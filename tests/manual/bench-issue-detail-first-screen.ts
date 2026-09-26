#!/usr/bin/env bun
/**
 * MUL-385: Issue detail first-screen route harness.
 *
 * Measures the three requests the detail page fires on open:
 *   GET /api/issues/:id
 *   GET /api/issues/:id/sessions
 *   GET /api/issues/:id/timeline?issue_session_id=@default&limit=40
 * plus the baseline-only `GET /api/issues/:id/comments` (the frontend defines
 * `listComments` but does not call it on open; MUL-249 moved the real work to
 * the timeline's SQL reverse pagination).
 *
 * The "before" numbers come from running the same file on the parent commit:
 * it drives the routes through `app.request`, so no code branch selects the
 * implementation under test.
 *
 * Per route it records dbq, db time, db bytes across the bridge, response
 * bytes and p50/p95 after warmup. `dbq` and db bytes are measured the way the
 * production worker does it: `PostgresSyncDatabase` replies with
 * `JSON.stringify({ rows, count })`, so the harness serializes exactly the rows
 * each statement returned and counts those bytes.
 *
 *   MULTIREMI_TEST_POSTGRES_URL=postgres://… \
 *     bun run tests/manual/bench-issue-detail-first-screen.ts --out /tmp/mul385.json
 *
 * Without `MULTIREMI_TEST_POSTGRES_URL` (or when the instance is unreachable)
 * the harness falls back to in-memory SQLite and records
 * `"database": "sqlite"` plus `"bridgeBytes": "simulated"` in the report.
 */
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { SqlDatabase, SqlStatement } from "../../packages/server/src/store/db/postgres.js";
import { MultiremiStore } from "../../packages/server/src/store/store.js";
import { createMultiremiApp } from "../../packages/server/src/api/server.js";
import {
  fillTaskBodies,
  seedIssueDetailFirstScreenFixture,
  type IssueDetailFixture,
  type IssueDetailFixtureOptions,
} from "../fixtures/multiremi/issue-detail-first-screen-fixture.js";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const DEFAULT_OUT = join(REPO_ROOT, "reports", "performance", "MUL-385-issue-detail-first-screen.json");
const ADMIN_URL = process.env.MULTIREMI_TEST_POSTGRES_URL ?? null;

const WARMUPS = Number(process.env.MUL385_WARMUPS ?? 5);
const SAMPLES = Number(process.env.MUL385_SAMPLES ?? 30);

interface CaseResult {
  label: string;
  method: string;
  path: string;
  status: number;
  samples: number;
  dbq: number;
  dbMs: number;
  dbBytes: number;
  dbRows: number;
  responseBytes: number;
  responseEntries: number;
  p50Ms: number;
  p95Ms: number;
  serverComputeMs: number;
  /** Lower bound on the per-statement breakdown (see the note in `measureCase`). */
  sqlBucketsTotal: number;
  /** Statements the same request issued more than once — the redundancy signal. */
  repeatedSql: Array<{ sql: string; count: number }>;
  topSql: Array<{ sql: string; count: number }>;
}

interface SqlProbe {
  statements: number;
  ms: number;
  bytes: number;
  rows: number;
  buckets: Map<string, { sql: string; count: number }>;
  reset(): void;
}

/**
 * Counts statements, time and bridge payload without changing results. `rows`
 * mirrors the worker's `JSON.stringify({ rows, count })` reply, so the byte
 * count is the same quantity production reports as `dbb`.
 */
function instrument(raw: SqlDatabase): { db: SqlDatabase; probe: SqlProbe } {
  const probe: SqlProbe = {
    statements: 0,
    ms: 0,
    bytes: 0,
    rows: 0,
    buckets: new Map(),
    reset() {
      this.statements = 0;
      this.ms = 0;
      this.bytes = 0;
      this.rows = 0;
      this.buckets = new Map();
    },
  };
  const record = (sql: string, rows: unknown[], startedAt: number): void => {
    probe.statements += 1;
    probe.ms += performance.now() - startedAt;
    const key = sql.replace(/\s+/g, " ").trim();
    const bucket = probe.buckets.get(key) ?? { sql: key, count: 0 };
    bucket.count += 1;
    probe.buckets.set(key, bucket);
    if (rows.length) {
      probe.rows += rows.length;
      probe.bytes += JSON.stringify({ rows, count: rows.length }).length;
    }
  };
  const wrap = (statement: SqlStatement, sql: string): SqlStatement => new Proxy(statement, {
    get(target, property) {
      const value = target[property as keyof SqlStatement];
      if (["get", "all", "run", "values"].includes(String(property))) {
        return (...params: unknown[]) => {
          const startedAt = performance.now();
          const result = (value as (...args: unknown[]) => unknown).apply(target, params);
          const rows = property === "get"
            ? (result == null ? [] : [result])
            : property === "values" || property === "all"
              ? (result as unknown[])
              : [];
          record(sql, rows, startedAt);
          return result;
        };
      }
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  const db = new Proxy(raw, {
    get(target, property) {
      if (property === "query" || property === "prepare") {
        return (sql: string) => wrap(target[property](sql) as unknown as SqlStatement, sql);
      }
      if (property === "run") {
        return (sql: string, ...params: unknown[]) => {
          const startedAt = performance.now();
          const result = (target.run as (...args: unknown[]) => unknown)(sql, ...params);
          record(sql, [], startedAt);
          return result;
        };
      }
      if (property === "exec") {
        return (sql: string) => {
          const startedAt = performance.now();
          const result = target.exec(sql);
          record(sql, [], startedAt);
          return result;
        };
      }
      const value = target[property as keyof SqlDatabase];
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as SqlDatabase;
  return { db, probe };
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
}

async function postgresReachable(url: string): Promise<boolean> {
  try {
    const probe = new Bun.SQL(url, { max: 1 });
    await probe`SELECT 1`;
    await probe.end();
    return true;
  } catch {
    return false;
  }
}

function countRows(store: MultiremiStore, path: string, body: unknown): number {
  if (Array.isArray(body)) return body.length;
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    for (const key of ["entries", "comments", "tasks", "sessions"]) {
      if (Array.isArray(record[key])) return (record[key] as unknown[]).length;
    }
  }
  void store;
  void path;
  return 0;
}

async function measureCase(
  app: ReturnType<typeof createMultiremiApp>,
  store: MultiremiStore,
  probe: SqlProbe,
  testCase: { label: string; path: string; headers: Record<string, string> },
): Promise<CaseResult> {
  const durations: number[] = [];
  let dbq = 0;
  let dbMs = 0;
  let dbBytes = 0;
  let dbRows = 0;
  let responseBytes = 0;
  let responseEntries = 0;
  let status = 0;
  let topSql: Array<{ sql: string; count: number }> = [];
  let sqlBucketsTotal = 0;
  let repeatedSql: Array<{ sql: string; count: number }> = [];
  let serverComputeMs = 0;

  for (let sample = 0; sample < WARMUPS + SAMPLES; sample += 1) {
    probe.reset();
    const startedAt = performance.now();
    const response = await app.request(testCase.path, { headers: testCase.headers });
    const text = await response.text();
    const elapsed = performance.now() - startedAt;
    status = response.status;
    if (response.status !== 200) {
      throw new Error(`${testCase.label}: HTTP ${response.status} ${text.slice(0, 300)}`);
    }
    if (sample < WARMUPS) continue;
    durations.push(elapsed);
    dbq = probe.statements;
    dbMs = Number(probe.ms.toFixed(3));
    dbBytes = probe.bytes;
    dbRows = probe.rows;
    responseBytes = text.length;
    responseEntries = countRows(store, testCase.path, JSON.parse(text) as unknown);
    serverComputeMs = Number(Math.max(0, elapsed - probe.ms).toFixed(3));
    topSql = [...probe.buckets.values()]
      .sort((left, right) => right.count - left.count || left.sql.localeCompare(right.sql))
      .slice(0, 40);
    // Diagnostics only: the driver may serve a cached statement without a fresh
    // bucket, so the breakdown is a lower bound on `dbq`. Repeated statements in
    // one request are exactly the redundancy this harness exists to expose, so
    // they are reported rather than rejected.
    sqlBucketsTotal = probe.buckets.size
      ? [...probe.buckets.values()].reduce((sum, bucket) => sum + bucket.count, 0)
      : 0;
    repeatedSql = [...probe.buckets.values()]
      .filter((bucket) => bucket.count > 1)
      .map((bucket) => ({ sql: bucket.sql, count: bucket.count }))
      .sort((left, right) => right.count - left.count || left.sql.localeCompare(right.sql));
  }

  return {
    label: testCase.label,
    method: "GET",
    path: testCase.path,
    status,
    samples: durations.length,
    dbq,
    dbMs,
    dbBytes,
    dbRows,
    responseBytes,
    responseEntries,
    p50Ms: Number(percentile(durations, 0.5).toFixed(3)),
    p95Ms: Number(percentile(durations, 0.95).toFixed(3)),
    serverComputeMs,
    sqlBucketsTotal,
    repeatedSql,
    topSql,
  };
}

/**
 * Auth-guard cost on the same three routes.
 *
 * The guard runs before every handler: `verifyAccessToken` (hash lookup, a
 * `last_used_at` write and a re-read) plus one membership read for a real user.
 * `denyCurrentUserWorkspaceAccess` itself never touches the database. This is
 * measured, not changed: MUL-385 must not weaken the token check, and the
 * numbers are recorded so a later regression is attributable.
 */
async function authGuardScan(
  store: MultiremiStore,
  app: ReturnType<typeof createMultiremiApp>,
  probe: SqlProbe,
  paths: Array<{ label: string; path: string }>,
): Promise<{ master: Array<{ label: string; dbq: number }>; userPat: Array<{ label: string; dbq: number }>; note: string }> {
  store.createWorkspaceMember({
    id: "mem_mul385_auth",
    workspaceId: "local",
    userId: "usr_mul385_auth",
    name: "MUL-385 auth probe",
    role: "member",
  });
  const pat = await store.createAccessToken({
    name: "MUL-385 auth probe",
    type: "pat",
    userId: "usr_mul385_auth",
    workspaceId: "local",
  });
  const scan = async (headers: Record<string, string>): Promise<Array<{ label: string; dbq: number }>> => {
    const out: Array<{ label: string; dbq: number }> = [];
    for (const testCase of paths) {
      probe.reset();
      const response = await app.request(testCase.path, { headers });
      if (response.status !== 200) throw new Error(`auth scan ${testCase.label}: HTTP ${response.status}`);
      out.push({ label: testCase.label, dbq: probe.statements });
    }
    return out;
  };
  return {
    master: await scan({ Authorization: "Bearer root-secret" }),
    userPat: await scan({ Authorization: `Bearer ${pat.token}` }),
    note: "user PAT adds verifyAccessToken (3 statements: hash lookup, last_used_at write, re-read) "
      + "and one workspace membership read; the master token adds none. "
      + "Unchanged by MUL-385 - recorded so a later drift is visible.",
  };
}

/**
 * Sessions N+1 scale scan: session count 1 / 5 / 20 on their own Issues, each
 * with the same participant shape, so `dbq` growth isolates the per-session work.
 */
async function sessionsScaleScan(
  store: MultiremiStore,
  app: ReturnType<typeof createMultiremiApp>,
  probe: SqlProbe,
  headers: Record<string, string>,
): Promise<Array<{ sessions: number; participants: number; dbq: number; dbMs: number; responseBytes: number }>> {
  const owner = store.getCurrentUser();
  const agent = store.createAgent({
    id: "agt_mul385_scale",
    name: "MUL-385 scale agent",
    provider: "codex",
    workspaceId: "local",
    ownerId: owner.id,
    visibility: "workspace",
  });
  const results: Array<{ sessions: number; participants: number; dbq: number; dbMs: number; responseBytes: number }> = [];
  for (const sessionCount of [1, 5, 20]) {
    const issue = store.createIssue({
      id: `iss_mul385_scale_${sessionCount}`,
      workspaceId: "local",
      title: `MUL-385 scale ${sessionCount} sessions`,
    });
    const sessions = [store.getOrCreateDefaultIssueSession(issue.id, owner.id)];
    for (let index = 1; index < sessionCount; index += 1) {
      sessions.push(store.createIssueSession(issue.id, {
        id: `ises_mul385_scale_${sessionCount}_${index}`,
        title: `scale session ${index}`,
      }));
    }
    let participants = 0;
    for (const session of sessions) {
      store.addSessionParticipant(session.id, {
        participantType: "member",
        participantId: "mem_local_local",
        role: "owner",
      });
      store.addSessionParticipant(session.id, {
        participantType: "agent",
        participantId: agent.id,
        role: "participant",
      });
      participants += 2;
    }
    probe.reset();
    const response = await app.request(`/api/issues/${issue.id}/sessions`, { headers });
    const text = await response.text();
    if (response.status !== 200) throw new Error(`scale ${sessionCount}: HTTP ${response.status} ${text.slice(0, 200)}`);
    results.push({
      sessions: sessionCount,
      participants,
      dbq: probe.statements,
      dbMs: Number(probe.ms.toFixed(3)),
      responseBytes: text.length,
    });
  }
  return results;
}

function fixtureReport(fixture: IssueDetailFixture, options: IssueDetailFixtureOptions): Record<string, unknown> {
  return {
    seed: "MUL-307 scale (long issue)",
    version: 1,
    issueId: fixture.issueId,
    issueKey: fixture.issueKey,
    defaultSessionId: fixture.defaultSessionId,
    counts: fixture.counts,
    options: {
      rootComments: options.rootComments ?? 105,
      replies: options.replies ?? 68,
      sessions: 1 + (options.sideSessions ?? 5),
      tasks: options.tasks ?? 54,
      taskPromptBytes: options.taskPromptBytes ?? 1200,
      taskResultBytes: options.taskResultBytes ?? 2400,
      decoratedComments: options.decoratedComments ?? 24,
      commentsPerSession: options.commentsPerSession ?? 24,
    },
    seedMs: fixture.seedMs,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const outPath = outIndex >= 0 ? args[outIndex + 1]! : DEFAULT_OUT;

  let database = "sqlite";
  let transport = "in-process app.request()";
  let postgresNote: string | null = ADMIN_URL ? null : "MULTIREMI_TEST_POSTGRES_URL is not set";
  let raw: SqlDatabase = new Database(":memory:");

  if (ADMIN_URL && await postgresReachable(ADMIN_URL)) {
    const { PostgresSyncDatabase } = await import("../../packages/server/src/store/db/postgres.js");
    const url = new URL(ADMIN_URL);
    const dbName = `multiremi_mul385_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
    const admin = new Bun.SQL(ADMIN_URL, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    await admin.end();
    url.pathname = `/${dbName}`;
    raw = new PostgresSyncDatabase(url.toString());
    database = "postgres";
    transport = `in-process app.request() over PostgresSyncDatabase (${dbName})`;
  } else if (ADMIN_URL) {
    postgresNote = "MULTIREMI_TEST_POSTGRES_URL is unreachable; fell back to SQLite + simulated bridge bytes";
  }

  const { db, probe } = instrument(raw);
  const store = new MultiremiStore(db);
  const run = (sql: string, params: unknown[]): void => { db.run(sql, ...params); };
  const fixture = seedIssueDetailFirstScreenFixture(store, { run });
  fillTaskBodies(run, fixture.taskIds, 2400);

  const app = createMultiremiApp({ store, authToken: "root-secret" });
  const headers = { Authorization: "Bearer root-secret" };

  const cases = [
    { label: "issue detail", path: `/api/issues/${fixture.issueId}`, headers },
    { label: "sessions", path: `/api/issues/${fixture.issueId}/sessions`, headers },
    {
      label: "timeline @default limit=40",
      path: `/api/issues/${fixture.issueId}/timeline?issue_session_id=%40default&limit=40`,
      headers,
    },
    { label: "comments (baseline only)", path: `/api/issues/${fixture.issueId}/comments`, headers },
  ];

  const results: CaseResult[] = [];
  for (const testCase of cases) {
    results.push(await measureCase(app, store, probe, testCase));
  }
  const scale = await sessionsScaleScan(store, app, probe, headers);
  const authGuard = await authGuardScan(store, app, probe, cases.map(({ label, path }) => ({ label, path })));

  const report = {
    generatedAt: new Date().toISOString(),
    issue: "MUL-385",
    parentIssue: "MUL-383",
    stage: process.env.MUL385_STAGE ?? "before",
    commit: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: REPO_ROOT }).stdout.toString().trim(),
    runtime: {
      bun: Bun.version,
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      cpus: (await import("node:os")).cpus().length,
      totalMemBytes: (await import("node:os")).totalmem(),
      database,
      bridgeBytes: "simulated (JSON.stringify({ rows, count }), same shape as pg-worker)",
      transport,
      postgresNote,
    },
    fixture: fixtureReport(fixture, {}),
    warmups: WARMUPS,
    samples: SAMPLES,
    results,
    sessionsScaleScan: scale,
    authGuard,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`wrote ${outPath}`);
  console.log(`database=${database} fixture=${fixture.counts.comments} comments, ${fixture.counts.sessions} sessions, ${fixture.counts.tasks} tasks`);
  console.log("label                            dbq   db_ms   db_bytes  resp_bytes    p50    p95  entries");
  for (const result of results) {
    console.log(
      `${result.label.padEnd(30)} ${String(result.dbq).padStart(4)} ${String(result.dbMs).padStart(7)} `
      + `${String(result.dbBytes).padStart(9)} ${String(result.responseBytes).padStart(11)} `
      + `${String(result.p50Ms).padStart(6)} ${String(result.p95Ms).padStart(6)} ${String(result.responseEntries).padStart(7)}`,
    );
  }
  console.log("sessions scale scan:", scale.map((point) => `${point.sessions}s=${point.dbq}dbq`).join(" "));

  if (raw instanceof Object && "close" in raw && typeof (raw as { close: unknown }).close === "function") {
    (raw as { close: () => void }).close();
  }
}

await main();
