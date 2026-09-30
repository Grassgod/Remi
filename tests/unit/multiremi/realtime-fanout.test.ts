/**
 * MUL-462 acceptance: the fanout's role routing, the peer path between two real
 * API servers sharing one SQLite file, the loop guard, and the no-peer case.
 *
 * The two-server cases run in-process (`startMultiremiServer` twice, random
 * ports, one database file, each pointing at the other) because the routes,
 * the WebSocket registries, and the sender queue are what is under test — a
 * second OS process would add variance without changing what can break here.
 * PR-C (MUL-464) scales the same topology out to real child processes.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultiremiStore } from "@multiremi/store.js";
import { startMultiremiServer } from "@multiremi/api.js";
import { MultiremiDaemonClient } from "@multiremi/worker/client.js";
import { createPeerChannel, PEER_REALTIME_TOPIC, type PeerChannel, type PeerFetch } from "../../../packages/server/src/api/peer/peer-channel.js";
import type { PeerEventEnvelope } from "@multiremi/contracts/peer-events.js";
import { peerMetricsSnapshot, resetRequestMetricsForTest } from "@multiremi/observability/request-metrics.js";
import {
  notifyBrowserTaskEvent,
  notifyBrowserWorkspaceEvent,
} from "../../../packages/server/src/api/realtime.js";
import {
  createRealtimeFanout,
  type LocalRealtimeRole,
  type RealtimeFanoutOptions,
} from "../../../packages/server/src/api/realtime-fanout.js";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, nextWebSocketMessage, resetMultiremiTestEnv, waitWebSocketOpen } from "./helpers.js";

afterEach(() => {
  resetMultiremiTestEnv();
  resetRequestMetricsForTest();
});

/** A browser-registry client that records the frames it is handed. */
function fakeBrowserClient(frames: string[], options: { workspaceId?: string; userId?: string | null } = {}) {
  return {
    data: {
      kind: "browser" as const,
      connectedAt: new Date().toISOString(),
      workspaceId: options.workspaceId ?? "local",
      authenticated: true,
      userId: options.userId ?? "local",
      accessToken: null,
    },
    sendText: (frame: string) => frames.push(frame),
    close: () => {},
  };
}

type DaemonTaskEvent = Parameters<NonNullable<RealtimeFanoutOptions["onDaemonTask"]>>[0];

function registriesFor(workspaceId = "local") {
  const browserFrames: string[] = [];
  const userFrames: string[] = [];
  const daemonEvents: DaemonTaskEvent[] = [];
  const browserClient = fakeBrowserClient(browserFrames, { workspaceId });
  return {
    browserFrames,
    daemonEvents,
    onDaemonTask: (event: DaemonTaskEvent) => { daemonEvents.push(event); },
    registries: {
      browser: new Map([[workspaceId, new Set([browserClient])]]) as any,
      browserUser: new Map([["local", new Set([fakeBrowserClient(userFrames)])]]) as any,
    },
  };
}

describe("realtime fanout — role routing", () => {
  it("delivers browser events without using the retired daemon v1 registry", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Fanout agent", provider: "codex" });
    const runtime = store.registerRuntime({ id: "rt_fanout", name: "Fanout runtime", provider: "codex" });
    const { registries, browserFrames, daemonEvents, onDaemonTask } = registriesFor();
    const fanout = createRealtimeFanout({ role: "all", store, registries, onDaemonTask });

    try {
      const task = store.createTask({ agentId: agent.id, prompt: "fanout", runtimeId: runtime.id });
      expect(JSON.parse(browserFrames[0]!)).toMatchObject({ type: "task:queued", payload: { task_id: task.id } });
      expect(daemonEvents).toEqual([]);
    } finally {
      fanout.close();
    }
  });

  it("keeps a `runtime` process off browser delivery and both roles off daemon v1", () => {
    for (const [role, expectBrowser, expectDaemon] of [
      ["ui", 1, 0],
      ["runtime", 0, 0],
    ] as Array<[LocalRealtimeRole, number, number]>) {
      const store = createStore();
      const agent = store.createAgent({ name: `Fanout ${role}`, provider: "codex" });
      const runtime = store.registerRuntime({ id: "rt_fanout", name: "Fanout runtime", provider: "codex" });
      const { registries, browserFrames, daemonEvents, onDaemonTask } = registriesFor();
      const fanout = createRealtimeFanout({ role, store, registries, onDaemonTask });
      try {
        const task = store.createTask({ agentId: agent.id, prompt: "fanout", runtimeId: runtime.id });
        expect(browserFrames, role).toHaveLength(expectBrowser);
        expect(daemonEvents, role).toHaveLength(expectDaemon);
        if (expectDaemon) expect(daemonEvents[0]).toEqual({ type: "task:queued", task });
      } finally {
        fanout.close();
      }
    }
  });

  it("does not revive daemon v1 for a peer-delivered task_enqueued", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Fanout remote", provider: "codex" });
    const runtime = store.registerRuntime({ id: "rt_fanout", name: "Fanout runtime", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, prompt: "remote", runtimeId: runtime.id });
    const { registries, browserFrames, daemonEvents, onDaemonTask } = registriesFor();
    const fanout = createRealtimeFanout({ role: "runtime", store, registries, onDaemonTask });

    try {
      // Daemon v2 obtains pending tasks through its own protocol, not this registry.
      fanout.deliverRemote({
        v: 1,
        origin: "process-ui",
        kind: "task_enqueued",
        payload: { task, task_id: task.id },
      });
      expect(browserFrames).toHaveLength(0);
      expect(daemonEvents).toEqual([]);
    } finally {
      fanout.close();
    }
  });

  it("unsubscribes from the store on close", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Fanout close", provider: "codex" });
    const { registries, browserFrames } = registriesFor();
    const fanout = createRealtimeFanout({ role: "all", store, registries });
    fanout.close();

    store.createTask({ agentId: agent.id, prompt: "after close" });
    expect(browserFrames).toHaveLength(0);
  });
});

describe("realtime fanout — peer forwarding", () => {
  it("posts a locally produced event to the peer and never delivers it back to itself", async () => {
    const posts: Array<{ topic: string; events: unknown[] }> = [];
    const fetchImpl: PeerFetch = async (_url, init) => {
      posts.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200 });
    };
    const store = createStore();
    const agent = store.createAgent({ name: "Fanout forward", provider: "codex" });
    const { registries, browserFrames } = registriesFor();
    const peer = createPeerChannel({ url: "http://peer:6120", secret: "s", origin: "process-a", fetchImpl });
    const fanout = createRealtimeFanout({ role: "ui", store, registries, peer });

    try {
      store.createTask({ agentId: agent.id, prompt: "forward" });
      const deadline = Date.now() + 2_000;
      while (posts.length === 0 && Date.now() < deadline) await Bun.sleep(10);

      expect(posts).toHaveLength(1);
      expect(posts[0]!.topic).toBe(PEER_REALTIME_TOPIC);
      expect(posts[0]!.events[0]).toMatchObject({ v: 1, origin: "process-a", kind: "task_enqueued" });
      // Local delivery still happened; forwarding is additive.
      expect(browserFrames).toHaveLength(1);
    } finally {
      fanout.close();
    }
  });

  it("does not build or queue an envelope when no peer is configured", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Fanout no peer", provider: "codex" });
    const { registries, browserFrames } = registriesFor();
    const fanout = createRealtimeFanout({ role: "all", store, registries });

    try {
      // The no-peer path must not even attempt serialization: `JSON.stringify`
      // would throw on a cyclic payload, and the store write must not care.
      const cyclic: Record<string, unknown> = { type: "fanout:cyclic", workspaceId: "local", payload: {} };
      cyclic.self = cyclic;
      expect(() => store.emitWorkspaceEvent(cyclic as any)).not.toThrow();
      expect(browserFrames).toHaveLength(1);
      expect(fanout).toBeDefined();
    } finally {
      fanout.close();
    }
  });
});

describe("realtime fanout — two servers over one database", () => {
  interface TwoServers {
    serverA: ReturnType<typeof startMultiremiServer>;
    serverB: ReturnType<typeof startMultiremiServer>;
    storeA: MultiremiStore;
    storeB: MultiremiStore;
    /** POST attempts each process made: `a` = A→B, `b` = B→A. */
    postCounts: { a: number; b: number };
    daemonEvents: { a: DaemonTaskEvent[]; b: DaemonTaskEvent[] };
    /** Simulate the other machine being unreachable, or coming back. */
    setLink(direction: "a" | "b", open: boolean): void;
    cleanup: () => void;
  }

  /**
   * Bring up two API servers on random ports sharing one SQLite file, each with
   * a peer channel pointed at the other. Routing goes straight to each server's
   * port; the nginx split is PR-C's business.
   *
   * `queueLimit` lets a case watch overflow happen without writing 10 000
   * events; the default is the production cap.
   */
  async function startTwoServers(options: {
    queueLimit?: number;
    roles?: { a: LocalRealtimeRole; b: LocalRealtimeRole };
  } = {}): Promise<TwoServers> {
    const directory = mkdtempSync(join(tmpdir(), "multiremi-peer-two-"));
    const databasePath = join(directory, "shared.sqlite");
    const dbA = new Database(databasePath, { create: true });
    const dbB = new Database(databasePath, { create: true });
    const storeA = new MultiremiStore(dbA);
    const storeB = new MultiremiStore(dbB);
    storeA.ensureLocalWorkspace();
    storeB.ensureLocalWorkspace();

    const secret = "peer-secret-under-test";
    const postCounts = { a: 0, b: 0 };
    const daemonEvents = { a: [] as DaemonTaskEvent[], b: [] as DaemonTaskEvent[] };
    const linkOpen = { a: true, b: true };
    // Each server's sender is a real HTTP client to the other server's port,
    // counted so the loop test can prove an inbound event is not re-sent and
    // switchable so a case can take one direction away.
    let serverA: ReturnType<typeof startMultiremiServer> | null = null;
    let serverB: ReturnType<typeof startMultiremiServer> | null = null;
    const peerA = createPeerChannel({
      url: `http://127.0.0.1:0`,
      secret,
      origin: "process-a",
      minBackoffMs: 20,
      maxBackoffMs: 60,
      queueLimit: options.queueLimit,
      fetchImpl: ((url: string, init: RequestInit) => {
        postCounts.a += 1;
        if (!linkOpen.a) return Promise.reject(new Error("peer unreachable"));
        return fetch(url.replace(":0", `:${serverB!.port}`), init);
      }) as PeerFetch,
    });
    const peerB = createPeerChannel({
      url: `http://127.0.0.1:0`,
      secret,
      origin: "process-b",
      minBackoffMs: 20,
      maxBackoffMs: 60,
      queueLimit: options.queueLimit,
      fetchImpl: ((url: string, init: RequestInit) => {
        postCounts.b += 1;
        if (!linkOpen.b) return Promise.reject(new Error("peer unreachable"));
        return fetch(url.replace(":0", `:${serverA!.port}`), init);
      }) as PeerFetch,
    });

    serverA = startMultiremiServer({
      store: storeA,
      scheduler: null,
      port: 0,
      hostname: "127.0.0.1",
      apiRole: options.roles?.a,
      peerChannel: peerA,
      peerSecret: secret,
      createRealtimeFanout: options => createRealtimeFanout({ ...options, onDaemonTask: event => { daemonEvents.a.push(event); } }),
      requestMetrics: {
        enabled: false, slowRequestMs: 500, summaryIntervalMs: 60_000, summaryTopRoutes: 10,
        bufferCapacity: 16, role: options.roles?.a ?? "all",
      },
    });
    serverB = startMultiremiServer({
      store: storeB,
      scheduler: null,
      port: 0,
      hostname: "127.0.0.1",
      apiRole: options.roles?.b,
      peerChannel: peerB,
      peerSecret: secret,
      createRealtimeFanout: options => createRealtimeFanout({ ...options, onDaemonTask: event => { daemonEvents.b.push(event); } }),
      requestMetrics: {
        enabled: false, slowRequestMs: 500, summaryIntervalMs: 60_000, summaryTopRoutes: 10,
        bufferCapacity: 16, role: options.roles?.b ?? "all",
      },
    });

    return {
      serverA,
      serverB,
      storeA,
      storeB,
      postCounts,
      daemonEvents,
      setLink: (direction, open) => { linkOpen[direction] = open; },
      cleanup: () => {
        try { serverA!.stop(true); } catch { /* already stopped */ }
        try { serverB!.stop(true); } catch { /* already stopped */ }
        dbA.close();
        dbB.close();
        rmSync(directory, { recursive: true, force: true });
      },
    };
  }

  /**
   * One server pair for the whole block.
   *
   * Each pair is two full `startMultiremiServer` instances with their own SQLite
   * handle and migration run, and CI's runner is loaded enough that starting a
   * dozen of them pushed individual cases past their own timeouts. Cases that
   * need different limits (queue caps, an unconfigured process) still start their
   * own; everything else shares this one. Each case uses fresh agents, issues and
   * tasks, so nothing leaks between cases.
   */
  let shared: TwoServers | null = null;
  beforeAll(async () => {
    shared = await startTwoServers();
  }, 120_000);
  afterAll(() => {
    shared?.cleanup();
    shared = null;
  });

  /**
   * CI's runner is loaded enough that the WebSocket helpers' 2s default (shared
   * with the rest of the suite) is not always enough for a fresh pair to answer
   * an upgrade. Raising it here keeps the assertion about the fanout, not about
   * how busy the runner was.
   */
  const WS_TIMEOUT_MS = 15_000;
  function openBrowserSocket(port: number | undefined, token: string): WebSocket {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?workspace_slug=local`);
    socket.addEventListener("error", () => {});
    return socket;
  }
  async function authenticateBrowserSocket(socket: WebSocket, token: string): Promise<void> {
    await waitWebSocketOpen(socket, WS_TIMEOUT_MS);
    socket.send(JSON.stringify({ type: "auth", payload: { token } }));
    expect(await nextWebSocketMessage(socket, WS_TIMEOUT_MS)).toMatchObject({ type: "auth_ack" });
  }

  it("delivers a comment created on B to a browser socket on A, 20/20", async () => {
    const two = shared!;
    {
      const { storeA, storeB, serverA, serverB } = two;
      const agent = storeA.createAgent({ name: "Peer comment agent", provider: "codex" });
      const issue = storeA.createIssue({ title: "Peer comment issue", createdBy: "local" });
      const token = await storeA.createAccessToken({ name: "Peer browser", type: "pat", workspaceId: "local" });

      const socket = openBrowserSocket(serverA.port, token.token);
      await authenticateBrowserSocket(socket, token.token);

      try {
        const received = new Set<string>();
        const frames: any[] = [];
        socket.addEventListener("message", (event) => {
          const frame = JSON.parse(String(event.data));
          if (frame.type !== "comment:created") return;
          frames.push(frame);
          received.add(frame.payload.comment.id);
        });

        // The setup writes above were A's own, so A→B has already posted. What
        // matters is that the 20 inbound events produce no further A→B POSTs:
        // that is the loop guard.
        const aPostsBefore = two.postCounts.a;
        const bPostsBefore = two.postCounts.b;

        for (let index = 0; index < 20; index += 1) {
          // Written on B; the browser socket is on A, so every one of these has
          // to cross the peer channel to arrive at all.
          storeB.createIssueComment(issue.id, {
            body: `peer comment ${index}`,
            authorType: "agent",
            authorId: agent.id,
          });
        }

        const deadline = Date.now() + 15_000;
        while (received.size < 20 && Date.now() < deadline) await Bun.sleep(20);
        expect(received.size).toBe(20);
        expect(frames.every((frame) => frame.payload.comment.issue_id === issue.id
          || frame.payload.comment.issueId === issue.id)).toBe(true);
        expect(two.postCounts.b).toBeGreaterThan(bPostsBefore);
        // A delivered every one of them locally and re-sent none of them.
        expect(two.postCounts.a).toBe(aPostsBefore);
      } finally {
        socket.close();
      }

    }
  });

  it("routes decision HTTP to runtime and fans decision events to the ui socket once", async () => {
    const two = await startTwoServers({ roles: { a: "ui", b: "runtime" } });
    const encryptionKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
    const larkAppId = process.env.MULTIREMI_LARK_APP_ID;
    const larkAppSecret = process.env.MULTIREMI_LARK_APP_SECRET;
    process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 29).toString("base64");
    process.env.MULTIREMI_LARK_APP_ID = "cli_peer_decision";
    process.env.MULTIREMI_LARK_APP_SECRET = "peer-decision-secret";
    try {
      const { storeA, serverA, serverB } = two;
      const user = storeA.getOrCreateUser({
        externalId: "ou_peer_decision",
        name: "Peer decision member",
        email: "peer-decision@example.test",
      });
      storeA.createWorkspaceMember({
        workspaceId: "local",
        userId: user.id,
        name: "Peer decision member",
        email: "peer-decision@example.test",
        role: "member",
      });
      const agent = storeA.createAgent({ name: "Peer decision agent", provider: "codex", workspaceId: "local" });
      storeA.registerRuntime({
        id: "rt_peer_decision",
        name: "Peer decision bot host",
        provider: "codex",
        workspaceId: "local",
        daemonId: "peer-decision-host",
      });
      storeA.heartbeatRuntime("rt_peer_decision", {
        supportsFeishuBotConfig: true,
        supportsIssueDecisionCard: true,
      });
      const config = storeA.upsertFeishuBotConfig("local", {
        agentId: agent.id,
        runtimeId: "rt_peer_decision",
        appId: "cli_peer_decision",
        appSecretOp: "set",
        appSecret: "peer-decision-secret",
        domain: "feishu",
        enabled: true,
      });
      storeA.reportFeishuBotRuntimeStatus("local", "rt_peer_decision", {
        appliedRevision: config.revision,
        state: "online",
      });
      const workspace = storeA.getWorkspace("local")!;
      storeA.updateWorkspace("local", {
        settings: {
          ...workspace.settings,
          issueTopics: { enabled: true, chatId: "oc_peer_decision", notifyMode: "person", notifyOpenId: "ou_peer_decision" },
        },
      });
      const issue = storeA.createIssue({ title: "Peer decision issue", workspaceId: "local" });
      storeA.prepareFeishuIssueTopicWithinTransaction(issue);
      const root = storeA.claimFeishuBotOutbound("local", "rt_peer_decision")!;
      storeA.reportFeishuBotOutbound("local", "rt_peer_decision", root.id, {
        claimToken: root.claimToken,
        status: "sent",
        externalMessageId: "om_peer_decision_root",
      });
      const browserToken = await storeA.createAccessToken({
        name: "Peer decision browser",
        type: "pat",
        workspaceId: "local",
        userId: user.id,
      });
      const daemonToken = await storeA.createAccessToken({
        name: "Peer decision bot host",
        type: "daemon",
        workspaceId: "local",
        daemonId: "peer-decision-host",
      });
      const socket = openBrowserSocket(serverA.port, browserToken.token);
      await authenticateBrowserSocket(socket, browserToken.token);
      const frames: any[] = [];
      socket.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data));
        if (frame.type === "decision:created" || frame.type === "decision:updated") frames.push(frame);
      });

      try {
        const uiBase = `http://127.0.0.1:${serverA.port}`;
        const runtimeBase = `http://127.0.0.1:${serverB.port}`;
        await Bun.sleep(100);
        const postsBeforeCreate = { ...two.postCounts };
        const createdResponse = await fetch(`${uiBase}/api/issues/${issue.id}/decisions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${browserToken.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "production_change", title: "Ship through the peer?" }),
        });
        expect(createdResponse.status, await createdResponse.clone().text()).toBe(201);
        const created = (await createdResponse.json() as any).decision;
        const createDeadline = Date.now() + WS_TIMEOUT_MS;
        while ((!frames.some((frame) => frame.type === "decision:created")
          || two.postCounts.a === postsBeforeCreate.a) && Date.now() < createDeadline) {
          await Bun.sleep(20);
        }
        expect(frames.filter((frame) => frame.type === "decision:created" && frame.payload.decision.id === created.id)).toHaveLength(1);
        expect(two.postCounts.a).toBeGreaterThan(postsBeforeCreate.a);
        expect(two.postCounts.b).toBe(postsBeforeCreate.b);

        const card = storeA.claimFeishuBotOutbound("local", "rt_peer_decision")!;
        storeA.reportFeishuBotOutbound("local", "rt_peer_decision", card.id, {
          claimToken: card.claimToken,
          status: "sent",
          externalMessageId: "om_peer_decision_card",
          interactionOpenId: "ou_peer_decision",
        });
        const readPath = `/api/daemon/issues/${issue.id}/decisions/${created.id}`;
        expect((await fetch(`${uiBase}${readPath}`, {
          headers: { Authorization: `Bearer ${daemonToken.token}` },
        })).status).toBe(421);
        expect((await fetch(`${runtimeBase}${readPath}`, {
          headers: { Authorization: `Bearer ${daemonToken.token}` },
        })).status).toBe(200);

        const postsBeforeAnswer = { ...two.postCounts };
        const daemon = new MultiremiDaemonClient(runtimeBase, daemonToken.token);
        const answered = await daemon.answerFeishuIssueDecision(issue.id, created.id, {
          answer: "yes",
          operatorOpenId: "ou_peer_decision",
        });
        expect(answered.status).toBe("answered");
        const answerDeadline = Date.now() + WS_TIMEOUT_MS;
        while (!frames.some((frame) => frame.type === "decision:updated") && Date.now() < answerDeadline) {
          await Bun.sleep(20);
        }
        await Bun.sleep(100);
        expect(frames.filter((frame) => frame.type === "decision:updated" && frame.payload.decision.id === created.id)).toHaveLength(1);
        expect(two.postCounts.b).toBeGreaterThan(postsBeforeAnswer.b);
        expect(two.postCounts.a).toBe(postsBeforeAnswer.a);
      } finally {
        socket.close();
      }
    } finally {
      two.cleanup();
      if (encryptionKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
      else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = encryptionKey;
      if (larkAppId === undefined) delete process.env.MULTIREMI_LARK_APP_ID;
      else process.env.MULTIREMI_LARK_APP_ID = larkAppId;
      if (larkAppSecret === undefined) delete process.env.MULTIREMI_LARK_APP_SECRET;
      else process.env.MULTIREMI_LARK_APP_SECRET = larkAppSecret;
    }
  }, 60_000);

  it("makes a task created on A visible on B without a v1 wakeup socket", async () => {
    const two = shared!;
    {
      const { storeA, storeB, serverB } = two;
      const runtime = storeA.registerRuntime({ id: "rt_peer_wakeup", name: "Peer runtime", provider: "codex" });
      const agent = storeA.createAgent({ name: "Peer wakeup agent", provider: "codex", runtimeId: runtime.id });

      const refused = await fetch(`http://127.0.0.1:${serverB.port}/api/daemon/ws?runtime_ids=${runtime.id}`, {
        headers: { Upgrade: "websocket", Connection: "Upgrade" },
      });
      expect(refused.status).toBe(426);
      expect(await refused.json()).toMatchObject({ code: "daemon_protocol_upgrade_required" });
      const task = storeA.createTask({ agentId: agent.id, prompt: "visible to daemon v2", runtimeId: runtime.id });
      expect(storeB.getTask(task.id)).toMatchObject({ id: task.id, status: "queued", runtimeId: runtime.id });
    }
  });

  it("answers /internal/peer/health on both sides and 401s a bad secret", async () => {
    const two = shared!;
    {
      const { serverA, serverB } = two;
      const healthA = await fetch(`http://127.0.0.1:${serverA.port}/internal/peer/health`);
      const bodyA = (await healthA.json()) as any;
      expect(bodyA).toMatchObject({ ok: true, enabled: true });
      expect(await (await fetch(`http://127.0.0.1:${serverB.port}/internal/peer/health`)).json())
        .toMatchObject({ ok: true, enabled: true });

      const emptyBatch = JSON.stringify({ topic: "realtime", epoch: "process-b", batch_seq: 1, events: [] });
      const noSecret = await fetch(`http://127.0.0.1:${serverA.port}/internal/peer/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: emptyBatch,
      });
      expect(noSecret.status).toBe(401);

      const wrongSecret = await fetch(`http://127.0.0.1:${serverA.port}/internal/peer/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer not-the-secret" },
        body: emptyBatch,
      });
      expect(wrongSecret.status).toBe(401);

      // A fresh epoch, because this block shares one server pair: reusing an
      // epoch/batch number an earlier case already delivered is answered
      // `duplicate` by design, which is not what this case is testing.
      const rightSecret = await fetch(`http://127.0.0.1:${serverA.port}/internal/peer/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer peer-secret-under-test" },
        body: JSON.stringify({
          topic: "realtime",
          epoch: "health-check-probe",
          batch_seq: 1,
          events: [{ v: 1, origin: "health-check-probe", kind: "workspace_event", payload: { event: { type: "x", workspaceId: "local", payload: {} } } }],
        }),
      });
      expect(rightSecret.status).toBe(200);
      expect(await rightSecret.json()).toMatchObject({ ok: true, accepted: 1, rejected: 0 });
    }
  });

  it("delivers 100 workspace invalidations in order across the channel", async () => {
    const two = shared!;
    {
      const { storeA, storeB, serverA } = two;
      const token = await storeA.createAccessToken({ name: "Peer order browser", type: "pat", workspaceId: "local" });

      const socket = openBrowserSocket(serverA.port, token.token);
      await authenticateBrowserSocket(socket, token.token);
      try {
        const seqs: number[] = [];
        socket.addEventListener("message", (event) => {
          const frame = JSON.parse(String(event.data));
          if (frame.type === "issue:updated") seqs.push(frame.payload.seq);
        });
        for (let seq = 1; seq <= 100; seq += 1) {
          storeB.emitWorkspaceEvent({ type: "issue:updated", workspaceId: "local", payload: { seq } });
        }

        const deadline = Date.now() + 20_000;
        while (seqs.length < 100 && Date.now() < deadline) await Bun.sleep(20);
        expect(seqs).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
      } finally {
        socket.close();
      }
    }
  });

  it("keeps single-process behaviour when MULTIREMI_PEER_URL is unset", async () => {
    // Acceptance item 1: with no peer URL there is no sender and no subscriber,
    // the health route says so, and a local write still reaches a local socket.
    const directory = mkdtempSync(join(tmpdir(), "multiremi-peer-off-"));
    const database = new Database(join(directory, "single.sqlite"), { create: true });
    const store = new MultiremiStore(database);
    store.ensureLocalWorkspace();
    const server = startMultiremiServer({
      store, scheduler: null, port: 0, hostname: "127.0.0.1",
      apiRoleConfiguration: { role: "all", configured: false },
    });
    try {
      // QA item 2: with nothing configured this body must be exactly what main
      // returned, key set included — no `role`, no `peer_healthy`.
      const health = (await (await fetch(`http://127.0.0.1:${server.port}/health/realtime`)).json()) as any;
      expect(Object.keys(health).sort()).toEqual(["connections", "enabled", "transport"]);
      expect(health).toEqual({ connections: 0, enabled: true, transport: "websocket" });

      const peerHealth = (await (await fetch(`http://127.0.0.1:${server.port}/internal/peer/health`)).json()) as any;
      expect(peerHealth).toMatchObject({ ok: true, enabled: false, peer_healthy: false });

      // QA item 1: with no peer, every credential shape gets the same 401. A
      // caller must not be able to read this process's configuration off the
      // status code.
      const bodies = new Set<string>();
      for (const authorization of [undefined, "Bearer ", "Bearer multi", "Bearer wrong-secret"]) {
        const post = await fetch(`http://127.0.0.1:${server.port}/internal/peer/events`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(authorization ? { Authorization: authorization } : {}),
          },
          body: JSON.stringify({ topic: "realtime", epoch: "e", batch_seq: 1, events: [] }),
        });
        expect(post.status).toBe(401);
        bodies.add(await post.text());
      }
      expect(bodies.size).toBe(1);

      const agent = store.createAgent({ name: "Peer off agent", provider: "codex" });
      const runtime = store.registerRuntime({ id: "rt_peer_off", name: "Peer off runtime", provider: "codex" });
      const token = await store.createAccessToken({ name: "Peer off browser", type: "pat", workspaceId: "local" });
      const socket = openBrowserSocket(server.port, token.token);
      await authenticateBrowserSocket(socket, token.token);
      try {
        const frame = nextWebSocketMessage(socket, WS_TIMEOUT_MS);
        const task = store.createTask({ agentId: agent.id, prompt: "still local", runtimeId: runtime.id });
        expect(await frame).toMatchObject({ type: "task:queued", payload: { task_id: task.id } });
      } finally {
        socket.close();
      }
    } finally {
      server.stop(true);
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps the main flow moving while the peer is unreachable, drops the oldest, and catches up", async () => {
    // A tiny queue so overflow is reachable here; the accounting is the same one
    // the peer-channel unit cases pin at the real 10 000 cap.
    const two = await startTwoServers({ queueLimit: 10 });
    try {
      const { storeA, storeB, serverA } = two;
      const token = await storeA.createAccessToken({ name: "Peer down browser", type: "pat", workspaceId: "local" });

      const socket = openBrowserSocket(serverA.port, token.token);
      await authenticateBrowserSocket(socket, token.token);
      try {
        const received: number[] = [];
        socket.addEventListener("message", (event) => {
          const frame = JSON.parse(String(event.data));
          if (frame.type === "issue:updated") received.push(frame.payload.seq);
        });
        // B can no longer reach A. Every write below is therefore a write whose
        // realtime delivery fails; none of them may slow the caller down.
        two.setLink("b", false);
        const writeMs: number[] = [];
        for (let seq = 1; seq <= 40; seq += 1) {
          const startedAt = performance.now();
          storeB.emitWorkspaceEvent({ type: "issue:updated", workspaceId: "local", payload: { seq } });
          writeMs.push(performance.now() - startedAt);
        }
        expect(Math.max(...writeMs)).toBeLessThan(250);

        // Wait for a failed attempt to be recorded, then read the counters off
        // the real health route rather than out of the test's own objects.
        const deadline = Date.now() + 10_000;
        let health: any = null;
        while (Date.now() < deadline) {
          health = await (await fetch(`http://127.0.0.1:${two.serverB.port}/internal/peer/health`)).json();
          if (health.failed > 0 && health.dropped > 0) break;
          await Bun.sleep(20);
        }
        expect(health).toMatchObject({ ok: true, enabled: true });
        expect(health.failed).toBeGreaterThan(0);
        expect(health.dropped).toBeGreaterThan(0);
        expect(received).toHaveLength(0);

        const healthRealtime = (await (await fetch(`http://127.0.0.1:${two.serverB.port}/health/realtime`)).json()) as any;
        // A configured split does report the two additive fields.
        expect(healthRealtime).toMatchObject({ role: "all", peer_healthy: false });

        // Bring the peer back: the surviving queue drains and delivery resumes.
        two.setLink("b", true);
        const resumeDeadline = Date.now() + 10_000;
        while (received.length === 0 && Date.now() < resumeDeadline) await Bun.sleep(20);
        expect(received.length).toBeGreaterThan(0);
        // What did arrive is still ordered.
        expect([...received]).toEqual([...received].sort((left, right) => left - right));
      } finally {
        socket.close();
      }
    } finally {
      two.cleanup();
    }
  });
});

describe("realtime fanout — dedupe and guards", () => {
  /**
   * QA item 6: the receiver handles a batch, the response is lost, the sender
   * retries. Before dedupe the browser got two invalidations; the raw WS
   * frames are what the browser sees, so the assertion is on those, not on the
   * client cache (which dedupes by seq and would hide the protocol bug).
   */
  it("does not re-deliver a batch whose ACK was lost", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Dedupe agent", provider: "codex" });
    store.createTask({ agentId: agent.id, prompt: "dedupe" });
    const { registries, browserFrames } = registriesFor();

    let posts = 0;
    // First POST is delivered and then reported as failed: exactly an ACK lost on
    // the way back. The second POST is the sender's retry.
    const fetchImpl: PeerFetch = async (_url, init) => {
      posts += 1;
      await receiverPeer.receive(...bodyParts(init));
      if (posts === 1) throw new Error("response lost");
      return new Response(JSON.stringify({ ok: true, accepted: 1, rejected: 0 }), { status: 200 });
    };

    const receiverPeer = createPeerChannel({
      url: "http://peer:6120",
      secret: "s",
      origin: "process-a",
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });
    // The fanout owns the peer subscription itself; nothing here subscribes a
    // second time, or every inbound event would be delivered twice and the frame
    // count could not distinguish that from a failed dedupe.
    const fanout = createRealtimeFanout({ role: "ui", store, registries, peer: receiverPeer });

    const sender = createPeerChannel({
      url: "http://peer:6120",
      secret: "s",
      origin: "process-b",
      minBackoffMs: 10,
      maxBackoffMs: 20,
      fetchImpl,
    });

    function bodyParts(init: RequestInit): [string, unknown[], { epoch: string; batchSeq: number }] {
      const parsed = JSON.parse(String(init.body)) as { topic: string; epoch: string; batch_seq: number; events: unknown[] };
      return [parsed.topic, parsed.events, { epoch: parsed.epoch, batchSeq: parsed.batch_seq }];
    }

    try {
      sender.forwardRealtime("workspace_event", { event: {
        type: "issue:updated", workspaceId: "local", payload: { issue_id: "issue-dedupe" },
      } });

      const deadline = Date.now() + 5_000;
      while (sender.stats().batches < 1 && Date.now() < deadline) await Bun.sleep(10);
      // Wait for the retry to be answered, then let a late duplicate land if any.
      await Bun.sleep(150);

      const frames = browserFrames.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === "issue:updated");
      expect(frames.map((frame) => frame.payload.issue_id)).toEqual(["issue-dedupe"]);
      expect(posts).toBeGreaterThanOrEqual(2);
      expect(receiverPeer.stats().duplicates).toBe(1);
      expect(receiverPeer.stats().received).toBe(1);
      expect(peerMetricsSnapshot().duplicates).toBeGreaterThanOrEqual(1);
      // The sender's own accounting agrees: one delivery, one duplicate answer.
      expect(sender.stats().sent).toBe(1);
    } finally {
      sender.close();
      fanout.close();
    }
  });

  it("keeps the dashboard auth boundary for an /internal route that is not the peer pair", async () => {
    // QA item 3: the exemption is two exact paths, so a future `/internal/...`
    // route without its own guard must still meet dashboard auth.
    const store = createStore();
    const token = "dashboard-token";
    store.ensureLocalWorkspace();
    const app = createMultiremiApp({ store, authToken: token });
    app.get("/internal/other", (c) => c.json({ ok: true }));

    const denied = await app.request("/internal/other");
    expect(denied.status).toBe(401);

    const deniedForPeerCredential = await app.request("/internal/other", {
      headers: { Authorization: "Bearer peer-secret" },
    });
    expect(deniedForPeerCredential.status).toBe(401);

    const allowed = await app.request("/internal/other", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(allowed.status).toBe(200);

    // And the two peer paths themselves are reachable without dashboard auth:
    // they answer on their own terms (401 for a missing peer secret, 200 for
    // health), not 401-from-the-middleware.
    const peerHealth = await app.request("/internal/peer/health");
    expect(peerHealth.status).toBe(200);
    const peerEvents = await app.request("/internal/peer/events", { method: "POST", body: "{}" });
    expect(peerEvents.status).toBe(401);
  });
});
