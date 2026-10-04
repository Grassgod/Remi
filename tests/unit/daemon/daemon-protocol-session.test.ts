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
  DAEMON_MIN_CLI_VERSION,
  DAEMON_FRAME_MAX_BYTES,
  DAEMON_PROTOCOL_CLOSE_CODES,
  DAEMON_UPLINK_WINDOW_FRAMES,
} from "@multiremi/contracts/daemon-protocol.js";
import { DaemonSessionRegistry } from "../../../packages/server/src/api/daemon-protocol/session-registry.js";
import { ManualDaemonProtocolClock } from "../../../packages/server/src/api/daemon-protocol/clock.js";
import {
  DaemonProtocolSession,
  type DaemonProtocolSocket,
  type DaemonSessionHeartbeat,
  type DaemonSessionRuntimeAuthorization,
} from "../../../packages/server/src/api/daemon-protocol/session.js";
import type { WsFrameSample } from "../../../packages/server/src/api/daemon-protocol/metrics.js";

/** A socket that records what it was asked to do and answers with a scripted status. */
class FakeDaemonSocket implements DaemonProtocolSocket {
  readonly sent: Array<Record<string, unknown>> = [];
  readonly delivered: Array<Record<string, unknown>> = [];
  readonly closed: Array<{ code: number; reason: string }> = [];
  bufferedAmount = 0;
  /** Status the next `send` answers with; `null` means "sent as many bytes as were written". */
  nextStatus: number | null = null;
  /** Status every `send` answers with, until reset. */
  fixedStatus: number | null = null;
  /** Failure injected before the frame reaches the peer. */
  nextError: Error | null = null;

  send(text: string): number {
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = null;
      throw error;
    }
    const status = this.nextStatus;
    this.nextStatus = null;
    const result = this.fixedStatus ?? status ?? Buffer.byteLength(text, "utf8");
    const frame = JSON.parse(text) as Record<string, unknown>;
    this.sent.push(frame);
    if (result !== 0) this.delivered.push(frame);
    return result;
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

  lastDeliveredOfType(type: string): Record<string, unknown> | null {
    for (let index = this.delivered.length - 1; index >= 0; index -= 1) {
      if (this.delivered[index]!.t === type) return this.delivered[index]!;
    }
    return null;
  }
}

function helloPayload(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: 2,
    daemon_id: "dmn_test",
    cli_version: DAEMON_MIN_CLI_VERSION,
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
  heartbeat?: () => unknown;
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
      options.authorize?.(daemonId, runtimeId) ?? { runtimeId, ok: true, scope: "daemon" },
    traceHeads: options.traceHeads,
    onFrame: (sample) => frames.push(sample),
    onHeartbeat: options.heartbeat,
    onRpc: (frame) => {
      rpcCalls.push(frame.type);
      return options.rpc ? options.rpc(frame.type) : null;
    },
  });
  return { session, socket, registry, clock, frames, rpcCalls };
}

/** Capture `console.warn` output for the duration of `body`. */
async function captureWarnings(body: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    await body();
  } finally {
    console.warn = realWarn;
  }
  return lines;
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
        min_cli_version: DAEMON_MIN_CLI_VERSION,
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
      min_cli_version: DAEMON_MIN_CLI_VERSION,
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
      min_cli_version: DAEMON_MIN_CLI_VERSION,
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

  it("refuses a frame that precedes the handshake with 4002, not 4426", async () => {
    const h = harness();
    await h.session.handleMessage(JSON.stringify({ v: 2, t: "hb", ts: 1, p: {} }));
    expect(h.socket.lastOfType("welcome")).toBeNull();
    // 4426 would park the daemon in `upgrade_wait` waiting for an upgrade that is
    // not coming; an out-of-order frame is a client fault, so it retries instead.
    expect(h.socket.closed[0]!.code).toBe(DAEMON_PROTOCOL_CLOSE_CODES.protocol_violation);
    expect(h.socket.closed[0]!.code).not.toBe(DAEMON_PROTOCOL_CLOSE_CODES.protocol_upgrade_required);
  });

  it("refuses a malformed hello with 4002, not 4426", async () => {
    const h = harness();
    await h.session.handleMessage(JSON.stringify({ v: 2, t: "hello", ts: 1, p: { daemon_id: "dmn_test" } }));
    expect(h.socket.closed[0]!.code).toBe(DAEMON_PROTOCOL_CLOSE_CODES.protocol_violation);
    expect(h.registry.size).toBe(0);
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
        scope: "daemon",
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
        scope: "daemon",
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
        scope: "daemon",
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
      authorize: (daemonId, runtimeId) => ({ runtimeId, ok: false, scope: "daemon", status: 403, code: "x" }),
    });
    await h.session.handleMessage(JSON.stringify({ v: 2, t: "hello", ts: 1, p: helloPayload() }));
    expect(h.socket.sent.map((frame) => frame.t)).toEqual([]);
  });
});

describe("MUL-417 daemon protocol session — downlink seq and ack", () => {
  it("numbers reliable downlink frames from 1 and retires them on an ack", async () => {
    const h = harness();
    await handshake(h);

    expect(h.session.sendEvent({ t: "task.offer", rt: "rt_one", p: { task_id: "t1" } })).toEqual({ ok: true, seq: 1 });
    expect(h.session.sendEvent({ t: "task.offer", rt: "rt_one", p: { task_id: "t2" } })).toEqual({ ok: true, seq: 2 });
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
    expect(h.session.sendEvent({ t: "task.offer", p: {} })).toEqual({ ok: false, reason: "closed" });
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
    expect(h.session.sendEvent({ t: "task.offer", p: {} }, { pausable: true })).toEqual({ ok: true, seq: 1 });
    expect(h.session.isPaused).toBe(true);
    expect(h.socket.sent.filter((frame) => frame.t === "task.offer")).toHaveLength(1);

    // Still paused: no new pausable frame leaves.
    expect(h.session.sendEvent({ t: "task.offer", p: {} }, { pausable: true })).toEqual({ ok: false, reason: "paused" });
    expect(h.socket.sent.filter((frame) => frame.t === "task.offer")).toHaveLength(1);

    h.socket.fixedStatus = null;
    h.session.handleDrain();
    expect(h.session.isPaused).toBe(false);
    expect(h.session.sendEvent({ t: "task.offer", p: {} }, { pausable: true })).toEqual({ ok: true, seq: 2 });
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
    expect(h.session.sendEvent({ t: "task.offer", p: {} })).toEqual({ ok: false, reason: "closed" });
    expect(h.session.isClosed).toBe(true);
    expect(h.registry.size).toBe(0);
    expect(h.socket.closed[0]!.code).toBe(DAEMON_PROTOCOL_CLOSE_CODES.server_closing);
  });

  for (const failure of ["throws", "returns 0"] as const) {
    it(`rolls back welcome when socket.send ${failure} and allows the daemon to reconnect`, async () => {
      const h = harness();
      if (failure === "throws") h.socket.nextError = new Error("send failed");
      else h.socket.nextStatus = 0;

      await h.session.handleMessage(JSON.stringify({ v: 2, t: "hello", ts: 1, p: helloPayload() }));
      expect(h.socket.closed.map(({ code }) => code)).toEqual([4001]);
      expect(h.socket.lastDeliveredOfType("welcome")).toBeNull();
      expect(h.session.isHandshakeComplete).toBe(false);
      expect(h.registry.size).toBe(0);
      expect(h.registry.daemonIdForRuntime("rt_one")).toBeNull();

      const retrySocket = new FakeDaemonSocket();
      const retry = new DaemonProtocolSession({
        sessionId: "dws_retry",
        socket: retrySocket,
        registry: h.registry,
        serverVersion: "0.2.83",
        clock: new ManualDaemonProtocolClock(),
        authorizeRuntime: async (_daemonId, runtimeId) => ({ runtimeId, ok: true, scope: "daemon" }),
      });
      await retry.handleMessage(JSON.stringify({ v: 2, t: "hello", ts: 2, p: helloPayload() }));
      expect(retrySocket.lastOfType("welcome")).not.toBeNull();
      expect(retry.isHandshakeComplete).toBe(true);
      expect(h.registry.get("dmn_test")).toBe(retry);
    });
  }

  it("closes and unregisters an established session when a later send throws", async () => {
    const h = harness();
    await handshake(h);
    h.socket.nextError = new Error("send failed");

    expect(h.session.sendEvent({ t: "task.offer", p: {} })).toEqual({ ok: false, reason: "closed" });
    expect(h.socket.closed.map(({ code }) => code)).toEqual([4001]);
    expect(h.session.isClosed).toBe(true);
    expect(h.registry.size).toBe(0);
    expect(h.registry.daemonIdForRuntime("rt_one")).toBeNull();
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

describe("MUL-417 daemon protocol session — the downlink window is enforced", () => {
  it("refuses the frame past the 64-frame window and sends it once an ack frees room", async () => {
    const h = harness();
    await handshake(h);

    for (let index = 1; index <= DAEMON_UPLINK_WINDOW_FRAMES; index += 1) {
      expect(h.session.sendEvent({ t: "task.offer", p: { index } })).toEqual({ ok: true, seq: index });
    }
    expect(h.session.windowUsage().frames).toBe(DAEMON_UPLINK_WINDOW_FRAMES);
    // The 65th is refused, and the refusal consumes no sequence.
    expect(h.session.sendEvent({ t: "task.offer", p: { index: 65 } })).toEqual({ ok: false, reason: "window_full" });
    expect(h.session.lastSentSeq).toBe(DAEMON_UPLINK_WINDOW_FRAMES);

    // An ack for the whole window frees it, and the retry fills the next slot: the
    // refused frame must not have burned a number.
    await h.session.handleMessage(JSON.stringify({ v: 2, t: "ack", ts: 2, p: { ack: DAEMON_UPLINK_WINDOW_FRAMES } }));
    expect(h.session.windowUsage().frames).toBe(0);
    expect(h.session.sendEvent({ t: "task.offer", p: { index: 65 } })).toEqual({
      ok: true,
      seq: DAEMON_UPLINK_WINDOW_FRAMES + 1,
    });
  });

  it("refuses a frame that would push the window past 1 MiB", async () => {
    const h = harness();
    await handshake(h);
    // ~600 KiB each: the second fits in bytes (1.2 MB > 1 MiB, so it is refused).
    const padding = "x".repeat(600 * 1024);
    expect(h.session.sendEvent({ t: "task.offer", p: { padding } })).toEqual({ ok: true, seq: 1 });
    expect(h.session.sendEvent({ t: "task.offer", p: { padding } })).toEqual({ ok: false, reason: "window_full" });
    expect(h.session.windowUsage().bytes).toBeGreaterThan(600 * 1024);
    expect(h.session.lastSentSeq).toBe(1);

    // Draining the window lets it through, again without consuming a sequence.
    await h.session.handleMessage(JSON.stringify({ v: 2, t: "ack", ts: 2, p: { ack: 1 } }));
    expect(h.session.sendEvent({ t: "task.offer", p: { padding } })).toEqual({ ok: true, seq: 2 });
  });

  it("calls an oversized single frame too_large, because no ack can make it fit", async () => {
    const h = harness();
    await handshake(h);
    // The window is empty, so `window_full` would be a lie: this frame is over the
    // `frame_bytes: 1 MiB` the daemon was told about, and free space never changes
    // that. A pump reading `window_full` would park the task waiting for room.
    expect(h.session.windowUsage()).toEqual({ frames: 0, bytes: 0 });
    expect(h.session.sendEvent({
      t: "task.offer",
      p: { padding: "x".repeat(DAEMON_FRAME_MAX_BYTES + 1) },
    })).toEqual({ ok: false, reason: "too_large" });
    expect(h.session.lastSentSeq).toBe(0);

    // The refusal burned no sequence: the next, normal frame still fits.
    expect(h.session.sendEvent({ t: "task.offer", p: { task_id: "t1" } })).toEqual({ ok: true, seq: 1 });
  });

  it("keeps res, ack and heartbeat replies outside the window", async () => {
    const h = harness();
    await handshake(h);
    for (let index = 1; index <= DAEMON_UPLINK_WINDOW_FRAMES; index += 1) {
      h.session.sendEvent({ t: "task.offer", p: { index } });
    }
    expect(h.session.sendEvent({ t: "task.offer", p: {} })).toEqual({ ok: false, reason: "window_full" });

    // These release the peer's own window or keep it alive; gating them behind the
    // downlink window would deadlock both sides.
    expect(h.session.sendDirect({ t: "ack", ack: DAEMON_UPLINK_WINDOW_FRAMES })).toBe(true);
    expect(h.session.sendReply("q1", { ok: true })).toBe(true);
    await h.session.handleMessage(JSON.stringify({ v: 2, t: "hb", id: "hb-1", ts: 2, p: {} }));
    expect(h.socket.lastOfType("res")).toMatchObject({ re: "hb-1" });
  });

  it("reports the window usage the caller needs to decide when to retry", async () => {
    const h = harness();
    await handshake(h);
    expect(h.session.windowUsage()).toEqual({ frames: 0, bytes: 0 });
    h.session.sendEvent({ t: "task.offer", p: {} });
    const after = h.session.windowUsage();
    expect(after.frames).toBe(1);
    expect(after.bytes).toBeGreaterThan(0);
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

  it("answers an unknown reliable frame by seq, so its outbox row can be retired", async () => {
    const h = harness();
    await handshake(h);
    const frame = JSON.stringify({ v: 2, t: "future.reliable", seq: 17, rt: "rt_one", ts: 3, p: {} });

    await h.session.handleMessage(frame);
    expect(h.socket.lastOfType("res")).toMatchObject({
      t: "res",
      re: "17",
      p: { ok: false, code: "unknown_frame", retryable: false },
    });

    // A replay after a reconnect has to get the same answer, or the row stays in
    // the daemon's outbox and is replayed forever.
    await h.session.handleMessage(frame);
    const replies = h.socket.sent.filter((sent) => sent.t === "res");
    expect(replies).toHaveLength(2);
    expect(replies.map((reply) => reply.re)).toEqual(["17", "17"]);
    expect(h.session.isClosed).toBe(false);
    expect(h.socket.closed).toEqual([]);
  });

  it("answers an unknown frame that only carries an RPC id by id", async () => {
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

  it("ignores an unknown frame with neither seq nor id instead of answering with an empty re", async () => {
    const h = harness();
    await handshake(h);
    const before = h.socket.sent.filter((sent) => sent.t === "res").length;

    // A newer daemon may send a notification this server version does not know.
    // There is no row to name, so a `res` would carry nothing actionable; the
    // frame is counted and the connection stays up.
    await h.session.handleMessage(JSON.stringify({ v: 2, t: "future.notice", ts: 3, p: { note: "hi" } }));

    expect(h.socket.sent.filter((sent) => sent.t === "res")).toHaveLength(before);
    expect(h.session.isClosed).toBe(false);
    expect(h.socket.closed).toEqual([]);
    expect(h.frames.at(-1)).toMatchObject({ type: "future.notice", errorCode: "unknown_frame" });
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

  it("closes a malformed frame with 4002", async () => {
    const h = harness();
    await handshake(h);
    await h.session.handleMessage("{not json");
    expect(h.session.isClosed).toBe(true);
    // Nothing in an unparseable frame can address an outbox row, so there is no
    // reply to give; 4002 says "you sent rubbish", and it stays retryable.
    expect(h.socket.closed[0]!.code).toBe(DAEMON_PROTOCOL_CLOSE_CODES.protocol_violation);
    expect(h.session.isClosed).toBe(true);
  });

  it("answers an oversized reliable event with res{re: seq} and keeps the connection", async () => {
    const h = harness();
    await handshake(h);
    // A reliable event the daemon has in its outbox: `seq` names the row, so the
    // server can tell it exactly which row not to retry. Closing instead would
    // loop forever, because the daemon replays unacknowledged rows.
    const oversized = `{"v":2,"t":"task.progress","seq":17,"rt":"rt_one","ts":1,"p":{"pad":"${"x".repeat(1024 * 1024 + 64)}"}}`;
    await h.session.handleMessage(oversized);
    expect(h.socket.lastOfType("res")).toMatchObject({
      re: "17",
      p: { ok: false, code: "protocol_violation", retryable: false },
    });
    expect(h.session.isClosed).toBe(false);
    expect(h.socket.closed).toEqual([]);

    // The same frame again (a reconnect replaying the row) gets the same answer.
    await h.session.handleMessage(oversized);
    expect(h.socket.sent.filter((frame) => frame.t === "res")).toHaveLength(2);
    expect(h.socket.sent.filter((frame) => frame.t === "res").every((frame) => frame.re === "17")).toBe(true);
    expect(h.session.isClosed).toBe(false);
  });

  it("answers an oversized RPC with res{re: id} and keeps the connection", async () => {
    const h = harness();
    await handshake(h);
    const oversized = `{"v":2,"t":"trace.head","id":"q-oversize","ts":1,"p":{"pad":"${"x".repeat(1024 * 1024 + 64)}"}}`;
    await h.session.handleMessage(oversized);
    expect(h.socket.lastOfType("res")).toMatchObject({
      re: "q-oversize",
      p: { ok: false, code: "protocol_violation", retryable: false },
    });
    expect(h.session.isClosed).toBe(false);
  });

  it("closes an oversized frame that names no outbox row with 4002", async () => {
    const h = harness();
    await handshake(h);
    // Neither `seq` nor `id`: there is nothing to address, so no reply can tell
    // the daemon which row to isolate.
    const oversized = `{"v":2,"t":"hb","ts":1,"p":{"pad":"${"x".repeat(1024 * 1024 + 64)}"}}`;
    await h.session.handleMessage(oversized);
    expect(h.session.isClosed).toBe(true);
    expect(h.socket.closed[0]!.code).toBe(DAEMON_PROTOCOL_CLOSE_CODES.protocol_violation);
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
      authorizeRuntime: async (_daemonId, runtimeId) => ({ runtimeId, ok: true, scope: "daemon" }),
    });
    await session2.handleMessage(JSON.stringify({ v: 2, t: "hello", ts: 1, p: helloPayload() }));

    expect(first.socket.closed[0]!.code).toBe(DAEMON_PROTOCOL_CLOSE_CODES.server_closing);
    expect(first.session.isClosed).toBe(true);
    expect(first.registry.get("dmn_test")).toBe(session2);
    expect(first.registry.size).toBe(1);
  });

  it("does not evict another daemon's connection when it claims the same runtime", async () => {
    const first = harness();
    await handshake(first);

    const second = harness();
    const session2 = new DaemonProtocolSession({
      sessionId: "dws_other",
      socket: second.socket,
      registry: first.registry,
      serverVersion: "0.2.83",
      clock: second.clock,
      authorizeRuntime: async (_daemonId, runtimeId) => ({ runtimeId, ok: true, scope: "daemon" }),
    });
    await session2.handleMessage(JSON.stringify({
      v: 2,
      t: "hello",
      ts: 1,
      p: helloPayload({ daemon_id: "dmn_other" }),
    }));

    // The later connection keeps only what nobody else holds; the earlier one is
    // untouched, because a socket serves a whole machine and evicting it over one
    // runtime would strand that machine's other runtimes.
    expect(first.session.isClosed).toBe(false);
    expect(first.socket.closed).toEqual([]);
    expect(first.registry.daemonIdForRuntime("rt_one")).toBe("dmn_test");
    expect(session2.runtimeIds).toEqual([]);
    expect(session2.unavailableRuntimeIds).toEqual(["rt_one"]);
    expect(session2.isClosed).toBe(false);
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
      authorizeRuntime: async (_daemonId, runtimeId) => ({ runtimeId, ok: true, scope: "daemon" }),
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
    const heartbeats: Array<DaemonSessionHeartbeat> = [];
    const socket = new FakeDaemonSocket();
    const registry = new DaemonSessionRegistry();
    const clock = new ManualDaemonProtocolClock();
    const session = new DaemonProtocolSession({
      sessionId: "dws_hb",
      socket,
      registry,
      serverVersion: "0.2.83",
      clock,
      authorizeRuntime: async (_daemonId, runtimeId) => ({ runtimeId, ok: true, scope: "daemon" }),
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
      unavailableRuntimeIds: [],
      advertisedRuntimeIds: ["rt_one", "rt_two"],
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
      authorizeRuntime: async (_daemonId, runtimeId) => ({ runtimeId, ok: true, scope: "daemon" }),
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

  it("answers server_error when an rpc handler throws, and keeps the connection", async () => {
    const h = harness({
      rpc: (type) => {
        if (type === "trace.head") throw new Error("handler exploded with sensitive payload");
        return { ok: true };
      },
    });
    await handshake(h);
    const lines = await captureWarnings(() =>
      h.session.handleMessage(JSON.stringify({ v: 2, t: "trace.head", id: "a", ts: 2, p: {} })),
    );

    // The caller gets a retryable answer instead of waiting out its own timeout
    // for a request the server already failed.
    expect(h.socket.lastOfType("res")).toMatchObject({
      re: "a",
      p: { ok: false, code: "server_error", retryable: true },
    });
    // The frame summary records the fault under the server's error code.
    expect(h.frames.at(-1)).toMatchObject({ type: "trace.head", errorCode: "server_error" });
    // The warning names the frame and the session but carries no payload content.
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: "daemon_protocol_frame_failed",
      session_id: "dws_test",
      frame_type: "trace.head",
      direction: "rpc",
      error_class: "Error",
    });
    expect(lines[0]).not.toContain("sensitive payload");

    // And processing continues: the next frame is served normally.
    await h.session.handleMessage(JSON.stringify({ v: 2, t: "trace.fetch", id: "b", ts: 2, p: {} }));
    expect(h.rpcCalls).toEqual(["trace.head", "trace.fetch"]);
    expect(h.session.isClosed).toBe(false);
    expect(h.socket.lastOfType("res")).toMatchObject({ re: "b", p: { ok: true } });
  });

  it("defers trace.fetch replies without changing other handlers' serial dispatch", async () => {
    const order: string[] = [];
    let finishFetch!: (value: Record<string, unknown>) => void;
    let finishRpc!: () => void;
    let startRpc!: () => void;
    const fetched = new Promise<Record<string, unknown>>((resolve) => { finishFetch = resolve; });
    const blocked = new Promise<void>((resolve) => { finishRpc = resolve; });
    const started = new Promise<void>((resolve) => { startRpc = resolve; });
    const socket = new FakeDaemonSocket();
    const session: DaemonProtocolSession = new DaemonProtocolSession({
      sessionId: "dws_deferred_serial",
      socket,
      registry: new DaemonSessionRegistry(),
      serverVersion: "0.2.83",
      clock: new ManualDaemonProtocolClock(),
      authorizeRuntime: async (_daemonId, runtimeId) => ({ runtimeId, ok: true, scope: "daemon" }),
      onRpc: async (frame) => {
        order.push(frame.id!);
        if (frame.type === "trace.fetch") return session.deferReply(frame.id!, fetched);
        if (frame.id === "first") { startRpc(); await blocked; }
        order.push(`${frame.id}:done`);
        return { ok: true };
      },
    });
    await session.handleMessage(JSON.stringify({ v: 2, t: "hello", ts: 1, p: helloPayload() }));
    await session.handleMessage(JSON.stringify({ v: 2, t: "trace.fetch", id: "fetch", ts: 2, p: {} }));
    const first = session.handleMessage(JSON.stringify({ v: 2, t: "gc.check_task", id: "first", ts: 3, p: {} }));
    const second = session.handleMessage(JSON.stringify({ v: 2, t: "trace.head", id: "second", ts: 4, p: {} }));
    await started;
    expect(order).toEqual(["fetch", "first"]);
    expect(socket.sent.filter((frame) => frame.t === "res")).toEqual([]);
    finishRpc();
    await Promise.all([first, second]);
    expect(order).toEqual(["fetch", "first", "first:done", "second", "second:done"]);
    expect(socket.sent.filter((frame) => frame.t === "res").map((frame) => frame.re)).toEqual(["first", "second"]);
    finishFetch({ ok: true, head: 3 });
    await Promise.resolve();
    expect(socket.lastOfType("res")).toMatchObject({ re: "fetch", p: { ok: true, head: 3 } });
    session.handleSocketClose();
  });

  it("answers a failed reliable frame using its seq and logs no exception content", async () => {
    const h = harness({
      heartbeat: () => { throw new Error("sensitive payload"); },
    });
    await handshake(h);
    const lines = await captureWarnings(() =>
      h.session.handleMessage(JSON.stringify({ v: 2, t: "hb", seq: 17, ts: 2, p: {} })),
    );

    expect(h.socket.lastOfType("res")).toMatchObject({
      re: "17",
      p: { ok: false, code: "server_error", retryable: true },
    });
    expect(h.frames.at(-1)).toMatchObject({ type: "hb", errorCode: "server_error" });
    expect(JSON.parse(lines[0]!)).toMatchObject({
      session_id: "dws_test",
      frame_type: "hb",
      direction: "uplink",
      error_class: "Error",
    });
    expect(lines[0]).not.toContain("sensitive payload");
  });

  it("closes 4001 when the handshake itself throws, since there is no id to answer through", async () => {
    const socket = new FakeDaemonSocket();
    const registry = new DaemonSessionRegistry();
    const clock = new ManualDaemonProtocolClock();
    const session = new DaemonProtocolSession({
      sessionId: "dws_throw",
      socket,
      registry,
      serverVersion: "0.2.83",
      clock,
      authorizeRuntime: async () => {
        throw new Error("store unavailable");
      },
    });
    await captureWarnings(() => session.handleMessage(JSON.stringify({
      v: 2, t: "hello", ts: 1,
      p: helloPayload(),
    })));
    expect(session.isClosed).toBe(true);
    expect(socket.closed[0]!.code).toBe(DAEMON_PROTOCOL_CLOSE_CODES.server_closing);
    expect(socket.lastOfType("welcome")).toBeNull();
    expect(registry.size).toBe(0);
    expect(registry.daemonIdForRuntime("rt_one")).toBeNull();
  });

  it("rolls the registration back when onHello throws, so the daemon can just reconnect", async () => {
    const registry = new DaemonSessionRegistry();
    const socket = new FakeDaemonSocket();
    const session = new DaemonProtocolSession({
      sessionId: "dws_onhello",
      socket,
      registry,
      serverVersion: "0.2.83",
      clock: new ManualDaemonProtocolClock(),
      authorizeRuntime: async (_daemonId, runtimeId) => ({ runtimeId, ok: true, scope: "daemon" }),
      onHello: () => {
        throw new Error("onHello failed");
      },
    });

    await captureWarnings(() => session.handleMessage(JSON.stringify({
      v: 2, t: "hello", ts: 1, p: helloPayload(),
    })));

    // The whole registration is one transaction: nothing may stay registered for
    // a session the daemon was never told about.
    expect(session.isClosed).toBe(true);
    expect(session.isHandshakeComplete).toBe(false);
    expect(socket.closed.map(({ code }) => code)).toEqual([4001]);
    expect(socket.lastOfType("welcome")).toBeNull();
    expect(registry.size).toBe(0);
    expect(registry.daemonIdForRuntime("rt_one")).toBeNull();

    // The same daemon reconnecting is not blocked by a ghost entry, and neither
    // is another daemon's registration.
    const retrySocket = new FakeDaemonSocket();
    const retry = new DaemonProtocolSession({
      sessionId: "dws_onhello_retry",
      socket: retrySocket,
      registry,
      serverVersion: "0.2.83",
      clock: new ManualDaemonProtocolClock(),
      authorizeRuntime: async (_daemonId, runtimeId) => ({ runtimeId, ok: true, scope: "daemon" }),
    });
    await retry.handleMessage(JSON.stringify({ v: 2, t: "hello", ts: 2, p: helloPayload() }));
    expect(retry.isHandshakeComplete).toBe(true);
    expect(retrySocket.lastOfType("welcome")).not.toBeNull();
    expect(registry.get("dmn_test")).toBe(retry);

    const otherSocket = new FakeDaemonSocket();
    const other = new DaemonProtocolSession({
      sessionId: "dws_other",
      socket: otherSocket,
      registry,
      serverVersion: "0.2.83",
      clock: new ManualDaemonProtocolClock(),
      authorizeRuntime: async (_daemonId, runtimeId) => ({ runtimeId, ok: true, scope: "daemon" }),
    });
    await other.handleMessage(JSON.stringify({
      v: 2,
      t: "hello",
      ts: 3,
      p: helloPayload({
        daemon_id: "dmn_other",
        runtimes: [{ runtime_id: "rt_other", provider: "codex", max_concurrency: 1, active_task_ids: [] }],
      }),
    }));
    expect(otherSocket.lastOfType("welcome")).not.toBeNull();
    expect(registry.daemonIdForRuntime("rt_other")).toBe("dmn_other");
  });

  it("rolls back and closes 4001 when traceHeads throws while building welcome", async () => {
    const registry = new DaemonSessionRegistry();
    const socket = new FakeDaemonSocket();
    const session = new DaemonProtocolSession({
      sessionId: "dws_trace_heads",
      socket,
      registry,
      serverVersion: "0.2.83",
      clock: new ManualDaemonProtocolClock(),
      authorizeRuntime: async (_daemonId, runtimeId) => ({ runtimeId, ok: true, scope: "daemon" }),
      traceHeads: () => {
        throw new Error("trace store unavailable");
      },
    });

    await captureWarnings(() => session.handleMessage(JSON.stringify({
      v: 2, t: "hello", ts: 1, p: helloPayload(),
    })));

    expect(socket.closed.map(({ code }) => code)).toEqual([4001]);
    expect(socket.lastOfType("welcome")).toBeNull();
    expect(session.isHandshakeComplete).toBe(false);
    expect(registry.size).toBe(0);
    expect(registry.daemonIdForRuntime("rt_one")).toBeNull();
  });

  it("rolls back and closes 4001 when registry.register throws after indexing", async () => {
    const registry = new DaemonSessionRegistry();
    const register = registry.register.bind(registry);
    registry.register = (session) => {
      register(session);
      throw new Error("registry failed after indexing");
    };
    const socket = new FakeDaemonSocket();
    const session = new DaemonProtocolSession({
      sessionId: "dws_register_failure",
      socket,
      registry,
      serverVersion: "0.2.83",
      clock: new ManualDaemonProtocolClock(),
      authorizeRuntime: async (_daemonId, runtimeId) => ({ runtimeId, ok: true, scope: "daemon" }),
    });

    await captureWarnings(() => session.handleMessage(JSON.stringify({
      v: 2, t: "hello", ts: 1, p: helloPayload(),
    })));

    expect(socket.closed.map(({ code }) => code)).toEqual([4001]);
    expect(socket.lastOfType("welcome")).toBeNull();
    expect(session.isHandshakeComplete).toBe(false);
    expect(registry.size).toBe(0);
    expect(registry.daemonIdForRuntime("rt_one")).toBeNull();
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
