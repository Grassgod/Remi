// MUL-462: the sending half of the peer channel — batching, ordering, backoff,
// the queue cap, and the fact that `MULTIREMI_PEER_URL` unset means "inert".
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { registerPeerRoutes } from "../../../packages/server/src/api/peer/peer-routes.js";
import {
  PEER_REALTIME_TOPIC,
  createPeerChannel,
  createPeerChannelFromEnv,
  resolvePeerSecret,
  resolvePeerUrl,
  type PeerChannel,
  type PeerFetch,
} from "../../../packages/server/src/api/peer/peer-channel.js";
import { peerMetricsSnapshot, resetRequestMetricsForTest } from "@multiremi/observability/request-metrics.js";

/**
 * One POST attempt. Attempts that happened while the peer was offline are kept
 * (the backoff test needs their timing) but flagged, so a delivery assertion can
 * look at `delivered` instead of `posts`.
 */
interface Post {
  url: string;
  body: { topic: string; events: unknown[] };
  authorization: string | null;
  at: number;
  ok: boolean;
}

/**
 * A stub peer that can be paused, so a case can watch the queue fill and the
 * backoff schedule instead of racing the real network.
 */
function fakePeer(options: { fail?: boolean } = {}) {
  const posts: Post[] = [];
  let online = options.fail !== true;
  let delayMs = 0;
  let startedAt = performance.now();
  const fetchImpl: PeerFetch = async (url, init) => {
    const body = JSON.parse(String(init.body)) as Post["body"];
    const headers = new Headers(init.headers);
    if (delayMs > 0) await Bun.sleep(delayMs);
    posts.push({
      url,
      body,
      authorization: headers.get("Authorization"),
      at: performance.now() - startedAt,
      ok: online,
    });
    if (!online) throw new Error("peer offline");
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
    payloads: () => posts.filter((post) => post.ok).flatMap((post) => post.body.events),
    /** How many payloads were handed to the peer, delivered or not. */
    attempts: () => posts.flatMap((post) => post.body.events),
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
      env.publish(PEER_REALTIME_TOPIC, { hello: true });
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

    channel.publish(PEER_REALTIME_TOPIC, { kind: "a" });
    channel.publish(PEER_REALTIME_TOPIC, { kind: "b" });
    channel.publish(PEER_REALTIME_TOPIC, { kind: "c" });
    await waitFor(() => peer.posts.length === 1, "the coalesced batch");

    expect(peer.posts).toHaveLength(1);
    expect(peer.posts[0]!.url).toBe("http://peer:6120/internal/peer/events");
    expect(peer.posts[0]!.authorization).toBe("Bearer peer-secret");
    expect(peer.posts[0]!.body.topic).toBe(PEER_REALTIME_TOPIC);
    expect(peer.posts[0]!.body.events).toEqual([{ kind: "a" }, { kind: "b" }, { kind: "c" }]);
    expect(channel.stats()).toMatchObject({ sent: 3, batches: 1, failed: 0, queued: 0 });
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

    for (let index = 0; index < 10; index += 1) channel.publish(PEER_REALTIME_TOPIC, { index });
    await waitFor(() => channel!.stats().batches === 3, "every batch to land", 3_000);

    expect(peer.posts.map((post) => post.body.events.length)).toEqual([4, 4, 2]);
    expect(peer.payloads()).toEqual(Array.from({ length: 10 }, (_, index) => ({ index })));
  });

  it("caps one batch at the configured byte budget without splitting an event", async () => {
    const peer = fakePeer();
    channel = createPeerChannel({
      url: "http://peer:6120",
      secret: "s",
      fetchImpl: peer.fetchImpl,
      maxBatchEvents: 64,
      maxBatchBytes: 60,
    });
    peer.setDelay(10);

    // ~33 bytes each; the first two do not fit together under a 60-byte cap, so
    // the first goes alone and the third (15 bytes) rides with the second.
    channel.publish(PEER_REALTIME_TOPIC, { payload: "x".repeat(20) });
    channel.publish(PEER_REALTIME_TOPIC, { payload: "y".repeat(20) });
    channel.publish(PEER_REALTIME_TOPIC, { payload: "z" });
    await waitFor(() => channel!.stats().batches === 2, "the byte-capped batches");

    expect(peer.posts.map((post) => post.body.events.length)).toEqual([1, 2]);
    expect(channel.stats()).toMatchObject({ sent: 3, batches: 2, dropped: 0 });
  });

  it("still sends a single event that exceeds the whole byte budget", async () => {
    const peer = fakePeer();
    channel = createPeerChannel({
      url: "http://peer:6120",
      secret: "s",
      fetchImpl: peer.fetchImpl,
      maxBatchEvents: 64,
      maxBatchBytes: 16,
    });

    channel.publish(PEER_REALTIME_TOPIC, { payload: "x".repeat(500) });
    await waitFor(() => channel!.stats().batches === 1, "the oversized event");

    // An event can never be cut in half on the wire; one over-budget event is
    // still one event in one batch.
    expect(peer.posts).toHaveLength(1);
    expect(peer.posts[0]!.body.events).toHaveLength(1);
    expect(channel.stats()).toMatchObject({ sent: 1, batches: 1, dropped: 0 });
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

    for (let seq = 1; seq <= 100; seq += 1) channel.publish(PEER_REALTIME_TOPIC, { seq });
    await waitFor(() => channel!.stats().batches === 20, "all 100 messages", 5_000);

    expect(peer.payloads()).toEqual(Array.from({ length: 100 }, (_, index) => ({ seq: index + 1 })));
    // Serial delivery: the batches are contiguous, never interleaved.
    expect(peer.posts.map((post) => post.body.events.length)).toEqual([5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5]);
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

    for (let seq = 1; seq <= 20; seq += 1) channel.publish(PEER_REALTIME_TOPIC, { seq });
    // The first flush is in flight (and failing) while the rest overflow.
    await waitFor(() => channel!.stats().dropped >= 15, "overflow to be counted");

    expect(channel.stats().queued).toBe(5);
    const snapshot = peerMetricsSnapshot();
    expect(snapshot.dropped).toBe(channel.stats().dropped);
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
    channel.publish(PEER_REALTIME_TOPIC, { seq: 1 });
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
    expect(peer.payloads()).toEqual([{ seq: 1 }]);
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
    channel.publish(PEER_REALTIME_TOPIC, { seq: 1 });

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

    channel.publish(PEER_REALTIME_TOPIC, { burst: 1 });
    await waitFor(() => peer.posts.length === 1, "the first post");
    channel.publish(PEER_REALTIME_TOPIC, { burst: 2 });
    channel.publish(PEER_REALTIME_TOPIC, { burst: 3 });
    channel.publish(PEER_REALTIME_TOPIC, { burst: 4 });
    await waitForBatches(2);

    expect(peer.payloads()).toEqual([{ burst: 1 }, { burst: 2 }, { burst: 3 }, { burst: 4 }]);
    expect(channel.stats()).toMatchObject({ sent: 4, batches: 2 });
  });

  it("counts a non-serializable payload as dropped instead of throwing at the caller", () => {
    const peer = fakePeer();
    channel = createPeerChannel({ url: "http://peer:6120", secret: "s", fetchImpl: peer.fetchImpl });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => channel!.publish(PEER_REALTIME_TOPIC, cyclic)).not.toThrow();
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
    channelToClose.publish(PEER_REALTIME_TOPIC, { seq: 1 });
    await waitFor(() => channelToClose.stats().failed >= 1, "a failure before close");

    const postsAtClose = peer.posts.length;
    channelToClose.close();
    await Bun.sleep(50);
    expect(peer.posts.length).toBe(postsAtClose);
    expect(channelToClose.enabled).toBe(false);
    expect(channelToClose.healthy()).toBe(false);
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
      const body = JSON.stringify({ topic: PEER_REALTIME_TOPIC, events: [] });

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

  it("reports a disabled channel instead of pretending to accept events", async () => {
    const app = peerApp({ peer: null, secret: "shared" });

    const health = await app.request("/internal/peer/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, enabled: false, peer_healthy: false });

    const post = await app.request("/internal/peer/events", {
      method: "POST",
      headers: { Authorization: "Bearer shared" },
      body: JSON.stringify({ topic: PEER_REALTIME_TOPIC, events: [] }),
    });
    expect(post.status).toBe(503);
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
      expect((await post(JSON.stringify({ topic: PEER_REALTIME_TOPIC }))).status).toBe(400);

      // An unusable frame inside an otherwise fine batch is counted, not fatal.
      const mixed = await post(JSON.stringify({
        topic: PEER_REALTIME_TOPIC,
        events: [
          { nope: true },
          { v: 1, origin: "process-b", kind: "task_event", payload: { type: "task:done", task: { id: "tsk_1" } } },
        ],
      }));
      expect(mixed.status).toBe(200);
      expect(await mixed.json()).toEqual({ ok: true, accepted: 1, rejected: 1 });
      expect(seen).toHaveLength(1);

      const ok = await post(JSON.stringify({
        topic: PEER_REALTIME_TOPIC,
        events: [{ v: 1, origin: "process-b", kind: "task_event", payload: { type: "task:done", task: { id: "tsk_1" } } }],
      }));
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

    expect(result).toEqual({ accepted: 1, rejected: 0 });
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

    expect(result).toEqual({ accepted: 1, rejected: 4 });
    expect(seen).toHaveLength(1);
    expect(channel.stats()).toMatchObject({ received: 1, rejected: 4 });
  });

  it("refuses a topic this process does not subscribe to, without stalling the sender", () => {
    channel = createPeerChannel({ url: "http://peer:6120", secret: "s", fetchImpl: fakePeer().fetchImpl, origin: "a" });
    const subscription = channel.subscribe(PEER_REALTIME_TOPIC, () => {});
    try {
      // A 200 with everything rejected is what keeps the sender's queue moving;
      // a 4xx here would make it retry this batch forever.
      expect(channel.receive("hub", [{ some: "frame" }])).toEqual({ accepted: 0, rejected: 1 });
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
