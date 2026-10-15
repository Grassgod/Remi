import type { TraceItem } from "@multiremi/contracts/trace";
import {
  at, command, message, read, search, subagent, tool, unknown, userMessage,
} from "../../../test/trace-fixtures";

// Subagent traces for the PR 5 Chat tests, trimmed from the prototype's mock
// data, with the bridges' real tool names (shared `agentControl`): Claude
// `SendMessage` / `TaskStop` / `ListAgents`, Codex `spawnAgent` / `sendInput`
// / `wait`. Times are seconds after `T0`.

const running = { status: "in_progress" as const, completed_at: null, duration_ms: null };

/**
 * A Claude turn still running: Explore runs in the background and has spawned
 * a nested general-purpose agent; Plan runs in the foreground; the root sent
 * Explore a message.
 */
export function claudeLiveItems(): TraceItem[] {
  return [
    userMessage("in:1", "找出前端读取 trace 的地方，再出一个面板方案"),
    subagent("sa:explore", "查找 trace 读取方", {
      ...running, name: "查找 trace 读取方", agent_type: "Explore", background: true, thread_id: "a-explore",
      prompt: "在 `frontend/packages` 里找出所有读取 trace 的组件（useTurnTrace / useTaskTrace），列出文件和调用方式。",
      started_at: at(2),
    }),
    command("cmd:e1", [search("useTurnTrace", "frontend/packages")], { parent_id: "sa:explore", started_at: at(3), completed_at: at(4) }),
    subagent("sa:gp", "核对飞书步骤文案", {
      ...running, parent_id: "sa:explore", name: "核对飞书步骤文案", agent_type: "general-purpose",
      prompt: "看看服务端 feishu/cot-timeline.ts 的步骤文案是否和 Chat 一致。", started_at: at(6),
    }),
    command("cmd:g1", [read("packages/connectors/src/feishu/cot-timeline.ts")], { parent_id: "sa:gp", ...running, started_at: at(7) }),
    message("msg:1", "Explore 在后台查找读取方，接下来让 Plan 设计数据流。", "commentary", { started_at: at(8), completed_at: at(9) }),
    tool("t:send", "SendMessage", { input: { to: "a-explore", message: "顺便看看 **execution-log** 的读取" }, started_at: at(9), completed_at: at(9) }),
    subagent("sa:plan", "设计面板数据流", {
      ...running, name: "设计面板数据流", agent_type: "Plan", background: false, model: "sonnet",
      prompt: "基于 PR 2 的 turn + items trace，设计 Chat 子代理面板的数据流。", started_at: at(10),
    }),
    message("msg:p1", "先看 use-task-trace.ts 的缓存键。", "commentary", { parent_id: "sa:plan", ...running, started_at: at(11) }),
  ];
}

/** A finished Claude turn: Explore completed (resumed once), Plan was stopped, Review failed. */
export function claudeDoneItems(): TraceItem[] {
  return [
    userMessage("in:1", "审阅一下飞书步骤文案的改动"),
    subagent("sa:review", "审阅文案差异", {
      name: "审阅文案差异", agent_type: "Explore", background: true, model: "haiku",
      prompt: "审阅 `claude/feishu-step-copy` 分支的改动。", output: "审阅结论：文案一致。",
      started_at: at(1), completed_at: at(42), duration_ms: 41_000,
    }),
    command("cmd:r1", [read("cot-timeline.ts")], { parent_id: "sa:review", started_at: at(2), completed_at: at(3) }),
    command("cmd:r2", [unknown("git diff main")], { parent_id: "sa:review", started_at: at(3), completed_at: at(5) }),
    message("msg:r1", "第一轮：中文文案没问题。", "commentary", { parent_id: "sa:review", started_at: at(6), completed_at: at(8) }),
    // Resumed by SendMessage: a second generation with its own instructions.
    { ...userMessage("um:r2", "再看看 ja 和 ko 的翻译"), parent_id: "sa:review", started_at: at(20), completed_at: at(20) },
    command("cmd:r3", [read("ja/chat.json")], { parent_id: "sa:review", started_at: at(21), completed_at: at(22) }),
    message("msg:r2", "审阅结论：ja / ko 缺两个片段。", "commentary", { parent_id: "sa:review", started_at: at(30), completed_at: at(41) }),
    subagent("sa:plan", "列出回归测试清单", {
      status: "stopped", name: "列出回归测试清单", agent_type: "Plan", prompt: "列出需要补的回归测试。",
      output: "已列出 3 项", started_at: at(4), completed_at: at(9), duration_ms: 5_000,
    }),
    command("cmd:p1", [read("TESTING.md")], { parent_id: "sa:plan", started_at: at(5), completed_at: at(6) }),
    tool("t:stop", "TaskStop", { input: { task_id: "sa:plan" }, started_at: at(9), completed_at: at(9) }),
    subagent("sa:fail", "排查发送超时", {
      status: "failed", name: "排查发送超时", prompt: "查一下飞书卡片为什么发送超时。",
      output: "Error: connect ETIMEDOUT open.feishu.cn:443", started_at: at(10), completed_at: at(15), duration_ms: 5_000,
    }),
    message("msg:f", "审阅完了：ja / ko 缺两个片段。", "final", { started_at: at(45), completed_at: at(48) }),
  ];
}

/** A Codex turn with native child sessions: one child, a sendInput and the hidden wait. */
export function codexItems(): TraceItem[] {
  return [
    userMessage("in:1", "统计各包文件数和 TODO"),
    subagent("sa:t1", "count_files", {
      tool: "spawnAgent", name: "count_files", thread_id: "t1", prompt: null, background: null,
      output: "core 120 个文件", started_at: at(1), completed_at: at(9), duration_ms: 8_000,
    }),
    command("cmd:c1", [unknown("find packages/core -type f | wc -l")], { parent_id: "sa:t1", started_at: at(2), completed_at: at(3) }),
    message("msg:c1", "core 120 个文件", "commentary", { parent_id: "sa:t1", started_at: at(4), completed_at: at(5) }),
    tool("t:input", "sendInput", { input: { receiverThreadIds: ["t1"], prompt: "也数一下 views" }, started_at: at(2), completed_at: at(2) }),
    tool("t:wait", "wait", { input: { receiverThreadIds: ["t1"] }, started_at: at(3), completed_at: at(9) }),
    message("msg:f", "core 有 120 个文件。", "final", { started_at: at(10), completed_at: at(11) }),
  ];
}
