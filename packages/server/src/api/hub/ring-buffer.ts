/**
 * Retention for the Live Hub (MUL-403 §1, C1 / MUL-436).
 *
 * Two ordered streams share this layer and nothing about their payloads:
 * `log:<session_id>` frames carry a conversation-log row's own `seq`,
 * `trace:<task_id>` frames the daemon's `trace_seq`. The hub assigns no sequence
 * of its own, so a ring is a window over somebody else's numbering and the only
 * thing this file decides is how much of that window stays resident.
 *
 * Three budgets, from ADR 0007 and plan 2/6 §1:
 *
 *   - one stream holds at most 1024 frames **or** 4 MiB, whichever bites first;
 *   - every stream together hold at most 128 MiB;
 *   - past the global budget the ring evicts whole streams that have no
 *     subscriber and have not been touched for 15 minutes, oldest first.
 *
 * Eviction only shortens replay. A stream that was evicted is a cold stream
 * again, and a subscriber asking for a range the ring no longer holds is
 * answered with a `gap` so it can read the range from the route that owns it
 * (the browser from the log window endpoints, A-6 from `trace.fetch`). Nothing
 * here ever reads a database: filling a hole is the hub's job, and the hub does
 * it through an injected reader.
 *
 * Frames are serialized **once**, on the way in, and the ring keeps that string
 * next to the frame. Fan-out and `/health`'s ring occupancy both use the string's
 * real byte length rather than guessing from object shape, and one frame costs
 * one serialization however many subscribers it reaches.
 */

import type { HubFrame, HubStreamKey } from "@multiremi/contracts/live-hub.js";

/** Frames retained per stream before the oldest is dropped. */
export const HUB_STREAM_MAX_FRAMES = 1024;
/** Bytes retained per stream (serialized frames) before the oldest is dropped. */
export const HUB_STREAM_MAX_BYTES = 4 * 1024 * 1024;
/** Bytes retained across every stream of one process. */
export const HUB_GLOBAL_MAX_BYTES = 128 * 1024 * 1024;
/** How long an untouched, subscriber-less stream may survive the global budget. */
export const HUB_EVICT_AFTER_MS = 15 * 60 * 1000;

export interface HubRingLimits {
  streamMaxFrames: number;
  streamMaxBytes: number;
  globalMaxBytes: number;
  evictAfterMs: number;
}

/** The production budgets. Tests inject smaller numbers; they are the same policy. */
export const HUB_RING_LIMITS: HubRingLimits = {
  streamMaxFrames: HUB_STREAM_MAX_FRAMES,
  streamMaxBytes: HUB_STREAM_MAX_BYTES,
  globalMaxBytes: HUB_GLOBAL_MAX_BYTES,
  evictAfterMs: HUB_EVICT_AFTER_MS,
};

/** One retained frame: the shared object plus its one-time serialization. */
export interface HubRingEntry {
  readonly frame: HubFrame;
  readonly serialized: string;
  readonly bytes: number;
}

/**
 * Deep-freeze the frame and its payload's first level.
 *
 * Every subscriber of a stream receives the *same* frame object — that is what
 * makes one serialization and one `send` per subscriber possible — so a listener
 * that rewrote a field in place would corrupt every other subscriber's view.
 * Freezing the frame and its payload is the cheapest way to make that a loud
 * error in strict mode instead of a silent cross-subscriber bug.
 */
export function freezeHubFrame<T extends HubFrame>(frame: T): T {
  const payload = frame.payload;
  if (payload && typeof payload === "object") Object.freeze(payload);
  return Object.freeze(frame);
}

/**
 * Serialize a frame once and measure the result.
 *
 * `JSON.stringify` of the frame wrapper plus its payload is exactly what a
 * `stream.data` frame will carry, so the byte count is the number the 64 KiB
 * batch cap and the ring budgets are both denominated in.
 */
export function serializeHubFrame(frame: HubFrame): { serialized: string; bytes: number } {
  const serialized = JSON.stringify(frame);
  return { serialized, bytes: Buffer.byteLength(serialized, "utf8") };
}

/** One stream's retained window plus the bookkeeping the hub needs beside it. */
export interface HubRingStream {
  readonly key: HubStreamKey;
  readonly kind: "log" | "trace";
  readonly id: string;
  readonly entries: HubRingEntry[];
  bytes: number;
  /** Newest sequence the ring accepted. 0 means "nothing accepted yet". */
  headSeq: number;
  /** Oldest retained sequence, or `headSeq + 1` when nothing is retained. */
  tailSeq: number;
  /** The replica freshness token for `log:` streams; null when unknown. */
  logVersion: number | null;
  /** Wall-clock ms of the last access (any enqueue, subscribe or fan-out). */
  lastAccess: number;
  /** Set by {@link HubRingBuffer.markClosed}; the trace completeness signal. */
  closed: boolean;
  /**
   * Sequences whose retained frame is no longer the whole truth.
   *
   * An in-place update (`patch`) replaces part of a row that the ring already
   * holds. The ring cannot rebuild the row from the patch — only the database can —
   * so a subscriber replaying that position would get a fragment it has no base
   * for. Marking the sequence lets the hub report it as a `gap` instead of serving
   * a patch as if it were the row.
   */
  readonly staleSeqs: Set<number>;
  /** Frames dropped because their sequence was at or below the head. */
  droppedFrames: number;
  /** Frames dropped from the front because a budget bit. */
  trimmedFrames: number;
}

/** What the ring needs to know about a stream to decide whether it may be evicted. */
export type HubRingProtection = (stream: HubRingStream) => boolean;

/**
 * Every stream of one hub, with the byte budgets applied.
 *
 * The class owns no timers and no I/O: the hub calls {@link touch} from its hot
 * path and {@link evictOverBudget} when the global budget is exceeded, which
 * keeps the eviction policy testable with an injected clock.
 */
export class HubRingBuffer {
  private readonly streams = new Map<HubStreamKey, HubRingStream>();
  private bytes = 0;

  constructor(
    private readonly limits: HubRingLimits = HUB_RING_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  get totalBytes(): number {
    return this.bytes;
  }

  get streamCount(): number {
    return this.streams.size;
  }

  get frameCount(): number {
    let frames = 0;
    for (const stream of this.streams.values()) frames += stream.entries.length;
    return frames;
  }

  get(key: HubStreamKey): HubRingStream | undefined {
    return this.streams.get(key);
  }

  /** The stream's state, created empty when this is the first mention of it. */
  ensure(key: HubStreamKey): HubRingStream {
    const existing = this.streams.get(key);
    if (existing) return existing;
    const colon = key.indexOf(":");
    const created: HubRingStream = {
      key,
      kind: key.startsWith("log:") ? "log" : "trace",
      id: key.slice(colon + 1),
      entries: [],
      bytes: 0,
      headSeq: 0,
      tailSeq: 1,
      logVersion: null,
      lastAccess: this.now(),
      closed: false,
      staleSeqs: new Set<number>(),
      droppedFrames: 0,
      trimmedFrames: 0,
    };
    this.streams.set(key, created);
    return created;
  }

  delete(key: HubStreamKey): boolean {
    const stream = this.streams.get(key);
    if (!stream) return false;
    this.streams.delete(key);
    this.bytes -= stream.bytes;
    stream.bytes = 0;
    stream.entries.length = 0;
    return true;
  }

  /** Record an access so the LRU order reflects reads as well as writes. */
  touch(stream: HubRingStream): void {
    stream.lastAccess = this.now();
  }

  /** The ids of every resident stream, for diagnostics and tests. */
  keys(): HubStreamKey[] {
    return [...this.streams.keys()];
  }

  /**
   * Append a frame whose sequence is exactly `headSeq + 1`.
   *
   * The caller (the hub) proves contiguity; this layer only enforces the
   * budgets. It is deliberately not a general "insert anywhere": an out-of-order
   * frame is the continuity buffer's problem, and letting it reach the ring would
   * break the `[tail, head]` range contract that `subscribe` reports.
   */
  push(stream: HubRingStream, frame: HubFrame): HubRingEntry {
    const { serialized, bytes } = serializeHubFrame(frame);
    const entry: HubRingEntry = { frame: freezeHubFrame(frame), serialized, bytes };
    const wasEmpty = stream.entries.length === 0;
    stream.staleSeqs.delete(frame.seq);
    stream.entries.push(entry);
    stream.bytes += bytes;
    this.bytes += bytes;
    if (wasEmpty) stream.tailSeq = frame.seq;
    stream.headSeq = frame.seq;
    this.trim(stream);
    this.touch(stream);
    return entry;
  }

  /**
   * Mark the retained frame at `seq` stale after an in-place update.
   *
   * A patch keeps the `seq` of the row it patches, so it is not a new sequence and
   * must not extend the window — but it also does not contain the whole row. The
   * retained frame therefore stays where it is (the window must not gain a hole)
   * and the sequence is flagged: a live subscriber that already holds the row is
   * handed the patch, and a subscriber that replays this position is told a `gap`,
   * because only the database can serve the current row.
   *
   * Returns false when the ring does not hold that sequence — a patch for a row
   * outside the window changes nothing here, and a later replay cannot reach it
   * either.
   */
  markStale(stream: HubRingStream, seq: number): boolean {
    if (!stream.entries.some((entry) => entry.frame.seq === seq)) return false;
    stream.staleSeqs.add(seq);
    this.touch(stream);
    return true;
  }

  /**
   * Drop the retained window and restart it one frame before `seq`.
   *
   * Used only when a hole could not be closed: without this the stream would keep
   * claiming a contiguous `[tail, head]` range across a sequence it does not have.
   * Subscribers are told the missing range separately, so this is the bookkeeping
   * half of the pair. `headSeq` becomes `seq - 1` so the next accepted frame is
   * `seq` itself and continuity holds again from there.
   */
  refound(stream: HubRingStream, seq: number): void {
    this.bytes -= stream.bytes;
    stream.entries.length = 0;
    stream.staleSeqs.clear();
    stream.bytes = 0;
    stream.headSeq = seq - 1;
    stream.tailSeq = seq;
    this.touch(stream);
  }

  /** Retained frames with `seq > afterSeq`, oldest first. */
  entriesAfter(stream: HubRingStream, afterSeq: number): HubRingEntry[] {
    if (stream.entries.length === 0) return [];
    const first = stream.entries[0]!;
    if (first.frame.seq > afterSeq) return [...stream.entries];
    return stream.entries.filter((entry) => entry.frame.seq > afterSeq);
  }

  /**
   * Drop the oldest frames until the per-stream budgets are satisfied.
   *
   * A trimmed frame is not an error: it shortens replay, and a subscriber that
   * asked for it is told so through `gap`. `tailSeq` follows the oldest retained
   * frame, so the range the ring reports is always truthful.
   */
  private trim(stream: HubRingStream): void {
    while (
      stream.entries.length > this.limits.streamMaxFrames ||
      stream.bytes > this.limits.streamMaxBytes
    ) {
      const dropped = stream.entries.shift();
      if (!dropped) break;
      stream.staleSeqs.delete(dropped.frame.seq);
      stream.bytes -= dropped.bytes;
      this.bytes -= dropped.bytes;
      stream.trimmedFrames += 1;
      stream.tailSeq = stream.entries[0]?.frame.seq ?? stream.headSeq + 1;
    }
  }

  /**
   * Bring the process back under the global budget by evicting whole streams.
   *
   * Only streams `isProtected` declines to protect — the hub protects any stream
   * with a subscriber — and only after {@link HubRingLimits.evictAfterMs} without
   * a touch are candidates. When nothing qualifies the loop stops and the caller
   * logs the overshoot: dropping a stream somebody is watching would be a
   * correctness bug, while a short overshoot is not.
   */
  evictOverBudget(isProtected: HubRingProtection): HubStreamKey[] {
    const evicted: HubStreamKey[] = [];
    while (this.bytes > this.limits.globalMaxBytes) {
      const candidate = this.oldestEvictable(isProtected);
      if (!candidate) break;
      this.delete(candidate.key);
      evicted.push(candidate.key);
    }
    return evicted;
  }

  /** How far past the global budget the ring is right now; 0 when inside. */
  get overshootBytes(): number {
    return Math.max(0, this.bytes - this.limits.globalMaxBytes);
  }

  private oldestEvictable(isProtected: HubRingProtection): HubRingStream | null {
    const deadline = this.now() - this.limits.evictAfterMs;
    let candidate: HubRingStream | null = null;
    for (const stream of this.streams.values()) {
      if (isProtected(stream)) continue;
      if (stream.lastAccess > deadline) continue;
      if (!candidate || stream.lastAccess < candidate.lastAccess) candidate = stream;
    }
    return candidate;
  }
}
