import type { MultiremiStore } from "@multiremi/store/store.js";

export function readSessionLogRange(store: MultiremiStore, sessionId: string,
  from: number, to: number, cursor?: string, excludeAgentId?: string | null) {
  const start = cursor ? JSON.parse(cursor) as { seq: number; offset: number } : { seq: from + 1, offset: 0 };
  if (!start || !Number.isSafeInteger(start.seq) || start.seq < from + 1 || start.seq > to + 1
    || !Number.isSafeInteger(start.offset) || start.offset < 0) throw new Error("Invalid range cursor");
  const readTo = Math.min(to, store.getConversationLogHead(sessionId)?.headSeq ?? 0);
  const rows = store.listConversationLogRangePage(sessionId, start.seq - 1, readTo, 100);
  const entries: Array<Record<string, unknown>> = [];
  let remaining = 32_000;
  let next = { seq: start.seq, offset: start.offset };
  for (const entry of rows) {
    if (entry.visibility !== "shown" || entry.deleted_at
      || entry.author_type === "agent" && entry.author_id === excludeAgentId) {
      next = { seq: entry.seq + 1, offset: 0 };
      continue;
    }
    const offset = entry.seq === start.seq ? start.offset : 0;
    if (offset > entry.body_md.length) throw new Error("Invalid range cursor offset");
    let end = Math.min(entry.body_md.length, offset + remaining);
    if (end < entry.body_md.length && /[\uD800-\uDBFF]/.test(entry.body_md[end - 1] ?? "")) end--;
    const body = entry.body_md.slice(offset, end);
    entries.push({ session_id: sessionId, seq: entry.seq, id: entry.id, kind: entry.kind,
      author_type: entry.author_type, author_id: entry.author_id, task_id: entry.task_id,
      parent_id: entry.parent_id, metadata: entry.metadata, created_at: entry.created_at,
      body_md: body, body_offset: offset, body_omitted_chars: entry.body_md.length - end });
    remaining -= body.length;
    next = end < entry.body_md.length ? { seq: entry.seq, offset: end } : { seq: entry.seq + 1, offset: 0 };
    if (next.offset > 0 || remaining < 2) break;
  }
  const complete = rows.length === 0 || next.seq > readTo
    || next.offset === 0 && rows.length < 100 && next.seq > (rows.at(-1)?.seq ?? readTo);
  const end = complete ? { seq: readTo + 1, offset: 0 } : next;
  return { session_id: sessionId, from_seq: from, to_seq: to, entries,
    read_start: start, read_end: end, next_cursor: complete ? null : JSON.stringify(next) };
}
