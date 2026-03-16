/**
 * Provider protocol and shared types.
 */

/** Callback for streaming text chunks. */
export type StreamCallback = (chunk: string) => void;

/** Question from Claude's AskUserQuestion tool. */
export interface AskUserQuestionData {
  toolUseId: string;
  questions: Array<{
    question: string;
    header?: string;
    options: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>;
  /** Resolve this promise with the user's answers to unblock the stream. */
  resolve: (answers: Record<string, string>) => void;
  /** Reject to cancel (e.g. timeout). */
  reject: (reason: string) => void;
}

/** Plan review request from Claude's ExitPlanMode tool. */
export interface PlanReviewData {
  toolUseId: string;
  /** Resolve with "approved", "rejected", or user feedback text. */
  resolve: (result: string) => void;
  reject: (reason: string) => void;
}

/** Streaming event emitted during real-time generation. */
export type StreamEvent =
  | { kind: "thinking_delta"; text: string }
  | { kind: "content_delta"; text: string }
  | { kind: "tool_use"; name: string; toolUseId: string; input?: Record<string, unknown> }
  | { kind: "tool_result"; toolUseId: string; name: string; resultPreview?: string; durationMs?: number }
  | { kind: "rate_limit"; retryAfterMs: number; rateLimitType?: string; resetsAt?: string; status?: string }
  | { kind: "error"; error: string; code?: string }
  | { kind: "result"; response: AgentResponse }
  | { kind: "ask_user"; data: AskUserQuestionData }
  | { kind: "plan_review"; data: PlanReviewData };

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
  durationMs?: number | null;
  model?: string | null;
  metadata?: Record<string, unknown>;
  toolCalls?: Array<Record<string, unknown>>;
}

/** Media attachment for multimodal messages (re-exported for convenience). */
export type { MediaAttachment } from "./claude-cli/protocol.js";

/** Common options for send/sendStream. */
export interface SendOptions {
  systemPrompt?: string | null;
  context?: string | null;
  cwd?: string | null;
  sessionId?: string | null;
  chatId?: string | null;
  media?: import("./claude-cli/protocol.js").MediaAttachment[];
  /** Override allowed tools for this session (from bot profile). */
  allowedTools?: string[];
  /** Additional directories to add via --add-dir (from bot profile). */
  addDirs?: string[];
  /** Override stream deadline in ms (default: 15 minutes). Useful for long-running skills/jobs. */
  deadlineMs?: number;
}

/** Protocol that all provider backends must implement. */
export interface Provider {
  readonly name: string;

  send(
    message: string,
    options?: SendOptions,
  ): Promise<AgentResponse>;

  /** Stream events in real-time. Optional — connectors fall back to send() if absent. */
  sendStream?(
    message: string,
    options?: SendOptions,
  ): AsyncGenerator<StreamEvent>;

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
