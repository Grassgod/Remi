/**
 * Core Provider interface and shared types for Remi's provider system.
 * Moved here so remi's src/providers/base.ts can re-export without circular deps.
 */

import type { SessionUpdate, MediaAttachment } from "./protocol.js";

export type ProviderEvent = SessionUpdate;

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
}

export interface SendOptions {
  systemPrompt?: string | null;
  cwd?: string | null;
  sessionId?: string | null;
  chatId?: string | null;
  media?: MediaAttachment[];
  allowedTools?: string[];
  addDirs?: string[];
  permissionMode?: string | null;
  deadlineMs?: number;
  traceId?: string;
  signal?: AbortSignal;
}

export interface Provider {
  readonly name: string;
  send(message: string, options?: SendOptions): Promise<AgentResponse>;
  sendStream?(message: string, options?: SendOptions): AsyncGenerator<ProviderEvent>;
  getLastResponse?(): AgentResponse | null;
  healthCheck(): Promise<boolean>;
}

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
