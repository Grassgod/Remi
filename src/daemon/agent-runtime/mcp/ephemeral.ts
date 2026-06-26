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
 * into the ACP stdio mcpServers shape `{ name, command, args?, env? }`. It is
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

/** ACP `session/new` mcpServers entry (stdio transport). */
export interface AcpMcpServer {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Coerce an unknown value to a string[] of non-empty strings, or undefined. */
function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string");
  return out.length > 0 ? out : undefined;
}

/** Coerce an unknown value to a Record<string,string>, or undefined. */
function toStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string") out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Build the ACP mcpServers array for a task from its agent's `mcpConfig`.
 *
 * Returns `[]` when the agent has no mcpConfig, the config is malformed, or no
 * entry yields a usable stdio server (i.e. has a string `command`). Only stdio
 * (command-based) servers are injected — http/sse/url-only entries are skipped
 * because ACP `session/new` here takes command-launched servers.
 */
export function buildTaskMcpServers(task: AgentTask): AcpMcpServer[] {
  const raw = task.agent?.mcpConfig;
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
    const server: AcpMcpServer = { name, command };
    const args = toStringArray(entry.args);
    if (args) server.args = args;
    const env = toStringRecord(entry.env);
    if (env) server.env = env;
    out.push(server);
  }
  return out;
}
