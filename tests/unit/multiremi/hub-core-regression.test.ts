import { afterEach, describe, expect, it } from "bun:test";
import {
  createHub,
  type HubImpl,
  type HubFillReader,
  type HubOptions,
  type HubSubscriberSink,
} from "@multiremi/api/hub/hub-core.js";
import { createLocalHubTransport } from "@multiremi/api/hub/hub-transport.js";
import type { ConversationLogPatch } from "@multiremi/api/hub/live-hub.js";
import type { HubFrame, HubSeqRange } from "@multiremi/contracts/live-hub.js";

const hubs: HubImpl[] = [];
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.shutdown();
});

function make(options: Partial<HubOptions> = {}): HubImpl {
  const hub = createHub({
    transport: createLocalHubTransport(),
    scheduleFlush: () => {},
    ...options,
  });
  hubs.push(hub);
  return hub;
}

function row(hub: HubImpl, seq: number): void {
  hub.onEntry("s", {
    session_id: "s", seq, revision: 1, kind: "message", visibility: "shown",
    ...{ body_md: `original-${seq}` },
  });
}

function patch(hub: HubImpl, seq: number, fields: ConversationLogPatch["fields"] = { body_md: "edited" }, revision = 2): void {
  hub.onEntry("s", { session_id: "s", target_seq: seq, revision, fields });
}

class RecordingSink implements HubSubscriberSink {
  buffered = 0;
  readonly frames: HubFrame[] = [];
  readonly gaps: HubSeqRange[] = [];
  readonly order: string[] = [];
  getBufferedAmount(): number { return this.buffered; }
  send(frames: readonly HubFrame[]): void {
    this.frames.push(...frames);
    this.order.push(`data:${frames.map((frame) => frame.seq).join(",")}`);
  }
  gap(from: number, to: number): void {
    this.gaps.push({ from, to });
    this.order.push(`gap:${from},${to}`);
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

function reader(head: number, seqs: number[]): HubFillReader {
  return {
    logHead: async () => ({ head, log_version: 19 }),
    traceHead: async () => null,
    readRange: async (_key, after, to) => seqs.filter((seq) => after < seq && seq <= to)
      .map((seq) => ({ seq, kind: "entry", payload: { seq, body_md: `read-${seq}` } })),
  };
}

describe("MUL-436 regression 1: patch bases and stale replay", () => {
  it("does not mistake an ack gap cursor for a delivered base", () => {
    const hub = make();
    const current = new RecordingSink();
    hub.subscribeWithSink("log:s", 0, current);
    row(hub, 1); hub.flushNow(); patch(hub, 1);
    const late = new RecordingSink();
    const sub = hub.subscribeWithSink("log:s", 0, late);
    expect(sub.gap).toEqual({ from: 0, to: 1 });
    hub.flushNow();
    expect(late.frames).toEqual([]);
    expect(current.frames.map((frame) => frame.kind)).toEqual(["entry", "patch"]);
    expect(current.gaps).toEqual([]);
  });

  it("rejects a baseless pending patch under the default setImmediate scheduler", async () => {
    const hub = make({ scheduleFlush: (callback) => { setImmediate(callback); } });
    row(hub, 1); await settle(); patch(hub, 1);
    const late = new RecordingSink();
    expect(hub.subscribeWithSink("log:s", 0, late).gap).toEqual({ from: 0, to: 1 });
    await settle();
    expect(late.frames).toEqual([]);
  });

  it("checks for stale rows on the first flush after subscribing", () => {
    const hub = make();
    const out = new RecordingSink();
    hub.subscribeWithSink("log:s", 0, out);
    row(hub, 1); patch(hub, 1); hub.flushNow();
    expect(out.order).toEqual(["gap:0,1"]);
    expect(out.frames).toEqual([]);
  });
});

describe("MUL-436 regression 2: edits while lagging", () => {
  it("retains an invalidation for the slow consumer while delivering to the fast one", () => {
    const hub = make({ limits: { laggingBytes: 10 } });
    const slow = new RecordingSink(), fast = new RecordingSink();
    const sub = hub.subscribeWithSink("log:s", 0, slow);
    hub.subscribeWithSink("log:s", 0, fast);
    slow.buffered = 11;
    row(hub, 1); hub.flushNow(); patch(hub, 1); hub.flushNow();
    expect(slow.frames.map((frame) => frame.kind)).toEqual(["entry"]);
    expect(fast.frames.map((frame) => frame.kind)).toEqual(["entry", "patch"]);
    slow.buffered = 0; sub.notifyDrain(); hub.flushNow();
    expect(slow.gaps).toEqual([{ from: 1, to: 1 }]);
    patch(hub, 1, { body_md: "edited again" }, 3); hub.flushNow();
    expect(slow.frames.map((frame) => frame.kind)).toEqual(["entry"]);
    expect(slow.gaps).toEqual([{ from: 1, to: 1 }, { from: 1, to: 1 }]);
  });

  it("bounds deferred edits with one conservative range and resumes after its cursor", () => {
    const hub = make({ limits: { laggingBytes: 10 } });
    const out = new RecordingSink();
    const sub = hub.subscribeWithSink("log:s", 0, out);
    out.buffered = 11;
    for (let seq = 1; seq <= 3; seq++) row(hub, seq);
    hub.flushNow();
    patch(hub, 1); hub.flushNow(); patch(hub, 3); hub.flushNow();
    row(hub, 4); hub.flushNow();
    out.buffered = 0; sub.notifyDrain(); hub.flushNow();
    expect(out.order).toEqual(["data:1,2,3", "gap:1,3", "data:4"]);
  });
});

describe("MUL-436 regression 3: edits outside retention", () => {
  it("delivers an edit after its base leaves the ring, and gaps a consumer without that base", () => {
    const hub = make({ limits: { ring: { streamMaxFrames: 3 } } });
    const current = new RecordingSink();
    hub.subscribeWithSink("log:s", 0, current);
    for (let seq = 1; seq <= 5; seq++) { row(hub, seq); hub.flushNow(); }
    const late = new RecordingSink();
    hub.subscribeWithSink("log:s", 5, late);
    patch(hub, 1); hub.flushNow();
    expect(current.frames.at(-1)).toMatchObject({ seq: 1, kind: "patch" });
    expect(current.gaps).toEqual([]);
    expect(late.frames).toEqual([]);
    expect(late.gaps).toEqual([{ from: 1, to: 1 }]);
    expect(hub.snapshot().frames).toBe(3);
  });

  it("keeps an out-of-ring edit visible to a lagging consumer after drain", () => {
    const hub = make({ limits: { laggingBytes: 10, ring: { streamMaxFrames: 3 } } });
    const out = new RecordingSink();
    const sub = hub.subscribeWithSink("log:s", 0, out);
    for (let seq = 1; seq <= 5; seq++) { row(hub, seq); hub.flushNow(); }
    out.buffered = 11; row(hub, 6); hub.flushNow();
    patch(hub, 1); hub.flushNow();
    out.buffered = 0; sub.notifyDrain(); hub.flushNow();
    expect(out.gaps).toEqual([{ from: 1, to: 1 }]);
  });
});

describe("MUL-436 regression 4: coalesced partial patches", () => {
  it("preserves disjoint fields, explicit nulls, and the newest value for repeated fields", () => {
    const hub = make(), out = new RecordingSink();
    hub.subscribeWithSink("log:s", 0, out);
    row(hub, 1); hub.flushNow();
    patch(hub, 1, { body_md: "edited", body_html: null }, 2);
    patch(hub, 1, { metadata: { resolved: true } }, 3);
    patch(hub, 1, { body_md: "latest" }, 4);
    hub.flushNow();
    expect(out.frames.filter((frame) => frame.kind === "patch")).toEqual([{
      seq: 1, kind: "patch", payload: {
        session_id: "s", target_seq: 1, revision: 4,
        fields: { body_md: "latest", body_html: null, metadata: { resolved: true } },
      },
    }]);
  });

  it("merges an older queued revision without overwriting newer fields", () => {
    const hub = make(), out = new RecordingSink();
    hub.subscribeWithSink("log:s", 0, out);
    row(hub, 1); hub.flushNow();
    patch(hub, 1, { body_md: "newer", metadata: { resolved: true } }, 3);
    patch(hub, 1, { body_md: "older", body_html: null }, 2);
    hub.flushNow();
    expect(out.frames.at(-1)?.payload).toEqual({
      session_id: "s", target_seq: 1, revision: 3,
      fields: { body_md: "newer", metadata: { resolved: true }, body_html: null },
    });
  });
});

describe("MUL-436 regression 5: ordinary flush boundaries", () => {
  it("reports trimmed log sequences before data without affecting a current consumer", () => {
    const hub = make({ limits: { ring: { streamMaxFrames: 3 } } });
    const behind = new RecordingSink(), current = new RecordingSink();
    hub.subscribeWithSink("log:s", 0, behind);
    hub.subscribeWithSink("log:s", 9, current);
    for (let seq = 1; seq <= 10; seq++) row(hub, seq);
    hub.flushNow();
    expect(behind.order).toEqual(["gap:0,7", "data:8,9,10"]);
    expect(current.order).toEqual(["data:10"]);
  });

  it("reports a trimmed trace batch through the same sink boundary", () => {
    const hub = make({ limits: { ring: { streamMaxFrames: 3 } } });
    const out = new RecordingSink();
    hub.subscribeWithSink("trace:t", 0, out);
    hub.append("t", Array.from({ length: 10 }, (_, i) => ({
      seq: i + 1, ts: "2026-09-28T00:00:00Z", type: "text", content: `${i + 1}`,
    })));
    hub.flushNow();
    expect(out.order).toEqual(["gap:0,7", "data:8,9,10"]);
  });

  it("rechecks retention between capped batches", () => {
    const hub = make({ limits: { batchBytes: 1, ring: { streamMaxFrames: 3 } } });
    const out = new RecordingSink();
    hub.subscribeWithSink("log:s", 0, out);
    for (let seq = 1; seq <= 3; seq++) row(hub, seq);
    hub.flushNow();
    for (let seq = 4; seq <= 8; seq++) row(hub, seq);
    hub.flushNow(); hub.flushNow(); hub.flushNow();
    expect(out.order).toEqual(["data:1", "gap:1,5", "data:6", "data:7", "data:8"]);
  });
});

describe("MUL-436 regression 6: sparse cold warm-up", () => {
  it("preserves the authoritative head and reports both prefix and suffix gaps", async () => {
    const hub = make({ fill: reader(200, Array.from({ length: 54 }, (_, i) => i + 137)) });
    const out = new RecordingSink();
    const sub = hub.subscribeWithSink("log:s", 0, out);
    await hub.warmUpSettled(); hub.flushNow();
    expect(sub.head).toBe(200);
    expect(sub.log_version).toBe(19);
    expect(out.gaps).toEqual([{ from: 0, to: 136 }, { from: 190, to: 200 }]);
    expect(out.frames.map((frame) => frame.seq)).toEqual(Array.from({ length: 54 }, (_, i) => i + 137));
    expect(out.order.at(-1)).toBe("gap:190,200");
    const late = new RecordingSink();
    hub.subscribeWithSink("log:s", 190, late); hub.flushNow();
    expect(late.order).toEqual(["gap:190,200"]);
    row(hub, 201); hub.flushNow();
    expect(sub.head).toBe(201);
    expect(out.frames.at(-1)?.seq).toBe(201);
  });

  it("reports an empty warm-up through both the sink and subscription getters", async () => {
    const hub = make({ fill: reader(30, []) }), out = new RecordingSink();
    const sub = hub.subscribeWithSink("log:s", 0, out);
    await hub.warmUpSettled(); hub.flushNow();
    expect(sub.head).toBe(30);
    expect(sub.first_seq).toBe(31);
    expect(sub.gap).toEqual({ from: 0, to: 30 });
    expect(out.gaps).toEqual([{ from: 0, to: 30 }]);
    row(hub, 31); hub.flushNow();
    expect(out.frames.map((frame) => frame.seq)).toEqual([31]);
  });

  it("delivers every readable segment with separate gaps for internal holes", async () => {
    const hub = make({ fill: reader(8, [3, 4, 6, 8]) }), out = new RecordingSink();
    const sub = hub.subscribeWithSink("log:s", 0, out);
    await hub.warmUpSettled();
    hub.flushNow(); hub.flushNow(); hub.flushNow();
    expect(sub.head).toBe(8);
    expect(out.order).toEqual(["gap:0,2", "data:3,4", "gap:4,5", "data:6", "gap:6,7", "data:8"]);
    const late = new RecordingSink();
    hub.subscribeWithSink("log:s", 5, late); hub.flushNow(); hub.flushNow();
    expect(late.order).toEqual(["data:6", "gap:6,7", "data:8"]);
  });

  it("reports prefix, internal and suffix gaps independently in one cold window", async () => {
    const hub = make({ fill: reader(10, [3, 4, 6, 7]) }), out = new RecordingSink();
    const sub = hub.subscribeWithSink("log:s", 0, out);
    await hub.warmUpSettled(); hub.flushNow(); hub.flushNow();
    expect(sub.head).toBe(10);
    expect(out.order).toEqual(["gap:0,2", "data:3,4", "gap:4,5", "data:6,7", "gap:7,10"]);
  });
});

class ReentrantSink extends RecordingSink {
  onSend: ((frames: readonly HubFrame[]) => void) | null = null;
  override send(frames: readonly HubFrame[]): void {
    super.send(frames);
    this.onSend?.(frames);
  }
}

describe("MUL-436 regression 2a: synchronous patch reentry", () => {
  it("delivers the patch queued synchronously while sending its base", () => {
    const hub = make(), out = new ReentrantSink();
    hub.subscribeWithSink("log:s", 0, out);
    out.onSend = (frames) => {
      if (!frames.some((frame) => frame.kind === "entry" && frame.seq === 1)) return;
      out.onSend = null;
      patch(hub, 1);
    };
    row(hub, 1);
    hub.flushNow(); hub.flushNow(); hub.flushNow();
    expect(out.frames.map((frame) => frame.kind)).toEqual(["entry", "patch"]);
    expect(out.frames.at(-1)?.payload).toMatchObject({ revision: 2, fields: { body_md: "edited" } });
    expect(out.gaps).toEqual([]);
  });

  it("delivers a reentrant patch once to both consumers holding its base", () => {
    const hub = make(), first = new ReentrantSink(), second = new RecordingSink();
    hub.subscribeWithSink("log:s", 0, first);
    hub.subscribeWithSink("log:s", 0, second);
    row(hub, 1); hub.flushNow();
    first.onSend = () => {
      first.onSend = null;
      patch(hub, 1);
    };
    row(hub, 2);
    hub.flushNow(); hub.flushNow(); hub.flushNow();
    for (const out of [first, second]) {
      expect(out.frames.map((frame) => frame.kind)).toEqual(["entry", "entry", "patch"]);
      expect(out.frames.at(-1)).toMatchObject({ seq: 1, payload: { revision: 2 } });
      expect(out.gaps).toEqual([]);
    }
  });

  it("preserves both fields when a pending revision triggers a newer patch during send", () => {
    const hub = make(), first = new ReentrantSink(), second = new RecordingSink();
    hub.subscribeWithSink("log:s", 0, first);
    hub.subscribeWithSink("log:s", 0, second);
    row(hub, 1); hub.flushNow();
    first.onSend = () => {
      first.onSend = null;
      patch(hub, 1, { metadata: { resolved: true } }, 3);
    };
    patch(hub, 1, { body_md: "edited" }, 2);
    hub.flushNow(); hub.flushNow(); hub.flushNow();
    for (const out of [first, second]) {
      const updates = out.frames.filter((frame) => frame.kind === "patch")
        .map((frame) => frame.payload as ConversationLogPatch);
      expect(updates.map((update) => update.revision)).toEqual([2, 3]);
      expect(Object.assign({}, ...updates.map((update) => update.fields))).toEqual({
        body_md: "edited", metadata: { resolved: true },
      });
      expect(out.gaps).toEqual([]);
    }
  });

  it("retains a reentrant patch for a key already handled in this flush", () => {
    const hub = make(), first = new RecordingSink(), second = new RecordingSink();
    hub.subscribeWithSink("log:s", 0, first);
    hub.subscribeWithSink("log:s", 0, second);
    row(hub, 1); hub.flushNow();
    const trigger = new ReentrantSink();
    hub.subscribeWithSink("log:trigger", 0, trigger); hub.flushNow();
    trigger.onSend = () => {
      trigger.onSend = null;
      patch(hub, 1);
    };
    row(hub, 2);
    hub.onEntry("trigger", { session_id: "trigger", seq: 1, revision: 1, kind: "message", visibility: "shown" });
    hub.flushNow(); hub.flushNow(); hub.flushNow();
    for (const out of [first, second]) {
      expect(out.frames.filter((frame) => frame.kind === "patch")).toEqual([{
        seq: 1, kind: "patch", payload: { session_id: "s", target_seq: 1, revision: 2, fields: { body_md: "edited" } },
      }]);
      expect(out.gaps).toEqual([]);
    }
  });

  it("merges a reentrant patch into a later key's pending revision without duplicating it", () => {
    const hub = make(), first = new RecordingSink(), second = new RecordingSink();
    hub.subscribeWithSink("log:s", 0, first);
    hub.subscribeWithSink("log:s", 0, second);
    row(hub, 1); hub.flushNow();
    const trigger = new ReentrantSink();
    hub.subscribeWithSink("log:trigger", 0, trigger);
    trigger.onSend = () => {
      trigger.onSend = null;
      patch(hub, 1, { metadata: { resolved: true } }, 3);
    };
    hub.onEntry("trigger", { session_id: "trigger", seq: 1, revision: 1, kind: "message", visibility: "shown" });
    patch(hub, 1, { body_md: "edited" }, 2);
    hub.flushNow(); hub.flushNow(); hub.flushNow();
    for (const out of [first, second]) {
      expect(out.frames.filter((frame) => frame.kind === "patch")).toEqual([{
        seq: 1, kind: "patch", payload: {
          session_id: "s", target_seq: 1, revision: 3,
          fields: { body_md: "edited", metadata: { resolved: true } },
        },
      }]);
      expect(out.gaps).toEqual([]);
    }
  });

  it("reports a reentrant edit as a gap to a consumer without the base", () => {
    const hub = make(), owner = new ReentrantSink(), baseless = new RecordingSink();
    hub.subscribeWithSink("log:s", 0, owner);
    row(hub, 1); hub.flushNow();
    hub.subscribeWithSink("log:s", 1, baseless);
    owner.onSend = () => {
      owner.onSend = null;
      patch(hub, 1);
    };
    row(hub, 2);
    hub.flushNow(); hub.flushNow(); hub.flushNow();
    expect(owner.frames.filter((frame) => frame.kind === "patch")).toHaveLength(1);
    expect(baseless.frames.map((frame) => frame.kind)).toEqual(["entry"]);
    expect(baseless.gaps).toEqual([{ from: 1, to: 1 }]);
  });
});
