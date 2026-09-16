import { expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseRuntimeClaudeProfile } from "@multiremi/contracts/claude-profile";
import { assertRuntimeClaudeProjectCredentials, resolveRuntimeClaudeProfile, runtimeClaudeProfileEnv, runtimeClaudeProfileRouting } from "@daemon/agent-runtime/claude-profile.js";
import { prepareIssueSessionProviderHome, type IssueSessionProviderHome } from "@daemon/agent-runtime/workspace/session-home.js";
import { ClaudeAdapter } from "@acp/adapters/claude-code/index.js";

const profile = { name: "custom", base_url: "http://127.0.0.1:9000", model: "unlisted-model", env_key: "REMI_CLAUDE_CUSTOM" };

it("rejects project credential overrides without disclosing their values or changing project settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "remi-claude-project-auth-"));
  try {
    const cwd = join(root, "project", "child");
    await mkdir(cwd, { recursive: true });
    await mkdir(join(root, "project", ".claude"));
    const path = join(root, "project", ".claude", "settings.local.json");
    const safe = { env: { ANTHROPIC_BASE_URL: "http://old.invalid", ANTHROPIC_MODEL: "old" }, hooks: {} };
    await writeFile(path, JSON.stringify(safe));
    await assertRuntimeClaudeProjectCredentials(cwd);
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "apiKeyHelper"]) {
      const text = JSON.stringify(key === "apiKeyHelper" ? { ...safe, apiKeyHelper: "private-value" } : { ...safe, env: { [key]: "private-value" } });
      await writeFile(path, text);
      const error = await assertRuntimeClaudeProjectCredentials(cwd).catch(error => error as Error);
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error("Expected project credential conflict");
      expect(error.message).toContain(key);
      expect(error.message).not.toContain("private-value");
      expect(await readFile(path, "utf8")).toBe(text);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("validates Claude auth headers and fails closed when its dedicated environment credential is missing", () => {
  expect(parseRuntimeClaudeProfile(profile)?.auth_header).toBe("bearer");
  expect(() => parseRuntimeClaudeProfile({ ...profile, auth_header: "custom-header" })).toThrow("auth_header");
  expect(() => parseRuntimeClaudeProfile({ ...profile, env_key: "REMI_CODEX_KEY" })).toThrow("REMI_CLAUDE_");
  expect(() => resolveRuntimeClaudeProfile(profile, { ANTHROPIC_API_KEY: "unrelated" })).toThrow("REMI_CLAUDE_CUSTOM");
});

it("keeps keys out of the isolated settings and sends the selected auth header only through child env", async () => {
  const root = await mkdtemp(join(tmpdir(), "remi-claude-profile-"));
  try {
    const original = JSON.stringify({ model: "old-model", env: { ANTHROPIC_BASE_URL: "https://old.example", ANTHROPIC_API_KEY: "old-key", CLAUDE_CODE_USE_BEDROCK: "1" } });
    await writeFile(join(root, "settings.json"), original);
    const home: IssueSessionProviderHome = { storageRoot: root, root: join(root, "execution"), home: join(root, "execution", "home"), provider: "claude", agentId: "agent", sessionId: "session", generation: 1 };
    for (const auth_header of ["bearer", "x-api-key"] as const) {
      const configured = { ...profile, auth_header };
      const relay = resolveRuntimeClaudeProfile(configured, { REMI_CLAUDE_CUSTOM: "in-memory-key" });
      await prepareIssueSessionProviderHome(home, { baseClaudeConfigDir: root, linkClaudeCredentials: false, relayFragment: relay.fragment });
      const text = await readFile(join(home.home, "settings.json"), "utf8");
      expect(text).not.toContain("in-memory-key");
      expect(text).not.toContain("old-key");
      expect(JSON.parse(text)).toMatchObject({ model: profile.model, env: { ANTHROPIC_BASE_URL: profile.base_url, CLAUDE_CODE_USE_BEDROCK: "0" } });
      const env = runtimeClaudeProfileEnv(configured, relay.auth_token);
      expect(env.ANTHROPIC_API_KEY).toBe(auth_header === "x-api-key" ? "in-memory-key" : "");
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe(auth_header === "bearer" ? "in-memory-key" : "");
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("");
      const settings = { model: profile.model, env: runtimeClaudeProfileRouting(configured) };
      const meta = new ClaudeAdapter().buildSessionMeta({ model: profile.model, claudeSettings: settings });
      expect(meta?.claudeCode?.options?.settings).toEqual(settings);
      expect(JSON.stringify(meta)).not.toContain("in-memory-key");
    }
    expect(await readFile(join(root, "settings.json"), "utf8")).toBe(original);
    expect(await Bun.file(join(home.home, ".credentials.json")).exists()).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
