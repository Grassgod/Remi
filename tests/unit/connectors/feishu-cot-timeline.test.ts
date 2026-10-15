import { describe, expect, it } from "bun:test";
import { FeishuCotTimeline } from "@connectors/feishu/cot-timeline.js";
import { cotPlan, cotStepRows } from "@connectors/feishu/cot-tool-display.js";
import type { TaskStreamEvent } from "@connectors/base.js";
import type { TraceEvent } from "@multiremi/contracts/trace.js";
import type { CotSample } from "@connectors/feishu/native-cot.js";
import { agentMessage, command, completed, delta, input, item, plan, read, reasoning, running, started, streamedText, turnCompleted,
  turnStarted, updated } from "./feishu-native-harness.js";

const trace = (rows: TaskStreamEvent[]): TraceEvent[] => rows.map(row => (row as { message: TraceEvent }).message);
function feed(timeline: FeishuCotTimeline, rows: TaskStreamEvent[]): void {
  for (const row of trace(rows)) timeline.accept(row);
}
const of = (samples: CotSample[], type: string) => samples.filter(([kind]) => kind === type).map(([, content]) => content);
const prose = (samples: CotSample[]) => of(samples, "REASONING_MESSAGE_CONTENT").map(content => content.delta).join("");
const results = (samples: CotSample[]) => of(samples, "TOOL_CALL_RESULT").map(content => JSON.parse(String(content.content)));

describe("native CoT rows from finished items", () => {
  it.each([
    ["cat src/app.ts", [{ type: "read", command: "cat src/app.ts", name: "app.ts", path: "src/app.ts" }], "已读取 app.ts", "read", "$ cat src/app.ts"],
    ["rg foo src", [{ type: "search", command: "rg foo src", query: "foo", path: "src" }], "已在 src 中搜索“foo”", "search", "$ rg foo src"],
    ["rg --files", [{ type: "search", command: "rg --files", query: null, path: null }], "已搜索文件", "search", "$ rg --files"],
    ["ls packages", [{ type: "list_files", command: "ls packages", path: "packages" }], "已列出 packages 中的文件", "search", "$ ls packages"],
    ["bun test", [{ type: "unknown", command: "bun test" }], "已运行 bun test", "bash", "$ bun test"],
    ["remi task get tsk | grep -v '^INFO'", [{ type: "unknown", command: "remi task get tsk | grep -v '^INFO'" }],
      "已运行 remi task get tsk | grep -v '^INFO'", "bash", "$ remi task get tsk | grep -v '^INFO'"],
  ] as const)("titles a shell command by its parsed action: %s", (script, actions, title, icon, args) => {
    const [row] = cotStepRows(command("tc", script, [...actions]));
    expect(row).toEqual({ key: "tc:0", title, icon, args });
  });

  it("titles a command the model labelled with its label, one row with the command as args (spec §13)", () => {
    const titled = command("tc", "sleep 25; ls -A /w", [
      { type: "unknown", command: "sleep 25" }, { type: "list_files", command: "ls -A /w", path: "/w" },
    ], { title: "Sleep 25s then list directory" });
    expect(cotStepRows(titled)).toEqual([{ key: "tc:0", title: "Sleep 25s then list directory", icon: "bash", args: "$ sleep 25; ls -A /w" }]);
    expect(cotStepRows({ ...titled, status: "stopped" })[0]).toMatchObject({ title: "已停止 Sleep 25s then list directory" });
    expect(cotStepRows({ ...titled, status: "stopped" })[0]?.note).toBeUndefined();
    expect(cotStepRows({ ...titled, status: "failed", exit_code: 1 })[0]).toMatchObject({ title: "Sleep 25s then list directory", note: "执行失败" });
  });

  it("writes one row per action of a compound command and one per changed file", () => {
    const rows = cotStepRows(command("tc", "cat a.ts && rg foo src", [
      { type: "read", command: "cat a.ts", name: "a.ts", path: "a.ts" },
      { type: "search", command: "rg foo src", query: "foo", path: "src" },
    ]));
    expect(rows.map(row => [row.key, row.title])).toEqual([["tc:0", "已读取 a.ts"], ["tc:1", "已在 src 中搜索“foo”"]]);
    const edits = cotStepRows(item("file_change", "fc", { changes: [
      { path: "/repo/new.ts", kind: "add", move_path: null, diff: "+x", added: 1, removed: 0 },
      { path: "/repo/app.ts", kind: "update", move_path: null, diff: "-a\n+b", added: 1, removed: 1 },
      { path: "/repo/old.ts", kind: "delete", move_path: null, diff: null, added: 0, removed: 3 },
    ] }));
    expect(edits.map(row => [row.title, row.icon, row.args])).toEqual([
      ["已创建 new.ts", "write", "/repo/new.ts"], ["已编辑 app.ts", "write", "/repo/app.ts"], ["已删除 old.ts", "write", "/repo/old.ts"],
    ]);
  });

  it("gives structured tools Codex copy and aiden's native icons", () => {
    const rows = [
      cotStepRows(read("r", "/project/README.md"))[0],
      cotStepRows(item("web_search", "w", { query: "message_cot" }))[0],
      cotStepRows(item("web_search", "f", { tool: "WebFetch", action: "fetch", url: "https://example.com" }))[0],
      cotStepRows(item("tool", "s", { tool: "Skill", title: "Skill", input: { skill: "release-check" } }))[0],
      cotStepRows(item("tool", "q", { tool: "ToolSearch", input: { query: "lark" } }))[0],
      cotStepRows(item("tool", "m", { tool: "mcp__lark__send", server: "lark", title: "Send message" }))[0],
    ];
    expect(rows.map(row => [row!.title, row!.icon, row!.args])).toEqual([
      ["已读取 README.md", "read", "/project/README.md"],
      ["已搜索网页：message_cot", "search", "message_cot"],
      ["已打开 https://example.com", "search", "https://example.com"],
      ["已调用 Skill", "doc", "release-check"],
      ["已调用 ToolSearch", "find-app_outlined", "lark"],
      ["已调用 Send message", "default", undefined],
    ]);
  });

  it("adds a short status only where the title cannot carry it, and never the output", () => {
    const failed = cotStepRows(command("a", "bun test", undefined, { status: "failed", exit_code: 1, output: "sensitive stacktrace" }));
    expect(failed).toEqual([expect.objectContaining({ title: "已运行 bun test", note: "执行失败" })]);
    expect(cotStepRows(read("b", "/source.ts", { status: "stopped" }))[0]).toMatchObject({ title: "已读取 source.ts", note: "已停止" });
    expect(cotStepRows(command("c", "rm -rf build", undefined, { status: "declined" }))[0])
      .toEqual({ key: "c:0", title: "已拒绝运行 rm -rf build", icon: "bash", args: "$ rm -rf build" });
    expect(cotStepRows(command("d", "bun test", undefined, { status: "stopped" }))[0]).toMatchObject({ title: "已停止 bun test" });
    expect(cotStepRows(command("d", "bun test", undefined, { status: "stopped" }))[0]?.note).toBeUndefined();
    expect(JSON.stringify(failed)).not.toContain("stacktrace");
  });

  it("writes a tool only when it completes, whatever arrives while it runs", () => {
    const timeline = new FeishuCotTimeline("task");
    const bash = command("toolu_bash", "git status --short");
    // Claude AIR withholds the command until a later tool_call_update.
    feed(timeline, [started(1, { ...bash, command: null, actions: [] }), updated(2, bash), delta(3, bash.id, "M a.ts", "output")]);
    expect(timeline.drain()).toEqual({ samples: [], throughSeq: 3 });
    feed(timeline, [completed(4, { ...bash, output: "M a.ts" })]);
    const samples = timeline.drain().samples;
    expect(samples.map(([type]) => type)).toEqual(["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END"]);
    expect(samples[0]?.[1]).toMatchObject({ toolCallName: "Bash", title: "已运行 git status --short", icon: "bash" });
    expect(JSON.stringify(samples)).not.toContain("M a.ts");
  });

  it("adds a later decline to an already written tool as a result, never as a second start", () => {
    const timeline = new FeishuCotTimeline("task");
    const bash = command("toolu_rm", "rm -rf build");
    feed(timeline, [started(1, bash), completed(2, bash)]);
    const first = timeline.drain().samples;
    // A refused approval re-closes its linked tool as declined.
    feed(timeline, [completed(3, { ...bash, status: "declined" })]);
    expect(timeline.drain().samples).toEqual([["TOOL_CALL_RESULT", { toolCallId: of(first, "TOOL_CALL_START")[0]!.toolCallId,
      messageId: expect.any(String), role: "tool", content: JSON.stringify({ type: "text", text: "已拒绝" }) }]]);
    feed(timeline, [completed(4, { ...bash, status: "declined" })]);
    expect(timeline.drain().samples).toEqual([]);
  });
});

describe("semantic native CoT timeline", () => {
  it("keeps narration chronological: commentary at once, a possible answer until a later step proves it narration", () => {
    const timeline = new FeishuCotTimeline("task");
    const items = {
      prompt: input("检查源文件"),
      first: agentMessage("msg:1", "先读取。"),
      second: agentMessage("msg:2", "再检查。", "commentary"),
      tool: read("toolu_read", "/source.ts"),
      agent: item("subagent", "toolu_agent", { title: "检查子目录" }),
      childText: agentMessage("msg:child", "child secret", "unknown", { parent_id: "toolu_agent" }),
      childTool: command("toolu_child", "cat secret.txt", undefined, { parent_id: "toolu_agent" }),
      third: agentMessage("msg:3", "已核对。", "commentary"),
      answer: agentMessage("msg:4", "最终答案", "final"),
    };
    feed(timeline, [
      turnStarted(1),
      completed(2, items.prompt),
      ...streamedText(3, items.first),
      ...streamedText(6, items.second),
      started(9, items.tool),
      completed(10, items.tool),
      started(11, items.agent),
      completed(12, items.childText),
      completed(13, items.childTool),
      completed(14, items.agent),
      ...streamedText(15, items.third),
      ...streamedText(18, { ...items.answer, phase: "unknown" }),
      completed(21, items.answer),
      turnCompleted(22, Object.values(items)),
    ]);
    // The closing turn counts tools at any depth: the read, the subagent and its child.
    expect(timeline.state.turn?.stats).toMatchObject({ item_count: 9, tool_call_count: 3 });
    const samples = timeline.finish("completed");
    expect(prose(samples)).toBe("先读取。再检查。已核对。");
    expect(of(samples, "REASONING_MESSAGE_START")).toHaveLength(3);
    expect(of(samples, "REASONING_MESSAGE_END")).toHaveLength(3);
    expect(of(samples, "REASONING_START")).toHaveLength(1);
    expect(samples.at(-1)?.[0]).toBe("REASONING_END");
    expect(of(samples, "TOOL_CALL_START").map(start => start.title)).toEqual(["已读取 source.ts", "检查子目录"]);
    expect(timeline.answer("fallback")).toBe("最终答案");
    expect(JSON.stringify(samples)).not.toContain("secret");
    expect(JSON.stringify(samples)).not.toContain("检查源文件");
    expect(JSON.stringify(samples)).not.toContain("最终答案");
  });

  it("follows the final-reply rule across steer rounds without losing the earlier answer", () => {
    const timeline = new FeishuCotTimeline("task");
    const first = agentMessage("msg:round1", "第一轮答案", "final");
    const second = agentMessage("msg:round2", "第二轮答案", "final");
    feed(timeline, [
      turnStarted(1),
      completed(2, first),
      completed(3, item("user_message", "steer:1", { origin: "steer", text: "再看一下测试" })),
      started(4, command("toolu_test", "bun test")),
      completed(5, command("toolu_test", "bun test")),
      completed(6, second),
      completed(7, { ...first, phase: "commentary" }),
      turnCompleted(8, [{ ...first, phase: "commentary" }, second]),
    ]);
    const samples = timeline.finish("completed");
    expect(prose(samples)).toBe("第一轮答案");
    expect(timeline.answer("")).toBe("第二轮答案");
  });

  it("narrates candidates that are not the final item when the turn ends", () => {
    const timeline = new FeishuCotTimeline("task");
    const partial = agentMessage("msg:partial", "部分结论");
    const answer = agentMessage("msg:answer", "完整答案", "final");
    feed(timeline, [turnStarted(1), completed(2, partial), completed(3, answer), turnCompleted(4, [partial, answer])]);
    const samples = timeline.finish("completed");
    expect(prose(samples)).toBe("部分结论");
    expect(timeline.answer("")).toBe("完整答案");
  });

  it("writes one native message per reasoning item and ignores deltas until the item completes", () => {
    const timeline = new FeishuCotTimeline("task");
    feed(timeline, [started(1, reasoning("rsn:1", "")), delta(2, "rsn:1", "First "), delta(3, "rsn:1", "thought")]);
    expect(timeline.drain().samples).toEqual([]);
    feed(timeline, [completed(4, reasoning("rsn:1", "First thought"))]);
    const samples = timeline.drain().samples;
    expect(new Set(of(samples, "REASONING_MESSAGE_CONTENT").map(content => content.messageId)).size).toBe(1);
    expect(prose(samples)).toBe("First thought");
  });

  it("skips v1 lines and unknown event types while advancing the cursor", () => {
    const timeline = new FeishuCotTimeline("task");
    timeline.accept({ seq: 1, ts: "2026-10-15T00:00:00.000Z", type: "text", content: "legacy fragment" } as unknown as TraceEvent);
    timeline.accept({ seq: 2, ts: "2026-10-15T00:00:00.000Z", type: "future.widget", payload: { x: 1 } } as unknown as TraceEvent);
    expect(timeline.drain()).toEqual({ samples: [], throughSeq: 2 });
    expect(timeline.finish("completed")).toEqual([]);
    expect(timeline.answer("snapshot result")).toBe("snapshot result");
  });

  it("renders plan snapshots as native list rows, once per change, and not again when the turn closes it", () => {
    const timeline = new FeishuCotTimeline("task");
    const entries = [{ content: "检查", status: "completed", priority: null }, { content: "验证", status: "in_progress", priority: null },
      { content: "汇报", status: "pending", priority: null }] as const;
    feed(timeline, [started(1, plan([...entries])), updated(2, plan([...entries]))]);
    const samples = timeline.drain().samples;
    expect(of(samples, "TOOL_CALL_START")).toHaveLength(1);
    expect(samples[0]?.[1]).toMatchObject({ title: "更新待办 (1/3)", icon: "doc", toolCallName: "Plan" });
    expect(results(samples)).toEqual([{ type: "list", items: [
      { icon: "task", text: "已完成 · 检查" }, { text: "进行中 · 验证" }, { text: "待开始 · 汇报" },
    ] }]);
    const done = entries.map(entry => ({ ...entry, status: "completed" as const }));
    feed(timeline, [updated(3, plan(done))]);
    const update = timeline.drain().samples;
    expect(update[0]?.[1].title).toBe("更新待办 (3/3)");
    expect(results(update)[0].items.every((entry: { icon?: string }) => entry.icon === "task")).toBe(true);
    // The answer arrives after the plan; closing the turn re-completes the plan unchanged.
    feed(timeline, [completed(4, agentMessage("msg:answer", "答案", "final")), completed(5, plan(done)),
      turnCompleted(6, [plan(done), agentMessage("msg:answer", "答案", "final")])]);
    expect(timeline.finish("completed")).toEqual([]);
  });

  it("bounds a large native list as a whole and explicitly reports omitted entries", () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({ content: `任务 ${i} ` + '中文🙂"\\'.repeat(1000), status: "pending" }));
    const result = cotPlan(entries)!;
    expect(result.title).toBe("更新待办 (0/100)");
    expect(result.result.type).toBe("list");
    const visible = result.result.items.length - 1;
    expect(visible).toBeGreaterThan(0);
    expect(result.result.items.at(-1)?.text).toBe(`另有 ${100 - visible} 项待办，完整计划见工作台`);
    expect(result.result.items.every(entry => !Object.hasOwn(entry, "icon"))).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(JSON.stringify(result.result)))).toBeLessThan(3200);
    expect(JSON.stringify(result.result)).not.toContain("�");
    expect(cotPlan([null, {}, { content: "  " }])).toBeUndefined();
  });

  it("narrates a held message before a question so the waiting step follows it", () => {
    const timeline = new FeishuCotTimeline("task");
    // Claude's AskUserQuestion has no tool item: the question itself ends the answer search.
    feed(timeline, [completed(1, agentMessage("msg:ask", "还需要你确认。")),
      started(2, item("question", "q:approval", { message_id: "approval", message: "Continue?" }))]);
    const samples = [...timeline.drain().samples, ...timeline.waitForUser("approval", "question")];
    let open = false;
    for (const [type] of samples) {
      if (type === "REASONING_MESSAGE_START") { expect(open).toBe(false); open = true; }
      if (type === "REASONING_MESSAGE_END") { expect(open).toBe(true); open = false; }
    }
    expect(open).toBe(false);
    expect(prose(samples)).toBe("还需要你确认。等待你的回答，提交后继续。");
    expect(of(samples, "STEP_STARTED")).toEqual([{ stepId: expect.any(String), stepName: "等待用户回答" }]);
    expect(timeline.waitForUser("approval", "question")).toEqual([]);
    expect(timeline.resume("approval", "responded")).toEqual([["STEP_FINISHED",
      { stepId: of(samples, "STEP_STARTED")[0]!.stepId, stepName: "已收到回复，继续执行" }]]);
  });

  it("shows a subagent as a step from its start to its end and keeps its children in the workbench", () => {
    const timeline = new FeishuCotTimeline("task");
    const agent = item("subagent", "toolu_agent", { title: "检查接口", prompt: "Inspect the API" });
    feed(timeline, [started(1, agent), completed(2, command("toolu_child", "rg api", undefined, { parent_id: agent.id }))]);
    const opening = timeline.drain().samples;
    expect(opening.map(([type]) => type)).toEqual(["TOOL_CALL_START", "TOOL_CALL_END", "STEP_STARTED"]);
    expect(opening[0]?.[1]).toMatchObject({ toolCallName: "Agent", title: "检查接口", icon: "robot_outlined" });
    expect(opening[2]?.[1].stepName).toBe("正在运行子代理：检查接口");
    feed(timeline, [completed(3, { ...agent, output: "done" })]);
    expect(timeline.drain().samples).toEqual([["STEP_FINISHED", { stepId: opening[2]![1].stepId, stepName: "子代理已完成：检查接口" }]]);
    expect(of(timeline.finish("completed"), "STEP_FINISHED")).toEqual([]);
  });

  it.each([["failed", "子代理执行失败：核对文档"], ["stopped", "子代理已停止：核对文档"]] as const)(
    "names a %s subagent truthfully", (status, name) => {
      const timeline = new FeishuCotTimeline("task");
      const agent = item("subagent", "toolu_agent", { title: "核对文档" });
      feed(timeline, [started(1, agent), completed(2, { ...agent, status })]);
      expect(of(timeline.drain().samples, "STEP_FINISHED")[0]?.stepName).toBe(name);
    });

  it("keeps a background subagent's step open until the turn closes it (spec §13)", () => {
    const timeline = new FeishuCotTimeline("task");
    const agent = item("subagent", "toolu_agent", { title: "核对文档", background: true, output: null });
    // The translator keeps an async launch in progress: its children run, it never completes on the launch.
    feed(timeline, [started(1, agent), completed(2, command("toolu_child", "rg api", undefined, { parent_id: agent.id }))]);
    const opening = timeline.drain().samples;
    expect(of(opening, "STEP_STARTED")[0]?.stepName).toBe("后台运行中：核对文档");
    expect(of(opening, "STEP_FINISHED")).toEqual([]);
    // Closing the turn completes it; that is the child's real end.
    feed(timeline, [completed(3, { ...agent, status: "completed" })]);
    expect(of(timeline.drain().samples, "STEP_FINISHED")).toEqual([{ stepId: of(opening, "STEP_STARTED")[0]!.stepId, stepName: "子代理已完成：核对文档" }]);
    expect(of(timeline.finish("completed"), "STEP_FINISHED")).toEqual([]);
  });

  it.each([["completed", "核对文档 · 本轮已结束，子任务结果见工作台"], ["cancelled", "核对文档 · 本轮已中断"]] as const)(
    "closes a subagent step still open when the run ends %s", (status, name) => {
      const timeline = new FeishuCotTimeline("task");
      const agent = item("subagent", "toolu_agent", { title: "核对文档", background: true });
      feed(timeline, [started(1, agent)]);
      expect(of(timeline.drain().samples, "STEP_FINISHED")).toEqual([]);
      expect(of(timeline.finish(status), "STEP_FINISHED")[0]?.stepName).toBe(name);
    });

  it("shows a compaction as a step and notices as named steps", () => {
    const timeline = new FeishuCotTimeline("task");
    const compaction = item("compaction", "cmp:1", { pre_tokens: 190000, post_tokens: 20000 });
    feed(timeline, [started(1, compaction), completed(2, compaction),
      completed(3, item("notice", "ntc:1", { severity: "warning", title: "Usage limit is near" }))]);
    expect(of(timeline.drain().samples, "STEP_STARTED").map(step => step.stepName)).toEqual(["正在压缩上下文", "Usage limit is near"]);
    feed(timeline, [started(4, item("compaction", "cmp:2")), completed(5, item("compaction", "cmp:2", { status: "failed" }))]);
    expect(of(timeline.drain().samples, "STEP_FINISHED").map(step => step.stepName)).toEqual(["上下文压缩失败"]);
  });

  it("bounds escaped Unicode labels, args and native plan lists to event limits", () => {
    const timeline = new FeishuCotTimeline("task");
    const long = '中文🙂"\\\n'.repeat(2000);
    feed(timeline, [completed(1, command("tc", long)), completed(2, plan([{ content: long, status: "pending", priority: null }])),
      completed(3, item("subagent", "agent", { title: long }))]);
    const samples = timeline.finish("completed");
    expect(samples.every(([, content]) => Buffer.byteLength(JSON.stringify(content)) <= 4096)).toBe(true);
    expect(JSON.stringify(samples)).not.toContain("�");
  });
});

describe("restart and checkpoint replay", () => {
  const prefix = [
    turnStarted(1),
    ...streamedText(2, agentMessage("msg:1", "先检查仓库。")),
    started(5, command("toolu_status", "git status")),
    completed(6, command("toolu_status", "git status")),
    started(7, command("toolu_test", "bun test")),
  ];

  it("regenerates nothing for the acknowledged prefix and continues after it", () => {
    const fresh = new FeishuCotTimeline("task");
    feed(fresh, prefix);
    const sent = fresh.drain();
    expect(sent.throughSeq).toBe(7);
    expect(of(sent.samples, "TOOL_CALL_START")).toHaveLength(1);
    const resumed = new FeishuCotTimeline("task", sent.throughSeq);
    feed(resumed, prefix);
    expect(resumed.drain().samples).toEqual([]);
    feed(resumed, [completed(8, command("toolu_test", "bun test", undefined, { status: "failed" }))]);
    const next = resumed.drain().samples;
    expect(of(next, "TOOL_CALL_START").map(start => start.title)).toEqual(["已运行 bun test"]);
    expect(results(next)).toEqual([{ type: "text", text: "执行失败" }]);
    // Native IDs come from item IDs, so both runs name the same invocation.
    const original = new FeishuCotTimeline("task");
    feed(original, [...prefix, completed(8, command("toolu_test", "bun test", undefined, { status: "failed" }))]);
    expect(of(original.drain().samples, "TOOL_CALL_START").at(-1)?.toolCallId).toBe(of(next, "TOOL_CALL_START")[0]!.toolCallId);
  });

  it("keeps a candidate held across the checkpoint and narrates it once a later step proves it was not the answer", () => {
    const resumed = new FeishuCotTimeline("task", 3);
    feed(resumed, [turnStarted(1), started(2, agentMessage("msg:1", "")), completed(3, agentMessage("msg:1", "先看日志。"))]);
    expect(resumed.drain().samples).toEqual([]);
    feed(resumed, [started(4, command("toolu_log", "tail -100 daemon.log", [{ type: "read", command: "tail -100 daemon.log",
      name: "daemon.log", path: "daemon.log" }]))]);
    expect(prose(resumed.drain().samples)).toBe("先看日志。");
  });

  it("finishes a subagent opened before the checkpoint without opening it again", () => {
    const agent = item("subagent", "toolu_agent", { title: "检查接口" });
    const original = new FeishuCotTimeline("task");
    feed(original, [started(1, agent)]);
    const stepId = of(original.drain().samples, "STEP_STARTED")[0]!.stepId;
    // Production replays from seq 0, so the resumed timeline sees the start again.
    const resumed = new FeishuCotTimeline("task", 1);
    feed(resumed, [started(1, agent), completed(2, agent)]);
    expect(resumed.drain().samples).toEqual([["STEP_FINISHED", { stepId, stepName: "子代理已完成：检查接口" }]]);
  });

  it("opens and closes the step of a compaction reported only once finished, after a resume", () => {
    const compaction = item("compaction", "cmp:1", { pre_tokens: 190000, post_tokens: 20000 });
    const prefix = [turnStarted(1), completed(2, input("继续"))];
    const original = new FeishuCotTimeline("task");
    feed(original, prefix);
    const checkpoint = original.drain().throughSeq;
    const resumed = new FeishuCotTimeline("task", checkpoint);
    feed(resumed, [...prefix, completed(3, compaction)]);
    const samples = resumed.drain().samples;
    expect(samples.map(([type]) => type)).toEqual(["STEP_STARTED", "STEP_FINISHED"]);
    expect(samples[0]?.[1].stepId).toBe(samples[1]?.[1].stepId);
    expect(samples.map(([, content]) => content.stepName)).toEqual(["正在压缩上下文", "已压缩上下文"]);
    // Acknowledged, it is not written again.
    const again = new FeishuCotTimeline("task", 3);
    feed(again, [...prefix, completed(3, compaction)]);
    expect(again.drain().samples).toEqual([]);
  });

  it("does not resend an acknowledged plan after restart but sends the next status change", () => {
    const first = plan([{ content: "检查", status: "in_progress", priority: null }]);
    const timeline = new FeishuCotTimeline("task", 2);
    feed(timeline, [started(1, first), updated(2, first)]);
    expect(timeline.drain().samples).toEqual([]);
    feed(timeline, [updated(3, plan([{ content: "检查", status: "completed", priority: null }]))]);
    expect(timeline.drain().samples[0]?.[1].title).toBe("更新待办 (1/1)");
  });

  it("ignores an event replayed at or below the seq already applied", () => {
    const timeline = new FeishuCotTimeline("task");
    const bash = command("toolu_bash", "bun test");
    feed(timeline, [completed(1, bash)]);
    timeline.drain();
    feed(timeline, [completed(1, { ...bash, status: "failed" }), started(1, running(bash))]);
    expect(timeline.drain()).toEqual({ samples: [], throughSeq: 1 });
  });
});

describe("the final-reply rule in the native CoT", () => {
  const tool = command("toolu_test", "bun test");
  const order = (samples: CotSample[]) => samples.flatMap(([type, content]) =>
    type === "TOOL_CALL_START" ? [content.title] : type === "REASONING_MESSAGE_CONTENT" ? [content.delta] : []);

  it("keeps a summary out of the CoT when a plan update follows it, and still shows the plan after the steps", () => {
    const timeline = new FeishuCotTimeline("task");
    const summary = agentMessage("msg:summary", "测试全部通过。");
    const done = plan([{ content: "运行测试", status: "completed", priority: null }]);
    feed(timeline, [turnStarted(1), started(2, plan([{ content: "运行测试", status: "in_progress", priority: null }])),
      started(3, tool), completed(4, tool), completed(5, summary), updated(6, done)]);
    // The plan update waits behind the summary, which may still be the answer.
    expect(order(timeline.drain().samples)).toEqual(["更新待办 (0/1)", "已运行 bun test"]);
    feed(timeline, [completed(7, { ...summary, phase: "final" }), completed(8, done),
      turnCompleted(9, [done, tool, { ...summary, phase: "final" }])]);
    expect(order(timeline.finish("completed"))).toEqual(["更新待办 (1/1)"]);
    expect(timeline.answer("")).toBe("测试全部通过。");
  });

  it("shows reasoning that follows the answer, without the answer", () => {
    const timeline = new FeishuCotTimeline("task");
    const answer = agentMessage("msg:answer", "答案是 42。");
    feed(timeline, [turnStarted(1), completed(2, answer), completed(3, reasoning("rsn:after", "再复核一遍。"))]);
    expect(timeline.drain().samples).toEqual([]);
    feed(timeline, [completed(4, { ...answer, phase: "final" }), turnCompleted(5, [{ ...answer, phase: "final" }])]);
    const samples = timeline.finish("completed");
    expect(prose(samples)).toBe("再复核一遍。");
    expect(samples[0]?.[0]).toBe("REASONING_START");
    expect(timeline.answer("")).toBe("答案是 42。");
  });

  it("keeps a Codex native final out of the CoT although a tool follows it", () => {
    const timeline = new FeishuCotTimeline("task");
    const final = agentMessage("msg:final", "已完成修改。", "final");
    feed(timeline, [turnStarted(1), completed(2, final), started(3, tool), completed(4, tool)]);
    // Rule 1: only a later final replaces a bridge-labelled one, so the tool waits behind it.
    expect(timeline.drain().samples).toEqual([]);
    feed(timeline, [turnCompleted(5, [final, tool])]);
    const samples = timeline.finish("completed");
    expect(order(samples)).toEqual(["已运行 bun test"]);
    expect(timeline.answer("")).toBe("已完成修改。");
  });

  it("writes a later message behind a native final as process text, and a later final replaces it", () => {
    const timeline = new FeishuCotTimeline("task");
    const first = agentMessage("msg:first", "初步答案", "final");
    const note = agentMessage("msg:note", "补充检查", "commentary");
    const second = agentMessage("msg:second", "最终答案", "final");
    feed(timeline, [turnStarted(1), completed(2, first), completed(3, note)]);
    expect(timeline.drain().samples).toEqual([]);
    feed(timeline, [completed(4, second), completed(5, { ...first, phase: "commentary" }),
      turnCompleted(6, [{ ...first, phase: "commentary" }, note, second])]);
    expect(prose(timeline.finish("completed"))).toBe("初步答案补充检查");
    expect(timeline.answer("")).toBe("最终答案");
  });

  it("shows text before a closing tool both as process text and as the answer (known D-final duplicate)", () => {
    const timeline = new FeishuCotTimeline("task");
    const text = agentMessage("msg:text", "我来修改配置。");
    // The tool after the text makes it process text at once ...
    feed(timeline, [turnStarted(1), completed(2, text), started(3, tool)]);
    expect(prose(timeline.drain().samples)).toBe("我来修改配置。");
    // ... but the turn ends on that tool, so the rule promotes the text anyway.
    feed(timeline, [completed(4, tool), completed(5, { ...text, phase: "final" }),
      turnCompleted(6, [{ ...text, phase: "final" }, tool])]);
    expect(prose(timeline.finish("completed"))).toBe("");
    expect(timeline.answer("")).toBe("我来修改配置。");
  });

  it("does not let an approval end the answer search: its tool already did", () => {
    const timeline = new FeishuCotTimeline("task");
    const answer = agentMessage("msg:answer", "已完成。");
    feed(timeline, [turnStarted(1), completed(2, answer),
      started(3, item("permission", "perm:late", { message_id: "late", title: "Bash" }))]);
    expect(timeline.drain().samples).toEqual([]);
    feed(timeline, [completed(4, { ...answer, phase: "final" }), turnCompleted(5, [{ ...answer, phase: "final" }])]);
    expect(prose(timeline.finish("completed"))).toBe("");
  });
});

describe("Claude subagent titles", () => {
  // claude-agent-acp's first Agent frame is titled "Task" and carries no input (AIR).
  const placeholder = item("subagent", "toolu_agent", { tool: "Task", title: "Task", prompt: null });
  const real = { ...placeholder, title: "检查接口", prompt: "Inspect the API handlers" };

  it("opens the row and step on the first event with a real title, never on the placeholder", () => {
    const timeline = new FeishuCotTimeline("task");
    feed(timeline, [started(1, placeholder)]);
    expect(timeline.drain().samples).toEqual([]);
    feed(timeline, [updated(2, real), updated(3, real)]);
    const samples = timeline.drain().samples;
    expect(of(samples, "TOOL_CALL_START")).toEqual([{ toolCallId: expect.any(String), toolCallName: "Task", title: "检查接口", icon: "robot_outlined" }]);
    expect(of(samples, "STEP_STARTED").map(step => step.stepName)).toEqual(["正在运行子代理：检查接口"]);
    feed(timeline, [completed(4, real)]);
    expect(of(timeline.drain().samples, "STEP_FINISHED").map(step => step.stepName)).toEqual(["子代理已完成：检查接口"]);
  });

  it("opens on a prompt when the title stays the placeholder", () => {
    const timeline = new FeishuCotTimeline("task");
    feed(timeline, [started(1, placeholder), updated(2, { ...placeholder, prompt: "Review the docs" })]);
    expect(of(timeline.drain().samples, "TOOL_CALL_START")[0]?.title).toBe("Review the docs");
  });

  it("falls back to the first child item, or to the completion", () => {
    const viaChild = new FeishuCotTimeline("task");
    feed(viaChild, [started(1, placeholder), completed(2, command("toolu_child", "rg api", undefined, { parent_id: placeholder.id }))]);
    expect(of(viaChild.drain().samples, "STEP_STARTED")).toHaveLength(1);
    const viaEnd = new FeishuCotTimeline("task");
    feed(viaEnd, [started(1, placeholder), completed(2, placeholder)]);
    expect(viaEnd.drain().samples.map(([type]) => type)).toEqual(["TOOL_CALL_START", "TOOL_CALL_END", "STEP_STARTED", "STEP_FINISHED"]);
  });
});
