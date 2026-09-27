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
  // A frozen fingerprint or an unfingerprinted later attempt is excluded by
  // the claim-time refresh. Only the former is a frozen retry.
  | "冻结重试" | "重试钉机";

/**
 * A task pinned to a machine that cannot reach it explains why instead of
 * rendering as an unexplained queue. Only hard affinities use this: soft
 * affinities re-pool instead.
 *
 * Redispatch alone does not resolve data pins: its replacement re-derives
 * the same hard affinity. An Agent binding conflict needs rebinding as well.
 */
export function deviceRoutingWaitReason(input: {
  runtimeName: string;
  /** `"会话"` is the generic label when no single hard affinity dominates. */
  affinity: DeviceRoutingAffinity | "会话";
  frozenTask?: boolean;
}): string {
  const remedy = input.affinity === "Agent 绑定"
    ? `请调整该 Agent 的 Runtime 绑定${input.frozenTask ? "；直接改绑会取消这条已冻结的任务" : ""}`
    : "请把该机器加回项目的设备绑定，或取消它的独享设置";
  return `${DEVICE_ROUTING_WAIT_PREFIX}任务钉在 ${input.runtimeName}（${input.affinity}），`
    + `该机器不在项目的设备绑定里或为独享设备；${remedy}`;
}

/**
 * Why no machine can take this Task. The remedy is chosen by priority so the
 * text always names ONE action that actually resolves the conflict:
 *   1. a workspace whose Runtime is gone   → re-register that machine
 *   2. a frozen retry without data pins    → redispatch (preserves the request)
 *   3. an Agent-bound Runtime              → re-bind to the other constraints' machine
 *   4. anything else                       → make the constraints agree
 */
export function placementWaitReason(input: {
  constraints: string[];
  workspaceRuntimeMissing?: boolean;
  frozenRetry?: boolean;
  agentBound?: boolean;
  codeSnapshot?: boolean;
  localDirectory?: boolean;
  agentBindingTarget?: string | null;
  agentBindingRuntimeId?: string | null;
  frozenTask?: boolean;
  agentId?: string | null;
  redispatchTaskId?: string;
}): string {
  const listed = input.constraints.join("；");
  let remedy: string;
  const redispatch = input.redispatchTaskId
    ? `remi task redispatch ${input.redispatchTaskId} --reason '恢复已冻结任务并保留原请求' --yes`
    : null;
  if (input.workspaceRuntimeMissing) {
    remedy = "该 Issue 的工作区记录失去了所属 Runtime（状态 runtime_offline）；"
      + "重新注册原机器后可在其上重新接管，否则需要人工处理";
  } else if (input.frozenRetry && !input.codeSnapshot && !input.localDirectory && redispatch) {
    remedy = `运行 ${redispatch} 冷启动，落点会按当前工作区重新计算`;
  } else if (input.agentBound && input.agentBindingTarget && input.agentBindingRuntimeId && input.agentId) {
    const rebind = `remi agent update ${input.agentId} --runtime ${input.agentBindingRuntimeId}`;
    if (input.frozenTask && redispatch) {
      remedy = `直接改绑会取消这条已冻结的任务；先运行 ${redispatch}，再运行 ${rebind}，由 ${input.agentBindingTarget} 领取替代任务`;
    } else {
      remedy = `把该 Agent 的 Runtime 绑定改到 ${input.agentBindingTarget}（${rebind}）`;
    }
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
