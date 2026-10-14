import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import * as nodeFs from "node:fs";
import { parse as parseToml } from "smol-toml";
import {
  cleanupTaskPrivateTempDirectory,
  listIssueConversationRoots,
  prepareIssueExecutionDirectory,
  prepareIssueSessionProviderHome,
  prepareTaskPrivateTempDirectory,
  loadIssueSessionProviderEnv,
  resolveTaskProviderHome,
} from "@daemon/agent-runtime/workspace/session-home.js";
import { executionLaneForTask, subjectForTask, workDirectory } from "@daemon/agent-runtime/workspace/layout.js";
import type { AgentTask } from "@daemon/contracts/types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspaceOf(workspaces: string): string {
  return workDirectory(workspaces, subjectForTask(task("claude")));
}

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
  it("allocates a fresh private temp per execution and cleans only its own directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-task-private-tmp-"));
    roots.push(root);
    const workspaces = join(root, "workspaces");
    const home = resolveTaskProviderHome(task("claude"), workspaces)!;
    const subject = subjectForTask(task("claude"));
    const first = await prepareTaskPrivateTempDirectory(home.storageRoot, subject, "tsk_same");
    const second = await prepareTaskPrivateTempDirectory(home.storageRoot, subject, "tsk_same");
    expect(first.path).not.toBe(second.path);
    writeFileSync(join(first.path, "first.txt"), "first");
    writeFileSync(join(second.path, "second.txt"), "second");

    await cleanupTaskPrivateTempDirectory(first);
    expect(existsSync(first.path)).toBe(false);
    expect(readFileSync(join(second.path, "second.txt"), "utf8")).toBe("second");
    await cleanupTaskPrivateTempDirectory(second);
    expect(existsSync(second.path)).toBe(false);
  });

  // MUL-449: macOS caps a unix socket path at 104 bytes, while a delegation's
  // real task temp directory runs past 220. Each execution therefore gets a
  // short `/tmp/remi-XXXXXXXX` alias, and TMPDIR/TMP/TEMP point at that alias.
  it("allocates a short /tmp alias for the task temp directory on darwin", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-task-tmp-alias-"));
    roots.push(root);
    const home = resolveTaskProviderHome(task("claude"), join(root, "workspaces"))!;
    const subject = subjectForTask(task("claude"));
    const directory = await prepareTaskPrivateTempDirectory(home.storageRoot, subject, "tsk_alias", "darwin");
    if (directory.aliasPath) roots.push(directory.aliasPath);

    expect(directory.aliasPath).toBeDefined();
    // Short enough that a socket inside it stays under the 104-byte cap.
    expect(Buffer.byteLength(directory.aliasPath!)).toBeLessThanOrEqual(24);
    expect(directory.aliasPath!.startsWith("/tmp/remi-")).toBe(true);
    // The alias names the real directory; the real directory does not move.
    expect(lstatSync(directory.aliasPath!).isSymbolicLink()).toBe(true);
    expect(readlinkSync(directory.aliasPath!)).toBe(directory.path);
    expect(directory.path).toContain("task-tmp");

    await cleanupTaskPrivateTempDirectory(directory);
    expect(existsSync(directory.aliasPath!)).toBe(false);
    expect(existsSync(directory.path)).toBe(false);
  });

  it("keeps the alias usable for a unix socket when the real path is too long", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-task-tmp-socket-"));
    roots.push(root);
    // A provider home deep enough to blow macOS's 104-byte `sun_path` cap,
    // shaped like the delegation path the MBP actually uses.
    const deep = join(
      root, "w".repeat(80), "delegations", "d".repeat(60), "executions", "e".repeat(64),
    );
    mkdirSync(deep, { recursive: true });
    const home = resolveTaskProviderHome(task("claude"), join(deep, "workspaces"))!;
    const subject = subjectForTask(task("claude"));
    const directory = await prepareTaskPrivateTempDirectory(home.storageRoot, subject, "tsk_socket", "darwin");
    if (directory.aliasPath) roots.push(directory.aliasPath);

    expect(directory.aliasPath).toBeDefined();
    // The real directory is unusable as a socket directory on macOS: its own
    // path already exceeds the cap before any socket name is appended. Linux
    // accepts longer paths, so assert the length contract rather than trying to
    // reproduce the macOS kernel error here.
    const realSocket = join(directory.path, "probe.sock");
    const aliasSocket = join(directory.aliasPath!, "probe.sock");
    expect(Buffer.byteLength(realSocket)).toBeGreaterThan(104);
    expect(Buffer.byteLength(aliasSocket)).toBeLessThanOrEqual(64);

    // A listener really can bind through the alias, and the node lands in the
    // real directory (the alias is a link, not a copy).
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(aliasSocket, resolve);
    });
    expect(existsSync(join(directory.path, "probe.sock"))).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanupTaskPrivateTempDirectory(directory);
  });

  it("never deletes an alias that is not the one this execution created", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-task-tmp-foreign-"));
    roots.push(root);
    const home = resolveTaskProviderHome(task("claude"), join(root, "workspaces"))!;
    const subject = subjectForTask(task("claude"));
    const directory = await prepareTaskPrivateTempDirectory(home.storageRoot, subject, "tsk_foreign", "darwin");
    expect(directory.aliasPath).toBeDefined();
    // Someone else's directory now occupies the alias name.
    rmSync(directory.aliasPath!, { force: true });
    const foreignTarget = join(root, "foreign");
    mkdirSync(foreignTarget, { recursive: true });
    symlinkSync(foreignTarget, directory.aliasPath!);
    roots.push(directory.aliasPath!);

    await cleanupTaskPrivateTempDirectory({ ...directory, aliasPath: directory.aliasPath });
    // The foreign link and its target survive; only the owned directory goes.
    expect(existsSync(directory.aliasPath!)).toBe(true);
    expect(existsSync(foreignTarget)).toBe(true);
    expect(existsSync(directory.path)).toBe(false);
  });

  it("falls back to the long real path when the alias cannot be created", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-task-tmp-fallback-"));
    roots.push(root);
    const home = resolveTaskProviderHome(task("claude"), join(root, "workspaces"))!;
    const subject = subjectForTask(task("claude"));
    // Force every candidate name to collide, which is the same code path as an
    // unwritable /tmp: the execution keeps the long path and still succeeds.
    const aliasSpy = spyOn(nodeFs, "symlinkSync").mockImplementation(() => {
      throw Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" });
    });
    try {
      const directory = await prepareTaskPrivateTempDirectory(home.storageRoot, subject, "tsk_fallback", "darwin");
      expect(directory.aliasPath).toBeUndefined();
      expect(existsSync(directory.path)).toBe(true);
      await cleanupTaskPrivateTempDirectory(directory);
      expect(existsSync(directory.path)).toBe(false);
    } finally {
      aliasSpy.mockRestore();
    }
  });

  it("does not create an alias on non-darwin platforms", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-task-tmp-linux-"));
    roots.push(root);
    const home = resolveTaskProviderHome(task("claude"), join(root, "workspaces"))!;
    const subject = subjectForTask(task("claude"));
    const directory = await prepareTaskPrivateTempDirectory(home.storageRoot, subject, "tsk_linux", "linux");
    expect(directory.aliasPath).toBeUndefined();
    await cleanupTaskPrivateTempDirectory(directory);
  });

  it("isolates delegation homes below the lane's execution scope", () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-delegation-home-"));
    roots.push(root);
    const main = resolveTaskProviderHome(task("claude"), root)!;
    const first = resolveTaskProviderHome({ ...task("claude"), execution_scope: "dlg_one" }, root)!;
    const second = resolveTaskProviderHome({ ...task("claude"), execution_scope: "dlg_two" }, root)!;
    expect(new Set([main.home, first.home, second.home]).size).toBe(3);
    expect(first.root).toBe(join(root, "env", "iss_1", "ises_1", "agt_1", "dlg_one", "3"));
    expect(second.root).toBe(join(root, "env", "iss_1", "ises_1", "agt_1", "dlg_two", "3"));
  });

  it("uses the stable session/agent/lane-generation layout", () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-session-home-"));
    roots.push(root);

    const workspaces = join(root, "daemon-workspaces");
    expect(resolveTaskProviderHome(task("claude"), workspaces)).toEqual({
      storageRoot: workspaces,
      root: join(workspaces, "env", "iss_1", "ises_1", "agt_1", "main", "3"),
      home: join(workspaces, "env", "iss_1", "ises_1", "agt_1", "main", "3", "home"),
      sessionId: "ises_1",
      agentId: "agt_1",
      generation: 3,
      provider: "claude",
    });
  });

  it("uses a daemon-owned home under the task's own subject for one-shot tasks", () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-task-home-"));
    roots.push(root);
    const workspaces = join(root, "workspaces");
    const nonIssueTask = {
      ...task("claude"),
      id: "tsk_quick_1",
      issueId: null,
      issueSessionId: null,
    } as AgentTask;

    expect(resolveTaskProviderHome(nonIssueTask, workspaces)).toEqual({
      storageRoot: workspaces,
      root: join(workspaces, "env", "tsk_quick_1", "tsk_quick_1", "agt_1", "main", "3"),
      home: join(workspaces, "env", "tsk_quick_1", "tsk_quick_1", "agt_1", "main", "3", "home"),
      sessionId: "tsk_quick_1",
      agentId: "agt_1",
      generation: 3,
      provider: "claude",
    });

    const automationTask = {
      ...nonIssueTask,
      id: "tsk_automation_1",
      autopilotRunId: "run_1",
    } as AgentTask;
    expect(resolveTaskProviderHome(automationTask, workspaces))
      .toMatchObject({ root: join(workspaces, "env", "tsk_automation_1", "tsk_automation_1", "agt_1", "main", "3") });
  });

  it("reuses one Chat provider home across tasks", async () => {
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
    const firstHome = resolveTaskProviderHome(first, workspaces)!;
    const secondHome = resolveTaskProviderHome(second, workspaces)!;

    expect(secondHome).toEqual(firstHome);
    expect(firstHome).toMatchObject({
      storageRoot: workspaces,
      root: join(workspaces, "env", "chat_1", "chat_1", "agt_1", "main", "3"),
      sessionId: "chat_1",
    });

    await prepareIssueSessionProviderHome(firstHome, {
      baseClaudeConfigDir: join(root, "base"),
      linkClaudeCredentials: false,
    });
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

    expect(resolveTaskProviderHome(boundChat, workspaces))
      .toMatchObject({
        root: join(workspaces, "env", "chat_1", "chat_1", "agt_1", "main", "3"),
        sessionId: "chat_1",
      });
  });

  it("falls back to the Issue id when a task carries no Issue session", () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-task-home-invalid-"));
    roots.push(root);
    const missingSession = { ...task("claude"), issueSessionId: null } as AgentTask;
    expect(resolveTaskProviderHome(missingSession, join(root, "workspaces")))
      .toMatchObject({
        root: join(root, "workspaces", "env", "iss_1", "iss_1", "agt_1", "main", "3"),
        sessionId: "iss_1",
        generation: 3,
      });
  });

  it("lists the conversations of an Issue without following links or counting temp directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-conversation-roots-"));
    roots.push(root);
    const workspaces = join(root, "workspaces");
    expect(listIssueConversationRoots(workspaces, "iss_1")).toEqual([]);
    const home = resolveTaskProviderHome(task("claude"), workspaces)!;
    await prepareIssueSessionProviderHome(home, { baseClaudeConfigDir: join(root, "base"), linkClaudeCredentials: false });
    await prepareTaskPrivateTempDirectory(workspaces, subjectForTask(task("claude")), "tsk_home");
    mkdirSync(join(workspaces, "env", "iss_1", "ises_2"));
    symlinkSync(root, join(workspaces, "env", "iss_1", "ises_linked"));
    expect(listIssueConversationRoots(workspaces, "iss_1")).toEqual([
      join(workspaces, "env", "iss_1", "ises_1"),
      join(workspaces, "env", "iss_1", "ises_2"),
    ]);
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

    const firstHome = resolveTaskProviderHome(first, workspaces)!;
    const sameHome = resolveTaskProviderHome(same, workspaces)!;
    const changedHome = resolveTaskProviderHome(changed, workspaces)!;

    expect(sameHome.home).toBe(firstHome.home);
    expect(changedHome.home).not.toBe(firstHome.home);
    expect(firstHome.root).toBe(join(
      workspaces,
      "env",
      "chat_1",
      "chat_1",
      "agt_1",
      "main",
      "3",
      "executions",
      "a".repeat(64),
    ));
    expect(changedHome.root).toEndWith(join("executions", "b".repeat(64)));
  });

  it.each(["chat", "issue"])("isolates custom Claude %s homes while reusing an unchanged connection", (kind) => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-claude-fingerprint-"));
    roots.push(root);
    const workspaces = join(root, "workspaces");
    const first = {
      ...task("claude"),
      ...(kind === "chat" ? { chatSessionId: "chat_claude" } : {}),
      claudeProfile: { name: "private", base_url: "https://example.test", model: "custom", env_key: "REMI_CLAUDE_API_KEY" },
    } as AgentTask;
    const resolve = (input: AgentTask) => resolveTaskProviderHome(input, workspaces)!;
    const home = resolve(first);
    expect(resolve({ ...first, id: "tsk_same" }).home).toBe(home.home);
    expect(resolve({ ...first, executionFingerprint: "b".repeat(64) }).home).not.toBe(home.home);
    expect(resolve({ ...first, claudeProfile: null }).home).not.toBe(home.home);
    expect(home.sessionId).toBe(kind === "chat" ? "chat_claude" : "ises_1");
  });

  it("keeps one lane while isolating failed cold starts and generations", () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-issue-fingerprint-"));
    roots.push(root);
    const first = { ...task("codex", 3), executionFingerprint: "a".repeat(64) } as AgentTask;
    // A provider can fail before a lane is promoted, so the server generation
    // remains 3 even though a freshly claimed task now carries fingerprint B.
    const failedThenChanged = { ...first, id: "tsk_b", executionFingerprint: "b".repeat(64) } as AgentTask;
    const resetGeneration = { ...first, id: "tsk_a_gen4", issueSessionGeneration: 4 } as AgentTask;

    const firstHome = resolveTaskProviderHome(first, join(root, "workspaces"))!;
    const changedHome = resolveTaskProviderHome(failedThenChanged, join(root, "workspaces"))!;
    const resetHome = resolveTaskProviderHome(resetGeneration, join(root, "workspaces"))!;

    expect(changedHome.home).not.toBe(firstHome.home);
    expect(resetHome.home).not.toBe(firstHome.home);
    const lane = join(root, "workspaces", "env", "iss_1", "ises_1", "agt_1", "main");
    expect(firstHome.root).toStartWith(join(lane, "3"));
    expect(changedHome.root).toStartWith(join(lane, "3"));
    expect(resetHome.root).toStartWith(join(lane, "4"));
  });

  it("rejects a symlinked Issue Provider Home parent without writing outside", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-issue-home-symlink-"));
    roots.push(root);
    const workspaces = join(root, "workspaces");
    const outside = join(root, "outside");
    mkdirSync(workspaces, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(workspaces, "env"), "dir");
    const resolved = resolveTaskProviderHome(task("codex"), workspaces)!;

    await expect(prepareIssueSessionProviderHome(resolved, {
      baseCodexHome: join(root, "missing-base"),
      linkCodexAuth: false,
    })).rejects.toThrow("must be a real directory");
    expect(existsSync(join(outside, "iss_1"))).toBe(false);
  });

  it("gives each Issue lane a private execution directory beside its home, apart from the shared workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-issue-execution-dir-"));
    roots.push(root);
    const workspaces = join(root, "workspaces");
    const main = executionLaneForTask(task("claude"))!;
    const delegated = executionLaneForTask({ ...task("claude"), execution_scope: "dlg_one" } as AgentTask)!;

    const mainDirectory = await prepareIssueExecutionDirectory(workspaces, main);
    const delegatedDirectory = await prepareIssueExecutionDirectory(workspaces, delegated);

    expect(mainDirectory).toBe(join(workspaces, "env", "iss_1", "ises_1", "agt_1", "main", "3", "work"));
    expect(delegatedDirectory).toBe(join(workspaces, "env", "iss_1", "ises_1", "agt_1", "dlg_one", "3", "work"));
    expect(lstatSync(mainDirectory).isDirectory()).toBe(true);
    expect(lstatSync(delegatedDirectory).isDirectory()).toBe(true);
    expect(mainDirectory).not.toBe(workspaceOf(workspaces));
    // The directory is created again, untouched, by the next execution of the same lane generation.
    writeFileSync(join(mainDirectory, "marker"), "kept");
    expect(await prepareIssueExecutionDirectory(workspaces, main)).toBe(mainDirectory);
    expect(readFileSync(join(mainDirectory, "marker"), "utf8")).toBe("kept");
    // The shared workspace is not created by preparing a private directory.
    expect(existsSync(workspaceOf(workspaces))).toBe(false);
  });

  it("refuses an execution directory below a symlinked env root without writing outside", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-issue-execution-symlink-"));
    roots.push(root);
    const workspaces = join(root, "workspaces");
    const outside = join(root, "outside");
    mkdirSync(workspaces, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(workspaces, "env"), "dir");

    await expect(prepareIssueExecutionDirectory(workspaces, executionLaneForTask(task("claude"))!))
      .rejects.toThrow("must be a real directory");
    expect(existsSync(join(outside, "iss_1"))).toBe(false);
  });

  it("rejects a symlinked Chat Provider Home parent without writing outside", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-chat-home-symlink-"));
    roots.push(root);
    const workspaces = join(root, "workspaces");
    const outside = join(root, "outside");
    mkdirSync(workspaces, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(workspaces, "env"), "dir");
    const chatTask = {
      ...task("claude"),
      issueId: null,
      issueSessionId: null,
      chatSessionId: "chat_1",
    } as AgentTask;
    const resolved = resolveTaskProviderHome(chatTask, workspaces)!;

    await expect(prepareIssueSessionProviderHome(resolved, {
      baseClaudeConfigDir: join(root, "base"),
      linkClaudeCredentials: false,
    })).rejects.toThrow("must be a real directory");
    expect(existsSync(join(outside, "chat_1"))).toBe(false);
  });

  it("refuses a private temp directory below a symlinked env root without writing outside", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-task-tmp-symlink-"));
    roots.push(root);
    const workspaces = join(root, "workspaces");
    const outside = join(root, "outside");
    mkdirSync(workspaces, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(workspaces, "env"), "dir");

    await expect(prepareTaskPrivateTempDirectory(workspaces, { kind: "task", id: "tsk_quick_1" }, "tsk_quick_1"))
      .rejects.toThrow("must be a real directory");
    expect(existsSync(join(outside, "tsk_quick_1"))).toBe(false);
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

    const resolved = resolveTaskProviderHome(task("codex"), join(root, "workspaces"))!;
    await prepareIssueSessionProviderHome(resolved, { baseCodexHome: baseHome, linkCodexAuth: false });

    expect(existsSync(join(resolved.home, ".multiremi-session-home.json"))).toBe(true);
    const taskConfig = readFileSync(join(resolved.home, "config.toml"), "utf8");
    expect(taskConfig).toContain('model = "gpt-test"');
    expect(taskConfig).not.toContain("must-never-enter-task-home");
    expect(existsSync(join(resolved.home, "auth.json"))).toBe(false);
  });

  it("enables Codex Default-mode request_user_input in every generated home", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-session-home-"));
    const baseHome = join(root, "base");
    roots.push(root);
    mkdirSync(baseHome, { recursive: true });
    writeFileSync(join(baseHome, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "oauth-secret" },
    }), { mode: 0o600 });
    writeFileSync(join(baseHome, "config.toml"), 'model = "gpt-test"\n');

    // Plain Issue Session lane.
    const native = resolveTaskProviderHome(task("codex"), join(root, "workspaces"))!;
    await prepareIssueSessionProviderHome(native, { baseCodexHome: baseHome, linkCodexAuth: false });
    const nativeConfig = parseToml(readFileSync(join(native.home, "config.toml"), "utf8")) as Record<string, any>;
    expect(nativeConfig.features.default_mode_request_user_input).toBe(true);

    // Side conversation lane: reconcile also appends its developer_instructions,
    // which must not displace the features table.
    const side = resolveTaskProviderHome(task("codex"), join(root, "workspaces"))!;
    await prepareIssueSessionProviderHome(side, {
      baseCodexHome: baseHome,
      linkCodexAuth: false,
      sideConversation: true,
    });
    const sideConfig = parseToml(readFileSync(join(side.home, "config.toml"), "utf8")) as Record<string, any>;
    expect(sideConfig.features.default_mode_request_user_input).toBe(true);
    expect(sideConfig.developer_instructions).toContain("Sub-agents are off-limits");
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

    const resolved = resolveTaskProviderHome(task("claude"), join(root, "workspaces"))!;
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
    const resolved = resolveTaskProviderHome(task("claude"), join(root, "workspaces"))!;
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

    const resolved = resolveTaskProviderHome(task("claude"), join(root, "workspaces"))!;
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

    const resolved = resolveTaskProviderHome(task("codex"), join(root, "workspaces"))!;
    await prepareIssueSessionProviderHome(resolved, { baseCodexHome: baseHome, linkCodexAuth: false });

    expect(await loadIssueSessionProviderEnv(resolved, { baseCodexHome: baseHome })).toEqual({
      OPENAI_API_KEY: "sk-static",
    });
    expect(existsSync(join(resolved.home, "auth.json"))).toBe(false);
  });

  it("links subscription OAuth while provider-native history stays in the Issue lineage", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-session-home-"));
    const baseHome = join(root, "base");
    const workspaces = join(root, "workspaces");
    roots.push(root);
    mkdirSync(baseHome, { recursive: true });
    writeFileSync(join(baseHome, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "oauth-secret", account_id: "acct_1" },
    }), { mode: 0o600 });

    const resolved = resolveTaskProviderHome(task("codex"), workspaces)!;
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

    const resolved = resolveTaskProviderHome(task("codex"), join(root, "workspaces"))!;
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

    const resolved = resolveTaskProviderHome(task("codex"), join(root, "workspaces"))!;
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
    const resolved = resolveTaskProviderHome(task("codex"), join(root, "workspaces"))!;
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
    const resolved = resolveTaskProviderHome(task("codex"), join(root, "workspaces"))!;
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

    const resolved = resolveTaskProviderHome(task("codex"), join(root, "workspaces"))!;
    await expect(prepareIssueSessionProviderHome(resolved, { baseCodexHome: baseHome })).rejects.toThrow(
      "must be a private regular file",
    );
  });
});

it("installs side developer instructions in the private Codex config exactly once across restarts", async () => {
  const root = mkdtempSync(join(tmpdir(), "multiremi-side-home-"));
  roots.push(root);
  const baseHome = join(root, "base");
  mkdirSync(baseHome);
  writeFileSync(join(baseHome, "config.toml"), 'model = "gpt-test"\ndeveloper_instructions = "Existing developer rules"\n');
  const resolved = resolveTaskProviderHome(task("codex"), join(root, "workspaces"))!;
  // Plugin/native lane configuration is preserved; host-wide arbitrary
  // instructions are intentionally excluded by the seed allowlist.
  mkdirSync(resolved.home, { recursive: true });
  writeFileSync(join(resolved.home, "config.toml"), readFileSync(join(baseHome, "config.toml")));
  const options = { baseCodexHome: baseHome, linkCodexAuth: false, sideConversation: true, codexPluginInstalled: true };
  await prepareIssueSessionProviderHome(resolved, options);
  const first = readFileSync(join(resolved.home, "config.toml"), "utf8");
  expect(first).toContain("developer_instructions");
  expect(first).toContain("Existing developer rules");
  expect(first).toContain("Sub-agents are off-limits");
  await prepareIssueSessionProviderHome(resolved, options);
  expect(readFileSync(join(resolved.home, "config.toml"), "utf8")).toBe(first);
  expect(readFileSync(join(baseHome, "config.toml"), "utf8")).not.toContain("Sub-agents are off-limits");
});
