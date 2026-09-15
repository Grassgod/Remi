import { parseRuntimeClaudeProfile, type RuntimeClaudeProfile } from "@multiremi/contracts/claude-profile";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** Claude applies project settings after child env. Reject credential overrides
 * before starting it instead of sending the Runtime key in SDK settings/argv. */
export async function assertRuntimeClaudeProjectCredentials(cwd: string): Promise<void> {
  let directory = await realpath(cwd).catch(() => resolve(cwd));
  for (;;) {
    for (const name of ["settings.json", "settings.local.json"]) {
      const path = join(directory, ".claude", name);
      let text: string;
      try { text = await readFile(path, "utf8"); }
      catch (error) {
        if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
        throw new Error(`Cannot read Claude project settings at ${path}`);
      }
      let settings: Record<string, unknown>;
      try { settings = JSON.parse(text.replace(/^\uFEFF/, "")); }
      catch { throw new Error(`Cannot validate Claude project settings at ${path}; fix its JSON before using a Runtime connection`); }
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) continue;
      const env = settings.env && typeof settings.env === "object" ? settings.env : {};
      const conflicts = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"]
        .filter(key => Object.prototype.hasOwnProperty.call(env, key));
      if (Object.prototype.hasOwnProperty.call(settings, "apiKeyHelper")) conflicts.push("apiKeyHelper");
      if (conflicts.length) throw new Error(`Claude project credentials conflict with the Runtime connection: remove ${conflicts.join(", ")} from ${path} and configure credentials in Runtime instead`);
    }
    const parent = dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

/** Non-secret routing applied to both the isolated settings and child environment. */
export function runtimeClaudeProfileRouting(profile: RuntimeClaudeProfile): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: profile.base_url,
    ANTHROPIC_MODEL: profile.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: profile.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: profile.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: profile.model,
    CLAUDE_CODE_SUBAGENT_MODEL: profile.model,
    CLAUDE_CODE_USE_BEDROCK: "0",
    CLAUDE_CODE_USE_VERTEX: "0",
    CLAUDE_CODE_USE_FOUNDRY: "0",
    CLAUDE_MODEL_CONFIG: "",
    ANTHROPIC_CUSTOM_HEADERS: "",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

export function runtimeClaudeProfileEnv(profile: RuntimeClaudeProfile, token: string): Record<string, string> {
  return {
    ...runtimeClaudeProfileRouting(profile),
    ANTHROPIC_API_KEY: profile.auth_header === "x-api-key" ? token : "",
    ANTHROPIC_AUTH_TOKEN: profile.auth_header === "x-api-key" ? "" : token,
    CLAUDE_CODE_OAUTH_TOKEN: "",
  };
}

export function resolveRuntimeClaudeProfile(input: RuntimeClaudeProfile, env: NodeJS.ProcessEnv = process.env, apiKey?: string) {
  const profile = parseRuntimeClaudeProfile(input)!;
  const token = (profile.auth_mode === "api_key" ? apiKey : env[profile.env_key])?.trim();
  if (!token) throw new Error(profile.auth_mode === "api_key" ? "Claude profile API key is unavailable" : `Claude profile requires ${profile.env_key} in the Runtime process environment; configure it and restart the Runtime`);
  return {
    fragment: JSON.stringify({ model: profile.model, env: runtimeClaudeProfileRouting(profile) }),
    auth_token: token,
    revision: 0,
  };
}

export function runtimeClaudeProfileModels(profile: RuntimeClaudeProfile) {
  return [{ id: profile.model, label: profile.model, provider: "claude", default: true }];
}
