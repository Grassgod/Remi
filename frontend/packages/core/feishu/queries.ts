import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import type { FeishuMessageListParams } from "../api/endpoints/feishu";

export const feishuKeys = {
  all: (workspaceId: string) => ["feishu", workspaceId] as const,
  endpoints: (workspaceId: string) => ["feishu", workspaceId, "endpoints"] as const,
  sources: (workspaceId: string) => ["feishu", workspaceId, "sources"] as const,
  sourceStatus: (workspaceId: string, sourceId: string) =>
    ["feishu", workspaceId, "sources", sourceId, "status"] as const,
  availableChats: (workspaceId: string, sourceId: string, params: { q?: string; scope?: string }) =>
    ["feishu", workspaceId, "sources", sourceId, "available-chats", params] as const,
  messages: (workspaceId: string, params: FeishuMessageListParams) =>
    ["feishu", workspaceId, "messages", params] as const,
  chats: (workspaceId: string) => ["feishu", workspaceId, "chats"] as const,
  proposals: (workspaceId: string, params: { status?: string; source?: string }) =>
    ["feishu", workspaceId, "proposals", params] as const,
  authorization: (workspaceId: string, connectionId: string, sessionId: string) =>
    ["feishu", workspaceId, "connections", connectionId, "authorization", sessionId] as const,
};

/**
 * Endpoint health for the 接入服务 panel. Members get a 403 here — the panel
 * degrades to a read-only notice instead of retrying, because retrying a
 * permission failure only burns requests.
 */
export function feishuEndpointsOptions(workspaceId: string, enabled = true) {
  return queryOptions({
    queryKey: feishuKeys.endpoints(workspaceId),
    queryFn: () => api.listFeishuEndpoints(workspaceId),
    enabled: enabled && workspaceId.length > 0,
    retry: false,
    staleTime: 15_000,
  });
}

export function feishuMessageAuthorizationOptions(
  workspaceId: string,
  connectionId: string,
  sessionId: string,
  enabled = true,
) {
  return queryOptions({
    queryKey: feishuKeys.authorization(workspaceId, connectionId, sessionId),
    queryFn: () => api.getFeishuMessageAuthorization(workspaceId, connectionId, sessionId),
    enabled: enabled && workspaceId.length > 0 && connectionId.length > 0 && sessionId.length > 0,
    retry: false,
    refetchInterval: (query) => query.state.data?.authorization.status === "pending" ? 1_500 : false,
  });
}

export function feishuSourcesOptions(workspaceId: string, enabled = true) {
  return queryOptions({
    queryKey: feishuKeys.sources(workspaceId),
    queryFn: () => api.listFeishuSources(workspaceId),
    enabled: enabled && workspaceId.length > 0,
    retry: false,
  });
}

export function feishuSourceStatusOptions(workspaceId: string, sourceId: string, enabled = true) {
  return queryOptions({
    queryKey: feishuKeys.sourceStatus(workspaceId, sourceId),
    queryFn: () => api.getFeishuSourceStatus(workspaceId, sourceId),
    enabled: enabled && workspaceId.length > 0 && sourceId.length > 0,
    retry: false,
    // Lag, backlog and failure counts are the operator's live signal that
    // ingestion is stuck; a minute-stale panel would hide an outage.
    refetchInterval: 30_000,
  });
}

/** Chat directory lookup for the allowlist picker. Only runs while the picker
 *  is open — it reaches Feishu itself and should not poll in the background. */
export function feishuAvailableChatsOptions(
  workspaceId: string,
  sourceId: string,
  params: { q?: string; scope?: string; limit?: number },
  enabled = true,
) {
  return queryOptions({
    queryKey: feishuKeys.availableChats(workspaceId, sourceId, { q: params.q, scope: params.scope }),
    queryFn: () => api.listFeishuAvailableChats(workspaceId, sourceId, params),
    enabled: enabled && workspaceId.length > 0 && sourceId.length > 0,
    retry: false,
    staleTime: 30_000,
  });
}

export function feishuMessagesOptions(workspaceId: string, params: FeishuMessageListParams) {
  return queryOptions({
    queryKey: feishuKeys.messages(workspaceId, params),
    queryFn: () => api.listFeishuMessages(workspaceId, params),
    enabled: workspaceId.length > 0,
    retry: false,
  });
}

export function feishuChatsOptions(workspaceId: string) {
  return queryOptions({
    queryKey: feishuKeys.chats(workspaceId),
    queryFn: () => api.listFeishuChats(workspaceId),
    enabled: workspaceId.length > 0,
    retry: false,
    staleTime: 60_000,
  });
}

export function feishuProposalsOptions(
  workspaceId: string,
  params: { status?: string; source?: string; limit?: number; offset?: number } = {},
) {
  return queryOptions({
    queryKey: feishuKeys.proposals(workspaceId, { status: params.status, source: params.source }),
    queryFn: () => api.listFeishuProposals(workspaceId, params),
    enabled: workspaceId.length > 0,
    retry: false,
  });
}
