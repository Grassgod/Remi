// The queue protocol shared by every daemon async-request family (model list, directory scan,
// runtime update, local-skill list, local-skill import, runtime command).
//
// All six families run the same lifecycle — a row is inserted `pending`, claimed into `running`,
// timed out on either deadline, then closed by a report — and previously existed as five verbatim
// copies of `get`/`claim`/`expire` in runtimes-repo.ts. The copies differed only in table name,
// id prefix, the two deadlines and the human-readable timeout copy, so those five knobs are now a
// `RuntimeRequestSpec` and the bodies live here once. `create` and `report` stay with their family
// because their column lists and completed-branch payloads genuinely differ.
import { createId, nowIso } from "@multiremi/ids.js";
import { type SqlDatabase } from "@multiremi/store/db/postgres.js";

type Row = Record<string, unknown>;

/**
 * Describes one async-request family.
 *
 * Every instance is a module-level constant declared beside the family it configures; no field is
 * ever derived from request input. `table` and the two timeout messages are interpolated into SQL
 * text rather than bound as parameters, which is what keeps the generated statements byte-identical
 * to the original hand-written copies this template replaced — do not widen these fields to accept
 * caller-supplied strings.
 */
export interface RuntimeRequestSpec<T> {
  /** Backing table, e.g. `multiremi_runtime_model_list_requests`. */
  table: string;
  /** `createId()` prefix for new rows, e.g. `rml`. */
  idPrefix: string;
  /** How long a row may sit `pending` before the daemon is presumed unreachable. */
  pendingTimeoutMs: number;
  /** Column used as the pending deadline anchor. Defaults to the immutable creation time. */
  pendingDeadlineColumn?: "created_at" | "updated_at";
  /** How long a row may stay `running` before the daemon is presumed stuck. */
  runningTimeoutMs: number;
  /** `error` written when `pendingTimeoutMs` elapses. */
  pendingTimeoutError: string;
  /** `error` written when `runningTimeoutMs` elapses. */
  runningTimeoutError: string;
  /** Row → domain object mapper. */
  hydrate: (row: Row) => T;
}

/** One instantiation of the shared request lifecycle, bound to a table and its deadlines. */
export class RuntimeRequestQueue<T> {
  constructor(private db: SqlDatabase, readonly spec: RuntimeRequestSpec<T>) {}

  /** Mint an id for a new row of this family. */
  nextId(): string {
    return createId(this.spec.idPrefix);
  }

  /** Read one request by id, scoped to its runtime. Expires stale rows first. */
  get(runtimeId: string, requestId: string): T | null {
    this.expire(runtimeId);
    const row = this.db.query(
      `SELECT * FROM ${this.spec.table} WHERE id = ? AND runtime_id = ?`,
    ).get(requestId, runtimeId) as Row | null;
    return row ? this.spec.hydrate(row) : null;
  }

  /**
   * Move the oldest pending request to `running` and return it, or null when the queue is empty.
   *
   * Selection and the state change are one statement: the sub-select picks the row and
   * `RETURNING *` hands back exactly what was written, so there is no window in which a second
   * reader could see the row between the SELECT and the UPDATE, and no second read of it.
   *
   * `sweep` is for callers that have already proved the deadline sweep would write nothing
   * (the heartbeat's merged probe does this); it skips the extra UPDATE, never a claim.
   */
  claim(runtimeId: string, sweep = true): T | null {
    if (sweep) this.expire(runtimeId);
    const now = nowIso();
    const row = this.db.query(
      `UPDATE ${this.spec.table}
       SET status = 'running', run_started_at = ?, updated_at = ?
       WHERE id = (
         SELECT id FROM ${this.spec.table}
         WHERE runtime_id = ? AND status = 'pending'
         ORDER BY created_at ASC
         LIMIT 1
       )
       RETURNING *`,
    ).get(now, now, runtimeId) as Row | null;
    return row ? this.spec.hydrate(row) : null;
  }

  /**
   * Batch variant of {@link claim}: moves up to `limit` pending requests to `running` and returns
   * the written rows, oldest first. One statement for the whole batch — the previous per-row
   * UPDATE loop made a ten-item import cost ten writes plus ten re-reads.
   *
   * `UPDATE ... RETURNING` does not promise the order of the returned rows, so the ordering the
   * single-row path gets from `ORDER BY created_at ASC` is restored here explicitly.
   */
  claimBatch(runtimeId: string, limit: number, sweep = true): T[] {
    if (sweep) this.expire(runtimeId);
    const now = nowIso();
    const rows = this.db.query(
      `UPDATE ${this.spec.table}
       SET status = 'running', run_started_at = ?, updated_at = ?
       WHERE id IN (
         SELECT id FROM ${this.spec.table}
         WHERE runtime_id = ? AND status = 'pending'
         ORDER BY created_at ASC
         LIMIT ?
       )
       RETURNING *`,
    ).all(now, now, runtimeId, Math.max(1, Math.floor(limit))) as Row[];
    return rows
      .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at))
        || String(left.id).localeCompare(String(right.id)))
      .map((row) => this.spec.hydrate(row));
  }

  /**
   * Time out rows that blew either deadline, in one statement.
   *
   * `CASE` reads the pre-update `status`, so each row still gets its own family text; a single
   * statement replaces the two per-deadline UPDATEs, which halves the sweep on every read. Running
   * before every read means reads never see zombies.
   */
  expire(runtimeId: string): void {
    const now = nowIso();
    const pendingCutoff = new Date(Date.now() - this.spec.pendingTimeoutMs).toISOString();
    const runningCutoff = new Date(Date.now() - this.spec.runningTimeoutMs).toISOString();
    const pendingDeadlineColumn = this.spec.pendingDeadlineColumn ?? "created_at";
    this.db.run(
      `UPDATE ${this.spec.table}
       SET status = 'timeout',
           error = CASE WHEN status = 'running' THEN ? ELSE ? END,
           updated_at = ?
       WHERE runtime_id = ?
         AND (
           (status = 'pending' AND ${pendingDeadlineColumn} < ?)
           OR (status = 'running' AND run_started_at IS NOT NULL AND run_started_at < ?)
         )`,
      [this.spec.runningTimeoutError, this.spec.pendingTimeoutError, now, runtimeId, pendingCutoff, runningCutoff],
    );
  }
}
