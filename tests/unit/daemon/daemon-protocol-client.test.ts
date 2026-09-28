import { afterEach, describe, expect, it } from "bun:test";
import {
  DAEMON_FRAME_MAX_BYTES, DAEMON_HEARTBEAT_INTERVAL_MS, DAEMON_SEND_PAUSE_BYTES,
  DAEMON_SEND_RESUME_BYTES, DAEMON_TERMINAL_CLOSE_CODES,
} from "@multiremi/contracts/daemon-protocol.js";
import { ManualDaemonProtocolClock } from "@multiremi/api/daemon-protocol/clock.js";
import { encodeDaemonProtocolFrame } from "@multiremi/api/daemon-protocol/frames.js";
import {
  DaemonProtocolClient, DaemonProtocolRpcError, daemonProtocolUrl,
  type DaemonProtocolClientOptions, type DaemonProtocolLane, type DaemonProtocolSocketLike,
} from "@multiremi/worker/daemon-protocol-client.js";

class Socket implements DaemonProtocolSocketLike {
  bufferedAmount = 0;
  closed = false;
  readonly sent: Record<string, any>[] = [];
  readonly text: string[] = [];
  readonly listeners = new Map<string, Set<(event: any) => void>>();
  send(data: string): void { this.text.push(data); this.sent.push(JSON.parse(data)); }
  close(): void { this.closed = true; }
  addEventListener(type: string, listener: (event: any) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: (event: any) => void): void { this.listeners.get(type)?.delete(listener); }
  emit(type: string, event: any = {}): void { for (const listener of [...this.listeners.get(type) ?? []]) listener(event); }
  frame(frame: Record<string, unknown>): void { this.emit("message", { data: JSON.stringify({ v: 2, ts: 1, ...frame }) }); }
  handshake(): void {
    this.emit("open");
    this.frame({ t: "welcome", p: { protocol: 2, session_id: "session-unit", hb_interval_ms: 15_000 } });
    this.answerHeartbeat();
  }
  answerHeartbeat(): void {
    const hb = this.sent.findLast(frame => frame.t === "hb");
    if (hb) this.frame({ t: "res", re: hb.id, p: { ok: true, runtime_acks: [] } });
  }
}

const clients: DaemonProtocolClient[] = [];
function bed(options: Partial<DaemonProtocolClientOptions> = {}) {
  const clock = new ManualDaemonProtocolClock();
  const sockets: Socket[] = [];
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  const errors: Error[] = [];
  const logs: string[] = [];
  const terminal: number[] = [];
  let probes = 0;
  const lane: DaemonProtocolLane = {
    runtime: () => ({ runtime_id: "rt_unit", provider: "claude", max_concurrency: 2, active_task_ids: [] }),
    heartbeat: () => ({ active_task_count: 1, outbox: { pending: 3, unacked: 2 }, drain_ack_generation: 4 }),
    onHeartbeatAck: async () => {}, probeUpgrade: async () => { probes++; },
    onTerminal: async code => { terminal.push(code); },
  };
  const client = new DaemonProtocolClient({
    serverUrl: "https://api.example", daemonId: "dmn_unit", cliVersion: "0.2.83", clock,
    random: () => 0.5, log: { warn: line => logs.push(line) }, onError: error => errors.push(error),
    connect: (url, init) => { urls.push(url); headers.push(init.headers); const socket = new Socket(); sockets.push(socket); return socket; },
    ...options,
  });
  clients.push(client);
  client.addLane(lane);
  client.startLane(lane);
  return { client, clock, sockets, urls, headers, errors, logs, terminal, lane, probes: () => probes };
}

afterEach(async () => {
  for (const client of clients.splice(0)) { client.close(); await client.drain(); }
});

describe("daemon protocol v2 client", () => {
  it("sends the daemon token in an Authorization header, not in the URL", () => {
    const b = bed({ token: "test-daemon-credential" });
    expect(b.headers).toEqual([{ Authorization: "Bearer test-daemon-credential" }]);
    expect(b.urls[0]).not.toContain("test-daemon-credential");
    expect(daemonProtocolUrl("http://127.0.0.1:6120")).toBe("ws://127.0.0.1:6120/api/daemon/ws?protocol=2");
  });

  it("reports connecting until the protocol welcome completes the handshake", () => {
    const b = bed();
    expect(b.client.connectionState()).toBe("connecting");
    b.sockets[0]!.emit("open");
    expect(b.client.connectionState()).toBe("connecting");
    b.sockets[0]!.handshake();
    expect(b.client.connectionState()).toBe("connected");
  });

  it("does not reconnect during authority suspension and starts again after an explicit restart", () => {
    const b = bed();
    b.sockets[0]!.handshake();
    b.client.suspendAuthority();
    b.clock.advance(60_000);
    expect(b.client.connectionState()).toBe("terminal");
    expect(b.sockets).toHaveLength(1);
    b.client.stopLane(b.lane);
    b.client.startLane(b.lane);
    expect(b.sockets).toHaveLength(2);
    b.sockets[1]!.handshake();
    expect(b.client.connectionState()).toBe("connected");
  });

  it("ignores a superseded socket close after a runtime change", () => {
    const b = bed();
    b.sockets[0]!.handshake();
    const lateClose = [...b.sockets[0]!.listeners.get("close")!][0]!;
    b.client.runtimesChanged();
    b.sockets[1]!.handshake();
    lateClose({ code: 4001 });
    expect(b.client.connectionState()).toBe("connected");
    b.clock.advance(5_000);
    expect(b.sockets).toHaveLength(2);
  });

  it("spreads reconnects with jitter instead of a fixed first delay", () => {
    const low = bed({ random: () => 0 });
    const high = bed({ random: () => 1 });
    low.sockets[0]!.emit("close", { code: 4001 });
    high.sockets[0]!.emit("close", { code: 4001 });
    low.clock.advance(800);
    high.clock.advance(800);
    expect(low.sockets).toHaveLength(2);
    expect(high.sockets).toHaveLength(1);
    high.clock.advance(400);
    expect(high.sockets).toHaveLength(2);
  });

  it("uses the protocol marker and advertises every co-resident runtime on one socket", async () => {
    expect(daemonProtocolUrl("https://api.example/base/?old=1")).toBe("wss://api.example/base/api/daemon/ws?protocol=2");
    const b = bed();
    const second: DaemonProtocolLane = { ...b.lane, runtime: () => ({ runtime_id: "rt_second", provider: "codex", max_concurrency: 1, active_task_ids: ["task-1"] }) };
    b.client.close();
    b.client.addLane(second);
    b.client.startLane(b.lane);
    b.client.startLane(second);
    b.sockets[1]!.handshake();
    expect(b.urls).toEqual(["wss://api.example/api/daemon/ws?protocol=2", "wss://api.example/api/daemon/ws?protocol=2"]);
    expect(b.sockets[1]!.sent[0]!.p.runtimes.map((rt: any) => rt.runtime_id)).toEqual(["rt_unit", "rt_second"]);
    expect(b.sockets[1]!.sent[1]!.p).toEqual({ active_task_count: 2, outbox: { pending: 6, unacked: 4 }, drain_ack_generation: 4 });
    b.client.stopLane(b.lane);
    expect(b.client.diagnostics().sockets).toBe(1);
    b.client.stopLane(second);
    await b.client.drain();
    expect(b.clock.pendingTimerCount).toBe(0);
  });

  it("sends heartbeat every 15 seconds and acknowledges independently of a blocked consumer and uplink pause", async () => {
    let unblock!: () => void;
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const b = bed({ onFrame: () => blocked });
    try {
      const socket = b.sockets[0]!;
      socket.handshake();
      socket.bufferedAmount = DAEMON_SEND_PAUSE_BYTES + 1;
      socket.frame({ t: "task.offer", seq: 1, rt: "rt_unit", p: { task_id: "task-1" } });
      b.clock.advance(100);
      expect(socket.sent.find(frame => frame.t === "ack")?.ack).toBe(1);
      expect(b.client.uplinkPaused()).toBe(true);
      b.clock.advance(DAEMON_HEARTBEAT_INTERVAL_MS - 101);
      expect(socket.sent.filter(frame => frame.t === "hb")).toHaveLength(1);
      b.clock.advance(1);
      expect(socket.sent.filter(frame => frame.t === "hb")).toHaveLength(2);
      socket.answerHeartbeat();
    } finally { unblock(); }
  });

  for (const code of [1000, 1001, 1006, 1011, 1012, 1013, 4000, 4001, 4002, 4999]) {
    it(`reconnects after nonterminal close ${code}`, () => {
      const b = bed();
      b.sockets[0]!.handshake();
      b.sockets[0]!.emit("close", { code });
      expect(b.client.connectionState()).toBe("disconnected");
      b.clock.advance(999);
      expect(b.sockets).toHaveLength(1);
      b.clock.advance(1);
      expect(b.sockets).toHaveLength(2);
    });
  }

  for (const code of DAEMON_TERMINAL_CLOSE_CODES) {
    it(`honors the contracts terminal close ${code}`, async () => {
      const b = bed();
      b.sockets[0]!.emit("close", { code });
      await b.client.drain();
      expect(b.client.connectionState()).toBe(code === 4426 ? "upgrade_wait" : "terminal");
      expect(b.terminal).toEqual(code === 4426 ? [] : [code]);
      b.clock.advance(30_000);
      expect(b.sockets).toHaveLength(1);
      expect(b.client.allowsClaims()).toBe(false);
    });
  }

  for (const status of [400, 404, 421, 429, 502, 503]) {
    it(`retries an HTTP ${status} upgrade rejection instead of treating it as authority loss`, async () => {
      const b = bed();
      b.sockets[0]!.emit("error", { status, code: "server_error" });
      await b.client.drain();
      expect(b.client.connectionState()).toBe("disconnected");
      expect(b.terminal).toEqual([]);
      expect(b.logs).toEqual([`daemon websocket upgrade failed (HTTP ${status}); retrying with backoff`]);
      b.clock.advance(1000);
      expect(b.sockets).toHaveLength(2);
    });
  }

  for (const [status, error, expected] of [[403, "daemon_token_required", 4403], [401, "unauthorized", 4401], [410, "daemon_retired", 4410], [403, "daemon_owner_membership_required", 4401]] as const) {
    it(`maps HTTP ${status} ${error} through the server authority mapper`, async () => {
      const b = bed();
      b.sockets[0]!.emit("error", { status, code: error });
      await b.client.drain();
      expect(b.client.connectionState()).toBe("terminal");
      expect(b.terminal).toEqual([expected]);
      b.clock.advance(60_000);
      expect(b.sockets).toHaveLength(1);
    });
  }

  for (const trigger of ["close", "ready", "http"] as const) {
    it(`enters upgrade_wait from ${trigger}, probes at 60-second boundaries and exposes health`, async () => {
      const b = bed();
      if (trigger === "close") {
        b.sockets[0]!.frame({ t: "reject", p: { min_protocol: 3 } });
        b.sockets[0]!.emit("close", { code: 4426 });
      } else if (trigger === "http") b.sockets[0]!.emit("error", { status: 426, min_version: 3 });
      else b.sockets[0]!.emit("message", { data: JSON.stringify({ type: "ready" }) });
      await b.client.drain();
      const min = trigger === "ready" ? 2 : 3;
      expect(b.client.health()).toEqual({ state: "rejected", server_min: min, self: 2, next_probe_at: new Date(1_060_000).toISOString() });
      expect(b.logs).toEqual([`daemon protocol rejected by server (min ${min}, self 2); waiting for pending_update, no tasks will be claimed`]);
      expect(b.client.allowsClaims()).toBe(false);
      b.clock.advance(59_999);
      expect(b.probes()).toBe(0);
      b.clock.advance(1);
      await b.client.drain();
      expect(b.probes()).toBe(1);
      b.clock.advance(60_000);
      await b.client.drain();
      expect(b.probes()).toBe(2);
      expect(b.sockets).toHaveLength(1);
      b.client.close();
      b.clock.advance(120_000);
      expect(b.probes()).toBe(2);
      expect(b.clock.pendingTimerCount).toBe(0);
    });
  }

  it("caps jittered backoff at 30 seconds and removes all old listeners and timers across 20 failures", async () => {
    const b = bed({ random: () => 1 });
    for (let round = 0; round < 20; round++) {
      const socket = b.sockets.at(-1)!;
      socket.emit("close", { code: 4001 });
      expect([...socket.listeners.values()].every(set => set.size === 0)).toBe(true);
      expect(socket.closed).toBe(true);
      expect(b.clock.pendingTimerCount).toBe(1);
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(round, 15) * 1.2);
      b.clock.advance(delay - 1);
      expect(b.sockets).toHaveLength(round + 1);
      b.clock.advance(1);
      expect(b.sockets).toHaveLength(round + 2);
    }
    b.client.close();
    await b.client.drain();
    expect(b.client.diagnostics()).toEqual({ timers: 0, sockets: 0, pending_rpcs: 0, background: 0 });
    expect(b.clock.pendingTimerCount).toBe(0);
    b.client.startLane(b.lane);
    expect(b.client.connectionState()).toBe("connecting");
  });

  it("logs only the upgrade-wait notice when rejection interrupts an in-flight heartbeat", async () => {
    const b = bed();
    const socket = b.sockets[0]!;
    socket.emit("open");
    socket.frame({ t: "welcome", p: { protocol: 2, session_id: "upgrade-pending-hb" } });
    expect(b.client.diagnostics().pending_rpcs).toBe(1);
    socket.emit("close", { code: 4426 });
    await b.client.drain();
    expect(b.logs).toEqual(["daemon protocol rejected by server (min 2, self 2); waiting for pending_update, no tasks will be claimed"]);
    expect(b.errors).toEqual([]);
    expect(b.client.diagnostics().pending_rpcs).toBe(0);
  });

  it("pairs out-of-order RPC responses and respects retryable flags, timeout and disconnect", async () => {
    const b = bed();
    const socket = b.sockets[0]!;
    socket.handshake();
    const first = b.client.rpc("plugin.desired", { n: 1 }, "rt_unit");
    const second = b.client.rpc("plugin.desired", { n: 2 }, "rt_unit");
    const [a, c] = socket.sent.slice(-2);
    socket.frame({ t: "res", re: c!.id, p: { ok: true, n: 2 } });
    socket.frame({ t: "res", re: a!.id, p: { ok: true, n: 1 } });
    expect(await first).toEqual({ ok: true, n: 1 });
    expect(await second).toEqual({ ok: true, n: 2 });
    for (const retryable of [true, false]) {
      const failed = b.client.rpc("plugin.desired", {}).catch(error => error);
      socket.frame({ t: "res", re: socket.sent.at(-1)!.id, p: { ok: false, code: "server_error", retryable } });
      expect(await failed).toMatchObject({ code: "server_error", retryable });
    }
    const timed = b.client.rpc("plugin.desired", {}, undefined, 500).catch(error => error);
    b.clock.advance(500);
    expect(await timed).toMatchObject({ code: "daemon_timeout", retryable: true });
    const cancelled = b.client.rpc("plugin.desired", {}).catch(error => error);
    socket.emit("close", { code: 4001 });
    expect(await cancelled).toMatchObject({ code: "daemon_unreachable", retryable: true });
  });

  it("checks encoded UTF-8 frame bytes before sending, including RPC and heartbeat", async () => {
    const b = bed();
    const socket = b.sockets[0]!;
    socket.handshake();
    const overhead = Buffer.byteLength(encodeDaemonProtocolFrame({ t: "test", p: { value: "" } }, b.clock.now()));
    b.client.send({ t: "test", p: { value: "x".repeat(DAEMON_FRAME_MAX_BYTES - overhead) } });
    expect(Buffer.byteLength(socket.text.at(-1)!)).toBe(DAEMON_FRAME_MAX_BYTES);
    const before = socket.sent.length;
    expect(() => b.client.send({ t: "test", p: { value: "x".repeat(DAEMON_FRAME_MAX_BYTES - overhead + 1) } })).toThrow(DaemonProtocolRpcError);
    await expect(b.client.rpc("plugin.desired", { value: "\u4e2d".repeat(DAEMON_FRAME_MAX_BYTES / 2) })).rejects.toMatchObject({ retryable: false });
    b.lane.heartbeat = () => ({ active_task_count: 0, outbox: { pending: "x".repeat(DAEMON_FRAME_MAX_BYTES) as any, unacked: 0 } });
    b.clock.advance(15_000);
    await b.client.drain();
    expect(socket.sent).toHaveLength(before);
    expect(b.errors.at(-1)).toMatchObject({ retryable: false });
    expect(b.client.diagnostics().pending_rpcs).toBe(0);
  });

  it("passes event receipts to the downlink handler without consuming unrelated RPCs", async () => {
    const received: Record<string, unknown>[] = [];
    const b = bed({ onFrame: frame => { received.push(frame.raw); } });
    const socket = b.sockets[0]!;
    socket.handshake();
    const rpc = b.client.rpc("plugin.desired", {});
    const id = socket.sent.at(-1)!.id;
    socket.frame({ t: "res", re: "73", p: { ok: false, code: "server_error", retryable: true } });
    socket.frame({ t: "res", re: id, p: { ok: true } });
    expect(await rpc).toEqual({ ok: true });
    await b.client.drain();
    expect(received).toEqual([expect.objectContaining({ t: "res", re: "73", p: { ok: false, code: "server_error", retryable: true } })]);
  });

  it("rejects an oversized hello locally without sending any frame", async () => {
    const b = bed();
    b.lane.runtime = () => ({ runtime_id: "rt_unit", provider: "claude", max_concurrency: 1, active_task_ids: ["x".repeat(DAEMON_FRAME_MAX_BYTES)] });
    b.client.runtimesChanged();
    const socket = b.sockets.at(-1)!;
    socket.emit("open");
    expect(socket.sent).toEqual([]);
    expect(b.errors).toEqual([expect.objectContaining({ code: "protocol_violation", retryable: false })]);
    expect(b.client.connectionState()).toBe("disconnected");
    expect(b.clock.pendingTimerCount).toBe(1);
  });

  it("aborts a stale upgrade inspection when stopped and ignores its eventual rejection", async () => {
    let signal!: AbortSignal;
    let rejectUpgrade!: (value: { status: number; code: string }) => void;
    const b = bed({ inspectUpgradeRejection: async (_url, _headers, currentSignal) => {
      signal = currentSignal;
      return await new Promise(resolve => { rejectUpgrade = resolve; });
    } });
    b.sockets[0]!.emit("error", {});
    expect(signal.aborted).toBe(false);
    b.client.close();
    expect(signal.aborted).toBe(true);
    rejectUpgrade({ status: 403, code: "daemon_token_required" });
    await b.client.drain();
    expect(b.client.connectionState()).toBe("stopped");
    expect(b.terminal).toEqual([]);
    expect(b.clock.pendingTimerCount).toBe(0);
  });

  it("exposes backpressure hysteresis and entity dedupe across reconnects", () => {
    let pauses = 0, resumes = 0;
    const b = bed({ onPause: () => { pauses++; }, onResume: () => { resumes++; } });
    const socket = b.sockets[0]!;
    socket.handshake();
    socket.bufferedAmount = DAEMON_SEND_PAUSE_BYTES;
    b.client.checkBackpressure();
    expect(pauses).toBe(0);
    socket.bufferedAmount++;
    b.client.checkBackpressure();
    b.client.checkBackpressure();
    expect(pauses).toBe(1);
    socket.bufferedAmount = DAEMON_SEND_RESUME_BYTES;
    b.clock.advance(100);
    expect(resumes).toBe(0);
    socket.bufferedAmount--;
    b.clock.advance(100);
    expect(resumes).toBe(1);
    expect(b.client.dedupe.claim("task.offer", "task-1")).toBe(true);
    expect(b.client.dedupe.claim("task.offer", "task-1")).toBe(false);
    expect(b.client.dedupe.claim("runtime.command", "task-1")).toBe(true);
    b.client.runtimesChanged();
    expect(b.client.dedupe.claim("task.offer", "task-1")).toBe(false);
    b.client.dedupe.release("task.offer", "task-1");
    expect(b.client.dedupe.claim("task.offer", "task-1")).toBe(true);
  });
});
