export const QUEUED_CAPABILITY_GRACE_MS = 120_000;
// This lightweight alert uses task creation age. Before adding Inbox/Feishu
// delivery, persist starvation_started_at and measure continuous capability failure.
export const QUEUED_CAPABILITY_ALERT_MS = 15 * 60_000;
// Ownership is coupled to this text prefix until a structured reason code exists.
// Other queued wait reasons must not reuse it, or this observer may overwrite/clear them.
const CAPABILITY_WAIT_PREFIX = "等待模型能力恢复：";
// Keep the threshold stable: an increasing elapsed-minute counter would write
// every sweep and defeat persisted transition-based notification deduplication.
const CAPABILITY_ALERT_SUFFIX = "；任务创建已达 15 分钟，请检查 Runtime 模型能力";

// A hard-affinity task waits for an administrator to restore its Project device
// binding. Same ownership contract as the prefix above: only this observer may
// write or clear it (MUL-449).
export const DEVICE_ROUTING_WAIT_PREFIX = "等待项目设备：";

/**
 * No registered machine satisfies ALL of a Task's hard placement constraints.
 * A different prefix from the device one on purpose: the remedy is to make the
 * constraints agree (re-bind the Agent, restore a deleted workspace Runtime),
 * not to add a device back to the Project (MUL-449).
 */
export const PLACEMENT_WAIT_PREFIX = "等待任务落点：";

/** Every reason this observer owns, capability or device routing. */
export function isQueuedObserverWaitReason(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return reason.startsWith(CAPABILITY_WAIT_PREFIX)
    || reason.startsWith(DEVICE_ROUTING_WAIT_PREFIX)
    || reason.startsWith(PLACEMENT_WAIT_PREFIX);
}

export function isQueuedCapabilityWaitReason(reason: string | null | undefined): boolean {
  return reason?.startsWith(CAPABILITY_WAIT_PREFIX) ?? false;
}

/**
 * The hard affinities that can strand a Task on one machine (MUL-449). Used to
 * EXPLAIN a placement verdict, never to decide it: the decision comes from the
 * claim's own SQL.
 */
export type DeviceRoutingAffinity =
  | "Agent 绑定" | "代码快照" | "显式 Runtime 工作区" | "Issue 工作区" | "本机目录"
  // A retry whose frozen execution must resume where it was frozen. The
  // claim-time refreshes exclude it (see their `execution_fingerprint IS NULL
  // AND attempt = 1` filters), so its pin is visible rather than re-pooled.
  | "冻结重试";

/**
 * A task pinned to a machine that cannot reach it explains why instead of
 * rendering as an unexplained queue. Only hard affinities use this: soft
 * affinities re-pool instead.
 *
 * The remedy must actually clear the pin. `remi task redispatch` is NOT one:
 * it replaces the task with another one that re-derives the same hard
 * affinity, so it would produce an equally stuck task.
 */
export function deviceRoutingWaitReason(input: {
  runtimeName: string;
  /** `"会话"` is the generic label when no single hard affinity dominates. */
  affinity: DeviceRoutingAffinity | "会话";
}): string {
  const remedy = input.affinity === "Agent 绑定"
    ? "请调整该 Agent 的 Runtime 绑定"
    : "请把该机器加回项目的设备绑定，或取消它的独享设置";
  return `${DEVICE_ROUTING_WAIT_PREFIX}任务钉在 ${input.runtimeName}（${input.affinity}），`
    + `该机器不在项目的设备绑定里或为独享设备；${remedy}`;
}

/**
 * Why no machine can take this Task. The remedy is chosen by priority so the
 * text always names ONE action that actually resolves the conflict:
 *   1. a workspace whose Runtime is gone   → re-register that machine
 *   2. a frozen retry                      → redispatch (drops the frozen pin)
 *   3. an Agent-bound Runtime              → re-bind or unbind the Agent
 *   4. anything else                       → make the constraints agree
 */
export function placementWaitReason(input: {
  constraints: string[];
  workspaceRuntimeMissing?: boolean;
  frozenRetry?: boolean;
  agentBound?: boolean;
  redispatchTaskId?: string;
}): string {
  const listed = input.constraints.join("；");
  let remedy: string;
  if (input.workspaceRuntimeMissing) {
    remedy = "该 Issue 的工作区记录失去了所属 Runtime（状态 runtime_offline）；"
      + "重新注册原机器后可在其上重新接管，否则需要人工处理";
  } else if (input.frozenRetry && input.redispatchTaskId) {
    remedy = `运行 remi task redispatch ${input.redispatchTaskId} 冷启动，落点会按当前工作区重新计算`;
  } else if (input.agentBound) {
    remedy = "把该 Agent 的 Runtime 绑定改到工作区所在机器，或解除绑定（remi agent update --runtime）";
  } else {
    remedy = "让这些约束指向同一台机器";
  }
  return `${PLACEMENT_WAIT_PREFIX}没有一台机器同时满足：${listed}；${remedy}`;
}

export function isQueuedCapabilityAlert(reason: string | null | undefined): boolean {
  return isQueuedCapabilityWaitReason(reason) && reason!.endsWith(CAPABILITY_ALERT_SUFFIX);
}

/** Pure decision over all routing-eligible candidates, including offline/busy ones. */
export function queuedCapabilityWait(input: {
  candidateSupportsModel: readonly boolean[];
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
  return {
    reason: `${CAPABILITY_WAIT_PREFIX}${input.candidateSupportsModel.length} 个候选 Runtime 均无法执行 ${selection}${alerted ? CAPABILITY_ALERT_SUFFIX : ""}`,
    alerted,
  };
}
