/**
 * Wake-up channel for the daemon poll loop.
 *
 * The control plane already publishes `daemon:task_available` on
 * `/api/daemon/ws` when a task is enqueued (see `api/realtime.ts`). This client
 * only consumes that one frame so an idle Runtime can back its claim polling off
 * to 30 seconds without adding task-start latency.
 *
 * It is deliberately an accelerator, never a control channel: no liveness,
 * heartbeat, or task state travels over it. When the socket cannot be
 * established — a proxy that drops `Upgrade`, an old server, a flapping
 * network — polling continues on its normal schedule and the heartbeat stays on
 * HTTP.
 */

/** Operator-visible state of the wake-up channel, mirrored into `/health`. */
export type DaemonWakeupState = "connected" | "connecting" | "disconnected" | "disabled";

export interface DaemonWakeupStatus {
  state: DaemonWakeupState;
  connected: boolean;
  runtime_id: string | null;
  connected_since: string | null;
  last_error: string | null;
  reconnect_attempts: number;
  next_reconnect_at: string | null;
  /** Reconnects are deliberately paused while this daemon's authority is revoked. */
  suspended: boolean;
}

export interface DaemonWakeupTransport {
  /** Point the transport at the current Runtime; reconnects when the id changes. */
  setRuntimeId(runtimeId: string | null): void;
  /**
   * Pause (or resume) reconnecting while the control plane rejects this
   * daemon's credential.
   *
   * A 401/403/410 means the handshake is refused too, so retrying every 30s is
   * pure noise. The authority probe reconnects once it restores the credential.
   */
  setAuthoritySuspended(suspended: boolean): void;
  close(): void;
  status(): DaemonWakeupStatus;
}

/** The subset of the WebSocket API this client uses, so tests can inject a fake. */
export interface DaemonWakeupSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
}

export type DaemonWakeupConnect = (
  url: string,
  init: { headers: Record<string, string> },
) => DaemonWakeupSocketLike;

export interface DaemonWakeupSocketOptions {
  serverUrl: string;
  token?: string | null;
  /** Called for every `daemon:task_available` frame. */
  onTaskAvailable: () => void;
  log?: {
    info(message: string): void;
    warn(message: string): void;
  };
  /** Injectable socket factory for tests. */
  connect?: DaemonWakeupConnect;
  pingIntervalMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /** Jitter source for the reconnect delay; injectable so tests stay exact. */
  random?: () => number;
}

const DEFAULT_PING_INTERVAL_MS = 30_000;
const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
/**
 * Fraction of a reconnect delay that is randomised.
 *
 * Without it, every daemon disconnected by the same server restart would come
 * back in lockstep. Jitter spreads the reconnect wave while the ceiling still
 * bounds how long a queued task can wait for the socket.
 */
const RECONNECT_JITTER_RATIO = 0.3;

/** `http(s)://host/base` → `ws(s)://host/base/api/daemon/ws?runtime_ids=<id>`. */
export function daemonWakeupUrl(serverUrl: string, runtimeId: string): string {
  const base = new URL(serverUrl);
  if (base.protocol === "https:") base.protocol = "wss:";
  else if (base.protocol === "http:") base.protocol = "ws:";
  else throw new Error(`unsupported daemon server URL protocol: ${base.protocol}`);
  const path = base.pathname.replace(/\/+$/, "");
  base.pathname = `${path}/api/daemon/ws`;
  base.search = `?runtime_ids=${encodeURIComponent(runtimeId)}`;
  base.hash = "";
  return base.toString();
}

export class DaemonWakeupSocket implements DaemonWakeupTransport {
  private readonly options: DaemonWakeupSocketOptions;
  private readonly pingIntervalMs: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly random: () => number;
  private socket: DaemonWakeupSocketLike | null = null;
  private runtimeId: string | null = null;
  private closed = false;
  private suspended = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs: number;
  private connected = false;
  private connectedAt: string | null = null;
  private lastError: string | null = null;
  private reconnectAttempts = 0;
  private nextReconnectAt: string | null = null;
  private state: DaemonWakeupState = "disabled";
  /** Consecutive failures already reported, so repeated identical warnings stay quiet. */
  private repeatedFailures = 0;

  constructor(options: DaemonWakeupSocketOptions) {
    this.options = options;
    this.pingIntervalMs = positive(options.pingIntervalMs, DEFAULT_PING_INTERVAL_MS);
    this.reconnectBaseMs = positive(options.reconnectBaseMs, DEFAULT_RECONNECT_BASE_MS);
    this.reconnectMaxMs = Math.max(this.reconnectBaseMs, positive(options.reconnectMaxMs, DEFAULT_RECONNECT_MAX_MS));
    this.random = options.random ?? Math.random;
    this.reconnectDelayMs = this.reconnectBaseMs;
  }

  setRuntimeId(runtimeId: string | null): void {
    if (this.closed) return;
    if (!runtimeId) {
      this.teardown();
      this.runtimeId = null;
      this.state = "disabled";
      return;
    }
    if (runtimeId === this.runtimeId && this.socket) return;
    this.runtimeId = runtimeId;
    // A new Runtime id invalidates the previous subscription, so reconnect
    // immediately instead of waiting out the current backoff.
    this.teardown();
    this.reconnectDelayMs = this.reconnectBaseMs;
    this.connectNow();
  }

  setAuthoritySuspended(suspended: boolean): void {
    if (this.closed) return;
    if (suspended === this.suspended) return;
    this.suspended = suspended;
    // Either way the socket on hand is unusable: while suspended the control
    // plane refuses the handshake, and once authority is restored the process
    // restarts with a fresh credential, so carrying the old socket across is
    // never correct.
    this.teardown();
    if (suspended) {
      // "disconnected" is the truthful word for it — there is no socket — and
      // `suspended` says the pause is deliberate rather than a broken Upgrade.
      this.state = "disconnected";
      this.lastError = "daemon authority was revoked; wake-up channel paused until the probe succeeds";
      return;
    }
    this.lastError = null;
    this.reconnectDelayMs = this.reconnectBaseMs;
    this.reconnectAttempts = 0;
    this.repeatedFailures = 0;
    if (this.runtimeId) this.connectNow();
  }

  close(): void {
    this.closed = true;
    this.teardown();
    this.runtimeId = null;
    this.state = "disabled";
  }

  status(): DaemonWakeupStatus {
    return {
      state: this.closed || !this.runtimeId ? "disabled" : this.state,
      // The open event is the only proof the control plane accepted the
      // handshake. A socket that merely exists is still `connecting`, and
      // calling that "connected" would hide exactly the failure this status
      // exists to expose.
      connected: this.connected,
      runtime_id: this.runtimeId,
      connected_since: this.connectedAt,
      last_error: this.lastError,
      reconnect_attempts: this.reconnectAttempts,
      next_reconnect_at: this.nextReconnectAt,
      suspended: this.suspended,
    };
  }

  private connectNow(): void {
    const runtimeId = this.runtimeId;
    if (this.closed || this.suspended || !runtimeId) return;
    let url: string;
    try {
      url = daemonWakeupUrl(this.options.serverUrl, runtimeId);
    } catch (error) {
      this.lastError = messageOf(error);
      this.options.log?.warn(`daemon wake-up channel disabled: ${this.lastError}`);
      return;
    }
    const headers: Record<string, string> = {};
    if (this.options.token) headers.Authorization = `Bearer ${this.options.token}`;
    let socket: DaemonWakeupSocketLike;
    try {
      socket = this.options.connect
        ? this.options.connect(url, { headers })
        : new WebSocket(url, { headers } as never) as unknown as DaemonWakeupSocketLike;
    } catch (error) {
      this.scheduleReconnect(messageOf(error) ?? "socket error");
      return;
    }
    this.socket = socket;
    this.state = "connecting";
    socket.addEventListener("open", () => {
      // A stale socket from a replaced Runtime id must not publish state or
      // start a ping loop for a connection nobody is tracking any more.
      if (this.socket !== socket || this.closed || this.suspended) return;
      this.connected = true;
      this.connectedAt = new Date().toISOString();
      this.reconnectDelayMs = this.reconnectBaseMs;
      this.reconnectAttempts = 0;
      this.repeatedFailures = 0;
      this.lastError = null;
      this.nextReconnectAt = null;
      this.state = "connected";
      this.options.log?.info(
        `daemon wake-up channel connected for ${runtimeId}; queued tasks are claimed immediately`,
      );
      this.startPing(socket);
    });
    socket.addEventListener("message", (event) => this.handleMessage(socket, event));
    socket.addEventListener("close", () => this.handleDisconnect(socket, "connection closed"));
    socket.addEventListener("error", (event) => this.handleDisconnect(socket, messageOf(event) ?? "socket error"));
  }

  private handleMessage(socket: DaemonWakeupSocketLike, event: unknown): void {
    if (this.socket !== socket || this.closed) return;
    const data = (event as { data?: unknown } | null)?.data;
    if (typeof data !== "string") return;
    let frame: { type?: unknown };
    try {
      frame = JSON.parse(data) as { type?: unknown };
    } catch {
      return;
    }
    if (frame.type !== "daemon:task_available") return;
    this.options.onTaskAvailable();
  }

  private handleDisconnect(socket: DaemonWakeupSocketLike, reason: string): void {
    // `teardown()` clears `this.socket` before closing it, so an event from the
    // socket that was already replaced must stop here. Otherwise it would
    // overwrite the state of the current socket and schedule a second reconnect.
    if (this.socket !== socket) return;
    this.teardown();
    if (this.closed || this.suspended || !this.runtimeId) return;
    this.scheduleReconnect(reason);
  }

  private scheduleReconnect(reason: string): void {
    if (this.closed || this.suspended || !this.runtimeId || this.reconnectTimer) return;
    this.lastError = reason;
    this.state = "disconnected";
    this.reconnectAttempts++;
    this.repeatedFailures++;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.reconnectMaxMs);
    const waitMs = jittered(delay, this.reconnectMaxMs, this.random);
    this.nextReconnectAt = new Date(Date.now() + waitMs).toISOString();
    // The first failure of a streak is the one an operator has to act on; the
    // rest repeat on an unchanged backoff and would otherwise fill the journal.
    if (this.repeatedFailures === 1 || this.repeatedFailures % 10 === 0) {
      const repeated = this.repeatedFailures === 1 ? "" : ` (${this.repeatedFailures} consecutive failures)`;
      this.options.log?.warn(
        `daemon wake-up channel unavailable${repeated}: ${reason}; task claims degrade to polling with up to 30s latency,`
          + ` next reconnect attempt at ${this.nextReconnectAt}`,
      );
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // The transport may have been suspended or retargeted while the timer was
      // pending; neither a new connect nor a stale one is safe here.
      if (this.closed || this.suspended) return;
      if (!this.runtimeId) return;
      this.connectNow();
    }, waitMs);
    this.reconnectTimer.unref?.();
  }

  private startPing(socket: DaemonWakeupSocketLike): void {
    this.stopPing();
    // Keeps an idle proxy from closing the socket while no tasks are queued.
    this.pingTimer = setInterval(() => {
      if (this.socket !== socket) return;
      try {
        socket.send(JSON.stringify({ type: "ping" }));
      } catch {
        this.handleDisconnect(socket, "ping failed");
      }
    }, this.pingIntervalMs);
    this.pingTimer.unref?.();
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private teardown(): void {
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    this.connectedAt = null;
    this.nextReconnectAt = null;
    if (socket && this.state === "connected") this.state = "disconnected";
    if (!socket) return;
    try {
      socket.close();
    } catch {
      // Already closed.
    }
  }
}

/** Spread a reconnect delay inside ±`RECONNECT_JITTER_RATIO`, never above the ceiling. */
function jittered(delayMs: number, maxMs: number, random: () => number): number {
  const spread = (random() - 0.5) * 2 * RECONNECT_JITTER_RATIO * delayMs;
  return Math.max(1, Math.min(maxMs, Math.round(delayMs + spread)));
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function messageOf(error: unknown): string | null {
  if (!error) return null;
  if (error instanceof Error) return error.message;
  const value = (error as { message?: unknown }).message;
  return typeof value === "string" ? value : String(error);
}
