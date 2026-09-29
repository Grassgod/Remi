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

/** Cap on one page of the window read; the route rejects anything larger. */
export const CONVERSATION_LOG_MAX_WINDOW = 100;

/** Default window when the caller passes neither `before` nor `after`. */
export const CONVERSATION_LOG_DEFAULT_WINDOW = 30;

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
  constructor(private ctx: StoreContext) {}

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

  private legacyHeadSeq(sessionId: string): number {
    const issue = this.ctx.db.query(
      "SELECT MAX(seq) AS seq FROM multiremi_session_events WHERE session_id = ?",
    ).get(sessionId) as { seq: number | string | null } | null;
    const chat = this.ctx.db.query(
      "SELECT message_sequence AS seq FROM multiremi_chat_sessions WHERE id = ?",
    ).get(sessionId) as { seq: number | string | null } | null;
    return Math.max(0, Number(issue?.seq ?? 0), Number(chat?.seq ?? 0));
  }

  private ensureCounterWithinTransaction(sessionId: string, at: string, seq = 0): void {
    // Acquire the writer lock before reading legacy rows. SQLite's deferred
    // transaction otherwise cannot upgrade a concurrent read to a write.
    this.ctx.db.run(
      `INSERT INTO multiremi_conversation_heads (session_id, head_seq, log_version, updated_at)
       VALUES (?, 0, 0, ?)
       ON CONFLICT(session_id) DO NOTHING`,
      [sessionId, at],
    );
    const initialSeq = Math.max(seq, this.legacyHeadSeq(sessionId));
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
    return this.ctx.db.transaction(() => this.appendWithinTransaction(input))();
  }

  /** Allocate seq and insert. The caller already owns the transaction. */
  appendWithinTransaction(input: AppendConversationLogInput): ConversationLogEntry {
    const visibility = CONVERSATION_LOG_KIND_VISIBILITY[input.kind];
    if (!visibility) throw new Error(`Unknown conversation log kind: ${input.kind}`);
    // `head` is the row at seq 0, not an event: it takes no allocation, so the
    // first real append still gets seq 1 and `cursor_seq = 0` keeps meaning
    // "nothing read" for every lane.
    const seq = input.seq != null
      ? Math.max(0, Math.floor(input.seq))
      : input.kind === "head" ? 0 : this.nextSeqWithinTransaction(input.sessionId);
    if (input.seq != null) this.raiseHeadWithinTransaction(input.sessionId, seq);
    const id = input.id ?? createId("clog");
    const now = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? now;
    const rendered = renderMarkdown(input.bodyMd ?? "");
    this.ctx.db.run(
      `INSERT INTO multiremi_conversation_log (
         session_id, seq, id, kind, visibility, author_type, author_id, task_id,
         body_md, body_html, render_version, parent_id,
         resolved_at, resolved_by_type, resolved_by_id,
         metadata, revision, created_at, updated_at, deleted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.sessionId,
        seq,
        id,
        input.kind,
        visibility,
        input.authorType,
        input.authorId ?? null,
        input.taskId ?? null,
        input.bodyMd ?? "",
        rendered.html,
        rendered.render_version,
        input.parentId ?? null,
        input.resolvedAt ?? null,
        input.resolvedByType ?? null,
        input.resolvedById ?? null,
        toJson(input.metadata ?? {}),
        input.revision ?? 1,
        now,
        updatedAt,
        input.deletedAt ?? null,
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
    const row = this.runQuery(query, "SELECT * FROM multiremi_conversation_heads WHERE session_id = ?", [sessionId]).get() as Row | null;
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
    return row ? toConversationLogEntry(row) : null;
  }

  getEntryWithinTransaction(sessionId: string, seq: number): ConversationLogEntry | null {
    const row = this.ctx.db.query(
      "SELECT * FROM multiremi_conversation_log WHERE session_id = ? AND seq = ?",
    ).get(sessionId, seq) as Row | null;
    return row ? toConversationLogEntry(row) : null;
  }

  getEntryById(id: string): ConversationLogEntry | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_conversation_log WHERE id = ?").get(id) as Row | null;
    return row ? toConversationLogEntry(row) : null;
  }

  /** Locate one row's seq by id, for deep links. */
  locate(sessionId: string, id: string, query?: ConversationLogQuery | null): ConversationLogLocation | null {
    const row = this.runQuery(query, "SELECT id, seq FROM multiremi_conversation_log WHERE session_id = ? AND id = ? AND visibility = 'shown' AND deleted_at IS NULL", [sessionId, id]).get() as Row | null;
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
    if (fields.body_md !== undefined || fields.body_html !== undefined || fields.render_version !== undefined) {
      const rendered = renderMarkdown(fields.body_md ?? current.body_md);
      fields.body_html = rendered.html;
      fields.render_version = rendered.render_version;
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
    const visible = "visibility = 'shown' AND deleted_at IS NULL";
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
    const entries = rows.map(toConversationLogEntry);
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
   * The `turn` card for a task, if one exists. A task's card is created when the
   * task is created (Issue) or when its reply lands (chat), and is then updated
   * in place through its lifecycle, so the lookup is by `task_id`.
   */
  findTurnEntry(taskId: string): ConversationLogEntry | null {
    const row = this.ctx.db.query(
      "SELECT * FROM multiremi_conversation_log WHERE task_id = ? AND kind = 'turn' ORDER BY seq ASC LIMIT 1",
    ).get(taskId) as Row | null;
    return row ? toConversationLogEntry(row) : null;
  }

  /**
   * Update a task's `turn` card in place: status and the fields the completion
   * report carries. `revision` bumps on every call, which is what the browser
   * replica keys on. No card means nothing to update (a chat turn whose reply
   * has not landed yet).
   */
  updateTurnCardWithinTransaction(
    taskId: string,
    fields: {
      status?: string | null;
      finalReplyMd?: string | null;
      finalEntryId?: string | null;
      summary?: string | null;
      toolCallCount?: number | null;
      eventCount?: number | null;
      typeHistogram?: unknown[] | null;
      usage?: unknown[] | null;
      model?: unknown | null;
      elapsedMs?: number | null;
      failureReason?: string | null;
    },
  ): ConversationLogEntry | null {
    const current = this.findTurnEntry(taskId);
    if (!current) return null;
    const metadata: Record<string, unknown> = { ...current.metadata };
    if (fields.status !== undefined) metadata.status = fields.status;
    if (fields.finalReplyMd !== undefined) metadata.final_reply_md = fields.finalReplyMd;
    if (fields.finalEntryId !== undefined) metadata.final_entry_id = fields.finalEntryId;
    if (fields.summary !== undefined) metadata.summary = fields.summary;
    if (fields.toolCallCount !== undefined) metadata.tool_call_count = fields.toolCallCount;
    if (fields.eventCount !== undefined) metadata.event_count = fields.eventCount;
    if (fields.typeHistogram !== undefined) metadata.type_histogram = fields.typeHistogram;
    if (fields.usage !== undefined) metadata.usage = fields.usage;
    if (fields.model !== undefined) metadata.model = fields.model;
    if (fields.elapsedMs !== undefined) metadata.elapsed_ms = fields.elapsedMs;
    if (fields.failureReason !== undefined) metadata.failure_reason = fields.failureReason;
    return this.updateWithinTransaction(current.session_id, current.seq, { fields: { metadata } });
  }

  /** Shown rows in the inclusive seq range, oldest first. */
  listShown(sessionId: string, input: { sinceSeq?: number | null; toSeq?: number | null } = {}): ConversationLogEntry[] {
    const since = Math.max(0, Math.floor(Number(input.sinceSeq ?? 0)));
    const to = input.toSeq == null ? null : Math.max(0, Math.floor(Number(input.toSeq)));
    const rows = (to == null
      ? this.ctx.db.query(
        `SELECT * FROM multiremi_conversation_log
         WHERE session_id = ? AND seq > ? AND visibility = 'shown' AND deleted_at IS NULL
         ORDER BY seq ASC`,
      ).all(sessionId, since)
      : this.ctx.db.query(
        `SELECT * FROM multiremi_conversation_log
         WHERE session_id = ? AND seq > ? AND seq <= ? AND visibility = 'shown' AND deleted_at IS NULL
         ORDER BY seq ASC`,
      ).all(sessionId, since, to)) as Row[];
    return rows.map(toConversationLogEntry);
  }

  /** Every row, hidden included, oldest first. Used by projections and backfill. */
  listAll(sessionId: string, input: { sinceSeq?: number | null; toSeq?: number | null } = {}): ConversationLogEntry[] {
    const since = Math.max(0, Math.floor(Number(input.sinceSeq ?? 0)));
    const to = input.toSeq == null ? null : Math.max(0, Math.floor(Number(input.toSeq)));
    const rows = (to == null
      ? this.ctx.db.query(
        "SELECT * FROM multiremi_conversation_log WHERE session_id = ? AND seq > ? ORDER BY seq ASC",
      ).all(sessionId, since)
      : this.ctx.db.query(
        "SELECT * FROM multiremi_conversation_log WHERE session_id = ? AND seq > ? AND seq <= ? ORDER BY seq ASC",
      ).all(sessionId, since, to)) as Row[];
    return rows.map(toConversationLogEntry);
  }

  listByTask(taskId: string): ConversationLogEntry[] {
    const rows = this.ctx.db.query(
      "SELECT * FROM multiremi_conversation_log WHERE task_id = ? ORDER BY seq ASC",
    ).all(taskId) as Row[];
    return rows.map(toConversationLogEntry);
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
    session_id: sessionId,
    seq: Number(row.seq ?? 0),
    id: String(row.id),
    kind,
    visibility,
    author_type: String(row.author_type ?? "system"),
    author_id: nullableString(row.author_id),
    task_id: nullableString(row.task_id),
    body_md: String(row.body_md ?? ""),
    body_html: nullableString(row.body_html),
    render_version: nullableString(row.render_version),
    parent_id: nullableString(row.parent_id),
    resolved_at: nullableString(row.resolved_at),
    resolved_by_type: nullableString(row.resolved_by_type),
    resolved_by_id: nullableString(row.resolved_by_id),
    metadata: parseJson<ConversationLogEntryMetadata>(row.metadata, {}),
    revision: Number(row.revision ?? 1),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at ?? row.created_at),
    deleted_at: nullableString(row.deleted_at),
  };
}
