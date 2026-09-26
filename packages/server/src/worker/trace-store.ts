/**
 * Daemon-side storage for one task's normalized trace (MUL-401 §5).
 *
 * A-0 ships the interface and an in-memory implementation that tests and the
 * A-6 wiring use. MUL-402's `worker/trace-file-store.ts` implements the same
 * interface on disk; the interface is the contract between them, so it must not
 * grow a file-only concept (paths, rotations, fsync policy) and must not leak the
 * in-memory one (object identity, shared arrays).
 *
 * Two responsibilities live here rather than at the call sites, because this is
 * the only durable write point in the trace path (MUL-402 rulings 2 and 6b):
 *
 *   - **Sequencing.** `append` assigns the per-task `seq`. Dense, from 1, never
 *     rewritten; a retry that appends the same logical event gets a new sequence,
 *     so deduplication above this layer keys on the event, not the sequence.
 *   - **Sanitizing.** `append` applies the byte caps and structured-field guards
 *     from `@shared/trace-sanitize.js`. The frame and the file therefore carry
 *     identical, already-bounded events, and nothing downstream needs its own cap.
 *
 * `TraceEvent.ts` is assigned here too: the store is what knows the write time.
 */

import type { TraceEvent, TraceEventInput } from "@multiremi/contracts/trace.js";
import {
  cleanTraceField,
  parseStoredTraceJson,
  sanitizeTraceEventFields,
} from "@shared/trace-sanitize.js";

/** Result of appending: the new head plus the stored events with sequences bound. */
export interface TraceAppendResult {
  head: number;
  events: TraceEvent[];
}

/**
 * Result of a paginated read.
 *
 * `eof` means this page reached the current head, so a caller polling for more can
 * stop until it learns the head moved. Completeness is NOT reported here: the
 * single "no more events will be written" signal is `closed`, which lives on
 * {@link TraceStoreHead} and on the reader's result (MUL-402 ruling 3).
 */
export interface TraceReadResult {
  events: TraceEvent[];
  head: number;
  eof: boolean;
}

/**
 * The head and completeness of a task's trace.
 *
 * `closed` is the one boolean that says the trace is final — the trailer exists.
 * There is no terminator event and no `ended` flag anywhere in v2; a consumer that
 * needs to know "is the turn over" reads this field and nothing else.
 */
export interface TraceStoreHead {
  head: number;
  closed: boolean;
}

/** Terminal status recorded by {@link TraceStore.close}. */
export type TraceEndStatus = "completed" | "failed" | "cancelled";

export interface TraceCloseInput {
  status: TraceEndStatus;
  /** ISO 8601. The moment the turn ended, as the daemon observed it. */
  ended_at: string;
}

export interface TraceStore {
  /**
   * Append events to a task's trace.
   *
   * Takes `TraceEventInput` (which is `TraceEvent` without `seq`, and with an
   * **optional** `ts`) because the store owns the write:
   *
   *   - `seq` is always assigned here, densely from the current head;
   *   - `ts` is taken from the event when it carries one, and otherwise stamped
   *     from the store's clock. The live path never sets it, so the write time is
   *     used; the backfill always sets it to the row's `created_at`, so a
   *     reproduced turn keeps its original timestamps.
   *
   * The field caps and structured-field guards are applied here too, which makes
   * this the only sanitize point in the trace path.
   *
   * Appending to a closed task is a no-op that returns the existing head and an
   * empty array: a late frame must not reopen a closed trace, because the archive
   * that follows assumes the tail it saw is final.
   */
  append(taskId: string, events: TraceEventInput[]): TraceAppendResult;

  /**
   * Read events with `seq > afterSeq`, up to `limit` events and `maxBytes` of
   * serialized payload, whichever comes first. A single event larger than
   * `maxBytes` is still returned alone rather than deadlocking the reader.
   *
   * A task with no trace reads as `{ events: [], head: 0, eof: true }` rather than
   * throwing: an unknown task is a normal answer for a reader that raced the
   * daemon's registration.
   *
   * Backfilled traces keep their original sparse sequences, so `read` must not
   * assume a page's events are consecutive, nor that `events.length` equals
   * `head` (A11). Only freshly written traces are dense.
   */
  read(taskId: string, afterSeq?: number, limit?: number, maxBytes?: number): TraceReadResult;

  /**
   * Current head and completeness, or null when this store has never seen the
   * task. A null here is what makes a reader answer `trace_not_hot`.
   */
  head(taskId: string): TraceStoreHead | null;

  /**
   * Mark a task's trace final by writing the trailer. Idempotent; the first call
   * wins, so a retried completion cannot rewrite the recorded status.
   */
  close(taskId: string, end: TraceCloseInput): void;

  /** Drop a task's trace. Used for GC, not for task completion. */
  forget(taskId: string): void;
}

export const TRACE_READ_DEFAULT_LIMIT = 200;
export const TRACE_READ_MAX_LIMIT = 500;

interface TraceState {
  events: TraceEvent[];
  head: number;
  closed: boolean;
  end: TraceCloseInput | null;
}

/** Injectable clock so tests can assert the `ts` the store assigns. */
export type TraceClock = () => string;

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

  constructor(private readonly now: TraceClock = () => new Date().toISOString()) {}

  private stateFor(taskId: string): TraceState {
    const existing = this.tasks.get(taskId);
    if (existing) return existing;
    const created: TraceState = { events: [], head: 0, closed: false, end: null };
    this.tasks.set(taskId, created);
    return created;
  }

  append(taskId: string, events: TraceEventInput[]): TraceAppendResult {
    const existing = this.tasks.get(taskId);
    if (existing?.closed) return { head: existing.head, events: [] };
    const state = this.stateFor(taskId);

    const stored: TraceEvent[] = [];
    for (const event of events) {
      // The event's own `ts` wins: that is how a backfill keeps `created_at`.
      const row = sanitizeStoredEvent(event, event.ts ?? this.now());
      state.head += 1;
      const sequenced: TraceEvent = { ...row, seq: state.head };
      state.events.push(sequenced);
      stored.push(sequenced);
    }
    return { head: state.head, events: stored };
  }

  read(
    taskId: string,
    afterSeq = 0,
    limit = TRACE_READ_DEFAULT_LIMIT,
    maxBytes = Number.MAX_SAFE_INTEGER,
  ): TraceReadResult {
    const state = this.tasks.get(taskId);
    if (!state) return { events: [], head: 0, eof: true };

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
    // Written traces are dense, so the last returned seq tells the truth. A
    // backfilled trace is sparse and this stays a best-effort answer; callers that
    // need exactness compare against `head`.
    const lastSeq = events.at(-1)?.seq ?? afterSeq;
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
    state.end = end;
  }

  /** The recorded trailer, for tests and for a caller that wants the status. */
  endInfo(taskId: string): TraceCloseInput | null {
    return this.tasks.get(taskId)?.end ?? null;
  }

  forget(taskId: string): void {
    this.tasks.delete(taskId);
  }
}

/**
 * Apply the shared caps and turn serialized structured fields back into values.
 *
 * The stored `input` / `meta` are JSON text, matching the historical column; a
 * field whose cap fired cannot be parsed back and becomes null, which is what the
 * API answers for the same row today.
 */
export function sanitizeStoredEvent(event: TraceEventInput, ts: string): Omit<TraceEvent, "seq"> {
  const fields = sanitizeTraceEventFields({
    type: typeof event.type === "string" ? event.type : "text",
    tool: event.tool,
    content: event.content,
    input: event.input,
    output: event.output,
    tool_call_id: event.tool_call_id,
    status: event.status,
    meta: event.meta,
  });
  return {
    ts,
    type: fields.type,
    tool: fields.tool,
    content: fields.content,
    input: parseStoredTraceJson<Record<string, unknown>>(fields.input),
    output: fields.output,
    tool_call_id: cleanTraceField(fields.tool_call_id),
    status: fields.status,
    meta: parseStoredTraceJson<Record<string, unknown>>(fields.meta),
  };
}

/** Serialized size of one event as a frame would carry it. */
export function traceEventBytes(event: TraceEvent): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}
