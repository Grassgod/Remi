import { afterEach, describe, expect, it } from "bun:test";
import { InMemoryDaemonTraceReader, type DaemonTraceReader } from "@multiremi/api/trace/daemon-trace-reader.js";
import { InMemoryTraceStore, sanitizeStoredEvent } from "@multiremi/worker/trace-store.js";
import { TraceReader, TRACE_READ_MAX_BYTES } from "@multiremi/trace/trace-reader.js";
import type { TraceEvent } from "@multiremi/contracts/trace.js";
import { isTraceFileEvent, type MultiremiTaskTrace } from "@multiremi/contracts/trace-file.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

import { oversizedTraceCases, TRACE_BUDGET_FIXTURE_TS, TRACE_SANITIZED_EVENT_MAX_BYTES, traceFiniteEventBytes } from "./trace-budget-fixtures.js";

afterEach(() => {
  resetMultiremiTestEnv();
});

function pointer(location: MultiremiTaskTrace["location"]): MultiremiTaskTrace {
  return {
    taskId: "tsk_trace", location, runtimeId: "rt_trace",
    eventCount: null, headSeq: null, closed: null, updatedAt: "2026-09-28T00:00:00Z",
  };
}

describe("TraceReader oversized first event", () => {
  for (const { name, input } of oversizedTraceCases) {
    it(`returns ${name} byte-for-byte alone and pages through last`, async () => {
      const trace = new InMemoryTraceStore(() => TRACE_BUDGET_FIXTURE_TS);
      if (name === "contract-limit event" || input.type === "x") {
        expect(sanitizeStoredEvent(input, input.ts ?? TRACE_BUDGET_FIXTURE_TS)).toEqual({ ts: TRACE_BUDGET_FIXTURE_TS, ...input });
      }
      const original = trace.append("tsk_trace", [input, { type: "text", content: "last" }]).events;
      const eventBytes = Buffer.byteLength(JSON.stringify(original[0]));
      expect(eventBytes).toBeGreaterThan(TRACE_READ_MAX_BYTES);
      expect(isTraceFileEvent(original[0])).toBe(true);
      expect(original[0]!.ts).toBe(input.ts ?? TRACE_BUDGET_FIXTURE_TS);
      expect(traceFiniteEventBytes(original[0]!)).toBeLessThanOrEqual(TRACE_SANITIZED_EVENT_MAX_BYTES);
      const store = createStore();
      const reader = new TraceReader({
        store, daemon: new InMemoryDaemonTraceReader(() => trace), getPointer: () => pointer("daemon"),
      });
      const page = await reader.readTrace("tsk_trace");
      expect(page).toMatchObject({ state: "ok", source: "daemon", head: 2, next_after_seq: original[0]!.seq, eof: false });
      expect(page.events).toHaveLength(1);
      expect(JSON.stringify(page.events[0])).toBe(JSON.stringify(original[0]));
      const last = await reader.readTrace("tsk_trace", page.next_after_seq);
      expect(last).toMatchObject({ state: "ok", next_after_seq: original[1]!.seq, head: 2, eof: true });
      expect(JSON.stringify(last.events)).toBe(JSON.stringify([original[1]]));
      console.log(`B5 r9 ${name}: event=${eventBytes}, finite=${traceFiniteEventBytes(original[0]!)}, events=${Buffer.byteLength(JSON.stringify(page.events))}, reply=${Buffer.byteLength(JSON.stringify(page))}`);
    });
  }

  it("returns normal, oversized, normal events on exact successive pages", async () => {
    const trace = new InMemoryTraceStore(() => TRACE_BUDGET_FIXTURE_TS);
    const original = trace.append("tsk_trace", [
      { type: "text", content: "first" },
      { type: "text", content: "\u0001".repeat(180_000) },
      { type: "text", content: "last" },
    ]).events;
    const store = createStore();
    const reader = new TraceReader({
      store, daemon: new InMemoryDaemonTraceReader(() => trace), getPointer: () => pointer("daemon"),
    });
    let afterSeq = 0;
    for (const event of original) {
      const page = await reader.readTrace("tsk_trace", afterSeq);
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
    const original = trace.append("tsk_trace", [
      { type: "text", content: "\u0001".repeat(100_000) },
      { type: "text", content: "\u0001".repeat(100_000) },
    ]).events;
    expect(Buffer.byteLength(JSON.stringify(original[0]))).toBeGreaterThan(600_000);
    const store = createStore();
    const reader = new TraceReader({
      store, daemon: new InMemoryDaemonTraceReader(() => trace), getPointer: () => pointer("daemon"),
    });
    for (const afterSeq of [0, 1]) {
      const page = await reader.readTrace("tsk_trace", afterSeq);
      expect(page.events).toEqual([original[afterSeq]!]);
      expect(Buffer.byteLength(JSON.stringify(page.events))).toBeLessThanOrEqual(TRACE_READ_MAX_BYTES);
      expect(page).toMatchObject({ state: "ok", head: 2, next_after_seq: afterSeq + 1, eof: afterSeq === 1 });
    }
  });

  it("accepts a one-byte budget and rejects non-positive or non-integer budgets", async () => {
    const store = createStore();
    const trace = new InMemoryTraceStore(() => TRACE_BUDGET_FIXTURE_TS);
    const original = trace.append("tsk_trace", [{ type: "text", content: "完整😀" }]).events;
    const reader = new TraceReader({ store, daemon: new InMemoryDaemonTraceReader(() => trace),
      getPointer: () => pointer("daemon") });
    expect(await reader.readTrace("tsk_trace", 0, 200, 1)).toMatchObject({ state: "ok", events: original, next_after_seq: 1, eof: true });
    for (const bytes of [0, -1, 1.5]) {
      await expect(reader.readTrace("tsk_trace", 0, 200, bytes)).rejects.toBeInstanceOf(RangeError);
    }
  });
});

describe("TraceReader states and hot routing", () => {
  it("enforces its own JSON byte budget and sparse cursor without source truncation", async () => {
    const content = "中文😀\u0001".repeat(35_000);
    const events: TraceEvent[] = [1, 7, 21].map((seq) => ({ seq, ts: "2026-09-28T00:00:00Z", type: "text", content }));
    const daemon: DaemonTraceReader = {
      read: async (request) => {
        const remaining = events.filter((event) => event.seq > (request.afterSeq ?? 0)).slice(0, request.limit);
        return { ok: true, events: remaining, next_after_seq: remaining.at(-1)?.seq ?? request.afterSeq ?? 0, head: 21, eof: true, closed: true };
      },
    };
    const store = createStore();
    const reader = new TraceReader({ store, daemon, getPointer: () => pointer("daemon") });
    const seen: number[] = [];
    let afterSeq = 0;
    for (const seq of [1, 7, 21]) {
      const page = await reader.readTrace("tsk_trace", afterSeq);
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
    const store = createStore();
    const trace = new InMemoryTraceStore(() => "2026-09-28T00:00:00Z");
    trace.append("tsk_trace", [{ type: "text", content: "first" }, { type: "text", content: "second" }]);
    const reader = new TraceReader({
      store,
      daemon: new InMemoryDaemonTraceReader(() => trace),
      getPointer: () => pointer("daemon"),
    });
    expect(await reader.readTrace("tsk_trace", 0, 1)).toMatchObject({
      state: "ok", source: "daemon", head: 2, eof: false, next_after_seq: 1,
    });
    const tail = await reader.readTrace("tsk_trace", 1);
    expect(tail).toMatchObject({ state: "ok", eof: true, next_after_seq: 2 });
    expect(tail.events.map((event) => event.content)).toEqual(["second"]);
  });

  it("maps unreachable, timeout and busy to retryable unreachable", async () => {
    const store = createStore();
    const cases = ["daemon_unreachable", "daemon_timeout", "daemon_busy"] as const;
    for (const code of cases) {
      const daemon: DaemonTraceReader = { read: async () => ({ ok: false, code }) };
      const reader = new TraceReader({ store, daemon, getPointer: () => pointer("daemon") });
      expect(await reader.readTrace("tsk_trace")).toMatchObject({ state: "unreachable", source: "daemon", reason: code, retryable: true });
    }
  });

  it("maps a daemon that no longer has the trace to not_found", async () => {
    const store = createStore();
    const fake = new InMemoryDaemonTraceReader(() => new InMemoryTraceStore());
    const reader = new TraceReader({ store, daemon: fake, getPointer: () => pointer("daemon") });
    expect(await reader.readTrace("tsk_trace")).toMatchObject({ state: "not_found", source: "daemon", reason: "trace_not_hot" });
  });

  it("exposes lost, no-events and missing-pointer states", async () => {
    const store = createStore();
    const daemon = new InMemoryDaemonTraceReader(() => null);
    for (const [location, state] of [["lost", "lost"], ["none", "not_found"]] as const) {
      const reader = new TraceReader({ store, daemon, getPointer: () => pointer(location) });
      expect((await reader.readTrace("tsk_trace")).state).toBe(state);
    }
    const missing = new TraceReader({ store, daemon, getPointer: () => null });
    expect((await missing.readTrace("tsk_trace")).state).toBe("not_found");
  });

  it("keeps the runtime name on a running task with no pointer", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({ id: "rt_missing_pointer", name: "Desktop daemon", provider: "codex", workspaceId: "local" });
    const agent = store.createAgent({ name: "Pointer gap", provider: "codex", workspaceId: "local", runtimeId: runtime.id });
    const task = store.createTask({ agentId: agent.id, workspaceId: "local", prompt: "running" });
    store.claimTask(runtime.id);
    const reader = new TraceReader({ store, daemon: new InMemoryDaemonTraceReader(() => null),
      getPointer: () => null });
    expect(await reader.readTrace(task.id)).toMatchObject({
      state: "unreachable", reason: "pointer_missing", runtime_id: runtime.id, runtime_name: "Desktop daemon",
    });
  });

  it("limits pages by JSON bytes without advancing past an unseen event", async () => {
    const store = createStore();
    const trace = new InMemoryTraceStore(() => "2026-09-28T00:00:00Z");
    trace.append("tsk_trace", [{ type: "text", content: "a".repeat(100) }, { type: "text", content: "b".repeat(100) }]);
    const reader = new TraceReader({ store, daemon: new InMemoryDaemonTraceReader(() => trace), getPointer: () => pointer("daemon") });
    const page = await reader.readTrace("tsk_trace", 0, 200, 250);
    expect(page.events).toHaveLength(1);
    expect(page).toMatchObject({ next_after_seq: 1, eof: false });
    expect(Buffer.byteLength(JSON.stringify(page.events))).toBeLessThanOrEqual(252);
  });
});
