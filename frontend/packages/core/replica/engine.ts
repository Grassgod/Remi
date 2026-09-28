/**
 * The replica engine: the six-step sync protocol over a {@link ReplicaStorage}.
 *
 * Everything here is environment-free. The Worker drives it over OPFS SQLite,
 * `MemoryReplicaStorage` drives it without one, and the unit tests drive it
 * directly — the plan's "identical semantics, no hot start" degrade path is a
 * second storage, not a second protocol.
 *
 * The engine deliberately has no timers. A background tab's timers are throttled,
 * and the plan (3/6 §1) puts stream handling in the Worker for exactly that
 * reason: work happens when a frame arrives, and the only clock this code reads
 * is the `synced_at` timestamp it writes.
 */

import type { HubFrame, HubSeqRange, HubStreamAckPayload } from "@multiremi/contracts/live-hub";
import type { SessionLogEntry, SessionReplicaSnapshot } from "./port";
import { applyFrames, computeFresh, contiguousHead, decideAck, subscribeFromSeq, type ReplicaState } from "./protocol";
import { coversSeq } from "./ranges";
import { META_SCHEMA_VERSION, META_USER_ID, META_WORKSPACE_ID, REPLICA_SCHEMA_VERSION } from "./schema";
import type { ReplicaStorage } from "./storage";

/** What one session's stream writes into the engine, and where the page reads it. */
export type ReplicaSessionView = SessionReplicaSnapshot & {
  /** Ascending rows the replica holds. Sparse windows are legal. */
  entries: SessionLogEntry[];
};

export interface ReplicaClearEvent {
  /** Why the whole database was dropped, for the `replica:cleared` broadcast. */
  reason: "logout" | "user_mismatch" | "schema_upgrade";
}

/**
 * One browser's replica for one `(user, workspace)`.
 *
 * The engine is a plain object with no async surface: `ack`/`frames` are called
 * with what the socket delivered, and every read the page makes is synchronous
 * against storage. Persistence is the caller's concern (the Worker writes
 * through), so a `MemoryReplicaStorage` engine is the fallback with no extra
 * code path.
 */
export class ReplicaEngine {
  private readonly listeners = new Map<string, Set<() => void>>();
  /**
   * Every session this engine has touched.
   *
   * Tracked explicitly because a database-level clear has to reach sessions
   * nobody currently subscribes to: a tab that opened a session, navigated away
   * and closed the socket still has rows on disk, and leaving them behind is
   * exactly the state the `log_version` and user-mismatch triggers exist to
   * prevent.
   */
  private readonly knownSessions = new Set<string>();
  /** Ack state per session, so freshness is a verdict and not a recomputation. */
  private readonly acks = new Map<string, { headSeq: number | null; logVersion: number | null }>();
  /**
   * Memoized snapshots. `useSyncExternalStore` compares snapshots by identity, so
   * a fresh object per read is an infinite render loop; the cache is invalidated
   * only when something actually changed.
   */
  private readonly snapshots = new Map<string, ReplicaSessionView>();

  constructor(
    private readonly storage: ReplicaStorage,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /**
   * Step 1. Record which `(user, workspace)` this database belongs to and open a
   * session at the seq the database already reached.
   *
   * The `user_id` check is a cleanup trigger from plan 3/6 §1.6: a database left
   * behind by a different user must not serve one row, so a mismatch clears
   * everything before anything is read.
   */
  openSession(input: { sessionId: string; userId: string; workspaceId: string }): {
    fromSeq: number;
    state: ReplicaState;
    cleared: ReplicaClearEvent | null;
  } {
    const schemaVersion = this.storage.readMeta(META_SCHEMA_VERSION);
    if (schemaVersion !== null && schemaVersion !== String(REPLICA_SCHEMA_VERSION)) {
      this.clear("schema_upgrade");
      return { fromSeq: 1, state: this.storage.readState(input.sessionId), cleared: { reason: "schema_upgrade" } };
    }

    const storedUser = this.storage.readMeta(META_USER_ID);
    const storedWorkspace = this.storage.readMeta(META_WORKSPACE_ID);
    if (storedUser !== null && (storedUser !== input.userId || storedWorkspace !== input.workspaceId)) {
      this.clear("user_mismatch");
      return { fromSeq: 1, state: this.storage.readState(input.sessionId), cleared: { reason: "user_mismatch" } };
    }

    if (schemaVersion === null) this.storage.writeMeta(META_SCHEMA_VERSION, String(REPLICA_SCHEMA_VERSION));
    if (storedUser === null) this.storage.writeMeta(META_USER_ID, input.userId);
    if (storedWorkspace === null) this.storage.writeMeta(META_WORKSPACE_ID, input.workspaceId);

    this.knownSessions.add(input.sessionId);
    const state = this.storage.readState(input.sessionId);
    return { fromSeq: subscribeFromSeq(state), state, cleared: null };
  }

  /** Drop one session's rows (a `log_version` change, step 2). */
  resetSession(sessionId: string): void {
    this.storage.clearSession(sessionId);
    this.acks.delete(sessionId);
    this.knownSessions.add(sessionId);
    this.invalidate(sessionId);
  }

  /**
   * Step 2. Apply `stream.ack`.
   *
   * Returns the range the caller must read through the read route before the
   * frames can replay — `gap` for an ordinary fall-behind, or the range below
   * `first_seq` after a `log_version` reset. Null means the stream can start
   * sending immediately.
   */
  ack(sessionId: string, ack: HubStreamAckPayload): HubSeqRange | null {
    const current = this.storage.readState(sessionId);
    const decision = decideAck(ack, current);

    if (decision.reset) {
      this.storage.clearSession(sessionId);
    }

    // The ack's head is the server's, and freshness compares the replica's
    // contiguous head against it; recording it here is what makes the very first
    // ack able to produce a verdict instead of "unknown".
    this.acks.set(sessionId, {
      headSeq: ack.head_seq,
      logVersion: decision.state.logVersion,
    });
    this.storage.writeState(sessionId, decision.state, this.now());
    this.knownSessions.add(sessionId);
    this.invalidate(sessionId);

    return decision.backfill;
  }

  /**
   * Step 3 + 4. Apply one frame batch and persist the resulting state.
   *
   * Returns the hole the batch exposed, if any: the caller backfills that range
   * and then continues, which is what keeps `head` meaning "in order" even when
   * the socket delivers a batch that starts above the local head.
   */
  frames(sessionId: string, frames: readonly HubFrame[]): HubSeqRange | null {
    if (frames.length === 0) return null;
    const state = this.storage.readState(sessionId);
    const entries = this.storage.readEntries(sessionId);
    const result = applyFrames({ frames, state, entries });

    if (result.upserts.length > 0) this.storage.upsertEntries(result.upserts);
    if (result.deletes.length > 0) this.storage.deleteEntries(sessionId, result.deletes);
    this.storage.writeState(sessionId, result.state, this.now());
    this.knownSessions.add(sessionId);
    this.invalidate(sessionId);
    return result.missing;
  }

  /**
   * Store a backfilled window (a `gap`, a deep link, or the initial fill).
   *
   * Backfilled rows are indistinguishable from streamed ones once written —
   * same table, same coverage — so a later reconnect resumes from the same head
   * either way.
   */
  writeWindow(sessionId: string, entries: readonly SessionLogEntry[], range: HubSeqRange): void {
    if (entries.length > 0) this.storage.upsertEntries(entries);
    const state = this.storage.readState(sessionId);
    // Coverage advances to what the read route proved it served, not to the
    // highest seq among the returned rows: a window that came back short because
    // rows were tombstoned must not claim to cover seqs it never saw.
    const ranges = mergeCoverage(state.ranges, range);
    // The head is the *contiguous* have, so a deep-link window at seq 880 does
    // not become the resume cursor — subscribing from 882 would skip the whole
    // head of the session and call the result fresh. Only a window that extends
    // the run starting after the current head moves it.
    const head = contiguousHead(ranges, state.head);
    this.storage.writeState(sessionId, { ...state, ranges, head }, this.now());
    this.knownSessions.add(sessionId);
    this.invalidate(sessionId);
  }

  /**
   * Step 6. The replica's freshness verdict for one session.
   *
   * `log_version` equality **and** head equality; a session with no ack, no
   * stored head or an unknown `log_version` is not fresh, never "probably fine".
   */
  isFresh(sessionId: string): boolean {
    const ack = this.acks.get(sessionId) ?? null;
    return computeFresh({
      state: this.storage.readState(sessionId),
      ackHeadSeq: ack?.headSeq ?? null,
      ackLogVersion: ack?.logVersion ?? null,
    });
  }

  /**
   * Whether the replica holds `seq` for this session.
   *
   * Coverage, not row presence: a seq the server marked hidden has no row but is
   * definitively known, and treating it as missing would re-read it forever.
   */
  covers(sessionId: string, seq: number): boolean {
    return coversSeq(this.storage.readState(sessionId).ranges, seq);
  }

  /** The rows the replica holds, for the Worker's `window` response. */
  snapshotEntries(sessionId: string): readonly SessionLogEntry[] {
    return this.snapshot(sessionId).entries;
  }

  /** Step 1's number, exposed so the caller can log or assert the resume cursor. */
  resumeFrom(sessionId: string): number {
    return subscribeFromSeq(this.storage.readState(sessionId));
  }

  readRowHeight(sessionId: string, seq: number, key: string): number | null {
    return this.storage.readRowHeight(sessionId, seq, key);
  }

  writeRowHeight(sessionId: string, seq: number, key: string, height: number): void {
    this.storage.writeRowHeight(sessionId, seq, key, height);
  }

  /** The window the list renders: rows the replica holds in `[from, to]`. */
  readWindow(sessionId: string, from: number, to: number): SessionLogEntry[] {
    return this.storage.readWindow(sessionId, from, to);
  }

  /**
   * One session's snapshot, memoized for `useSyncExternalStore`.
   *
   * Entries are the whole held window rather than a fixed page: the list decides
   * which slice to render, and a second window query here would be a second
   * answer to "what does the replica hold".
   */
  snapshot(sessionId: string): ReplicaSessionView {
    const cached = this.snapshots.get(sessionId);
    if (cached) return cached;
    const state = this.storage.readState(sessionId);
    const entries = this.storage.readWindow(sessionId, 0, Number.MAX_SAFE_INTEGER);
    const view: ReplicaSessionView = {
      sessionId,
      entries,
      head: state.head,
      fresh: this.isFresh(sessionId),
      // `ready` is the separate gate `useAnchoredReveal` takes as `dataReady`:
      // an ack has been applied, so the replica has answered at least once.
      ready: state.synced,
    };
    this.snapshots.set(sessionId, view);
    return view;
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

  /**
   * Drop everything — the logout, user-mismatch and schema-upgrade trigger
   * (plan 3/6 §1.6).
   *
   * Every session the engine has opened is cleared, not just the subscribed
   * ones: the contract is "整库清除", and a session that was opened an hour ago
   * still holds rows. `meta` is rewritten so the next `openSession` starts from a
   * consistent database rather than from a half-cleared one, and the caller
   * (the leader) additionally deletes the file when the storage is SQLite —
   * {@link ReplicaClearEvent} is what it broadcasts to the other tabs.
   */
  clear(reason: ReplicaClearEvent["reason"]): void {
    const sessions = [...this.knownSessions];
    // Database-wide, not per known session: this engine may be a fresh leader
    // that has opened nothing while the previous user's rows are still on disk.
    this.storage.clearDatabase();
    this.storage.writeMeta(META_SCHEMA_VERSION, String(REPLICA_SCHEMA_VERSION));
    this.acks.clear();
    this.snapshots.clear();
    for (const sessionId of sessions) this.invalidate(sessionId);
    this.onClear?.(reason);
  }

  /** Set by the owner so a database-level clear can be broadcast to every tab. */
  onClear?: (reason: ReplicaClearEvent["reason"]) => void;

  /**
   * Release the underlying storage.
   *
   * Not called on a handoff by itself: the leader deletes the database file when
   * the trigger is a whole-database clear, and an ordinary handoff keeps it so
   * the next leader hot-starts from the same rows.
   */
  close(): void {
    this.storage.close();
  }

  private invalidate(sessionId: string): void {
    this.snapshots.delete(sessionId);
    const listeners = this.listeners.get(sessionId);
    if (!listeners) return;
    for (const listener of [...listeners]) listener();
  }
}

/** Merge a read range into coverage without splitting an existing range. */
function mergeCoverage(ranges: readonly HubSeqRange[], range: HubSeqRange): { from: number; to: number }[] {
  const out = ranges.map((r) => ({ from: r.from, to: r.to }));
  out.push({ from: range.from, to: range.to });
  out.sort((left, right) => left.from - right.from);
  const merged: { from: number; to: number }[] = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r.from <= last.to + 1) {
      if (r.to > last.to) last.to = r.to;
      continue;
    }
    merged.push({ ...r });
  }
  return merged;
}
