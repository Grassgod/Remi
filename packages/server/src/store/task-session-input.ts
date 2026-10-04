import type { ConversationLogEntry } from "@multiremi/contracts/conversation-log.js";
import { expandHint, unreadRangeHint, TRIGGER_MESSAGE_INLINE_CHARS } from "@multiremi/contracts/session-input.js";

export function taskSessionInput(input: {
  sessionId: string;
  agentId: string;
  fromSeq: number;
  toSeq: number;
  entries: ConversationLogEntry[];
  triggerSeqs: ReadonlySet<number>;
  coldStart?: boolean;
  inlineChars?: number;
}): string {
  const visible = input.entries.filter(entry => entry.visibility === "shown" && !entry.deleted_at
    && (!(entry.author_type === "agent" && entry.author_id === input.agentId) || input.triggerSeqs.has(entry.seq)));
  const unread = visible.filter(entry => entry.seq > input.fromSeq && entry.seq <= input.toSeq
    && !(entry.author_type === "agent" && entry.author_id === input.agentId));
  const limit = input.inlineChars ?? TRIGGER_MESSAGE_INLINE_CHARS;
  return [
    JSON.stringify({ type: "unread_range", session_id: input.sessionId, from_seq: input.fromSeq,
      to_seq: input.toSeq, unread_count: unread.length,
      instruction: unreadRangeHint(input.sessionId, input.fromSeq, input.toSeq, unread.length, input.coldStart) }),
    ...visible.filter(entry => input.triggerSeqs.has(entry.seq)).map(entry => {
      const body = entry.body_md;
      const prefix = body.slice(0, limit);
      const omitted = body.length - prefix.length;
      return JSON.stringify({ type: "triggering_message", seq: entry.seq, id: entry.id,
        author_type: entry.author_type, author_id: entry.author_id, task_id: entry.task_id,
        body: prefix, ...(omitted ? { body_folded: true, body_omitted_chars: omitted,
          expand: `remi message list ${input.sessionId} --from ${entry.seq - 1} --to ${entry.seq}`,
          expand_hint: expandHint(omitted, `remi message list ${input.sessionId} --from ${entry.seq - 1} --to ${entry.seq}`) } : {}) });
    }),
  ].join("\n");
}
