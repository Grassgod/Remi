/**
 * {@link ReplicaStorage} over SQLite.
 *
 * The Worker passes it a `sqlite-wasm` `opfs-sahpool` database; the tests pass a
 * `node:sqlite` one. Both run the same statements from `schema.ts`, which is the
 * point: the SQL that production executes is exercised by a fast unit test
 * instead of only by a browser.
 */

import type { SessionLogEntry } from "./port";
import { normalizeRanges } from "./ranges";
import { SQL } from "./schema";
import type { ReplicaState } from "./protocol";
import type { ReplicaStorage } from "./storage";
import type { SqlDatabase } from "./sql";
import { REPLICA_SCHEMA_SQL as REPLICA_SCHEMA_DDL } from "./schema";

interface EntryRow {
  session_id: string;
  seq: number;
  id: string;
  revision: number;
  kind: string;
  body_md: string;
  body_html: string | null;
  render_version: string | null;
}

function toEntry(row: EntryRow): SessionLogEntry {
  return {
    session_id: row.session_id,
    seq: row.seq,
    id: row.id,
    revision: row.revision,
    kind: row.kind,
    body_md: row.body_md ?? "",
    body_html: row.body_html ?? null,
    render_version: row.render_version ?? null,
  };
}

export class SqlReplicaStorage implements ReplicaStorage {
  /** Prepared once per statement; a reconnect backfill runs in one tight loop. */
  private readonly statements = new Map<string, ReturnType<SqlDatabase["prepare"]>>();

  constructor(private readonly db: SqlDatabase) {
    db.exec(REPLICA_SCHEMA_DDL);
  }

  private statement(sql: string) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  readMeta(key: string): string | null {
    const row = this.statement(SQL.selectMeta).get<{ v: string }>([key]);
    return row ? row.v : null;
  }

  writeMeta(key: string, value: string): void {
    this.statement(SQL.upsertMeta).run([key, value]);
  }

  readState(sessionId: string): ReplicaState {
    const head = this.statement(SQL.selectHead).get<{ head_seq: number | null; log_version: number | null }>([sessionId]);
    const ranges = this.statement(SQL.selectRanges).all<{ from_seq: number; to_seq: number }>([sessionId]);
    return {
      ranges: normalizeRanges(ranges.map((row) => ({ from: row.from_seq, to: row.to_seq }))),
      // `undefined` and `null` both mean "no head": the column is nullable and a
      // driver may hand back either.
      head: head?.head_seq ?? null,
      logVersion: head ? (head.log_version ?? null) : null,
      synced: head !== null,
    };
  }

  writeState(sessionId: string, state: ReplicaState, now: string): void {
    // The ranges table is the authority for coverage, so it is replaced rather
    // than patched: `applyFrames` already merged what it holds, and reconciling
    // two range lists in SQL would be a second implementation of that merge.
    this.statement(SQL.deleteRanges).run([sessionId]);
    for (const range of state.ranges) {
      this.statement(SQL.insertRange).run([sessionId, range.from, range.to]);
    }
    this.statement(SQL.upsertHead).run([sessionId, state.head, state.logVersion, now]);
  }

  upsertEntries(entries: readonly SessionLogEntry[]): void {
    const statement = this.statement(SQL.insertEntry);
    for (const entry of entries) {
      statement.run([
        entry.session_id,
        entry.seq,
        entry.id,
        entry.revision,
        entry.kind,
        entry.body_md,
        entry.body_html,
        entry.render_version,
      ]);
    }
  }

  deleteEntries(sessionId: string, seqs: readonly number[]): void {
    const statement = this.statement(SQL.deleteEntry);
    for (const seq of seqs) statement.run([sessionId, seq]);
  }

  readEntries(sessionId: string): Map<number, SessionLogEntry> {
    const rows = this.statement(SQL.selectWindow).all<EntryRow>([sessionId, 0, MAX_SEQ]);
    return new Map(rows.map((row) => [row.seq, toEntry(row)]));
  }

  readWindow(sessionId: string, from: number, to: number): SessionLogEntry[] {
    return this.statement(SQL.selectWindow)
      .all<EntryRow>([sessionId, from, to])
      .map(toEntry);
  }

  clearSession(sessionId: string): void {
    this.statement(SQL.deleteSessionEntries).run([sessionId]);
    this.statement(SQL.deleteRanges).run([sessionId]);
    this.statement(SQL.deleteSessionHead).run([sessionId]);
    this.clearSessionHeights(sessionId);
  }

  clearSessionHeights(sessionId: string): void {
    this.statement(SQL.deleteSessionHeights).run([sessionId]);
  }

  /**
   * Empty every table including the previous identity. The engine writes the
   * schema version, and the next open binds the current user and workspace.
   */
  clearDatabase(): void {
    this.statement(SQL.deleteAllMeta).run([]);
    this.statement(SQL.deleteAllEntries).run([]);
    this.statement(SQL.deleteAllRanges).run([]);
    this.statement(SQL.deleteAllHeads).run([]);
    this.statement(SQL.deleteAllHeights).run([]);
  }

  readRowHeight(sessionId: string, seq: number, key: string): number | null {
    const row = this.statement(SQL.selectRowHeight).get<{ height: number }>([sessionId, seq, key]);
    return row ? row.height : null;
  }

  writeRowHeight(sessionId: string, seq: number, key: string, height: number): void {
    this.statement(SQL.upsertRowHeight).run([sessionId, seq, key, height]);
  }

  /** Row count for one session; the storage-level assertion the tests read. */
  countEntries(sessionId: string): number {
    const row = this.statement(SQL.countEntries).get<{ n: number }>([sessionId]) as { n: number } | null;
    return row ? Number(row.n) : 0;
  }

  close(): void {
    for (const statement of this.statements.values()) statement.finalize();
    this.statements.clear();
    this.db.close();
  }
}

/**
 * `sqlite3` stores integers as 64-bit, so this is the largest seq the schema can
 * hold and a safe upper bound for "the whole session".
 */
const MAX_SEQ = Number.MAX_SAFE_INTEGER;
