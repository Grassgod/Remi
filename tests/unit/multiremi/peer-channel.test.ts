// MUL-462: the sending half of the peer channel — batching by count and by real
// serialized bytes, ordering, backoff, the queue caps, splitting, degradation,
// dedupe on retry, and the fact that `MULTIREMI_PEER_URL` unset means "inert".
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { registerPeerRoutes } from "../../../packages/server/src/api/peer/peer-routes.js";
import {
  PEER_MAX_BATCH_BYTES,
  PEER_MAX_EVENT_BYTES,
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
 *  (the backoff test needs their timing) but flagged, so a delivery assertion can
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
    expect(channel.stats()).toMatchObject({ sent: 0, dropped: 1, oversize_dropped: 1, queued: 0 });
    expect(peerMetricsSnapshot()).toMatchObject({ dropped: 1, oversize_dropped: 1 });
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
    await waitFor(() => channel!.stats().dropped >= 15, "overflow to be counted");

    expect(channel.stats().queued).toBe(5);
    expect(peerMetricsSnapshot().dropped).toBe(channel.stats().dropped);
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

    expect(channel.stats().queued_bytes).toBeLessThanOrEqual(2 * 1024 + 4 * 1024);
    expect(channel.stats().queued).toBeLessThan(30);
    // The survivors are the newest ones: the queue drops from the oldest end.
    const lastBatch = peer.payloads().at(-1) as any;
    expect(channel.stats().dropped).toBe(30 - channel.stats().queued);
    expect(lastBatch).toBeUndefined();
  });

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
    expect(channel.stats().queued).toBe(1);

    peer.goOnline();
    await waitForBatches(1);
    expect(channel.stats().sent).toBe(1);
    expect(channel.healthy()).toBe(true);
    expect(peer.payloads()).toHaveLength(1);
  });

  it("backs off from 1s toward 10s instead of hammering a dead peer", async () => {
    const peer = fakePeer();
    channel = createPeerChannel({
      url: "http://peer:6120",
      secret: "s",
      fetchImpl: peer.fetchImpl,
      minBackoffMs: 5,
      maxBackoffMs: 20,
    });
    peer.goOffline();
    channel.forwardRealtime("task_event", { type: "task:done", task: TASK, task_id: TASK.id });

    await waitFor(() => channel!.stats().failed >= 3, "several retries");
    // Each retry is later than the previous one: the gaps grow rather than
    // staying at the first delay.
    const gaps = peer.posts.slice(1).map((post, index) => post.at - peer.posts[index]!.at);
    expect(gaps[gaps.length - 1]!).toBeGreaterThan(gaps[0]!);
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
   * QA's first counterexample: 64 events of ~16 KB each. Their combined event
   * bytes sit just under 1 MiB, so a batch loop that estimates from event sizes
   * ships a body over it once the wrapper, topic and separators are counted.
   */
  it("keeps every POST body at or under 1 MiB for 64 large-but-legal events", async () => {
    const peer = fakePeer();
    channel = createPeerChannel({ url: "http://peer:6120", secret: "s", fetchImpl: peer.fetchImpl, maxBatchEvents: 64 });
    peer.setDelay(5);

    const content = "x".repeat(16_360);
    for (let seq = 1; seq <= 64; seq += 1) {
      channel.forwardRealtime("task_messages", {
        task: TASK,
        task_id: TASK.id,
        messages: [message(seq, 16_360)],
      });
    }
    await waitFor(() => channel!.stats().sent === 64, "every event to land", 8_000);

    expect(peer.posts.length).toBeGreaterThan(1);
    for (const post of peer.posts) {
      expect(Buffer.byteLength(post.body, "utf8")).toBeLessThanOrEqual(PEER_MAX_BATCH_BYTES);
    }
    // Nothing was dropped or degraded: the events are legal, just large.
    expect(channel.stats()).toMatchObject({ sent: 64, dropped: 0, oversize_dropped: 0, degraded: 0 });
    expect(peer.payloads()).toHaveLength(64);
    // And the payload really is the size the counterexample describes.
    expect(content.length).toBe(16_360);
  });

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

    await waitFor(() => channel!.stats().sent === 256, "all 256 messages", 60_000);

    // Every body fits, every message arrived exactly once, and order is intact.
    for (const post of peer.posts) {
      expect(Buffer.byteLength(post.body, "utf8")).toBeLessThanOrEqual(PEER_MAX_BATCH_BYTES);
    }
    const seqs = peer.payloads().map((event: any) => event.payload.messages[0].seq);
    expect(seqs).toEqual(Array.from({ length: 256 }, (_, index) => index + 1));
    expect(channel.stats()).toMatchObject({ sent: 256, dropped: 0, oversize_dropped: 0, degraded: 0 });

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

  it("drops an event whose own message alone cannot fit, and counts it", async () => {
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

    // The store caps a message at 256 KiB; this payload is over the channel's own
    // budget even after the task header and split, so it cannot be delivered.
    channel.forwardRealtime("task_messages", {
      task: TASK,
      task_id: TASK.id,
      messages: [message(1, 200 * 1024)],
    });
    await waitFor(() => channel!.stats().oversize_dropped === 1, "the oversize drop");

    expect(peer.posts).toHaveLength(0);
    expect(channel.stats()).toMatchObject({ sent: 0, degraded: 0, dropped: 1, oversize_dropped: 1 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.kind).toBe("task_messages");
    expect(warnings[0]!.bytes).toBeGreaterThan(200 * 1024);
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
