import { describe, expect, it } from "bun:test";
import type {
  TraceAgentMessageItem,
  TraceItem,
  TraceSubagentItem,
  TraceToolItem,
  TraceTurn,
} from "@multiremi/contracts/trace";
import { isTraceLateSubagent } from "@multiremi/contracts/trace";
import {
  completeTurn,
  isProcessItem,
  lateSubagents,
  processItemCount,
  runningSubagentCounts,
  subagentReply,
  subagentToolCount,
  topLevelSubagents,
  turnCompletionFields,
  turnTraceStats,
} from "@shared/turn-trace.js";

// Subagent reads over a turn + items trace (PR 5 §4.2).

const T0 = Date.parse("2026-10-15T00:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

function turn(overrides: Partial<TraceTurn> = {}): TraceTurn {
  return {
    id: "tsk_1", turn_id: "turn_1", agent_id: "agt_1", agent_name: "Remi", provider: "claude",
    requested_model: null, model: null, status: "running", error: null, started_at: at(0),
    completed_at: null, duration_ms: null, final_item_id: null, final_started_at: null, context_usage: null,
    stats: { item_count: 0, tool_call_count: 0, process_item_count: 0, type_histogram: [] },
    ...overrides,
  };
}

function agent(id: string, overrides: Partial<TraceSubagentItem> = {}): TraceSubagentItem {
  return {
    id, parent_id: null, status: "completed", started_at: at(1), completed_at: at(5), type: "subagent", tool: "Agent",
    title: null, prompt: null, output: null, duration_ms: null, ...overrides,
  };
}

function running(id: string, overrides: Partial<TraceSubagentItem> = {}): TraceSubagentItem {
  return agent(id, { status: "in_progress", completed_at: null, ...overrides });
}

function tool(id: string, name: string, overrides: Partial<TraceToolItem> = {}): TraceToolItem {
  return {
    id, parent_id: null, status: "completed", started_at: at(2), completed_at: at(3), type: "tool", tool: name,
    server: null, kind: null, title: null, input: {}, output: null, duration_ms: null, ...overrides,
  };
}

function message(id: string, text: string, overrides: Partial<TraceAgentMessageItem> = {}): TraceAgentMessageItem {
  return {
    id, parent_id: null, status: "completed", started_at: at(2), completed_at: at(3), type: "agent_message",
    text, phase: "unknown", ...overrides,
  };
}

function instruction(id: string, parentId: string, text: string): TraceItem {
  return {
    id, parent_id: parentId, status: "completed", started_at: at(6), completed_at: at(6), type: "user_message",
    origin: "input", text, message_ids: [], attachments: [], steer: null,
  };
}

describe("topLevelSubagents and runningSubagentCounts", () => {
  const items: TraceItem[] = [
    running("sa:a", { name: "a" }),
    agent("sa:b", { name: "b" }),
    running("sa:c", { parent_id: "sa:a" }),
    running("sa:d", { parent_id: "sa:c" }),
    agent("sa:e", { parent_id: "sa:a", status: "failed" }),
    tool("call_1", "Read"),
    running("sa:f", { name: "f", background: true }),
  ];

  it("lists top-level subagents in order, nested ones excluded", () => {
    expect(topLevelSubagents(items).map((item) => item.id)).toEqual(["sa:a", "sa:b", "sa:f"]);
    expect(topLevelSubagents([])).toEqual([]);
  });

  it("counts running top-level and nested subagents", () => {
    expect(runningSubagentCounts(items)).toEqual({ top: 2, nested: 2 });
    expect(runningSubagentCounts([agent("sa:x"), tool("t", "Bash", { status: "in_progress", completed_at: null })]))
      .toEqual({ top: 0, nested: 0 });
  });
});

describe("subagentToolCount", () => {
  it("counts the tools at the subagent's own level, without nested subagents or hidden steps", () => {
    const items: TraceItem[] = [
      agent("sa:a"),
      tool("call_1", "Read", { parent_id: "sa:a" }),
      tool("call_2", "Bash", { parent_id: "sa:a", status: "failed" }),
      agent("sa:nested", { parent_id: "sa:a" }),
      tool("call_3", "Read", { parent_id: "sa:nested" }),
      tool("call_4", "wait", { parent_id: "sa:a" }),
      message("msg:a", "done", { parent_id: "sa:a" }),
      tool("call_5", "Read"),
    ];
    expect(subagentToolCount(items, "sa:a")).toBe(2);
    expect(subagentToolCount(items, "sa:nested")).toBe(1);
    expect(subagentToolCount(items, "sa:missing")).toBe(0);
  });
});

describe("subagentReply", () => {
  it("is the last direct message with text once the subagent has ended", () => {
    const items: TraceItem[] = [
      agent("sa:a"),
      message("msg:1", "Looking", { parent_id: "sa:a" }),
      tool("call_1", "Read", { parent_id: "sa:a" }),
      message("msg:2", "Found 3 files.", { parent_id: "sa:a" }),
      message("msg:3", "  ", { parent_id: "sa:a" }),
      message("msg:top", "Root text"),
    ];
    expect(subagentReply(items, "sa:a")?.id).toBe("msg:2");
  });

  it("is null while the subagent runs", () => {
    const items: TraceItem[] = [running("sa:a"), message("msg:1", "Found 3 files.", { parent_id: "sa:a" })];
    expect(subagentReply(items, "sa:a")).toBeNull();
  });

  it("is null when a tool call or a new instruction follows the last message", () => {
    expect(subagentReply([
      agent("sa:a", { status: "stopped" }),
      message("msg:1", "Let me check", { parent_id: "sa:a" }),
      tool("call_1", "Bash", { parent_id: "sa:a", status: "stopped" }),
    ], "sa:a")).toBeNull();
    expect(subagentReply([
      agent("sa:a"),
      message("msg:1", "Working on it", { parent_id: "sa:a" }),
      agent("sa:nested", { parent_id: "sa:a" }),
    ], "sa:a")).toBeNull();
    expect(subagentReply([
      agent("sa:a"),
      message("msg:1", "First answer", { parent_id: "sa:a" }),
      instruction("in:2", "sa:a", "Also count tests"),
    ], "sa:a")).toBeNull();
  });

  it("takes the resumed generation's answer, past hidden steps and nested agents' messages", () => {
    const items: TraceItem[] = [
      agent("sa:a", { status: "failed" }),
      agent("sa:nested", { parent_id: "sa:a" }),
      message("msg:n1", "nested says hi", { parent_id: "sa:nested" }),
      message("msg:1", "First answer", { parent_id: "sa:a" }),
      instruction("in:2", "sa:a", "Also count tests"),
      message("msg:2", "12 tests", { parent_id: "sa:a" }),
      tool("call_wait", "wait", { parent_id: "sa:a" }),
      message("msg:n2", "nested again", { parent_id: "sa:nested" }),
    ];
    expect(subagentReply(items, "sa:a")?.text).toBe("12 tests");
    expect(subagentReply(items, "sa:nested")?.id).toBe("msg:n2");
  });

  it("is null for an id that is not a subagent", () => {
    const items: TraceItem[] = [tool("call_1", "Read"), message("msg:1", "x", { parent_id: "call_1" })];
    expect(subagentReply(items, "call_1")).toBeNull();
    expect(subagentReply(items, "missing")).toBeNull();
  });
});

describe("lateSubagents", () => {
  const final = at(10);

  it("lists top-level subagents that ended after the final reply started, in the order they ended", () => {
    const items: TraceItem[] = [
      agent("sa:early", { name: "early", completed_at: at(9) }),
      agent("sa:late2", { name: "second", completed_at: at(14), duration_ms: 13_000, status: "failed" }),
      agent("sa:late1", { title: "first by title", completed_at: at(12) }),
      agent("sa:nested", { parent_id: "sa:late1", completed_at: at(15) }),
      running("sa:running", { name: "still running" }),
      agent("sa:stopped", { name: "  ", title: null, status: "stopped", started_at: at(2), completed_at: at(11) }),
      agent("sa:declined", { status: "declined", completed_at: at(13) }),
      agent("sa:same", { completed_at: final }),
    ];
    expect(lateSubagents(items, final)).toEqual([
      { item_id: "sa:stopped", name: "", status: "stopped", duration_ms: 9_000 },
      { item_id: "sa:late1", name: "first by title", status: "completed", duration_ms: 11_000 },
      { item_id: "sa:late2", name: "second", status: "failed", duration_ms: 13_000 },
    ]);
    for (const entry of lateSubagents(items, final)) expect(isTraceLateSubagent(entry)).toBe(true);
  });

  it("caps the list at 5 by default, keeping the first to end; ties keep trace order", () => {
    const items = Array.from({ length: 8 }, (_, index) =>
      agent(`sa:${index}`, { name: `agent ${index}`, completed_at: at(index < 2 ? 40 : 30 - index) }));
    expect(lateSubagents(items, final).map((entry) => entry.item_id)).toEqual(["sa:7", "sa:6", "sa:5", "sa:4", "sa:3"]);
    expect(lateSubagents(items, final, 2).map((entry) => entry.item_id)).toEqual(["sa:7", "sa:6"]);
    const tied = [agent("sa:x", { completed_at: at(20) }), agent("sa:y", { completed_at: at(20) })];
    expect(lateSubagents(tied, final).map((entry) => entry.item_id)).toEqual(["sa:x", "sa:y"]);
  });

  it("is empty without a final reply", () => {
    const items = [agent("sa:a", { completed_at: at(20) })];
    expect(lateSubagents(items, null)).toEqual([]);
    expect(lateSubagents(items, undefined)).toEqual([]);
    expect(lateSubagents(items, "not a time")).toEqual([]);
  });
});

describe("isProcessItem and hidden steps", () => {
  it("excludes Codex wait from the process count, top level only", () => {
    const wait = tool("call_wait", "wait", { input: { receiverThreadIds: ["019a"] } });
    const items: TraceItem[] = [
      agent("sa:a", { tool: "spawnAgent" }),
      wait,
      tool("call_send", "sendInput", { input: { receiverThreadIds: ["019a"], prompt: "go" } }),
      tool("call_read", "Read"),
    ];
    expect(isProcessItem(wait)).toBe(false);
    expect(items.filter(isProcessItem).map((item) => item.id)).toEqual(["sa:a", "call_send", "call_read"]);
    expect(processItemCount(items)).toBe(3);
    // `wait` is still a tool call and still in the histogram.
    const stats = turnTraceStats(items);
    expect(stats.tool_call_count).toBe(4);
    expect(stats.type_histogram).toContainEqual({ type: "tool", tool: "wait", count: 1 });
  });
});

describe("turnCompletionFields.late_subagents", () => {
  it("reports the late subagents of the completed turn", () => {
    const items: TraceItem[] = [
      agent("sa:bg", { name: "Count files", background: true, started_at: at(1), completed_at: at(9) }),
      message("msg:final", "Started a helper; here is what I have.", { phase: "final", started_at: at(6), completed_at: at(7) }),
    ];
    const done = completeTurn({ turn: turn(), items }, { status: "completed", completedAt: at(9) });
    expect(done).toMatchObject({ final_item_id: "msg:final", final_started_at: at(6) });
    expect(turnCompletionFields({ turn: done, items, head: 4 }, { eventCount: 4 }).late_subagents)
      .toEqual([{ item_id: "sa:bg", name: "Count files", status: "completed", duration_ms: 8_000 }]);
  });

  it("is null when no subagent ended late or the turn has no final reply", () => {
    const items: TraceItem[] = [
      agent("sa:fg", { name: "Explore", completed_at: at(3) }),
      message("msg:final", "Done.", { phase: "final", started_at: at(6) }),
    ];
    const done = completeTurn({ turn: turn(), items }, { status: "completed", completedAt: at(9) });
    expect(turnCompletionFields({ turn: done, items, head: 3 }, { eventCount: 3 }).late_subagents).toBeNull();
    const noFinal: TraceItem[] = [agent("sa:a", { completed_at: at(20) })];
    const failed = completeTurn({ turn: turn(), items: noFinal }, { status: "failed", completedAt: at(21) });
    expect(turnCompletionFields({ turn: failed, items: noFinal, head: 2 }, { eventCount: 2 }).late_subagents).toBeNull();
  });
});

describe("isTraceLateSubagent", () => {
  it("accepts well-formed entries with extra keys and rejects malformed ones", () => {
    const entry = { item_id: "sa:1", name: "Explore", status: "completed", duration_ms: 1200 };
    expect(isTraceLateSubagent(entry)).toBe(true);
    expect(isTraceLateSubagent({ ...entry, name: "", duration_ms: null, extra: 1 })).toBe(true);
    for (const bad of [
      null, [], "sa:1", { ...entry, item_id: "" }, { ...entry, name: null }, { ...entry, status: "in_progress" },
      { ...entry, status: "declined" }, { ...entry, duration_ms: -1 }, { ...entry, duration_ms: Number.NaN },
      { ...entry, duration_ms: "1200" }, { item_id: "sa:1", name: "x", status: "completed" },
    ]) {
      expect(isTraceLateSubagent(bad)).toBe(false);
    }
  });
});
