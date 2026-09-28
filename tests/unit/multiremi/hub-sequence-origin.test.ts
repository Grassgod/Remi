import { afterEach, describe, expect, it } from "bun:test";
import { createHub, type HubImpl } from "@multiremi/api/hub/hub-core.js";
import { createLocalHubTransport } from "@multiremi/api/hub/hub-transport.js";
import type { HubFrame } from "@multiremi/contracts/live-hub.js";
import type { TraceEvent } from "@multiremi/contracts/trace.js";

const hubs: HubImpl[] = [];
afterEach(() => { for (const hub of hubs.splice(0)) hub.shutdown(); });
function make() {
  const hub = createHub({ transport: createLocalHubTransport(), scheduleFlush: () => {} });
  hubs.push(hub);
  return hub;
}
function row(hub: HubImpl, seq: number) {
  hub.onEntry("s", { session_id: "s", seq, revision: 1, kind: "message", visibility: "shown" });
}

describe("MUL-436 regression 4C: sequence spelling and origin", () => {
  it("replays 2 and 3 from the next wanted seq 2 on repeated reconnects", () => {
    const hub = make();
    for (let seq = 1; seq <= 3; seq++) row(hub, seq);
    for (let reconnect = 0; reconnect < 2; reconnect++) {
      const frames: HubFrame[] = [];
      const sub = hub.subscribe("log:s", 2, (_key, batch) => frames.push(...batch));
      hub.flushNow();
      expect(sub.gap).toBeNull();
      expect(frames.map((frame) => frame.seq)).toEqual([2, 3]);
      sub.unsubscribe();
    }
  });

  it("distinguishes an empty log head from a retained real seq zero", () => {
    const hub = make();
    const frames: HubFrame[] = [];
    const sub = hub.subscribe("log:s", 0, (_key, batch) => frames.push(...batch));
    expect(sub.head).toBe(-1);
    expect(sub.first_seq).toBe(0);
    expect(sub.gap).toBeNull();
    row(hub, 0); hub.flushNow();
    expect(sub.head).toBe(0);
    expect(frames.map((frame) => frame.seq)).toEqual([0]);
    row(hub, 1); hub.flushNow();
    expect(frames.map((frame) => frame.seq)).toEqual([0, 1]);
  });

  it("clamps keyed trace zero to one without a false gap", () => {
    const hub = make();
    hub.append("t", [1, 2, 3].map((seq) => ({ seq, ts: "", type: "text" })));
    for (const from of [0, 1]) {
      const frames: HubFrame[] = [];
      const sub = hub.subscribe("trace:t", from, (_key, batch) => frames.push(...batch));
      expect(sub.gap).toBeNull(); hub.flushNow();
      expect(frames.map((frame) => frame.seq)).toEqual([1, 2, 3]);
      sub.unsubscribe();
    }
  });

  it("keeps A-0 exclusive and keyed inclusive on the same trace stream", () => {
    const hub = make();
    hub.append("t", [1, 2, 3].map((seq) => ({ seq, ts: "", type: "text" })));
    const events: TraceEvent[] = [], frames: HubFrame[] = [];
    hub.subscribe("t", 2, (_task, batch) => events.push(...batch));
    hub.subscribe("trace:t", 2, (_key, batch) => frames.push(...batch));
    hub.flushNow();
    expect(events.map((event) => event.seq)).toEqual([3]);
    expect(frames.map((frame) => frame.seq)).toEqual([2, 3]);
  });

  it("reports a single missing requested position at the retained boundary", () => {
    const hub = createHub({ transport: createLocalHubTransport(), scheduleFlush: () => {}, limits: { ring: { streamMaxFrames: 1 } } });
    hubs.push(hub); row(hub, 0); row(hub, 1); row(hub, 2);
    const sub = hub.subscribe("log:s", 1, () => {});
    expect(sub.gap).toEqual({ from: 1, to: 1 });
  });

  it("warms a log whose authoritative head is zero", async () => {
    const ranges: number[][] = [];
    const hub = createHub({ transport: createLocalHubTransport(), scheduleFlush: () => {}, fill: {
      logHead: async () => ({ head: 0, log_version: 9 }), traceHead: async () => null,
      readRange: async (_key, after, to) => { ranges.push([after, to]); return [{ seq: 0, kind: "entry", payload: { seq: 0 } }]; },
    } });
    hubs.push(hub);
    const frames: HubFrame[] = [];
    const sub = hub.subscribe("log:s", 0, (_key, batch) => frames.push(...batch));
    await hub.warmUpSettled(); hub.flushNow();
    expect(ranges).toEqual([[-1, 0]]);
    expect(sub.head).toBe(0); expect(sub.gap).toBeNull();
    expect(frames.map((frame) => frame.seq)).toEqual([0]);
  });
});
