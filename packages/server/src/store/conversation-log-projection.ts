import type { ConversationLogEntry } from "@multiremi/contracts/conversation-log";
import type { MultiremiChatMessage, MultiremiSessionEvent } from "@multiremi/contracts/types.js";

const TURN_STATE_FIELDS = [
  "status", "final_reply_md", "final_entry_id", "summary", "tool_call_count", "event_count",
  "type_histogram", "usage", "model", "elapsed_ms", "failure_reason",
];

/** Reconstruct immutable event bodies from the mutable display rows and their markers. */
export function conversationLogProjectionEvents(entries: ConversationLogEntry[]): MultiremiSessionEvent[] {
  const originalBodies = new Map<number, string>();
  for (const entry of entries) {
    if (entry.kind !== "message_edited" || typeof entry.metadata.previous_body !== "string") continue;
    const target = Number(entry.metadata.target_seq);
    if (Number.isFinite(target) && !originalBodies.has(target)) originalBodies.set(target, entry.metadata.previous_body);
  }
  return entries.filter((entry) => entry.kind !== "head" && entry.seq > 0).map((entry) => {
    const metadata: Record<string, unknown> = { ...entry.metadata };
    const commentId = (entry.kind === "message" || entry.kind === "system") && entry.id.startsWith("cmt_") ? entry.id : null;
    let body = entry.body_md;
    if (commentId) {
      body = originalBodies.get(entry.seq) ?? (entry.deleted_at && typeof metadata.deleted_body === "string" ? metadata.deleted_body : body);
      if (originalBodies.has(entry.seq)) {
        delete metadata.body;
        delete metadata.previous_body;
      }
      if (entry.deleted_at) delete metadata.deleted_body;
      if (entry.kind === "message" || entry.parent_id !== null) metadata.parent_comment_id = entry.parent_id;
    }
    if (entry.kind === "turn") for (const key of TURN_STATE_FIELDS) delete metadata[key];
    if (entry.kind === "message_edited") delete metadata.body;
    if (["message_edited", "message_deleted", "thread_resolved", "thread_unresolved", "task_completed", "task_failed", "task_cancelled", "task_steer"].includes(entry.kind)) {
      delete metadata.target_seq;
    }
    return {
      id: entry.id, sessionId: entry.session_id, seq: entry.seq,
      authorType: entry.author_type, authorId: entry.author_id, kind: entry.kind,
      body, taskId: commentId ? null : entry.task_id, sourceCommentId: commentId, metadata, createdAt: entry.created_at,
    };
  });
}

export function conversationLogChatMessage(entry: ConversationLogEntry): MultiremiChatMessage {
  return {
    id: entry.id, chatSessionId: entry.session_id, taskId: entry.task_id,
    role: entry.kind === "turn" ? "assistant" : entry.author_type === "member" ? "user" : "system",
    body: entry.kind === "turn" && typeof entry.metadata.final_reply_md === "string" ? entry.metadata.final_reply_md : entry.body_md,
    failureReason: typeof entry.metadata.failure_reason === "string" ? entry.metadata.failure_reason : null,
    elapsedMs: typeof entry.metadata.elapsed_ms === "number" ? entry.metadata.elapsed_ms : null,
    createdAt: entry.created_at,
  };
}
