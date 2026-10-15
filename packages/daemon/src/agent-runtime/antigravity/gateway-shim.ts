/**
 * The daemon's loopback gateway shim for Antigravity (PR 4 §4).
 *
 * Google's ACP server authenticates through its gateway mode against
 * `AGY_LLM_GATEWAY_URL`, which points here with a placeholder key. The shim:
 * - accepts only `/<token>/<allowlisted Gemini route>` on 127.0.0.1;
 * - drops every inbound credential (the harness sends the placeholder both as
 *   Bearer and as `x-goog-api-key`, and our gateway prefers the latter) and
 *   forwards with the real key as `Authorization: Bearer`;
 * - passes response bytes through unchanged while reading each model
 *   response's last `usageMetadata`, which the provider turns into usage units;
 * - opens a per-token breaker when the gateway rejects the key or stays
 *   unreachable, because the harness retries a dead gateway forever.
 *
 * One shim serves the daemon process; `forRun()` scopes the real key to one
 * task run, and `open()` mints one token per ACP process. The real key lives
 * only in this object (and the daemon's redaction list); tokens are 256-bit,
 * looked up by hash, revoked on close and never logged beyond 6 characters.
 */

import { createHash, randomBytes } from "node:crypto";
import type { Server as BunServer } from "bun";
import type {
  GatewayShimChannel, GatewayShimEvent, GatewayShimHost, GatewayShimListingFailure, GatewayShimRequestObservation,
} from "@acp/access/gateway-shim-types.js";
import { assertPublicHost } from "@shared/relay-http.js";
import { createLogger } from "@shared/logger.js";
import { GeminiResponseScanner, JSON_BODY_MAX_BYTES, SSE_EVENT_MAX_BYTES } from "./gemini-sse.js";

const log = createLogger("antigravity-shim");
type Server = BunServer<undefined>;

export const GATEWAY_SHIM_LIMITS = {
  requestBodyBytes: 32 * 1024 * 1024,
  /** Upstream response headers must arrive within this (then 504). */
  firstByteMs: 60_000,
  /** Longest silence between response bytes before the stream is cut. */
  idleMs: 120_000,
  totalMs: 15 * 60_000,
  /** Consecutive network / 5xx / 429 failures that open the breaker. */
  breakerFailures: 5,
  /** Continuous failure time that opens the breaker. */
  breakerWindowMs: 180_000,
  /** How long a public-address check of the upstream host is trusted. */
  hostCheckMs: 60_000,
  sseEventBytes: SSE_EVENT_MAX_BYTES,
  jsonBytes: JSON_BODY_MAX_BYTES,
};
export type GatewayShimLimits = typeof GATEWAY_SHIM_LIMITS;

export interface AntigravityGatewayShimOptions {
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Clock for the breaker window. */
  now?: () => number;
  /**
   * Rejects an upstream the shim must not reach. Default: https only, and the
   * host must resolve to public addresses (checked at most every 60 s).
   */
  assertUpstream?: (url: URL) => Promise<void>;
  limits?: Partial<GatewayShimLimits>;
}

export interface GatewayShimRunOptions {
  /** The workspace Model gateway's Antigravity `base_url`, without `/v1beta`. */
  upstreamBase: string;
  /** The gateway key. Never leaves this process except as the upstream Bearer. */
  apiKey: string;
  /** For logs only. */
  runId: string;
}

/** A task run's view of the shim: channels for its ACP processes, all revoked at `close()`. */
export interface GatewayShimRun extends GatewayShimHost {
  readonly runId: string;
  close(): void;
}

type Route =
  | { kind: "list" | "get"; model: string | null }
  | { kind: "generateContent" | "streamGenerateContent" | "countTokens"; model: string };

const MODEL = "([A-Za-z0-9][A-Za-z0-9._@-]{0,199})";
const ROUTES: Array<{ method: string; pattern: RegExp; route: (match: RegExpExecArray) => Route }> = [
  { method: "GET", pattern: /^v1beta\/models\/?$/, route: () => ({ kind: "list", model: null }) },
  { method: "GET", pattern: /^v1\/models\/?$/, route: () => ({ kind: "list", model: null }) },
  { method: "GET", pattern: new RegExp(`^v1beta/models/${MODEL}$`), route: (m) => ({ kind: "get", model: m[1]! }) },
  {
    method: "POST", pattern: new RegExp(`^v1beta/models/${MODEL}:(streamGenerateContent|generateContent|countTokens)$`),
    route: (m) => ({ kind: m[2] as "generateContent", model: m[1]! }),
  },
];

const HOP_BY_HOP = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"];
const DROP_REQUEST_HEADERS = new Set([
  ...HOP_BY_HOP, "authorization", "x-goog-api-key", "cookie", "host", "content-length", "accept-encoding", "forwarded", "x-real-ip",
]);
const DROP_RESPONSE_HEADERS = new Set([...HOP_BY_HOP, "content-encoding", "content-length", "set-cookie"]);

/** Identical for unknown, revoked and disallowed: nothing tells a caller which tokens exist. */
function notFound(): Response {
  return Response.json({ error: { code: 404, message: "Not found", status: "NOT_FOUND" } }, { status: 404 });
}

function gatewayError(status: number, message: string, state: string): Response {
  return Response.json({ error: { code: status, message, status: state } }, { status });
}

/** A refused or failed listing, or null for an answer the gateway gave. */
function listingFailure(status: number): GatewayShimListingFailure | null {
  if (status === 401 || status === 403) return { reason: "auth", status, message: `the model gateway rejected the gateway key (HTTP ${status})` };
  if (status === 429) return { reason: "quota", status, message: "the model gateway is rate limiting or out of quota (HTTP 429)" };
  if (status >= 500) return { reason: "unreachable", status, message: `the model gateway failed (HTTP ${status})` };
  return null;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeDecode(path: string): string | null {
  try { return decodeURIComponent(path); } catch { return null; }
}

function matchRoute(method: string, rest: string): Route | null {
  const decoded = safeDecode(rest);
  if (decoded === null) return null;
  for (const candidate of ROUTES) {
    if (candidate.method !== method) continue;
    const match = candidate.pattern.exec(decoded);
    if (match) return candidate.route(match);
  }
  return null;
}

class ShimAbort extends Error {
  constructor(readonly cause: "client" | "first-byte" | "idle" | "total" | "revoked" | "settle") {
    super(`gateway shim request ended: ${cause}`);
  }
}

/** Reads a request body, or null when it exceeds `cap`. */
async function readBody(request: Request, cap: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > cap) return null;
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(new ArrayBuffer(0));
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const body = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const part of parts) { body.set(part, offset); offset += part.byteLength; }
  return body;
}

class ShimRunState implements GatewayShimRun {
  closed = false;
  readonly channels = new Set<ShimChannel>();

  constructor(
    private readonly shim: AntigravityGatewayShim,
    readonly runId: string,
    readonly upstreamBase: string,
    /** Cleared at close: a finished run keeps no copy of the gateway key. */
    public apiKey: string,
  ) {}

  open(label: string): GatewayShimChannel {
    if (this.closed) throw new Error("[antigravity_gateway_unconfigured] the gateway shim run is closed");
    return this.shim._openChannel(this, label);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const channel of [...this.channels]) channel.close();
    // A run that never opened a channel (a task that failed before its server
    // started) is forgotten here; one with channels, by its last channel's close.
    this.shim._forgetRun(this);
    this.apiKey = "";
  }
}

class ShimChannel implements GatewayShimChannel {
  closed = false;
  seq = 0;
  /** Metered requests whose observation is still pending. */
  inflight = 0;
  readonly waiters = new Set<() => void>();
  readonly listeners = new Set<(event: GatewayShimEvent) => void>();
  readonly requests = new Set<AbortController>();
  /** In-flight model calls, for `abortInflight()`. */
  readonly metered = new Set<AbortController>();
  /** Active prompts of this channel's ACP process: model calls are served only while one is. */
  activePrompts = 0;
  /** A model call outside a prompt was refused and logged (logged once). */
  refusedLogged = false;
  failures = 0;
  failingSince: number | null = null;
  fatal: Extract<GatewayShimEvent, { type: "fatal" }> | null = null;

  constructor(
    readonly run: ShimRunState,
    readonly hash: string,
    readonly tokenPrefix: string,
    readonly label: string,
    readonly baseUrl: string,
    private readonly onClose: (channel: ShimChannel) => void,
  ) {}

  subscribe(listener: (event: GatewayShimEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  settled(ms: number): Promise<void> {
    if (this.inflight === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); this.waiters.delete(done); resolve(); };
      const timer = setTimeout(done, Math.max(0, ms));
      this.waiters.add(done);
    });
  }

  beginPrompt(): () => void {
    this.activePrompts++;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.activePrompts = Math.max(0, this.activePrompts - 1);
    };
  }

  abortInflight(): void {
    for (const request of [...this.metered]) request.abort(new ShimAbort("settle"));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose(this);
    for (const request of [...this.requests]) request.abort(new ShimAbort("revoked"));
    for (const waiter of [...this.waiters]) waiter();
  }

  emit(event: GatewayShimEvent): void {
    if (this.closed) return;
    for (const listener of [...this.listeners]) {
      try { listener(event); } catch (error) {
        log.warn(`gateway shim listener failed for ${this.tokenPrefix}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  requestDone(): void {
    this.inflight = Math.max(0, this.inflight - 1);
    if (this.inflight === 0) for (const waiter of [...this.waiters]) waiter();
  }
}

export class AntigravityGatewayShim {
  private server: Server | null = null;
  /** Live channels by token hash. */
  private readonly tokens = new Map<string, ShimChannel>();
  private readonly runs = new Set<ShimRunState>();
  private readonly hostChecks = new Map<string, number>();
  private readonly limits: GatewayShimLimits;
  private readonly fetchUpstream: (url: string, init: RequestInit) => Promise<Response>;
  private readonly now: () => number;
  private readonly assertUpstream: (url: URL) => Promise<void>;

  constructor(options: AntigravityGatewayShimOptions = {}) {
    this.limits = { ...GATEWAY_SHIM_LIMITS, ...options.limits };
    this.fetchUpstream = options.fetch ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
    this.assertUpstream = options.assertUpstream ?? ((url) => this.assertPublicUpstream(url));
  }

  /** The bound loopback port, or null before the first channel. */
  get port(): number | null {
    return this.server?.port ?? null;
  }

  /** Scope the real gateway key to one task run (or one model probe). */
  forRun(options: GatewayShimRunOptions): GatewayShimRun {
    let url: URL;
    try { url = new URL(options.upstreamBase.trim()); } catch {
      throw new Error("[antigravity_gateway_unconfigured] the Antigravity gateway base_url is not a URL");
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search || url.hash) {
      throw new Error("[antigravity_gateway_unconfigured] the Antigravity gateway base_url must be a plain http(s) URL");
    }
    const base = url.toString().replace(/\/+$/, "");
    // The server appends `/v1beta/...` itself.
    if (/\/v1(?:beta)?$/.test(base)) throw new Error("[antigravity_gateway_unconfigured] the Antigravity gateway base_url must not end in /v1beta");
    const apiKey = options.apiKey.trim();
    if (!apiKey || /[\r\n]/.test(apiKey)) throw new Error("[antigravity_gateway_unconfigured] the Antigravity gateway key is missing");
    const run = new ShimRunState(this, options.runId, base, apiKey);
    this.runs.add(run);
    return run;
  }

  /** Stop listening and revoke every token. */
  stop(): void {
    for (const run of [...this.runs]) run.close();
    this.runs.clear();
    this.server?.stop(true);
    this.server = null;
  }

  /** Runs that still hold a gateway key (diagnostics and tests). */
  get openRuns(): number {
    return this.runs.size;
  }

  /** @internal A closed run with no live channel. */
  _forgetRun(run: ShimRunState): void {
    if (run.closed && !run.channels.size) this.runs.delete(run);
  }

  /** @internal */
  _openChannel(run: ShimRunState, label: string): GatewayShimChannel {
    const port = this.ensureServer();
    const token = `r_${randomBytes(32).toString("base64url")}`;
    const hash = hashToken(token);
    const channel = new ShimChannel(run, hash, token.slice(0, 6), label, `http://127.0.0.1:${port}/${token}`, (closed) => {
      this.tokens.delete(closed.hash);
      run.channels.delete(closed);
      if (run.closed && !run.channels.size) this.runs.delete(run);
    });
    this.tokens.set(hash, channel);
    run.channels.add(channel);
    log.info(`gateway shim channel ${channel.tokenPrefix} opened for ${label} (run ${run.runId})`);
    return channel;
  }

  private ensureServer(): number {
    if (!this.server) {
      this.server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        // Model calls can think for minutes between bytes; the shim's own timeouts apply.
        idleTimeout: 0,
        maxRequestBodySize: this.limits.requestBodyBytes + 1,
        fetch: (request, server) => this.handle(request, server),
        error: () => gatewayError(500, "gateway shim error", "INTERNAL"),
      });
    }
    return this.server.port ?? 0;
  }

  private async assertPublicUpstream(url: URL): Promise<void> {
    if (url.protocol !== "https:") throw new Error("the Antigravity gateway must use https");
    const checkedAt = this.hostChecks.get(url.hostname);
    if (checkedAt !== undefined && this.now() - checkedAt < this.limits.hostCheckMs) return;
    await assertPublicHost(url.hostname);
    this.hostChecks.set(url.hostname, this.now());
  }

  private async handle(request: Request, server: Server): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/(r_[A-Za-z0-9_-]{43})(?:\/(.*))?$/.exec(url.pathname);
    const channel = match ? this.tokens.get(hashToken(match[1]!)) : undefined;
    if (!match || !channel || channel.closed) return notFound();
    const route = matchRoute(request.method, match[2] ?? "");
    if (!route) return notFound();
    if (channel.fatal) return gatewayError(503, "the model gateway is unavailable for this session", "UNAVAILABLE");

    let body: Uint8Array<ArrayBuffer> | undefined;
    if (request.method === "POST") {
      const read = await readBody(request, this.limits.requestBodyBytes).catch(() => null);
      if (!read) return gatewayError(413, "request body too large", "INVALID_ARGUMENT");
      body = read;
    }
    const query = new URLSearchParams(url.search);
    query.delete("key");
    const search = query.toString();
    const upstream = new URL(`${channel.run.upstreamBase}/${match[2] ?? ""}${search ? `?${search}` : ""}`);
    const headers = new Headers();
    const connectionListed = new Set((request.headers.get("connection") ?? "").split(",").map((name) => name.trim().toLowerCase()).filter(Boolean));
    for (const [name, value] of request.headers) {
      if (DROP_REQUEST_HEADERS.has(name) || connectionListed.has(name) || name.startsWith("x-forwarded-")) continue;
      headers.set(name, value);
    }
    headers.set("authorization", `Bearer ${channel.run.apiKey}`);

    const metered = route.kind === "generateContent" || route.kind === "streamGenerateContent";
    if (metered && channel.activePrompts === 0) {
      // Nothing would meter it: the run's prompt has ended (a backgrounded
      // command calling the gateway after the turn, between prompts).
      if (!channel.refusedLogged) {
        channel.refusedLogged = true;
        log.warn(`gateway shim refused a model call outside an active prompt for ${channel.tokenPrefix} (${channel.label})`);
      }
      return gatewayError(503, "no Remi prompt is active for this session; model calls are served only during a turn", "UNAVAILABLE");
    }
    return this.forward(channel, request, server, route, metered, upstream, { method: request.method, headers, body });
  }

  private async forward(
    channel: ShimChannel, request: Request, server: Server, route: Route, metered: boolean, upstream: URL,
    init: { method: string; headers: Headers; body: Uint8Array<ArrayBuffer> | undefined },
  ): Promise<Response> {
    const controller = new AbortController();
    channel.requests.add(controller);
    if (metered) {
      channel.metered.add(controller);
      channel.inflight++;
      channel.emit({ type: "request_started", requestedModel: route.model });
    }
    const listing = route.kind === "list" || route.kind === "get";
    let status = 0;
    let scanner: GeminiResponseScanner | null = null;
    let finished = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const onClientAbort = () => controller.abort(new ShimAbort("client"));
    const firstByteTimer = setTimeout(() => controller.abort(new ShimAbort("first-byte")), this.limits.firstByteMs);
    const totalTimer = setTimeout(() => controller.abort(new ShimAbort("total")), this.limits.totalMs);
    request.signal.addEventListener("abort", onClientAbort, { once: true });

    const finish = (aborted: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(firstByteTimer);
      clearTimeout(totalTimer);
      clearTimeout(idleTimer);
      request.signal.removeEventListener("abort", onClientAbort);
      channel.requests.delete(controller);
      channel.metered.delete(controller);
      if (!metered) return;
      const facts = scanner?.end() ?? { responseId: null, modelVersion: null, usageMetadata: null };
      const obs: GatewayShimRequestObservation = {
        seq: ++channel.seq, requestedModel: route.model, status, aborted, ...facts,
      };
      channel.emit({ type: "request", obs });
      channel.requestDone();
    };
    const abortCause = (): ShimAbort["cause"] | null => {
      const reason = controller.signal.reason;
      return reason instanceof ShimAbort ? reason.cause : null;
    };

    let response: Response;
    try {
      await this.assertUpstream(upstream);
      response = await this.fetchUpstream(upstream.toString(), {
        method: init.method, headers: init.headers, body: init.body, redirect: "error", signal: controller.signal,
      });
    } catch (error) {
      const cause = abortCause();
      finish(cause !== null);
      if (cause === "client" || cause === "revoked" || cause === "settle") return gatewayError(499, "client closed the request", "CANCELLED");
      const message = cause === "first-byte"
        ? "the model gateway did not answer in time"
        : `the model gateway is unreachable (${this.describe(error, channel.run.apiKey)})`;
      if (listing) channel.emit({ type: "listing", status: 0, failure: { reason: "unreachable", status: 0, message } });
      this.recordFailure(channel, "unreachable", null, message);
      return cause === "first-byte"
        ? gatewayError(504, "the model gateway did not answer in time", "DEADLINE_EXCEEDED")
        : gatewayError(502, "the model gateway is unreachable", "UNAVAILABLE");
    }
    clearTimeout(firstByteTimer);
    status = response.status;
    if (listing) channel.emit({ type: "listing", status, failure: listingFailure(status) });
    this.recordStatus(channel, response.status);

    const headers = new Headers();
    for (const [name, value] of response.headers) if (!DROP_RESPONSE_HEADERS.has(name)) headers.append(name, value);
    if (metered) {
      const sse = route.kind === "streamGenerateContent"
        && (/text\/event-stream/i.test(response.headers.get("content-type") ?? "") || upstream.searchParams.get("alt") === "sse");
      scanner = new GeminiResponseScanner(sse ? "sse" : "json", { sseEventBytes: this.limits.sseEventBytes, jsonBytes: this.limits.jsonBytes });
    }
    const reader = response.body?.getReader();
    if (!reader) {
      finish(false);
      return new Response(null, { status: response.status, headers });
    }
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(new ShimAbort("idle")), this.limits.idleMs);
    };
    armIdle();
    let dropped!: () => void;
    const connectionDropped = new Promise<void>((resolve) => { dropped = resolve; });
    const body = new ReadableStream<Uint8Array>({
      pull: async (output) => {
        try {
          const { done, value } = await reader.read();
          if (done) {
            finish(false);
            output.close();
            return;
          }
          armIdle();
          scanner?.push(value);
          output.enqueue(value);
        } catch (error) {
          const cause = abortCause();
          if (cause === "idle" || cause === "total" || cause === null) {
            this.recordFailure(channel, "unreachable", status, cause === null
              ? `the model gateway stream failed (${this.describe(error, channel.run.apiKey)})`
              : "the model gateway stream stalled");
          }
          finish(true);
          // Bun ends an errored or closed body with a clean chunk terminator, which
          // would pass a cut stream off as complete. Stop writing and let the
          // connection time out instead: the harness then sees a broken transfer.
          server.timeout(request, 1);
          await connectionDropped;
        }
      },
      cancel: () => {
        // The ACP server stopped reading (cancelled turn, dead process, dropped connection).
        controller.abort(new ShimAbort("client"));
        finish(true);
        dropped();
        reader.cancel().catch(() => {});
      },
    });
    return new Response(body, { status: response.status, headers });
  }

  private recordStatus(channel: ShimChannel, status: number): void {
    if (status === 401 || status === 403) {
      this.trip(channel, "auth", status, `the model gateway rejected the gateway key (HTTP ${status})`);
    } else if (status === 429) {
      this.recordFailure(channel, "quota", status, "the model gateway is rate limiting or out of quota");
    } else if (status >= 500) {
      this.recordFailure(channel, "unreachable", status, `the model gateway failed (HTTP ${status})`);
    } else {
      channel.failures = 0;
      channel.failingSince = null;
    }
  }

  private recordFailure(channel: ShimChannel, reason: "unreachable" | "quota", status: number | null, message: string): void {
    const now = this.now();
    channel.failures++;
    channel.failingSince ??= now;
    if (channel.failures >= this.limits.breakerFailures || now - channel.failingSince >= this.limits.breakerWindowMs) {
      this.trip(channel, reason, status, message);
    }
  }

  private trip(channel: ShimChannel, reason: "auth" | "unreachable" | "quota", status: number | null, message: string): void {
    if (channel.fatal || channel.closed) return;
    channel.fatal = { type: "fatal", reason, status, message };
    log.warn(`gateway shim breaker opened for ${channel.tokenPrefix} (${channel.label}): ${reason}${status !== null ? ` HTTP ${status}` : ""}`);
    channel.emit(channel.fatal);
  }

  /** A transport error without anything that could carry the key. */
  private describe(error: unknown, apiKey: string): string {
    const code = (error as { code?: unknown })?.code;
    const text = typeof code === "string" && code ? code : error instanceof Error ? error.name : "error";
    return text.split(apiKey).join("<redacted>").slice(0, 120);
  }
}

/**
 * The real shim in front of the loopback fake upstream of
 * `verifyAntigravityRuntime` (PR 4 §1.4), so `remi runtime prepare` also proves
 * the header policy: Bearer with the real key, no `x-goog-api-key`.
 */
export async function contractCheckShim(upstream: { baseUrl: string; apiKey: string }): Promise<{ host: GatewayShimHost; close(): void }> {
  const shim = new AntigravityGatewayShim({
    assertUpstream: async (url) => {
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("the contract check upstream must be loopback");
    },
  });
  return { host: shim.forRun({ upstreamBase: upstream.baseUrl, apiKey: upstream.apiKey, runId: "contract-check" }), close: () => shim.stop() };
}
