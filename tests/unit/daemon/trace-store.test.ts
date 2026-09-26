import { describe, expect, it } from "bun:test";
import {
  InMemoryTraceStore,
  TRACE_READ_DEFAULT_LIMIT,
  TRACE_READ_MAX_LIMIT,
  traceEventBytes,
} from "@multiremi/worker/trace-store.js";
import type { TraceEventInput } from "@multiremi/contracts/trace.js";

function event(overrides: Partial<TraceEventInput> = {}): TraceEventInput {
  return { ts: 1_700_000_000_000, type: "text", content: "hello", ...overrides };
}

describe("InMemoryTraceStore", () => {
  it("assigns dense per-task sequences starting at 1", () => {
    const store = new InMemoryTraceStore();
    const first = store.append("task_a", [event(), event({ type: "thinking" })]);
    expect(first.head).toBe(2);
    expect(first.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(store.head("task_a")).toBe(2);

    const second = store.append("task_a", [event({ type: "usage" })]);
    expect(second.events.map((e) => e.seq)).toEqual([3]);
    expect(store.head("task_a")).toBe(3);
  });

  it("keeps sequences independent per task", () => {
    const store = new InMemoryTraceStore();
    store.append("task_a", [event(), event()]);
    const other = store.append("task_b", [event()]);
    expect(other.events.map((e) => e.seq)).toEqual([1]);
    expect(store.head("task_a")).toBe(2);
    expect(store.head("task_b")).toBe(1);
  });

  it("reports a head of null for an unknown task and never invents one", () => {
    const store = new InMemoryTraceStore();
    expect(store.head("nope")).toBeNull();
    expect(store.read("nope")).toEqual({ events: [], head: 0, eof: true, ended: false });
  });

  it("reads strictly after the cursor and pages without overlap or holes", () => {
    const store = new InMemoryTraceStore();
    store.append("task_a", Array.from({ length: 7 }, (_, index) => event({ content: `chunk-${index}` })));

    const page1 = store.read("task_a", 0, 3);
    expect(page1.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(page1.eof).toBe(false);
    expect(page1.head).toBe(7);

    const page2 = store.read("task_a", 3, 3);
    expect(page2.events.map((e) => e.seq)).toEqual([4, 5, 6]);

    const page3 = store.read("task_a", 6, 3);
    expect(page3.events.map((e) => e.seq)).toEqual([7]);
    expect(page3.eof).toBe(true);
    expect(page3.ended).toBe(false);
  });

  it("treats a cursor at the head as an empty page that reports eof", () => {
    const store = new InMemoryTraceStore();
    store.append("task_a", [event(), event()]);
    const page = store.read("task_a", 2);
    expect(page.events).toEqual([]);
    expect(page.eof).toBe(true);
    expect(page.head).toBe(2);
  });

  it("stops a page at maxBytes but still returns one oversized event", () => {
    const store = new InMemoryTraceStore();
    const small = event({ content: "x".repeat(64) });
    store.append("task_a", [small, small, small]);
    const oneEventBytes = traceEventBytes({ ...small, seq: 1 });

    const bounded = store.read("task_a", 0, TRACE_READ_DEFAULT_LIMIT, oneEventBytes * 2 + 8);
    expect(bounded.events.map((e) => e.seq)).toEqual([1, 2]);

    const oversized = event({ content: "y".repeat(4096) });
    const store2 = new InMemoryTraceStore();
    store2.append("task_b", [oversized]);
    const page = store2.read("task_b", 0, TRACE_READ_DEFAULT_LIMIT, 8);
    expect(page.events.map((e) => e.seq)).toEqual([1]);
    expect(page.eof).toBe(true);
  });

  it("clamps a limit above the reader maximum instead of returning everything", () => {
    const store = new InMemoryTraceStore();
    store.append("task_a", Array.from({ length: TRACE_READ_MAX_LIMIT + 25 }, () => event()));
    const page = store.read("task_a", 0, TRACE_READ_MAX_LIMIT * 10);
    expect(page.events).toHaveLength(TRACE_READ_MAX_LIMIT);
    expect(page.eof).toBe(false);
  });

  it("refuses to reopen an ended task, so the archived tail stays final", () => {
    const store = new InMemoryTraceStore();
    store.append("task_a", [event()]);
    store.end("task_a", "completed");
    expect(store.isEnded("task_a")).toBe(true);

    const late = store.append("task_a", [event({ type: "text", content: "too late" })]);
    expect(late).toEqual({ head: 1, events: [] });
    expect(store.head("task_a")).toBe(1);

    const page = store.read("task_a");
    expect(page.events).toHaveLength(1);
    expect(page.ended).toBe(true);
  });

  it("keeps the first end status and records an end for an unseen task", () => {
    const store = new InMemoryTraceStore();
    store.append("task_a", [event()]);
    store.end("task_a", "completed");
    store.end("task_a", "failed");
    expect(store.read("task_a").ended).toBe(true);
    expect(store.head("task_a")).toBe(1);

    store.end("never_seen", "cancelled");
    expect(store.isEnded("never_seen")).toBe(true);
    expect(store.head("never_seen")).toBe(0);
  });

  it("forgets a task without touching its neighbours", () => {
    const store = new InMemoryTraceStore();
    store.append("task_a", [event()]);
    store.append("task_b", [event()]);
    store.forget("task_a");
    expect(store.head("task_a")).toBeNull();
    expect(store.head("task_b")).toBe(1);
  });

  it("copies the producer's fields without mutating the caller's array", () => {
    const store = new InMemoryTraceStore();
    const input = event({ tool: "Bash", input: { command: "ls" }, tool_call_id: "tc_1", status: "in_progress" });
    const stored = store.append("task_a", [input]).events[0]!;
    expect(stored).toMatchObject({
      seq: 1,
      type: "text",
      tool: "Bash",
      input: { command: "ls" },
      tool_call_id: "tc_1",
      status: "in_progress",
    });
    expect(input).not.toHaveProperty("seq");
  });
});
