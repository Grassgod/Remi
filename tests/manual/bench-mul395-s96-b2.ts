/** S9-6 B2: fixed H1/H2 fixture, full HTTP first + five warmups + twenty samples. */
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
  const fixture = seedFirstScreenHotspotsFixture(store, { sessions: 20, agents: 20, issues: 20, inboxRows: 0,
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
  const issueId = fixture.issueIds[0]!;
  // Legacy rows can carry both issue and chat identities; these exercise the
  // route's existing creator/task-token permission rule.
  for (const taskId of fixture.taskIds) db.run("UPDATE multiremi_tasks SET issue_id = ? WHERE id = ?", [issueId, taskId]);
  for (let i = 0; i < 200; i++) {
    const task = store.createTask({ id: `tsk_b2_terminal_${i}`, agentId: fixture.agentIds[1]!, issueId, prompt: "terminal".repeat(2000) });
    db.run("UPDATE multiremi_tasks SET status = 'completed', result = ?, codex_profile = ? WHERE id = ?", ["result".repeat(2000), JSON.stringify({ fixture: "profile".repeat(2000) }), task.id]);
  }
  const plainTask = store.createTask({ id: "tsk_b2_plain", agentId: fixture.agentIds[1]!, issueId, prompt: "public prompt" });
  for (let i = 0; i < 20; i++) store.createProject({ id: `prj_b2_${i}`, title: `Project ${i}`, workspaceId: "local", description: i % 2 ? null : "summary", instructions: "instructions".repeat(2000), deltaInstructions: "delta".repeat(2000) });
  await measure("active-owner", `/api/issues/${issueId}/active-task`, owner.token);
  await measure("active-reader", `/api/issues/${issueId}/active-task`, reader.token);
  db.run("UPDATE multiremi_tasks SET status = 'completed' WHERE issue_id = ?", [issueId]);
  await measure("active-empty", `/api/issues/${issueId}/active-task`, owner.token);
  await measure("agents-owner", "/api/agents", owner.token);
  await measure("agents-reader", "/api/agents", reader.token);
  await measure("agents-archive-alias", "/api/agents?includeArchived=true", reader.token);
  await measure("projects-owner", "/api/projects", owner.token);
  await measure("projects-reader", "/api/projects", reader.token);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ database: postgres ? "postgres-18.3" : "sqlite", bun: Bun.version,
    bridgeDiagnosticMiB: postgres ? 128 : null, fixture: { terminalTasks: 200, chatSessions: 20, agents: 20, projects: 20 }, warmups: 5, steadySamples: 20,
    selection: process.env.MUL395_BENCH_ONLY ?? "all",
    byteMethod: postgres ? "actual Server-Timing dbb bridge counter, whole authenticated route" : "all driver replies JSON {rows,count}, including empty replies; driver elapsed time", results }, null, 2));
} finally {
  restore(); raw.close();
  if (postgres && dbName) { const admin = new Bun.SQL(postgres, { max: 1 }); await admin.unsafe(`DROP DATABASE ${dbName} WITH (FORCE)`); await admin.end(); }
}
