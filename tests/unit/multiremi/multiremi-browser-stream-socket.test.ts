// MUL-438 / C3 over real sockets: the frames a browser actually receives on
// `/ws` and `/api/trace/ws`.
//
// The protocol suite next door exercises the handler directly; this one proves
// the endpoint wiring — which socket serves which stream kind, and that the chat
// lifecycle invalidations now follow the session's creator instead of the chat
// scope.
import { afterEach, describe, expect, it } from "bun:test";
import { startMultiremiServer } from "@multiremi/api.js";
import {
  authenticateBrowserWebSocket,
  createStore,
  expectNoWebSocketMessage,
  nextWebSocketMessage,
  resetMultiremiTestEnv,
} from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("MUL-438 browser stream endpoints", () => {
  it("serves log streams on /ws, refuses trace there, and refuses log on /api/trace/ws", async () => {
    const store = createStore();
    const workspace = store.ensureLocalWorkspace();
    store.createWorkspaceMember({ workspaceId: workspace.id, userId: "creator", name: "Creator", role: "owner" });
    const agent = store.createAgent({ name: "Streamer", provider: "codex", workspaceId: workspace.id });
    const issue = store.createIssue({ title: "Socket issue", workspaceId: workspace.id });
    const session = store.getOrCreateDefaultIssueSession(issue.id, "creator");
    const task = store.createTask({ agentId: agent.id, workspaceId: workspace.id, prompt: "socket task", issueId: issue.id });
    const token = await store.createAccessToken({ name: "Socket owner", type: "pat", workspaceId: workspace.id, userId: "creator" });
    const server = startMultiremiServer({ store, scheduler: null, port: 0, hostname: "127.0.0.1", authToken: null });

    const logSocket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?workspace_id=${workspace.id}`);
    const traceSocket = new WebSocket(`ws://127.0.0.1:${server.port}/api/trace/ws?workspace_id=${workspace.id}`);
    try {
      await authenticateBrowserWebSocket(logSocket, token.token);
      await authenticateBrowserWebSocket(traceSocket, token.token);

      // `/ws` answers a log subscription, and it carries the C0 hub's honest
      // empty range while C1 is still in flight.
      logSocket.send(JSON.stringify({ type: "stream.subscribe", payload: { stream: "log", id: session.id, from_seq: 1 } }));
      expect(await nextWebSocketMessage(logSocket)).toEqual({
        type: "stream.ack",
        payload: { stream: "log", id: session.id, first_seq: 1, head_seq: 0, log_version: null, gap: null },
      });

      // The same socket must not serve trace: that stream lives in the runtime
      // process and the browser reaches it over the other endpoint.
      logSocket.send(JSON.stringify({ type: "stream.subscribe", payload: { stream: "trace", id: task.id, from_seq: 1 } }));
      expect(await nextWebSocketMessage(logSocket)).toEqual({
        type: "stream.error",
        payload: { stream: "trace", id: task.id, code: "wrong_endpoint" },
      });

      // …and the trace endpoint is the mirror image.
      traceSocket.send(JSON.stringify({ type: "stream.subscribe", payload: { stream: "trace", id: task.id, from_seq: 1 } }));
      expect(await nextWebSocketMessage(traceSocket)).toEqual({
        type: "stream.ack",
        payload: { stream: "trace", id: task.id, first_seq: 1, head_seq: 0, log_version: null, gap: null },
      });
      traceSocket.send(JSON.stringify({ type: "stream.subscribe", payload: { stream: "log", id: session.id, from_seq: 1 } }));
      expect(await nextWebSocketMessage(traceSocket)).toEqual({
        type: "stream.error",
        payload: { stream: "log", id: session.id, code: "wrong_endpoint" },
      });
    } finally {
      logSocket.close();
      traceSocket.close();
      server.stop(true);
    }
  });

  it("keeps a chat lifecycle event away from a workspace peer and delivers it to the creator", async () => {
    const store = createStore();
    const workspace = store.ensureLocalWorkspace();
    store.createWorkspaceMember({ workspaceId: workspace.id, userId: "creator", name: "Creator", role: "owner" });
    store.createWorkspaceMember({ workspaceId: workspace.id, userId: "peer", name: "Peer", role: "member" });
    const agent = store.createAgent({ name: "Chatty", provider: "codex", workspaceId: workspace.id });
    const chat = store.createChatSession({ agentId: agent.id, workspaceId: workspace.id, creatorId: "creator", title: "Private chat" });
    const creatorToken = await store.createAccessToken({ name: "Creator", type: "pat", workspaceId: workspace.id, userId: "creator" });
    const peerToken = await store.createAccessToken({ name: "Peer", type: "pat", workspaceId: workspace.id, userId: "peer" });
    const server = startMultiremiServer({ store, scheduler: null, port: 0, hostname: "127.0.0.1", authToken: null });

    const creator = new WebSocket(`ws://127.0.0.1:${server.port}/ws?workspace_id=${workspace.id}`);
    const peer = new WebSocket(`ws://127.0.0.1:${server.port}/ws?workspace_id=${workspace.id}`);
    try {
      await authenticateBrowserWebSocket(creator, creatorToken.token);
      await authenticateBrowserWebSocket(peer, peerToken.token);

      // A chat lifecycle signal is creator-private. The creator receives it on
      // the user registry — without subscribing to any scope — and the peer
      // receives nothing at all.
      store.updateChatSession(chat.id, { title: "Renamed privately" });

      const received = await nextWebSocketMessage(creator);
      expect(received).toMatchObject({
        type: "chat:session_updated",
        payload: { chat_session_id: chat.id, title: "Renamed privately" },
      });
      await expectNoWebSocketMessage(peer, 250);

      // A deleted session no longer resolves through the store, so this is the
      // case where the event's own actor has to carry the creator. It must still
      // reach the creator and still not reach the peer.
      store.deleteChatSession(chat.id);
      const deleted = await nextWebSocketMessage(creator);
      expect(deleted).toMatchObject({
        type: "chat:session_deleted",
        payload: { chat_session_id: chat.id },
      });
      await expectNoWebSocketMessage(peer, 250);
    } finally {
      creator.close();
      peer.close();
      server.stop(true);
    }
  });

  it("does not hand a chat invalidation to the creator's socket in another workspace (MUL-438)", async () => {
    const store = createStore();
    const first = store.ensureLocalWorkspace();
    const second = store.createWorkspace({ id: "ws_stream_second", name: "Second", slug: "stream-second" });
    // The same person, a member of both workspaces.
    store.createWorkspaceMember({ workspaceId: first.id, userId: "creator", name: "Creator", role: "owner" });
    store.createWorkspaceMember({ workspaceId: second.id, userId: "creator", name: "Creator", role: "owner" });
    const agent = store.createAgent({ name: "Chatty", provider: "codex", workspaceId: first.id });
    const chat = store.createChatSession({ agentId: agent.id, workspaceId: first.id, creatorId: "creator", title: "First-workspace chat" });
    const token = await store.createAccessToken({ name: "Creator", type: "pat", workspaceId: first.id, userId: "creator" });
    const server = startMultiremiServer({ store, scheduler: null, port: 0, hostname: "127.0.0.1", authToken: null });

    const inFirst = new WebSocket(`ws://127.0.0.1:${server.port}/ws?workspace_id=${first.id}`);
    const inSecond = new WebSocket(`ws://127.0.0.1:${server.port}/ws?workspace_id=${second.id}`);
    try {
      await authenticateBrowserWebSocket(inFirst, token.token);
      await authenticateBrowserWebSocket(inSecond, token.token);

      store.updateChatSession(chat.id, { title: "Renamed in the first workspace" });

      expect(await nextWebSocketMessage(inFirst)).toMatchObject({
        type: "chat:session_updated",
        payload: { chat_session_id: chat.id, title: "Renamed in the first workspace" },
      });
      // The user registry is keyed by user, so without the workspace filter the
      // other tab would receive a session id and title from a workspace it is
      // not looking at.
      await expectNoWebSocketMessage(inSecond, 250);
    } finally {
      inFirst.close();
      inSecond.close();
      server.stop(true);
    }
  });

  it("closes the read pool it built, and leaves an injected one alone", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    // The process under test builds no pool in `NODE_ENV=test` (the auth checks
    // use the store's synchronous handles, because a suite seeds an in-memory
    // database), so the injection is the only path worth pinning here: a caller
    // that hands the server an authenticator owns that authenticator's resources.
    let closed = 0;
    const server = startMultiremiServer({
      store,
      scheduler: null,
      port: 0,
      hostname: "127.0.0.1",
      authToken: null,
      streamAuth: {
        backend: "sqlite",
        async logFacts() { return { ok: true, facts: null }; },
        async traceFacts() { return { ok: true, facts: null }; },
      },
      readPool: {
        postgres: false,
        async query() { return []; },
        async queryOne() { return null; },
        async close() { closed += 1; },
      },
    });
    server.stop(true);
    expect(closed).toBe(0);
  });

  it("broadcasts resync to the sockets this process holds", async () => {
    const store = createStore();
    const workspace = store.ensureLocalWorkspace();
    store.createWorkspaceMember({ workspaceId: workspace.id, userId: "creator", name: "Creator", role: "owner" });
    const token = await store.createAccessToken({ name: "Creator", type: "pat", workspaceId: workspace.id, userId: "creator" });
    const server = startMultiremiServer({ store, scheduler: null, port: 0, hostname: "127.0.0.1", authToken: null });

    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?workspace_id=${workspace.id}`);
    try {
      await authenticateBrowserWebSocket(socket, token.token);
      const handle = server.broadcastResync({ jitterMs: () => 0 });
      expect(handle.recipients).toBe(1);
      expect(await nextWebSocketMessage(socket)).toEqual({ type: "resync" });
    } finally {
      socket.close();
      server.stop(true);
    }
  });
});
