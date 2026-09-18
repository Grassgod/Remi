import { parseRuntimeCodexProfile, type RuntimeCodexProfile } from "@multiremi/contracts/codex-profile.js";
import { parseRuntimeClaudeProfile, type RuntimeClaudeProfile } from "@multiremi/contracts/claude-profile.js";

/**
 * Project a stored profile onto the current daemon wire contract. Preserve its
 * selected upstream/model/credential while accepting historical default fields
 * and dropping schema metadata. Return a new object; callers must retain the
 * stored fingerprint rather than re-hash this representation-only projection.
 */
export function normalizeTaskRuntimeProfile(
  provider: string,
  value: unknown,
): RuntimeCodexProfile | RuntimeClaudeProfile | null {
  if ((provider !== "codex" && provider !== "claude")
    || !value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const connection = {
    name: row.name,
    base_url: row.base_url,
    model: row.model,
    env_key: row.auth_mode === "api_key" ? "" : row.env_key,
    auth_mode: row.auth_mode,
    credential_id: row.credential_id,
    ...(provider === "claude" ? { auth_header: row.auth_header } : {}),
  };
  try {
    return provider === "codex"
      ? parseRuntimeCodexProfile(connection)
      : parseRuntimeClaudeProfile(connection);
  } catch {
    return null;
  }
}

/**
 * Identity of the connection whose catalog supplies capability evidence.
 * Credential versions and display/schema metadata do not change that identity;
 * credential availability is a separate, Runtime-scoped scheduling check.
 * This projection is only for comparison: never rewrite the frozen profile.
 */
export function runtimeProfileCapabilityIdentity(
  provider: string,
  value: unknown,
  modelOverride?: string,
): string | null {
  if ((provider !== "codex" && provider !== "claude")
    || !value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const profile = normalizeTaskRuntimeProfile(provider, {
    ...row,
    name: "execution",
    model: modelOverride ?? row.model,
    credential_id: undefined,
  });
  if (!profile) return null;
  return JSON.stringify([
    provider,
    profile.base_url,
    profile.model,
    profile.auth_mode,
    profile.env_key,
    provider === "claude" ? (profile as RuntimeClaudeProfile).auth_header : null,
  ]);
}
