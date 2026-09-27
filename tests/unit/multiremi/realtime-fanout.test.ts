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
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultiremiStore } from "@multiremi/store.js";
import { startMultiremiServer } from "@multiremi/api.js";
import { createPeerChannel, PEER_REALTIME_TOPIC, type PeerChannel, type PeerFetch } from "../../../packages/server/src/api/peer/peer-channel.js";
import {
  notifyBrowserTaskEvent,
  notifyBrowserTaskMessages,
  notifyBrowserWorkspaceEvent,
  notifyDaemonTaskAvailable,
  notifyDaemonTaskEvent,
} from "../../../packages/server/src/api/realtime.js";
import {
  createRealtimeFanout,
  type LocalRealtimeRole,
} from "../../../packages/server/src/api/realtime-fanout.js";
import type { DaemonWebSocketRegistry } from "../../../packages/server/src/api/helpers/realtime-types.js";
import { authenticateBrowserWebSocket, createStore, nextWebSocketMessage, resetMultiremiTestEnv, waitWebSocketOpen } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

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
      scopeSubscriptions: [] as string[],
    },
    sendText: (frame: string) => frames.push(frame),
    close: () => {},
  };
}

/** A daemon-registry client keyed by runtime. */
function fakeDaemonClient(frames: string[], runtimeId: string) {
  return {
    data: {
      kind: "daemon" as const,
      connectedAt: new Date().toISOString(),
      runtimeId,
      runtimeIds: [runtimeId],
      accessToken: null,
      canReportAgentPluginProtocol: true,
    },
    sendText: (frame: string) => frames.push(frame),
    close: () => {},
  };
}

function registriesFor(workspaceId = "local") {
  const browserFrames: string[] = [];
  const userFrames: string[] = [];
  const scopeFrames: string[] = [];
  const daemonFrames: string[] = [];
  const browserClient = fakeBrowserClient(browserFrames, { workspaceId });
  const daemonClient = fakeDaemonClient(daemonFrames, "rt_fanout");
  return {
    browserFrames,
    daemonFrames,
    registries: {
      daemon: new Map([["rt_fanout", new Set([daemonClient])]]) as DaemonWebSocketRegistry,
      browser: new Map([[workspaceId, new Set([browserClient])]]) as any,
      browserUser: new Map([["local", new Set([fakeBrowserClient(userFrames)])]]) as any,
      browserScope: new Map() as any,
    },
  };
}

describe("realtime fanout — role routing", () => {
  it("delivers both sides when the process is `all`", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Fanout agent", provider: "codex" });
    const runtime = store.registerRuntime({ id: "rt_fanout", name: "Fanout runtime", provider: "codex" });
    const { registries, browserFrames, daemonFrames } = registriesFor();
    const fanout = createRealtimeFanout({ role: "all", store, registries });

    try {
      const task = store.createTask({ agentId: agent.id, prompt: "fanout", runtimeId: runtime.id });
      expect(JSON.parse(browserFrames[0]!)).toMatchObject({ type: "task:queued", payload: { task_id: task.id } });
      expect(JSON.parse(daemonFrames[0]!)).toMatchObject({
        type: "daemon:task_available",
        payload: { runtime_id: runtime.id, task_id: task.id },
      });
    } finally {
      fanout.close();
    }
  });

  it("keeps a `ui` process off the daemon registry and a `runtime` process off the browser one", () => {
    for (const [role, expectBrowser, expectDaemon] of [
      ["ui", 1, 0],
      ["runtime", 0, 1],
    ] as Array<[LocalRealtimeRole, number, number]>) {
      const store = createStore();
      const agent = store.createAgent({ name: `Fanout ${role}`, provider: "codex" });
      const runtime = store.registerRuntime({ id: "rt_fanout", name: "Fanout runtime", provider: "codex" });
      const { registries, browserFrames, daemonFrames } = registriesFor();
      const fanout = createRealtimeFanout({ role, store, registries });
      try {
        store.createTask({ agentId: agent.id, prompt: "fanout", runtimeId: runtime.id });
        expect(browserFrames, role).toHaveLength(expectBrowser);
        expect(daemonFrames, role).toHaveLength(expectDaemon);
      } finally {
        fanout.close();
      }
    }
  });

  it("routes a peer-delivered task_enqueued to the daemon registry of a `runtime` process", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Fanout remote", provider: "codex" });
    const runtime = store.registerRuntime({ id: "rt_fanout", name: "Fanout runtime", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, prompt: "remote", runtimeId: runtime.id });
    const { registries, browserFrames, daemonFrames } = registriesFor();
    const fanout = createRealtimeFanout({ role: "runtime", store, registries });

    try {
      // What the peer would have POSTed. A `runtime` process must wake the
      // daemon for a task created in the browser-facing one.
      fanout.deliverRemote({
        v: 1,
        origin: "process-ui",
        kind: "task_enqueued",
        payload: { task },
      });
      expect(browserFrames).toHaveLength(0);
      expect(JSON.parse(daemonFrames[0]!)).toMatchObject({
        type: "daemon:task_available",
        payload: { runtime_id: runtime.id, task_id: task.id },
      });
    } finally {
      fanout.close();
    }
  });

  it("delivers a peer task_messages event to the browser registries of a `ui` process", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Fanout messages", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, prompt: "messages" });
    store.appendTaskMessages(task.id, [{ type: "assistant", content: "hello" }]);
    const messages = store.listTaskMessages(task.id);
    const { registries, browserFrames, daemonFrames } = registriesFor();
    const fanout = createRealtimeFanout({ role: "ui", store, registries });

    try {
      fanout.deliverRemote({
        v: 1,
        origin: "process-runtime",
        kind: "task_messages",
        payload: { task: store.getTask(task.id)!, messages },
      });
      expect(daemonFrames).toHaveLength(0);
      expect(JSON.parse(browserFrames[0]!)).toMatchObject({ type: "task:message", payload: { seq: 1 } });
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
  async function startTwoServers(options: { queueLimit?: number } = {}): Promise<TwoServers> {
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
      peerChannel: peerA,
      peerSecret: secret,
      requestMetrics: { enabled: false, slowRequestMs: 500, summaryIntervalMs: 60_000, summaryTopRoutes: 10, bufferCapacity: 16 },
    });
    serverB = startMultiremiServer({
      store: storeB,
      scheduler: null,
      port: 0,
      hostname: "127.0.0.1",
      peerChannel: peerB,
      peerSecret: secret,
      requestMetrics: { enabled: false, slowRequestMs: 500, summaryIntervalMs: 60_000, summaryTopRoutes: 10, bufferCapacity: 16 },
    });

    return {
      serverA,
      serverB,
      storeA,
      storeB,
      postCounts,
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

  it("delivers a comment created on B to a browser socket on A, 20/20", async () => {
    const two = await startTwoServers();
    try {
      const { storeA, storeB, serverA, serverB } = two;
      const agent = storeA.createAgent({ name: "Peer comment agent", provider: "codex" });
      const issue = storeA.createIssue({ title: "Peer comment issue", createdBy: "local" });
      const token = await storeA.createAccessToken({ name: "Peer browser", type: "pat", workspaceId: "local" });

      const socket = new WebSocket(`ws://127.0.0.1:${serverA.port}/ws?workspace_slug=local`);
      await authenticateBrowserWebSocket(socket, token.token);

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

    } finally {
      two.cleanup();
    }
  });

  it("wakes a daemon socket on B for a task created on A", async () => {
    const two = await startTwoServers();
    try {
      const { storeA, storeB, serverA, serverB } = two;
      const runtime = storeA.registerRuntime({ id: "rt_peer_wakeup", name: "Peer runtime", provider: "codex" });
      const agent = storeA.createAgent({ name: "Peer wakeup agent", provider: "codex", runtimeId: runtime.id });

      // The daemon socket lives on B — the process that did not write the task.
      const daemonSocket = new WebSocket(`ws://127.0.0.1:${serverB.port}/api/daemon/ws?runtime_ids=${runtime.id}`);
      const ready = await nextWebSocketMessage(daemonSocket);
      expect(ready).toMatchObject({ type: "ready", runtime_id: runtime.id });

      try {
        const wakeup = nextWebSocketMessage(daemonSocket);
        const task = storeA.createTask({ agentId: agent.id, prompt: "wake the far side", runtimeId: runtime.id });
        expect(await wakeup).toMatchObject({
          type: "daemon:task_available",
          payload: { runtime_id: runtime.id, task_id: task.id },
        });
      } finally {
        daemonSocket.close();
      }
    } finally {
      two.cleanup();
    }
  });

  it("delivers task messages appended on B to A's task-scope subscription", async () => {
    const two = await startTwoServers();
    try {
      const { storeA, storeB, serverA } = two;
      const agent = storeA.createAgent({ name: "Peer messages agent", provider: "codex" });
      const task = storeA.createTask({ agentId: agent.id, prompt: "peer messages" });
      const token = await storeA.createAccessToken({ name: "Peer scope", type: "pat", workspaceId: "local" });

      const socket = new WebSocket(`ws://127.0.0.1:${serverA.port}/ws?workspace_slug=local`);
      await authenticateBrowserWebSocket(socket, token.token);
      try {
        socket.send(JSON.stringify({ type: "subscribe", payload: { scope: "task", id: task.id } }));
        expect(await nextWebSocketMessage(socket)).toEqual({
          type: "subscribe_ack",
          payload: { scope: "task", id: task.id },
        });

        const frame = nextWebSocketMessage(socket);
        storeB.appendTaskMessages(task.id, [{ type: "assistant", content: "crossed the channel" }]);
        expect(await frame).toMatchObject({
          type: "task:message",
          payload: { task_id: task.id, seq: 1, content: "crossed the channel" },
        });
      } finally {
        socket.close();
      }
    } finally {
      two.cleanup();
    }
  });

  it("answers /internal/peer/health on both sides and 401s a bad secret", async () => {
    const two = await startTwoServers();
    try {
      const { serverA, serverB } = two;
      const healthA = await fetch(`http://127.0.0.1:${serverA.port}/internal/peer/health`);
      const bodyA = (await healthA.json()) as any;
      expect(bodyA).toMatchObject({ ok: true, enabled: true });
      expect(await (await fetch(`http://127.0.0.1:${serverB.port}/internal/peer/health`)).json())
        .toMatchObject({ ok: true, enabled: true });

      const noSecret = await fetch(`http://127.0.0.1:${serverA.port}/internal/peer/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: "realtime", events: [] }),
      });
      expect(noSecret.status).toBe(401);

      const wrongSecret = await fetch(`http://127.0.0.1:${serverA.port}/internal/peer/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer not-the-secret" },
        body: JSON.stringify({ topic: "realtime", events: [] }),
      });
      expect(wrongSecret.status).toBe(401);

      const rightSecret = await fetch(`http://127.0.0.1:${serverA.port}/internal/peer/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer peer-secret-under-test" },
        body: JSON.stringify({
          topic: "realtime",
          events: [{ v: 1, origin: "process-b", kind: "workspace_event", payload: { event: { type: "x", workspaceId: "local", payload: {} } } }],
        }),
      });
      expect(rightSecret.status).toBe(200);
      expect(await rightSecret.json()).toMatchObject({ ok: true, accepted: 1, rejected: 0 });
    } finally {
      two.cleanup();
    }
  });

  it("delivers one task's 100 messages in seq order across the channel", async () => {
    const two = await startTwoServers();
    try {
      const { storeA, storeB, serverA } = two;
      const agent = storeA.createAgent({ name: "Peer order agent", provider: "codex" });
      const task = storeA.createTask({ agentId: agent.id, prompt: "peer order" });
      const token = await storeA.createAccessToken({ name: "Peer order scope", type: "pat", workspaceId: "local" });

      const socket = new WebSocket(`ws://127.0.0.1:${serverA.port}/ws?workspace_slug=local`);
      await authenticateBrowserWebSocket(socket, token.token);
      try {
        const seqs: number[] = [];
        socket.addEventListener("message", (event) => {
          const frame = JSON.parse(String(event.data));
          if (frame.type === "task:message") seqs.push(frame.payload.seq);
        });
        socket.send(JSON.stringify({ type: "subscribe", payload: { scope: "task", id: task.id } }));
        await nextWebSocketMessage(socket);

        for (let seq = 1; seq <= 100; seq += 1) {
          storeB.appendTaskMessages(task.id, [{ seq, type: "assistant", content: `message ${seq}` }]);
        }

        const deadline = Date.now() + 20_000;
        while (seqs.length < 100 && Date.now() < deadline) await Bun.sleep(20);
        expect(seqs).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
      } finally {
        socket.close();
      }
    } finally {
      two.cleanup();
    }
  });

  it("keeps the main flow moving while the peer is unreachable, drops the oldest, and catches up", async () => {
    // A tiny queue so overflow is reachable here; the accounting is the same one
    // the peer-channel unit cases pin at the real 10 000 cap.
    const two = await startTwoServers({ queueLimit: 10 });
    try {
      const { storeA, storeB, serverA } = two;
      const agent = storeA.createAgent({ name: "Peer down agent", provider: "codex" });
      const task = storeA.createTask({ agentId: agent.id, prompt: "peer down" });
      const token = await storeA.createAccessToken({ name: "Peer down scope", type: "pat", workspaceId: "local" });

      const socket = new WebSocket(`ws://127.0.0.1:${serverA.port}/ws?workspace_slug=local`);
      await authenticateBrowserWebSocket(socket, token.token);
      try {
        const received: number[] = [];
        socket.addEventListener("message", (event) => {
          const frame = JSON.parse(String(event.data));
          if (frame.type === "task:message") received.push(frame.payload.seq);
        });
        socket.send(JSON.stringify({ type: "subscribe", payload: { scope: "task", id: task.id } }));
        await nextWebSocketMessage(socket);

        // B can no longer reach A. Every write below is therefore a write whose
        // realtime delivery fails; none of them may slow the caller down.
        two.setLink("b", false);
        const writeMs: number[] = [];
        for (let seq = 1; seq <= 40; seq += 1) {
          const startedAt = performance.now();
          storeB.appendTaskMessages(task.id, [{ seq, type: "assistant", content: `queued ${seq}` }]);
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
        expect(healthRealtime.peer_healthy).toBe(false);

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
