import type {
  SessionArchiveRequest,
  SessionArchiveRequestStatus,
  SessionArchiveSubjectKind,
} from "@multiremi/contracts/trace-file.js";
import { createId, nowIso } from "@multiremi/ids.js";
import type { StoreContext } from "@multiremi/store/context.js";

type Row = Record<string, unknown>;

/**
 * How long a request may stay `acked` before it is failed. The daemon acks the
 * frame before it starts archiving and reports once it is done; a daemon that
 * restarts or loses its connection in between never reports, and a failed row
 * lets the next retirement plan ask again. Matches the running deadline of the
 * other runtime request families.
 */
export const SESSION_ARCHIVE_REQUEST_ACK_LEASE_MS = 30 * 60 * 1000;

const OPEN_STATUSES = ["pending", "sent", "acked"] as const;

export interface SessionArchiveRequestSubject {
  kind: SessionArchiveSubjectKind;
  id: string;
}

/**
 * What a daemon result did to its request:
 * - `applied`: an open request moved to the reported terminal status;
 * - `already_terminal`: the request was already completed or failed, and the
 *   result is absorbed as a replay;
 * - `not_found`: no request with this id belongs to the runtime.
 */
export type SessionArchiveRequestReportOutcome = "applied" | "already_terminal" | "not_found";

function hydrate(row: Row): SessionArchiveRequest {
  return {
    id: String(row.id),
    runtime_id: String(row.runtime_id),
    subject_kind: String(row.subject_kind) as SessionArchiveSubjectKind,
    subject_id: String(row.subject_id),
    status: String(row.status) as SessionArchiveRequestStatus,
    created_by: String(row.created_by),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(",");
}

/**
 * Requests asking a daemon to archive one session subject (ADR 0006 Decision 8).
 *
 * `status` only moves forward: `pending` (written) → `sent` (offered to a
 * connected daemon session) → `acked` (the daemon acknowledged the frame) →
 * `completed` | `failed` (the daemon's result, a too-large frame, or an expired
 * ack lease). A terminal request is never reopened; asking again writes a new
 * row.
 */
export class SessionArchiveRequestsRepo {
  constructor(private readonly ctx: StoreContext) {}

  get(runtimeId: string, id: string): SessionArchiveRequest | null {
    const row = this.ctx.db.query(
      "SELECT * FROM multiremi_session_archive_requests WHERE id = ? AND runtime_id = ?",
    ).get(id, runtimeId) as Row | null;
    return row ? hydrate(row) : null;
  }

  /**
   * Return the subject's open request on the runtime, writing a `pending` one
   * when there is none. The caller owns the transaction and holds the
   * workspace Runtime lifecycle lock, which serializes two callers asking for
   * the same subject.
   */
  ensureOpenWithinTransaction(
    runtimeId: string,
    subject: SessionArchiveRequestSubject,
    createdBy: string,
  ): { request: SessionArchiveRequest; created: boolean } {
    const open = this.ctx.db.query(
      `SELECT * FROM multiremi_session_archive_requests
       WHERE runtime_id = ? AND subject_kind = ? AND subject_id = ?
         AND status IN (${placeholders(OPEN_STATUSES)})
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).get(runtimeId, subject.kind, subject.id, ...OPEN_STATUSES) as Row | null;
    if (open) return { request: hydrate(open), created: false };
    const now = nowIso();
    const row = this.ctx.db.query(
      `INSERT INTO multiremi_session_archive_requests
         (id, runtime_id, subject_kind, subject_id, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
       RETURNING *`,
    ).get(createId("sar"), runtimeId, subject.kind, subject.id, createdBy, now, now) as Row;
    return { request: hydrate(row), created: true };
  }

  /**
   * The requests to offer a connected daemon, oldest first. A `sent` request
   * is offered again: a daemon that disconnected before acknowledging it gets
   * it on the next session, and the row waits at `sent` meanwhile. `pending`
   * rows move to `sent` here, since offering is the only send this layer sees.
   */
  dispatch(runtimeId: string): SessionArchiveRequest[] {
    const rows = this.ctx.db.query(
      `SELECT * FROM multiremi_session_archive_requests
       WHERE runtime_id = ? AND status IN ('pending', 'sent')
       ORDER BY created_at ASC, id ASC`,
    ).all(runtimeId) as Row[];
    const pending = rows.filter((row) => row.status === "pending").map((row) => String(row.id));
    if (!pending.length) return rows.map(hydrate);
    const now = nowIso();
    this.ctx.db.run(
      `UPDATE multiremi_session_archive_requests SET status = 'sent', updated_at = ?
       WHERE runtime_id = ? AND status = 'pending' AND id IN (${placeholders(pending)})`,
      [now, runtimeId, ...pending],
    );
    return rows.map((row) => hydrate(row.status === "pending" ? { ...row, status: "sent", updated_at: now } : row));
  }

  /** The daemon acknowledged the frame. Returns whether the row moved. */
  acknowledge(runtimeId: string, id: string): boolean {
    return this.ctx.db.query(
      `UPDATE multiremi_session_archive_requests SET status = 'acked', updated_at = ?
       WHERE id = ? AND runtime_id = ? AND status IN ('pending', 'sent')
       RETURNING id`,
    ).get(nowIso(), id, runtimeId) != null;
  }

  /** Close an open request without a daemon result, e.g. a frame too large to send. */
  fail(runtimeId: string, id: string): boolean {
    return this.ctx.db.query(
      `UPDATE multiremi_session_archive_requests SET status = 'failed', updated_at = ?
       WHERE id = ? AND runtime_id = ? AND status IN (${placeholders(OPEN_STATUSES)})
       RETURNING id`,
    ).get(nowIso(), id, runtimeId, ...OPEN_STATUSES) != null;
  }

  /** Apply a daemon result. A result for a terminal request is absorbed. */
  report(runtimeId: string, id: string, status: "completed" | "failed"): SessionArchiveRequestReportOutcome {
    const applied = this.ctx.db.query(
      `UPDATE multiremi_session_archive_requests SET status = ?, updated_at = ?
       WHERE id = ? AND runtime_id = ? AND status IN (${placeholders(OPEN_STATUSES)})
       RETURNING id`,
    ).get(status, nowIso(), id, runtimeId, ...OPEN_STATUSES);
    if (applied) return "applied";
    return this.get(runtimeId, id) ? "already_terminal" : "not_found";
  }

  /** Fail `acked` requests whose daemon has not reported within the lease. */
  expireAcked(runtimeIds: readonly string[], now = Date.now()): number {
    if (!runtimeIds.length) return 0;
    const cutoff = new Date(now - SESSION_ARCHIVE_REQUEST_ACK_LEASE_MS).toISOString();
    const rows = this.ctx.db.query(
      `UPDATE multiremi_session_archive_requests SET status = 'failed', updated_at = ?
       WHERE runtime_id IN (${placeholders(runtimeIds)}) AND status = 'acked' AND updated_at < ?
       RETURNING id`,
    ).all(new Date(now).toISOString(), ...runtimeIds, cutoff) as Row[];
    return rows.length;
  }

  /** The newest request of every subject on the runtimes. */
  listLatestForRuntimes(runtimeIds: readonly string[]): SessionArchiveRequest[] {
    if (!runtimeIds.length) return [];
    const rows = this.ctx.db.query(
      `SELECT r.* FROM multiremi_session_archive_requests r
       WHERE r.runtime_id IN (${placeholders(runtimeIds)})
         AND NOT EXISTS (
           SELECT 1 FROM multiremi_session_archive_requests n
           WHERE n.runtime_id = r.runtime_id AND n.subject_kind = r.subject_kind
             AND n.subject_id = r.subject_id
             AND (n.created_at > r.created_at OR (n.created_at = r.created_at AND n.id > r.id))
         )
       ORDER BY r.runtime_id ASC, r.subject_kind ASC, r.subject_id ASC`,
    ).all(...runtimeIds) as Row[];
    return rows.map(hydrate);
  }
}
