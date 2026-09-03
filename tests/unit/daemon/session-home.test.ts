import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupTemporaryTaskProviderHome,
  prepareIssueSessionProviderHome,
  loadIssueSessionProviderEnv,
  resolveIssueRuntimeStateRoot,
  resolveIssueSessionProviderHome,
  resolveTaskProviderHome,
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
    executionFingerprint: "a".repeat(64),
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
      storageRoot: workspaces,
      root: join(workspaces, ".runtime", "ises_1", "agt_1", "3"),
      home: join(workspaces, ".runtime", "ises_1", "agt_1", "3", "home"),
      sessionId: "ises_1",
      agentId: "agt_1",
      generation: 3,
      provider: "claude",
      runtimeStateRoot: join(workspaces, ".runtime", "ises_1"),
    });
  });

  it("uses a daemon-owned task-scoped home for one-shot non-Issue tasks", () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-task-home-"));
    roots.push(root);
    const workspaces = join(root, "workspaces");
    const nonIssueTask = {
      ...task("claude"),
      id: "tsk_quick_1",
      issueId: null,
      issueSessionId: null,
    } as AgentTask;

    expect(resolveTaskProviderHome(nonIssueTask, join(root, "user-cwd"), workspaces)).toEqual({
      storageRoot: workspaces,
      root: join(workspaces, ".runtime", "tsk_quick_1", "agt_1", "1"),
      home: join(workspaces, ".runtime", "tsk_quick_1", "agt_1", "1", "home"),
      sessionId: "tsk_quick_1",
      agentId: "agt_1",
      generation: 1,
      provider: "claude",
      runtimeStateRoot: join(workspaces, ".runtime", "tsk_quick_1"),
      temporaryTaskRoot: join(workspaces, ".runtime", "tsk_quick_1"),
    });

    const automationTask = {
      ...nonIssueTask,
      id: "tsk_automation_1",
      autopilotRunId: "run_1",
    } as AgentTask;
    expect(resolveTaskProviderHome(automationTask, join(root, "user-cwd"), workspaces))
      .toMatchObject({
        root: join(workspaces, ".runtime", "tsk_automation_1", "agt_1", "1"),
        runtimeStateRoot: join(workspaces, ".runtime", "tsk_automation_1"),
        temporaryTaskRoot: join(workspaces, ".runtime", "tsk_automation_1"),
      });
  });

  it("reuses one Chat provider home across tasks and leaves it for Chat GC", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-chat-home-"));
    roots.push(root);
    const workspaces = join(root, "workspaces");
    const first = {
      ...task("claude"),
      id: "tsk_chat_1",
      issueId: null,
      issueSessionId: null,
      chatSessionId: "chat_1",
    } as AgentTask;
    const second = { ...first, id: "tsk_chat_2" } as AgentTask;
    const firstHome = resolveTaskProviderHome(first, join(root, "cwd"), workspaces)!;
    const secondHome = resolveTaskProviderHome(second, join(root, "cwd"), workspaces)!;

    expect(secondHome).toEqual(firstHome);
    expect(firstHome).toMatchObject({
      storageRoot: workspaces,
      root: join(workspaces, ".runtime", "chat_1", "agt_1", "1"),
      sessionId: "chat_1",
      runtimeStateRoot: join(workspaces, ".runtime", "chat_1"),
    });
    expect(firstHome.temporaryTaskRoot).toBeUndefined();

    await prepareIssueSessionProviderHome(firstHome, {
      baseClaudeConfigDir: join(root, "base"),
      linkClaudeCredentials: false,
    });
    await cleanupTemporaryTaskProviderHome(firstHome, workspaces);
    expect(existsSync(firstHome.home)).toBe(true);
  });

  it("keeps an Issue-bound Chat in the Chat provider home", () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-bound-chat-home-"));
    roots.push(root);
    const workspaces = join(root, "workspaces");
    const boundChat = {
      ...task("claude"),
      id: "tsk_bound_chat",
      chatSessionId: "chat_1",
    } as AgentTask;

    expect(resolveTaskProviderHome(boundChat, join(root, "issue-runtime"), workspaces))
      .toMatchObject({
        root: join(workspaces, ".runtime", "chat_1", "agt_1", "1"),
        sessionId: "chat_1",
        runtimeStateRoot: join(workspaces, ".runtime", "chat_1"),
      });
  });

  it("cleans the whole temporary non-Issue task runtime", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-task-home-cleanup-"));
    roots.push(root);
    const workspaces = join(root, "workspaces");
    const nonIssueTask = {
      ...task("codex"),
      id: "tsk_quick_1",
      issueId: null,
      issueSessionId: null,
    } as AgentTask;
    const resolved = resolveTaskProviderHome(nonIssueTask, join(root, "cwd"), workspaces)!;
    await prepareIssueSessionProviderHome(resolved, {
      baseCodexHome: join(root, "base"),
      linkCodexAuth: false,
    });
    const sibling = join(resolved.temporaryTaskRoot!, ".remi-runtime", "execution.json");
    mkdirSync(join(sibling, ".."), { recursive: true });
    writeFileSync(sibling, "{}\n");

    await cleanupTemporaryTaskProviderHome(resolved, workspaces);

    expect(existsSync(resolved.root)).toBe(false);
    expect(existsSync(sibling)).toBe(false);
    expect(existsSync(resolved.temporaryTaskRoot!)).toBe(false);
  });

  it("uses a deterministic archiveable lineage for legacy Issue tasks", () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-task-home-invalid-"));
    roots.push(root);
    const missingSession = { ...task("claude"), issueSessionId: null } as AgentTask;
    expect(resolveTaskProviderHome(missingSession, join(root, "MUL-1"), join(root, "workspaces")))
      .toEqual({
        storageRoot: join(root, "workspaces"),
        root: join(root, "workspaces", ".runtime", "legacy-iss_1", "agt_1", "1"),
        home: join(root, "workspaces", ".runtime", "legacy-iss_1", "agt_1", "1", "home"),
        sessionId: "legacy-iss_1",
        agentId: "agt_1",
        generation: 1,
        provider: "claude",
        runtimeStateRoot: join(root, "workspaces", ".runtime", "legacy-iss_1"),
      });
  });

  it("isolates Codex Chat homes when the execution fingerprint changes", () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-chat-fingerprint-"));
    roots.push(root);
    const workspaces = join(root, "workspaces");
    const first = {
      ...task("codex"),
      id: "tsk_chat_a",
      issueId: null,
      issueSessionId: null,
      chatSessionId: "chat_1",
      executionFingerprint: "a".repeat(64),
    } as AgentTask;
    const same = { ...first, id: "tsk_chat_a2" } as AgentTask;
    const changed = {
      ...first,
      id: "tsk_chat_b",
      executionFingerprint: "b".repeat(64),
    } as AgentTask;

    const firstHome = resolveTaskProviderHome(first, join(root, "cwd"), workspaces)!;
    const sameHome = resolveTaskProviderHome(same, join(root, "cwd"), workspaces)!;
    const changedHome = resolveTaskProviderHome(changed, join(root, "cwd"), workspaces)!;

    expect(sameHome.home).toBe(firstHome.home);
    expect(changedHome.home).not.toBe(firstHome.home);
    expect(firstHome.root).toBe(join(
      workspaces,
      ".runtime",
      "chat_1",
      "agt_1",
      "1",
      "executions",
      "a".repeat(64),
    ));
    expect(changedHome.root).toEndWith(join("executions", "b".repeat(64)));
  });

  it("keeps Issue archive lineage while isolating failed cold starts and generations", () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-issue-fingerprint-"));
    roots.push(root);
    const workspace = join(root, "MUL-1");
    const first = { ...task("codex", 3), executionFingerprint: "a".repeat(64) } as AgentTask;
    // A provider can fail before a lane is promoted, so the server generation
    // remains 3 even though a freshly claimed task now carries fingerprint B.
    const failedThenChanged = { ...first, id: "tsk_b", executionFingerprint: "b".repeat(64) } as AgentTask;
    const resetGeneration = { ...first, id: "tsk_a_gen4", issueSessionGeneration: 4 } as AgentTask;

    const firstHome = resolveIssueSessionProviderHome(first, workspace, join(root, "workspaces"))!;
    const changedHome = resolveIssueSessionProviderHome(failedThenChanged, workspace, join(root, "workspaces"))!;
    const resetHome = resolveIssueSessionProviderHome(resetGeneration, workspace, join(root, "workspaces"))!;

    expect(changedHome.home).not.toBe(firstHome.home);
    expect(resetHome.home).not.toBe(firstHome.home);
    expect(firstHome.root).toStartWith(join(root, "workspaces", ".runtime", "ises_1", "agt_1", "3"));
    expect(changedHome.root).toStartWith(join(root, "workspaces", ".runtime", "ises_1", "agt_1", "3"));
    expect(resetHome.root).toStartWith(join(root, "workspaces", ".runtime", "ises_1", "agt_1", "4"));
  });

  it("rejects a symlinked Issue Provider Home parent without writing outside", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-issue-home-symlink-"));
    roots.push(root);
    const workspace = join(root, "MUL-1");
    const workspaces = join(root, "workspaces");
    const outside = join(root, "outside");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(workspaces, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(workspaces, ".runtime"), "dir");
    const resolved = resolveIssueSessionProviderHome(task("codex"), workspace, workspaces)!;

    await expect(prepareIssueSessionProviderHome(resolved, {
      baseCodexHome: join(root, "missing-base"),
      linkCodexAuth: false,
    })).rejects.toThrow("must be a real directory");
    expect(existsSync(join(outside, "ises_1"))).toBe(false);
  });

  it("rejects a symlinked Chat Provider Home parent without writing outside", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-chat-home-symlink-"));
    roots.push(root);
    const workspaces = join(root, "workspaces");
    const outside = join(root, "outside");
    mkdirSync(workspaces, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(workspaces, ".runtime"), "dir");
    const chatTask = {
      ...task("claude"),
      issueId: null,
      issueSessionId: null,
      chatSessionId: "chat_1",
    } as AgentTask;
    const resolved = resolveTaskProviderHome(chatTask, join(root, "cwd"), workspaces)!;

    await expect(prepareIssueSessionProviderHome(resolved, {
      baseClaudeConfigDir: join(root, "base"),
      linkClaudeCredentials: false,
    })).rejects.toThrow("must be a real directory");
    expect(existsSync(join(outside, "chat_1"))).toBe(false);
  });

  it("fails closed before cleaning through a symlinked task runtime parent", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-task-cleanup-symlink-"));
    roots.push(root);
    const workspaces = join(root, "workspaces");
    const outside = join(root, "outside");
    mkdirSync(workspaces, { recursive: true });
    mkdirSync(join(outside, "tsk_quick_1"), { recursive: true });
    const victim = join(outside, "tsk_quick_1", "victim.txt");
    writeFileSync(victim, "keep\n");
    symlinkSync(outside, join(workspaces, ".runtime"), "dir");
    const quickTask = {
      ...task("codex"),
      id: "tsk_quick_1",
      issueId: null,
      issueSessionId: null,
    } as AgentTask;
    const resolved = resolveTaskProviderHome(quickTask, join(root, "cwd"), workspaces)!;

    await expect(cleanupTemporaryTaskProviderHome(resolved, workspaces))
      .rejects.toThrow("must be a real directory");
    expect(readFileSync(victim, "utf8")).toBe("keep\n");
  });

  it("seeds a Codex home without requiring auth when runtime credentials come from env", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-session-home-"));
    const baseHome = join(root, "base");
    roots.push(root);
    // A normal Issue session inherits execution settings, not filesystem auth.
    mkdirSync(baseHome, { recursive: true });
    writeFileSync(join(baseHome, "config.toml"), [
      'model = "gpt-test"',
      'model_provider = "Corp"',
      "[model_providers.Corp]",
      'base_url = "https://gateway.example/v1"',
      'experimental_bearer_token = "must-never-enter-task-home"',
      "",
    ].join("\n"));
    writeFileSync(join(baseHome, "auth.json"), "{\"token\":\"secret\"}\n");

    const workspace = join(root, "MUL-1");
    const resolved = resolveIssueSessionProviderHome(task("codex"), workspace, join(root, "workspaces"))!;
    await prepareIssueSessionProviderHome(resolved, { baseCodexHome: baseHome, linkCodexAuth: false });

    expect(existsSync(join(resolved.home, ".multiremi-session-home.json"))).toBe(true);
    const taskConfig = readFileSync(join(resolved.home, "config.toml"), "utf8");
    expect(taskConfig).toContain('model = "gpt-test"');
    expect(taskConfig).not.toContain("must-never-enter-task-home");
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

  it("reconciles non-secret Claude Relay settings on every start", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-session-home-"));
    roots.push(root);
    const resolved = resolveIssueSessionProviderHome(task("claude"), join(root, "MUL-1"), join(root, "workspaces"))!;
    mkdirSync(resolved.home, { recursive: true });
    writeFileSync(join(resolved.home, "settings.json"), JSON.stringify({
      enabledPlugins: { "wiki@example": true },
    }));
    const firstFragment = JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://old.example.com" } });
    expect(await loadIssueSessionProviderEnv(resolved, {
      baseClaudeConfigDir: join(root, "base"),
      relayFragment: firstFragment,
      relayAuthToken: "secret-relay-token",
    })).toEqual({
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "secret-relay-token",
      ANTHROPIC_BASE_URL: "https://old.example.com",
    });

    await prepareIssueSessionProviderHome(resolved, {
      baseClaudeConfigDir: join(root, "base"),
      linkClaudeCredentials: false,
      relayFragment: firstFragment,
    });
    mkdirSync(join(resolved.home, "projects"), { recursive: true });
    writeFileSync(join(resolved.home, "projects", "history.jsonl"), "{\"type\":\"message\"}\n");

    await prepareIssueSessionProviderHome(resolved, {
      baseClaudeConfigDir: join(root, "base"),
      linkClaudeCredentials: false,
      relayFragment: JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://new.example.com" } }),
    });

    const settingsText = readFileSync(join(resolved.home, "settings.json"), "utf8");
    expect(JSON.parse(settingsText).env).toEqual({ ANTHROPIC_BASE_URL: "https://new.example.com" });
    expect(JSON.parse(settingsText).enabledPlugins).toEqual({ "wiki@example": true });
    expect(settingsText).not.toContain("AUTH_TOKEN");
    expect(settingsText).not.toContain("secret-relay-token");
    expect(readFileSync(join(resolved.root, ".multiremi-provider-config-baseline.json"), "utf8"))
      .not.toContain("secret-relay-token");
    expect(readFileSync(join(resolved.home, "projects", "history.jsonl"), "utf8")).toContain("message");

    expect(await loadIssueSessionProviderEnv(resolved, {
      baseClaudeConfigDir: join(root, "base"),
      relayFragment: "",
      relayAuthToken: "",
    })).toEqual({
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_BASE_URL: "",
    });
    await prepareIssueSessionProviderHome(resolved, {
      baseClaudeConfigDir: join(root, "base"),
      linkClaudeCredentials: false,
      relayFragment: "",
    });
    const clearedSettings = readFileSync(join(resolved.home, "settings.json"), "utf8");
    expect(JSON.parse(clearedSettings)).toEqual({
      enabledPlugins: { "wiki@example": true },
    });
    expect(clearedSettings).not.toContain("old.example.com");
    expect(clearedSettings).not.toContain("new.example.com");
    expect(readFileSync(join(resolved.home, "projects", "history.jsonl"), "utf8")).toContain("message");
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

  it("reconciles Relay routing into an existing Codex Plugin home without persisting its token", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-session-home-"));
    roots.push(root);
    const resolved = resolveIssueSessionProviderHome(task("codex"), join(root, "MUL-1"), join(root, "workspaces"))!;
    mkdirSync(resolved.home, { recursive: true });
    writeFileSync(join(resolved.home, ".remi-plugins.json"), "{}\n", { mode: 0o600 });
    writeFileSync(join(resolved.home, "config.toml"), 'model = "gpt-test"\n', { mode: 0o600 });
    writeFileSync(join(resolved.home, "auth.json"), '{"OPENAI_API_KEY":"stale-workspace-token"}\n', { mode: 0o600 });
    expect(await loadIssueSessionProviderEnv(resolved, {
      baseCodexHome: join(root, "base"),
      relayAuthToken: "secret-token",
    })).toEqual({ OPENAI_API_KEY: "secret-token" });

    await prepareIssueSessionProviderHome(resolved, {
      codexPluginInstalled: true,
      linkCodexAuth: false,
      relayFragment: [
        'model_provider = "OpenAI"',
        "[model_providers.OpenAI]",
        'base_url = "https://vip.openremi.fun/v1"',
        'wire_api = "responses"',
      ].join("\n"),
      codexRelayUsesEnvApiKey: true,
    });

    const configText = readFileSync(join(resolved.home, "config.toml"), "utf8");
    expect(configText).toContain('env_key = "OPENAI_API_KEY"');
    expect(configText).toContain("requires_openai_auth = false");
    expect(configText).toContain('model = "gpt-test"');
    expect(configText).not.toContain("secret-token");
    expect(readFileSync(join(resolved.root, ".multiremi-provider-config-baseline.json"), "utf8"))
      .not.toContain("openremi.fun");
    expect(existsSync(join(resolved.home, "auth.json"))).toBe(false);

    writeFileSync(join(resolved.home, "rollout.jsonl"), "{\"type\":\"session\"}\n");
    await prepareIssueSessionProviderHome(resolved, {
      codexPluginInstalled: true,
      linkCodexAuth: false,
      relayFragment: [
        'model_provider = "OpenAI"',
        "[model_providers.OpenAI]",
        'base_url = "https://next.openremi.fun/v1"',
        'wire_api = "responses"',
      ].join("\n"),
      codexRelayUsesEnvApiKey: true,
    });
    expect(readFileSync(join(resolved.home, "config.toml"), "utf8")).toContain(
      'base_url = "https://next.openremi.fun/v1"',
    );
    expect(readFileSync(join(resolved.home, "rollout.jsonl"), "utf8")).toContain("session");

    const nativeHome = join(root, "native-codex");
    mkdirSync(nativeHome, { recursive: true });
    writeFileSync(join(nativeHome, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "native-oauth" },
    }), { mode: 0o600 });
    expect(await loadIssueSessionProviderEnv(resolved, {
      baseCodexHome: nativeHome,
      relayFragment: "",
      relayAuthToken: "",
    })).toEqual({ OPENAI_API_KEY: "" });
    await prepareIssueSessionProviderHome(resolved, {
      baseCodexHome: nativeHome,
      codexPluginInstalled: true,
      relayFragment: "",
      codexRelayUsesEnvApiKey: false,
      linkCodexAuth: true,
    });
    const clearedConfig = readFileSync(join(resolved.home, "config.toml"), "utf8");
    expect(clearedConfig).toContain('model = "gpt-test"');
    expect(clearedConfig).not.toContain("model_provider");
    expect(clearedConfig).not.toContain("openremi.fun");
    expect(readFileSync(join(resolved.home, "rollout.jsonl"), "utf8")).toContain("session");
    expect(readFileSync(join(resolved.home, ".remi-plugins.json"), "utf8")).toBe("{}\n");
    expect(lstatSync(join(resolved.home, "auth.json")).isSymbolicLink()).toBe(true);
  });

  it("fails closed instead of relinking a globally overwritten Codex Relay key after clear", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-session-home-"));
    roots.push(root);
    const baseHome = join(root, "base");
    mkdirSync(baseHome, { recursive: true });
    writeFileSync(join(baseHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "old-relay-token" }), {
      mode: 0o600,
    });
    const resolved = resolveIssueSessionProviderHome(task("codex"), join(root, "MUL-1"), join(root, "workspaces"))!;
    mkdirSync(resolved.home, { recursive: true });
    writeFileSync(join(resolved.home, ".remi-plugins.json"), "{}\n", { mode: 0o600 });
    writeFileSync(join(resolved.home, "config.toml"), [
      'model = "gpt-test"',
      'model_provider = "OldRelay"',
      "[model_providers.OldRelay]",
      'base_url = "https://old.example.com/v1"',
    ].join("\n"), { mode: 0o600 });
    writeFileSync(join(resolved.home, "rollout.jsonl"), "{\"type\":\"session\"}\n");

    await expect(prepareIssueSessionProviderHome(resolved, {
      baseCodexHome: baseHome,
      codexPluginInstalled: true,
      relayFragment: "",
      codexRelayUsesEnvApiKey: false,
      linkCodexAuth: true,
    })).rejects.toMatchObject({
      code: "plugin_codex_native_oauth_required",
      retryKind: "setup_required",
    });

    const config = readFileSync(join(resolved.home, "config.toml"), "utf8");
    expect(config).toContain('model = "gpt-test"');
    expect(config).not.toContain("OldRelay");
    expect(config).not.toContain("old.example.com");
    expect(config).not.toContain("old-relay-token");
    expect(existsSync(join(resolved.home, "auth.json"))).toBe(false);
    expect(readFileSync(join(resolved.home, "rollout.jsonl"), "utf8")).toContain("session");
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
      join(workspaces, "issues", "legacy-iss_1"),
    );
    expect(resolveIssueRuntimeStateRoot(task("claude"), source, workspaces, false)).toBe(source);
  });
});
