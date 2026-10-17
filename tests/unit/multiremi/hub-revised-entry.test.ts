/**
 * A whole row re-emitted at a sequence the `log:` stream already passed.
 *
 * A Chat turn card is written (hidden) when its turn starts and the store
 * re-emits it as an `entry`, not a patch, each time the turn changes: a browser
 * that only holds the hidden marker has no base a patch could apply to. The hub
 * used to drop every entry at or below its head as a replay, so the finished
 * card (steps fold, 「用时」 header) never reached a live Chat.
 */
import { describe, expect, it } from "bun:test";
import { createHub, type HubSubscriberSink } from "@multiremi/api/hub/hub-core.js";
import { LocalHubTransport, type HubTransportPublishInput } from "@multiremi/api/hub/hub-transport.js";
import type { HubFrame, HubStreamKey } from "@multiremi/contracts/live-hub.js";

const KEY = "log:chat_1" as HubStreamKey;

class Sink implements HubSubscriberSink {
  readonly batches: HubFrame[][] = [];
  readonly gaps: { from: number; to: number }[] = [];
  buffered = 0;
  getBufferedAmount(): number { return this.buffered; }
  send(frames: readonly HubFrame[]): void { this.batches.push([...frames]); }
  gap(from: number, to: number): void { this.gaps.push({ from, to }); }
  get frames(): HubFrame[] { return this.batches.flat(); }
  clear(): void { this.batches.length = 0; this.gaps.length = 0; }
}

function card(revision: number, status: string) {
  return {
    session_id: "chat_1", seq: 2, id: "turn_1", kind: "turn", revision,
    visibility: (status === "completed" ? "shown" : "hidden") as "shown" | "hidden",
    metadata: { turn_id: "turn_1", status, ...(status === "completed" ? { final_entry_id: "msg_reply", process_item_count: 3 } : {}) },
  };
}

function row(seq: number) {
  return { session_id: "chat_1", seq, id: `msg_${seq}`, kind: "message", visibility: "shown" as const, revision: 1 };
}

function bed() {
  const published: HubTransportPublishInput[] = [];
  const transport = new (class extends LocalHubTransport {
    override publish(input: HubTransportPublishInput): void { published.push(input); }
  })();
  const scheduled: (() => void)[] = [];
  const hub = createHub({ transport, fill: null, scheduleFlush: (callback) => { scheduled.push(callback); } });
  const flush = () => { while (scheduled.length > 0) scheduled.shift()!(); };
  return { hub, published, flush };
}

/** The member's message (1), the running card (2), then the reply (3). */
function runTurn(t: ReturnType<typeof bed>) {
  t.hub.onEntry("chat_1", row(1));
  t.hub.onEntry("chat_1", card(2, "running"));
  t.hub.onEntry("chat_1", row(3));
}

describe("hub: a revised whole row at a passed sequence", () => {
  it("forwards the finished card to a subscriber that already holds its position", () => {
    const t = bed();
    const sink = new Sink();
    t.hub.subscribeWithSink(KEY, 1, sink);
    runTurn(t);
    t.flush();
    expect(sink.frames.map((frame) => frame.seq)).toEqual([1, 2, 3]);
    sink.clear();

    t.hub.onEntry("chat_1", card(5, "completed"));
    t.flush();
    expect(sink.frames).toHaveLength(1);
    expect(sink.frames[0]).toMatchObject({ seq: 2, kind: "entry", payload: { revision: 5, visibility: "shown" } });
    expect(sink.gaps).toEqual([]);
    expect(t.hub.snapshot().dropped_frames).toBe(0);
    // The window did not grow: the card kept its position.
    expect(t.hub.snapshot().frames).toBe(3);
  });

  it("drops an equal or older revision as a replay", () => {
    const t = bed();
    const sink = new Sink();
    t.hub.subscribeWithSink(KEY, 1, sink);
    runTurn(t);
    t.hub.onEntry("chat_1", card(5, "completed"));
    t.flush();
    sink.clear();

    t.hub.onEntry("chat_1", card(5, "completed"));
    t.hub.onEntry("chat_1", card(4, "running"));
    t.flush();
    expect(sink.frames).toEqual([]);
    expect(t.hub.snapshot().dropped_frames).toBe(2);
  });

  it("serves the newest row to a subscriber that replays the position later", () => {
    const t = bed();
    runTurn(t);
    t.hub.onEntry("chat_1", card(5, "completed"));
    t.flush();

    const late = new Sink();
    const subscription = t.hub.subscribeWithSink(KEY, 1, late);
    expect(subscription.gap).toBeNull();
    t.flush();
    expect(late.frames.map((frame) => [frame.seq, (frame.payload as { revision: number }).revision])).toEqual([[1, 1], [2, 5], [3, 1]]);
    expect(late.gaps).toEqual([]);
  });

  it("does not send the revision twice to a subscriber that replays it in the same tick", () => {
    const t = bed();
    runTurn(t);
    t.hub.onEntry("chat_1", card(5, "completed"));
    const sink = new Sink();
    t.hub.subscribeWithSink(KEY, 1, sink);
    t.flush();
    expect(sink.frames.map((frame) => frame.seq)).toEqual([1, 2, 3]);
  });

  it("tells a paused subscriber to reread the position instead", () => {
    const t = bed();
    const sink = new Sink();
    const subscription = t.hub.subscribeWithSink(KEY, 1, sink);
    runTurn(t);
    t.flush();
    sink.clear();
    sink.buffered = Number.MAX_SAFE_INTEGER;
    t.hub.onEntry("chat_1", row(4));
    t.flush();
    sink.clear();

    t.hub.onEntry("chat_1", card(5, "completed"));
    t.flush();
    expect(sink.frames).toEqual([]);
    sink.buffered = 0;
    subscription.notifyDrain();
    t.flush();
    expect(sink.gaps).toContainEqual({ from: 2, to: 2 });
  });

  it("announces the revision to a peer as a changed sequence", () => {
    const t = bed();
    runTurn(t);
    t.published.length = 0;
    t.hub.onEntry("chat_1", card(5, "completed"));
    expect(t.published).toEqual([{ key: KEY, frames: [expect.objectContaining({ seq: 2 })], head: 3, changed: true }]);
  });

  it("replaces a newer whole row that waits behind a hole", () => {
    const t = bed();
    const sink = new Sink();
    t.hub.subscribeWithSink(KEY, 1, sink);
    t.hub.onEntry("chat_1", card(2, "running"));
    t.hub.onEntry("chat_1", card(5, "completed"));
    t.hub.onEntry("chat_1", row(1));
    t.flush();
    expect(sink.frames.map((frame) => [frame.seq, (frame.payload as { revision: number }).revision])).toEqual([[1, 1], [2, 5]]);
  });
});
