import type { MultiremiStore } from "@multiremi/store/store.js";
import type { DaemonProtocolLayer } from "./index.js";
import type { DaemonParsedFrame } from "./frames.js";
import type { DaemonProtocolSession } from "./session.js";
import { daemonAgentPluginDesiredResponse } from "../wire/agent-plugins.js";
import { daemonTaskRuntimeIdentityDenial } from "../helpers/auth-guards.js";

const denied = (code = "invalid_report") => ({ ok: false, code, retryable: false });

export function registerTaskInputRpcs(layer: DaemonProtocolLayer, store: MultiremiStore, kick: (runtimeId: string) => void): void {
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
  layer.registerRpcHandler("steer.consume", async (frame, session) => {
    const refusal = await taskGuard(frame, session); if (refusal) return refusal;
    const ids = frame.payload.steer_ids;
    if (!Array.isArray(ids) || ids.some(id => typeof id !== "string")) return denied();
    const consumed = store.consumeTaskSteerMessages(String(frame.payload.task_id), ids as string[]);
    kick(frame.rt!);
    return { ok: true, consumed };
  });
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
