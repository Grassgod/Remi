import type { MultiremiStore } from "@multiremi/store/store.js";
import type { DaemonDownlinkEntity } from "./downlinks.js";

export function taskInputSnapshot(store: MultiremiStore, runtimeId: string, daemonId: string, activeTaskIds: ReadonlySet<string>,
  forget: (taskId: string) => void): DaemonDownlinkEntity[] {
  const ids = new Set(activeTaskIds);
  for (const task of store.listTaskRefs({ runtimeId,
    statuses: ["dispatched", "running", "waiting_local_directory", "awaiting_human"] })) ids.add(task.id);
  const host = store.getRuntimeLite(runtimeId);
  const entities: DaemonDownlinkEntity[] = [];
  for (const id of ids) {
    const task = store.getTaskIdentity(id);
    if (!task || task.runtimeId !== runtimeId || task.workspaceId !== host?.workspaceId) {
      forget(id); continue;
    }
    if (["completed", "failed", "cancelled"].includes(task.status)) {
      entities.push({ key: `cancel:${id}:${task.status}`, type: "task.cancelled",
        payload: { task_id: id, status: task.status }, claimed: () => forget(id), discard: () => forget(id) });
      continue;
    }
    for (const steer of store.listPendingTaskSteerMessages(id)) entities.push({
      key: `steer:${steer.id}`, type: "task.steer", payload: { task_id: id, steer },
      discard: () => { store.consumeTaskSteerMessages(id, [steer.id]); },
    });
    for (const request of store.listTaskHumanRequests(id)) {
      if (request.status === "pending") continue;
      entities.push({ key: `human:${request.id}`, type: "task.human_request.settled", payload: { task_id: id, request } });
    }
  }
  if (host?.daemonId === daemonId && host.workspaceId) {
    for (const candidate of store.listFeishuBotSettledHumanRequestCandidates(host.workspaceId, runtimeId)) {
      const task = store.getTaskIdentity(candidate.taskId);
      if (!task || task.workspaceId !== host.workspaceId || task.runtimeId === runtimeId) continue;
      if (!store.canFeishuBotDaemonAccessTask(host.workspaceId, daemonId, task.id)
        && !store.canFeishuBotDaemonAccessIssueTaskHumanRequest(host.workspaceId, daemonId, task.id)) continue;
      const request = store.getTaskHumanRequest(candidate.requestId);
      if (!request || request.taskId !== task.id || request.status === "pending") continue;
      entities.push({ key: `human:${request.id}`, type: "task.human_request.settled",
        payload: { task_id: task.id, request } });
    }
  }
  return entities;
}
