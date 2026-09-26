import { describe, expect, it } from "bun:test";
import { FeishuCotTimeline } from "@connectors/feishu/cot-timeline.js";
import {
  countToolCalls,
  deriveFinalReply,
  deriveTraceModel,
  summarizeTrace,
  traceTypeHistogram,
} from "@shared/trace-derive.js";
import type { TraceEvent } from "@multiremi/contracts/trace.js";
import type { MultiremiTaskMessage } from "@multiremi/contracts/types.js";
import { KNOWN_TRACE_EVENT_TYPES } from "@multiremi/contracts/trace.js";

let nextSeq = 1;

function event(patch: Partial<TraceEvent> = {}): TraceEvent {
  return {
    seq: nextSeq++,
    ts: "2026-09-27T00:00:00.000Z",
    type: "text",
    tool: null,
    content: null,
    input: null,
    output: null,
    tool_call_id: null,
    status: null,
    meta: null,
    ...patch,
  };
}

/** Feed the same events to the live Feishu timeline so the two can be compared. */
function timelineAnswer(events: TraceEvent[]): string {
  const timeline = new FeishuCotTimeline("task");
  for (const item of events) {
    timeline.accept({
      id: `m${item.seq}`,
      taskId: "task",
      seq: item.seq,
      type: item.type,
      tool: item.tool ?? null,
      content: item.content ?? null,
      input: item.input ?? null,
      output: item.output ?? null,
      toolCallId: item.tool_call_id ?? null,
      status: item.status ?? null,
      meta: item.meta ?? null,
      createdAt: item.ts,
    } as unknown as MultiremiTaskMessage);
  }
  // `answer(fallback)` returns final || candidate || fallback; an empty fallback
  // makes it directly comparable with a function that returns null for "none".
  return timeline.answer("");
}

/**
 * The extraction must equal the connector's live behaviour, case for case, since
 * the turn card and the Feishu card describe the same turn. Cases below are read
 * off `cot-timeline.ts:47-58`; the surprising ones (tool_result / usage / execution
 * do NOT break a run) are the reason this is a table rather than one example.
 */
describe("deriveFinalReply matches FeishuCotTimeline.answer", () => {
  const cases: Array<[string, TraceEvent[]]> = [
    ["empty trace", []],
    ["a single text run", [event({ content: "hello" })]],
    ["text split across chunks", [event({ content: "he" }), event({ content: "llo" })]],
    ["phase=final wins over earlier text", [
      event({ content: "narration" }),
      event({ content: "the answer", meta: { phase: "final" } }),
    ]],
    ["phase=final ignores a blank final", [
      event({ content: "candidate" }),
      event({ content: "   ", meta: { phase: "final" } }),
    ]],
    ["commentary does not become the answer", [
      event({ content: "thinking out loud", meta: { phase: "commentary" } }),
      event({ content: "final prose" }),
    ]],
    ["tool_use breaks the run", [
      event({ content: "before" }),
      event({ type: "tool_use", tool: "Bash", tool_call_id: "c1", status: "pending" }),
      event({ content: "after" }),
    ]],
    ["tool_result does NOT break the run", [
      event({ content: "before" }),
      event({ type: "tool_result", tool: "Bash", tool_call_id: "c1", status: "completed" }),
      event({ content: "after" }),
    ]],
    ["usage does NOT break the run", [
      event({ content: "before" }),
      event({ type: "usage", meta: {} }),
      event({ content: "after" }),
    ]],
    ["execution does NOT break the run", [
      event({ content: "before" }),
      event({ type: "execution", meta: { provider: "claude", model: "m" } }),
      event({ content: "after" }),
    ]],
    ["steer does NOT break the run", [
      event({ content: "before" }),
      event({ type: "steer", content: "do it differently" }),
      event({ content: "after" }),
    ]],
    ["permission_response does NOT break the run", [
      event({ content: "before" }),
      event({ type: "permission_response", content: "granted", meta: { request_id: "r1" } }),
      event({ content: "after" }),
    ]],
    ["question_response does NOT break the run", [
      event({ content: "before" }),
      event({ type: "question_response", content: "answered", meta: { request_id: "r2" } }),
      event({ content: "after" }),
    ]],
    ["thinking breaks the run", [
      event({ content: "before" }),
      event({ type: "thinking", content: "hmm" }),
      event({ content: "after" }),
    ]],
    ["permission_request breaks the run", [
      event({ content: "before" }),
      event({ type: "permission_request", content: "may I?", meta: { request_id: "r1" } }),
      event({ content: "after" }),
    ]],
    ["question_request breaks the run", [
      event({ content: "before" }),
      event({ type: "question_request", content: "which one?", meta: { request_id: "r2" } }),
      event({ content: "after" }),
    ]],
    ["plan breaks the run", [
      event({ content: "before" }),
      event({ type: "plan", content: "1/2", meta: { entries: [] } }),
      event({ content: "after" }),
    ]],
    ["compaction breaks the run", [
      event({ content: "before" }),
      event({ type: "compaction", content: "compacting" }),
      event({ content: "after" }),
    ]],
    ["nested text never contributes", [
      event({ content: "subagent prose", meta: { parent_tool_call_id: "p" } }),
      event({ content: "main answer" }),
    ]],
    ["nested text does not break the run", [
      event({ content: "before" }),
      event({ content: "subagent prose", meta: { parent_tool_call_id: "p" } }),
      event({ content: "after" }),
    ]],
    ["nested tool_use does not break the run", [
      event({ content: "before" }),
      event({ type: "tool_use", tool: "Agent", tool_call_id: "c9", meta: { parent_tool_call_id: "p" } }),
      event({ content: "after" }),
    ]],
    ["whitespace-only prose is not an answer", [event({ content: "   \n " })]],
    ["unknown type neither contributes nor breaks", [
      event({ content: "before" }),
      event({ type: "some_future_type", content: "?" }),
      event({ content: "after" }),
    ]],
    ["an empty trace with only tool frames", [event({ type: "tool_use", tool: "Bash" })]],
  ];

  for (const [name, events] of cases) {
    it(name, () => {
      const expected = timelineAnswer(events);
      const actual = deriveFinalReply(events);
      expect(actual ?? "").toBe(expected);
      // The two "no answer" representations must correspond.
      expect(actual === null).toBe(expected === "");
    });
  }

  it("exercises every known event type, so a new type cannot arrive uncovered", () => {
    // The gap this closes: the table used to omit `permission_request`,
    // `question_request`, `permission_response` and `question_response`, and a
    // mutation deleting `permission_request` from the flush list left the suite
    // fully green while `text -> permission_request -> text` diverged from the
    // connector 200/200. Requiring every known type to appear means the table
    // cannot fall behind the inventory again.
    const exercised = new Set(cases.flatMap(([, events]) => events.map((item) => item.type)));
    for (const type of KNOWN_TRACE_EVENT_TYPES) {
      expect(exercised, `no case exercises "${type}"`).toContain(type);
    }
  });

  it("asserts break and no-break for both directions of each type", () => {
    // A case only constrains the flush set if it can tell the two answers apart:
    // text on both sides of the event. `[thinking, text]` cannot, which is why the
    // old table pinned nothing about thinking. Every event type must appear in at
    // least one such discriminating sequence.
    const discriminating = new Set<string>();
    for (const [, events] of cases) {
      const firstText = events.findIndex((item) => item.type === "text");
      const lastText = events.findLastIndex((item) => item.type === "text");
      if (firstText === -1 || lastText === firstText) continue;
      for (const item of events.slice(firstText + 1, lastText)) discriminating.add(item.type);
    }
    for (const type of KNOWN_TRACE_EVENT_TYPES) {
      if (type === "text") continue;
      expect(discriminating, `no discriminating case covers "${type}"`).toContain(type);
    }
  });
});

describe("trace histogram and counters", () => {
  it("buckets by (type, tool) and keeps tool only on tool frames", () => {
    const events = [
      event({ type: "text", content: "a" }),
      event({ type: "tool_use", tool: "Bash", tool_call_id: "c1" }),
      event({ type: "tool_use", tool: "Bash", tool_call_id: "c2" }),
      event({ type: "tool_use", tool: "Read", tool_call_id: "c3" }),
      event({ type: "tool_result", tool: "Bash", tool_call_id: "c1", status: "completed" }),
      event({ type: "thinking", content: "hmm", tool: "Bash" }),
      event({ type: "text", content: "b", tool: "Read" }),
    ];
    const histogram = traceTypeHistogram(events);
    expect(histogram).toEqual([
      { type: "text", tool: null, count: 2 },
      { type: "tool_use", tool: "Bash", count: 2 },
      { type: "tool_use", tool: "Read", count: 1 },
      { type: "tool_result", tool: "Bash", count: 1 },
      { type: "thinking", tool: null, count: 1 },
    ]);
    expect(countToolCalls(events)).toBe(3);
  });

  it("orders buckets by first appearance so two runs over the same data agree", () => {
    const events = [event({ type: "thinking" }), event({ type: "text" }), event({ type: "thinking" })];
    expect(traceTypeHistogram(events).map((bucket) => bucket.type)).toEqual(["thinking", "text"]);
  });

  it("counts a nested tool_use too, matching the Feishu tool counter", () => {
    // `cot-timeline` records nested tool_use (as hidden) and `toolCount` counts it,
    // so the histogram must not drop it or the two counters disagree.
    const events = [
      event({ type: "tool_use", tool: "Agent", tool_call_id: "c1", meta: { parent_tool_call_id: "p" } }),
      event({ type: "tool_use", tool: "Bash", tool_call_id: "c2" }),
    ];
    expect(countToolCalls(events)).toBe(2);
    const timeline = new FeishuCotTimeline("task");
    for (const item of events) {
      timeline.accept({
        id: `m${item.seq}`, taskId: "task", seq: item.seq, type: item.type,
        tool: item.tool ?? null, content: null, input: null, output: null,
        toolCallId: item.tool_call_id ?? null, status: null,
        meta: item.meta ?? null, createdAt: item.ts,
      } as unknown as MultiremiTaskMessage);
    }
    expect(timeline.toolCount).toBe(countToolCalls(events));
  });

  it("summarizes with head and event_count as separate numbers", () => {
    const events = [event(), event(), event({ type: "tool_use", tool: "Bash" })];
    // A sparse (backfilled) trace has head > event_count; the summary must report
    // both rather than assuming they are equal (A11).
    const summary = summarizeTrace(events, 99);
    expect(summary.head).toBe(99);
    expect(summary.event_count).toBe(3);
    expect(summary.tool_call_count).toBe(1);
    expect(summary.type_histogram).toHaveLength(2);
  });

  it("reports the last execution event's model, or null", () => {
    const events = [
      event({ type: "execution", meta: { provider: "claude", model: "old" } }),
      event({ type: "text", content: "x" }),
      event({ type: "execution", meta: { provider: "codex", model: "new" } }),
    ];
    expect(deriveTraceModel(events)).toEqual({ provider: "codex", model: "new" });
    expect(deriveTraceModel([event({ type: "execution", meta: { provider: "claude" } })])).toBeNull();
    expect(deriveTraceModel([event()])).toBeNull();
  });
});
