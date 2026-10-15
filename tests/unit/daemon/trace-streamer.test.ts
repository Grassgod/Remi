import { describe, expect, it } from "bun:test";
import { TraceStreamer, coldTraceCursor } from "@multiremi/worker/trace-streamer.js";
import { InMemoryTraceStore, traceEventBytes } from "@multiremi/worker/trace-store.js";
import type { DaemonProtocolClient } from "@multiremi/worker/daemon-protocol-client.js";
import type { TraceEventInput, TraceEventLine } from "@multiremi/contracts/trace.js";
import { waitFor } from "../../integration/daemon-protocol-v2/harness.js";
import { encodeDaemonProtocolFrame } from "@multiremi/api/daemon-protocol/frames.js";

/** An opaque body of about `bytes` bytes: the streamer never looks inside events. */
function body(bytes = 0, type = "x.test"): TraceEventInput {
  return { type, pad: " ".repeat(bytes) } as unknown as TraceEventInput;
}

function peer() {
  const frames: Array<{ task_id: string; events: TraceEventLine[]; closed: boolean }> = [];
  const listeners = new Set<(welcome: any) => void>();
  let paused = false;
  const client = { onWelcome: (listener: any) => { listeners.add(listener); return () => listeners.delete(listener); },
    connectionState: () => "connected", uplinkPaused: () => paused,
    rpc: async (_type: string, payload: any) => { frames.push(payload); return { hub_head: payload.events.at(-1).seq }; } };
  return { frames, client: client as unknown as DaemonProtocolClient,
    pause: (value: boolean) => { paused = value; },
    welcome: (heads: Record<string, number>) => { for (const listener of listeners) listener({ trace_heads: heads }); } };
}

describe("trace stream frame and replay budgets", () => {
  it("cold replay keeps the newest events that fit the 2 MiB budget, each up to the 1 MiB ceiling", async () => {
    const store = new InMemoryTraceStore(); const p = peer();
    const events = store.append("large", [body(900 * 1024), body(900 * 1024), body(900 * 1024)]).events;
    expect(events).toHaveLength(3);
    expect(traceEventBytes(events[2]!)).toBeGreaterThan(900 * 1024);
    expect(coldTraceCursor(store, "large")).toBe(1);
    const pump = new TraceStreamer(p.client, store);
    try {
      pump.track("large", "rt");
      await waitFor(() => p.frames.flatMap((frame) => frame.events).length === 2, "cold tail replay");
      expect(p.frames.flatMap((frame) => frame.events)).toEqual(events.slice(1));
      expect(p.frames.every((frame) => frame.events.length === 1)).toBe(true);
    } finally { await pump.stop(); }
  });
  it("sends at most 256 events or 256 KiB, but admits one 640 KiB event", async () => {
    const store = new InMemoryTraceStore(); const p = peer();
    const pump = new TraceStreamer(p.client, store);
    pump.track("task", "rt");
    const large = store.append("task", [body(640 * 1024)]).events[0]!;
    store.append("task", Array.from({ length: 520 }, () => body(5)));
    store.close("task", { status: "completed", ended_at: new Date().toISOString() });
    pump.wake();
    try {
      await waitFor(() => p.frames.at(-1)?.closed === true, "all trace frames");
      expect(traceEventBytes(large)).toBeGreaterThan(630 * 1024);
      expect(p.frames[0]!.events).toHaveLength(1);
      expect(p.frames.flatMap(frame => frame.events.map(event => event.seq))).toEqual(Array.from({ length: 521 }, (_, i) => i + 1));
      expect(p.frames.some(frame => frame.events.length === 256)).toBe(true);
      for (const frame of p.frames) {
        expect(frame.events.length).toBeGreaterThan(0);
        expect(frame.events.length).toBeLessThanOrEqual(256);
        const bytes = Buffer.byteLength(encodeDaemonProtocolFrame({ t: "trace.append", id: "x".repeat(36),
          rt: "rt", ack: Number.MAX_SAFE_INTEGER, p: frame }, Number.MAX_SAFE_INTEGER));
        expect(bytes <= 256 * 1024 || frame.events.length === 1).toBe(true);
        expect(Buffer.byteLength(JSON.stringify({ v: 2, t: "trace.append", p: frame }))).toBeLessThan(1024 * 1024);
      }
    } finally { await pump.stop(); }
  });

  it("includes the envelope and array separators in the multi-event byte limit", async () => {
    const store = new InMemoryTraceStore(); const p = peer();
    const pump = new TraceStreamer(p.client, store);
    store.append("boundary", Array.from({ length: 4 }, () => body(130920)));
    pump.track("boundary", "rt");
    try {
      await waitFor(() => p.frames.flatMap(frame => frame.events).length === 4, "byte boundary");
      for (const frame of p.frames) {
        expect(Buffer.byteLength(encodeDaemonProtocolFrame({ t: "trace.append", id: "x".repeat(36),
          rt: "rt", ack: Number.MAX_SAFE_INTEGER, p: frame }, Number.MAX_SAFE_INTEGER))).toBeLessThanOrEqual(256 * 1024);
      }
    } finally { await pump.stop(); }
  });

  it("yields to reports and backpressure, then resumes at welcome's head", async () => {
    const store = new InMemoryTraceStore(); const p = peer(); let priority = true;
    const pump = new TraceStreamer(p.client, store, () => priority);
    pump.track("task", "rt"); store.append("task", Array.from({ length: 4 }, () => body()));
    pump.wake();
    try {
      await Bun.sleep(30); expect(p.frames).toHaveLength(0);
      priority = false; p.pause(true);
      await Bun.sleep(30); expect(p.frames).toHaveLength(0);
      p.pause(false); p.welcome({ task: 2 });
      await waitFor(() => p.frames.length > 0, "resume");
      expect(p.frames[0]!.events.map(event => event.seq)).toEqual([3, 4]);
    } finally { await pump.stop(); }
  });

  it("replays only a continuous tail bounded by 2,000 events and 2 MiB", () => {
    const store = new InMemoryTraceStore();
    store.append("count", Array.from({ length: 2500 }, () => body(1)));
    expect(coldTraceCursor(store, "count")).toBe(500);
    store.append("bytes", Array.from({ length: 2100 }, () => body(4096)));
    const cursor = coldTraceCursor(store, "bytes");
    expect(cursor).toBeGreaterThan(100);
    const tail: TraceEventLine[] = [];
    let after = cursor;
    while (after < 2100) {
      const page = store.read("bytes", after, 500); tail.push(...page.events); after = page.events.at(-1)!.seq;
    }
    expect(tail.length).toBeLessThanOrEqual(2000);
    expect(tail.reduce((sum, event) => sum + traceEventBytes(event), 0)).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(tail.map(event => event.seq)).toEqual(Array.from({ length: tail.length }, (_, i) => cursor + i + 1));
  });
});
