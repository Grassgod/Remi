/**
 * ACP (Agent Client Protocol) message type definitions.
 * Based on JSON-RPC 2.0 over stdio.
 */

// ── JSON-RPC 2.0 base ──────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// ── ACP session lifecycle ───────────────────────────────────────

export interface InitializeParams {
  clientInfo: { name: string; version: string };
  capabilities?: ClientCapabilities;
}

export interface ClientCapabilities {
  _meta?: Record<string, unknown>;
}

export interface InitializeResult {
  serverInfo: { name: string; version: string };
  capabilities?: Record<string, unknown>;
}

export interface NewSessionParams {
  cwd?: string;
  mcpServers?: McpServerConfig[];
  _meta?: NewSessionMeta;
}

export interface NewSessionMeta {
  claudeCode?: {
    options?: Record<string, unknown>;
    emitRawSDKMessages?: boolean | SdkMessageFilter[];
  };
  codex?: {
    options?: Record<string, unknown>;
  };
  additionalRoots?: string[];
}

export interface SdkMessageFilter {
  type: string;
  subtype?: string;
}

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface NewSessionResult {
  sessionId: string;
  modes?: SessionModeState;
  models?: SessionModelState;
  configOptions?: SessionConfigOption[];
}

export interface SessionModeState {
  currentModeId: string;
  availableModes: Array<{ id: string; name: string; description?: string }>;
}

export interface SessionModelState {
  currentModelId: string;
  availableModels: Array<{ id: string; name: string }>;
}

export interface SessionConfigOption {
  id: string;
  label: string;
  value: unknown;
  type: string;
}

// ── Prompt ───────────────────────────────────────────────────────

export interface PromptParams {
  sessionId: string;
  message: PromptMessage;
}

export interface PromptMessage {
  role: "user";
  content: PromptContent[];
}

export type PromptContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface PromptResult {
  stopReason: StopReason;
}

export type StopReason = "end_turn" | "tool_deferred" | "cancelled" | "interrupted" | "max_turns";

// ── Session update notifications ────────────────────────────────

export interface SessionNotification {
  sessionId: string;
  update: SessionUpdate;
  _meta?: Record<string, unknown>;
}

export type SessionUpdate =
  | ContentChunkUpdate
  | ThoughtChunkUpdate
  | ToolCallUpdate
  | ToolCallProgressUpdate
  | PlanUpdate
  | CurrentModeUpdate
  | UsageUpdate
  | ConfigOptionUpdate
  | SessionInfoUpdate
  | AvailableCommandsUpdate;

export interface ContentChunkUpdate {
  sessionUpdate: "agent_message_chunk" | "user_message_chunk";
  content: ContentBlock[];
}

export interface ThoughtChunkUpdate {
  sessionUpdate: "agent_thought_chunk";
  content: ContentBlock[];
}

export type ContentBlock =
  | { type: "text"; text: string; annotations?: unknown }
  | { type: "image"; data: string; mimeType: string };

export interface ToolCallUpdate {
  sessionUpdate: "tool_call";
  toolCallId: string;
  title: string;
  kind?: ToolKind;
  status?: ToolCallStatus;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
  _meta?: ToolCallMeta;
}

export interface ToolCallProgressUpdate {
  sessionUpdate: "tool_call_update";
  toolCallId: string;
  title?: string | null;
  kind?: ToolKind | null;
  status?: ToolCallStatus | null;
  content?: ToolCallContent[] | null;
  locations?: ToolCallLocation[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  _meta?: ToolCallMeta;
}

export type ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";
export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export interface ToolCallLocation {
  path: string;
  line?: number | null;
}

export type ToolCallContent =
  | { type: "content"; content: ContentBlock }
  | { type: "diff"; path: string; oldText?: string | null; newText: string }
  | { type: "terminal"; terminalId: string };

export interface ToolCallMeta {
  claudeCode?: {
    toolName?: string;
    toolResponse?: unknown;
    parentToolUseId?: string;
  };
  terminal_info?: { terminal_id: string };
  terminal_output?: { terminal_id: string; data: string };
  terminal_exit?: { terminal_id: string; exit_code: number; signal: string | null };
}

// ── Permission requests ─────────────────────────────────────────

export interface RequestPermissionParams {
  sessionId: string;
  toolCall: ToolCallProgressUpdate;
  options: PermissionOption[];
}

export interface PermissionOption {
  kind: PermissionOptionKind;
  name: string;
  optionId: string;
}

export type PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

export interface RequestPermissionResult {
  outcome: PermissionOutcome;
}

// Standard ACP permission responses select a client-presented option. Remi may
// attach `updatedInput` for patched Claude ACP agents that bridge
// AskUserQuestion back to the Claude SDK canUseTool `updatedInput` field.
export type PermissionOutcome =
  | { outcome: "selected"; optionId: string; updatedInput?: Record<string, unknown> }
  | { outcome: "cancelled" };

// ── Plan ────────────────────────────────────────────────────────

export interface PlanUpdate {
  sessionUpdate: "plan";
  entries: PlanEntry[];
}

export interface PlanEntry {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

// ── Usage ───────────────────────────────────────────────────────

export interface UsageUpdate {
  sessionUpdate: "usage_update";
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    costUsd?: number;
    model?: string;
    contextWindowSize?: number;
  };
}

// ── Other updates ───────────────────────────────────────────────

export interface CurrentModeUpdate {
  sessionUpdate: "current_mode_update";
  currentModeId: string;
}

export interface ConfigOptionUpdate {
  sessionUpdate: "config_option_update";
  id: string;
  value: unknown;
}

export interface SessionInfoUpdate {
  sessionUpdate: "session_info_update";
  title?: string;
}

export interface AvailableCommandsUpdate {
  sessionUpdate: "available_commands_update";
  commands: Array<{ name: string; description?: string }>;
}

// ── Session control ─────────────────────────────────────────────

export interface SetSessionModeParams {
  sessionId: string;
  modeId: string;
}

export interface CancelParams {
  sessionId: string;
}

export interface ResumeSessionParams {
  sessionId: string;
  cwd?: string;
  mcpServers?: McpServerConfig[];
}

export interface LoadSessionParams {
  sessionId: string;
  cwd?: string;
  mcpServers?: McpServerConfig[];
}

export interface CloseSessionParams {
  sessionId: string;
}

// ── Media attachment (compatible with existing MediaAttachment) ──

export interface MediaAttachment {
  type: "image" | "file";
  mimeType: string;
  data: string;
  fileName?: string;
}
