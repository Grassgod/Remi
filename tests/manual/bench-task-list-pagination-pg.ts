#!/usr/bin/env bun
/**
 * MUL-357: `GET /api/multiremi/tasks` before/after harness on real PostgreSQL.
 *
 * The SQLite harness (`bench-task-list-pagination.ts`) measures the same route
 * in-process. Production runs PostgreSQL behind the `PostgresSyncDatabase`
 * worker bridge, where a cost the SQLite numbers cannot show appears: every row
 * a statement returns is JSON-serialized into a SharedArrayBuffer and parsed
 * back on the main thread. This script measures that path and counts the bridge
 * payload, because "how many bytes crossed the bridge" is what the two-phase
 * fetch changes.
 *
 * Scenarios:
 *   mixed               production-like status / workspace / Chat mix
 *   tail-visible-newest 10 visible newest rows, the other 6000 invisible
 *   tail-visible-oldest 10 visible oldest rows, the other 6000 invisible
 *
 * The last two are the worst case for the chunked scan: it must reject 6k rows
 * before it can answer, so they show whether scanning past an invisible task is
 * cheap (projection) or expensive (whole row).
 *
 *   MULTIREMI_TEST_POSTGRES_URL=postgres://… \
 *     bun run tests/manual/bench-task-list-pagination-pg.ts --out /tmp/after-pg.json
 *
 * The "before" numbers come from running this same file on the parent commit.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { SqlDatabase, SqlStatement } from "../../packages/server/src/store/db/postgres.js";
import { MultiremiStore } from "../../packages/server/src/store/store.js";
import { createMultiremiApp } from "../../packages/server/src/api/server.js";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const DEFAULT_OUT = join(REPO_ROOT, "reports", "performance", "MUL-357-task-list-pagination-pg.json");
const ADMIN_URL = process.env.MULTIREMI_TEST_POSTGRES_URL
  ?? "postgres://multimira:multimira@localhost:5432/postgres";

const TOTAL_TASKS = Number(process.env.MUL357_TASKS ?? 6000);
const WARMUPS = Number(process.env.MUL357_WARMUPS ?? 2);
const SAMPLES = Number(process.env.MUL357_SAMPLES ?? 5);
const COMPLETED_SHARE = 0.92;
const FAILED_SHARE = 0.036;
const FOREIGN_EVERY = 7;
const CHAT_EVERY = 5;
const CHAT_OTHER_MEMBER_EVERY = 2;
const RESULT_BYTES = 2400;
const PROMPT_BYTES = 800;
const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);

interface CaseResult {
  label: string;
  query: string;
  samples: number;
  p50Ms: number;
  p95Ms: number;
  responseBytes: number;
  tasksReturned: number;
  sqlStatements: number;
  sqlMs: number;
  serverComputeMs: number;
  /** Bytes the worker serialized back across the shared buffer. */
  bridgeBytes: number;
  bridgeRows: number;
}

/**
 * Wraps the real Postgres bridge to count statements and their time, and to
 * measure the payload the worker hands back. The worker sends
 * `JSON.stringify({ rows, count })`, so serializing the same rows the wrapper
 * receives reproduces that payload byte for byte.
 */
class MeteredDb implements SqlDatabase {
  statements = 0;
  sqlMs = 0;
  bridgeBytes = 0;
  bridgeRows = 0;
  constructor(private readonly inner: SqlDatabase) {}
  reset(): void {
    this.statements = 0;
    this.sqlMs = 0;
    this.bridgeBytes = 0;
    this.bridgeRows = 0;
  }
  private measure<T>(run: () => T, countRows: (value: T) => unknown[] = () => []): T {
    const started = performance.now();
    const value = run();
    this.sqlMs += performance.now() - started;
    this.statements += 1;
    const rows = countRows(value);
    if (rows.length) {
      this.bridgeRows += rows.length;
      this.bridgeBytes += JSON.stringify({ rows, count: rows.length }).length;
    }
    return value;
  }
  private wrap(statement: SqlStatement): SqlStatement {
    return {
      get: (...params: unknown[]) => this.measure(() => statement.get(...params), (row) => (row == null ? [] : [row])),
      all: (...params: unknown[]) => this.measure(() => statement.all(...params), (rows) => rows),
      run: (...params: unknown[]) => this.measure(() => statement.run(...params)),
      values: (...params: unknown[]) => this.measure(() => statement.values(...params), (rows) => rows),
    };
  }
  query(sql: string): SqlStatement {
    return this.wrap(this.inner.query(sql));
  }
  prepare(sql: string): SqlStatement {
    return this.wrap(this.inner.prepare(sql));
  }
  run(sql: string, ...params: unknown[]) {
    return this.measure(() => this.inner.run(sql, ...params));
  }
  exec(sql: string): void {
    this.inner.exec(sql);
  }
  transaction<T>(fn: (...args: any[]) => T) {
    return this.inner.transaction(fn);
  }
  close(): void {
    this.inner.close();
  }
}

function filler(prefix: string, index: number, bytes: number): string {
  const head = `${prefix} #${index} `;
  return head + "lorem ipsum dolor sit amet ".repeat(Math.ceil(bytes / 27)).slice(0, Math.max(0, bytes - head.length));
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
}

type Scenario = "mixed" | "tail-visible-newest" | "tail-visible-oldest";

/** True when this row's task is hidden from the reader credential. */
function isInvisible(scenario: Scenario, index: number): boolean {
  if (scenario === "mixed") return index % FOREIGN_EVERY === 0;
  const visibleFrom = scenario === "tail-visible-newest" ? 0 : TOTAL_TASKS - 10;
  const visibleTo = scenario === "tail-visible-newest" ? 10 : TOTAL_TASKS;
  return index < visibleFrom || index >= visibleTo;
}

async function runScenario(scenario: Scenario, pg: InstanceType<typeof Bun.SQL>): Promise<{
  cases: CaseResult[];
  chatTasks: number;
  seedMs: number;
  postgresVersion: string;
}> {
  const { PostgresSyncDatabase } = await import("../../packages/server/src/store/db/postgres.js");
  const url = new URL(ADMIN_URL);
  const dbName = `multiremi_mul357_${scenario.replace(/-/g, "_")}_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new Bun.SQL(ADMIN_URL, { max: 1 });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  await admin.end();
  url.pathname = `/${dbName}`;

  const connection = new Bun.SQL(url.toString(), { max: 1 });
  const raw = new PostgresSyncDatabase(url.toString());
  const metered = new MeteredDb(raw);
  const store = new MultiremiStore(metered);
  store.ensureLocalWorkspace();
  store.createWorkspace({ id: "ws_foreign", name: "Foreign", slug: "foreign", issuePrefix: "FOR" });
  const owner = store.getCurrentUser();
  store.createWorkspaceMember({ workspaceId: "local", userId: "usr_reader", name: "Reader", role: "member" });
  const reader = await store.createAccessToken({
    name: "Reader", type: "pat", userId: "usr_reader", workspaceId: "local",
  });
  store.createAgent({ id: "agt_bench", name: "List agent", provider: "codex", workspaceId: "local", ownerId: owner.id, visibility: "workspace" });
  store.createAgent({ id: "agt_foreign", name: "Foreign agent", provider: "codex", workspaceId: "ws_foreign", ownerId: owner.id, visibility: "workspace" });

  const seedStarted = performance.now();
  // Chat sessions are real rows so the creator guard runs; they are created
  // through the store because the token guard reads them back.
  const chatSessionByOrder = new Map<number, string>();
  if (scenario === "mixed") {
    for (let index = 0; index < TOTAL_TASKS; index += 1) {
      if (index % FOREIGN_EVERY === 0) continue;
      if (index % CHAT_EVERY !== 0) continue;
      const session = store.createChatSession({
        agentId: "agt_bench",
        creatorId: index % CHAT_OTHER_MEMBER_EVERY === 0 ? owner.id : "usr_reader",
      });
      chatSessionByOrder.set(index, session.id);
    }
  }

  // Bulk insert: 6k per-row inserts across the bridge take minutes.
  const BATCH = 250;
  const columns = "(id, task_kind, agent_id, workspace_id, status, priority, prompt, attempt, max_attempts, holds_workspace, usage, result, chat_session_id, created_at, updated_at)";
  for (let start = 0; start < TOTAL_TASKS; start += BATCH) {
    const values: string[] = [];
    const params: unknown[] = [];
    let n = 0;
    for (let index = start; index < Math.min(start + BATCH, TOTAL_TASKS); index += 1) {
      const share = index / TOTAL_TASKS;
      const invisible = isInvisible(scenario, index);
      const status = share < COMPLETED_SHARE ? "completed"
        : share < COMPLETED_SHARE + FAILED_SHARE ? "failed" : "running";
      // Strictly decreasing: index 0 is newest.
      const createdAt = new Date(NOW - index * 60_000).toISOString();
      values.push(`($${++n}, 'direct', $${++n}, $${++n}, $${++n}, 0, $${++n}, 1, 3, 1, '[]', $${++n}, $${++n}, $${++n}, $${++n})`);
      params.push(
        `tsk_bench${String(index).padStart(6, "0")}`,
        invisible ? "agt_foreign" : "agt_bench",
        invisible ? "ws_foreign" : "local",
        status,
        filler("prompt", index, PROMPT_BYTES),
        filler("result", index, RESULT_BYTES),
        chatSessionByOrder.get(index) ?? null,
        createdAt,
        createdAt,
      );
    }
    await connection.unsafe(`INSERT INTO multiremi_tasks ${columns} VALUES ${values.join(",")}`, params as any[]);
  }
  await connection.unsafe("ANALYZE multiremi_tasks");
  const seedMs = performance.now() - seedStarted;
  const postgresVersion = String((await connection`SHOW server_version`)[0]?.server_version ?? "unknown");

  const app = createMultiremiApp({ store, authToken: "root-secret" });
  const rootHeaders = { Authorization: "Bearer root-secret" };
  const readerHeaders = { Authorization: `Bearer ${reader.token}` };
  const allCases: Array<{ scenario: Scenario; label: string; query: string; headers: Record<string, string> }> = [
    { scenario: "mixed", label: "no limit", query: "", headers: rootHeaders },
    { scenario: "mixed", label: "limit=5", query: "?limit=5", headers: rootHeaders },
    { scenario: "mixed", label: "limit=100", query: "?limit=100", headers: rootHeaders },
    { scenario: "mixed", label: "status=completed limit=100", query: "?status=completed&limit=100", headers: rootHeaders },
    { scenario: "mixed", label: "reader limit=5", query: "?limit=5", headers: readerHeaders },
    { scenario: "mixed", label: "reader limit=100", query: "?limit=100", headers: readerHeaders },
    { scenario: "tail-visible-newest", label: "tail(newest) reader limit=5", query: "?limit=5", headers: readerHeaders },
    { scenario: "tail-visible-newest", label: "tail(newest) reader limit=100", query: "?limit=100", headers: readerHeaders },
    { scenario: "tail-visible-oldest", label: "tail(oldest) reader limit=5", query: "?limit=5", headers: readerHeaders },
    { scenario: "tail-visible-oldest", label: "tail(oldest) reader limit=100", query: "?limit=100", headers: readerHeaders },
  ];

  const results: CaseResult[] = [];
  for (const testCase of allCases.filter((entry) => entry.scenario === scenario)) {
    const durations: number[] = [];
    let responseBytes = 0;
    let tasksReturned = 0;
    let sqlStatements = 0;
    let sqlMs = 0;
    let serverComputeMs = 0;
    let bridgeBytes = 0;
    let bridgeRows = 0;
    for (let sample = 0; sample < WARMUPS + SAMPLES; sample += 1) {
      metered.reset();
      const started = performance.now();
      const response = await app.request(`/api/multiremi/tasks${testCase.query}`, { headers: testCase.headers });
      const text = await response.text();
      const elapsed = performance.now() - started;
      if (response.status !== 200) throw new Error(`${testCase.label}: HTTP ${response.status} ${text.slice(0, 300)}`);
      if (sample < WARMUPS) continue;
      const parsed = JSON.parse(text) as { tasks: unknown[] };
      durations.push(elapsed);
      responseBytes = text.length;
      tasksReturned = parsed.tasks.length;
      sqlStatements = metered.statements;
      sqlMs = Number(metered.sqlMs.toFixed(2));
      serverComputeMs = Number(Math.max(0, elapsed - metered.sqlMs).toFixed(2));
      bridgeBytes = metered.bridgeBytes;
      bridgeRows = metered.bridgeRows;
    }
    results.push({
      label: testCase.label,
      query: testCase.query || "(none)",
      samples: durations.length,
      p50Ms: Number(percentile(durations, 0.5).toFixed(2)),
      p95Ms: Number(percentile(durations, 0.95).toFixed(2)),
      responseBytes,
      tasksReturned,
      sqlStatements,
      sqlMs,
      serverComputeMs,
      bridgeBytes,
      bridgeRows,
    });
  }

  void pg;
  await connection.end();
  raw.close();
  const cleanup = new Bun.SQL(ADMIN_URL, { max: 1 });
  await cleanup.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await cleanup.end();

  return { cases: results, chatTasks: chatSessionByOrder.size, seedMs, postgresVersion };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const outPath = outIndex >= 0 ? args[outIndex + 1]! : DEFAULT_OUT;
  const only = args.includes("--tail")
    ? (["tail-visible-newest", "tail-visible-oldest"] as Scenario[])
    : (["mixed", "tail-visible-newest", "tail-visible-oldest"] as Scenario[]);

  const results: CaseResult[] = [];
  let chatTasks = 0;
  let seedMs = 0;
  let postgresVersion = "unknown";
  for (const scenario of only) {
    const outcome = await runScenario(scenario, undefined as never);
    results.push(...outcome.cases);
    chatTasks = Math.max(chatTasks, outcome.chatTasks);
    seedMs += outcome.seedMs;
    postgresVersion = outcome.postgresVersion;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    commit: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: REPO_ROOT }).stdout.toString().trim(),
    runtime: {
      bun: Bun.version,
      database: `PostgreSQL ${postgresVersion}`,
      transport: "in-process app.request() over the PostgresSyncDatabase worker bridge",
    },
    fixture: {
      totalTasks: TOTAL_TASKS,
      chatTasks,
      seedMs: Number(seedMs.toFixed(2)),
      resultBytesPerTask: RESULT_BYTES,
      promptBytesPerTask: PROMPT_BYTES,
      statusMix: { completed: COMPLETED_SHARE, failed: FAILED_SHARE, running: 1 - COMPLETED_SHARE - FAILED_SHARE },
      scenarios: only,
    },
    warmups: WARMUPS,
    samples: SAMPLES,
    results,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`wrote ${outPath}`);
  console.log(`scenarios=${only.join(",")} seeded ${TOTAL_TASKS} tasks/scenario in ${(seedMs / 1000).toFixed(1)}s total`);
  console.log("label                            p50ms   p95ms  resp_KB  tasks   sql  sql_ms  compute  bridge_KB  rows");
  for (const result of results) {
    console.log(
      `${result.label.padEnd(32)} ${String(result.p50Ms).padStart(6)} ${String(result.p95Ms).padStart(7)} `
      + `${(result.responseBytes / 1024).toFixed(1).padStart(8)} ${String(result.tasksReturned).padStart(6)} `
      + `${String(result.sqlStatements).padStart(5)} ${String(result.sqlMs).padStart(7)} `
      + `${String(result.serverComputeMs).padStart(8)} ${(result.bridgeBytes / 1024).toFixed(1).padStart(10)} `
      + `${String(result.bridgeRows).padStart(5)}`,
    );
  }
}

await main();
