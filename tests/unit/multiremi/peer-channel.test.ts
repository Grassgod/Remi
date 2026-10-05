// MUL-462: the sending half of the peer channel — batching by count and by real
// serialized bytes, ordering, backoff, the queue caps, splitting, degradation,
// dedupe on retry, and the fact that `MULTIREMI_PEER_URL` unset means "inert".
import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { Hono } from "hono";
import { registerPeerRoutes } from "../../../packages/server/src/api/peer/peer-routes.js";
import {
  PEER_MAX_BATCH_BYTES,
  PEER_MAX_EVENT_BYTES,
  PEER_MAX_QUEUE_BYTES,
  PEER_REALTIME_TOPIC,
  createPeerChannel,
  createPeerChannelFromEnv,
  resolvePeerSecret,
  resolvePeerUrl,
  type PeerChannel,
  type PeerFetch,
} from "../../../packages/server/src/api/peer/peer-channel.js";
import { parsePeerEventBatch } from "@multiremi/contracts/peer-events.js";
import { peerMetricsSnapshot, resetRequestMetricsForTest } from "@multiremi/observability/request-metrics.js";

/** One POST attempt. Attempts that happened while the peer was offline are kept
 *  but flagged, so a delivery assertion can
 *  look at `delivered` instead of `posts`. */
interface Post {
  url: string;
  body: string;
  parsed: { topic: string; epoch: string; batch_seq: number; events: unknown[] };
  authorization: string | null;
  at: number;
  ok: boolean;
}

/**
 * A stub peer that can be paused, so a case can watch the queue fill and the
 * backoff schedule instead of racing the real network.
 *
 * `dropAck` throws after recording the attempt, which is exactly an ACK lost on
 * the way back: the receiver handled the batch, the sender never learned it.
 */
function fakePeer(options: { fail?: boolean } = {}) {
  const posts: Post[] = [];
  let online = options.fail !== true;
  let delayMs = 0;
  let startedAt = performance.now();
  const fetchImpl: PeerFetch = async (url, init) => {
    const body = String(init.body);
    const parsed = JSON.parse(body) as Post["parsed"];
    const headers = new Headers(init.headers);
    if (delayMs > 0) await Bun.sleep(delayMs);
    if (!online) {
      posts.push({ url, body, parsed, authorization: headers.get("Authorization"), at: performance.now() - startedAt, ok: false });
      throw new Error("peer offline");
    }
    posts.push({ url, body, parsed, authorization: headers.get("Authorization"), at: performance.now() - startedAt, ok: true });
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return {
    fetchImpl,
    posts,
    goOffline: () => { online = false; },
    goOnline: () => { online = true; },
    setDelay: (ms: number) => { delayMs = ms; },
    resetClock: () => { startedAt = performance.now(); },
    /** Every payload the peer actually accepted, in order. */
    payloads: () => posts.filter((post) => post.ok).flatMap((post) => post.parsed.events),
  };
}

/**
 * Wait until `check` holds, or fail with `label` after `timeoutMs`.
 *
 * Cases that assert on a *completed* flush must wait for `batches`/`sent`,
 * never for `queued === 0`: the queue empties when a batch is taken, which is
 * before the POST it belongs to has finished.
 */
async function waitFor(check: () => boolean, label: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** Wait for `count` completed POSTs. */
function waitForBatches(count: number, timeoutMs = 4_000): Promise<void> {
  return waitFor(() => channel!.stats().batches === count, `${count} completed batches`, timeoutMs);
}

/** A well-formed realtime batch body. */
function batchBody(overrides: {
  topic?: string;
  epoch?: string;
  batchSeq?: number;
  events: unknown[];
}): Record<string, unknown> {
  return {
    topic: overrides.topic ?? PEER_REALTIME_TOPIC,
    epoch: overrides.epoch ?? "process-b",
    batch_seq: overrides.batchSeq ?? 1,
    events: overrides.events,
  };
}

/** A realtime envelope shaped like the fanout sends. */
function envelope(kind: string, payload: Record<string, unknown>, origin = "process-b") {
  return { v: 1, origin, kind, payload };
}

/** A task message as the store persists it, with a content of `bytes`. */
function message(seq: number, bytes: number) {
  return {
    id: `msg_${seq}`,
    taskId: "tsk_1",
    seq,
    type: "assistant",
    tool: null,
    content: "x".repeat(bytes),
    input: null,
    output: null,
    toolCallId: null,
    status: null,
    meta: null,
    createdAt: "2026-09-27T00:00:00.000Z",
  };
}

const TASK = { id: "tsk_1", workspaceId: "local", agentId: "agt_1" };

let channel: PeerChannel | null = null;

beforeEach(() => {
  resetRequestMetricsForTest();
});

afterEach(() => {
  channel?.close();
  channel = null;
  resetRequestMetricsForTest();
});

describe("peer channel — configuration", () => {
  it("stays off when MULTIREMI_PEER_URL is unset", () => {
    expect(resolvePeerUrl({})).toBeNull();
    expect(resolvePeerUrl({ MULTIREMI_PEER_URL: "   " })).toBeNull();
    expect(createPeerChannelFromEnv({})).toBeNull();

    // A channel constructed without a URL is inert rather than throwing: the
    // server always builds one object and asks it whether it is enabled.
    const inert = createPeerChannel({ url: null });
    inert.publish(PEER_REALTIME_TOPIC, { hello: true });
    expect(inert.enabled).toBe(false);
    expect(inert.stats()).toMatchObject({ enabled: false, queued: 0, sent: 0, batches: 0 });
    inert.close();
  });

  it("prefers MULTIREMI_PEER_SECRET and falls back to MULTIREMI_TOKEN", () => {
    expect(resolvePeerSecret({ MULTIREMI_PEER_SECRET: "peer-secret", MULTIREMI_TOKEN: "master" })).toBe("peer-secret");
    expect(resolvePeerSecret({ MULTIREMI_TOKEN: "master" })).toBe("master");
    expect(resolvePeerSecret({ MULTIREMI_PEER_SECRET: "  " })).toBe("");
  });

  it("strips a trailing slash from the peer URL so the path is not doubled", async () => {
    expect(resolvePeerUrl({ MULTIREMI_PEER_URL: "http://peer:6120/" })).toBe("http://peer:6120");
    const fetched: string[] = [];
    const env = createPeerChannelFromEnv(
      { MULTIREMI_PEER_URL: "http://peer:6120/" },
      { fetchImpl: ((url: string) => { fetched.push(url); return Promise.resolve(new Response("{}")); }) as PeerFetch },
    )!;
    try {
      env.forwardRealtime("task_event", { type: "task:done", task: TASK, task_id: TASK.id });
      await waitFor(() => fetched.length > 0, "first post");
      expect(fetched[0]).toBe("http://peer:6120/internal/peer/events");
    } finally {
      env.close();
    }
  });
});

describe("peer channel — sending", () => {
  it("batches everything enqueued in one tick into a single authenticated POST", async () => {
    const peer = fakePeer();
    channel = createPeerChannel({ url: "http://peer:6120", secret: "peer-secret", fetchImpl: peer.fetchImpl });

    channel.forwardRealtime("task_event", { type: "task:done", task: TASK, task_id: TASK.id });
    channel.forwardRealtime("task_event", { type: "task:failed", task: TASK, task_id: TASK.id });
    await waitForBatches(1);

    expect(peer.posts).toHaveLength(1);
    const post = peer.posts[0]!;
    expect(post.url).toBe("http://peer:6120/internal/peer/events");
    expect(post.authorization).toBe("Bearer peer-secret");
    expect(post.parsed.topic).toBe(PEER_REALTIME_TOPIC);
    expect(post.parsed.epoch).toBeTruthy();
    expect(post.parsed.batch_seq).toBe(1);
    expect(post.parsed.events).toHaveLength(2);
    expect(channel.stats()).toMatchObject({ sent: 2, batches: 1, failed: 0, queued: 0 });
  });

  it("caps one batch at the configured event count", async () => {
    const peer = fakePeer();
    channel = createPeerChannel({
      url: "http://peer:6120",
      secret: "s",
      fetchImpl: peer.fetchImpl,
      maxBatchEvents: 4,
    });
    peer.setDelay(20);

    for (let index = 0; index < 10; index += 1) {
      channel.forwardRealtime("task_event", { type: `task:e${index}`, task: TASK, task_id: TASK.id });
    }
    await waitFor(() => channel!.stats().batches === 3, "every batch to land", 3_000);

    expect(peer.posts.map((post) => post.parsed.events.length)).toEqual([4, 4, 2]);
    expect(peer.payloads().map((event: any) => event.payload.type))
      .toEqual(Array.from({ length: 10 }, (_, index) => `task:e${index}`));
  });

  it("caps one batch at the byte budget, measuring the body it really builds", async () => {
    const peer = fakePeer();
    // Room for the wrapper plus about one small event.
    channel = createPeerChannel({
      url: "http://peer:6120",
      secret: "s",
      fetchImpl: peer.fetchImpl,
      maxBatchEvents: 64,
      maxBatchBytes: 400,
    });
    peer.setDelay(10);

    for (let index = 0; index < 5; index += 1) {
      channel.forwardRealtime("task_event", { type: `t${index}`, task: TASK, task_id: TASK.id });
    }
    await waitFor(() => channel!.stats().queued === 0 && channel!.stats().batches > 0, "the byte-capped batches");

    expect(channel!.stats().batches).toBeGreaterThan(1);
    for (const post of peer.posts) {
      expect(Buffer.byteLength(post.body, "utf8")).toBeLessThanOrEqual(400);
    }
  });

  it("drops an event that cannot fit one body, counts it, and warns without the payload", async () => {
    const warnings: Array<{ topic: string; kind: string | null; bytes: number }> = [];
    const peer = fakePeer();
    channel = createPeerChannel({
      url: "http://peer:6120",
      secret: "s",
      fetchImpl: peer.fetchImpl,
      maxBatchEvents: 64,
      maxBatchBytes: 256,
      onOversizeDrop: (info) => warnings.push(info),
    });

    // An opaque payload on a topic with no degradation rule: bytes alone decide.
    channel.publish("hub", { blob: "x".repeat(2_000) });
    await waitFor(() => channel!.stats().oversize_dropped === 1, "the oversize drop");

    expect(peer.posts).toHaveLength(0);
    // Oversize is its own counter: this event was never in the queue, so it is
    // not a backlog eviction and must not be counted as one.
    expect(channel.stats()).toMatchObject({ sent: 0, dropped: 0, oversize_dropped: 1, queued: 0 });
    expect(peerMetricsSnapshot()).toMatchObject({ dropped: 0, oversize_dropped: 1 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ topic: "hub", kind: null });
    expect(warnings[0]!.bytes).toBeGreaterThan(2_000);
  });

  it("keeps order across batches by never overlapping requests", async () => {
    const peer = fakePeer();
    channel = createPeerChannel({
      url: "http://peer:6120",
      secret: "s",
      fetchImpl: peer.fetchImpl,
      maxBatchEvents: 5,
    });
    peer.setDelay(15);

    for (let seq = 1; seq <= 100; seq += 1) {
      channel.forwardRealtime("task_event", { type: `seq:${seq}`, task: TASK, task_id: TASK.id });
    }
    await waitFor(() => channel!.stats().batches === 20, "all 100 events", 5_000);

    expect(peer.payloads().map((event: any) => event.payload.type))
      .toEqual(Array.from({ length: 100 }, (_, index) => `seq:${index + 1}`));
    // The batch numbers are the sender's monotonic handshake, in order.
    expect(peer.posts.map((post) => post.parsed.batch_seq)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
  });

  it("drops the oldest events and counts them when the queue is full", async () => {
    const peer = fakePeer();
    channel = createPeerChannel({
      url: "http://peer:6120",
      secret: "s",
      fetchImpl: peer.fetchImpl,
      queueLimit: 5,
      maxBatchEvents: 5,
    });
    peer.goOffline();

    for (let seq = 1; seq <= 20; seq += 1) {
      channel.forwardRealtime("task_event", { type: `seq:${seq}`, task: TASK, task_id: TASK.id });
    }
    await waitFor(() => channel!.stats().dropped >= 14, "overflow to be counted");

    // The cap bounds the *backlog*: each produce call trims what was already
    // queued down to the cap and then admits its own burst whole, so the queue
    // may sit one burst above the cap and never grows past that.
    const stats = channel.stats();
    expect(stats.queued).toBeLessThanOrEqual(5 + 1);
    expect(stats.dropped).toBe(20 - stats.queued);
    expect(peerMetricsSnapshot().dropped).toBe(stats.dropped);
  });

  it("drops the oldest events once the queue byte budget is spent, even under the count cap", async () => {
    const peer = fakePeer();
    channel = createPeerChannel({
      url: "http://peer:6120",
      secret: "s",
      fetchImpl: peer.fetchImpl,
      // 4 KiB of queue, events of roughly 1 KiB each: the byte budget binds long
      // before the 10 000-event cap could. The batch budget is small as well, so
      // the queue floor (one batch) stays below the queue budget under test.
      maxQueueBytes: 4 * 1024,
      maxBatchBytes: 2 * 1024,
      maxEventBytes: 2 * 1024,
      queueLimit: 10_000,
    });
    peer.goOffline();

    for (let seq = 1; seq <= 30; seq += 1) {
      channel.forwardRealtime("task_event", {
        type: `seq:${seq}`,
        task: TASK,
        task_id: TASK.id,
        filler: "y".repeat(900),
      });
    }
    await waitFor(() => channel!.stats().dropped > 0, "the byte budget to evict", 2_000);

    // Same invariant as the count cap: backlog <= budget, plus the burst in hand.
    expect(channel.stats().queued_bytes).toBeLessThanOrEqual(4 * 1024 + 2 * 1024);
    expect(channel.stats().queued).toBeLessThan(30);
    expect(channel.stats().dropped).toBe(30 - channel.stats().queued);
  });

  it("bounds the queue across a burst of maximum-size reports instead of growing with the tick", async () => {
    // 12 maximum legal reports (~64 MiB each) produced in one tick against a peer
    // that never answers. A budget enforced only at flush boundaries let this
    // queue 769 MiB; the invariant is `budget + one burst`.
    const peer = fakePeer();
    channel = createPeerChannel({ url: "http://peer:6120", secret: "s", fetchImpl: peer.fetchImpl });
    peer.goOffline();
    peer.setDelay(1);

    let peakBytes = 0;
    for (let round = 0; round < 12; round += 1) {
      channel.forwardRealtime("task_messages", {
        task: TASK,
        task_id: TASK.id,
        messages: Array.from({ length: 256 }, (_, index) => message(index + 1, 256 * 1024)),
      });
      peakBytes = Math.max(peakBytes, channel!.stats().queued_bytes);
    }

    const burstBytes = 256 * 256 * 1024;
    // One in-flight batch may already be out of the queue, so allow that slack.
    expect(peakBytes).toBeLessThanOrEqual(PEER_MAX_QUEUE_BYTES + burstBytes + PEER_MAX_BATCH_BYTES);
    // Persisted messages retain delivery via references when the byte budget
    // binds; count-cap evictions are covered separately above.
    expect(channel.stats().degraded).toBeGreaterThan(0);
    expect(channel.stats().oversize_dropped).toBe(0);
  }, 60_000);

  it("does not block the caller and reports the failure once the peer is back", async () => {
    const peer = fakePeer();
    channel = createPeerChannel({
      url: "http://peer:6120",
      secret: "s",
      fetchImpl: peer.fetchImpl,
      minBackoffMs: 20,
      maxBackoffMs: 40,
    });
    peer.goOffline();

    const startedAt = performance.now();
    channel.forwardRealtime("task_event", { type: "task:done", task: TASK, task_id: TASK.id });
    const publishMs = performance.now() - startedAt;
    // Publishing hands off to the queue; the store write that produced the event
    // must never wait on the peer.
    expect(publishMs).toBeLessThan(20);

    await waitFor(() => channel!.stats().failed >= 1, "the first failed attempt");
    expect(channel.healthy()).toBe(false);
    // The attempted batch moved into the frozen retry slot; it is no longer part
    // of the queue, which is what protects it from the cap.
    expect(channel.stats()).toMatchObject({ queued: 0, inflight: 1 });

    peer.goOnline();
    await waitForBatches(1);
    expect(channel.stats().sent).toBe(1);
    expect(channel.healthy()).toBe(true);
    expect(peer.payloads()).toHaveLength(1);
  });

  it("backs off from 1s toward 10s instead of hammering a dead peer", async () => {
    jest.useFakeTimers();
    const advance = async (ms: number) => {
      jest.advanceTimersByTime(ms);
      // Complete the async POST and its serial flush chain before the next tick.
      for (let index = 0; index < 8; index++) await Promise.resolve();
    };
    try {
      const peer = fakePeer({ fail: true });
      channel = createPeerChannel({ url: "http://peer:6120", secret: "s", fetchImpl: peer.fetchImpl });
      channel.forwardRealtime("task_event", { type: "task:done", task: TASK, task_id: TASK.id });
      await advance(1);
      expect(channel.stats().failed).toBe(1);
      for (const delay of [1_000, 2_000, 4_000, 8_000, 10_000, 10_000]) {
        const before = peer.posts.length;
        await advance(delay - 1);
        expect(peer.posts).toHaveLength(before);
        await advance(1);
        await advance(1); // The retry schedules the zero-delay batching tick.
        expect(peer.posts).toHaveLength(before + 1);
        expect(channel.stats().failed).toBe(before + 1);
      }
      peer.goOnline();
      await advance(10_000);
      await advance(1);
      expect(channel.stats()).toMatchObject({ batches: 1, sent: 1, failed: 7 });
      expect(channel.healthy()).toBe(true);
      expect(peer.payloads()).toHaveLength(1);
    } finally {
      channel?.close();
      jest.useRealTimers();
    }
  });

  it("reuses one serial chain when a burst arrives while a batch is in flight", async () => {
    const peer = fakePeer();
    channel = createPeerChannel({
      url: "http://peer:6120",
      secret: "s",
      fetchImpl: peer.fetchImpl,
      maxBatchEvents: 3,
    });
    peer.setDelay(30);

    channel.forwardRealtime("task_event", { type: "burst:1", task: TASK, task_id: TASK.id });
    await waitFor(() => peer.posts.length === 1, "the first post");
    for (const n of [2, 3, 4]) {
      channel.forwardRealtime("task_event", { type: `burst:${n}`, task: TASK, task_id: TASK.id });
    }
    await waitForBatches(2);

    expect(peer.payloads().map((event: any) => event.payload.type))
      .toEqual(["burst:1", "burst:2", "burst:3", "burst:4"]);
    expect(channel.stats()).toMatchObject({ sent: 4, batches: 2 });
  });

  it("counts a non-serializable payload as dropped instead of throwing at the caller", () => {
    const peer = fakePeer();
    channel = createPeerChannel({ url: "http://peer:6120", secret: "s", fetchImpl: peer.fetchImpl });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => channel!.publish("hub", cyclic)).not.toThrow();
    expect(channel.stats().dropped).toBe(1);
    expect(peerMetricsSnapshot().dropped).toBe(1);
  });

  it("stops sending and closes its timers when closed", async () => {
    const peer = fakePeer();
    const channelToClose = createPeerChannel({
      url: "http://peer:6120",
      secret: "s",
      fetchImpl: peer.fetchImpl,
      minBackoffMs: 5,
    });
    peer.goOffline();
    channelToClose.forwardRealtime("task_event", { type: "task:done", task: TASK, task_id: TASK.id });
    await waitFor(() => channelToClose.stats().failed >= 1, "a failure before close");

    const postsAtClose = peer.posts.length;
    channelToClose.close();
    await Bun.sleep(50);
    expect(peer.posts.length).toBeGreaterThanOrEqual(postsAtClose);
    // The retry timer is gone with the channel: no further attempts at all.
    expect(peer.posts.length).toBe(postsAtClose);
    expect(channelToClose.enabled).toBe(false);
    expect(channelToClose.healthy()).toBe(false);
  });
});


describe("peer channel — size limits (QA item 7)", () => {
  /**
   * QA's first counterexample, in two shapes.
   *
   * QA reported 64 events of 16 360 bytes of content shipping a 1 048 598-byte
   * body: the events summed to 1 048 503 and the wrapper pushed the body over
   * the line. That number is a property of QA's envelope, not of the byte count
   * alone — this implementation adds `task_id` to every event, so the same class
   * of counterexample sits at a slightly smaller content size here. The test
   * therefore checks the literal 16 360-byte shape *and* the exact boundary
   * computed from this envelope, so a batch loop that forgets the wrapper is
   * caught even if the envelope changes again.
   */
  it("keeps every POST body at or under 1 MiB for 64 large-but-legal events", async () => {
    const contentSizes = [16_360, largestContentKeeping64EventsAtTheCap()];
    expect(contentSizes[1]!, "the boundary case must be smaller than the reported shape").toBeLessThan(16_360);

    for (const contentBytes of contentSizes) {
      const peer = fakePeer();
      channel?.close();
      channel = createPeerChannel({ url: "http://peer:6120", secret: "s", fetchImpl: peer.fetchImpl, maxBatchEvents: 64 });
      peer.setDelay(5);

      for (let seq = 1; seq <= 64; seq += 1) {
        channel.forwardRealtime("task_messages", {
          task: TASK,
          task_id: TASK.id,
          messages: [message(seq, contentBytes)],
        });
      }
      await waitFor(() => channel!.stats().sent === 64, "every event to land", 20_000);

      // The whole point: no body may exceed one MiB, wrapper included. Before the
      // fix this failed at exactly the reported shape.
      expect(peer.posts.length, `content=${contentBytes}`).toBeGreaterThan(1);
      // Every batch in the run is full: the split is driven by the size cap, not
      // by the event count, which is what makes the boundary meaningful.
      expect(peer.posts.length, `content=${contentBytes}`).toBe(2);
      for (const post of peer.posts) {
        expect(Buffer.byteLength(post.body, "utf8"), `content=${contentBytes}`)
          .toBeLessThanOrEqual(PEER_MAX_BATCH_BYTES);
      }
      // Nothing was dropped or degraded: the events are legal, just large.
      expect(channel.stats(), `content=${contentBytes}`)
        .toMatchObject({ sent: 64, dropped: 0, oversize_dropped: 0, degraded: 0 });
      expect(peer.payloads(), `content=${contentBytes}`).toHaveLength(64);
    }
  });

  /**
   * The largest message content whose 64 events still sum to the batch cap.
   *
   * Bisected against the envelope this channel really builds, over the same
   * 1..64 sequence the test sends — the ids and seq digits differ per event, so a
   * probe on one representative event would land beside the real boundary. At
   * exactly this content size the events fill the cap and only the wrapper can
   * push the body over, which is precisely the bug QA found.
   */
  function largestContentKeeping64EventsAtTheCap(): number {
    const probe = createPeerChannel({ url: "http://peer:6120", secret: "s", fetchImpl: fakePeer().fetchImpl });
    try {
      const totalEventBytes = (contentBytes: number) => {
        let total = 0;
        for (let seq = 1; seq <= 64; seq += 1) {
          total += Buffer.byteLength(JSON.stringify({
            v: 1,
            origin: probe.origin,
            kind: "task_messages",
            payload: { task: TASK, task_id: TASK.id, messages: [message(seq, contentBytes)] },
          }), "utf8");
        }
        return total;
      };
      let low = 1;
      let high = 32_768;
      while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (totalEventBytes(mid) <= PEER_MAX_BATCH_BYTES) low = mid;
        else high = mid - 1;
      }
      return low;
    } finally {
      probe.close();
    }
  }

  /**
   * QA's second counterexample: the daemon's documented maximum report, 256
   * messages of 256 KiB. One event of ~64 MiB would be a ~57 ms stringify on the
   * sender and a ~38 ms parse on the receiver, both past the 50 ms event loop
   * guard. Splitting per message is what makes it legal.
   *
   * The test also carries the measurements QA asked for: the sender's
   * synchronous peer-layer cost (per event and in total) and the receiver's
   * parse + validation cost per batch. A `console.log` line carries them out for
   * the delivery note; the assertions on them are deliberately loose, because a
   * loaded CI runner is not the machine these numbers describe.
   */
  it("splits a 256 × 256 KiB report into legal events, in seq order, measuring both ends", async () => {
    const peer = fakePeer();
    channel = createPeerChannel({ url: "http://peer:6120", secret: "s", fetchImpl: peer.fetchImpl });

    const messages = Array.from({ length: 256 }, (_, index) => message(index + 1, 256 * 1024));
    const reportBytes = messages.reduce((total, item) =>
      total + Buffer.byteLength(JSON.stringify(item), "utf8"), 0);

    // Sender side: everything `forwardRealtime` does synchronously, split and
    // per-event serialization included.
    const publishStartedAt = performance.now();
    channel.forwardRealtime("task_messages", { task: TASK, task_id: TASK.id, messages });
    const publishTotalMs = performance.now() - publishStartedAt;

    // Wait for delivery to finish *or* for the report to be refused: without the
    // split the whole 64 MiB event is oversize, and this case must fail quickly
    // and say why rather than sit on a timeout.
    await waitFor(
      () => channel!.stats().sent === 256 || channel!.stats().oversize_dropped > 0,
      "all 256 messages (or an oversize refusal)",
      60_000,
    );
    expect(channel!.stats().oversize_dropped, "a legal report must never be oversize").toBe(0);

    // Every body fits, every message arrived exactly once, and order is intact.
    for (const post of peer.posts) {
      expect(Buffer.byteLength(post.body, "utf8")).toBeLessThanOrEqual(PEER_MAX_BATCH_BYTES);
    }
    const seqs = peer.payloads().flatMap((event: any) => event.payload.messages
      ? event.payload.messages.map((message: any) => message.seq)
      : Array.from({ length: event.payload.seq_end - event.payload.seq_start + 1 }, (_, index) => event.payload.seq_start + index));
    expect(seqs).toEqual(Array.from({ length: 256 }, (_, index) => index + 1));
    expect(channel.stats()).toMatchObject({ sent: 256, dropped: 0, oversize_dropped: 0 });
    expect(channel.stats().degraded).toBeGreaterThan(0);

    // Receiver side: parse the body the sender produced, then validate and
    // deliver it, which is the work one inbound batch costs.
    const receiver = createPeerChannel({
      url: "http://peer:6120",
      secret: "s",
      origin: "process-receiver",
      fetchImpl: peer.fetchImpl,
    });
    const parseMs: number[] = [];
    const serializeMs: number[] = [];
    try {
      receiver.subscribe(PEER_REALTIME_TOPIC, () => {});
      for (const [index, post] of peer.posts.entries()) {
        const startedAt = performance.now();
        const parsed = JSON.parse(post.body) as Record<string, unknown>;
        const batch = parsePeerEventBatch(parsed);
        expect(batch).not.toBeNull();
        receiver.receive(batch!.topic, batch!.events, { epoch: batch!.epoch, batchSeq: batch!.batch_seq });
        parseMs.push(performance.now() - startedAt);
        // Per-event serialize cost, measured on one event of this size.
        const only = JSON.stringify(batch!.events[0]);
        serializeMs.push(performance.now() - startedAt);
        expect(index).toBeGreaterThanOrEqual(0);
        void only;
      }
    } finally {
      receiver.close();
    }
    const p95 = (values: number[]) => [...values].sort((left, right) => left - right)[
      Math.min(values.length - 1, Math.ceil(0.95 * values.length) - 1)
    ]!;
    const measurements = {
      events: peer.posts.length,
      report_bytes: reportBytes,
      max_post_body_bytes: Math.max(...peer.posts.map((post) => Buffer.byteLength(post.body, "utf8"))),
      publish_total_ms: Math.round(publishTotalMs * 100) / 100,
      publish_per_event_ms: Math.round((publishTotalMs / 256) * 1000) / 1000,
      receive_parse_validate_p95_ms: Math.round(p95(parseMs) * 1000) / 1000,
      receive_parse_validate_max_ms: Math.round(Math.max(...parseMs) * 1000) / 1000,
    };
    console.log(`[peer-channel-measure] ${JSON.stringify(measurements)}`);

    // Loose sanity bounds: the point of the split is that no single piece of work
    // approaches the 50 ms event-loop guard.
    expect(measurements.publish_total_ms).toBeLessThan(2_000);
    expect(measurements.receive_parse_validate_max_ms).toBeLessThan(50);
  }, 120_000);

  it("degrades a task event whose task body cannot fit, and the receiver rebuilds it", async () => {
    const peer = fakePeer();
    channel = createPeerChannel({ url: "http://peer:6120", secret: "s", fetchImpl: peer.fetchImpl });

    // `MultiremiTask.prompt` is capped at 2 MiB by the store, so this is a legal
    // task that simply cannot travel as one event.
    const hugeTask = { ...TASK, prompt: "p".repeat(900 * 1024) };
    channel.forwardRealtime("task_enqueued", { task: hugeTask as any, task_id: hugeTask.id });
    await waitForBatches(1);

    const delivered = peer.payloads()[0] as any;
    expect(delivered.payload).toEqual({ task_id: TASK.id, degraded: true });
    expect(channel.stats()).toMatchObject({ degraded: 1, oversize_dropped: 0, dropped: 0 });
    expect(peerMetricsSnapshot().degraded).toBe(1);
  });

  it("degrades a task_messages event by dropping only the task header", async () => {
    const peer = fakePeer();
    channel = createPeerChannel({ url: "http://peer:6120", secret: "s", fetchImpl: peer.fetchImpl });

    const hugeTask = { ...TASK, prompt: "p".repeat(900 * 1024) };
    channel.forwardRealtime("task_messages", {
      task: hugeTask as any,
      task_id: hugeTask.id,
      messages: [message(7, 1_000)],
    });
    await waitForBatches(1);

    const delivered = peer.payloads()[0] as any;
    expect(delivered.payload.degraded).toBe(true);
    expect(delivered.payload.task_id).toBe(TASK.id);
    expect(delivered.payload.task).toBeUndefined();
    expect(delivered.payload.messages).toHaveLength(1);
    expect(channel.stats()).toMatchObject({ degraded: 1, oversize_dropped: 0, dropped: 0 });
  });

  it("references an event whose persisted message content cannot fit, without dropping it", async () => {
    const warnings: Array<{ kind: string | null; bytes: number }> = [];
    const peer = fakePeer();
    channel = createPeerChannel({
      url: "http://peer:6120",
      secret: "s",
      fetchImpl: peer.fetchImpl,
      maxEventBytes: 64 * 1024,
      maxBatchBytes: 128 * 1024,
      onOversizeDrop: (info) => warnings.push({ kind: info.kind, bytes: info.bytes }),
    });

    // Content over the per-event budget is delivered through a persisted seq
    // reference, including when JSON escaping alone made it too large.
    channel.forwardRealtime("task_messages", {
      task: TASK,
      task_id: TASK.id,
      messages: [message(1, 200 * 1024)],
    });
    await waitForBatches(1);

    expect(peer.posts).toHaveLength(1);
    expect((peer.payloads()[0] as any).payload).toEqual({ task_id: TASK.id, degraded: true, seq_start: 1, seq_end: 1 });
    expect(channel.stats()).toMatchObject({ sent: 1, degraded: 1, dropped: 0, oversize_dropped: 0 });
    expect(warnings).toHaveLength(0);
  });
});

describe("peer channel — HTTP routes", () => {
  /** Mount the peer routes the way the API does, without a whole app. */
  function peerApp(options: { peer: PeerChannel | null; secret: string }) {
    const app = new Hono();
    registerPeerRoutes(app, options);
    return app;
  }

  it("refuses every unauthenticated request and accepts the configured secret", async () => {
    const peer = createPeerChannel({ url: "http://peer:6120", secret: "shared", origin: "process-a", fetchImpl: fakePeer().fetchImpl });
    const app = peerApp({ peer, secret: "shared" });
    try {
      const body = JSON.stringify(batchBody({ events: [] }));

      expect((await app.request("/internal/peer/events", { method: "POST", body })).status).toBe(401);
      expect((await app.request("/internal/peer/events", {
        method: "POST",
        headers: { Authorization: "Bearer wrong" },
        body,
      })).status).toBe(401);
      // A token of a different length must not be compared byte-wise either.
      expect((await app.request("/internal/peer/events", {
        method: "POST",
        headers: { Authorization: "Bearer shared-but-longer" },
        body,
      })).status).toBe(401);
      expect((await app.request("/internal/peer/events", {
        method: "POST",
        headers: { Authorization: "Bearer shared" },
        body,
      })).status).toBe(200);

      // An empty expectation must refuse everything rather than wave callers in.
      const closed = peerApp({ peer, secret: "" });
      expect((await closed.request("/internal/peer/events", {
        method: "POST",
        headers: { Authorization: "Bearer " },
        body,
      })).status).toBe(401);
    } finally {
      peer.close();
    }
  });

  it("answers 401 for a process with no peer even when the secret matches", async () => {
    // QA item 1: whether this process is half of a split is configuration, and a
    // caller must not be able to tell "no peer here" from "wrong credential" by
    // the status code — including a caller that does hold the secret.
    const app = peerApp({ peer: null, secret: "shared" });
    const body = JSON.stringify(batchBody({ events: [] }));

    const health = await app.request("/internal/peer/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, enabled: false, peer_healthy: false });

    const withSecret = await app.request("/internal/peer/events", {
      method: "POST",
      headers: { Authorization: "Bearer shared" },
      body,
    });
    expect(withSecret.status).toBe(401);
    const withSecretBody = await withSecret.json();

    for (const headers of [
      undefined,
      { Authorization: "Bearer " },
      { Authorization: "Bearer wrong" },
      { Authorization: "Bearer shared-but-longer" },
    ]) {
      const response = await app.request("/internal/peer/events", {
        method: "POST",
        ...(headers ? { headers } : {}),
        body,
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual(withSecretBody);
    }
  });

  it("rejects a malformed batch and counts a well-formed one", async () => {
    const peer = createPeerChannel({ url: "http://peer:6120", secret: "shared", origin: "process-a", fetchImpl: fakePeer().fetchImpl });
    const app = peerApp({ peer, secret: "shared" });
    const seen: unknown[] = [];
    peer.subscribe(PEER_REALTIME_TOPIC, (payload) => seen.push(payload));
    try {
      const post = (body: string) => app.request("/internal/peer/events", {
        method: "POST",
        headers: { Authorization: "Bearer shared" },
        body,
      });

      expect((await post("not json")).status).toBe(400);
      // A body that is not a batch at all is the only 400: a sender that got one
      // would retry the same poisoned batch forever.
      expect((await post(JSON.stringify({ events: [] }))).status).toBe(400);
      expect((await post(JSON.stringify({ topic: PEER_REALTIME_TOPIC, events: [] }))).status).toBe(400);
      // The dedupe pair is required: without it the receiver could not tell a
      // retry from a new batch.
      expect((await post(JSON.stringify({ topic: PEER_REALTIME_TOPIC, epoch: "e", events: [] }))).status).toBe(400);
      expect((await post(JSON.stringify({ topic: PEER_REALTIME_TOPIC, batch_seq: 0, events: [] }))).status).toBe(400);

      // An unusable frame inside an otherwise fine batch is counted, not fatal.
      const mixed = await post(JSON.stringify(batchBody({
        batchSeq: 1,
        events: [
          { nope: true },
          envelope("task_event", { type: "task:done", task: TASK, task_id: TASK.id }),
        ],
      })));
      expect(mixed.status).toBe(200);
      expect(await mixed.json()).toEqual({ ok: true, accepted: 1, rejected: 1 });
      expect(seen).toHaveLength(1);

      const ok = await post(JSON.stringify(batchBody({
        batchSeq: 2,
        events: [envelope("task_event", { type: "task:done", task: TASK, task_id: TASK.id })],
      })));
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ ok: true, accepted: 1, rejected: 0 });
      expect(seen).toHaveLength(2);
    } finally {
      peer.close();
    }
  });
});

describe("peer channel — receiving", () => {
  it("delivers to a topic subscriber and never re-publishes", () => {
    const peer = fakePeer();
    channel = createPeerChannel({ url: "http://peer:6120", secret: "s", fetchImpl: peer.fetchImpl, origin: "process-a" });
    const seen: unknown[] = [];
    channel.subscribe(PEER_REALTIME_TOPIC, (payload) => seen.push(payload));

    const result = channel.receive(PEER_REALTIME_TOPIC, [
      { v: 1, origin: "process-b", kind: "task_enqueued", payload: { task: { id: "tsk_1" } } },
    ]);

    expect(result).toEqual({ accepted: 1, rejected: 0, duplicate: false });
    expect(seen).toEqual([{ v: 1, origin: "process-b", kind: "task_enqueued", payload: { task: { id: "tsk_1" } } }]);
    // Nothing goes back out: a receiving process must not echo to its peer.
    expect(peer.posts).toHaveLength(0);
    expect(channel.stats()).toMatchObject({ sent: 0, received: 1 });
  });

  it("rejects our own origin echoed back, and anything that is not an envelope", () => {
    const peer = fakePeer();
    channel = createPeerChannel({ url: "http://peer:6120", secret: "s", fetchImpl: peer.fetchImpl, origin: "process-a" });
    const seen: unknown[] = [];
    channel.subscribe(PEER_REALTIME_TOPIC, (payload) => seen.push(payload));

    const result = channel.receive(PEER_REALTIME_TOPIC, [
      { v: 1, origin: "process-a", kind: "task_event", payload: { type: "task:done", task: { id: "tsk_1" } } },
      { v: 2, origin: "process-b", kind: "task_event", payload: {} },
      { v: 1, origin: "process-b", kind: "not_a_kind", payload: {} },
      { nope: true },
      { v: 1, origin: "process-b", kind: "workspace_event", payload: { event: { type: "x", workspaceId: "local", payload: {} } } },
    ]);

    expect(result).toEqual({ accepted: 1, rejected: 4, duplicate: false });
    expect(seen).toHaveLength(1);
    expect(channel.stats()).toMatchObject({ received: 1, rejected: 4 });
  });

  it("refuses a topic this process does not subscribe to, without stalling the sender", () => {
    channel = createPeerChannel({ url: "http://peer:6120", secret: "s", fetchImpl: fakePeer().fetchImpl, origin: "a" });
    const subscription = channel.subscribe(PEER_REALTIME_TOPIC, () => {});
    try {
      // A 200 with everything rejected is what keeps the sender's queue moving;
      // a 4xx here would make it retry this batch forever.
      expect(channel.receive("hub", [{ some: "frame" }])).toEqual({ accepted: 0, rejected: 1, duplicate: false });
      expect(channel.stats()).toMatchObject({ received: 0, rejected: 1 });
    } finally {
      subscription.unsubscribe();
    }
  });

  it("unsubscribes cleanly", () => {
    channel = createPeerChannel({ url: "http://peer:6120", secret: "s", fetchImpl: fakePeer().fetchImpl, origin: "a" });
    const seen: unknown[] = [];
    const subscription = channel.subscribe(PEER_REALTIME_TOPIC, (payload) => seen.push(payload));
    subscription.unsubscribe();
    channel.receive(PEER_REALTIME_TOPIC, [
      { v: 1, origin: "b", kind: "task_event", payload: { type: "x", task: { id: "t" } } },
    ]);
    expect(seen).toHaveLength(0);
  });

  it("keeps delivering in `seq` order for one task", () => {
    const peer = fakePeer();
    channel = createPeerChannel({ url: "http://peer:6120", secret: "s", fetchImpl: peer.fetchImpl, origin: "process-a" });
    const seqs: number[] = [];
    channel.subscribe(PEER_REALTIME_TOPIC, (payload) => {
      const envelope = payload as { payload: { messages: Array<{ seq: number }> } };
      for (const message of envelope.payload.messages) seqs.push(message.seq);
    });

    for (let seq = 1; seq <= 100; seq += 1) {
      channel.receive(PEER_REALTIME_TOPIC, [{
        v: 1,
        origin: "process-b",
        kind: "task_messages",
        payload: { task: { id: "tsk_1" }, messages: [{ seq }] },
      }]);
    }
    expect(seqs).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
  });
});

describe("peer channel — frozen retry slot (QA round 2)", () => {
  /**
   * A receiver double that models the real one: it processes every batch it
   * receives, dedupes by `(epoch, batch_seq)` exactly like `PeerChannel.receive`,
   * and can lose the *response* of chosen batches on their first attempt.
   *
   * Modelling the dedupe matters. "ACK lost" does not mean "the receiver did
   * nothing" — it means the receiver handled the batch and the sender never
   * learned it. A double that only records acknowledged attempts would hide the
   * very bug these tests exist to catch: a retry that carries extra events under
   * an already-handled number is answered `duplicate`, so those extra events are
   * silently lost.
   */
  function loseFirstAckPeer(options: { loseAckFor?: number[] } = {}) {
    const posts: Array<{ body: string; batchSeq: number; events: unknown[] }> = [];
    const seqs: number[] = [];
    const attemptsPerSeq = new Map<number, number>();
    const highestHandled = new Map<string, number>();
    const epoch = "receiver-double";
    // Only the listed batches lose their first response; later batches answer
    // normally, which is what makes "the retry happened, the rest followed"
    // distinguishable from "every first attempt fails".
    const loseAckFor = new Set(options.loseAckFor ?? [1]);
    let duplicateBatches = 0;

    const fetchImpl: PeerFetch = async (_url, init) => {
      const body = String(init.body);
      const parsed = JSON.parse(body) as {
        epoch: string;
        batch_seq: number;
        events: Array<{ payload: { messages?: Array<{ seq: number }> } }>;
      };
      posts.push({ body, batchSeq: parsed.batch_seq, events: parsed.events });
      const attempt = (attemptsPerSeq.get(parsed.batch_seq) ?? 0) + 1;
      attemptsPerSeq.set(parsed.batch_seq, attempt);

      // Receiver side, identical rule to PeerChannel.receive: at or below the
      // high-water mark for this epoch means "already handled", delivered once.
      const highest = highestHandled.get(epoch) ?? 0;
      const duplicate = parsed.batch_seq <= highest;
      if (duplicate) {
        duplicateBatches += 1;
      } else {
        highestHandled.set(epoch, parsed.batch_seq);
        for (const event of parsed.events) {
          for (const message of event.payload.messages ?? []) seqs.push(message.seq);
        }
      }

      // The response is what gets lost, not the processing.
      if (attempt === 1 && loseAckFor.has(parsed.batch_seq)) throw new Error("response lost");
      return new Response(JSON.stringify({ ok: true, duplicate }), { status: 200 });
    };

    return {
      fetchImpl,
      posts,
      seqs: () => [...seqs],
      duplicates: () => duplicateBatches,
      /** Every attempt made for one batch_seq, in order. */
      bodiesFor: (batchSeq: number) => posts.filter((post) => post.batchSeq === batchSeq).map((post) => post.body),
    };
  }

  it("delivers every event when an ACK is lost and the queue evicts while retrying (QA repro)", async () => {
    const peer = loseFirstAckPeer();
    channel = createPeerChannel({
      url: "http://peer:6120",
      secret: "s",
      fetchImpl: peer.fetchImpl,
      queueLimit: 1,
      minBackoffMs: 15,
      maxBackoffMs: 30,
    });

    channel.forwardRealtime("task_messages", { task: TASK, task_id: TASK.id, messages: [message(1, 100)] });
    await waitFor(() => channel!.stats().failed >= 1, "the first attempt to fail");

    // Events 2 and 3 arrive while the retry is waiting. `queueLimit = 1` means
    // event 2 is the backlog that gets evicted — never the batch being retried.
    channel.forwardRealtime("task_messages", { task: TASK, task_id: TASK.id, messages: [message(2, 100)] });
    channel.forwardRealtime("task_messages", { task: TASK, task_id: TASK.id, messages: [message(3, 100)] });

    await waitFor(() => channel!.stats().queued === 0 && channel!.stats().inflight === 0, "everything to drain", 8_000);
    // The requirement: everything that was not evicted arrives, in order. The
    // retry must not share its number with event 3 — the receiver would call that
    // a duplicate and event 2 would vanish.
    expect(peer.seqs()).toEqual([1, 2, 3]);
    expect(channel.stats()).toMatchObject({ inflight: 0, queued: 0 });
  });

  it("re-sends a retried batch byte-for-byte, and a new same-topic event waits its turn", async () => {
    const peer = loseFirstAckPeer();
    channel = createPeerChannel({
      url: "http://peer:6120",
      secret: "s",
      fetchImpl: peer.fetchImpl,
      minBackoffMs: 15,
      maxBackoffMs: 30,
    });

    channel.forwardRealtime("task_messages", { task: TASK, task_id: TASK.id, messages: [message(1, 100)] });
    await waitFor(() => channel!.stats().failed >= 1, "the first attempt to fail");

    // A new same-topic event arrives before the retry fires.
    channel.forwardRealtime("task_messages", { task: TASK, task_id: TASK.id, messages: [message(2, 100)] });

    await waitFor(() => channel!.stats().queued === 0 && channel!.stats().inflight === 0, "the retry and the follow-up", 8_000);
    // Both events arrive. If the retry absorbed event 2 the receiver would answer
    // `duplicate` for batch 1 and event 2 would be lost, so this is the assertion
    // that matters; the byte-identity below is what makes it hold.
    expect(peer.seqs()).toEqual([1, 2]);
    const attemptsForSeqOne = peer.bodiesFor(1);
    expect(attemptsForSeqOne).toHaveLength(2);
    expect(attemptsForSeqOne[1]).toBe(attemptsForSeqOne[0]);
  });

  it("keeps a multi-event batch whole across a retry while the queue evicts older events", async () => {
    const peer = loseFirstAckPeer();
    channel = createPeerChannel({
      url: "http://peer:6120",
      secret: "s",
      fetchImpl: peer.fetchImpl,
      queueLimit: 2,
      minBackoffMs: 15,
      maxBackoffMs: 30,
    });

    // One batch of three messages, so the retry has to re-send all three.
    channel.forwardRealtime("task_messages", {
      task: TASK,
      task_id: TASK.id,
      messages: [message(1, 50), message(2, 50), message(3, 50)],
    });
    await waitFor(() => channel!.stats().failed >= 1, "the first attempt to fail");

    // Push more than the queue can hold so eviction happens for real.
    for (let seq = 10; seq <= 13; seq += 1) {
      channel.forwardRealtime("task_messages", { task: TASK, task_id: TASK.id, messages: [message(seq, 50)] });
    }
    const droppedBeforeDrain = channel.stats().dropped;

    await waitFor(() => channel!.stats().queued === 0 && channel!.stats().inflight === 0, "everything to settle", 8_000);

    // The retried batch is delivered complete and once, in order: eviction only
    // ever took queue backlog, never part of the batch already on the wire.
    expect(peer.seqs().slice(0, 3)).toEqual([1, 2, 3]);
    // And `dropped` names exactly what was evicted — no more, no less.
    const delivered = new Set(peer.seqs());
    const offered = [1, 2, 3, 10, 11, 12, 13];
    const missing = offered.filter((seq) => !delivered.has(seq));
    expect(channel.stats().dropped).toBe(missing.length);
    expect(droppedBeforeDrain).toBeGreaterThan(0);
  });

  it("keeps oversize and backlog-eviction counters disjoint", async () => {
    const peer = fakePeer();
    channel = createPeerChannel({
      url: "http://peer:6120",
      secret: "s",
      fetchImpl: peer.fetchImpl,
      // Small enough that one legal event fits and two do not.
      maxBatchBytes: 1024,
      maxEventBytes: 1024,
      maxQueueBytes: 1024,
      queueLimit: 1,
    });

    // (1) An oversize event: counted as oversize, never as a backlog eviction.
    channel.publish("hub", { blob: "x".repeat(4_000) });
    await waitFor(() => channel!.stats().oversize_dropped === 1, "the oversize drop");
    // Independently, so a regression that inflates both fails on the first line.
    expect(channel.stats().oversize_dropped).toBe(1);
    expect(channel.stats().dropped).toBe(0);
    expect(peerMetricsSnapshot().oversize_dropped).toBe(1);
    expect(peerMetricsSnapshot().dropped).toBe(0);

    // (2) A queue overflow, with nothing oversize: counted as dropped only.
    peer.goOffline();
    for (let seq = 1; seq <= 4; seq += 1) {
      channel.forwardRealtime("task_event", { type: `seq:${seq}`, task: TASK, task_id: TASK.id });
    }
    await waitFor(() => channel!.stats().dropped > 0, "the backlog eviction");
    // (2) independently: the eviction counter moved, the oversize counter did not.
    expect(channel.stats().dropped).toBeGreaterThan(0);
    expect(channel.stats().oversize_dropped).toBe(1);
    expect(channel.stats().dropped).toBe(4 - channel.stats().queued - channel.stats().inflight);
    expect(peerMetricsSnapshot().dropped).toBe(channel.stats().dropped);
    expect(peerMetricsSnapshot().oversize_dropped).toBe(1);
  });

  it("does not rebuild a frozen slot when the first POST fails after close", async () => {
    let failPost!: (reason: Error) => void;
    let started = false;
    channel = createPeerChannel({ url: "http://fake-peer", fetchImpl: async () => {
      started = true;
      return new Promise<Response>((_resolve, reject) => { failPost = reject; });
    } });
    channel.publish("hub", { i: 1 });
    await waitFor(() => started, "the pending initial POST");
    channel.close();
    failPost(new Error("fake closed transport"));
    await waitFor(() => channel!.stats().failed === 1, "the failure after close");
    expect(channel.stats()).toMatchObject({ enabled: false, dropped: 1, queued: 0, queued_bytes: 0, inflight: 0, inflight_bytes: 0 });
    expect(peerMetricsSnapshot().dropped).toBe(1);
  });

  it("counts the frozen slot as dropped when the channel closes before its retry", async () => {
    const peer = fakePeer();
    channel = createPeerChannel({
      url: "http://peer:6120",
      secret: "s",
      fetchImpl: peer.fetchImpl,
      minBackoffMs: 30,
    });
    peer.goOffline();
    channel.forwardRealtime("task_messages", {
      task: TASK,
      task_id: TASK.id,
      messages: [message(1, 10), message(2, 10)],
    });
    await waitFor(() => channel!.stats().failed >= 1, "the first attempt to fail");

    channel.close();
    // Both events never left this process, so both count as dropped — the frozen
    // slot is stranded exactly like queue backlog is.
    expect(peerMetricsSnapshot().dropped).toBe(2);
    expect(channel.stats()).toMatchObject({ inflight: 0, inflight_bytes: 0, queued: 0, dropped: 2 });
    channel = null;
  });
});
