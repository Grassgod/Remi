import { parse as parseToml } from "smol-toml";

export type RelayEngine = "claude" | "codex" | "antigravity";

/** Every engine the workspace model gateway can hold a config for. */
export const RELAY_ENGINES: readonly RelayEngine[] = ["claude", "codex", "antigravity"];

export function isRelayEngine(value: string): value is RelayEngine {
  return (RELAY_ENGINES as readonly string[]).includes(value);
}

export type FragmentValidation = { ok: true } | { ok: false; error: string };

// Keys that must never appear anywhere in a fragment. Secrets belong in the
// separate token field; hooks/permissions are executable config out of scope.
const DANGEROUS_KEY = /token|api[_-]?key|secret|authorization|password|credential|bearer/i;
const PROTO_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const FORBIDDEN_TOP = new Set(["hooks", "permissions", "mcpServers", "mcp_servers", "apiKeyHelper"]);

// Claude fragment: only `env` with a whitelisted set of keys. The auth token is a
// separate secret and must never live in the fragment.
const CLAUDE_ENV_ALLOW = new Set([
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "CLAUDE_CODE_ATTRIBUTION_HEADER",
  "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
  "ENABLE_TOOL_SEARCH",
  "MCP_TIMEOUT",
]);

// Codex `[model_providers.<id>]` fixed fields. env_key/experimental_bearer_token/auth
// are rejected: the key travels via the separate token → auth.json path.
const CODEX_PROVIDER_ALLOW = new Set(["name", "base_url", "wire_api", "supports_websockets", "requires_openai_auth"]);

// Antigravity fragment: the Gemini-protocol gateway root and an optional default
// model. The gateway key travels in the separate token field and is held by the
// daemon's local gateway shim; the Antigravity process only ever sees the shim URL.
const ANTIGRAVITY_KEYS = new Set(["base_url", "default_model"]);
const ANTIGRAVITY_MODEL_MAX_CHARS = 200;
// The server builds `<base_url>/v1beta/models/...` itself, so a base that already
// names a version would be requested as `/v1beta/v1beta/...` (or `/v1/v1beta/...`).
const VERSIONED_PATH = /\/v1(?:beta)?$/i;

function hasDangerousKeysDeep(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (PROTO_KEYS.has(key)) return `forbidden key: ${key}`;
    if (DANGEROUS_KEY.test(key)) return `secret-like key not allowed in fragment: ${key}`;
    const child = (value as Record<string, unknown>)[key];
    const nested = hasDangerousKeysDeep(child);
    if (nested) return nested;
  }
  return null;
}

/** https only, host is not an IP literal in a private/loopback/link-local/metadata range. */
export function validateGatewayUrl(raw: string): FragmentValidation {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: `invalid URL: ${raw}` };
  }
  if (url.protocol !== "https:") return { ok: false, error: "gateway URL must be https" };
  if (url.username || url.password) return { ok: false, error: "gateway URL must not embed credentials" };
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return { ok: false, error: "gateway host not allowed" };
  // IPv4 literal check
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    const priv =
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) || // link-local + 169.254.169.254 metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 0;
    if (priv) return { ok: false, error: "gateway host is a private/metadata address" };
  }
  if (host.includes(":") || host === "[::1]" || host.startsWith("[fd") || host.startsWith("[fe80")) {
    return { ok: false, error: "gateway host not allowed" };
  }
  return { ok: true };
}

function validateClaude(text: string): FragmentValidation {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${(err as Error).message}` };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, error: "fragment must be a JSON object" };
  const top = obj as Record<string, unknown>;
  for (const key of Object.keys(top)) {
    if (FORBIDDEN_TOP.has(key)) return { ok: false, error: `key not allowed: ${key}` };
    if (key !== "env") return { ok: false, error: `only "env" is allowed at top level, got: ${key}` };
  }
  const env = top.env;
  if (env !== undefined) {
    if (!env || typeof env !== "object" || Array.isArray(env)) return { ok: false, error: "env must be an object" };
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
      if (!CLAUDE_ENV_ALLOW.has(k)) return { ok: false, error: `env key not allowed: ${k}` };
      if (typeof v !== "string") return { ok: false, error: `env.${k} must be a string` };
      if (k === "ANTHROPIC_BASE_URL") {
        const u = validateGatewayUrl(v);
        if (!u.ok) return u;
      }
    }
  }
  const danger = hasDangerousKeysDeep(top);
  if (danger) return { ok: false, error: danger };
  return { ok: true };
}

function validateCodex(text: string): FragmentValidation {
  let obj: unknown;
  try {
    obj = parseToml(text);
  } catch (err) {
    return { ok: false, error: `invalid TOML: ${(err as Error).message}` };
  }
  if (!obj || typeof obj !== "object") return { ok: false, error: "fragment must be a TOML table" };
  const top = obj as Record<string, unknown>;
  for (const key of Object.keys(top)) {
    if (key !== "model_provider" && key !== "model_providers") {
      return { ok: false, error: `only model_provider / model_providers allowed, got: ${key}` };
    }
  }
  if (top.model_provider !== undefined && typeof top.model_provider !== "string") {
    return { ok: false, error: "model_provider must be a string" };
  }
  const providers = top.model_providers;
  const providerIds: string[] = [];
  if (providers !== undefined) {
    if (!providers || typeof providers !== "object" || Array.isArray(providers)) return { ok: false, error: "model_providers must be a table" };
    for (const [id, table] of Object.entries(providers as Record<string, unknown>)) {
      providerIds.push(id);
      if (!table || typeof table !== "object" || Array.isArray(table)) return { ok: false, error: `model_providers.${id} must be a table` };
      for (const [k, v] of Object.entries(table as Record<string, unknown>)) {
        if (!CODEX_PROVIDER_ALLOW.has(k)) return { ok: false, error: `model_providers.${id}.${k} not allowed` };
        // Strict scalar types so a valid-parsing fragment can't serialize to a
        // nested table Codex refuses to start on.
        if (k === "name" && typeof v !== "string") return { ok: false, error: `${id}.name must be a string` };
        if (k === "wire_api" && v !== "responses") return { ok: false, error: `${id}.wire_api must be "responses"` };
        if ((k === "supports_websockets" || k === "requires_openai_auth") && typeof v !== "boolean") {
          return { ok: false, error: `${id}.${k} must be a boolean` };
        }
        if (k === "base_url") {
          if (typeof v !== "string") return { ok: false, error: `${id}.base_url must be a string` };
          const u = validateGatewayUrl(v);
          if (!u.ok) return u;
        }
      }
    }
  }
  // If the fragment defines providers it must also name the active one, so a
  // deep-merge can never leave `model_provider` pointing at a stale gateway.
  if (providerIds.length > 0 && typeof top.model_provider !== "string") {
    return { ok: false, error: "model_provider is required when model_providers is set" };
  }
  if (typeof top.model_provider === "string" && providerIds.length > 0 && !providerIds.includes(top.model_provider)) {
    return { ok: false, error: `model_provider "${top.model_provider}" has no matching model_providers entry` };
  }
  const danger = hasDangerousKeysDeep(top);
  if (danger) return { ok: false, error: danger };
  return { ok: true };
}

function validateAntigravity(text: string): FragmentValidation {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${(err as Error).message}` };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, error: "fragment must be a JSON object" };
  const top = obj as Record<string, unknown>;
  for (const key of Object.keys(top)) {
    if (!ANTIGRAVITY_KEYS.has(key)) return { ok: false, error: `only base_url / default_model allowed, got: ${key}` };
  }
  if (top.base_url !== undefined) {
    if (typeof top.base_url !== "string") return { ok: false, error: "base_url must be a string" };
    const u = validateGatewayUrl(top.base_url);
    if (!u.ok) return u;
    const url = new URL(top.base_url);
    // Paths are appended to the base verbatim; a query or fragment would end up
    // in the middle of every request URL.
    if (url.search || url.hash) return { ok: false, error: "base_url must not contain a query or fragment" };
    if (VERSIONED_PATH.test(url.pathname.replace(/\/+$/, ""))) {
      return { ok: false, error: "base_url must be the gateway root without /v1beta or /v1 (the server appends /v1beta/...)" };
    }
  }
  if (top.default_model !== undefined) {
    const model = top.default_model;
    if (typeof model !== "string" || !model || model.length > ANTIGRAVITY_MODEL_MAX_CHARS || /[\s\u0000-\u001f\u007f]/.test(model)) {
      return { ok: false, error: `default_model must be a model id of 1-${ANTIGRAVITY_MODEL_MAX_CHARS} characters without whitespace` };
    }
  }
  return { ok: true };
}

export function validateRelayFragment(engine: RelayEngine, text: string): FragmentValidation {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true }; // empty fragment = nothing to merge
  if (engine === "claude") return validateClaude(trimmed);
  if (engine === "antigravity") return validateAntigravity(trimmed);
  return validateCodex(trimmed);
}

function parseAntigravityFragment(fragment: string): { base_url?: unknown; default_model?: unknown } | null {
  const trimmed = fragment.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed) as unknown;
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj as { base_url?: unknown; default_model?: unknown } : null;
  } catch {
    return null;
  }
}

/** The Antigravity engine's configured default model, used when an Agent names none. */
export function extractAntigravityDefaultModel(fragment: string): string | null {
  const model = parseAntigravityFragment(fragment)?.default_model;
  return typeof model === "string" && model ? model : null;
}

/** Extract the gateway base_url from a stored fragment (for server-side discovery). */
export function extractBaseUrl(engine: RelayEngine, fragment: string): string | null {
  const trimmed = fragment.trim();
  if (!trimmed) return null;
  if (engine === "antigravity") {
    const base = parseAntigravityFragment(trimmed)?.base_url;
    return typeof base === "string" && base ? base : null;
  }
  try {
    if (engine === "claude") {
      const obj = JSON.parse(trimmed) as { env?: Record<string, string> };
      return obj?.env?.ANTHROPIC_BASE_URL ?? null;
    }
    const obj = parseToml(trimmed) as { model_provider?: string; model_providers?: Record<string, { base_url?: string }> };
    const providerId = obj.model_provider ?? Object.keys(obj.model_providers ?? {})[0];
    if (!providerId) return null;
    return obj.model_providers?.[providerId]?.base_url ?? null;
  } catch {
    return null;
  }
}
