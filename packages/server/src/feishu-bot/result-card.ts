import type { MultiremiTask, MultiremiTaskMessage } from "@multiremi/contracts/types.js";
import { FeishuCotTimeline } from "@connectors/feishu/cot-timeline.js";
import { buildFinalCard } from "@connectors/feishu/streaming/card-elements.js";
import { formatCardStats, formatExecutionSubtitle } from "@connectors/feishu/card-metadata.js";
import { executionModel, readContextUsage, type AgentExecutionDisplay, type ContextUsage } from "@shared/agent-execution.js";

/** The same projection used by native CoT, rendered after the Task terminal commit. */
export function buildFeishuTaskResult(task: MultiremiTask, messages: MultiremiTaskMessage[], agentName: string | null) {
  const timeline = new FeishuCotTimeline(task.id);
  let execution: AgentExecutionDisplay = { agentName };
  let context: ContextUsage | null = null;
  for (const message of messages) {
    timeline.accept(message);
    if (message.meta?.parent_tool_call_id) continue;
    if (message.type === "usage") context = readContextUsage(message.meta) ?? context;
    if (message.type === "execution") {
      const info = message.meta ?? {};
      const model = Object.hasOwn(info, "model") ? executionModel(info.model) : undefined;
      if (model !== undefined && execution.model !== undefined && model !== execution.model) context = null;
      execution = { ...execution,
        ...(typeof info.agentName === "string" ? { agentName: info.agentName } : {}),
        ...(typeof info.provider === "string" ? { provider: info.provider } : {}),
        ...(model !== undefined ? { model, modelName: typeof info.modelName === "string" ? info.modelName : null } : {}) };
    }
  }
  const answer = timeline.answer(task.result ?? "");
  const text = task.status === "failed" ? `${answer}${answer ? "\n\n" : ""}**执行失败：** ${task.error || "请查看工作台任务详情"}`
    : task.status === "cancelled" ? `${answer}${answer ? "\n\n" : ""}任务已取消。` : answer || "任务已完成，未返回文字结果。";
  const elapsed = Math.max(0, Math.round((Date.parse(task.completedAt ?? "") - Date.parse(task.startedAt ?? task.createdAt)) / 1000));
  return { text, card: buildFinalCard({ text, agentName: execution.agentName, sessionId: task.sessionId,
    subtitle: formatExecutionSubtitle(execution), stats: formatCardStats(Number.isFinite(elapsed) ? elapsed : 0, context, timeline.toolCount) }) };
}
