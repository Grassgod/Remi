import type { MultiremiStore } from "@multiremi/store/store.js";
import type { DaemonProtocolLayer } from "./index.js";
import type { DaemonParsedFrame } from "./frames.js";
import type { DaemonProtocolSession } from "./session.js";
import { daemonAgentPluginDesiredResponse } from "../wire/agent-plugins.js";
import { daemonTaskRuntimeIdentityDenial } from "../helpers/auth-guards.js";
import type { DaemonTurnBridge, DaemonTurnRpc } from "./turn-bridge.js";

const denied = (code = "invalid_report") => ({ ok: false, code, retryable: false });

export function registerTaskInputRpcs(layer: DaemonProtocolLayer, store: MultiremiStore, kick: (runtimeId: string) => void, turns?: DaemonTurnBridge): void {
  const authorized = async (frame: DaemonParsedFrame, session: DaemonProtocolSession): Promise<boolean> => {
    if (!frame.rt || !session.runtimeIds.includes(frame.rt)) return false;
    const runtime = await layer.authorizeRuntimeForTest({ accessToken: session.ownerAccessToken,
      masterToken: session.ownerAccessToken === null }, session.daemonId, frame.rt);
    return runtime.ok;
  };
  const taskGuard = async (frame: DaemonParsedFrame, session: DaemonProtocolSession) => {
    if (!await authorized(frame, session)) return { ...denied("authority_revoked"), http_status: 403, http_code: "daemon_identity_forbidden" };
    if (typeof frame.payload.task_id !== "string") return denied();
    const task = store.getTaskIdentity(frame.payload.task_id);
    if (!task) return { ...denied("task_not_found"), http_status: 404, http_code: null };
    if (task.runtimeId !== frame.rt) return { ...denied("authority_revoked"), http_status: 403, http_code: "daemon_identity_forbidden" };
    const refusal = daemonTaskRuntimeIdentityDenial(store, session.ownerAccessToken, frame.payload.task_id);
    if (refusal) return { ok: false, code: refusal.status === 404 ? "task_not_found" : "authority_revoked",
      message: refusal.body.error, retryable: false, http_status: refusal.status, http_code: refusal.body.code ?? null };
    return null;
  };
  for (const type of ["turn.input", "turn.decision", "turn.decision.get", "turn.decision.expire"] as const) {
    layer.registerRpcHandler(type, async (frame, session) => {
      if (!await authorized(frame, session)) return denied("authority_revoked");
      const p = frame.payload;
      if (typeof p.turn_id !== "string" || !p.turn_id || typeof p.attempt_id !== "string" || !p.attempt_id || "task_id" in p) return denied();
      if (type === "turn.input" && (!Number.isSafeInteger(p.input_to_seq) || (p.input_to_seq as number) < 0
        || !Array.isArray(p.message_ids) || p.message_ids.some(id => typeof id !== "string" || !id))) return denied();
      if (type === "turn.decision" && (typeof p.body_md !== "string" || typeof p.dedupe_key !== "string" || !p.dedupe_key
        || !Array.isArray(p.options) || p.options.some(option => !option || typeof option.label !== "string" || typeof option.value !== "string")
        || !p.metadata || typeof p.metadata !== "object" || Array.isArray(p.metadata)
        || (p.timeout_ms !== undefined && (typeof p.timeout_ms !== "number" || !Number.isFinite(p.timeout_ms) || p.timeout_ms < 0)))) return denied();
      if (type !== "turn.input" && type !== "turn.decision" && (typeof p.message_id !== "string" || !p.message_id)) return denied();
      if (type === "turn.decision.expire" && p.status !== "cancelled" && p.status !== "timeout") return denied();
      if (!turns) return { ok: false, code: "server_error", retryable: true, message: "unified turn store is not installed" };
      const result = await turns.rpc(type as DaemonTurnRpc, p, { runtimeId: frame.rt!, daemonId: session.daemonId,
        workspaceId: store.getRuntimeLite(frame.rt!)!.workspaceId ?? "local" });
      kick(frame.rt!);
      return result;
    });
  }
  layer.registerRpcHandler("human_request.create", async (frame, session) => {
    const refusal = await taskGuard(frame, session); if (refusal) return refusal;
    const { kind, payload, request_id, timeout_ms } = frame.payload;
    if ((kind !== "permission" && kind !== "question") || typeof request_id !== "string" || !request_id || request_id.length > 128
      || !payload || typeof payload !== "object" || Array.isArray(payload)
      || (timeout_ms !== undefined && (typeof timeout_ms !== "number" || !Number.isFinite(timeout_ms) || timeout_ms < 0))) return denied();
    const taskId = String(frame.payload.task_id);
    const existing = store.getTaskHumanRequest(request_id);
    if (existing && (existing.taskId !== taskId || existing.kind !== kind)) return denied("authority_revoked");
    if (!existing && ["completed", "failed", "cancelled"].includes(store.getTaskIdentity(taskId)!.status)) return denied();
    const request = existing ?? store.createTaskHumanRequest({ id: request_id, taskId, kind,
      payload: payload as Record<string, unknown>, timeoutMs: timeout_ms as number | undefined });
    kick(frame.rt!);
    return { ok: true, request };
  });
  layer.registerRpcHandler("human_request.get", async (frame, session) => {
    if (!await authorized(frame, session)) return denied("authority_revoked");
    const { task_id, request_id } = frame.payload;
    if (typeof task_id !== "string" || typeof request_id !== "string" || !task_id || !request_id) return denied();
    const refusal = daemonTaskRuntimeIdentityDenial(store, session.ownerAccessToken, task_id, {
      feishuBotTransport: true, issueHumanRequestTransport: true,
    });
    if (refusal) return { ok: false, code: refusal.status === 404 ? "task_not_found" : "authority_revoked",
      message: refusal.body.error, retryable: false, http_status: refusal.status, http_code: refusal.body.code ?? null };
    const request = store.getTaskHumanRequest(request_id);
    if (!request || request.taskId !== task_id) return { ok: false, code: "task_not_found", message: "request not found",
      retryable: false, http_status: 404, http_code: null };
    return { ok: true, request };
  });
  layer.registerRpcHandler("human_request.expire", async (frame, session) => {
    const refusal = await taskGuard(frame, session); if (refusal) return refusal;
    const { request_id, status } = frame.payload;
    if (typeof request_id !== "string" || (status !== "cancelled" && status !== "timeout")) return denied();
    const request = store.getTaskHumanRequest(request_id);
    if (!request || request.taskId !== frame.payload.task_id) return denied("task_not_found");
    const expired = store.expireTaskHumanRequest(request.id, status) ?? store.getTaskHumanRequest(request.id);
    kick(frame.rt!);
    return { ok: true, request: expired };
  });
  layer.registerRpcHandler("plugin.desired", async (frame, session) => {
    if (!await authorized(frame, session)) return denied("authority_revoked");
    return { ok: true, ...daemonAgentPluginDesiredResponse(store.getRuntimeAgentPluginDesiredSnapshot(frame.rt!)) };
  });
}
