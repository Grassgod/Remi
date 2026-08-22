import { CliError, cliErrorCodeForStatus } from "./errors.js";

export type CliHttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
export type CliQueryValue = string | number | boolean | null | undefined;

export interface CliRequest {
  method: CliHttpMethod;
  path: string;
  query?: URLSearchParams | Readonly<Record<string, CliQueryValue | readonly CliQueryValue[]>>;
  body?: unknown;
  headers?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  retries?: number | false;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface CliResponse<T> {
  data: T;
  headers: Headers;
  status: number;
}

export interface CliPage<T> {
  items: readonly T[];
  nextCursor: string | null;
  raw: unknown;
}

export interface CliPageRequest<T> extends CliRequest {
  cursorParam?: string;
  page(data: unknown): { items: readonly T[]; nextCursor?: string | null };
}

export interface CliServerCapabilities {
  protocol_version?: number;
  manifest_version?: string;
  server_version?: string;
  [key: string]: unknown;
}

export interface CliApiClientOptions {
  serverUrl: string;
  token?: string | null;
  shareToken?: string | null;
  workspaceId?: string | null;
  timeoutMs?: number;
  maxRetries?: number;
  fetch?: CliFetch;
  sleep?: (ms: number) => Promise<void>;
}

export type CliFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const RETRYABLE_STATUSES = new Set([408, 429, 502, 503, 504]);

export class CliApiClient {
  private readonly serverUrl: string;
  private readonly token: string | null;
  private readonly shareToken: string | null;
  private readonly workspaceId: string | null;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchFn: CliFetch;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private capabilitiesPromise: Promise<CliServerCapabilities> | null = null;

  constructor(options: CliApiClientOptions) {
    const serverUrl = options.serverUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(serverUrl)) throw new CliError("usage", "CLI server URL must use http or https");
    this.serverUrl = serverUrl;
    this.token = options.token?.trim() || null;
    this.shareToken = options.shareToken?.trim() || null;
    if (this.token && this.shareToken) throw new CliError("usage", "CLI access and share credentials cannot be combined");
    this.workspaceId = options.workspaceId?.trim() || null;
    this.timeoutMs = positiveInteger(options.timeoutMs ?? 30_000, "timeoutMs");
    this.maxRetries = nonNegativeInteger(options.maxRetries ?? 2, "maxRetries");
    this.fetchFn = options.fetch ?? fetch;
    this.sleepFn = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async request<T>(request: CliRequest): Promise<CliResponse<T>> {
    if (!request.path.startsWith("/")) throw new CliError("usage", "CLI API path must start with /");
    const retryLimit = request.retries === false
      ? 0
      : nonNegativeInteger(request.retries ?? this.maxRetries, "retries");
    const retryableMethod = request.method === "GET" || request.method === "HEAD" || Boolean(request.idempotencyKey);
    let attempt = 0;
    while (true) {
      try {
        const response = await this.fetchAttempt<T>(request);
        if (response instanceof Response) {
          const error = await responseError(request.method, request.path, response);
          if (retryableMethod && attempt < retryLimit && error.retryable) {
            await this.sleepFn(retryDelayMs(response.headers.get("retry-after"), attempt));
            attempt++;
            continue;
          }
          throw error;
        }
        return response;
      } catch (error) {
        const normalized = normalizeFetchError(error, request.signal);
        if (retryableMethod && attempt < retryLimit && normalized.retryable) {
          await this.sleepFn(retryDelayMs(null, attempt));
          attempt++;
          continue;
        }
        throw normalized;
      }
    }
  }

  async *paginate<T>(request: CliPageRequest<T>): AsyncIterable<CliPage<T>> {
    const cursorParam = request.cursorParam ?? "cursor";
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const query = queryParams(request.query);
      if (cursor) query.set(cursorParam, cursor);
      const response = await this.request<unknown>({ ...request, query });
      const page = request.page(response.data);
      const nextCursor = page.nextCursor?.trim() || null;
      yield { items: page.items, nextCursor, raw: response.data };
      if (nextCursor && seen.has(nextCursor)) {
        throw new CliError("server", `pagination cursor repeated: ${nextCursor}`);
      }
      if (nextCursor) seen.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);
  }

  capabilities(force = false): Promise<CliServerCapabilities> {
    if (force || !this.capabilitiesPromise) {
      this.capabilitiesPromise = this.request<CliServerCapabilities>({
        method: "GET",
        path: "/api/cli/capabilities",
      }).then((response) => response.data).catch((error) => {
        this.capabilitiesPromise = null;
        throw error;
      });
    }
    return this.capabilitiesPromise;
  }

  private async fetchAttempt<T>(request: CliRequest): Promise<CliResponse<T> | Response> {
    const url = new URL(this.serverUrl + request.path);
    const query = queryParams(request.query);
    for (const [key, value] of query) url.searchParams.append(key, value);
    const headers = new Headers(request.headers);
    headers.set("Accept", "application/json");
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
    if (this.shareToken) headers.set("X-Remi-Share", this.shareToken);
    if (this.workspaceId) headers.set("X-Workspace-ID", this.workspaceId);
    if (request.idempotencyKey) headers.set("Idempotency-Key", request.idempotencyKey);
    if (request.body !== undefined) headers.set("Content-Type", "application/json");
    const timeout = request.timeoutMs ?? this.timeoutMs;
    const scope = requestAbortScope(positiveInteger(timeout, "timeoutMs"), request.signal);
    try {
      const response = await this.fetchFn(url, {
        method: request.method,
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: scope.signal,
      });
      if (!response.ok) return response;
      const text = request.method === "HEAD" ? "" : await response.text();
      return {
        data: parseResponseBody(text) as T,
        headers: response.headers,
        status: response.status,
      };
    } catch (error) {
      if (scope.timedOut()) {
        throw new CliError("timeout", `${request.method} ${request.path} timed out after ${timeout}ms`, {
          retryable: true,
          cause: error,
        });
      }
      throw error;
    } finally {
      scope.dispose();
    }
  }
}

function queryParams(query: CliRequest["query"]): URLSearchParams {
  if (query instanceof URLSearchParams) return new URLSearchParams(query);
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(query ?? {})) {
    for (const value of Array.isArray(raw) ? raw : [raw]) {
      if (value !== null && value !== undefined) params.append(key, String(value));
    }
  }
  return params;
}

function requestAbortScope(timeoutMs: number, parent?: AbortSignal): {
  signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
} {
  const controller = new AbortController();
  let timeoutTriggered = false;
  const onParentAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => {
    timeoutTriggered = true;
    controller.abort(new Error("CLI request timed out"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timeoutTriggered,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

async function responseError(method: string, path: string, response: Response): Promise<CliError> {
  const text = await response.text();
  const details = parseResponseBody(text);
  const record = isRecord(details) ? details : null;
  const message = typeof record?.error === "string"
    ? record.error
    : typeof record?.message === "string"
      ? record.message
      : `${method} ${path} returned ${response.status}`;
  return new CliError(cliErrorCodeForStatus(response.status), message, {
    status: response.status,
    retryable: RETRYABLE_STATUSES.has(response.status),
    details,
  });
}

function normalizeFetchError(error: unknown, parent?: AbortSignal): CliError {
  if (error instanceof CliError) return error;
  if (parent?.aborted) {
    return new CliError("network", "CLI request was aborted", { retryable: false, cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new CliError("network", `CLI request failed: ${message}`, { retryable: true, cause: error });
}

function parseResponseBody(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function retryDelayMs(retryAfter: string | null, attempt: number): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 30_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), 30_000);
  }
  return Math.min(200 * (2 ** attempt), 5_000);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new CliError("usage", `${label} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new CliError("usage", `${label} must be a non-negative integer`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
