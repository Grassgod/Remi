import type { MultiremiStore } from "@multiremi/store/store.js";
import type { DaemonDownlinkEntity } from "./downlinks.js";
import type { DaemonTurnBridge } from "./turn-bridge.js";

export function taskInputSnapshot(store: MultiremiStore, runtimeId: string, daemonId: string, activeTaskIds: ReadonlySet<string>,
  forget: (taskId: string) => void, turns?: DaemonTurnBridge): DaemonDownlinkEntity[] {
  const ids = new Set(activeTaskIds);
  for (const task of store.listTaskRefs({ runtimeId,
    statuses: ["dispatched", "running", "waiting_local_directory", "awaiting_human"] })) ids.add(task.id);
  const host = store.getRuntimeLite(runtimeId);
  const entities: DaemonDownlinkEntity[] = [];
  for (const id of ids) {
    const task = store.getTaskIdentity(id);
    if (!task || task.runtimeId !== runtimeId) { forget(id); continue; }
    if (["completed", "failed", "cancelled"].includes(task.status)) {
      entities.push({ key: `cancel:${id}:${task.status}`, type: "task.cancelled",
        payload: { task_id: id, status: task.status }, claimed: () => forget(id), discard: () => forget(id) });
      continue;
    }
  }
  if (turns && host) {
    const snapshot = turns.snapshot({ runtimeId, daemonId, workspaceId: host.workspaceId ?? "local" }, ids);
    for (const input of snapshot.messages) entities.push({
      key: `turn.message:${input.attempt_id}:${input.message.id}`, type: "turn.message", payload: { ...input },
    });
    for (const control of snapshot.wrapUps) entities.push({
      key: `turn.wrap_up:${control.attempt_id}:${control.requested_at}`, type: "turn.wrap_up", payload: { ...control },
    });
  }
  return entities;
}
