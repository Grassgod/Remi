/**
 * ACP (Agent Client Protocol) message type definitions.
 * Based on JSON-RPC 2.0 over stdio.
 *
 * Also defines MediaAttachment — the universal type for passing
 * images/files from connectors into ACP providers.
 */

// ── Media attachment ──────────────────────────────────────────

/** Image/file attachment passed from a connector into a provider. */
export interface MediaAttachment {
  buffer: Buffer;
  contentType: string;
  fileName?: string;
  mediaType: "image" | "file" | "audio" | "video" | "sticker";
}

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

// ── Elicitation (unstable ACP extension) ────────────────────────
// Agent → client request to collect structured user input. Claude ACP agents
// (>= 0.44.0) route the built-in AskUserQuestion tool through this when the
// client declares the `elicitation.form` capability.

export interface ElicitationCreateParams {
  mode: "form" | "url";
  sessionId: string;
  toolCallId?: string | null;
  /** Human-readable message describing what input is needed. */
  message: string;
  /** JSON Schema describing the form fields (form mode). */
  requestedSchema?: ElicitationSchema;
  url?: string;
  elicitationId?: string;
}

export interface ElicitationSchema {
  type: "object";
  properties: Record<string, ElicitationPropertySchema>;
  required?: string[];
}

export interface ElicitationPropertySchema {
  type?: string;
  title?: string;
  description?: string;
  oneOf?: Array<{ const: string; title?: string }>;
  enum?: string[];
  items?: { anyOf?: Array<{ const: string; title?: string }>; enum?: string[] };
}

export type ElicitationResult =
  | { action: "accept"; content?: Record<string, unknown> | null }
  | { action: "decline" }
  | { action: "cancel" };

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

// ── Agent adapter interfaces (moved from acp/adapters/base.ts in Phase 1 — L0 contract) ──

export interface AgentAdapter {
  readonly agentType: string;

  /** Resolve the canonical tool name from an ACP tool_call event. */
  resolveToolName(update: ToolCallUpdate | ToolCallProgressUpdate): string;

  /** Extract structured tool input from an ACP event for display. */
  extractToolInput(update: ToolCallUpdate | ToolCallProgressUpdate): Record<string, unknown> | undefined;

  /** Extract a preview string from a completed tool_call_update. */
  extractResultPreview(update: ToolCallProgressUpdate): string | undefined;

  /** Check if a request_permission is an AskUserQuestion. */
  extractAskUserQuestion(toolCall: ToolCallProgressUpdate): AskUserQuestionData | null;

  /** Check if a request_permission is an ExitPlanMode. */
  isExitPlanMode(toolCall: ToolCallProgressUpdate): boolean;

  /** Build agent-specific _meta for session/new. */
  buildSessionMeta(options: AgentSessionOptions): NewSessionMeta | undefined;

  /** Default executable name for this agent type. */
  defaultExecutable(): string;
}

export interface AskUserQuestionData {
  questions: Array<{
    question: string;
    header?: string;
    options: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>;
}

export interface AgentSessionOptions {
  model?: string | null;
  allowedTools?: string[];
  permissionMode?: string | null;
  additionalDirectories?: string[];
  [key: string]: unknown;
}

// ── Stream meta types (moved from acp/stream-types.ts in Phase 1 — L0 contract) ──

/** Metadata passed alongside an ACP stream to the connector's stream consumer. */
export interface StreamMeta {
  sessionId?: string | null;
  displayName?: string | null;
  providerName?: string | null;
  agentType?: string | null;
  mode?: string | null;
  setPermissionHandler?: (handler: (params: RequestPermissionParams) => Promise<PermissionOutcome>) => void;
  setElicitationHandler?: (handler: (params: ElicitationCreateParams) => Promise<ElicitationResult>) => void;
}

/** Logger interface for stream handlers (injected, no remi dep). */
export interface StreamHandlerLog {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}
