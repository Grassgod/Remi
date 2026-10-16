/** Shared storage / API vocabulary for the unified conversation model. */
import type { ConversationLogEntry, ConversationLogTypeHistogramBucket } from "./conversation-log.js";
import type { MultiremiTaskPluginSnapshotEntry, TaskUsageEntry } from "./types.js";
import type { RuntimeCodexProfile } from "./codex-profile.js";
import type { RuntimeClaudeProfile } from "./claude-profile.js";
import type { TraceRef } from "./trace-file.js";
import {
  TRACE_BACKGROUND_TASK_STOP_REASONS,
  type TraceBackgroundTaskStopRequest,
  type TraceBackgroundTaskUsage,
  type TraceContextUsage,
  type TraceLateSubagent,
} from "./trace.js";

export const MESSAGE_KINDS = ["request", "reply", "report", "decision", "status", "final"] as const;
export type MessageKind = typeof MESSAGE_KINDS[number];
export type MessageSenderType = "member" | "agent" | "platform" | "timer";
export type MessageWake = "now" | "next_turn" | "inbox_only";
export type MessageRole = "leader" | "parent_owner" | "delegator" | "issue_owner" | "relay";
export type MessageRecipient =
  | { type: "none" }
  | { type: "agent" | "member"; ref: string }
  | { type: "role"; ref: MessageRole };
export type WakeReason =
  | "human_sender" | "platform_to_owner" | "agent_dispatch" | "member_to_delegator"
  | "to_leader" | "to_parent_owner" | "agent_pair_not_privileged" | "pair_round_trip_limit"
  | "self" | "recipient_unavailable" | "no_recipient" | "requested_next_turn"
  | "requested_inbox_only" | "migration" | "dependencies_unmet" | "source_side_session" | "no_issue_target";
export interface DecisionOption { label: string; value: string; description?: string }

export interface MessageHeader {
  sender_type: MessageSenderType;
  sender_id: string | null;
  to_type: MessageRecipient["type"];
  to_ref: string | null;
  /** Recipient resolved at write time; ownership changes never retarget a message. */
  to_agent_id: string | null;
  to_member_id: string | null;
  message_kind: MessageKind;
  wake_requested: MessageWake;
  wake_applied: MessageWake;
  wake_reason: WakeReason;
  reply_to_id: string | null;
  dedupe_key: string | null;
  options: DecisionOption[] | null;
  card_token_hash: string | null;
  card_token_recipient: string | null;
  card_token_consumed_at: string | null;
}
export type UnifiedMessage = Omit<ConversationLogEntry, "author_type" | "author_id" | "parent_id" | "kind"> & MessageHeader & { kind: "message" };

/** Caller owns the transaction and its deferred event queue. */
export interface SendMessageInput {
  /** Internal id used by atomic lifecycle producers. */
  id?: string;
  /** Internal staging of an atomic terminal reply. */
  visibility?: 'shown' | 'hidden';
  session_id: string;
  sender: { type: MessageSenderType; id: string | null };
  to: MessageRecipient;
  body_md: string;
  message_kind: MessageKind;
  wake_requested: MessageWake;
  reply_to_id?: string | null;
  dedupe_key?: string | null;
  options?: DecisionOption[] | null;
  attachment_ids?: string[];
  metadata?: Record<string, unknown>;
  source_turn_id?: string | null;
  execution_scope?: string;
}
export interface SendMessageResult {
  message: UnifiedMessage;
  wake_applied: MessageWake;
  wake_reason: WakeReason;
  /** Existing or newly created turn; absent when only recording a message. */
  turn_id?: string;
}

export const TURN_STATUSES = ["pending", "running", "awaiting_human", "completed", "failed", "cancelled"] as const;
export type TurnStatus = typeof TURN_STATUSES[number];
export const ATTEMPT_STATUSES = ["offered", "accepted", "running", "waiting_local_directory", "completed", "failed", "cancelled", "lost"] as const;
export type TurnAttemptStatus = typeof ATTEMPT_STATUSES[number];

export interface MultiremiTurn {
  /** Migrated turns use the retry-chain root's tsk_ id. Attempts keep their own tsk_ ids. */
  id: string;
  session_id: string;
  seq: number;
  agent_id: string;
  execution_scope: string;
  status: TurnStatus;
  wake_source: string | null;
  wake_seq: number;
  trigger_message_id: string | null;
  input_from_seq: number | null;
  input_to_seq: number | null;
  waiting_on_message_id: string | null;
  reply_message_id: string | null;
  wrap_up_requested_at: string | null;
  current_attempt_id: string | null;
  delegation_id: string | null;
  delegated_by_agent_id: string | null;
  delegation_return_turn_id: string | null;
  delegated_from_issue_session_id: string | null;
  delegation_skip_reason: string | null;
  continued_from_turn_id: string | null;
  holds_workspace: boolean;
  priority: number;
  requesting_user_name: string | null;
  requesting_user_profile_description: string | null;
  issue_id: string | null;
  workspace_id: string;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  ended_reason: string | null;
  /** Historical input only; live input is the message seq range. */
  legacy_prompt: string | null;
  /**
   * Subagents the current attempt has running, from the daemon's best-effort
   * `task.activity` report (PR 5). Absent or null when never reported.
   */
  running_subagents?: number | null;
  /**
   * Background tasks the current attempt has running, from the same report
   * (PR 6, `running_background_tasks`). Absent or null when never reported.
   * Tasks parked after the attempt are the session registry's, not this.
   */
  running_background_tasks?: number | null;
}

export interface MultiremiTurnAttempt {
  id: string;
  turn_id: string;
  attempt_no: number;
  status: TurnAttemptStatus;
  runtime_id: string | null;
  provider: string | null;
  /** Provider-native session, distinct from the turn's conversation. */
  session_id: string | null;
  work_dir: string | null;
  plugin_snapshot: MultiremiTaskPluginSnapshotEntry[];
  codex_profile: RuntimeCodexProfile | null;
  claude_profile: RuntimeClaudeProfile | null;
  execution_fingerprint: string | null;
  execution_model: string | null;
  execution_thinking_level: string | null;
  fallback_switched: boolean;
  switch_reason: string | null;
  projection_from_seq: number | null;
  projection_to_seq: number | null;
  projection_mode: string | null;
  projection_degrade_level: number;
  projection_truncated: boolean;
  projection_omitted_events: number;
  projection_estimated_tokens: number;
  usage: TaskUsageEntry[];
  progress_summary: string | null;
  progress_step: number | null;
  progress_total: number | null;
  wait_reason: string | null;
  failure_reason: string | null;
  error: string | null;
  next_retry_at: string | null;
  branch_name: string | null;
  event_count: number | null;
  tool_call_count: number | null;
  type_histogram: ConversationLogTypeHistogramBucket[] | null;
  model: { provider: string; model: string } | null;
  trace_ref: TraceRef | null;
  /** PR 2 trace summary from the completion report; null before it, or when the daemon sent none. */
  context_usage: TraceContextUsage | null;
  worked_ms: number | null;
  process_item_count: number | null;
  /**
   * PR 5: the attempt's running subagents from `task.activity` while it is
   * active (accepted or running); null once it ended or when never reported.
   */
  running_subagents?: number | null;
  /** PR 6: the attempt's running background tasks from `task.activity`, under the same rule as `running_subagents`. */
  running_background_tasks?: number | null;
  /** PR 5 completion fact: top-level subagents that ended after the final reply started, at most 5; null when none did. */
  late_subagents?: TraceLateSubagent[] | null;
  offered_at: string | null;
  accepted_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MultiremiSessionLane {
  session_id: string;
  reader_type: "agent" | "member";
  reader_id: string;
  execution_scope: string;
  cursor_seq: number;
  cursor_offset: number;
  wake_hint_seq: number;
  swept_to_seq: number;
  swept_at: string | null;
  parent_cursor_seq: number;
  provider_session_id: string | null;
  runtime_id: string | null;
  provider: string | null;
  execution_fingerprint: string | null;
  work_dir: string | null;
  generation: number;
  status: string;
  last_attempt_id: string | null;
  created_at: string;
  updated_at: string;
}

// ── Background tasks (PR 6) ─────────────────────────────────────────────────
//
// A Chat lane's bridge process may outlive its attempt while background tasks
// run (keep-alive on demand). The session's live view is the registry
// (`multiremi_background_tasks`), fed by the daemon's best-effort
// `lane.background_tasks` snapshots; a trace keeps only its own attempt's part
// (`TraceBackgroundTaskItem`).

/**
 * A registry row's status. `paused` is a status here (the trace item flags it,
 * because trace statuses are frozen by ADR 0019); `unknown` is the server's
 * own, for a runtime that has been offline too long to know.
 */
export const BACKGROUND_TASK_STATUSES = ["running", "paused", "completed", "failed", "stopped", "unknown"] as const;
export type BackgroundTaskStatus = (typeof BACKGROUND_TASK_STATUSES)[number];
/** What a daemon may report; `unknown` is never reported. */
export type BackgroundTaskReportedStatus = Exclude<BackgroundTaskStatus, "unknown">;
/** Statuses with a process still behind them. */
export const BACKGROUND_TASK_LIVE_STATUSES = ["running", "paused"] as const satisfies readonly BackgroundTaskStatus[];

/**
 * Why a task stopped: the trace's reasons (`user`, `turn_end`, `cancelled`,
 * `lost`) plus the lane's own (PR 6 §2.7): the keep-alive cap, eviction or no
 * room to park (`evicted`, `no_capacity`), a daemon restart, stop or drain,
 * a reset or closed session, and a changed agent or runtime config.
 */
export const BACKGROUND_TASK_STOP_REASONS = [
  ...TRACE_BACKGROUND_TASK_STOP_REASONS,
  "keepalive_cap",
  "evicted",
  "no_capacity",
  "daemon_restart",
  "lane_reset",
  "session_closed",
  "config_changed",
] as const;
export type BackgroundTaskStopReason = (typeof BACKGROUND_TASK_STOP_REASONS)[number];

/** Why the server tells a daemon to release a parked lane (`lane.background_release`). */
export const BACKGROUND_LANE_RELEASE_REASONS = ["lane_reset", "session_closed"] as const satisfies readonly BackgroundTaskStopReason[];
export type BackgroundLaneReleaseReason = (typeof BACKGROUND_LANE_RELEASE_REASONS)[number];

/** Where a lane's process is: serving an attempt, parked between attempts, or gone. */
export const BACKGROUND_LANE_STATES = ["in_attempt", "parked", "closed"] as const;
export type BackgroundLaneState = (typeof BACKGROUND_LANE_STATES)[number];

export type BackgroundTaskStopOutcome = TraceBackgroundTaskStopRequest["outcome"];

/** One row of a session's background tasks (`GET /api/chat/sessions/:id/background-tasks`). */
export interface MultiremiBackgroundTask {
  id: string;
  workspace_id: string;
  session_id: string;
  agent_id: string;
  execution_scope: string;
  runtime_id: string;
  provider_session_id: string;
  /** The bridge's `asyncTaskId`, unique within the lane's provider session. */
  task_id: string;
  task_type: string;
  name: string;
  command: string | null;
  origin_attempt_id: string;
  origin_turn_id: string | null;
  /** The task's trace item in the origin attempt (`bg:<task_id>`). */
  origin_item_id: string | null;
  status: BackgroundTaskStatus;
  stop_reason: BackgroundTaskStopReason | null;
  can_stop: boolean;
  stop_requested_at: string | null;
  /** Member id of whoever asked; null when Remi itself stopped it. */
  stop_requested_by: string | null;
  /** The daemon's answer to the latest stop request; null before one is reported. */
  stop_outcome: BackgroundTaskStopOutcome | null;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  summary: string | null;
  output_tail: string | null;
  /** The daemon could not read the task's output (「无法读取输出」); this server always sends it. */
  output_unreadable?: boolean;
  usage: TraceBackgroundTaskUsage | null;
  lane_state: BackgroundLaneState;
  /** When the parked process stops at the latest (the keep-alive cap); null unless parked. */
  parked_until: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * `metadata.background_task` of the doorbell: the platform `status` message a
 * parked Claude task's end writes to its agent, waking it (PR 6 §2.5). The
 * attempt that attaches acknowledges it without prompting it; the web renders
 * it as a compact line, not a bubble.
 */
export interface BackgroundTaskDoorbellMetadata {
  task_id: string;
  name: string;
  task_type: string;
  /** Only an end that wakes the model rings: a stop never does. */
  status: Extract<BackgroundTaskStatus, "completed" | "failed">;
  origin_attempt_id: string;
  origin_turn_id: string | null;
  provider_session_id: string;
}

export const autopilotSessionId = (autopilotId: string): string => `auto_${autopilotId}`;
