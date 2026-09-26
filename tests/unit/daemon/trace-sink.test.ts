import { describe, expect, it } from "bun:test";
import { InMemoryTraceSink } from "@multiremi/api/trace/trace-sink.js";
import type { TraceEvent } from "@multiremi/contracts/trace.js";

function event(seq: number, content = `event-${seq}`): TraceEvent {
  return { seq, ts: 1_700_000_000_000 + seq, type: "text", content };
}

function batch(...seqs: number[]): TraceEvent[] {
  return seqs.map((seq) => event(seq));
}

describe("InMemoryTraceSink", () => {
  it("tracks the head and reports null before it has seen a task", () => {
    const sink = new InMemoryTraceSink();
    expect(sink.head("task_a")).toBeNull();
    expect(sink.append("task_a", batch(1, 2, 3)).head).toBe(3);
    expect(sink.head("task_a")).toBe(3);
  });

  it("drops replayed events at or below the head and treats them as already delivered", () => {
    const sink = new InMemoryTraceSink();
    sink.append("task_a", batch(1, 2, 3));
    const seen: number[][] = [];
    sink.subscribe("task_a", 3, (_taskId, events) => seen.push(events.map((e) => e.seq)));

    // The exact replay a reconnect produces: the daemon resends from its own
    // cursor, which may sit behind the sink's head.
    expect(sink.append("task_a", batch(1, 2, 3)).head).toBe(3);
    expect(seen).toEqual([]);

    sink.append("task_a", batch(4, 5));
    expect(seen).toEqual([[4, 5]]);
  });

  it("delivers the backlog on subscribe and then only new events", () => {
    const sink = new InMemoryTraceSink();
    sink.append("task_a", batch(1, 2, 3, 4));
    const seen: number[][] = [];
    const sub = sink.subscribe("task_a", 1, (_taskId, events) => seen.push(events.map((e) => e.seq)));

    expect(seen).toEqual([[2, 3, 4]]);
    expect(sub.first_seq).toBe(1);
    expect(sub.head).toBe(4);
    expect(sub.gap).toBe(false);

    sink.append("task_a", batch(5));
    expect(seen).toEqual([[2, 3, 4], [5]]);
  });

  it("reports a gap when the cursor predates what the sink still holds", () => {
    const sink = new InMemoryTraceSink();
    sink.append("task_a", batch(1, 2, 3, 4, 5));
    sink.dropBefore("task_a", 4);

    const seen: number[][] = [];
    const sub = sink.subscribe("task_a", 0, (_taskId, events) => seen.push(events.map((e) => e.seq)));
    expect(sub.gap).toBe(true);
    expect(sub.first_seq).toBe(4);
    // The gap degrades the view instead of silencing it: what the sink holds is
    // still delivered, so the reader only has to backfill 1..3.
    expect(seen).toEqual([[4, 5]]);
  });

  it("does not report a gap for a cursor the sink can still serve", () => {
    const sink = new InMemoryTraceSink();
    sink.append("task_a", batch(1, 2, 3));
    sink.dropBefore("task_a", 2);
    expect(sink.subscribe("task_a", 3, () => {}).gap).toBe(false);
    expect(sink.subscribe("task_a", 1, () => {}).gap).toBe(false);
  });

  it("stops delivering after unsubscribe", () => {
    const sink = new InMemoryTraceSink();
    const seen: number[][] = [];
    const sub = sink.subscribe("task_a", 0, (_taskId, events) => seen.push(events.map((e) => e.seq)));
    sink.append("task_a", batch(1));
    sub.unsubscribe();
    sub.unsubscribe();
    sink.append("task_a", batch(2));
    expect(seen).toEqual([[1]]);
  });

  it("keeps subscriptions isolated per task", () => {
    const sink = new InMemoryTraceSink();
    const seenA: number[][] = [];
    const seenB: number[][] = [];
    sink.subscribe("task_a", 0, (_t, events) => seenA.push(events.map((e) => e.seq)));
    sink.subscribe("task_b", 0, (_t, events) => seenB.push(events.map((e) => e.seq)));
    sink.append("task_a", batch(1));
    expect(seenA).toEqual([[1]]);
    expect(seenB).toEqual([]);
  });

  it("passes the task id through with the events", () => {
    const sink = new InMemoryTraceSink();
    const seen: string[] = [];
    sink.subscribe("task_a", 0, (taskId) => seen.push(taskId));
    sink.append("task_a", batch(1));
    expect(seen).toEqual(["task_a"]);
  });

  it("records the end of a task and keeps serving its trace", () => {
    const sink = new InMemoryTraceSink();
    sink.append("task_a", batch(1, 2));
    sink.end("task_a");
    expect(sink.isEnded("task_a")).toBe(true);
    const seen: number[][] = [];
    sink.subscribe("task_a", 0, (_taskId, events) => seen.push(events.map((e) => e.seq)));
    expect(seen).toEqual([[1, 2]]);
    expect(sink.append("task_a", batch(3)).head).toBe(3);
  });
});
