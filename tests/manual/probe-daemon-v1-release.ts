import { strict as assert } from "node:assert";
import type { Database } from "bun:sqlite";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { RETIRED_DAEMON_HTTP_ROUTES, startMultiremiServer } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { daemonRuntimeId } from "@multiremi/store/store.js";
import { DaemonV1ReleaseHarness } from "../fixtures/daemon-v1-release.js";
import { waitFor } from "../integration/daemon-protocol-v2/harness.js";

const archive = process.argv[2];
if (!archive) throw new Error("Usage: bun tests/manual/probe-daemon-v1-release.ts <verified-release-archive>");

type Exchange = { method: string; path: string; status: number; body: unknown };
const daemonId = "dmn_release_fixture";
const heartbeatDeadlineMs = 15_000; // v0.2.82 default heartbeat is 10 s; allow 5 s for local startup scheduling.

async function runScenario(scenario: "empty" | "nonempty"): Promise<void> {
  const provider = scenario === "empty" ? "antigravity" : "claude";
  const daemon = DaemonV1ReleaseHarness.prepare(archive!);
  let db: Database | undefined;
  let server: ReturnType<typeof startMultiremiServer> | undefined;
  let proxy: ReturnType<typeof Bun.serve> | undefined;
  const exchanges: Exchange[] = [];
  try {
    db = openSqliteDatabase(":memory:");
    const store = new MultiremiStore(db);
    store.ensureLocalWorkspace();
    const credential = await store.createAccessToken({ name: "release fixture", type: "daemon", workspaceId: "local", daemonId });
    if (scenario === "nonempty") {
      store.registerRuntime({ id: daemonRuntimeId(daemonId, provider), name: "release-fixture", provider,
        daemonId, workspaceId: "local", ownerId: "local" });
      const agent = store.createAgent({ name: "Legacy plugin agent", provider: "claude" });
      const plugin = store.importAgentPlugin({ provider: "claude",
        manifest: { name: "legacy-fixture", version: "1.0.0" },
        files: [{ path: "skills/legacy-fixture/SKILL.md", content: "# Fixture\n" }] });
      store.createAgentPluginBinding(agent.id, { pluginId: plugin.id });
      store.getRuntimeAgentPluginDesiredSnapshot(daemonRuntimeId(daemonId, provider));
    }
    const agent = store.createAgent({ name: "Legacy fixture task", provider });
    const task = store.createTask({ agentId: agent.id, prompt: "queued for legacy claim" });
    server = startMultiremiServer({ store, authToken: "isolated-release-fixture", backgroundJobs: false,
      apiRole: "all", peerChannel: null, daemonDirectBaseUrl: null, hostname: "127.0.0.1", port: 0 });
    proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
      if (request.headers.get("upgrade") === "websocket") return new Response(null, { status: 426 });
      const target = new URL(request.url);
      target.port = String(server!.port);
      const response = await fetch(new Request(target, request));
      if (target.pathname.startsWith("/api/daemon/")) {
        const body = await response.clone().json().catch(() => null);
        exchanges.push({ method: request.method, path: target.pathname, status: response.status, body });
      }
      return response;
    } });
    daemon.start(`http://127.0.0.1:${proxy.port}`, credential.token, provider);
    await waitFor(() => daemon.localPort() !== null || daemon.hasExited(), "legacy release local server or process exit");
    assert.equal(daemon.hasExited(), false, `${scenario}: release exited before local server started: ${daemon.diagnostic()}`);
    assert.equal((await daemon.health())?.cli_version, "v0.2.82");
    await waitFor(() => store.listRuntimes().some(runtime => runtime.daemonId === daemonId && runtime.provider === provider
      && runtime.metadata.cli_version === "v0.2.82"), "legacy release registration");
    const runtime = store.listRuntimes().find(entry => entry.daemonId === daemonId && entry.provider === provider)!;
    assert.equal(runtime.metadata.cli_version, "v0.2.82");
    const desiredPath = `/api/daemon/runtimes/${runtime.id}/agent-plugins/desired`;
    await waitFor(() => exchanges.some(entry => entry.method === "GET" && entry.path === desiredPath) || daemon.hasExited(),
      "legacy startup desired GET or process exit", 5_000);
    assert.equal(daemon.hasExited(), false, `${scenario}: release exited before desired GET completed`);
    const desired = exchanges.find(entry => entry.method === "GET" && entry.path === desiredPath)!;
    assert.equal(desired.status, 200);
    assert.equal(RETIRED_DAEMON_HTTP_ROUTES.some(route => route.method === "GET"
      && String(route.path) === "/api/daemon/runtimes/:runtimeId/agent-plugins/desired"), false,
    "the live desired GET must not also be marked retired");
    const desiredBody = desired.body as { runtime_id: string; revision: string; plugins: unknown[] };
    assert.equal(desiredBody.runtime_id, runtime.id);
    assert.equal(typeof desiredBody.revision, "string");
    assert.equal(desiredBody.plugins.length, scenario === "empty" ? 0 : 1);
    await waitFor(() => {
      if (daemon.hasExited()) throw new Error(`${scenario}: v0.2.82 exited before its first heartbeat`);
      return exchanges.some(entry => entry.path === "/api/daemon/heartbeat");
    }, `${scenario} legacy first heartbeat`, heartbeatDeadlineMs);
    const legacyHeartbeat = exchanges.find(entry => entry.path === "/api/daemon/heartbeat")!;
    assert.equal(legacyHeartbeat.status, 200);
    assert.ok((legacyHeartbeat.body as { pending_update?: unknown }).pending_update);
    const headers = { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" };
    const claim = await fetch(`http://127.0.0.1:${proxy.port}/api/daemon/runtimes/${runtime.id}/tasks/claim`,
      { method: "POST", headers, body: "{}" });
    assert.equal(claim.status, 200);
    assert.deepEqual(await claim.json(), { task: null });
    assert.equal(store.getTask(task.id)?.status, "queued");
    const retired = await fetch(`http://127.0.0.1:${proxy.port}/api/daemon/tasks/${task.id}/complete`, {
      method: "POST", headers: { Authorization: "Bearer isolated-release-fixture" }, body: "{}",
    });
    assert.equal(retired.status, 426);
    assert.deepEqual(await retired.json(), { code: "daemon_protocol_upgrade_required", min_version: 2 });
    assert.equal(store.getRuntime(runtime.id)?.protocol?.state, "upgrade_pending");
    const pending = db.query("SELECT COUNT(*) AS count FROM multiremi_runtime_update_requests WHERE runtime_id = ? AND status IN ('pending', 'running')")
      .get(runtime.id) as { count: number };
    assert.equal(pending.count, 1);
    console.log(`[Q418-v082 ${scenario}] real process sequence:`, exchanges.map(entry => `${entry.method} ${entry.path} ${entry.status}`).join(" -> "));
    console.log(`[Q418-v082 ${scenario}] heartbeat=pending_update claim=null retired=426 protocol=upgrade_pending pending=1`);
  } catch (error) {
    console.error(`[Q418-v082 ${scenario}] failed sequence:`, exchanges.map(entry => `${entry.method} ${entry.path} ${entry.status}`).join(" -> "));
    throw error;
  } finally {
    try { await daemon.dispose(); } finally {
      try { if (proxy) await waitFor(() => proxy!.pendingRequests === 0, "legacy release proxy requests to drain"); } finally {
        try { void proxy?.stop(true); } finally {
          try { if (server) await waitFor(() => server!.pendingRequests === 0, "legacy release server requests to drain"); } finally {
            try { void server?.stop(true); } finally { db?.close(); }
          }
        }
      }
    }
  }
}

await runScenario("empty");
await runScenario("nonempty");
