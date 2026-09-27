import { describe, expect, it } from "bun:test";
import {
  InMemoryTraceStore,
  TRACE_READ_DEFAULT_LIMIT,
  TRACE_READ_MAX_LIMIT,
  traceEventBytes,
} from "@multiremi/worker/trace-store.js";
import type { TraceEventInput } from "@multiremi/contracts/trace.js";
import { TRACE_TRUNCATION_MARKER } from "@shared/trace-sanitize.js";

/** A fixed clock so the `ts` the store assigns is assertable. */
const NOW = "2026-09-27T00:00:00.000Z";

function store(): InMemoryTraceStore {
  return new InMemoryTraceStore(() => NOW);
}

function event(patch: Partial<TraceEventInput> = {}): TraceEventInput {
  return { type: "text", content: "hello", ...patch };
}

describe("InMemoryTraceStore", () => {
  it("assigns dense per-task sequences starting at 1 and stamps ts", () => {
    const s = store();
    const first = s.append("task_a", [event(), event({ type: "thinking" })]);
    expect(first.head).toBe(2);
    expect(first.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(first.events.every((e) => e.ts === NOW)).toBe(true);
    expect(s.head("task_a")).toEqual({ head: 2, closed: false });

    const second = s.append("task_a", [event({ type: "usage" })]);
    expect(second.events.map((e) => e.seq)).toEqual([3]);
    expect(s.head("task_a")).toEqual({ head: 3, closed: false });
  });

  it("keeps sequences independent per task", () => {
    const s = store();
    s.append("task_a", [event(), event()]);
    const other = s.append("task_b", [event()]);
    expect(other.events.map((e) => e.seq)).toEqual([1]);
    expect(s.head("task_a")?.head).toBe(2);
    expect(s.head("task_b")?.head).toBe(1);
  });

  it("reports a head of null for an unknown task and never invents one", () => {
    const s = store();
    expect(s.head("nope")).toBeNull();
    expect(s.read("nope")).toEqual({ events: [], head: 0, eof: true });
  });

  it("reads strictly after the cursor and pages without overlap or holes", () => {
    const s = store();
    s.append("task_a", Array.from({ length: 7 }, (_, index) => event({ content: `chunk-${index}` })));

    const page1 = s.read("task_a", 0, 3);
    expect(page1.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(page1.eof).toBe(false);
    expect(page1.head).toBe(7);

    const page2 = s.read("task_a", 3, 3);
    expect(page2.events.map((e) => e.seq)).toEqual([4, 5, 6]);

    const page3 = s.read("task_a", 6, 3);
    expect(page3.events.map((e) => e.seq)).toEqual([7]);
    expect(page3.eof).toBe(true);
  });

  it("does not expose completeness on the read result, only on head", () => {
    // The read result has no `ended`/`closed` field on purpose: `closed` lives on
    // `head()` so there is exactly one place to ask.
    const s = store();
    s.append("task_a", [event()]);
    s.close("task_a", { status: "completed", ended_at: NOW });
    expect(Object.keys(s.read("task_a")).sort()).toEqual(["eof", "events", "head"]);
    expect(s.head("task_a")).toEqual({ head: 1, closed: true });
  });

  it("treats a cursor at the head as an empty page that reports eof", () => {
    const s = store();
    s.append("task_a", [event(), event()]);
    const page = s.read("task_a", 2);
    expect(page.events).toEqual([]);
    expect(page.eof).toBe(true);
    expect(page.head).toBe(2);
  });

  it("stops a page at maxBytes but still returns one oversized event", () => {
    const s = store();
    const small = event({ content: "x".repeat(64) });
    const stored = s.append("task_a", [small, small, small]).events;
    // Budget from the events the store actually holds, not from a re-serialized
    // guess: the store stamps `ts` and applies caps, so both change the size.
    const roomForTwo = traceEventBytes(stored[0]!) + traceEventBytes(stored[1]!);

    const bounded = s.read("task_a", 0, TRACE_READ_DEFAULT_LIMIT, roomForTwo);
    expect(bounded.events.map((e) => e.seq)).toEqual([1, 2]);

    const oversized = event({ content: "y".repeat(4096) });
    const s2 = store();
    s2.append("task_b", [oversized]);
    const page = s2.read("task_b", 0, TRACE_READ_DEFAULT_LIMIT, 8);
    expect(page.events.map((e) => e.seq)).toEqual([1]);
    expect(page.eof).toBe(true);
  });

  it("clamps a limit above the reader maximum instead of returning everything", () => {
    const s = store();
    s.append("task_a", Array.from({ length: TRACE_READ_MAX_LIMIT + 25 }, () => event()));
    const page = s.read("task_a", 0, TRACE_READ_MAX_LIMIT * 10);
    expect(page.events).toHaveLength(TRACE_READ_MAX_LIMIT);
    expect(page.eof).toBe(false);
  });

  it("refuses to reopen a closed task, so the archived tail stays final", () => {
    const s = store();
    s.append("task_a", [event()]);
    s.close("task_a", { status: "completed", ended_at: NOW });
    expect(s.head("task_a")).toEqual({ head: 1, closed: true });

    const late = s.append("task_a", [event({ content: "too late" })]);
    expect(late).toEqual({ head: 1, events: [] });
    expect(s.read("task_a").events).toHaveLength(1);
  });

  it("keeps the first close status, and closing an unseen task still marks it closed", () => {
    const s = store();
    s.append("task_a", [event()]);
    s.close("task_a", { status: "completed", ended_at: NOW });
    s.close("task_a", { status: "failed", ended_at: "2026-09-27T01:00:00.000Z" });
    expect(s.endInfo("task_a")).toEqual({ status: "completed", ended_at: NOW });

    s.close("never_seen", { status: "cancelled", ended_at: NOW });
    expect(s.head("never_seen")).toEqual({ head: 0, closed: true });
  });

  it("forgets a task without touching its neighbours", () => {
    const s = store();
    s.append("task_a", [event()]);
    s.append("task_b", [event()]);
    s.forget("task_a");
    expect(s.head("task_a")).toBeNull();
    expect(s.head("task_b")?.head).toBe(1);
  });

  it("copies the producer's fields without mutating the caller's array", () => {
    const s = store();
    const input = event({ tool: "Bash", input: { command: "ls" }, tool_call_id: "tc_1", status: "in_progress" });
    const stored = s.append("task_a", [input]).events[0]!;
    expect(stored).toMatchObject({
      seq: 1,
      type: "text",
      tool: "Bash",
      input: { command: "ls" },
      tool_call_id: "tc_1",
      status: "in_progress",
    });
    expect(input).not.toHaveProperty("seq");
    expect(input).not.toHaveProperty("ts");
  });

  it("sanitizes on append, so the file and the frame carry identical bounded events", () => {
    const s = store();
    const stored = s.append("task_a", [event({ content: "C".repeat(300 * 1024) })]).events[0]!;
    expect(stored.content!.endsWith(TRACE_TRUNCATION_MARKER)).toBe(true);
    expect(stored.content!.length).toBeLessThan(300 * 1024);
  });

  it("drops an unsupported status and keeps the raw type on append", () => {
    const s = store();
    const [cancelled] = s.append("task_a", [event({ type: "assistant", status: "cancelled" })]).events;
    expect(cancelled!.type).toBe("assistant");
    expect(cancelled!.status).toBeNull();
  });
});
