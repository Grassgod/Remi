import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { createMultiremiApp, startMultiremiServer } from "@multiremi/api.js";
import { createHub } from "@multiremi/api/hub/hub-core.js";
import { createConversationLogFillReader } from "@multiremi/api/hub/conversation-log-fill-reader.js";
import { stopHubReadResources } from "@multiremi/api/hub/hub-lifecycle.js";
import { createPeerHubTransport } from "@multiremi/api/hub/peer-hub-transport.js";
import { createLocalHubTransport } from "@multiremi/api/hub/hub-transport.js";
import { createPeerChannel, type PeerChannel } from "@multiremi/api/peer/peer-channel.js";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { createReadPool } from "@multiremi/store/db/read-pool.js";
import { authenticateBrowserWebSocket } from "./helpers.js";

const pgAdminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;

async function withPgStore(run: (store: MultiremiStore, url: string) => Promise<void>): Promise<void> {
  const name = `mul444_hub_wiring_${process.pid}_${Math.floor(Math.random() * 1e8)}`;
  const admin = new Bun.SQL(pgAdminUrl!, { max: 1 });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(pgAdminUrl!);
  url.pathname = `/${name}`;
  const db = new PostgresSyncDatabase(url.toString());
  try { await run(new MultiremiStore(db), url.toString()); }
  finally {
    db.close();
    await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
}

function waitForMessage(socket: WebSocket, match: (message: any) => boolean): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error("Timed out waiting for matching websocket message"));
    }, 2_000);
    const onMessage = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data));
      if (!match(message)) return;
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      resolve(message);
    };
    socket.addEventListener("message", onMessage);
  });
}

function subscribe(socket: WebSocket, sessionId: string, fromSeq: number) {
  const ack = waitForMessage(socket, message => message.type === "stream.ack" && message.payload?.id === sessionId);
  socket.send(JSON.stringify({ type: "stream.subscribe", payload: { stream: "log", id: sessionId, from_seq: fromSeq } }));
  return ack;
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const until = Date.now() + 2_000;
  while (Date.now() < until) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe("conversation log server Hub wiring", () => {
  it("detaches the log listener and stops fill before closing the read pool", () => {
    const closed: string[] = [];
    stopHubReadResources(
      () => { closed.push("listener"); },
      { shutdown: () => { closed.push("hub"); } },
      { close: async () => { closed.push("pool"); } },
    );
    expect(closed).toEqual(["listener", "hub", "pool"]);
  });

  it("warms a cold SQLite log with the same entries as the store read", async () => {
    const db = new Database(":memory:");
    const store = new MultiremiStore(db);
    const sessionId = "ises_cold_fill";
    for (let i = 1; i <= 3; i++) {
      store.appendConversationLog({ sessionId, kind: "message", authorType: "system", bodyMd: `row ${i}` });
    }
    const fill = createConversationLogFillReader(store, null);
    const hub = createHub({ transport: createLocalHubTransport(), role: "all", fill });
    const seen: number[] = [];
    const subscription = hub.subscribe(`log:${sessionId}`, 1, (_key, frames) => seen.push(...frames.map(frame => frame.seq)));
    try {
      await waitFor(() => seen.length === 3, "cold log replay");
      expect(seen).toEqual(store.listConversationLogEntries(sessionId).map(row => row.seq));
      expect(await fill.readRange("trace:tsk_cold_fill", 0, 3)).toEqual([]);
      expect(await fill.traceHead("tsk_cold_fill")).toBeNull();
    } finally {
      subscription.unsubscribe();
      hub.shutdown();
      db.close();
    }
  });

  it.skipIf(!pgAdminUrl)("fills a UI peer from committed runtime rows using the Postgres read pool", async () => {
    await withPgStore(async (store, url) => {
      const runtimeDb = new PostgresSyncDatabase(url);
      const runtimeStore = new MultiremiStore(runtimeDb);
      const readPool = createReadPool({ databaseUrl: url, role: "ui" });
      const sessionId = "ises_peer_fill";
      const cold = runtimeStore.appendConversationLog({ sessionId, kind: "message", authorType: "system", bodyMd: "cold row" });
      let receiver!: PeerChannel;
      const sender = createPeerChannel({
        url: "http://ui.test", secret: "test-only", minBackoffMs: 10, maxBackoffMs: 20,
        fetchImpl: async (_url, init) => {
          const body = JSON.parse(String(init.body)) as { topic: string; events: unknown[]; epoch: string; batch_seq: number };
          receiver.receive(body.topic, body.events, { epoch: body.epoch, batchSeq: body.batch_seq });
          return new Response("{}", { status: 200 });
        },
      });
      receiver = createPeerChannel({ url: "http://runtime.test", secret: "test-only", fetchImpl: async () => new Response("{}") });
      const runtimeHub = createHub({ transport: createPeerHubTransport({ peer: sender, heartbeatMs: 100_000 }), role: "runtime" });
      const uiHub = createHub({ transport: createPeerHubTransport({ peer: receiver, heartbeatMs: 100_000 }),
        role: "ui", fill: createConversationLogFillReader(store, readPool) });
      const detach = runtimeStore.subscribeConversationLog({ onEntry: (sessionId, row) => {
        runtimeHub.onEntry(sessionId, "target_seq" in row ? { ...row, session_id: sessionId } : row);
      } });
      const seen: number[] = [];
      const subscription = uiHub.subscribe(`log:${sessionId}`, 1, (_key, frames) => seen.push(...frames.map(frame => frame.seq)));
      try {
        await waitFor(() => seen.includes(cold.seq), "Postgres cold log replay");
        const entry = runtimeStore.appendConversationLog({ sessionId, kind: "message", authorType: "system", bodyMd: "runtime row" });
        await waitFor(() => seen.includes(entry.seq), "UI peer fill");
        expect(seen).toEqual(store.listConversationLogEntries(sessionId).map(row => row.seq));
        expect(await readPool.queryOne("SELECT head_seq FROM multiremi_conversation_heads WHERE session_id = ?", [sessionId]))
          .toMatchObject({ head_seq: entry.seq });
      } finally {
        subscription.unsubscribe();
        detach();
        uiHub.shutdown();
        runtimeHub.shutdown();
        sender.close();
        receiver.close();
        await readPool.close();
        runtimeDb.close();
      }
    });
  }, 30_000);

  it.skipIf(!pgAdminUrl)("publishes committed Chat and Issue API writes and replays after reconnect", async () => {
    await withPgStore(async (store) => {
      const workspace = store.ensureLocalWorkspace();
      store.createWorkspaceMember({ workspaceId: workspace.id, userId: "creator", name: "Creator", role: "owner" });
      const agent = store.createAgent({ name: "Log agent", provider: "codex", workspaceId: workspace.id });
      const chat = store.createChatSession({ agentId: agent.id, workspaceId: workspace.id, creatorId: "creator", title: "Hub chat" });
      const issue = store.createIssue({ title: "Hub issue", workspaceId: workspace.id });
      const issueSession = store.getOrCreateDefaultIssueSession(issue.id, "creator");
      const token = await store.createAccessToken({ name: "Hub test", type: "pat", workspaceId: workspace.id, userId: "creator" });
      const server = startMultiremiServer({ store, backgroundJobs: false, port: 0, hostname: "127.0.0.1", authToken: null });
      const base = `http://127.0.0.1:${server.port}`;
      const headers = { Authorization: `Bearer ${token.token}`, "X-Workspace-Slug": workspace.slug, "Content-Type": "application/json" };
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?workspace_id=${workspace.id}`);
      let resumed: WebSocket | null = null;
      try {
        await authenticateBrowserWebSocket(socket, token.token);
        expect(await subscribe(socket, chat.id, store.getConversationLogHead(chat.id)!.headSeq + 1))
          .toMatchObject({ type: "stream.ack", payload: { stream: "log", id: chat.id } });
        const chatFrame = waitForMessage(socket, message => message.type === "stream.data" && message.payload?.id === chat.id);
        const sent = await fetch(`${base}/api/chat/sessions/${chat.id}/messages`, { method: "POST", headers, body: JSON.stringify({ content: "live chat" }) });
        expect(sent.status).toBe(201);
        const chatData = await chatFrame;
        const chatHead = await (await fetch(`${base}/api/sessions/${chat.id}/log?before=30`, { headers })).json() as { head_seq: number };
        expect(chatData).toMatchObject({ type: "stream.data", payload: { stream: "log", id: chat.id, frames: [{ seq: chatHead.head_seq, kind: "entry" }] } });

        expect(await subscribe(socket, issueSession.id, store.getConversationLogHead(issueSession.id)!.headSeq + 1))
          .toMatchObject({ type: "stream.ack", payload: { stream: "log", id: issueSession.id } });
        const issueFrame = waitForMessage(socket, message => message.type === "stream.data" && message.payload?.id === issueSession.id);
        const posted = await fetch(`${base}/api/issues/${issue.id}/comments`, { method: "POST", headers,
          body: JSON.stringify({ content: "live issue", issue_session_id: issueSession.id }) });
        expect(posted.status).toBe(201);
        const issueData = await issueFrame;
        const issueHead = await (await fetch(`${base}/api/sessions/${issueSession.id}/log?before=30`, { headers })).json() as { head_seq: number };
        expect(issueData).toMatchObject({ type: "stream.data", payload: { stream: "log", id: issueSession.id, frames: [{ seq: issueHead.head_seq, kind: "entry" }] } });

        const patchFrame = waitForMessage(socket, message => message.type === "stream.data"
          && message.payload?.id === issueSession.id && message.payload.frames?.some((frame: { kind: string }) => frame.kind === "patch"));
        const comment = await posted.json() as { id: string };
        const edited = await fetch(`${base}/api/comments/${comment.id}`, { method: "PUT", headers, body: JSON.stringify({ body: "edited issue" }) });
        expect(edited.status).toBe(200);
        expect(await patchFrame).toMatchObject({ payload: { frames: [{ seq: issueHead.head_seq, kind: "patch", payload: { session_id: issueSession.id } }] } });

        socket.close();
        await fetch(`${base}/api/chat/sessions/${chat.id}/messages`, { method: "POST", headers, body: JSON.stringify({ content: "missed chat" }) });
        resumed = new WebSocket(`ws://127.0.0.1:${server.port}/ws?workspace_id=${workspace.id}`);
        await authenticateBrowserWebSocket(resumed, token.token);
        const replay = waitForMessage(resumed, message => ["stream.data", "stream.gap"].includes(message.type) && message.payload?.id === chat.id);
        expect(await subscribe(resumed, chat.id, chatHead.head_seq + 1)).toMatchObject({ type: "stream.ack", payload: { stream: "log", id: chat.id } });
        const replayData = await replay;
        expect(["stream.data", "stream.gap"]).toContain(replayData.type);
        expect(replayData.payload.id).toBe(chat.id);
      } finally {
        socket.close();
        resumed?.close();
        server.stop(true);
      }
    });
  }, 30_000);

  it("leaves a caller's listener alone when the Hub is injected", () => {
    const db = new Database(":memory:");
    const store = new MultiremiStore(db);
    const hub = createHub({ transport: createLocalHubTransport(), role: "all" });
    const received: string[] = [];
    store.setConversationLogListener({ onEntry: (_sessionId, row) => received.push("seq" in row ? String(row.seq) : "patch") });
    const app = createMultiremiApp({ store, hub });
    const server = startMultiremiServer({ store, hub, backgroundJobs: false, port: 0, hostname: "127.0.0.1", authToken: null });
    try {
      expect(app).toBeDefined();
      store.appendConversationLog({ sessionId: "ises_injected", kind: "message", authorType: "system", bodyMd: "first" });
      expect(received).toEqual(["1"]);
      server.stop(true);
      store.appendConversationLog({ sessionId: "ises_injected", kind: "message", authorType: "system", bodyMd: "second" });
      expect(received).toEqual(["1", "2"]);
    } finally {
      server.stop(true);
      hub.shutdown();
      db.close();
    }
  });

  it("registers an app-owned Hub and detaches only the server-owned Hub", async () => {
    const db = new Database(":memory:");
    const store = new MultiremiStore(db);
    const received: number[] = [];
    store.subscribeConversationLog({ onEntry: (_sessionId, row) => {
      if ("seq" in row) received.push(row.seq);
    } });
    const app = createMultiremiApp({ store, backgroundJobs: false });
    const server = startMultiremiServer({ store, backgroundJobs: false, port: 0, hostname: "127.0.0.1", authToken: null });
    try {
      store.appendConversationLog({ sessionId: "ises_owned", kind: "message", authorType: "system", bodyMd: "first" });
      expect(received).toEqual([1]);
      expect(await (await app.request("/health")).json()).toMatchObject({ hub: { frames: 1 } });
      server.stop(true);
      store.appendConversationLog({ sessionId: "ises_owned", kind: "message", authorType: "system", bodyMd: "second" });
      expect(received).toEqual([1, 2]);
      expect(await (await app.request("/health")).json()).toMatchObject({ hub: { frames: 2 } });
    } finally {
      server.stop(true);
      db.close();
    }
  });
});
