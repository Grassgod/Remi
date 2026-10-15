import { describe, expect, it } from "vitest";
import type { ChatBackgroundTask } from "@multiremi/core/types";
import { BACKGROUND_KEEPALIVE_MS } from "@multiremi/shared/background-tasks";
import { at, command, unknown } from "../../test/trace-fixtures";
import { bgItem, bgTask } from "./__fixtures__/background-tasks";
import {
  BACKGROUND_STOP_SENT_AFTER_MS,
  ENDED_NOTICE_GRACE_MS,
  ENDED_NOTICE_MS,
  backgroundEndedNotices,
  backgroundKeptUntil,
  backgroundLaunchResolver,
  backgroundOutputLines,
  backgroundStopReasonKey,
  backgroundStopState,
  backgroundTaskName,
  backgroundTaskTypeKey,
  canStopBackgroundTask,
  doorbellTaskIds,
  findBackgroundTask,
  formatKeepAliveCap,
  lastBackgroundOutputLine,
  rowDoorbell,
  splitBackgroundTasks,
  stoppableBackgroundTasks,
} from "./background-tasks";
import { buildChildSteps, buildTurnSteps } from "./turn-steps";

const NOW = Date.parse(at(600));

describe("background tasks (PR 6 §8)", () => {
  it("names a row by its name or its command's first line, at most 60 characters, and types it", () => {
    expect(backgroundTaskName(bgTask("a", { name: "  npm test\nmore" }))).toBe("npm test");
    expect(backgroundTaskName(bgTask("a", { name: " ", command: "python3 -m http.server\n# second" }))).toBe("python3 -m http.server");
    expect(backgroundTaskName(bgTask("a", { name: "x".repeat(70) }))).toBe(`${"x".repeat(60)}…`);
    expect(backgroundTaskName(bgTask("a", { name: "", command: null }))).toBe("a");
    expect(["shell", "workflow", "monitor", "mcp_task"].map(backgroundTaskTypeKey)).toEqual(["type_shell", "type_workflow", "type_monitor", null]);
  });

  it("splits running (with unknown) in start order from ended, latest end first", () => {
    const rows = [
      bgTask("late", { started_at: at(30) }),
      bgTask("early", { started_at: at(10), status: "paused" }),
      bgTask("gone", { status: "unknown", started_at: at(20) }),
      bgTask("old", { status: "completed", ended_at: at(40) }),
      bgTask("new", { status: "stopped", ended_at: at(90) }),
    ];
    const { running, done } = splitBackgroundTasks(rows);
    expect(running.map((row) => row.task_id)).toEqual(["early", "gone", "late"]);
    expect(done.map((row) => row.task_id)).toEqual(["new", "old"]);
  });

  it("maps every stop reason to its copy and gives none to an ended task that was not stopped", () => {
    const reason = (stop_reason: ChatBackgroundTask["stop_reason"]) => backgroundStopReasonKey(bgTask("a", { status: "stopped", stop_reason }));
    expect(reason("user")).toBe("stopped_user");
    expect(reason("turn_end")).toBe("stopped_turn_end");
    expect(reason("cancelled")).toBe("stopped_turn_end");
    expect(reason("no_capacity")).toBe("stopped_evicted");
    expect(reason("lost")).toBe("lost");
    expect(reason(null)).toBeNull();
    expect(backgroundStopReasonKey(bgTask("a", { status: "completed", stop_reason: "user" }))).toBeNull();
  });

  it("reads a stop as pending, then sent after 15 s, then answered; only an idle or failed stop can be retried", () => {
    const asked = bgTask("a", { stop_requested_at: at(600), stop_outcome: "pending" });
    expect(backgroundStopState(asked, NOW)).toBe("stopping");
    expect(canStopBackgroundTask(asked, NOW)).toBe(false);
    expect(backgroundStopState(asked, NOW + BACKGROUND_STOP_SENT_AFTER_MS)).toBe("sent");
    const failed = { ...asked, stop_outcome: "failed" as const };
    expect(backgroundStopState(failed, NOW)).toBe("failed");
    expect(canStopBackgroundTask(failed, NOW)).toBe(true);
    expect(backgroundStopState({ ...asked, stop_outcome: "not_running" }, NOW)).toBe("not_running");
    // An ended task has no stop state, and one the bridge cannot stop offers none.
    expect(backgroundStopState({ ...asked, status: "stopped" }, NOW)).toBe("none");
    expect(canStopBackgroundTask(bgTask("b", { can_stop: false }), NOW)).toBe(false);
    expect(stoppableBackgroundTasks([bgTask("c"), asked, bgTask("d", { status: "completed" })], NOW).map((row) => row.task_id)).toEqual(["c"]);
  });

  it("keeps the last 40 output lines and finds the last line with text", () => {
    const tail = Array.from({ length: 50 }, (_, index) => `line ${index}`).join("\n") + "\n\n";
    expect(backgroundOutputLines(tail)).toHaveLength(40);
    expect(backgroundOutputLines(tail)[0]).toBe("line 11");
    expect(lastBackgroundOutputLine("a\r\nb  \n   \n")).toBe("b");
    expect(lastBackgroundOutputLine(null)).toBeNull();
  });

  it("keeps the session until the latest parked_until of a running task, and names the cap per locale", () => {
    expect(backgroundKeptUntil([bgTask("a", { parked_until: at(100) }), bgTask("b", { parked_until: at(200) }),
      bgTask("c", { status: "completed", parked_until: at(900) })])).toBe(Date.parse(at(200)));
    expect(backgroundKeptUntil([bgTask("a", { parked_until: null })])).toBeNull();
    expect(BACKGROUND_KEEPALIVE_MS).toBe(2 * 60 * 60 * 1000);
    expect(formatKeepAliveCap("en")).toBe("2 hours");
    expect(formatKeepAliveCap("zh-Hans")).toMatch(/^2\s?小时$/);
    expect(formatKeepAliveCap("en", 30 * 60_000)).toBe("30 minutes");
  });

  it("gives a notice to Remi's stops and to quiet ends between turns, for 10 minutes, never to the person's own stop", () => {
    const ended = at(500);
    const rows = [
      bgTask("cap", { status: "stopped", stop_reason: "keepalive_cap", ended_at: ended }),
      bgTask("mine", { status: "stopped", stop_reason: "user", stop_requested_by: "mem_1", ended_at: ended }),
      bgTask("turn", { status: "stopped", stop_reason: "turn_end", ended_at: ended }),
      bgTask("codex", { status: "completed", lane_state: "parked", ended_at: at(520) }),
      bgTask("rang", { status: "completed", lane_state: "parked", ended_at: ended }),
      bgTask("in-turn", { status: "failed", lane_state: "in_attempt", ended_at: ended }),
      bgTask("old", { status: "stopped", stop_reason: "daemon_restart", ended_at: at(-200) }),
      bgTask("live"),
    ];
    const notices = (now: number, dismissed: string[] = []) => backgroundEndedNotices(rows,
      { now, doorbells: new Set(["rang"]), dismissed: new Set(dismissed) }).map((row) => row.task_id);
    expect(notices(NOW)).toEqual(["codex", "cap"]);
    // A quiet end waits for a doorbell that may still come.
    expect(notices(Date.parse(at(520)) + ENDED_NOTICE_GRACE_MS - 1)).toEqual(["cap"]);
    expect(notices(NOW, ["bgrow_cap"])).toEqual(["codex"]);
    expect(notices(Date.parse(ended) + ENDED_NOTICE_MS + 1)).toEqual(["codex"]);
  });

  it("reads doorbells only from platform messages and finds a task by its id and provider session", () => {
    const metadata = { background_task: { task_id: "t1", name: "npm test", task_type: "shell", status: "completed",
      origin_attempt_id: "att_1", origin_turn_id: "turn_1", provider_session_id: "ps_1" } };
    expect(rowDoorbell({ kind: "message", sender_type: "platform", metadata })?.task_id).toBe("t1");
    expect(rowDoorbell({ kind: "message", sender_type: "member", metadata })).toBeNull();
    expect([...doorbellTaskIds([{ kind: "message", sender_type: "platform", metadata }, { kind: "turn", metadata }])]).toEqual(["t1"]);
    const rows = [bgTask("t1", { provider_session_id: "ps_old", started_at: at(1) }), bgTask("t1", { id: "bgrow_new", started_at: at(5) })];
    expect(findBackgroundTask(rows, { task_id: "t1", provider_session_id: "ps_old" })?.provider_session_id).toBe("ps_old");
    expect(findBackgroundTask(rows, { task_id: "t1" })?.id).toBe("bgrow_new");
    expect(findBackgroundTask(rows, { task_id: "nope" })).toBeNull();
  });
});

describe("launch rows (PR 6 §8.1 Steps)", () => {
  const launch = command("cmd:1", [unknown("npm run dev")], { title: "Start the dev server" });
  const items = [launch, bgItem("t1", "cmd:1")];

  it("reads the trace when the registry is not loaded, and the registry first when it is", () => {
    const traced = buildTurnSteps(items, { resolveBackgroundTask: backgroundLaunchResolver(items, null, "att_1", false) });
    expect(traced.rows).toHaveLength(1);
    expect(traced.rows[0]!.descriptor).toMatchObject({ key: "background_command_active", args: { command: "Start the dev server" } });
    expect(traced.rows[0]!.icon).toBe("command");
    // The attempt ended and the registry says it still runs: handed off.
    const handed = backgroundLaunchResolver(items, [bgTask("t1")], "att_1", true);
    expect(buildTurnSteps(items, { resolveBackgroundTask: handed }).rows[0]!.descriptor.key).toBe("background_command_handed_off");
    // It ended later; the finished turn's row says how.
    const stopped = backgroundLaunchResolver(items, [bgTask("t1", { status: "stopped", stop_reason: "keepalive_cap" })], "att_1", true);
    const row = buildTurnSteps(items, { resolveBackgroundTask: stopped }).rows[0]!;
    expect(row.descriptor).toMatchObject({ key: "background_command_stopped", state: "stopped" });
    expect(row.icon).toBe("stopped");
    // Another attempt's row with the same task id is not this one's.
    const other = backgroundLaunchResolver(items, [bgTask("t1", { origin_attempt_id: "att_2", status: "failed" })], "att_1", true);
    expect(buildTurnSteps(items, { resolveBackgroundTask: other }).rows[0]!.descriptor.key).toBe("background_command_active");
  });

  it("gives a workflow its own glyph, keeps a multi-action command to one row, and adds no row for the task item", () => {
    const flow = command("cmd:2", [unknown("a"), unknown("b")]);
    const all = [flow, bgItem("w1", "cmd:2", { task_type: "workflow", name: "release-check" })];
    const steps = buildTurnSteps(all, { resolveBackgroundTask: backgroundLaunchResolver(all, null, "att_1", false) });
    expect(steps.rows.map((row) => [row.key, row.descriptor.key, row.icon])).toEqual([["cmd:2:0", "background_workflow_active", "workflow"]]);
    expect(steps.processCount).toBe(1);
    expect(backgroundLaunchResolver([command("cmd:3", [unknown("ls")])], [bgTask("t1")], "att_1", true)).toBeUndefined();
  });

  it("hides a task inside a subagent as a breaker and reads its launch row as the task", () => {
    const child = command("cmd:c", [unknown("pytest -x")], { parent_id: "sa:1" });
    const all = [child, bgItem("c1", "cmd:c", { parent_id: "sa:1", status: "completed", handed_off: true })];
    const steps = buildChildSteps(all, "sa:1", { resolveBackgroundTask: backgroundLaunchResolver(all, null, "att_1", true) });
    expect(steps.blocks.map((block) => block.kind)).toEqual(["row"]);
    expect(steps.rows[0]!.descriptor.key).toBe("background_command_handed_off");
  });
});
