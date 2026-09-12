import { describe, expect, it } from "bun:test";
import { FeishuCotTimeline } from "@connectors/feishu/cot-timeline.js";
import { cotToolDisplay, isCotSubagent } from "@connectors/feishu/cot-tool-display.js";
import type { MultiremiTaskMessage } from "@multiremi/contracts/types.js";
import { taskEvent } from "./feishu-native-harness.js";

const message = (seq: number, type: string, patch: Record<string, unknown> = {}) =>
  (taskEvent(seq, type, patch) as { message: MultiremiTaskMessage }).message;

describe("semantic native CoT timeline", () => {
  it("distinguishes spawning an agent from reading agent or task metadata", () => {
    expect(isCotSubagent("mcp__aiden_bot__spawn_agent", {})).toBe(true);
    expect(isCotSubagent("get_agent", {})).toBe(false);
    expect(isCotSubagent("remi/get_task", {})).toBe(false);
  });
  it("waits for delayed ACP args and description instead of permanently naming a shell Bash", () => {
    let now = 0;
    const timeline = new FeishuCotTimeline("task", 0, () => now);
    timeline.accept(message(1, "tool_use", { toolCallId: "tc", tool: "Bash" }));
    timeline.accept(message(2, "tool_use", { toolCallId: "tc", input: { command: "rg foo src" } }));
    now = 500;
    expect(timeline.drain()).toEqual({ samples: [], throughSeq: 0 });
    timeline.accept(message(3, "tool_use", { toolCallId: "tc", input: { description: "搜索调用入口" } }));
    const { samples, throughSeq } = timeline.drain();
    expect(throughSeq).toBe(3);
    expect(samples.filter(([t]) => t === "TOOL_CALL_START").map(([, c]) => c)).toEqual([
      expect.objectContaining({ title: "搜索调用入口", icon: "search", toolCallName: "Bash" }),
    ]);
    timeline.accept(message(4, "tool_result", { toolCallId: "tc", output: '{"huge":"private log"}', status: "completed" }));
    expect(timeline.drain().samples).toEqual([]);
  });

  it("bounded title buffering never hides a long running command indefinitely", () => {
    let now = 0;
    const timeline = new FeishuCotTimeline("task", 0, () => now);
    timeline.accept(message(1, "tool_use", { tool: "Bash", toolCallId: "tc", input: { command: "bun test" } }));
    expect(timeline.drain().samples).toHaveLength(0);
    now = 1001;
    expect(timeline.drain().samples[0]?.[1].title).toBe("执行：bun test");
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

  it("keeps narration in chronological segments, without child prose, hook noise or final text", () => {
    const timeline = new FeishuCotTimeline("task");
    timeline.accept(message(1, "text", { content: "先读取。" }));
    timeline.accept(message(2, "text", { content: "再检查。", meta: { phase: "commentary" } }));
    timeline.accept(message(3, "tool_use", { tool: "Read", toolCallId: "tc", input: { path: "/source.ts" } }));
    timeline.accept(message(4, "text", { content: "child secret", meta: { parent_tool_call_id: "tc" } }));
    timeline.accept(message(5, "system", { content: "hook heartbeat" }));
    timeline.accept(message(6, "text", { content: "已核对。", meta: { phase: "commentary" } }));
    timeline.accept(message(7, "text", { content: "最终答案", meta: { phase: "final" } }));
    const samples = timeline.finish("completed");
    const prose = samples.filter(([t]) => t === "REASONING_MESSAGE_CONTENT").map(([, c]) => c.delta).join("");
    expect(prose).toBe("先读取。再检查。已核对。");
    expect(samples.filter(([t]) => t === "REASONING_MESSAGE_START")).toHaveLength(2);
    expect(samples.filter(([t]) => t === "REASONING_MESSAGE_END")).toHaveLength(2);
    expect(timeline.answer("")).toBe("最终答案");
    expect(JSON.stringify(samples)).not.toContain("secret");
    expect(JSON.stringify(samples)).not.toContain("heartbeat");
  });

  it("renders actual changing plan entries, with a string-encoded native result and no duplicate update", () => {
    const timeline = new FeishuCotTimeline("task");
    const entries = [{ content: "检查", status: "completed" }, { content: "验证", status: "in_progress" }];
    timeline.accept(message(1, "plan", { meta: { entries } }));
    timeline.accept(message(2, "plan", { meta: { entries } }));
    const samples = timeline.drain().samples;
    expect(samples.filter(([t]) => t === "TOOL_CALL_START")).toHaveLength(1);
    expect(samples[0]?.[1].title).toBe("更新待办 (1/2)");
    expect(JSON.parse(String(samples.at(-1)?.[1].content))).toEqual({ type: "code", code: "✅ 检查\n🔄 验证" });
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

  it("bounds escaped Unicode labels, args and todo results to native event limits", () => {
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
