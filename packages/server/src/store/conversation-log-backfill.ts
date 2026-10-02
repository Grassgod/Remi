import { createHash } from "node:crypto";
import { CONVERSATION_LOG_KIND_VISIBILITY, type ConversationLogEntryMetadata } from "@multiremi/contracts/conversation-log";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import type { AppendConversationLogInput } from "@multiremi/store/repos/conversation-log-repo.js";
import { chatMessageToConversationLog, sessionEventToConversationLog, targetSeqForMarker,
  type MirrorChatMessageRow, type MirrorSessionEvent } from "@multiremi/store/conversation-log-mirror.js";

export const CONVERSATION_LOG_BACKFILL_MIGRATION = "20260928_conversation_log_backfill";
const BATCH_SIZE = 32;
const TEXT_CHUNK_CHARS = 16_384;
type Row = Record<string, any>;
type SourceEntry = AppendConversationLogInput & { id: string; seq: number; createdAt: string };

export interface ConversationBackfillCounts {
  issueSessions: number;
  chatSessions: number;
  sessionEvents: number;
  mirroredComments: number;
  editedComments: number;
  deletedComments: number;
  orphanCommentsAppended: number;
  orphanCommentsSkipped: number;
  orphanSessionsSkipped: number;
  chatMessages: number;
  chatConflictSessions: number;
  chatReorderedMessages: number;
  tasksWithoutAssistant: number;
  insertedRows: number;
  existingRowsSkipped: number;
  commentTaskIdsFilled: number;
  chatOwnedTopicTasks: number;
  chatOwnedTopicIssueEvents: number;
  chatOwnedTopicIssueLogRows: number;
  chatOwnedTopicChatLogRows: number;
  maxReadResultBytes: number;
}

export interface ConversationBackfillReport {
  counts: ConversationBackfillCounts;
  orphanComments: Array<{ id: string; issueId: string; disposition: "appended" | "missing_issue" }>;
  chatSequenceConflicts: Array<{ sessionId: string; messages: Array<{ id: string; previousSeq: number; seq: number }> }>;
  mismatches: Array<{ sessionId: string; seq: number | null; reason: string }>;
}

export function emptyConversationBackfillReport(): ConversationBackfillReport {
  return { counts: { issueSessions: 0, chatSessions: 0, sessionEvents: 0, mirroredComments: 0,
    editedComments: 0, deletedComments: 0, orphanCommentsAppended: 0, orphanCommentsSkipped: 0, orphanSessionsSkipped: 0,
    chatMessages: 0, chatConflictSessions: 0, chatReorderedMessages: 0, tasksWithoutAssistant: 0,
    insertedRows: 0, existingRowsSkipped: 0, commentTaskIdsFilled: 0, chatOwnedTopicTasks: 0,
    chatOwnedTopicIssueEvents: 0, chatOwnedTopicIssueLogRows: 0, chatOwnedTopicChatLogRows: 0, maxReadResultBytes: 0 },
  orphanComments: [], chatSequenceConflicts: [], mismatches: [] };
}

export class ConversationBackfillMismatch extends Error {
  constructor(readonly report: ConversationBackfillReport) {
    super(`Conversation backfill mismatch: ${report.mismatches[0]?.reason ?? "unknown"}`);
  }
}

function measured<T>(report: ConversationBackfillReport, value: T): T {
  report.counts.maxReadResultBytes = Math.max(report.counts.maxReadResultBytes, Buffer.byteLength(JSON.stringify(value) ?? "null"));
  return value;
}

/** Bound both row count and variable-width text before crossing the PG bridge. */
function* readRows(db: SqlDatabase, report: ConversationBackfillReport, input: {
  from: string; columns: string[]; text?: Record<string, string>; where?: string;
  params?: unknown[]; order: string; key?: string;
}): Generator<Row> {
  const text = Object.entries(input.text ?? {});
  const columns = [...input.columns, ...text.flatMap(([alias, column]) => [
    `SUBSTR(${column}, 1, ${TEXT_CHUNK_CHARS}) AS ${alias}`, `LENGTH(${column}) AS __length_${alias}`,
  ])];
  const params = input.params ?? [];
  for (let offset = 0; ; offset += BATCH_SIZE) {
    const rows = measured(report, db.query(`SELECT ${columns.join(", ")} FROM ${input.from}
      ${input.where ? `WHERE ${input.where}` : ""} ORDER BY ${input.order} LIMIT ? OFFSET ?`).all(...params, BATCH_SIZE, offset)) as Row[];
    for (const row of rows) {
      for (const [alias, column] of text) {
        const length = Number(row[`__length_${alias}`] ?? 0);
        let value = row[alias] as string | null;
        for (let start = TEXT_CHUNK_CHARS + 1; start <= length; start += TEXT_CHUNK_CHARS) {
          const part = measured(report, db.query(`SELECT SUBSTR(${column}, ?, ${TEXT_CHUNK_CHARS}) AS part
            FROM ${input.from} WHERE ${input.key ?? "id"} = ?`).get(start, row.id)) as { part: string };
          value = (value ?? "") + part.part;
        }
        row[alias] = value;
        delete row[`__length_${alias}`];
      }
      yield row;
    }
    if (rows.length < BATCH_SIZE) return;
  }
}

const COMMENT_COLUMNS = ["id", "issue_id", "issue_session_id", "author_type", "author_id", "task_id", "parent_id",
  "type", "resolved_at", "resolved_by_type", "resolved_by_id", "created_at", "updated_at"];

function commentRows(db: SqlDatabase, report: ConversationBackfillReport, where: string, params: unknown[] = []): Row[] {
  return [...readRows(db, report, { from: "multiremi_issue_comments", columns: COMMENT_COLUMNS,
    text: { body: "body" }, where, params, order: "created_at, id" })];
}

interface SourceSession { id: string; kind: "issue" | "chat"; entries: SourceEntry[]; sourceMaxSeq: number }

/** Read-only source plan; migration and reconciliation use the same B1 mapping. */
export function* conversationBackfillSource(db: SqlDatabase, report: ConversationBackfillReport): Generator<SourceSession> {
  const orphans = new Map<string, Row[]>();
  for (const comment of commentRows(db, report, "NOT EXISTS (SELECT 1 FROM multiremi_session_events e WHERE e.source_comment_id = multiremi_issue_comments.id)")) {
    const issue = db.query("SELECT id FROM multiremi_issues WHERE id = ?").get(comment.issue_id);
    if (!issue) {
      report.counts.orphanCommentsSkipped++;
      report.orphanComments.push({ id: comment.id, issueId: comment.issue_id, disposition: "missing_issue" });
      continue;
    }
    const session = db.query(`SELECT id FROM multiremi_issue_sessions WHERE issue_id = ?
      ORDER BY CASE WHEN id = ? THEN 0 WHEN is_default = 1 THEN 1 ELSE 2 END, created_at, id LIMIT 1`)
      .get(comment.issue_id, comment.issue_session_id ?? "");
    if (!session) {
      report.mismatches.push({ sessionId: "", seq: null, reason: `orphan_comment_without_session:${comment.id}` });
      continue;
    }
    const list = orphans.get(session.id) ?? [];
    list.push(comment);
    orphans.set(session.id, list);
  }
  const sessions = readRows(db, report, { from: "multiremi_issue_sessions", columns: ["id", "issue_id", "created_at"], order: "id" });
  for (const session of sessions) {
    const issue = [...readRows(db, report, { from: "multiremi_issues", columns: ["id"],
      text: { title: "title", description: "description" }, where: "id = ?", params: [session.issue_id], order: "id" })][0];
    if (!issue) {
      // Deleted Issues can leave historical sessions/events. Retain the legacy
      // tables and skip them, just like comments whose Issue no longer exists.
      report.counts.orphanSessionsSkipped++;
      continue;
    }
    report.counts.issueSessions++;
    const body = issue.description?.trim() ? `${issue.title}\n\n${issue.description.trim()}` : issue.title;
    const entries: SourceEntry[] = [{ sessionId: session.id, seq: 0, id: `head_${session.id}`, kind: "head",
      authorType: "system", taskId: null, bodyMd: body, metadata: { title: issue.title }, createdAt: session.created_at }];
    const events = [...readRows(db, report, { from: "multiremi_session_events", columns: ["id", "session_id", "seq", "author_type", "author_id", "kind", "task_id", "source_comment_id", "created_at"],
      text: { body: "body", metadata: "metadata" }, where: "session_id = ?", params: [session.id], order: "seq" })] as MirrorSessionEvent[];
    const comments = new Map(commentRows(db, report, `id IN (SELECT source_comment_id FROM multiremi_session_events WHERE session_id = ?)`, [session.id]).map((row) => [row.id, row]));
    const commentSeqs = new Map(events.filter((event) => event.source_comment_id).map((event) => [event.source_comment_id!, Number(event.seq)]));
    const turnSeqs = new Map(events.filter((event) => event.kind === "task_assigned" && event.task_id).map((event) => [event.task_id!, Number(event.seq)]));
    const edits = new Map<string, MirrorSessionEvent[]>();
    const deletes = new Map<string, string>();
    for (const event of events) {
      const metadata = JSON.parse(event.metadata) as ConversationLogEntryMetadata;
      const id = typeof metadata.comment_id === "string" ? metadata.comment_id : null;
      if (event.kind === "message_edited" && id) edits.set(id, [...(edits.get(id) ?? []), event]);
      if (event.kind === "message_deleted" && id) deletes.set(id, event.created_at);
    }
    for (const event of events) {
      report.counts.sessionEvents++;
      const comment = event.source_comment_id ? comments.get(event.source_comment_id) : null;
      const mapped = sessionEventToConversationLog(event, comment?.task_id ?? null);
      if (!mapped || Number(event.seq) <= 0) {
        report.mismatches.push({ sessionId: session.id, seq: Number(event.seq), reason: `unmapped_event:${event.kind}` });
        continue;
      }
      const entry: SourceEntry = { ...mapped, updatedAt: event.created_at };
      if (event.source_comment_id) {
        report.counts.mirroredComments++;
        const history = edits.get(event.source_comment_id) ?? [];
        entry.revision = 1 + history.length;
        if (history.length) report.counts.editedComments++;
        if (comment && history.length && history.at(-1)!.body !== comment.body) {
          report.mismatches.push({ sessionId: session.id, seq: Number(event.seq), reason: `last_edit_body_differs:${event.source_comment_id}` });
        }
        if (comment) {
          entry.bodyMd = comment.body;
          entry.parentId = comment.parent_id;
          entry.resolvedAt = comment.resolved_at;
          entry.resolvedByType = comment.resolved_by_type;
          entry.resolvedById = comment.resolved_by_id;
          entry.updatedAt = comment.updated_at;
        } else {
          report.counts.deletedComments++;
          entry.bodyMd = "";
          entry.taskId = null;
          entry.deletedAt = deletes.get(event.source_comment_id) ?? event.created_at;
          entry.metadata = { ...entry.metadata, deleted_body: event.body };
        }
        // Old startup mirrors omitted this key; agents must retain that exact metadata.
        if (!Object.hasOwn(JSON.parse(event.metadata), "parent_comment_id")) {
          entry.metadata = { ...entry.metadata, _legacy_parent_key_absent: true };
        }
      }
      if (["message_edited", "message_deleted", "thread_resolved", "thread_unresolved"].includes(mapped.kind)) {
        const target = targetSeqForMarker((id) => commentSeqs.get(id) ?? null, mapped.metadata);
        if (target != null) entry.metadata!.target_seq = target;
      } else if (["task_completed", "task_failed", "task_cancelled", "task_steer"].includes(mapped.kind) && mapped.taskId) {
        const target = turnSeqs.get(mapped.taskId);
        if (target != null) entry.metadata!.target_seq = target;
      }
      entries.push(entry);
    }
    let maxSeq = Math.max(0, ...events.map((event) => Number(event.seq)));
    for (const comment of orphans.get(session.id) ?? []) {
      report.counts.orphanCommentsAppended++;
      report.orphanComments.push({ id: comment.id, issueId: comment.issue_id, disposition: "appended" });
      // An orphan has no legacy seq. Once allocated, retain it across later writes.
      const existing = db.query("SELECT session_id, seq FROM multiremi_conversation_log WHERE id = ?").get(comment.id);
      const seq = existing?.session_id === session.id ? Number(existing.seq) : maxSeq + 1;
      maxSeq = Math.max(maxSeq, seq);
      entries.push({ sessionId: session.id, seq, id: comment.id, kind: comment.type === "system" ? "system" : "message",
        authorType: comment.author_type, authorId: comment.author_id, taskId: comment.task_id,
        bodyMd: comment.body, parentId: comment.parent_id, resolvedAt: comment.resolved_at,
        resolvedByType: comment.resolved_by_type, resolvedById: comment.resolved_by_id,
        metadata: {}, createdAt: comment.created_at, updatedAt: comment.updated_at });
    }
    entries.sort((a, b) => a.seq - b.seq);
    yield { id: session.id, kind: "issue", entries, sourceMaxSeq: maxSeq };
  }
  for (const chat of readRows(db, report, { from: "multiremi_chat_sessions", columns: ["id", "creator_id", "created_at", "message_sequence"], text: { title: "title" }, order: "id" })) {
    report.counts.chatSessions++;
    const messages = [...readRows(db, report, { from: "multiremi_chat_messages", columns: ["id", "chat_session_id", "task_id", "role", "elapsed_ms", "pending_agent_delivery", "agent_delivery_task_id", "sequence", "created_at"],
      text: { body: "body", failure_reason: "failure_reason" }, where: "chat_session_id = ?", params: [chat.id], order: "sequence, id" })] as MirrorChatMessageRow[];
    const conflict = new Set(messages.map((message) => Number(message.sequence))).size !== messages.length;
    if (messages.some((message) => Number(message.sequence) <= 0) && !conflict) {
      report.mismatches.push({ sessionId: chat.id, seq: null, reason: "nonpositive_chat_sequence" });
    }
    if (conflict) {
      report.counts.chatConflictSessions++;
      const remapped = messages.map((message, index) => ({ id: message.id, previousSeq: Number(message.sequence), seq: index + 1 }));
      report.chatSequenceConflicts.push({ sessionId: chat.id, messages: remapped });
      report.counts.chatReorderedMessages += remapped.filter((message) => message.seq !== message.previousSeq).length;
    }
    const entries: SourceEntry[] = [{ sessionId: chat.id, seq: 0, id: `head_${chat.id}`, kind: "head", authorType: "system",
      taskId: null, bodyMd: chat.title ?? "", metadata: { title: chat.title ?? "" }, createdAt: chat.created_at }];
    messages.forEach((message, index) => {
      report.counts.chatMessages++;
      const mapped = chatMessageToConversationLog({ ...message, sequence: conflict ? index + 1 : Number(message.sequence) }, { id: chat.id, creatorId: chat.creator_id });
      if (mapped.kind === "turn" && message.task_id) {
        const task = db.query("SELECT status FROM multiremi_tasks WHERE id = ?").get(message.task_id);
        if (task) mapped.metadata.status = task.status;
      }
      entries.push(mapped);
    });
    const missing = db.query(`SELECT COUNT(*) AS count FROM multiremi_tasks task WHERE task.chat_session_id = ?
      AND task.status IN ('cancelled', 'failed') AND NOT EXISTS
      (SELECT 1 FROM multiremi_chat_messages message WHERE message.task_id = task.id AND message.role = 'assistant')`).get(chat.id);
    report.counts.tasksWithoutAssistant += Number(missing?.count ?? 0);
    yield { id: chat.id, kind: "chat", entries, sourceMaxSeq: Math.max(Number(chat.message_sequence ?? 0), ...entries.map((entry) => entry.seq)) };
  }
}

function countChatOwnedTopicTasks(db: SqlDatabase, report: ConversationBackfillReport): void {
  // Chat ownership does not forbid historical lifecycle events or deliberate
  // Issue comment cross-posts. Count these rows; their mapped contents remain
  // subject to the same per-session integrity checks as every other source row.
  for (const task of readRows(db, report, { from: "multiremi_tasks", columns: ["id", "chat_session_id"],
    where: "issue_id IS NOT NULL AND chat_session_id IS NOT NULL", order: "id" })) {
    report.counts.chatOwnedTopicTasks++;
    const events = db.query("SELECT COUNT(*) AS count FROM multiremi_session_events WHERE task_id = ?").get(task.id);
    report.counts.chatOwnedTopicIssueEvents += Number(events.count);
    const issueRows = db.query(`SELECT COUNT(*) AS count FROM multiremi_conversation_log log
      JOIN multiremi_issue_sessions session ON session.id = log.session_id WHERE log.task_id = ?`).get(task.id);
    report.counts.chatOwnedTopicIssueLogRows += Number(issueRows.count);
    const chatRows = db.query("SELECT COUNT(*) AS count FROM multiremi_conversation_log WHERE session_id = ? AND task_id = ?")
      .get(task.chat_session_id, task.id);
    report.counts.chatOwnedTopicChatLogRows += Number(chatRows.count);
  }
}

const LOG_COLUMNS = ["session_id", "seq", "id", "kind", "visibility", "author_type", "author_id", "task_id", "body_md", "parent_id",
  "resolved_at", "resolved_by_type", "resolved_by_id", "metadata", "revision", "created_at", "updated_at", "deleted_at"];

function insertEntries(db: SqlDatabase, entries: SourceEntry[]): void {
  for (let offset = 0; offset < entries.length; offset += BATCH_SIZE) {
    const batch = entries.slice(offset, offset + BATCH_SIZE);
    db.run(`INSERT INTO multiremi_conversation_log (${LOG_COLUMNS.join(", ")}) VALUES
      ${batch.map(() => `(${LOG_COLUMNS.map(() => "?").join(",")})`).join(",")}`, batch.flatMap((entry) => [
      entry.sessionId, entry.seq, entry.id, entry.kind, CONVERSATION_LOG_KIND_VISIBILITY[entry.kind],
      entry.authorType, entry.authorId ?? null, entry.taskId ?? null, entry.bodyMd ?? "", entry.parentId ?? null,
      entry.resolvedAt ?? null, entry.resolvedByType ?? null, entry.resolvedById ?? null, JSON.stringify(entry.metadata ?? {}),
      entry.revision ?? 1, entry.createdAt, entry.updatedAt ?? entry.createdAt, entry.deletedAt ?? null,
    ]));
  }
}

/** Called inside runMigrationOnce's transaction, before any runtime can write. */
export function backfillConversationLogWithinTransaction(db: SqlDatabase): ConversationBackfillReport {
  const report = emptyConversationBackfillReport();
  for (const source of conversationBackfillSource(db, report)) {
    const existing = new Map([...readRows(db, report, { from: "multiremi_conversation_log",
      columns: ["id", "seq", "task_id"], where: "session_id = ?", params: [source.id], order: "seq" })].map((row) => [Number(row.seq), row]));
    const insert: SourceEntry[] = [];
    for (const entry of source.entries) {
      const row = existing.get(entry.seq);
      if (!row) { insert.push(entry); continue; }
      report.counts.existingRowsSkipped++;
      if (!entry.id.startsWith("cmt_")) continue;
      const expected = entry.taskId ?? null;
      if (row.task_id != null && row.task_id !== expected) {
        report.mismatches.push({ sessionId: source.id, seq: entry.seq, reason: "existing_comment_task_id_differs" });
      } else if (row.task_id == null && expected != null) {
        db.run("UPDATE multiremi_conversation_log SET task_id = ? WHERE session_id = ? AND seq = ? AND task_id IS NULL",
          [expected, source.id, entry.seq]);
        report.counts.commentTaskIdsFilled++;
      }
    }
    insertEntries(db, insert);
    report.counts.insertedRows += insert.length;
    for (const conflict of report.chatSequenceConflicts.filter((conflict) => conflict.sessionId === source.id)) {
      for (const message of conflict.messages) db.run("UPDATE multiremi_chat_messages SET sequence = ? WHERE id = ?", [message.seq, message.id]);
    }
    const now = new Date().toISOString();
    db.run(`INSERT INTO multiremi_conversation_heads (session_id, head_seq, log_version, updated_at) VALUES (?, ?, 0, ?)
      ON CONFLICT(session_id) DO UPDATE SET head_seq = CASE WHEN multiremi_conversation_heads.head_seq < excluded.head_seq
        THEN excluded.head_seq ELSE multiremi_conversation_heads.head_seq END`, [source.id, source.sourceMaxSeq, now]);
    if (source.kind === "chat") db.run(`UPDATE multiremi_chat_sessions SET message_sequence = CASE WHEN message_sequence < ?
      THEN ? ELSE message_sequence END WHERE id = ?`, [source.sourceMaxSeq, source.sourceMaxSeq, source.id]);
  }
  countChatOwnedTopicTasks(db, report);
  if (report.mismatches.length) throw new ConversationBackfillMismatch(report);
  return report;
}

export function canonicalConversationJson(value: unknown): string {
  const normalize = (item: any): any => Array.isArray(item) ? item.map(normalize)
    : item && typeof item === "object" ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, normalize(item[key])])) : item;
  return JSON.stringify(normalize(value));
}

function entryHash(row: SourceEntry): string {
  // Chat turn text lives in final_reply_md, unlike issue turn prompts in body_md.
  const body = row.kind === "turn" && typeof row.metadata?.final_reply_md === "string" ? row.metadata.final_reply_md : row.bodyMd ?? "";
  return createHash("sha256").update(canonicalConversationJson([row.kind, row.authorType, row.authorId ?? null,
    body, row.createdAt, row.taskId ?? null, row.parentId ?? null])).digest("hex");
}

export interface ConversationReconciliation extends ConversationBackfillReport {
  sessions: Array<{ sessionId: string; kind: "issue" | "chat"; expectedCount: number; actualCount: number;
    sourceDigest: string; logDigest: string }>;
}

/** Pure reads: no store construction, migration, repair or source mutation. */
export function reconcileConversationLog(db: SqlDatabase): ConversationReconciliation {
  const report: ConversationReconciliation = { ...emptyConversationBackfillReport(), sessions: [] };
  const known = new Set<string>();
  for (const source of conversationBackfillSource(db, report)) {
    known.add(source.id);
    const rows = [...readRows(db, report, { from: "multiremi_conversation_log", columns: ["id", "session_id", "seq", "kind", "author_type", "author_id", "task_id", "parent_id", "created_at", "revision", "resolved_at", "resolved_by_type", "resolved_by_id", "deleted_at"],
      text: { body_md: "body_md", metadata: "metadata" }, where: "session_id = ?", params: [source.id], order: "seq" })];
    const actual = new Map(rows.map((row) => [Number(row.seq), row]));
    if (rows.length !== source.entries.length) report.mismatches.push({ sessionId: source.id, seq: null, reason: "row_count" });
    const sourceHashes: string[] = [];
    const logHashes: string[] = [];
    let previous = -1;
    for (const row of rows) {
      if (Number(row.seq) <= previous) report.mismatches.push({ sessionId: source.id, seq: Number(row.seq), reason: "seq_not_strictly_increasing" });
      previous = Number(row.seq);
    }
    for (const entry of source.entries) {
      const row = actual.get(entry.seq);
      const hash = entryHash(entry);
      sourceHashes.push(`${entry.seq}:${hash}`);
      if (!row) { report.mismatches.push({ sessionId: source.id, seq: entry.seq, reason: "missing_seq" }); continue; }
      const metadata = JSON.parse(row.metadata) as ConversationLogEntryMetadata;
      const logHash = entryHash({ sessionId: row.session_id, seq: Number(row.seq), id: row.id, kind: row.kind,
        authorType: row.author_type, authorId: row.author_id, taskId: row.task_id, bodyMd: row.body_md,
        parentId: row.parent_id, createdAt: row.created_at, metadata });
      logHashes.push(`${entry.seq}:${logHash}`);
      if (hash !== logHash) report.mismatches.push({ sessionId: source.id, seq: entry.seq, reason: "content_hash" });
      if (entry.deletedAt && !row.deleted_at) report.mismatches.push({ sessionId: source.id, seq: entry.seq, reason: "missing_tombstone" });
      if (entry.kind.startsWith("thread_") || entry.kind === "message_edited" || entry.kind === "message_deleted") {
        if (entry.metadata?.target_seq !== metadata.target_seq) report.mismatches.push({ sessionId: source.id, seq: entry.seq, reason: "marker_target_seq" });
      }
    }
    const digest = (hashes: string[]) => createHash("sha256").update(hashes.join("\n")).digest("hex");
    report.sessions.push({ sessionId: source.id, kind: source.kind, expectedCount: source.entries.length,
      actualCount: rows.length, sourceDigest: digest(sourceHashes), logDigest: digest(logHashes) });
    const head = db.query("SELECT head_seq FROM multiremi_conversation_heads WHERE session_id = ?").get(source.id);
    if (!head || Number(head.head_seq) < source.sourceMaxSeq) report.mismatches.push({ sessionId: source.id, seq: null, reason: "head_seq_too_low" });
  }
  for (const row of readRows(db, report, { from: "multiremi_conversation_log", columns: ["session_id AS id"], order: "session_id", where: "seq = 0" })) {
    if (!known.has(row.id)) report.mismatches.push({ sessionId: row.id, seq: null, reason: "log_without_source_session" });
  }
  countChatOwnedTopicTasks(db, report);
  return report;
}
