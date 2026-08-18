import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareIssueSessionProviderHome,
  loadIssueSessionProviderEnv,
  resolveIssueRuntimeStateRoot,
  resolveIssueSessionProviderHome,
} from "@daemon/agent-runtime/workspace/session-home.js";
import type { AgentTask } from "@daemon/contracts/types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function task(provider: "claude" | "codex", generation = 3): AgentTask {
  return {
    id: "tsk_home",
    workspaceId: "ws_1",
    prompt: "test",
    issueId: "iss_1",
    issueSessionId: "ises_1",
    issueSessionGeneration: generation,
    agent: { id: "agt_1", provider } as AgentTask["agent"],
  } as AgentTask;
}

describe("Issue Session provider home", () => {
  it("uses the stable session/agent/lane-generation layout", () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-session-home-"));
    roots.push(root);

    const workspace = join(root, "MUL-1");
    const workspaces = join(root, "daemon-workspaces");
    expect(resolveIssueSessionProviderHome(task("claude"), workspace, workspaces)).toEqual({
      root: join(workspace, ".multiremi", "sessions", "ises_1", "agt_1", "3"),
      home: join(workspace, ".multiremi", "sessions", "ises_1", "agt_1", "3", "home"),
      sessionId: "ises_1",
      agentId: "agt_1",
      generation: 3,
      provider: "claude",
    });
  });

  it("seeds a Codex home without requiring auth when runtime credentials come from env", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-session-home-"));
    const baseHome = join(root, "base");
    roots.push(root);
    // A normal Issue session inherits execution settings, not filesystem auth.
    mkdirSync(baseHome, { recursive: true });
    writeFileSync(join(baseHome, "config.toml"), "model = \"gpt-test\"\n");
    writeFileSync(join(baseHome, "auth.json"), "{\"token\":\"secret\"}\n");

    const workspace = join(root, "MUL-1");
    const resolved = resolveIssueSessionProviderHome(task("codex"), workspace, join(root, "workspaces"))!;
    await prepareIssueSessionProviderHome(resolved, { baseCodexHome: baseHome, linkCodexAuth: false });

    expect(existsSync(join(resolved.home, ".multiremi-session-home.json"))).toBe(true);
    expect(readFileSync(join(resolved.home, "config.toml"), "utf8")).toContain('model = "gpt-test"');
    expect(existsSync(join(resolved.home, "auth.json"))).toBe(false);
  });

  it("copies only whitelisted Claude execution settings", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-session-home-"));
    const baseHome = join(root, "base");
    roots.push(root);
    mkdirSync(baseHome, { recursive: true });
    writeFileSync(join(baseHome, "settings.json"), JSON.stringify({
      model: "claude-test",
      language: "zh-CN",
      alwaysThinkingEnabled: true,
      env: {
        ANTHROPIC_AUTH_TOKEN: "secret",
        ANTHROPIC_BASE_URL: "https://gateway.example",
        API_TOKEN: "other-secret",
      },
      hooks: { SessionStart: [{ command: "steal-secret" }] },
      enabledPlugins: { dangerous: true },
      mcpServers: { private: { command: "private-server" } },
    }));

    const resolved = resolveIssueSessionProviderHome(task("claude"), join(root, "MUL-1"), join(root, "workspaces"))!;
    await prepareIssueSessionProviderHome(resolved, { baseClaudeConfigDir: baseHome, linkClaudeCredentials: false });

    expect(JSON.parse(readFileSync(join(resolved.home, "settings.json"), "utf8"))).toEqual({
      model: "claude-test",
      language: "zh-CN",
      alwaysThinkingEnabled: true,
    });
    expect(await loadIssueSessionProviderEnv(resolved, { baseClaudeConfigDir: baseHome })).toEqual({
      ANTHROPIC_AUTH_TOKEN: "secret",
      ANTHROPIC_BASE_URL: "https://gateway.example",
    });
    expect(readFileSync(join(resolved.home, "settings.json"), "utf8")).not.toContain("secret");
  });

  it("links Claude filesystem credentials when no env credential is available", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-session-home-"));
    const baseHome = join(root, "base");
    roots.push(root);
    mkdirSync(baseHome, { recursive: true });
    writeFileSync(join(baseHome, ".credentials.json"), "{\"oauthToken\":\"secret\"}\n", { mode: 0o600 });

    const resolved = resolveIssueSessionProviderHome(task("claude"), join(root, "MUL-1"), join(root, "workspaces"))!;
    await prepareIssueSessionProviderHome(resolved, { baseClaudeConfigDir: baseHome });

    const credentialsLink = join(resolved.home, ".credentials.json");
    expect(lstatSync(credentialsLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(credentialsLink)).toBe(join(baseHome, ".credentials.json"));
    expect(readFileSync(credentialsLink, "utf8")).toContain("oauthToken");
  });

  it("injects a static Codex key in memory without copying auth.json", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-session-home-"));
    const baseHome = join(root, "base");
    roots.push(root);
    mkdirSync(baseHome, { recursive: true });
    writeFileSync(join(baseHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-static" }));

    const resolved = resolveIssueSessionProviderHome(task("codex"), join(root, "MUL-1"), join(root, "workspaces"))!;
    await prepareIssueSessionProviderHome(resolved, { baseCodexHome: baseHome, linkCodexAuth: false });

    expect(await loadIssueSessionProviderEnv(resolved, { baseCodexHome: baseHome })).toEqual({
      OPENAI_API_KEY: "sk-static",
    });
    expect(existsSync(join(resolved.home, "auth.json"))).toBe(false);
  });

  it("links subscription OAuth while provider-native history stays in the Issue lineage", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-session-home-"));
    const baseHome = join(root, "base");
    const workspace = join(root, "MUL-1");
    const workspaces = join(root, "workspaces");
    roots.push(root);
    mkdirSync(baseHome, { recursive: true });
    writeFileSync(join(baseHome, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "oauth-secret", account_id: "acct_1" },
    }), { mode: 0o600 });

    const resolved = resolveIssueSessionProviderHome(task("codex"), workspace, workspaces)!;
    expect(await loadIssueSessionProviderEnv(resolved, { baseCodexHome: baseHome })).toEqual({});
    await prepareIssueSessionProviderHome(resolved, { baseCodexHome: baseHome });

    const authLink = join(resolved.home, "auth.json");
    expect(lstatSync(authLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(authLink)).toBe(join(baseHome, "auth.json"));
    expect((lstatSync(join(baseHome, "auth.json")).mode & 0o777)).toBe(0o600);
    expect(JSON.parse(readFileSync(authLink, "utf8"))).toMatchObject({
      auth_mode: "chatgpt",
      tokens: { access_token: "oauth-secret" },
    });
    mkdirSync(join(resolved.home, "sessions"), { recursive: true });
    writeFileSync(join(resolved.home, "sessions", "rollout.jsonl"), "{\"type\":\"session\"}\n");
    expect(readFileSync(join(resolved.root, "home", "sessions", "rollout.jsonl"), "utf8")).toContain("session");
  });

  it("reconciles OAuth when a prepared Relay home is reused after Relay removal", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-session-home-"));
    const baseHome = join(root, "base");
    roots.push(root);
    mkdirSync(baseHome, { recursive: true });
    writeFileSync(join(baseHome, "auth.json"), "{\"tokens\":{\"access_token\":\"oauth\"}}\n", { mode: 0o600 });

    const resolved = resolveIssueSessionProviderHome(task("codex"), join(root, "MUL-1"), join(root, "workspaces"))!;
    await prepareIssueSessionProviderHome(resolved, { baseCodexHome: baseHome, linkCodexAuth: false });
    expect(existsSync(join(resolved.home, "auth.json"))).toBe(false);

    await prepareIssueSessionProviderHome(resolved, { baseCodexHome: baseHome, linkCodexAuth: true });
    expect(lstatSync(join(resolved.home, "auth.json")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(resolved.home, "auth.json"))).toBe(join(baseHome, "auth.json"));
  });

  it("reconciles OAuth into a Codex Plugin home that was published without auth", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-session-home-"));
    const baseHome = join(root, "base");
    roots.push(root);
    mkdirSync(baseHome, { recursive: true });
    writeFileSync(join(baseHome, "auth.json"), "{\"tokens\":{\"access_token\":\"oauth\"}}\n", { mode: 0o600 });

    const resolved = resolveIssueSessionProviderHome(task("codex"), join(root, "MUL-1"), join(root, "workspaces"))!;
    mkdirSync(resolved.home, { recursive: true });
    writeFileSync(join(resolved.home, ".remi-plugins.json"), "{}\n", { mode: 0o600 });
    await prepareIssueSessionProviderHome(resolved, {
      baseCodexHome: baseHome,
      codexPluginInstalled: true,
      linkCodexAuth: true,
    });

    expect(lstatSync(join(resolved.home, "auth.json")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(resolved.home, "auth.json"))).toBe(join(baseHome, "auth.json"));
  });

  it("rejects an OAuth credential source with unsafe permissions", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-session-home-"));
    const baseHome = join(root, "base");
    roots.push(root);
    mkdirSync(baseHome, { recursive: true });
    writeFileSync(join(baseHome, "auth.json"), "{\"tokens\":{}}\n", { mode: 0o644 });

    const resolved = resolveIssueSessionProviderHome(task("codex"), join(root, "MUL-1"), join(root, "workspaces"))!;
    await expect(prepareIssueSessionProviderHome(resolved, { baseCodexHome: baseHome })).rejects.toThrow(
      "must be a private regular file",
    );
  });

  it("redirects defensive local-directory Issue state into a daemon sidecar", () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-session-home-"));
    roots.push(root);
    const source = join(root, "user-checkout");
    const workspaces = join(root, "workspaces");

    expect(resolveIssueRuntimeStateRoot(task("claude"), source, workspaces, true)).toBe(
      join(workspaces, ".issue-runtime", "iss_1"),
    );
    expect(resolveIssueRuntimeStateRoot(task("claude"), source, workspaces, false)).toBe(source);
  });
});
