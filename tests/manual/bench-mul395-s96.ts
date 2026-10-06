/** Identical runner on the S9-6 parent and head: first read + 5 warmups + all 20 samples. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";
import { createMultiremiApp } from "@multiremi/api.js";
import { seedFirstScreenHotspotsFixture } from "../fixtures/multiremi/first-screen-hotspots-fixture";
import { installFirstScreenHotspotIds } from "../fixtures/multiremi/first-screen-hotspots-normalize";
import { scrubInheritedEnv } from "../setup/hermetic-env-policy";
import { parseServerTiming } from "../../frontend/scripts/perf/lib/harness";

scrubInheritedEnv();
const postgres = process.env.MULTIREMI_TEST_POSTGRES_URL;
const out = process.argv[process.argv.indexOf("--out") + 1];
if (!out) throw new Error("--out is required");
let dbName: string | undefined;
let raw: SqlDatabase;
if (postgres) {
  dbName = `s96_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Bun.SQL(postgres, { max: 1 });
  await admin.unsafe(`CREATE DATABASE ${dbName}`); await admin.end();
  const address = new URL(postgres); address.pathname = `/${dbName}`;
  // Both revisions reserve 128MiB for diagnostic byte counting. The existing
  // 64MiB effective ceiling still rejects the old 5000 × 16KiB response.
  raw = new PostgresSyncDatabase(address.toString(), 128 * 1024 * 1024);
} else raw = openSqliteDatabase(":memory:") as unknown as SqlDatabase;
let bytes = 0, ms = 0, rows = 0, sql: string[] = [];
const record = (query: string, result: unknown, start: number, method: string) => {
  const values = method === "get" ? result == null ? [] : [result] : method === "all" ? result as unknown[] : [];
  ms += performance.now() - start; rows += values.length;
  bytes += Buffer.byteLength(JSON.stringify({ rows: values, count: values.length }));
  sql.push(query.replace(/\s+/g, " ").trim());
};
const db = new Proxy(raw, { get(target, key) {
  if (key === "query" || key === "prepare") return (query: string) => new Proxy(target[key](query), { get(st, method) {
    const value = Reflect.get(st, method);
    if (["get", "all", "run"].includes(String(method))) return (...args: unknown[]) => {
      const start = performance.now();
      let result;
      try { result = value.apply(st, args); }
      catch (error) { sql.push(query.replace(/\s+/g, " ").trim()); throw error; }
      record(query, result, start, String(method)); return result;
    };
    return typeof value === "function" ? value.bind(st) : value;
  } });
  if (key === "run" || key === "exec") return (query: string, ...args: unknown[]) => {
    const start = performance.now(), result = target[key](query, ...args); record(query, result, start, String(key)); return result;
  };
  const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
} }) as SqlDatabase;
const restore = installFirstScreenHotspotIds();
try {
  const store = new MultiremiStore(db);
  const fixture = seedFirstScreenHotspotsFixture(store, { sessions: 100, agents: 3, issues: 0, inboxRows: 0,
    taskPromptBytes: 2048, run: (query, params) => db.run(query, params) });
  const owner = await store.createAccessToken({ name: "S96 owner", type: "pat", userId: fixture.ownerUserId, workspaceId: "local" });
  const reader = await store.createAccessToken({ name: "S96 reader", type: "pat", userId: fixture.readerUserId, workspaceId: "local" });
  const app = createMultiremiApp({ store, authToken: "s96-local-fixture-root" });
  const results: unknown[] = [];
  async function measure(label: string, path: string, token: string) {
    if (process.env.MUL395_BENCH_ONLY && process.env.MUL395_BENCH_ONLY !== label) return;
    const samples: unknown[] = []; let first: unknown; let queries: string[] = [];
    for (let index = -6; index < 20; index++) {
      bytes = ms = rows = 0; sql = [];
      const start = performance.now();
      const response = await app.request(path, { headers: { Authorization: `Bearer ${token}`, "X-Workspace-ID": "local" } });
      const body = await response.text();
      const parsed = response.status === 200 ? JSON.parse(body) : null;
      const timing = parseServerTiming(response.headers.get("server-timing"));
      const sample = { round: index, status: response.status, totalMs: performance.now() - start,
        dbMs: postgres ? timing.db : ms, dbBytes: postgres ? timing.dbb : bytes,
        dbq: postgres ? timing.dbq : sql.length, dbRows: rows, responseBytes: Buffer.byteLength(body),
        responseRows: Array.isArray(parsed) ? parsed.length : null,
        responseSha256: new Bun.CryptoHasher("sha256").update(body).digest("hex") };
      if (response.status !== 200 && !(process.env.MUL395_ALLOW_OVERFLOW === "1" && label === "summary-5000-16KiB" && response.status === 500)) throw new Error(`${label}: HTTP ${response.status}`);
      if (index === -6) first = sample;
      if (index >= 0) samples.push(sample);
      queries = [...sql];
    }
    results.push({ label, path, first, samples, queries });
    console.log(`${label}: sampled first + 20 steady requests`);
  }
  const insert = `INSERT INTO multiremi_inbox_items
    (id,workspace_id,member_id,recipient_type,recipient_id,severity,actor_type,type,title,body,details,read,archived,created_at)
    VALUES (?,'local',?,'member',?,'info','system','autopilot_run_completed','run','',?, ?,0,?)`;
  db.transaction(() => {
    for (let i = 0; i < 5000; i++) db.run(insert, [`inb_s96_run_${i}`, fixture.readerMemberId, fixture.readerMemberId,
      JSON.stringify({ autopilot_id: `atp_${i % 20}`, filler: "x".repeat(2048) }), i % 2,
      new Date(Date.UTC(2026, 8, 12 + i % 14, 9)).toISOString()]);
  })();
  await measure("summary-5000-2KiB", "/api/inbox/summary?timezone_offset=-480", reader.token);
  db.transaction(() => {
    for (let i = 0; i < 5000; i++) db.run("UPDATE multiremi_inbox_items SET details = ? WHERE id = ?",
      [JSON.stringify({ autopilot_id: `atp_${i % 20}`, filler: "x".repeat(16384) }), `inb_s96_run_${i}`]);
  })();
  await measure("summary-5000-16KiB", "/api/inbox/summary?timezone_offset=-480", reader.token);
  await measure("snapshot-owner-one-visible", "/api/agent-task-snapshot", owner.token);
  await measure("snapshot-reader-100-visible", "/api/agent-task-snapshot", reader.token);
  // Nine single-task sessions change creator; the owner's existing task makes
  // exactly ten visible results. Revert before the fixed-visibility size probe.
  for (let index = 10; index < 19; index++) db.run("UPDATE multiremi_chat_sessions SET creator_id = ? WHERE id = ?", [fixture.ownerUserId, `chat_hotspot_${index}`]);
  await measure("snapshot-owner-ten-visible", "/api/agent-task-snapshot", owner.token);
  for (let index = 10; index < 19; index++) db.run("UPDATE multiremi_chat_sessions SET creator_id = ? WHERE id = ?", [fixture.readerUserId, `chat_hotspot_${index}`]);
  db.run("UPDATE multiremi_tasks SET prompt = ?, result = ?, codex_profile = ? WHERE chat_session_id IN (SELECT id FROM multiremi_chat_sessions WHERE creator_id = ?)",
    ["p".repeat(16384), "r".repeat(16384), JSON.stringify({ filler: "x".repeat(16384) }), fixture.readerUserId]);
  await measure("snapshot-owner-large-hidden", "/api/agent-task-snapshot", owner.token);
  db.run("UPDATE multiremi_tasks SET status = 'cancelled' WHERE chat_session_id = 'chat_hotspot_foreign'");
  await measure("snapshot-owner-zero-visible", "/api/agent-task-snapshot", owner.token);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ database: postgres ? "postgres-18.3" : "sqlite", bun: Bun.version,
    bridgeDiagnosticMiB: postgres ? 128 : null, fixture: { runs: 5000, chatSessions: 100, agents: 3 }, warmups: 5, steadySamples: 20,
    selection: process.env.MUL395_BENCH_ONLY ?? "all",
    byteMethod: postgres ? "actual Server-Timing dbb bridge counter, whole authenticated route" : "all driver replies JSON {rows,count}, including empty replies; driver elapsed time", results }, null, 2));
} finally {
  restore(); raw.close();
  if (postgres && dbName) { const admin = new Bun.SQL(postgres, { max: 1 }); await admin.unsafe(`DROP DATABASE ${dbName} WITH (FORCE)`); await admin.end(); }
}
