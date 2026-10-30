import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultiremiDaemon } from "@multiremi/daemon.js";
import type { AcpProviderOptions } from "@acp/provider.js";
import type { AgentTask } from "@daemon/contracts/types.js";
import { buildTaskEnv } from "@daemon/agent-runtime/env/injector.js";
import { loadIssueSessionProviderEnv, prepareIssueSessionProviderHome, resolveTaskProviderHome } from "@daemon/agent-runtime/workspace/session-home.js";
import { runtimeWorkspaceContext, writeProviderInstructions } from "@daemon/agent-runtime/workspace/runtime-context.js";
import { providerHomeSkillRoot, syncAgentSkills } from "@daemon/agent-runtime/skills/ephemeral.js";
import { disabledSshMeshRuntime } from "../../helpers/ssh-mesh-isolation.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "remi-cursor-runtime-"));
  roots.push(root);
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const task = {
    id: "cursor-task", workspaceId: "local", chatSessionId: "cursor-chat", prompt: "Inspect the project",
    repos: [], projectResources: [], holdsWorkspace: false,
    agent: { id: "cursor-agent", name: "Cursor", provider: "cursor", instructions: "Use the review checklist.",
      model: "auto", customEnv: {}, skills: [{ name: "Review", description: "Review changes", content: "Check correctness." }] },
  } as unknown as AgentTask;
  const home = resolveTaskProviderHome(task, join(root, "state"))!;
  return { root, cwd, task, home };
}

describe("Cursor runtime integration", () => {
  it("keeps the gateway key in memory and clears prior routing on an authoritative gateway clear", async () => {
    const { task, home } = fixture();
    const relay = { relayFragment: '{"base_url":"https://cursor.example","default_model":"auto"}', relayAuthToken: "cursor-fixture-secret" };
    await prepareIssueSessionProviderHome(home, relay);
    const providerEnv = await loadIssueSessionProviderEnv(home, relay);
    const env = buildTaskEnv({ ...task, workspaceEnv: { CURSOR_CONFIG_DIR: "/foreign", CURSOR_DATA_DIR: "/foreign" } }, {
      daemonPort: 6200, serverUrl: "http://localhost:6120", providerHome: home, providerEnv,
    });
    expect(env).toMatchObject({
      CURSOR_CONFIG_DIR: home.home, CURSOR_DATA_DIR: home.home,
      CURSOR_API_ENDPOINT: "https://cursor.example", CURSOR_API_KEY: "cursor-fixture-secret",
      CURSOR_AUTH_TOKEN: "", AGENT_CLI_CREDENTIAL_STORE: "memory",
    });
    expect(readdirSync(home.home)).toEqual(["cli-config.json"]);
    expect(JSON.parse(readFileSync(join(home.home, "cli-config.json"), "utf8"))).toEqual({ channel: "static" });
    expect(readFileSync(join(home.root, "meta.json"), "utf8")).not.toContain("cursor-fixture-secret");
    expect(await loadIssueSessionProviderEnv(home, { relayFragment: "", relayAuthToken: "" })).toEqual({
      CURSOR_API_KEY: "", CURSOR_AUTH_TOKEN: "", CURSOR_API_ENDPOINT: "https://api2.cursor.sh",
    });
  });

  it("pins the CLI update channel while preserving native session preferences", async () => {
    const { home } = fixture();
    await prepareIssueSessionProviderHome(home);
    writeFileSync(join(home.home, "cli-config.json"), JSON.stringify({ channel: "prod", model: "auto", theme: "dark" }));
    await prepareIssueSessionProviderHome(home);
    expect(JSON.parse(readFileSync(join(home.home, "cli-config.json"), "utf8"))).toEqual({
      channel: "static", model: "auto", theme: "dark",
    });
  });

  it("gives the private launch directory project instructions, Cursor rules and Agent skills", async () => {
    const { cwd, task, home } = fixture();
    writeFileSync(join(cwd, "AGENTS.md"), "Use the project compiler.");
    mkdirSync(join(cwd, ".cursor", "rules"), { recursive: true });
    writeFileSync(join(cwd, ".cursor", "rules", "always.mdc"), "---\nalwaysApply: true\n---\nCheck project constraints.");
    writeFileSync(join(cwd, ".cursor", "rules", "ui.mdc"), "---\ndescription: UI conventions\nglobs: '*.tsx'\n---\nUI_RULE_BODY");
    const before = readdirSync(cwd);
    await prepareIssueSessionProviderHome(home);
    const context = runtimeWorkspaceContext(task, home, cwd)!;
    writeProviderInstructions(home, { remi: task.agent!.instructions, local: context.instructions });
    const skills = providerHomeSkillRoot(home.home, "cursor");
    syncAgentSkills(skills, task);
    const instructions = readFileSync(join(home.home, "AGENTS.md"), "utf8");
    expect(instructions).toContain("Use the review checklist.");
    expect(instructions).toContain("Use the project compiler.");
    expect(instructions).toContain("Check project constraints.");
    expect(instructions).toContain("UI conventions");
    expect(instructions).not.toContain("UI_RULE_BODY");
    expect(readFileSync(join(skills, "review", "SKILL.md"), "utf8")).toContain("Check correctness.");
    expect(readdirSync(cwd)).toEqual(before);
    expect(readFileSync(join(cwd, "AGENTS.md"), "utf8")).toBe("Use the project compiler.");
  });

  it("prepares native model discovery from the Cursor gateway and forwards the private home to task execution", async () => {
    const { root, cwd, task, home } = fixture();
    let received: AcpProviderOptions | undefined;
    const daemon = new MultiremiDaemon({
      sshMeshManager: disabledSshMeshRuntime(), serverUrl: "http://127.0.0.1:1", token: "fixture",
      runtimeId: "fixture", provider: "cursor", daemonId: "fixture", workspaceId: "local",
      gcEnabled: false, workspacesRoot: join(root, "state"),
      providerFactory: options => { received = options; throw new Error("provider captured"); },
    });
    const state = daemon as any;
    state.workspaceRelays.set("local", { claude: null, codex: null,
      cursor: { fragment: '{"base_url":"https://cursor.example"}', auth_token: "cursor-fixture-secret", revision: 1 } });
    const probe = await state.runtimeModelProbeProviderOptions();
    expect(probe.options.agentType).toBe("cursor");
    expect(probe.options.providerHome).toBe(probe.options.env.CURSOR_DATA_DIR);
    expect(probe.options.env).toMatchObject({ CURSOR_API_KEY: "cursor-fixture-secret", CURSOR_API_ENDPOINT: "https://cursor.example" });
    state.assertWorkspaceRootOwner = () => {};
    state.registerTaskRepos = async () => [];
    state.prepareTaskWorkspace = async () => ({ checkouts: [], repos: [], warnings: [] });
    state.enqueueTaskReport = () => {};
    await prepareIssueSessionProviderHome(home);
    await expect(state.runAgent(task, new AbortController().signal,
      { workDir: cwd, ensureDir: false, localDirectory: true }, undefined, home, probe.options.env,
    )).rejects.toThrow("provider captured");
    expect(received?.agentType).toBe("cursor");
    expect(received?.cwd).toBe(cwd);
    expect(received?.providerHome).toBe(home.home);
    expect(received?.env?.CURSOR_CONFIG_DIR).toBe(home.home);
    expect(readFileSync(join(home.home, "AGENTS.md"), "utf8")).toContain("Use the review checklist.");
    expect(readFileSync(join(home.home, ".cursor", "skills", "review", "SKILL.md"), "utf8")).toContain("Check correctness.");
  });
});
