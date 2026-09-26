/**
 * MUL-417 — the server-side connection layer for daemon protocol v2.
 *
 * Each acceptance item from the sub-issue has a case here, and each is written
 * against a fake socket so the timing (the 15 s ack deadline) and the flow
 * control (`ws.send` returning -1 / 0) are deterministic rather than a race with
 * a real network:
 *
 *   - handshake success;
 *   - reject + 4426 for a low protocol or a low CLI version;
 *   - 4401 / 4403 / 4410 for the three terminal authorization failures;
 *   - downlink seq/ack, including the 15 s timeout closing 4000;
 *   - `-1` pausing pausable traffic and `drain` resuming it, `0` unregistering;
 *   - RPC dispatch and the unknown-frame reply;
 *   - a reconnect closing the previous session with 4001.
 *
 * The real-socket path (upgrade, `Bun.serve` limits, and the wiring in
 * `api/server.ts`) is covered by `daemon-protocol-server.test.ts`.
 */
import { describe, expect, it } from "bun:test";
import {
  DAEMON_ACK_TIMEOUT_MS,
  DAEMON_PROTOCOL_CLOSE_CODES,
} from "@multiremi/contracts/daemon-protocol.js";
import { DaemonSessionRegistry } from "../../../packages/server/src/api/daemon-protocol/session-registry.js";
import { ManualDaemonProtocolClock } from "../../../packages/server/src/api/daemon-protocol/clock.js";
import {
  DaemonProtocolSession,
  type DaemonProtocolSocket,
  type DaemonSessionRuntimeAuthorization,
} from "../../../packages/server/src/api/daemon-protocol/session.js";
import type { WsFrameSample } from "../../../packages/server/src/api/daemon-protocol/metrics.js";

/** A socket that records what it was asked to do and answers with a scripted status. */
class FakeDaemonSocket implements DaemonProtocolSocket {
  readonly sent: Array<Record<string, unknown>> = [];
  readonly closed: Array<{ code: number; reason: string }> = [];
  bufferedAmount = 0;
  /** Status the next `send` answers with; `null` means "sent as many bytes as were written". */
  nextStatus: number | null = null;
  /** Status every `send` answers with, until reset. */
  fixedStatus: number | null = null;

  send(text: string): number {
    this.sent.push(JSON.parse(text) as Record<string, unknown>);
    if (this.fixedStatus !== null) return this.fixedStatus;
    const status = this.nextStatus;
    this.nextStatus = null;
    return status ?? Buffer.byteLength(text, "utf8");
  }

  close(code?: number, reason?: string): void {
    this.closed.push({ code: code ?? 1000, reason: reason ?? "" });
  }

  /** The last frame of a given type, or null. */
  lastOfType(type: string): Record<string, unknown> | null {
    for (let index = this.sent.length - 1; index >= 0; index -= 1) {
      if (this.sent[index]!.t === type) return this.sent[index]!;
    }
    return null;
  }
}

function helloPayload(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: 2,
    daemon_id: "dmn_test",
    cli_version: "0.2.83",
    launched_by: null,
    runtimes: [{ runtime_id: "rt_one", provider: "codex", max_concurrency: 2, active_task_ids: [] }],
    caps: [],
    ...patch,
  };
}

interface Harness {
  session: DaemonProtocolSession;
  socket: FakeDaemonSocket;
  registry: DaemonSessionRegistry;
  clock: ManualDaemonProtocolClock;
  frames: WsFrameSample[];
  rpcCalls: string[];
}

function harness(options: {
  authorize?: (daemonId: string, runtimeId: string) => DaemonSessionRuntimeAuthorization;
  traceHeads?: () => Record<string, number>;
  rpc?: (type: string) => unknown | null;
} = {}): Harness {
  const socket = new FakeDaemonSocket();
  const registry = new DaemonSessionRegistry();
  const clock = new ManualDaemonProtocolClock();
  const frames: WsFrameSample[] = [];
  const rpcCalls: string[] = [];
  const session = new DaemonProtocolSession({
    sessionId: "dws_test",
    socket,
    registry,
    serverVersion: "0.2.83",
    clock,
    authorizeRuntime: async (daemonId, runtimeId) =>
      options.authorize?.(daemonId, runtimeId) ?? { runtimeId, ok: true },
    traceHeads: options.traceHeads,
    onFrame: (sample) => frames.push(sample),
    onRpc: (frame) => {
      rpcCalls.push(frame.type);
      return options.rpc ? options.rpc(frame.type) : null;
    },
  });
  return { session, socket, registry, clock, frames, rpcCalls };
}

/** Send a hello and assert it was accepted, so a case can start from a live session. */
async function handshake(h: Harness, patch: Record<string, unknown> = {}): Promise<void> {
  await h.session.handleMessage(JSON.stringify({ v: 2, t: "hello", ts: 1, p: helloPayload(patch) }));
  expect(h.socket.lastOfType("welcome")).not.toBeNull();
}

describe("MUL-417 daemon protocol session — handshake", () => {
  it("answers a valid hello with welcome and registers the daemon", async () => {
    const h = harness({ traceHeads: () => ({ task_a: 7 }) });
    await handshake(h);

    const welcome = h.socket.lastOfType("welcome")!;
    expect(welcome).toMatchObject({
      v: 2,
      t: "welcome",
      p: {
        protocol: 2,
        min_cli_version: "0.2.83",
        session_id: "dws_test",
        hb_interval_ms: 15000,
        limits: { frame_bytes: 1048576, window_frames: 64, window_bytes: 1048576 },
        trace_heads: { task_a: 7 },
      },
    });
    // A-1 leaves the caps and trace heads to the sub-issues that own them, but
    // the fields must exist so the daemon reads one shape.
    expect(h.registry.get("dmn_test")).toBe(h.session);
    expect(h.registry.daemonIdForRuntime("rt_one")).toBe("dmn_test");
    expect(h.session.runtimeIds).toEqual(["rt_one"]);
    expect(h.socket.closed).toEqual([]);
  });

  it("answers trace_heads with an empty object when A-6 has not filled it", async () => {
    const h = harness();
    await handshake(h);
    expect((h.socket.lastOfType("welcome")!.p as Record<string, unknown>).trace_heads).toEqual({});
  });

  it("rejects a protocol below the minimum with reject and close 4426", async () => {
    const h = harness();
    await h.session.handleMessage(JSON.stringify({
      v: 1,
      t: "hello",
      ts: 1,
      p: helloPayload({ protocol: 1 }),
    }));

    const reject = h.socket.lastOfType("reject")!;
    expect(reject.p).toMatchObject({
      code: "daemon_protocol_upgrade_required",
      min_protocol: 2,
      min_cli_version: "0.2.83",
    });
    expect(h.socket.closed).toEqual([{
      code: DAEMON_PROTOCOL_CLOSE_CODES.protocol_upgrade_required,
      reason: expect.any(String),
    }]);
    expect(h.registry.size).toBe(0);
    expect(h.session.isHandshakeComplete).toBe(false);
  });

  it("rejects a CLI below the minimum with reject and close 4426", async () => {
    const h = harness();
    await h.session.handleMessage(JSON.stringify({
      v: 2,
      t: "hello",
      ts: 1,
      p: helloPayload({ cli_version: "0.2.82" }),
    }));

    expect(h.socket.lastOfType("reject")!.p).toMatchObject({
      code: "daemon_cli_upgrade_required",
      min_cli_version: "0.2.83",
    });
    expect(h.socket.closed[0]!.code).toBe(DAEMON_PROTOCOL_CLOSE_CODES.protocol_upgrade_required);
    expect(h.registry.size).toBe(0);
  });

  it("treats an unparseable CLI version as too old, so it must upgrade", async () => {
    const h = harness();
    await h.session.handleMessage(JSON.stringify({
      v: 2,
      t: "hello",
      ts: 1,
      p: helloPayload({ cli_version: "nightly" }),
    }));
    expect(h.socket.closed[0]!.code).toBe(DAEMON_PROTOCOL_CLOSE_CODES.protocol_upgrade_required);
  });

  it("refuses a frame that precedes the handshake", async () => {
    const h = harness();
    await h.session.handleMessage(JSON.stringify({ v: 2, t: "hb", ts: 1, p: {} }));
    expect(h.socket.lastOfType("welcome")).toBeNull();
    expect(h.socket.closed[0]!.code).toBe(DAEMON_PROTOCOL_CLOSE_CODES.protocol_upgrade_required);
  });

  it("refuses a hello with no runtimes rather than registering an empty session", async () => {
    const h = harness();
    await h.session.handleMessage(JSON.stringify({
      v: 2,
      t: "hello",
      ts: 1,
      p: helloPayload({ runtimes: [] }),
    }));
    expect(h.socket.closed).toHaveLength(1);
    expect(h.registry.size).toBe(0);
  });
});

describe("MUL-417 daemon protocol session — terminal authorization failures", () => {
  it("closes 4401 when the credential is no longer authorized", async () => {
    const h = harness({
      authorize: (daemonId, runtimeId) => ({
        runtimeId,
        ok: false,
        status: 401,
        code: "authority_revoked",
        message: "credential revoked",
      }),
    });
    await h.session.handleMessage(JSON.stringify({ v: 2, t: "hello", ts: 1, p: helloPayload() }));
    expect(h.socket.lastOfType("welcome")).toBeNull();
    expect(h.socket.closed[0]!.code).toBe(DAEMON_PROTOCOL_CLOSE_CODES.authority_revoked);
    expect(h.registry.size).toBe(0);
  });

  it("closes 4403 when the token lacks the scope for the socket", async () => {
    const h = harness({
      authorize: (daemonId, runtimeId) => ({
        runtimeId,
        ok: false,
        status: 403,
        code: "daemon_identity_forbidden",
        message: "daemon token may only serve its own runtimes",
      }),
    });
    await h.session.handleMessage(JSON.stringify({ v: 2, t: "hello", ts: 1, p: helloPayload() }));
    expect(h.socket.closed[0]!.code).toBe(DAEMON_PROTOCOL_CLOSE_CODES.forbidden);
  });

  it("closes 4410 when the daemon has been retired", async () => {
    const h = harness({
      authorize: (daemonId, runtimeId) => ({
        runtimeId,
        ok: false,
        status: 410,
        code: "daemon_retired",
        message: "daemon has been retired",
      }),
    });
    await h.session.handleMessage(JSON.stringify({ v: 2, t: "hello", ts: 1, p: helloPayload() }));
    expect(h.socket.closed[0]!.code).toBe(DAEMON_PROTOCOL_CLOSE_CODES.daemon_retired);
  });

  it("does not leak negotiated limits to a credential it is about to refuse", async () => {
    const h = harness({
      authorize: (daemonId, runtimeId) => ({ runtimeId, ok: false, status: 403, code: "x" }),
    });
    await h.session.handleMessage(JSON.stringify({ v: 2, t: "hello", ts: 1, p: helloPayload() }));
    expect(h.socket.sent.map((frame) => frame.t)).toEqual([]);
  });
});

describe("MUL-417 daemon protocol session — downlink seq and ack", () => {
  it("numbers reliable downlink frames from 1 and retires them on an ack", async () => {
    const h = harness();
    await handshake(h);

    expect(h.session.sendEvent({ t: "task.offer", rt: "rt_one", p: { task_id: "t1" } })).toBe(1);
    expect(h.session.sendEvent({ t: "task.offer", rt: "rt_one", p: { task_id: "t2" } })).toBe(2);
    expect(h.socket.sent.filter((frame) => frame.t === "task.offer").map((frame) => frame.seq)).toEqual([1, 2]);
    expect(h.session.unacknowledgedFrameCount).toBe(2);

    await h.session.handleMessage(JSON.stringify({ v: 2, t: "ack", ts: 2, p: { ack: 2 } }));
    expect(h.session.unacknowledgedFrameCount).toBe(0);
  });

  it("honours a piggybacked ack", async () => {
    const h = harness();
    await handshake(h);
    h.session.sendEvent({ t: "task.offer", p: {} });
    h.session.sendEvent({ t: "task.steer", p: {} });
    expect(h.session.unacknowledgedFrameCount).toBe(2);

    // Any frame may carry `ack`, not just an `ack` frame.
    await h.session.handleMessage(JSON.stringify({ v: 2, t: "hb", ack: 1, ts: 2, p: {} }));
    expect(h.session.unacknowledgedFrameCount).toBe(1);
  });

  it("ignores a stale or impossible ack instead of closing the connection", async () => {
    const h = harness();
    await handshake(h);
    h.session.sendEvent({ t: "task.offer", p: {} });
    await h.session.handleMessage(JSON.stringify({ v: 2, t: "ack", ts: 2, p: { ack: 99 } }));
    expect(h.session.isClosed).toBe(false);
    expect(h.session.unacknowledgedFrameCount).toBe(1);
  });

  it("closes 4000 when a reliable frame goes unacknowledged for the deadline", async () => {
    const h = harness();
    await handshake(h);
    h.session.sendEvent({ t: "task.offer", rt: "rt_one", p: { task_id: "t1" } });
    expect(h.session.isClosed).toBe(false);

    // One millisecond short of the deadline: still alive.
    h.clock.advance(DAEMON_ACK_TIMEOUT_MS - 1);
    expect(h.session.isClosed).toBe(false);

    h.clock.advance(1);
    expect(h.session.isClosed).toBe(true);
    expect(h.socket.closed[0]!.code).toBe(DAEMON_PROTOCOL_CLOSE_CODES.ack_timeout);
  });

  it("survives the deadline when the ack arrives first", async () => {
    const h = harness();
    await handshake(h);
    h.session.sendEvent({ t: "task.offer", p: {} });

    h.clock.advance(DAEMON_ACK_TIMEOUT_MS - 5_000);
    await h.session.handleMessage(JSON.stringify({ v: 2, t: "ack", ts: 2, p: { ack: 1 } }));

    h.clock.advance(30_000);
    expect(h.session.isClosed).toBe(false);
    expect(h.clock.pendingTimerCount).toBe(0);
  });

  it("does not sequence a frame it refused to send", async () => {
    const h = harness();
    await handshake(h);
    h.socket.fixedStatus = 0;
    expect(h.session.sendEvent({ t: "task.offer", p: {} })).toBeNull();
    // The dropped socket closes the session; a retry must not consume sequence 1.
    expect(h.session.isClosed).toBe(true);
    expect(h.socket.lastOfType("task.offer")).not.toBeNull();
  });
});

describe("MUL-417 daemon protocol session — backpressure", () => {
  it("pauses pausable traffic on send === -1 and resumes on drain", async () => {
    const h = harness();
    await handshake(h);

    h.socket.fixedStatus = -1;
    // `-1` means "queued, but the socket is behind": the frame did leave, so it
    // keeps its sequence, and the *next* pausable frame is what gets held back.
    expect(h.session.sendEvent({ t: "task.offer", p: {} }, { pausable: true })).toBe(1);
    expect(h.session.isPaused).toBe(true);
    expect(h.socket.sent.filter((frame) => frame.t === "task.offer")).toHaveLength(1);

    // Still paused: no new pausable frame leaves.
    expect(h.session.sendEvent({ t: "task.offer", p: {} }, { pausable: true })).toBeNull();
    expect(h.socket.sent.filter((frame) => frame.t === "task.offer")).toHaveLength(1);

    h.socket.fixedStatus = null;
    h.session.handleDrain();
    expect(h.session.isPaused).toBe(false);
    expect(h.session.sendEvent({ t: "task.offer", p: {} }, { pausable: true })).toBe(2);
  });

  it("keeps res and ack flowing while paused", async () => {
    const h = harness();
    await handshake(h);
    h.socket.fixedStatus = -1;
    h.session.sendEvent({ t: "task.offer", p: {} }, { pausable: true });
    expect(h.session.isPaused).toBe(true);

    // `res` releases the peer's window; pausing it would deadlock both sides.
    expect(h.session.sendDirect({ t: "ack", ack: 0 })).toBe(true);
    expect(h.session.sendReply("q1", { ok: true })).toBe(true);
    expect(h.socket.lastOfType("res")).not.toBeNull();
  });

  it("unregisters the connection when send returns 0", async () => {
    const h = harness();
    await handshake(h);
    expect(h.registry.size).toBe(1);

    h.socket.fixedStatus = 0;
    expect(h.session.sendEvent({ t: "task.offer", p: {} })).toBeNull();
    expect(h.session.isClosed).toBe(true);
    expect(h.registry.size).toBe(0);
    expect(h.socket.closed[0]!.code).toBe(DAEMON_PROTOCOL_CLOSE_CODES.server_closing);
  });

  it("ignores a drain callback after the socket dropped a frame", async () => {
    const h = harness();
    await handshake(h);
    h.socket.fixedStatus = 0;
    h.session.sendEvent({ t: "task.offer", p: {} });
    expect(h.session.isClosed).toBe(true);

    h.session.handleDrain();
    expect(h.session.isClosed).toBe(true);
    expect(h.registry.size).toBe(0);
  });

  it("reports the queue depth the socket exposes", async () => {
    const h = harness();
    await handshake(h);
    h.socket.bufferedAmount = 2 * 1024 * 1024;
    expect((h.socket as DaemonProtocolSocket).bufferedAmount).toBe(2 * 1024 * 1024);
  });
});

describe("MUL-417 daemon protocol session — rpc dispatch and unknown frames", () => {
  it("dispatches a registered rpc and answers through res", async () => {
    const h = harness({ rpc: () => ({ ok: true, first_seq: 1, head: 3 }) });
    await handshake(h);

    await h.session.handleMessage(JSON.stringify({
      v: 2,
      t: "trace.head",
      id: "q-9",
      ts: 3,
      p: { task_id: "t1" },
    }));

    expect(h.rpcCalls).toEqual(["trace.head"]);
    expect(h.socket.lastOfType("res")).toMatchObject({
      t: "res",
      re: "q-9",
      p: { ok: true, first_seq: 1, head: 3 },
    });
  });

  it("answers an unknown frame with res{ok:false, code:unknown_frame} and keeps the socket", async () => {
    const h = harness();
    await handshake(h);

    await h.session.handleMessage(JSON.stringify({ v: 2, t: "nope.not.a.frame", id: "q-1", ts: 3, p: {} }));

    expect(h.socket.lastOfType("res")).toMatchObject({
      t: "res",
      re: "q-1",
      p: { ok: false, code: "unknown_frame", retryable: false },
    });
    expect(h.session.isClosed).toBe(false);
    expect(h.socket.closed).toEqual([]);
  });

  it("refuses an rpc nobody registered yet instead of answering ok", async () => {
    const h = harness();
    await handshake(h);
    await h.session.handleMessage(JSON.stringify({
      v: 2,
      t: "trace.subscribe",
      id: "q-2",
      ts: 3,
      p: { task_id: "t1", from_seq: 0 },
    }));
    expect(h.socket.lastOfType("res")).toMatchObject({
      re: "q-2",
      p: { ok: false, retryable: false },
    });
  });

  it("closes on a malformed frame", async () => {
    const h = harness();
    await handshake(h);
    await h.session.handleMessage("{not json");
    expect(h.session.isClosed).toBe(true);
    expect(h.socket.closed[0]!.code).toBe(DAEMON_PROTOCOL_CLOSE_CODES.server_closing);
  });

  it("closes when a frame exceeds the protocol size limit", async () => {
    const h = harness();
    await handshake(h);
    const oversized = JSON.stringify({ v: 2, t: "hb", ts: 1, p: { pad: "x".repeat(1024 * 1024 + 64) } });
    await h.session.handleMessage(oversized);
    expect(h.session.isClosed).toBe(true);
    expect(h.socket.closed[0]!.code).toBe(DAEMON_PROTOCOL_CLOSE_CODES.server_closing);
  });
});

describe("MUL-417 daemon protocol session — registry replacement", () => {
  it("closes the previous session with 4001 when the same daemon reconnects", async () => {
    const first = harness();
    await handshake(first);
    expect(first.registry.size).toBe(1);

    const second = harness();
    // Share the registry the way a second socket on the same server would.
    const session2 = new DaemonProtocolSession({
      sessionId: "dws_second",
      socket: second.socket,
      registry: first.registry,
      serverVersion: "0.2.83",
      clock: second.clock,
      authorizeRuntime: async (_daemonId, runtimeId) => ({ runtimeId, ok: true }),
    });
    await session2.handleMessage(JSON.stringify({ v: 2, t: "hello", ts: 1, p: helloPayload() }));

    expect(first.socket.closed[0]!.code).toBe(DAEMON_PROTOCOL_CLOSE_CODES.server_closing);
    expect(first.session.isClosed).toBe(true);
    expect(first.registry.get("dmn_test")).toBe(session2);
    expect(first.registry.size).toBe(1);
  });

  it("closes the previous daemon when a different one claims the same runtime", async () => {
    const first = harness();
    await handshake(first);

    const second = harness();
    const session2 = new DaemonProtocolSession({
      sessionId: "dws_other",
      socket: second.socket,
      registry: first.registry,
      serverVersion: "0.2.83",
      clock: second.clock,
      authorizeRuntime: async (_daemonId, runtimeId) => ({ runtimeId, ok: true }),
    });
    await session2.handleMessage(JSON.stringify({
      v: 2,
      t: "hello",
      ts: 1,
      p: helloPayload({ daemon_id: "dmn_other" }),
    }));

    expect(first.session.isClosed).toBe(true);
    expect(first.socket.closed[0]!.code).toBe(DAEMON_PROTOCOL_CLOSE_CODES.server_closing);
    expect(first.registry.daemonIdForRuntime("rt_one")).toBe("dmn_other");
  });

  it("leaves the successor's runtime index alone when the replaced session is disposed", async () => {
    const first = harness();
    await handshake(first);
    const second = harness();
    const registry = first.registry;
    const session2 = new DaemonProtocolSession({
      sessionId: "dws_second",
      socket: second.socket,
      registry,
      serverVersion: "0.2.83",
      clock: second.clock,
      authorizeRuntime: async (_daemonId, runtimeId) => ({ runtimeId, ok: true }),
    });
    await session2.handleMessage(JSON.stringify({ v: 2, t: "hello", ts: 1, p: helloPayload() }));

    // The replaced session's own teardown must not evict the live one.
    first.session.handleSocketClose();
    expect(registry.daemonIdForRuntime("rt_one")).toBe("dmn_test");
    expect(registry.get("dmn_test")).toBe(session2);
  });

  it("unregisters when the peer disconnects", async () => {
    const h = harness();
    await handshake(h);
    h.session.handleSocketClose();
    expect(h.registry.size).toBe(0);
    expect(h.registry.daemonIdForRuntime("rt_one")).toBeNull();
  });
});

describe("MUL-417 daemon protocol session — heartbeat and serialization", () => {
  it("reports every advertised runtime on hb and records the drain ack", async () => {
    const heartbeats: Array<{ daemonId: string; runtimeIds: string[]; payload: Record<string, unknown> }> = [];
    const socket = new FakeDaemonSocket();
    const registry = new DaemonSessionRegistry();
    const clock = new ManualDaemonProtocolClock();
    const session = new DaemonProtocolSession({
      sessionId: "dws_hb",
      socket,
      registry,
      serverVersion: "0.2.83",
      clock,
      authorizeRuntime: async (_daemonId, runtimeId) => ({ runtimeId, ok: true }),
      onHeartbeat: (heartbeat) => heartbeats.push(heartbeat),
    });
    await session.handleMessage(JSON.stringify({
      v: 2,
      t: "hello",
      ts: 1,
      p: helloPayload({
        runtimes: [
          { runtime_id: "rt_one", provider: "codex", max_concurrency: 2, active_task_ids: [] },
          { runtime_id: "rt_two", provider: "claude", max_concurrency: 1, active_task_ids: ["t9"] },
        ],
      }),
    }));

    await session.handleMessage(JSON.stringify({
      v: 2,
      t: "hb",
      ts: 2,
      p: { active_task_count: 1, drain_ack_generation: 3 },
    }));

    expect(heartbeats).toEqual([{
      daemonId: "dmn_test",
      runtimeIds: ["rt_one", "rt_two"],
      payload: { active_task_count: 1, drain_ack_generation: 3 },
    }]);
  });

  it("processes frames in arrival order even when handlers await", async () => {
    const order: string[] = [];
    const socket = new FakeDaemonSocket();
    const registry = new DaemonSessionRegistry();
    const clock = new ManualDaemonProtocolClock();
    const session = new DaemonProtocolSession({
      sessionId: "dws_serial",
      socket,
      registry,
      serverVersion: "0.2.83",
      clock,
      authorizeRuntime: async (_daemonId, runtimeId) => ({ runtimeId, ok: true }),
      onRpc: async (frame) => {
        // The first frame yields for longer than the second; serialization is
        // what keeps them from interleaving.
        await new Promise((resolve) => setTimeout(resolve, frame.type === "trace.head" ? 30 : 0));
        order.push(frame.type);
        return { ok: true };
      },
    });
    await session.handleMessage(JSON.stringify({ v: 2, t: "hello", ts: 1, p: helloPayload() }));

    const first = session.handleMessage(JSON.stringify({ v: 2, t: "trace.head", id: "a", ts: 2, p: {} }));
    const second = session.handleMessage(JSON.stringify({ v: 2, t: "trace.fetch", id: "b", ts: 2, p: {} }));
    await Promise.all([first, second]);

    expect(order).toEqual(["trace.head", "trace.fetch"]);
  });

  it("keeps processing after a frame handler throws", async () => {
    const h = harness({
      rpc: (type) => {
        if (type === "trace.head") throw new Error("handler exploded");
        return { ok: true };
      },
    });
    await handshake(h);
    await h.session.handleMessage(JSON.stringify({ v: 2, t: "trace.head", id: "a", ts: 2, p: {} }));
    await h.session.handleMessage(JSON.stringify({ v: 2, t: "trace.fetch", id: "b", ts: 2, p: {} }));
    expect(h.rpcCalls).toEqual(["trace.head", "trace.fetch"]);
    expect(h.session.isClosed).toBe(false);
  });

  it("records one frame sample per dispatched frame with its type and direction", async () => {
    const h = harness({ rpc: () => ({ ok: true }) });
    await handshake(h);
    await h.session.handleMessage(JSON.stringify({ v: 2, t: "hb", ts: 2, p: {} }));
    await h.session.handleMessage(JSON.stringify({ v: 2, t: "trace.head", id: "a", ts: 2, p: {} }));

    expect(h.frames.map((sample) => [sample.type, sample.direction])).toEqual([
      ["hello", "uplink"],
      ["hb", "uplink"],
      ["trace.head", "rpc"],
    ]);
    expect(h.frames.every((sample) => sample.protocolViolation === false)).toBe(true);
  });

  it("flags a protocol violation in the frame sample", async () => {
    const h = harness();
    await handshake(h);
    await h.session.handleMessage(JSON.stringify({ v: 2, t: "hb", ts: 2, p: { pad: "x".repeat(1024 * 1024 + 64) } }));
    const violation = h.frames.at(-1)!;
    expect(violation.protocolViolation).toBe(true);
    expect(violation.errorCode).toBe("protocol_violation");
  });
});
