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
   * A `:generateContent` / `:streamGenerateContent` call left for the gateway;
   * its `request` observation follows when it ends. Lets the provider tell a
   * thinking model from a stalled turn.
   */
  | { type: "request_started"; requestedModel: string | null }
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
  | { type: "fatal"; reason: "auth" | "unreachable" | "quota"; status: number | null; message: string }
  /**
   * A model listing (`GET models`, `GET models/<m>`) ended, with or without a
   * prompt. Server 1.4.0 never fails `session/new` on a refused listing: it
   * falls back to built-in model ids, so the provider needs this to report the
   * gateway failure instead of an unsupported model.
   */
  | { type: "listing"; status: number; failure: GatewayShimListingFailure | null };

/** Why a model listing failed: `status` 0 means no response arrived. */
export interface GatewayShimListingFailure {
  reason: "auth" | "unreachable" | "quota";
  status: number;
  message: string;
}

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
  /**
   * A prompt of this channel's ACP process is active until the returned
   * function is called (idempotent). Model calls are served only while one
   * is: outside a prompt nothing would meter them (a backgrounded shell
   * command calling the gateway after the turn), so they get a fast 503.
   * Listings and `countTokens` are always served.
   */
  beginPrompt(): () => void;
  /** Cut every model call still in flight; each still emits its (aborted) observation. */
  abortInflight(): void;
  /** Revokes the token; later requests get the unknown-token 404. Idempotent. */
  close(): void;
}

export interface GatewayShimHost {
  /** One channel per ACP process; `label` is for logs only (never the token). */
  open(label: string): GatewayShimChannel;
}
