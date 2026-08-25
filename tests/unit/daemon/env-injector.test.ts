// Merge precedence for the task spawn env (MUL-49):
// MULTIREMI coordinates > agent customEnv > workspace env (> machine env,
// applied at spawn where this overlay is merged over process.env).
import { describe, expect, it } from "bun:test";
import { buildTaskEnv } from "@daemon/agent-runtime/env/injector.js";
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
