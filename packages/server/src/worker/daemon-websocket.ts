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
}

export interface DaemonWakeupTransport {
  /** Point the transport at the current Runtime; reconnects when the id changes. */
  setRuntimeId(runtimeId: string | null): void;
  close(): void;
  status(): DaemonWakeupStatus;
}

/** The subset of the WebSocket API this client uses, so tests can inject a fake. */
export interface DaemonWakeupSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
}

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
  connect?: (url: string, init: { headers: Record<string, string> }) => DaemonWakeupSocketLike;
  pingIntervalMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

const DEFAULT_PING_INTERVAL_MS = 30_000;
const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;

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
  private socket: DaemonWakeupSocketLike | null = null;
  private runtimeId: string | null = null;
  private closed = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs: number;
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
    this.connectNow();
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
      connected: this.socket !== null,
      runtime_id: this.runtimeId,
      connected_since: this.connectedAt,
      last_error: this.lastError,
      reconnect_attempts: this.reconnectAttempts,
      next_reconnect_at: this.nextReconnectAt,
    };
  }

  private connectNow(): void {
    const runtimeId = this.runtimeId;
    if (this.closed || !runtimeId) return;
    let url: string;
    try {
      url = daemonWakeupUrl(this.options.serverUrl, runtimeId!);
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
      if (this.socket !== socket || this.closed) return;
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
    if (this.socket === socket) this.teardown();
    if (this.closed || !this.runtimeId) return;
    this.scheduleReconnect(reason);
  }

  private scheduleReconnect(reason: string): void {
    if (this.closed || !this.runtimeId || this.reconnectTimer) return;
    this.lastError = reason;
    this.state = "disconnected";
    this.reconnectAttempts++;
    this.repeatedFailures++;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.reconnectMaxMs);
    this.nextReconnectAt = new Date(Date.now() + delay).toISOString();
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
      this.connectNow();
    }, delay);
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

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function messageOf(error: unknown): string | null {
  if (!error) return null;
  if (error instanceof Error) return error.message;
  const value = (error as { message?: unknown }).message;
  return typeof value === "string" ? value : String(error);
}
