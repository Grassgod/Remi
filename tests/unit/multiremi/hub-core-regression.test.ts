import { afterEach, describe, expect, it } from "bun:test";
import {
  createHub,
  type HubImpl,
  type HubOptions,
  type HubSubscriberSink,
} from "@multiremi/api/hub/hub-core.js";
import { createLocalHubTransport } from "@multiremi/api/hub/hub-transport.js";
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

function patch(hub: HubImpl, seq: number, fields = { body_md: "edited" }, revision = 2): void {
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
