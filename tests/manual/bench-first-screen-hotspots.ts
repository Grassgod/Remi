#!/usr/bin/env bun
/**
 * MUL-473 (S9-2, PR1): first-screen hotspot harness for the two routes PR1
 * changes.
 *
 *   GET /api/chat/pending-tasks
 *   GET /api/issues?assignee_id=…          (my-issues)
 *   GET /api/issues?assignee_id=<agent>    (the Agent branch of the filter resolver)
 *
 * The "before" numbers come from running this same file on the parent commit:
 * it drives the routes through `app.request`, so no branch in this file selects
 * the implementation under test.
 *
 * Per case it records dbq, db time, bridged bytes, response bytes and p50/p95
 * after warmup. dbq and the bytes are measured the way the production worker
 * does it: `PostgresSyncDatabase` replies with `JSON.stringify({ rows, count })`,
 * so counting those bytes is the same quantity production reports as `dbb`.
 *
 *   MULTIREMI_TEST_POSTGRES_URL=postgres://… \
 *     bun run tests/manual/bench-first-screen-hotspots.ts --out /tmp/mul473.json
 *
 * Without `MULTIREMI_TEST_POSTGRES_URL` (or when it is unreachable) the harness
 * falls back to in-memory SQLite and records that plus `"simulated"` bridge
 * bytes in the report.
 */
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { SqlDatabase, SqlStatement } from "../../packages/server/src/store/db/postgres.js";
import { MultiremiStore } from "../../packages/server/src/store/store.js";
import { createMultiremiApp } from "../../packages/server/src/api/server.js";
import { seedFirstScreenHotspotsFixture } from "../fixtures/multiremi/first-screen-hotspots-fixture.js";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const DEFAULT_OUT = resolve(REPO_ROOT, "reports/performance", "MUL-473-first-screen-hotspots.json");
const ADMIN_URL = process.env.MULTIREMI_TEST_POSTGRES_URL ?? null;
const WARMUPS = Number(process.env.MUL473_WARMUPS ?? 5);
const SAMPLES = Number(process.env.MUL473_SAMPLES ?? 20);
/** The issue's scale bar, plus a larger point so growth is visible. */
const SCALE = process.env.MUL473_SCALE === "before" ? [50] : [50, 200];

interface Probe {
  statements: number;
  ms: number;
  bytes: number;
  rows: number;
  bySql: Map<string, { sql: string; count: number }>;
  reset(): void;
}

function createProbe(): Probe {
  return {
    statements: 0,
    ms: 0,
    bytes: 0,
    rows: 0,
    bySql: new Map(),
    reset() {
      this.statements = 0;
      this.ms = 0;
      this.bytes = 0;
      this.rows = 0;
      this.bySql = new Map();
    },
  };
}

function instrument(raw: SqlDatabase, probe: Probe): SqlDatabase {
  const record = (sql: string, rows: unknown[], startedAt: number): void => {
    probe.statements += 1;
    probe.ms += performance.now() - startedAt;
    const key = sql.replace(/\s+/g, " ").trim();
    const bucket = probe.bySql.get(key) ?? { sql: key, count: 0 };
    bucket.count += 1;
    probe.bySql.set(key, bucket);
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
  return new Proxy(raw, {
    get(target, property) {
      if (property === "query" || property === "prepare") {
        return (sql: string) => wrap((target[property] as (sql: string) => SqlStatement).call(target, sql), sql);
      }
      if (property === "run") {
        return (sql: string, ...params: unknown[]) => {
          const startedAt = performance.now();
          const result = (target.run as (...args: unknown[]) => unknown).call(target, sql, ...params);
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
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]!;
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

interface CaseResult {
  label: string;
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
  topSql: Array<{ sql: string; count: number }>;
}

async function measureCase(
  app: ReturnType<typeof createMultiremiApp>,
  probe: Probe,
  testCase: { label: string; path: string; headers: Record<string, string>; entries: (body: unknown) => number },
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
  for (let sample = 0; sample < WARMUPS + SAMPLES; sample += 1) {
    probe.reset();
    const startedAt = performance.now();
    const response = await app.request(testCase.path, { headers: testCase.headers });
    const text = await response.text();
    const elapsed = performance.now() - startedAt;
    status = response.status;
    if (response.status !== 200) throw new Error(`${testCase.label}: HTTP ${response.status} ${text.slice(0, 300)}`);
    if (sample < WARMUPS) continue;
    durations.push(elapsed);
    dbq = probe.statements;
    dbMs = Number(probe.ms.toFixed(3));
    dbBytes = probe.bytes;
    dbRows = probe.rows;
    responseBytes = text.length;
    responseEntries = testCase.entries(JSON.parse(text) as unknown);
    topSql = [...probe.bySql.values()]
      .sort((left, right) => right.count - left.count || left.sql.localeCompare(right.sql))
      .slice(0, 20);
  }
  return {
    label: testCase.label,
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
    topSql,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const outPath = outIndex >= 0 ? args[outIndex + 1]! : DEFAULT_OUT;

  let database = "sqlite";
  let transport = "in-process app.request()";
  let postgresNote: string | null = ADMIN_URL ? null : "MULTIREMI_TEST_POSTGRES_URL is not set";
  let admin: InstanceType<typeof Bun.SQL> | null = null;
  let dbName: string | null = null;

  const scaleResults: Array<{
    sessions: number;
    agents: number;
    issues: number;
    inboxRows: number;
    results: CaseResult[];
  }> = [];

  for (const sessions of SCALE) {
    let raw: SqlDatabase = new Database(":memory:");
    if (ADMIN_URL && await postgresReachable(ADMIN_URL)) {
      const { PostgresSyncDatabase } = await import("../../packages/server/src/store/db/postgres.js");
      dbName = `multiremi_mul473_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
      admin = new Bun.SQL(ADMIN_URL, { max: 1 });
      await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE ${dbName}`);
      const url = new URL(ADMIN_URL);
      url.pathname = `/${dbName}`;
      raw = new PostgresSyncDatabase(url.toString());
      database = "postgres";
      transport = `in-process app.request() over PostgresSyncDatabase (${dbName})`;
    } else if (ADMIN_URL) {
      postgresNote = "MULTIREMI_TEST_POSTGRES_URL is unreachable; fell back to SQLite + simulated bridge bytes";
    }

    const probe = createProbe();
    const db = instrument(raw, probe);
    const store = new MultiremiStore(db);
    const fixture = seedFirstScreenHotspotsFixture(store, {
      sessions,
      // The response golden locks the private-Agent rule separately; this
      // harness measures the full batch, so every seeded Chat must be visible to
      // the caller it measures.
      privatePrimaryAgent: false,
      run: (sql, params) => { (db.run as (sql: string, ...params: unknown[]) => unknown)(sql, ...params); },
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const credential = await store.createAccessToken({
      name: "MUL-473 bench",
      type: "pat",
      userId: fixture.readerUserId,
      workspaceId: fixture.workspaceId,
      purpose: "session",
    });
    const headers = {
      Authorization: `Bearer ${credential.token}`,
      "X-Workspace-ID": fixture.workspaceId,
    };
    const cases = [
      {
        label: "GET /api/chat/pending-tasks",
        path: "/api/chat/pending-tasks",
        entries: (body: unknown) => (body as { tasks: unknown[] }).tasks.length,
      },
      {
        label: "GET /api/issues (assignee_id=usr_)",
        path: `/api/issues?assignee_id=${fixture.readerUserId}&limit=50`,
        entries: (body: unknown) => (body as { issues: unknown[] }).issues.length,
      },
      {
        label: "GET /api/issues (assignee_id=agt_)",
        path: `/api/issues?assignee_id=${fixture.agentIds[1]}&limit=50`,
        entries: (body: unknown) => (body as { issues: unknown[] }).issues.length,
      },
      {
        label: "GET /api/issues (assignee_id=<agent name>)",
        path: `/api/issues?assignee_id=${encodeURIComponent("Hotspot agent 5")}&limit=50`,
        entries: (body: unknown) => (body as { issues: unknown[] }).issues.length,
      },
    ];
    const results: CaseResult[] = [];
    for (const testCase of cases) results.push(await measureCase(app, probe, { ...testCase, headers }));
    scaleResults.push({
      sessions,
      agents: fixture.counts.agents,
      issues: fixture.counts.issues,
      inboxRows: fixture.counts.inboxRows,
      results,
    });

    if (dbName) {
      (raw as { close: () => void }).close();
      const cleanup = new Bun.SQL(ADMIN_URL!, { max: 1 });
      await cleanup.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await cleanup.end();
      dbName = null;
    } else {
      (raw as { close: () => void }).close();
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    issue: "MUL-473",
    stage: process.env.MUL473_STAGE ?? "after",
    commit: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: REPO_ROOT }).stdout.toString().trim(),
    runtime: {
      bun: Bun.version,
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      database,
      bridgeBytes: "simulated (JSON.stringify({ rows, count }), same shape as pg-worker)",
      transport,
      postgresNote,
    },
    warmups: WARMUPS,
    samples: SAMPLES,
    scale: scaleResults,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`wrote ${outPath}`);
  console.log(`database=${database}`);
  for (const point of scaleResults) {
    console.log(`\n-- sessions=${point.sessions} agents=${point.agents} issues=${point.issues} --`);
    console.log("label                                      dbq   db_ms   db_bytes  resp_bytes     p50     p95  entries");
    for (const result of point.results) {
      console.log(
        `${result.label.padEnd(42)} ${String(result.dbq).padStart(4)} ${String(result.dbMs).padStart(7)} `
        + `${String(result.dbBytes).padStart(9)} ${String(result.responseBytes).padStart(11)} `
        + `${String(result.p50Ms).padStart(7)} ${String(result.p95Ms).padStart(7)} ${String(result.responseEntries).padStart(7)}`,
      );
    }
  }
  if (admin) await admin.end();
}

await main();
