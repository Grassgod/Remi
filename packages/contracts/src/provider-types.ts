/**
 * Core Provider interface and shared types for Remi's provider system.
 * Moved here so remi's src/providers/base.ts can re-export without circular deps.
 */

import type { AsyncTaskState, SessionUpdate, MediaAttachment } from "./acp-protocol.js";
import type { TraceBackgroundTaskStopRequest, TraceSteerOutcome } from "./trace.js";

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
  /**
   * Stream the frames of a turn the bridge started on its own after the last
   * prompt resolved (an autonomous round, PR 5), replaying what arrived in
   * between first. Ends at the round's result marker, after `idleMs` without a
   * frame, on `signal` abort or when the agent process dies; afterwards
   * `getLastResponse` covers the round. Absent when the provider never captures
   * such rounds.
   */
  listenAutonomous?(options: ListenAutonomousOptions): AsyncGenerator<ProviderEvent>;
  getLastResponse?(): AgentResponse | null;
  healthCheck(): Promise<boolean>;

  // ── Background tasks (PR 6 §3.3). All absent when the provider has no
  // async-task registry; the daemon then stops nothing and parks nothing.

  /** The pooled session's background tasks, as its registry last saw them, in announcement order. */
  listAsyncTasks?(options: { chatId?: string | null }): AsyncTaskSnapshot[];
  /**
   * Stop one task: `_session/async_task/stop` on the root session, with a
   * timeout. An unknown task, or one not running, answers `{stopped: false}`
   * without a wire call. Never throws.
   */
  stopAsyncTask?(taskId: string, options: {
    chatId?: string | null;
    timeoutMs?: number;
    /** Who asked (the registry's `stop_request.by`); default `remi`. */
    by?: TraceBackgroundTaskStopRequest["by"];
  }): Promise<StopAsyncTaskResult>;
  /**
   * Replay the frames that arrived since the last prompt, wait `drainMs` for
   * late announcements (Codex), optionally stop every running task, then
   * yield frames until none runs or `timeoutMs` passes.
   */
  settleAsyncTasks?(options: SettleAsyncTasksOptions): AsyncGenerator<ProviderEvent>;
  /**
   * Whether the pooled session could serve `options` without being recreated:
   * the staleness rule of session creation, with no side effects. A model or
   * effort change alone never makes it stale.
   */
  reuseCheck?(chatId: string, options?: SendOptions): ReuseCheckResult;
  /**
   * Move the pooled session (its process, child sessions and death listener)
   * from `fromChatId` to `toChatId`, for the next attempt of a parked lane.
   * Starts a new prompt state; turn-scope cost estimates count from the parked
   * prompt's last cumulative cost. False when nothing is pooled under `fromChatId`.
   */
  adoptSession?(fromChatId: string, toChatId: string): boolean;
  /** Suspend (`on`) or resume the pool's idle cleanup for this session, and capture every frame while parked. */
  park?(chatId: string, on: boolean): void;
  /** The bridge's process group id, for the daemon's crash sweep; null when no process is pooled. */
  processGroupId?(chatId: string): number | null;
}

/** One background task as a provider's registry holds it (PR 6 §3.2). */
export interface AsyncTaskSnapshot {
  /** The bridge's `asyncTaskId`. */
  id: string;
  /** The ACP session its frames arrive on: the root, or a native child's. */
  sessionId: string;
  state: AsyncTaskState;
  canStop: boolean;
  name: string;
  taskType: string;
  description: string | null;
  toolCallId: string | null;
  /** Kept out of the trace; the daemon reads the output tail from it (Claude). */
  outputFilePath: string | null;
  summary: string | null;
  lastToolName: string | null;
  usage: { totalTokens: number; toolUses: number; durationMs: number } | null;
  /** Epoch ms when the provider saw the spawn, and when it saw a terminal state. */
  startedAt: number;
  endedAt: number | null;
  /** The latest stop Remi sent, and its answer so far. */
  stop: { requestedAt: number; by: TraceBackgroundTaskStopRequest["by"]; outcome: TraceBackgroundTaskStopRequest["outcome"] } | null;
}

/** Fires for every registry change of a pooled session's task (the parked-lane supervisor listens). */
export type AsyncTaskChangeListener = (chatId: string, task: AsyncTaskSnapshot) => void;

export interface StopAsyncTaskResult {
  stopped: boolean;
}

export interface SettleAsyncTasksOptions {
  chatId?: string | null;
  /** Stop every running task (in parallel) before waiting. */
  stopRunning: boolean;
  /** Wait this long first for announcements a bridge sends after the prompt resolved (Codex). */
  drainMs?: number;
  /** End by this long after the call, whether or not tasks still run. */
  timeoutMs: number;
  signal?: AbortSignal;
}

/**
 * Why a pooled session cannot be reused: nothing is pooled, its process died
 * or lost its gateway, or a value fixed when the session or process was created
 * changed (PR 6 §2.4; the `_ensureSession` staleness rule).
 */
export const PROVIDER_REUSE_REJECTIONS = [
  "no_session",
  "process_dead",
  "gateway_unavailable",
  "cwd",
  "mcp_servers",
  "plugins",
  "context_declaration",
  "startup_model",
  "codex_home",
] as const;
export type ProviderReuseRejection = (typeof PROVIDER_REUSE_REJECTIONS)[number];

export type ReuseCheckResult = { reuse: true } | { reuse: false; reason: ProviderReuseRejection };

export interface ListenAutonomousOptions {
  chatId?: string | null;
  signal?: AbortSignal;
  /** End the listen after this long without a frame. */
  idleMs?: number;
  /**
   * End the listen by this time (epoch ms), e.g. a wrap-up's grace deadline. A
   * permission or question still waiting for a person holds it open.
   */
  deadline?: number;
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
