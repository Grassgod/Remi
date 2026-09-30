import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createMultiremiApp, startMultiremiServer } from "@multiremi/api.js";
import { createHub } from "@multiremi/api/hub/hub-core.js";
import { createLocalHubTransport } from "@multiremi/api/hub/hub-transport.js";
import {
  authenticateBrowserWebSocket,
  createStore,
  nextWebSocketMessage,
  resetMultiremiTestEnv,
} from "./helpers.js";

let savedApiRole: string | undefined;
beforeEach(() => { savedApiRole = process.env.MULTIREMI_API_ROLE; });
afterEach(() => {
  resetMultiremiTestEnv();
  if (savedApiRole === undefined) delete process.env.MULTIREMI_API_ROLE;
  else process.env.MULTIREMI_API_ROLE = savedApiRole;
});

async function fixture() {
  const store = createStore();
  const workspace = store.ensureLocalWorkspace();
  store.createWorkspaceMember({ workspaceId: workspace.id, userId: "creator", name: "Creator", role: "owner" });
  const issue = store.createIssue({ title: "Shared Hub", workspaceId: workspace.id });
  const session = store.getOrCreateDefaultIssueSession(issue.id, "creator");
  const agent = store.createAgent({ name: "Streamer", provider: "codex", workspaceId: workspace.id });
  const task = store.createTask({ agentId: agent.id, workspaceId: workspace.id, prompt: "stream", issueId: issue.id });
  const token = await store.createAccessToken({ name: "Creator", type: "pat", workspaceId: workspace.id, userId: "creator" });
  return { store, workspace, session, task, token };
}

async function subscribe(socket: WebSocket, stream: "log" | "trace", id: string) {
  const ack = nextWebSocketMessage(socket);
  socket.send(JSON.stringify({ type: "stream.subscribe", payload: { stream, id, from_seq: 1 } }));
  expect(await ack).toMatchObject({ type: "stream.ack", payload: { stream, id } });
}

describe("MUL-436 shared server Hub wiring", () => {
  it("reports both default socket subscriptions from the one real Hub without configuring a role", async () => {
    delete process.env.MULTIREMI_API_ROLE;
    const { store, workspace, session, task, token } = await fixture();
    const server = startMultiremiServer({ store, backgroundJobs: false, port: 0, hostname: "127.0.0.1", authToken: null });
    const base = `http://127.0.0.1:${server.port}`;
    const log = new WebSocket(`ws://127.0.0.1:${server.port}/ws?workspace_id=${workspace.id}`);
    const trace = new WebSocket(`ws://127.0.0.1:${server.port}/api/trace/ws?workspace_id=${workspace.id}`);
    try {
      await authenticateBrowserWebSocket(log, token.token);
      await authenticateBrowserWebSocket(trace, token.token);
      await subscribe(log, "log", session.id);
      await subscribe(trace, "trace", task.id);
      const health = await (await fetch(`${base}/health`)).json() as Record<string, any>;
      expect(health).not.toHaveProperty("role");
      expect(health.hub).toMatchObject({ role: "all", transport: "local", streams: 2, subscriptions: 2 });
      expect(await (await fetch(`${base}/readyz`)).json()).toEqual({ ok: true });
    } finally {
      log.close();
      trace.close();
      server.stop(true);
    }
  });

  it.each(["ui", "runtime"] as const)("uses injected apiRole=%s for both app and server Hub despite the environment", async (apiRole) => {
    process.env.MULTIREMI_API_ROLE = apiRole === "ui" ? "runtime" : "ui";
    const { store } = await fixture();
    const app = createMultiremiApp({ store, apiRole, backgroundJobs: false, authToken: null });
    const server = startMultiremiServer({ store, apiRole, backgroundJobs: false, port: 0, hostname: "127.0.0.1", authToken: null });
    try {
      const expectedReady = { ok: true, role: apiRole };
      expect(await (await app.request("/readyz")).json()).toEqual(expectedReady);
      expect(await (await fetch(`http://127.0.0.1:${server.port}/readyz`)).json()).toEqual(expectedReady);
      const expectedHealth = { ok: true, role: apiRole, hub: { role: apiRole, transport: "local" } };
      expect(await (await app.request("/health")).json()).toMatchObject(expectedHealth);
      expect(await (await fetch(`http://127.0.0.1:${server.port}/health`)).json()).toMatchObject(expectedHealth);
    } finally { server.stop(true); }
  });

  it.each(["hub", "liveHub"] as const)("shares a real injected %s between health, log edits and trace delivery", async (option) => {
    const { store, workspace, session, task, token } = await fixture();
    const hub = createHub({ transport: createLocalHubTransport(), role: "all" });
    const server = startMultiremiServer({ store, [option]: hub, apiRole: "all", backgroundJobs: false, port: 0, hostname: "127.0.0.1", authToken: null });
    const log = new WebSocket(`ws://127.0.0.1:${server.port}/ws?workspace_id=${workspace.id}`);
    const trace = new WebSocket(`ws://127.0.0.1:${server.port}/api/trace/ws?workspace_id=${workspace.id}`);
    try {
      await authenticateBrowserWebSocket(log, token.token);
      await authenticateBrowserWebSocket(trace, token.token);
      await subscribe(log, "log", session.id);
      await subscribe(trace, "trace", task.id);
      const row = nextWebSocketMessage(log);
      const event = nextWebSocketMessage(trace);
      hub.onEntry(session.id, { session_id: session.id, seq: 1, revision: 1, kind: "message", visibility: "shown", ...{ body_md: "original" } });
      hub.append(task.id, [{ seq: 1, ts: "2026-09-28T00:00:00.000Z", type: "text", content: "trace" }]);
      expect(await row).toMatchObject({ type: "stream.data", payload: { stream: "log", id: session.id, frames: [{ seq: 1, kind: "entry" }] } });
      expect(await event).toMatchObject({ type: "stream.data", payload: { stream: "trace", id: task.id, frames: [{ seq: 1 }] } });
      const edit = nextWebSocketMessage(log);
      hub.onEntry(session.id, { session_id: session.id, target_seq: 1, revision: 2, fields: { body_md: "edited" } });
      expect(await edit).toMatchObject({ type: "stream.data", payload: { frames: [{ seq: 1, kind: "patch", payload: { revision: 2, fields: { body_md: "edited" } } }] } });
      const health = await (await fetch(`http://127.0.0.1:${server.port}/health`)).json() as Record<string, any>;
      expect(health.role).toBe("all");
      expect(health.hub).toEqual(hub.snapshot());
      expect(health.hub).toMatchObject({ streams: 2, subscriptions: 2, frames: 2 });
    } finally {
      log.close();
      trace.close();
      server.stop(true);
      hub.shutdown();
    }
  });

  it("uses an injected liveHub for app health and human-request feed too", async () => {
    const { store, session } = await fixture();
    const hub = createHub({ transport: createLocalHubTransport(), role: "ui" });
    hub.onEntry(session.id, { session_id: session.id, seq: 1, revision: 1, kind: "message", visibility: "shown" });
    const app = createMultiremiApp({ store, liveHub: hub, apiRole: "ui", backgroundJobs: true, authToken: null });
    try {
      const health = await (await app.request("/health")).json() as Record<string, any>;
      expect(health.hub).toEqual(hub.snapshot());
      const listeners = (store as unknown as { ctx: { humanRequestListeners: Set<unknown> } }).ctx.humanRequestListeners;
      expect(listeners.size).toBe(1);
    } finally { hub.shutdown(); }
  });
});
