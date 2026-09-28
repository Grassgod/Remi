import { createHash } from "node:crypto";
import type { MultiremiStore } from "@multiremi/store/store.js";
import type { DaemonDownlinkEntity } from "./downlinks.js";
import { workspaceReposResponse } from "../wire/workspaces.js";
import type { DaemonProtocolSession } from "./session.js";

function config(type: string, payload: Record<string, unknown>): DaemonDownlinkEntity {
  const revision = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return { key: `${type}:${revision}`, type, payload };
}

export function runtimeInputSnapshot(store: MultiremiStore, runtimeId: string, session?: DaemonProtocolSession): DaemonDownlinkEntity[] {
  const runtime = store.getRuntimeLite(runtimeId);
  if (!runtime) return [];
  const pending: DaemonDownlinkEntity[] = store.pendingRuntimeRequests(runtimeId).map(request => ({
    key: `runtime.${request.kind}:${request.id}`, type: `runtime.${request.kind}`, payload: request.payload,
    claimed: () => store.claimAcknowledgedRuntimeRequest(runtimeId, request.kind, request.id),
    discard: () => store.discardRuntimePendingRequest(runtimeId, request.kind, request.id),
  }));
  const entities: DaemonDownlinkEntity[] = [];
  const maintenance = store.getPlatformMaintenance();
  const desired = store.getRuntimeAgentPluginDesiredSnapshot(runtimeId);
  entities.push(config("platform.drain", { mode: maintenance.mode, generation: maintenance.generation }),
    config("runtime.profile", { codex_profile: store.getRuntimeCodexProfile(runtimeId),
      claude_profile: store.getRuntimeClaudeProfile(runtimeId) }));
  if (Number(runtime.metadata.agent_plugin_protocol) >= 1) entities.push(config("plugin.desired_revision", { revision: desired.revision }));
  const token = session?.ownerAccessToken;
  const workspaceId = runtime.workspaceId ?? "local";
  const role = token?.userId ? store.getUserRoleInWorkspace(token.userId, workspaceId)
    : workspaceId === "local" || !token ? "owner" : null;
  const workspace = workspaceReposResponse(store, runtime.workspaceId ?? "local", role === "owner" || role === "admin");
  if (workspace) entities.push(config("workspace.settings", { settings: workspace.settings }), config("workspace.relay", { relay: workspace.relay }));
  const directive = store.feishuBotDirectiveForRuntime(workspaceId, runtimeId);
  if (directive) entities.push(config("feishu.directive", { ...directive }));
  const mesh = store.sshMeshDirectiveForRuntime(runtimeId);
  if (mesh) entities.push(config("ssh_mesh.reconcile", { ...mesh }));
  const outbound = store.pendingFeishuBotOutbound(workspaceId, runtimeId);
  if (outbound) entities.push({
    key: `feishu.outbound:${outbound.id}`, type: "feishu.outbound",
    payload: { id: outbound.id, claim_token: outbound.claimToken, chat_id: outbound.chatId,
      thread_id: outbound.threadId, reply_to_message_id: outbound.replyToMessageId,
      body: outbound.body, body_origin: outbound.bodyOrigin, idempotency_key: outbound.idempotencyKey,
      attachments: outbound.attachments, task_id: outbound.taskId, resume_message_id: outbound.resumeMessageId,
      mention: outbound.mention, presentation: outbound.presentation, interaction_open_id: outbound.interactionOpenId,
      receipt_message_ids: outbound.receiptMessageIds, kind: outbound.kind, human_request_id: outbound.humanRequestId,
      human_request_task_id: outbound.humanRequestTaskId, target_message_id: outbound.targetMessageId,
      expires_at: outbound.expiresAt, degraded: outbound.degraded },
    claimed: () => store.claimAcknowledgedFeishuBotOutbound(workspaceId, runtimeId, outbound.id, outbound.claimToken),
    discard: () => store.discardPendingFeishuBotOutbound(workspaceId, runtimeId, outbound.id),
  });
  entities.push(...pending);
  return entities;
}
