/**
 * Daemon-side storage for one task's normalized trace (MUL-401 §5).
 *
 * A-0 ships the interface and an in-memory implementation that tests and the
 * A-6 wiring use. MUL-402's `worker/trace-file-store.ts` implements the same
 * interface on disk; the interface is the contract between them, so it must not
 * grow a file-only concept (paths, rotations, fsync policy) and must not leak the
 * in-memory one (object identity, shared arrays).
 *
 * Sequence contract: `append` assigns dense per-task sequences starting at 1 and
 * never rewrites one. A retry that appends the same logical event therefore gets
 * a new sequence; deduplication above this layer keys on the *event*, not on the
 * sequence. This is what lets the Hub discard everything at or below its head and
 * still have `first_seq .. head` be gapless.
 */

import type { TraceEvent, TraceEventInput } from "@multiremi/contracts/trace.js";

/** Result of appending: the new head plus the stored events with sequences bound. */
export interface TraceAppendResult {
  head: number;
  events: TraceEvent[];
}

/**
 * Result of a paginated read.
 *
 * `eof` means this page reached the current head, so a caller polling for more
 * can stop until it learns the head moved. `ended` means the task finished and no
 * further events will ever be written, so a caller can stop polling for good.
 * They are deliberately separate: a live task is frequently at `eof` but never
 * `ended`.
 */
export interface TraceReadResult {
  events: TraceEvent[];
  head: number;
  eof: boolean;
  ended: boolean;
}

/** Terminal status recorded by {@link TraceStore.end}. */
export type TraceEndStatus = "completed" | "failed" | "cancelled";

export interface TraceStore {
  /**
   * Append events to a task's trace. Assigns `seq` densely from the current head
   * and returns the events that were actually stored, in order.
   *
   * Appending to a task already ended is a no-op that returns the existing head
   * and an empty array: a late frame must not reopen a closed trace, because the
   * archive that follows assumes the tail it saw is final.
   */
  append(taskId: string, events: TraceEventInput[]): TraceAppendResult;

  /**
   * Read events with `seq > afterSeq`, up to `limit` events and `maxBytes` of
   * serialized payload, whichever comes first. A single event larger than
   * `maxBytes` is still returned alone rather than deadlocking the reader.
   *
   * A task with no trace reads as `{ events: [], head: 0, eof: true, ended: false }`
   * rather than throwing: an unknown task is a normal answer for a reader that
   * raced the daemon's registration, and the caller turns it into `trace_not_hot`
   * only when it knows the task should exist.
   */
  read(taskId: string, afterSeq?: number, limit?: number, maxBytes?: number): TraceReadResult;

  /** Current head sequence, or null when this store has never seen the task. */
  head(taskId: string): number | null;

  /** Mark a task's trace final. Idempotent; the first status wins. */
  end(taskId: string, status: TraceEndStatus): void;

  /** Whether {@link TraceStore.end} has been called for this task. */
  isEnded(taskId: string): boolean;

  /** Drop a task's trace. Used for GC, not for task completion. */
  forget(taskId: string): void;
}

export const TRACE_READ_DEFAULT_LIMIT = 200;
export const TRACE_READ_MAX_LIMIT = 500;

interface TraceState {
  events: TraceEvent[];
  head: number;
  ended: boolean;
  endStatus: TraceEndStatus | null;
}

/**
 * In-memory {@link TraceStore}.
 *
 * Not for production use: the daemon must survive its own restart, which is the
 * entire point of MUL-402's file store. This exists so A-0's tests and A-6's
 * wiring can run without a filesystem, and so the interface has exactly one
 * reference implementation that is easy to read.
 */
export class InMemoryTraceStore implements TraceStore {
  private readonly tasks = new Map<string, TraceState>();

  append(taskId: string, events: TraceEventInput[]): TraceAppendResult {
    const state = this.tasks.get(taskId);
    if (state?.ended) return { head: state.head, events: [] };
    const target = state ?? { events: [], head: 0, ended: false, endStatus: null };
    if (!state) this.tasks.set(taskId, target);

    const stored: TraceEvent[] = [];
    for (const event of events) {
      target.head += 1;
      const stored_event: TraceEvent = { ...event, seq: target.head };
      target.events.push(stored_event);
      stored.push(stored_event);
    }
    return { head: target.head, events: stored };
  }

  read(taskId: string, afterSeq = 0, limit = TRACE_READ_DEFAULT_LIMIT, maxBytes = Number.MAX_SAFE_INTEGER): TraceReadResult {
    const state = this.tasks.get(taskId);
    if (!state) return { events: [], head: 0, eof: true, ended: false };

    const boundedLimit = Math.max(1, Math.min(Math.floor(limit), TRACE_READ_MAX_LIMIT));
    const events: TraceEvent[] = [];
    let bytes = 0;
    for (const event of state.events) {
      if (event.seq <= afterSeq) continue;
      if (events.length >= boundedLimit) break;
      const size = traceEventBytes(event);
      // Always admit the first event of the page, even if it alone exceeds the
      // byte budget; otherwise a single large event would block every reader.
      if (events.length > 0 && bytes + size > maxBytes) break;
      events.push(event);
      bytes += size;
    }
    const head = state.head;
    const lastSeq = events.at(-1)?.seq ?? afterSeq;
    return { events, head, eof: lastSeq >= head, ended: state.ended };
  }

  head(taskId: string): number | null {
    const state = this.tasks.get(taskId);
    return state ? state.head : null;
  }

  end(taskId: string, status: TraceEndStatus): void {
    const state = this.tasks.get(taskId);
    if (!state) {
      this.tasks.set(taskId, { events: [], head: 0, ended: true, endStatus: status });
      return;
    }
    if (state.ended) return;
    state.ended = true;
    state.endStatus = status;
  }

  isEnded(taskId: string): boolean {
    return this.tasks.get(taskId)?.ended ?? false;
  }

  forget(taskId: string): void {
    this.tasks.delete(taskId);
  }
}

/** Serialized size of one event as a frame would carry it. */
export function traceEventBytes(event: TraceEvent): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}
