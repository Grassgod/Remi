import { describe, expect, it } from "bun:test";
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
