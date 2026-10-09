import { createResponsibleTestIssue } from './helpers.js';
// MUL-438 / C3: the browser WebSocket's v2 stream protocol.
//
// These are the acceptance cases the sub-issue names for the server side:
// authorization refusals across all of a log stream's ownership shapes and the
// trace stream, ack and gap, `from_seq` resumption, `wrong_endpoint`, and the
// resync broadcast.
//
// The hub is a fake that implements the C0 seam, so this suite does not wait for
// C1 (MUL-436). It is deliberately scriptable: each test states what the hub
// held, what the socket asked for and what the client saw.
import { afterEach, describe, expect, it } from "bun:test";
import { createEmptyLiveHub } from "../../../packages/server/src/api/hub/live-hub.js";
import { createLocalHubTransport } from "../../../packages/server/src/api/hub/hub-transport.js";
import type {
  HubFrame,
  HubFrameListener,
  HubStreamKey,
  HubSubscription,
  LiveHub,
} from "../../../packages/server/src/api/hub/live-hub.js";
import {
  BROWSER_RESYNC_JITTER_MAX_MS,
  broadcastBrowserResync,
} from "../../../packages/server/src/api/hub/browser-stream.js";
import {
  createStore,
  nextWebSocketMessage,
  resetMultiremiTestEnv,
  authenticateBrowserWebSocket,
} from "./helpers.js";
import type { MultiremiStore } from "@multiremi/store/store.js";

afterEach(resetMultiremiTestEnv);

/**
 * A hub that answers from a script instead of a ring.
 *
 * `subscribe` reports the range the test declares and replays the frames the
 * test declares, so an assertion about `stream.ack`/`stream.data` is a statement
 * about the socket's mapping, not about C1's buffering.
 */
class FakeHub implements LiveHub {
  readonly transport = createLocalHubTransport();
  readonly subscriptions: Array<{
    key: string;
    fromSeq: number;
    listener: HubFrameListener;
    unsubscribed: boolean;
  }> = [];
  script: {
    first_seq: number;
    head: number;
    log_version?: number | null;
    gap?: { from: number; to: number } | null;
    replay?: readonly HubFrame[];
  } = { first_seq: 1, head: 0, log_version: null, gap: null };

  append() { return { head: 0 }; }
  head() { return null; }
  close() {}
  onEntry() {}
  subscribeHumanRequests() { return { unsubscribe: () => {} }; }

  subscribe(keyOrTaskId: string, fromSeq: number, onFrames: HubFrameListener | ((...args: any[]) => void)): any {
    const listener = onFrames as HubFrameListener;
    const record = {
      key: keyOrTaskId,
      fromSeq,
      listener,
      unsubscribed: false,
    };
    this.subscriptions.push(record);
    if (this.script.replay?.length) listener(keyOrTaskId as HubStreamKey, this.script.replay);
    return {
      first_seq: this.script.first_seq,
      head: this.script.head,
      log_version: this.script.log_version ?? null,
      gap: this.script.gap ?? null,
      unsubscribe: () => { record.unsubscribed = true; },
    } satisfies HubSubscription;
  }

  /** Push a batch to every subscriber of `key`, as the real hub's flush does. */
  emit(key: string, frames: readonly HubFrame[]): void {
    for (const subscription of this.subscriptions) {
      if (subscription.unsubscribed || subscription.key !== key) continue;
      subscription.listener(key as HubStreamKey, frames);
    }
  }
}

function frame(seq: number, kind: HubFrame["kind"] = "entry", payload: unknown = { seq }): HubFrame {
  return { seq, kind, payload };
}

interface SeededWorld {
  store: MultiremiStore;
  workspaceId: string;
  issueSessionId: string;
  otherIssueSessionId: string;
  chatSessionId: string;
  memberUserId: string;
  creatorUserId: string;
  taskId: string;
  chatTaskId: string;
  privateAgentTaskId: string;
}

/** One workspace with an issue session, a chat session and three tasks. */
function seedWorld(store: MultiremiStore): SeededWorld {
  const workspace = store.ensureLocalWorkspace();
  store.createWorkspaceMember({ workspaceId: workspace.id, userId: "creator", name: "Creator", role: "owner" });
  store.createWorkspaceMember({ workspaceId: workspace.id, userId: "member", name: "Member", role: "member" });
  const agent = store.createAgent({ name: "Public agent", provider: "codex", workspaceId: workspace.id, visibility: "workspace" });
  const privateAgent = store.createAgent({
    name: "Private agent",
    provider: "codex",
    workspaceId: workspace.id,
    visibility: "private",
    ownerId: "creator",
  });
  const issue = createResponsibleTestIssue(store, { title: "Streamed issue", workspaceId: workspace.id });
  const session = store.getOrCreateDefaultIssueSession(issue.id, "creator");
  const otherIssue = createResponsibleTestIssue(store, { title: "Second issue", workspaceId: workspace.id });
  const otherSession = store.getOrCreateDefaultIssueSession(otherIssue.id, "creator");
  const chat = store.createChatSession({ agentId: agent.id, workspaceId: workspace.id, creatorId: "creator", title: "Private chat" });
  const task = store.createTask({ agentId: agent.id, workspaceId: workspace.id, prompt: "issue task", issueId: issue.id });
  const chatTask = store.createTask({ agentId: agent.id, workspaceId: workspace.id, prompt: "chat task", chatSessionId: chat.id });
  const privateAgentTask = store.createTask({ agentId: privateAgent.id, workspaceId: workspace.id, prompt: "private task", issueId: otherIssue.id });
  return {
    store,
    workspaceId: workspace.id,
    issueSessionId: session.id,
    otherIssueSessionId: otherSession.id,
    chatSessionId: chat.id,
    memberUserId: "member",
    creatorUserId: "creator",
    taskId: task.id,
    chatTaskId: chatTask.id,
    privateAgentTaskId: privateAgentTask.id,
  };
}

interface FakeClient {
  data: {
    kind: "browser";
    connectedAt: string;
    workspaceId: string;
    authenticated: boolean;
    userId: string | null;
    accessToken: null;
    streamEndpoint?: "log" | "trace";
  };
  frames: any[];
  sendText(message: string): void;
  close(): void;
}

function fakeClient(workspaceId: string, userId: string | null): FakeClient {
  const frames: any[] = [];
  return {
    data: {
      kind: "browser",
      connectedAt: new Date().toISOString(),
      workspaceId,
      authenticated: true,
      userId,
      accessToken: null,
    },
    frames,
    sendText(message: string) {
      frames.push(JSON.parse(message));
    },
    close() {},
  };
}

/** Build the handler the `/ws` endpoint installs, with a scriptable hub. */
async function logHandler(world: SeededWorld, hub = new FakeHub()) {
  const { createBrowserStreamHandler } = await import("../../../packages/server/src/api/hub/browser-stream.js");
  const { createSqliteStreamAuthReader } = await import("../../../packages/server/src/api/hub/stream-auth.js");
  return {
    hub,
    handler: createBrowserStreamHandler({
      hub,
      auth: createSqliteStreamAuthReader(world.store),
      endpoint: "log",
    }),
  };
}

async function traceHandler(world: SeededWorld, hub = new FakeHub()) {
  const { createBrowserStreamHandler } = await import("../../../packages/server/src/api/hub/browser-stream.js");
  const { createSqliteStreamAuthReader } = await import("../../../packages/server/src/api/hub/stream-auth.js");
  return {
    hub,
    handler: createBrowserStreamHandler({
      hub,
      auth: createSqliteStreamAuthReader(world.store),
      endpoint: "trace",
    }),
  };
}

const subscribeFrame = (stream: "log" | "trace", id: string, fromSeq = 1) => ({
  type: "stream.subscribe",
  payload: { stream, id, from_seq: fromSeq },
});

describe("MUL-438 pending subscription disposal", () => {
  it("invalidates authorization even when dispose precedes the first active subscription", async () => {
    const world = seedWorld(createStore());
    const { createBrowserStreamHandler } = await import("../../../packages/server/src/api/hub/browser-stream.js");
    const { createSqliteStreamAuthReader } = await import("../../../packages/server/src/api/hub/stream-auth.js");
    const reader = createSqliteStreamAuthReader(world.store);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const hub = new FakeHub();
    const handler = createBrowserStreamHandler({
      hub,
      endpoint: "log",
      auth: {
        ...reader,
        async logFacts(...args) {
          await gate;
          return reader.logFacts(...args);
        },
      },
    });
    const client = fakeClient(world.workspaceId, world.creatorUserId);
    const pending = handler.handleSubscribe(client as any, subscribeFrame("log", world.issueSessionId));
    handler.disposeClient(client as any);
    release();
    await pending;
    expect(handler.subscriptionCount(client as any)).toBe(0);
    expect(hub.subscriptions.filter((subscription) => !subscription.unsubscribed)).toHaveLength(0);
    expect(client.frames).toEqual([]);
  });
});

describe("MUL-438 browser stream protocol — log subscription authorization", () => {
  it("allows an issue session to a workspace member", async () => {
    const world = seedWorld(createStore());
    const { handler } = await logHandler(world);
    const client = fakeClient(world.workspaceId, world.memberUserId);

    await handler.handleSubscribe(client as any, subscribeFrame("log", world.issueSessionId));

    expect(client.frames).toHaveLength(1);
    expect(client.frames[0]).toMatchObject({
      type: "stream.ack",
      payload: { stream: "log", id: world.issueSessionId },
    });
  });

  it("allows a chat session to its creator", async () => {
    const world = seedWorld(createStore());
    const { handler } = await logHandler(world);
    const client = fakeClient(world.workspaceId, world.creatorUserId);

    await handler.handleSubscribe(client as any, subscribeFrame("log", world.chatSessionId));

    expect(client.frames[0]).toMatchObject({ type: "stream.ack", payload: { stream: "log", id: world.chatSessionId } });
  });

  it("refuses a chat session to another workspace member", async () => {
    const world = seedWorld(createStore());
    const { handler, hub } = await logHandler(world);
    const client = fakeClient(world.workspaceId, world.memberUserId);

    await handler.handleSubscribe(client as any, subscribeFrame("log", world.chatSessionId));

    expect(client.frames).toEqual([
      { type: "stream.error", payload: { stream: "log", id: world.chatSessionId, code: "forbidden" } },
    ]);
    // A refused subscription must not leave a live hub subscription behind.
    expect(hub.subscriptions).toHaveLength(0);
  });

  it("refuses an unknown session id with the same code as a forbidden one", async () => {
    const world = seedWorld(createStore());
    const { handler } = await logHandler(world);
    const unknown = fakeClient(world.workspaceId, world.creatorUserId);
    const forbidden = fakeClient(world.workspaceId, world.memberUserId);

    await handler.handleSubscribe(unknown as any, subscribeFrame("log", "ises_does_not_exist"));
    await handler.handleSubscribe(forbidden as any, subscribeFrame("log", world.chatSessionId));

    expect(unknown.frames[0].payload.code).toBe("forbidden");
    expect(forbidden.frames[0].payload.code).toBe("forbidden");
  });

  it("refuses a session from another workspace even for its nominal user", async () => {
    const world = seedWorld(createStore());
    const { handler } = await logHandler(world);
    // Same user id, but a socket bound to a different workspace.
    const foreign = fakeClient("ws_not_this_one", world.creatorUserId);

    await handler.handleSubscribe(foreign as any, subscribeFrame("log", world.chatSessionId));

    expect(foreign.frames[0]).toMatchObject({ type: "stream.error", payload: { code: "forbidden" } });
  });
});

describe("MUL-438 browser stream protocol — trace subscription authorization", () => {
  it("allows an ordinary issue task to a workspace member", async () => {
    const world = seedWorld(createStore());
    const { handler } = await traceHandler(world);
    const client = fakeClient(world.workspaceId, world.memberUserId);

    await handler.handleSubscribe(client as any, subscribeFrame("trace", world.taskId));

    expect(client.frames[0]).toMatchObject({ type: "stream.ack", payload: { stream: "trace", id: world.taskId } });
  });

  it("refuses a chat task to a non-creator and allows the creator", async () => {
    const world = seedWorld(createStore());
    const { handler } = await traceHandler(world);
    const peer = fakeClient(world.workspaceId, world.memberUserId);
    const creator = fakeClient(world.workspaceId, world.creatorUserId);

    await handler.handleSubscribe(peer as any, subscribeFrame("trace", world.chatTaskId));
    await handler.handleSubscribe(creator as any, subscribeFrame("trace", world.chatTaskId));

    expect(peer.frames[0]).toMatchObject({ type: "stream.error", payload: { code: "forbidden" } });
    expect(creator.frames[0]).toMatchObject({ type: "stream.ack", payload: { stream: "trace", id: world.chatTaskId } });
  });

  it("refuses a private agent's task to a peer and allows the owner", async () => {
    const world = seedWorld(createStore());
    const { handler } = await traceHandler(world);
    const peer = fakeClient(world.workspaceId, world.memberUserId);
    const owner = fakeClient(world.workspaceId, world.creatorUserId);

    await handler.handleSubscribe(peer as any, subscribeFrame("trace", world.privateAgentTaskId));
    await handler.handleSubscribe(owner as any, subscribeFrame("trace", world.privateAgentTaskId));

    expect(peer.frames[0]).toMatchObject({ type: "stream.error", payload: { code: "forbidden" } });
    expect(owner.frames[0]).toMatchObject({ type: "stream.ack" });
  });

  it("allows a workspace admin to read a private agent's task", async () => {
    const world = seedWorld(createStore());
    // A second admin who does not own the private agent.
    world.store.createWorkspaceMember({ workspaceId: world.workspaceId, userId: "admin", name: "Admin", role: "admin" });
    const { handler } = await traceHandler(world);
    const admin = fakeClient(world.workspaceId, "admin");

    await handler.handleSubscribe(admin as any, subscribeFrame("trace", world.privateAgentTaskId));

    expect(admin.frames[0]).toMatchObject({ type: "stream.ack" });
  });
});

describe("MUL-438 browser stream protocol — frames", () => {
  it("answers stream.ack with the hub's range and forwards a replay batch after it", async () => {
    const world = seedWorld(createStore());
    const hub = new FakeHub();
    hub.script = {
      first_seq: 5,
      head: 9,
      log_version: 77,
      gap: null,
      replay: [frame(5), frame(6)],
    };
    const { handler } = await logHandler(world, hub);
    const client = fakeClient(world.workspaceId, world.creatorUserId);

    await handler.handleSubscribe(client as any, subscribeFrame("log", world.issueSessionId, 5));

    expect(client.frames.map((entry) => entry.type)).toEqual(["stream.ack", "stream.data"]);
    expect(client.frames[0].payload).toEqual({
      stream: "log",
      id: world.issueSessionId,
      first_seq: 5,
      head_seq: 9,
      log_version: 77,
      gap: null,
    });
    expect(client.frames[1].payload.frames.map((entry: HubFrame) => entry.seq)).toEqual([5, 6]);
    // The requested cursor — what C3's resume rule sends — reaches the hub
    // unchanged: `from_seq` is exclusive and local head + 1 is the client's job.
    expect(hub.subscriptions[0]!.fromSeq).toBe(5);
  });

  it("reports a gap the client must backfill instead of hiding it", async () => {
    const world = seedWorld(createStore());
    const hub = new FakeHub();
    hub.script = { first_seq: 41, head: 60, log_version: 3, gap: { from: 30, to: 40 } };
    const { handler } = await logHandler(world, hub);
    const client = fakeClient(world.workspaceId, world.creatorUserId);

    await handler.handleSubscribe(client as any, subscribeFrame("log", world.issueSessionId, 30));

    expect(client.frames[0].payload).toMatchObject({ first_seq: 41, head_seq: 60, gap: { from: 30, to: 40 } });
  });

  it("streams live batches to a subscribed socket and stops after unsubscribe", async () => {
    const world = seedWorld(createStore());
    const hub = new FakeHub();
    const { handler } = await logHandler(world, hub);
    const client = fakeClient(world.workspaceId, world.creatorUserId);

    await handler.handleSubscribe(client as any, subscribeFrame("log", world.issueSessionId));
    hub.emit(`log:${world.issueSessionId}`, [frame(1), frame(2)]);
    expect(client.frames[1]).toMatchObject({
      type: "stream.data",
      payload: { stream: "log", id: world.issueSessionId },
    });
    expect(client.frames[1].payload.frames).toHaveLength(2);

    handler.handleUnsubscribe(client as any, {
      type: "stream.unsubscribe",
      payload: { stream: "log", id: world.issueSessionId },
    });
    hub.emit(`log:${world.issueSessionId}`, [frame(3)]);
    expect(client.frames).toHaveLength(2);
    expect(hub.subscriptions[0]!.unsubscribed).toBe(true);
    expect(handler.subscriptionCount(client as any)).toBe(0);
  });

  it("replaces the existing subscription when the same stream is re-subscribed", async () => {
    const world = seedWorld(createStore());
    const hub = new FakeHub();
    const { handler } = await logHandler(world, hub);
    const client = fakeClient(world.workspaceId, world.creatorUserId);

    await handler.handleSubscribe(client as any, subscribeFrame("log", world.issueSessionId, 1));
    hub.script = { first_seq: 8, head: 8, log_version: null, gap: null };
    await handler.handleSubscribe(client as any, subscribeFrame("log", world.issueSessionId, 8));

    expect(hub.subscriptions.map((entry) => entry.fromSeq)).toEqual([1, 8]);
    expect(hub.subscriptions[0]!.unsubscribed).toBe(true);
    expect(hub.subscriptions[1]!.unsubscribed).toBe(false);
    expect(handler.subscriptionCount(client as any)).toBe(1);
  });

  it("drops every subscription when the connection closes", async () => {
    const world = seedWorld(createStore());
    const hub = new FakeHub();
    const { handler } = await logHandler(world, hub);
    const client = fakeClient(world.workspaceId, world.creatorUserId);

    await handler.handleSubscribe(client as any, subscribeFrame("log", world.issueSessionId));
    await handler.handleSubscribe(client as any, subscribeFrame("log", world.otherIssueSessionId));
    handler.disposeClient(client as any);

    expect(hub.subscriptions.every((entry) => entry.unsubscribed)).toBe(true);
    expect(handler.subscriptionCount(client as any)).toBe(0);
  });

  it("refuses a malformed subscribe with invalid_payload and never reaches the hub", async () => {
    const world = seedWorld(createStore());
    const hub = new FakeHub();
    const { handler } = await logHandler(world, hub);
    const client = fakeClient(world.workspaceId, world.creatorUserId);

    for (const payload of [
      { stream: "log" },
      { stream: "log", id: "ises_x", from_seq: -1 },
      { stream: "log", id: "ises_x", from_seq: 1.5 },
      { stream: "log", id: "ises_x", from_seq: "1" },
      { stream: "timeline", id: "ises_x", from_seq: 1 },
    ]) {
      client.frames.length = 0;
      await handler.handleSubscribe(client as any, { type: "stream.subscribe", payload });
      expect(client.frames[0]).toMatchObject({ type: "stream.error", payload: { code: "invalid_payload" } });
    }
    expect(hub.subscriptions).toHaveLength(0);
  });
});

describe("MUL-438 browser stream protocol — a failing dependency is a refusal, not a crash", () => {
  it("answers unavailable when the hub refuses the subscription", async () => {
    const world = seedWorld(createStore());
    const hub = new FakeHub();
    hub.subscribe = () => { throw new Error("hub is closed"); };
    const { handler } = await logHandler(world, hub);
    const client = fakeClient(world.workspaceId, world.creatorUserId);

    await handler.handleSubscribe(client as any, subscribeFrame("log", world.issueSessionId));

    expect(client.frames).toEqual([
      { type: "stream.error", payload: { stream: "log", id: world.issueSessionId, code: "unavailable" } },
    ]);
  });

  it("answers unavailable when the authorization reader throws", async () => {
    const world = seedWorld(createStore());
    const { createBrowserStreamHandler } = await import("../../../packages/server/src/api/hub/browser-stream.js");
    const handler = createBrowserStreamHandler({
      hub: new FakeHub(),
      auth: {
        backend: "sqlite",
        async logFacts() { throw new Error("reader exploded"); },
        async traceFacts() { throw new Error("reader exploded"); },
      },
      endpoint: "log",
    });
    const client = fakeClient(world.workspaceId, world.creatorUserId);

    await handler.handleSubscribe(client as any, subscribeFrame("log", world.issueSessionId));

    expect(client.frames).toEqual([
      { type: "stream.error", payload: { stream: "log", id: world.issueSessionId, code: "unavailable" } },
    ]);
    expect(handler.subscriptionCount(client as any)).toBe(0);
  });
});

describe("MUL-438 browser stream protocol — one stream per endpoint", () => {
  it("answers a trace subscribe on /ws with wrong_endpoint", async () => {
    const world = seedWorld(createStore());
    const { handler, hub } = await logHandler(world);
    const client = fakeClient(world.workspaceId, world.creatorUserId);

    await handler.handleSubscribe(client as any, subscribeFrame("trace", world.taskId));

    expect(client.frames).toEqual([
      { type: "stream.error", payload: { stream: "trace", id: world.taskId, code: "wrong_endpoint" } },
    ]);
    // Refused before authorization, so a log socket cannot even probe task ids.
    expect(hub.subscriptions).toHaveLength(0);
  });

  it("answers a log subscribe on /api/trace/ws with wrong_endpoint", async () => {
    const world = seedWorld(createStore());
    const { handler } = await traceHandler(world);
    const client = fakeClient(world.workspaceId, world.creatorUserId);

    await handler.handleSubscribe(client as any, subscribeFrame("log", world.issueSessionId));

    expect(client.frames[0]).toMatchObject({
      type: "stream.error",
      payload: { stream: "log", code: "wrong_endpoint" },
    });
  });
});

describe("MUL-438 browser stream protocol — resync broadcast", () => {
  it("reaches every browser socket once, with jitter bounded by 2s", () => {
    const sockets = [fakeClient("local", "a"), fakeClient("local", "b"), fakeClient("other", "c")];
    const registry = new Map<string, Set<any>>([
      ["local", new Set([sockets[0], sockets[1]])],
      ["other", new Set([sockets[2]])],
    ]);
    const delays: number[] = [];
    const handle = broadcastBrowserResync({
      browserWebSockets: registry as any,
      jitterMs: () => 1_500,
      setTimeoutFn: (callback, delayMs) => {
        delays.push(delayMs);
        callback();
        return 0;
      },
    });

    expect(handle.recipients).toBe(3);
    expect(delays).toEqual([1_500, 1_500, 1_500]);
    for (const socket of sockets) {
      expect(socket.frames).toEqual([{ type: "resync" }]);
    }
  });

  it("clamps a jitter source that escapes the documented window", () => {
    const sockets = [fakeClient("local", "a"), fakeClient("local", "b")];
    const registry = new Map<string, Set<any>>([["local", new Set(sockets)]]);
    const delays: number[] = [];
    broadcastBrowserResync({
      browserWebSockets: registry as any,
      jitterMs: (() => {
        let index = 0;
        const values = [-10, BROWSER_RESYNC_JITTER_MAX_MS + 5_000];
        return () => values[index++]!;
      })(),
      setTimeoutFn: (callback, delayMs) => {
        delays.push(delayMs);
        callback();
        return 0;
      },
    });

    expect(delays).toEqual([0, BROWSER_RESYNC_JITTER_MAX_MS]);
  });

  it("skips unauthenticated sockets and cancels pending frames", () => {
    const authenticated = fakeClient("local", "a");
    const anonymous = fakeClient("local", null);
    anonymous.data.authenticated = false;
    const registry = new Map<string, Set<any>>([["local", new Set([authenticated, anonymous])]]);
    const cancelled: unknown[] = [];
    const handle = broadcastBrowserResync({
      browserWebSockets: registry as any,
      jitterMs: () => 1_000,
      setTimeoutFn: () => ({ timer: true }),
      clearTimeoutFn: (timer) => cancelled.push(timer),
    });

    expect(handle.recipients).toBe(1);
    expect(authenticated.frames).toEqual([]);
    handle.cancel();
    expect(cancelled).toHaveLength(1);
    expect(authenticated.frames).toEqual([]);
  });
});
