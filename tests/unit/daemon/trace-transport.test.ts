import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceFileStore } from "@multiremi/worker/trace-file-store.js";
import { DaemonTraceTransport } from "@multiremi/worker/trace-transport.js";
import { InMemoryTraceStore } from "@multiremi/worker/trace-store.js";
import type { DaemonProtocolClient } from "@multiremi/worker/daemon-protocol-client.js";
import { parseDaemonProtocolFrame, type DaemonParsedFrame } from "@multiremi/api/daemon-protocol/frames.js";

function peer() {
  let handler!: (frame: DaemonParsedFrame) => void;
  const replies: Array<{ p: any }> = [];
  const client = { onWelcome: () => () => {}, onFrame: (listener: typeof handler) => { handler = listener; return () => {}; },
    connectionState: () => "disconnected", send: (frame: { p: any }) => replies.push(frame) };
  return { client: client as unknown as DaemonProtocolClient, replies,
    read: (rt: string, taskId: string) => {
      const parsed = parseDaemonProtocolFrame(JSON.stringify({ v: 2, t: "trace.read", id: "read", rt, p: { task_id: taskId } }));
      if (!parsed.ok) throw new Error(parsed.reason);
      handler(parsed.frame);
    } };
}

describe("daemon trace transport ownership and completion", () => {
  it("answers unavailable files immediately and leaves healthy traces readable", async () => {
    const root = mkdtempSync(join(tmpdir(), "trace-read-gc-"));
    const store = new TraceFileStore({ workspacesRoot: root, resolveTask: () => ({
      sessionId: "ises_read", agentId: "agent", provider: "codex", runtimeId: "rt", startedAt: "2026-09-28T12:00:00Z" }) });
    const p = peer(); const errors: unknown[] = [];
    const trace = new DaemonTraceTransport(p.client, store, undefined, error => errors.push(error));
    try {
      for (const id of ["gone", "corrupt", "healthy"]) trace.append(id, "rt", [{ type: "text", content: id }]);
      unlinkSync(join(root, ".runtime", "ises_read", "traces", "gone.jsonl"));
      writeFileSync(join(root, ".runtime", "ises_read", "traces", "corrupt.jsonl"), "broken\n");
      for (const id of ["gone", "corrupt"]) {
        expect(() => p.read("rt", id)).not.toThrow();
        expect(p.replies.at(-1)!.p).toEqual({ ok: false, code: "trace_not_hot", retryable: false });
      }
      p.read("rt", "healthy");
      expect(p.replies.at(-1)!.p).toMatchObject({ ok: true, events: [{ content: "healthy" }] });
      expect(errors).toHaveLength(2);
      trace.pruneMissing();
      expect(trace.ownership().has("gone")).toBe(false);
      expect(store.head("gone")).toBe(null);
      expect(trace.ownership().has("corrupt")).toBe(true);
      expect(trace.ownership().has("healthy")).toBe(true);
    } finally { await trace.stop(); rmSync(root, { recursive: true, force: true }); }
  });

  it("releases active tool identities on close and bounds completed summary caching", async () => {
    const trace = new DaemonTraceTransport(peer().client);
    for (let i = 0; i < 140; i++) {
      const id = `task_${i}`;
      trace.append(id, "rt", [{ type: "tool_use", tool: "Read", toolCallId: `tool_${i}` }]);
      trace.completion(id); trace.close(id, "completed");
    }
    const cache = trace as unknown as { summaries: Map<string, unknown>; completedSummaries: Map<string, unknown> };
    expect(cache.summaries.size).toBe(0);
    expect(cache.completedSummaries.size).toBe(128);
    expect(trace.completion("task_139").trace!.tool_call_count).toBe(1);
    expect(cache.summaries.size).toBe(0);
    await trace.stop();
    expect(cache.completedSummaries.size).toBe(0);
  });
  it("does not replay closed history on fresh transport boot", async () => {
    const root = mkdtempSync(join(tmpdir(), "trace-closed-restart-"));
    const make = () => new TraceFileStore({ workspacesRoot: root, resolveTask: () => ({ sessionId: "ises_history",
      agentId: "agent", provider: "codex", runtimeId: "rt", startedAt: "2026-09-28T12:00:00Z" }) });
    const store = make();
    for (let i = 0; i < 100; i++) {
      store.append(`task_${i}`, [{ type: "text", content: "history" }]);
      store.close(`task_${i}`, { status: "completed", ended_at: "2026-09-28T12:00:01Z" });
    }
    const p = peer(); let calls = 0;
    Object.assign(p.client, { connectionState: () => "connected", uplinkPaused: () => false,
      rpc: async () => { calls++; return { hub_head: 1 }; } });
    const recovered = new DaemonTraceTransport(p.client, make());
    try {
      await Bun.sleep(30);
      expect(calls).toBe(0);
      p.read("rt", "task_50");
      expect(p.replies.at(-1)!.p).toMatchObject({ ok: true, head: 1, closed: true });
      expect(recovered.ownership().size).toBe(100);
    } finally { await recovered.stop(); rmSync(root, { recursive: true, force: true }); }
  });

  it("updates completion incrementally and rebuilds a recovered summary only once", async () => {
    const p = peer(); const store = new InMemoryTraceStore();
    let reads = 0; const read = store.read.bind(store);
    store.read = (...args) => { reads++; return read(...args); };
    const trace = new DaemonTraceTransport(p.client, store);
    try {
      trace.append("task", "rt", [{ type: "text", content: "first" }]);
      const baseline = reads;
      for (let i = 0; i < 10; i++) trace.append("task", "rt", [{ type: "tool_use", tool: "Read", toolCallId: `tool_${i}` }]);
      expect(trace.completion("task").trace!.event_count).toBe(11);
      trace.completion("task");
      expect(reads).toBe(baseline);
    } finally { await trace.stop(); }
    const next = new DaemonTraceTransport(peer().client, store, undefined, undefined, new Map([["task", "rt"]]));
    try {
      next.completion("task"); const baseline = reads;
      next.completion("task");
      expect(reads).toBe(baseline);
    } finally { await next.stop(); }
  });
  it("recovers two runtime owners in a fresh file store and transport", async () => {
    const root = mkdtempSync(join(tmpdir(), "trace-transport-restart-"));
    const make = () => new TraceFileStore({ workspacesRoot: root, resolveTask: taskId => ({
      sessionId: "ises_shared", agentId: "agent", provider: "codex", runtimeId: taskId === "task_one" ? "rt_one" : "rt_two",
      startedAt: "2026-09-28T12:00:00Z" }) });
    const p = peer();
    const first = new DaemonTraceTransport(p.client, make());
    first.append("task_one", "rt_one", [{ type: "text", content: "first" }]);
    first.close("task_one", "completed");
    first.append("task_two", "rt_two", [{ type: "text", content: "second" }]);
    await first.stop();
    const next = peer();
    const recovered = new DaemonTraceTransport(next.client, make());
    try {
      next.read("rt_one", "task_one");
      expect(next.replies.at(-1)!.p).toMatchObject({ ok: true, head: 1, closed: true, events: [{ content: "first", seq: 1 }] });
      next.read("rt_two", "task_one");
      expect(next.replies.at(-1)!.p).toMatchObject({ ok: false, code: "trace_not_hot" });
      next.read("rt_two", "task_two");
      expect(next.replies.at(-1)!.p).toMatchObject({ ok: true, closed: false, events: [{ content: "second" }] });
      expect(recovered.append("task_two", "rt_two", [{ type: "text", content: "third" }])[0]!.seq).toBe(2);
      expect(() => recovered.track("task_two", "rt_one")).toThrow("ownership changed");
    } finally { await recovered.stop(); rmSync(root, { recursive: true, force: true }); }
  });
  it("assigns live timestamps and dense sequences at TraceStore, not at producers", async () => {
    const p = peer(); const store = new InMemoryTraceStore(() => "2026-09-28T12:00:00Z");
    const trace = new DaemonTraceTransport(p.client, store);
    try {
      const messages = trace.append("task", "rt", [{ seq: 99, type: "text", content: " answer ", meta: { phase: "final" } },
        { seq: 700, type: "tool_use", tool: "Read" }, { type: "execution", meta: { provider: "claude", model: "test-model" } }]);
      expect(messages.map(message => message.seq)).toEqual([1, 2, 3]);
      expect(store.read("task").events.map(event => event.ts)).toEqual(Array(3).fill("2026-09-28T12:00:00Z"));
      expect(trace.completion("task")).toMatchObject({ trace: { head: 3, event_count: 3, closed: true, tool_call_count: 1,
        type_histogram: expect.arrayContaining([{ type: "tool_use", tool: "Read", count: 1 }]) },
        final_reply_md: "answer", model: { provider: "claude", model: "test-model" } });
      trace.close("task", "completed");
      expect(trace.append("task", "rt", [{ type: "text", content: "late" }])).toEqual([]);
      expect(store.head("task")).toEqual({ head: 3, closed: true });
    } finally { await trace.stop(); }
  });

  it("reads an empty closed turn while rejecting another runtime and an archived turn", async () => {
    const p = peer(); const trace = new DaemonTraceTransport(p.client);
    try {
      trace.track("empty", "rt"); trace.close("empty", "failed");
      p.read("rt", "empty");
      expect(p.replies.at(-1)!.p).toEqual({ ok: true, events: [], next_after_seq: 0, head: 0, eof: true, closed: true });
      p.read("other", "empty");
      expect(p.replies.at(-1)!.p).toEqual({ ok: false, code: "trace_not_hot", retryable: false });
      trace.store.forget("empty"); p.read("rt", "empty");
      expect(p.replies.at(-1)!.p).toEqual({ ok: false, code: "trace_not_hot", retryable: false });
    } finally { await trace.stop(); }
  });
});
