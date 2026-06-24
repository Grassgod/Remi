/**
 * @remi/acp-provider — ACP (Agent Client Protocol) provider package.
 *
 * Public API:
 *   AcpProvider          — the provider class
 *   AcpProviderOptions   — constructor options
 *   Provider             — Remi provider interface
 *   AgentResponse        — provider response type
 *   SendOptions          — send/sendStream options
 *   MediaAttachment      — connector→provider media type
 *   SessionUpdate + all ACP protocol types
 *   ClaudeAdapter / CodexAdapter / createAdapter
 */

// ── Provider ──────────────────────────────────────────────────
export {
  AcpProvider,
  resolveAcpPermissionMode,
  resolveAvailableAcpPermissionMode,
  resolveAcpExecutableForAgent,
  resolveAcpHealthCheckCommand,
} from "./provider.js";
export type { AcpProviderOptions } from "./provider.js";

// ── Provider interface & shared types ─────────────────────────
export type { Provider, AgentResponse, SendOptions, ProviderEvent } from "./provider-types.js";
export { createAgentResponse } from "./provider-types.js";

// ── ACP Protocol types ────────────────────────────────────────
export type {
  MediaAttachment,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  JsonRpcMessage,
  NewSessionParams,
  NewSessionMeta,
  NewSessionResult,
  SessionModeState,
  SessionModelState,
  SessionConfigOption,
  McpServerConfig,
  PromptParams,
  PromptResult,
  StopReason,
  SessionNotification,
  SessionUpdate,
  ContentChunkUpdate,
  ThoughtChunkUpdate,
  ToolCallUpdate,
  ToolCallProgressUpdate,
  ToolKind,
  ToolCallStatus,
  ToolCallLocation,
  ToolCallContent,
  ToolCallMeta,
  RequestPermissionParams,
  PermissionOption,
  PermissionOptionKind,
  PermissionOutcome,
  ElicitationCreateParams,
  ElicitationSchema,
  ElicitationPropertySchema,
  ElicitationResult,
  PlanUpdate,
  PlanEntry,
  UsageUpdate,
  CurrentModeUpdate,
  ConfigOptionUpdate,
  SessionInfoUpdate,
  ContentBlock,
} from "./protocol.js";

// ── Elicitation (AskUserQuestion form conversion) ─────────────
export { elicitationToQuestions, answersToElicitationContent } from "./elicitation.js";
export type { ElicitationQuestion } from "./elicitation.js";

// ── Adapters ──────────────────────────────────────────────────
export { ClaudeAdapter, CodexAdapter, createAdapter } from "./adapters/index.js";
export type { AgentAdapter, AskUserQuestionData, AgentSessionOptions } from "./adapters/base.js";

// ── Streaming meta types (used by connector stream handlers) ──
export type { StreamMeta, StreamHandlerLog } from "./stream-types.js";

// ── ACP Client (lower-level) ──────────────────────────────────
export { AcpClient } from "./client.js";
export type { AcpClientOptions } from "./client.js";
