import { describe, expect, it } from "vitest";
import { parseTraceEvent, parseTraceFrames, TraceTurnPageSchema } from "./tasks";

const TS = "2026-10-15T00:00:00.000Z";
const turn = {
  id: "att_1", turn_id: "turn_1", agent_id: "agt_1", agent_name: null, provider: "codex", requested_model: null,
  model: null, status: "running", error: null, started_at: TS, completed_at: null, duration_ms: null,
  final_item_id: null, final_started_at: null, context_usage: null,
  stats: { item_count: 0, tool_call_count: 0, process_item_count: 0, type_histogram: [] },
};
const item = { id: "cmd_1", parent_id: null, status: "in_progress", started_at: TS, completed_at: null, type: "command",
  tool: "Bash", source: "shell", command: "ls", cwd: null, actions: [{ type: "list_files", command: "ls", path: null }],
  output: null, exit_code: null, duration_ms: null };

describe("trace event schema", () => {
  it("parses every known event type", () => {
    const events = [
      { seq: 1, ts: TS, type: "turn.started", turn },
      { seq: 2, ts: TS, type: "turn.updated", patch: { context_usage: { used: 10, size: 100 } } },
      { seq: 3, ts: TS, type: "item.started", item },
      { seq: 4, ts: TS, type: "item.updated", item },
      { seq: 5, ts: TS, type: "item.delta", item_id: "cmd_1", field: "output", delta: "a" },
      { seq: 6, ts: TS, type: "item.completed", item: { ...item, status: "completed" } },
      { seq: 7, ts: TS, type: "turn.completed", turn: { ...turn, status: "completed" } },
    ];
    expect(events.map(parseTraceEvent).map((event) => event?.type)).toEqual(events.map((event) => event.type));
  });

  it("skips unknown types, legacy fragments and malformed bodies", () => {
    expect(parseTraceEvent({ seq: 1, ts: TS, type: "tool_use", tool: "Bash" })).toBeNull();
    expect(parseTraceEvent({ seq: 1, ts: TS, type: "item.future", item })).toBeNull();
    expect(parseTraceEvent({ seq: 0, ts: TS, type: "item.started", item })).toBeNull();
    expect(parseTraceEvent({ seq: 1, ts: "yesterday", type: "item.started", item })).toBeNull();
    expect(parseTraceEvent({ seq: 1, ts: TS, type: "item.started", item: { ...item, status: "running" } })).toBeNull();
    expect(parseTraceEvent({ seq: 1, ts: TS, type: "turn.updated", patch: { status: "completed" } })).toBeNull();
  });

  it("keeps the good frames of a batch in order", () => {
    const events = parseTraceFrames([
      { kind: "trace", payload: { seq: 1, ts: TS, type: "item.started", item } },
      { kind: "trace", payload: { seq: 2, ts: TS, type: "mystery" } },
      { kind: "log", payload: { seq: 3, ts: TS, type: "item.started", item } },
      { kind: "trace", payload: { seq: 4, ts: TS, type: "item.delta", item_id: "cmd_1", field: "output", delta: "x" } },
    ]);
    expect(events.map((event) => event.seq)).toEqual([1, 4]);
  });
});

describe("trace turn page schema", () => {
  it("reads a legacy file as an empty page", () => {
    expect(TraceTurnPageSchema.parse({ view: "turn", format: "legacy", turn: null, items: [], next_item_cursor: null, head: 12, closed: true, state: "ok" }))
      .toMatchObject({ format: "legacy", turn: null, items: [], head: 12 });
  });

  it("rejects a malformed turn", () => {
    expect(TraceTurnPageSchema.safeParse({ turn: { ...turn, status: "done" }, items: [], state: "ok" }).success).toBe(false);
  });

  // Contract additions after the readers were written: a capped command line,
  // and histogram buckets of an item type a newer daemon added (spec §12).
  it("accepts a capped command and drops histogram buckets of unknown item types", () => {
    const stats = { item_count: 2, tool_call_count: 1, process_item_count: 1, type_histogram: [
      { type: "command", tool: "Bash", count: 1 }, { type: "hologram", tool: null, count: 1 },
    ] };
    const page = TraceTurnPageSchema.parse({ view: "turn", format: "v2", turn: { ...turn, stats },
      items: [{ ...item, status: "completed", command_truncated: true }], next_item_cursor: null, head: 3, closed: false, state: "ok" });
    expect(page.items).toEqual([expect.objectContaining({ id: "cmd_1", command_truncated: true })]);
    expect(page.turn?.stats.type_histogram).toEqual([{ type: "command", tool: "Bash", count: 1 }]);
  });
});
