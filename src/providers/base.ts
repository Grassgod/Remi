/**
 * Provider protocol and shared types.
 */

/** Callback for streaming text chunks. */
export type StreamCallback = (chunk: string) => void;

/** Streaming event emitted during real-time generation. */
export type StreamEvent =
  | { kind: "thinking_delta"; text: string }
  | { kind: "content_delta"; text: string }
  | { kind: "tool_use"; name: string; toolUseId: string; input?: Record<string, unknown> }
  | { kind: "tool_result"; toolUseId: string; name: string; resultPreview?: string; durationMs?: number }
  | { kind: "result"; response: AgentResponse };

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
  costUsd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  durationMs?: number | null;
  model?: string | null;
  metadata?: Record<string, unknown>;
  toolCalls?: Array<Record<string, unknown>>;
}

/** Protocol that all provider backends must implement. */
export interface Provider {
  readonly name: string;

  send(
    message: string,
    options?: {
      systemPrompt?: string | null;
      context?: string | null;
      cwd?: string | null;
      sessionId?: string | null;
      chatId?: string | null;
    },
  ): Promise<AgentResponse>;

  /** Stream events in real-time. Optional — connectors fall back to send() if absent. */
  sendStream?(
    message: string,
    options?: {
      systemPrompt?: string | null;
      context?: string | null;
      chatId?: string | null;
      sessionId?: string | null;
    },
  ): AsyncGenerator<StreamEvent>;

  healthCheck(): Promise<boolean>;
}

/** Create a default AgentResponse with sensible defaults. */
export function createAgentResponse(partial: Partial<AgentResponse> & { text: string }): AgentResponse {
  return {
    thinking: null,
    sessionId: null,
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
