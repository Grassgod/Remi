import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { createMultiremiApp } from "@multiremi/api/server.js";
import {
  createRequestMetricsMiddleware, currentDbReplyOrigin, DB_REPLY_TRANSITION_EXCEPTIONS,
  DEFAULT_DB_REPLY_MAX_BYTES, resetRequestMetricsForTest, resolveDbReplyMaxBytes,
} from "@multiremi/observability/request-metrics.js";
import {
  PostgresReplyTooLargeError, PostgresSyncDatabase, postgresReplyMaxBytes,
  resetDbReplyLimitForTest, type SqlDatabase,
} from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store/store.js";
import { taskMessagePageRows } from "@multiremi/store/task-message-pagination.js";

const MIB = 1_048_576;
const originalLimit = process.env.MULTIREMI_PG_REPLY_MAX_BYTES;
const metrics = {
  enabled: true, slowRequestMs: 500, summaryIntervalMs: 60_000,
  summaryTopRoutes: 10, bufferCapacity: 256, role: "all" as const,
};
const pgMarker = { dialect: "postgres" } as SqlDatabase;

function defaultLimit(): void {
  delete process.env.MULTIREMI_PG_REPLY_MAX_BYTES;
  resetDbReplyLimitForTest();
}

afterEach(() => {
  if (originalLimit === undefined) delete process.env.MULTIREMI_PG_REPLY_MAX_BYTES;
  else process.env.MULTIREMI_PG_REPLY_MAX_BYTES = originalLimit;
  resetDbReplyLimitForTest();
  resetRequestMetricsForTest();
});

describe("MUL-398 C-1 effective reply limit", () => {
  it("warns once per resolution with only the invalid override as variable data", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const value of ["bad", "-1", "1.5", "NaN", "Infinity", "9007199254740992"]) {
        warn.mockClear();
        expect(resolveDbReplyMaxBytes({ MULTIREMI_PG_REPLY_MAX_BYTES: value })).toBe(8 * MIB);
        expect(warn.mock.calls).toEqual([["[pg-bridge] invalid MULTIREMI_PG_REPLY_MAX_BYTES", value]]);
      }
      for (const value of [undefined, "", " ", "0", " 2097152 "]) {
        warn.mockClear();
        expect(resolveDbReplyMaxBytes({ MULTIREMI_PG_REPLY_MAX_BYTES: value }))
          .toBe(value === "0" ? 0 : value === " 2097152 " ? 2 * MIB : DEFAULT_DB_REPLY_MAX_BYTES);
        expect(warn).not.toHaveBeenCalled();
      }
    } finally { warn.mockRestore(); }
  });

  it("keeps every HTTP exception registered and resolves its actual Hono pattern", async () => {
    defaultLimit();
    const db = new Database(":memory:");
    const store = new MultiremiStore(db);
    const realApp = createMultiremiApp({ store, backgroundJobs: false, authToken: "c1-fixture" });
    const registered = new Set(realApp.routes.map(route => `${route.method} ${route.path}`));
    try {
      for (const key of DB_REPLY_TRANSITION_EXCEPTIONS) {
        if (key === "<background> <background>") continue;
        expect(registered.has(key), key).toBe(true);
        const [method, pattern] = key.split(" ") as [string, string];
        const app = new Hono();
        app.use("*", createRequestMetricsMiddleware(metrics));
        app.on(method, pattern, c => c.json({
          origin: currentDbReplyOrigin(), bytes: postgresReplyMaxBytes(), rows: taskMessagePageRows(pgMarker),
        }));
        const response = await app.request(pattern.replace(/:[^/]+/g, "fixture"), { method });
        expect(await response.json(), key).toEqual({
          origin: { method, route: pattern }, bytes: 64 * MIB, rows: 8,
        });
      }
    } finally { db.close(); }
  });

  it("preserves background's eight-row page as an independent removable exception", () => {
    defaultLimit();
    expect(currentDbReplyOrigin()).toEqual({ method: "<background>", route: "<background>" });
    expect(postgresReplyMaxBytes()).toBe(64 * MIB);
    expect(taskMessagePageRows(pgMarker)).toBe(8);
  });

  it("shares the effective limit with pagination and retains HTTP origin with metrics off", async () => {
    defaultLimit();
    for (const enabled of [true, false]) {
      const app = new Hono();
      app.use("*", createRequestMetricsMiddleware({ ...metrics, enabled }));
      const result = () => ({ bytes: postgresReplyMaxBytes(), rows: taskMessagePageRows(pgMarker) });
      app.post("/api/daemon/tasks/:taskId/messages", c => c.json(result()));
      app.get("/api/c1/nonexception", c => c.json(result()));
      expect(await (await app.request("/api/daemon/tasks/fixture/messages", { method: "POST" })).json())
        .toEqual({ bytes: 64 * MIB, rows: 8 });
      const ordinary = await app.request("/api/c1/nonexception");
      expect(await ordinary.json()).toEqual({ bytes: 8 * MIB, rows: 1 });
      expect(Boolean(ordinary.headers.get("Server-Timing"))).toBe(enabled);
      process.env.MULTIREMI_PG_REPLY_MAX_BYTES = "0";
      resetDbReplyLimitForTest();
      expect(await (await app.request("/api/c1/nonexception")).json()).toEqual({ bytes: 64 * MIB, rows: 8 });
      defaultLimit();
    }
    const sqlite = new Database(":memory:");
    try { expect(taskMessagePageRows(sqlite)).toBe(8); }
    finally { sqlite.close(); }
  });
});

const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
let pgAvailable = false;
if (adminUrl) {
  const admin = new Bun.SQL(adminUrl, { max: 1, connectionTimeout: 2 });
  try { await admin.unsafe("SELECT 1"); pgAvailable = true; }
  catch { /* The SQLite run does not require a PostgreSQL service. */ }
  finally { await admin.end(); }
}

describe.skipIf(!pgAvailable)("MUL-398 C-1 real PostgreSQL", () => {
  it("allows exception replies and rejects ordinary replies before parse at the same effective limit", async () => {
    defaultLimit();
    const db = new PostgresSyncDatabase(adminUrl!);
    const app = new Hono();
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation(line => { lines.push(String(line)); });
    let caught: unknown;
    app.use("*", createRequestMetricsMiddleware(metrics));
    const read = (size: number) => db.query("SELECT repeat('x', ?) AS body").get(size) as { body: string };
    app.get("/api/tasks/:taskId/messages", c => c.json({ bytes: read(24 * MIB).body.length }));
    app.get("/api/c1/nonexception", c => c.json({ bytes: read(9 * MIB).body.length }));
    app.onError((error, c) => { caught = error; return c.json({ error: error.message }, 500); });
    try {
      const exception = await app.request("/api/tasks/fixture/messages");
      expect(exception.status).toBe(200);
      expect(await exception.json()).toEqual({ bytes: 24 * MIB });
      expect(lines.some(line => JSON.parse(line).event === "api_db_reply_rejected")).toBe(false);
      const ordinary = await app.request("/api/c1/nonexception");
      expect(ordinary.status).toBe(500);
      expect(caught).toBeInstanceOf(PostgresReplyTooLargeError);
      const rejected = lines.map(line => JSON.parse(line)).find(line => line.event === "api_db_reply_rejected");
      expect(rejected).toMatchObject({ method: "GET", route: "/api/c1/nonexception", max_bytes: 8 * MIB });
      expect(rejected.bytes).toBeGreaterThan(8 * MIB);
      expect(ordinary.headers.get("Server-Timing")).toContain("dbp;dur=0.0");
      expect(await (await app.request("/api/tasks/fixture/messages")).json()).toEqual({ bytes: 24 * MIB });
    } finally { log.mockRestore(); db.close(); }
  });

  it("completes the preflight's 20 queued half-MiB prompts under the unset default", async () => {
    defaultLimit();
    const admin = new Bun.SQL(adminUrl!, { max: 1 });
    const name = `mul398_c1_queued_${process.pid}`;
    let db: PostgresSyncDatabase | undefined;
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await admin.unsafe(`CREATE DATABASE ${name}`);
      const url = new URL(adminUrl!); url.pathname = `/${name}`;
      db = new PostgresSyncDatabase(url.toString());
      const store = new MultiremiStore(db);
      const agent = store.createAgent({ name: "C1 queued", provider: "codex" });
      const autopilot = store.createAutopilot({ title: "C1 queued", assigneeId: agent.id, status: "active", executionMode: "run_only" });
      const insert = db.prepare(`INSERT INTO multiremi_autopilot_runs
        (id, autopilot_id, source, status, triggered_at, created_at, schedule_batch_id, schedule_prompt, payload)
        VALUES (?, ?, 'schedule', 'queued', ?, ?, 'c1_batch', ?, '{}')`);
      db.transaction(() => {
        for (let i = 0; i < 20; i++) insert.run(`c1_run_${i}`, autopilot.id,
          "2026-09-28T00:00:00.000Z", "2026-09-28T00:00:00.000Z", "x".repeat(512 * 1024));
      })();
      expect(() => store.advanceScheduledTargetRuns()).not.toThrow();
      const replies = log.mock.calls.map(([line]) => { try { return JSON.parse(String(line)); } catch { return null; } });
      expect(replies.some(line => line?.event === "api_large_db_reply" && line.method === "<background>" && line.bytes > 8 * MIB)).toBe(true);
      expect(replies.some(line => line?.event === "api_db_reply_rejected")).toBe(false);
    } finally {
      log.mockRestore(); db?.close();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    }
  });
});
