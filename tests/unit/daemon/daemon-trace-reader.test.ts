import { describe, expect, it } from "bun:test";
import { InMemoryDaemonTraceReader } from "@multiremi/api/trace/daemon-trace-reader.js";
import { InMemoryTraceStore, type TraceStore } from "@multiremi/worker/trace-store.js";
import type { TraceEventInput } from "@multiremi/contracts/trace.js";

const NOW = "2026-09-27T00:00:00.000Z";

function event(patch: Partial<TraceEventInput> = {}): TraceEventInput {
  return { type: "text", content: "x", ...patch };
}

function ws(runtimeId: string, stores: Map<string, TraceStore>): InMemoryDaemonTraceReader {
  return new InMemoryDaemonTraceReader(
    (id) => stores.get(id) ?? null,
    (id) => (id === runtimeId ? NOW : null),
  );
}

describe("InMemoryDaemonTraceReader", () => {
  it("returns daemon_unreachable for a runtime with no live connection", async () => {
    const reader = ws("rt_a", new Map());
    const result = await reader.read({ taskId: "task_a", runtimeId: "rt_missing" });
    expect(result).toEqual({
      ok: false,
      code: "daemon_unreachable",
      runtime_id: "rt_missing",
      last_seen_at: undefined,
    });
  });

  it("fills last_seen_at when it is known", async () => {
    const reader = new InMemoryDaemonTraceReader(() => null, () => NOW);
    const result = await reader.read({ taskId: "task_a", runtimeId: "rt_a" });
    expect(result).toMatchObject({ ok: false, code: "daemon_unreachable", last_seen_at: NOW });
  });

  it("returns trace_not_hot when the runtime never saw the task", async () => {
    const stores = new Map<string, TraceStore>([["rt_a", new InMemoryTraceStore(() => NOW)]]);
    const reader = ws("rt_a", stores);
    const result = await reader.read({ taskId: "task_unknown", runtimeId: "rt_a" });
    expect(result).toEqual({ ok: false, code: "trace_not_hot", runtime_id: "rt_a" });
  });

  it("reads a page and reports head, eof and closed", async () => {
    const store = new InMemoryTraceStore(() => NOW);
    store.append("task_a", [event({ content: "1" }), event({ content: "2" }), event({ content: "3" })]);
    const reader = ws("rt_a", new Map([["rt_a", store]]));

    const first = await reader.read({ taskId: "task_a", runtimeId: "rt_a", limit: 2 });
    expect(first).toMatchObject({ ok: true, head: 3, eof: false, closed: false, next_after_seq: 2 });
    expect(first.ok && first.events.map((e) => e.seq)).toEqual([1, 2]);

    const second = await reader.read({ taskId: "task_a", runtimeId: "rt_a", afterSeq: 2, limit: 2 });
    expect(second).toMatchObject({ ok: true, head: 3, eof: true, next_after_seq: 3 });
  });

  it("still serves a closed trace, and says so", async () => {
    const store = new InMemoryTraceStore(() => NOW);
    store.append("task_a", [event()]);
    store.close("task_a", { status: "completed", ended_at: NOW });
    const reader = ws("rt_a", new Map([["rt_a", store]]));

    // Closed is not "not hot": the file is still there and still readable.
    const result = await reader.read({ taskId: "task_a", runtimeId: "rt_a" });
    expect(result).toMatchObject({ ok: true, head: 1, eof: true, closed: true });
  });

  it("reports next_after_seq as the cursor it was given when the page is empty", async () => {
    const store = new InMemoryTraceStore(() => NOW);
    store.append("task_a", [event()]);
    const reader = ws("rt_a", new Map([["rt_a", store]]));
    const result = await reader.read({ taskId: "task_a", runtimeId: "rt_a", afterSeq: 1 });
    expect(result).toMatchObject({ ok: true, next_after_seq: 1, events: [], eof: true });
  });

  it("clamps a limit above the maximum and respects a small maxBytes", async () => {
    const store = new InMemoryTraceStore(() => NOW);
    store.append("task_a", Array.from({ length: 600 }, (_, index) => event({ content: `${index}` })));
    const reader = ws("rt_a", new Map([["rt_a", store]]));

    const big = await reader.read({ taskId: "task_a", runtimeId: "rt_a", limit: 99_999 });
    expect(big.ok && big.events).toHaveLength(500);

    const tiny = await reader.read({ taskId: "task_a", runtimeId: "rt_a", maxBytes: 1 });
    // One event always comes through, even when it alone busts the budget.
    expect(tiny.ok && tiny.events).toHaveLength(1);
  });

  it("routes each runtime to its own store", async () => {
    const storeA = new InMemoryTraceStore(() => NOW);
    const storeB = new InMemoryTraceStore(() => NOW);
    storeA.append("task_a", [event({ content: "A" })]);
    storeB.append("task_a", [event({ content: "B1" }), event({ content: "B2" })]);
    const reader = ws("rt_a", new Map([["rt_a", storeA], ["rt_b", storeB]]));

    const a = await reader.read({ taskId: "task_a", runtimeId: "rt_a" });
    const b = await reader.read({ taskId: "task_a", runtimeId: "rt_b" });
    expect(a.ok && a.head).toBe(1);
    expect(b.ok && b.head).toBe(2);
  });
});
