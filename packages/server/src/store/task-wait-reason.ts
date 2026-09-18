export const QUEUED_CAPABILITY_GRACE_MS = 120_000;
// This lightweight alert uses task creation age. Before adding Inbox/Feishu
// delivery, persist starvation_started_at and measure continuous capability failure.
export const QUEUED_CAPABILITY_ALERT_MS = 15 * 60_000;
// Ownership is coupled to this text prefix until a structured reason code exists.
// Other queued wait reasons must not reuse it, or this observer may overwrite/clear them.
const CAPABILITY_WAIT_PREFIX = "等待模型能力恢复：";
const EXECUTION_WAIT_PREFIX = "等待执行条件恢复：";
// Keep the threshold stable: an increasing elapsed-minute counter would write
// every sweep and defeat persisted transition-based notification deduplication.
const CAPABILITY_ALERT_SUFFIX = "；任务创建已达 15 分钟，请检查 Runtime 模型能力";
const EXECUTION_ALERT_SUFFIX = "；任务创建已达 15 分钟，请检查 Runtime 执行条件";

export function isQueuedCapabilityWaitReason(reason: string | null | undefined): boolean {
  return Boolean(reason?.startsWith(CAPABILITY_WAIT_PREFIX) || reason?.startsWith(EXECUTION_WAIT_PREFIX));
}

export function isQueuedCapabilityAlert(reason: string | null | undefined): boolean {
  return isQueuedCapabilityWaitReason(reason)
    && (reason!.endsWith(CAPABILITY_ALERT_SUFFIX) || reason!.endsWith(EXECUTION_ALERT_SUFFIX));
}

/** Pure decision over all routing-eligible candidates, including offline/busy ones. */
export function queuedCapabilityWait(input: {
  candidateSupportsModel: readonly boolean[];
  /** Static claim failures for the same candidates; absence preserves model-only wording. */
  candidateBlockers?: readonly (string | null)[];
  model: string | null;
  thinkingLevel: string | null;
  createdAt: string;
  now: number;
}): { reason: string; alerted: boolean } | null {
  const ageMs = input.now - Date.parse(input.createdAt);
  if (!Number.isFinite(ageMs) || ageMs < QUEUED_CAPABILITY_GRACE_MS
    || input.candidateSupportsModel.length === 0 || input.candidateSupportsModel.some(Boolean)) return null;
  const selection = `${input.model || "默认模型"}${input.thinkingLevel ? `（thinking: ${input.thinkingLevel}）` : ""}`;
  const alerted = ageMs >= QUEUED_CAPABILITY_ALERT_MS;
  if (input.candidateBlockers?.some(Boolean)) {
    const details = [...new Set(input.candidateBlockers.map(reason => reason ?? `模型能力不支持 ${selection}`))].sort();
    return {
      reason: `${EXECUTION_WAIT_PREFIX}${details.join("；")}${alerted ? EXECUTION_ALERT_SUFFIX : ""}`,
      alerted,
    };
  }
  return {
    reason: `${CAPABILITY_WAIT_PREFIX}${input.candidateSupportsModel.length} 个候选 Runtime 均无法执行 ${selection}${alerted ? CAPABILITY_ALERT_SUFFIX : ""}`,
    alerted,
  };
}
