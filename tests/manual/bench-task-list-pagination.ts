#!/usr/bin/env bun
/**
 * MUL-357: `GET /api/multiremi/tasks` before/after harness.
 *
 * Seeds an in-memory SQLite store at production scale (the 2026-09-21 read-only
 * baseline was 5854 tasks: 5527 completed / 216 failed / 5 running / 0 queued)
 * with ordinary, Chat and foreign-workspace tasks carrying full-size
 * `result` / `prompt` bodies, then times the real route through `app.request()`.
 *
 * The "before" numbers come from running this same file on the parent commit: it
 * drives the route through its public HTTP surface, so no code branch selects the
 * implementation under test.
 *
 *   bun run tests/manual/bench-task-list-pagination.ts --out /tmp/after.json
 *
 * This is an in-process SQLite measurement. It isolates SQL + authorization +
 * JSON cost; it does not model production network transfer, and it is not a
 * PostgreSQL measurement.
 */
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { SqlStatement } from "../../packages/server/src/store/db/postgres.js";
import { MultiremiStore } from "../../packages/server/src/store/store.js";
import { createMultiremiApp } from "../../packages/server/src/api/server.js";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const DEFAULT_OUT = join(REPO_ROOT, "reports", "performance", "MUL-357-task-list-pagination.json");

const TOTAL_TASKS = Number(process.env.MUL357_TASKS ?? 6000);
const WARMUPS = Number(process.env.MUL357_WARMUPS ?? 2);
const SAMPLES = Number(process.env.MUL357_SAMPLES ?? 7);
const COMPLETED_SHARE = 0.92;
const FAILED_SHARE = 0.036;
const RUNNING_SHARE = 0.001;
/** Every Nth task belongs to another workspace, so membership filtering is live. */
const FOREIGN_EVERY = 7;
/** Every Nth remaining task is a private Chat task, so the chat guard is live. */
const CHAT_EVERY = 5;
/** Half of those Chats belong to the other member, so the creator boundary is live. */
const CHAT_OTHER_MEMBER_EVERY = 2;
/** Sized against the production baseline: 54.6 MB returned over 5854 tasks. */
const RESULT_BYTES = 2400;
const PROMPT_BYTES = 800;
const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);

interface SqlProbe {
  statements: number;
  ms: number;
  reset(): void;
}

interface CaseResult {
  label: string;
  query: string;
  samples: number;
  p50Ms: number;
  p95Ms: number;
  responseBytes: number;
  tasksReturned: number;
  bytesPerTask: number;
  sqlStatements: number;
  sqlMs: number;
  serverComputeMs: number;
  serializeMs: number;
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

/** Counts and times every statement the store issues, without changing results. */
function instrument(raw: Database): { db: Database; probe: SqlProbe } {
  const probe: SqlProbe = {
    statements: 0,
    ms: 0,
    reset() {
      this.statements = 0;
      this.ms = 0;
    },
  };
  const record = <T>(run: () => T): T => {
    const started = performance.now();
    try {
      return run();
    } finally {
      probe.statements += 1;
      probe.ms += performance.now() - started;
    }
  };
  const proxy = new Proxy(raw, {
    get(target, property) {
      if (property === "query" || property === "prepare") {
        return (sql: string) => {
          const statement = target[property](sql) as unknown as SqlStatement;
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              const value = statementTarget[statementProperty as keyof SqlStatement];
              if (typeof value === "function" && ["get", "all", "run", "values"].includes(String(statementProperty))) {
                return (...params: unknown[]) =>
                  record(() => (value as (...args: unknown[]) => unknown).apply(statementTarget, params));
              }
              return typeof value === "function"
                ? (value as (...args: unknown[]) => unknown).bind(statementTarget)
                : value;
            },
          });
        };
      }
      if (property === "run") {
        return (sql: string, ...params: unknown[]) =>
          record(() => (target.run as (...args: unknown[]) => unknown)(sql, ...params));
      }
      if (property === "exec") return (sql: string) => record(() => target.exec(sql));
      const value = target[property as keyof Database];
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as Database;
  return { db: proxy, probe };
}

function statusFor(index: number): "completed" | "failed" | "running" | "queued" {
  const share = index / TOTAL_TASKS;
  if (share < COMPLETED_SHARE) return "completed";
  if (share < COMPLETED_SHARE + FAILED_SHARE) return "failed";
  if (share < COMPLETED_SHARE + FAILED_SHARE + RUNNING_SHARE) return "running";
  return "queued";
}

function seed(raw: Database, store: MultiremiStore): { chatTasks: number; ms: number } {
  const started = performance.now();
  let chatTasks = 0;
  const patch = raw.prepare(
    "UPDATE multiremi_tasks SET status = ?, result = ?, created_at = ?, updated_at = ? WHERE id = ?",
  );
  raw.transaction(() => {
    for (let index = 0; index < TOTAL_TASKS; index += 1) {
      const foreign = index % FOREIGN_EVERY === 0;
      const chat = !foreign && index % CHAT_EVERY === 0;
      let chatSessionId: string | null = null;
      if (chat) {
        const session = store.createChatSession({
          agentId: "agt_bench",
          creatorId: index % CHAT_OTHER_MEMBER_EVERY === 0 ? "usr_owner" : "usr_reader",
        });
        chatSessionId = session.id;
        chatTasks += 1;
      }
      const task = store.createTask({
        agentId: foreign ? "agt_foreign" : "agt_bench",
        prompt: filler("prompt", index, PROMPT_BYTES),
        workspaceId: foreign ? "ws_foreign" : "local",
        chatSessionId,
      });
      const status = statusFor(index);
      const createdAt = new Date(NOW - index * 60_000).toISOString();
      patch.run(
        status,
        status === "queued" ? null : filler("result", index, RESULT_BYTES),
        createdAt,
        createdAt,
        task.id,
      );
    }
  })();
  return { chatTasks, ms: performance.now() - started };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const outPath = outIndex >= 0 ? args[outIndex + 1]! : DEFAULT_OUT;

  const raw = new Database(":memory:");
  const { db, probe } = instrument(raw);
  const store = new MultiremiStore(db);
  store.ensureLocalWorkspace();
  store.createWorkspace({ id: "ws_foreign", name: "Foreign", slug: "foreign", issuePrefix: "FOR" });
  const owner = store.getCurrentUser();
  store.createWorkspaceMember({ workspaceId: "local", userId: "usr_reader", name: "Reader", role: "member" });
  const reader = await store.createAccessToken({
    name: "Reader",
    type: "pat",
    userId: "usr_reader",
    workspaceId: "local",
  });
  store.createAgent({
    id: "agt_bench",
    name: "List agent",
    provider: "codex",
    workspaceId: "local",
    ownerId: owner.id,
    visibility: "workspace",
  });
  store.createAgent({
    id: "agt_foreign",
    name: "Foreign agent",
    provider: "codex",
    workspaceId: "ws_foreign",
    ownerId: owner.id,
    visibility: "workspace",
  });
  const seeded = seed(raw, store);

  const app = createMultiremiApp({ store, authToken: "root-secret" });
  const rootHeaders = { Authorization: "Bearer root-secret" };
  const cases: Array<{ label: string; query: string; headers: Record<string, string> }> = [
    { label: "no limit", query: "", headers: rootHeaders },
    { label: "limit=5", query: "?limit=5", headers: rootHeaders },
    { label: "limit=100", query: "?limit=100", headers: rootHeaders },
    { label: "status=completed limit=100", query: "?status=completed&limit=100", headers: rootHeaders },
    { label: "reader limit=5", query: "?limit=5", headers: { Authorization: `Bearer ${reader.token}` } },
    { label: "reader limit=100", query: "?limit=100", headers: { Authorization: `Bearer ${reader.token}` } },
  ];

  const results: CaseResult[] = [];
  for (const testCase of cases) {
    const durations: number[] = [];
    let responseBytes = 0;
    let tasksReturned = 0;
    let sqlStatements = 0;
    let sqlMs = 0;
    let serverComputeMs = 0;
    let serializeMs = 0;
    for (let sample = 0; sample < WARMUPS + SAMPLES; sample += 1) {
      probe.reset();
      const started = performance.now();
      const response = await app.request(`/api/multiremi/tasks${testCase.query}`, { headers: testCase.headers });
      const text = await response.text();
      const elapsed = performance.now() - started;
      if (response.status !== 200) throw new Error(`${testCase.label}: HTTP ${response.status} ${text.slice(0, 300)}`);
      if (sample < WARMUPS) continue;
      const serialized = JSON.stringify(JSON.parse(text));
      const serializeStarted = performance.now();
      JSON.stringify(JSON.parse(text));
      serializeMs = Number((performance.now() - serializeStarted).toFixed(2));
      const parsed = JSON.parse(text) as { tasks: unknown[] };
      durations.push(elapsed);
      responseBytes = serialized.length;
      tasksReturned = parsed.tasks.length;
      sqlStatements = probe.statements;
      sqlMs = Number(probe.ms.toFixed(2));
      // Route time minus database time is authorization plus JSON encoding.
      serverComputeMs = Number(Math.max(0, elapsed - probe.ms).toFixed(2));
    }
    results.push({
      label: testCase.label,
      query: testCase.query || "(none)",
      samples: durations.length,
      p50Ms: Number(percentile(durations, 0.5).toFixed(2)),
      p95Ms: Number(percentile(durations, 0.95).toFixed(2)),
      responseBytes,
      tasksReturned,
      bytesPerTask: tasksReturned ? Math.round(responseBytes / tasksReturned) : 0,
      sqlStatements,
      sqlMs,
      serverComputeMs,
      serializeMs,
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    commit: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: REPO_ROOT }).stdout.toString().trim(),
    runtime: { bun: Bun.version, database: "sqlite(:memory:)", transport: "in-process app.request()" },
    fixture: {
      totalTasks: TOTAL_TASKS,
      chatTasks: seeded.chatTasks,
      seedMs: Number(seeded.ms.toFixed(2)),
      resultBytesPerTask: RESULT_BYTES,
      promptBytesPerTask: PROMPT_BYTES,
      statusMix: { completed: COMPLETED_SHARE, failed: FAILED_SHARE, running: RUNNING_SHARE },
      foreignWorkspaceEvery: FOREIGN_EVERY,
      chatEvery: CHAT_EVERY,
      chatOwnedByOtherMemberEvery: CHAT_OTHER_MEMBER_EVERY,
    },
    warmups: WARMUPS,
    samples: SAMPLES,
    results,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`wrote ${outPath}`);
  console.log(`seeded ${TOTAL_TASKS} tasks (${seeded.chatTasks} chat) in ${seeded.ms.toFixed(0)}ms`);
  console.log("label                           p50ms   p95ms   resp_MB  tasks  sql  sql_ms  compute_ms  serial_ms");
  for (const result of results) {
    console.log(
      `${result.label.padEnd(30)} ${String(result.p50Ms).padStart(6)} ${String(result.p95Ms).padStart(7)} `
      + `${(result.responseBytes / 1e6).toFixed(2).padStart(8)} ${String(result.tasksReturned).padStart(6)} `
      + `${String(result.sqlStatements).padStart(4)} ${String(result.sqlMs).padStart(7)} `
      + `${String(result.serverComputeMs).padStart(11)} ${String(result.serializeMs).padStart(10)}`,
    );
  }
}

await main();
