import type { FeishuSidecarEndpointRegistry } from "./endpoints.js";

export type FeishuEndpointHealthStatus = "ready" | "unreachable" | "unknown";

export interface FeishuEndpointHealthResult {
  name: string;
  status: FeishuEndpointHealthStatus;
  checkedAt: string | null;
  latencyMs: number | null;
  version: string | null;
  capabilities: string[] | null;
  errorCode: string | null;
}

export interface FeishuEndpointHealthCheckerOptions {
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  ttlMs?: number;
}

interface HealthMetadata {
  version: string | null;
  capabilities: string[] | null;
}

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_TTL_MS = 15_000;

export class FeishuEndpointHealthChecker {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, { expiresAt: number; result: FeishuEndpointHealthResult }>();

  constructor(
    private readonly registry: FeishuSidecarEndpointRegistry,
    options: FeishuEndpointHealthCheckerOptions = {},
  ) {
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.ttlMs = Math.max(0, options.ttlMs ?? DEFAULT_TTL_MS);
  }

  async get(name: string, force = false): Promise<FeishuEndpointHealthResult | null> {
    const endpoint = this.registry.get(name);
    if (!endpoint) return null;
    const now = this.now();
    const cached = this.cache.get(name);
    if (!force && cached && cached.expiresAt > now.getTime()) return cached.result;
    const result = await this.probe(name, endpoint, now);
    this.cache.set(name, { expiresAt: now.getTime() + this.ttlMs, result });
    return result;
  }

  unknown(name: string): FeishuEndpointHealthResult {
    return {
      name,
      status: "unknown",
      checkedAt: null,
      latencyMs: null,
      version: null,
      capabilities: null,
      errorCode: null,
    };
  }

  private async probe(name: string, endpoint: string, startedAt: Date): Promise<FeishuEndpointHealthResult> {
    const checkedAt = startedAt.toISOString();
    try {
      const response = await this.request(endpointPath(endpoint, "/healthz"));
      const latencyMs = Math.max(0, this.now().getTime() - startedAt.getTime());
      if (!response.ok) {
        return unreachable(name, checkedAt, latencyMs, `http_${response.status}`);
      }
      const healthMetadata = await readMetadata(response);
      if (healthMetadata === null) {
        return unreachable(name, checkedAt, latencyMs, "invalid_response");
      }
      const agentMetadata = healthMetadata.version || healthMetadata.capabilities
        ? { version: null, capabilities: null }
        : await this.readAgentMetadata(endpoint);
      return {
        name,
        status: "ready",
        checkedAt,
        latencyMs,
        version: healthMetadata.version ?? agentMetadata.version,
        capabilities: healthMetadata.capabilities ?? agentMetadata.capabilities,
        errorCode: null,
      };
    } catch (error) {
      const latencyMs = Math.max(0, this.now().getTime() - startedAt.getTime());
      return unreachable(name, checkedAt, latencyMs, healthErrorCode(error));
    }
  }

  private async readAgentMetadata(endpoint: string): Promise<HealthMetadata> {
    try {
      const response = await this.request(endpointPath(endpoint, "/api/agent/feishu"));
      if (!response.ok) return { version: null, capabilities: null };
      return await readMetadata(response) ?? { version: null, capabilities: null };
    } catch {
      return { version: null, capabilities: null };
    }
  }

  private async request(url: string): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchFn(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

function endpointPath(endpoint: string, pathname: string): string {
  const url = new URL(endpoint);
  url.pathname = `${url.pathname.replace(/\/$/u, "")}${pathname}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function readMetadata(response: Response): Promise<HealthMetadata | null> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("json")) return { version: null, capabilities: null };
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const data = record.data && typeof record.data === "object" && !Array.isArray(record.data)
    ? record.data as Record<string, unknown>
    : record;
  const version = safeVersion(data.version ?? record.version);
  const capabilities = safeCapabilities(data.capabilities ?? record.capabilities);
  return { version, capabilities };
}

function safeVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const version = value.trim();
  return version && version.length <= 64 && /^[A-Za-z0-9._+-]+$/u.test(version) ? version : null;
}

function safeCapabilities(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const capabilities = value.flatMap((entry) => {
    if (typeof entry !== "string") return [];
    const capability = entry.trim();
    return capability && capability.length <= 128 && /^[A-Za-z0-9._:-]+$/u.test(capability) ? [capability] : [];
  });
  return capabilities.length > 0 ? [...new Set(capabilities)].sort() : null;
}

function healthErrorCode(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "timeout";
  if (error instanceof Error && error.name === "AbortError") return "timeout";
  return "connection_refused";
}

function unreachable(
  name: string,
  checkedAt: string,
  latencyMs: number,
  errorCode: string,
): FeishuEndpointHealthResult {
  return {
    name,
    status: "unreachable",
    checkedAt,
    latencyMs,
    version: null,
    capabilities: null,
    errorCode,
  };
}
