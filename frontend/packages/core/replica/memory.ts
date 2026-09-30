/**
 * The in-memory {@link SessionReplicaPort} (MUL-403 C8 §5).
 *
 * Two consumers, one implementation:
 *
 * - **tests** drive the flat list's window, freshness and height cache without
 *   a Worker, OPFS or a WebSocket;
 * - **the zero-jump fixture page** (`tests/integration/zero-jump-session-log-*`)
 *   drives the real `SessionLogList` through the same port in a real browser.
 *   C7's SQLite replica is the production implementation; the plan's degrade
 *   path for browsers without OPFS is the same shape.
 *
 * `getSnapshot` is written for `useSyncExternalStore`: it returns the memoized
 * object it last built for that session and only rebuilds when the window was
 * actually replaced. Returning a fresh object every call is the classic
 * infinite-render bug, so that is enforced by a test rather than left to review.
 */
import type {
  SessionLogEntry,
  SessionReplicaPort,
  SessionReplicaSnapshot,
} from "./port";
import { rowHeightKey, type RowHeightKeyInput } from "./port";

export interface MemorySessionReplicaSeed {
  entries?: readonly SessionLogEntry[];
  /** Server's newest seq; defaults to the newest entry's. */
  head?: number | null;
  fresh?: boolean;
  ready?: boolean;
  /** Heights to preload, keyed the way {@link MemorySessionReplica.readRowHeight} looks them up. */
  rowHeights?: Array<RowHeightKeyInput & { sessionId: string; seq: number; height: number }>;
}

interface SessionState {
  snapshot: SessionReplicaSnapshot;
  listeners: Set<() => void>;
  heights: Map<string, number>;
}

/**
 * A replica that holds every session's window in memory.
 *
 * The async surface is deliberately tiny — {@link setWindow} and
 * {@link setFreshness} are the only ways the log changes — so a test can say
 * exactly when "20 more entries arrived" happened instead of racing a socket.
 */
export class MemorySessionReplica implements SessionReplicaPort {
  private readonly sessions = new Map<string, SessionState>();

  constructor(seed: Record<string, MemorySessionReplicaSeed> = {}) {
    for (const [sessionId, value] of Object.entries(seed)) {
      const entries = [...(value.entries ?? [])].sort((left, right) => left.seq - right.seq);
      const state: SessionState = {
        snapshot: {
          sessionId,
          entries,
          head: value.head ?? (entries.length > 0 ? entries[entries.length - 1]!.seq : null),
          fresh: value.fresh ?? true,
          ready: value.ready ?? true,
        },
        listeners: new Set(),
        heights: new Map(),
      };
      for (const height of value.rowHeights ?? []) {
        // Stored under the same `seq|key` shape `readRowHeight` looks up; seeding
        // through a different spelling is exactly how a cache silently never hits.
        state.heights.set(`${height.seq}|${rowHeightKey(height)}`, height.height);
      }
      this.sessions.set(sessionId, state);
    }
  }

  getSnapshot(sessionId: string): SessionReplicaSnapshot & { entries: readonly SessionLogEntry[] } {
    return this.stateFor(sessionId).snapshot;
  }

  subscribe(sessionId: string, listener: () => void): () => void {
    const listeners = this.stateFor(sessionId).listeners;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  readRowHeight(sessionId: string, seq: number, key: string): number | null {
    return this.stateFor(sessionId).heights.get(`${seq}|${key}`) ?? null;
  }

  writeRowHeight(sessionId: string, seq: number, key: string, height: number): void {
    this.stateFor(sessionId).heights.set(`${seq}|${key}`, height);
  }

  /** Replace one session's window. Entries are sorted; `head` defaults to the newest. */
  setWindow(
    sessionId: string,
    entries: readonly SessionLogEntry[],
    options: { head?: number | null; fresh?: boolean; ready?: boolean } = {},
  ): void {
    const state = this.stateFor(sessionId);
    const sorted = [...entries].sort((left, right) => left.seq - right.seq);
    state.snapshot = {
      sessionId,
      entries: sorted,
      head: options.head ?? (sorted.length > 0 ? sorted[sorted.length - 1]!.seq : null),
      fresh: options.fresh ?? state.snapshot.fresh,
      ready: options.ready ?? state.snapshot.ready,
    };
    this.emit(state);
  }

  /** Append entries, as the log stream does; `head` advances with them. */
  append(sessionId: string, entries: readonly SessionLogEntry[], options: { fresh?: boolean } = {}): void {
    const state = this.stateFor(sessionId);
    const merged = new Map<number, SessionLogEntry>();
    for (const entry of state.snapshot.entries) merged.set(entry.seq, entry);
    for (const entry of entries) merged.set(entry.seq, entry);
    const sorted = [...merged.values()].sort((left, right) => left.seq - right.seq);
    state.snapshot = {
      sessionId,
      entries: sorted,
      head: sorted.length > 0 ? sorted[sorted.length - 1]!.seq : state.snapshot.head,
      fresh: options.fresh ?? state.snapshot.fresh,
      ready: true,
    };
    this.emit(state);
  }

  /** Flip the replica's own freshness verdict without touching the window. */
  setFreshness(sessionId: string, fresh: boolean): void {
    const state = this.stateFor(sessionId);
    if (state.snapshot.fresh === fresh) return;
    state.snapshot = { ...state.snapshot, fresh };
    this.emit(state);
  }

  /** Test/teardown helper: drop every listener without clearing the windows. */
  dispose(): void {
    for (const state of this.sessions.values()) state.listeners.clear();
  }

  private stateFor(sessionId: string): SessionState {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const created: SessionState = {
      snapshot: { sessionId, entries: [], head: null, fresh: false, ready: false },
      listeners: new Set(),
      heights: new Map(),
    };
    this.sessions.set(sessionId, created);
    return created;
  }

  private emit(state: SessionState): void {
    for (const listener of [...state.listeners]) listener();
  }
}

/** A fresh replica whose one session already holds a window. */
export function memoryReplicaWith(
  sessionId: string,
  seed: MemorySessionReplicaSeed = {},
): MemorySessionReplica {
  return new MemorySessionReplica({ [sessionId]: seed });
}
