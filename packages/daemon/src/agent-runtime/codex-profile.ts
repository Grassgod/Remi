import { stringify } from "smol-toml";
import { parseRuntimeCodexProfile, type RuntimeCodexProfile } from "@multiremi/contracts/codex-profile";

/** Flatten the profile into isolated CODEX_HOME, independent of Codex's profile-file version. */
export function resolveRuntimeCodexProfile(input: RuntimeCodexProfile, env: NodeJS.ProcessEnv = process.env, apiKey?: string) {
  const profile = parseRuntimeCodexProfile(input)!;
  const token = (profile.auth_mode === "api_key" ? apiKey : env[profile.env_key])?.trim();
  if (!token) throw new Error(profile.auth_mode === "api_key" ? "Codex profile API key is unavailable" : `Codex profile requires ${profile.env_key} in the Runtime process environment; configure it and restart the Runtime`);
  return {
    fragment: stringify({
      model: profile.model,
      model_provider: "remi_custom",
      model_providers: {
        remi_custom: { name: profile.name, base_url: profile.base_url, wire_api: "responses", env_key: "OPENAI_API_KEY", requires_openai_auth: false },
      },
    }),
    auth_token: token,
    revision: 0,
  };
}

export function runtimeCodexProfileModels(profile: RuntimeCodexProfile) {
  return [{ id: profile.model, label: profile.model, provider: "codex", default: true }];
}
