/**
 * The synchronous read surface over the replica (MUL-403 C7 §1.4).
 *
 * C8's port is synchronous — `getSnapshot(sessionId)` feeds
 * `useSyncExternalStore`, and a Promise there would make every list render a
 * suspense boundary. Storage, on the other hand, is the Worker's, and crossing a
 * Worker boundary is asynchronous by construction.
 *
 * So the leader keeps this view: the windows and heights it has already read or
 * written, memoized per session and updated from Worker responses. It is not a
 * second source of truth — the Worker's SQLite is, and every write goes there
 * first — it is a read cache with the same lifetime as the leader's tab, which is
 * exactly the "no hot start without persistence" trade the plan accepts for the
 * no-OPFS fallback.
 */

import type { SessionLogEntry, SessionReplicaPort, SessionReplicaSnapshot } from "./port";
import type { SeqRange } from "./ranges";

export interface SessionViewState {
  entries: SessionLogEntry[];
  head: number | null;
  fresh: boolean;
  ready: boolean;
  ranges: SeqRange[];
  heights: Map<string, number>;
}

/** One tab's view of every session it is showing. */
export class ReplicaView implements SessionReplicaPort {
  private readonly sessions = new Map<string, SessionViewState>();
  private readonly snapshots = new Map<string, SessionReplicaSnapshot & { entries: SessionLogEntry[] }>();
  private readonly listeners = new Map<string, Set<() => void>>();

  getSnapshot(sessionId: string): SessionReplicaSnapshot & { entries: readonly SessionLogEntry[] } {
    const cached = this.snapshots.get(sessionId);
    if (cached) return cached;
    const state = this.stateFor(sessionId);
    // One object, memoized: `useSyncExternalStore` compares by identity, so
    // rebuilding this per read is the classic infinite-render bug.
    const memoized: SessionReplicaSnapshot & { entries: SessionLogEntry[] } = {
      sessionId,
      entries: state.entries,
      head: state.head,
      fresh: state.fresh,
      ready: state.ready,
    };
    this.snapshots.set(sessionId, memoized);
    return memoized;
  }

  subscribe(sessionId: string, listener: () => void): () => void {
    let listeners = this.listeners.get(sessionId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(sessionId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  readRowHeight(sessionId: string, seq: number, key: string): number | null {
    return this.stateFor(sessionId).heights.get(`${seq}|${key}`) ?? null;
  }

  writeRowHeight(sessionId: string, seq: number, key: string, height: number): void {
    // Heights are the one write the list itself produces, so they update the view
    // immediately; persistence happens through the Worker.
    this.stateFor(sessionId).heights.set(`${seq}|${key}`, height);
  }

  /** Replace a session's window (after an open, a backfill or a batch). */
  setWindow(
    sessionId: string,
    entries: readonly SessionLogEntry[],
    options: { head?: number | null; fresh?: boolean; ready?: boolean; ranges?: readonly SeqRange[] },
  ): void {
    const state = this.stateFor(sessionId);
    state.entries = [...entries].sort((left, right) => left.seq - right.seq);
    if (options.head !== undefined) state.head = options.head;
    if (options.fresh !== undefined) state.fresh = options.fresh;
    if (options.ready !== undefined) state.ready = options.ready;
    if (options.ranges !== undefined) state.ranges = options.ranges.map((range) => ({ ...range }));
    this.invalidate(sessionId);
  }

  updateFreshness(sessionId: string, fresh: boolean): void {
    const state = this.stateFor(sessionId);
    if (state.fresh === fresh) return;
    state.fresh = fresh;
    this.invalidate(sessionId);
  }

  /** Seed heights read back from storage on open. */
  seedHeights(sessionId: string, heights: Map<string, number>): void {
    const state = this.stateFor(sessionId);
    for (const [key, height] of heights) state.heights.set(key, height);
  }

  /** Drop one session's rows — a `replica:cleared` for that session, or a reset. */
  dropSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.snapshots.delete(sessionId);
    this.invalidate(sessionId);
  }

  /** Drop everything — logout, a user mismatch or a schema upgrade. */
  dropAll(): void {
    const sessions = [...this.sessions.keys()];
    this.sessions.clear();
    this.snapshots.clear();
    for (const sessionId of sessions) this.invalidate(sessionId);
  }

  private stateFor(sessionId: string): SessionViewState {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const created: SessionViewState = {
      entries: [],
      head: null,
      fresh: false,
      ready: false,
      ranges: [],
      heights: new Map(),
    };
    this.sessions.set(sessionId, created);
    return created;
  }

  private invalidate(sessionId: string): void {
    this.snapshots.delete(sessionId);
    const listeners = this.listeners.get(sessionId);
    if (!listeners) return;
    for (const listener of [...listeners]) listener();
  }
}
