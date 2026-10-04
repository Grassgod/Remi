import { randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  DAEMON_ACK_TIMEOUT_MS,
  DAEMON_FRAME_MAX_BYTES,
  DAEMON_HEARTBEAT_INTERVAL_MS,
  DAEMON_MIN_CLI_VERSION,
  DAEMON_PROTOCOL_CLOSE_CODES,
  DAEMON_PROTOCOL_MIN,
  DAEMON_PROTOCOL_VERSION,
  DAEMON_RECONNECT_BASE_MS,
  DAEMON_RECONNECT_MAX_MS,
  DAEMON_SEND_PAUSE_BYTES,
  DAEMON_SEND_RESUME_BYTES,
  DAEMON_UPGRADE_PROBE_INTERVAL_MS,
  daemonCloseCodeIsRetryable,
  daemonCloseCodeRequiresUpgrade,
  compareDaemonCliVersion,
  type DaemonHeartbeatPayload,
  type DaemonHelloPayload,
  type DaemonHelloRuntime,
  type DaemonProtocolCap,
  type DaemonWelcomePayload,
  type DaemonGcErrorReply,
} from "@multiremi/contracts/daemon-protocol.js";
import type { MultiremiDaemonHeartbeatAck, MultiremiDaemonSshMeshStatus } from "@multiremi/contracts/types.js";
import { daemonAuthorizationCloseCode } from "../api/daemon-protocol/session.js";
import { systemClock, type DaemonProtocolClock, type DaemonProtocolTimer } from "../api/daemon-protocol/clock.js";
import {
  encodeDaemonProtocolFrame,
  parseDaemonProtocolFrame,
  type DaemonOutboundFrame,
  type DaemonParsedFrame,
} from "../api/daemon-protocol/frames.js";

export interface DaemonProtocolSocketLike {
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
}

export type DaemonProtocolConnect = (url: string, init: { headers: Record<string, string> }) => DaemonProtocolSocketLike;
export type DaemonProtocolClientState = "disconnected" | "connecting" | "connected" | "upgrade_wait" | "terminal" | "stopped";

/** A provider lane contributes to the single process connection. */
export interface DaemonProtocolLane {
  runtime(): DaemonHelloRuntime | null;
  heartbeat(): DaemonHeartbeatPayload & {
    ssh_mesh_protocol?: number;
    ssh_mesh_status?: MultiremiDaemonSshMeshStatus;
  };
  onHeartbeatAck(ack: MultiremiDaemonHeartbeatAck): Promise<void>;
  probeUpgrade(): Promise<void>;
  onTerminal(code: number): Promise<void>;
  onStateChange?(): void;
  onConnected?(): void;
  readyToConnect?(): boolean;
}

export interface DaemonProtocolClientOptions {
  serverUrl: string;
  token?: string | null;
  daemonId: string;
  cliVersion: string;
  launchedBy?: string | null;
  caps?: DaemonProtocolCap[];
  connect?: DaemonProtocolConnect;
  clock?: DaemonProtocolClock;
  random?: () => number;
  log?: { warn(message: string): void };
  onError?: (error: Error) => void;
  onFrame?: (frame: DaemonParsedFrame) => void | Promise<void>;
  onWelcome?: (welcome: DaemonWelcomePayload) => void;
  onPause?: () => void;
  onResume?: () => void;
  inspectUpgradeRejection?: typeof inspectDaemonUpgradeRejection;
}

export class DaemonProtocolRpcError extends Error {
  readonly detail?: string;
  readonly operationError?: DaemonGcErrorReply["operation_error"];
  constructor(readonly code: string, readonly retryable: boolean,
    detailOrOperationError?: string | DaemonGcErrorReply["operation_error"],
    readonly httpStatus?: number, readonly httpCode?: string | null) {
    super(`daemon RPC failed: ${code}`);
    this.detail = typeof detailOrOperationError === "string" ? detailOrOperationError : undefined;
    this.operationError = typeof detailOrOperationError === "object" ? detailOrOperationError : undefined;
  }
}

/** Entity keys survive reconnects; failed handlers release their key for replay. */
export class DaemonDownlinkDedupe {
  private readonly entities = new Map<string, Set<string>>();

  claim(type: string, entityId: string): boolean {
    let ids = this.entities.get(type);
    if (!ids) this.entities.set(type, ids = new Set());
    if (ids.has(entityId)) return false;
    ids.add(entityId);
    return true;
  }

  release(type: string, entityId: string): void {
    this.entities.get(type)?.delete(entityId);
  }

  clear(): void { this.entities.clear(); }
}

interface PendingRpc {
  timer: DaemonProtocolTimer;
  resolve(payload: Record<string, unknown>): void;
  reject(error: Error): void;
}

export function daemonProtocolUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/daemon/ws`;
  url.search = "?protocol=2";
  url.hash = "";
  return url.toString();
}

export class DaemonProtocolClient {
  readonly dedupe = new DaemonDownlinkDedupe();
  private readonly clock: DaemonProtocolClock;
  private readonly lanes = new Set<DaemonProtocolLane>();
  private readonly activeLanes = new Set<DaemonProtocolLane>();
  private readonly background = new Set<Promise<unknown>>();
  private readonly laneWork = new Map<DaemonProtocolLane, Promise<void>>();
  private readonly pending = new Map<string, PendingRpc>();
  private readonly frameHandlers = new Map<string, Set<(frame: DaemonParsedFrame) => void | Promise<void>>>();
  private readonly frameListeners = new Set<(frame: DaemonParsedFrame) => void | Promise<void>>();
  private readonly welcomeListeners = new Set<(welcome: DaemonWelcomePayload) => void>();
  private readonly timers = new Set<DaemonProtocolTimer>();
  private socket: DaemonProtocolSocketLike | null = null;
  private listeners: Array<[string, (event: any) => void]> = [];
  private state: DaemonProtocolClientState = "stopped";
  private generation = 0;
  private attempts = 0;
  private receivedSeq = 0;
  private sentAck = 0;
  private ackTimer: DaemonProtocolTimer | null = null;
  private hbTimer: DaemonProtocolTimer | null = null;
  private handshakeTimer: DaemonProtocolTimer | null = null;
  private probeInFlight = false;
  private paused = false;
  private serverMin = DAEMON_PROTOCOL_MIN;
  private serverMinCli: string | null = null;
  private nextProbeAt: number | null = null;
  private upgradeAbort: AbortController | null = null;
  private advertised: Array<{ lane: DaemonProtocolLane; runtimeId: string }> = [];

  constructor(private readonly options: DaemonProtocolClientOptions) {
    this.clock = options.clock ?? systemClock;
  }

  addLane(lane: DaemonProtocolLane): void { this.lanes.add(lane); }

  registerFrameHandler(type: string, handler: (frame: DaemonParsedFrame) => void | Promise<void>): void {
    let handlers = this.frameHandlers.get(type);
    if (!handlers) this.frameHandlers.set(type, handlers = new Set());
    handlers.add(handler);
  }

  onFrame(listener: (frame: DaemonParsedFrame) => void | Promise<void>): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onWelcome(listener: (welcome: DaemonWelcomePayload) => void): () => void {
    this.welcomeListeners.add(listener);
    return () => this.welcomeListeners.delete(listener);
  }

  startLane(lane: DaemonProtocolLane): void {
    this.activeLanes.add(lane);
    if (this.state === "disconnected" && this.attempts === 0 && !this.socket) { this.connect(); return; }
    if (this.state !== "stopped") return;
    this.attempts = 0;
    this.transition("disconnected");
    this.connect();
  }

  stopLane(lane: DaemonProtocolLane): void {
    this.activeLanes.delete(lane);
    if (!this.activeLanes.size) this.close();
  }

  /** hello is once per connection: a registration change requires a new socket. */
  runtimesChanged(): void {
    if (this.state !== "connected" && this.state !== "connecting") return;
    this.disconnectSocket();
    this.transition("disconnected");
    this.connect();
  }

  allowsClaims(): boolean { return this.state !== "upgrade_wait" && this.state !== "terminal"; }
  connectionState(): DaemonProtocolClientState { return this.state; }
  uplinkPaused(): boolean { return this.paused; }

  health(): { state: string; server_min: number; self: number; next_probe_at: string | null } {
    return {
      state: this.state === "upgrade_wait" ? "rejected" : this.state === "connected" ? "ok" : this.state,
      server_min: this.serverMin,
      self: DAEMON_PROTOCOL_VERSION,
      next_probe_at: this.nextProbeAt === null ? null : new Date(this.nextProbeAt).toISOString(),
    };
  }

  diagnostics(): { timers: number; sockets: number; pending_rpcs: number; background: number } {
    return { timers: this.timers.size, sockets: this.socket ? 1 : 0, pending_rpcs: this.pending.size, background: this.background.size };
  }

  async drain(): Promise<void> {
    while (this.background.size) await Promise.allSettled([...this.background]);
  }

  close(): void {
    this.transition("stopped");
    this.nextProbeAt = null;
    this.disconnectSocket();
  }

  suspendAuthority(): void {
    this.disconnectSocket();
    this.nextProbeAt = null;
    this.transition("terminal");
  }

  /** Callers own retries; retryable errors preserve the peer's explicit flag. */
  rpc(type: string, payload: unknown, runtimeId?: string, timeoutMs = 10_000): Promise<Record<string, unknown>> {
    const id = randomUUID();
    return this.exchange({ t: type, id, ...(runtimeId ? { rt: runtimeId } : {}), p: payload }, id, timeoutMs);
  }

  /** Reliable uplink acknowledgements address the durable outbox id. */
  event(frame: DaemonOutboundFrame & { seq: number }): Promise<Record<string, unknown>> {
    return this.exchange(frame, String(frame.seq), DAEMON_ACK_TIMEOUT_MS);
  }

  private exchange(frame: DaemonOutboundFrame, key: string, timeoutMs: number): Promise<Record<string, unknown>> {
    if (this.state !== "connected") return Promise.reject(new DaemonProtocolRpcError("daemon_unreachable", true));
    return new Promise((resolve, reject) => {
      const timer = this.schedule(() => {
        this.pending.delete(key);
        reject(new DaemonProtocolRpcError("daemon_timeout", true));
      }, timeoutMs);
      this.pending.set(key, { timer, resolve, reject });
      try {
        this.send(frame);
      } catch (error) {
        this.cancel(timer);
        this.pending.delete(key);
        reject(error);
      }
    });
  }

  /** Shared encoding guard also covers hello, heartbeat, RPC, res and ack. */
  send(frame: DaemonOutboundFrame): void {
    const text = encodeDaemonProtocolFrame({ ...frame, ...(this.receivedSeq ? { ack: this.receivedSeq } : {}) }, this.clock.now());
    if (Buffer.byteLength(text, "utf8") > DAEMON_FRAME_MAX_BYTES) {
      throw new DaemonProtocolRpcError("protocol_violation", false);
    }
    if (!this.socket) throw new DaemonProtocolRpcError("daemon_unreachable", true);
    this.socket.send(text);
    this.sentAck = this.receivedSeq;
    this.checkBackpressure();
  }

  checkBackpressure(): void {
    const bytes = this.socket?.bufferedAmount ?? 0;
    if (!this.paused && bytes > DAEMON_SEND_PAUSE_BYTES) {
      this.paused = true;
      this.options.onPause?.();
    } else if (this.paused && bytes < DAEMON_SEND_RESUME_BYTES) {
      this.paused = false;
      this.options.onResume?.();
    }
  }

  private connect(): void {
    if (!this.activeLanes.size || this.state === "upgrade_wait" || this.state === "terminal" || this.state === "stopped") return;
    if ([...this.lanes].some(lane => lane.readyToConnect?.() === false)) return;
    const runtimes: DaemonHelloRuntime[] = [];
    this.advertised = [];
    for (const lane of this.lanes) {
      const runtime = lane.runtime();
      if (!runtime) continue;
      runtimes.push(runtime);
      this.advertised.push({ lane, runtimeId: runtime.runtime_id });
    }
    if (!runtimes.length) return;
    const hello: DaemonHelloPayload = {
      protocol: DAEMON_PROTOCOL_VERSION,
      daemon_id: this.options.daemonId,
      cli_version: this.options.cliVersion,
      launched_by: this.options.launchedBy ?? null,
      runtimes,
      caps: this.options.caps ?? [],
    };
    const url = daemonProtocolUrl(this.options.serverUrl);
    const headers: Record<string, string> = this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {};
    const generation = ++this.generation;
    this.transition("connecting");
    try {
      const socket = (this.options.connect ?? ((target, init) => new WebSocket(target, init as never)))(url, { headers });
      this.socket = socket;
      let inspecting = false;
      const listen = (type: string, handler: (event: any) => void) => {
        const guarded = (event: any) => { if (this.socket === socket && this.generation === generation) handler(event); };
        socket.addEventListener(type, guarded);
        this.listeners.push([type, guarded]);
      };
      this.handshakeTimer = this.schedule(() => this.disconnected(DAEMON_PROTOCOL_CLOSE_CODES.ack_timeout), DAEMON_ACK_TIMEOUT_MS);
      listen("open", () => {
        try { this.send({ t: "hello", p: hello }); }
        catch (error) { this.report(error); this.disconnected(4002); }
      });
      listen("message", (event) => {
        this.receive(String(event.data));
      });
      listen("error", (event) => {
        if (this.state !== "connecting") { this.disconnected(1006); return; }
        if (inspecting) return;
        inspecting = true;
        this.upgradeAbort = new AbortController();
        this.track((async () => {
          let refusal: { status: number; code: string | null; minProtocol?: number } | null = null;
          try {
            refusal = typeof event.status === "number"
              ? { status: event.status, code: event.code ?? null, minProtocol: event.min_version }
              : await (this.options.inspectUpgradeRejection ?? inspectDaemonUpgradeRejection)(url, headers, this.upgradeAbort!.signal);
          } catch { /* Network failures retain the default reconnect policy. */ }
          if (generation !== this.generation || this.socket !== socket) return;
          const code = refusal?.status === 426
            ? DAEMON_PROTOCOL_CLOSE_CODES.protocol_upgrade_required
            : refusal && [401, 403, 410].includes(refusal.status)
              ? daemonAuthorizationCloseCode(refusal.status, refusal.code)
              : 1006;
          if (refusal?.status === 426 && typeof refusal.minProtocol === "number") this.serverMin = refusal.minProtocol;
          if (code === 1006) this.options.log?.warn(`daemon websocket upgrade failed (${refusal ? `HTTP ${refusal.status}` : "network error"}); retrying with backoff`);
          this.disconnected(code);
        })());
      });
      listen("close", (event) => { if (!inspecting) this.disconnected(typeof event.code === "number" ? event.code : 1006); });
    } catch {
      this.disconnected(1006);
    }
  }

  private receive(text: string): void {
    let legacy: unknown;
    try { legacy = JSON.parse(text); } catch { this.disconnected(4002); return; }
    if ((legacy as { type?: string } | null)?.type === "ready") { this.enterUpgradeWait(); return; }
    const parsed = parseDaemonProtocolFrame(text);
    if (!parsed.ok || parsed.frame.v !== DAEMON_PROTOCOL_VERSION) { this.disconnected(4002); return; }
    const frame = parsed.frame;
    if (frame.type === "reject") {
      if (typeof frame.payload.min_protocol === "number") this.serverMin = frame.payload.min_protocol;
      if (typeof frame.payload.min_cli_version === "string") this.serverMinCli = frame.payload.min_cli_version;
      return;
    }
    if (frame.type === "welcome" && this.state === "connecting") {
      if (frame.payload.protocol !== DAEMON_PROTOCOL_VERSION || !frame.payload.session_id) { this.disconnected(4002); return; }
      // A v2 envelope alone does not prove the server understands turn payloads.
      // Production welcomes always advertise the payload release gate.
      if (typeof frame.payload.min_cli_version === "string") {
        this.serverMinCli = frame.payload.min_cli_version;
        if (compareDaemonCliVersion(this.serverMinCli, DAEMON_MIN_CLI_VERSION) < 0) {
          this.enterUpgradeWait();
          return;
        }
      } else {
        this.enterUpgradeWait();
        return;
      }
      this.attempts = 0;
      if (this.handshakeTimer !== null) this.cancel(this.handshakeTimer);
      this.handshakeTimer = null;
      this.transition("connected");
      this.options.onWelcome?.(frame.payload as unknown as DaemonWelcomePayload);
      for (const { lane } of this.advertised) lane.onConnected?.();
      for (const listener of this.welcomeListeners) listener(frame.payload as unknown as DaemonWelcomePayload);
      this.ackTick();
      this.heartbeatTick();
      return;
    }
    if (this.state !== "connected") { this.disconnected(4002); return; }
    if (frame.seq !== null) {
      if (frame.seq <= this.receivedSeq) return;
      if (frame.seq !== this.receivedSeq + 1) { this.disconnected(4002); return; }
      this.receivedSeq = frame.seq;
    }
    if (frame.type === "res" && frame.re) {
      const pending = this.pending.get(frame.re);
      if (pending) {
        this.pending.delete(frame.re);
        this.cancel(pending.timer);
        if (frame.payload.ok === false) {
          const operation = frame.payload.operation_error as Record<string, unknown> | null | undefined;
          const operationError = operation && typeof operation === "object" && typeof operation.status === "number"
            && Number.isInteger(operation.status) && operation.status >= 400 && operation.status <= 599
            && (operation.code === null || typeof operation.code === "string") && typeof operation.message === "string"
            ? operation as DaemonGcErrorReply["operation_error"] : undefined;
          pending.reject(new DaemonProtocolRpcError(String(frame.payload.code), frame.payload.retryable === true,
            operationError ?? (typeof frame.payload.message === "string" ? frame.payload.message : undefined),
            typeof frame.payload.http_status === "number" ? frame.payload.http_status : undefined,
            typeof frame.payload.http_code === "string" ? frame.payload.http_code : null));
        }
        else pending.resolve(frame.payload);
        return;
      }
    }
    if (this.options.onFrame) this.track(Promise.resolve().then(() => this.options.onFrame!(frame)).catch(error => this.report(error)));
    for (const handler of this.frameHandlers.get(frame.type) ?? []) {
      this.track(Promise.resolve().then(() => handler(frame)).catch(error => this.report(error)));
    }
    for (const listener of this.frameListeners) this.track(Promise.resolve().then(() => listener(frame)).catch(error => this.report(error)));
  }

  private heartbeatTick(): void {
    if (this.state !== "connected") return;
    if (this.hbTimer !== null) this.cancel(this.hbTimer);
    this.hbTimer = null;
    const advertised = [...this.advertised];
    const generation = this.generation;
    const payload: DaemonHeartbeatPayload = { active_task_count: 0, outbox: { pending: 0, unacked: 0 }, runtimes: [] };
    for (const { lane, runtimeId } of advertised) {
      const current = lane.heartbeat();
      const runtime = lane.runtime();
      if (runtime?.runtime_id === runtimeId) payload.runtimes!.push({
        runtime_id: runtimeId, capabilities: runtime.capabilities,
        ...(current.ssh_mesh_protocol === undefined ? {} : {
          ssh_mesh_protocol: current.ssh_mesh_protocol,
          ssh_mesh_status: current.ssh_mesh_status,
        }),
      });
      payload.active_task_count += current.active_task_count;
      payload.outbox!.pending += current.outbox?.pending ?? 0;
      payload.outbox!.unacked += current.outbox?.unacked ?? 0;
      if (current.drain_ack_generation !== undefined) {
        payload.drain_ack_generation = payload.drain_ack_generation === undefined
          ? current.drain_ack_generation : Math.min(payload.drain_ack_generation, current.drain_ack_generation);
      }
    }
    this.track(this.rpc("hb", payload).then(reply => {
      if (generation !== this.generation || this.state !== "connected") return;
      if (!Array.isArray(reply.runtime_acks)) return;
      for (const value of reply.runtime_acks) {
        const ack = value as MultiremiDaemonHeartbeatAck;
        const entry = advertised.find(item => item.runtimeId === ack.runtime_id);
        if (!entry || entry.lane.runtime()?.runtime_id !== entry.runtimeId) continue;
        this.queueLane(entry.lane, () => entry.lane.onHeartbeatAck(ack));
      }
    }).catch(error => {
      if (generation === this.generation && this.state === "connected") this.report(error);
    }));
    this.hbTimer = this.schedule(() => this.heartbeatTick(), DAEMON_HEARTBEAT_INTERVAL_MS);
  }

  sendHeartbeatNow(): void { this.heartbeatTick(); }

  private ackTick(): void {
    if (this.state !== "connected") return;
    try {
      if (this.receivedSeq > this.sentAck) this.send({ t: "ack" });
      this.checkBackpressure();
    } catch (error) { this.report(error); this.disconnected(1006); return; }
    this.ackTimer = this.schedule(() => this.ackTick(), 100);
  }

  private disconnected(code: number): void {
    this.disconnectSocket();
    if (this.state === "stopped") return;
    if (daemonCloseCodeRequiresUpgrade(code)) { this.enterUpgradeWait(); return; }
    if (!daemonCloseCodeIsRetryable(code)) {
      this.transition("terminal");
      for (const lane of this.lanes) this.queueLane(lane, () => lane.onTerminal(code));
      return;
    }
    this.transition("disconnected");
    const base = Math.min(DAEMON_RECONNECT_MAX_MS, DAEMON_RECONNECT_BASE_MS * 2 ** Math.min(this.attempts++, 15));
    const jitter = 0.8 + (this.options.random ?? Math.random)() * 0.4;
    this.schedule(() => this.connect(), Math.min(DAEMON_RECONNECT_MAX_MS, Math.max(1, Math.round(base * jitter))));
  }

  private enterUpgradeWait(): void {
    if (this.state === "upgrade_wait") return;
    this.disconnectSocket();
    this.transition("upgrade_wait");
    this.options.log?.warn(`daemon protocol rejected by server (min ${this.serverMinCli ?? this.serverMin}, self ${this.serverMinCli ? this.options.cliVersion : DAEMON_PROTOCOL_VERSION}); waiting for pending_update, no tasks will be claimed`);
    this.scheduleProbe();
  }

  private scheduleProbe(): void {
    if (this.state !== "upgrade_wait") return;
    this.nextProbeAt = this.clock.now() + DAEMON_UPGRADE_PROBE_INTERVAL_MS;
    this.schedule(() => {
      if (this.state !== "upgrade_wait") return;
      this.scheduleProbe();
      if (this.probeInFlight) return;
      this.probeInFlight = true;
      this.track(Promise.allSettled([...this.lanes].map(lane => lane.probeUpgrade())).finally(() => { this.probeInFlight = false; }));
    }, DAEMON_UPGRADE_PROBE_INTERVAL_MS);
  }

  private disconnectSocket(): void {
    ++this.generation;
    for (const timer of this.timers) this.clock.clearTimeout(timer);
    this.timers.clear();
    this.ackTimer = this.hbTimer = this.handshakeTimer = null;
    this.upgradeAbort?.abort();
    this.upgradeAbort = null;
    for (const pending of this.pending.values()) pending.reject(new DaemonProtocolRpcError("daemon_unreachable", true));
    this.pending.clear();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      for (const [type, handler] of this.listeners) socket.removeEventListener(type, handler);
      try { socket.close(); } catch { /* Already disconnected. */ }
    }
    this.listeners = [];
    this.receivedSeq = this.sentAck = 0;
    if (this.paused) { this.paused = false; this.options.onResume?.(); }
  }

  private transition(state: DaemonProtocolClientState): void {
    this.state = state;
    for (const lane of this.lanes) lane.onStateChange?.();
  }

  private schedule(handler: () => void, ms: number): DaemonProtocolTimer {
    const timer = this.clock.setTimeout(() => { this.timers.delete(timer); handler(); }, ms);
    this.timers.add(timer);
    (timer as ReturnType<typeof setTimeout>).unref?.();
    return timer;
  }

  private cancel(timer: DaemonProtocolTimer): void {
    this.clock.clearTimeout(timer);
    this.timers.delete(timer);
  }

  private queueLane(lane: DaemonProtocolLane, work: () => Promise<void>): void {
    const run = (this.laneWork.get(lane) ?? Promise.resolve()).then(work).catch(error => this.report(error));
    this.laneWork.set(lane, run);
    this.track(run.finally(() => { if (this.laneWork.get(lane) === run) this.laneWork.delete(lane); }));
  }

  private track<T>(run: Promise<T>): void {
    this.background.add(run);
    void run.finally(() => this.background.delete(run)).catch(() => {});
  }

  private report(error: unknown): void {
    // The peer's text may contain payload or credentials; only local error codes are logged.
    if (this.options.onError) this.options.onError(error instanceof Error ? error : new Error("daemon protocol client failed"));
    else this.options.log?.warn("daemon protocol client frame failed");
  }
}

/** Bun's error event hides the HTTP response. Inspect only after a failed upgrade. */
export function inspectDaemonUpgradeRejection(
  socketUrl: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<{ status: number; code: string | null; minProtocol?: number } | null> {
  const url = new URL(socketUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      headers: { ...headers, Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": randomBytes(16).toString("base64") },
      signal,
    });
    request.setTimeout(5_000, () => request.destroy(new Error("upgrade inspection timed out")));
    request.on("upgrade", (_response, socket) => { socket.destroy(); resolve(null); });
    request.on("response", response => {
      let body = "";
      response.on("data", chunk => {
        body += chunk.toString();
        if (body.length > 16_384) request.destroy(new Error("upgrade response too large"));
      });
      response.on("end", () => {
        let code: string | null = null;
        let minProtocol: number | undefined;
        try {
          const payload = JSON.parse(body);
          code = typeof payload.code === "string" ? payload.code : null;
          minProtocol = typeof payload.min_version === "number" ? payload.min_version : undefined;
        } catch { /* Status still carries authority facts. */ }
        resolve({ status: response.statusCode ?? 0, code, minProtocol });
      });
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end();
  });
}
