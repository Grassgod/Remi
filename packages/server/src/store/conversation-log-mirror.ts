// Mapping from the legacy conversation writers to `multiremi_conversation_log`
// (MUL-402 / B1). The write paths keep their existing tables until B2 moves the
// readers; this module is what fills the new table from the same transaction, so
// the log is complete the moment the read endpoints switch over.
//
// The mapping covers every kind main has a producer for: the fifteen
// `session_events` kinds plus `head`, with `task_assigned` renamed to `turn` and
// everything else under its existing name. `delegation_report` (ADR 0005, merged
// from main) is one of the hidden kinds, so its seq is not a hole in the log.
// Issue sessions keep `session_events.seq` as their log seq, which is what lets
// lane cursors, `inherit_cutoff_seq`, `follow_frozen_seq` and stored
// `requiredEventSeq` values stay valid without remapping.
import type {
  ConversationLogEntryMetadata,
  ConversationLogKind,
} from "@multiremi/contracts/conversation-log";
import type { MultiremiChatMessage, MultiremiChatSession } from "@multiremi/contracts/types.js";

/**
 * The `multiremi_chat_messages` columns the log needs. The hydrated
 * `MultiremiChatMessage` contract drops the delivery pair and the sequence, and
 * those are exactly the fields the log must carry, so the mirror reads the row.
 */
export interface MirrorChatMessageRow {
  id: string;
  chat_session_id: string;
  task_id: string | null;
  role: string;
  body: string;
  failure_reason: string | null;
  elapsed_ms: number | null;
  pending_agent_delivery: number | boolean | null;
  agent_delivery_task_id: string | null;
  sequence: number;
  created_at: string;
  /** Set by the sender when the client optimistically rendered the message. */
  client_id?: string | null;
}
import { parseJson } from "@multiremi/store/helpers.js";

/** One row of `multiremi_session_events` as the mirror reads it. */
export interface MirrorSessionEvent {
  id: string;
  session_id: string;
  seq: number;
  author_type: string;
  author_id: string | null;
  kind: string;
  body: string;
  task_id: string | null;
  source_comment_id: string | null;
  metadata: string;
  created_at: string;
}

/**
 * Kinds the log stores, keyed by the `session_events.kind` that produces them.
 * Every kind an `appendSessionEvent` caller writes is here (ruling
 * cmt_u7m8e7yitmai for `follow_frozen` / `thread_resolved` /
 * `thread_unresolved`, ruling (ad) for `delegation_report`); the kind-coverage
 * test in `conversation-log-delegation-report.test.ts` pins that nothing is
 * left unmapped.
 */
const SESSION_EVENT_KIND_MAP: Record<string, ConversationLogKind> = {
  message: "message",
  system: "system",
  task_assigned: "turn",
  task_completed: "task_completed",
  task_failed: "task_failed",
  task_cancelled: "task_cancelled",
  result_published: "result_published",
  session_created: "session_created",
  task_steer: "task_steer",
  message_edited: "message_edited",
  message_deleted: "message_deleted",
  follow_frozen: "follow_frozen",
  thread_resolved: "thread_resolved",
  thread_unresolved: "thread_unresolved",
  delegation_report: "delegation_report",
};

/** The log kind a `session_events` row maps to, or null when it is not mirrored. */
export function conversationLogKindForSessionEvent(kind: string): ConversationLogKind | null {
  return SESSION_EVENT_KIND_MAP[kind] ?? null;
}

/**
 * Edit, delete, resolve and unresolve markers describe an earlier row, so their
 * `metadata.target_seq` points at the comment's own seq on the same axis. The
 * legacy metadata carries `comment_id`; the log row id is that same comment id.
 */
export function targetSeqForMarker(
  lookupSeqByEntryId: (id: string) => number | null,
  metadata: ConversationLogEntryMetadata,
): number | null {
  const commentId = typeof metadata.comment_id === "string" ? metadata.comment_id : null;
  if (!commentId) return null;
  const seq = lookupSeqByEntryId(commentId);
  return seq == null ? null : seq;
}

/** A `session_events` row as a log append. */
export function sessionEventToConversationLog(event: MirrorSessionEvent): {
  sessionId: string;
  seq: number;
  id: string;
  kind: ConversationLogKind;
  authorType: string;
  authorId: string | null;
  taskId: string | null;
  bodyMd: string;
  parentId: string | null;
  metadata: ConversationLogEntryMetadata;
  createdAt: string;
} | null {
  const kind = conversationLogKindForSessionEvent(event.kind);
  if (!kind) return null;
  const raw = parseJson<ConversationLogEntryMetadata & { comment_id?: string }>(event.metadata, {});
  const parentId = typeof raw.parent_comment_id === "string" ? raw.parent_comment_id : null;
  // `metadata` is the whole blob: keep the legacy keys and drop the ones the log
  // models as columns, so a reader never sees two sources for `parent_id`.
  const { parent_comment_id: _parentCommentId, ...metadata } = raw;
  if (kind === "message_edited") metadata.body = event.body;
  return {
    sessionId: event.session_id,
    seq: Number(event.seq),
    id: event.source_comment_id ?? event.id,
    kind,
    authorType: event.author_type,
    authorId: event.author_id,
    taskId: event.task_id,
    bodyMd: event.body ?? "",
    parentId,
    metadata: metadata as ConversationLogEntryMetadata,
    createdAt: event.created_at,
  };
}

/**
 * Chat messages map onto the same axis: a user message is a `message` authored
 * by the session owner, an assistant message is the task's terminal `turn` card,
 * and a system message stays a `message` of author type `system`. The
 * `pending_agent_delivery` / `agent_delivery_task_id` pair must survive, because
 * the next task's prompt is built from the rows where it is still true.
 */
export function chatMessageToConversationLog(
  message: MirrorChatMessageRow,
  session: Pick<MultiremiChatSession, "id" | "creatorId">,
): {
  sessionId: string;
  seq: number;
  id: string;
  kind: ConversationLogKind;
  authorType: string;
  authorId: string | null;
  taskId: string | null;
  bodyMd: string;
  metadata: ConversationLogEntryMetadata;
  createdAt: string;
} {
  const base = {
    sessionId: session.id,
    seq: Number(message.sequence),
    id: message.id,
    taskId: message.task_id,
    createdAt: message.created_at,
  };
  if (message.role === "user") {
    return {
      ...base,
      kind: "message",
      authorType: "member",
      // `chat_messages` has no author column: the owner is the only human writer.
      authorId: session.creatorId,
      bodyMd: message.body,
      // The optimistic-send key, kept verbatim so the client can merge in place.
      metadata: message.client_id != null ? { client_id: message.client_id } : {},
    };
  }
  if (message.role === "assistant") {
    // The terminal state of a chat task is a `turn` card, not a second `message`:
    // chat has no threads, so the reply folds into the card.
    return {
      ...base,
      kind: "turn",
      authorType: "agent",
      authorId: null,
      bodyMd: "",
      metadata: {
        final_reply_md: message.body,
        failure_reason: message.failure_reason ?? null,
        elapsed_ms: message.elapsed_ms ?? null,
      },
    };
  }
  // `system`: the agent-Issue-update delivery pair drives the next prompt, so it
  // must survive the move.
  const metadata: ConversationLogEntryMetadata = {};
  if (message.pending_agent_delivery) metadata.pending_agent_delivery = true;
  if (message.agent_delivery_task_id) metadata.agent_delivery_task_id = message.agent_delivery_task_id;
  return {
    ...base,
    kind: "message",
    authorType: "system",
    authorId: null,
    bodyMd: message.body,
    metadata,
  };
}
