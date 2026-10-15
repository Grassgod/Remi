/**
 * Core Provider interface and shared types for Remi's provider system.
 * Moved here so remi's src/providers/base.ts can re-export without circular deps.
 */

import type { SessionUpdate, MediaAttachment } from "./acp-protocol.js";
import type { TraceSteerOutcome } from "./trace.js";

export type ProviderEvent = SessionUpdate;

/**
 * What a native steer call answered (ACP `_session/steering`, ADR 0020):
 * - `injected`: the text joined the running prompt, which keeps running;
 * - `promptRequired`: no prompt is running; nothing was sent, re-prompt instead;
 * - `startedNewTurn`: the bridge started a turn of its own (Codex, idle race);
 *   the provider has already cancelled it and waited for it to go quiet;
 * - `failed`: the call threw, timed out or the bridge could not apply it;
 * - `unsupported`: the agent does not advertise native steering.
 * Defined with the trace (a runtime leaf) because the trace records it verbatim.
 */
export type SteerOutcome = TraceSteerOutcome;

/**
 * Why a steer came back `promptRequired`. Only `noActivePrompt` means the
 * prompt has ended (the round finishes by itself); every other reason means
 * the prompt is still running but cannot take the steer now, so the caller
 * interrupts it and re-prompts (ADR 0020).
 */
export const STEER_REASONS = {
  /** No prompt of ours is running; nothing was sent. */
  noActivePrompt: "noActivePrompt",
  /** The bridge answered it has no running turn while our prompt still ran (claude-agent-acp opt-in). */
  noRunningTurn: "noRunningTurn",
  /** A top-level tool call kept running past the wait cap (`AgentSteering.waitForToolCalls`). */
  toolCallRunning: "toolCallRunning",
  /** A permission or question is waiting for a person; nothing was sent. */
  userInputPending: "userInputPending",
} as const;

export interface SteerResult {
  outcome: SteerOutcome;
  /** For `promptRequired`, one of {@link STEER_REASONS}; otherwise bridge detail. */
  reason?: string;
  /** Redacted error text for `failed`. */
  error?: string;
}

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
  /** Total context tokens consumed, for providers that report no input/output split (ACP `used`). */
  totalTokens?: number | null;
  contextWindow?: number | null;
  durationMs?: number | null;
  model?: string | null;
  metadata?: Record<string, unknown>;
  toolCalls?: Array<Record<string, unknown>>;
}

export interface SendOptions {
  systemPrompt?: string | null;
  /** Assembled memory/context block (passed alongside the system prompt). */
  context?: string | null;
  cwd?: string | null;
  sessionId?: string | null;
  chatId?: string | null;
  /** Overrides the provider's construction-time model for this turn. */
  model?: string | null;
  /** Reasoning/effort level, applied through the agent's `thought_level` config option. */
  effort?: string | null;
  media?: MediaAttachment[];
  allowedTools?: string[];
  addDirs?: string[];
  permissionMode?: string | null;
  deadlineMs?: number;
  traceId?: string;
  signal?: AbortSignal;
  /**
   * Fires once the agent has started this stream's prompt: its first
   * turn-level update (message or thought text, a tool call, usage) arrived.
   * A bridge registers the turn asynchronously, so only then does a native
   * steer have a running turn to join (ADR 0020).
   */
  onPromptStarted?: () => void;
}

export interface Provider {
  readonly name: string;
  send(message: string, options?: SendOptions): Promise<AgentResponse>;
  sendStream?(message: string, options?: SendOptions): AsyncGenerator<ProviderEvent>;
  /**
   * Inject `text` into the prompt currently streaming for `chatId` (native
   * steering). Never throws: every failure is an outcome. Absent when the
   * provider cannot steer; callers then interrupt and re-prompt.
   */
  steer?(text: string, options: { chatId?: string | null }): Promise<SteerResult>;
  getLastResponse?(): AgentResponse | null;
  healthCheck(): Promise<boolean>;
}

/** Custom tool that the agent can call, handled within Remi. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (...args: unknown[]) => string | Promise<string>;
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
