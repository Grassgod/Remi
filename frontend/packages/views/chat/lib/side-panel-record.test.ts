import { describe, expect, it } from "vitest";
import { at, subagent, userMessage } from "../../test/trace-fixtures";
import { chatLogWithSubagents, doorbell, histogram, memberMessage, turnCard } from "./__fixtures__/side-panel";
import {
  chatSubagentTurns,
  defaultPanelTarget,
  logHasBackgroundTasks,
  overviewTurns,
  promptLine,
  runningSubagentCount,
  tracePromptLine,
} from "./side-panel-record";

describe("side panel record", () => {
  it("lists the turns that ran subagents, newest first, with their time and prompt", () => {
    const turns = chatSubagentTurns(chatLogWithSubagents());
    expect(turns).toEqual([
      // Only late completions on its card; the prompt is the card's own.
      { attemptId: "att_3", turnId: "turn_3", live: false, startedAt: Date.parse(at(120)), prompt: "Review the diff" },
      // The member message delivered into the turn names it, on one plain line.
      { attemptId: "att_1", turnId: "turn_1", live: false, startedAt: Date.parse(at(1)), prompt: "Find the trace readers" },
    ]);
  });

  it("adds the running turn once its live trace has a subagent, also before its card is in the window", () => {
    const entries = [...chatLogWithSubagents(), memberMessage("turn_5", "Plan the panel", 240), turnCard("att_5", "turn_5", { status: "running" }, 241)];
    expect(chatSubagentTurns(entries, { attemptId: "att_5", turnId: "turn_5", hasSubagents: false }).map((turn) => turn.attemptId))
      .toEqual(["att_3", "att_1"]);
    expect(chatSubagentTurns(entries, { attemptId: "att_5", turnId: "turn_5", hasSubagents: true })[0])
      .toEqual({ attemptId: "att_5", turnId: "turn_5", live: true, startedAt: Date.parse(at(241)), prompt: "Plan the panel" });
    // No card yet: the trace's start and the delivered message.
    const early = chatSubagentTurns([...chatLogWithSubagents(), memberMessage("turn_6", "Next", 300)],
      { attemptId: "att_6", turnId: "turn_6", hasSubagents: true, startedAt: at(301) });
    expect(early[0]).toEqual({ attemptId: "att_6", turnId: "turn_6", live: true, startedAt: Date.parse(at(301)), prompt: "Next" });
  });

  it("finds background tasks on record from a card that started one or a doorbell line", () => {
    expect(logHasBackgroundTasks(chatLogWithSubagents())).toBe(true);
    expect(logHasBackgroundTasks([turnCard("att_1", "turn_1", { type_histogram: histogram("command") })])).toBe(false);
    expect(logHasBackgroundTasks([doorbell("t1")])).toBe(true);
    // A card that predates the trace stats says nothing.
    expect(logHasBackgroundTasks([turnCard("att_1", "turn_1", { type_histogram: null })])).toBe(false);
  });

  it("opens the newest subagent turn's overview, else the 后台任务 view", () => {
    const turns = chatSubagentTurns(chatLogWithSubagents());
    expect(defaultPanelTarget("chat_1", { turns, tasks: true }))
      .toEqual({ sessionId: "chat_1", view: "subagents", attemptId: "att_3", turnId: "turn_3", live: false, path: [] });
    expect(defaultPanelTarget("chat_1", { turns: [], tasks: true }))
      .toEqual({ sessionId: "chat_1", view: "tasks", attemptId: null, live: false, path: [], task: null });
  });

  it("puts the panel's own attempt in front of the overview when the record does not hold it", () => {
    const turns = chatSubagentTurns(chatLogWithSubagents());
    expect(overviewTurns(turns, { attemptId: "att_1", turnId: "turn_1", live: false })).toBe(turns);
    expect(overviewTurns(turns, { attemptId: null, live: false })).toBe(turns);
    expect(overviewTurns(turns, { attemptId: "att_9", turnId: "turn_9", live: true }).map((turn) => turn.attemptId))
      .toEqual(["att_9", "att_3", "att_1"]);
  });

  it("counts running subagents as the strip does, and reads a prompt line", () => {
    const running = { status: "in_progress" as const, completed_at: null };
    expect(runningSubagentCount([subagent("sa:1", "A", running), subagent("sa:2", "B", { ...running, parent_id: "sa:1" }), subagent("sa:3", "C")])).toBe(1);
    expect(runningSubagentCount([subagent("sa:1", "A"), subagent("sa:2", "B", { ...running, parent_id: "sa:1" })])).toBe(1);
    expect(runningSubagentCount([subagent("sa:1", "A")])).toBe(0);
    expect(promptLine("\n\n## Plan `x`\nmore")).toBe("Plan x");
    expect(promptLine("   ")).toBeNull();
    expect(promptLine("a".repeat(130))).toBe(`${"a".repeat(120)}…`);
    expect(tracePromptLine([subagent("sa:1", "A"), userMessage("in:1", "统计各包文件数")])).toBe("统计各包文件数");
  });
});
