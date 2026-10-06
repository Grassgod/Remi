// Local, disposable PG only. Credentials stay in the child environment, never in output.
import { writeFileSync } from "node:fs";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { readProcessDbCounters } from "../../packages/server/src/observability/request-metrics.js";
import { openHotspotDatabase } from "../fixtures/multiremi/first-screen-hotspots-database.js";
import { seedFirstScreenHotspotsFixture } from "../fixtures/multiremi/first-screen-hotspots-fixture.js";

if (!process.env.MULTIREMI_TEST_POSTGRES_URL) throw new Error("Explicit disposable PostgreSQL required");
const database = await openHotspotDatabase();
let maximumReplyBytes = 0;
let queryWaits: Array<{wait_ms:number;bytes:number}> = [];
const measured = (fn: (...args: any[]) => any) => (...args: any[]) => {
  const beforeCounters=readProcessDbCounters();
  const before = beforeCounters.dbBytes;
  try { return fn(...args); }
  finally { const after=readProcessDbCounters(); queryWaits.push({wait_ms:after.dbMs-beforeCounters.dbMs,bytes:after.dbBytes-before}); maximumReplyBytes = Math.max(maximumReplyBytes, after.dbBytes - before); }
};
const db = new Proxy(database.db, { get(target, property) {
  if (property === "query" || property === "prepare") return (sql: string) => {
    const statement = target[property](sql);
    return new Proxy(statement, { get(statementTarget, key) {
      const value = Reflect.get(statementTarget, key);
      return typeof value === "function" ? measured(value.bind(statementTarget)) : value;
    } });
  };
  const value = Reflect.get(target, property, target);
  return typeof value === "function" ? (["run", "exec"].includes(String(property))
    ? measured(value.bind(target)) : value.bind(target)) : value;
} }) as SqlDatabase;
const store = new MultiremiStore(db);
const tasks = Number(process.env.MUL395_TASKS ?? 5000);
const samples = Number(process.env.MUL395_SAMPLES ?? 20);
const warmups = 5;
const out = process.argv[process.argv.indexOf("--out") + 1];
if (!out || !process.argv.includes("--out")) throw new Error("--out required");
const diff = (a: ReturnType<typeof readProcessDbCounters>, b: typeof a) => ({
  db_queries: b.dbQueries - a.dbQueries, db_ms: b.dbMs - a.dbMs, bridge_bytes: b.dbBytes - a.dbBytes,
});
const release = { version: "0.2.85", tag: "v0.2.85", channel: "stable", manifestUrl: "https://example.test/platform-release.json" };
try {
  const fixture = seedFirstScreenHotspotsFixture(store, { sessions: Number(process.env.QA_S95_SESSIONS ?? 250), agents: 20, issues: 10,
    inboxRows: 0, privatePrimaryAgent: false, skillBodyBytes: 16384,
    run: (sql, params) => db.run(sql, params) });
  const runtimeIds = [fixture.runtimeId];
  for (let i = 1; i < 10; i++) {
    const id = `rt_s95_${i}`;
    store.registerRuntime({ id, workspaceId: "local", name: id, provider: "codex", ownerId: fixture.readerUserId,
      daemonId: `daemon_s95_${i}`, metadata: { cli_version: "0.2.85" } });
    runtimeIds.push(id);
  }
  db.run("UPDATE multiremi_tasks SET status = 'completed', runtime_id = ?", fixture.runtimeId);
  const usage = JSON.stringify([{ inputTokens: 1234, output_tokens: 567, cacheReadTokens: 89, cache_write_tokens: 10,
    model: "fixture-" + "m".repeat(300), provider: "codex" }]);
  db.run(`INSERT INTO multiremi_tasks
    (id, workspace_id, agent_id, runtime_id, status, prompt, usage, created_at, updated_at)
    SELECT 'tsk_s95_' || g, 'local', ?, CASE WHEN g % 10 = 0 THEN ? ELSE 'rt_s95_' || (g % 10) END,
      CASE WHEN g <= 10 THEN 'running' ELSE 'completed' END, 'fixture', ?,
      '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z'
    FROM generate_series(1, ?) g`, fixture.primaryAgentId, fixture.runtimeId, usage, tasks);
  const credential = await store.createAccessToken({ name: "S95 disposable fixture", type: "pat",
    userId: fixture.readerUserId, workspaceId: "local" });
  const headers = { Authorization: `Bearer ${credential.token}`, "X-Workspace-ID": "local" };
  const app = createMultiremiApp({ store, authToken: "fixture-master", platformUpdaterToken: "fixture-updater" });
  const phases: Record<string, unknown[]> = {};
  for (const name of ["heartbeatPlatformUpdater", "claimDuePlatformAutoUpdateCheck", "getActivePlatformOperation", "reconcileRuntimeCliRelease", "getPlatformState"] as const) {
    const original = store[name].bind(store) as (...args: any[]) => unknown;
    (store[name] as any) = (...args: any[]) => {
      const a = readProcessDbCounters(), start = performance.now();
      const value = original(...args);
      (phases[name] ??= []).push({ ...diff(a, readProcessDbCounters()), elapsed_ms: performance.now() - start });
      return value;
    };
  }
  const results = [];
  let activeOperation: string | undefined;
  const updaterInit = { method: "POST", headers: {
    "Content-Type": "application/json", Authorization: "Bearer fixture-master", "X-Multiremi-Updater-Token": "fixture-updater" },
    body: JSON.stringify({ driver: "docker_compose", currentRelease: release, latestRelease: release }) };
  for (const [label, path, init] of [
    ["chat", "/api/chat/sessions", { headers }],
    ["runtimes", "/api/runtimes", { headers }],
    ...(process.env.MUL395_USAGE_CASES ? [["runtimes invalidated", "/api/runtimes", { headers }]] as const : []),
    ["execution-groups", "/api/execution-groups", { headers }],
    ["models", "/api/models", { headers }],
    ["heartbeat", "/api/platform-updater/heartbeat", updaterInit],
    ...(process.env.MUL395_HEARTBEAT_CASES ? [
      ["heartbeat due", "/api/platform-updater/heartbeat", updaterInit],
      ["heartbeat busy", "/api/platform-updater/heartbeat", updaterInit],
      ["heartbeat version", "/api/platform-updater/heartbeat", updaterInit],
    ] as const : []),
  ] as const) {
    if(process.env.QA_S95_ROUTES && !process.env.QA_S95_ROUTES.split(",").includes(label)) continue;
    if (process.env.MUL395_HEARTBEAT_CASES && !label.startsWith("heartbeat")) continue;
    if (process.env.MUL395_USAGE_CASES && !label.startsWith("runtimes")) continue;
    if (label === "heartbeat due") store.setPlatformAutoUpdateSettings({ enabled: true, time: "05:00", timezone: "UTC" });
    if (label === "heartbeat busy") activeOperation = store.createPlatformOperation({ kind: "restart" }, "local").id;
    const rows = [];
    for (let i = 0; i < samples + warmups + 1; i++) {
      if (label === "heartbeat due") db.run("UPDATE multiremi_platform_state SET auto_update_next_check_at = ?", "2000-01-01T00:00:00.000Z");
      if (label === "runtimes invalidated") db.run("UPDATE multiremi_tasks SET updated_at = ? WHERE id = 'tsk_s95_20'", String(i));
      const requestInit = label === "heartbeat version" ? { ...init, body: JSON.stringify({ driver: "docker_compose",
        currentRelease: { ...release, version: `0.2.${86 + i}` }, latestRelease: release }) } : init;
      await new Promise(resolve => setTimeout(resolve, 5));
      const a = readProcessDbCounters(), start = performance.now();
      queryWaits = [];
      maximumReplyBytes = 0;
      // A timer scheduled immediately before the route records time until the UI thread yields.
      let lastTick = start, maxDelay = 0, finished = false;
      const yielded = new Promise<number>(resolve => {
        const tick = () => {
          const now = performance.now();
          maxDelay = Math.max(maxDelay, now - lastTick);
          lastTick = now;
          if (finished) resolve(maxDelay);
          else setTimeout(tick, 0);
        };
        setTimeout(tick, 0);
      });
      const response = await app.request(path, requestInit);
      const body = await response.text();
      const elapsed_ms = performance.now() - start;
      if (response.status !== 200) throw new Error(`${label}: HTTP ${response.status}`);
      const metrics = diff(a, readProcessDbCounters());
      finished = true;
      rows.push({ sample: i, cold: i === 0, warmup: i > 0 && i <= warmups, ...metrics, elapsed_ms, non_db_ms: elapsed_ms - metrics.db_ms,
        query_waits: queryWaits, maximum_reply_bytes: maximumReplyBytes, main_thread_ms: await yielded, response_bytes: Buffer.byteLength(body),
        response_sha256: new Bun.CryptoHasher("sha256").update(body).digest("hex") });
    }
    results.push({ label, rows });
    if (label === "heartbeat busy" && activeOperation) store.reportPlatformOperation(activeOperation, { status: "failed" });
  }
  const calibration=[]; for(let i=0;i<100;i++){const a=readProcessDbCounters();db.query("SELECT 1 AS n").get();calibration.push(diff(a,readProcessDbCounters()));}
  const report = { bridgeSelectOneCalibration:calibration,bun: Bun.version, database: "PostgreSQL18.4", fixture: { tasks: tasks + fixture.counts.tasks,
    runtimes: runtimeIds.length, sessions: Number(process.env.QA_S95_SESSIONS ?? 250), agents: 20, skillBodyBytes: 16384 },
    measurement: "Actual bridge counters; db_ms=Atomics.wait; main_thread_ms=max recurring zero-delay timer until yield (includes timer floor). Serial route order: chat/runtimes/groups/models/heartbeat; sample0 first per route, five warmups,20 samples. Usage cache shared across routes; only runtimes sample0 has empty list usage cache.",
    cases: process.env.MUL395_HEARTBEAT_CASES ? "heartbeat due/busy/version" : process.env.MUL395_USAGE_CASES ? "runtime invalidation" : "default",
    results, heartbeatPhases: phases };
  writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  for (const result of results) {
    const warm = result.rows.slice(warmups + 1);
    const percentile = (key: keyof typeof warm[number], p: number) => warm.map(row => Number(row[key])).sort((a,b) => a-b)[Math.ceil(p*warm.length)-1];
    console.log(JSON.stringify({ label: result.label, cold: result.rows[0], warm_p50: Object.fromEntries(
      ["db_queries", "db_ms", "bridge_bytes", "main_thread_ms", "non_db_ms"].map(key => [key, percentile(key as any,.5)])),
      main_thread_p95: percentile("main_thread_ms",.95) }));
  }
} finally { await database.dispose(); }
