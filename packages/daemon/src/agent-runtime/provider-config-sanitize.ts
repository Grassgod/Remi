const INLINE_SECRET_CONTAINER_KEYS = new Set([
  "headers",
  "http_headers",
  "query_params",
]);

const INLINE_SECRET_KEY = /token|api[_-]?key|secret|authorization|password|credential|bearer/i;
const ENVIRONMENT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OPAQUE_NAME_MAP_KEYS = new Set([
  "agents",
  "disabledplugins",
  "enabledplugins",
  "mcpservers",
  "modelproviders",
  "profiles",
  "projects",
]);

/**
 * Remove inline credentials from provider configuration before it is written
 * into a task-owned Home. Environment pointers remain safe because the secret
 * value is supplied only to the child process at launch time.
 */
export function sanitizeProviderConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeProviderConfigValue);
  if (!value || typeof value !== "object") return value;

  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase();
    if (normalized === "env_key") {
      if (isEnvironmentVariableName(child)) sanitized[key] = child;
      continue;
    }
    if (normalized === "env_http_headers") {
      const pointers = sanitizeEnvironmentHeaderPointers(child);
      if (pointers) sanitized[key] = pointers;
      continue;
    }
    if (OPAQUE_NAME_MAP_KEYS.has(normalized.replace(/[_-]/g, ""))) {
      sanitized[key] = sanitizeOpaqueNameMap(child);
      continue;
    }
    if (INLINE_SECRET_CONTAINER_KEYS.has(normalized)) continue;
    if (INLINE_SECRET_KEY.test(normalized)) continue;
    sanitized[key] = sanitizeProviderConfigValue(child);
  }
  return sanitized;
}

function sanitizeOpaqueNameMap(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return sanitizeProviderConfigValue(value);
  }
  const sanitized: Record<string, unknown> = {};
  for (const [name, config] of Object.entries(value as Record<string, unknown>)) {
    sanitized[name] = sanitizeProviderConfigValue(config);
  }
  return sanitized;
}

function sanitizeEnvironmentHeaderPointers(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const pointers: Record<string, string> = {};
  for (const [header, environmentVariable] of Object.entries(value as Record<string, unknown>)) {
    if (isEnvironmentVariableName(environmentVariable)) pointers[header] = environmentVariable;
  }
  return Object.keys(pointers).length ? pointers : null;
}

function isEnvironmentVariableName(value: unknown): value is string {
  return typeof value === "string" && ENVIRONMENT_VARIABLE_NAME.test(value);
}
