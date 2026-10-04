import type { MultiremiTask } from "@multiremi/contracts/types.js";
import { formatCardStats } from "@connectors/feishu/card-metadata.js";

/** Durable answer fallback. The sending daemon adds display metadata from trace. */
export function buildFeishuTaskResult(task: MultiremiTask, agentName: string | null) {
  const answer = (task.result ?? "").trim();
  const text = task.status === "failed" ? `${answer}${answer ? "\n\n" : ""}**执行失败：** ${task.error || "请查看工作台任务详情"}`
    : task.status === "cancelled" ? `${answer}${answer ? "\n\n" : ""}任务已取消。` : answer || "任务已完成，未返回文字结果。";
  const elapsed = Math.max(0, Math.round((Date.parse(task.completedAt ?? "") - Date.parse(task.startedAt ?? task.createdAt)) / 1000));
  const elapsedSeconds = Number.isFinite(elapsed) ? elapsed : 0;
  return { text, agentName, sessionId: task.sessionId, elapsedSeconds,
    subtitle: agentName, stats: formatCardStats(elapsedSeconds, null, 0) };
}
