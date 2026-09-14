import { parseRuntimeConnectionProfile, type RuntimeConnectionProfile } from "./runtime-connection.js";

export interface RuntimeClaudeProfile extends RuntimeConnectionProfile {
  /** Authentication header expected by the Anthropic Messages endpoint. */
  auth_header?: "bearer" | "x-api-key";
}
export interface RuntimeClaudeProfileConfig { profile: RuntimeClaudeProfile | null }
export interface RuntimeClaudeProfileInput extends RuntimeClaudeProfileConfig { api_key?: string }

export function parseRuntimeClaudeProfile(value: unknown): RuntimeClaudeProfile | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("profile must be an object or null");
  const { auth_header = "bearer", ...connection } = value as Record<string, unknown>;
  if (auth_header !== "bearer" && auth_header !== "x-api-key") throw new Error("Invalid profile auth_header");
  return { ...parseRuntimeConnectionProfile(connection, "REMI_CLAUDE_")!, auth_header };
}
