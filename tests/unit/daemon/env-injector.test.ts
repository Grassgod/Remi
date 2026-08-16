// Merge precedence for the task spawn env (MUL-49):
// MULTIREMI coordinates > agent customEnv > workspace env (> machine env,
// applied at spawn where this overlay is merged over process.env).
import { describe, expect, it } from "bun:test";
import { buildTaskEnv } from "@daemon/agent-runtime/env/injector.js";
import type { AgentTask } from "@daemon/contracts/types.js";

const OPTS = { daemonPort: 6200, serverUrl: "http://server:6120", fallbackToken: null };

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
      agent: { customEnv: { SHARED: "from-agent" } } as AgentTask["agent"],
    }), OPTS);

    expect(env.GH_TOKEN).toBe("ghp_ws");
    expect(env.SHARED).toBe("from-agent");
  });

  it("accepts the snake_case wire field", () => {
    const env = buildTaskEnv(taskWith({ workspace_env: { GH_TOKEN: "ghp_snake" } }), OPTS);
    expect(env.GH_TOKEN).toBe("ghp_snake");
  });

  it("never lets workspace or agent env override the Multiremi coordinates", () => {
    const clash = {
      MULTIREMI_DAEMON_PORT: "9999",
      MULTIREMI_WORKSPACE_ID: "spoofed",
      MULTIREMI_TASK_ID: "spoofed",
      MULTIREMI_SERVER_URL: "http://spoofed",
      MULTIREMI_TOKEN: "spoofed",
    };
    const env = buildTaskEnv(taskWith({
      workspaceEnv: { ...clash },
      agent: { customEnv: { ...clash } } as AgentTask["agent"],
      authToken: "real-token",
    }), OPTS);

    expect(env.MULTIREMI_DAEMON_PORT).toBe("6200");
    expect(env.MULTIREMI_WORKSPACE_ID).toBe("local");
    expect(env.MULTIREMI_TASK_ID).toBe("tsk_env");
    expect(env.MULTIREMI_SERVER_URL).toBe("http://server:6120");
    expect(env.MULTIREMI_TOKEN).toBe("real-token");
  });

  it("builds the same env as before when the task has no workspace env", () => {
    const env = buildTaskEnv(taskWith({
      agent: { customEnv: { ONLY_AGENT: "1" } } as AgentTask["agent"],
    }), OPTS);
    expect(env.ONLY_AGENT).toBe("1");
    expect(Object.keys(env).sort()).toEqual([
      "MULTIREMI_AGENT_NAME",
      "MULTIREMI_DAEMON_PORT",
      "MULTIREMI_SERVER_URL",
      "MULTIREMI_TASK_ID",
      "MULTIREMI_WORKSPACE_ID",
      "ONLY_AGENT",
    ]);
  });
});
