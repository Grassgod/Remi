import { afterEach, describe, expect, it } from "bun:test";
import type { HubFrame, HubStreamKey } from "@multiremi/contracts/live-hub.js";
import { createHub, type HubFillReader } from "@multiremi/api/hub/hub-core.js";
import { createPeerHubTransport } from "@multiremi/api/hub/peer-hub-transport.js";
import { createLocalHubTransport } from "@multiremi/api/hub/hub-transport.js";
import { createPeerChannel, type PeerChannel, type PeerFetch } from "@multiremi/api/peer/peer-channel.js";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore } from "./helpers.js";

async function waitFor(check: () => boolean, label: string, timeout = 5_000): Promise<void> {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function reader() {
  const rows = new Map<number, HubFrame>();
  let reads = 0;
  const fill: HubFillReader = {
    async logHead() {
      reads += 1;
      return rows.size ? { head: Math.max(...rows.keys()), log_version: 1 } : null;
    },
    async traceHead() { return null; },
    async readRange(_key: HubStreamKey, after: number, through: number) {
      return [...rows.values()].filter((frame) => after < frame.seq && frame.seq <= through);
    },
  };
  return {
    fill,
    add(seq: number) {
      rows.set(seq, { seq, kind: "entry", payload: { session_id: "s", seq, kind: "message", visibility: "shown", revision: 1 } });
    },
    get reads() { return reads; },
  };
}

function pair(options: { queueLimit?: number; heartbeatMs?: number; staleMs?: number } = {}) {
  let online = true;
  let clockOffset = 0;
  const now = () => Date.now() + clockOffset;
  let receiver!: PeerChannel;
  const posts: { events: unknown[]; epoch: string; batch_seq: number }[] = [];
  const fetchImpl: PeerFetch = async (_url, init) => {
    if (!online) throw new Error("offline");
    const body = JSON.parse(String(init.body)) as { topic: string; events: unknown[]; epoch: string; batch_seq: number };
    posts.push(body);
    receiver.receive(body.topic, body.events, { epoch: body.epoch, batchSeq: body.batch_seq });
    return new Response("{}", { status: 200 });
  };
  const sender = createPeerChannel({
    url: "http://peer.test",
    secret: "test-only",
    fetchImpl,
    queueLimit: options.queueLimit ?? 100,
    minBackoffMs: 10,
    maxBackoffMs: 20,
  });
  receiver = createPeerChannel({ url: "http://sender.test", secret: "test-only", fetchImpl: async () => new Response("{}") });
  const left = createPeerHubTransport({ peer: sender, now, heartbeatMs: options.heartbeatMs ?? 100_000, staleMs: options.staleMs ?? 15_000 });
  const right = createPeerHubTransport({ peer: receiver, now, heartbeatMs: 100_000, staleMs: options.staleMs ?? 15_000 });
  const db = reader();
  const hub = createHub({ transport: right, fill: db.fill });
  return {
    sender, receiver, left, right, hub, db, posts, fetchImpl,
    setOnline(value: boolean) { online = value; },
    setNow(value: number) { clockOffset = value; },
    close() { hub.shutdown(); left.close(); sender.close(); receiver.close(); },
  };
}

const fixtures: ReturnType<typeof pair>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });

describe("Hub peer transport", () => {
  it("wires two apps through the authenticated 462 route", async () => {
    let receiverApp: ReturnType<typeof createMultiremiApp>;
    let senderApp: ReturnType<typeof createMultiremiApp>;
    const sender = createPeerChannel({
      url: "http://receiver.test", secret: "test-only",
      fetchImpl: async (url, init) => receiverApp.request(url, init),
    });
    const receiver = createPeerChannel({
      url: "http://sender.test", secret: "test-only",
      fetchImpl: async (url, init) => senderApp.request(url, init),
    });
    const source = createPeerHubTransport({ peer: sender, heartbeatMs: 100_000 });
    const target = createPeerHubTransport({ peer: receiver, heartbeatMs: 100_000 });
    const db = reader();
    const senderHub = createHub({ transport: source });
    const receiverHub = createHub({ transport: target, fill: db.fill });
    senderApp = createMultiremiApp({
      store: createStore(), hub: senderHub, peerChannel: sender, peerSecret: "test-only", backgroundJobs: false,
      apiRoleConfiguration: { role: "all", configured: false },
    });
    receiverApp = createMultiremiApp({
      store: createStore(), hub: receiverHub, peerChannel: receiver, peerSecret: "test-only", backgroundJobs: false,
      apiRoleConfiguration: { role: "all", configured: false },
    });
    try {
      const seen: number[] = [];
      receiverHub.subscribe("log:s", 0, (_key, frames) => seen.push(...frames.map((frame) => frame.seq)));
      for (let seq = 0; seq < 20; seq += 1) {
        db.add(seq);
        senderHub.onEntry("s", { session_id: "s", seq, kind: "message", visibility: "shown", revision: 1 });
        await waitFor(() => receiverHub.knownHead("log:s")?.head === seq, `cross-app head ${seq}`);
      }
      await waitFor(() => seen.length === 20, "cross-app frames");
      expect(seen).toEqual(Array.from({ length: 20 }, (_, seq) => seq));
      expect((await (await receiverApp.request("/health")).json() as { hub: {
        transport: string; peer_link: string; hub_peer_loss_detected: { first_epoch: number }; hub_peer_reconcile_streams: number;
      } }).hub).toMatchObject({
        transport: "peer", peer_link: "healthy", hub_peer_loss_detected: { first_epoch: 1 }, hub_peer_reconcile_streams: 1,
      });
      expect(await (await receiverApp.request("/readyz")).json()).toEqual({ ok: true });
    } finally {
      senderHub.shutdown();
      receiverHub.shutdown();
      sender.close();
      receiver.close();
    }
  }, 10_000);

  it("delivers 20 head pointers in order without shipping row or trace bodies", async () => {
    const f = pair(); fixtures.push(f);
    const seen: number[] = [];
    f.hub.subscribe("log:s", 0, (_key, frames) => seen.push(...frames.map((frame) => frame.seq)));
    f.db.add(0);
    f.left.publish({ key: "log:s", frames: [{ seq: 0, kind: "entry", payload: { body_md: "private" } }] });
    await waitFor(() => f.hub.snapshot().hub_peer_loss_detected.first_epoch === 1, "first epoch");
    for (let seq = 1; seq <= 20; seq += 1) {
      f.db.add(seq);
      f.left.publish({ key: "log:s", frames: [{ seq, kind: "entry", payload: { body_md: "private" } }] });
      await waitFor(() => f.hub.knownHead("log:s")?.head === seq, `head ${seq}`);
    }
    await waitFor(() => seen.length === 21, "all frames");
    expect(seen).toEqual(Array.from({ length: 21 }, (_, seq) => seq));
    const sent = JSON.stringify(f.posts);
    expect(sent).not.toContain("private");
    expect(sent).not.toContain("trace");
    expect(f.hub.snapshot().hub_peer_loss_detected).toEqual({ first_epoch: 1, epoch_change: 0, sequence_gap: 0 });
  });

  it("turns a remote revision pointer into a gap for the previously delivered row", async () => {
    const f = pair(); fixtures.push(f);
    const seen: number[] = [];
    const gaps: [number, number][] = [];
    f.db.add(0);
    f.hub.subscribeWithSink("log:s", 0, {
      getBufferedAmount: () => 0,
      send: (frames) => seen.push(...frames.map((frame) => frame.seq)),
      gap: (from, to) => gaps.push([from, to]),
    });
    f.left.publish({ key: "log:s", frames: [{ seq: 0, kind: "entry", payload: {} }], head: 0 });
    await waitFor(() => seen.length === 1, "base row");
    await f.hub.applyRemoteHead("log:s", 0, 7);
    f.left.publish({ key: "log:s", frames: [{ seq: 0, kind: "patch", payload: { secret: "never-send" } }], head: 0 });
    await waitFor(() => gaps.length === 1, "revision gap");
    expect(gaps).toEqual([[0, 0]]);
    expect(f.hub.knownHead("log:s")?.log_version).toBeNull();
    expect(JSON.stringify(f.posts)).not.toContain("never-send");
  });

  it("detects queue eviction from pre-enqueue sequence numbers and reconciles once", async () => {
    const f = pair({ queueLimit: 3 }); fixtures.push(f);
    const seen: number[] = [];
    f.db.add(0);
    f.hub.subscribe("log:s", 0, (_key, frames) => seen.push(...frames.map((frame) => frame.seq)));
    f.left.publish({ key: "log:s", frames: [{ seq: 0, kind: "entry", payload: {} }] });
    await waitFor(() => f.hub.snapshot().hub_peer_loss_detected.first_epoch === 1, "first epoch");
    await f.right.settled();
    const before = f.hub.snapshot().hub_peer_reconcile_streams;
    f.setOnline(false);
    for (let seq = 1; seq <= 10; seq += 1) {
      f.db.add(seq);
      f.left.publish({ key: "log:s", frames: [{ seq, kind: "entry", payload: {} }] });
    }
    await waitFor(() => f.sender.stats().dropped > 0, "evicted queue");
    f.setOnline(true);
    await waitFor(() => f.hub.snapshot().hub_peer_loss_detected.sequence_gap === 1, "sequence gap");
    await waitFor(() => f.hub.snapshot().hub_peer_reconcile_streams === before + 1, "single reconciliation");
    await waitFor(() => f.hub.knownHead("log:s")?.head === 10, "final head");
    await f.right.settled();
    expect(new Set(seen).size).toBe(seen.length);
    expect(f.hub.knownHead("log:s")?.head).toBe(10);
    expect(f.hub.snapshot().hub_peer_loss_detected.sequence_gap).toBe(1);
  }, 15_000);

  it("deduplicates replayed batches after one first-epoch reconciliation", async () => {
    const f = pair(); fixtures.push(f);
    f.db.add(0);
    f.hub.subscribe("log:s", 0, () => {});
    f.left.publish({ key: "log:s", frames: [{ seq: 0, kind: "entry", payload: {} }] });
    await waitFor(() => f.hub.snapshot().hub_peer_loss_detected.first_epoch === 1, "first epoch");
    const first = f.posts[0]!;
    f.receiver.receive("hub", first.events, { epoch: first.epoch, batchSeq: first.batch_seq + 1 });
    await f.right.settled();
    expect(f.hub.snapshot().hub_peer_loss_detected.first_epoch).toBe(1);
    expect(f.hub.snapshot().hub_peer_duplicate_dropped).toBeGreaterThan(0);
    expect(f.hub.snapshot().hub_peer_reconcile_streams).toBe(1);
  });

  it("reconciles once for a new sender epoch", async () => {
    const f = pair(); fixtures.push(f);
    f.db.add(0);
    f.hub.subscribe("log:s", 0, () => {});
    f.left.publish({ key: "log:s", frames: [{ seq: 0, kind: "entry", payload: {} }] });
    await waitFor(() => f.hub.snapshot().hub_peer_loss_detected.first_epoch === 1, "first epoch");
    const newSender = createPeerChannel({ url: "http://peer.test", secret: "test-only", fetchImpl: f.fetchImpl });
    const newTransport = createPeerHubTransport({ peer: newSender, heartbeatMs: 100_000 });
    try {
      f.db.add(1);
      newTransport.publish({ key: "log:s", frames: [{ seq: 1, kind: "entry", payload: {} }] });
      await waitFor(() => f.hub.snapshot().hub_peer_loss_detected.epoch_change === 1, "new epoch");
      await waitFor(() => f.hub.snapshot().hub_peer_reconcile_streams === 2, "epoch reconciliation");
      expect(f.hub.snapshot().hub_peer_reconcile_streams).toBe(2);
    } finally {
      newTransport.close();
      newSender.close();
    }
  }, 10_000);

  it("reconciles once after a receiver restart and drops replayed payloads", async () => {
    const f = pair(); fixtures.push(f);
    f.db.add(0);
    f.left.publish({ key: "log:s", frames: [{ seq: 0, kind: "entry", payload: {} }] });
    await waitFor(() => f.posts.length === 1, "first batch");
    f.hub.shutdown();
    const restarted = createPeerHubTransport({ peer: f.receiver, heartbeatMs: 100_000 });
    const hub = createHub({ transport: restarted, fill: f.db.fill });
    const seen: number[] = [];
    hub.subscribe("log:s", 0, (_key, frames) => seen.push(...frames.map((frame) => frame.seq)));
    try {
      const first = f.posts[0]!;
      f.receiver.receive("hub", first.events, { epoch: first.epoch, batchSeq: first.batch_seq + 1 });
      await waitFor(() => hub.snapshot().hub_peer_loss_detected.first_epoch === 1, "restart reconciliation");
      f.receiver.receive("hub", first.events, { epoch: first.epoch, batchSeq: first.batch_seq + 2 });
      await restarted.settled();
      expect(hub.snapshot().hub_peer_reconcile_streams).toBe(1);
      expect(hub.snapshot().hub_peer_duplicate_dropped).toBeGreaterThan(0);
      expect(new Set(seen).size).toBe(seen.length);
    } finally {
      hub.shutdown();
    }
  });

  it("delivers 50 queued heads after a ten-second outage without reconciliation", async () => {
    const f = pair({ queueLimit: 100 }); fixtures.push(f);
    f.db.add(0);
    const seen: number[] = [];
    f.hub.subscribe("log:s", 0, (_key, frames) => seen.push(...frames.map((frame) => frame.seq)));
    f.left.publish({ key: "log:s", frames: [{ seq: 0, kind: "entry", payload: {} }] });
    await waitFor(() => f.hub.snapshot().hub_peer_loss_detected.first_epoch === 1, "first epoch");
    await f.right.settled();
    f.setOnline(false);
    for (let seq = 1; seq <= 50; seq += 1) {
      f.db.add(seq);
      f.left.publish({ key: "log:s", frames: [{ seq, kind: "entry", payload: {} }] });
    }
    f.setNow(10_000);
    f.setOnline(true);
    await waitFor(() => f.hub.knownHead("log:s")?.head === 50, "fiftieth head");
    await waitFor(() => seen.length === 51, "all ordered frames");
    expect(seen).toEqual(Array.from({ length: 51 }, (_, seq) => seq));
    expect(f.hub.snapshot().hub_peer_loss_detected.sequence_gap).toBe(0);
    expect(f.hub.snapshot().hub_peer_reconcile_streams).toBe(1);
  });

  it("keeps a heartbeat-only link healthy without repeated reconciliation", async () => {
    const f = pair({ heartbeatMs: 20 }); fixtures.push(f);
    await waitFor(() => f.hub.snapshot().hub_peer_loss_detected.first_epoch === 1, "first heartbeat");
    const first = f.hub.snapshot().hub_peer_loss_detected.first_epoch;
    await Bun.sleep(75);
    expect(f.hub.snapshot().peer_link).toBe("healthy");
    expect(f.hub.snapshot().hub_peer_loss_detected.first_epoch).toBe(first);
    expect(f.hub.snapshot().hub_peer_loss_detected.sequence_gap).toBe(0);
  });

  it("keeps received heartbeats healthy while reconciliation waits on the reader", async () => {
    const f = pair({ staleMs: 15_000 }); fixtures.push(f);
    f.hub.subscribe("log:s", 0, () => {});
    await Bun.sleep(20);
    let readerCalls = 0;
    let releaseReader!: () => void;
    const readerWait = new Promise<void>((resolve) => { releaseReader = resolve; });
    f.db.fill.logHead = async () => {
      readerCalls += 1;
      await readerWait;
      return null;
    };
    try {
      const receiveHeartbeat = (seq: number) => f.receiver.receive("hub", [
        { kind: "hb", sender_epoch: "remote-heartbeats", hub_seq: seq },
      ], { epoch: "remote-heartbeats", batchSeq: seq });
      receiveHeartbeat(1);
      await waitFor(() => readerCalls === 1, "blocked reconciliation reader");
      for (let seq = 2; seq <= 5; seq += 1) {
        f.setNow((seq - 1) * 5_000);
        receiveHeartbeat(seq);
        expect(f.hub.snapshot().peer_link).toBe("healthy");
        expect(f.hub.snapshot().hub_peer_loss_detected).toMatchObject({
          first_epoch: 1, epoch_change: 0, sequence_gap: 0,
        });
      }
      expect(f.hub.snapshot().hub_peer_reconcile_streams).toBe(0);
    } finally {
      releaseReader();
      await f.right.settled();
    }
    expect(readerCalls).toBe(1);
  });

  it("ignores malformed frames for link health but counts valid duplicate frames", async () => {
    const f = pair({ staleMs: 15_000 }); fixtures.push(f);
    const frame = { kind: "hb", sender_epoch: "remote-heartbeats", hub_seq: 1 };
    f.receiver.receive("hub", [frame], { epoch: "remote-heartbeats", batchSeq: 1 });
    await f.right.settled();
    f.setNow(15_000);
    expect(f.hub.snapshot().peer_link).toBe("stale");
    f.receiver.receive("hub", [{ ...frame, hub_seq: "bad" }], { epoch: "remote-heartbeats", batchSeq: 2 });
    expect(f.hub.snapshot().peer_link).toBe("stale");
    f.receiver.receive("hub", [frame], { epoch: "remote-heartbeats", batchSeq: 3 });
    expect(f.hub.snapshot().peer_link).toBe("healthy");
    await f.right.settled();
    expect(f.hub.snapshot().hub_peer_duplicate_dropped).toBe(1);
    expect(f.hub.snapshot().hub_peer_loss_detected).toMatchObject({
      first_epoch: 1, epoch_change: 0, sequence_gap: 0,
    });
  });

  it("does not let a delayed pointer lower a reconciled head or clear its version", async () => {
    const f = pair(); fixtures.push(f);
    for (let seq = 0; seq <= 3; seq += 1) f.db.add(seq);
    f.hub.subscribe("log:s", 0, () => {});
    await f.hub.applyRemoteHead("log:s", 3, 7);
    await f.hub.applyRemoteHead("log:s", 1, null);
    expect(f.hub.knownHead("log:s")).toMatchObject({ head: 3, log_version: 7 });
    await f.hub.applyRemoteHead("log:s", 3, null);
    expect(f.hub.knownHead("log:s")).toMatchObject({ head: 3, log_version: 7 });
  });

  it("uses the local transport without a peer URL", () => {
    const hub = createHub({ transport: createLocalHubTransport() });
    try {
      expect(hub.snapshot()).toMatchObject({ transport: "local", peer_link: "disabled" });
      hub.onEntry("s", { session_id: "s", seq: 0, kind: "message", visibility: "shown", revision: 1 });
      expect(hub.snapshot().frames).toBe(1);
    } finally {
      hub.shutdown();
    }
  });

  it("marks a silent link stale and heals on a continuous frame without reconciliation", async () => {
    const f = pair({ staleMs: 15_000 }); fixtures.push(f);
    f.db.add(0);
    f.hub.subscribe("log:s", 0, () => {});
    f.left.publish({ key: "log:s", frames: [{ seq: 0, kind: "entry", payload: {} }] });
    await waitFor(() => f.hub.snapshot().hub_peer_loss_detected.first_epoch === 1, "first epoch");
    const before = f.hub.snapshot().hub_peer_reconcile_streams;
    f.setNow(15_000);
    expect(f.hub.snapshot().peer_link).toBe("stale");
    const app = createMultiremiApp({
      store: createStore(), hub: f.hub, backgroundJobs: false,
      apiRoleConfiguration: { role: "all", configured: false },
    });
    expect((await (await app.request("/health")).json() as { hub: { peer_link: string } }).hub.peer_link).toBe("stale");
    expect(await (await app.request("/readyz")).json()).toEqual({ ok: true });
    expect(f.hub.snapshot().hub_peer_reconcile_streams).toBe(before);
    f.db.add(1);
    f.left.publish({ key: "log:s", frames: [{ seq: 1, kind: "entry", payload: {} }] });
    await waitFor(() => f.hub.knownHead("log:s")?.head === 1, "recovered head");
    expect(f.hub.snapshot().peer_link).toBe("healthy");
    expect(f.hub.snapshot().hub_peer_reconcile_streams).toBe(before);
  });

  it("sends human-request transitions through the same channel", async () => {
    const f = pair(); fixtures.push(f);
    const seen: string[] = [];
    f.hub.subscribeHumanRequests("ws", (event) => seen.push(event.request_id));
    f.left.publishHumanRequest({ type: "created", workspace_id: "ws", request_id: "req_1", task_id: "tsk_1", at: "2026-09-29T00:00:00Z" });
    await waitFor(() => seen.length === 1, "human request");
    expect(seen).toEqual(["req_1"]);
  });
});
