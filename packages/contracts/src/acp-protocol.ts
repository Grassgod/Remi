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
  params?: unknown;
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
  params?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

/**
 * Params of the `$/cancel_request` protocol notification: the peer abandons an
 * in-flight request it sent us (sdk/dist/jsonrpc.js:527-528, 852-863).
 */
export interface CancelRequestParams {
  requestId: number | string;
}

// ── ACP session lifecycle ───────────────────────────────────────

/** Client/agent name+version pair (`Implementation` in the ACP schema). */
export interface Implementation {
  name: string;
  title?: string;
  version: string;
}

/** `InitializeRequest` — sdk/dist/schema/zod.gen.js:2292-2305. */
export interface InitializeParams {
  protocolVersion: number;
  clientCapabilities?: ClientCapabilities;
  clientInfo?: Implementation;
  _meta?: Record<string, unknown>;
}

/** `ClientCapabilities` — sdk/dist/schema/zod.gen.js:2272-2284. */
export interface ClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  terminal?: boolean;
  elicitation?: { form?: Record<string, unknown>; url?: Record<string, unknown> };
  _meta?: Record<string, unknown>;
}

/** `InitializeResponse` — sdk/dist/schema/zod.gen.js:1186-1219. */
export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities?: AgentCapabilities;
  agentInfo?: Implementation;
  _meta?: Record<string, unknown>;
}

/** `AgentCapabilities` — sdk/dist/schema/zod.gen.js:1057-1078. */
export interface AgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
  mcpCapabilities?: { http?: boolean; sse?: boolean; acp?: boolean };
  sessionCapabilities?: SessionCapabilities;
  _meta?: Record<string, unknown>;
}

/**
 * `SessionCapabilities` — sdk/dist/schema/zod.gen.js:868-876. Each entry is a
 * presence marker: supplying `{}` means the agent supports that method.
 */
export interface SessionCapabilities {
  list?: SessionCapabilityMarker;
  delete?: SessionCapabilityMarker;
  additionalDirectories?: SessionCapabilityMarker;
  fork?: SessionCapabilityMarker;
  resume?: SessionCapabilityMarker;
  close?: SessionCapabilityMarker;
}

export interface SessionCapabilityMarker {
  _meta?: Record<string, unknown>;
}

export interface NewSessionParams {
  cwd?: string;
  mcpServers?: McpServerConfig[];
  /**
   * Official ACP extra workspace roots — `zNewSessionRequest.additionalDirectories`,
   * sdk/dist/schema/zod.gen.js:2446 (same field on load/resume at :2460/:2515).
   * Only send it when the agent advertises `sessionCapabilities.additionalDirectories`;
   * otherwise fall back to the `_meta.additionalRoots` extension, which both
   * pinned bridges still read (claude-agent-acp dist/acp-agent.js:4549,
   * codex-acp dist/index.js:27064-27070). Entries must be absolute — codex
   * rejects relative/empty paths with -32602 (dist/index.js:27078-27088).
   */
  additionalDirectories?: string[];
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
  /**
   * Claude-only system prompt override — claude-agent-acp dist/acp-agent.js:
   * 4357-4374. A string REPLACES the claude_code preset; an object is merged as
   * `{...value, type:"preset", preset:"claude_code"}`, so `{append}` keeps the
   * preset and appends to it (claude-agent-sdk sdk.d.ts:1969, 2020).
   * codex-acp has no equivalent: its only instructions channel is
   * `developer_instructions`, hardcoded to `null` (dist/index.js:26263).
   */
  systemPrompt?: string | { append?: string; [key: string]: unknown };
}

export interface SdkMessageFilter {
  type: string;
  subtype?: string;
}

/** `EnvVariable` — sdk/dist/schema/zod.gen.js:349-353 (required: name, value). */
export interface McpEnvVariable {
  name: string;
  value: string;
}

/**
 * `McpServerStdio` — sdk/dist/schema/zod.gen.js:2412-2418. `args` and `env` are
 * BOTH required and `env` is an `EnvVariable[]`, not a Record. `mcpServers` is
 * parsed with `vecSkipError` (zod.gen.js:2447), so a non-conforming entry is
 * dropped silently before the bridge handler ever sees it — no error comes back.
 */
export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env: McpEnvVariable[];
}

/** `NewSessionResponse` — sdk/dist/schema/zod.gen.js:1445-1450. */
export interface NewSessionResult {
  sessionId: string;
  modes?: SessionModeState;
  configOptions?: SessionConfigOption[];
  /**
   * codex-acp additionally returns a model catalog on session/new, load and
   * resume (`models: modelState`, dist/index.js:29131, 29144, 29806 built by
   * createModelState at :29717-29729); `modelId` is codex's `model[effort]`
   * bracket form. claude-agent-acp never sends this key — its model catalog
   * lives in {@link SessionConfigOption} instead.
   */
  models?: SessionModelState;
  _meta?: Record<string, unknown>;
}

export interface SessionModeState {
  currentModeId: string;
  availableModes: Array<{ id: string; name: string; description?: string }>;
}

export interface SessionModelState {
  currentModelId: string;
  availableModels: Array<{ modelId: string; name: string; description?: string }>;
}

/**
 * A session config selector and its current state — `SessionConfigOption`,
 * sdk/dist/schema/zod.gen.js:1384-1439. The claude bridge advertises `mode`,
 * `model`, `effort`, `fast` and `agent` here (claude-agent-acp
 * dist/acp-agent.js:5094-5175); `configOptions` is the only carrier for the
 * agent's model/effort catalogs — `session/new` has no `models` field.
 */
export type SessionConfigOption = SessionConfigOptionBase &
  (
    | { type: "select"; currentValue: string; options: SessionConfigSelectOption[] | SessionConfigSelectGroup[] }
    | { type: "boolean"; currentValue: boolean }
  );

export interface SessionConfigOptionBase {
  id: string;
  name: string;
  description?: string;
  /** Reserved values: "mode" | "model" | "model_config" | "thought_level"; agents may send others. */
  category?: string;
  _meta?: Record<string, unknown>;
}

export interface SessionConfigSelectOption {
  value: string;
  name: string;
  description?: string;
}

export interface SessionConfigSelectGroup {
  group: string;
  name: string;
  options: SessionConfigSelectOption[];
}

// ── Prompt ───────────────────────────────────────────────────────

/** `PromptRequest` — sdk schema.json requires `["sessionId", "prompt"]`. */
export interface PromptParams {
  sessionId: string;
  prompt: PromptContent[];
  _meta?: Record<string, unknown>;
}

export type PromptContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface PromptResult {
  stopReason: StopReason;
  /**
   * Accumulated token usage for the whole prompt turn. Both bridges settle
   * `session/prompt` with this shape: claude-agent-acp (dist/acp-agent.js
   * `sessionUsage()`) fills all five fields; codex-acp (dist/index.js
   * `toPromptUsage()`) has no `cachedWriteTokens` and adds `thoughtTokens`.
   * This is the only place the input/output split is available — the
   * `usage_update` notification stream only carries `{used, size, cost}`.
   */
  usage?: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    cachedReadTokens?: number | null;
    cachedWriteTokens?: number | null;
    totalTokens?: number | null;
  } | null;
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

export interface ElicitationEnumEntry {
  const: string;
  title?: string;
  /** codex-acp carries the option's help text here (dist/index.js:25133-25137). */
  description?: string;
}

export interface ElicitationPropertySchema {
  type?: string;
  title?: string;
  description?: string;
  oneOf?: ElicitationEnumEntry[];
  enum?: string[];
  items?: { anyOf?: ElicitationEnumEntry[]; enum?: string[] };
  /** codex-acp tags its `<questionId>__other` companion fields here. */
  _meta?: Record<string, unknown>;
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

/**
 * Context window + cost update — `UsageUpdate`, sdk/dist/schema/zod.gen.js:
 * 2015-2020. The wire shape is flat: both bridges emit `{used, size}` (+ an
 * optional `cost` and `_meta`) and neither ever sends a per-direction token
 * split — claude-agent-acp dist/acp-agent.js:1855-1862, 2456-2473, 2741-2750,
 * 3085-3094; codex-acp dist/index.js:24230-24242.
 */
export interface UsageUpdate {
  sessionUpdate: "usage_update";
  /** Total context tokens occupied (no input/output split). */
  used: number;
  /** Model context window size. */
  size: number;
  cost?: { amount: number; currency: string };
  _meta?: Record<string, unknown>;
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

/**
 * `SetSessionConfigOptionRequest` — sdk/dist/schema/zod.gen.js:2543-2555. The
 * only ACP lever for model and effort, and both pinned bridges implement it:
 * claude-agent-acp dist/acp-agent.js:3462-3546 (ids `model` / `effort`) and
 * codex-acp dist/index.js:29298-29329 (ids `model` / `reasoning_effort`).
 */
export interface SetSessionConfigOptionParams {
  sessionId: string;
  configId: string;
  value: string | boolean;
}

/** `SetSessionConfigOptionResponse` — sdk/dist/schema/zod.gen.js:1522-1525. */
export interface SetSessionConfigOptionResult {
  configOptions?: SessionConfigOption[];
}

export interface CancelParams {
  sessionId: string;
}

/**
 * `ResumeSessionRequest` — sdk/dist/schema/zod.gen.js:2512-2518. The claude
 * bridge routes resume through the same createSession path as session/new
 * (dist/acp-agent.js:775-781 -> 4272-4278), so `_meta` and
 * `additionalDirectories` are honored here exactly as on session/new.
 */
export interface ResumeSessionParams {
  sessionId: string;
  cwd?: string;
  mcpServers?: McpServerConfig[];
  additionalDirectories?: string[];
  _meta?: NewSessionMeta;
}

/**
 * `LoadSessionRequest` — sdk/dist/schema/zod.gen.js:2457-2463 (codex-acp
 * dist/index.js:19550-19556 is identical). `cwd` and `mcpServers` are both
 * required: `mcpServers` goes through `requiredDefaultOnError`, which raises
 * "Required value is missing" for `undefined` instead of defaulting, so an
 * omission is rejected with -32602 before the bridge handler runs.
 */
export interface LoadSessionParams {
  sessionId: string;
  cwd: string;
  mcpServers: McpServerConfig[];
  additionalDirectories?: string[];
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

  /**
   * Agent-side mode ids that stand in for one of our mode names, most preferred
   * first. Consulted only when the agent doesn't advertise the requested id
   * itself — claude advertises our ids directly and needs no mapping, so this
   * hook is optional.
   */
  mapPermissionMode?(mode: string): string[];

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

/**
 * Inputs for the agent-specific `session/new` `_meta`. Permission mode is
 * deliberately absent: the claude bridge overwrites
 * `_meta.claudeCode.options.permissionMode` with its own settings-derived value
 * (dist/acp-agent.js:4433 spread, then an explicit `permissionMode` key at
 * :4454), so `session/set_mode` is the only working lever for both agents.
 */
export interface AgentSessionOptions {
  model?: string | null;
  allowedTools?: string[];
  /** Appended to the agent's own system prompt where the agent supports it. */
  systemPrompt?: string | null;
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
