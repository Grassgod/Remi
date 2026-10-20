import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTask } from "@daemon/contracts/types.js";
import { LocalPathLocker, lockedFolderOf, resolveTaskWorkDir } from "@daemon/agent-runtime/workspace/ephemeral.js";
import { resolveTaskProviderHome, prepareIssueSessionProviderHome, seedIssueSessionAntigravityHome } from "@daemon/agent-runtime/workspace/session-home.js";
import { symlinkSync } from "node:fs";
import { PROVIDER_INSTRUCTIONS_MARKER, prepareRuntimeWorkspaceContext, writeProviderInstructions } from "@daemon/agent-runtime/workspace/runtime-context.js";
import { providerHomeSkillRoot, syncAgentSkills } from "@daemon/agent-runtime/skills/ephemeral.js";
import { statSync } from "node:fs";
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
  it("keeps default runtime leases in the shared test run root", async () => {
    const { cwd, task, options } = fixture();
    const resolved = await resolveTaskWorkDir(task, { ...options, runtimeWorkspaceLeaseRoot: undefined });
    try {
      const leasesRoot = join(process.env.MULTIREMI_TEST_RUN_ROOT!, "shared-locks", "runtime-workspace-leases");
      const entries = readdirSync(leasesRoot);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.some(entry => {
        const ownerPath = join(leasesRoot, entry, "owner.lock", "owner.json");
        return existsSync(ownerPath) && JSON.parse(readFileSync(ownerPath, "utf8")).workspace_root === realpathSync(cwd);
      })).toBe(true);
      expect(existsSync(join(process.env.MULTIREMI_STATE_DIR!, "runtime-workspace-leases"))).toBe(false);
    } finally { resolved.release?.(); }
  });

  it("uses the original non-Git directory and retains ignored files across tasks", async () => {
    const { root, cwd, task, options } = fixture();
    const before = readdirSync(cwd);
    const resolved = await resolveTaskWorkDir(task, options);
    expect(resolved.workDir).toBe(cwd);
    expect(resolved.ensureDir).toBe(false);
    expect(resolved.localDirectory).toBe(true);
    // PR 6: the lock a parked lane's process keeps, as the lane's next attempt computes it.
    expect(resolved.lockPath).toBe(realpathSync(cwd));
    expect(lockedFolderOf(task, options.daemonIds)).toBe(resolved.lockPath!);
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
    const home = resolveTaskProviderHome(task, options.workspacesRoot)!;
    await prepareIssueSessionProviderHome(home, { baseCodexHome: baseHome, linkCodexAuth: false });
    const env = prepareRuntimeWorkspaceContext(task, home, cwd);
    const instructions = readFileSync(join(home.home, "AGENTS.md"), "utf8");
    // ADR 0023: the user's own ~/.codex/AGENTS.md is not part of an Agent's definition.
    expect(instructions).not.toContain("Use the local compiler.");
    expect(instructions.startsWith(PROVIDER_INSTRUCTIONS_MARKER)).toBe(true);
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

  it("keeps Antigravity's home, gateway routing and Google credentials out of the env file, but not other providers' Google tools", async () => {
    const { base, cwd, task, options } = fixture();
    writeFileSync(join(cwd, ".env.local"), "GOOGLE_APPLICATION_CREDENTIALS=/creds.json\n");
    const codexHome = resolveTaskProviderHome(task, options.workspacesRoot)!;
    await prepareIssueSessionProviderHome(codexHome, { baseCodexHome: join(base, "user-home", ".codex"), linkCodexAuth: false });
    expect(prepareRuntimeWorkspaceContext(task, codexHome, cwd))
      .toEqual({ GOOGLE_APPLICATION_CREDENTIALS: "/creds.json" });
    const agyTask = { ...task, agent: { ...task.agent!, provider: "antigravity" } } as AgentTask;
    const agyHome = resolveTaskProviderHome(agyTask, options.workspacesRoot)!;
    await prepareIssueSessionProviderHome(agyHome);
    for (const line of ["GOOGLE_APPLICATION_CREDENTIALS=/creds.json", "GEMINI_HOME=/elsewhere", "GEMINI_API_KEY=k", "AGY_LLM_GATEWAY_URL=https://x", "ANTIGRAVITY_HARNESS_PATH=/h"]) {
      writeFileSync(join(cwd, ".env.local"), `${line}\n`);
      expect(() => prepareRuntimeWorkspaceContext(agyTask, agyHome, cwd))
        .toThrow(`cannot override ${line.split("=")[0]}`);
    }
  });

  it("seeds the Antigravity home on every start and refuses a linked settings file", async () => {
    const { base, cwd, task, options } = fixture();
    const agyTask = { ...task, agent: { ...task.agent!, provider: "antigravity" } } as AgentTask;
    const home = resolveTaskProviderHome(agyTask, options.workspacesRoot)!;
    await prepareIssueSessionProviderHome(home);
    await seedIssueSessionAntigravityHome(home, { cwd, workspaceDir: base });
    const settings = join(home.home, "antigravity-acp", "settings.json");
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ auth: { type: "gateway" } });
    expect(JSON.parse(readFileSync(join(home.home, "antigravity-acp", "trusted_workspaces.json"), "utf8")))
      .toEqual({ trusted: [], untrusted: [realpathSync(cwd), realpathSync(base)] });
    // A model can rewrite its own home; the next start must not write through a planted link.
    rmSync(settings);
    const outside = join(base, "outside.json");
    writeFileSync(outside, "{}");
    symlinkSync(outside, settings);
    await expect(seedIssueSessionAntigravityHome(home, { cwd })).rejects.toThrow("regular file");
    expect(readFileSync(outside, "utf8")).toBe("{}");
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

  it("writes one AGENTS.md in the provider home, a CLAUDE.md that imports it, atomically and only on change", async () => {
    const { task, options } = fixture();
    const claudeTask = { ...task, agent: { ...task.agent!, provider: "claude" } } as AgentTask;
    const home = resolveTaskProviderHome(claudeTask, options.workspacesRoot)!;
    await prepareIssueSessionProviderHome(home, { linkClaudeCredentials: false });
    const written = writeProviderInstructions(home, { remi: "# Remi\nNotes.", local: "# Runtime workspace local context\nLocal." })!;
    expect(written).toBe(`${PROVIDER_INSTRUCTIONS_MARKER}\n\n# Remi\nNotes.\n\n# Runtime workspace local context\nLocal.\n`);
    expect(readFileSync(join(home.home, "AGENTS.md"), "utf8")).toBe(written);
    expect(readFileSync(join(home.home, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
    const before = statSync(join(home.home, "AGENTS.md")).ino;
    writeProviderInstructions(home, { remi: "# Remi\nNotes.", local: "# Runtime workspace local context\nLocal." });
    expect(statSync(join(home.home, "AGENTS.md")).ino).toBe(before);
    writeProviderInstructions(home, { remi: "# Remi\nChanged." });
    expect(readFileSync(join(home.home, "AGENTS.md"), "utf8")).toContain("Changed.");
    expect(readdirSync(home.home).filter(name => name.endsWith(".tmp"))).toEqual([]);
    // Nothing to write: Remi's own files go, anyone else's stay.
    writeProviderInstructions(home, {});
    expect(existsSync(join(home.home, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(home.home, "CLAUDE.md"))).toBe(false);
    writeFileSync(join(home.home, "AGENTS.md"), "my own notes");
    writeProviderInstructions(home, {});
    expect(readFileSync(join(home.home, "AGENTS.md"), "utf8")).toBe("my own notes");
    // A planted link is never written through.
    rmSync(join(home.home, "AGENTS.md"));
    const outside = join(options.workspacesRoot, "..", "outside.md");
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(home.home, "AGENTS.md"));
    expect(() => writeProviderInstructions(home, { remi: "# Remi" })).toThrow("unlinked regular file");
    expect(readFileSync(outside, "utf8")).toBe("outside");
  });

  it("installs the Agent's skills where the provider finds them and removes the ones it no longer has", () => {
    const { base, task } = fixture();
    const root = providerHomeSkillRoot(join(base, "home"), "claude");
    expect(root).toBe(join(base, "home", "skills"));
    expect(providerHomeSkillRoot(join(base, "home"), "antigravity")).toBe(join(base, "home", ".agents", "skills"));
    const skill = (name: string, files: Array<{ path: string; content: string }> = []) => ({ name, description: `${name} skill`, content: `# ${name}`, files });
    syncAgentSkills(root, { ...task, agent: { ...task.agent!, skills: [skill("Review", [{ path: "ref.md", content: "r" }]), skill("Deploy")] } } as AgentTask);
    mkdirSync(join(root, ".system", "builtin"), { recursive: true });
    mkdirSync(join(root, "own-skill"), { recursive: true });
    // The frontmatter ends on its own line; Codex skips a SKILL.md whose closing `---` runs into the body.
    // ADR 0025: its `name` is the directory name, the one `/review` invokes.
    expect(readFileSync(join(root, "review", "SKILL.md"), "utf8")).toBe('---\nname: "review"\ndescription: "Review skill"\n---\n# Review');
    expect(readFileSync(join(root, "review", "ref.md"), "utf8")).toBe("r");
    syncAgentSkills(root, { ...task, agent: { ...task.agent!, skills: [skill("Review")] } } as AgentTask);
    expect(existsSync(join(root, "deploy"))).toBe(false);
    expect(existsSync(join(root, "review", "ref.md"))).toBe(false);
    expect(existsSync(join(root, ".system", "builtin"))).toBe(true);
    expect(existsSync(join(root, "own-skill"))).toBe(true);
    syncAgentSkills(root, { ...task, agent: { ...task.agent!, skills: [] } } as AgentTask);
    expect(existsSync(join(root, "review"))).toBe(false);
    expect(existsSync(join(root, "own-skill"))).toBe(true);
  });

  it("never writes into or deletes a skill directory Remi did not create", () => {
    const { base, task } = fixture();
    const root = join(base, "exec", ".claude", "skills");
    // Someone else's skill already has the Agent skill's name.
    mkdirSync(join(root, "review"), { recursive: true });
    writeFileSync(join(root, "review", "SKILL.md"), "mine");
    const skill = (name: string) => ({ name, description: `${name} skill`, content: `# ${name}`, files: [] });
    syncAgentSkills(root, { ...task, agent: { ...task.agent!, skills: [skill("Review"), skill("Deploy")] } } as AgentTask);
    expect(readFileSync(join(root, "review", "SKILL.md"), "utf8")).toBe("mine");
    expect(existsSync(join(root, "deploy", "SKILL.md"))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, ".remi-skills.json"), "utf8"))).toEqual({ skills: ["deploy"] });
    // Removing the Agent's skills removes only what Remi recorded.
    syncAgentSkills(root, { ...task, agent: { ...task.agent!, skills: [] } } as AgentTask);
    expect(readFileSync(join(root, "review", "SKILL.md"), "utf8")).toBe("mine");
    expect(existsSync(join(root, "deploy"))).toBe(false);
  });

  it("keeps the user's personal Codex skills out of every session config", async () => {
    const { base, task, options } = fixture();
    const personal = join(base, "personal-home");
    mkdirSync(join(personal, ".agents", "skills", "my-private"), { recursive: true });
    writeFileSync(join(personal, ".agents", "skills", "my-private", "SKILL.md"), "---\nname: my-private\n---\nbody");
    const home = resolveTaskProviderHome(task, options.workspacesRoot)!;
    await prepareIssueSessionProviderHome(home, { baseCodexHome: join(base, "user-home", ".codex"), linkCodexAuth: false, personalSkillsHome: personal });
    const config = readFileSync(join(home.home, "config.toml"), "utf8");
    expect(config).toContain("[[skills.config]]");
    expect(config).toContain(JSON.stringify(join(realpathSync(personal), ".agents", "skills", "my-private", "SKILL.md")));
    expect(config).toContain("enabled = false");
    const none = resolveTaskProviderHome({ ...task, agent: { ...task.agent!, id: "agt_other" } } as AgentTask, options.workspacesRoot)!;
    await prepareIssueSessionProviderHome(none, { baseCodexHome: join(base, "user-home", ".codex"), linkCodexAuth: false, personalSkillsHome: join(base, "nobody") });
    expect(readFileSync(join(none.home, "config.toml"), "utf8")).not.toContain("skills.config");
  });
});
