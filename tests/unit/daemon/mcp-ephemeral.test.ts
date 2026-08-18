/**
 * Unit tests for ephemeral per-task MCP server injection (D6).
 *
 * buildTaskMcpServers() parses an agent's untrusted `mcpConfig` blob into the
 * ACP session/new mcpServers shape. Critically, tasks without mcpConfig (the
 * common case, incl. the daemon-smoke agent) must yield [] so existing runs see
 * zero behavior change.
 */

import { test, expect } from "bun:test";
import { buildTaskMcpServers } from "@daemon/agent-runtime/mcp/ephemeral.js";
import type { AgentTask } from "@daemon/contracts/types.js";

function taskWithMcpConfig(mcpConfig: unknown): AgentTask {
  return {
    agent: {
      id: "a1",
      name: "Agent",
      provider: "claude",
      model: null,
      instructions: "",
      skills: [],
      cwd: null,
      executable: null,
      allowedTools: [],
      customEnv: {},
      mcpConfig,
    },
  } as unknown as AgentTask;
}

test("no agent → []", () => {
  expect(buildTaskMcpServers({ agent: null } as unknown as AgentTask)).toEqual([]);
});

test("null mcpConfig → []", () => {
  expect(buildTaskMcpServers(taskWithMcpConfig(null))).toEqual([]);
});

test("empty mcpConfig object → []", () => {
  expect(buildTaskMcpServers(taskWithMcpConfig({}))).toEqual([]);
  expect(buildTaskMcpServers(taskWithMcpConfig({ mcpServers: {} }))).toEqual([]);
});

test("malformed (non-object / array / bad JSON string) → []", () => {
  expect(buildTaskMcpServers(taskWithMcpConfig(42))).toEqual([]);
  expect(buildTaskMcpServers(taskWithMcpConfig([1, 2, 3]))).toEqual([]);
  expect(buildTaskMcpServers(taskWithMcpConfig("{not json"))).toEqual([]);
  expect(buildTaskMcpServers(taskWithMcpConfig({ mcpServers: [1, 2] }))).toEqual([]);
});

test("valid mcpConfig → ACP mcpServers shape", () => {
  const cfg = {
    mcpServers: {
      local: { command: "secret-command", env: { API_KEY: "secret" } },
      tooling: { command: "npx", args: ["-y", "some-mcp"] },
    },
  };
  expect(buildTaskMcpServers(taskWithMcpConfig(cfg))).toEqual([
    { name: "local", command: "secret-command", args: [], env: [{ name: "API_KEY", value: "secret" }] },
    { name: "tooling", command: "npx", args: ["-y", "some-mcp"], env: [] },
  ]);
});

test("accepts a JSON string blob", () => {
  const json = JSON.stringify({ mcpServers: { s: { command: "run" } } });
  expect(buildTaskMcpServers(taskWithMcpConfig(json))).toEqual([{ name: "s", command: "run", args: [], env: [] }]);
});

test("skips entries without a usable command (e.g. http/url-only)", () => {
  const cfg = {
    mcpServers: {
      stdio: { command: "go" },
      remote: { type: "http", url: "https://example.com" }, // no command → skipped
      empty: { command: "" }, // empty command → skipped
    },
  };
  expect(buildTaskMcpServers(taskWithMcpConfig(cfg))).toEqual([{ name: "stdio", command: "go", args: [], env: [] }]);
});

test("drops non-string args / env members defensively", () => {
  const cfg = {
    mcpServers: {
      s: { command: "go", args: ["ok", 5, null], env: { A: "1", B: 2 } },
    },
  };
  expect(buildTaskMcpServers(taskWithMcpConfig(cfg))).toEqual([
    { name: "s", command: "go", args: ["ok"], env: [{ name: "A", value: "1" }] },
  ]);
});

test("emits the exact ACP McpServerStdio wire JSON (args + env required, env is EnvVariable[])", () => {
  // These are the literal bytes that land in `session/new.mcpServers`. The
  // schema requires all four keys and `env: EnvVariable[]`
  // (sdk/schema/schema.json $defs.McpServerStdio.required, $defs.EnvVariable),
  // and `mcpServers` is parsed with vecSkipError — a Record env or a missing
  // `args` makes BOTH bridges drop the server silently, with no error back.
  const cfg = { mcpServers: { gc: { command: "node", args: ["a.js"], env: { TOKEN: "x" } } } };
  expect(JSON.stringify(buildTaskMcpServers(taskWithMcpConfig(cfg)))).toBe(
    '[{"name":"gc","command":"node","args":["a.js"],"env":[{"name":"TOKEN","value":"x"}]}]',
  );

  // …and a bare command still ships both required keys as empty arrays.
  expect(JSON.stringify(buildTaskMcpServers(taskWithMcpConfig({ mcpServers: { bare: { command: "run" } } })))).toBe(
    '[{"name":"bare","command":"run","args":[],"env":[]}]',
  );
});

test("injects a task-scoped project knowledge MCP and reserves its name", () => {
  const task = taskWithMcpConfig({
    mcpServers: {
      "multiremi-project-knowledge": { command: "attacker" },
      other: { command: "other-mcp" },
    },
  });
  task.id = "tsk_1";
  task.workspaceId = "ws_1";
  task.project = { id: "prj_1", title: "Project", description: null };
  task.authToken = "task-token";

  expect(buildTaskMcpServers(task, { serverUrl: "https://remi.test", fallbackToken: "fallback" })).toEqual([
    { name: "other", command: "other-mcp", args: [], env: [] },
    {
      name: "multiremi-project-knowledge",
      command: "remi",
      args: ["multiremi", "project-knowledge-mcp", "prj_1"],
      env: [
        { name: "MULTIREMI_SERVER_URL", value: "https://remi.test" },
        { name: "MULTIREMI_TOKEN", value: "task-token" },
        { name: "MULTIREMI_TASK_ID", value: "tsk_1" },
        { name: "MULTIREMI_WORKSPACE_ID", value: "ws_1" },
      ],
    },
  ]);
});
