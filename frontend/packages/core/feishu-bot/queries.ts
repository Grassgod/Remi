import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

/**
 * Query keys for the workspace Feishu concierge (MUL-206).
 *
 * Everything is keyed on `workspaceId` so switching workspaces swaps the whole
 * subtree rather than showing one workspace's bot under another's settings.
 */
export const feishuBotKeys = {
  all: (workspaceId: string) => ["feishu-bot", workspaceId] as const,
  config: (workspaceId: string) => ["feishu-bot", workspaceId, "config"] as const,
  status: (workspaceId: string) => ["feishu-bot", workspaceId, "status"] as const,
  candidates: (workspaceId: string) => ["feishu-bot", workspaceId, "candidates"] as const,
  audit: (workspaceId: string, limit: number) => ["feishu-bot", workspaceId, "audit", limit] as const,
  registration: (workspaceId: string, sessionId: string) =>
    ["feishu-bot", workspaceId, "registration", sessionId] as const,
  issueTopics: (workspaceId: string) => ["feishu-bot", workspaceId, "issue-topics"] as const,
};

export function feishuBotOptions(workspaceId: string, enabled = true) {
  return queryOptions({
    queryKey: feishuBotKeys.config(workspaceId),
    queryFn: () => api.getFeishuBot(workspaceId),
    enabled: enabled && workspaceId.length > 0,
    // A 403 here is a role answer, not a transient failure — retrying it just
    // burns requests on a permission the user will not gain mid-session.
    retry: false,
  });
}

export function issueTopicConfigOptions(workspaceId: string, enabled = true) {
  return queryOptions({
    queryKey: feishuBotKeys.issueTopics(workspaceId),
    queryFn: () => api.getIssueTopicConfig(workspaceId),
    enabled: enabled && workspaceId.length > 0,
    retry: false,
  });
}

/**
 * Status is the only thing that moves on its own: the daemon picks up a
 * directive on its next heartbeat, so `deploying` becomes `online` seconds
 * later with no user action. Polling is what makes the badge tell the truth;
 * the rest of the page stays event-driven.
 */
export function feishuBotStatusOptions(workspaceId: string, enabled = true) {
  return queryOptions({
    queryKey: feishuBotKeys.status(workspaceId),
    queryFn: () => api.getFeishuBotStatus(workspaceId),
    enabled: enabled && workspaceId.length > 0,
    retry: false,
    refetchInterval: enabled ? 10_000 : false,
    staleTime: 5_000,
  });
}

export function feishuBotCandidatesOptions(workspaceId: string, enabled = true) {
  return queryOptions({
    queryKey: feishuBotKeys.candidates(workspaceId),
    queryFn: () => api.getFeishuBotCandidates(workspaceId),
    enabled: enabled && workspaceId.length > 0,
    retry: false,
    staleTime: 15_000,
  });
}

export function feishuBotAuditOptions(workspaceId: string, limit = 20, enabled = true) {
  return queryOptions({
    queryKey: feishuBotKeys.audit(workspaceId, limit),
    queryFn: () => api.listFeishuBotAudit(workspaceId, limit),
    enabled: enabled && workspaceId.length > 0,
    retry: false,
  });
}
