import { describe, expect, it } from "bun:test";
import type {
  TraceAgentMessageItem,
  TraceCommandItem,
  TraceEventBody,
  TraceItem,
  TraceTurn,
  TraceEvent,
} from "@multiremi/contracts/trace";
import { isTraceItem, isTraceTurn, isTraceEvent, isTraceTurnSnapshot, knownTraceItems } from "@multiremi/contracts/trace";
import {
  EMPTY_TURN_TRACE,
  TurnTraceFold,
  applyTurnTraceEvent,
  applyTurnTraceEvents,
  applyTurnTracePage,
  closeOpenItems,
  closeTurnTrace,
  completeTurn,
  finalItem,
  finalReplyBody,
  isProcessItem,
  pageTurnTrace,
  processItemCount,
  selectFinalReply,
  topLevelItems,
  turnCompletionFields,
  turnTraceFromPage,
  turnTraceFromSnapshot,
  turnTraceSnapshot,
  turnTraceStats,
  turnWorkedMs,
  type TurnTraceState,
} from "@shared/turn-trace.js";

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

function message(id: string, text: string, overrides: Partial<TraceAgentMessageItem> = {}): TraceAgentMessageItem {
  return {
    id, parent_id: null, status: "completed", started_at: at(1), completed_at: at(2),
    type: "agent_message", text, phase: "unknown", ...overrides,
  };
}

function command(id: string, overrides: Partial<TraceCommandItem> = {}): TraceCommandItem {
  return {
    id, parent_id: null, status: "completed", started_at: at(1), completed_at: at(2), type: "command",
    tool: "Bash", source: "shell", command: "ls", cwd: null, actions: [{ type: "list_files", command: "ls", path: null }],
    output: null, exit_code: 0, duration_ms: 1000, ...overrides,
  };
}

const input: TraceItem = {
  id: "in:tsk_1", parent_id: null, status: "completed", started_at: at(0), completed_at: at(0),
  type: "user_message", origin: "input", text: "hi", message_ids: ["msg_1"], attachments: [], steer: null,
};

/** Number a list of bodies from `from`, as the store would. */
function stored(bodies: TraceEventBody[], from = 1): TraceEvent[] {
  return bodies.map((body, index) => ({ seq: from + index, ts: at(from + index), ...body }) as TraceEvent);
}

/** A representative running turn: input, streamed reply, a command, a final reply. */
function scenario(): TraceEvent[] {
  return stored([
    { type: "turn.started", turn: turn() },
    { type: "item.completed", item: input },
    { type: "item.started", item: message("msg:a", "", { status: "in_progress", completed_at: null }) },
    { type: "item.delta", item_id: "msg:a", field: "text", delta: "Let me " },
    { type: "item.delta", item_id: "msg:a", field: "text", delta: "look." },
    { type: "item.completed", item: message("msg:a", "Let me look.") },
    { type: "item.started", item: command("call_1", { status: "in_progress", command: null, actions: [], completed_at: null, exit_code: null }) },
    { type: "turn.updated", patch: { context_usage: { used: 1000, size: 200_000 } } },
    { type: "item.updated", item: command("call_1", { status: "in_progress", completed_at: null, exit_code: null }) },
    { type: "item.delta", item_id: "call_1", field: "output", delta: "a.ts\n" },
    { type: "item.delta", item_id: "call_1", field: "output", delta: "b.ts\n" },
    { type: "item.completed", item: command("call_1", { output: "a.ts\nb.ts\n" }) },
    { type: "item.started", item: message("msg:b", "", { status: "in_progress", completed_at: null, started_at: at(5) }) },
    { type: "item.delta", item_id: "msg:b", field: "text", delta: "Done." },
    { type: "turn.updated", patch: { model: "claude-opus-5-5" } },
  ]);
}

function fold(events: readonly TraceEvent[], state: TurnTraceState = EMPTY_TURN_TRACE): TurnTraceState {
  return applyTurnTraceEvents(state, events);
}

/** State without the reader-side bookkeeping that legitimately differs between paths. */
function view(state: TurnTraceState) {
  return { turn: state.turn, items: state.items.map(({ seq: _seq, ...item }) => item), head: state.head };
}

describe("turn trace reducer", () => {
  it("upserts items by id in first-seen order and streams deltas into them", () => {
    const state = fold(scenario());
    expect(state.items.map((item) => item.id)).toEqual(["in:tsk_1", "msg:a", "call_1", "msg:b"]);
    expect(state.items[1]).toMatchObject({ text: "Let me look.", status: "completed", seq: 6 });
    expect(state.items[2]).toMatchObject({ command: "ls", output: "a.ts\nb.ts\n", status: "completed" });
    expect(state.items[3]).toMatchObject({ text: "Done.", status: "in_progress", seq: 14 });
    expect(state.turn).toMatchObject({ model: "claude-opus-5-5", context_usage: { used: 1000, size: 200_000 } });
    expect(state.head).toBe(15);
    expect(state.turnSeq).toBe(15);
  });

  it("is idempotent: re-applied events change nothing and return the same state", () => {
    const events = scenario();
    const once = fold(events);
    expect(fold(events, once)).toBe(once);
    for (const event of events) expect(applyTurnTraceEvent(once, event)).toBe(once);
  });

  it("appends a delta only to an in-progress item and only above its seq", () => {
    const base = fold(stored([
      { type: "turn.started", turn: turn() },
      { type: "item.started", item: command("call_1", { status: "in_progress", output: null, completed_at: null }) },
      { type: "item.completed", item: command("call_1", { output: "final" }) },
    ]));
    const late = fold(stored([{ type: "item.delta", item_id: "call_1", field: "output", delta: "late" }], 4), base);
    expect(late.items[0]).toMatchObject({ output: "final", seq: 3 });
    expect(late.head).toBe(4);

    const running = fold(stored([
      { type: "item.started", item: command("call_2", { status: "in_progress", output: null, completed_at: null }) },
    ], 5), late);
    // A stale delta (seq at or below the item's) and a mismatched field are both ignored.
    const stale = applyTurnTraceEvent(running, { seq: 5, ts: at(5), type: "item.delta", item_id: "call_2", field: "output", delta: "x" });
    expect(stale.items[1]).toMatchObject({ output: null });
    const wrongField = applyTurnTraceEvent(running, { seq: 6, ts: at(6), type: "item.delta", item_id: "call_2", field: "text", delta: "x" });
    expect(wrongField.items[1]).toMatchObject({ output: null });
    const missing = applyTurnTraceEvent(running, { seq: 7, ts: at(7), type: "item.delta", item_id: "nope", field: "output", delta: "x" });
    expect(missing.items).toBe(running.items);
    const ok = applyTurnTraceEvent(running, { seq: 8, ts: at(8), type: "item.delta", item_id: "call_2", field: "output", delta: "x" });
    expect(ok.items[1]).toMatchObject({ output: "x", seq: 8 });
  });

  it("skips stale full replacements and stale turn events", () => {
    const state = fold(scenario());
    const replay = applyTurnTraceEvents(state, [
      { seq: 3, ts: at(3), type: "item.started", item: message("msg:a", "", { status: "in_progress", completed_at: null }) },
      { seq: 1, ts: at(1), type: "turn.started", turn: turn() },
      { seq: 8, ts: at(8), type: "turn.updated", patch: { context_usage: null } },
    ]);
    expect(replay).toBe(state);
  });

  it("keeps unchanged items' identity across batches", () => {
    const state = fold(scenario());
    const next = fold(stored([{ type: "item.completed", item: message("msg:b", "Done.", { phase: "final", started_at: at(5) }) }], 16), state);
    expect(next.items[0]).toBe(state.items[0]);
    expect(next.items[2]).toBe(state.items[2]);
    expect(next.items[3]).not.toBe(state.items[3]);
  });

  it("merges turn.updated patches without letting undefined fields erase values", () => {
    const state = fold(stored([
      { type: "turn.started", turn: turn({ model: "a" }) },
      { type: "turn.updated", patch: { model: undefined, agent_name: "Renamed" } },
    ]));
    expect(state.turn).toMatchObject({ model: "a", agent_name: "Renamed" });
    // Before turn.started there is nothing to patch.
    expect(fold(stored([{ type: "turn.updated", patch: { model: "x" } }])).turn).toBeNull();
  });

  it("skips unknown event types but still advances the head", () => {
    const state = fold([...stored([{ type: "turn.started", turn: turn() }]), { seq: 2, ts: at(2), type: "item.future" } as unknown as TraceEvent]);
    expect(state.head).toBe(2);
    expect(state.items).toEqual([]);
  });

  it("replays any prefix over a snapshot to the same state", () => {
    const events = scenario();
    const full = fold(events);
    for (const cut of [0, 4, 9, events.length]) {
      const snapshot = turnTraceSnapshot(fold(events.slice(0, cut)));
      if (!snapshot) continue;
      const resumed = fold(events, turnTraceFromSnapshot(snapshot));
      expect(view(resumed)).toEqual(view(full));
    }
  });

  it("stitches pages taken at different heads, then live events, into the full fold", () => {
    const events = scenario();
    const atNine = fold(events.slice(0, 9));
    const page1 = pageTurnTrace(atNine, { itemCursor: 0, limit: 2, maxBytes: 1 << 20 });
    expect(page1).toMatchObject({ view: "turn", format: "v2", next_item_cursor: 2, head: 9, closed: false });
    expect(page1.items.map((item) => item.id)).toEqual(["in:tsk_1", "msg:a"]);

    const atFourteen = fold(events.slice(0, 14));
    const page2 = pageTurnTrace(atFourteen, { itemCursor: 2, limit: 2, maxBytes: 1 << 20 });
    expect(page2.next_item_cursor).toBeNull();
    expect(page2.items.map((item) => item.id)).toEqual(["call_1", "msg:b"]);

    // The client subscribes from the first page's head: events 10..15 arrive,
    // several of them already reflected in page 2.
    const stitched = fold(events.slice(9), applyTurnTracePage(turnTraceFromPage(page1), page2));
    expect(view(stitched)).toEqual(view(fold(events)));
    expect(stitched.items[2]).toMatchObject({ output: "a.ts\nb.ts\n" });
    expect(stitched.items[3]).toMatchObject({ text: "Done." });
  });

  it("resets on a fresh page after a stream gap", () => {
    const stale = fold(scenario().slice(0, 6));
    const fresh = turnTraceFromPage({
      view: "turn", format: "v2", turn: turn({ status: "completed" }), items: [message("msg:z", "Only this")],
      next_item_cursor: null, head: 40, closed: true,
    });
    expect(stale.items.length).toBeGreaterThan(1);
    expect(fresh.items.map((item) => item.id)).toEqual(["msg:z"]);
    expect(fresh).toMatchObject({ head: 40, turnSeq: 40, closed: true });
    expect(fresh.items[0]!.seq).toBe(40);
  });

  it("shows nothing for a legacy page", () => {
    const legacy = turnTraceFromPage({ view: "turn", format: "legacy", turn: null, items: [], next_item_cursor: null, head: 12, closed: true });
    expect(legacy).toMatchObject({ turn: null, items: [], head: 12, closed: true });
  });

  it("pages by item count and by bytes, always returning at least one item", () => {
    const state = fold(scenario());
    const tight = pageTurnTrace(state, { itemCursor: 0, limit: 10, maxBytes: 1 });
    expect(tight.items).toHaveLength(1);
    expect(tight.next_item_cursor).toBe(1);
    const past = pageTurnTrace(state, { itemCursor: 99, limit: 10, maxBytes: 1 << 20 });
    expect(past).toMatchObject({ items: [], next_item_cursor: null });
  });

  it("closes the state on stream.closed", () => {
    const state = fold(scenario());
    expect(closeTurnTrace(state).closed).toBe(true);
    expect(closeTurnTrace(closeTurnTrace(state))).toEqual(closeTurnTrace(state));
  });
});

describe("TurnTraceFold", () => {
  it("applies the same rules as the immutable reducer and counts events", () => {
    const events = scenario();
    const mutable = new TurnTraceFold();
    mutable.apply(events.slice(0, 7));
    mutable.apply(events.slice(5)); // overlap is idempotent
    expect(view(mutable.state())).toEqual(view(fold(events)));
    expect(mutable.eventCount).toBe(events.length);
    expect(mutable.head).toBe(events.length);
  });

  it("hands out states that later applies do not change", () => {
    const events = scenario();
    const mutable = new TurnTraceFold();
    mutable.apply(events.slice(0, 3));
    const early = mutable.state();
    mutable.apply(events.slice(3));
    expect(early.items).toHaveLength(2);
    expect(mutable.items).toHaveLength(4);
    // The handed-out state keeps working with the immutable reducer.
    expect(view(fold(events.slice(3), early))).toEqual(view(fold(events)));
  });

  it("resumes from a state", () => {
    const events = scenario();
    const mutable = new TurnTraceFold(fold(events.slice(0, 8)));
    mutable.apply(events);
    expect(view(mutable.state())).toEqual(view(fold(events)));
  });
});

describe("stats and helpers", () => {
  const subagent: TraceItem = {
    id: "task_1", parent_id: null, status: "completed", started_at: at(2), completed_at: at(4), type: "subagent",
    tool: "Task", title: "Explore", prompt: "look around", output: "found it", duration_ms: 2000,
  };
  const nested = command("call_nested", { parent_id: "task_1", tool: "Read", source: "tool", command: null });
  const items: TraceItem[] = [
    input,
    message("msg:a", "Let me look."),
    command("call_1"),
    subagent,
    nested,
    message("msg:sub", "subagent prose", { parent_id: "task_1" }),
    { id: "rsn:1", parent_id: null, status: "completed", started_at: at(3), completed_at: at(3), type: "reasoning", text: "hmm" },
    command("call_2"),
    message("msg:b", "All done.", { phase: "final", started_at: at(6) }),
  ];

  it("counts tool items at any depth and process items at the top level", () => {
    const stats = turnTraceStats(items);
    expect(stats.item_count).toBe(9);
    expect(stats.tool_call_count).toBe(4); // call_1, task_1, call_nested, call_2
    // msg:a, call_1, task_1, call_2: not the input, the reasoning, the final, or nested items (D-count).
    expect(stats.process_item_count).toBe(4);
    expect(processItemCount(items)).toBe(4);
    expect(stats.type_histogram).toEqual([
      { type: "user_message", tool: null, count: 1 },
      { type: "agent_message", tool: null, count: 3 },
      { type: "command", tool: "Bash", count: 2 },
      { type: "subagent", tool: "Task", count: 1 },
      { type: "command", tool: "Read", count: 1 },
      { type: "reasoning", tool: null, count: 1 },
    ]);
  });

  it("leaves permissions and questions out of the process count (decision Q1)", () => {
    const permission: TraceItem = {
      id: "perm:d1", parent_id: null, status: "completed", started_at: at(2), completed_at: at(3), type: "permission",
      tool_item_id: "call_1", title: "Run ls", message_id: "d1", options: [], decision: null, outcome: "cancelled",
      responded_by: null, reply_message_id: null,
    };
    const question: TraceItem = {
      id: "q:d2", parent_id: null, status: "completed", started_at: at(3), completed_at: at(4), type: "question",
      tool_item_id: null, message: "Which?", message_id: "d2", questions: [], answers: null, responded_by: null,
      reply_message_id: null,
    };
    const stats = turnTraceStats([...items, permission, question]);
    expect(stats.item_count).toBe(11);
    expect(stats.process_item_count).toBe(4);
    expect(isProcessItem(permission)).toBe(false);
    expect(isProcessItem(question)).toBe(false);
    expect(isProcessItem(items[1]!)).toBe(true);
  });

  it("counts only items that draw a fold row: no reasoning, no empty messages (decision D-count)", () => {
    const reasoning = items.find((item) => item.type === "reasoning")!;
    const empty = message("msg:empty", "");
    const blank = message("msg:blank", " \n\t ");
    const commentary = message("msg:c", "Checking.", { phase: "commentary" });
    const emptyFinal = message("msg:f", "", { phase: "final" });
    expect(isProcessItem(reasoning)).toBe(false);
    expect(isProcessItem(empty)).toBe(false);
    expect(isProcessItem(blank)).toBe(false);
    expect(isProcessItem(emptyFinal)).toBe(false);
    expect(isProcessItem(commentary)).toBe(true);
    expect(isProcessItem(message("msg:sub2", "nested", { parent_id: "task_1" }))).toBe(false);
    expect(processItemCount([input, reasoning, empty, blank, commentary, command("call_9"), emptyFinal])).toBe(2);
  });

  it("finds top-level items and the final item", () => {
    expect(topLevelItems(items).map((item) => item.id)).not.toContain("call_nested");
    expect(finalItem(items)?.id).toBe("msg:b");
    expect(finalItem(items, "msg:a")?.id).toBe("msg:a");
    expect(finalItem(items, "call_1")).toBeNull();
    expect(finalItem(items.slice(0, 3))).toBeNull();
  });

  it("completes the turn and derives the completion fields", () => {
    const state = { turn: turn({ model: "claude-opus-5-5", context_usage: { used: 5, size: 10 } }), items, head: 30 };
    const completed = completeTurn(state, { status: "completed", completedAt: at(10) });
    expect(completed).toMatchObject({
      status: "completed", error: null, completed_at: at(10), duration_ms: 10_000,
      final_item_id: "msg:b", final_started_at: at(6),
      stats: { tool_call_count: 4, process_item_count: 4 },
    });
    expect(isTraceTurn(completed)).toBe(true);
    expect(turnWorkedMs(completed)).toBe(6000);

    const fields = turnCompletionFields({ ...state, turn: completed }, { eventCount: 30 });
    expect(fields).toMatchObject({
      trace: { head: 30, event_count: 30, closed: true, tool_call_count: 4 },
      final_reply_md: "All done.",
      model: { provider: "claude", model: "claude-opus-5-5" },
      context_usage: { used: 5, size: 10 },
      worked_ms: 6000,
      process_item_count: 4,
    });
    expect(fields.trace.type_histogram).toEqual(turnTraceStats(items).type_histogram);
  });

  it("reports null worked_ms and reply without a final item", () => {
    const state = { turn: turn(), items: items.slice(0, 3), head: 3 };
    const completed = completeTurn(state, { status: "failed", error: { message: "boom", reason: "agent_error" }, completedAt: at(4) });
    expect(completed).toMatchObject({ final_item_id: null, final_started_at: null, error: { message: "boom" } });
    const fields = turnCompletionFields({ ...state, turn: completed }, { eventCount: 3 });
    expect(fields).toMatchObject({ final_reply_md: null, worked_ms: null, model: null, context_usage: null });
    expect(completeTurn({ turn: null, items: [] }, { status: "completed", completedAt: at(1) })).toBeNull();
  });

  it("closes open items by type and turn outcome", () => {
    const open: TraceItem[] = [
      command("call_1", { status: "in_progress", completed_at: null }),
      message("msg:a", "partial", { status: "in_progress", completed_at: null, seq: 9 }),
      { id: "plan", parent_id: null, status: "in_progress", started_at: at(1), completed_at: null, type: "plan", entries: [] },
      {
        id: "perm:1", parent_id: null, status: "in_progress", started_at: at(1), completed_at: null, type: "permission",
        tool_item_id: "call_1", title: "Run ls", message_id: null, options: [], decision: null, outcome: null,
        responded_by: null, reply_message_id: null,
      },
      message("msg:done", "done"),
    ];
    const completed = closeOpenItems(open, "completed", at(9));
    expect(completed.map((body) => body.type === "item.completed" && [body.item.id, body.item.status])).toEqual([
      ["call_1", "stopped"], ["msg:a", "completed"], ["plan", "completed"], ["perm:1", "stopped"],
    ]);
    const cancelled = closeOpenItems(open, "cancelled", at(9));
    expect(cancelled.map((body) => body.type === "item.completed" && body.item.status)).toEqual(["stopped", "stopped", "stopped", "stopped"]);
    for (const body of completed) {
      if (body.type !== "item.completed") throw new Error("expected item.completed");
      expect(body.item.completed_at).toBe(at(9));
      expect("seq" in body.item).toBe(false);
      expect(isTraceItem(body.item)).toBe(true);
    }
  });
});

describe("final reply rule", () => {
  it("rule 1: the last bridge-labelled final wins and earlier finals become commentary", () => {
    const items: TraceItem[] = [
      message("msg:1", "first answer", { phase: "final" }),
      command("call_1"),
      message("msg:2", "progress", { phase: "commentary" }),
      message("msg:3", "second answer", { phase: "final" }),
      message("msg:sub", "nested", { phase: "final", parent_id: "task_1" }),
    ];
    const selection = selectFinalReply(items);
    expect(selection).toMatchObject({ itemId: "msg:3", text: "second answer", rule: "phase" });
    expect(selection.reemit.map((item) => [item.id, item.phase])).toEqual([["msg:1", "commentary"]]);
  });

  it("rule 2: the last message with no tool after it becomes final", () => {
    const items: TraceItem[] = [
      message("msg:1", "Let me check."),
      command("call_1"),
      message("msg:2", "Here is the answer."),
      { id: "rsn:1", parent_id: null, status: "completed", started_at: at(3), completed_at: at(3), type: "reasoning", text: "…" },
      message("msg:3", "  "),
      message("msg:sub", "nested", { parent_id: "task_1" }),
    ];
    const selection = selectFinalReply(items);
    expect(selection).toMatchObject({ itemId: "msg:2", text: "Here is the answer.", rule: "inferred" });
    expect(selection.reemit).toEqual([{ ...message("msg:2", "Here is the answer."), phase: "final" }]);
  });

  it("D-final: when a tool follows the last message, the last unknown message is final anyway", () => {
    const items: TraceItem[] = [
      message("msg:1", "Let me check."),
      command("call_1"),
      message("msg:2", "Running it now."),
      message("msg:3", " "),
      command("call_2"),
    ];
    const selection = selectFinalReply(items);
    expect(selection).toMatchObject({ itemId: "msg:2", text: "Running it now.", rule: "fallback" });
    expect(selection.reemit).toEqual([{ ...message("msg:2", "Running it now."), phase: "final" }]);
    // The old LastAssistantMessage reply, not "Task completed.".
    expect(finalReplyBody(selection, items, "provider text")).toBe("Running it now.");
  });

  it("finds nothing without a non-empty unknown message", () => {
    const items: TraceItem[] = [message("msg:1", ""), command("call_1"), message("msg:2", "Next I will…", { phase: "commentary" })];
    expect(selectFinalReply(items)).toEqual({ itemId: null, text: null, rule: null, reemit: [] });
    expect(finalReplyBody(selectFinalReply(items), items, "provider text")).toBe("Task completed.");
  });

  it("never promotes a bridge-labelled commentary message", () => {
    const items: TraceItem[] = [message("msg:1", "answer?"), message("msg:2", "Next I will…", { phase: "commentary" })];
    // The commentary blocks rule 2; the fallback still takes the unknown message, never msg:2.
    expect(selectFinalReply(items)).toMatchObject({ itemId: "msg:1", rule: "fallback" });
    expect(selectFinalReply([message("msg:2", "Next I will…", { phase: "commentary" })]).itemId).toBeNull();
  });

  it("rule 2 treats a top-level question as a blocker, like a tool (spec §11)", () => {
    const question: TraceItem = {
      id: "q:d1", parent_id: null, status: "completed", started_at: at(3), completed_at: at(4), type: "question",
      tool_item_id: null, message: "Which?", message_id: "d1", questions: [], answers: { a: "x" }, responded_by: null,
      reply_message_id: null,
    };
    const plan: TraceItem = { id: "plan", parent_id: null, status: "in_progress", started_at: at(3), completed_at: null,
      type: "plan", entries: [] };
    // Claude's AskUserQuestion has no tool item: the question alone blocks rule 2.
    expect(selectFinalReply([message("msg:1", "Which one?"), question])).toMatchObject({ itemId: "msg:1", rule: "fallback" });
    // Items that are not blockers leave rule 2 in charge.
    expect(selectFinalReply([message("msg:1", "Done."), plan])).toMatchObject({ itemId: "msg:1", rule: "inferred" });
    // A reply after the answered question is rule 2's pick.
    expect(selectFinalReply([message("msg:1", "Which one?"), question, message("msg:2", "Done with x.")]))
      .toMatchObject({ itemId: "msg:2", rule: "inferred" });
    // A nested question does not block.
    expect(selectFinalReply([message("msg:1", "Done."), { ...question, parent_id: "task_1" }]))
      .toMatchObject({ itemId: "msg:1", rule: "inferred" });
  });

  it("moves the inferred final across steer rounds and demotes the previous pick", () => {
    const round1: TraceItem[] = [message("msg:1", "First reply.")];
    const first = selectFinalReply(round1);
    expect(first.itemId).toBe("msg:1");
    const promoted = round1.map((item) => item.id === "msg:1" ? first.reemit[0]! : item);

    // Steer, more work, a new reply: the old pick must not count as a bridge final.
    const steer: TraceItem = { ...input, id: "steer:1", origin: "steer", text: "also do X",
      steer: { steer_id: "s1", kind: "now", injected: true, author_type: "member", author_id: "mem_1" } };
    const round2 = [...promoted, steer, command("call_1"), message("msg:2", "Second reply.")];
    const second = selectFinalReply(round2, "msg:1");
    expect(second).toMatchObject({ itemId: "msg:2", rule: "inferred" });
    expect(second.reemit.map((item) => [item.id, item.phase])).toEqual([["msg:2", "final"], ["msg:1", "unknown"]]);

    // Re-settling with nothing new keeps the previous pick, with nothing to re-emit.
    expect(selectFinalReply(promoted, "msg:1")).toEqual({ itemId: "msg:1", text: "First reply.", rule: "inferred", reemit: [] });

    // A round that ends on a tool with no new text keeps the previous pick (D-final).
    const round3 = [...promoted, steer, command("call_2")];
    expect(selectFinalReply(round3, "msg:1")).toEqual({ itemId: "msg:1", text: "First reply.", rule: "fallback", reemit: [] });

    // With new text before the tool, the fallback moves to it and demotes the previous pick.
    const round4 = [...promoted, steer, message("msg:3", "Working on X."), command("call_3")];
    const fourth = selectFinalReply(round4, "msg:1");
    expect(fourth).toMatchObject({ itemId: "msg:3", rule: "fallback" });
    expect(fourth.reemit.map((item) => [item.id, item.phase])).toEqual([["msg:3", "final"], ["msg:1", "unknown"]]);
  });

  it("a bridge final after an inferred pick takes over and demotes it", () => {
    const items: TraceItem[] = [message("msg:1", "Inferred.", { phase: "final" }), message("msg:2", "Native.", { phase: "final" })];
    const selection = selectFinalReply(items, "msg:1");
    expect(selection).toMatchObject({ itemId: "msg:2", rule: "phase" });
    expect(selection.reemit.map((item) => [item.id, item.phase])).toEqual([["msg:1", "unknown"]]);
  });

  it("re-emitted items carry no reader-side seq", () => {
    const selection = selectFinalReply([message("msg:1", "Hi", { seq: 4 })]);
    expect("seq" in selection.reemit[0]!).toBe(false);
  });

  it("builds the reply body with the existing fallback", () => {
    const items: TraceItem[] = [message("msg:1", "  Answer  ")];
    expect(finalReplyBody(selectFinalReply(items), items)).toBe("Answer");
    expect(finalReplyBody({ text: null }, [command("call_1")], " provider text ")).toBe("provider text");
    expect(finalReplyBody({ text: null }, [command("call_1")])).toBe("Task completed.");
    expect(finalReplyBody({ text: "" }, [message("msg:1", "")], "provider text")).toBe("Task completed.");
  });
});

describe("contract validators on reducer output", () => {
  it("accepts every event and item the scenario produces", () => {
    for (const event of scenario()) expect(isTraceEvent(event), event.type).toBe(true);
    for (const item of fold(scenario()).items) expect(isTraceItem(item), item.id).toBe(true);
  });

  it("rejects malformed events", () => {
    expect(isTraceEvent({ seq: 0, ts: at(0), type: "turn.started", turn: turn() })).toBe(false);
    expect(isTraceEvent({ seq: 1, ts: "yesterday", type: "turn.started", turn: turn() })).toBe(false);
    expect(isTraceEvent({ seq: 1, ts: at(1), type: "item.delta", item_id: "x", field: "input", delta: "" })).toBe(false);
    expect(isTraceEvent({ seq: 1, ts: at(1), type: "turn.updated", patch: { status: "completed" } })).toBe(false);
    expect(isTraceEvent({ seq: 1, ts: at(1), type: "item.started", item: { ...message("m", "x"), phase: "final_answer" } })).toBe(false);
    expect(isTraceEvent({ seq: 1, ts: at(1), type: "item.future" })).toBe(false);
  });

  it("drops snapshot items of unknown types instead of rejecting the snapshot (spec §13)", () => {
    const known = message("msg:1", "done");
    const snapshot = { turn: turn(), head: 3, closed: true, items: [{ ...known, id: "card", type: "agent_card", agents: [] }, known] };
    expect(isTraceTurnSnapshot(snapshot)).toBe(true);
    expect(snapshot.items).toEqual([known]);
    expect(knownTraceItems([known])).toEqual([known]);
    // A damaged item of a known type, or a row without a type, still rejects it.
    expect(isTraceTurnSnapshot({ turn: turn(), head: 3, closed: true, items: [{ ...known, status: "running" }] })).toBe(false);
    expect(isTraceTurnSnapshot({ turn: turn(), head: 3, closed: true, items: [{ id: "x" }] })).toBe(false);
    expect(knownTraceItems("items")).toBeNull();
  });

  it("accepts the optional subagent and command facts and rejects malformed ones (spec §13)", () => {
    const base = { id: "toolu_a", parent_id: null, status: "in_progress", started_at: at(1), completed_at: null };
    const subagent = { ...base, type: "subagent", tool: "Agent", title: "Count files", prompt: "p", output: null, duration_ms: null };
    expect(isTraceItem(subagent)).toBe(true);
    expect(isTraceItem({ ...subagent, agent_type: "general-purpose", name: "Count files", background: true, model: null, thread_id: null })).toBe(true);
    for (const bad of [{ agent_type: 1 }, { name: false }, { background: "yes" }, { model: {} }, { thread_id: ["t"] }]) {
      expect(isTraceItem({ ...subagent, ...bad }), JSON.stringify(bad)).toBe(false);
    }
    const command = { ...base, type: "command", tool: "Bash", source: "shell", command: "ls", cwd: null, actions: [], output: null,
      exit_code: null, duration_ms: null };
    expect(isTraceItem({ ...command, title: "List files" })).toBe(true);
    expect(isTraceItem({ ...command, title: null })).toBe(true);
    expect(isTraceItem({ ...command, title: 3 })).toBe(false);
  });

  it("drops histogram buckets of unknown item types instead of rejecting the turn (spec §12)", () => {
    const histogram = [
      { type: "command", tool: "Bash", count: 2 },
      { type: "hologram", tool: null, count: 1 },
      { type: "agent_message", tool: null, count: 3 },
    ];
    const newer = turn({ stats: { item_count: 6, tool_call_count: 2, process_item_count: 3, type_histogram: histogram } as never });
    expect(isTraceTurn(newer)).toBe(true);
    expect(newer.stats.type_histogram).toEqual([
      { type: "command", tool: "Bash", count: 2 },
      { type: "agent_message", tool: null, count: 3 },
    ]);
    // The rest of the turn, and a snapshot or event that carries it, still validates.
    expect(isTraceEvent({ seq: 1, ts: at(1), type: "turn.started",
      turn: turn({ stats: { item_count: 1, tool_call_count: 0, process_item_count: 0,
        type_histogram: [{ type: "hologram", tool: null, count: 1 }] } as never }) })).toBe(true);
    // A known histogram is left as it is.
    const known = turn();
    const before = known.stats.type_histogram;
    expect(isTraceTurn(known)).toBe(true);
    expect(known.stats.type_histogram).toBe(before);
    // Malformed buckets still reject the turn.
    for (const bad of [{ type: "", tool: null, count: 1 }, { type: "command", tool: 3, count: 1 }, { type: "hologram", tool: null, count: -1 }]) {
      expect(isTraceTurn(turn({ stats: { item_count: 0, tool_call_count: 0, process_item_count: 0, type_histogram: [bad] } as never }))).toBe(false);
    }
  });
});
