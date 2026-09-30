import { afterAll, beforeAll, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createMultiremiApp, RETIRED_DAEMON_HTTP_ROUTES, startMultiremiServer } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { DAEMON_PROTOCOL_MIN } from "@multiremi/contracts/daemon-protocol.js";
import baseline from "../../fixtures/daemon-v1-routes.json";
import { snapshotRouteTable } from "../../../scripts/snapshot-api-routes.js";
import { requestRuntimeRpc } from "../../fixtures/runtime-downlinks.js";
import { waitFor } from "./harness.js";

const upgradeRequired = { code: "daemon_protocol_upgrade_required", min_version: DAEMON_PROTOCOL_MIN };

const removedBy421 = [
  "GET /api/daemon/runtimes/:runtimeId/tasks/pending",
  "GET /api/daemon/tasks/:taskId/human-requests/:requestId",
  "GET /api/daemon/tasks/:taskId/messages",
  "GET /api/daemon/tasks/:taskId/steer",
  "POST /api/daemon/runtimes/:runtimeId/agent-plugins/:versionId/state",
  "POST /api/daemon/runtimes/:runtimeId/bot-menu/:requestId/result",
  "POST /api/daemon/runtimes/:runtimeId/commands/:requestId/result",
  "POST /api/daemon/runtimes/:runtimeId/directory-scans/:requestId/result",
  "POST /api/daemon/runtimes/:runtimeId/feishu-bot/outbound/:deliveryId/result",
  "POST /api/daemon/runtimes/:runtimeId/feishu-bot/status",
  "POST /api/daemon/runtimes/:runtimeId/local-skills/:requestId/result",
  "POST /api/daemon/runtimes/:runtimeId/local-skills/import/:requestId/result",
  "POST /api/daemon/runtimes/:runtimeId/models/:requestId/result",
  "POST /api/daemon/tasks/:taskId/complete",
  "POST /api/daemon/tasks/:taskId/dispatch-lease",
  "POST /api/daemon/tasks/:taskId/fail",
  "POST /api/daemon/tasks/:taskId/human-requests",
  "POST /api/daemon/tasks/:taskId/human-requests/:requestId/expire",
  "POST /api/daemon/tasks/:taskId/messages",
  "POST /api/daemon/tasks/:taskId/progress",
  "POST /api/daemon/tasks/:taskId/prompt",
  "POST /api/daemon/tasks/:taskId/session",
  "POST /api/daemon/tasks/:taskId/steer/consume",
  "POST /api/daemon/tasks/:taskId/usage",
  "POST /api/daemon/tasks/:taskId/workspace",
  "PUT /api/daemon/runtimes/:runtimeId/models",
];

it("keeps the retired method + path table equal to v1 minus live routes", () => {
  const retired = RETIRED_DAEMON_HTTP_ROUTES.map(({ method, path }) => `${method} ${path}`);
  expect(retired).toHaveLength(new Set(retired).size);
  expect(retired.toSorted()).toEqual(baseline.routes.filter(route => !liveRoutes.has(route)).toSorted());
});

it.each(["empty", "nonempty"] as const)("keeps v1 desired GET read-only and equal to plugin.desired RPC (%s)", async scenario => {
  const db = new Database(":memory:");
  try {
    const store = new MultiremiStore(db);
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({ id: `rt_desired_${scenario}`, name: "Legacy desired", provider: "claude",
      workspaceId: "local", daemonId: "dmn_desired" });
    if (scenario === "nonempty") {
      const agent = store.createAgent({ name: "Desired agent", provider: "claude" });
      const plugin = store.importAgentPlugin({ provider: "claude",
        manifest: { name: "desired-fixture", version: "1.0.0" } });
      store.createAgentPluginBinding(agent.id, { pluginId: plugin.id });
    }
    const credential = await store.createAccessToken({ name: "Desired daemon", type: "daemon",
      workspaceId: "local", daemonId: runtime.daemonId });
    const foreign = await store.createAccessToken({ name: "Foreign desired daemon", type: "daemon",
      workspaceId: "local", daemonId: "dmn_foreign_desired" });
    const path = `/api/daemon/runtimes/${runtime.id}/agent-plugins/desired`;
    const rpc = await requestRuntimeRpc(store, runtime.id, "plugin.desired", {}, credential.token);
    expect(rpc.ok).toBe(true);
    const expected = { runtime_id: rpc.runtime_id, revision: rpc.revision, plugins: rpc.plugins };
    expect(expected.plugins.length).toBe(scenario === "empty" ? 0 : 1);
    for (const apiRole of ["all", "runtime"] as const) {
      const app = createMultiremiApp({ store, authToken: "isolated-desired", apiRole });
      const unauthorized = await app.request(path);
      expect(unauthorized.status).toBe(401);
      const forbidden = await app.request(path, { headers: { Authorization: `Bearer ${foreign.token}` } });
      expect(forbidden.status).toBe(403);
      const changesBefore = db.query<{ count: number }, []>("SELECT total_changes() AS count").get()!.count;
      const response = await app.request(path, { headers: { Authorization: `Bearer ${credential.token}` } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(expected);
      expect(db.query<{ count: number }, []>("SELECT total_changes() AS count").get()!.count).toBe(changesBefore);
    }
    const ui = createMultiremiApp({ store, authToken: "isolated-desired", apiRole: "ui" });
    expect((await ui.request(path, { headers: { Authorization: `Bearer ${credential.token}` } })).status).toBe(421);
  } finally { db.close(); }
});

it.each(["all", "runtime"] as const)("keeps v1 task claim inert and authenticated (%s)", async apiRole => {
  const db = new Database(":memory:");
  try {
    const store = new MultiremiStore(db);
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({ id: `rt_claim_${apiRole}`, name: "Legacy claim", provider: "claude" });
    const agent = store.createAgent({ name: "Legacy claim", provider: "claude", runtimeId: runtime.id });
    const issue = store.createIssue({ title: "Legacy claim" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, runtimeId: runtime.id, prompt: "Remain queued" });
    const authToken = "isolated-legacy-claim";
    const app = createMultiremiApp({ store, authToken, apiRole });
    const path = `/api/daemon/runtimes/${runtime.id}/tasks/claim`;
    expect(baseline.routes).toContain("POST /api/daemon/runtimes/:runtimeId/tasks/claim");
    const unauthorized = await app.request(path, { method: "POST" });
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: "unauthorized" });
    const changesBefore = db.query<{ count: number }, []>("SELECT total_changes() AS count").get()!.count;
    const response = await app.request(path, { method: "POST", headers: { Authorization: `Bearer ${authToken}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ task: null });
    expect(store.getTask(task.id)?.status).toBe("queued");
    expect(db.query<{ count: number }, []>("SELECT total_changes() AS count").get()!.count).toBe(changesBefore);
  } finally {
    db.close();
  }
});

let removedRoutesServer: ReturnType<typeof startMultiremiServer>;
let removedRoutesDb: Database;
let liveRoutes: Set<string>;
const removedRoutesAuthToken = "isolated-removed-v1-routes";

beforeAll(() => {
  removedRoutesDb = new Database(":memory:");
  const store = new MultiremiStore(removedRoutesDb);
  store.ensureLocalWorkspace();
  const app = createMultiremiApp({ store, authToken: removedRoutesAuthToken, apiRole: "all" });
  liveRoutes = new Set(snapshotRouteTable(app).map(({ method, path }) => `${method} ${path}`));
  removedRoutesServer = startMultiremiServer({ store, authToken: removedRoutesAuthToken, backgroundJobs: false, apiRole: "all", hostname: "127.0.0.1", port: 0 });
});

afterAll(async () => {
  try {
    await waitFor(() => removedRoutesServer.pendingRequests === 0, "removed v1 route requests to drain");
  } finally {
    try { void removedRoutesServer.stop(true); } finally { removedRoutesDb.close(); }
  }
});

it.each(removedBy421)("returns the protocol 426 for deleted MUL-421 route %s", async route => {
  expect(baseline.routes).toContain(route);
  expect(liveRoutes.has(route)).toBe(false);
  const [method, pattern] = route.split(" ");
  const path = pattern!.replace(/:[A-Za-z_][A-Za-z_0-9]*/g, "legacy-fixture");
  const response = await fetch(`http://127.0.0.1:${removedRoutesServer.port}${path}`, {
    method,
    headers: { Authorization: `Bearer ${removedRoutesAuthToken}` },
  });
  expect(response.status).toBe(426);
  expect(await response.json()).toEqual(upgradeRequired);
});

it.each(removedBy421)("does not disclose retired route %s without authorization", async route => {
  const [method, pattern] = route.split(" ");
  const path = pattern!.replace(/:[A-Za-z_][A-Za-z_0-9]*/g, "legacy-fixture");
  const response = await fetch(`http://127.0.0.1:${removedRoutesServer.port}${path}`, { method });
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "unauthorized" });
});

it.each(["all", "runtime"] as const)("automatically rejects removed snapshot routes and preserves the HTTP upgrade channel (%s)", async (apiRole) => {
  const db = new Database(":memory:");
  const store = new MultiremiStore(db);
  store.ensureLocalWorkspace();
  const runtime = store.registerRuntime({ id: "rt_legacy_http", name: "Legacy HTTP", provider: "claude", daemonId: "dmn_legacy_http", metadata: { cli_version: "0.2.82" } });
  const issue = store.createIssue({ title: "Legacy HTTP routes" });
  const agent = store.createAgent({ name: "Legacy HTTP", provider: "claude", runtimeId: runtime.id });
  const task = store.createTask({ agentId: agent.id, issueId: issue.id, runtimeId: runtime.id, prompt: "Do not dispatch this fixture" });
  const credential = await store.createAccessToken({ name: "Legacy HTTP fixture", type: "daemon", workspaceId: "local", daemonId: runtime.daemonId, userId: "local" });
  const authToken = "isolated-legacy-http-fixture";
  const options = { store, authToken, backgroundJobs: false, apiRole };
  const removed = baseline.routes.filter(route => !liveRoutes.has(route));
  const server = startMultiremiServer({ ...options, hostname: "127.0.0.1", port: 0 });
  const headers = { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" };
  const request = (path: string, method = "GET", body?: unknown) => fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    // The table equality test keeps this inventory in sync with v1 minus live routes.
    for (const route of removed) {
      const [method, pattern] = route.split(" ");
      const path = pattern!.replace(/:runtimeId\b/g, runtime.id).replace(/:taskId\b/g, task.id)
        .replace(/:issueId\b/g, issue.id).replace(/:[A-Za-z_][A-Za-z_0-9]*/g, "legacy-fixture");
      const response = await fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers: { Authorization: `Bearer ${authToken}` } });
      expect(response.status, route).toBe(426);
      expect(await response.json(), route).toEqual(upgradeRequired);
    }
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      const response = await request(`/api/daemon/runtimes/${runtime.id}/removed-v1-fixture`, method);
      expect(response.status).toBe(404);
      await response.text();
    }
    const otherMethod = await fetch(`http://127.0.0.1:${server.port}/api/daemon/tasks/${task.id}/messages`, {
      method: "PATCH", headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(otherMethod.status).toBe(404);
    await otherMethod.text();
    const retiredHead = await fetch(`http://127.0.0.1:${server.port}/api/daemon/tasks/${task.id}/messages`, {
      method: "HEAD", headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(retiredHead.status).toBe(404);
    await retiredHead.text();
    for (const path of ["/api/daemon/qa-never-existed", "/api/daemon/heartbeat/extra", "/api/daemon"]) {
      const response = await fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { Authorization: `Bearer ${authToken}` } });
      expect(response.status, path).toBe(apiRole === "runtime" && path === "/api/daemon" ? 421 : 404);
      await response.text();
    }
    const heartbeat = await request("/api/daemon/heartbeat", "POST", { runtime_id: runtime.id });
    expect(heartbeat.status).toBe(200);
    const ack = await heartbeat.json() as { pending_update: { id: string } };
    expect(ack.pending_update.id).toBeString();
    const result = await request(`/api/daemon/runtimes/${runtime.id}/update/${ack.pending_update.id}/result`, "POST", { status: "failed", error: "legacy fixture install failure" });
    expect(result.status).toBe(200);
    await result.json();
    expect(store.getRuntimeUpdateRequest(runtime.id, ack.pending_update.id)?.error).toBe("legacy fixture install failure");
    const cards = await request(`/api/daemon/runtimes/${runtime.id}/feishu-bot/decision-cards`);
    expect(cards.status).toBe(200);
    expect(await cards.json()).toEqual({ cards: [] });
    const decision = await request(`/api/daemon/issues/${issue.id}/decisions/missing-decision`);
    expect(decision.status).toBe(403);
    expect(await decision.json()).toEqual({ error: "forbidden for daemon identity", code: "daemon_identity_forbidden" });
    const masterDecision = await fetch(`http://127.0.0.1:${server.port}/api/daemon/issues/${issue.id}/decisions/missing-decision`, { headers: { Authorization: `Bearer ${authToken}` } });
    expect(masterDecision.status).toBe(404);
    expect(await masterDecision.json()).toEqual({ error: "decision not found" });
    const unrelated = await fetch(`http://127.0.0.1:${server.port}/api/not-a-daemon-route`, { headers: { Authorization: `Bearer ${authToken}` } });
    expect(unrelated.status).toBe(apiRole === "runtime" ? 421 : 404);
    await unrelated.text();
    const unauthorized = await fetch(`http://127.0.0.1:${server.port}/api/daemon/qa-never-existed`);
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: "unauthorized" });
  } finally {
    try {
      await waitFor(() => server.pendingRequests === 0, "legacy HTTP requests to drain");
    } finally {
      try { void server.stop(true); } finally { db.close(); }
    }
  }
});

it("keeps UI-role routing rejection ahead of every retired HTTP route", async () => {
  const db = new Database(":memory:");
  const store = new MultiremiStore(db);
  store.ensureLocalWorkspace();
  const authToken = "isolated-legacy-ui-fixture";
  const server = startMultiremiServer({ store, authToken, backgroundJobs: false, apiRole: "ui", hostname: "127.0.0.1", port: 0 });
  try {
    for (const route of removedBy421) {
      const [method, pattern] = route.split(" ");
      const path = pattern!.replace(/:[A-Za-z_][A-Za-z_0-9]*/g, "legacy-fixture");
      const response = await fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers: { Authorization: `Bearer ${authToken}` } });
      expect(response.status, route).toBe(421);
      expect(await response.json(), route).toEqual({ error: "misdirected", role: "ui" });
    }
  } finally {
    try {
      await waitFor(() => server.pendingRequests === 0, "UI legacy HTTP requests to drain");
    } finally {
      try { void server.stop(true); } finally { db.close(); }
    }
  }
});
