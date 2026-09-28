#!/usr/bin/env bun
/**
 * MUL-398 (MUL-383 A): per-request `db_bytes` harness for
 * `GET /api/workspaces/:id/repository-wikis` on real PostgreSQL.
 *
 * Why this route: on 209 the summary shipped ~12.2 MB per request from
 * `repositoryWikiObservability`'s `SELECT r.* FROM multiremi_autopilot_runs`
 * and ~10.8 MB from `listLatestRepositoryAutopilotRuns`. Both statements read
 * the whole run row, so `payload` and `result` — the two big columns — cross the
 * Postgres bridge even though the route only uses a handful of scalar fields.
 *
 * Accounting. `db_bytes` is not the HTTP response size; it is the payload the
 * bridge worker serializes into the shared buffer and the main thread parses
 * (`JSON.stringify({ rows, count })` per statement). The primary number below
 * is the production one: the route runs behind the real
 * `createRequestMetricsMiddleware` and the harness reads `dbb` / `dbq` / `db` /
 * `dbp` / `total` off the `Server-Timing` response header, the same values
 * production logs as `api_slow_request.db_bytes`. A metered `SqlDatabase`
 * wrapper records the per-statement attribution for diagnosis only.
 *
 *   MULTIREMI_TEST_POSTGRES_URL=postgres://… \
 *     bun run tests/manual/bench-repository-wikis-db-bytes.ts --out /tmp/before.json
 *
 * The "before" numbers come from running this same file on the parent commit,
 * so no code branch selects the implementation under test. Without a reachable
 * `MULTIREMI_TEST_POSTGRES_URL` the harness exits non-zero rather than falling
 * back: SQLite cannot show a bridge payload, and a silent fallback is exactly
 * how a "PG number" ends up reported from the wrong database.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { SqlDatabase, SqlStatement } from "../../packages/server/src/store/db/postgres.js";
import { MultiremiStore } from "../../packages/server/src/store/store.js";
import { createMultiremiApp } from "../../packages/server/src/api/server.js";
import {
  REPOSITORY_WIKIS_WORKSPACE_ID,
  seedRepositoryWikisBridgeFixture,
  type RepositoryWikisBridgeFixture,
  type RepositoryWikisBridgeFixtureOptions,
} from "../fixtures/multiremi/repository-wikis-bridge-fixture.js";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const DEFAULT_OUT = join(REPO_ROOT, "reports", "performance", "MUL-398-repository-wikis-db-bytes.json");
const ADMIN_URL = process.env.MULTIREMI_TEST_POSTGRES_URL?.trim() ?? "";
const ROUTE = "/api/workspaces/:id/repository-wikis";
const WARMUPS = Number(process.env.MUL398_WARMUPS ?? 1);
const SAMPLES = Number(process.env.MUL398_SAMPLES ?? 5);
const AUTH_TOKEN = "root-secret";

interface StatementSample {
  sql: string;
  calls: number;
  rows: number;
  bytes: number;
}

interface Sample {
  totalMs: number;
  dbMs: number;
  dbParseMs: number;
  dbQueries: number;
  dbBytes: number;
  responseBytes: number;
  repositories: number;
  /**
   * The parsed response body. The fix must change `db_bytes` only, so before
   * and after are compared field by field on this snapshot.
   */
  responseBody: unknown;
  /** Diagnosis only: per-statement attribution from the wrapper. */
  statements: StatementSample[];
}

/** Metered wrapper: counts statements and re-serializes replies the way pg-worker does. */
class MeteredDb implements SqlDatabase {
  private readonly byStatement = new Map<string, StatementSample>();
  constructor(private readonly inner: SqlDatabase) {}

  reset(): void { this.byStatement.clear(); }

  statements(): StatementSample[] {
    return [...this.byStatement.values()].map((entry) => ({ ...entry })).sort((left, right) => right.bytes - left.bytes);
  }

  private measure<T>(sql: string, run: () => T, rowsOf: (value: T) => unknown[] = () => []): T {
    const value = run();
    const rows = rowsOf(value);
    const key = statementLabel(sql);
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

/**
 * Collapse a statement to a stable label so per-SQL bytes can be ranked.
 *
 * Two statements can share the projection and table but differ in their WHERE
 * clause — MUL-398's two run queries do, which is exactly the distinction the
 * report has to show — so the normalized text after the table name is kept as a
 * suffix instead of being dropped.
 */
export function statementLabel(sql: string): string {
  const flat = sql.replace(/\s+/g, " ").trim();
  const select = /^SELECT\s+(.+?)\s+FROM\s+([A-Za-z0-9_]+)/i.exec(flat);
  if (select) {
    const head = `SELECT ${select[1]!.slice(0, 40)} FROM ${select[2]}`;
    const tail = flat.slice(flat.indexOf(` FROM ${select[2]}`) + ` FROM ${select[2]}`.length).trim();
    return tail ? `${head} ${tail.slice(0, 130)}` : head;
  }
  const insert = /^(INSERT(?: OR IGNORE)?\s+INTO)\s+([A-Za-z0-9_]+)/i.exec(flat);
  if (insert) return `${insert[1]!.toUpperCase()} ${insert[2]}`;
  const update = /^UPDATE\s+([A-Za-z0-9_]+)/i.exec(flat);
  if (update) return `UPDATE ${update[1]}`;
  const del = /^DELETE\s+FROM\s+([A-Za-z0-9_]+)/i.exec(flat);
  if (del) return `DELETE FROM ${del[1]}`;
  return flat.slice(0, 60);
}

/** Parse the production `Server-Timing` header the route's metrics middleware writes. */
export function parseServerTiming(header: string | null): { totalMs: number; dbMs: number; dbParseMs: number; dbQueries: number; dbBytes: number } {
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

/**
 * Sorted leaf paths of a JSON value, with array indexes collapsed to `[]`.
 *
 * Used to compare response contracts across commits without depending on row
 * ids, which differ between two fixture runs.
 */
export function leafPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) {
    const collected = new Set<string>();
    for (const entry of value) for (const path of leafPaths(entry, `${prefix}[]`)) collected.add(path);
    return [...collected].sort();
  }
  if (value && typeof value === "object") {
    const collected: string[] = [];
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      collected.push(...leafPaths((value as Record<string, unknown>)[key], prefix ? `${prefix}.${key}` : key));
    }
    return collected;
  }
  return [prefix];
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
}

async function postgresReachable(url: string): Promise<string | null> {
  try {
    const probe = new Bun.SQL(url, { max: 1 });
    const rows = await probe`SHOW server_version` as Array<{ server_version?: string }>;
    await probe.end();
    return String(rows[0]?.server_version ?? "unknown");
  } catch {
    return null;
  }
}

function summarize(samples: Sample[]): Record<string, unknown> {
  const durations = samples.map((sample) => sample.totalMs);
  return {
    samples: samples.length,
    warmups: WARMUPS,
    minMs: Number(Math.min(...durations).toFixed(3)),
    p50Ms: Number(percentile(durations, 0.5).toFixed(3)),
    p95Ms: Number(percentile(durations, 0.95).toFixed(3)),
    maxMs: Number(Math.max(...durations).toFixed(3)),
    dbBytes: samples[0]!.dbBytes,
    dbBytesAllEqual: samples.every((sample) => sample.dbBytes === samples[0]!.dbBytes),
    dbQueries: samples[0]!.dbQueries,
    dbQueriesAllEqual: samples.every((sample) => sample.dbQueries === samples[0]!.dbQueries),
    dbMs: Number(percentile(samples.map((sample) => sample.dbMs), 0.5).toFixed(3)),
    dbParseMs: Number(percentile(samples.map((sample) => sample.dbParseMs), 0.5).toFixed(3)),
    responseBytes: samples[0]!.responseBytes,
    repositories: samples[0]!.repositories,
    /** Wrapper attribution, the statement that dominates `dbBytes`. */
    topStatements: samples[0]!.statements.slice(0, 12),
  };
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
  const dbName = `multiremi_mul398_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new Bun.SQL(ADMIN_URL, { max: 1 });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  await admin.end();
  url.pathname = `/${dbName}`;

  const { PostgresSyncDatabase } = await import("../../packages/server/src/store/db/postgres.js");
  const raw = new PostgresSyncDatabase(url.toString());
  const metered = new MeteredDb(raw);
  const store = new MultiremiStore(metered);
  const run = (sql: string, params: unknown[]): void => { metered.run(sql, ...params); };

  const fixtureOptions: RepositoryWikisBridgeFixtureOptions = {
    pages: Number(process.env.MUL398_PAGES ?? 146),
    pageBodyBytes: Number(process.env.MUL398_PAGE_BODY_BYTES ?? 50_000),
    pageStorage: (process.env.MUL398_PAGE_STORAGE as "openviking" | "sql" | undefined) ?? "openviking",
    runs: Number(process.env.MUL398_RUNS ?? 130),
    scheduleOnlyRuns: Number(process.env.MUL398_SCHEDULE_ONLY_RUNS ?? 48),
    scheduleOnlyCompilationRuns: Number(process.env.MUL398_SCHEDULE_ONLY_COMPILATION_RUNS ?? 3),
    legacyRuns: Number(process.env.MUL398_LEGACY_RUNS ?? 0),
    runPayloadBytes: Number(process.env.MUL398_RUN_PAYLOAD_BYTES ?? 46_800),
    runResultBytes: Number(process.env.MUL398_RUN_RESULT_BYTES ?? 32_000),
    compilationRuns: Number(process.env.MUL398_COMPILATION_RUNS ?? 133),
    run,
  };
  const fixture: RepositoryWikisBridgeFixture = seedRepositoryWikisBridgeFixture(store, fixtureOptions);

  // Production shape check: how big the two columns really are in the database.
  const storedBytes = metered.query(
    `SELECT SUM(LENGTH(payload)) AS payload_bytes, SUM(LENGTH(result)) AS result_bytes,
            COUNT(*) AS runs FROM multiremi_autopilot_runs`,
  ).get() as { payload_bytes: number | bigint; result_bytes: number | bigint; runs: number | bigint };

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
      role: "all",
    },
  });

  const path = `/api/workspaces/${REPOSITORY_WIKIS_WORKSPACE_ID}/repository-wikis`;
  const headers = { Authorization: `Bearer ${AUTH_TOKEN}` };
  const samples: Sample[] = [];
  let status = 0;
  for (let index = 0; index < WARMUPS + SAMPLES; index += 1) {
    metered.reset();
    const startedAt = performance.now();
    const response = await app.request(path, { headers });
    const text = await response.text();
    const elapsed = performance.now() - startedAt;
    status = response.status;
    if (response.status !== 200) throw new Error(`${path}: HTTP ${response.status} ${text.slice(0, 300)}`);
    if (index < WARMUPS) continue;
    const parsed = JSON.parse(text) as { repositories?: unknown[] };
    const timing = parseServerTiming(response.headers.get("Server-Timing"));
    samples.push({
      totalMs: elapsed,
      dbMs: timing.dbMs,
      dbParseMs: timing.dbParseMs,
      dbQueries: timing.dbQueries,
      dbBytes: timing.dbBytes,
      responseBytes: text.length,
      repositories: (parsed.repositories?.length ?? 0),
      responseBody: parsed,
      statements: metered.statements(),
    });
  }

  const summary = summarize(samples);
  const report = {
    generatedAt: new Date().toISOString(),
    issue: "MUL-398",
    route: ROUTE,
    requestPath: path,
    stage: process.env.MUL398_STAGE ?? "before",
    commit: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: REPO_ROOT }).stdout.toString().trim(),
    runtime: {
      bun: Bun.version,
      platform: `${process.platform} ${process.arch}`,
      postgres: serverVersion,
      database: dbName,
      transport: "in-process app.request() over PostgresSyncDatabase (Worker + SharedArrayBuffer)",
      accounting: "Server-Timing dbb (production request-metrics db_bytes) + per-statement JSON.stringify({rows,count}) attribution",
    },
    fixture: {
      ...fixture.counts,
      seedMs: Number(fixture.seedMs.toFixed(1)),
      storedPayloadBytes: Number(storedBytes.payload_bytes ?? 0),
      storedResultBytes: Number(storedBytes.result_bytes ?? 0),
      storedRuns: Number(storedBytes.runs ?? 0),
    },
    result: { status, ...summary },
    /**
     * The contract half of the acceptance criterion: the route's response must
     * be identical before and after. `fieldPaths` is the sorted set of leaf
     * paths, so a dropped or renamed field fails a textual diff even when the
     * shape looks similar.
     */
    responseContract: {
      body: samples[0]!.responseBody,
      fieldPaths: leafPaths(samples[0]!.responseBody),
    },
    samples,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`wrote ${outPath}`);
  console.log(`database=postgres ${serverVersion} fixture: ${fixture.counts.pages} pages, `
    + `${fixture.counts.repositoryScopedRuns + fixture.counts.scheduleOnlyRuns} runs, `
    + `${(report.fixture.storedPayloadBytes / 1e6).toFixed(1)} MB payload + ${(report.fixture.storedResultBytes / 1e6).toFixed(1)} MB result stored`);
  console.log(`route status=${status} db_bytes=${samples[0]!.dbBytes} dbq=${samples[0]!.dbQueries} `
    + `p50=${summary.p50Ms}ms max=${summary.maxMs}ms response=${samples[0]!.responseBytes}B`);
  for (const statement of samples[0]!.statements.slice(0, 6)) {
    console.log(`  ${String(statement.bytes).padStart(10)} B  x${String(statement.calls).padStart(3)}  ${statement.sql}`);
  }

  raw.close();
  const cleanup = new Bun.SQL(ADMIN_URL, { max: 1 });
  await cleanup.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await cleanup.end();
}

await main();
