/**
 * Daemon-side storage for one task's trace (MUL-401 §5, PR 2 §3.1).
 *
 * The interface is the contract between the in-memory implementation (tests,
 * the server's in-process reader) and `worker/trace-file-store.ts` on disk, so it
 * must not grow a file-only concept (paths, rotations, fsync policy) and must not
 * leak the in-memory one (object identity, shared arrays).
 *
 * Two responsibilities live here rather than at the call sites, because this is
 * the only durable write point in the trace path (MUL-402 rulings 2 and 6b):
 *
 *   - **Sequencing.** `append` assigns the per-task `seq` and the `ts`. Dense,
 *     from 1, never rewritten; a producer never sets either.
 *   - **Sanitizing.** `append` re-applies the item caps and the 1 MiB event
 *     ceiling from `@shared/trace-sanitize.js` (the translator applies them
 *     first, so this is a no-op for its output). The frame and the file carry
 *     identical, bounded events.
 *
 * `close` writes the framing a v2 file ends with: the snapshot of the fold
 * (split into parts of at most 768 KiB) and the trailer. The open items and
 * `turn.completed` that precede them are ordinary events the transport appends.
 */

import type {
  TraceEvent,
  TraceEventInput,
  TraceEventLine,
  TraceTurnSnapshot,
} from "@multiremi/contracts/trace.js";
import {
  TRACE_SNAPSHOT_PART_MAX_BYTES,
  type TraceEndStatus,
  type TraceFileFormatVersion,
  type TraceFileSnapshotLine,
} from "@multiremi/contracts/trace-file.js";
import { createLogger } from "@shared/logger.js";
import { capTraceEvent } from "@shared/trace-sanitize.js";

const log = createLogger("multiremi-trace-store");

export type { TraceEndStatus } from "@multiremi/contracts/trace-file.js";

/** Result of appending: the new head plus the stored events with sequences bound. */
export interface TraceAppendResult {
  head: number;
  events: TraceEvent[];
}

/**
 * Result of a paginated read: raw stored event lines (a v1 file's legacy
 * fragments included; snapshot framing never).
 *
 * `eof` means this page reached the current head, so a caller polling for more can
 * stop until it learns the head moved. Completeness is NOT reported here: the
 * single "no more events will be written" signal is `closed`, which lives on
 * {@link TraceStoreHead} and on the reader's result (MUL-402 ruling 3).
 */
export interface TraceReadResult {
  events: TraceEventLine[];
  head: number;
  eof: boolean;
}

/**
 * The head and completeness of a task's trace.
 *
 * `closed` is the one boolean that says the trace is final — the trailer exists.
 * A consumer that needs to know "is the trace sealed" reads this field and
 * nothing else.
 */
export interface TraceStoreHead {
  head: number;
  closed: boolean;
}

/** One snapshot framing part, as `close` wrote it. */
export type TraceSnapshotPart = TraceFileSnapshotLine["snapshot"];

export interface TraceCloseInput {
  status: TraceEndStatus;
  /** ISO 8601. The moment the turn ended, as the daemon observed it. */
  ended_at: string;
  /** The fold at the head, written as snapshot framing before the trailer; null without a turn. */
  snapshot?: TraceTurnSnapshot | null;
}

export interface TraceStore {
  /**
   * Append event bodies to a task's trace. `seq` and `ts` are always assigned
   * here; the caps are re-applied, and an event that cannot be brought under the
   * 1 MiB ceiling is dropped (it never takes a seq).
   *
   * Appending to a closed task is a no-op that returns the existing head and an
   * empty array: a late frame must not reopen a closed trace. Appending to a v1
   * (legacy, read-only) trace throws.
   */
  append(taskId: string, events: TraceEventInput[]): TraceAppendResult;

  /**
   * Read event lines with `seq > afterSeq`, up to `limit` events and `maxBytes` of
   * serialized payload, whichever comes first. A single event larger than
   * `maxBytes` is still returned alone rather than deadlocking the reader.
   *
   * A task with no trace reads as `{ events: [], head: 0, eof: true }`.
   * Historical traces may have sparse sequences, so `read` must not assume a
   * page's events are consecutive.
   */
  read(taskId: string, afterSeq?: number, limit?: number, maxBytes?: number): TraceReadResult;

  /**
   * Current head and completeness, or null when this store has never seen the
   * task. A null here is what makes a reader answer `trace_not_hot`.
   */
  head(taskId: string): TraceStoreHead | null;

  /**
   * Seal the trace: write the snapshot parts, then the trailer. Idempotent; the
   * first call wins, so a retried completion cannot rewrite the recorded status.
   * Throws for a v1 trace, which is read-only.
   */
  close(taskId: string, end: TraceCloseInput): void;

  /** Snapshot part `part` (0-based) of a closed v2 trace, or null (open, v1, no snapshot, out of range). */
  snapshotPart(taskId: string, part: number): TraceSnapshotPart | null;

  /** The format a trace was written in, or null when the store has never seen it. */
  format(taskId: string): TraceFileFormatVersion | null;

  /** Drop a task's trace. Used for GC, not for task completion. */
  forget(taskId: string): void;
}

/**
 * Split a snapshot into framing parts of at most `maxBytes` serialized bytes.
 * Items stay in fold order and every part repeats the turn, so each line stands
 * alone. An item too large for any part (at most one capped event, 1 MiB) gets a
 * part of its own. A turn with no items is one part with an empty list.
 */
export function splitTraceSnapshot(
  snapshot: TraceTurnSnapshot,
  maxBytes: number = TRACE_SNAPSHOT_PART_MAX_BYTES,
): TraceSnapshotPart[] {
  const line = (items: TraceTurnSnapshot["items"], part = 0, parts = 1): TraceFileSnapshotLine =>
    ({ snapshot: { part, parts, head: snapshot.head, turn: snapshot.turn, items } });
  const baseBytes = Buffer.byteLength(JSON.stringify(line([], Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)), "utf8");
  const groups: Array<TraceTurnSnapshot["items"]> = [];
  let current: TraceTurnSnapshot["items"] = [];
  let bytes = baseBytes;
  for (const item of snapshot.items) {
    const size = Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
    if (current.length > 0 && bytes + size > maxBytes) {
      groups.push(current);
      current = [];
      bytes = baseBytes;
    }
    current.push(item);
    bytes += size;
  }
  groups.push(current);
  return groups.map((items, part) => line(items, part, groups.length).snapshot);
}

export const TRACE_READ_DEFAULT_LIMIT = 200;
export const TRACE_READ_MAX_LIMIT = 500;
export const TRACE_READ_MAX_BYTES = 2 * 1024 * 1024;

export function normalizeTraceReadArgs(afterSeq?: number, limit?: number, maxBytes?: number): {
  afterSeq: number; limit: number; maxBytes: number;
} {
  return {
    afterSeq: afterSeq === undefined || Number.isNaN(afterSeq) || afterSeq < 0 ? 0 : Math.floor(afterSeq),
    limit: limit === undefined || Number.isNaN(limit)
      ? TRACE_READ_DEFAULT_LIMIT
      : Math.max(1, Math.min(Math.floor(limit), TRACE_READ_MAX_LIMIT)),
    maxBytes: maxBytes === undefined || Number.isNaN(maxBytes)
      ? TRACE_READ_MAX_BYTES
      : Math.max(0, Math.min(TRACE_READ_MAX_BYTES, Math.floor(maxBytes))),
  };
}

interface TraceState {
  events: TraceEvent[];
  head: number;
  closed: boolean;
  end: TraceCloseInput | null;
  snapshot: TraceSnapshotPart[];
}

/** Injectable clock so tests can assert the `ts` the store assigns. */
export type TraceClock = () => string;

/**
 * In-memory {@link TraceStore}.
 *
 * Not for production use: the daemon must survive its own restart, which is the
 * entire point of MUL-402's file store. This exists so tests and the in-process
 * wiring can run without a filesystem, and so the interface has exactly one
 * reference implementation that is easy to read. Every trace is v2.
 */
export class InMemoryTraceStore implements TraceStore {
  private readonly tasks = new Map<string, TraceState>();

  constructor(private readonly now: TraceClock = () => new Date().toISOString()) {}

  private stateFor(taskId: string): TraceState {
    const existing = this.tasks.get(taskId);
    if (existing) return existing;
    const created: TraceState = { events: [], head: 0, closed: false, end: null, snapshot: [] };
    this.tasks.set(taskId, created);
    return created;
  }

  append(taskId: string, events: TraceEventInput[]): TraceAppendResult {
    const existing = this.tasks.get(taskId);
    if (existing?.closed) return { head: existing.head, events: [] };
    const state = this.stateFor(taskId);

    const stored: TraceEvent[] = [];
    for (const event of events) {
      const row = sanitizeStoredEvent(event, this.now(), taskId);
      if (!row) continue;
      state.head += 1;
      const sequenced = { ...row, seq: state.head } as TraceEvent;
      state.events.push(sequenced);
      stored.push(sequenced);
    }
    return { head: state.head, events: stored };
  }

  read(
    taskId: string,
    afterSeq = 0,
    limit = TRACE_READ_DEFAULT_LIMIT,
    maxBytes?: number,
  ): TraceReadResult {
    const state = this.tasks.get(taskId);
    if (!state) return { events: [], head: 0, eof: true };

    const args = normalizeTraceReadArgs(afterSeq, limit, maxBytes);
    const events: TraceEventLine[] = [];
    let bytes = 0;
    for (const event of state.events) {
      if (event.seq <= args.afterSeq) continue;
      if (events.length >= args.limit) break;
      const size = traceEventBytes(event);
      // Always admit the first event of the page, even if it alone exceeds the
      // byte budget; otherwise a single large event would block every reader.
      if (events.length > 0 && bytes + size > args.maxBytes) break;
      events.push(event as TraceEventLine);
      bytes += size;
    }
    const head = state.head;
    // Written traces are dense, so the last returned seq tells the truth. A
    // sparse trace stays a best-effort answer; callers that need exactness
    // compare against `head`.
    const lastSeq = events.at(-1)?.seq ?? args.afterSeq;
    return { events, head, eof: lastSeq >= head };
  }

  head(taskId: string): TraceStoreHead | null {
    const state = this.tasks.get(taskId);
    return state ? { head: state.head, closed: state.closed } : null;
  }

  close(taskId: string, end: TraceCloseInput): void {
    const state = this.stateFor(taskId);
    if (state.closed) return;
    state.closed = true;
    state.end = { status: end.status, ended_at: end.ended_at };
    state.snapshot = end.snapshot ? splitTraceSnapshot({ ...end.snapshot, head: state.head, closed: true }) : [];
  }

  snapshotPart(taskId: string, part: number): TraceSnapshotPart | null {
    const state = this.tasks.get(taskId);
    if (!state?.closed || !Number.isSafeInteger(part)) return null;
    return state.snapshot[part] ?? null;
  }

  format(taskId: string): TraceFileFormatVersion | null {
    return this.tasks.has(taskId) ? "v2" : null;
  }

  /** The recorded trailer, for tests and for a caller that wants the status. */
  endInfo(taskId: string): Omit<TraceCloseInput, "snapshot"> | null {
    return this.tasks.get(taskId)?.end ?? null;
  }

  forget(taskId: string): void {
    this.tasks.delete(taskId);
  }
}

/**
 * The stored form of one event body: the item caps and the 1 MiB ceiling
 * re-applied (`capTraceEvent`), plus the write time. Null for an event that
 * cannot be brought under the ceiling; the caller drops it, and this logs a
 * warning naming the event so the gap is never silent. Bodies of a type this
 * contract does not know pass through untouched (they are opaque to the store,
 * as they are to the hub).
 */
export function sanitizeStoredEvent(event: TraceEventInput, ts: string, taskId: string): Omit<TraceEvent, "seq"> | null {
  const capped = capTraceEvent(event);
  if (!capped) {
    const item = "item" in event && event.item && typeof event.item === "object" ? event.item as { id?: unknown; type?: unknown } : null;
    log.warn("Trace event dropped: over the event ceiling after its fields were dropped", {
      taskId,
      type: event.type,
      itemId: typeof item?.id === "string" ? item.id : null,
      itemType: typeof item?.type === "string" ? item.type : null,
      bytes: Buffer.byteLength(JSON.stringify(event), "utf8"),
    });
    return null;
  }
  // `seq` and `ts` are the store's: a producer's own are overwritten.
  const { seq: _seq, ts: _ts, ...body } = capped as TraceEventInput & { seq?: unknown; ts?: unknown };
  return { ts, ...body } as Omit<TraceEvent, "seq">;
}

/** Serialized size of one event as a frame would carry it. */
export function traceEventBytes(event: TraceEvent | TraceEventLine): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}
