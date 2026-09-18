import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTask } from "@daemon/contracts/types.js";
import { LocalPathLocker, resolveTaskWorkDir } from "@daemon/agent-runtime/workspace/ephemeral.js";
import { resolveTaskProviderHome, prepareIssueSessionProviderHome } from "@daemon/agent-runtime/workspace/session-home.js";
import { prepareRuntimeWorkspaceContext } from "@daemon/agent-runtime/workspace/runtime-context.js";
import { buildTaskPrompt } from "@daemon/agent-runtime/prompts/ephemeral.js";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "remi-runtime-workspace-test-"));
  temporary.push(base);
  const root = join(base, "workbench");
  const cwd = join(root, "repository");
  const baseHome = join(base, "user-home", ".codex");
  for (const path of [cwd, baseHome, join(root, ".agents", "skills", "private")]) mkdirSync(path, { recursive: true });
  writeFileSync(join(baseHome, "AGENTS.md"), "Use the local compiler.");
  writeFileSync(join(root, "AGENTS.md"), "PARENT_PRIVATE_INSTRUCTION");
  writeFileSync(join(root, ".agents", "skills", "private", "SKILL.md"), "---\nname: private\ndescription: Use when inspecting local research.\n---\nPRIVATE_SKILL_BODY");
  writeFileSync(join(cwd, ".env.local"), 'DEPENDENCY_HOME="../dependencies"\nLOCAL_FEATURE=1\n');
  writeFileSync(join(cwd, "ignored-state.txt"), "Keep me between tasks.");
  const task = {
    id: "tsk_local", workspaceId: "local", prompt: "Inspect", issueId: null, chatSessionId: "chat_local",
    runtimeWorkspaceId: "rws_local", runtimeWorkspace: {
      id: "rws_local", workspaceId: "local", daemonId: "laptop", rootPath: root, cwd: "repository",
      name: "Local research", contextPaths: [], envFile: "repository/.env.local", archivedAt: null,
    },
    agent: { id: "agt_local", name: "Local", provider: "codex", skills: [], instructions: "", customEnv: {} },
    project: null, projectResources: [], repos: [],
  } as unknown as AgentTask;
  const options = {
    daemonIds: ["laptop"], workspacesRoot: join(base, "daemon-state"), locker: new LocalPathLocker(),
    signal: new AbortController().signal, runtimeWorkspaceLeaseRoot: join(base, "leases"),
    onWaitLocalDirectory: () => {},
  };
  return { base, root, cwd, baseHome, task, options };
}

describe("Runtime workspace local execution", () => {
  it("uses the original non-Git directory and retains ignored files across tasks", async () => {
    const { root, cwd, task, options } = fixture();
    const before = readdirSync(cwd);
    const resolved = await resolveTaskWorkDir(task, options);
    expect(resolved.workDir).toBe(cwd);
    expect(resolved.ensureDir).toBe(false);
    expect(resolved.localDirectory).toBe(true);
    resolved.release?.();
    const reused = await resolveTaskWorkDir({ ...task, id: "second" }, options);
    try {
      expect(reused.workDir).toBe(cwd);
      expect(readdirSync(cwd)).toEqual(before);
      expect(readFileSync(join(cwd, "ignored-state.txt"), "utf8")).toBe("Keep me between tasks.");
      expect(existsSync(join(root, ".multiremi"))).toBe(false);
    } finally { reused.release?.(); }
  });

  it("loads parent and user context locally without embedding file contents in the server prompt", async () => {
    const { base, root, cwd, baseHome, task, options } = fixture();
    const home = resolveTaskProviderHome(task, options.workspacesRoot, options.workspacesRoot)!;
    await prepareIssueSessionProviderHome(home, { baseCodexHome: baseHome, linkCodexAuth: false });
    const env = prepareRuntimeWorkspaceContext(task, home, cwd, { baseHome, userHome: join(base, "user-home") });
    const instructions = readFileSync(join(home.home, "AGENTS.md"), "utf8");
    expect(instructions).toContain("Use the local compiler.");
    expect(instructions).toContain("PARENT_PRIVATE_INSTRUCTION");
    expect(instructions).toContain("Use when inspecting local research.");
    expect(instructions).toContain(JSON.stringify(realpathSync(join(root, ".agents", "skills", "private", "SKILL.md"))));
    expect(instructions).not.toContain("PRIVATE_SKILL_BODY");
    expect(env).toEqual({ DEPENDENCY_HOME: "../dependencies", LOCAL_FEATURE: "1" });
    expect(buildTaskPrompt(task)).not.toContain("PARENT_PRIVATE_INSTRUCTION");
    expect(buildTaskPrompt(task)).not.toContain("LOCAL_FEATURE");
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe("PARENT_PRIVATE_INSTRUCTION");
    expect(existsSync(join(cwd, ".multiremi"))).toBe(false);
  });

  it("fails closed on wrong hosts, missing directories and escaping cwd", async () => {
    const { task, options } = fixture();
    await expect(resolveTaskWorkDir(task, { ...options, daemonIds: ["other"] })).rejects.toThrow("unavailable");
    task.runtimeWorkspace!.cwd = "missing";
    await expect(resolveTaskWorkDir(task, options)).rejects.toThrow("does not exist");
    task.runtimeWorkspace!.cwd = "../user-home";
    await expect(resolveTaskWorkDir(task, options)).rejects.toThrow("escapes");
  });

  it("serializes independently instantiated daemon lockers and cancels waiting cleanly", async () => {
    const { task, options } = fixture();
    const first = await resolveTaskWorkDir(task, options);
    const controller = new AbortController();
    let waited = false;
    try {
      const second = resolveTaskWorkDir({ ...task, id: "second" }, {
        ...options, locker: new LocalPathLocker(), signal: controller.signal,
        onWaitLocalDirectory: () => { waited = true; controller.abort(); },
      });
      await expect(second).rejects.toThrow();
      expect(waited).toBe(true);
    } finally { first.release?.(); }
    const third = await resolveTaskWorkDir({ ...task, id: "third" }, options);
    third.release?.();
  });
});
