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
    { name: "local", command: "secret-command", env: { API_KEY: "secret" } },
    { name: "tooling", command: "npx", args: ["-y", "some-mcp"] },
  ]);
});

test("accepts a JSON string blob", () => {
  const json = JSON.stringify({ mcpServers: { s: { command: "run" } } });
  expect(buildTaskMcpServers(taskWithMcpConfig(json))).toEqual([{ name: "s", command: "run" }]);
});

test("skips entries without a usable command (e.g. http/url-only)", () => {
  const cfg = {
    mcpServers: {
      stdio: { command: "go" },
      remote: { type: "http", url: "https://example.com" }, // no command → skipped
      empty: { command: "" }, // empty command → skipped
    },
  };
  expect(buildTaskMcpServers(taskWithMcpConfig(cfg))).toEqual([{ name: "stdio", command: "go" }]);
});

test("drops non-string args / env members defensively", () => {
  const cfg = {
    mcpServers: {
      s: { command: "go", args: ["ok", 5, null], env: { A: "1", B: 2 } },
    },
  };
  expect(buildTaskMcpServers(taskWithMcpConfig(cfg))).toEqual([
    { name: "s", command: "go", args: ["ok"], env: { A: "1" } },
  ]);
});
