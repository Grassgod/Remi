import { describe, expect, it } from "bun:test";
import {
  InMemoryTraceStore,
  splitTraceSnapshot,
  TRACE_READ_DEFAULT_LIMIT,
  traceEventBytes,
} from "@multiremi/worker/trace-store.js";
import type { TraceEventInput } from "@multiremi/contracts/trace.js";
import { isTraceFileSnapshotLine } from "@multiremi/contracts/trace-file.js";
import { contractMessage, contractSnapshot, describeTraceStoreContract } from "./trace-store-contract.js";

/** A fixed clock so the `ts` the store assigns is assertable. */
const NOW = "2026-09-27T00:00:00.000Z";

function store(): InMemoryTraceStore {
  return new InMemoryTraceStore(() => NOW);
}

function event(text = "hello", id = `msg:${text}`): TraceEventInput {
  return { type: "item.completed", item: contractMessage(id, text) };
}

// Shared cases own cursor/head, limit caps, terminal appends, snapshots and caps.
describeTraceStoreContract("InMemoryTraceStore", () => store(), () => {
  const sparse = store();
  const events = sparse.append("tsk_one", [event("a"), event("b"), event("c")]).events;
  const state = (sparse as unknown as { tasks: Map<string, { events: typeof events; head: number }> }).tasks.get("tsk_one")!;
  state.events = events.map((row, index) => ({ ...row, seq: [1, 10, 20][index]! }));
  state.head = 20;
  return sparse;
});

describe("InMemoryTraceStore", () => {
  it("assigns dense per-task sequences starting at 1 and stamps ts", () => {
    const s = store();
    const first = s.append("task_a", [event("a"), event("b")]);
    expect(first.head).toBe(2);
    expect(first.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(first.events.every((e) => e.ts === NOW)).toBe(true);
    expect(s.head("task_a")).toEqual({ head: 2, closed: false });

    const second = s.append("task_a", [{ type: "turn.updated", patch: { model: "m" } }]);
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
    expect(s.format("nope")).toBeNull();
    expect(s.read("nope")).toEqual({ events: [], head: 0, eof: true });
  });

  it("reads strictly after the cursor and pages without overlap or holes", () => {
    const s = store();
    s.append("task_a", Array.from({ length: 7 }, (_, index) => event(`chunk-${index}`)));

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
    // `closed` lives on `head()` so there is exactly one place to ask.
    const s = store();
    s.append("task_a", [event()]);
    s.close("task_a", { status: "completed", ended_at: NOW });
    expect(Object.keys(s.read("task_a")).sort()).toEqual(["eof", "events", "head"]);
    expect(s.head("task_a")).toEqual({ head: 1, closed: true });
  });

  it("stops a page at maxBytes but still returns one oversized event", () => {
    const s = store();
    const stored = s.append("task_a", [event("x".repeat(64)), event("x".repeat(64)), event("x".repeat(64))]).events;
    // Budget from the events the store actually holds: it stamps `ts` and applies caps.
    const roomForTwo = traceEventBytes(stored[0]!) + traceEventBytes(stored[1]!);
    expect(s.read("task_a", 0, TRACE_READ_DEFAULT_LIMIT, roomForTwo).events.map((e) => e.seq)).toEqual([1, 2]);

    const s2 = store();
    s2.append("task_b", [event("y".repeat(4096))]);
    const page = s2.read("task_b", 0, TRACE_READ_DEFAULT_LIMIT, 8);
    expect(page.events.map((e) => e.seq)).toEqual([1]);
    expect(page.eof).toBe(true);
  });

  it("keeps the first close status, and closing an unseen task still marks it closed", () => {
    const s = store();
    s.append("task_a", [event()]);
    s.close("task_a", { status: "completed", ended_at: NOW, snapshot: contractSnapshot([contractMessage("m", "x")], 1) });
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

  it("copies the producer's body without mutating the caller's array", () => {
    const s = store();
    const input = event("body");
    const stored = s.append("task_a", [input]).events[0]!;
    expect(stored).toMatchObject({ seq: 1, ts: NOW, type: "item.completed", item: { id: "msg:body", text: "body" } });
    expect(input).not.toHaveProperty("seq");
    expect(input).not.toHaveProperty("ts");
  });
});

describe("splitTraceSnapshot", () => {
  it("keeps every part a valid framing line under the budget and in fold order", () => {
    const items = Array.from({ length: 12 }, (_, index) => contractMessage(`m${index}`, "z".repeat(1000)));
    const parts = splitTraceSnapshot(contractSnapshot(items, 12), 4000);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.flatMap((part) => part.items.map((item) => item.id))).toEqual(items.map((item) => item.id));
    parts.forEach((part, index) => {
      expect(part).toMatchObject({ part: index, parts: parts.length, head: 12 });
      expect(isTraceFileSnapshotLine({ snapshot: part })).toBe(true);
      expect(Buffer.byteLength(JSON.stringify({ snapshot: part }), "utf8")).toBeLessThanOrEqual(4000);
    });
  });

  it("gives an item too large for any part a part of its own", () => {
    const items = [contractMessage("small", "a"), contractMessage("huge", "b".repeat(9000)), contractMessage("tail", "c")];
    const parts = splitTraceSnapshot(contractSnapshot(items, 3), 4000);
    expect(parts.map((part) => part.items.map((item) => item.id))).toEqual([["small"], ["huge"], ["tail"]]);
  });

  it("writes one empty part for a turn without items", () => {
    expect(splitTraceSnapshot(contractSnapshot([], 0))).toEqual([expect.objectContaining({ part: 0, parts: 1, items: [] })]);
  });
});
