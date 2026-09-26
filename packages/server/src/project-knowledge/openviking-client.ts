import type {
  OpenVikingClientContract,
  OpenVikingFindHit,
  OpenVikingSnapshotCommit,
} from "./types.js";

type FetchLike = typeof fetch;

interface OpenVikingEnvelope<T> {
  status?: string;
  result?: T;
  error?: { code?: string; message?: string; details?: unknown } | string | null;
}

export interface OpenVikingClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetch?: FetchLike;
  signal?: AbortSignal;
  /** Epoch ms by which every attempt, retry and backoff must have finished. */
  deadlineAt?: number;
}

export const OPENVIKING_DEFAULT_ATTEMPT_TIMEOUT_MS = 15_000;
/** Hard cap: an env value above this is clamped rather than multiplying a hang. */
export const OPENVIKING_MAX_RETRIES = 2;

interface RequestOptions {
  allowPlainJson?: boolean;
  rawText?: boolean;
  /** Replaying the request after an ambiguous failure cannot change the outcome. Defaults to GET/HEAD. */
  idempotent?: boolean;
}

export class OpenVikingClientError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** The caller's overall deadline ran out; no further attempt was or will be made. */
export class OpenVikingDeadlineError extends OpenVikingClientError {
  constructor(readonly operation: string | null = null, readonly attempts = 0) {
    super("OpenViking request deadline exceeded", null, "DEADLINE_EXCEEDED", false);
  }
}

/** A configured per-attempt timeout never outlives the caller's deadline, however large the env sets it. */
export function clampAttemptTimeoutMs(configuredMs: number, deadlineAt: number | undefined, now = Date.now()): number {
  if (deadlineAt === undefined) return configuredMs;
  return Math.max(0, Math.min(configuredMs, deadlineAt - now));
}

/** Aborts at `deadlineAt` with an `OpenVikingDeadlineError`, so callers can tell it from their own cancellation. */
export function openVikingDeadlineSignal(deadlineAt: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new OpenVikingDeadlineError()), Math.max(0, deadlineAt - Date.now()));
  (timer as { unref?: () => void }).unref?.();
  return controller.signal;
}

export class OpenVikingClient implements OpenVikingClientContract {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: OpenVikingClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey.trim();
    if (!this.baseUrl) throw new Error("OpenViking base URL is required");
    if (!this.apiKey) throw new Error("OpenViking API key is required");
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? OPENVIKING_DEFAULT_ATTEMPT_TIMEOUT_MS);
    this.maxRetries = Math.max(0, Math.min(OPENVIKING_MAX_RETRIES, options.maxRetries ?? OPENVIKING_MAX_RETRIES));
    this.fetchImpl = options.fetch ?? fetch;
  }

  withSignal(signal: AbortSignal): OpenVikingClient {
    return new OpenVikingClient({ ...this.options, signal: this.options.signal
      ? AbortSignal.any([this.options.signal, signal]) : signal });
  }

  /** Bound every call on the returned client by one overall deadline; nested deadlines keep the earlier one. */
  withDeadline(deadlineAt: number): OpenVikingClient {
    const at = Math.min(deadlineAt, this.options.deadlineAt ?? Infinity);
    const deadline = openVikingDeadlineSignal(at);
    return new OpenVikingClient({
      ...this.options,
      deadlineAt: at,
      signal: this.options.signal ? AbortSignal.any([this.options.signal, deadline]) : deadline,
    });
  }

  async health(): Promise<void> {
    await this.request("/health", { method: "GET" }, { allowPlainJson: true });
  }

  async ensureDirectory(uri: string): Promise<void> {
    try {
      // mkdir treats an existing directory as success, so a replay is harmless.
      await this.request("/api/v1/fs/mkdir", { method: "POST", body: JSON.stringify({ uri }) }, { idempotent: true });
    } catch (error) {
      if (error instanceof OpenVikingClientError && (error.status === 409 || error.code === "ALREADY_EXISTS")) return;
      throw error;
    }
  }

  async read(uri: string): Promise<string> {
    const result = await this.request<unknown>(`/api/v1/content/read?raw=true&uri=${encodeURIComponent(uri)}`, { method: "GET" });
    if (typeof result !== "string") throw new OpenVikingClientError("OpenViking read returned non-text content", 502, null, false);
    return result;
  }

  async exists(uri: string): Promise<boolean> {
    try {
      await this.request(`/api/v1/fs/stat?uri=${encodeURIComponent(uri)}`, { method: "GET" });
      return true;
    } catch (error) {
      if (error instanceof OpenVikingClientError && error.status === 404) return false;
      throw error;
    }
  }

  async create(uri: string, rootUri: string, content: string): Promise<void> {
    await this.batchWrite(rootUri, [{ uri, content, precondition: { kind: "create_if_absent" } }]);
  }

  async replace(uri: string, rootUri: string, content: string, baseHash: string): Promise<void> {
    await this.batchWrite(rootUri, [{
      uri,
      content,
      precondition: { kind: "replace_if_hash", base_hash: openVikingContentHash(baseHash) },
    }]);
  }

  async remove(uri: string, options: { wait?: boolean } = {}): Promise<void> {
    try {
      // A replayed delete of an already-removed path answers 404, which is success here.
      await this.request(
        `/api/v1/fs?uri=${encodeURIComponent(uri)}&wait=${options.wait !== false}`,
        { method: "DELETE" },
        { idempotent: true },
      );
    } catch (error) {
      if (error instanceof OpenVikingClientError && error.status === 404) return;
      throw error;
    }
  }

  async setTags(uri: string, tags: string[]): Promise<void> {
    // mode=replace sets the full tag list, so applying it twice leaves the same state.
    await this.request("/api/v1/content/set_tags", {
      method: "POST",
      body: JSON.stringify({ uri, tags, mode: "replace", recursive: false }),
    }, { idempotent: true });
  }

  async find(query: string, targetUri: string | string[], limit: number, tags: string[] = []): Promise<OpenVikingFindHit[]> {
    const result = await this.request<Record<string, unknown>>("/api/v1/search/find", {
      method: "POST",
      body: JSON.stringify({
        query,
        target_uri: targetUri,
        limit,
        tags: tags.length ? tags : undefined,
        include_provenance: true,
      }),
    }, { idempotent: true });
    const collections = [result?.resources, result?.memories, result?.skills];
    const hits: OpenVikingFindHit[] = [];
    for (const collection of collections) {
      if (!Array.isArray(collection)) continue;
      for (const value of collection) {
        if (!isRecord(value) || typeof value.uri !== "string") continue;
        hits.push({
          uri: value.uri,
          score: typeof value.score === "number" ? value.score : null,
          abstract: typeof value.abstract === "string" ? value.abstract : null,
          tags: Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === "string") : [],
        });
      }
    }
    return hits.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity)).slice(0, limit);
  }

  async commit(message: string, paths: string[]): Promise<string | null> {
    const result = await this.request<unknown>("/api/v1/snapshot/commit", {
      method: "POST",
      body: JSON.stringify({ message, paths, branch: "main", author_name: "Multiremi" }),
    });
    if (typeof result === "string") return result;
    if (!isRecord(result)) return null;
    return stringField(result, "oid", "commit_oid", "commitOid", "id");
  }

  async log(paths: string[], limit = 100): Promise<OpenVikingSnapshotCommit[]> {
    const params = new URLSearchParams({ branch: "main", limit: String(Math.max(1, Math.min(500, limit))) });
    for (const path of paths.slice(0, 32)) params.append("paths", path);
    const result = await this.request<unknown>(`/api/v1/snapshot/log?${params.toString()}`, { method: "GET" });
    const rows = Array.isArray(result) ? result : isRecord(result) && Array.isArray(result.commits) ? result.commits : [];
    return rows.flatMap((value): OpenVikingSnapshotCommit[] => {
      if (!isRecord(value)) return [];
      const message = stringField(value, "message") ?? "";
      return [{
        oid: stringField(value, "oid", "commit_oid", "commitOid", "id"),
        message,
        createdAt: stringField(value, "created_at", "createdAt", "timestamp", "date"),
      }];
    });
  }

  async show(targetRef: string, path: string): Promise<string> {
    const params = new URLSearchParams({ target_ref: targetRef, path, raw: "true" });
    const result = await this.request<unknown>(
      `/api/v1/snapshot/show?${params.toString()}`,
      { method: "GET" },
      { rawText: true },
    );
    if (typeof result === "string") return result;
    if (isRecord(result)) {
      const content = stringField(result, "content", "body", "text");
      if (content !== null) return content;
    }
    throw new OpenVikingClientError("OpenViking snapshot show returned non-text content", 502, null, false);
  }

  private async batchWrite(rootUri: string, operations: unknown[]): Promise<void> {
    await this.request("/api/v1/content/batch-write", {
      method: "POST",
      body: JSON.stringify({ root_uri: rootUri, operations, wait: false }),
    });
  }

  private async request<T = unknown>(path: string, init: RequestInit, options: RequestOptions = {}): Promise<T> {
    const { allowPlainJson = false, rawText = false } = options;
    const method = (init.method ?? "GET").toUpperCase();
    const idempotent = options.idempotent ?? (method === "GET" || method === "HEAD");
    const operation = `${method} ${path.split("?")[0]}`;
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      this.throwIfStopped(operation, attempt);
      const attemptTimeoutMs = clampAttemptTimeoutMs(this.timeoutMs, this.options.deadlineAt);
      if (attemptTimeoutMs <= 0) throw new OpenVikingDeadlineError(operation, attempt);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
      // Only a write OpenViking provably did not apply may be replayed; a timeout or
      // 5xx leaves the outcome unknown, so non-idempotent writes stop there.
      let replaySafe = idempotent;
      try {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          ...init,
          signal: this.options.signal ? AbortSignal.any([controller.signal, this.options.signal]) : controller.signal,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            ...(init.body ? { "Content-Type": "application/json" } : {}),
            ...init.headers,
          },
        });
        if (response.ok && rawText) return await response.text() as T;
        const payload = await response.json().catch(() => null) as OpenVikingEnvelope<T> | null;
        if (response.ok && allowPlainJson && payload?.status !== "error") {
          return (payload?.status === "ok" ? payload.result : payload) as T;
        }
        if (response.ok && payload?.status === "ok") return payload.result as T;
        const code = isRecord(payload?.error) && typeof payload?.error.code === "string" ? payload.error.code : null;
        const rawDetail = typeof payload?.error === "string"
          ? payload.error
          : isRecord(payload?.error) && typeof payload.error.message === "string"
            ? payload.error.message
            : `HTTP ${response.status}`;
        const detail = rawDetail.replaceAll(this.apiKey, "[REDACTED]");
        const errorDetails = isRecord(payload?.error) && isRecord(payload.error.details)
          ? payload.error.details
          : null;
        const rejectedUnapplied = response.status === 429 || errorDetails?.retryable === true;
        const retryable = rejectedUnapplied || response.status >= 500;
        if (rejectedUnapplied) replaySafe = true;
        throw new OpenVikingClientError(`OpenViking request failed: ${detail}`, response.status, code, retryable);
      } catch (error) {
        this.throwIfStopped(operation, attempt + 1);
        const timedOut = error instanceof Error && error.name === "AbortError";
        // The clamp, not the configured attempt timeout, ended this attempt: the deadline is spent.
        if (timedOut && attemptTimeoutMs < this.timeoutMs) throw new OpenVikingDeadlineError(operation, attempt + 1);
        const normalized = error instanceof OpenVikingClientError
          ? error
          : new OpenVikingClientError(
            timedOut ? "OpenViking request timed out" : "OpenViking request failed",
            null,
            timedOut ? "TIMEOUT" : null,
            true,
          );
        lastError = normalized;
        if (!normalized.retryable || !replaySafe || attempt === this.maxRetries) throw normalized;
        const backoffMs = Math.min(2_000, 100 * 2 ** attempt);
        // No room for another attempt after the backoff: report the real failure now.
        if (this.options.deadlineAt !== undefined && this.options.deadlineAt - Date.now() <= backoffMs) throw normalized;
        try {
          await delay(backoffMs, this.options.signal);
        } catch (aborted) {
          this.throwIfStopped(operation, attempt + 1);
          throw aborted;
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }

  /** Surface caller cancellation as-is, and deadline expiry with the operation that ran out of time. */
  private throwIfStopped(operation: string, attempts: number): void {
    const signal = this.options.signal;
    if (!signal?.aborted) return;
    if (signal.reason instanceof OpenVikingDeadlineError) throw new OpenVikingDeadlineError(operation, attempts);
    throw signal.reason;
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    if (typeof value[key] === "string" && String(value[key]).trim()) return String(value[key]);
  }
  return null;
}

function openVikingContentHash(value: string): string {
  const digest = value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("OpenViking base hash must be a SHA-256 digest");
  return `sha256:${digest}`;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
