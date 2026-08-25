export const FEISHU_SIDECAR_ENDPOINTS_ENV = "MULTIREMI_FEISHU_SIDECAR_ENDPOINTS";

export interface FeishuSidecarEndpointRegistry {
  get(name: string): string | null;
  has(name: string): boolean;
  names(): string[];
}

export function feishuSidecarEndpointsFromEnv(
  value = process.env[FEISHU_SIDECAR_ENDPOINTS_ENV],
): FeishuSidecarEndpointRegistry {
  const endpoints = new Map<string, string>();
  const entries = String(value ?? "")
    .split(/[\n,]/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const separator = entry.indexOf("=");
    if (separator < 1) throw new Error(`Invalid Feishu sidecar endpoint entry at index ${index}`);
    const name = normalizeFeishuSidecarEndpointName(entry.slice(0, separator));
    if (endpoints.has(name)) throw new Error(`Duplicate Feishu sidecar endpoint name: ${name}`);
    endpoints.set(name, normalizeConfiguredEndpoint(entry.slice(separator + 1), index));
  }
  return {
    get: (name) => endpoints.get(name.trim()) ?? null,
    has: (name) => endpoints.has(name.trim()),
    names: () => [...endpoints.keys()].sort(),
  };
}

export function normalizeFeishuSidecarEndpointName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(name)) {
    throw new Error("Feishu sidecar endpoint_name must start with a letter and contain only lowercase letters, numbers, _ or -");
  }
  return name;
}

function normalizeConfiguredEndpoint(value: string, index: number): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value.trim());
  } catch {
    throw new Error(`Invalid Feishu sidecar endpoint URL at index ${index}`);
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error(`Feishu sidecar endpoint at index ${index} must use http or https`);
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error(`Feishu sidecar endpoint at index ${index} must not contain credentials, query, or fragment`);
  }
  return endpoint.toString().replace(/\/$/u, "");
}
