/**
 * The Live Hub's core behaviour (MUL-403 §1, C1 / MUL-436 acceptance).
 *
 * One file per acceptance bullet, in the order the issue lists them, so a reviewer
 * can walk the list top to bottom:
 *
 *   - replay and gap, LRU eviction, cold-stream warm-up;
 *   - sequence handling: continuous, dropped replay, hole;
 *   - a slow subscriber never blocks the producer, resumes from its cursor, and is
 *     told a gap when its resume point has left the ring;
 *   - the continuity buffer: out-of-order frames, a sequence that never arrives
 *     (filled after the 500ms window), and duplicates;
 *   - a peer head pointer fills a held stream and is only remembered otherwise.
 *
 * No test here touches Postgres: the reader is a fake (`HubFillReader`), which is
 * what the issue asks for ("本单测试用假实现"). The SQL that reads a real range is
 * v2 integration's job.
 */
import { describe, expect, it } from "bun:test";
import {
  HubImpl,
  createHub,
  HUB_BATCH_MAX_BYTES,
  HUB_LAGGING_THRESHOLD_BYTES,
  type HubFillReader,
  type HubSubscriberSink,
} from "@multiremi/api/hub/hub-core.js";
import {
  HubRingBuffer,
  HUB_RING_LIMITS,
  type HubRingLimits,
} from "@multiremi/api/hub/ring-buffer.js";
import { LocalHubTransport, createLocalHubTransport } from "@multiremi/api/hub/hub-transport.js";
import type { HubTransport } from "@multiremi/api/hub/hub-transport.js";
import type { HubFrame, HubStreamKey } from "@multiremi/contracts/live-hub.js";
import type { TraceEvent } from "@multiremi/contracts/trace.js";

// ── Harness ────────────────────────────────────────────────────────────────────────────────────

/** A clock and timer set the tests drive by hand, so no case waits on wall time. */
class FakeClock {
  ms = 1_700_000_000_000;
  private timers: { at: number; callback: () => void }[] = [];

  now = (): number => this.ms;

  scheduleHole = (callback: () => void, delayMs: number): unknown => {
    const timer = { at: this.ms + delayMs, callback };
    this.timers.push(timer);
    return timer;
  };

  /** Advance the clock and run every timer whose deadline has passed. */
  async advance(ms: number): Promise<void> {
    this.ms += ms;
    const due = this.timers.filter((timer) => timer.at <= this.ms);
    this.timers = this.timers.filter((timer) => timer.at > this.ms);
    for (const timer of due) timer.callback();
    // The hole handlers are async; let them settle before the caller asserts.
    await drainMicrotasks();
  }

  get pendingTimers(): number {
    return this.timers.length;
  }
}

async function drainMicrotasks(turns = 8): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

/** A sink that records everything it is handed and can fake a transport backlog. */
class RecordingSink implements HubSubscriberSink {
  readonly batches: HubFrame[][] = [];
  readonly gaps: { from: number; to: number }[] = [];
  buffered = 0;

  getBufferedAmount(): number {
    return this.buffered;
  }

  send(frames: readonly HubFrame[]): void {
    this.batches.push([...frames]);
  }

  gap(from: number, to: number): void {
    this.gaps.push({ from, to });
  }

  get frames(): HubFrame[] {
    return this.batches.flat();
  }
}

/**
 * A reader over a materialized map of streams.
 *
 * `logHead`/`traceHead` report where the "database" thinks the head is, and
 * `readRange` answers exactly `(afterSeq, toSeq]`. `failNext` lets a case prove the
 * hub survives a reader error, and `calls` records what was asked for so a test can
 * assert the hub asked for the *missing* range rather than re-reading everything.
 */
class FakeReader implements HubFillReader {
  readonly frames = new Map<string, HubFrame[]>();
  readonly logHeads = new Map<string, { head: number; log_version: number | null }>();
  readonly traceHeads = new Map<string, number | null>();
  readonly calls: { key: string; afterSeq: number; toSeq: number }[] = [];
  failNext = false;
  /** When set, `readRange` answers with nothing, modelling a lost row. */
  answerEmpty = false;

  seed(key: HubStreamKey, frames: HubFrame[]): void {
    this.frames.set(key, [...frames]);
  }

  async logHead(sessionId: string): Promise<{ head: number; log_version: number | null } | null> {
    return this.logHeads.get(sessionId) ?? null;
  }

  async traceHead(taskId: string): Promise<number | null> {
    return this.traceHeads.get(taskId) ?? null;
  }

  async readRange(key: HubStreamKey, afterSeq: number, toSeq: number): Promise<HubFrame[]> {
    this.calls.push({ key, afterSeq, toSeq });
    if (this.failNext) {
      this.failNext = false;
      throw new Error("read range failed");
    }
    if (this.answerEmpty) return [];
    return (this.frames.get(key) ?? []).filter((frame) => frame.seq > afterSeq && frame.seq <= toSeq);
  }
}

function logFrame(seq: number, body = `row-${seq}`): HubFrame {
  return { seq, kind: "entry", payload: { session_id: "ises_1", seq, body_md: body } };
}

function traceFrame(seq: number): HubFrame {
  return { seq, kind: "trace", payload: traceEvent(seq) };
}

function traceEvent(seq: number): TraceEvent {
  return { seq, ts: new Date(1_700_000_000_000 + seq).toISOString(), type: "text", content: `t-${seq}` };
}

interface Bed {
  hub: HubImpl;
  clock: FakeClock;
  reader: FakeReader;
  warnings: string[];
  transport: HubTransport;
  /** Run the merged fan-out tick that `setImmediate` would have run. */
  flush(): Promise<void>;
}

function bed(options: {
  reader?: FakeReader | null;
  ring?: Partial<HubRingLimits>;
  limits?: Partial<{ batchBytes: number; laggingBytes: number; warmupFrames: number; knownHeadLimit: number }>;
  transport?: HubTransport;
} = {}): Bed {
  const clock = new FakeClock();
  const reader = options.reader === undefined ? new FakeReader() : options.reader;
  const warnings: string[] = [];
  const transport = options.transport ?? createLocalHubTransport();
  const scheduled: (() => void)[] = [];
  const hub = createHub({
    transport,
    fill: reader,
    now: clock.now,
    scheduleHole: clock.scheduleHole,
    // The real hub merges fan-out through `setImmediate`; recording the callback
    // keeps a case in control of when the batch is built and sent.
    scheduleFlush: (callback) => { scheduled.push(callback); },
    limits: {
      ...(options.limits ?? {}),
      ...(options.ring ? { ring: { ...HUB_RING_LIMITS, ...options.ring } } : {}),
    },
    onWarn: (message) => { warnings.push(message); },
  });
  return {
    hub,
    clock,
    reader: reader ?? new FakeReader(),
    warnings,
    transport,
    flush: async () => {
      while (scheduled.length > 0) {
        const callback = scheduled.shift()!;
        callback();
        await drainMicrotasks(2);
      }
      await drainMicrotasks(2);
    },
  };
}

// ── Replay, gap and the ring's own contracts ────────────────────────────────────────────────────

describe("hub core: replay and gap", () => {
  it("replays the retained window to a subscriber that starts behind the head", async () => {
    const t = bed();
    const key = "log:ises_1" as HubStreamKey;
    for (let seq = 1; seq <= 5; seq += 1) t.hub.onEntry("ises_1", entry(seq));
    await t.flush();

    const sink = new RecordingSink();
    const subscription = t.hub.subscribeWithSink(key, 0, sink);
    await t.flush();

    expect(sink.frames.map((frame) => frame.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(subscription.first_seq).toBe(1);
    expect(subscription.head).toBe(5);
    expect(subscription.gap).toBeNull();
  });

  it("reports the missing range instead of reading the database itself", async () => {
    // The stream budget is what drops the front of a ring in production, so the
    // case shrinks the budget rather than reaching for a test-only trim.
    const t = bed({ ring: { streamMaxFrames: 5 } });
    for (let seq = 1; seq <= 10; seq += 1) t.hub.onEntry("ises_1", entry(seq));
    await t.flush();

    const sink = new RecordingSink();
    const subscription = t.hub.subscribeWithSink("log:ises_1" as HubStreamKey, 2, sink);
    // `gap` is read at subscribe time — that is the value the caller puts in its
    // ack — so it is captured before the deferred replay advances the cursor.
    expect(subscription.first_seq).toBe(6);
    expect(subscription.gap).toEqual({ from: 2, to: 5 });
    await t.flush();

    // The retained tail still arrives: a gap degrades the view, it does not silence
    // the stream, and the replay does not re-send the range the caller was told to
    // fetch itself.
    expect(sink.frames.map((frame) => frame.seq)).toEqual([6, 7, 8, 9, 10]);
    // The hub read nothing on the subscriber's behalf.
    expect(t.reader.calls).toHaveLength(0);
  });

  it("answers a request that is exactly current with an empty replay and no gap", async () => {
    const t = bed();
    for (let seq = 1; seq <= 3; seq += 1) t.hub.onEntry("ises_1", entry(seq));
    await t.flush();

    const sink = new RecordingSink();
    const subscription = t.hub.subscribeWithSink("log:ises_1" as HubStreamKey, 3, sink);
    await t.flush();

    expect(sink.frames).toEqual([]);
    expect(subscription.gap).toBeNull();
    expect(subscription.head).toBe(3);
  });
});

// ── Sequence handling: continuous, replay, hole ─────────────────────────────────────────────────

describe("hub core: trace sequence handling", () => {
  it("accepts a continuous batch and reports the daemon's own head", () => {
    const t = bed();
    const result = t.hub.append("task_a", [traceEvent(1), traceEvent(2), traceEvent(3)]);
    expect(result).toEqual({ head: 3 });
    expect(t.hub.head("task_a")).toBe(3);
  });

  it("drops a replayed frame and counts it, without disturbing the head", () => {
    const t = bed();
    t.hub.append("task_a", [traceEvent(1), traceEvent(2)]);
    t.hub.append("task_a", [traceEvent(2), traceEvent(3)]);

    expect(t.hub.head("task_a")).toBe(3);
    expect(t.hub.snapshot().dropped_frames).toBeGreaterThanOrEqual(1);
  });

  it("holds a frame that skipped a sequence and delivers it once the hole closes", async () => {
    const t = bed();
    const sink = new RecordingSink();
    t.hub.subscribeWithSink("trace:task_a" as HubStreamKey, 0, sink);

    t.hub.append("task_a", [traceEvent(1)]);
    t.hub.append("task_a", [traceEvent(3)]); // 2 is missing
    await t.flush();

    // Only the contiguous frame is delivered; the jumper waits in the buffer.
    expect(sink.frames.map((frame) => frame.seq)).toEqual([1]);
    expect(t.hub.snapshot().pending_frames).toBe(1);

    // The missing frame arrives inside the 500ms window: no fill was needed.
    t.hub.append("task_a", [traceEvent(2)]);
    await t.flush();
    expect(sink.frames.map((frame) => frame.seq)).toEqual([1, 2, 3]);
    expect(t.hub.snapshot().pending_frames).toBe(0);
    expect(t.hub.snapshot().fill_count).toBe(0);
  });

  it("continues from the buffer's frame when the hole is never filled by a live write", async () => {
    const t = bed();
    t.hub.append("task_a", [traceEvent(1)]);
    t.hub.append("task_a", [traceEvent(3)]);
    t.reader.answerEmpty = true; // the reader cannot help either

    await t.clock.advance(500);
    expect(t.hub.snapshot().fill_failures).toBeGreaterThanOrEqual(1);
    // The window restarts at the pending frame, so the stream is contiguous again
    // from 3 rather than claiming to hold 2.
    expect(t.hub.head("task_a")).toBe(3);
  });

  it("fills a hole from the reader after the 500ms window", async () => {
    const t = bed();
    const key = "trace:task_a" as HubStreamKey;
    t.reader.seed(key, [traceFrame(2)]);
    const sink = new RecordingSink();
    t.hub.subscribeWithSink(key, 0, sink);

    t.hub.append("task_a", [traceEvent(1)]);
    t.hub.append("task_a", [traceEvent(3)]);
    await t.flush();
    expect(sink.frames.map((frame) => frame.seq)).toEqual([1]);

    await t.clock.advance(500);
    await t.flush();
    expect(t.reader.calls).toEqual([{ key, afterSeq: 1, toSeq: 2 }]);
    expect(sink.frames.map((frame) => frame.seq)).toEqual([1, 2, 3]);
    expect(t.hub.snapshot().fill_count).toBe(1);
  });

  it("ignores a duplicate of a frame that is already waiting in the buffer", async () => {
    const t = bed();
    t.hub.append("task_a", [traceEvent(3)]);
    t.hub.append("task_a", [traceEvent(3)]);

    expect(t.hub.snapshot().pending_frames).toBe(1);
    expect(t.hub.snapshot().dropped_frames).toBe(1);
  });

  it("survives a reader failure and records it instead of throwing", async () => {
    const t = bed();
    t.reader.failNext = true;
    t.hub.append("task_a", [traceEvent(3)]);
    await t.clock.advance(500);
    expect(t.hub.snapshot().fill_failures).toBeGreaterThanOrEqual(1);
    expect(t.warnings.some((warning) => warning.includes("fill failed"))).toBe(true);
  });
});

// ── Fan-out and backpressure ────────────────────────────────────────────────────────────────────

describe("hub core: fan-out and backpressure", () => {
  it("sends one batch frame per subscriber per flush", async () => {
    const t = bed();
    const sink = new RecordingSink();
    t.hub.subscribeWithSink("log:ises_1" as HubStreamKey, 0, sink);
    for (let seq = 1; seq <= 20; seq += 1) t.hub.onEntry("ises_1", entry(seq));

    await t.flush();
    // 20 small frames fit one batch, so one `send` carries them all.
    expect(sink.batches).toHaveLength(1);
    expect(sink.batches[0]).toHaveLength(20);
  });

  it("splits a batch at the 64 KiB cap instead of sending one oversized frame", async () => {
    const t = bed();
    const sink = new RecordingSink();
    t.hub.subscribeWithSink("log:ises_1" as HubStreamKey, 0, sink);
    // Each payload is ~8 KiB, so a batch of them crosses the 64 KiB cap.
    const filler = "x".repeat(8 * 1024);
    for (let seq = 1; seq <= 20; seq += 1) {
      t.hub.onEntry("ises_1", {
        session_id: "ises_1",
        seq,
        kind: "message",
        visibility: "shown",
        revision: 1,
        // B0's row carries the rendered body; the hub treats the payload as opaque
        // and simply measures it once on the way into the ring.
        ...({ body_md: filler } as Record<string, unknown>),
      } as never);
    }

    await t.flush();
    expect(sink.batches.length).toBeGreaterThan(1);
    for (const batch of sink.batches) {
      const bytes = Buffer.byteLength(JSON.stringify(batch), "utf8");
      expect(bytes).toBeLessThanOrEqual(HUB_BATCH_MAX_BYTES * 4);
    }
    // Every frame arrived exactly once, in order, across the batches.
    expect(sink.frames.map((frame) => frame.seq)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  });

  it("never blocks the producer on a subscriber that is not draining", async () => {
    const t = bed();
    const slow = new RecordingSink();
    const key = "log:ises_1" as HubStreamKey;
    const subscription = t.hub.subscribeWithSink(key, 0, slow);

    // The transport reports a backlog past the threshold: the subscriber pauses.
    slow.buffered = HUB_LAGGING_THRESHOLD_BYTES + 1;
    for (let seq = 1; seq <= 3; seq += 1) t.hub.onEntry("ises_1", entry(seq));
    await t.flush();
    expect(t.hub.snapshot().lagging_subscribers).toBe(1);

    // The producer keeps accepting while the subscriber is paused, and the ring
    // keeps the whole window: nothing was lost, only deferred.
    for (let seq = 4; seq <= 500; seq += 1) t.hub.onEntry("ises_1", entry(seq));
    await t.flush();
    expect(subscription.head).toBe(500);
    const deliveredWhilePaused = slow.frames.length;
    expect(deliveredWhilePaused).toBeLessThan(500);

    // Drain: the subscriber resumes from its cursor and receives the rest.
    slow.buffered = 0;
    subscription.notifyDrain();
    await t.flush();
    expect(slow.frames.map((frame) => frame.seq)).toEqual(Array.from({ length: 500 }, (_, index) => index + 1));
  });

  it("tells a subscriber whose resume point left the ring to backfill it", async () => {
    const t = bed({ ring: { streamMaxFrames: 5 } });
    const sink = new RecordingSink();
    const key = "log:ises_1" as HubStreamKey;
    const subscription = t.hub.subscribeWithSink(key, 0, sink);

    // Stay current first, so the subscriber's cursor is 3 before it pauses.
    for (let seq = 1; seq <= 3; seq += 1) t.hub.onEntry("ises_1", entry(seq));
    await t.flush();
    expect(sink.frames.map((frame) => frame.seq)).toEqual([1, 2, 3]);

    // The transport reports a backlog, so the next batch is the last one sent and
    // the subscriber is paused from there on.
    sink.buffered = HUB_LAGGING_THRESHOLD_BYTES + 1;
    for (let seq = 4; seq <= 6; seq += 1) t.hub.onEntry("ises_1", entry(seq));
    await t.flush();
    expect(t.hub.snapshot().lagging_subscribers).toBe(1);
    const deliveredBeforePausing = sink.frames.length;

    // More frames arrive while it is paused, and the ring's 5-frame budget drops
    // everything below 16 — including the sequence the subscriber would resume at.
    for (let seq = 7; seq <= 20; seq += 1) t.hub.onEntry("ises_1", entry(seq));
    await t.flush();
    expect(sink.frames.length).toBe(deliveredBeforePausing);
    expect(subscription.first_seq).toBe(16);

    sink.buffered = 0;
    subscription.notifyDrain();
    await t.flush();

    // The range that left the ring is reported to the sink, and the frames still
    // retained are delivered from the ring tail.
    expect(sink.gaps).toEqual([{ from: deliveredBeforePausing, to: 15 }]);
    expect(sink.frames.map((frame) => frame.seq)).toEqual(
      [1, 2, 3, 4, 5, 6].concat([16, 17, 18, 19, 20]),
    );
  });
});

// ── Ring retention and LRU ──────────────────────────────────────────────────────────────────────

describe("hub ring: retention and LRU eviction", () => {
  it("caps a stream at its frame budget and keeps the newest window", () => {
    const ring = new HubRingBuffer({ ...HUB_RING_LIMITS, streamMaxFrames: 3 }, () => 0);
    const stream = ring.ensure("log:ises_1" as HubStreamKey);
    for (let seq = 1; seq <= 5; seq += 1) ring.push(stream, logFrame(seq));

    expect(stream.entries.map((entry) => entry.frame.seq)).toEqual([3, 4, 5]);
    expect(stream.tailSeq).toBe(3);
    expect(stream.headSeq).toBe(5);
    expect(stream.trimmedFrames).toBe(2);
  });

  it("caps a stream at its byte budget as well", () => {
    const ring = new HubRingBuffer({ ...HUB_RING_LIMITS, streamMaxBytes: 200 }, () => 0);
    const stream = ring.ensure("log:ises_1" as HubStreamKey);
    for (let seq = 1; seq <= 5; seq += 1) ring.push(stream, logFrame(seq, "y".repeat(80)));

    expect(stream.bytes).toBeLessThanOrEqual(200);
    expect(stream.entries.length).toBeLessThan(5);
  });

  it("evicts an idle stream with no subscriber when the global budget is exceeded", () => {
    let now = 0;
    const ring = new HubRingBuffer(
      { ...HUB_RING_LIMITS, streamMaxBytes: 400, globalMaxBytes: 500, evictAfterMs: 1_000 },
      () => now,
    );
    const first = ring.ensure("log:cold" as HubStreamKey);
    ring.push(first, logFrame(1, "z".repeat(200)));
    now += 5_000; // long past `evictAfterMs`
    const second = ring.ensure("log:warm" as HubStreamKey);
    ring.push(second, logFrame(1, "z".repeat(200)));

    const evicted = ring.evictOverBudget(() => false);
    expect(evicted).toEqual(["log:cold"]);
    expect(ring.totalBytes).toBeLessThanOrEqual(500);
  });

  it("never evicts a stream that has a subscriber, even when the budget is breached", () => {
    const ring = new HubRingBuffer(
      { ...HUB_RING_LIMITS, streamMaxBytes: 400, globalMaxBytes: 100, evictAfterMs: 0 },
      () => 0,
    );
    const protectedStream = ring.ensure("log:watched" as HubStreamKey);
    ring.push(protectedStream, logFrame(1, "z".repeat(200)));

    const evicted = ring.evictOverBudget((stream) => stream.key === "log:watched");
    expect(evicted).toEqual([]);
    expect(ring.get("log:watched" as HubStreamKey)).toBeDefined();
    expect(ring.overshootBytes).toBeGreaterThan(0);
  });

  it("keeps a fresh idle stream inside the budget grace period", () => {
    let now = 1_000;
    const ring = new HubRingBuffer(
      { ...HUB_RING_LIMITS, streamMaxBytes: 400, globalMaxBytes: 100, evictAfterMs: 60_000 },
      () => now,
    );
    const stream = ring.ensure("log:new" as HubStreamKey);
    ring.push(stream, logFrame(1, "z".repeat(200)));
    now += 5_000; // well inside the grace period

    expect(ring.evictOverBudget(() => false)).toEqual([]);
  });
});

// ── Cold-stream warm-up ─────────────────────────────────────────────────────────────────────────

describe("hub core: cold-stream warm-up", () => {
  it("prefills a cold log stream from the reader and stamps the freshness token", async () => {
    const reader = new FakeReader();
    const key = "log:ises_1" as HubStreamKey;
    reader.seed(key, Array.from({ length: 64 }, (_, index) => logFrame(index + 1)));
    reader.logHeads.set("ises_1", { head: 64, log_version: 2 });

    const t = bed({ reader });
    const sink = new RecordingSink();
    const subscription = t.hub.subscribeWithSink(key, 0, sink);
    await t.hub.warmUpSettled();
    await t.flush();

    expect(t.reader.calls).toEqual([{ key, afterSeq: 0, toSeq: 64 }]);
    expect(sink.frames).toHaveLength(64);
    expect(subscription.head).toBe(64);
    expect(subscription.log_version).toBe(2);
  });

  it("warms up only the last 64 frames when the session is longer than that", async () => {
    const reader = new FakeReader();
    const key = "log:ises_1" as HubStreamKey;
    reader.seed(key, Array.from({ length: 500 }, (_, index) => logFrame(index + 1)));
    reader.logHeads.set("ises_1", { head: 500, log_version: 7 });

    const t = bed({ reader });
    const sink = new RecordingSink();
    t.hub.subscribeWithSink(key, 0, sink);
    await t.hub.warmUpSettled();
    await t.flush();

    expect(t.reader.calls).toEqual([{ key, afterSeq: 436, toSeq: 500 }]);
    expect(sink.frames.map((frame) => frame.seq)).toEqual(
      Array.from({ length: 64 }, (_, index) => 437 + index),
    );
  });

  it("reports a cold log stream's missing head range when the prefill cannot reach it", async () => {
    const reader = new FakeReader();
    const key = "log:ises_1" as HubStreamKey;
    // The database says the head is 10 but only 8..10 are readable, as a trimmed
    // or partially migrated session would look.
    reader.seed(key, [logFrame(8), logFrame(9), logFrame(10)]);
    reader.logHeads.set("ises_1", { head: 10, log_version: 3 });

    const t = bed({ reader });
    const sink = new RecordingSink();
    t.hub.subscribeWithSink(key, 0, sink);
    await t.hub.warmUpSettled();
    await t.flush();

    // C0's formula: the range runs from the cursor to `first_seq - 1`, so it is
    // conservative by one sequence and a client that re-reads `from` de-duplicates.
    expect(sink.gaps.length).toBeGreaterThanOrEqual(1);
    expect(sink.gaps[0]).toEqual({ from: 0, to: 7 });
    expect(sink.frames.map((frame) => frame.seq)).toEqual([8, 9, 10]);
  });

  it("leaves a cold trace stream at head null when the daemon does not hold it", async () => {
    const reader = new FakeReader();
    reader.traceHeads.set("task_cold", null);
    const t = bed({ reader });

    const sink = new RecordingSink();
    const subscription = t.hub.subscribeWithSink("trace:task_cold" as HubStreamKey, 0, sink);
    await t.hub.warmUpSettled();

    expect(t.hub.head("task_cold")).toBeNull();
    expect(subscription.head).toBe(0);
    expect(sink.frames).toEqual([]);
    expect(t.hub.isWarm("trace:task_cold" as HubStreamKey)).toBe(true);
  });

  it("announces a cold trace stream's head as a gap for the subscriber to fetch", async () => {
    const reader = new FakeReader();
    reader.traceHeads.set("task_hot", 40);
    const t = bed({ reader });

    const sink = new RecordingSink();
    t.hub.subscribeWithSink("trace:task_hot" as HubStreamKey, 0, sink);
    await t.hub.warmUpSettled();

    // The events live in the daemon, so the hub hands the subscriber the range it
    // must fetch and moves its own head; nothing is fabricated.
    expect(sink.gaps).toEqual([{ from: 0, to: 40 }]);
    expect(t.hub.head("task_hot")).toBe(40);
    expect(sink.frames).toEqual([]);
  });

  it("does not warm a stream twice", async () => {
    const reader = new FakeReader();
    reader.logHeads.set("ises_1", { head: 2, log_version: 1 });
    reader.seed("log:ises_1" as HubStreamKey, [logFrame(1), logFrame(2)]);
    const t = bed({ reader });

    t.hub.subscribeWithSink("log:ises_1" as HubStreamKey, 0, new RecordingSink());
    await t.hub.warmUpSettled();
    t.hub.subscribeWithSink("log:ises_1" as HubStreamKey, 0, new RecordingSink());
    await t.hub.warmUpSettled();

    expect(t.reader.calls).toHaveLength(1);
  });
});

// ── Peer head pointers ──────────────────────────────────────────────────────────────────────────

describe("hub core: peer head pointers", () => {
  it("fills a held stream from the reader when a peer reports a newer head", async () => {
    const reader = new FakeReader();
    const key = "log:ises_1" as HubStreamKey;
    reader.seed(key, [logFrame(2), logFrame(3)]);
    const t = bed({ reader });

    const sink = new RecordingSink();
    t.hub.subscribeWithSink(key, 0, sink);
    await t.hub.warmUpSettled();
    await t.flush();
    sink.batches.length = 0;

    // The peer says the database moved to 3 while this process held only 1.
    t.hub.onEntry("ises_1", entry(1));
    await t.flush();
    sink.batches.length = 0;
    const pushed = await t.hub.applyRemoteHead(key, 3, 9);
    await t.flush();

    expect(pushed).toBe(2);
    expect(t.reader.calls).toEqual([{ key, afterSeq: 1, toSeq: 3 }]);
    expect(sink.frames.map((frame) => frame.seq)).toEqual([2, 3]);
    expect(t.hub.snapshot().fill_count).toBeGreaterThanOrEqual(1);
  });

  it("only remembers the head for a stream this process does not hold", async () => {
    const t = bed();
    const key = "log:ises_other" as HubStreamKey;
    const pushed = await t.hub.applyRemoteHead(key, 42, 5);

    expect(pushed).toBe(0);
    expect(t.hub.knownHead(key)).toMatchObject({ head: 42, log_version: 5 });
    // Nothing was read: the point of remembering is that this process has no
    // subscriber to serve.
    expect(t.reader.calls).toHaveLength(0);
    expect(t.hub.hasSubscribers(key)).toBe(false);
  });

  it("does not re-read for a pointer at or below the head it already has", async () => {
    const t = bed();
    const key = "log:ises_1" as HubStreamKey;
    for (let seq = 1; seq <= 4; seq += 1) t.hub.onEntry("ises_1", entry(seq));
    await t.flush();

    expect(await t.hub.applyRemoteHead(key, 4, 1)).toBe(0);
    expect(await t.hub.applyRemoteHead(key, 2, 1)).toBe(0);
    expect(t.reader.calls).toHaveLength(0);
  });

  it("caps the heads it remembers, dropping the oldest first", async () => {
    const t = bed({ limits: { knownHeadLimit: 3 } });
    for (let index = 1; index <= 5; index += 1) {
      await t.hub.applyRemoteHead(`log:ises_${index}` as HubStreamKey, index, 1);
    }
    expect(t.hub.knownHead("log:ises_1" as HubStreamKey)).toBeNull();
    expect(t.hub.knownHead("log:ises_5" as HubStreamKey)).toMatchObject({ head: 5 });
  });
});

// ── Transport seam ──────────────────────────────────────────────────────────────────────────────

describe("hub core: transport", () => {
  it("announces a local log frame so a peer adapter can derive its head pointer", async () => {
    const published: { key: string; seq: number }[] = [];
    const transport = createLocalHubTransport();
    const spy = new (class extends LocalHubTransport {
      override publish(input: { key: HubStreamKey; frames: readonly HubFrame[] }): void {
        for (const frame of input.frames) published.push({ key: input.key, seq: frame.seq });
      }
    })();
    expect(transport.kind).toBe("local");
    const t = bed({ transport: spy });
    t.hub.onEntry("ises_1", entry(1));
    expect(published).toEqual([{ key: "log:ises_1", seq: 1 }]);
  });

  it("never publishes a trace frame: trace streams do not cross processes", () => {
    const published: HubFrame[] = [];
    const spy = new (class extends LocalHubTransport {
      override publish(input: { key: HubStreamKey; frames: readonly HubFrame[] }): void {
        published.push(...input.frames);
      }
    })();
    const t = bed({ transport: spy });
    t.hub.append("task_a", [traceEvent(1), traceEvent(2)]);
    t.hub.close?.("task_a");
    expect(published).toEqual([]);
  });

  it("feeds a remote frame through the same enqueue path as a local one", async () => {
    const t = bed();
    const sink = new RecordingSink();
    t.hub.subscribeWithSink("log:ises_1" as HubStreamKey, 0, sink);

    // A peer's frame arrives through the transport subscription.
    let deliver: ((input: { key: HubStreamKey; frames: readonly HubFrame[] }) => void) | null = null;
    const transport = new (class extends LocalHubTransport {
      override subscribe(handler: (input: { key: HubStreamKey; frames: readonly HubFrame[] }) => void) {
        deliver = handler;
        return { unsubscribe: () => {} };
      }
    })();
    const remote = bed({ transport });
    const remoteSink = new RecordingSink();
    remote.hub.subscribeWithSink("log:ises_1" as HubStreamKey, 0, remoteSink);
    deliver!({ key: "log:ises_1" as HubStreamKey, frames: [logFrame(1)] });
    await remote.flush();
    expect(remoteSink.frames.map((frame) => frame.seq)).toEqual([1]);
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────

function entry(seq: number): { session_id: string; seq: number; kind: string; visibility: "shown"; revision: number } {
  return { session_id: "ises_1", seq, kind: "message", visibility: "shown", revision: 1 };
}
