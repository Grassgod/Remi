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

export interface PlacementRecovery {
  anchorName?: string | null;
  anchorRuntimeId?: string | null;
  anchorRoutingAllowed?: boolean;
  agentNeedsRebind?: boolean;
  conflictingDataConstraints?: string[];
  anchorRoutingState?: DeviceRoutingState | null;
}

export interface DeviceRoutingState {
  projectId: string | null;
  projectHasDevices: boolean;
  machineBound: boolean;
  runtimeWorkspaceOnMachine: boolean;
  dedicated: boolean;
}

/** Only offer an action that, by itself, satisfies the claim's two routing clauses. */
export function deviceRoutingRepair(state: DeviceRoutingState, machineName: string): {
  cause: string; actions: string[];
} | null {
  const bindingAllowed = !state.projectId || !state.projectHasDevices || state.machineBound;
  const dedicatedAllowed = !state.dedicated || (Boolean(state.projectId) && state.machineBound)
    || state.runtimeWorkspaceOnMachine;
  if (bindingAllowed && dedicatedAllowed) return null;
  const actions: string[] = [];
  if (state.projectId) actions.push(`把 ${machineName} 加回项目的设备绑定`);
  if (state.dedicated && bindingAllowed) actions.push(`取消 ${machineName} 的独享设置`);
  if (!actions.length) throw new Error(`No effective device-routing remedy for ${machineName}`);
  const cause = !bindingAllowed
    ? `该机器不在项目的设备绑定里${state.dedicated ? "，且是独享设备" : ""}`
    : `该机器是独享设备，${state.projectId ? "而项目没有设备绑定" : "而任务没有项目"}`;
  return { cause, actions };
}

function chatResendSteps(chatId: string, taskId: string): string {
  return `由能查看该 Chat 的用户运行 remi chat message list ${chatId} --output json，找到 task_id 为 ${taskId} 且 role 为 user 的消息；若本页没有，用上一页的 next_cursor JSON 作为 --cursor '<next_cursor JSON>' 继续翻到更早的消息；把 content 字段正文原样存成文件，再运行 remi chat message create ${chatId} --content-file <文件> 重发（两步可以由不同的人执行；附件需重新上传）`;
}

function rebindRemedy(input: {
  agentId: string; runtimeId: string; targetName: string; frozenTask?: boolean;
  chatSessionId?: string | null; taskId?: string | null;
}): string {
  const command = `remi agent update ${input.agentId} --runtime ${input.runtimeId}`;
  if (!input.frozenTask) return `把该 Agent 的 Runtime 绑定改到 ${input.targetName}（${command}）`;
  if (input.chatSessionId && input.taskId) {
    return `直接改绑会取消这条已冻结的任务；由 Agent 所有者或工作区 owner/admin 先运行 ${command}，再${chatResendSteps(input.chatSessionId, input.taskId)}；由 ${input.targetName} 领取新任务`;
  }
  const redispatch = input.taskId
    ? `remi task redispatch ${input.taskId} --reason '恢复已冻结任务并保留原请求' --yes`
    : null;
  return redispatch
    ? `直接改绑会取消这条已冻结的任务；先运行 ${redispatch}，再运行 ${command}，由 ${input.targetName} 领取替代任务`
    : `直接改绑会取消这条已冻结的任务；把该 Agent 的 Runtime 绑定改到 ${input.targetName}（${command}）`;
}

function anchoredRemedy(input: PlacementRecovery & {
  agentId?: string | null; frozenTask?: boolean; chatSessionId?: string | null; taskId?: string | null;
}): string | null {
  if (input.conflictingDataConstraints?.length) {
    return `${input.conflictingDataConstraints.join("；")}互相冲突；让这些约束指向同一台机器`;
  }
  if (!input.anchorName) return null;
  const actions: string[] = [];
  if (!input.anchorRoutingAllowed) {
    if (!input.anchorRoutingState) return "让这些约束指向同一台机器";
    const repair = deviceRoutingRepair(input.anchorRoutingState, input.anchorName);
    if (!repair) throw new Error("Anchor routing verdict disagrees with its routing state");
    actions.push(`${repair.cause}；${repair.actions.join("，或")}`);
  }
  if (input.agentNeedsRebind) {
    if (!input.agentId || !input.anchorRuntimeId) return "让这些约束指向同一台机器";
    actions.push(rebindRemedy({
      agentId: input.agentId, runtimeId: input.anchorRuntimeId, targetName: input.anchorName,
      frozenTask: input.frozenTask, chatSessionId: input.chatSessionId, taskId: input.taskId,
    }));
  }
  return actions.join("；") || null;
}

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
  chatSessionId?: string | null;
  agentId?: string | null;
  taskId?: string | null;
  routingState: DeviceRoutingState;
} & PlacementRecovery): string {
  const repair = deviceRoutingRepair(input.routingState, input.runtimeName);
  if (!repair) throw new Error("Device wait reason requires rejected routing");
  const anchor = anchoredRemedy(input);
  const remedy = anchor ?? repair.actions.join("，或");
  return `${DEVICE_ROUTING_WAIT_PREFIX}任务钉在 ${input.runtimeName}（${input.affinity}），`
    + `${anchor ? "" : `${repair.cause}；`}${remedy}`;
}

/**
 * Why no machine can take this Task. The remedy is chosen by priority so the
 * text names the ordered actions needed to resolve the conflict:
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
  chatSessionId?: string | null;
} & PlacementRecovery): string {
  const listed = input.constraints.join("；");
  let remedy: string;
  const redispatch = input.redispatchTaskId
    ? `remi task redispatch ${input.redispatchTaskId} --reason '恢复已冻结任务并保留原请求' --yes`
    : null;
  const anchor = anchoredRemedy({ ...input, taskId: input.redispatchTaskId });
  if (input.workspaceRuntimeMissing) {
    remedy = "该 Issue 的工作区记录失去了所属 Runtime（状态 runtime_offline）；"
      + "重新注册原机器后可在其上重新接管，否则需要人工处理";
  } else if (anchor) {
    remedy = anchor;
  } else if (input.frozenRetry && !input.chatSessionId && !input.codeSnapshot && !input.localDirectory && redispatch) {
    remedy = `运行 ${redispatch} 冷启动，落点会按当前工作区重新计算`;
  } else if (input.agentBound && input.agentBindingTarget && input.agentBindingRuntimeId && input.agentId) {
    remedy = rebindRemedy({ agentId: input.agentId, runtimeId: input.agentBindingRuntimeId,
      targetName: input.agentBindingTarget, frozenTask: input.frozenTask,
      chatSessionId: input.chatSessionId, taskId: input.redispatchTaskId });
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
