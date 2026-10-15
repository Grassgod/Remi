/**
 * The local gateway shim seen from `packages/acp` (PR 4 §4.1). The daemon owns
 * the implementation (`packages/daemon/src/agent-runtime/antigravity/
 * gateway-shim.ts`, Task C); this package only consumes these interfaces, so it
 * never imports `@daemon`.
 *
 * One host serves one task run. `open()` mints one loopback base URL per ACP
 * process; usage attribution follows that token, and therefore the provider
 * pool entry and its `acpSessionId`. The real gateway key lives only in the
 * shim: the ACP server sees the placeholder key of `buildAntigravityEnv`.
 */

/** One model call the shim proxied, observed when its response ended or was aborted. */
export interface GatewayShimRequestObservation {
  /** Monotonic per channel. */
  seq: number;
  /** The URL model segment of `models/<m>:…`, or null when none. */
  requestedModel: string | null;
  /** Upstream HTTP status; 0 when no response arrived. */
  status: number;
  /** The client or a timeout cut the response short. */
  aborted: boolean;
  /** The last `responseId` the response carried. */
  responseId: string | null;
  /** The last `modelVersion` the response carried. */
  modelVersion: string | null;
  /** The last `usageMetadata` (Gemini counters, e.g. `promptTokenCount`). */
  usageMetadata: Record<string, number> | null;
}

export type GatewayShimEvent =
  /**
   * Emitted once per `:generateContent` / `:streamGenerateContent` call.
   * Model listings and `countTokens` consume nothing and are not observed.
   */
  | { type: "request"; obs: GatewayShimRequestObservation }
  /**
   * The breaker opened (§4.2): a 401/403 at once, or repeated network / 5xx /
   * 429 failures. The token now answers 503 quickly; the provider cancels and
   * fails the turn.
   */
  | { type: "fatal"; reason: "auth" | "unreachable" | "quota"; status: number | null; message: string };

export interface GatewayShimChannel {
  /** `http://127.0.0.1:<port>/r_<token>`, without `/v1beta`. */
  readonly baseUrl: string;
  /** Returns the unsubscribe function. */
  subscribe(listener: (event: GatewayShimEvent) => void): () => void;
  /**
   * Resolves once every request in flight has emitted its observation, or after
   * `ms` at the latest. Never rejects.
   */
  settled(ms: number): Promise<void>;
  /** Revokes the token; later requests get the unknown-token 404. Idempotent. */
  close(): void;
}

export interface GatewayShimHost {
  /** One channel per ACP process; `label` is for logs only (never the token). */
  open(label: string): GatewayShimChannel;
}
