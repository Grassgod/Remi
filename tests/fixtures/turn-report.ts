import type { MultiremiStore } from "@multiremi/store.js";

/** Manually claimed fixtures consume the same inline input that a daemon receives. */
export function readOfferedTurnInput(store: MultiremiStore, attemptId: string): void {
  const task = store.getTaskWithAgent(attemptId);
  if (!task?.runtimeId) throw new Error(`Claimed attempt required: ${attemptId}`);
  const bridge = store.getDaemonTurnBridge();
  const offer = bridge.offerInput(task);
  const result = bridge.rpc("turn.input", {
    turn_id: offer.turn_id, attempt_id: offer.attempt_id, input_to_seq: offer.input_to_seq,
    message_ids: offer.input_messages.map(message => message.id),
  }, { runtimeId: task.runtimeId, workspaceId: task.workspaceId,
    daemonId: store.getRuntime(task.runtimeId)!.daemonId! });
  if (result.ok !== true) throw new Error(`Input receipt rejected: ${JSON.stringify(result)}`);
}

/** Build the current wire contract from an offer that this fixture actually received. */
export function turnCompletion(store: MultiremiStore, attemptId: string, body: string,
  fields: Record<string, unknown> = {}): Record<string, unknown> {
  const task = store.getTask(attemptId);
  const turn = store.getTurnForAttempt(attemptId);
  if (!task || !turn) throw new Error(`Missing completion fixture attempt: ${attemptId}`);
  return { ...fields, turn_id: turn.id, attempt_id: attemptId,
    input_to_seq: turn.input_to_seq ?? 0,
    reply: { body_md: body, message_kind: "final" } };
}

export function completionResponse(store: MultiremiStore, attemptId: string) {
  const turn = store.getTurnForAttempt(attemptId);
  if (!turn?.reply_message_id) throw new Error(`Missing committed fixture reply: ${attemptId}`);
  return { ok: true, turn_id: turn.id, reply_message_id: turn.reply_message_id };
}
