import { strict as assert } from "node:assert";
import { Database } from "bun:sqlite";
import { startMultiremiServer } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { DaemonV1ReleaseHarness } from "../fixtures/daemon-v1-release.js";
import { waitFor } from "../integration/daemon-protocol-v2/harness.js";

const archive = process.argv[2];
if (!archive) throw new Error("Usage: bun tests/manual/probe-daemon-v1-release.ts <verified-release-archive>");
const daemon = DaemonV1ReleaseHarness.prepare(archive);
let db: Database | undefined;
let server: ReturnType<typeof startMultiremiServer> | undefined;
let proxy: ReturnType<typeof Bun.serve> | undefined;
try {
  db = new Database(":memory:");
  const store = new MultiremiStore(db);
  store.ensureLocalWorkspace();
  const credential = await store.createAccessToken({ name: "release fixture", type: "daemon", workspaceId: "local", daemonId: "dmn_release_fixture" });
  const agent = store.createAgent({ name: "Legacy fixture task", provider: "antigravity" });
  const task = store.createTask({ agentId: agent.id, prompt: "queued for legacy claim" });
  server = startMultiremiServer({ store, authToken: "isolated-release-fixture", backgroundJobs: false, apiRole: "all", peerChannel: null, daemonDirectBaseUrl: null, hostname: "127.0.0.1", port: 0 });
  const exchanges: Array<{ method: string; path: string; status: number; body: unknown }> = [];
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
  daemon.start(`http://127.0.0.1:${proxy.port}`, credential.token);
  await waitFor(() => daemon.localPort() !== null, "legacy release local server");
  await waitFor(() => store.listRuntimes().some(runtime => runtime.daemonId === "dmn_release_fixture"), "legacy release registration");
  assert.equal((await daemon.health())?.cli_version, "v0.2.82");
  const runtime = store.listRuntimes().find(runtime => runtime.daemonId === "dmn_release_fixture")!;
  assert.equal(runtime.metadata.cli_version, "v0.2.82");
  await waitFor(() => exchanges.some(entry => entry.method === "GET" &&
    entry.path === `/api/daemon/runtimes/${runtime.id}/agent-plugins/desired`), "legacy startup desired GET", 5_000);
  const desired = exchanges.find(entry => entry.path.endsWith("/agent-plugins/desired"));
  assert.equal(desired?.status, 426);
  assert.deepEqual(desired!.body, { code: "daemon_protocol_upgrade_required", min_version: 2 });
  await Bun.sleep(1_000);
  assert.equal(exchanges.some(entry => entry.path === "/api/daemon/heartbeat" || entry.path.endsWith("/tasks/claim")), false);
  const headers = { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" };
  const heartbeat = await fetch(`http://127.0.0.1:${proxy.port}/api/daemon/heartbeat`, {
    method: "POST", headers, body: JSON.stringify({ runtime_id: runtime.id }),
  });
  assert.equal(heartbeat.status, 200);
  assert.ok((await heartbeat.json() as { pending_update?: unknown }).pending_update);
  const claim = await fetch(`http://127.0.0.1:${proxy.port}/api/daemon/runtimes/${runtime.id}/tasks/claim`, {
    method: "POST", headers, body: "{}",
  });
  assert.equal(claim.status, 200);
  assert.deepEqual(await claim.json(), { task: null });
  assert.equal(store.getTask(task.id)?.status, "queued");
  const retired = await fetch(`http://127.0.0.1:${proxy.port}/api/daemon/tasks/${task.id}/complete`, {
    method: "POST", headers: { Authorization: "Bearer isolated-release-fixture" },
    body: "{}",
  });
  assert.equal(retired.status, 426);
  assert.deepEqual(await retired.json(), { code: "daemon_protocol_upgrade_required", min_version: 2 });
  assert.equal(store.getRuntime(runtime.id)?.protocol?.state, "upgrade_pending");
  const pending = db.query("SELECT COUNT(*) AS count FROM multiremi_runtime_update_requests WHERE runtime_id = ? AND status IN ('pending', 'running')")
    .get(runtime.id) as { count: number };
  assert.equal(pending.count, 1);
  console.log(`v0.2.82 real process: register 200, desired GET 426 before heartbeat/claim; runtime=${runtime.id}`);
  console.log("v2 server contract probes (test process): pending_update=1 claim_null=1 retired_report_426=1 protocol=upgrade_pending pending_requests=1");
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
