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

export class OpenVikingClient implements OpenVikingClientContract {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: OpenVikingClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey.trim();
    if (!this.baseUrl) throw new Error("OpenViking base URL is required");
    if (!this.apiKey) throw new Error("OpenViking API key is required");
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? 30_000);
    this.maxRetries = Math.max(0, Math.min(5, options.maxRetries ?? 2));
    this.fetchImpl = options.fetch ?? fetch;
  }

  async health(): Promise<void> {
    await this.request("/health", { method: "GET" }, true);
  }

  async ensureDirectory(uri: string): Promise<void> {
    try {
      await this.request("/api/v1/fs/mkdir", { method: "POST", body: JSON.stringify({ uri }) });
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
    await this.batchWrite(rootUri, [{ uri, content, precondition: { kind: "replace_if_hash", base_hash: baseHash } }]);
  }

  async remove(uri: string): Promise<void> {
    await this.request(`/api/v1/fs?uri=${encodeURIComponent(uri)}&wait=true`, { method: "DELETE" });
  }

  async setTags(uri: string, tags: string[]): Promise<void> {
    await this.request("/api/v1/content/set_tags", {
      method: "POST",
      body: JSON.stringify({ uri, tags, mode: "replace", recursive: false }),
    });
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
    });
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
    const result = await this.request<unknown>(`/api/v1/snapshot/show?${params.toString()}`, { method: "GET" });
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
      body: JSON.stringify({ root_uri: rootUri, operations, wait: true, timeout: this.timeoutMs / 1_000 }),
    });
  }

  private async request<T = unknown>(path: string, init: RequestInit, allowPlainJson = false): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          ...init,
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            ...(init.body ? { "Content-Type": "application/json" } : {}),
            ...init.headers,
          },
        });
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
        const retryable = response.status === 429 || response.status >= 500;
        throw new OpenVikingClientError(`OpenViking request failed: ${detail}`, response.status, code, retryable);
      } catch (error) {
        const normalized = error instanceof OpenVikingClientError
          ? error
          : new OpenVikingClientError(
            error instanceof Error && error.name === "AbortError" ? "OpenViking request timed out" : "OpenViking request failed",
            null,
            null,
            true,
          );
        lastError = normalized;
        if (!normalized.retryable || attempt === this.maxRetries) throw normalized;
        await delay(Math.min(2_000, 100 * 2 ** attempt));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
