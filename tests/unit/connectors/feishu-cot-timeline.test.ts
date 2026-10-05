import { describe, expect, it } from "bun:test";
import { FeishuCotTimeline } from "@connectors/feishu/cot-timeline.js";
import { cotPlan, cotToolDisplay, isCotSubagent } from "@connectors/feishu/cot-tool-display.js";
import type { TraceEvent } from "@multiremi/contracts/trace.js";
import { taskEvent } from "./feishu-native-harness.js";

const message = (seq: number, type: string, patch: Record<string, unknown> = {}) =>
  (taskEvent(seq, type, patch) as { message: TraceEvent }).message;

describe("semantic native CoT timeline", () => {
  it.each([
    ["rg foo src", "search"],
    ["/usr/bin/grep -n foo source.ts | head -20", "search"],
    ["find src -name '*.ts'", "search"],
    ["cat daemon.log | grep -v INFO", "read"],
    ["sed -n '1,20p' source.ts", "read"],
    ["tail -100 daemon.log", "read"],
    ["remi task get tsk_example | grep -v '^INFO'", "bash"],
    ["ssh runtime 'cat daemon.log | grep -v INFO'", "bash"],
    ["python3 -c 'print(\"find\")'", "bash"],
    ["echo 'grep cat find'", "bash"],
    ["bun test tests/find.test.ts", "bash"],
    ["rg foo src && bun test", "bash"],
    ["cat <<'EOF'\ngrep foo\nEOF", "bash"],
    ["cat daemon.log; bun test", "bash"],
  ])("classifies the leading shell operation: %s", (command, icon) => {
    expect(cotToolDisplay("Bash", { command, description: "检查任务" })).toMatchObject({ title: "检查任务", icon });
  });

  it("retains aiden's native categories for structured tools", () => {
    const displays = [
      cotToolDisplay("Read", { file_path: "/source.ts" }),
      cotToolDisplay("Edit", { file_path: "/source.ts" }),
      cotToolDisplay("Grep", { pattern: "example" }),
      cotToolDisplay("Skill", { skill: "diagnose" }),
      cotToolDisplay("Agent", { description: "验证修复" }),
      cotToolDisplay("unknown_tool", {}),
    ];
    expect(displays.map(d => d.icon)).toEqual(["read", "write", "search", "doc", "robot_outlined", "default"]);
  });

  it("keeps a delayed shell invocation with a log filter generic in native events", () => {
    const timeline = new FeishuCotTimeline("task");
    timeline.accept(message(1, "tool_use", { toolCallId: "tc", tool: "Bash" }));
    timeline.accept(message(2, "tool_use", { toolCallId: "tc", input: {
      command: "remi task get tsk_example | grep -v '^INFO'", description: "查看任务记录",
    } }));
    const starts = timeline.drain().samples.filter(([type]) => type === "TOOL_CALL_START");
    expect(starts).toHaveLength(1);
    expect(starts[0]?.[1]).toMatchObject({ title: "查看任务记录", icon: "bash" });
  });

  it("distinguishes spawning an agent from reading agent or task metadata", () => {
    expect(isCotSubagent("mcp__aiden_bot__spawn_agent", {})).toBe(true);
    expect(isCotSubagent("get_agent", {})).toBe(false);
    expect(isCotSubagent("remi/get_task", {})).toBe(false);
  });
  it("waits for meaningful ACP args and attaches a later description to the existing invocation", () => {
    let now = 0;
    const timeline = new FeishuCotTimeline("task", 0, () => now);
    timeline.accept(message(1, "tool_use", { toolCallId: "tc", tool: "Bash" }));
    timeline.accept(message(2, "tool_use", { toolCallId: "tc", input: { command: "rg foo src" } }));
    now = 500;
    const initial = timeline.drain();
    expect(initial.samples.find(([type]) => type === "TOOL_CALL_START")?.[1].title).toBe("执行：rg foo src");
    timeline.accept(message(3, "tool_use", { toolCallId: "tc", input: { description: "搜索调用入口" } }));
    const { samples, throughSeq } = timeline.drain();
    expect(throughSeq).toBe(3);
    expect(samples.filter(([type]) => type === "TOOL_CALL_START")).toEqual([]);
    expect(JSON.parse(String(samples.find(([type]) => type === "TOOL_CALL_RESULT")?.[1].content)).text).toContain("搜索调用入口");
    timeline.accept(message(4, "tool_result", { toolCallId: "tc", output: '{"huge":"private log"}', status: "completed" }));
    expect(timeline.drain().samples).toEqual([]);
  });

  it("defers a bare placeholder independently until real arguments or the terminal event", () => {
    let now = 0;
    const timeline = new FeishuCotTimeline("task", 0, () => now);
    timeline.accept(message(1, "tool_use", { tool: "Bash", toolCallId: "tc" }));
    expect(timeline.drain().samples).toHaveLength(0);
    now = 1001;
    expect(timeline.drain().samples).toEqual([]);
    timeline.accept(message(2, "text", { content: "仍在执行", meta: { phase: "commentary" } }));
    expect(timeline.drain().samples.some(([type]) => type === "REASONING_MESSAGE_CONTENT")).toBe(true);
    expect(timeline.deferredToolIds).toEqual(["tc"]);
    timeline.accept(message(3, "tool_result", { tool: "Bash", toolCallId: "tc", status: "completed" }));
    expect(timeline.drain().samples.find(([type]) => type === "TOOL_CALL_START")?.[1].title).toBe("Bash");
    expect(timeline.deferredToolIds).toEqual([]);
  });

  it("restores an unsent placeholder and starts it once when late arguments arrive", () => {
    let now = 0;
    const initial = message(1, "tool_use", { tool: "Bash", toolCallId: "late" });
    const refined = message(2, "tool_use", { tool: "Bash", toolCallId: "late", input: {
      command: "git status --short", description: "检查仓库状态",
    } });
    const timeline = new FeishuCotTimeline("task", 0, () => now);
    timeline.accept(initial);
    expect(timeline.drain().samples).toEqual([]);
    now = 1001;
    expect(timeline.drain().samples).toEqual([]);
    timeline.accept(refined);
    const update = timeline.drain();
    const first = update.samples.find(([type]) => type === "TOOL_CALL_START")!;
    expect(first[1]).toMatchObject({ title: "检查仓库状态", toolCallName: "Bash" });
    expect(timeline.toolCount).toBe(1);
    timeline.accept({ ...refined, seq: 3 });
    expect(timeline.drain().samples).toEqual([]);

    const restart = new FeishuCotTimeline("task", update.throughSeq);
    restart.accept(initial);
    restart.accept(refined);
    restart.accept(message(3, "tool_result", { toolCallId: "late", status: "completed" }));
    expect(restart.drain().samples).toEqual([]);
    const pending = new FeishuCotTimeline("task", 1, Date.now, ["late"]);
    pending.accept(refined);
    expect(pending.drain().samples.find(([type]) => type === "TOOL_CALL_START")?.[1])
      .toMatchObject({ toolCallId: first[1].toolCallId, title: "检查仓库状态" });
    expect(pending.deferredToolIds).toEqual([]);
    const terminalOnly = new FeishuCotTimeline("task", 1, Date.now, ["late"]);
    terminalOnly.accept(message(2, "tool_result", { tool: "Bash", toolCallId: "late", status: "completed" }));
    expect(terminalOnly.drain().samples.filter(([type]) => type === "TOOL_CALL_START")).toHaveLength(1);
    expect(terminalOnly.deferredToolIds).toEqual([]);
    const ending = new FeishuCotTimeline("task", 1, Date.now, ["late"]);
    expect(ending.finish("cancelled").filter(([type]) => type === "TOOL_CALL_START")).toHaveLength(1);
    expect(ending.deferredToolIds).toEqual([]);
  });

  it("recovers both an unacknowledged placeholder and an acknowledged invocation without losing or duplicating it", () => {
    const prefix = [message(1, "tool_use", { tool: "Bash", toolCallId: "tc" }),
      message(2, "tool_use", { toolCallId: "tc", input: { command: "bun test", description: "运行回归测试" } })];
    const fresh = new FeishuCotTimeline("task");
    prefix.forEach(m => fresh.accept(m));
    const sent = fresh.drain();
    expect(sent.samples.filter(([t]) => t === "TOOL_CALL_START")).toHaveLength(1);
    const resumed = new FeishuCotTimeline("task", sent.throughSeq);
    prefix.forEach(m => resumed.accept(m));
    resumed.accept(message(3, "tool_result", { toolCallId: "tc", status: "completed", output: "ok" }));
    expect(resumed.drain().samples).toEqual([]);
    expect(resumed.toolCount).toBe(1);
  });

  it("does not treat a partial tool output as completion and only shows a short failure indication", () => {
    const timeline = new FeishuCotTimeline("task");
    timeline.accept(message(1, "tool_use", { tool: "Read", toolCallId: "tc", input: { file_path: "/source.ts" } }));
    timeline.drain();
    timeline.accept(message(2, "tool_result", { toolCallId: "tc", status: "in_progress", output: "partial" }));
    expect(timeline.drain().samples).toHaveLength(0);
    timeline.accept(message(3, "tool_result", { toolCallId: "tc", status: "failed", output: "sensitive stacktrace" }));
    const samples = timeline.drain().samples;
    expect(samples).toHaveLength(1);
    expect(JSON.parse(String(samples[0]?.[1].content))).toEqual({ type: "text", text: "执行失败" });
    expect(JSON.stringify(samples)).not.toContain("stacktrace");
  });

  it.each([["failed", "执行失败"], ["cancelled", "已取消"]])(
    "preserves a %s tool result after a checkpoint without replaying the invocation",
    (status, text) => {
      const original = new FeishuCotTimeline("task");
      original.accept(message(1, "tool_use", { tool: "Read", toolCallId: "tc", input: { file_path: "/source.ts" } }));
      const prefix = original.drain();
      const toolCallId = prefix.samples.find(([type]) => type === "TOOL_CALL_START")?.[1].toolCallId;
      const resumed = new FeishuCotTimeline("task", prefix.throughSeq);
      resumed.accept(message(2, "tool_result", { toolCallId: "tc", status: "in_progress", output: "partial" }));
      expect(resumed.drain().samples).toEqual([]);
      resumed.accept(message(3, "tool_result", { toolCallId: "tc", status, output: "sensitive stacktrace" }));
      const result = resumed.drain();
      expect(result.throughSeq).toBe(3);
      expect(result.samples).toEqual([["TOOL_CALL_RESULT", {
        toolCallId, messageId: expect.any(String), role: "tool", content: JSON.stringify({ type: "text", text }),
      }]]);
      expect(resumed.toolCount).toBe(1);
      expect(JSON.stringify(result.samples)).not.toContain("stacktrace");
    },
  );

  it("keeps narration chronological and passes unknown trace types through verbatim", () => {
    const timeline = new FeishuCotTimeline("task");
    timeline.accept(message(1, "text", { content: "先读取。" }));
    timeline.accept(message(2, "text", { content: "再检查。", meta: { phase: "commentary" } }));
    timeline.accept(message(3, "tool_use", { tool: "Read", toolCallId: "tc", input: { path: "/source.ts" } }));
    timeline.accept(message(4, "text", { content: "child secret", meta: { parent_tool_call_id: "tc" } }));
    const unknown = message(5, "system", { content: "hook heartbeat" });
    timeline.accept(unknown);
    timeline.accept(message(6, "text", { content: "已核对。", meta: { phase: "commentary" } }));
    timeline.accept(message(7, "text", { content: "最终答案", meta: { phase: "final" } }));
    const samples = timeline.finish("completed");
    const prose = samples.filter(([t]) => t === "REASONING_MESSAGE_CONTENT").map(([, c]) => c.delta).join("");
    expect(prose).toBe("先读取。再检查。已核对。");
    expect(samples.filter(([t]) => t === "REASONING_MESSAGE_START")).toHaveLength(3);
    expect(samples.filter(([t]) => t === "REASONING_MESSAGE_END")).toHaveLength(3);
    expect(timeline.answer("")).toBe("最终答案");
    expect(JSON.stringify(samples)).not.toContain("secret");
    expect(samples.find(([type]) => type === "system")).toEqual(["system", { ...unknown }]);
  });

  it("renders plan entries as native list rows without a code panel or duplicate update", () => {
    const timeline = new FeishuCotTimeline("task");
    const entries = [{ content: "检查", status: "completed" }, { content: "验证", status: "in_progress" }, { content: "汇报", status: "pending" }];
    timeline.accept(message(1, "plan", { meta: { entries } }));
    timeline.accept(message(2, "plan", { meta: { entries } }));
    const samples = timeline.drain().samples;
    expect(samples.filter(([t]) => t === "TOOL_CALL_START")).toHaveLength(1);
    expect(samples[0]?.[1].title).toBe("更新待办 (1/3)");
    expect(samples[0]?.[1].icon).toBe("doc");
    expect(JSON.parse(String(samples.at(-1)?.[1].content))).toEqual({ type: "list", items: [
      { icon: "task", text: "已完成 · 检查" }, { text: "进行中 · 验证" }, { text: "待开始 · 汇报" },
    ] });
    timeline.accept(message(3, "plan", { meta: { entries: entries.map(e => ({ ...e, status: "completed" })) } }));
    const updated = timeline.drain().samples;
    expect(updated[0]?.[1].title).toBe("更新待办 (3/3)");
    expect(JSON.parse(String(updated.at(-1)?.[1].content)).items.every((e: { text: string }) => e.text.startsWith("已完成"))).toBe(true);
    expect(JSON.parse(String(updated.at(-1)?.[1].content)).items.every((e: { icon: string }) => e.icon === "task")).toBe(true);
  });

  it("uses the same native checklist for successful TodoWrite and never shows it as completed before success", () => {
    const timeline = new FeishuCotTimeline("task");
    const todos = [{ content: "检查投递", status: "in_progress" }, { content: "输出结果", status: "pending" }];
    timeline.accept(message(1, "tool_use", { tool: "TodoWrite", toolCallId: "todo", input: { todos } }));
    const invocation = timeline.drain().samples;
    expect(invocation.some(([type]) => type === "TOOL_CALL_RESULT")).toBe(false);
    expect(invocation.find(([type]) => type === "TOOL_CALL_START")?.[1].icon).toBe("doc");
    timeline.accept(message(2, "tool_result", { toolCallId: "todo", status: "in_progress" }));
    expect(timeline.drain().samples).toEqual([]);
    timeline.accept(message(3, "tool_result", { toolCallId: "todo", status: "completed" }));
    const samples = timeline.drain().samples;
    expect(samples).toHaveLength(1);
    expect(JSON.parse(String(samples[0]?.[1].content))).toEqual(cotPlan(todos)?.result);
    expect(samples[0]?.[1].toolCallId).toBeDefined();
  });

  it("shows a short failure instead of a successful checklist when TodoWrite fails", () => {
    const timeline = new FeishuCotTimeline("task");
    timeline.accept(message(1, "tool_use", { tool: "TodoWrite", toolCallId: "todo", input: { todos: [{ content: "检查", status: "completed" }] } }));
    timeline.drain();
    timeline.accept(message(2, "tool_result", { toolCallId: "todo", status: "failed" }));
    expect(JSON.parse(String(timeline.drain().samples[0]?.[1].content))).toEqual({ type: "text", text: "执行失败" });
  });

  it("does not resend an acknowledged plan after restart but sends the next status change", () => {
    const prefix = message(1, "plan", { meta: { entries: [{ content: "检查", status: "in_progress" }] } });
    const timeline = new FeishuCotTimeline("task", 1);
    timeline.accept(prefix);
    timeline.accept({ ...prefix, seq: 2 });
    expect(timeline.drain().samples).toEqual([]);
    timeline.accept(message(3, "plan", { meta: { entries: [{ content: "检查", status: "completed" }] } }));
    expect(timeline.drain().samples[0]?.[1].title).toBe("更新待办 (1/1)");
  });

  it("bounds a large native list as a whole and explicitly reports omitted entries", () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({ content: `任务 ${i} ` + '中文🙂"\\'.repeat(1000), status: "pending" }));
    const result = cotPlan(entries)!;
    expect(result.title).toBe("更新待办 (0/100)");
    expect(result.result.type).toBe("list");
    const visible = result.result.items.length - 1;
    expect(visible).toBeGreaterThan(0);
    expect(result.result.items.at(-1)?.text).toBe(`另有 ${100 - visible} 项待办，完整计划见工作台`);
    expect(result.result.items.every(item => !Object.hasOwn(item, "icon"))).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(JSON.stringify(result.result)))).toBeLessThan(3200);
    expect(JSON.stringify(result.result)).not.toContain("�");
    expect(cotPlan([null, {}, { content: "  " }])).toBeUndefined();
  });

  it("closes the preceding paragraph before opening a separate waiting message", () => {
    const timeline = new FeishuCotTimeline("task");
    timeline.accept(message(1, "text", { content: "还需要你确认。", meta: { phase: "commentary" } }));
    timeline.accept(message(2, "permission_request", { input: { request_id: "approval" } }));
    const samples = [...timeline.drain(true).samples, ...timeline.waitForUser("approval", "permission", 2)];
    let open = false;
    for (const [type] of samples) {
      if (type === "REASONING_MESSAGE_START") { expect(open).toBe(false); open = true; }
      if (type === "REASONING_MESSAGE_END") { expect(open).toBe(true); open = false; }
    }
    expect(open).toBe(false);
    expect(samples.filter(([t]) => t === "REASONING_MESSAGE_START")).toHaveLength(2);
  });

  it("does not equate a child launch acknowledgment or wait call with child completion", () => {
    const timeline = new FeishuCotTimeline("task");
    timeline.accept(message(1, "tool_use", { tool: "spawnAgent", toolCallId: "spawn", input: {
      senderThreadId: "parent", receiverThreadIds: ["child"], description: "检查接口", agentsStates: { child: { status: "running" } },
    } }));
    timeline.accept(message(2, "tool_result", { toolCallId: "spawn", status: "completed", output: "async_launched" }));
    const initial = timeline.drain().samples;
    expect(initial.filter(([t]) => t === "STEP_STARTED")).toHaveLength(1);
    expect(initial.filter(([t]) => t === "STEP_FINISHED")).toHaveLength(0);
    timeline.accept(message(3, "tool_use", { tool: "wait", toolCallId: "wait", input: {
      senderThreadId: "parent", receiverThreadIds: ["child"], agentsStates: { child: { status: "completed" } },
    } }));
    const ending = timeline.drain().samples;
    expect(ending.filter(([t]) => t === "STEP_STARTED")).toHaveLength(0);
    expect(ending.filter(([t]) => t === "STEP_FINISHED")).toHaveLength(1);
    expect(ending.find(([t]) => t === "STEP_FINISHED")?.[1].stepName).toBe("检查接口 · 已完成");
    expect(timeline.finish("completed").filter(([t]) => t === "STEP_FINISHED")).toHaveLength(0);
  });

  it("closes unresolved background work truthfully when the main run ends", () => {
    const timeline = new FeishuCotTimeline("task");
    timeline.accept(message(1, "tool_use", { tool: "Agent", toolCallId: "spawn", input: { description: "核对文档" } }));
    timeline.accept(message(2, "tool_result", { toolCallId: "spawn", status: "completed", output: "async_launched" }));
    const samples = timeline.finish("completed");
    expect(samples.find(([t]) => t === "STEP_FINISHED")?.[1].stepName).toBe("核对文档 · 本轮已结束，子任务结果见工作台");
  });

  it("bounds escaped Unicode labels, args and native plan lists to event limits", () => {
    const timeline = new FeishuCotTimeline("task");
    const long = '中文🙂"\\\n'.repeat(2000);
    timeline.accept(message(1, "tool_use", { tool: "Bash", toolCallId: "tc", input: { command: long, description: long } }));
    timeline.accept(message(2, "plan", { meta: { entries: [{ content: long, status: "pending" }] } }));
    const samples = timeline.finish("completed");
    expect(samples.every(([, c]) => Buffer.byteLength(JSON.stringify(c)) <= 4096)).toBe(true);
    expect(JSON.stringify(samples)).not.toContain("�");
  });

  for (const [name, input, title, icon] of [
    ["Read", { file_path: "/project/README.md" }, "读取 /project/README.md", "read"],
    ["Edit", { file_path: "/project/app.ts" }, "编辑 /project/app.ts", "write"],
    ["Grep", { pattern: "message_cot" }, "搜索 message_cot", "search"],
    ["Skill", { skill: "release-check" }, "阅读 release-check 技能", "doc"],
    ["ToolSearch", { query: "lark" }, "加载工具：lark", "find-app_outlined"],
    ["Start subagent reviewer", { agentThreadId: "child", activityKind: "review", agentPath: "agents/reviewer" }, "review · reviewer", "robot_outlined"],
  ] as const) it(`gives ${name} a meaningful title and native icon`, () => {
    expect(cotToolDisplay(name, input)).toMatchObject({ title, icon });
  });
});
