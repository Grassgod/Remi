import { afterEach, describe, expect, it } from "bun:test";
import { InMemoryDaemonTraceReader, type DaemonTraceReader } from "@multiremi/api/trace/daemon-trace-reader.js";
import { InMemoryTraceStore } from "@multiremi/worker/trace-store.js";
import { TraceReader, TRACE_READ_MAX_BYTES } from "@multiremi/trace/trace-reader.js";
import type { TraceEvent, TraceItem } from "@multiremi/contracts/trace.js";
import { isTraceFileEvent, type MultiremiTaskTrace } from "@multiremi/contracts/trace-file.js";
import { legacyTraceFile, traceWriter } from "../../helpers/turn-trace.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

import {
  bulkItem, commandItem, messageEvent, oversizedTraceCases, TRACE_BUDGET_FIXTURE_TS, TRACE_STORED_EVENT_MAX_BYTES,
  turnStartedEvent, storedEventBytes,
} from "./trace-budget-fixtures.js";

afterEach(() => {
  resetMultiremiTestEnv();
});

function pointer(location: MultiremiTaskTrace["location"]): MultiremiTaskTrace {
  return {
    taskId: "tsk_trace", location, runtimeId: "rt_trace",
    eventCount: null, headSeq: null, closed: null, updatedAt: "2026-09-28T00:00:00Z",
  };
}

function readerOver(trace: InMemoryTraceStore | ReturnType<typeof legacyTraceFile>["store"]) {
  return new TraceReader({ store: createStore(), daemon: new InMemoryDaemonTraceReader(() => trace), getPointer: () => pointer("daemon") });
}

describe("TraceReader view=events oversized first event", () => {
  for (const { name, input } of oversizedTraceCases) {
    it(`returns ${name} byte-for-byte alone and pages through last`, async () => {
      const trace = new InMemoryTraceStore(() => TRACE_BUDGET_FIXTURE_TS);
      const original = trace.append("tsk_trace", [input, messageEvent("msg:last", "last")]).events;
      const eventBytes = storedEventBytes(original[0]!);
      expect(eventBytes).toBeGreaterThan(TRACE_READ_MAX_BYTES);
      expect(eventBytes).toBeLessThanOrEqual(TRACE_STORED_EVENT_MAX_BYTES);
      expect(isTraceFileEvent(original[0])).toBe(true);
      expect(original[0]!.ts).toBe(TRACE_BUDGET_FIXTURE_TS);
      const reader = readerOver(trace);
      const page = await reader.readEvents("tsk_trace");
      expect(page).toMatchObject({ view: "events", format: "v2", state: "ok", source: "daemon", head: 2,
        next_after_seq: original[0]!.seq, eof: false });
      expect(page.events).toHaveLength(1);
      expect(JSON.stringify(page.events[0])).toBe(JSON.stringify(original[0]));
      const last = await reader.readEvents("tsk_trace", page.next_after_seq);
      expect(last).toMatchObject({ state: "ok", next_after_seq: original[1]!.seq, head: 2, eof: true });
      expect(JSON.stringify(last.events)).toBe(JSON.stringify([original[1]]));
      console.log(`PR2 trace ${name}: event=${eventBytes}, events=${Buffer.byteLength(JSON.stringify(page.events))}, reply=${Buffer.byteLength(JSON.stringify(page))}`);
    });
  }

  it("returns normal, oversized, normal events on exact successive pages", async () => {
    const trace = new InMemoryTraceStore(() => TRACE_BUDGET_FIXTURE_TS);
    const original = trace.append("tsk_trace", [
      messageEvent("msg:first", "first"), oversizedTraceCases[0]!.input, messageEvent("msg:last", "last"),
    ]).events;
    const reader = readerOver(trace);
    let afterSeq = 0;
    for (const event of original) {
      const page = await reader.readEvents("tsk_trace", afterSeq);
      expect(page).toMatchObject({ state: "ok", source: "daemon", head: 3, next_after_seq: event.seq, eof: event.seq === 3 });
      expect(JSON.stringify(page.events)).toBe(JSON.stringify([event]));
      if (event.seq !== 2) {
        expect(Buffer.byteLength(JSON.stringify(page.events))).toBeLessThanOrEqual(TRACE_READ_MAX_BYTES);
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(TRACE_READ_MAX_BYTES + 512);
      }
      afterSeq = page.next_after_seq;
    }
  });

  it("keeps two 600KiB events on separate bounded pages", async () => {
    const trace = new InMemoryTraceStore(() => TRACE_BUDGET_FIXTURE_TS);
    const original = trace.append("tsk_trace", [0, 1].map((i) =>
      ({ type: "item.completed" as const, item: bulkItem(`cmd_${i}`, "a".repeat(600_000)) }))).events;
    expect(storedEventBytes(original[0]!)).toBeGreaterThan(600_000);
    const reader = readerOver(trace);
    for (const afterSeq of [0, 1]) {
      const page = await reader.readEvents("tsk_trace", afterSeq);
      expect(page.events).toEqual([original[afterSeq]!]);
      expect(Buffer.byteLength(JSON.stringify(page.events))).toBeLessThanOrEqual(TRACE_READ_MAX_BYTES);
      expect(page).toMatchObject({ state: "ok", head: 2, next_after_seq: afterSeq + 1, eof: afterSeq === 1 });
    }
  });

  it("accepts a one-byte budget and rejects non-positive or non-integer budgets", async () => {
    const trace = new InMemoryTraceStore(() => TRACE_BUDGET_FIXTURE_TS);
    const original = trace.append("tsk_trace", [messageEvent("msg:only", "完整😀")]).events;
    const reader = readerOver(trace);
    expect(await reader.readEvents("tsk_trace", 0, 200, 1)).toMatchObject({ state: "ok", events: original, next_after_seq: 1, eof: true });
    expect(await reader.readTurn("tsk_trace", 0, 200, 1)).toMatchObject({ state: "ok", items: [{ id: "msg:only" }], next_item_cursor: null });
    for (const bytes of [0, -1, 1.5]) {
      await expect(reader.readEvents("tsk_trace", 0, 200, bytes)).rejects.toBeInstanceOf(RangeError);
      await expect(reader.readTurn("tsk_trace", 0, 200, bytes)).rejects.toBeInstanceOf(RangeError);
    }
    await expect(reader.readTurn("tsk_trace", -1)).rejects.toBeInstanceOf(RangeError);
  });
});

describe("TraceReader view=turn", () => {
  it("pages a running trace from the daemon's fold, with live statistics", async () => {
    const writer = traceWriter(new InMemoryTraceStore(() => TRACE_BUDGET_FIXTURE_TS), { now: () => TRACE_BUDGET_FIXTURE_TS });
    try {
      writer.append("tsk_trace", [
        turnStartedEvent("tsk_trace"),
        { type: "item.completed", item: commandItem("cmd_1", "ls") },
        messageEvent("msg:1", "working"),
        { type: "item.started", item: { ...commandItem("cmd_2", "cat a"), status: "in_progress", completed_at: null } },
      ]);
      const reader = readerOver(writer.store as InMemoryTraceStore);
      const first = await reader.readTurn("tsk_trace", 0, 2);
      expect(first).toMatchObject({ view: "turn", format: "v2", state: "ok", source: "daemon", head: 4, closed: false,
        next_item_cursor: 2, turn: { id: "tsk_trace", status: "running" } });
      expect(first.items.map((item) => [item.id, item.seq])).toEqual([["cmd_1", 2], ["msg:1", 3]]);
      // The page's turn counts the whole fold, not just this page.
      expect(first.turn!.stats).toMatchObject({ item_count: 3, tool_call_count: 2, process_item_count: 3 });
      const rest = await reader.readTurn("tsk_trace", first.next_item_cursor!);
      expect(rest).toMatchObject({ next_item_cursor: null, items: [{ id: "cmd_2", status: "in_progress" }] });
    } finally { await writer.stop(); }
  });

  it("returns an oversized first item alone and keeps the cursor", async () => {
    const writer = traceWriter(new InMemoryTraceStore(() => TRACE_BUDGET_FIXTURE_TS));
    try {
      writer.append("tsk_trace", [turnStartedEvent("tsk_trace"), oversizedTraceCases[0]!.input, messageEvent("msg:last", "last")]);
      const reader = readerOver(writer.store as InMemoryTraceStore);
      const page = await reader.readTurn("tsk_trace");
      expect(page.items.map((item) => item.id)).toEqual(["agent_ceiling"]);
      // At the event ceiling, the item leaves no room for the next one in a 1 MiB page.
      expect(Buffer.byteLength(JSON.stringify(page.items[0]))).toBeGreaterThan(TRACE_READ_MAX_BYTES - 64);
      expect(page.next_item_cursor).toBe(1);
      // A budget smaller than the first item still returns it, alone.
      expect(await reader.readTurn("tsk_trace", 0, 200, 1000)).toMatchObject({ items: [{ id: "agent_ceiling" }], next_item_cursor: 1 });
      const last = await reader.readTurn("tsk_trace", 1);
      expect(last).toMatchObject({ items: [{ id: "msg:last", text: "last" }], next_item_cursor: null, head: 3 });
    } finally { await writer.stop(); }
  });

  it("pages a closed trace from its persisted snapshot across parts", async () => {
    const writer = traceWriter(new InMemoryTraceStore(() => TRACE_BUDGET_FIXTURE_TS), { now: () => TRACE_BUDGET_FIXTURE_TS });
    try {
      writer.append("tsk_trace", [
        turnStartedEvent("tsk_trace"),
        { type: "item.completed", item: bulkItem("cmd_1", "a".repeat(500_000)) },
        { type: "item.completed", item: bulkItem("cmd_2", "b".repeat(500_000)) },
        messageEvent("msg:final", "done"),
      ]);
      writer.close("tsk_trace", "completed");
      // Two 500 KB items cannot share a 768 KiB snapshot part.
      expect(writer.store.snapshotPart("tsk_trace", 0)?.parts).toBeGreaterThan(1);
      const reader = readerOver(writer.store as InMemoryTraceStore);
      const items: TraceItem[] = [];
      let cursor: number | null = 0;
      for (let pages = 0; cursor !== null && pages < 10; pages++) {
        const page = await reader.readTurn("tsk_trace", cursor, 200, 600_000);
        expect(page).toMatchObject({ view: "turn", format: "v2", state: "ok", closed: true, head: 5,
          turn: { status: "completed", completed_at: TRACE_BUDGET_FIXTURE_TS } });
        items.push(...page.items);
        cursor = page.next_item_cursor;
      }
      expect(items.map((item) => item.id)).toEqual(["cmd_1", "cmd_2", "msg:final"]);
      const whole = await reader.readTurn("tsk_trace");
      expect(whole.turn).toMatchObject({ final_item_id: null, stats: { item_count: 3, tool_call_count: 2 } });
    } finally { await writer.stop(); }
  });

  it("answers a v1 file as legacy with no turn and no items, and shows its raw lines as events", async () => {
    const lines = [
      { seq: 1, ts: "2026-09-28T00:00:00Z", type: "text", content: "old fragment" },
      // A v1 writer accepted long fractional seconds; raw reads keep them verbatim.
      { seq: 2, ts: `2026-01-01T00:00:00.${"0".repeat(100)}Z`, type: "tool_use", tool: "Bash", tool_call_id: "call_1" },
    ];
    const legacy = legacyTraceFile("tsk_trace", lines, { closed: true });
    try {
      const reader = readerOver(legacy.store);
      expect(await reader.readTurn("tsk_trace")).toEqual({
        view: "turn", format: "legacy", turn: null, items: [], next_item_cursor: null, head: 2, closed: true,
        source: "daemon", state: "ok", runtime_id: "rt_trace", runtime_name: "rt_trace",
      });
      const raw = await reader.readEvents("tsk_trace");
      expect(raw).toMatchObject({ view: "events", format: "legacy", head: 2, eof: true, closed: true, next_after_seq: 2 });
      expect(raw.events.map((event) => JSON.stringify(event))).toEqual(legacy.lines.slice(1, 3));
    } finally { legacy.cleanup(); }
  });

  it("re-applies its own item budget when a daemon returns too much", async () => {
    const big = (id: string) => ({ ...commandItem(id, "x".repeat(400_000)), seq: 2 });
    const daemon: DaemonTraceReader = {
      read: async () => ({ ok: true, view: "turn", format: "v2", turn: null, items: [big("a"), big("b"), big("c")],
        next_item_cursor: null, head: 9, closed: false }),
    };
    const reader = new TraceReader({ store: createStore(), daemon, getPointer: () => pointer("daemon") });
    const page = await reader.readTurn("tsk_trace", 4);
    expect(page.items.map((item) => item.id)).toEqual(["a", "b"]);
    expect(page.next_item_cursor).toBe(6);
    const tight = await reader.readTurn("tsk_trace", 4, 1);
    expect(tight).toMatchObject({ items: [{ id: "a" }], next_item_cursor: 5 });
  });

  it("treats a reply for the other view as an unreadable daemon", async () => {
    const daemon: DaemonTraceReader = {
      read: async () => ({ ok: true, view: "events", format: "v2", events: [], next_after_seq: 0, head: 0, eof: true, closed: false }),
    };
    const reader = new TraceReader({ store: createStore(), daemon, getPointer: () => pointer("daemon") });
    expect(await reader.readTurn("tsk_trace")).toMatchObject({ state: "unreachable", reason: "daemon_read_failed", retryable: true,
      view: "turn", turn: null, items: [] });
  });
});

describe("TraceReader states and hot routing", () => {
  it("enforces its own JSON byte budget and sparse cursor without source truncation", async () => {
    const delta = "中文😀\u0001".repeat(35_000);
    const events: TraceEvent[] = [1, 7, 21].map((seq) => ({ seq, ts: "2026-09-28T00:00:00Z", type: "item.delta", item_id: "msg", field: "text", delta }));
    const daemon: DaemonTraceReader = {
      read: async (request) => {
        const after = request.view === "events" ? request.afterSeq ?? 0 : 0;
        const remaining = events.filter((event) => event.seq > after).slice(0, request.limit);
        return { ok: true, view: "events", format: "v2", events: remaining, next_after_seq: remaining.at(-1)?.seq ?? after, head: 21, eof: true, closed: true };
      },
    };
    const reader = new TraceReader({ store: createStore(), daemon, getPointer: () => pointer("daemon") });
    const seen: number[] = [];
    let afterSeq = 0;
    for (const seq of [1, 7, 21]) {
      const page = await reader.readEvents("tsk_trace", afterSeq);
      expect(Buffer.byteLength(JSON.stringify(page.events))).toBeLessThanOrEqual(TRACE_READ_MAX_BYTES);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(TRACE_READ_MAX_BYTES + 512);
      expect(page).toMatchObject({ state: "ok", head: 21, next_after_seq: seq, eof: seq === 21 });
      expect(page.events).toEqual([events.find((event) => event.seq === seq)!]);
      expect(page.next_after_seq).toBe(page.events.at(-1)!.seq);
      expect(page.next_after_seq).toBeGreaterThan(afterSeq);
      seen.push(...page.events.map((event) => event.seq));
      afterSeq = page.next_after_seq;
    }
    expect(seen).toEqual([1, 7, 21]);
  });

  it("writes a daemon pointer on claim, none for an empty terminal trace, and lost for abandon", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({ id: "rt_pointer", name: "Pointer runtime", provider: "codex", workspaceId: "local" });
    const agent = store.createAgent({ name: "Pointer agent", provider: "codex", workspaceId: "local", runtimeId: runtime.id });
    const emptyTask = store.createTask({ agentId: agent.id, workspaceId: "local", prompt: "empty" });
    expect(store.claimTask(runtime.id)?.id).toBe(emptyTask.id);
    expect(store.getTaskTrace(emptyTask.id)).toMatchObject({ location: "daemon", runtimeId: runtime.id });
    store.startTask(emptyTask.id);
    store.completeTask(emptyTask.id, { output: "done", traceEventCount: 0 });
    expect(store.getTaskTrace(emptyTask.id)).toMatchObject({ location: "none", runtimeId: null });

    const abandoned = store.createTask({ agentId: agent.id, workspaceId: "local", prompt: "abandon" });
    expect(store.claimTask(runtime.id)?.id).toBe(abandoned.id);
    store.markTaskTraceLost(abandoned.id);
    // The lost row keeps its runtime: usage accounting still attributes the task to it.
    expect(store.getTaskTrace(abandoned.id)).toMatchObject({ location: "lost", runtimeId: runtime.id });
  });

  it("loses every daemon pointer of a deleted Runtime and nothing else", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const gone = store.registerRuntime({ id: "rt_gone", name: "Gone", provider: "codex", workspaceId: "local", daemonId: "dmn_gone", maxConcurrency: 4 });
    const kept = store.registerRuntime({ id: "rt_kept", name: "Kept", provider: "codex", workspaceId: "local", daemonId: "dmn_kept", maxConcurrency: 4 });
    const claim = (runtimeId: string, prompt: string) => {
      const agent = store.createAgent({ name: `Agent ${prompt}`, provider: "codex", workspaceId: "local", runtimeId });
      const task = store.createTask({ agentId: agent.id, workspaceId: "local", prompt });
      expect(store.claimTask(runtimeId)?.id).toBe(task.id);
      return task.id;
    };
    const lostTask = claim(gone.id, "gone");
    const keptTask = claim(kept.id, "kept");
    const emptyTask = claim(gone.id, "empty");
    store.markTaskTraceNone(emptyTask);
    expect(store.markTaskTracesLostForRuntimes([])).toBe(0);
    expect(store.markTaskTracesLostForRuntimes([gone.id])).toBe(1);
    expect(store.getTaskTrace(lostTask)).toMatchObject({ location: "lost", runtimeId: gone.id });
    expect(store.getTaskTrace(keptTask)).toMatchObject({ location: "daemon", runtimeId: kept.id });
    expect(store.getTaskTrace(emptyTask)?.location).toBe("none");
    expect(store.markTaskTracesLostForRuntimes([gone.id])).toBe(0);
  });

  it("reads hot events through the A-0 in-memory daemon reader", async () => {
    const trace = new InMemoryTraceStore(() => "2026-09-28T00:00:00Z");
    trace.append("tsk_trace", [messageEvent("msg:1", "first"), messageEvent("msg:2", "second")]);
    const reader = readerOver(trace);
    expect(await reader.readEvents("tsk_trace", 0, 1)).toMatchObject({
      state: "ok", source: "daemon", head: 2, eof: false, next_after_seq: 1,
    });
    const tail = await reader.readEvents("tsk_trace", 1);
    expect(tail).toMatchObject({ state: "ok", eof: true, next_after_seq: 2 });
    expect(tail.events.map((event) => (event.item as { text: string }).text)).toEqual(["second"]);
  });

  it("maps unreachable, timeout and busy to retryable unreachable on both views", async () => {
    const store = createStore();
    for (const code of ["daemon_unreachable", "daemon_timeout", "daemon_busy"] as const) {
      const daemon: DaemonTraceReader = { read: async () => ({ ok: false, code }) };
      const reader = new TraceReader({ store, daemon, getPointer: () => pointer("daemon") });
      expect(await reader.readTurn("tsk_trace")).toMatchObject({ state: "unreachable", source: "daemon", reason: code, retryable: true,
        view: "turn", format: "v2", turn: null, items: [], next_item_cursor: null, head: 0, closed: false });
      expect(await reader.readEvents("tsk_trace", 3)).toMatchObject({ state: "unreachable", source: "daemon", reason: code, retryable: true,
        view: "events", events: [], next_after_seq: 3, eof: true });
    }
  });

  it("maps a daemon that no longer has the trace to not_found", async () => {
    const reader = readerOver(new InMemoryTraceStore());
    expect(await reader.readTurn("tsk_trace")).toMatchObject({ state: "not_found", source: "daemon", reason: "trace_not_hot" });
    expect(await reader.readEvents("tsk_trace")).toMatchObject({ state: "not_found", source: "daemon", reason: "trace_not_hot" });
  });

  it("exposes lost, no-events and missing-pointer states with an empty page", async () => {
    const store = createStore();
    const daemon = new InMemoryDaemonTraceReader(() => null);
    for (const [location, state] of [["lost", "lost"], ["none", "not_found"]] as const) {
      const reader = new TraceReader({ store, daemon, getPointer: () => pointer(location) });
      expect(await reader.readTurn("tsk_trace")).toMatchObject({ state, turn: null, items: [] });
      expect((await reader.readEvents("tsk_trace")).state).toBe(state);
    }
    const missing = new TraceReader({ store, daemon, getPointer: () => null });
    expect((await missing.readTurn("tsk_trace")).state).toBe("not_found");
  });

  it("keeps the runtime name on a running task with no pointer", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({ id: "rt_missing_pointer", name: "Desktop daemon", provider: "codex", workspaceId: "local" });
    const agent = store.createAgent({ name: "Pointer gap", provider: "codex", workspaceId: "local", runtimeId: runtime.id });
    const task = store.createTask({ agentId: agent.id, workspaceId: "local", prompt: "running" });
    store.claimTask(runtime.id);
    const reader = new TraceReader({ store, daemon: new InMemoryDaemonTraceReader(() => null), getPointer: () => null });
    expect(await reader.readTurn(task.id)).toMatchObject({
      state: "unreachable", reason: "pointer_missing", runtime_id: runtime.id, runtime_name: "Desktop daemon",
    });
  });

  it("limits pages by JSON bytes without advancing past an unseen event", async () => {
    const trace = new InMemoryTraceStore(() => "2026-09-28T00:00:00Z");
    trace.append("tsk_trace", [messageEvent("msg:a", "a".repeat(100)), messageEvent("msg:b", "b".repeat(100))]);
    const reader = readerOver(trace);
    const page = await reader.readEvents("tsk_trace", 0, 200, 400);
    expect(page.events).toHaveLength(1);
    expect(page).toMatchObject({ next_after_seq: 1, eof: false });
    expect(Buffer.byteLength(JSON.stringify(page.events))).toBeLessThanOrEqual(402);
  });
});
