import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

export const scmKeys = {
  capabilities: ["scm", "capabilities"] as const,
  all: (workspaceId: string) => ["scm", workspaceId] as const,
  connections: (workspaceId: string) => ["scm", workspaceId, "connections"] as const,
  connection: (workspaceId: string, connectionId: string) =>
    ["scm", workspaceId, "connections", connectionId] as const,
  events: (workspaceId: string) => ["scm", workspaceId, "events"] as const,
  changeRequestsAll: ["scm", "change-requests"] as const,
  changeRequests: (issueId: string) => [...scmKeys.changeRequestsAll, issueId] as const,
};

export function scmCapabilitiesOptions() {
  return queryOptions({
    queryKey: scmKeys.capabilities,
    queryFn: () => api.getScmCapabilities(),
    staleTime: 5 * 60_000,
  });
}

export function issueChangeRequestsOptions(issueId: string) {
  return queryOptions({
    queryKey: scmKeys.changeRequests(issueId),
    queryFn: () => api.listIssueChangeRequests(issueId),
    enabled: Boolean(issueId),
  });
}

export function scmConnectionsOptions(workspaceId: string) {
  return queryOptions({
    queryKey: scmKeys.connections(workspaceId),
    queryFn: () => api.listScmConnections(workspaceId),
    enabled: Boolean(workspaceId),
  });
}
