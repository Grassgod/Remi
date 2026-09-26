/**
 * Server-side sink for the daemon's live trace stream (MUL-401 §5).
 *
 * The path is: daemon TraceStore -> `trace.append` frame -> this interface ->
 * MUL-403's Live Hub -> `subscribe(taskId, fromSeq)` for browsers, Feishu CoT and
 * SSR. A-0 defines the seam and ships an in-memory implementation that A-6 wires
 * into the connection layer; C implements the real one.
 *
 * The one invariant that matters: the sequence on the wire is the daemon's
 * `trace_seq`, passed through untouched. This layer must never renumber, because
 * C's `subscribe(fromSeq)` cursor and MUL-402's file offsets all speak the
 * daemon's numbering.
 */

import type { TraceEvent } from "@multiremi/contracts/trace.js";

export interface TraceSinkAppendResult {
  head: number;
}

/**
 * A live subscription. `first_seq` is the oldest sequence this subscription can
 * still serve; `gap` is true when the caller asked for something older than that
 * and must backfill from the daemon through {@link DaemonTraceReader}.
 */
export interface TraceSinkSubscription {
  first_seq: number;
  head: number;
  gap: boolean;
  unsubscribe(): void;
}

export type TraceSinkListener = (taskId: string, events: TraceEvent[]) => void;

export interface TraceSink {
  /** Store events for a task and fan them out to subscribers. Returns the new head. */
  append(taskId: string, events: TraceEvent[]): TraceSinkAppendResult;

  /** Highest sequence this sink holds for the task, or null when it holds none. */
  head(taskId: string): number | null;

  /**
   * Subscribe to a task's events from `fromSeq` (exclusive), i.e. the next event
   * the caller wants is `fromSeq + 1`.
   *
   * A caller that is already current receives only future events. A caller whose
   * `fromSeq` predates {@link TraceSinkSubscription.first_seq} gets `gap: true`
   * and should read the missing range from the daemon; the subscription still
   * delivers everything it does hold, so a gap degrades the view instead of
   * silencing it.
   */
  subscribe(taskId: string, fromSeq: number, onEvents: TraceSinkListener): TraceSinkSubscription;

  /** Mark a task's stream finished so subscribers can stop waiting. Optional for implementations that learn this elsewhere. */
  end?(taskId: string): void;
}

interface SinkState {
  events: TraceEvent[];
  head: number;
  firstSeq: number;
  subscribers: Set<TraceSinkListener>;
  ended: boolean;
}

/**
 * In-memory {@link TraceSink}.
 *
 * Holds only the tail it was given and forgets nothing else; MUL-403 owns
 * retention, the browser contract and cross-process concerns. This exists so A-6
 * can prove the wiring end to end before C's Hub lands.
 */
export class InMemoryTraceSink implements TraceSink {
  private readonly tasks = new Map<string, SinkState>();

  append(taskId: string, events: TraceEvent[]): TraceSinkAppendResult {
    const state = this.tasks.get(taskId) ?? {
      events: [],
      head: 0,
      firstSeq: 1,
      subscribers: new Set<TraceSinkListener>(),
      ended: false,
    };
    this.tasks.set(taskId, state);

    const accepted: TraceEvent[] = [];
    for (const event of events) {
      // Drop anything already known. `<= head` is the only dedup rule needed:
      // sequences are dense and append-only, so a replayed frame is entirely
      // covered by the head.
      if (event.seq <= state.head) continue;
      state.events.push(event);
      state.head = event.seq;
      accepted.push(event);
    }
    if (accepted.length > 0) {
      for (const listener of [...state.subscribers]) listener(taskId, accepted);
    }
    return { head: state.head };
  }

  head(taskId: string): number | null {
    const state = this.tasks.get(taskId);
    return state ? state.head : null;
  }

  subscribe(taskId: string, fromSeq: number, onEvents: TraceSinkListener): TraceSinkSubscription {
    const state = this.tasks.get(taskId) ?? {
      events: [],
      head: 0,
      firstSeq: 1,
      subscribers: new Set<TraceSinkListener>(),
      ended: false,
    };
    this.tasks.set(taskId, state);

    const gap = fromSeq + 1 < state.firstSeq;
    const backlog = state.events.filter((event) => event.seq > fromSeq);
    if (backlog.length > 0) onEvents(taskId, backlog);

    let active = true;
    state.subscribers.add(onEvents);
    return {
      first_seq: state.firstSeq,
      head: state.head,
      gap,
      unsubscribe: () => {
        if (!active) return;
        active = false;
        state.subscribers.delete(onEvents);
      },
    };
  }

  end(taskId: string): void {
    const state = this.tasks.get(taskId);
    if (state) state.ended = true;
  }

  /** Test helper: forget the oldest events while keeping the head, which creates a gap. */
  dropBefore(taskId: string, seq: number): void {
    const state = this.tasks.get(taskId);
    if (!state) return;
    state.events = state.events.filter((event) => event.seq >= seq);
    state.firstSeq = Math.max(state.firstSeq, seq);
  }

  isEnded(taskId: string): boolean {
    return this.tasks.get(taskId)?.ended ?? false;
  }
}
