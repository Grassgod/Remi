import { describe, expect, it } from "vitest";
import type { TraceItem } from "@multiremi/contracts/trace";
import { formatStepCopy, type StepSummaryFragment } from "@multiremi/shared/trace-step-copy";
import { processItemCount } from "@multiremi/shared/turn-trace";
import en from "../../locales/en/chat.json";
import ja from "../../locales/ja/chat.json";
import ko from "../../locales/ko/chat.json";
import zh from "../../locales/zh-Hans/chat.json";
import {
  at, change, command, compaction, fileChange, listFiles, message, notice, permission, plan, read, reasoning, search,
  subagent, tool, traceTurn, unknown, userMessage, webSearch,
} from "../../test/trace-fixtures";
import {
  buildChildSteps,
  buildTurnSteps,
  finishedFoldHeader,
  isAwaitingHuman,
  groupIcon,
  groupSummary,
  joinSummary,
  liveBlockKey,
  liveFoldHeader,
  liveLabel,
  reasoningHeadline,
  stepRows,
} from "./turn-steps";

const running = { status: "in_progress" as const, completed_at: null };
/** Turn shapes the fold sees: a Codex run, a Claude run with a subagent, a run waiting on a person. */
const FIXTURES: TraceItem[][] = [
  [userMessage("in:1", "fix it"), reasoning("rsn:1", "**Plan**"), command("cmd_1", [read("a.ts"), search("x", "src")]),
    message("msg:1", "Looking."), fileChange("fc_1", [change("a.ts")]), webSearch("ws_1", "q"), message("msg:f", "Done.", "final")],
  [userMessage("in:2", "explore"), subagent("sub_1", "Explore"), command("cmd_c", [read("b.ts")], { parent_id: "sub_1" }),
    message("msg:c", "child", "unknown", { parent_id: "sub_1" }), message("msg:empty", ""), tool("t_1", "mcp__x__y"),
    plan([{ content: "a", status: "completed", priority: null }]), compaction("cmp:1"), notice("ntc:1", "slow")],
  [userMessage("in:3", "deploy"), command("cmd_2", [unknown("make deploy")], running), permission("perm:1", "Bash")],
];

describe("split", () => {
  it("keeps finals, the user message, permissions and questions out of the process", () => {
    const steps = buildTurnSteps([
      userMessage("in:att_1", "please fix"),
      message("msg:1", "Looking at the list first."),
      reasoning("rsn:1", "**Planning**"),
      command("cmd_1", [read("src/a.ts")]),
      permission("perm:1", "Bash"),
      message("msg:2", "Done.", "final"),
    ]);
    expect(steps.finals.map((item) => item.id)).toEqual(["msg:2"]);
    // msg:1 and cmd_1: the card's process_item_count rule (reasoning draws no row).
    expect(steps.processCount).toBe(2);
    expect(steps.blocks.map((block) => block.key)).toEqual(["item:msg:1", "row:cmd_1:0"]);
  });

  it("counts only process items that draw something: no reasoning, no empty messages", () => {
    const steps = buildTurnSteps([message("msg:empty", "  "), reasoning("rsn:1", "x"), command("cmd_1", [read("a.ts")])]);
    expect(steps.processCount).toBe(1);
  });

  // The card's process_item_count (spec §10 D-count) and the fold must agree,
  // reasoning and empty messages included: neither draws a row.
  it("agrees with the shared processItemCount on every fixture", () => {
    for (const items of FIXTURES) expect(buildTurnSteps(items).processCount).toBe(processItemCount(items));
  });

  it("treats child items as the subagent's own steps, never as finals", () => {
    const steps = buildTurnSteps([
      subagent("agent_1", "Explore"),
      command("cmd_c", [read("b.ts")], { parent_id: "agent_1" }),
      message("msg:c", "child says done", "final", { parent_id: "agent_1" }),
    ]);
    expect(steps.finals).toEqual([]);
    expect(steps.blocks.map((block) => block.kind)).toEqual(["breaker"]);
    const children = buildChildSteps([subagent("agent_1", "Explore"), command("cmd_c", [read("b.ts")], { parent_id: "agent_1" }),
      message("msg:c", "child says done", "final", { parent_id: "agent_1" })], "agent_1");
    expect(children.blocks.map((block) => block.key)).toEqual(["row:cmd_c:0", "item:msg:c"]);
  });
});

describe("rows", () => {
  it("gives one row per parsed command action, keyed by index", () => {
    const rows = stepRows(command("cmd_1", [read("src/a.ts"), search("todo", "src"), listFiles("docs"), unknown("make")]));
    expect(rows.map((r) => [r.key, r.descriptor.key, r.icon, r.category])).toEqual([
      ["cmd_1:0", "read_done", "read", "explore"],
      ["cmd_1:1", "search_query_path_done", "search", "explore"],
      ["cmd_1:2", "list_files_path_done", "list", "explore"],
      ["cmd_1:3", "run_done", "command", "command"],
    ]);
  });

  it("keeps a failed run reading as run and a stopped one as stopped", () => {
    expect(stepRows(command("cmd_1", [unknown("bun test")], { status: "failed", exit_code: 1 }))[0]!.descriptor)
      .toMatchObject({ key: "run_done", args: { command: "bun test" } });
    const stopped = stepRows(command("cmd_2", [unknown("sleep 9")], { status: "stopped" }))[0]!;
    expect([stopped.descriptor.key, stopped.icon]).toEqual(["run_stopped", "stopped"]);
  });

  it("gives a command the model titled one row under its title (spec §13)", () => {
    const titled = command("cmd_t", [unknown("sleep 25"), listFiles("/w")], { title: "Sleep 25s then list directory" });
    const rows = stepRows(titled);
    expect(rows.map((r) => [r.key, r.descriptor.key, r.descriptor.args.title, r.icon, r.category, r.part])).toEqual([
      ["cmd_t:0", "titled_done", "Sleep 25s then list directory", "command", "command", undefined],
    ]);
    // A single parsed read keeps its glyph and category; an interrupted one shows stopped.
    expect(stepRows(command("cmd_r", [read("a.ts")], { title: "Read the config" })).map((r) => [r.icon, r.category]))
      .toEqual([["read", "explore"]]);
    const stopped = stepRows({ ...titled, status: "stopped" })[0]!;
    expect([stopped.descriptor.key, stopped.icon]).toEqual(["titled_stopped", "stopped"]);
    expect(stepRows(command("cmd_n", [read("a.ts"), read("b.ts")], { title: " " }))).toHaveLength(2);
  });

  it("names a running background subagent and keeps the label quiet under it (spec §13)", () => {
    const steps = buildTurnSteps([subagent("sub_bg", "Count files", { ...running, background: true })]);
    const [block] = steps.blocks;
    expect(block).toMatchObject({ kind: "breaker", descriptor: { key: "subagent_background", args: { title: "Count files" }, state: "active" } });
    expect(steps.breakerRunning).toBe(true);
    expect(liveLabel(steps).kind).toBe("quiet");
    expect(buildTurnSteps([subagent("sub_bg", "Count files", { background: true })]).blocks[0])
      .toMatchObject({ descriptor: { key: "subagent_done" } });
  });

  it("folds a declined multi-action command into one refused run", () => {
    const rows = stepRows(command("cmd_1", [read("a.ts"), read("b.ts")], { status: "declined" }));
    expect(rows.map((r) => r.descriptor.key)).toEqual(["run_declined"]);
  });

  it("gives one row per changed file and one for web searches and tools", () => {
    expect(stepRows(fileChange("fc_1", [change("a.ts", "add"), change("b.ts"), change("c.ts", "delete")]))
      .map((r) => r.descriptor.key)).toEqual(["create_done", "edit_done", "delete_done"]);
    expect(stepRows(webSearch("ws_1", "acp spec")).map((r) => r.descriptor.key)).toEqual(["web_search_detail_done"]);
    expect(stepRows(tool("t_1", "mcp__linear__search")).map((r) => r.key)).toEqual(["t_1"]);
    expect(stepRows(reasoning("rsn:1", "hm"))).toEqual([]);
  });

  it("marks in-progress rows active with their running copy", () => {
    const [row] = stepRows(command("cmd_1", [read("a.ts")], { status: "in_progress", completed_at: null }));
    expect(row).toMatchObject({ active: true, descriptor: { key: "read_active", state: "active" } });
  });
});

describe("groups", () => {
  it("groups two or more consecutive rows and lets reasoning sit inside a run", () => {
    const steps = buildTurnSteps([
      command("cmd_1", [read("a.ts")]),
      reasoning("rsn:1", "next"),
      command("cmd_2", [search("x")]),
      message("msg:1", "Found it."),
      command("cmd_3", [unknown("bun test")]),
      compaction("cmp:1"),
      fileChange("fc_1", [change("a.ts"), change("b.ts")]),
    ]);
    expect(steps.blocks.map((block) => block.kind === "group" ? [block.kind, block.rows.length] : [block.kind])).toEqual([
      ["group", 2], ["breaker"], ["row"], ["breaker"], ["group", 2],
    ]);
  });

  it("breaks runs at commentary, compaction, subagents, the plan and notices, but not at empty text", () => {
    const steps = buildTurnSteps([
      command("cmd_1", [read("a.ts")]), message("msg:empty", "  "), command("cmd_2", [read("b.ts")]),
      plan([{ content: "x", status: "pending", priority: null }]), command("cmd_3", [read("c.ts")]),
      notice("ntc:1", "Rate limited"), subagent("sub_1", "Explore"),
    ]);
    expect(steps.blocks.map((block) => block.kind)).toEqual(["group", "breaker", "row", "breaker", "breaker"]);
    expect(steps.blocks.filter((block) => block.kind === "breaker").map((block) => block.kind === "breaker" && block.icon))
      .toEqual(["plan", "notice", "subagent"]);
  });

  it("marks a group active while any row runs and puts the live label on the block holding its row", () => {
    const running = buildTurnSteps([command("cmd_1", [read("a.ts")]), command("cmd_2", [read("b.ts")], { status: "in_progress", completed_at: null })]);
    expect(running.blocks[0]).toMatchObject({ kind: "group", active: true });
    expect(liveBlockKey(running, liveLabel(running))).toBe("group:cmd_1:0");
    const idle = buildTurnSteps([command("cmd_1", [read("a.ts")]), message("msg:1", "hm")]);
    expect(liveBlockKey(idle, liveLabel(idle))).toBeNull();
    // A held label of a finished row still points at that row's block.
    const held = { id: "step:cmd_1:0", kind: "step" as const, descriptor: idle.rows[0]!.descriptor, icon: "read" as const };
    expect(liveBlockKey(idle, held)).toBe("row:cmd_1:0");
    expect(liveBlockKey(idle, { ...held, id: "step:gone:0" })).toBeNull();
  });
});

describe("summaries", () => {
  const rows = buildTurnSteps([
    command("cmd_1", [unknown("bun test"), read("a.ts")]),
    fileChange("fc_1", [change("a.ts")]),
    webSearch("ws_1", "q"),
    command("cmd_2", [search("x")]),
  ]).rows;

  it("orders fragments by category, never by time, and counts only pick the plural", () => {
    expect(groupSummary(rows).map((f) => [f.key, f.count])).toEqual([
      ["summary_edit_first", 1], ["summary_explore_rest", 2], ["summary_command_rest", 1], ["summary_web_rest", 1],
    ]);
    expect(groupIcon(rows)).toBe("edit");
  });

  it.each([
    ["zh-Hans", zh, "编辑了文件，读取文件，运行了命令，已搜索网页"],
    ["ja", ja, "ファイルを編集しました、ファイルを読み込みました、コマンドを実行しました、ウェブを検索しました"],
    ["ko", ko, "파일 편집함, 파일 읽음, 명령 실행함, 웹 검색함"],
    ["en", en, "Edited a file, read files, ran a command, searched the web"],
  ] as const)("joins %s with its own separator", (_locale, bundle, expected) => {
    const copy = bundle.steps as Record<string, string>;
    const translate = (fragment: StepSummaryFragment) => formatStepCopy(fragment.key, {}, { count: fragment.count, copy });
    expect(joinSummary(groupSummary(rows), translate, bundle.turn_steps.summary_separator, copy.summary_empty!)).toBe(expected);
  });

  it("uses the plural form in en for more than one file", () => {
    const copy = en.steps as Record<string, string>;
    const many = buildTurnSteps([fileChange("fc_1", [change("a.ts"), change("b.ts")])]).rows;
    const [fragment] = groupSummary(many);
    expect(formatStepCopy(fragment!.key, {}, { count: fragment!.count, copy })).toBe("Edited files");
  });
});

describe("live label", () => {
  it("prefers the last in-progress row", () => {
    const steps = buildTurnSteps([
      reasoning("rsn:1", "**Planning**"),
      command("cmd_1", [read("a.ts")], { status: "in_progress", completed_at: null }),
      command("cmd_2", [unknown("bun test")], { status: "in_progress", completed_at: null }),
    ]);
    expect(liveLabel(steps)).toMatchObject({ kind: "step", id: "step:cmd_2:0", descriptor: { key: "run_active" }, icon: "command" });
  });

  it("is quiet while a breaker is still in progress, so no thinking line sits under it", () => {
    expect(liveLabel(buildTurnSteps([reasoning("rsn:1", "Plan"), message("msg:1", "Writing", "unknown", { status: "in_progress", completed_at: null })])))
      .toEqual({ id: "quiet", kind: "quiet" });
    expect(liveLabel(buildTurnSteps([subagent("sub_1", "Explore", { status: "in_progress", completed_at: null })])).kind).toBe("quiet");
    expect(liveLabel(buildTurnSteps([compaction("cmp:1", { status: "in_progress", completed_at: null })])).kind).toBe("quiet");
    // A message that has not produced text yet draws nothing: thinking shows.
    expect(liveLabel(buildTurnSteps([message("msg:1", "", "unknown", { status: "in_progress", completed_at: null })])).kind).toBe("thinking");
    // A running row still wins over a running breaker after it.
    expect(liveLabel(buildTurnSteps([command("cmd_1", [read("a.ts")], { status: "in_progress", completed_at: null }),
      subagent("sub_1", "Explore", { status: "in_progress", completed_at: null })])).kind).toBe("step");
  });

  it("falls back to the last reasoning line, then to thinking", () => {
    expect(liveLabel(buildTurnSteps([reasoning("rsn:1", "Old"), command("cmd_1", [read("a.ts")]),
      reasoning("rsn:2", "I should check the tests.\n\n**Running the `vitest` suite**")])))
      .toEqual({ id: "reasoning:Running the vitest suite", kind: "reasoning", text: "Running the vitest suite" });
    expect(liveLabel(buildTurnSteps([command("cmd_1", [read("a.ts")])]))).toEqual({ id: "thinking", kind: "thinking" });
  });

  it("strips markdown and skips comment lines", () => {
    expect(reasoningHeadline("## [Read](x) the *docs*\n<!-- note -->\n")).toBe("Read the docs");
    expect(reasoningHeadline("- `a` and __b__")).toBe("a and b");
    expect(reasoningHeadline("  \n")).toBeNull();
  });
});

describe("fold headers", () => {
  const turn = traceTurn();
  it("reads working, then working for, then worked for once the final starts", () => {
    const start = Date.parse(turn.started_at);
    expect(liveFoldHeader(turn, [], start + 999)).toEqual({ kind: "working" });
    expect(liveFoldHeader(turn, [], start + 1000)).toEqual({ kind: "working_for", ms: 1000 });
    expect(liveFoldHeader(turn, [message("msg:f", "Hi", "final", { started_at: at(12) })], start + 99_000))
      .toEqual({ kind: "worked_for", ms: 12_000 });
  });

  it("reads stopped after for a cancelled turn and worked for for one that ended without a final", () => {
    expect(liveFoldHeader({ ...turn, status: "cancelled", duration_ms: 4000 }, [], 0)).toEqual({ kind: "stopped_after", ms: 4000 });
    expect(liveFoldHeader({ ...turn, status: "failed", completed_at: at(7) }, [], 0)).toEqual({ kind: "worked_for", ms: 7000 });
  });

  it("titles a finished card by worked_ms, falling back to elapsed_ms", () => {
    expect(finishedFoldHeader({ status: "completed", workedMs: 3000, elapsedMs: 9000 })).toEqual({ kind: "worked_for", ms: 3000 });
    expect(finishedFoldHeader({ status: "failed", workedMs: null, elapsedMs: 9000 })).toEqual({ kind: "worked_for", ms: 9000 });
    // A cancelled card's notice says so; the fold title stays neutral.
    expect(finishedFoldHeader({ status: "cancelled", workedMs: null, elapsedMs: 2000 })).toEqual({ kind: "steps" });
    expect(finishedFoldHeader({ status: "completed", workedMs: null, elapsedMs: null })).toEqual({ kind: "steps" });
  });
});

describe("waiting on a person", () => {
  it("is true while the last top-level item is an open permission or question", () => {
    const waiting = { ...permission("perm:1", "Bash"), status: "in_progress" as const, completed_at: null, outcome: null };
    expect(isAwaitingHuman([command("cmd_1", [unknown("make")], running), waiting])).toBe(true);
    expect(isAwaitingHuman([waiting, command("cmd_c", [read("a.ts")], { parent_id: "sub_1" })])).toBe(true);
    expect(isAwaitingHuman([permission("perm:1", "Bash")])).toBe(false);
    expect(isAwaitingHuman([waiting, command("cmd_2", [read("a.ts")])])).toBe(false);
    expect(isAwaitingHuman([])).toBe(false);
  });
});
