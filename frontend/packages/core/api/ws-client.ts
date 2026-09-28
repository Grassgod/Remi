import type { WSMessage, WSEventType } from "../types/events";
import { type Logger, noopLogger } from "../logger";
import type {
  HubFrame,
  HubStreamAckPayload,
  HubStreamErrorPayload,
  HubStreamGapPayload,
  HubStreamName,
} from "@multiremi/contracts/live-hub";

type EventHandler = (payload: unknown, actorId?: string, actorType?: string) => void;

// ─── v2 stream protocol (MUL-438) ───────────────────────────────────────────────

/** First retry waits at least this long; the jitter never goes below it. */
export const WS_RECONNECT_BASE_DELAY_MS = 1_000;
/** A retry never waits longer than this, however many attempts have failed. */
export const WS_RECONNECT_MAX_DELAY_MS = 30_000;
/** Heartbeat cadence. Bun's `idleTimeout` is 120s, so this is the keepalive. */
export const WS_PING_INTERVAL_MS = 25_000;

/**
 * The delay before reconnect attempt `attempt + 1`.
 *
 * Exponential with a jittered window: attempt 0 waits 1s, attempt 1 up to 2s, and
 * so on, capped at 30s. Jitter is "half the window, plus up to the other half",
 * floored and capped so the documented 1s–30s envelope is exact — a fleet of tabs
 * that lost the same server does not retry on the same tick, and a server that is
 * coming back up is not hammered by a client that has been waiting for an hour.
 *
 * `random` is injected so the schedule can be asserted without mocking a global.
 */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(WS_RECONNECT_MAX_DELAY_MS, WS_RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt));
  const half = exponential / 2;
  const jittered = half + random() * half;
  return Math.max(WS_RECONNECT_BASE_DELAY_MS, Math.min(WS_RECONNECT_MAX_DELAY_MS, Math.round(jittered)));
}

/** One batch of frames as it arrives on `stream.data`. */
export type StreamFrameHandler = (frames: readonly HubFrame[]) => void;

/** What a stream subscriber wants to hear about. Every callback is optional. */
export interface StreamSubscriptionHandlers {
  /** The subscription is live; carries the hub's range and any gap to backfill. */
  onAck?: (payload: HubStreamAckPayload) => void;
  /** One ordered batch. `seq` is the upstream sequence, not a client counter. */
  onFrames?: StreamFrameHandler;
  /** The connection fell behind mid-stream; backfill `[from, to]` and continue. */
  onGap?: (payload: HubStreamGapPayload) => void;
  /**
   * The subscription was refused. `unavailable` is retryable, the rest are final
   * until the caller unsubscribes — the caller owns that decision, so the entry
   * stays registered (and is therefore re-sent on the next reconnect).
   */
  onError?: (payload: HubStreamErrorPayload) => void;
}

export interface StreamSubscriptionOptions {
  /**
   * Where to start. Defaults to the local head + 1, which is what a resume needs;
   * pass an explicit value when the caller has a better anchor (the browser
   * replica's own `head_seq`, for instance).
   */
  fromSeq?: number;
}

/** The handle an active stream subscription returns. */
export interface StreamSubscription {
  readonly stream: HubStreamName;
  readonly id: string;
  /** Highest sequence this client has actually received for the stream, or 0. */
  head(): number;
  unsubscribe(): void;
}

interface ActiveStream {
  stream: HubStreamName;
  id: string;
  handlers: StreamSubscriptionHandlers;
  /**
   * The caller's anchor, kept until the first frame arrives. A resume from
   * `head + 1` is only meaningful once something has been received; before that
   * the caller's anchor is the newest information available.
   */
  pendingFromSeq: number | null;
  head: number;
  sent: boolean;
}

function streamSubscriptionKey(stream: HubStreamName, id: string): string {
  return `${stream}:${id}`;
}

/** Server → client frames that belong to the v2 stream vocabulary. */
const STREAM_FRAME_TYPES: ReadonlySet<string> = new Set([
  "stream.ack",
  "stream.data",
  "stream.gap",
  "stream.error",
]);

// Cap how much of an unparseable frame we put into the log. A malformed or
// rogue server can stream arbitrarily large garbage, and the warn handler may
// be a console / IPC bridge whose buffers we don't want to blow.
const UNPARSEABLE_LOG_MAX_CHARS = 200;

function summarizeUnparseable(data: unknown): string {
  const text = typeof data === "string" ? data : String(data);
  if (text.length <= UNPARSEABLE_LOG_MAX_CHARS) return text;
  return `${text.slice(0, UNPARSEABLE_LOG_MAX_CHARS)}… (truncated, ${text.length} chars total)`;
}

/** Identifies the WS client to the server. Sent as `client_platform`,
 *  `client_version`, and `client_os` query parameters on the upgrade URL —
 *  browsers cannot set custom headers on WebSocket handshakes, so query
 *  params are the only portable channel. */
export interface WSClientIdentity {
  platform?: string;
  version?: string;
  os?: string;
}

export class WSClient {
  private ws: WebSocket | null = null;
  private baseUrl: string;
  private token: string | null = null;
  private workspaceSlug: string | null = null;
  private cookieAuth = false;
  private identity: WSClientIdentity | undefined;
  private handlers = new Map<WSEventType, Set<EventHandler>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private hasConnectedBefore = false;
  private onReconnectCallbacks = new Set<() => void>();
  private onAuthenticatedCallbacks = new Set<() => void>();
  private anyHandlers = new Set<(msg: WSMessage) => void>();
  private logger: Logger;
  /** Failed reconnect attempts since the last successful authentication. */
  private reconnectAttempt = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** Every stream this client wants on the socket, keyed by `stream:id`. */
  private streams = new Map<string, ActiveStream>();
  /** Called after a reconnect or a server `resync`; see {@link onResync}. */
  private onResyncCallbacks = new Set<() => void>();
  private disposed = false;

  constructor(
    url: string,
    options?: {
      logger?: Logger;
      cookieAuth?: boolean;
      identity?: WSClientIdentity;
    },
  ) {
    this.baseUrl = url;
    this.logger = options?.logger ?? noopLogger;
    this.cookieAuth = options?.cookieAuth ?? false;
    this.identity = options?.identity;
  }

  setAuth(token: string | null, workspaceSlug: string) {
    this.token = token;
    this.workspaceSlug = workspaceSlug;
  }

  connect() {
    const url = new URL(this.baseUrl);
    // Token is never sent as a URL query parameter — it would be logged by
    // proxies, CDNs, and browser history.  In cookie mode the HttpOnly cookie
    // is sent automatically with the upgrade request.  In token mode the token
    // is delivered as the first WebSocket message after the connection opens.
    if (this.workspaceSlug)
      url.searchParams.set("workspace_slug", this.workspaceSlug);
    if (this.identity?.platform)
      url.searchParams.set("client_platform", this.identity.platform);
    if (this.identity?.version)
      url.searchParams.set("client_version", this.identity.version);
    if (this.identity?.os)
      url.searchParams.set("client_os", this.identity.os);

    this.ws = new WebSocket(url.toString());

    this.ws.onopen = () => {
      if (!this.cookieAuth && this.token) {
        this.ws!.send(
          JSON.stringify({ type: "auth", payload: { token: this.token } }),
        );
        return;
      }

      this.onAuthenticated();
    };

    this.ws.onmessage = (event) => {
      let msg: WSMessage;
      try {
        msg = JSON.parse(event.data as string) as WSMessage;
      } catch {
        this.logger.warn(
          "ws: received unparseable message",
          summarizeUnparseable(event.data),
        );
        return;
      }
      if (!msg || typeof msg !== "object" || typeof (msg as { type?: unknown }).type !== "string") {
        this.logger.warn(
          "ws: received message without a valid type",
          summarizeUnparseable(event.data),
        );
        return;
      }
      if ((msg as any).type === "auth_ack") {
        this.onAuthenticated();
        return;
      }
      // `resync` is a process-level recovery signal: the cross-process link came
      // back, so the client re-runs the same work as a reconnect (re-subscribe
      // from local head + 1, then refetch what the socket does not carry).
      if ((msg as any).type === "resync") {
        this.logger.info("server resync");
        this.resubscribeStreams();
        this.emitResync();
        return;
      }
      if (this.handleStreamFrame(msg as { type: string; payload?: unknown })) return;
      this.logger.debug("received", msg.type);
      const eventHandlers = this.handlers.get(msg.type);
      if (eventHandlers) {
        for (const handler of eventHandlers) {
          handler(msg.payload, msg.actor_id, msg.actor_type);
        }
      }
      for (const handler of this.anyHandlers) {
        handler(msg);
      }
    };

    this.ws.onclose = () => {
      this.stopPing();
      if (this.disposed) return;
      const delayMs = reconnectDelayMs(this.reconnectAttempt);
      this.reconnectAttempt += 1;
      this.logger.warn(`disconnected, reconnecting in ${delayMs}ms`);
      this.reconnectTimer = setTimeout(() => this.connect(), delayMs);
    };

    this.ws.onerror = () => {
      // Suppress — onclose handles reconnect; errors during StrictMode
      // double-fire are expected in dev and harmless.
    };
  }

  private onAuthenticated() {
    this.logger.info("connected");
    const isResume = this.hasConnectedBefore;
    this.reconnectAttempt = 0;
    this.startPing();
    if (isResume) {
      for (const cb of this.onReconnectCallbacks) {
        try {
          cb();
        } catch {
          // ignore reconnect callback errors
        }
      }
    }
    this.hasConnectedBefore = true;
    // v2 resume: every stream the client still wants is re-sent from the head it
    // has locally (or its original anchor if nothing arrived yet), so a reconnect
    // continues the stream instead of invalidating the page. This runs for the
    // first connection too, which is how a subscriber that registered before the
    // socket opened is honoured.
    this.resubscribeStreams();
    // Fires on every authenticated connection (first + reconnect). Scope
    // subscriptions must be (re)sent here: the server clears them on
    // disconnect, and a subscribe frame sent before auth would be dropped.
    for (const cb of this.onAuthenticatedCallbacks) {
      try {
        cb();
      } catch {
        // ignore
      }
    }
  }

  get authenticated(): boolean {
    return this.hasConnectedBefore && this.ws?.readyState === WebSocket.OPEN;
  }

  disconnect() {
    this.disposed = true;
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      // Remove handlers before close to prevent onclose from scheduling a reconnect
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }
    this.hasConnectedBefore = false;
    this.reconnectAttempt = 0;
    this.handlers.clear();
    this.anyHandlers.clear();
    this.onReconnectCallbacks.clear();
    this.onAuthenticatedCallbacks.clear();
    this.onResyncCallbacks.clear();
    this.streams.clear();
  }

  // ─── v2 streams ───────────────────────────────────────────────────────────

  /**
   * Subscribe to one stream. A repeat call for the same `stream:id` replaces the
   * handlers and re-anchors the subscription, which is what a caller restoring a
   * view after navigation needs.
   */
  subscribeStream(
    stream: HubStreamName,
    id: string,
    handlers: StreamSubscriptionHandlers,
    options: StreamSubscriptionOptions = {},
  ): StreamSubscription {
    const key = streamSubscriptionKey(stream, id);
    const entry: ActiveStream = {
      stream,
      id,
      handlers,
      pendingFromSeq: options.fromSeq ?? null,
      head: options.fromSeq != null && options.fromSeq > 1 ? options.fromSeq - 1 : 0,
      sent: false,
    };
    this.streams.set(key, entry);
    this.sendStreamSubscribe(entry);
    return {
      stream,
      id,
      head: () => this.streams.get(key)?.head ?? entry.head,
      unsubscribe: () => {
        const current = this.streams.get(key);
        if (!current) return;
        this.streams.delete(key);
        this.send({ type: "stream.unsubscribe", payload: { stream, id } } as never);
      },
    };
  }

  /** True while this client holds a subscription for `stream:id`. */
  hasStreamSubscription(stream: HubStreamName, id: string): boolean {
    return this.streams.has(streamSubscriptionKey(stream, id));
  }

  /** How many streams this client is subscribed to; for tests and diagnostics. */
  get streamSubscriptionCount(): number {
    return this.streams.size;
  }

  /**
   * (Re)send `stream.subscribe` for every active stream from the anchor the
   * client has now.
   *
   * `from_seq` is *exclusive* (C0's contract), so a stream that has received
   * something resumes at `head + 1`; one that has received nothing keeps the
   * caller's original anchor, because there is nothing local to resume from.
   */
  private resubscribeStreams(): void {
    for (const entry of this.streams.values()) {
      this.sendStreamSubscribe(entry);
    }
  }

  private sendStreamSubscribe(entry: ActiveStream): void {
    const fromSeq = entry.pendingFromSeq ?? (entry.head > 0 ? entry.head + 1 : 1);
    entry.pendingFromSeq = null;
    entry.sent = true;
    this.send({
      type: "stream.subscribe",
      payload: { stream: entry.stream, id: entry.id, from_seq: fromSeq },
    } as never);
  }

  /**
   * Route one v2 server frame. Returns true when it belonged to the stream
   * vocabulary, so the generic event handlers never see it.
   */
  private handleStreamFrame(msg: { type: string; payload?: unknown }): boolean {
    if (!STREAM_FRAME_TYPES.has(msg.type)) return false;
    const payload = (msg.payload ?? {}) as Record<string, unknown>;
    const stream = payload.stream === "trace" ? "trace" : payload.stream === "log" ? "log" : null;
    const id = typeof payload.id === "string" ? payload.id : "";
    if (!stream || !id) return true;
    const entry = this.streams.get(streamSubscriptionKey(stream, id));
    if (!entry) return true;
    switch (msg.type) {
      case "stream.ack": {
        const ack = msg.payload as HubStreamAckPayload;
        entry.pendingFromSeq = null;
        entry.handlers.onAck?.(ack);
        break;
      }
      case "stream.data": {
        const frames = (payload.frames ?? []) as HubFrame[];
        if (frames.length > 0) {
          const latest = frames[frames.length - 1]!.seq;
          if (typeof latest === "number" && latest > entry.head) entry.head = latest;
          entry.handlers.onFrames?.(frames);
        }
        break;
      }
      case "stream.gap":
        entry.handlers.onGap?.(msg.payload as HubStreamGapPayload);
        break;
      case "stream.error":
        entry.handlers.onError?.(msg.payload as HubStreamErrorPayload);
        break;
      default:
        break;
    }
    return true;
  }

  /**
   * Fires after a reconnect *and* after a server `resync`: both mean the same
   * thing to a listener — non-stream caches may have moved while this client was
   * not listening.
   */
  onResync(callback: () => void) {
    this.onResyncCallbacks.add(callback);
    return () => {
      this.onResyncCallbacks.delete(callback);
    };
  }

  private emitResync(): void {
    for (const cb of this.onResyncCallbacks) {
      try {
        cb();
      } catch {
        // ignore resync callback errors
      }
    }
  }

  // ─── keepalive ────────────────────────────────────────────────────────────

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.send({ type: "ping" } as never);
    }, WS_PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (!this.pingTimer) return;
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  on(event: WSEventType, handler: EventHandler) {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
    return () => {
      this.handlers.get(event)?.delete(handler);
    };
  }

  onAny(handler: (msg: WSMessage) => void) {
    this.anyHandlers.add(handler);
    return () => {
      this.anyHandlers.delete(handler);
    };
  }

  onReconnect(callback: () => void) {
    this.onReconnectCallbacks.add(callback);
    return () => {
      this.onReconnectCallbacks.delete(callback);
    };
  }

  onAuthenticated_(callback: () => void) {
    this.onAuthenticatedCallbacks.add(callback);
    // If already authenticated, fire immediately so a late subscriber catches up.
    if (this.authenticated) {
      try { callback(); } catch { /* ignore */ }
    }
    return () => {
      this.onAuthenticatedCallbacks.delete(callback);
    };
  }

  send(message: WSMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }
}
