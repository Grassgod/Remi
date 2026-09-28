/**
 * The storage seam under the replica engine.
 *
 * Two implementations, one contract:
 *
 * - {@link ReplicaSqlStore} (`sql.ts`) writes SQLite — the Worker's
 *   `opfs-sahpool` database, or `node:sqlite` in the unit tests;
 * - {@link MemoryReplicaStorage} below holds the same rows in maps, which is the
 *   whole degrade path from plan 3/6 §1: no OPFS means no hot start, so the
 *   protocol runs unchanged over memory.
 *
 * The engine never sees a driver, and neither implementation sees a policy: when
 * to clear, when to backfill and what "fresh" means all live in `engine.ts` and
 * `protocol.ts`.
 */

import type { SessionLogEntry } from "./port";
import type { ReplicaState } from "./protocol";

export interface ReplicaStorage {
  /** Synchronous write batch; SQLite commits rows and watermarks atomically. */
  transaction<T>(write: () => T): T;
  readMeta(key: string): string | null;
  writeMeta(key: string, value: string): void;
  readState(sessionId: string): ReplicaState;
  writeState(sessionId: string, state: ReplicaState, now: string): void;
  upsertEntries(entries: readonly SessionLogEntry[]): void;
  deleteEntries(sessionId: string, seqs: readonly number[]): void;
  readEntries(sessionId: string): Map<number, SessionLogEntry>;
  /** Highest accepted revision, including rows no longer present in entries. */
  readRevisionWatermarks(sessionId: string): Map<number, number>;
  writeRevisionWatermarks(sessionId: string, revisions: ReadonlyMap<number, number>): void;
  /** Rows in `[from, to]`, ascending, keyed by seq. */
  readWindow(sessionId: string, from: number, to: number): SessionLogEntry[];
  clearSession(sessionId: string): void;
  /**
   * Drop every row of every session.
   *
   * Separate from {@link clearSession} because the whole-database triggers
   * (logout, `user_id` mismatch, schema upgrade) run in a tab that may never have
   * opened the sessions the previous user left on disk, so "clear what I know
   * about" would leak exactly those rows.
   */
  clearDatabase(): void;
  /** Drop one session's cached row heights only. */
  clearSessionHeights(sessionId: string): void;
  readRowHeight(sessionId: string, seq: number, key: string): number | null;
  writeRowHeight(sessionId: string, seq: number, key: string, height: number): void;
  close(): void;
}

/**
 * The no-OPFS fallback store.
 *
 * It is a map, not a second protocol: the point of the degrade path is that
 * freshness, gaps, patches and the resume cursor behave identically, and the
 * only thing lost is the hot start. Keeping it a `ReplicaStorage` is what makes
 * that claim checkable — the Playwright OPFS-off case runs the same suite.
 */
export class MemoryReplicaStorage implements ReplicaStorage {
  private readonly meta = new Map<string, string>();
  private readonly entries = new Map<string, Map<number, SessionLogEntry>>();
  private readonly revisions = new Map<string, Map<number, number>>();
  private readonly states = new Map<string, ReplicaState>();
  private readonly heights = new Map<string, number>();

  transaction<T>(write: () => T): T {
    return write();
  }

  readMeta(key: string): string | null {
    return this.meta.get(key) ?? null;
  }

  writeMeta(key: string, value: string): void {
    this.meta.set(key, value);
  }

  readState(sessionId: string): ReplicaState {
    const state = this.states.get(sessionId);
    return state ? { ranges: state.ranges.map((range) => ({ ...range })), head: state.head, logVersion: state.logVersion, synced: state.synced } : { ranges: [], head: null, logVersion: null, synced: false };
  }

  writeState(sessionId: string, state: ReplicaState, _now: string): void {
    this.states.set(sessionId, {
      ranges: state.ranges.map((range) => ({ ...range })),
      head: state.head,
      logVersion: state.logVersion,
      synced: state.synced,
    });
  }

  upsertEntries(entries: readonly SessionLogEntry[]): void {
    for (const entry of entries) {
      let session = this.entries.get(entry.session_id);
      if (!session) {
        session = new Map();
        this.entries.set(entry.session_id, session);
      }
      session.set(entry.seq, { ...entry });
    }
  }

  deleteEntries(sessionId: string, seqs: readonly number[]): void {
    const session = this.entries.get(sessionId);
    if (!session) return;
    for (const seq of seqs) session.delete(seq);
  }

  readEntries(sessionId: string): Map<number, SessionLogEntry> {
    const session = this.entries.get(sessionId);
    return new Map(session ? [...session].map(([seq, entry]) => [seq, { ...entry }]) : []);
  }

  readRevisionWatermarks(sessionId: string): Map<number, number> {
    return new Map(this.revisions.get(sessionId));
  }

  writeRevisionWatermarks(sessionId: string, revisions: ReadonlyMap<number, number>): void {
    let session = this.revisions.get(sessionId);
    if (!session) {
      session = new Map();
      this.revisions.set(sessionId, session);
    }
    for (const [seq, revision] of revisions) {
      session.set(seq, Math.max(session.get(seq) ?? -Infinity, revision));
    }
  }

  readWindow(sessionId: string, from: number, to: number): SessionLogEntry[] {
    const session = this.entries.get(sessionId);
    if (!session) return [];
    return [...session.values()]
      .filter((entry) => entry.seq >= from && entry.seq <= to)
      .sort((left, right) => left.seq - right.seq)
      .map((entry) => ({ ...entry }));
  }

  clearSession(sessionId: string): void {
    this.entries.delete(sessionId);
    this.revisions.delete(sessionId);
    this.states.delete(sessionId);
    this.clearSessionHeights(sessionId);
  }

  clearSessionHeights(sessionId: string): void {
    for (const key of [...this.heights.keys()]) {
      if (key.startsWith(`${sessionId}|`)) this.heights.delete(key);
    }
  }

  clearDatabase(): void {
    this.meta.clear();
    this.entries.clear();
    this.revisions.clear();
    this.states.clear();
    this.heights.clear();
  }

  readRowHeight(sessionId: string, seq: number, key: string): number | null {
    return this.heights.get(`${sessionId}|${seq}|${key}`) ?? null;
  }

  writeRowHeight(sessionId: string, seq: number, key: string, height: number): void {
    this.heights.set(`${sessionId}|${seq}|${key}`, height);
  }

  close(): void {
    // Nothing to release; kept so both stores satisfy one interface.
  }
}
