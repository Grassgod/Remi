#!/usr/bin/env bun
/**
 * MUL-398 A2: the repository-wikis route on a real PostgreSQL at the shape 209
 * reported, with the per-repository costs broken out.
 *
 * Why a second harness: the A fixture has 2 repositories and 178 runs, so it
 * cannot show whether a change moves the 209-scale number. This one seeds the
 * row counts Explorer measured (1,842 observability rows / 1,443 build-state
 * rows) and lets the repository count vary, because the residual cost the A
 * report identified is per repository, not per row.
 *
 * Metrics come from the production `Server-Timing` header (`dbb`, `dbq`, `db`,
 * `dbp`, `total`), i.e. exactly what `api_slow_request.db_bytes` records, plus
 * a per-statement breakdown from a metered `SqlDatabase` wrapper.
 *
 *   MULTIREMI_TEST_POSTGRES_URL=postgres://… \
 *     bun run tests/manual/bench-repository-wikis-a2-scale.ts --out /tmp/a2.json
 *
 * Without a reachable PostgreSQL the harness exits non-zero: SQLite cannot show
 * a bridge payload.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { SqlDatabase, SqlStatement } from "../../packages/server/src/store/db/postgres.js";
import { MultiremiStore } from "../../packages/server/src/store/store.js";
import { createMultiremiApp } from "../../packages/server/src/api/server.js";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const DEFAULT_OUT = join(REPO_ROOT, "reports", "performance", "MUL-398-repository-wikis-a2-scale.json");
const ADMIN_URL = process.env.MULTIREMI_TEST_POSTGRES_URL?.trim() ?? "";
const AUTH_TOKEN = "root-secret";
const WARMUPS = Number(process.env.MUL398_A2_WARMUPS ?? 1);
const SAMPLES = Number(process.env.MUL398_A2_SAMPLES ?? 5);

/** Explorer's 209 probe (MUL-398 cmt_db48gqrimjk9). */
const OBSERVABILITY_ROWS = Number(process.env.MUL398_A2_OBS_ROWS ?? 1842);
const BUILD_STATE_ROWS = Number(process.env.MUL398_A2_BUILD_ROWS ?? 1443);
const PAYLOAD_BYTES = Number(process.env.MUL398_A2_PAYLOAD ?? Math.round(3_064_136 / 1842));
const RESULT_BYTES = Number(process.env.MUL398_A2_RESULT ?? Math.round(10_147_432 / 1842));
const DOCS_PER_REPO = Number(process.env.MUL398_A2_DOCS_PER_REPO ?? 3);
const DOC_BODY_BYTES = Number(process.env.MUL398_A2_DOC_BODY ?? 50_000);
/** Where page bodies live; `openviking` is the production shape. */
const PAGE_STORAGE = (process.env.MUL398_A2_PAGE_STORAGE as "openviking" | "sql" | undefined) ?? "openviking";
const REPO_COUNTS = (process.env.MUL398_A2_REPOS ?? "26,46,92").split(",").map((value) => Number(value.trim()));

interface StatementSample {
  sql: string;
  /** Normalized SQL, truncated for readable report output. */
  label: string;
  calls: number; rows: number; bytes: number;
}
interface StatementBucket { bytes: number; rows: number; calls: number; }
interface ScenarioResult {
  repositories: number;
  /** Rows the observability statement is seeded to match (Explorer: 1,842). */
  observabilityRows: number;
  /** Rows the build-state statement is seeded to match (Explorer: 1,443). */
  buildStateRows: number;
  scopedRunsPerRepository: number[];
  scheduleOnlyRunsPerRepository: number[];
  dbBytes: number;
  dbQueries: number;
  dbMs: number;
  dbParseMs: number;
  p50Ms: number;
  maxMs: number;
  responseBytes: number;
  /** Bytes per repository, the quantity the A report identified as the residual. */
  bytesPerRepository: number;
  bytesPerRepositoryResidual: number;
  /** Per-statement attribution for the buckets the model is built from. */
  statements: {
    observability: StatementBucket;
    buildState: StatementBucket;
    publicationProbe: StatementBucket;
    docsStatement: StatementBucket;
    getRunById: StatementBucket;
    compilations: StatementBucket;
    taskById: StatementBucket;
    autopilotById: StatementBucket;
    publishedProbe: StatementBucket;
  };
  topStatements: StatementSample[];
  responseBody?: unknown;
}

class MeteredDb implements SqlDatabase {
  private readonly byStatement = new Map<string, StatementSample>();
  constructor(private readonly inner: SqlDatabase) {}
  get dialect(): SqlDatabase["dialect"] { return this.inner.dialect; }
  reset(): void { this.byStatement.clear(); }
  statements(): StatementSample[] {
    return [...this.byStatement.values()].map((entry) => ({ ...entry })).sort((a, b) => b.bytes - a.bytes);
  }
  private measure<T>(sql: string, run: () => T, rowsOf: (value: T) => unknown[] = () => []): T {
    const value = run();
    const rows = rowsOf(value);
    const normalized = sql.replace(/\s+/g, " ").trim();
    const entry = this.byStatement.get(normalized) ?? {
      sql: normalized, label: normalized.slice(0, 150), calls: 0, rows: 0, bytes: 0,
    };
    entry.calls += 1;
    entry.rows += rows.length;
    entry.bytes += rows.length ? JSON.stringify({ rows, count: rows.length }).length : 0;
    this.byStatement.set(normalized, entry);
    return value;
  }
  private wrap(statement: SqlStatement, sql: string): SqlStatement {
    return {
      get: (...params: unknown[]) => this.measure(sql, () => statement.get(...params), (row) => (row == null ? [] : [row])),
      all: (...params: unknown[]) => this.measure(sql, () => statement.all(...params), (rows) => rows),
      run: (...params: unknown[]) => this.measure(sql, () => statement.run(...params)),
      values: (...params: unknown[]) => this.measure(sql, () => statement.values(...params), (rows) => rows),
    };
  }
  query(sql: string): SqlStatement { return this.wrap(this.inner.query(sql), sql); }
  prepare(sql: string): SqlStatement { return this.wrap(this.inner.prepare(sql), sql); }
  run(sql: string, ...params: unknown[]) { return this.measure(sql, () => this.inner.run(sql, ...params)); }
  exec(sql: string): void { this.inner.exec(sql); }
  transaction<T>(fn: (...args: any[]) => T) { return this.inner.transaction(fn); }
  close(): void { this.inner.close(); }
}

/** Parse the production Server-Timing header. */
export function parseServerTiming(header: string | null): {
  totalMs: number; dbMs: number; dbParseMs: number; dbQueries: number; dbBytes: number;
} {
  const out = { totalMs: 0, dbMs: 0, dbParseMs: 0, dbQueries: 0, dbBytes: 0 };
  if (!header) return out;
  for (const part of header.split(",")) {
    const [rawName, ...rest] = part.trim().split(";");
    const name = rawName!.trim();
    let duration: number | null = null;
    let desc: number | null = null;
    for (const attribute of rest) {
      const [rawKey, rawValue = ""] = attribute.split("=");
      const key = rawKey!.trim();
      const value = rawValue.trim().replace(/^"|"$/g, "");
      if (key === "dur") duration = Number(value);
      if (key === "desc") desc = Number(value);
    }
    const value = duration ?? desc ?? 0;
    if (name === "total") out.totalMs = value;
    else if (name === "db") out.dbMs = value;
    else if (name === "dbp") out.dbParseMs = value;
    else if (name === "dbq") out.dbQueries = value;
    else if (name === "dbb") out.dbBytes = value;
  }
  return out;
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]!;
}

async function postgresVersion(url: string): Promise<string | null> {
  try {
    const probe = new Bun.SQL(url, { max: 1 });
    const rows = await probe`SHOW server_version` as Array<{ server_version?: string }>;
    await probe.end();
    return String(rows[0]?.server_version ?? "unknown");
  } catch { return null; }
}

/** Split `total` into `parts` whole numbers, remainder spread over the front. */
function distribute(total: number, parts: number): number[] {
  const base = Math.floor(total / parts);
  const remainder = total - base * parts;
  return Array.from({ length: parts }, (_, index) => base + (index < remainder ? 1 : 0));
}

function filler(prefix: string, bytes: number): string {
  return (prefix + " ").padEnd(bytes, "x").slice(0, bytes);
}

async function createDatabase(adminUrl: string, name: string): Promise<string> {
  const admin = new Bun.SQL(adminUrl, { max: 1 });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function dropDatabase(adminUrl: string, name: string): Promise<void> {
  const admin = new Bun.SQL(adminUrl, { max: 1 });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
}

/**
 * Seed `repoCount` repositories. Runs are distributed so the observability
 * statement matches OBSERVABILITY_ROWS and the build-state statement matches
 * BUILD_STATE_ROWS (only the repositories with a compilation record are
 * eligible for the latter, which is what made 209's two queries differ).
 */
async function runScenario(
  repoCount: number,
  captureResponse: boolean,
): Promise<ScenarioResult> {
  const dbName = `multiremi_mul398_a2_${repoCount}_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
  const dbUrl = await createDatabase(ADMIN_URL, dbName);
  const { PostgresSyncDatabase } = await import("../../packages/server/src/store/db/postgres.js");
  const raw = new PostgresSyncDatabase(dbUrl);
  const metered = new MeteredDb(raw);
  const store = new MultiremiStore(metered);

  store.ensureLocalWorkspace();
  const owner = store.getCurrentUser();
  if (!store.getWorkspaceMember("mem_local_local")) {
    store.createWorkspaceMember({ id: "mem_local_local", workspaceId: "local", userId: owner.id, name: owner.name ?? "Owner", role: "owner" });
  }
  const agent = store.createAgent({
    id: "agt_a2", name: "A2 agent", provider: "codex", workspaceId: "local", ownerId: owner.id, visibility: "workspace",
  });
  const repositories = Array.from({ length: repoCount }, (_, index) => ({
    id: `repo_a2_${String(index).padStart(4, "0")}`,
    name: `a2-repo-${index}`,
    url: `https://github.com/multiremi/a2-repo-${index}.git`,
    source: "github" as const,
    default_branch: "main",
  }));
  store.updateWorkspaceRepositories("local", repositories);
  const autopilot = store.createAutopilot({
    id: "ap_a2", title: "A2 fixture", workspaceId: "local", assigneeId: agent.id,
    executionMode: "run_only", status: "active",
  });

  // Explorer's 209 probe measured 1,842 rows for the observability statement and
  // 1,443 for the build-state statement. The gap is the 399 schedule-only runs
  // that observability also matches but the build-state statement does not
  // (it requires a repository-scoped compilation record for those). The split is
  // reproduced literally: every run is repository-scoped or schedule-only, and
  // only the repository-scoped ones are visible to both statements.
  const scopedRuns = distribute(BUILD_STATE_ROWS, repoCount);
  const scheduleOnlyRuns = distribute(OBSERVABILITY_ROWS - BUILD_STATE_ROWS, repoCount);
  const observabilityRows = OBSERVABILITY_ROWS;

  const insertRun = (
    id: string,
    index: number,
    scopedRepositoryId: string | null,
    /** Set for schedule-only runs: `repository_id` stays NULL and the run is
     * scoped by this JSON instead, exactly like the 399 rows in the 209 gap. */
    scheduleTarget: string | null,
    taskId: string | null,
    createdAt: string,
  ): void => {
    metered.run(
      `INSERT INTO multiremi_autopilot_runs (
         id, autopilot_id, source, status, repository_id, schedule_target, dedupe_key, task_id,
         triggered_at, completed_at, payload, result, created_at
       ) VALUES (?, ?, 'scm_event', 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, autopilot.id, scopedRepositoryId, scheduleTarget,
      scopedRepositoryId ? `${scopedRepositoryId}:incremental_update:sha${String(index).padStart(6, "0")}` : null,
      taskId,
      createdAt, createdAt,
      JSON.stringify({ event: { type: "change.merged" }, data: { merge_sha: `sha${index}`, patch: filler("p", PAYLOAD_BYTES) } }),
      JSON.stringify({ taskId: taskId ?? `tsk_a2_${index}`, status: "completed", output: filler("r", RESULT_BYTES) }),
      createdAt,
    );
  };

  // Runs are laid out newest-first by a single descending clock, so "newest run
  // per repository" is unambiguous. Each repository's newest run carries a task:
  // that is the run the route resolves through `repositoryWikiBuildState`.
  interface RunRow {
    id: string; index: number; scopedRepositoryId: string | null; scheduleTarget: string | null;
    taskId: string | null; createdAt: string; repositoryIndex: number;
  }
  const runPlan: Array<Omit<RunRow, "id" | "index" | "createdAt">> = [];
  for (const [repositoryIndex] of repositories.entries()) {
    for (let runIndex = 0; runIndex < scopedRuns[repositoryIndex]!; runIndex += 1) {
      runPlan.push({
        scopedRepositoryId: repositories[repositoryIndex]!.id,
        scheduleTarget: null,
        taskId: runIndex === 0 ? `tsk_a2_${String(repositoryIndex).padStart(4, "0")}` : null,
        repositoryIndex,
      });
    }
    for (let runIndex = 0; runIndex < scheduleOnlyRuns[repositoryIndex]!; runIndex += 1) {
      // Schedule-only runs are older than every repository-scoped run, so they
      // can never win the per-repository "latest" pick.
      runPlan.push({
        scopedRepositoryId: null,
        scheduleTarget: JSON.stringify({ kind: "repository", id: repositories[repositoryIndex]!.id }),
        taskId: null,
        repositoryIndex,
      });
    }
  }
  const orderedRuns: RunRow[] = runPlan.map((row, index) => ({
    ...row,
    id: `run_a2_${String(index).padStart(5, "0")}`,
    index,
    createdAt: new Date(Date.UTC(2026, 8, 26, 6, 0, 0) - index * 60_000).toISOString(),
  }));
  for (const row of orderedRuns) {
    insertRun(row.id, row.index, row.scopedRepositoryId, row.scheduleTarget, row.taskId, row.createdAt);
  }
  const scopedRunIds = new Map<string, string[]>();
  for (const row of orderedRuns) {
    if (!row.scopedRepositoryId) continue;
    const ids = scopedRunIds.get(row.scopedRepositoryId) ?? [];
    ids.push(row.id);
    scopedRunIds.set(row.scopedRepositoryId, ids);
  }

  for (const [repositoryIndex, repository] of repositories.entries()) {
    for (let docIndex = 0; docIndex < DOCS_PER_REPO; docIndex += 1) {
      // Production pages live in OpenViking, so the control-plane row keeps an
      // empty body and only the storage pointer. Seeding the body into the row
      // (no control) models a SQL-mode project and inflates the docs statement
      // by `DOC_BODY_BYTES` per page, which is not the 209 shape.
      const control = PAGE_STORAGE === "openviking"
        ? {
          contentUri: `viking://resources/local/repository-wiki/${repository.id}/page-${docIndex}.md`,
          contentSha256: "0".repeat(64),
          snapshotOid: `snapshot-a2-${repositoryIndex}-${docIndex}`,
        }
        : undefined;
      store.createRepositoryWikiDoc("local", repository.id, {
        path: `page-${docIndex}.md`,
        title: `Page ${docIndex}`,
        summary: `summary ${docIndex}`,
        body: filler("body", DOC_BODY_BYTES),
        sourceRevision: `sha${repositoryIndex}`,
      }, control);
    }
  }
  // Pin doc timestamps so two runs of the same scenario are byte-comparable.
  metered.run(
    `UPDATE multiremi_repository_wiki_docs SET created_at = ?, updated_at = ?`,
    ["2026-09-25T12:00:00.000Z", "2026-09-25T12:00:00.000Z"],
  );
  // Compilation provenance for the build-state statement.
  //
  // The statement matches a run when it is repository-scoped, or when it carries
  // a repository `schedule_target` plus a repository-scoped compilation record.
  // Every repository-scoped run gets one, which makes the statement's row count
  // exactly the 1,443 Explorer measured; the schedule-only runs stay excluded.
  const compilationRows: Array<{ id: string; runId: string; repositoryId: string }> = [];
  let compilationIndex = 0;
  for (const row of orderedRuns) {
    if (!row.scopedRepositoryId) continue;
    compilationRows.push({
      id: `krun_a2_${String(compilationIndex).padStart(5, "0")}`,
      runId: row.id,
      repositoryId: row.scopedRepositoryId,
    });
    compilationIndex += 1;
  }
  for (const entry of compilationRows) {
    metered.run(
      `INSERT INTO multiremi_knowledge_compilation_runs (
         id, workspace_id, project_id, repository_id, task_id, agent_id, autopilot_run_id,
         mode, status, result_summary, dedupe_key, created_at, completed_at
       ) VALUES (?, 'local', NULL, ?, NULL, ?, ?, 'incremental_update', 'published', 'Published', NULL, ?, ?)`,
      entry.id,
      entry.repositoryId,
      agent.id,
      entry.runId,
      new Date(Date.UTC(2026, 8, 26, 6, 0, 0)).toISOString(),
      new Date(Date.UTC(2026, 8, 26, 6, 0, 0)).toISOString(),
    );
  }
  // The route reads tasks for the newest run of each repository and for
  // `repositoryWikiTaskOutcome`; seed them so the queries are not trivially empty.
  for (const [index, repository] of repositories.entries()) {
    void repository;
    metered.run(
      `INSERT INTO multiremi_tasks (
         id, task_kind, agent_id, workspace_id, status, priority, prompt, attempt, max_attempts,
         holds_workspace, usage, created_at, updated_at
       ) VALUES (?, 'direct', ?, 'local', 'completed', 0, 'a2', 1, 3, 1, '[]', ?, ?)`,
      `tsk_a2_${String(index).padStart(4, "0")}`, agent.id,
      "2026-09-26T06:00:00.000Z", "2026-09-26T06:00:00.000Z",
    );
  }

  const counts = raw.query(`SELECT
     (SELECT COUNT(*) FROM multiremi_autopilot_runs) AS runs,
     (SELECT COUNT(*) FROM multiremi_repository_wiki_docs) AS docs,
     (SELECT COUNT(*) FROM multiremi_knowledge_compilation_runs) AS compilations`).get() as any;

  const app = createMultiremiApp({
    store,
    authToken: AUTH_TOKEN,
    backgroundJobs: false,
    requestMetrics: {
      enabled: true,
      slowRequestMs: 500,
      summaryIntervalMs: 60_000,
      summaryTopRoutes: 10,
      bufferCapacity: 64,
      // MUL-461: `role` is required on RequestMetricsOptions. This bench runs the
      // whole stack in one process, so it is the `all` role.
      role: "all",
    },
  });
  const path = "/api/workspaces/local/repository-wikis";
  const headers = { Authorization: `Bearer ${AUTH_TOKEN}` };
  const durations: number[] = [];
  let last = { dbBytes: 0, dbQueries: 0, dbMs: 0, dbParseMs: 0, responseBytes: 0, statements: [] as StatementSample[], body: undefined as unknown };
  for (let index = 0; index < WARMUPS + SAMPLES; index += 1) {
    metered.reset();
    const startedAt = performance.now();
    const response = await app.request(path, { headers });
    const text = await response.text();
    const elapsed = performance.now() - startedAt;
    if (response.status !== 200) throw new Error(`${path}: HTTP ${response.status} ${text.slice(0, 200)}`);
    if (index < WARMUPS) continue;
    const timing = parseServerTiming(response.headers.get("Server-Timing"));
    durations.push(elapsed);
    last = {
      dbBytes: timing.dbBytes, dbQueries: timing.dbQueries, dbMs: timing.dbMs, dbParseMs: timing.dbParseMs,
      responseBytes: text.length, statements: metered.statements(),
      body: captureResponse ? JSON.parse(text) : undefined,
    };
  }

  raw.close();
  await dropDatabase(ADMIN_URL, dbName);

  const statementBytes = (test: (sql: string) => boolean): { bytes: number; rows: number; calls: number } =>
    last.statements
      .filter((entry) => test(entry.sql))
      .reduce((sum, entry) => ({
        bytes: sum.bytes + entry.bytes, rows: sum.rows + entry.rows, calls: sum.calls + entry.calls,
      }), { bytes: 0, rows: 0, calls: 0 });
  // Buckets are matched on the full normalized SQL and are mutually exclusive;
  // several statements share a prefix, so prefix matching silently double-counts.
  const observability = statementBytes((sql) => /^SELECT r\.id, r\.repository_id, r\.schedule_target, r\.task_id, r\.completed_at, r\.created_at FROM multiremi_autopilot_runs r/.test(sql));
  const buildState = statementBytes((sql) => /repository_rank/.test(sql));
  const publicationProbe = statementBytes((sql) => /^SELECT r\.repository_id, r\.schedule_target, r\.task_id, r\.dedupe_key,/.test(sql));
  const docsStatement = statementBytes((sql) => /^SELECT id, repository_id, workspace_id, path, title, summary, tags, refs,/.test(sql));
  const getRunById = statementBytes((sql) => /^SELECT \* FROM multiremi_autopilot_runs WHERE id = \?$/.test(sql));
  const compilations = statementBytes((sql) => /FROM multiremi_knowledge_compilation_runs r LEFT JOIN multiremi_knowledge_compilation_outputs o/.test(sql) && /MAX\(o\.created_at\) AS publication_at/.test(sql));
  const taskById = statementBytes((sql) => /^SELECT \* FROM multiremi_tasks WHERE id = \?$/.test(sql));
  const autopilotById = statementBytes((sql) => /^SELECT \* FROM multiremi_autopilots WHERE id = \?$/.test(sql));
  const publishedProbe = statementBytes((sql) => /^SELECT 1 AS published FROM multiremi_repository_wiki_docs doc/.test(sql));

  return {
    repositories: repoCount,
    observabilityRows,
    buildStateRows: compilationRows.length,
    scopedRunsPerRepository: scopedRuns,
    scheduleOnlyRunsPerRepository: scheduleOnlyRuns,
    dbBytes: last.dbBytes,
    dbQueries: last.dbQueries,
    dbMs: Number(last.dbMs.toFixed(2)),
    dbParseMs: Number(last.dbParseMs.toFixed(2)),
    p50Ms: Number(percentile(durations, 0.5).toFixed(2)),
    maxMs: Number(Math.max(...durations).toFixed(2)),
    responseBytes: last.responseBytes,
    bytesPerRepository: Number((last.dbBytes / repoCount).toFixed(1)),
    bytesPerRepositoryResidual: Number(((last.dbBytes - observability.bytes - buildState.bytes) / repoCount).toFixed(1)),
    statements: {
      observability, buildState, publicationProbe, docsStatement, getRunById,
      compilations, taskById, autopilotById, publishedProbe,
    },
    topStatements: last.statements.slice(0, 14).map((entry) => ({ ...entry, sql: entry.label })),
    responseBody: last.body,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const outPath = outIndex >= 0 ? args[outIndex + 1]! : DEFAULT_OUT;
  if (!ADMIN_URL) throw new Error("MULTIREMI_TEST_POSTGRES_URL is required: db_bytes is a bridge measurement and cannot be taken on SQLite");
  const version = await postgresVersion(ADMIN_URL);
  if (!version) throw new Error("MULTIREMI_TEST_POSTGRES_URL is unreachable");

  const scenarios: ScenarioResult[] = [];
  for (const repoCount of REPO_COUNTS) {
    const result = await runScenario(repoCount, repoCount === REPO_COUNTS[0]);
    scenarios.push(result);
    const twoStatements = result.topStatements
      .filter((entry) => /FROM multiremi_autopilot_runs r/.test(entry.sql))
      .reduce((sum, entry) => sum + entry.bytes, 0);
    console.log(`repos=${String(repoCount).padStart(4)} db_bytes=${String(result.dbBytes).padStart(9)} `
      + `(${(result.dbBytes / 1048576).toFixed(2)} MiB) dbq=${String(result.dbQueries).padStart(4)} `
      + `p50=${result.p50Ms}ms parse=${result.dbParseMs}ms run-statements=${twoStatements} `
      + `obs=${result.statements.observability.bytes}/${result.statements.observability.rows}r `
      + `build=${result.statements.buildState.bytes}/${result.statements.buildState.rows}r `
      + `docs=${result.statements.docsStatement.bytes}/${result.statements.docsStatement.rows}r `
      + `probe=${result.statements.publicationProbe.bytes} getRun=${result.statements.getRunById.bytes}`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    issue: "MUL-398",
    stage: process.env.MUL398_A2_STAGE ?? "before",
    commit: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: REPO_ROOT }).stdout.toString().trim(),
    route: "/api/workspaces/:id/repository-wikis",
    runtime: {
      bun: Bun.version,
      platform: `${process.platform} ${process.arch}`,
      postgres: version,
      transport: "in-process app.request() over PostgresSyncDatabase (Worker + SharedArrayBuffer)",
      accounting: "Server-Timing dbb (production request-metrics db_bytes) + per-statement JSON.stringify({rows,count}) attribution",
    },
    fixture: {
      observabilityRows: OBSERVABILITY_ROWS,
      buildStateRows: BUILD_STATE_ROWS,
      payloadBytes: PAYLOAD_BYTES,
      resultBytes: RESULT_BYTES,
      docsPerRepository: DOCS_PER_REPO,
      docBodyBytes: DOC_BODY_BYTES,
      pageStorage: PAGE_STORAGE,
      repositoryCounts: REPO_COUNTS,
      source: "Explorer 209 probe (MUL-398 cmt_db48gqrimjk9)",
    },
    warmups: WARMUPS,
    samples: SAMPLES,
    scenarios,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nwrote ${outPath}`);
}

await main();
