/** A Runtime-owned model connection. Plaintext credentials are never part of this configuration. */
export interface RuntimeConnectionProfile {
  name: string;
  base_url: string;
  model: string;
  env_key: string;
  auth_mode?: "api_key" | "env";
  /** Opaque immutable credential version; never contains the key. */
  credential_id?: string;
}

export interface RuntimeConnectionProfileConfig {
  profile: RuntimeConnectionProfile | null;
}

export interface RuntimeConnectionProfileInput extends RuntimeConnectionProfileConfig {
  /** Omit to keep the existing key. Never returned by browser APIs. */
  api_key?: string;
}

/** Shared by the control plane and daemon; never accept executable TOML or inline secrets. */
export function parseRuntimeConnectionProfile(value: unknown, envPrefix: "REMI_CODEX_" | "REMI_CLAUDE_"): RuntimeConnectionProfile | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("profile must be an object or null");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !["name", "base_url", "model", "env_key", "auth_mode", "credential_id"].includes(key))) {
    throw new Error("Unsupported profile field; send api_key separately or reference a Runtime variable with env_key");
  }
  const field = (key: string, max: number) => {
    if (typeof row[key] !== "string" || row[key].length > max || /[\x00-\x1f\x7f]/.test(row[key])) {
      throw new Error(`Invalid profile ${key}`);
    }
    return row[key].trim();
  };
  const name = field("name", 64);
  const model = field("model", 200);
  const env_key = field("env_key", 128);
  const auth_mode = row.auth_mode ?? "env";
  if (auth_mode !== "env" && auth_mode !== "api_key") throw new Error("Invalid profile auth_mode");
  const credential_id = row.credential_id;
  if (credential_id !== undefined && (typeof credential_id !== "string" || !/^rck_[a-zA-Z0-9_-]{1,100}$/.test(credential_id))) throw new Error("Invalid credential reference");
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("Profile name must use letters, numbers, underscores or hyphens");
  if (!model) throw new Error("Profile model is required");
  // A dedicated prefix prevents remote configuration from redirecting unrelated daemon secrets.
  if (auth_mode === "env" && !new RegExp(`^${envPrefix}[A-Z0-9_]+$`).test(env_key)) throw new Error(`env_key must name a ${envPrefix}* Runtime environment variable`);
  let url: URL;
  try { url = new URL(field("base_url", 2048)); } catch { throw new Error("Invalid profile base_url"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("base_url must be an HTTP(S) URL without credentials, query or fragment");
  }
  // Only the Runtime connects to this URL; loopback and LAN endpoints are intentional.
  return { name, base_url: url.toString().replace(/\/$/, ""), model, env_key: auth_mode === "env" ? env_key : "", auth_mode,
    ...(auth_mode === "api_key" && credential_id ? { credential_id } : {}) };
}
