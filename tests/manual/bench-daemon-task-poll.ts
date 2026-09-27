#!/usr/bin/env bun
/**
 * MUL-474 (MUL-383 S8e): per-request `db_bytes` harness for the daemon's
 * task-level polls.
 *
 * The three routes a running task hits every 2.5 s:
 *   GET  /api/daemon/tasks/:taskId/status
 *   GET  /api/daemon/tasks/:taskId/steer
 *   POST /api/daemon/tasks/:taskId/messages   (one message)
 *
 * Why these: on 209 the two polls are the top two daemon routes by SQL, and both
 * the identity guard and the handler pulled the whole `multiremi_tasks` row --
 * including `prompt` (>=100 KB in production), `result` and `usage` -- across the
 * synchronous Postgres bridge. This harness makes that column visible by seeding
 * a task whose prompt is at least `MUL474_PROMPT_BYTES` (default 128 KB), and the
 * `Server-Timing` deltas are read for the same task on the same DB.
 *
 * Accounting. `db_bytes` is not the HTTP response size; it is what the bridge
 * worker serializes into the shared buffer and the main thread parses
 * (`JSON.stringify({ rows, count })` per statement). The judgement value is the
 * production one: the routes run behind the real `createRequestMetricsMiddleware`
 * and the harness reads `dbb` / `dbq` / `db` / `dbp` / `total` off the
 * `Server-Timing` response header -- the same values production logs as
 * `api_slow_request.db_*`. A metered `SqlDatabase` wrapper records the
 * per-statement attribution for diagnosis only; it does not feed the judgement.
 *
 *   MULTIREMI_TEST_POSTGRES_URL=postgres://... \
 *     bun run tests/manual/bench-daemon-task-poll.ts --out /tmp/mul474-before.json
 *
 * The "before" numbers come from running this same file on the parent commit, so
 * no code branch selects the implementation under test. Without a reachable
 * `MULTIREMI_TEST_POSTGRES_URL` the harness exits non-zero rather than falling
 * back: SQLite cannot show a bridge payload, and a silent fallback is exactly how
 * a "PG number" ends up reported from the wrong database.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { SqlDatabase, SqlStatement } from "../../packages/server/src/store/db/postgres.js";
import { MultiremiStore } from "../../packages/server/src/store/store.js";
import { createMultiremiApp } from "../../packages/server/src/api/server.js";
import {
  DAEMON_TASK_POLL_PROMPT_BYTES,
  seedDaemonTaskPollFixture,
  type DaemonTaskPollFixture,
} from "../fixtures/multiremi/daemon-task-poll-fixture.js";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const DEFAULT_OUT = join(REPO_ROOT, "reports", "performance", "MUL-474-daemon-task-poll.json");
const ADMIN_URL = process.env.MULTIREMI_TEST_POSTGRES_URL?.trim() ?? "";
const WARMUPS = Number(process.env.MUL474_WARMUPS ?? 2);
const SAMPLES = Number(process.env.MUL474_SAMPLES ?? 5);
const PROMPT_BYTES = Number(process.env.MUL474_PROMPT_BYTES ?? DAEMON_TASK_POLL_PROMPT_BYTES);
const RESULT_BYTES = Number(process.env.MUL474_RESULT_BYTES ?? 4_096);
const AUTH_TOKEN = "root-secret";
/** The fixture needs a key for the encrypted Feishu app secret in its config row. */
process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString("base64");
/** Pinned so the `status` body the harness records is comparable across runs. */
const PINNED_STARTED_AT = "2026-09-27T00:00:00.000Z";

interface StatementSample {
  sql: string;
  calls: number;
  rows: number;
  bytes: number;
}

interface Sample {
  route: string;
  status: number;
  totalMs: number;
  dbMs: number;
  dbParseMs: number;
  dbQueries: number;
  dbBytes: number;
  responseBytes: number;
  responseBody: unknown;
  statements: StatementSample[];
}

/** Metered wrapper: counts statements and re-serializes replies the way pg-worker does. */
class MeteredDb implements SqlDatabase {
  private readonly byStatement = new Map<string, StatementSample>();
  constructor(private readonly inner: SqlDatabase) {}

  /**
   * Forward the backend marker (MUL-407): migrations must not infer Postgres by
   * probing, so a wrapper that hides `dialect` would send this in-process store
   * down the SQLite migration branch and fail on `PRAGMA`.
   */
  get dialect() { return this.inner.dialect; }

  reset(): void { this.byStatement.clear(); }

  statements(): StatementSample[] {
    return [...this.byStatement.values()]
      .map((entry) => ({ ...entry }))
      .sort((left, right) => right.bytes - left.bytes);
  }

  /** Every statement the window issued, in stable order, for the shape assertions. */
  sqlTexts(): string[] {
    return [...this.byStatement.keys()];
  }

  private measure<T>(sql: string, run: () => T, rowsOf: (value: T) => unknown[] = () => []): T {
    const value = run();
    const rows = rowsOf(value);
    const key = sql.replace(/\s+/g, " ").trim();
    const entry = this.byStatement.get(key) ?? { sql: key, calls: 0, rows: 0, bytes: 0 };
    entry.calls += 1;
    entry.rows += rows.length;
    entry.bytes += rows.length ? JSON.stringify({ rows, count: rows.length }).length : 0;
    this.byStatement.set(key, entry);
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

function parseServerTiming(value: string | null): {
  totalMs: number; dbMs: number; dbParseMs: number; dbQueries: number; dbBytes: number;
} {
  const parse = (name: string): number => {
    const match = new RegExp(`${name};(?:desc="([0-9]+)"|dur=([0-9.]+))`).exec(value ?? "");
    return match ? Number(match[1] ?? match[2] ?? 0) : 0;
  };
  return {
    totalMs: parse("total"),
    dbMs: parse("db"),
    dbParseMs: parse("dbp"),
    dbQueries: parse("dbq"),
    dbBytes: parse("dbb"),
  };
}

async function postgresReachable(url: string): Promise<string | null> {
  try {
    const probe = new Bun.SQL(url, { max: 1 });
    const rows = await probe`SELECT version() AS version`;
    await probe.end();
    return String((rows[0] as { version?: string } | undefined)?.version ?? "unknown");
  } catch {
    return null;
  }
}

function daemonHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "content-type": "application/json" };
}

interface RouteCase {
  label: string;
  method: "GET" | "POST";
  path: (fixture: DaemonTaskPollFixture) => string;
  body?: (fixture: DaemonTaskPollFixture) => unknown;
}

function routeCases(): RouteCase[] {
  return [
    {
      label: "status",
      method: "GET",
      path: (fixture) => `/api/daemon/tasks/${fixture.taskId}/status`,
    },
    {
      label: "steer",
      method: "GET",
      path: (fixture) => `/api/daemon/tasks/${fixture.taskId}/steer`,
    },
    {
      label: "messages",
      method: "POST",
      path: (fixture) => `/api/daemon/tasks/${fixture.taskId}/messages`,
      // One message: the unit production sends most often, and the only shape
      // the per-request statement cap is defined on.
      body: () => ({ messages: [{ type: "text", content: "MUL-474 one message" }] }),
    },
  ];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const outPath = outIndex >= 0 ? args[outIndex + 1]! : DEFAULT_OUT;

  if (!ADMIN_URL) {
    throw new Error("MULTIREMI_TEST_POSTGRES_URL is required: db_bytes is a bridge measurement and cannot be taken on SQLite");
  }
  const serverVersion = await postgresReachable(ADMIN_URL);
  if (!serverVersion) throw new Error("MULTIREMI_TEST_POSTGRES_URL is unreachable");

  const url = new URL(ADMIN_URL);
  const dbName = `multiremi_mul474_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new Bun.SQL(ADMIN_URL, { max: 1 });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  await admin.end();
  url.pathname = `/${dbName}`;

  const { PostgresSyncDatabase } = await import("../../packages/server/src/store/db/postgres.js");
  const raw = new PostgresSyncDatabase(url.toString());
  const metered = new MeteredDb(raw);
  const store = new MultiremiStore(metered);
  store.ensureLocalWorkspace();
  const fixture = await seedDaemonTaskPollFixture(store, {
    promptBytes: PROMPT_BYTES,
    run: (sql, params) => { metered.run(sql, ...params); },
  });
  const storedPromptBytes = (metered.query(
    "SELECT LENGTH(prompt) AS prompt_bytes, LENGTH(result) AS result_bytes FROM multiremi_tasks WHERE id = ?",
  ).get(fixture.taskId) as { prompt_bytes: number | bigint; result_bytes: number | bigint | null } | null);

  metered.run("UPDATE multiremi_tasks SET started_at = ? WHERE id = ?", PINNED_STARTED_AT, fixture.taskId);

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
    },
  });

  const samples: Sample[] = [];
  for (const route of routeCases()) {
    for (let index = 0; index < WARMUPS + SAMPLES; index += 1) {
      metered.reset();
      const path = route.path(fixture);
      const startedAt = performance.now();
      const response = await app.request(path, {
        method: route.method,
        headers: daemonHeaders(fixture.daemonToken),
        ...(route.body ? { body: JSON.stringify(route.body(fixture)) } : {}),
      });
      const text = await response.text();
      const elapsed = performance.now() - startedAt;
      if (response.status !== 200) throw new Error(`${route.label}: HTTP ${response.status} ${text.slice(0, 300)}`);
      if (index < WARMUPS) continue;
      const timing = parseServerTiming(response.headers.get("Server-Timing"));
      samples.push({
        route: route.label,
        status: response.status,
        totalMs: Number(elapsed.toFixed(3)),
        dbMs: timing.dbMs,
        dbParseMs: timing.dbParseMs,
        dbQueries: timing.dbQueries,
        dbBytes: timing.dbBytes,
        responseBytes: text.length,
        responseBody: JSON.parse(text) as unknown,
        statements: metered.statements(),
      });
    }
  }

  const byRoute = samples.reduce<Record<string, Sample[]>>((accumulator, sample) => {
    (accumulator[sample.route] ??= []).push(sample);
    return accumulator;
  }, {});
  const routes = routeCases().map((route) => {
    const routeSamples = byRoute[route.label]!;
    const first = routeSamples[0]!;
    const stable = routeSamples.every((sample) =>
      sample.dbQueries === first.dbQueries && sample.dbBytes === first.dbBytes);
    return {
      label: route.label,
      method: route.method,
      path: route.path(fixture),
      samples: routeSamples.length,
      dbQueries: first.dbQueries,
      dbBytes: first.dbBytes,
      dbMs: first.dbMs,
      dbParseMs: first.dbParseMs,
      responseBytes: first.responseBytes,
      stableAcrossSamples: stable,
      sql: first.statements.map((statement) => statement.sql),
      statements: first.statements,
      responseBody: first.responseBody,
    };
  });

  // ── authority matrix + status golden ────────────────────────────────────────────────
  //
  // The guard's branches are reordered, not removed, so the same (credential, task)
  // pairs must keep the same answers. Recorded here so "before" and "after" can be
  // diffed field by field; the suites named in the acceptance criteria cover the rest.
  const emptyMessageId = "msg_mul474_matrix";
  const matrix: Array<{ label: string; path: string; method: "GET" | "POST"; token: string; body?: unknown }> = [
    { label: "owner daemon / status", method: "GET", path: `/api/daemon/tasks/${fixture.taskId}/status`, token: fixture.daemonToken },
    { label: "owner daemon / steer", method: "GET", path: `/api/daemon/tasks/${fixture.taskId}/steer`, token: fixture.daemonToken },
    { label: "foreign daemon / status", method: "GET", path: `/api/daemon/tasks/${fixture.taskId}/status`, token: fixture.foreignDaemonToken },
    { label: "foreign daemon / steer", method: "GET", path: `/api/daemon/tasks/${fixture.taskId}/steer`, token: fixture.foreignDaemonToken },
    {
      label: "foreign daemon / messages",
      method: "POST",
      path: `/api/daemon/tasks/${fixture.taskId}/messages`,
      token: fixture.foreignDaemonToken,
      body: { messages: [{ type: "text", content: "matrix" }] },
    },
    {
      label: "foreign daemon / complete",
      method: "POST",
      path: `/api/daemon/tasks/${fixture.taskId}/complete`,
      token: fixture.foreignDaemonToken,
      body: { output: "matrix" },
    },
    { label: "master token / status", method: "GET", path: `/api/daemon/tasks/${fixture.taskId}/status`, token: AUTH_TOKEN },
  ];
  const authority: Array<{ label: string; status: number; body: unknown }> = [];
  for (const entry of matrix) {
    const response = await app.request(entry.path, {
      method: entry.method,
      headers: daemonHeaders(entry.token),
      ...(entry.body === undefined ? {} : { body: JSON.stringify(entry.body) }),
    });
    const text = await response.text();
    authority.push({ label: entry.label, status: response.status, body: text ? JSON.parse(text) : null });
  }
  void emptyMessageId;

  // The `status` body the Feishu host renders, captured verbatim so a shape change
  // is a textual diff rather than a review question.
  const golden = samples.find((sample) => sample.route === "status")!.responseBody;

  const report = {
    generatedAt: new Date().toISOString(),
    issue: "MUL-474",
    parentIssue: "MUL-383",
    stage: process.env.MUL474_STAGE ?? "before",
    commit: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: REPO_ROOT }).stdout.toString().trim(),
    runtime: {
      bun: Bun.version,
      platform: `${process.platform} ${process.arch}`,
      postgres: serverVersion,
      database: dbName,
      transport: "in-process app.request() over PostgresSyncDatabase (Worker + SharedArrayBuffer)",
      accounting: "Server-Timing dbb/dbq (production request-metrics) + per-statement JSON.stringify({rows,count}) attribution",
    },
    fixture: {
      promptBytes: Number(storedPromptBytes?.prompt_bytes ?? 0),
      resultBytes: Number(storedPromptBytes?.result_bytes ?? 0),
      targetPromptBytes: PROMPT_BYTES,
    },
    warmups: WARMUPS,
    samplesPerRoute: SAMPLES,
    routes,
    authorityMatrix: authority,
    statusGolden: golden,
    raw: samples,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`wrote ${outPath}`);
  console.log(`database=postgres ${serverVersion} prompt=${report.fixture.promptBytes}B result=${report.fixture.resultBytes}B`);
  console.log("route         dbq      dbb   db_ms  resp_bytes  stable");
  for (const route of routes) {
    console.log(`${route.label.padEnd(12)} ${String(route.dbQueries).padStart(3)} ${String(route.dbBytes).padStart(8)} `
      + `${String(route.dbMs).padStart(7)} ${String(route.responseBytes).padStart(11)}  ${route.stableAcrossSamples}`);
  }

  raw.close();
  const cleanup = new Bun.SQL(ADMIN_URL, { max: 1 });
  await cleanup.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await cleanup.end();
  void fixture.foreignRuntimeId;
  void fixture.agentId;
}

await main();
