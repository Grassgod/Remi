/**
 * Provider protocol and shared types.
 */

/** Callback for streaming text chunks. */
export type StreamCallback = (chunk: string) => void;

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
    },
  ): Promise<AgentResponse>;

  healthCheck(): Promise<boolean>;
}

/** Create a default AgentResponse with sensible defaults. */
export function createAgentResponse(partial: Partial<AgentResponse> & { text: string }): AgentResponse {
  return {
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
