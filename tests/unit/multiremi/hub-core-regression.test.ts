import { afterEach, describe, expect, it } from "bun:test";
import {
  createHub,
  type HubImpl,
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
