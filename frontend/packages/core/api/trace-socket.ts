import { WSClient } from "./ws-client";
import type { StreamSubscription, StreamSubscriptionHandlers } from "./ws-client";
import type { Logger } from "../logger";
import { createLogger, noopLogger } from "../logger";

/**
 * The lazy trace socket (MUL-438, plan 2/6 §2 + plan 3/6 §6).
 *
 * Trace is a different stream from the conversation log — it lives in the
 * runtime process and has its own endpoint (`/api/trace/ws`) — and the
 * 「执行过程」 panel has five entry points, only one of which is usually open. So
 * the socket is built on the first subscription and torn down with the last
 * one: a user who never opens the panel never opens a second WebSocket, and a
 * user who closes it does not leave an idle connection behind.
 *
 * The wrapper is intentionally thin. It owns connection lifetime and hands every
 * other decision (backoff, ping, resume-from-head, `resync`) to {@link WSClient},
 * so there is exactly one reconnect implementation in the app and the trace
 * socket cannot drift from it.
 */
export interface TraceSocketOptions {
  /** Absolute or path WS URL for the trace endpoint, e.g. `/api/trace/ws`. */
  url: string;
  /** Bearer token, or null in cookie mode. */
  token?: string | null;
  /** Workspace slug for the upgrade query string. */
  workspaceSlug: string;
  cookieAuth?: boolean;
  logger?: Logger;
}

export class TraceSocket {
  private client: WSClient | null = null;
  private readonly subscriptions = new Map<string, () => void>();
  private readonly options: TraceSocketOptions;
  private readonly logger: Logger;

  constructor(options: TraceSocketOptions) {
    this.options = options;
    this.logger = options.logger ?? noopLogger;
  }

  /** True while a trace socket exists (i.e. at least one subscriber is active). */
  get connected(): boolean {
    return this.client !== null;
  }

  /** How many trace streams are currently subscribed. */
  get subscriptionCount(): number {
    return this.subscriptions.size;
  }

  /**
   * Subscribe to `trace:<taskId>`.
   *
   * The first call opens the socket; the returned unsubscribe closes it again
   * once it was the last one.
   */
  subscribe(taskId: string, handlers: StreamSubscriptionHandlers): StreamSubscription {
    if (this.subscriptions.has(taskId)) {
      throw new Error(`trace socket already subscribed to ${taskId}`);
    }
    const client = this.ensureClient();
    const subscription = client.subscribeStream("trace", taskId, handlers);
    this.subscriptions.set(taskId, () => subscription.unsubscribe());
    return {
      stream: "trace",
      id: taskId,
      head: () => subscription.head(),
      unsubscribe: () => this.unsubscribe(taskId),
    };
  }

  private unsubscribe(taskId: string): void {
    const dispose = this.subscriptions.get(taskId);
    if (!dispose) return;
    dispose();
    this.subscriptions.delete(taskId);
    if (this.subscriptions.size === 0) this.close();
  }

  /** Tear down the socket. Called by the last unsubscribe; safe to call again. */
  close(): void {
    const client = this.client;
    this.client = null;
    for (const dispose of this.subscriptions.values()) dispose();
    this.subscriptions.clear();
    if (!client) return;
    client.disconnect();
    this.logger.debug("trace socket closed");
  }

  private ensureClient(): WSClient {
    if (this.client) return this.client;
    const client = createTraceClient(this.options);
    this.client = client;
    this.logger.debug("trace socket opened");
    return client;
  }
}

/** Build the underlying client. Swappable so tests can prove laziness. */
export type TraceClientFactory = (options: TraceSocketOptions) => WSClient;

function createDefaultTraceClient(options: TraceSocketOptions): WSClient {
  const client = new WSClient(options.url, {
    logger: options.logger ?? createLogger("ws.trace"),
    cookieAuth: options.cookieAuth,
  });
  client.setAuth(options.token ?? null, options.workspaceSlug);
  client.connect();
  return client;
}

let traceClientFactory: TraceClientFactory = createDefaultTraceClient;

/**
 * Replace the client factory. Tests use this to assert that the socket is only
 * built for a real subscription; production never calls it.
 */
export function setTraceClientFactoryForTesting(factory: TraceClientFactory | null): void {
  traceClientFactory = factory ?? createDefaultTraceClient;
}

function createTraceClient(options: TraceSocketOptions): WSClient {
  return traceClientFactory(options);
}

/**
 * The trace endpoint for a WebSocket URL that points at `/ws`.
 *
 * Both live on the same origin and both are proxied by the app's own rewrite
 * rules, so the only thing that changes is the path: `/ws` becomes
 * `/api/trace/ws`. Kept here rather than in the Next app so the derivation has
 * one definition and can be asserted.
 */
export function deriveTraceWsUrl(wsUrl: string): string {
  try {
    const url = new URL(wsUrl);
    url.pathname = "/api/trace/ws";
    url.search = "";
    return url.toString();
  } catch {
    // A relative or otherwise unparseable URL: fall back to the documented path
    // rather than throwing at the call site that is opening a panel.
    return "/api/trace/ws";
  }
}
