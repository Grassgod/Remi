import { afterEach, describe, expect, it } from "bun:test";
import { createHub, type HubImpl } from "@multiremi/api/hub/hub-core.js";
import { createLocalHubTransport } from "@multiremi/api/hub/hub-transport.js";
import { createBrowserStreamHandler } from "@multiremi/api/hub/browser-stream.js";
import type { StreamAuthReader } from "@multiremi/api/hub/stream-auth.js";
import type { MultiremiWebSocketClient } from "@multiremi/api/helpers/realtime-types.js";
import { startMultiremiServer } from "@multiremi/api.js";
import { authenticateBrowserWebSocket, createStore, nextWebSocketMessage, nextWebSocketMessages, resetMultiremiTestEnv } from "./helpers.js";

const hubs: HubImpl[] = [];
afterEach(() => { for (const hub of hubs.splice(0)) hub.shutdown(); resetMultiremiTestEnv(); });
const auth: StreamAuthReader = {
  backend: "sqlite",
  logFacts: async () => ({ ok: true, facts: { kind: "issue", workspaceId: "w", creatorId: null, requesterIsMember: true } }),
  traceFacts: async () => ({ ok: true, facts: { workspaceId: "w", chatSessionId: null, chatCreatorId: null, agentId: null, agentVisibility: null, agentOwnerId: null, requesterIsWorkspaceAdmin: true } }),
};

function fixture(stream: "log" | "trace" = "log") {
  const hub = createHub({ transport: createLocalHubTransport(), scheduleFlush: () => {}, limits: { ring: { streamMaxFrames: 3 }, laggingBytes: 10 } });
  hubs.push(hub);
  const frames: Array<{ type: string; payload: any }> = [];
  let buffered = 0;
  const client = {
    data: { kind: "browser", connectedAt: "", workspaceId: "w", authenticated: true, userId: "u", accessToken: null, scopeSubscriptions: [] },
    sendText: (text: string) => { frames.push(JSON.parse(text)); },
    close: () => {},
    getBufferedAmount: () => buffered,
  } satisfies MultiremiWebSocketClient;
  const handler = createBrowserStreamHandler({ hub, auth, endpoint: stream });
  const subscribe = (fromSeq = 0) => handler.handleSubscribe(client, { type: "stream.subscribe", payload: { stream, id: "s", from_seq: fromSeq } });
  const row = (seq: number) => {
    if (stream === "log") hub.onEntry("s", { session_id: "s", seq, revision: 1, kind: "message", visibility: "shown" });
    else hub.append("s", [{ seq, type: "text", ts: "", content: String(seq) }]);
  };
  return { hub, client, handler, frames, subscribe, row, setBuffered: (bytes: number) => { buffered = bytes; } };
}

describe("MUL-436 regression 4B: real Hub browser sink", () => {
  for (const stream of ["log", "trace"] as const) {
    it(`reports a running ${stream} ring gap before the retained tail`, async () => {
      const { hub, frames, subscribe, row } = fixture(stream);
      await subscribe();
      for (let seq = 1; seq <= 10; seq++) row(seq);
      hub.flushNow();
      expect(frames.map((frame) => frame.type)).toEqual(["stream.ack", "stream.gap", "stream.data"]);
      expect(frames[1]!.payload).toEqual({ stream, id: "s", from: stream === "trace" ? 1 : 0, to: 7 });
      expect(frames[2]!.payload.frames.map((frame: { seq: number }) => frame.seq)).toEqual([8, 9, 10]);
    });

    it(`pauses ${stream} at socket backpressure and resumes only after drain`, async () => {
      const { hub, client, handler, frames, subscribe, row, setBuffered } = fixture(stream);
      await subscribe();
      setBuffered(11); row(1); hub.flushNow();
      const count = frames.length;
      for (let seq = 2; seq <= 8; seq++) row(seq);
      hub.flushNow();
      expect(hub.snapshot().lagging_subscribers).toBe(1);
      expect(frames).toHaveLength(count);
      setBuffered(0); handler.notifyDrain(client); hub.flushNow();
      expect(frames.slice(count).map((frame) => frame.type)).toEqual(["stream.gap", "stream.data"]);
      expect(frames.at(-1)!.payload.frames.map((frame: { seq: number }) => frame.seq)).toEqual([6, 7, 8]);
    });
  }

  it("reports a late lower revision instead of silently discarding it", async () => {
    const { hub, frames, subscribe, row } = fixture();
    await subscribe(); row(1); hub.flushNow();
    hub.onEntry("s", { session_id: "s", target_seq: 1, revision: 4, fields: { body_html: "new" } }); hub.flushNow();
    const count = frames.length;
    hub.onEntry("s", { session_id: "s", target_seq: 1, revision: 3, fields: { body_html: null } }); hub.flushNow();
    expect(frames.slice(count)).toEqual([{ type: "stream.gap", payload: { stream: "log", id: "s", from: 1, to: 1 } }]);
  });

  it("keeps synchronous data and gap behind the ack in their original order", async () => {
    const { hub, frames, subscribe } = fixture();
    const original = hub.subscribeWithSink.bind(hub);
    hub.subscribeWithSink = (key, from, sink) => {
      const sub = original(key, from, sink);
      sink.send([{ seq: 1, kind: "entry", payload: { seq: 1 } }]);
      sink.gap?.(2, 3);
      sink.send([{ seq: 4, kind: "entry", payload: { seq: 4 } }]);
      return sub;
    };
    await subscribe();
    expect(frames.map((frame) => frame.type)).toEqual(["stream.ack", "stream.data", "stream.gap", "stream.data"]);
  });

  it("sends running gaps and late-revision gaps over the real browser endpoint", async () => {
    const store = createStore();
    const workspace = store.ensureLocalWorkspace();
    const issue = store.createIssue({ title: "Hub socket gap", workspaceId: workspace.id });
    const session = store.getOrCreateDefaultIssueSession(issue.id, "local");
    const token = await store.createAccessToken({ name: "Hub sink test", type: "pat", workspaceId: workspace.id });
    const hub = createHub({ transport: createLocalHubTransport(), scheduleFlush: () => {}, limits: { ring: { streamMaxFrames: 3 } } });
    hubs.push(hub);
    const server = startMultiremiServer({ store, scheduler: null, port: 0, hostname: "127.0.0.1", authToken: null, liveHub: hub });
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?workspace_id=${workspace.id}`);
    try {
      await authenticateBrowserWebSocket(socket, token.token);
      const ack = nextWebSocketMessage(socket);
      socket.send(JSON.stringify({ type: "stream.subscribe", payload: { stream: "log", id: session.id, from_seq: 0 } }));
      expect(await ack).toMatchObject({ type: "stream.ack" });
      const tail = nextWebSocketMessages(socket, 2);
      for (let seq = 1; seq <= 10; seq++) hub.onEntry(session.id, { session_id: session.id, seq, revision: 1, kind: "message", visibility: "shown" });
      hub.flushNow();
      const frames = await tail;
      expect(frames[0]).toMatchObject({ type: "stream.gap", payload: { from: 0, to: 7 } });
      expect(frames[1]).toMatchObject({ type: "stream.data" });
      const patch = nextWebSocketMessage(socket);
      hub.onEntry(session.id, { session_id: session.id, target_seq: 10, revision: 4, fields: { body_html: "new" } }); hub.flushNow();
      expect(await patch).toMatchObject({ type: "stream.data" });
      const gap = nextWebSocketMessage(socket);
      hub.onEntry(session.id, { session_id: session.id, target_seq: 10, revision: 3, fields: { body_html: null } }); hub.flushNow();
      expect(await gap).toMatchObject({ type: "stream.gap", payload: { from: 10, to: 10 } });
    } finally {
      socket.close(); server.stop(true);
    }
  });
});

describe("MUL-436 regression 4C: browser inclusive resume", () => {
  for (const stream of ["log", "trace"] as const) {
    it(`replays ${stream} seq 2 and 3 from next-wanted 2 on repeated subscriptions`, async () => {
      const { hub, frames, subscribe, row } = fixture(stream);
      for (let seq = 1; seq <= 3; seq++) row(seq);
      for (let attempt = 0; attempt < 2; attempt++) {
        frames.length = 0;
        await subscribe(2);
        hub.flushNow();
        expect(frames.map((frame) => frame.type)).toEqual(["stream.ack", "stream.data"]);
        expect(frames[0]!.payload.gap).toBeNull();
        expect(frames[1]!.payload.frames.map((frame: { seq: number }) => frame.seq)).toEqual([2, 3]);
      }
    });
  }
});
