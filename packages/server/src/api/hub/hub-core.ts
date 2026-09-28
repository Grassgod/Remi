/**
 * The Live Hub itself (MUL-403 §1, C1 / MUL-436).
 *
 * One hub per API process fans out two ordered streams whose home is decided per
 * kind (ADR 0007 decision 1):
 *
 *   - `log:<session_id>` — MUL-402's conversation log. The database owns the
 *     sequence; a peer process sends only a head pointer, and a process that holds
 *     the stream reads `(local_head, head]` through an injected reader.
 *   - `trace:<task_id>` — MUL-401's daemon trace. It has exactly one home, the
 *     runtime process the daemon is connected to, so it never crosses a process.
 *
 * The hub assigns no sequence: a frame carries the sequence its owner gave it,
 * `<= head` is a replay (dropped and counted), and `!= head + 1` is a hole that
 * waits {@link HUB_HOLE_WAIT_MS} before the reader fills it.
 *
 * ## Why the fan-out is shaped this way
 *
 * An API process serves HTTP and fan-out on one event loop, so an append must
 * never wait for a subscriber:
 *
 *   - `append` / `onEntry` enqueue, mark the stream dirty and return.
 *   - A `setImmediate`-merged flush does the fan-out. One tick hands each
 *     subscriber **one batch frame**, capped at {@link HUB_BATCH_MAX_BYTES}; a
 *     single frame larger than the cap travels alone, because a subscriber cannot
 *     reassemble half a frame.
 *   - A subscriber whose sink reports more than {@link HUB_LAGGING_THRESHOLD_BYTES}
 *     buffered is paused until its transport calls `notifyDrain()`.
 *   - Frames are serialized once, on the way into the ring, and every subscriber
 *     receives that same frame object.
 *
 * ## What a subscriber is told when the ring cannot serve it
 *
 * Falling behind is not an error. The ring is a window, so a subscriber whose
 * cursor left it is told the missing range and reads that range from the route
 * that owns it (the browser from MUL-402's log windows, A-6 from the daemon's
 * `trace.fetch`). The hub never reads for a subscriber. The reads it performs
 * repair its own ring: cold-stream warm-up, peer head fill, continuity fill.
 */

import { parseHubStreamKey } from "@multiremi/contracts/live-hub.js";
import type {
  HubFrame,
  HubFrameListener,
  HubSeqRange,
  HubStreamKey,
  HubSubscription,
} from "@multiremi/contracts/live-hub.js";
import type { TraceEvent } from "@multiremi/contracts/trace.js";
import type {
  TraceSinkAppendResult,
  TraceSinkListener,
  TraceSinkSubscription,
} from "@multiremi/api/trace/trace-sink.js";
import type { HubTransport } from "./hub-transport.js";
import {
  HUB_RING_LIMITS,
  HubRingBuffer,
  type HubRingLimits,
  type HubRingStream,
} from "./ring-buffer.js";
import type {
  B0ConversationLogEntry,
  ConversationLogPatch,
  HumanRequestEvent,
  HumanRequestListener,
  LiveHub,
} from "./live-hub.js";

/** The API process role. MUL-461's `ApiRole` takes this name over when it reaches main. */
export type HubRole = "all" | "ui" | "runtime";

/** Largest batch frame the hub hands one subscriber in one `send`. */
export const HUB_BATCH_MAX_BYTES = 64 * 1024;
/** Buffered bytes above which a subscriber is paused as lagging. */
export const HUB_LAGGING_THRESHOLD_BYTES = 512 * 1024;
/** How long a hole may stay open before the reader is asked to close it. */
export const HUB_HOLE_WAIT_MS = 500;
/** Frames one cold `log:` stream prefills from the read pool. */
export const HUB_WARMUP_FRAMES = 64;
/** Frames one reader call may push, so a repair cannot stall the event loop. */
export const HUB_MAX_FILL_FRAMES = 4096;
/** Streams this process remembers a remote head for. */
export const HUB_KNOWN_HEAD_LIMIT = 1024;
/** Flush durations kept for the `/health` p95. */
export const HUB_FLUSH_SAMPLES = 256;
/** Hole waits kept for the `/readyz` p95. */
export const HUB_HOLE_WAIT_SAMPLES = 256;
/** Non-initial row revisions remembered per consumer; forgotten bases need gaps. */
const HUB_DELIVERED_REVISION_LIMIT = 1024;
/** Keep the newest 1024 delivered islands, independent of gaps or online time. */
const HUB_DELIVERED_RANGE_LIMIT = 1024;

/**
 * The read side the hub may use.
 *
 * One injectable object rather than a pool reference: this issue ships the hub
 * with fakes, and v2 integration points the same seam at B1's repo functions and
 * C4's `readPool.query`. The hub never builds SQL, which is what keeps the real
 * `readRange` statement in the one place that owns it (MUL-402 `cmt_mzsa67algpsl` §4).
 */
export interface HubFillReader {
  /** `log:` head and freshness token for a session, or null when it has no rows. */
  logHead(sessionId: string): Promise<{ head: number; log_version: number | null } | null>;
  /** `trace:` head the owning daemon reports, or null when it does not hold the task. */
  traceHead(taskId: string): Promise<number | null>;
  /** Frames with `afterSeq < seq <= toSeq`, oldest first. An empty answer is normal. */
  readRange(key: HubStreamKey, afterSeq: number, toSeq: number): Promise<HubFrame[]>;
}

/**
 * Where a subscription's frames go.
 *
 * `getBufferedAmount` is the transport's own backlog (Bun's
 * `WebSocket.getBufferedAmount()`), which turns backpressure into the hub's
 * decision instead of the socket's. `gap` is optional so an in-process listener
 * with nowhere to put that information can leave it out.
 */
export interface HubSubscriberSink {
  getBufferedAmount(): number;
  send(frames: readonly HubFrame[]): void;
  gap?(from: number, to: number): void;
}

/** A keyed subscription over a backpressure-aware sink. */
export interface HubSinkSubscription extends HubSubscription {
  /**
   * The transport drained: resume from `cursor + 1`.
   *
   * A resume point that has already left the ring is reported through the sink's
   * `gap` and the subscription continues from the ring tail, so a slow subscriber
   * degrades to "backfill this range" instead of silently skipping frames.
   */
  notifyDrain(): void;
}

export interface HubLimits {
  ring: HubRingLimits;
  batchBytes: number;
  laggingBytes: number;
  holeWaitMs: number;
  warmupFrames: number;
  maxFillFrames: number;
  knownHeadLimit: number;
}

export const HUB_LIMITS: HubLimits = {
  ring: HUB_RING_LIMITS,
  batchBytes: HUB_BATCH_MAX_BYTES,
  laggingBytes: HUB_LAGGING_THRESHOLD_BYTES,
  holeWaitMs: HUB_HOLE_WAIT_MS,
  warmupFrames: HUB_WARMUP_FRAMES,
  maxFillFrames: HUB_MAX_FILL_FRAMES,
  knownHeadLimit: HUB_KNOWN_HEAD_LIMIT,
};

export interface HubOptions {
  transport: HubTransport;
  /** Reported through `/readyz`; behaviour does not depend on it. */
  role?: HubRole;
  /** The repair reader. Absent means "serve only what was handed to me". */
  fill?: HubFillReader | null;
  limits?: Partial<Omit<HubLimits, "ring">> & { ring?: Partial<HubRingLimits> };
  now?: () => number;
  /** Injected so tests drive flush timing by hand. Defaults to `setImmediate`. */
  scheduleFlush?: (callback: () => void) => void;
  /** Injected so tests drive the 500ms hole window without a wall clock. */
  scheduleHole?: (callback: () => void, delayMs: number) => unknown;
  onWarn?: (message: string) => void;
}

/** The state `/health` and `/readyz` publish (plan 2/6 §1, item 9). */
export interface HubSnapshot {
  role: HubRole;
  transport: string;
  streams: number;
  frames: number;
  ring_bytes: number;
  known_heads: number;
  subscriptions: number;
  lagging_subscribers: number;
  flush_p95_ms: number;
  flush_samples: number;
  fill_count: number;
  fill_failures: number;
  hole_waits: number;
  hole_wait_ms: number;
  dropped_frames: number;
  pending_frames: number;
  evicted_streams: number;
}

/** A hub that can describe itself; what the API's health routes ask for. */
export interface ObservableLiveHub extends LiveHub {
  snapshot(): HubSnapshot;
}

/** What this process remembers about a stream it does not hold. */
export interface HubKnownHead {
  head: number;
  log_version: number | null;
  at: number;
}

/** One subscriber: its cursor, its backpressure state and its destination. */
interface HubSubscriber {
  readonly key: HubStreamKey;
  readonly sink: HubSubscriberSink;
  /**
   * The `fromSeq` the subscription was created with.
   *
   * Kept beside `cursor` because the two answer different questions. `cursor` is
   * delivery bookkeeping and moves as frames are handed over; the numbers a
   * subscription *reports* (`first_seq`, `gap`) describe the request, and A-0 types
   * `first_seq` as fixed at subscribe time for exactly that reason — a caller
   * building an ack after a replay started must not see its gap shrink under it.
   */
  readonly requested: number;
  /** Replay cursor, advanced by both delivery and gap notifications. */
  cursor: number;
  /** Contiguous ranges actually delivered; gap-skipped rows are never patch bases. */
  readonly delivered: HubSeqRange[];
  /** Revision 1 needs no slot; higher revisions are bounded and tied to held bases. */
  readonly deliveredRevisions: Map<number, number>;
  /** Edits that require a reread, bounded to one conservative range while paused. */
  changeGap: HubSeqRange | null;
  lagging: boolean;
  active: boolean;
  /** Set for A-0's spelling, which wants `TraceEvent`s rather than hub frames. */
  readonly traceListener: TraceSinkListener | null;
  readonly traceTaskId: string | null;
}

/** A frame that arrived out of order and waits for the sequence before it. */
interface PendingFrame {
  readonly frame: HubFrame;
  readonly at: number;
}

interface LiveChange {
  readonly frame: HubFrame;
  readonly fieldRevisions: Map<string, number>;
}

function defaultWarn(message: string): void {
  // `console.warn` rather than the shared logger: the hub is constructed before
  // the API's logger in some harnesses, and a dropped-frame warning must never be
  // the thing that throws on the hot path.
  console.warn(`[live-hub] ${message}`);
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isConversationLogPatch(
  entry: B0ConversationLogEntry | ConversationLogPatch,
): entry is ConversationLogPatch {
  return "target_seq" in entry;
}

/**
 * The real hub.
 *
 * `EmptyLiveHub` in `./live-hub.js` stays as the degenerate implementation C0
 * shipped; this is what production, C3 and A-6 use.
 */
export class HubImpl implements ObservableLiveHub {
  readonly transport: HubTransport;
  readonly role: HubRole;
  readonly limits: HubLimits;

  private readonly ring: HubRingBuffer;
  private readonly fill: HubFillReader | null;
  private readonly now: () => number;
  private readonly scheduleFlush: (callback: () => void) => void;
  private readonly scheduleHole: (callback: () => void, delayMs: number) => unknown;
  private readonly warn: (message: string) => void;
  private readonly subscribers = new Map<HubStreamKey, Set<HubSubscriber>>();
  private readonly pending = new Map<HubStreamKey, PendingFrame[]>();
  private readonly holeTimers = new Map<HubStreamKey, unknown>();
  private readonly filling = new Set<HubStreamKey>();
  private readonly warmed = new Set<HubStreamKey>();
  private readonly warming = new Set<HubStreamKey>();
  private readonly knownHeads = new Map<HubStreamKey, HubKnownHead>();
  private readonly humanRequestListeners = new Map<string, Set<HumanRequestListener>>();
  /**
   * Frames that describe a change to a sequence the ring already holds.
   *
   * A `log:` patch keeps its row's `seq`, so it is not a new sequence and does not
   * belong in the contiguous window — but it *is* news for whoever is already
   * watching, and dropping it as a "replay" would lose every in-place edit. These
   * are delivered to active subscribers on the next flush and then forgotten.
   */
  private readonly liveChanges = new Map<HubStreamKey, LiveChange[]>();
  private readonly flushSamples: number[] = [];
  private readonly holeWaitSamples: number[] = [];
  private readonly closedTasks = new Set<string>();
  private readonly transportSubscription: { unsubscribe(): void };
  private flushDirty = new Set<HubStreamKey>();
  private flushScheduled = false;
  private closed = false;

  private fillCount = 0;
  private fillFailures = 0;
  private droppedFrames = 0;
  private holeWaits = 0;
  private evictedStreams = 0;

  constructor(options: HubOptions) {
    this.transport = options.transport;
    this.role = options.role ?? "all";
    this.fill = options.fill ?? null;
    this.limits = {
      ...HUB_LIMITS,
      ...options.limits,
      ring: { ...HUB_LIMITS.ring, ...options.limits?.ring },
    };
    this.now = options.now ?? Date.now;
    this.scheduleFlush = options.scheduleFlush ?? ((callback) => { setImmediate(callback); });
    this.scheduleHole = options.scheduleHole ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.warn = options.onWarn ?? defaultWarn;
    this.ring = new HubRingBuffer(this.limits.ring, this.now);
    // Remote frames enter the local ring first, so ordering stays the hub's job
    // rather than the transport's.
    this.transportSubscription = this.transport.subscribe((input) => {
      this.enqueue(input.key, input.frames, "remote");
    });
  }

  // ── Writes ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Store trace events for a task.
   *
   * The sequence belongs to the daemon: `seq <= head` is a replay and is counted
   * as dropped, `seq == head + 1` is stored, and a jump becomes a hole that waits
   * for the sequence before it. This method invents no sequence.
   */
  append(taskId: string, events: TraceEvent[]): TraceSinkAppendResult {
    const key = traceKey(taskId);
    const frames: HubFrame[] = events.map((event) => ({
      seq: event.seq,
      kind: "trace",
      payload: event,
    }));
    this.enqueue(key, frames, "local");
    return { head: this.ring.get(key)?.headSeq ?? 0 };
  }

  /**
   * Highest sequence this hub holds frames for, or null when it holds none.
   *
   * A cold trace stream's warm-up learns a head from the daemon without holding any
   * of its events, so the learned number lives beside the ring and is reported only
   * through the subscription: A-0 types this method as "what this sink holds", and
   * answering with a number whose frames are somewhere else would make a caller
   * believe it can read them here.
   */
  head(taskId: string): number | null {
    const stream = this.ring.get(traceKey(taskId));
    return stream && stream.headSeq > 0 ? stream.headSeq : null;
  }

  /**
   * MUL-402 B1's write hook: an insert, or an in-place update after `revision++`.
   *
   * An entry carries its own `seq`; a patch keeps the `seq` of the row it patches,
   * so it is fanned out to the subscribers already holding that row and marks
   * the retained copy stale rather than extending the window.
   */
  onEntry(sessionId: string, entry: B0ConversationLogEntry | ConversationLogPatch): void {
    const key = `log:${sessionId}` as HubStreamKey;
    const patch = isConversationLogPatch(entry);
    const frame: HubFrame = {
      seq: patch ? entry.target_seq : entry.seq,
      kind: patch ? "patch" : "entry",
      payload: entry,
    };
    this.enqueue(key, [frame], "local");
  }

  /**
   * A-0's completeness signal.
   *
   * Establishes the closed state for a task nobody has appended to as well: a
   * zero-event turn, or a cold hub that sees the completion frame before any
   * `trace.append`, would otherwise leave a subscriber waiting on `closed`
   * forever.
   */
  close(taskId: string): void {
    this.closedTasks.add(taskId);
    this.ring.ensure(traceKey(taskId)).closed = true;
  }

  /** Whether `close` has run for this task. Test helper and diagnostics. */
  isClosed(taskId: string): boolean {
    return this.closedTasks.has(taskId);
  }

  /**
   * A `log:` head pointer from the peer process (ADR 0007 decision 1, item 6).
   *
   * A stream this process holds is repaired: the missing `(local head, head]` is
   * read through the injected reader and fanned out. A stream it does not hold is
   * only remembered — the subscriber that arrives later warms up from the database.
   *
   * Returns the number of frames the fill pushed, so the transport can report the
   * repair without reaching into the ring.
   */
  async applyRemoteHead(
    key: HubStreamKey,
    head: number,
    logVersion: number | null = null,
  ): Promise<number> {
    const stream = this.ring.get(key);
    if (!stream) {
      this.rememberHead(key, head, logVersion);
      return 0;
    }
    this.ring.touch(stream);
    this.rememberHead(key, head, logVersion);
    if (head <= stream.headSeq) {
      // Already current. The freshness token still gets refreshed: a peer's
      // versioned head is newer information than whatever this ring stamped last.
      if (head === stream.headSeq) this.stampLogVersion(stream, head, logVersion);
      return 0;
    }
    // A pointer may arrive before the frames it names, so it also arms the
    // continuity buffer for a hole that is already waiting behind this head.
    this.armHoleTimer(key);
    const queued = this.pending.get(key)?.[0];
    const ceiling = queued ? queued.frame.seq - 1 : head;
    let pushed = 0;
    if (ceiling > stream.headSeq) pushed = await this.fillFrom(key, stream.headSeq, ceiling);
    await this.drainPending(key);
    this.stampLogVersion(stream, head, logVersion);
    this.scheduleFlushFor(key);
    return pushed;
  }

  // ── Subscriptions ───────────────────────────────────────────────────────────────────────────

  subscribe(key: HubStreamKey, fromSeq: number, onFrames: HubFrameListener): HubSubscription;
  subscribe(taskId: string, fromSeq: number, onEvents: TraceSinkListener): TraceSinkSubscription;
  subscribe(
    keyOrTaskId: string,
    fromSeq: number,
    onEvents: HubFrameListener | TraceSinkListener,
  ): HubSubscription | TraceSinkSubscription {
    return parseHubStreamKey(keyOrTaskId)
      ? this.subscribeWithSink(
        keyOrTaskId as HubStreamKey,
        fromSeq,
        listenerSink(keyOrTaskId as HubStreamKey, onEvents as HubFrameListener),
      )
      : this.subscribeTraceSink(keyOrTaskId, fromSeq, onEvents as TraceSinkListener);
  }

  /**
   * Keyed subscription over a backpressure-aware sink — the shape C3's browser
   * socket and A-6's daemon handler use.
   *
   * Returns immediately; a cold stream warms up in the background. What the
   * warm-up discovers is announced through the sink's `gap`, because the
   * synchronous ack the caller already sent cannot carry news that had not
   * arrived yet.
   */
  subscribeWithSink(key: HubStreamKey, fromSeq: number, sink: HubSubscriberSink): HubSinkSubscription {
    const stream = this.ring.ensure(key);
    this.ring.touch(stream);
    const subscriber = this.newSubscriber(key, fromSeq, sink, null, null);
    // Whatever the ring cannot serve is reported through `gap` (the caller puts it
    // in its ack) and the replay starts after it: plan 2/6's rule is that a
    // subscriber which falls behind gets the range *and* everything the ring still
    // holds, so the view degrades instead of going silent.
    this.skipUnservable(subscriber, stream);
    // A subscription that starts behind the head is a replay, and a replay is
    // delivered the same way a live frame is: one batch per flush tick. Without
    // this the backlog would wait for the next write, which may never come.
    this.scheduleFlushFor(key);
    void this.ensureWarm(key);
    return {
      get first_seq() { return firstServableSeq(stream); },
      get head() { return stream.headSeq; },
      get log_version() { return stream.kind === "log" ? stream.logVersion : null; },
      get gap() { return gapFor(stream, subscriber.requested); },
      unsubscribe: () => { this.removeSubscriber(subscriber); },
      notifyDrain: () => { this.resume(subscriber); },
    };
  }

  /** A-0's spelling: the same trace stream, addressed by a bare task id. */
  private subscribeTraceSink(
    taskId: string,
    fromSeq: number,
    onEvents: TraceSinkListener,
  ): TraceSinkSubscription {
    const key = traceKey(taskId);
    const stream = this.ring.ensure(key);
    stream.closed = stream.closed || this.closedTasks.has(taskId);
    this.ring.touch(stream);
    // The listener spelling has no sink of its own, so `gap`/`head`/`closed` must
    // be read off the subscription — which is exactly why A-0 types them as live
    // getters rather than snapshot fields.
    const subscriber = this.newSubscriber(key, fromSeq, listenerSink(key, () => {}), onEvents, taskId);
    this.skipUnservable(subscriber, stream);
    this.scheduleFlushFor(key);
    void this.ensureWarm(key);
    return {
      get first_seq() { return firstServableSeq(stream); },
      get head() { return stream.headSeq; },
      get gap() { return hasUnservableAfter(stream, subscriber.requested); },
      get closed() { return stream.closed; },
      unsubscribe: () => { this.removeSubscriber(subscriber); },
    };
  }

  /** MUL-400 E5: process-local fan-out of the human-request lifecycle. */
  subscribeHumanRequests(workspaceId: string, onEvent: HumanRequestListener): { unsubscribe(): void } {
    let listeners = this.humanRequestListeners.get(workspaceId);
    if (!listeners) {
      listeners = new Set();
      this.humanRequestListeners.set(workspaceId, listeners);
    }
    listeners.add(onEvent);
    return {
      unsubscribe: () => {
        const current = this.humanRequestListeners.get(workspaceId);
        if (!current) return;
        current.delete(onEvent);
        if (current.size === 0) this.humanRequestListeners.delete(workspaceId);
      },
    };
  }

  /**
   * Publish one human-request transition to this process's subscribers.
   *
   * The write side of {@link subscribeHumanRequests}: MUL-400 E5's writers call it,
   * and the peer adapter calls it for events that arrived from the runtime process.
   * `reminder_due` never comes through here — the bot host derives it from
   * `expires_at` on its own timer.
   */
  publishHumanRequest(event: HumanRequestEvent): void {
    const listeners = this.humanRequestListeners.get(event.workspace_id);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.warn(`human request listener threw for ${event.request_id}: ${errorText(error)}`);
      }
    }
  }

  /** True while any subscriber is attached to the stream. */
  hasSubscribers(key: HubStreamKey): boolean {
    return (this.subscribers.get(key)?.size ?? 0) > 0;
  }

  /** True once the stream was warmed up from the reader at least once. */
  isWarm(key: HubStreamKey): boolean {
    return this.warmed.has(key);
  }

  /** Wait for in-flight warm-ups to settle. Tests only; the hot path never blocks. */
  async warmUpSettled(): Promise<void> {
    for (let guard = 0; guard < 10_000 && this.warming.size > 0; guard += 1) {
      await new Promise<void>((resolve) => { setImmediate(resolve); });
    }
  }

  // ── Diagnostics ─────────────────────────────────────────────────────────────────────────────

  snapshot(): HubSnapshot {
    let lagging = 0;
    let subscriptions = 0;
    for (const set of this.subscribers.values()) {
      subscriptions += set.size;
      for (const subscriber of set) if (subscriber.lagging) lagging += 1;
    }
    let pending = 0;
    for (const frames of this.pending.values()) pending += frames.length;
    // `dropped_frames` is the hub-wide total, counted once per rejected frame. The
    // per-stream counters exist for a future per-stream diagnostic and are
    // deliberately not added in: summing both would report every drop twice.
    return {
      role: this.role,
      transport: this.transport.kind,
      streams: this.ring.streamCount,
      frames: this.ring.frameCount,
      ring_bytes: this.ring.totalBytes,
      known_heads: this.knownHeads.size,
      subscriptions,
      lagging_subscribers: lagging,
      flush_p95_ms: percentile(this.flushSamples, 0.95),
      flush_samples: this.flushSamples.length,
      fill_count: this.fillCount,
      fill_failures: this.fillFailures,
      hole_waits: this.holeWaits,
      hole_wait_ms: percentile(this.holeWaitSamples, 0.95),
      dropped_frames: this.droppedFrames,
      pending_frames: pending,
      evicted_streams: this.evictedStreams,
    };
  }

  /** The head this process remembers for a stream it does not hold. */
  knownHead(key: HubStreamKey): HubKnownHead | null {
    const known = this.knownHeads.get(key);
    if (!known) return null;
    // Reading a known head is an access, so the cap evicts genuinely cold ones.
    this.knownHeads.delete(key);
    this.knownHeads.set(key, known);
    return known;
  }

  /** Run a scheduled flush now. Tests and diagnostics only. */
  flushNow(): void {
    this.flushScheduled = false;
    this.flush();
  }

  /**
   * Stop delivering, drop every subscriber and release the transport subscription.
   *
   * Named `shutdown` rather than `close` because `close` is A-0's per-task
   * completeness signal (see above) and the two mean entirely different things.
   */
  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    for (const timer of this.holeTimers.values()) clearTimeout(timer as never);
    this.holeTimers.clear();
    for (const set of this.subscribers.values()) {
      for (const subscriber of set) subscriber.active = false;
    }
    this.subscribers.clear();
    this.flushDirty.clear();
    this.liveChanges.clear();
    this.transportSubscription.unsubscribe();
  }

  // ── Enqueue, continuity and fill ────────────────────────────────────────────────────────────

  /**
   * Put frames into a stream's ring, in order, waiting out any hole.
   *
   * Remote frames take this exact path, so a peer's frame is deduped and buffered
   * like a local one — the transport does not get to assume contiguity.
   */
  private enqueue(key: HubStreamKey, frames: readonly HubFrame[], origin: "local" | "remote"): void {
    if (this.closed || frames.length === 0) return;
    const stream = this.ring.ensure(key);
    let dirty = false;
    let dropped = 0;
    for (const frame of frames) {
      if (frame.kind === "patch") {
        // A patch only exists for `log:` streams (B1's in-place update) and keeps
        // its row's seq, so it is news for a peer without being a new sequence: the
        // adapter turns it into the same head pointer as an insert.
        //
        // It does *not* replace the retained frame: a patch carries only the fields
        // that changed, and nothing in this process can rebuild the row from it. So
        // the window keeps its entry and the sequence is flagged stale — a live
        // subscriber that holds the row gets the patch, and one that replays that
        // position is told a `gap` instead of being served a fragment.
        this.ring.markStale(stream, frame.seq);
        this.queueLiveChange(key, frame);
        // Retention only controls replay. Active subscribers may hold a base
        // long after it left the ring, so every edit must reach the flush.
        dirty = true;
        if (origin === "local" && stream.kind === "log") this.transport.publish({ key, frames: [frame] });
        continue;
      }
      if (frame.seq <= stream.headSeq) {
        // Replay: everything at or below the head is already retained.
        dropped += 1;
        continue;
      }
      if (frame.seq === stream.headSeq + 1) {
        this.push(stream, frame, origin === "local");
        dirty = true;
        continue;
      }
      this.bufferPending(key, frame);
    }
    if (dropped > 0) {
      stream.droppedFrames += dropped;
      this.droppedFrames += dropped;
    }
    // An accepted frame can be the sequence a buffered frame was waiting for, so
    // the buffer is drained here rather than only on the hole timer.
    if (dirty && (this.pending.get(key)?.length ?? 0) > 0) this.drainPendingNow(key);
    if (dirty) this.scheduleFlushFor(key);
    this.evictOverBudget();
  }

  private queueLiveChange(key: HubStreamKey, frame: HubFrame): void {
    const incoming = frame.payload as ConversationLogPatch;
    const change: LiveChange = {
      frame,
      fieldRevisions: new Map(Object.keys(incoming.fields).map((field) => [field, incoming.revision])),
    };
    const list = this.liveChanges.get(key);
    if (!list) {
      this.liveChanges.set(key, [change]);
      return;
    }
    const index = list.findIndex((existing) => existing.frame.seq === frame.seq);
    if (index >= 0) {
      const existing = list[index]!;
      const previous = existing.frame.payload as ConversationLogPatch;
      const fields = { ...previous.fields };
      const fieldRevisions = new Map(existing.fieldRevisions);
      // A merged frame's revision does not describe every field in its delta.
      for (const [field, value] of Object.entries(incoming.fields)) {
        if (incoming.revision >= (fieldRevisions.get(field) ?? -1)) {
          Object.assign(fields, { [field]: value });
          fieldRevisions.set(field, incoming.revision);
        }
      }
      list[index] = {
        frame: { ...frame, payload: { ...previous, revision: Math.max(previous.revision, incoming.revision), fields } },
        fieldRevisions,
      };
    } else {
      list.push(change);
      list.sort((a, b) => a.frame.seq - b.frame.seq);
    }
  }

  private bufferPending(key: HubStreamKey, frame: HubFrame): void {
    let list = this.pending.get(key);
    if (!list) {
      list = [];
      this.pending.set(key, list);
    }
    if (list.some((entry) => entry.frame.seq === frame.seq)) {
      const stream = this.ring.get(key);
      if (stream) stream.droppedFrames += 1;
      this.droppedFrames += 1;
      return;
    }
    list.push({ frame, at: this.now() });
    list.sort((a, b) => a.frame.seq - b.frame.seq);
    this.armHoleTimer(key);
  }

  /** The 500ms window: the reader gets one chance to close the hole. */
  private armHoleTimer(key: HubStreamKey): void {
    if (this.closed || this.holeTimers.has(key)) return;
    const timer = this.scheduleHole(() => {
      this.holeTimers.delete(key);
      void this.closeHole(key);
    }, this.limits.holeWaitMs);
    this.holeTimers.set(key, timer);
  }

  private async closeHole(key: HubStreamKey): Promise<void> {
    if (this.closed) return;
    const first = this.pending.get(key)?.[0];
    if (!first) return;
    this.holeWaits += 1;
    this.holeWaitSamples.push(Math.max(0, this.now() - first.at));
    if (this.holeWaitSamples.length > HUB_HOLE_WAIT_SAMPLES) this.holeWaitSamples.shift();

    // The missing sequence may have arrived while the timer ran.
    if (await this.drainPending(key)) {
      if ((this.pending.get(key)?.length ?? 0) > 0) this.armHoleTimer(key);
      return;
    }
    const stream = this.ring.get(key);
    const next = this.pending.get(key)?.[0];
    if (!stream || !next) return;
    const wanted = next.frame.seq;
    if (wanted > stream.headSeq + 1 && this.fill && !this.filling.has(key)) {
      this.filling.add(key);
      try {
        const ceiling = Math.min(wanted - 1, stream.headSeq + this.limits.maxFillFrames);
        await this.fillFrom(key, stream.headSeq, ceiling);
      } finally {
        this.filling.delete(key);
      }
      if (await this.drainPending(key)) {
        if ((this.pending.get(key)?.length ?? 0) > 0) this.armHoleTimer(key);
        return;
      }
    }
    const latest = this.ring.get(key);
    const rest = this.pending.get(key)?.[0];
    if (!latest || !rest) return;
    if (rest.frame.seq <= latest.headSeq + 1) {
      await this.drainPending(key);
      return;
    }
    // The hole could not be closed: tell the subscribers the range that is gone,
    // then restart the window at the pending frame. A ring that claims a range it
    // does not hold is worse than a short ring.
    this.fillFailures += 1;
    this.emitGap(key, latest.headSeq + 1, rest.frame.seq - 1);
    latest.trimmedFrames += latest.entries.length;
    this.ring.refound(latest, rest.frame.seq);
    await this.drainPending(key);
    if ((this.pending.get(key)?.length ?? 0) > 0) this.armHoleTimer(key);
  }

  /**
   * Push every pending frame that has become contiguous, in order.
   *
   * Synchronous: it touches no I/O, so the enqueue path can call it directly and
   * the asynchronous callers (`closeHole`, `applyRemoteHead`) simply await the
   * boolean it returns.
   */
  private drainPending(key: HubStreamKey): Promise<boolean> {
    return Promise.resolve(this.drainPendingNow(key));
  }

  private drainPendingNow(key: HubStreamKey): boolean {
    const stream = this.ring.get(key);
    const list = this.pending.get(key);
    if (!stream || !list || list.length === 0) return false;
    let pushed = false;
    for (;;) {
      const next = list[0];
      if (!next) break;
      if (next.frame.seq <= stream.headSeq) {
        list.shift();
        stream.droppedFrames += 1;
        this.droppedFrames += 1;
        continue;
      }
      if (next.frame.seq !== stream.headSeq + 1) break;
      list.shift();
      this.push(stream, next.frame, true);
      pushed = true;
    }
    if (list.length === 0) this.pending.delete(key);
    if (pushed) this.scheduleFlushFor(key);
    return pushed;
  }

  /**
   * Read `(afterSeq, toSeq]` through the injected reader and push what comes back.
   *
   * `bootstrap` is for the cold-start case: the hub asked for a specific range and
   * the ring holds nothing at all, so the first frame that comes back *becomes* the
   * window's base rather than being rejected for not following a head the hub never
   * had. Without it a cold session longer than the warm-up window could never fill
   * at all — the prefill starts above sequence 1 by definition.
   */
  private async fillFrom(
    key: HubStreamKey,
    afterSeq: number,
    toSeq: number,
    bootstrap = false,
  ): Promise<number> {
    if (!this.fill || toSeq <= afterSeq || this.closed) return 0;
    if (!this.ring.get(key)) return 0;
    let frames: HubFrame[];
    try {
      frames = await this.fill.readRange(key, afterSeq, toSeq);
    } catch (error) {
      this.fillFailures += 1;
      this.warn(`fill failed for ${key}: ${errorText(error)}`);
      return 0;
    }
    if (frames.length === 0) return 0;
    let pushed = 0;
    for (const frame of frames.slice(0, this.limits.maxFillFrames)) {
      const current = this.ring.get(key);
      if (!current) return pushed;
      if (frame.seq <= current.headSeq) continue;
      if (frame.seq !== current.headSeq + 1) {
        if (bootstrap) {
          // A cold reader may return several readable segments. Retain each one;
          // replay checks every discontinuity and reports the intervening gap.
          current.headSeq = frame.seq - 1;
        } else {
          // A sparse answer: stop rather than open a second hole behind this one.
          break;
        }
      }
      this.push(current, frame, false);
      pushed += 1;
    }
    if (pushed > 0) {
      this.fillCount += 1;
      this.scheduleFlushFor(key);
    }
    return pushed;
  }

  /**
   * One accepted frame: into the ring, then announced to the transport.
   *
   * **`log:` only.** A `trace:` stream has exactly one home — the runtime process
   * the daemon is connected to — so it never enters the transport (ADR 0007
   * decision 1: "A `trace:` stream never enters it", plan 2/6 §1). The browser
   * reaches it through `/api/trace/ws`, which is the reason trace bytes across
   * processes are zero by construction. Sending them here would move the heaviest
   * stream over the link for consumers only one process has, and would make the
   * peer adapter the second place that has to know the rule.
   *
   * The transport is handed the frame the hub just accepted, so a peer adapter can
   * derive its head pointer from it (pointers cross, frames do not). Frames that
   * came *from* the transport and frames the reader filled are never announced
   * back, which is what stops two processes echoing one event.
   */
  private push(stream: HubRingStream, frame: HubFrame, announce: boolean): void {
    this.ring.push(stream, frame);
    if (announce && stream.kind === "log") this.transport.publish({ key: stream.key, frames: [frame] });
  }

  // ── Fan-out ─────────────────────────────────────────────────────────────────────────────────

  private scheduleFlushFor(key: HubStreamKey): void {
    this.flushDirty.add(key);
    if (this.flushScheduled || this.closed) return;
    this.flushScheduled = true;
    this.scheduleFlush(() => {
      if (this.closed) return;
      this.flushScheduled = false;
      this.flush();
    });
  }

  /**
   * One flush tick: at most one batch frame per subscriber, plus whatever live
   * changes (in-place updates) are waiting.
   *
   * Whatever does not fit stays dirty for the next tick, which is what bounds the
   * work one append can cause on the HTTP event loop.
   */
  private flush(): void {
    const started = this.now();
    const keys = [...this.flushDirty];
    this.flushDirty = new Set();
    for (const key of keys) {
      const changes = this.liveChanges.get(key);
      // Detach before callbacks: reentrant patches must enter a fresh queue.
      this.liveChanges.delete(key);
      const stream = this.ring.get(key);
      const set = this.subscribers.get(key);
      if (!stream || !set) continue;
      this.ring.touch(stream);
      for (const subscriber of set) {
        if (!subscriber.active) continue;
        if (changes) {
          for (const change of changes) {
            const frame = change.frame;
            if (frame.seq <= subscriber.cursor &&
              (subscriber.lagging || !this.hasDelivered(subscriber, frame.seq)
                || !this.advancesRevision(subscriber, change))) {
              this.deferChangeGap(subscriber, frame.seq);
            }
          }
        }
        if (subscriber.changeGap && !subscriber.lagging) {
          const gap = subscriber.changeGap;
          subscriber.changeGap = null;
          this.notifyGap(subscriber, gap.from, gap.to);
        }
        if (changes && changes.length > 0 && !subscriber.lagging) {
          // A gap advances the replay cursor without delivering a patch base.
          const applicable = changes.filter((change) => this.hasDelivered(subscriber, change.frame.seq))
            .map((change) => change.frame);
          if (applicable.length > 0) this.send(subscriber, applicable);
        }
        const more = this.deliverOneBatch(subscriber, stream);
        if (more) this.flushDirty.add(key);
      }
    }
    if (this.flushDirty.size > 0) {
      this.flushScheduled = false;
      this.scheduleFlushFor([...this.flushDirty][0]!);
    }
    this.flushSamples.push(Math.max(0, this.now() - started));
    if (this.flushSamples.length > HUB_FLUSH_SAMPLES) this.flushSamples.shift();
  }

  /** Returns true when the subscriber still has frames waiting after this batch. */
  private deliverOneBatch(subscriber: HubSubscriber, stream: HubRingStream): boolean {
    // A paused subscriber is the drain callback's business, not the flush loop's:
    // returning true here would spin `setImmediate` until the socket drained.
    if (subscriber.lagging) return false;
    if (hasUnservableAfter(stream, subscriber.cursor)) {
      this.reportGap(subscriber, firstServableSeq(stream) - 1);
    }
    const entries = this.ring.entriesAfter(stream, subscriber.cursor);
    if (entries.length === 0) {
      if (subscriber.cursor < stream.headSeq) this.reportGap(subscriber, stream.headSeq);
      return false;
    }
    if (entries[0]!.frame.seq > subscriber.cursor + 1) {
      this.reportGap(subscriber, entries[0]!.frame.seq - 1);
    }
    const batch: HubFrame[] = [];
    let bytes = 0;
    let index = 0;
    for (; index < entries.length; index += 1) {
      const entry = entries[index]!;
      const previous = batch.at(-1)?.seq ?? subscriber.cursor;
      if (entry.frame.seq !== previous + 1) break;
      if (batch.length > 0 && bytes + entry.bytes > this.limits.batchBytes) break;
      batch.push(entry.frame);
      bytes += entry.bytes;
    }
    subscriber.cursor = batch[batch.length - 1]!.seq;
    this.send(subscriber, batch);
    if (subscriber.lagging) return false;
    const next = entries[index];
    const gapEnd = next ? next.frame.seq - 1 : stream.headSeq;
    if (gapEnd > subscriber.cursor) this.reportGap(subscriber, gapEnd);
    return index < entries.length;
  }

  private send(subscriber: HubSubscriber, frames: readonly HubFrame[]): void {
    const listener = subscriber.traceListener;
    try {
      if (listener && subscriber.traceTaskId) {
        const events = frames
          .filter((frame) => frame.kind === "trace")
          .map((frame) => frame.payload as TraceEvent);
        if (events.length > 0) listener(subscriber.traceTaskId, events);
      } else {
        subscriber.sink.send(frames);
      }
      for (const frame of frames) {
        if (frame.kind !== "patch") {
          const last = subscriber.delivered.at(-1);
          if (last && last.to + 1 === frame.seq) last.to = frame.seq;
          else subscriber.delivered.push({ from: frame.seq, to: frame.seq });
          this.trimDelivered(subscriber);
        }
        if (frame.kind !== "trace") {
          this.rememberDeliveredRevision(subscriber, frame.seq, (frame.payload as B0ConversationLogEntry).revision);
        }
      }
    } catch (error) {
      this.warn(`subscriber for ${subscriber.key} threw: ${errorText(error)}`);
    }
    let buffered = 0;
    try {
      buffered = subscriber.sink.getBufferedAmount();
    } catch {
      buffered = 0;
    }
    if (buffered > this.limits.laggingBytes) subscriber.lagging = true;
  }

  private hasDelivered(subscriber: HubSubscriber, seq: number): boolean {
    return subscriber.delivered.some((range) => range.from <= seq && seq <= range.to);
  }

  private advancesRevision(subscriber: HubSubscriber, change: LiveChange): boolean {
    const revision = subscriber.deliveredRevisions.get(change.frame.seq) ?? 1;
    if ((change.frame.payload as ConversationLogPatch).revision <= revision) return false;
    // Even a higher envelope may conceal an old field the client cannot order.
    return [...change.fieldRevisions.values()].every((fieldRevision) => fieldRevision > revision);
  }

  private rememberDeliveredRevision(subscriber: HubSubscriber, seq: number, revision: number): void {
    if (!(revision > 1)) return;
    subscriber.deliveredRevisions.delete(seq);
    subscriber.deliveredRevisions.set(seq, revision);
    while (subscriber.deliveredRevisions.size > HUB_DELIVERED_REVISION_LIMIT) {
      const oldest = subscriber.deliveredRevisions.keys().next().value!;
      this.forgetDelivered(subscriber, oldest, oldest);
    }
  }

  private deferChangeGap(subscriber: HubSubscriber, seq: number): void {
    const gap = subscriber.changeGap;
    const from = Math.min(gap?.from ?? seq, seq);
    const to = Math.max(gap?.to ?? seq, seq);
    subscriber.changeGap = { from, to };
    // A reread is asynchronous: until a new base is delivered, another patch must
    // also become a gap. The conservative range may invalidate unchanged rows.
    this.forgetDelivered(subscriber, from, to);
  }

  private forgetDelivered(subscriber: HubSubscriber, from: number, to: number): void {
    for (const seq of subscriber.deliveredRevisions.keys()) {
      if (from <= seq && seq <= to) subscriber.deliveredRevisions.delete(seq);
    }
    const held = subscriber.delivered.splice(0);
    for (const range of held) {
      if (range.to < from || range.from > to) subscriber.delivered.push(range);
      else {
        if (range.from < from) subscriber.delivered.push({ from: range.from, to: from - 1 });
        if (range.to > to) subscriber.delivered.push({ from: to + 1, to: range.to });
      }
    }
    this.trimDelivered(subscriber);
  }

  private trimDelivered(subscriber: HubSubscriber): void {
    const excess = subscriber.delivered.length - HUB_DELIVERED_RANGE_LIMIT;
    if (excess <= 0) return;
    const removed = subscriber.delivered.splice(0, excess);
    const through = removed.at(-1)!.to;
    // Forget both kinds of proof; a future edit of a trimmed row becomes a gap.
    for (const seq of subscriber.deliveredRevisions.keys()) {
      if (seq <= through) subscriber.deliveredRevisions.delete(seq);
    }
  }

  /** The transport drained: resume from `cursor + 1`, or report the range we lost. */
  private resume(subscriber: HubSubscriber): void {
    if (!subscriber.active) return;
    subscriber.lagging = false;
    const stream = this.ring.get(subscriber.key);
    if (!stream) return;
    if (hasUnservableAfter(stream, subscriber.cursor)) {
      this.reportGap(subscriber, firstServableSeq(stream) - 1);
    }
    this.scheduleFlushFor(subscriber.key);
  }

  /**
   * Move a new subscription's delivery cursor to the servable boundary.
   *
   * The range it skips is the one `gap`/`gap` reports, so this is bookkeeping, not a
   * second notification: the keyed spelling hands the range back in the
   * subscription object and A-0's spelling reports it as `gap: true`.
   */
  private skipUnservable(subscriber: HubSubscriber, stream: HubRingStream): void {
    const first = firstServableSeq(stream);
    if (subscriber.cursor < first - 1) subscriber.cursor = first - 1;
  }

  /**
   * Tell one subscriber about a range it cannot get from the ring, and move its
   * cursor to just below the first sequence that *is* servable.
   *
   * Setting the cursor here is what keeps the following replay contiguous with the
   * gap: the subscriber is not sent a range it was just told to fetch itself.
   */
  private reportGap(subscriber: HubSubscriber, upTo: number): void {
    if (!subscriber.active) return;
    const from = subscriber.cursor;
    if (upTo < from) return;
    this.notifyGap(subscriber, from, upTo);
    subscriber.cursor = upTo;
  }

  private notifyGap(subscriber: HubSubscriber, from: number, to: number): void {
    if (subscriber.sink.gap) {
      try {
        subscriber.sink.gap(from, to);
      } catch (error) {
        this.warn(`subscriber for ${subscriber.key} threw in gap: ${errorText(error)}`);
      }
    }
  }

  /**
   * Tell every subscriber of a stream that everything up to `upTo` is missing.
   *
   * Used when the *stream* has a hole rather than a subscriber falling behind: the
   * end of the range is the same for everyone, but each subscriber is told from its
   * own cursor, because one that is already past the hole has nothing to fetch.
   */
  private emitGap(key: HubStreamKey, _from: number, upTo: number): void {
    const set = this.subscribers.get(key);
    if (!set) return;
    for (const subscriber of set) this.reportGap(subscriber, upTo);
  }

  private newSubscriber(
    key: HubStreamKey,
    fromSeq: number,
    sink: HubSubscriberSink,
    traceListener: TraceSinkListener | null,
    traceTaskId: string | null,
  ): HubSubscriber {
    const subscriber: HubSubscriber = {
      key,
      sink,
      requested: fromSeq,
      cursor: fromSeq,
      delivered: [],
      deliveredRevisions: new Map(),
      changeGap: null,
      lagging: false,
      active: true,
      traceListener,
      traceTaskId,
    };
    let set = this.subscribers.get(key);
    if (!set) {
      set = new Set();
      this.subscribers.set(key, set);
    }
    set.add(subscriber);
    return subscriber;
  }

  private removeSubscriber(subscriber: HubSubscriber): void {
    if (!subscriber.active) return;
    subscriber.active = false;
    const set = this.subscribers.get(subscriber.key);
    if (!set) return;
    set.delete(subscriber);
    if (set.size === 0) this.subscribers.delete(subscriber.key);
  }

  // ── Warm-up and LRU ─────────────────────────────────────────────────────────────────────────

  /** Fill a cold stream once, in the background, from the injected reader. */
  private async ensureWarm(key: HubStreamKey): Promise<void> {
    if (!this.fill || this.warmed.has(key) || this.warming.has(key) || this.closed) return;
    const parsed = parseHubStreamKey(key);
    if (!parsed) return;
    this.warming.add(key);
    try {
      if (parsed.stream === "log") await this.warmLog(key, parsed.id);
      else await this.warmTrace(key, parsed.id);
      this.warmed.add(key);
    } catch (error) {
      this.warn(`warm-up failed for ${key}: ${errorText(error)}`);
    } finally {
      this.warming.delete(key);
    }
  }

  /**
   * A cold `log:` stream: read `head_seq / log_version`, then prefill the last
   * {@link HUB_WARMUP_FRAMES} frames so a first subscriber sees context instead of
   * an empty stream that fills in one frame at a time.
   *
   * A stream that already holds frames was fed by a write or a peer pointer, so it
   * only takes the freshness token from here.
   */
  private async warmLog(key: HubStreamKey, sessionId: string): Promise<void> {
    const fill = this.fill;
    if (!fill) return;
    const known = await fill.logHead(sessionId);
    if (this.closed) return;
    const stream = this.ring.ensure(key);
    if (!known) return;
    if (stream.entries.length > 0 || stream.headSeq > 0) {
      this.stampLogVersion(stream, known.head, known.log_version);
      return;
    }
    const from = Math.max(1, known.head - this.limits.warmupFrames + 1);
    const pushed = await this.fillFrom(key, from - 1, known.head, true);
    const after = this.ring.get(key);
    if (!after) return;
    // A partial/empty read must not lower the authoritative head. Unreadable
    // sequences stay explicit gaps, and the next live write follows this head.
    after.headSeq = Math.max(after.headSeq, known.head);
    after.tailSeq = after.entries[0]?.frame.seq ?? after.headSeq + 1;
    this.stampLogVersion(after, known.head, known.log_version);
    // A prefill that starts above the requested range is a gap for whoever is
    // already subscribed: the ack they sent before the warm-up finished could not
    // carry news that had not arrived yet. Each subscriber is told its own missing
    // range, and its cursor moves to just below the oldest frame actually held, so
    // the replay that follows is contiguous with what it was told.
    const heldFrom = after.entries[0]?.frame.seq ?? null;
    const subscribers = this.subscribers.get(key);
    if (heldFrom !== null && subscribers) {
      for (const subscriber of subscribers) {
        if (!subscriber.active || subscriber.cursor >= heldFrom - 1) continue;
        this.reportGap(subscriber, heldFrom - 1);
      }
    }
    if (pushed === 0 && !after.entries.length) {
      // Nothing at all came back: the ring keeps only the head it learned, and the
      // subscribers are left to fetch the entire range through their own route.
      const listeners = subscribers;
      if (listeners) {
        for (const subscriber of listeners) {
          if (subscriber.active) this.reportGap(subscriber, known.head);
        }
      }
    }
    this.scheduleFlushFor(key);
  }

  /**
   * A cold `trace:` stream: learn the head from the trace reader.
   *
   * The events live in the daemon, so there is nothing for this process to prefill
   * (`trace.fetch` is the read route that owns them). Learning the head is what
   * makes the subscriber's gap computable, and the subscriber is told it through
   * its sink so it can fetch exactly the missing range.
   */
  private async warmTrace(key: HubStreamKey, taskId: string): Promise<void> {
    const fill = this.fill;
    if (!fill) return;
    const head = await fill.traceHead(taskId);
    if (this.closed || head === null) return;
    const stream = this.ring.ensure(key);
    if (stream.entries.length > 0 || head <= stream.headSeq) return;
    const subscribers = this.subscribers.get(key);
    stream.headSeq = head;
    stream.tailSeq = head + 1;
    if (subscribers) {
      // Nothing was retained, so every subscriber must fetch its own range through
      // the route that owns trace bytes (`trace.fetch`); the hub only knows where
      // the head is.
      for (const subscriber of subscribers) this.reportGap(subscriber, head);
    }
  }

  /**
   * Record the freshness token for a `log:` stream.
   *
   * Only the database can name the version that covers a head, so a locally
   * appended row past the last versioned head answers `null` ("unknown") until the
   * next fill or peer pointer stamps it. Reporting a stale token would tell a
   * replica that two different heads share a version, which is the one thing the
   * token exists to prevent.
   */
  private stampLogVersion(stream: HubRingStream, _head: number, logVersion: number | null): void {
    if (stream.kind !== "log") return;
    stream.logVersion = logVersion;
  }

  private rememberHead(key: HubStreamKey, head: number, logVersion: number | null): void {
    while (this.knownHeads.size >= this.limits.knownHeadLimit) {
      const oldest = this.knownHeads.keys().next();
      if (oldest.done) break;
      this.knownHeads.delete(oldest.value);
    }
    this.knownHeads.set(key, { head, log_version: logVersion, at: this.now() });
  }

  private evictOverBudget(): void {
    if (this.ring.overshootBytes <= 0) return;
    const evicted = this.ring.evictOverBudget((stream) => this.hasSubscribers(stream.key));
    if (evicted.length === 0) return;
    this.evictedStreams += evicted.length;
    for (const key of evicted) {
      this.pending.delete(key);
      this.liveChanges.delete(key);
      const timer = this.holeTimers.get(key);
      if (timer !== undefined) {
        clearTimeout(timer as never);
        this.holeTimers.delete(key);
      }
      this.flushDirty.delete(key);
      this.warmed.delete(key);
    }
  }
}

/**
 * The oldest sequence this stream can serve.
 *
 * `tailSeq` is the oldest retained frame, and a stale position is one whose
 * retained frame is only a fragment of a row, so serving starts after the newest of
 * them. The two conditions compose: trimming moves the tail, patching moves the
 * boundary.
 */
function firstServableSeq(stream: HubRingStream): number {
  let first = stream.tailSeq;
  for (const seq of stream.staleSeqs) {
    if (seq + 1 > first) first = seq + 1;
  }
  return first;
}

/**
 * The range a subscription created at `requested` cannot get from this ring.
 *
 * `from` is the requested cursor rather than `requested + 1`, so the range is
 * conservative by one sequence: a subscriber that re-reads `from` de-duplicates by
 * sequence, while one that skipped it could silently lose a frame. C0's contract
 * test pins this shape.
 */
function gapFor(stream: HubRingStream, requested: number): HubSeqRange | null {
  if (stream.headSeq === 0) return null;
  const first = firstServableSeq(stream);
  if (requested >= first - 1) return null;
  return { from: requested, to: Math.min(stream.headSeq, first - 1) };
}

/**
 * Whether a subscriber at `cursor` has sequences it cannot be served.
 *
 * One predicate covers both ways a ring goes short, because `firstServableSeq`
 * already folds them together: `cursor + 1 < first` means the next sequence the
 * subscriber wants is either below the retained tail or a position whose frame was
 * patched in place. The comparison is `cursor < first - 1` rather than
 * `cursor + 1 < first` for the one-sequence convention `gap` uses: `from` is the
 * requested cursor, so a request that only just reaches the servable range is not a
 * gap.
 */
function hasUnservableAfter(stream: HubRingStream, cursor: number): boolean {
  return cursor < firstServableSeq(stream) - 1;
}

function traceKey(taskId: string): HubStreamKey {
  return `trace:${taskId}` as HubStreamKey;
}

function listenerSink(key: HubStreamKey, onFrames: HubFrameListener): HubSubscriberSink {
  return {
    getBufferedAmount: () => 0,
    send: (frames) => { onFrames(key, frames); },
  };
}

/** Create the hub the API process uses. */
export function createHub(options: HubOptions): HubImpl {
  return new HubImpl(options);
}
