// Local, disposable PG only. Credentials stay in the child environment, never in output.
import { writeFileSync } from "node:fs";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { readProcessDbCounters } from "../../packages/server/src/observability/request-metrics.js";
import { openHotspotDatabase } from "../fixtures/multiremi/first-screen-hotspots-database.js";
import { seedFirstScreenHotspotsFixture } from "../fixtures/multiremi/first-screen-hotspots-fixture.js";

if (!process.env.MULTIREMI_TEST_POSTGRES_URL) throw new Error("Explicit disposable PostgreSQL required");
const database = await openHotspotDatabase();
const store = new MultiremiStore(database.db);
const tasks = Number(process.env.MUL395_TASKS ?? 5000);
const samples = Number(process.env.MUL395_SAMPLES ?? 20);
const out = process.argv[process.argv.indexOf("--out") + 1];
if (!out || !process.argv.includes("--out")) throw new Error("--out required");
const diff = (a: ReturnType<typeof readProcessDbCounters>, b: typeof a) => ({
  db_queries: b.dbQueries - a.dbQueries, db_ms: b.dbMs - a.dbMs, bridge_bytes: b.dbBytes - a.dbBytes,
});
const release = { version: "0.2.85", tag: "v0.2.85", channel: "stable", manifestUrl: "https://example.test/platform-release.json" };
try {
  const fixture = seedFirstScreenHotspotsFixture(store, { sessions: 250, agents: 20, issues: 10,
    inboxRows: 0, privatePrimaryAgent: false, skillBodyBytes: 16384,
    run: (sql, params) => database.db.run(sql, params) });
  const runtimeIds = [fixture.runtimeId];
  for (let i = 1; i < 10; i++) {
    const id = `rt_s95_${i}`;
    store.registerRuntime({ id, workspaceId: "local", name: id, provider: "codex", ownerId: fixture.readerUserId,
      daemonId: `daemon_s95_${i}`, metadata: { cli_version: "0.2.85" } });
    runtimeIds.push(id);
  }
  database.db.run("UPDATE multiremi_tasks SET status = 'completed', runtime_id = ?", fixture.runtimeId);
  const usage = JSON.stringify([{ inputTokens: 1234, output_tokens: 567, cacheReadTokens: 89, cache_write_tokens: 10,
    model: "fixture-" + "m".repeat(300), provider: "codex" }]);
  database.db.run(`INSERT INTO multiremi_tasks
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
  for (const name of ["heartbeatPlatformUpdater", "claimDuePlatformAutoUpdateCheck", "getActivePlatformOperation", "reconcileRuntimeCliRelease"] as const) {
    const original = store[name].bind(store) as (...args: any[]) => unknown;
    (store[name] as any) = (...args: any[]) => {
      const a = readProcessDbCounters(), start = performance.now();
      const value = original(...args);
      (phases[name] ??= []).push({ ...diff(a, readProcessDbCounters()), elapsed_ms: performance.now() - start });
      return value;
    };
  }
  const results = [];
  for (const [label, path, init] of [
    ["chat", "/api/chat/sessions", { headers }],
    ["runtimes", "/api/runtimes", { headers }],
    ["heartbeat", "/api/platform-updater/heartbeat", { method: "POST", headers: {
      "Content-Type": "application/json", Authorization: "Bearer fixture-master", "X-Multiremi-Updater-Token": "fixture-updater" },
      body: JSON.stringify({ driver: "docker_compose", currentRelease: release, latestRelease: release }) }],
  ] as const) {
    const rows = [];
    for (let i = 0; i < samples + 1; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
      const a = readProcessDbCounters(), start = performance.now();
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
      const response = await app.request(path, init);
      const body = await response.text();
      const elapsed_ms = performance.now() - start;
      if (response.status !== 200) throw new Error(`${label}: HTTP ${response.status}`);
      const db = diff(a, readProcessDbCounters());
      finished = true;
      rows.push({ sample: i, cold: i === 0, ...db, elapsed_ms, non_db_ms: elapsed_ms - db.db_ms,
        main_thread_ms: await yielded, response_bytes: Buffer.byteLength(body) });
    }
    results.push({ label, rows });
  }
  const report = { bun: Bun.version, database: "PostgreSQL18.4", fixture: { tasks: tasks + fixture.counts.tasks,
    runtimes: runtimeIds.length, sessions: 250, agents: 20, skillBodyBytes: 16384 },
    measurement: "Actual bridge counters; db_ms=Atomics.wait; main_thread_ms=zero-delay timer until yield (includes timer floor). Serial requests, sample0 cold, next20 warm.",
    results, heartbeatPhases: phases };
  writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  for (const result of results) {
    const warm = result.rows.slice(1);
    const percentile = (key: keyof typeof warm[number], p: number) => warm.map(row => Number(row[key])).sort((a,b) => a-b)[Math.ceil(p*warm.length)-1];
    console.log(JSON.stringify({ label: result.label, cold: result.rows[0], warm_p50: Object.fromEntries(
      ["db_queries", "db_ms", "bridge_bytes", "main_thread_ms", "non_db_ms"].map(key => [key, percentile(key as any,.5)])),
      main_thread_p95: percentile("main_thread_ms",.95) }));
  }
} finally { await database.dispose(); }
