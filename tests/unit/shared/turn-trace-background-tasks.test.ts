import { describe, expect, it } from "bun:test";
import type {
  TraceAgentMessageItem,
  TraceBackgroundTaskItem,
  TraceCommandItem,
  TraceEvent,
  TraceItem,
  TraceSubagentItem,
  TraceUserMessageDoorbell,
  TraceUserMessageItem,
} from "@multiremi/contracts/trace";
import {
  TRACE_BACKGROUND_TASK_OUTPUT_TAIL_MAX_BYTES,
  TRACE_BACKGROUND_TASK_STOP_REASONS,
  TRACE_ITEM_TYPES,
  TRACE_TOOL_ITEM_TYPES,
  isTraceEventBody,
  isTraceItem,
  isTraceItemType,
  isTraceUserMessageDoorbell,
  knownTraceItems,
} from "@multiremi/contracts/trace";
import { BACKGROUND_TASK_STOP_REASONS } from "@multiremi/contracts/unified-model";
import {
  TRACE_ITEM_LABEL_MAX_BYTES,
  TRACE_ITEM_SUMMARY_MAX_BYTES,
  capOutputTail,
  capTraceEvent,
  capTraceItem,
  outputTailFromBytes,
  utf8ByteLength,
} from "@shared/trace-sanitize.js";
import {
  EMPTY_TURN_TRACE,
  applyTurnTraceEvents,
  backgroundTaskCloseReason,
  backgroundTaskItemId,
  backgroundTaskItems,
  closeOpenItems,
  handOffBackgroundTasks,
  isBackgroundTaskItem,
  isProcessItem,
  isToolItem,
  runningBackgroundTasks,
  selectFinalReply,
  subagentReply,
  subagentToolCount,
  turnTraceStats,
} from "@shared/turn-trace.js";

// The background_task item (PR 6 §4.1): contract, fold rules and caps.

const T0 = Date.parse("2026-10-16T00:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

function task(id: string, facts: Partial<TraceBackgroundTaskItem> = {}): TraceBackgroundTaskItem {
  return {
    id: backgroundTaskItemId(id), parent_id: null, status: "in_progress", started_at: at(1), completed_at: null,
    type: "background_task", task_id: id, task_type: "shell", name: "npm run dev", description: "npm run dev",
    tool_item_id: "call_dev", can_stop: true, summary: null, duration_ms: null, ...facts,
  };
}

function shell(id: string, facts: Partial<TraceCommandItem> = {}): TraceCommandItem {
  return {
    id, parent_id: null, status: "completed", started_at: at(1), completed_at: at(2), type: "command", tool: "Bash",
    source: "shell", command: "npm run dev", cwd: null, actions: [{ type: "unknown", command: "npm run dev" }],
    output: null, exit_code: 0, duration_ms: 1000, ...facts,
  };
}

function message(id: string, text: string, facts: Partial<TraceAgentMessageItem> = {}): TraceAgentMessageItem {
  return { id, parent_id: null, status: "completed", started_at: at(3), completed_at: at(4), type: "agent_message", text, phase: "unknown", ...facts };
}

function agent(id: string, facts: Partial<TraceSubagentItem> = {}): TraceSubagentItem {
  return {
    id, parent_id: null, status: "completed", started_at: at(1), completed_at: at(9), type: "subagent", tool: "Agent",
    title: null, prompt: null, output: null, duration_ms: null, ...facts,
  };
}

/** Statuses as they were before PR 6: ADR 0019 forbids new ones on any item. */
const PRE_PR6_STATUSES = ["in_progress", "completed", "failed", "declined", "stopped"];

describe("background_task contract (PR 6 §4.1)", () => {
  it("is a known item type, and not a tool type", () => {
    expect(TRACE_ITEM_TYPES).toContain("background_task");
    expect(isTraceItemType("background_task")).toBe(true);
    expect(TRACE_TOOL_ITEM_TYPES as readonly string[]).not.toContain("background_task");
  });

  it("accepts a minimal item and one with every optional fact", () => {
    expect(isTraceItem(task("t1"))).toBe(true);
    expect(isTraceItem(task("t1", {
      last_tool_name: "Bash", usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 4000 }, paused: true,
      output_tail: "listening on :3000\n", output_tail_truncated: true,
      stop_request: { requested_at: at(5), by: "user", outcome: "pending" }, stop_reason: null,
    }))).toBe(true);
    expect(isTraceItem(task("t1", { status: "completed", completed_at: at(9), handed_off: true }))).toBe(true);
    expect(isTraceItem(task("t1", { status: "stopped", completed_at: at(9), stop_reason: "turn_end", duration_ms: 8000 }))).toBe(true);
    expect(isTraceItem({ ...task("t1"), extra_future_field: 1 })).toBe(true);
  });

  it("rejects a malformed item", () => {
    const bad: Array<Record<string, unknown>> = [
      { task_id: "" },
      { task_type: null },
      { name: undefined },
      { description: 3 },
      { tool_item_id: undefined },
      { can_stop: "yes" },
      { summary: undefined },
      { usage: { total_tokens: -1, tool_uses: 0, duration_ms: 0 } },
      { usage: { total_tokens: 1 } },
      { paused: false },
      { output_tail: 7 },
      { output_tail_truncated: false },
      { stop_request: { requested_at: "yesterday", by: "user", outcome: "pending" } },
      { stop_request: { requested_at: at(1), by: "admin", outcome: "pending" } },
      { stop_request: { requested_at: at(1), by: "user", outcome: "maybe" } },
      { stop_reason: "keepalive_cap" },
      { handed_off: false },
      { duration_ms: "1s" },
      { status: "parked" },
    ];
    for (const patch of bad) expect(isTraceItem({ ...task("t1"), ...patch }), JSON.stringify(patch)).toBe(false);
  });

  it("keeps the trace's stop reasons a subset of the registry's", () => {
    for (const reason of TRACE_BACKGROUND_TASK_STOP_REASONS) expect(BACKGROUND_TASK_STOP_REASONS as readonly string[]).toContain(reason);
  });

  it("writes only statuses older readers know, so they never misread it (ADR 0019)", () => {
    const written = [
      task("run"),
      task("pause", { paused: true }),
      ...handOffBackgroundTasks([task("hand")], at(9)).map((body) => (body as { item: TraceItem }).item),
      ...(["completed", "failed", "cancelled"] as const).flatMap((outcome) =>
        closeOpenItems([task(`close-${outcome}`)], outcome, at(9)).map((body) => (body as { item: TraceItem }).item)),
    ];
    for (const item of written) {
      expect(PRE_PR6_STATUSES).toContain(item.status);
      expect(isTraceItem(item)).toBe(true);
    }
  });

  it("leaves the forward-compatible path intact: an unknown newer type next to it is dropped, it is kept", () => {
    const items: unknown[] = [shell("call_dev"), task("t1"), { ...task("t2"), type: "background_task_v2" }];
    const known = knownTraceItems(items);
    expect(known?.map((item) => item.id)).toEqual(["call_dev", "bg:t1"]);
    // A damaged item of this (now known) type rejects the list, as for every known type.
    expect(knownTraceItems([task("t1"), { ...task("t2"), can_stop: null }])).toBeNull();
  });
});

describe("user_message doorbells (PR 6 §2.5)", () => {
  const doorbell: TraceUserMessageDoorbell = { task_id: "bash_1", name: "npm test", task_type: "shell", status: "completed" };
  const prompt = (facts: Record<string, unknown> = {}): TraceUserMessageItem => ({
    id: "in:tsk_doorbell", parent_id: null, status: "completed", started_at: at(1), completed_at: at(1), type: "user_message",
    origin: "input", text: "后台任务已结束：npm test（已完成，用时 45 秒）", message_ids: ["msg_doorbell"], attachments: [], steer: null,
    ...facts,
  } as TraceUserMessageItem);

  it("accepts an input or steer item without the field (older traces) and with well-formed doorbells", () => {
    expect(isTraceItem(prompt())).toBe(true);
    expect(isTraceItem(prompt({ background_tasks: [] }))).toBe(true);
    expect(isTraceItem(prompt({ background_tasks: [doorbell, { ...doorbell, task_id: "wf_2", task_type: "workflow", status: "failed" }] }))).toBe(true);
    expect(isTraceItem(prompt({ origin: "steer", background_tasks: [doorbell],
      steer: { steer_id: "st_1", kind: "now", injected: true, author_type: "platform", author_id: null } }))).toBe(true);
    // Extra keys inside an entry are accepted, like every guard here.
    expect(isTraceItem(prompt({ background_tasks: [{ ...doorbell, origin_attempt_id: "tsk_origin" }] }))).toBe(true);
    expect(isTraceUserMessageDoorbell(doorbell)).toBe(true);
  });

  it("rejects a malformed doorbell list or entry", () => {
    const bad: unknown[] = [
      null,
      doorbell,
      "bash_1",
      [null],
      [{ ...doorbell, task_id: "" }],
      [{ ...doorbell, task_id: undefined }],
      [{ ...doorbell, name: null }],
      [{ ...doorbell, task_type: 3 }],
      // A stop never rings, so a doorbell is only ever a completion or a failure.
      [{ ...doorbell, status: "stopped" }],
      [{ ...doorbell, status: "running" }],
      [doorbell, { ...doorbell, status: undefined }],
    ];
    for (const background_tasks of bad) {
      expect(isTraceItem(prompt({ background_tasks })), JSON.stringify(background_tasks)).toBe(false);
    }
  });
});

describe("background_task in the fold (PR 6 §4.1)", () => {
  it("is neither a tool item nor a process item, at any depth", () => {
    const items: TraceItem[] = [shell("call_dev"), task("t1"), task("t2", { parent_id: "sa:1" })];
    expect(items.filter(isToolItem).map((item) => item.id)).toEqual(["call_dev"]);
    expect(isProcessItem(task("t1"))).toBe(false);
    const stats = turnTraceStats(items);
    expect(stats.tool_call_count).toBe(1);
    expect(stats.process_item_count).toBe(1);
    expect(stats.item_count).toBe(3);
    expect(stats.type_histogram).toContainEqual({ type: "background_task", tool: null, count: 2 });
  });

  it("does not block the inferred final reply (rule 2)", () => {
    const selection = selectFinalReply([shell("call_dev"), message("m1", "The dev server is starting."), task("t1")]);
    expect(selection).toMatchObject({ itemId: "m1", rule: "inferred" });
    // A tool after the message still blocks it; the task does not change that.
    expect(selectFinalReply([message("m1", "Starting"), shell("call_2"), task("t1")]).rule).toBe("fallback");
  });

  it("does not count as a subagent's tool or reset its reply", () => {
    const items: TraceItem[] = [
      agent("sa:1"),
      shell("call_child", { parent_id: "sa:1" }),
      message("m_child", "Started the server.", { parent_id: "sa:1" }),
      task("t1", { parent_id: "sa:1", tool_item_id: "call_child" }),
    ];
    expect(subagentToolCount(items, "sa:1")).toBe(1);
    expect(subagentReply(items, "sa:1")?.id).toBe("m_child");
  });

  it("takes no deltas: its output tail is replaced whole", () => {
    const events: TraceEvent[] = [
      { seq: 1, ts: at(1), type: "item.started", item: task("t1") },
      { seq: 2, ts: at(2), type: "item.delta", item_id: "bg:t1", field: "output", delta: "line\n" },
      { seq: 3, ts: at(3), type: "item.updated", item: task("t1", { output_tail: "ready\n" }) },
    ];
    const state = applyTurnTraceEvents(EMPTY_TURN_TRACE, events);
    expect(state.items).toHaveLength(1);
    expect((state.items[0] as TraceBackgroundTaskItem).output_tail).toBe("ready\n");
    expect(state.head).toBe(3);
  });

  it("finds the tasks and the running ones (any depth, paused included)", () => {
    const items: TraceItem[] = [
      shell("call_dev"),
      task("run"),
      task("pause", { paused: true, parent_id: "sa:1" }),
      task("done", { status: "completed", completed_at: at(5) }),
      task("gone", { status: "completed", completed_at: at(5), handed_off: true }),
    ];
    expect(backgroundTaskItems(items).map((item) => item.task_id)).toEqual(["run", "pause", "done", "gone"]);
    expect(runningBackgroundTasks(items).map((item) => item.task_id)).toEqual(["run", "pause"]);
    expect(isBackgroundTaskItem(items[0]!)).toBe(false);
    expect(backgroundTaskItemId("abc")).toBe("bg:abc");
  });
});

describe("ending an attempt with background tasks (PR 6 §2.2, §4.1)", () => {
  it("hands off running tasks as completed, without the paused flag or a duration", () => {
    const items: TraceItem[] = [
      { ...task("run"), seq: 4 },
      task("pause", { paused: true, parent_id: "sa:1" }),
      task("done", { status: "failed", completed_at: at(5), duration_ms: 4000 }),
    ];
    const bodies = handOffBackgroundTasks(items, at(9));
    expect(bodies).toEqual([
      { type: "item.completed", item: { ...task("run"), status: "completed", completed_at: at(9), handed_off: true, duration_ms: null } },
      { type: "item.completed", item: { ...task("pause", { parent_id: "sa:1" }), status: "completed", completed_at: at(9), handed_off: true, duration_ms: null } },
    ]);
    for (const body of bodies) expect(isTraceEventBody(body)).toBe(true);
    // Once handed off, closing the attempt has nothing left to stop.
    const handed = items.map((item) => bodies.map((body) => (body as { item: TraceItem }).item).find((next) => next.id === item.id) ?? item);
    expect(closeOpenItems(handed, "completed", at(10))).toEqual([]);
  });

  it("stops what is left open, with a reason by the turn's outcome", () => {
    expect(backgroundTaskCloseReason("completed")).toBe("turn_end");
    expect(backgroundTaskCloseReason("cancelled")).toBe("cancelled");
    expect(backgroundTaskCloseReason("failed")).toBe("lost");
    for (const [outcome, reason] of [["completed", "turn_end"], ["cancelled", "cancelled"], ["failed", "lost"]] as const) {
      const [body] = closeOpenItems([{ ...task("t1", { paused: true }), seq: 3 }], outcome, at(9));
      expect(body).toEqual({ type: "item.completed", item: {
        ...task("t1"), status: "stopped", completed_at: at(9), stop_reason: reason, duration_ms: 8000,
      } });
      expect(isTraceEventBody(body)).toBe(true);
    }
  });

  it("keeps a stop reason and a duration the task already has, and leaves ended tasks alone", () => {
    const [body] = closeOpenItems([task("t1", { stop_reason: "user", duration_ms: 1234 })], "completed", at(9));
    expect(body).toMatchObject({ item: { status: "stopped", stop_reason: "user", duration_ms: 1234 } });
    expect(closeOpenItems([task("t2", { status: "completed", completed_at: at(5) })], "failed", at(9))).toEqual([]);
  });
});

describe("background_task caps (PR 6)", () => {
  const KiB = 1024;

  it("caps labels, description, summary and the output tail, and flags the tail", () => {
    const long = "x".repeat(TRACE_ITEM_SUMMARY_MAX_BYTES + 100);
    const tail = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const capped = capTraceItem(task("t1", {
      name: "n".repeat(2 * KiB), task_type: "t".repeat(2 * KiB), last_tool_name: "l".repeat(2 * KiB),
      description: long, summary: long, output_tail: tail,
    }));
    expect(utf8ByteLength(capped.name)).toBeLessThanOrEqual(TRACE_ITEM_LABEL_MAX_BYTES + 32);
    expect(utf8ByteLength(capped.task_type)).toBeLessThanOrEqual(TRACE_ITEM_LABEL_MAX_BYTES + 32);
    expect(utf8ByteLength(capped.last_tool_name!)).toBeLessThanOrEqual(TRACE_ITEM_LABEL_MAX_BYTES + 32);
    expect(utf8ByteLength(capped.description!)).toBeLessThanOrEqual(TRACE_ITEM_SUMMARY_MAX_BYTES + 32);
    expect(utf8ByteLength(capped.summary!)).toBeLessThanOrEqual(TRACE_ITEM_SUMMARY_MAX_BYTES + 32);
    expect(utf8ByteLength(capped.output_tail!)).toBeLessThanOrEqual(TRACE_BACKGROUND_TASK_OUTPUT_TAIL_MAX_BYTES);
    expect(capped.output_tail!.startsWith("line ")).toBe(true);
    expect(capped.output_tail!.endsWith("line 999\n")).toBe(true);
    expect(capped.output_tail_truncated).toBe(true);
    expect(isTraceItem(capped)).toBe(true);
    // Re-capping a capped item is a no-op.
    expect(capTraceItem(capped)).toBe(capped);
    expect(capTraceEvent({ type: "item.updated", item: capped })).toEqual({ type: "item.updated", item: capped });
  });

  it("leaves a small item untouched", () => {
    const small = task("t1", { output_tail: "ready\n", summary: "ok" });
    expect(capTraceItem(small)).toBe(small);
  });

  it("takes a tail from a line start, on a character boundary", () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    expect(outputTailFromBytes(encode("short\n"), 16)).toEqual({ value: "short\n", truncated: false });
    // A window that starts mid-line drops the partial line; one that starts at a newline keeps the next line whole.
    expect(outputTailFromBytes(encode("first line\nsecond\nthird\n"), 12)).toEqual({ value: "third\n", truncated: true });
    expect(outputTailFromBytes(encode("first line\nsecond\nthird\n"), 14)).toEqual({ value: "second\nthird\n", truncated: true });
    // One long line keeps its character-aligned end.
    expect(outputTailFromBytes(encode("abcdefghij\n"), 5)).toEqual({ value: "ghij\n", truncated: true });
    // "é" is two bytes: a window that starts inside it moves past it.
    expect(outputTailFromBytes(encode("éééé"), 3)).toEqual({ value: "é", truncated: true });
    expect(capOutputTail(null)).toEqual({ value: null, truncated: false });
    expect(capOutputTail("a".repeat(5 * KiB))).toMatchObject({ truncated: true });
  });
});
