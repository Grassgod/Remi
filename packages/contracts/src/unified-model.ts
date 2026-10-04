/** Shared storage / API vocabulary for the unified conversation model. */
import type { ConversationLogEntry, ConversationLogTypeHistogramBucket } from "./conversation-log.js";
import type { MultiremiTaskPluginSnapshotEntry, TaskUsageEntry } from "./types.js";
import type { RuntimeCodexProfile } from "./codex-profile.js";
import type { RuntimeClaudeProfile } from "./claude-profile.js";
import type { TraceRef } from "./trace-file.js";

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

export const autopilotSessionId = (autopilotId: string): string => `auto_${autopilotId}`;
