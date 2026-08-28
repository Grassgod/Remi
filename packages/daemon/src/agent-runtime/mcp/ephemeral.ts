/**
 * Ephemeral MCP server injection for per-task (Multiremi) agent runs.
 *
 * A Multiremi agent may carry an `mcpConfig` blob (the standard `.mcp.json`
 * shape: `{ mcpServers: { <name>: { command, args?, env? } } }`). When a task
 * spawns its ACP agent, those servers must be injected into the ACP
 * `session/new` request's `mcpServers` array so the agent can reach them for
 * the lifetime of that session only — hence "ephemeral" (no on-disk config is
 * written; nothing persists past the run).
 *
 * `buildTaskMcpServers(task)` parses the (untrusted, possibly malformed) JSON
 * into the ACP stdio mcpServers shape `{ name, command, args, env }`. It is
 * intentionally defensive: any non-conforming entry is dropped, and a fully
 * malformed / null config yields `[]` (zero behavior change for tasks with no
 * mcpConfig).
 *
 * NOTE on server lifecycle / `mcp/servers/`: there is no Remi-owned MCP server
 * process registration or lifecycle code. MCP server *processes* are spawned
 * and owned by the ACP agent process itself (it reads the injected mcpServers
 * and launches them). This module only translates a task's stored config into
 * the per-session injection shape; it does not start, stop, or supervise any
 * process.
 */

import type { AgentTask } from "@daemon/contracts/types.js";

/** ACP `EnvVariable` — sdk/schema/schema.json `$defs.EnvVariable` (required: name, value). */
export interface AcpMcpEnvVariable {
  name: string;
  value: string;
}

/**
 * ACP `session/new` mcpServers entry (stdio transport).
 *
 * Mirrors `McpServerStdio` exactly: `args` AND `env` are both REQUIRED, and
 * `env` is an `EnvVariable[]`, never a Record (sdk/schema/schema.json
 * `$defs.McpServerStdio.required = [name, command, args, env]`; zod form at
 * sdk/dist/schema/zod.gen.js:2412-2418). `NewSessionRequest.mcpServers` is
 * parsed with `vecSkipError`, which drops non-conforming entries SILENTLY —
 * an entry missing `args`/`env`, or carrying a Record `env`, never reaches the
 * agent and nothing is reported back. Both pinned bridges rebuild a Record
 * from the array (claude-agent-acp dist/acp-agent.js:4346-4353, codex-acp
 * dist/index.js:26749-26752), confirming the array is the wire form.
 */
export interface AcpMcpServer {
  name: string;
  command: string;
  args: string[];
  env: AcpMcpEnvVariable[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Coerce an unknown value to a string[], dropping non-string members. */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/** Coerce an unknown `.mcp.json` env Record to the ACP `EnvVariable[]` wire form. */
function toEnvVariables(value: unknown): AcpMcpEnvVariable[] {
  if (!isRecord(value)) return [];
  const out: AcpMcpEnvVariable[] = [];
  for (const [name, v] of Object.entries(value)) {
    if (typeof v === "string") out.push({ name, value: v });
  }
  return out;
}

/**
 * Build the ACP mcpServers array for a task from its agent's `mcpConfig`.
 *
 * Returns `[]` when the agent has no mcpConfig, the config is malformed, or no
 * entry yields a usable stdio server (i.e. has a string `command`). Only stdio
 * (command-based) servers are injected — http/sse/url-only entries are skipped
 * because ACP `session/new` here takes command-launched servers.
 */
export function buildTaskMcpServers(
  task: AgentTask,
): AcpMcpServer[] {
  return buildAgentMcpServers(task.agent?.mcpConfig);
}

/** Build ACP stdio MCP entries directly from one Multiremi agent row. */
export function buildAgentMcpServers(raw: unknown): AcpMcpServer[] {
  if (raw == null) return [];

  // Tolerate a JSON string as well as an already-parsed object.
  let config: unknown = raw;
  if (typeof raw === "string") {
    try {
      config = JSON.parse(raw);
    } catch {
      return [];
    }
  }

  if (!isRecord(config)) return [];
  const servers = config.mcpServers;
  if (!isRecord(servers)) return [];

  const out: AcpMcpServer[] = [];
  for (const [name, entry] of Object.entries(servers)) {
    if (!name || !isRecord(entry)) continue;
    const command = entry.command;
    if (typeof command !== "string" || command.length === 0) continue;
    out.push({
      name,
      command,
      args: toStringArray(entry.args),
      env: toEnvVariables(entry.env),
    });
  }
  return out;
}
