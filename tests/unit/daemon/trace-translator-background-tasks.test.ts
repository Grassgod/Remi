/**
 * Background-task items in the trace translator (PR 6 §4.2): one
 * `background_task` item per AIR task (`bg:<id>`), its lifecycle from
 * `async_task_*` frames without splitting a streaming message, the
 * "backgrounded" marker, the stop notice it absorbs, the stop / end / hand-off
 * facts the daemon reports, the autonomous-round rule for a task that ended,
 * the activity counts, and the doorbells on a turn's `user_message`.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createAdapter } from "@acp/index.js";
import type { ProviderEvent } from "@shared/contracts/provider-types.js";
import { TRACE_TOOL_ITEM_TYPES, type TraceEvent, type TraceEventInput, type TraceItem, type TraceItemOf } from "@multiremi/contracts/trace.js";
import { EMPTY_TURN_TRACE, applyTurnTraceEvents, closeOpenItems, isProcessItem, type TurnTraceState } from "@shared/turn-trace.js";
import { capTraceItem } from "@shared/trace-sanitize.js";
import { createTraceTranslator, type TraceActivityCounts, type TraceTranslatorOptions } from "@multiremi/worker/trace-translator.js";

const T0 = Date.parse("2026-10-16T08:00:00.000Z");
const CHILD = "a0000000000000001";

function harness(agentType: "claude" | "codex", options: Partial<TraceTranslatorOptions> = {},
  input: Array<Record<string, unknown>> = [{ id: "msg_in", body_md: "Run the tests", metadata: {} }]) {
  let tick = 0;
  const now = () => new Date(T0 + tick * 1000).toISOString();
  const events: TraceEvent[] = [];
  let state: TurnTraceState = EMPTY_TURN_TRACE;
  const translator = createTraceTranslator(createAdapter(agentType), (batch: TraceEventInput[]) => {
    const stored = batch.map((body, index) => ({ ...body, seq: events.length + index + 1, ts: now() }) as TraceEvent);
    events.push(...stored);
    state = applyTurnTraceEvents(state, stored);
  }, { now: () => { tick++; return now(); }, nowMs: () => T0 + tick * 1000, flushIntervalMs: 60_000, ...options });
  translator.start({ attemptId: "tsk_attempt", turnId: "turn_1", agentId: "agt_1", agentName: "Remi", provider: agentType,
    requestedModel: null, input: input as never });
  const h = {
    translator,
    events,
    get state() { return state; },
    feed(updates: Array<Record<string, unknown>>) {
      for (const update of updates) translator.acp(update as unknown as ProviderEvent);
      return h;
    },
    item<T extends TraceItem["type"]>(id: string, type?: T): TraceItemOf<T> {
      const item = state.items.find((candidate) => candidate.id === id);
      if (!item) throw new Error(`no item ${id}; have ${state.items.map((candidate) => candidate.id).join(", ")}`);
      if (type) expect(item.type).toBe(type);
      return item as TraceItemOf<T>;
    },
  };
  return h;
}

const chunk = (text: string, extra: Record<string, unknown> = {}) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text }, ...extra });
const spawned = (id: string, extra: Record<string, unknown> = {}) => ({ sessionUpdate: "async_task_spawned", asyncTaskId: id,
  name: "npm test", taskType: "shell", description: "npm test", showInTranscript: false, canStop: true, ...extra });
const ended = (id: string, state: string, extra: Record<string, unknown> = {}) =>
  ({ sessionUpdate: "async_task_state_update", asyncTaskId: id, state, ...extra });
const bash = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ sessionUpdate: status === "pending" ? "tool_call" : "tool_call_update",
  toolCallId: id, name: "Bash", kind: "execute", status, title: "npm test", rawInput: { command: "npm test", run_in_background: true },
  _meta: { claudeCode: { toolName: "Bash" } }, ...extra });
const marker = { jetbrains: { air: { asyncTasks: { backgrounded: true } } } };
const result = (origin: string) => ({ sessionUpdate: "usage_update", used: 10, size: 1_000, _meta: { "_claude/origin": { kind: origin } } });

describe("background_task items", () => {
  it("a Claude shell: announced before its call's result, linked to it, ended with its duration; not a tool or process item", () => {
    const h = harness("claude").feed([
      chunk("Starting the tests. "),
      bash("toolu_bash", "pending"),
      // claude-agent-acp publishes the spawn (with the call id) before the Bash result (dist/acp-agent.js:5511-5515).
      spawned("bash-1", { toolCallId: "toolu_bash", outputFilePath: "/tmp/x/tasks/bash-1.output" }),
      bash("toolu_bash", "completed", { rawOutput: "Command running in background with ID: bash-1", _meta: { ...marker, claudeCode: { toolName: "Bash" } } }),
      chunk("They run in the background."),
    ]);
    const task = h.item("bg:bash-1", "background_task");
    expect(task).toMatchObject({ parent_id: null, status: "in_progress", task_id: "bash-1", task_type: "shell", name: "npm test",
      tool_item_id: "toolu_bash", can_stop: true, summary: null, duration_ms: null });
    // No output path in the trace (§4.1).
    expect(JSON.stringify(task)).not.toContain("tasks/bash-1.output");
    const started = h.events.findIndex((event) => event.type === "item.started" && (event as { item: TraceItem }).item.id === "bg:bash-1");
    const callDone = h.events.findIndex((event) => event.type === "item.completed" && (event as { item: TraceItem }).item.id === "toolu_bash");
    expect(started).toBeLessThan(callDone);
    expect(isProcessItem(task)).toBe(false);
    h.feed([ended("bash-1", "completed", { summary: "42 passed" })]);
    expect(h.item("bg:bash-1")).toMatchObject({ status: "completed", summary: "42 passed", duration_ms: expect.any(Number) });
    expect((TRACE_TOOL_ITEM_TYPES as readonly string[]).includes("background_task")).toBe(false);
  });

  it("never splits a streaming message", () => {
    const h = harness("claude").feed([chunk("Hello "), spawned("bash-1"), chunk("world")]);
    h.translator.flush();
    const messages = h.state.items.filter((item) => item.type === "agent_message");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ text: "Hello world", status: "in_progress" });
  });

  it("a task started inside a native child sits under its agent; progress, pause and a corrected level-closed stop", () => {
    const h = harness("claude").feed([
      { sessionUpdate: "subagent_spawned", subagentSessionId: CHILD, name: "Reviewer", task: "t", prompt: "t", capabilities: {} },
      spawned("wf-1", { taskType: "workflow", name: "review", _meta: { remiSessionId: CHILD } }),
      { sessionUpdate: "async_task_progress", asyncTaskId: "wf-1", summary: "step 2", lastToolName: "Read",
        usage: { totalTokens: 120, toolUses: 3, durationMs: 4_000 }, _meta: { remiSessionId: CHILD } },
      ended("wf-1", "paused"),
    ]);
    expect(h.item("bg:wf-1")).toMatchObject({ parent_id: `sa:${CHILD}`, task_type: "workflow", summary: "step 2", last_tool_name: "Read",
      usage: { total_tokens: 120, tool_uses: 3, duration_ms: 4_000 }, paused: true, status: "in_progress" });
    h.feed([ended("wf-1", "running")]);
    expect(h.item("bg:wf-1", "background_task").paused).toBeUndefined();
    h.feed([ended("wf-1", "stopped"), ended("wf-1", "completed"), ended("wf-1", "failed")]);
    expect(h.item("bg:wf-1")).toMatchObject({ status: "completed" });
  });

  it("a stop Remi asked for: the request, the bridge's answer, its notice absorbed, `user` as the reason", () => {
    const h = harness("claude").feed([spawned("bash-1"), chunk("ok")]);
    h.translator.backgroundTaskStopRequested("bash-1", { by: "user", requested_at: "2026-10-16T08:01:00.000Z" });
    expect(h.item("bg:bash-1", "background_task").stop_request).toEqual({ requested_at: "2026-10-16T08:01:00.000Z", by: "user", outcome: "pending" });
    h.feed([{ sessionUpdate: "notice", severity: "info", title: "Task stopped by user" }, ended("bash-1", "stopped")]);
    h.translator.backgroundTaskStopResult("bash-1", "stopped");
    expect(h.item("bg:bash-1")).toMatchObject({ status: "stopped", stop_reason: "user",
      stop_request: { by: "user", outcome: "stopped" } });
    expect(h.state.items.filter((item) => item.type === "notice")).toHaveLength(0);
    // An unasked stop notice is kept.
    h.feed([{ sessionUpdate: "notice", severity: "info", title: "Task stopped by user" }]);
    expect(h.state.items.filter((item) => item.type === "notice")).toHaveLength(1);
  });

  it("the attempt ends without parking: tasks Remi stops carry `turn_end`, and a leftover one gets it at the close", () => {
    const h = harness("claude").feed([spawned("a"), spawned("b"), chunk("done")]);
    h.translator.backgroundTasksEnding("turn_end");
    h.translator.backgroundTaskStopRequested("a", { by: "remi", requested_at: "2026-10-16T08:01:00.000Z" });
    h.feed([ended("a", "stopped")]);
    expect(h.item("bg:a")).toMatchObject({ status: "stopped", stop_reason: "turn_end" });
    const close = closeOpenItems(h.state.items, "completed", "2026-10-16T08:02:00.000Z");
    const b = close.map((body) => (body as { item: TraceItem }).item).find((item) => item.id === "bg:b");
    expect(b).toMatchObject({ status: "stopped", stop_reason: "turn_end" });
  });

  it("parking hands running tasks off as completed, closes a still-open launch, and a later frame of the attempt reopens one", () => {
    const counts: TraceActivityCounts[] = [];
    // Codex: the terminal's command item stays open while it runs, and the announcement comes after the marker.
    const h = harness("codex", { onActivity: (value) => counts.push(value) }).feed([
      { sessionUpdate: "tool_call", toolCallId: "call_1", kind: "execute", status: "in_progress", title: "python3 -m http.server",
        rawInput: { command: ["python3", "-m", "http.server"] } },
      { sessionUpdate: "tool_call_update", toolCallId: "call_1", _meta: marker },
      spawned("thr:call_1", { name: "python3 -m http.server", toolCallId: "call_1", showInTranscript: false }),
      chunk("The server runs."),
    ]);
    expect(h.translator.runningBackgroundTasks.map((item) => item.id)).toEqual(["bg:thr:call_1"]);
    // A steer's abort leaves the backgrounded call open (§4.2).
    h.translator.roundAborted();
    h.translator.promptEnded({ aborted: true });
    expect(h.item("call_1").status).toBe("in_progress");
    h.translator.backgroundTasksHandedOff();
    expect(h.item("bg:thr:call_1")).toMatchObject({ status: "completed", handed_off: true, duration_ms: null });
    expect(h.item("call_1").status).toBe("completed");
    expect(h.translator.runningBackgroundTasks).toEqual([]);
    expect(counts.map((value) => value.backgroundTasks)).toEqual([1, 0]);
    h.feed([ended("thr:call_1", "running")]);
    expect(h.item("bg:thr:call_1")).toMatchObject({ status: "in_progress" });
    expect(h.item("bg:thr:call_1", "background_task").handed_off).toBeUndefined();
    expect(counts.at(-1)!.backgroundTasks).toBe(1);
    // The close of a trace whose task was handed off leaves it as it was.
    h.translator.backgroundTasksHandedOff();
    const close = closeOpenItems(h.state.items, "completed", "2026-10-16T08:02:00.000Z");
    expect(close.map((body) => (body as { item: TraceItem }).item.id)).not.toContain("bg:thr:call_1");
  });

  it("a task first seen by its end (started in an earlier attempt) takes its name from the provider's registry", () => {
    const h = harness("claude", { backgroundTaskInfo: (id) => id === "bash-old"
      ? { name: "sleep 20; echo done", taskType: "shell", description: null, toolCallId: "toolu_old", canStop: true, startedAt: T0 - 60_000, sessionId: null }
      : null });
    h.feed([ended("bash-old", "completed", { summary: "done" })]);
    expect(h.item("bg:bash-old")).toMatchObject({ status: "completed", name: "sleep 20; echo done", tool_item_id: "toolu_old",
      started_at: new Date(T0 - 60_000).toISOString(), summary: "done" });
  });

  it("the output tail", () => {
    const h = harness("claude").feed([spawned("bash-1")]);
    h.translator.backgroundTaskOutput("bash-1", "line 1\nline 2\n", true);
    expect(h.item("bg:bash-1")).toMatchObject({ output_tail: "line 1\nline 2\n", output_tail_truncated: true });
    h.translator.backgroundTaskOutput("bash-1", "short", false);
    expect(h.item("bg:bash-1", "background_task").output_tail_truncated).toBeUndefined();
  });
});

describe("owesAutonomousRound with background tasks (Claude)", () => {
  it("a task that ended after the cycle began, with no later tool result, owes a round; a stop never does", () => {
    const h = harness("claude").feed([chunk("Started."), spawned("a"), spawned("b"), result("human")]);
    h.translator.promptEnded();
    expect(h.translator.owesAutonomousRound).toBe(false);
    h.feed([ended("b", "stopped")]);
    expect(h.translator.owesAutonomousRound).toBe(false);
    h.feed([ended("a", "completed")]);
    expect(h.translator.owesAutonomousRound).toBe(true);
    // The notification cycle that began after the end carried it.
    h.feed([chunk("Tests passed."), result("task-notification")]);
    expect(h.translator.owesAutonomousRound).toBe(false);
  });

  it("an end while a cycle already runs is carried by a later root tool result, else owes the next cycle", () => {
    const h = harness("claude").feed([spawned("a"), spawned("b"), chunk("Working."), ended("a", "completed")]);
    expect(h.translator.owesAutonomousRound).toBe(true);
    h.feed([bash("toolu_ls", "pending"), bash("toolu_ls", "completed", { rawOutput: "ok" })]);
    expect(h.translator.owesAutonomousRound).toBe(false);
    // b ends inside the cycle, after its last tool result: that cycle's own result does not cover it.
    h.feed([ended("b", "failed"), chunk("Done."), result("human")]);
    expect(h.translator.owesAutonomousRound).toBe(true);
  });

  it("Codex never owes one: its tasks wake nothing", () => {
    const h = harness("codex").feed([spawned("a"), chunk("ok"), ended("a", "completed")]);
    expect(h.translator.owesAutonomousRound).toBe(false);
  });
});

describe("doorbells on user_message", () => {
  const doorbell = (taskId: string, status: "completed" | "failed") => ({ background_task: { task_id: taskId, name: "npm test", task_type: "shell",
    status, origin_attempt_id: "tsk_origin", origin_turn_id: "turn_0", provider_session_id: "sess_root" } });

  it("the input lists its doorbells in order; an ordinary input has none", () => {
    const h = harness("claude", {}, [
      { id: "msg_bell_1", body_md: "后台任务已结束：npm test（已完成）", metadata: doorbell("bash-1", "completed") },
      { id: "msg_user", body_md: "and then?", metadata: {} },
      { id: "msg_bell_2", body_md: "后台任务已结束：npm test（失败）", metadata: doorbell("bash-2", "failed") },
      { id: "msg_bad", body_md: "x", metadata: { background_task: { task_id: "bash-3" } } },
    ]);
    expect(h.item("in:tsk_attempt", "user_message").background_tasks).toEqual([
      { task_id: "bash-1", name: "npm test", task_type: "shell", status: "completed" },
      { task_id: "bash-2", name: "npm test", task_type: "shell", status: "failed" },
    ]);
    const plain = harness("claude");
    expect("background_tasks" in plain.item("in:tsk_attempt", "user_message")).toBe(false);
  });

  it("a doorbell steered into a running turn lists it on the steer item", () => {
    const h = harness("claude");
    h.translator.steer([
      { id: "msg_bell", taskId: "tsk_attempt", kind: "steer", content: "后台任务已结束", authorType: "system", authorId: null,
        createdAt: "2026-10-16T08:01:00.000Z", consumedAt: null, metadata: doorbell("bash-9", "completed") } as never,
      { id: "msg_user", taskId: "tsk_attempt", kind: "steer", content: "hi", authorType: "user", authorId: "mem_1",
        createdAt: "2026-10-16T08:01:01.000Z", consumedAt: null } as never,
    ], { via: "native", native_outcome: "injected", error: null });
    expect(h.item("steer:msg_bell", "user_message").background_tasks).toEqual([
      { task_id: "bash-9", name: "npm test", task_type: "shell", status: "completed" },
    ]);
    expect("background_tasks" in h.item("steer:msg_user", "user_message")).toBe(false);
  });

  it("the sanitizer caps a doorbell's name and type like a background task's labels", () => {
    const long = "x".repeat(2_000);
    const item = capTraceItem({ id: "in:a", parent_id: null, status: "completed", started_at: "2026-10-16T08:00:00.000Z",
      completed_at: "2026-10-16T08:00:00.000Z", type: "user_message", origin: "input", text: "t", message_ids: [], attachments: [],
      background_tasks: [{ task_id: "t1", name: long, task_type: long, status: "completed" }], steer: null } as TraceItem);
    const doorbell = (item as TraceItemOf<"user_message">).background_tasks![0]!;
    expect(doorbell.name.length).toBeLessThan(600);
    expect(doorbell.task_type.length).toBeLessThan(600);
  });
});

describe("the claude-agent-acp 0.90 live capture (tests/fixtures/acp/claude-090-async-task-doorbell.json)", () => {
  // Rows as the other live captures: the prompt's frames, a `parked` marker, then what arrived while parked.
  const rows = JSON.parse(readFileSync(new URL("../../fixtures/acp/claude-090-async-task-doorbell.json", import.meta.url), "utf8")) as Array<{
    remi?: string; params?: { update?: Record<string, unknown> } }>;
  const parkedAt = rows.findIndex((row) => row.remi === "parked");
  const phase = (name: "prompt" | "parked_then_attached") => (name === "prompt" ? rows.slice(0, parkedAt) : rows.slice(parkedAt + 1))
    .flatMap((row) => row.params?.update ? [row.params.update] : []);

  it("turn 1: the spawn precedes the Bash result, the launch is linked, and the task is handed off when the lane parks", () => {
    const h = harness("claude").feed(phase("prompt"));
    h.translator.promptEnded();
    const spawnedAt = h.events.findIndex((event) => event.type === "item.started" && (event as { item: TraceItem }).item.type === "background_task");
    const task = h.state.items.find((item) => item.type === "background_task")!;
    const launch = h.state.items.find((item) => item.id === (task as TraceItemOf<"background_task">).tool_item_id)!;
    expect(launch.type).toBe("command");
    expect(spawnedAt).toBeLessThan(h.events.findIndex((event) => event.type === "item.completed" && (event as { item: TraceItem }).item.id === launch.id));
    // The bridge names a shell after the Bash tool's description, not its command.
    expect(task).toMatchObject({ task_type: "shell", name: "Sleep 20 seconds then print done", status: "in_progress" });
    expect(h.translator.owesAutonomousRound).toBe(false);
    h.translator.backgroundTasksHandedOff();
    expect(h.item(task.id)).toMatchObject({ status: "completed", handed_off: true });
  });

  it("the doorbell attempt: the parked end and the task-notification cycle; the reply is the cycle's", () => {
    const h = harness("claude", { backgroundTaskInfo: () => ({ name: "Sleep 20 seconds then print done", taskType: "shell", description: null,
      toolCallId: "toolu_01BxebSrKQzmNMgetis8Vscx", canStop: true, startedAt: T0 - 20_000, sessionId: null }) });
    h.feed(phase("parked_then_attached"));
    h.translator.promptEnded();
    expect(h.state.items.find((item) => item.type === "background_task")).toMatchObject({ status: "completed", name: "Sleep 20 seconds then print done" });
    expect(h.translator.owesAutonomousRound).toBe(false);
    expect(h.translator.settle().text).toContain("finished with exit code 0");
  });
});
