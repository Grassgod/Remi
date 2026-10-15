import { describe, expect, it } from "bun:test";
import { InMemoryDaemonTraceReader } from "@multiremi/api/trace/daemon-trace-reader.js";
import { InMemoryTraceStore, type TraceStore } from "@multiremi/worker/trace-store.js";
import type { TraceEventInput, TraceTurn } from "@multiremi/contracts/trace.js";
import { legacyTraceFile, traceWriter } from "../../helpers/turn-trace.js";

const NOW = "2026-09-27T00:00:00.000Z";

function message(id: string, text = "x"): TraceEventInput {
  return { type: "item.completed", item: { id, parent_id: null, type: "agent_message", status: "completed", phase: "unknown",
    text, started_at: NOW, completed_at: NOW } };
}

function turn(id: string): TraceTurn {
  return { id, turn_id: "turn_a", agent_id: "agt", agent_name: null, provider: "codex", requested_model: null, model: null,
    status: "running", error: null, started_at: NOW, completed_at: null, duration_ms: null, final_item_id: null,
    final_started_at: null, context_usage: null, stats: { item_count: 0, tool_call_count: 0, process_item_count: 0, type_histogram: [] } };
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
    for (const view of ["turn", "events"] as const) {
      expect(await reader.read({ taskId: "task_a", runtimeId: "rt_missing", view })).toEqual({
        ok: false,
        code: "daemon_unreachable",
        runtime_id: "rt_missing",
        last_seen_at: undefined,
      });
    }
  });

  it("fills last_seen_at when it is known", async () => {
    const reader = new InMemoryDaemonTraceReader(() => null, () => NOW);
    const result = await reader.read({ taskId: "task_a", runtimeId: "rt_a", view: "turn" });
    expect(result).toMatchObject({ ok: false, code: "daemon_unreachable", last_seen_at: NOW });
  });

  it("returns trace_not_hot when the runtime never saw the task", async () => {
    const stores = new Map<string, TraceStore>([["rt_a", new InMemoryTraceStore(() => NOW)]]);
    const reader = ws("rt_a", stores);
    for (const view of ["turn", "events"] as const) {
      expect(await reader.read({ taskId: "task_unknown", runtimeId: "rt_a", view })).toEqual({ ok: false, code: "trace_not_hot", runtime_id: "rt_a" });
    }
  });

  it("reads an events page and reports head, eof and closed", async () => {
    const store = new InMemoryTraceStore(() => NOW);
    store.append("task_a", [message("m1"), message("m2"), message("m3")]);
    const reader = ws("rt_a", new Map([["rt_a", store]]));

    const first = await reader.read({ taskId: "task_a", runtimeId: "rt_a", view: "events", limit: 2 });
    expect(first).toMatchObject({ ok: true, view: "events", format: "v2", head: 3, eof: false, closed: false, next_after_seq: 2 });
    expect(first.ok && first.view === "events" && first.events.map((e) => e.seq)).toEqual([1, 2]);

    const second = await reader.read({ taskId: "task_a", runtimeId: "rt_a", view: "events", afterSeq: 2, limit: 2 });
    expect(second).toMatchObject({ ok: true, head: 3, eof: true, next_after_seq: 3 });
  });

  it("pages the running fold by item cursor, with the fold's live statistics", async () => {
    const store = new InMemoryTraceStore(() => NOW);
    store.append("task_a", [{ type: "turn.started", turn: turn("task_a") }, message("m1"), message("m2"), message("m3")]);
    const reader = ws("rt_a", new Map([["rt_a", store]]));
    const first = await reader.read({ taskId: "task_a", runtimeId: "rt_a", view: "turn", limit: 2 });
    expect(first).toMatchObject({ ok: true, view: "turn", format: "v2", head: 4, closed: false, next_item_cursor: 2,
      turn: { id: "task_a", stats: { item_count: 3, process_item_count: 3 } } });
    expect(first.ok && first.view === "turn" && first.items.map((item) => [item.id, item.seq])).toEqual([["m1", 2], ["m2", 3]]);
    const rest = await reader.read({ taskId: "task_a", runtimeId: "rt_a", view: "turn", itemCursor: 2 });
    expect(rest).toMatchObject({ ok: true, next_item_cursor: null, items: [{ id: "m3" }] });
    // A line the fold skips (a newer producer's type) still counts toward the page head.
    store.append("task_a", [{ type: "item.future", blob: "x" } as unknown as TraceEventInput]);
    expect(await reader.read({ taskId: "task_a", runtimeId: "rt_a", view: "turn" })).toMatchObject({ ok: true, head: 5, items: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] });
  });

  it("still serves a closed trace from its snapshot, and says so", async () => {
    const writer = traceWriter(new InMemoryTraceStore(() => NOW), { runtimeId: "rt_a", now: () => NOW });
    try {
      writer.append("task_a", [{ type: "turn.started", turn: turn("task_a") }, message("m1", "answer")]);
      writer.close("task_a", "completed");
      const reader = ws("rt_a", new Map([["rt_a", writer.store]]));
      // Closed is not "not hot": the file is still there and still readable.
      expect(await reader.read({ taskId: "task_a", runtimeId: "rt_a", view: "events" }))
        .toMatchObject({ ok: true, head: 3, eof: true, closed: true });
      expect(await reader.read({ taskId: "task_a", runtimeId: "rt_a", view: "turn" })).toMatchObject({
        ok: true, view: "turn", format: "v2", closed: true, head: 3, next_item_cursor: null,
        turn: { status: "completed", completed_at: NOW }, items: [{ id: "m1", text: "answer" }],
      });
    } finally { await writer.stop(); }
  });

  it("answers a v1 file as legacy, with its raw lines on the events view", async () => {
    const legacy = legacyTraceFile("task_v1", [{ seq: 1, ts: NOW, type: "text", content: "old" }], { runtimeId: "rt_a" });
    try {
      const reader = ws("rt_a", new Map([["rt_a", legacy.store]]));
      expect(await reader.read({ taskId: "task_v1", runtimeId: "rt_a", view: "turn" })).toEqual({
        ok: true, view: "turn", format: "legacy", turn: null, items: [], next_item_cursor: null, head: 1, closed: false,
      });
      expect(await reader.read({ taskId: "task_v1", runtimeId: "rt_a", view: "events" })).toMatchObject({
        ok: true, view: "events", format: "legacy", events: [{ seq: 1, type: "text", content: "old" }],
      });
    } finally { legacy.cleanup(); }
  });

  it("reports next_after_seq as the cursor it was given when the page is empty", async () => {
    const store = new InMemoryTraceStore(() => NOW);
    store.append("task_a", [message("m1")]);
    const reader = ws("rt_a", new Map([["rt_a", store]]));
    const result = await reader.read({ taskId: "task_a", runtimeId: "rt_a", view: "events", afterSeq: 1 });
    expect(result).toMatchObject({ ok: true, next_after_seq: 1, events: [], eof: true });
  });

  it("clamps a limit above the maximum and respects a small maxBytes", async () => {
    const store = new InMemoryTraceStore(() => NOW);
    store.append("task_a", Array.from({ length: 600 }, (_, index) => message(`m${index}`)));
    const reader = ws("rt_a", new Map([["rt_a", store]]));

    for (const view of ["turn", "events"] as const) {
      const big = await reader.read({ taskId: "task_a", runtimeId: "rt_a", view, limit: 99_999 });
      expect(big.ok && (big.view === "turn" ? big.items : big.events)).toHaveLength(500);
      // One entry always comes through, even when it alone busts the budget.
      const tiny = await reader.read({ taskId: "task_a", runtimeId: "rt_a", view, maxBytes: 1 });
      expect(tiny.ok && (tiny.view === "turn" ? tiny.items : tiny.events)).toHaveLength(1);
    }
  });

  it("routes each runtime to its own store", async () => {
    const storeA = new InMemoryTraceStore(() => NOW);
    const storeB = new InMemoryTraceStore(() => NOW);
    storeA.append("task_a", [message("A")]);
    storeB.append("task_a", [message("B1"), message("B2")]);
    const reader = ws("rt_a", new Map([["rt_a", storeA], ["rt_b", storeB]]));

    const a = await reader.read({ taskId: "task_a", runtimeId: "rt_a", view: "events" });
    const b = await reader.read({ taskId: "task_a", runtimeId: "rt_b", view: "turn" });
    expect(a.ok && a.head).toBe(1);
    expect(b.ok && b.head).toBe(2);
  });
});
