/**
 * Contract for `multiremi_conversation_log`, the single per-session conversation
 * log that replaces `multiremi_session_events`, `multiremi_issue_comments` and
 * `multiremi_chat_messages` (MUL-402, message architecture v2-B; ADR 0006).
 *
 * One row is one display unit: `head` at seq 0, `message`, `system`, `turn` and
 * `result_published`. Every other lifecycle fact the agent projections and the
 * wake-up rules depend on stays on the same seq axis as a `visibility = "hidden"`
 * marker, so lane cursors, projection windows and the browser replica keep
 * reading one ordering. The kind names are the production values; `task_assigned`
 * is renamed to `turn`, which keeps the backfill a 1:1 copy instead of a lossy
 * mapping.
 *
 * Type-only module plus the kind constants. The writer and the read routes land
 * in MUL-426 (B1).
 */
import type { MultiremiTaskStatus, TaskUsageEntry } from "./types.js";
import type { TraceRef } from "./trace-file.js";

/** A row is either a display unit or a hidden lifecycle marker. */
export type ConversationLogVisibility = "shown" | "hidden";

/** Display units, in the order the seq axis allocates them. */
export const CONVERSATION_LOG_SHOWN_KINDS = [
  "head",
  "message",
  "system",
  "turn",
  "result_published",
] as const;

/**
 * Lifecycle facts the agent projections and the wake-up rules depend on. Each
 * hidden row carries `metadata.target_seq`. `head` is deliberately absent: it is
 * a row, never an event, so `cursor_seq = 0` still means "nothing read" and no
 * lane is woken by it.
 */
export const CONVERSATION_LOG_HIDDEN_KINDS = [
  "task_completed",
  "task_failed",
  "task_cancelled",
  "session_created",
  "task_steer",
  "message_edited",
  "message_deleted",
] as const;

/** Every `kind` the table stores: the production kinds plus `head`. */
export const CONVERSATION_LOG_KINDS = [
  ...CONVERSATION_LOG_SHOWN_KINDS,
  ...CONVERSATION_LOG_HIDDEN_KINDS,
] as const;

export type ConversationLogShownKind = (typeof CONVERSATION_LOG_SHOWN_KINDS)[number];
export type ConversationLogHiddenKind = (typeof CONVERSATION_LOG_HIDDEN_KINDS)[number];
export type ConversationLogKind = (typeof CONVERSATION_LOG_KINDS)[number];

/** The visibility each kind is written with. Listed explicitly so a new kind cannot skip it. */
export const CONVERSATION_LOG_KIND_VISIBILITY = {
  head: "shown",
  message: "shown",
  system: "shown",
  turn: "shown",
  result_published: "shown",
  task_completed: "hidden",
  task_failed: "hidden",
  task_cancelled: "hidden",
  session_created: "hidden",
  task_steer: "hidden",
  message_edited: "hidden",
  message_deleted: "hidden",
} as const satisfies Record<ConversationLogKind, ConversationLogVisibility>;

/** One `(type, tool)` bucket of a turn card's process-event histogram. */
export interface ConversationLogTypeHistogramBucket {
  type: string;
  /** Provider tool name; null for every type outside `tool_use` / `tool_result`. */
  tool: string | null;
  count: number;
}

/** Provider and model that executed the turn, as reported in the completion frame. */
export interface ConversationLogModel {
  provider: string;
  model: string;
}

/**
 * Metadata fields the kinds carry. The index signature keeps marker- and
 * provider-specific extras legal: the column is a JSON blob that grows with the
 * event kinds, not a closed structural contract.
 */
export interface ConversationLogEntryMetadata {
  /** Hidden rows: seq of the row this marker describes. */
  target_seq?: number;
  /** `head`: Issue or chat title. `result_published`: published result title. */
  title?: string;
  /** `message` tombstone: body as it stood when the comment was deleted. */
  deleted_body?: string;
  /** `message_edited`: the new body, verbatim. */
  body?: string;
  /** `message_edited`: the body the edit replaced. */
  previous_body?: string;
  /** `result_published`: source result row id, verbatim. */
  result_id?: string;
  /** `session_created`: the actor that opened the session. */
  created_by_type?: string;
  created_by_id?: string | null;
  /**
   * Chat `system` rows: pending agent-Issue-update delivery. The next task's
   * prompt is built from the rows where this is still true, so the wake-up port
   * must carry both fields.
   */
  pending_agent_delivery?: boolean;
  agent_delivery_task_id?: string | null;
  [key: string]: unknown;
}

/** The `turn` card: one row per agent turn, updated in place until it is terminal. */
export interface ConversationLogTurnMetadata extends ConversationLogEntryMetadata {
  /** Chat turns: the final reply folded into the card. */
  final_reply_md?: string | null;
  /** Issue turns: the reply stays a threadable `message` row, referenced by id. */
  final_entry_id?: string | null;
  summary?: string | null;
  /** `tool_use` event count for the turn. */
  tool_call_count?: number | null;
  event_count?: number | null;
  /** Process-event buckets keyed by `(type, tool)`. */
  type_histogram?: ConversationLogTypeHistogramBucket[] | null;
  usage?: TaskUsageEntry[] | null;
  model?: ConversationLogModel | null;
  /** Pointer to the trace while it is on a daemon or inside a session archive. */
  trace_ref?: TraceRef | null;
  status?: MultiremiTaskStatus | null;
  elapsed_ms?: number | null;
  failure_reason?: string | null;
}

/**
 * One row of `multiremi_conversation_log`, keyed by `(session_id, seq)`.
 *
 * `session_id` is an Issue session (`ises_*`) or a chat (`chat_*`). Issue seq is
 * `multiremi_session_events.seq` unchanged; chat seq is
 * `multiremi_chat_messages.sequence`. `id` is the source id (`cmt_*`, chat
 * message id, `sevt_*`), which keeps threads, reactions, attachments and inbox
 * deep links working.
 */
export interface ConversationLogEntry {
  session_id: string;
  seq: number;
  id: string;
  kind: ConversationLogKind;
  visibility: ConversationLogVisibility;
  /** `member`, `agent`, `system` or `external`, depending on the source row. */
  author_type: string;
  author_id: string | null;
  task_id: string | null;
  body_md: string;
  /** Pre-rendered body; null until the renderer backfills it by `render_version`. */
  body_html: string | null;
  render_version: string | null;
  parent_id: string | null;
  metadata: ConversationLogEntryMetadata;
  /** Increments on every in-place update of a shown row. */
  revision: number;
  created_at: string;
  updated_at: string;
  /** Set on a `message` tombstone; display windows filter these rows out. */
  deleted_at: string | null;
}

/** A `turn` row with its known card fields; the card is updated in place, never appended twice. */
export interface ConversationLogTurnEntry extends ConversationLogEntry {
  kind: "turn";
  metadata: ConversationLogTurnMetadata;
}
