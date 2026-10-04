import { projectTurnCard } from "@multiremi/store/turn-attempts.js";
import { registerTurnChangeHook, registerExecutionMessageHook, notifyTurnChanged } from "@multiremi/store/turn-execution-records.js";
// Conversation log domain: the single per-session log that replaces the three
// conversation tables (MUL-402 / ADR 0006). One row is one display unit; every
// other lifecycle fact is a hidden marker on the same seq axis.
//
// Seq allocation is `UPDATE multiremi_conversation_heads SET head_seq = head_seq + 1
// RETURNING head_seq` inside the caller's transaction, so two server processes
// cannot take the same seq; the `(session_id, seq)` primary key is the backstop.
// The legacy row lock plus `MAX(seq) + 1` is gone.
import { createId, nowIso } from "@multiremi/ids.js";
import { nullableString, parseJson, toJson } from "@multiremi/store/helpers.js";
import { type StoreContext } from "@multiremi/store/context.js";
import { afterCommit } from "@multiremi/store/db/postgres.js";
import { renderMarkdown } from "../../render/markdown.js";
import {
  CONVERSATION_LOG_BEFORE_VISIBLE_COUNT_CAP,
  CONVERSATION_LOG_KIND_VISIBILITY,
  type ConversationLogEntry,
  type ConversationLogEntryMetadata,
  type ConversationLogKind,
  type ConversationLogLocation,
  type ConversationLogPatch,
  type ConversationLogVisibility,
  type ConversationLogWindow,
} from "@multiremi/contracts/conversation-log";

type Row = Record<string, unknown>;

// Chat streams its in-flight trace separately; show its persisted card only at
// the terminal outcome, while keeping the turn pointer addressable from creation.
const SHOWN_ROW_SQL = `visibility = 'shown' AND deleted_at IS NULL
  AND NOT (kind = 'turn' AND session_id LIKE 'chat_%' AND EXISTS
    (SELECT 1 FROM multiremi_turns t WHERE t.id = multiremi_conversation_log.id
      AND t.status IN ('pending','running','awaiting_human')))`;

/** Cap on one page of the window read; the route rejects anything larger. */
export const CONVERSATION_LOG_MAX_WINDOW = 100;

/** Default window when the caller passes neither `before` nor `after`. */
export const CONVERSATION_LOG_DEFAULT_WINDOW = 30;

export const CONVERSATION_LOG_HEAD_SQL = "SELECT * FROM multiremi_conversation_heads WHERE session_id = ?";
export const CONVERSATION_LOG_RANGE_SQL =
  "SELECT * FROM multiremi_conversation_log WHERE session_id = ? AND seq > ? AND seq <= ? ORDER BY seq ASC";
export const CONVERSATION_LOG_RANGE_PAGE_SQL = `${CONVERSATION_LOG_RANGE_SQL} LIMIT ?`;

/**
 * Read-only query seam. `window` and `locate` funnel every statement through
 * this so MUL-403's read pool can be wired in at v2-integration without
 * touching the SQL; B1 defaults to the primary handle.
 */
export type ConversationLogQuery = (
  sql: string,
  params: unknown[],
) => { get(): unknown; all(): unknown[] };

export type ConversationLogWindowInput = {
  anchor?: number | null;
  before?: number | null;
  after?: number | null;
  /**
   * Optional read-only connection. Defaults to the primary store handle; C
   * passes the bounded read pool here.
   */
  query?: ConversationLogQuery | null;
};

export type AppendConversationLogInput = {
  sessionId: string;
  /** Source row id (`cmt_*`, chat message id, `sevt_*`); unique across the table. */
  id?: string;
  kind: ConversationLogKind;
  authorType: string;
  messageKind?: import("@multiremi/contracts/unified-model.js").MessageKind;
  authorId?: string | null;
  taskId?: string | null;
  bodyMd?: string;
  bodyHtml?: string | null;
  renderVersion?: string | null;
  parentId?: string | null;
  resolvedAt?: string | null;
  resolvedByType?: string | null;
  resolvedById?: string | null;
  metadata?: ConversationLogEntryMetadata;
  revision?: number;
  createdAt?: string;
  updatedAt?: string | null;
  deletedAt?: string | null;
  /**
   * Place the row at this seq instead of allocating one. Issue sessions use it to
   * keep the log on `multiremi_session_events.seq`, so lane cursors,
   * `inherit_cutoff_seq`, `follow_frozen_seq` and stored `requiredEventSeq`
   * values stay valid without remapping. The head counter is raised to match.
   */
  seq?: number;
};

export type UpdateConversationLogInput = {
  /** Patch fields to write. Metadata, when present, replaces the stored value. */
  fields: ConversationLogPatch["fields"];
  /** Stored `updated_at`; defaults to now. */
  touch?: boolean;
};

export class ConversationLogRepo {
  constructor(private ctx: StoreContext) {
    registerExecutionMessageHook(ctx.db,id=>{const entry=this.getEntryById(id);if(entry)this.emit(entry.session_id,entry);});
    registerTurnChangeHook(ctx.db, (turnId,created) => {
      const row=ctx.db.query("SELECT session_id,seq FROM multiremi_turns WHERE id=?").get(turnId);
      if (!row) return;
      ctx.db.run("UPDATE multiremi_conversation_log SET revision=revision+1,updated_at=? WHERE session_id=? AND seq=?",[nowIso(),row.session_id,row.seq]);
      this.touchSessionWithinTransaction(row.session_id);
      const entry=this.getEntryWithinTransaction(row.session_id,Number(row.seq));
      if(entry)this.emit(entry.session_id,created || entry.session_id.startsWith("chat_") ?entry:toPatch(entry.seq,entry.revision,{metadata:entry.metadata,body_md:entry.body_md,body_html:entry.body_html,render_version:entry.render_version},entry.updated_at));
    });
  }
  private materialize(row:Row):ConversationLogEntry { return projectTurnCard(this.ctx.db,toConversationLogEntry(row)); }

  /**
   * The write hook C's Live Hub implements. B1 ships an empty implementation;
   * a throwing listener must never roll back the write, so failures are
   * swallowed the same way realtime listeners are.
   */
  private listeners = new Set<import("@multiremi/contracts/conversation-log").ConversationLogListener>();

  setConversationLogListener(listener: import("@multiremi/contracts/conversation-log").ConversationLogListener | null): void {
    this.listeners.clear();
    if (listener) this.listeners.add(listener);
  }

  subscribeConversationLog(listener: import("@multiremi/contracts/conversation-log").ConversationLogListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(sessionId: string, payload: ConversationLogEntry | ConversationLogPatch): void {
    afterCommit(this.ctx.db, () => {
      for (const listener of [...this.listeners]) {
        try {
          listener.onEntry(sessionId, payload);
        } catch {
          // A subscriber must not be able to roll back a conversation write.
        }
      }
    });
  }

  /** The seq `head` row occupies; also the anchor when no anchor is requested. */
  static readonly HEAD_SEQ = 0;

  private ensureCounterWithinTransaction(sessionId: string, at: string, seq = 0): void {
    // Acquire the writer lock before reading legacy rows. SQLite's deferred
    // transaction otherwise cannot upgrade a concurrent read to a write.
    this.ctx.db.run(
      `INSERT INTO multiremi_conversation_heads (session_id, head_seq, log_version, updated_at)
       VALUES (?, 0, 0, ?)
       ON CONFLICT(session_id) DO NOTHING`,
      [sessionId, at],
    );
    const initialSeq = Math.max(seq, 0);
    this.ctx.db.run(
      `INSERT INTO multiremi_conversation_heads (session_id, head_seq, log_version, updated_at)
       VALUES (?, ?, 0, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         head_seq = CASE WHEN multiremi_conversation_heads.head_seq < excluded.head_seq
           THEN excluded.head_seq ELSE multiremi_conversation_heads.head_seq END`,
      [sessionId, initialSeq, at],
    );
  }

  /**
   * Create the `head` row and the counter for a session. Idempotent: a second
   * call for the same session is a no-op so migrations and lazy creation can
   * race safely.
   */
  ensureSessionHeadWithinTransaction(
    sessionId: string,
    input: { bodyMd: string; title?: string | null; metadata?: ConversationLogEntryMetadata; createdAt?: string } = { bodyMd: "" },
  ): ConversationLogEntry {
    const now = input.createdAt ?? nowIso();
    this.ensureCounterWithinTransaction(sessionId, now);
    const metadata: ConversationLogEntryMetadata = {
      ...(input.metadata ?? {}),
      ...(input.title != null ? { title: input.title } : {}),
    };
    const existing = this.ctx.db.query(
      "SELECT body_md, metadata FROM multiremi_conversation_log WHERE session_id = ? AND seq = 0",
    ).get(sessionId) as Row | null;
    if (existing) {
      // A renamed Issue or Chat keeps one row: the second write is an in-place
      // update with `revision++`, never a second head.
      const bodyChanged = String(existing.body_md ?? "") !== input.bodyMd;
      const metadataChanged = String(existing.metadata ?? "{}") !== toJson(metadata);
      if (!bodyChanged && !metadataChanged) return this.getEntryWithinTransaction(sessionId, 0)!;
      return this.updateWithinTransaction(sessionId, 0, {
        fields: { body_md: input.bodyMd, metadata, updated_at: now },
      })!;
    }
    const entry = this.appendWithinTransaction({
      sessionId,
      id: `head_${sessionId}`,
      kind: "head",
      authorType: "system",
      authorId: null,
      bodyMd: input.bodyMd,
      metadata,
      createdAt: now,
    });
    return entry;
  }

  /**
   * Sync the `head` row to the Issue title and description. Every session of one
   * Issue mirrors its own row, so this runs once per session; `revision` bumps
   * only when the text actually changed.
   */
  syncIssueHeadWithinTransaction(
    sessionId: string,
    issue: { title: string; description?: string | null },
    createdAt?: string,
  ): ConversationLogEntry {
    const body = issue.description?.trim()
      ? `${issue.title}\n\n${issue.description.trim()}`
      : issue.title;
    return this.ensureSessionHeadWithinTransaction(sessionId, {
      bodyMd: body,
      title: issue.title,
      metadata: { title: issue.title },
      createdAt,
    });
  }

  /** Sync a chat head from the session title. */
  syncChatHeadWithinTransaction(sessionId: string, title: string | null, createdAt?: string): ConversationLogEntry {
    return this.ensureSessionHeadWithinTransaction(sessionId, {
      bodyMd: title ?? "",
      title,
      metadata: { title: title ?? undefined },
      createdAt,
    });
  }

  append(input: AppendConversationLogInput): ConversationLogEntry {
    const appendWithinTransaction = () => this.appendWithinTransaction(input);
    return this.ctx.db.inTransaction ? appendWithinTransaction() : this.ctx.db.transaction(appendWithinTransaction)();
  }

  /** Allocate seq and insert. The caller already owns the transaction. */
  appendWithinTransaction(input: AppendConversationLogInput): ConversationLogEntry {
    if (input.kind==='turn' && input.taskId) {
      const turn=this.ctx.db.query("SELECT t.session_id,t.seq FROM multiremi_turns t JOIN multiremi_turn_attempts a ON a.turn_id=t.id WHERE a.id=?").get(input.taskId);
      if(turn)return this.getEntryWithinTransaction(turn.session_id,Number(turn.seq))!;
    }
    const kind = input.kind === 'system' || input.kind === 'delegation_report' ? 'message' : input.kind;
    const visibility = CONVERSATION_LOG_KIND_VISIBILITY[kind];
    if (!visibility) throw new Error(`Unknown conversation log kind: ${kind}`);
    const metadata:any={...input.metadata};
    const envelope=metadata.envelope;delete metadata.envelope;
    if(envelope){const {to,kind,wake,dedupeKey,replyTo,recipient_agent_id,...provenance}=envelope;
      metadata.message_source=provenance.source;metadata.priority=provenance.priority;
      metadata.message_outcome=provenance.outcome;metadata.address_context=Object.fromEntries(Object.entries(to??{}).filter(([k])=>k!=='role'&&k!=='agentId'));}
    let toType:string|null="none",toRef:string|null=null,toAgent:string|null=null,toMember:string|null=null;
    if(envelope){
      const address=envelope.to??{},role=address.role;
      toType=role==='agent'||role==='chat'?'agent':'role';toRef=toType==='agent'?address.agentId:role;
      toAgent=envelope.recipient_agent_id??(toType==='agent'?address.agentId:null);
      let issueId=role==='issue_owner'?address.issueId:null;
      if(role==='parent_owner')issueId=this.ctx.db.query('SELECT parent_issue_id FROM multiremi_issues WHERE id=?').get(address.childIssueId)?.parent_issue_id;
      if(issueId&&!toAgent){const owner=this.ctx.db.query('SELECT assignee_type,assignee_id FROM multiremi_issues WHERE id=?').get(issueId);
        if(owner?.assignee_type==='agent')toAgent=owner.assignee_id;else if(owner?.assignee_type==='member')toMember=owner.assignee_id;}
      if(role==='delegator'&&!toAgent){const source=this.ctx.db.query('SELECT delegated_by_agent_id FROM multiremi_turn_execution_records WHERE id=?').get(envelope.source?.taskId??input.taskId);toAgent=source?.delegated_by_agent_id??null;}
    }
    const messageKind=input.messageKind??(input.kind==='head'||input.kind==='turn'?'status':envelope?.kind==='decision_needed'?'decision':envelope?.kind==='lifecycle'?'status':envelope?.kind??(input.kind==='system'?'status':input.kind==='delegation_report'?'report':input.authorType==='agent'?'reply':'request'));
    if(kind==='turn'){input={...input,bodyMd:'',metadata:{}};}
    // Completion stages the output once in the terminal transaction; the
    // product writer publishes that same message with its thread metadata.
    const staged=input.id?this.getEntryById(input.id):null;
    if(staged?.metadata.pending_completion===true){
      const {pending_completion,...prior}=staged.metadata;
      this.ctx.db.run("UPDATE multiremi_conversation_log SET visibility='shown',reply_to_id=?,sender_type=?,sender_id=? WHERE id=?",[input.parentId??null,input.authorType,input.authorId??null,input.id]);
      const entry=this.updateWithinTransaction(staged.session_id,staged.seq,{fields:{body_md:input.bodyMd??'',metadata:{...prior,...metadata}}})!;
      this.emit(entry.session_id,entry);return entry;
    }
    // `head` is the row at seq 0, not an event: it takes no allocation, so the
    // first real append still gets seq 1 and `cursor_seq = 0` keeps meaning
    // "nothing read" for every lane.
    const seq = input.seq != null
      ? Math.max(0, Math.floor(input.seq))
      : input.kind === "head" ? 0 : this.nextSeqWithinTransaction(input.sessionId);
    if (input.seq != null) this.raiseHeadWithinTransaction(input.sessionId, seq);
    const id = input.id ?? createId("clog");
    const workId=input.taskId?this.ctx.db.query('SELECT turn_id FROM multiremi_turn_attempts WHERE id=?').get(input.taskId)?.turn_id??input.taskId:null;
    const now = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? now;
    const rendered = renderMarkdown(input.bodyMd ?? "");
    this.ctx.db.run(
      `INSERT INTO multiremi_conversation_log (
         session_id, seq, id, kind, visibility, sender_type, sender_id, task_id,
         body_md, body_html, render_version, reply_to_id,
         resolved_at, resolved_by_type, resolved_by_id,
         metadata, revision, created_at, updated_at, deleted_at,
         to_type,to_ref,to_agent_id,to_member_id,message_kind,wake_requested,wake_applied,wake_reason,dedupe_key
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.sessionId,
        seq,
        id,
        kind,
        visibility,
        input.authorType === "system" || input.authorType === "external" ? "platform" : input.authorType,
        input.authorId ?? null,
        workId,
        input.bodyMd ?? "",
        rendered.html,
        rendered.render_version,
        input.parentId ?? null,
        input.resolvedAt ?? null,
        input.resolvedByType ?? null,
        input.resolvedById ?? null,
        toJson(kind==='turn'?{}:metadata),
        input.revision ?? 1,
        now,
        updatedAt,
        input.deletedAt ?? null,
        toType,toRef,toAgent,toMember,messageKind,envelope?.wake??"inbox_only",envelope?.wake??"inbox_only",envelope?"migration":"requested_inbox_only",envelope?.dedupeKey??null,
      ],
    );
    // One `log_version` bump per log mutation: the allocator already counted
    // this append, so only the explicit-seq path (mirror, backfill) bumps here.
    if (input.seq != null && input.kind !== "head") this.touchSessionWithinTransaction(input.sessionId, now);
    const entry = this.getEntryWithinTransaction(input.sessionId, seq)!;
    this.emit(input.sessionId, entry);
    return entry;
  }

  /**
   * Allocate the next seq for a session. `UPDATE … RETURNING` serializes across
   * processes on both backends; the row is created if the session is new.
   */
  nextSeqWithinTransaction(sessionId: string): number {
    this.ensureCounterWithinTransaction(sessionId, nowIso());
    const row = this.ctx.db.query(
      `UPDATE multiremi_conversation_heads
       SET head_seq = head_seq + 1, log_version = log_version + 1, updated_at = ?
       WHERE session_id = ?
       RETURNING head_seq`,
    ).get(nowIso(), sessionId) as { head_seq?: number } | null;
    if (!row) throw new Error(`Conversation head not found: ${sessionId}`);
    return Number(row.head_seq);
  }

  /**
   * Raise the counter to at least `seq` after an explicit placement, so a later
   * allocation cannot collide with a mirrored row. `log_version` is left alone:
   * it counts log mutations, and the append that follows this call is the one
   * that increments it.
   */
  private raiseHeadWithinTransaction(sessionId: string, seq: number): void {
    this.ensureCounterWithinTransaction(sessionId, nowIso(), seq);
  }

  /** The head row: `head_seq`, `log_version` and `updated_at`. */
  getHead(sessionId: string, query?: ConversationLogQuery | null): {
    sessionId: string;
    headSeq: number;
    logVersion: number;
    updatedAt: string;
  } | null {
    const row = this.runQuery(query, CONVERSATION_LOG_HEAD_SQL, [sessionId]).get() as Row | null;
    if (!row) return null;
    return {
      sessionId: String(row.session_id),
      headSeq: Number(row.head_seq ?? 0),
      logVersion: Number(row.log_version ?? 0),
      updatedAt: String(row.updated_at),
    };
  }

  getEntry(sessionId: string, seq: number, query?: ConversationLogQuery | null): ConversationLogEntry | null {
    const row = this.runQuery(query, "SELECT * FROM multiremi_conversation_log WHERE session_id = ? AND seq = ?", [sessionId, seq]).get() as Row | null;
    return row ? this.materialize(row) : null;
  }

  getEntryWithinTransaction(sessionId: string, seq: number): ConversationLogEntry | null {
    const row = this.ctx.db.query(
      "SELECT * FROM multiremi_conversation_log WHERE session_id = ? AND seq = ?",
    ).get(sessionId, seq) as Row | null;
    return row ? this.materialize(row) : null;
  }

  getEntryById(id: string): ConversationLogEntry | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_conversation_log WHERE id = ?").get(id) as Row | null;
    return row ? this.materialize(row) : null;
  }

  /** Locate one row's seq by id, for deep links. */
  locate(sessionId: string, id: string, query?: ConversationLogQuery | null): ConversationLogLocation | null {
    const row = this.runQuery(query, `SELECT id, seq FROM multiremi_conversation_log WHERE session_id = ? AND id = ? AND ${SHOWN_ROW_SQL}`, [sessionId, id]).get() as Row | null;
    if (!row) return null;
    const head = this.getHead(sessionId, query);
    return { id: String(row.id), seq: Number(row.seq ?? 0), head_seq: head?.headSeq ?? 0 };
  }

  /**
   * In-place update of a shown row. Bumps `revision` unconditionally (the caller
   * decides whether the change is worth a revision) and reports the new value to
   * the write hook as a patch.
   */
  updateWithinTransaction(sessionId: string, seq: number, input: UpdateConversationLogInput): ConversationLogEntry | null {
    const current = this.getEntryWithinTransaction(sessionId, seq);
    if (!current) return null;
    const sets: string[] = [];
    const params: unknown[] = [];
    const fields = { ...input.fields };
    if(current.kind==='turn'&&(fields.metadata!==undefined||fields.body_md!==undefined||fields.body_html!==undefined))
      throw new Error('Turn log rows are pointers; update the turn or attempt instead');
    if (fields.body_md !== undefined || fields.body_html !== undefined || fields.render_version !== undefined) {
      const rendered = renderMarkdown(fields.body_md ?? current.body_md);
      fields.body_html = rendered.html;
      fields.render_version = rendered.render_version;
    }
    if (fields.task_id !== undefined) {
      sets.push("task_id = ?");
      params.push(fields.task_id);
    }
    if (fields.body_md !== undefined) {
      sets.push("body_md = ?");
      params.push(fields.body_md);
    }
    if (fields.body_html !== undefined) {
      sets.push("body_html = ?");
      params.push(fields.body_html);
    }
    if (fields.render_version !== undefined) {
      sets.push("render_version = ?");
      params.push(fields.render_version);
    }
    if (fields.metadata !== undefined) {
      // `fields.metadata` is the whole new blob, not a merge.
      sets.push("metadata = ?");
      params.push(toJson(fields.metadata));
    }
    if (fields.deleted_at !== undefined) {
      sets.push("deleted_at = ?");
      params.push(fields.deleted_at);
    }
    if (fields.resolved_at !== undefined) {
      sets.push("resolved_at = ?");
      params.push(fields.resolved_at);
    }
    if (fields.resolved_by_type !== undefined) {
      sets.push("resolved_by_type = ?");
      params.push(fields.resolved_by_type);
    }
    if (fields.resolved_by_id !== undefined) {
      sets.push("resolved_by_id = ?");
      params.push(fields.resolved_by_id);
    }
    const now = input.fields.updated_at ?? nowIso();
    sets.push("updated_at = ?");
    params.push(now);
    const revision = current.revision + 1;
    sets.push("revision = revision + 1");
    if (input.touch !== false) {
      this.ctx.db.run(
        "UPDATE multiremi_conversation_heads SET log_version = log_version + 1, updated_at = ? WHERE session_id = ?",
        [now, sessionId],
      );
    }
    this.ctx.db.run(
      `UPDATE multiremi_conversation_log SET ${sets.join(", ")} WHERE session_id = ? AND seq = ?`,
      [...params, sessionId, seq],
    );
    const entry = this.getEntryWithinTransaction(sessionId, seq);
    if (!entry) return null;
    this.emit(sessionId, toPatch(seq, revision, fields, now));
    return entry;
  }

  update(sessionId: string, seq: number, input: UpdateConversationLogInput): ConversationLogEntry | null {
    return this.ctx.db.transaction(() => this.updateWithinTransaction(sessionId, seq, input))();
  }

  /** Bump `log_version` without touching a row, for head-only freshness. */
  touchSessionWithinTransaction(sessionId: string, at?: string): void {
    this.ctx.db.run(
      "UPDATE multiremi_conversation_heads SET log_version = log_version + 1, updated_at = ? WHERE session_id = ?",
      [at ?? nowIso(), sessionId],
    );
  }

  /**
   * A window of shown rows anchored on a seq, plus the flags a reader needs to
   * page outwards. Hidden markers never appear, and `before_visible_count` is
   * computed with a bounded subquery (`LIMIT 1001`) so it never scans a whole
   * session.
   */
  window(sessionId: string, input: ConversationLogWindowInput = {}): ConversationLogWindow {
    const head = this.getHead(sessionId, input.query);
    const headSeq = head?.headSeq ?? 0;
    const logVersion = head?.logVersion ?? 0;
    const before = clampWindow(input.before);
    const after = clampWindow(input.after);
    const requestedAnchor = input.anchor ?? null;
    const anchor = requestedAnchor == null
      ? headSeq
      : Math.max(0, Math.min(Math.floor(requestedAnchor), headSeq));
    const visible = SHOWN_ROW_SQL;
    const rows: Row[] = [];
    let hasMoreBefore = false;
    let hasMoreAfter = false;
    if (before > 0 || after > 0) {
      const beforeRows = before > 0
        ? this.runQuery(
          input.query,
          `SELECT * FROM multiremi_conversation_log
           WHERE session_id = ? AND seq <= ? AND ${visible}
           ORDER BY seq DESC LIMIT ?`,
          [sessionId, anchor, before + 1],
        ).all() as Row[]
        : [];
      hasMoreBefore = beforeRows.length > before;
      const older = beforeRows.slice(0, before).reverse();
      const afterRows = after > 0
        ? this.runQuery(
          input.query,
          `SELECT * FROM multiremi_conversation_log
           WHERE session_id = ? AND seq > ? AND ${visible}
           ORDER BY seq ASC LIMIT ?`,
          [sessionId, anchor, after + 1],
        ).all() as Row[]
        : [];
      hasMoreAfter = afterRows.length > after;
      rows.push(...older, ...afterRows.slice(0, after));
    } else {
      // No explicit window: return the newest entries ending at the anchor.
      const limit = CONVERSATION_LOG_DEFAULT_WINDOW;
      const newest = this.runQuery(
        input.query,
        `SELECT * FROM multiremi_conversation_log
         WHERE session_id = ? AND seq <= ? AND ${visible}
         ORDER BY seq DESC LIMIT ?`,
        [sessionId, anchor, limit + 1],
      ).all() as Row[];
      hasMoreBefore = newest.length > limit;
      rows.push(...newest.slice(0, limit).reverse());
      hasMoreAfter = anchor < headSeq;
    }
    const entries = rows.map(row=>this.materialize(row));
    if (entries.length) {
      hasMoreBefore = (this.runQuery(
        input.query,
        `SELECT seq FROM multiremi_conversation_log WHERE session_id = ? AND seq < ? AND ${visible} ORDER BY seq DESC LIMIT 1`,
        [sessionId, entries[0]!.seq],
      ).get() as Row | null) != null;
      hasMoreAfter = (this.runQuery(
        input.query,
        `SELECT seq FROM multiremi_conversation_log WHERE session_id = ? AND seq > ? AND ${visible} ORDER BY seq ASC LIMIT 1`,
        [sessionId, entries[entries.length - 1]!.seq],
      ).get() as Row | null) != null;
    }
    const result: ConversationLogWindow = {
      entries,
      head_seq: headSeq,
      log_version: logVersion,
      has_more_before: hasMoreBefore,
      has_more_after: hasMoreAfter,
    };
    if (hasMoreBefore && entries.length) {
      // `seq >= 1` and the plain visibility filter keep this on the
      // `(session_id, visibility, seq)` index; the cap keeps it bounded.
      const countRows = this.runQuery(
        input.query,
        `SELECT seq FROM multiremi_conversation_log
         WHERE session_id = ? AND seq >= 1 AND seq < ? AND ${visible}
         ORDER BY seq ASC LIMIT ?`,
        [sessionId, entries[0]!.seq, CONVERSATION_LOG_BEFORE_VISIBLE_COUNT_CAP + 1],
      ).all() as Row[];
      result.before_visible_count = Math.min(countRows.length, CONVERSATION_LOG_BEFORE_VISIBLE_COUNT_CAP);
      result.before_visible_count_capped = countRows.length > CONVERSATION_LOG_BEFORE_VISIBLE_COUNT_CAP;
    }
    return result;
  }

  /**
   * The `turn` card for a task, if one exists. Every task's card is created with its
   * turn, including Chat and automation, then projected from its current attempt.
   */
  findTurnEntry(taskId: string): ConversationLogEntry | null {
    const row = this.ctx.db.query(
      "SELECT * FROM multiremi_conversation_log WHERE id = (SELECT turn_id FROM multiremi_turn_attempts WHERE id=?) AND kind = 'turn' ORDER BY seq ASC LIMIT 1",
    ).get(taskId) as Row | null;
    return row ? this.materialize(row) : null;
  }

  /**
   * Update a task's `turn` card in place: status and the fields the completion
   * report carries. `revision` bumps on every call, which is what the browser
   * replica keys on. No card means nothing to update (a chat turn whose reply
   * has not landed yet).
   */
  recordAttemptOutcomeWithinTransaction(taskId:string,fields:{
    status?:string|null;finalReplyMd?:string|null;finalEntryId?:string|null;summary?:string|null;
    toolCallCount?:number|null;eventCount?:number|null;typeHistogram?:unknown[]|null;usage?:unknown[]|null;
    model?:unknown|null;elapsedMs?:number|null;failureReason?:string|null;
    inbox?:{delivered_from_seq:number;delivered_to_seq:number;delivered_at:string;task_id:string};
  }):ConversationLogEntry|null {
    const attempt=this.ctx.db.query('SELECT turn_id FROM multiremi_turn_attempts WHERE id=?').get(taskId);
    if(!attempt)return null;
    const mapping:Record<string,string>={summary:'progress_summary',toolCallCount:'tool_call_count',eventCount:'event_count',typeHistogram:'type_histogram',usage:'usage',model:'model',failureReason:'failure_reason'};
    const values:Record<string,unknown>={};
    for(const [key,column] of Object.entries(mapping))if((fields as any)[key]!==undefined)values[column]=['typeHistogram','usage','model'].includes(key)?toJson((fields as any)[key]):(fields as any)[key];
    const keys=Object.keys(values);
    if(keys.length)this.ctx.db.run(`UPDATE multiremi_turn_attempts SET ${keys.map(k=>`${k}=?`).join(',')} WHERE id=?`,[...keys.map(k=>values[k]),taskId]);
    if(fields.finalEntryId!==undefined&&fields.finalEntryId!==null)this.ctx.db.run('UPDATE multiremi_turns SET reply_message_id=? WHERE id=? AND current_attempt_id=?',[fields.finalEntryId,attempt.turn_id,taskId]);
    notifyTurnChanged(this.ctx.db,attempt.turn_id);
    return this.findTurnEntry(taskId);
  }
  recordTurnInboxDeliveryWithinTransaction(taskId:string,fromSeq:number,toSeq:number):ConversationLogEntry|null {
    this.ctx.db.run('UPDATE multiremi_turns SET input_from_seq=?,input_to_seq=? WHERE current_attempt_id=?',[fromSeq,toSeq,taskId]);
    const row=this.ctx.db.query('SELECT turn_id FROM multiremi_turn_attempts WHERE id=?').get(taskId);
    if(row)notifyTurnChanged(this.ctx.db,row.turn_id);
    return this.findTurnEntry(taskId);
  }
  hasInboxReceiptCovering(sessionId:string,agentId:string,seq:number):boolean {
    return Boolean(this.ctx.db.query('SELECT 1 AS present FROM multiremi_turns WHERE session_id=? AND agent_id=? AND input_to_seq>=? LIMIT 1').get(sessionId,agentId,seq));
  }

  /** Shown rows in the inclusive seq range, oldest first. */
  listShown(sessionId: string, input: { sinceSeq?: number | null; toSeq?: number | null; limit?: number } = {}): ConversationLogEntry[] {
    const since = Math.max(0, Math.floor(Number(input.sinceSeq ?? 0)));
    const to = input.toSeq == null ? null : Math.max(0, Math.floor(Number(input.toSeq)));
    const limit = input.limit == null ? null : Math.max(1, Math.floor(input.limit));
    const limitSql = limit == null ? "" : " LIMIT ?";
    const rows = (to == null
      ? this.ctx.db.query(
        `SELECT * FROM multiremi_conversation_log
         WHERE session_id = ? AND seq > ? AND ${SHOWN_ROW_SQL}
         ORDER BY seq ASC${limitSql}`,
      ).all(...(limit == null ? [sessionId, since] : [sessionId, since, limit]))
      : this.ctx.db.query(
        `SELECT * FROM multiremi_conversation_log
         WHERE session_id = ? AND seq > ? AND seq <= ? AND ${SHOWN_ROW_SQL}
         ORDER BY seq ASC${limitSql}`,
      ).all(...(limit == null ? [sessionId, since, to] : [sessionId, since, to, limit]))) as Row[];
    return rows.map(row=>this.materialize(row));
  }

  /** Every row, hidden included, oldest first. Used by projections and backfill. */
  listAll(sessionId: string, input: { sinceSeq?: number | null; toSeq?: number | null } = {}): ConversationLogEntry[] {
    const since = Math.max(0, Math.floor(Number(input.sinceSeq ?? 0)));
    const to = input.toSeq == null ? null : Math.max(0, Math.floor(Number(input.toSeq)));
    const rows = (to == null
      ? this.ctx.db.query(
        "SELECT * FROM multiremi_conversation_log WHERE session_id = ? AND seq > ? ORDER BY seq ASC",
      ).all(sessionId, since)
      : this.ctx.db.query(CONVERSATION_LOG_RANGE_SQL).all(sessionId, since, to)) as Row[];
    return rows.map(row=>this.materialize(row));
  }

  /** The bounded range page shared by SQLite fill and the Postgres read pool. */
  listRangePage(sessionId: string, afterSeq: number, toSeq: number, limit: number): ConversationLogEntry[] {
    const rows = this.ctx.db.query(CONVERSATION_LOG_RANGE_PAGE_SQL)
      .all(sessionId, afterSeq, toSeq, limit) as Row[];
    return rows.map(row=>this.materialize(row));
  }

  listByTask(taskId: string): ConversationLogEntry[] {
    const rows = this.ctx.db.query(
      "SELECT * FROM multiremi_conversation_log WHERE task_id = ? ORDER BY seq ASC",
    ).all(taskId) as Row[];
    return rows.map(row=>this.materialize(row));
  }

  private runQuery(
    query: ConversationLogQuery | null | undefined,
    sql: string,
    params: unknown[],
  ): { get(): unknown; all(): unknown[] } {
    if (query) return query(sql, params);
    return {
      get: () => this.ctx.db.query(sql).get(...params),
      all: () => this.ctx.db.query(sql).all(...params),
    };
  }
}

function clampWindow(value: number | null | undefined): number {
  if (value == null) return 0;
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(parsed, CONVERSATION_LOG_MAX_WINDOW);
}

/** Build the patch a listener sees for an in-place update. */
function toPatch(
  seq: number,
  revision: number,
  fields: ConversationLogPatch["fields"],
  updatedAt: string,
): ConversationLogPatch {
  return {
    target_seq: seq,
    revision,
    fields: { ...fields, updated_at: updatedAt },
  };
}

export function toConversationLogEntry(row: Row): ConversationLogEntry {
  const sessionId = String(row.session_id);
  const kind = String(row.kind) as ConversationLogKind;
  const visibility = String(row.visibility ?? CONVERSATION_LOG_KIND_VISIBILITY[kind] ?? "shown") as ConversationLogVisibility;
  return {
    ...Object.fromEntries(['sender_type','sender_id','to_type','to_ref','to_agent_id','to_member_id','message_kind','wake_requested','wake_applied','wake_reason','dedupe_key','options','card_token_hash','card_token_recipient','card_token_consumed_at','reply_to_id'].map(k=>[k,row[k]??null])),
    session_id: sessionId,
    seq: Number(row.seq ?? 0),
    id: String(row.id),
    kind,
    visibility,
    author_type: String(row.sender_type === "platform" ? "system" : row.sender_type),
    author_id: nullableString(row.sender_id),
    task_id: nullableString(row.task_id),
    body_md: String(row.body_md ?? ""),
    body_html: nullableString(row.body_html),
    render_version: nullableString(row.render_version),
    parent_id: nullableString(row.reply_to_id),
    resolved_at: nullableString(row.resolved_at),
    resolved_by_type: nullableString(row.resolved_by_type),
    resolved_by_id: nullableString(row.resolved_by_id),
    metadata: messageMetadata(row),
    revision: Number(row.revision ?? 1),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at ?? row.created_at),
    deleted_at: nullableString(row.deleted_at),
  };
}

/** Existing execution consumers receive a projection built solely from columns. */
function messageMetadata(row:Row):ConversationLogEntryMetadata {
  const metadata:any=parseJson(row.metadata,{});
  if(row.kind==='message' && row.to_type!==null && row.to_type!=='none'){
    const role=row.to_type==='agent'?'agent':row.to_ref;
    metadata.envelope={to:{...metadata.address_context,role,...(role==='agent'?{agentId:row.to_agent_id,issueSessionId:row.session_id}:{})},
      kind:row.message_kind==='status'?'lifecycle':row.message_kind==='decision'?'decision_needed':row.message_kind,
      wake:row.wake_applied,dedupeKey:row.dedupe_key??undefined,replyTo:row.reply_to_id??undefined,
      source:metadata.message_source??{},priority:metadata.priority??4,recipient_agent_id:row.to_agent_id??undefined,outcome:metadata.message_outcome};
  }
  return metadata;
}
