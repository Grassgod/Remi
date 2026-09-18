// Merge precedence for the task spawn env (MUL-49):
// MULTIREMI coordinates > agent customEnv > workspace env (> machine env,
// applied at spawn where this overlay is merged over process.env).
import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { buildTaskEnv } from "@daemon/agent-runtime/env/injector.js";
import { SIDE_CONVERSATION_INSTRUCTIONS } from "@daemon/agent-runtime/prompts/side-conversation.js";
import type { AgentTask } from "@daemon/contracts/types.js";

const OPTS = { daemonPort: 6200, serverUrl: "http://server:6120" };

function taskWith(overrides: Partial<AgentTask>): AgentTask {
  return {
    id: "tsk_env",
    workspaceId: "local",
    prompt: "env",
    issueId: null,
    chatSessionId: null,
    autopilotRunId: null,
    completedAt: null,
    createdAt: "2026-08-16T00:00:00.000Z",
    agent: null,
    issue: null,
    project: null,
    projectResources: [],
    repos: [],
    workDir: null,
    runtimeId: null,
    triggerCommentId: null,
    triggerSummary: null,
    sessionId: null,
    ...overrides,
  } as AgentTask;
}

describe("buildTaskEnv", () => {
  it("injects workspace env below agent customEnv", () => {
    const env = buildTaskEnv(taskWith({
      workspaceEnv: { GH_TOKEN: "ghp_ws", SHARED: "from-workspace" },
      agent: { customEnv: { SHARED: "from-agent" } } as unknown as AgentTask["agent"],
    }), OPTS);

    expect(env.GH_TOKEN).toBe("ghp_ws");
    expect(env.SHARED).toBe("from-agent");
  });

  it("accepts the snake_case wire field", () => {
    const env = buildTaskEnv(taskWith({
      workspace_env: { GH_TOKEN: "ghp_snake" },
      scm_revision: "deadbeef",
    }), OPTS);
    expect(env.GH_TOKEN).toBe("ghp_snake");
    expect(env.MULTIREMI_SCM_REVISION).toBe("deadbeef");
  });

  it("never falls back to the daemon credential when a claim has no task token", () => {
    const env = buildTaskEnv(taskWith({
      workspaceEnv: { MULTIREMI_TOKEN: "spoofed-workspace-token" },
      agent: { customEnv: { MULTIREMI_TOKEN: "spoofed-agent-token" } } as unknown as AgentTask["agent"],
    }), OPTS);

    // Empty is intentional: the provider overlays this on process.env, where
    // the daemon credential may exist for supervisor control-plane requests.
    expect(env.MULTIREMI_TOKEN).toBe("");
  });

  it("never lets workspace or agent env override the Multiremi coordinates", () => {
    const clash = {
      MULTIREMI_DAEMON_PORT: "9999",
      MULTIREMI_WORKSPACE_ID: "spoofed",
      MULTIREMI_TASK_ID: "spoofed",
      MULTIREMI_SERVER_URL: "http://spoofed",
      MULTIREMI_TOKEN: "spoofed",
      MULTIREMI_PROJECT_ID: "spoofed",
      MULTIREMI_ISSUE_ID: "spoofed",
      MULTIREMI_ISSUE_SESSION_ID: "spoofed",
      MULTIREMI_SCM_REVISION: "spoofed",
      MULTIREMI_WORKSPACE_ROOT: "/spoofed",
      CODEX_HOME: "/spoofed/codex",
    };
    const env = buildTaskEnv(taskWith({
      workspaceEnv: { ...clash },
      agent: { customEnv: { ...clash } } as unknown as AgentTask["agent"],
      authToken: "real-token",
      project: { id: "prj_real", title: "Project", description: null },
      issueId: "iss_real",
      issueSessionId: "ises_real",
      scmRevision: "abc123",
    }), {
      ...OPTS,
      workDir: "/workspaces/MUL-1",
      providerHome: {
        storageRoot: "/workspaces/MUL-1",
        root: "/workspaces/MUL-1/.multiremi/sessions/ises_real/agt_real/1",
        home: "/workspaces/MUL-1/.multiremi/sessions/ises_real/agt_real/1/home",
        sessionId: "ises_real",
        agentId: "agt_real",
        generation: 1,
        provider: "codex",
      },
      providerEnv: { OPENAI_API_KEY: "provider-secret" },
    });

    expect(env.MULTIREMI_DAEMON_PORT).toBe("6200");
    expect(env.MULTIREMI_WORKSPACE_ID).toBe("local");
    expect(env.MULTIREMI_TASK_ID).toBe("tsk_env");
    expect(env.MULTIREMI_SERVER_URL).toBe("http://server:6120");
    expect(env.MULTIREMI_TOKEN).toBe("real-token");
    expect(env.MULTIREMI_PROJECT_ID).toBe("prj_real");
    expect(env.MULTIREMI_ISSUE_ID).toBe("iss_real");
    expect(env.MULTIREMI_ISSUE_SESSION_ID).toBe("ises_real");
    expect(env.MULTIREMI_SCM_REVISION).toBe("abc123");
    expect(env.MULTIREMI_WORKSPACE_ROOT).toBe("/workspaces/MUL-1");
    expect(env.CODEX_HOME).toBe("/workspaces/MUL-1/.multiremi/sessions/ises_real/agt_real/1/home");
    expect(env.OPENAI_API_KEY).toBe("provider-secret");
  });

  it("injects CLAUDE_CONFIG_DIR for a Claude Issue Session home", () => {
    const env = buildTaskEnv(taskWith({ issueId: "iss_1", issueSessionId: "ises_1" }), {
      ...OPTS,
      providerHome: {
        storageRoot: "/workspaces/MUL-1",
        root: "/workspaces/MUL-1/.multiremi/sessions/ises_1/agt_1/2",
        home: "/workspaces/MUL-1/.multiremi/sessions/ises_1/agt_1/2/home",
        sessionId: "ises_1",
        agentId: "agt_1",
        generation: 2,
        provider: "claude",
      },
    });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/workspaces/MUL-1/.multiremi/sessions/ises_1/agt_1/2/home");
    expect(env.CODEX_HOME).toBeUndefined();
  });

  it("keeps provider tombstones so stale workspace and agent credentials cannot reach the child", () => {
    const env = buildTaskEnv(taskWith({
      workspaceEnv: { OPENAI_API_KEY: "workspace-old" },
      agent: { customEnv: { OPENAI_API_KEY: "agent-old" } } as unknown as AgentTask["agent"],
    }), {
      ...OPTS,
      providerEnv: { OPENAI_API_KEY: "" },
    });

    // AcpClient overlays this object on top of process.env. Keeping the empty
    // entry, rather than omitting it, also clears a machine-level old key.
    expect(env).toHaveProperty("OPENAI_API_KEY", "");
  });

  it("builds the same env as before when the task has no workspace env", () => {
    const env = buildTaskEnv(taskWith({
      agent: { customEnv: { ONLY_AGENT: "1" } } as unknown as AgentTask["agent"],
    }), OPTS);
    expect(env.ONLY_AGENT).toBe("1");
    expect(Object.keys(env).sort()).toEqual([
      "GCM_INTERACTIVE",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_KEY_1",
      "GIT_CONFIG_KEY_2",
      "GIT_CONFIG_VALUE_0",
      "GIT_CONFIG_VALUE_1",
      "GIT_CONFIG_VALUE_2",
      "GIT_SSH_COMMAND",
      "GIT_TERMINAL_PROMPT",
      "MULTIREMI_AGENT_NAME",
      "MULTIREMI_DAEMON_PORT",
      "MULTIREMI_GIT_CREDENTIAL_TIMEOUT_MS",
      "MULTIREMI_SERVER_URL",
      "MULTIREMI_TASK_ID",
      "MULTIREMI_TOKEN",
      "MULTIREMI_WORKSPACE_ID",
      "ONLY_AGENT",
    ]);
  });
});

describe("read-only code snapshot environment", () => {
  it("removes injected SCM credentials and resets helpers while keeping task and provider auth", () => {
    const machine = {
      GH_TOKEN: "machine-github", GH_ENTERPRISE_TOKEN: "machine-enterprise",
      GIT_CONFIG_COUNT: "10", GIT_CONFIG_KEY_9: "credential.helper", GIT_CONFIG_VALUE_9: "machine-helper",
      GIT_CONFIG_PARAMETERS: "'http.extraHeader=Authorization: machine-secret'",
      MULTIREMI_GIT_REPOSITORIES_JSON: '["https://example.test/repo.git"]',
      SSH_AUTH_SOCK: "/machine/ssh-agent", GIT_SSH_COMMAND: "machine-ssh",
    };
    const previous = new Map(Object.keys(machine).map((key) => [key, process.env[key]]));
    Object.assign(process.env, machine);
    try {
      const task = taskWith({
        authToken: "side-task-auth", issueId: "issue", issueSessionId: "side", holdsWorkspace: false,
        issueSession: { id: "side", title: "Side", parentSessionId: "parent", inheritMode: "follow", withCode: true },
        workspaceEnv: { GITHUB_TOKEN: "workspace-github", CODEBASE_ACCESS_TOKEN: "workspace-codebase" },
        agent: {
          id: "agent", name: "Reader", provider: "codex", model: null, instructions: "",
          skills: [], executable: null, allowedTools: [],
          customEnv: { GLAB_TOKEN: "agent-gitlab", GIT_ASKPASS: "agent-askpass" },
        },
        repos: [{ url: "https://example.test/repo.git" }],
      });
      const env = buildTaskEnv(task, { ...OPTS, providerEnv: { OPENAI_API_KEY: "provider-key" } });
      for (const key of ["GH_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_TOKEN", "CODEBASE_ACCESS_TOKEN", "GLAB_TOKEN",
        "GIT_CONFIG_PARAMETERS", "MULTIREMI_GIT_REPOSITORIES_JSON", "SSH_AUTH_SOCK", "GIT_CONFIG_VALUE_9"]) {
        expect(env[key]).toBe("");
      }
      expect(env.MULTIREMI_TOKEN).toBe("side-task-auth");
      expect(env.OPENAI_API_KEY).toBe("provider-key");
      expect(env.GIT_SSH_COMMAND).toBe("/bin/false");
      expect(env.GIT_ASKPASS).toBe("/bin/false");
      expect(Object.values(env).some((value) => value.includes("git-credential"))).toBe(false);
      // Exercise Git's effective config after the same overlay used by ACP.
      const childEnv = { ...process.env, ...env };
      expect(execFileSync("git", ["config", "--get-all", "credential.helper"], {
        cwd: "/tmp", env: childEnv, encoding: "utf8",
      }).trim()).toBe("");
      expect(execFileSync("git", ["config", "--get", "credential.interactive"], {
        cwd: "/tmp", env: childEnv, encoding: "utf8",
      }).trim()).toBe("false");
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("recognizes snake-case opt-in without changing ordinary task credential injection", () => {
    const task = taskWith({
      issue_session: { id: "side", title: "Side", parent_session_id: "parent", inherit_mode: "snapshot", with_code: true },
    });
    expect(buildTaskEnv(task, OPTS).GIT_CONFIG_VALUE_1).toBe("false");
    const ordinary = buildTaskEnv(taskWith({ workspaceEnv: { GH_TOKEN: "ordinary-token" } }), OPTS);
    expect(ordinary.GH_TOKEN).toBe("ordinary-token");
    expect(Object.values(ordinary).some((value) => value.includes("git-credential"))).toBe(true);
  });
});

describe("side Codex environment instructions", () => {
  function sideTask(workspaceEnv?: Record<string, string>, customEnv?: Record<string, string>): AgentTask {
    return taskWith({
      issueId: "issue_side", issueSessionId: "session_side",
      issueSession: { id: "session_side", title: "Side", inheritMode: "snapshot" },
      workspaceEnv,
      agent: { provider: "codex", customEnv } as AgentTask["agent"],
    });
  }

  function withMachineConfig(value: string | undefined, run: () => void): void {
    const previous = process.env.CODEX_CONFIG;
    if (value === undefined) delete process.env.CODEX_CONFIG;
    else process.env.CODEX_CONFIG = value;
    try { run(); } finally {
      if (previous === undefined) delete process.env.CODEX_CONFIG;
      else process.env.CODEX_CONFIG = previous;
    }
  }

  const config = (instructions: string) => JSON.stringify({
    developer_instructions: instructions,
    model: "example-model",
    arbitrary: { keep: [1, "value", true] },
  });

  it("preserves agent > workspace > machine precedence and appends policy without losing config", () => {
    withMachineConfig(config("machine instructions"), () => {
      const cases = [
        { task: sideTask(), expected: "machine instructions" },
        { task: sideTask({ CODEX_CONFIG: config("workspace instructions") }), expected: "workspace instructions" },
        {
          task: sideTask({ CODEX_CONFIG: config("workspace instructions") }, { CODEX_CONFIG: config("agent instructions") }),
          expected: "agent instructions",
        },
      ];
      for (const { task, expected } of cases) {
        const result = JSON.parse(buildTaskEnv(task, OPTS).CODEX_CONFIG!);
        expect(result).toEqual({
          developer_instructions: `${expected}\n\n${SIDE_CONVERSATION_INSTRUCTIONS}`,
          model: "example-model", arbitrary: { keep: [1, "value", true] },
        });
      }
    });
  });

  it("keeps the authoritative provider override above lower-priority sources", () => {
    withMachineConfig(config("machine"), () => {
      const task = sideTask({ CODEX_CONFIG: config("workspace") }, { CODEX_CONFIG: config("agent") });
      const env = buildTaskEnv(task, { ...OPTS, providerEnv: { CODEX_CONFIG: config("provider") } });
      expect(JSON.parse(env.CODEX_CONFIG!).developer_instructions).toBe(`provider\n\n${SIDE_CONVERSATION_INSTRUCTIONS}`);
      expect(task.agent?.customEnv.CODEX_CONFIG).toBe(config("agent"));
    });
  });

  it("preserves empty provider, agent and workspace tombstones instead of reviving machine config", () => {
    withMachineConfig(config("machine"), () => {
      expect(buildTaskEnv(sideTask({ CODEX_CONFIG: "" }), OPTS).CODEX_CONFIG).toBe("");
      expect(buildTaskEnv(sideTask({ CODEX_CONFIG: config("workspace") }, { CODEX_CONFIG: "" }), OPTS).CODEX_CONFIG).toBe("");
      expect(buildTaskEnv(sideTask({ CODEX_CONFIG: config("workspace") }, { CODEX_CONFIG: config("agent") }), {
        ...OPTS, providerEnv: { CODEX_CONFIG: "" },
      }).CODEX_CONFIG).toBe("");
    });
  });

  it("leaves config without an instruction override unchanged and relies on the private home", () => {
    withMachineConfig(undefined, () => {
      expect(buildTaskEnv(sideTask(), OPTS).CODEX_CONFIG).toBeUndefined();
      const raw = '{ "model": "example-model", "custom": [1, 2] }';
      expect(buildTaskEnv(sideTask({ CODEX_CONFIG: raw }), OPTS).CODEX_CONFIG).toBe(raw);
      withMachineConfig(raw, () => {
        expect(buildTaskEnv(sideTask(), OPTS).CODEX_CONFIG).toBeUndefined();
      });
    });
  });

  it("handles an empty developer instruction override as a real override", () => {
    withMachineConfig(undefined, () => {
      const env = buildTaskEnv(sideTask({ CODEX_CONFIG: config("") }), OPTS);
      expect(JSON.parse(env.CODEX_CONFIG!).developer_instructions).toBe(SIDE_CONVERSATION_INSTRUCTIONS);
    });
  });

  it("rejects malformed and conflicting config without including raw configuration in errors", () => {
    withMachineConfig(undefined, () => {
      for (const raw of [
        '{"secret":"sensitive-fixture-value",',
        '["sensitive-fixture-value"]',
        '"sensitive-fixture-value"',
        "null",
        "42",
        '{"developer_instructions":{"secret":"sensitive-fixture-value"}}',
        '{"developer_instructions":null,"secret":"sensitive-fixture-value"}',
        '{"developer_instructions":false}',
      ]) {
        let error: unknown;
        try { buildTaskEnv(sideTask({ CODEX_CONFIG: raw }), OPTS); } catch (caught) { error = caught; }
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/^Side conversation CODEX_CONFIG /);
        expect((error as Error).message).not.toContain("sensitive-fixture-value");
        expect((error as Error).cause).toBeUndefined();
      }
    });
  });

  it("does not alter ordinary Sessions, private chats, or Claude task environments", () => {
    withMachineConfig(config("machine"), () => {
      const side = sideTask({ CODEX_CONFIG: config("workspace") });
      const ordinary = { ...side, issueSession: { id: "ordinary", title: "Ordinary", inheritMode: "none" as const } };
      expect(buildTaskEnv(ordinary, OPTS).CODEX_CONFIG).toBe(config("workspace"));
      expect(buildTaskEnv({ ...ordinary, workspaceEnv: undefined }, OPTS).CODEX_CONFIG).toBeUndefined();
      expect(buildTaskEnv({ ...side, chatSessionId: "private" }, OPTS).CODEX_CONFIG).toBe(config("workspace"));
      expect(buildTaskEnv({ ...side, agent: { ...side.agent!, provider: "claude" } }, OPTS).CODEX_CONFIG).toBe(config("workspace"));
      expect(buildTaskEnv({ ...ordinary, workspaceEnv: { CODEX_CONFIG: "unchanged invalid config" } }, OPTS).CODEX_CONFIG)
        .toBe("unchanged invalid config");
    });
  });
});
