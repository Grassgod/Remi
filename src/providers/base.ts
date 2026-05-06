/**
 * Provider protocol and shared types.
 */

/** Callback for streaming text chunks. */
export type StreamCallback = (chunk: string) => void;

/** Question structure from AskUserQuestion tool (extracted from permission_denials). */
export interface AskUserQuestion {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

/** @deprecated Use ProviderEvent instead. Will be removed after ACP pass-through refactor. */
export type StreamEvent =
  | { kind: "thinking_delta"; text: string }
  | { kind: "content_delta"; text: string }
  | { kind: "tool_use"; name: string; toolUseId: string; input?: Record<string, unknown> }
  | { kind: "tool_input_update"; toolUseId: string; name: string; input: Record<string, unknown> }
  | { kind: "tool_result"; toolUseId: string; name: string; resultPreview?: string; durationMs?: number; input?: Record<string, unknown> }
  | { kind: "rate_limit"; retryAfterMs: number; rateLimitType?: string; resetsAt?: string; status?: string }
  | { kind: "error"; error: string; code?: string }
  | { kind: "result"; response: AgentResponse };

/** Stream event type: pure ACP SessionUpdate. */
export type ProviderEvent = import("./acp/protocol.js").SessionUpdate;

/** Custom tool that the agent can call, handled within Remi. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (...args: unknown[]) => string | Promise<string>;
}

/** Response from an AI provider. */
export interface AgentResponse {
  text: string;
  thinking?: string | null;
  sessionId?: string | null;
  requestId?: string | null;
  costUsd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheCreateInputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  contextWindow?: number | null;
  durationMs?: number | null;
  model?: string | null;
  metadata?: Record<string, unknown>;
  toolCalls?: Array<Record<string, unknown>>;
  permissionDenials?: import("./claude-cli/protocol.js").PermissionDenial[];
}

/** Media attachment for multimodal messages (re-exported for convenience). */
export type { MediaAttachment } from "./claude-cli/protocol.js";

/** Common options for send/sendStream. */
export interface SendOptions {
  systemPrompt?: string | null;
  cwd?: string | null;
  sessionId?: string | null;
  chatId?: string | null;
  media?: import("./claude-cli/protocol.js").MediaAttachment[];
  /** Override allowed tools for this session (from bot profile). */
  allowedTools?: string[];
  /** Additional directories to add via --add-dir (from bot profile). */
  addDirs?: string[];
  /** Permission mode override (e.g. "plan", "auto", "default"). */
  permissionMode?: string | null;
  /** Override stream deadline in ms (default: 15 minutes). Useful for long-running skills/jobs. */
  deadlineMs?: number;
  /** Trace ID for request-scoped log correlation (conversations.id). */
  traceId?: string;
  /** AbortSignal for cancelling the request (e.g. /esc). */
  signal?: AbortSignal;
}

/** Protocol that all provider backends must implement. */
export interface Provider {
  readonly name: string;

  send(
    message: string,
    options?: SendOptions,
  ): Promise<AgentResponse>;

  /** Stream ACP events. Generator ends naturally when prompt completes, throws on error. */
  sendStream?(
    message: string,
    options?: SendOptions,
  ): AsyncGenerator<ProviderEvent>;

  /** Get the AgentResponse from the last completed sendStream call. */
  getLastResponse?(): AgentResponse | null;

  healthCheck(): Promise<boolean>;
}

/** Create a default AgentResponse with sensible defaults. */
export function createAgentResponse(partial: Partial<AgentResponse> & { text: string }): AgentResponse {
  return {
    thinking: null,
    sessionId: null,
    requestId: null,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    durationMs: null,
    model: null,
    metadata: {},
    toolCalls: [],
    ...partial,
  };
}
