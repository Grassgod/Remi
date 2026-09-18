import { validCodexNativeCatalog } from "@multiremi/contracts/codex-model-catalog.js";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { sanitizeProviderConfigValue } from "./provider-config-sanitize.js";
import { publicRelayHttpRequest, type RelayHttpRequest } from "@shared/relay-http.js";

const CODEX_CATALOG_MAX_BYTES = 1_000_000;
const CODEX_CATALOG_TIMEOUT_MS = 10_000;

export type CodexModelCatalogState =
  | { status: "disabled" }
  | { status: "loaded" }
  | { status: "error"; error: string };

export type CodexModelCatalogResult =
  | Exclude<CodexModelCatalogState, { status: "loaded" }>
  | { status: "loaded"; content: string };

/** Read only the active Relay fragment's URL; never reuse stale host routing. */
function codexRelayBaseUrl(fragment: string): URL | null {
  let config: Record<string, unknown>;
  try { config = parseToml(fragment) as Record<string, unknown>; }
  catch { throw new Error("Codex Relay fragment is not valid TOML"); }
  const provider = typeof config.model_provider === "string" ? config.model_provider : "";
  const providers = isPlainObject(config.model_providers) ? config.model_providers : {};
  const active = isPlainObject(providers[provider]) ? providers[provider] : {};
  if (typeof active.base_url !== "string" || !active.base_url.trim()) return null;
  let base: URL;
  try { base = new URL(active.base_url); }
  catch { throw new Error("Codex Relay URL is invalid"); }
  if (base.protocol !== "https:" || base.username || base.password) {
    throw new Error("Codex Relay URL must use HTTPS without embedded credentials");
  }
  return base;
}

/** Fetch Codex's complete native catalog. Parsing is validation only: preserve every original byte. */
export async function loadCodexModelCatalog(
  fragment: string,
  token: string,
  httpRequest: RelayHttpRequest = publicRelayHttpRequest,
): Promise<CodexModelCatalogResult> {
  if (!fragment.trim() || !token) return { status: "disabled" };
  try {
    const base = codexRelayBaseUrl(fragment);
    if (!base) return { status: "error", error: "Codex model catalog has no Relay base URL" };
    const response = await httpRequest(new URL("/backend-api/codex/models", base).toString(), {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    }, { timeoutMs: CODEX_CATALOG_TIMEOUT_MS, maxBodyBytes: CODEX_CATALOG_MAX_BYTES });
    if (response.status < 200 || response.status >= 300) {
      return { status: "error", error: `Codex model catalog HTTP ${response.status}` };
    }
    if (Buffer.byteLength(response.text) > CODEX_CATALOG_MAX_BYTES) {
      return { status: "error", error: "Codex model catalog response too large" };
    }
    let catalog: unknown;
    try { catalog = JSON.parse(response.text); }
    catch { return { status: "error", error: "Codex model catalog returned invalid JSON" }; }
    if (!validCodexNativeCatalog(catalog)) {
      return { status: "error", error: "Codex model catalog contains incomplete or invalid native model metadata" };
    }
    return { status: "loaded", content: response.text };
  } catch {
    // Fetch/DNS/JSON diagnostics can contain URLs, headers or echoed payloads.
    return { status: "error", error: "Codex model catalog request failed or timed out" };
  }
}

/** Used after a catalog failure so gateway-only models also receive the error status. */
export async function loadCodexGatewayInventory(
  fragment: string,
  token: string,
  httpRequest: RelayHttpRequest = publicRelayHttpRequest,
): Promise<Array<{ id: string; label: string }>> {
  try {
    const base = codexRelayBaseUrl(fragment);
    if (!base || !token) return [];
    const response = await httpRequest(`${base.toString().replace(/\/+$/, "")}/models`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    }, { timeoutMs: CODEX_CATALOG_TIMEOUT_MS, maxBodyBytes: CODEX_CATALOG_MAX_BYTES });
    if (response.status < 200 || response.status >= 300 || Buffer.byteLength(response.text) > CODEX_CATALOG_MAX_BYTES) return [];
    const body: unknown = JSON.parse(response.text);
    if (!isPlainObject(body) || !Array.isArray(body.data)) return [];
    const models = new Map<string, { id: string; label: string }>();
    for (const model of body.data) {
      if (!isPlainObject(model) || typeof model.id !== "string" || !model.id.trim()) continue;
      const id = model.id.trim();
      models.set(id, { id, label: typeof model.display_name === "string" && model.display_name.trim() ? model.display_name.trim() : id });
    }
    return [...models.values()];
  } catch { return []; }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// ── pure merge helpers (exported for tests) ────────────────────────

/** Recursive object merge: patch keys override, everything else preserved. Arrays/scalars replace. */
export function deepMerge<T extends Record<string, unknown>>(target: T, patch: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key] as Record<string, unknown>, value);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

/** Merge the claude fragment + token into an existing settings.json object. */
export function mergeClaudeSettings(current: Record<string, unknown>, fragment: string, token: string): Record<string, unknown> {
  let patch: Record<string, unknown> = {};
  if (fragment.trim()) {
    // Parse errors can echo the source line — throw a sanitized message.
    try { patch = JSON.parse(fragment) as Record<string, unknown>; }
    catch { throw new Error("claude fragment is not valid JSON"); }
  }
  if (!isPlainObject(patch)) throw new Error("claude fragment is not an object");
  const safeCurrent = sanitizeProviderConfigValue(current) as Record<string, unknown>;
  const safePatch = sanitizeProviderConfigValue(patch) as Record<string, unknown>;
  const merged = deepMerge(safeCurrent, safePatch);
  const env = isPlainObject(merged.env) ? { ...(merged.env as Record<string, unknown>) } : {};
  if (token) env.ANTHROPIC_AUTH_TOKEN = token;
  else delete env.ANTHROPIC_AUTH_TOKEN;
  // A gateway AUTH_TOKEN and an API_KEY are mutually exclusive; the key would bypass the gateway.
  delete env.ANTHROPIC_API_KEY;
  merged.env = env;
  // Fail closed: the base_url must come from THIS fragment, not from a stale value
  // already on the machine — otherwise a token-only wire update would pair the new
  // token with the old local gateway.
  if (token) {
    const patchBase = isPlainObject(safePatch.env)
      ? (safePatch.env as Record<string, unknown>).ANTHROPIC_BASE_URL
      : undefined;
    if (typeof patchBase !== "string" || !patchBase.trim()) {
      throw new Error("refusing to write claude token without a gateway base_url in this fragment");
    }
  }
  return merged;
}

/** Merge the codex fragment into an existing config.toml text, cleaning inline secrets. */
export function mergeCodexConfig(currentToml: string, fragment: string): string {
  // A corrupt existing config.toml may carry a bearer token on the failing line;
  // smol-toml puts that line in its error, so never surface the raw parse error.
  let current: Record<string, unknown> = {};
  if (currentToml.trim()) {
    try { current = parseToml(currentToml) as Record<string, unknown>; }
    catch { throw new Error("existing config.toml is not valid TOML"); }
  }
  let patch: Record<string, unknown> = {};
  if (fragment.trim()) {
    try { patch = parseToml(fragment) as Record<string, unknown>; }
    catch { throw new Error("codex fragment is not valid TOML"); }
  }
  const merged = deepMerge(
    sanitizeProviderConfigValue(current) as Record<string, unknown>,
    sanitizeProviderConfigValue(patch) as Record<string, unknown>,
  );
  // Inline bearer values must not linger next to the auth.json key path.
  // Valid env_key/env_http_headers pointers were already normalized above.
  const providers = merged.model_providers;
  if (isPlainObject(providers)) {
    for (const table of Object.values(providers)) {
      if (isPlainObject(table)) {
        delete (table as Record<string, unknown>).experimental_bearer_token;
      }
    }
  }
  return stringifyToml(merged);
}

/**
 * Merge Relay routing into an Issue Session CODEX_HOME. Relay credentials are
 * supplied to the child process through OPENAI_API_KEY, so the active provider
 * must explicitly read that environment variable instead of requiring Codex's
 * filesystem authentication. No credential value is written to config.toml.
 */
export function mergeCodexSessionConfig(
  currentToml: string,
  fragment: string,
  relayUsesEnvApiKey: boolean,
  modelCatalogPath?: string,
): string {
  const mergedToml = mergeCodexConfig(currentToml, fragment);
  let merged: Record<string, unknown>;
  try {
    merged = parseToml(mergedToml) as Record<string, unknown>;
  } catch {
    // mergeCodexConfig already parsed this value. Keep this sanitized guard in
    // case the serializer/parser contract changes later.
    throw new Error("merged session config.toml is not valid TOML");
  }
  const activeProvider = typeof merged.model_provider === "string"
    ? merged.model_provider.trim()
    : "";
  const providers = isPlainObject(merged.model_providers)
    ? merged.model_providers as Record<string, unknown>
    : null;
  // A local config or Relay fragment must never select an arbitrary file. The
  // only accepted path is the daemon-owned file in this isolated Session home.
  delete merged.model_catalog_json;
  if (modelCatalogPath) merged.model_catalog_json = modelCatalogPath;
  for (const provider of Object.values(providers ?? {})) {
    if (isPlainObject(provider)) delete provider.experimental_bearer_token;
  }
  if (!relayUsesEnvApiKey) return stringifyToml(merged);

  const active = activeProvider && providers && isPlainObject(providers[activeProvider])
    ? providers[activeProvider] as Record<string, unknown>
    : null;
  if (!active) {
    throw new Error("relay session config has no active model provider");
  }
  active.env_key = "OPENAI_API_KEY";
  active.requires_openai_auth = false;
  return stringifyToml(merged);
}
