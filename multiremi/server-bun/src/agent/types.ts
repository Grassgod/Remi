/**
 * The Multiremi-Bun agent contract. ONE interface for all agents — the Go
 * backend's 12 per-agent implementations collapse into a single ACP-driven
 * provider (see ./acp/provider.ts).
 */

import type {
  SessionUpdate,
  StopReason,
  RequestPermissionParams,
  PermissionOutcome,
  McpServerConfig,
} from "./acp/protocol.js";

export interface AgentExecuteOptions {
  /** "codex" | "claude" | "gemini" | "hermes" | "kimi" | "kiro" | … */
  agentType: string;
  /** The user/task prompt for this turn. */
  prompt: string;
  /** Working directory (repo worktree or local_directory). */
  cwd?: string;
  /** Model override. */
  model?: string | null;
  /** Override the ACP agent executable (else the adapter's default). */
  executable?: string;
  /** Override the ACP agent launch args (else the adapter's defaultArgs). */
  args?: string[];
  /** Extra env for the agent process (e.g. OPENAI_API_KEY, gateway base url). */
  env?: Record<string, string>;
  /** MCP servers to expose to the agent. */
  mcpServers?: McpServerConfig[];
  /** Permission mode (e.g. "bypassPermissions" for autonomous runs). */
  permissionMode?: string | null;
  /** Tool allowlist. */
  allowedTools?: string[];
  /** Permission handler. Defaults to auto-approve (bypass) when omitted. */
  onPermissionRequest?: (p: RequestPermissionParams) => Promise<PermissionOutcome>;
}

export type AgentEvent =
  | { kind: "text"; text: string; raw: SessionUpdate }
  | { kind: "thought"; text: string; raw: SessionUpdate }
  | { kind: "tool_call"; raw: SessionUpdate }
  | { kind: "tool_update"; raw: SessionUpdate }
  | { kind: "plan"; raw: SessionUpdate }
  | { kind: "other"; raw: SessionUpdate };

export interface AgentResult {
  stopReason: StopReason;
  /** Accumulated assistant text across the turn. */
  text: string;
  sessionId: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface AgentBackend {
  execute(opts: AgentExecuteOptions): AsyncGenerator<AgentEvent, AgentResult, void>;
}
