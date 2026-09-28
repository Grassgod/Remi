// MUL-438 / C3 over real sockets: the frames a browser actually receives on
// `/ws` and `/api/trace/ws`.
//
// The protocol suite next door exercises the handler directly; this one proves
// the endpoint wiring — which socket serves which stream kind, and that the chat
// lifecycle invalidations now follow the session's creator instead of the chat
// scope.
import { afterEach, describe, expect, it } from "bun:test";
import { startMultiremiServer } from "@multiremi/api.js";
import { createEmptyLiveHub, type HubSubscription } from "@multiremi/api/hub/live-hub.js";
import { createLocalHubTransport } from "@multiremi/api/hub/hub-transport.js";
import { createStreamAuthReader, type StreamAuthReader } from "@multiremi/api/hub/stream-auth.js";
import { WSClient } from "../../../frontend/packages/core/api/ws-client.js";
import {
  authenticateBrowserWebSocket,
  createStore,
  expectNoWebSocketMessage,
  nextWebSocketMessage,
  nextWebSocketMessages,
  resetMultiremiTestEnv,
  waitWebSocketOpen,
} from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function pausedSubscriptionFixture(stream: "log" | "trace") {
  const store = createStore();
  const workspace = store.ensureLocalWorkspace();
  store.createWorkspaceMember({ workspaceId: workspace.id, userId: "creator", name: "Creator", role: "owner" });
  const issue = store.createIssue({ title: "Subscription races", workspaceId: workspace.id });
  const session = store.getOrCreateDefaultIssueSession(issue.id, "creator");
  const agent = store.createAgent({ name: "Streamer", provider: "codex", workspaceId: workspace.id });
  const task = store.createTask({ agentId: agent.id, workspaceId: workspace.id, prompt: "race", issueId: issue.id });
  const token = await store.createAccessToken({ name: "Creator", type: "pat", workspaceId: workspace.id, userId: "creator" });
  const auth = createStreamAuthReader(store);
  const gates = Array.from({ length: 2 }, () => ({ entered: deferred(), release: deferred(), finished: deferred() }));
  let request = 0;
  const pause: StreamAuthReader = {
    backend: auth.backend,
    async logFacts(...args) {
      const gate = gates[request++]!;
      gate.entered.resolve();
      await gate.release.promise;
      try { return await auth.logFacts(...args); } finally { gate.finished.resolve(); }
    },
    async traceFacts(...args) {
      const gate = gates[request++]!;
      gate.entered.resolve();
      await gate.release.promise;
      try { return await auth.traceFacts(...args); } finally { gate.finished.resolve(); }
    },
  };
  const active = new Set<number>();
  const hub = createEmptyLiveHub(createLocalHubTransport());
  // Only the keyed browser overload is used by this fixture.
  hub.subscribe = ((_key: string, fromSeq: number): HubSubscription => {
    active.add(fromSeq);
    return { first_seq: 1, head: 50, log_version: null, gap: null, unsubscribe: () => { active.delete(fromSeq); } };
  }) as typeof hub.subscribe;
  const server = startMultiremiServer({ store, scheduler: null, port: 0, hostname: "127.0.0.1", authToken: null, liveHub: hub, streamAuth: pause });
  const path = stream === "log" ? "/ws" : "/api/trace/ws";
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}${path}?workspace_id=${workspace.id}`);
  const frames: Array<{ type: string }> = [];
  socket.addEventListener("message", (event) => frames.push(JSON.parse(String(event.data))));
  await authenticateBrowserWebSocket(socket, token.token);
  const id = stream === "log" ? session.id : task.id;
  const subscribe = (fromSeq: number) => socket.send(JSON.stringify({ type: "stream.subscribe", payload: { stream, id, from_seq: fromSeq } }));
  const barrier = async () => {
    const pong = nextWebSocketMessage(socket);
    socket.send(JSON.stringify({ type: "ping" }));
    expect(await pong).toEqual({ type: "pong" });
  };
  return { server, socket, id, gates, active, frames, subscribe, barrier };
}

describe.each(["log", "trace"] as const)("MUL-438 pending %s subscriptions over real sockets", (stream) => {
  it("cancels pending authorization after unsubscribe has been processed", async () => {
    const fixture = await pausedSubscriptionFixture(stream);
    const { server, socket, id, gates, active, frames, subscribe, barrier } = fixture;
    try {
      subscribe(1);
      await gates[0]!.entered.promise;
      socket.send(JSON.stringify({ type: "stream.unsubscribe", payload: { stream, id } }));
      await barrier();
      const quiet = expectNoWebSocketMessage(socket);
      gates[0]!.release.resolve();
      await quiet;
      expect(frames.filter((frame) => frame.type === "stream.ack")).toEqual([]);
      expect(active.size).toBe(0);
    } finally {
      for (const gate of gates) gate.release.resolve();
      socket.close();
      server.stop(true);
    }
  });

  it("disposes pending authorization when the connection closes", async () => {
    const { server, socket, gates, active, subscribe } = await pausedSubscriptionFixture(stream);
    try {
      subscribe(1);
      await gates[0]!.entered.promise;
      const closed = new Promise<void>((resolve) => socket.addEventListener("close", () => resolve(), { once: true }));
      socket.close();
      await closed;
      gates[0]!.release.resolve();
      await gates[0]!.finished.promise;
      await Bun.sleep(10);
      expect(active.size).toBe(0);
    } finally {
      for (const gate of gates) gate.release.resolve();
      socket.close();
      server.stop(true);
    }
  });

  it("keeps the newer anchor when the older authorization finishes last", async () => {
    const { server, socket, gates, active, frames, subscribe, barrier } = await pausedSubscriptionFixture(stream);
    try {
      subscribe(1);
      await gates[0]!.entered.promise;
      subscribe(50);
      await gates[1]!.entered.promise;
      const ack = nextWebSocketMessage(socket);
      gates[1]!.release.resolve();
      expect(await ack).toMatchObject({ type: "stream.ack" });
      expect([...active]).toEqual([50]);
      const quiet = expectNoWebSocketMessage(socket);
      gates[0]!.release.resolve();
      await quiet;
      await barrier();
      expect([...active]).toEqual([50]);
      expect(frames.filter((frame) => frame.type === "stream.ack")).toHaveLength(1);
    } finally {
      for (const gate of gates) gate.release.resolve();
      socket.close();
      server.stop(true);
    }
  });
});

describe("MUL-438 browser stream endpoints", () => {
  it("lets a real WSClient subscribe between open and auth_ack without breaking authentication", async () => {
    const store = createStore();
    const workspace = store.ensureLocalWorkspace();
    store.createWorkspaceMember({ workspaceId: workspace.id, userId: "creator", name: "Creator", role: "owner" });
    const issue = store.createIssue({ title: "Client handshake", workspaceId: workspace.id });
    const session = store.getOrCreateDefaultIssueSession(issue.id, "creator");
    const token = await store.createAccessToken({ name: "Creator", type: "pat", workspaceId: workspace.id, userId: "creator" });
    const verify = store.verifyAccessToken.bind(store);
    const entered = deferred();
    const release = deferred();
    const finished = deferred();
    store.verifyAccessToken = async (...args) => {
      entered.resolve();
      await release.promise;
      try { return await verify(...args); } finally { finished.resolve(); }
    };
    const server = startMultiremiServer({ store, scheduler: null, port: 0, hostname: "127.0.0.1", authToken: null });
    const client = new WSClient(`ws://127.0.0.1:${server.port}/ws?workspace_id=${workspace.id}`);
    client.setAuth(token.token, workspace.slug);
    client.connect();
    const socket = (client as unknown as { ws: WebSocket }).ws;
    let acknowledged = false;
    try {
      await waitWebSocketOpen(socket);
      await entered.promise;
      client.subscribeStream("log", session.id, { onAck: () => { acknowledged = true; } });
      await expectNoWebSocketMessage(socket);
      expect(socket.readyState).toBe(WebSocket.OPEN);
      const handshakeAndAck = nextWebSocketMessages(socket, 2);
      release.resolve();
      expect(await handshakeAndAck).toMatchObject([
        { type: "auth_ack" },
        { type: "stream.ack", payload: { stream: "log", id: session.id } },
      ]);
      expect(acknowledged).toBe(true);
      expect(client.authenticated).toBe(true);
      expect(socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      release.resolve();
      await finished.promise;
      client.disconnect();
      server.stop(true);
    }
  });

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
