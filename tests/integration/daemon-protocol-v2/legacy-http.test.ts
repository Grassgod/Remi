import { afterAll, beforeAll, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { startMultiremiServer } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { DAEMON_PROTOCOL_MIN } from "@multiremi/contracts/daemon-protocol.js";
import baseline from "../../fixtures/daemon-v1-routes.json";
import current from "../../../scripts/api-routes.golden.json";
import { waitFor } from "./harness.js";

const upgradeRequired = { code: "daemon_protocol_upgrade_required", min_version: DAEMON_PROTOCOL_MIN };

const removedBy421 = [
  "GET /api/daemon/autopilot-runs/:runId/gc-check",
  "GET /api/daemon/chat-sessions/:sessionId/gc-check",
  "GET /api/daemon/issues/:issueId/gc-check",
  "GET /api/daemon/tasks/:taskId/gc-check",
  "GET /api/daemon/tasks/:taskId/messages",
  "POST /api/daemon/issues/:issueId/workspace/cleaned",
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
  "POST /api/daemon/tasks/:taskId/fail",
  "POST /api/daemon/tasks/:taskId/messages",
  "POST /api/daemon/tasks/:taskId/progress",
  "POST /api/daemon/tasks/:taskId/prompt",
  "POST /api/daemon/tasks/:taskId/session",
  "POST /api/daemon/tasks/:taskId/start",
  "POST /api/daemon/tasks/:taskId/usage",
  "POST /api/daemon/tasks/:taskId/workspace",
  "PUT /api/daemon/runtimes/:runtimeId/models",
];

let removedRoutesServer: ReturnType<typeof startMultiremiServer>;
let removedRoutesDb: Database;
const removedRoutesAuthToken = "isolated-removed-v1-routes";

beforeAll(() => {
  removedRoutesDb = new Database(":memory:");
  const store = new MultiremiStore(removedRoutesDb);
  store.ensureLocalWorkspace();
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
  expect(current.routes).not.toContain(route);
  const [method, pattern] = route.split(" ");
  const path = pattern!.replace(/:[A-Za-z_][A-Za-z_0-9]*/g, "legacy-fixture");
  const response = await fetch(`http://127.0.0.1:${removedRoutesServer.port}${path}`, {
    method,
    headers: { Authorization: `Bearer ${removedRoutesAuthToken}` },
  });
  expect(response.status).toBe(426);
  expect(await response.json()).toEqual(upgradeRequired);
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
  const routes = new Set(current.routes);
  const removed = baseline.routes.filter(route => !routes.has(route));
  const server = startMultiremiServer({ ...options, hostname: "127.0.0.1", port: 0 });
  const headers = { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" };
  const request = (path: string, method = "GET", body?: unknown) => fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    // The difference grows automatically as MUL-419/MUL-421 delete their HTTP routes.
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
      expect(response.status).toBe(426);
      expect(await response.json()).toEqual(upgradeRequired);
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
    const unauthorized = await fetch(`http://127.0.0.1:${server.port}/api/daemon/removed-v1-fixture`);
    expect(unauthorized.status).toBe(401);
    await unauthorized.text();
  } finally {
    try {
      await waitFor(() => server.pendingRequests === 0, "legacy HTTP requests to drain");
    } finally {
      try { void server.stop(true); } finally { db.close(); }
    }
  }
});

it("keeps UI-role routing rejection ahead of the legacy HTTP fallback", async () => {
  const db = new Database(":memory:");
  const store = new MultiremiStore(db);
  store.ensureLocalWorkspace();
  const authToken = "isolated-legacy-ui-fixture";
  const server = startMultiremiServer({ store, authToken, backgroundJobs: false, apiRole: "ui", hostname: "127.0.0.1", port: 0 });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/daemon/removed-v1-fixture`, { headers: { Authorization: `Bearer ${authToken}` } });
    expect(response.status).toBe(421);
    expect(await response.json()).toEqual({ error: "misdirected", role: "ui" });
  } finally {
    try {
      await waitFor(() => server.pendingRequests === 0, "UI legacy HTTP requests to drain");
    } finally {
      try { void server.stop(true); } finally { db.close(); }
    }
  }
});
