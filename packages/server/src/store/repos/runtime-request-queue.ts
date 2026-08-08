// The queue protocol shared by every daemon async-request family (model list, directory scan,
// runtime update, local-skill list, local-skill import).
//
// All five families run the same lifecycle — a row is inserted `pending`, claimed into `running`,
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
 * to the five hand-written copies this template replaced — do not widen these fields to accept
 * caller-supplied strings.
 */
export interface RuntimeRequestSpec<T> {
  /** Backing table, e.g. `multiremi_runtime_model_list_requests`. */
  table: string;
  /** `createId()` prefix for new rows, e.g. `rml`. */
  idPrefix: string;
  /** How long a row may sit `pending` before the daemon is presumed unreachable. */
  pendingTimeoutMs: number;
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

  /** Move the oldest pending request to `running` and return it, or null when the queue is empty. */
  claim(runtimeId: string): T | null {
    this.expire(runtimeId);
    const row = this.db.query(
      `SELECT * FROM ${this.spec.table}
       WHERE runtime_id = ? AND status = 'pending'
       ORDER BY created_at ASC
       LIMIT 1`,
    ).get(runtimeId) as Row | null;
    if (!row) return null;
    const now = nowIso();
    this.db.run(
      `UPDATE ${this.spec.table} SET status = 'running', run_started_at = ?, updated_at = ? WHERE id = ?`,
      [now, now, String(row.id)],
    );
    return this.get(runtimeId, String(row.id));
  }

  /**
   * Batch variant of {@link claim}: moves up to `limit` pending requests to `running` and returns
   * their ids. Callers re-read the rows themselves so families with extra hydration keep it.
   */
  claimBatchIds(runtimeId: string, limit: number): string[] {
    this.expire(runtimeId);
    const rows = this.db.query(
      `SELECT * FROM ${this.spec.table}
       WHERE runtime_id = ? AND status = 'pending'
       ORDER BY created_at ASC
       LIMIT ?`,
    ).all(runtimeId, Math.max(1, Math.floor(limit))) as Row[];
    if (!rows.length) return [];
    const now = nowIso();
    for (const row of rows) {
      this.db.run(
        `UPDATE ${this.spec.table} SET status = 'running', run_started_at = ?, updated_at = ? WHERE id = ?`,
        [now, now, String(row.id)],
      );
    }
    return rows.map((row) => String(row.id));
  }

  /** Time out rows that blew either deadline. Runs before every read so reads never see zombies. */
  expire(runtimeId: string): void {
    const now = nowIso();
    const pendingCutoff = new Date(Date.now() - this.spec.pendingTimeoutMs).toISOString();
    const runningCutoff = new Date(Date.now() - this.spec.runningTimeoutMs).toISOString();
    this.db.run(
      `UPDATE ${this.spec.table}
       SET status = 'timeout', error = '${this.spec.pendingTimeoutError}', updated_at = ?
       WHERE runtime_id = ? AND status = 'pending' AND created_at < ?`,
      [now, runtimeId, pendingCutoff],
    );
    this.db.run(
      `UPDATE ${this.spec.table}
       SET status = 'timeout', error = '${this.spec.runningTimeoutError}', updated_at = ?
       WHERE runtime_id = ? AND status = 'running' AND run_started_at IS NOT NULL AND run_started_at < ?`,
      [now, runtimeId, runningCutoff],
    );
  }
}
