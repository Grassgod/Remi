import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

export const sessionArchiveKeys = {
  all: ["session-archives"] as const,
  workspaceStatus: (workspaceId: string) =>
    [...sessionArchiveKeys.all, "workspace", workspaceId, "status"] as const,
  issueList: (issueId: string) =>
    [...sessionArchiveKeys.all, "issue", issueId, "list"] as const,
};

export function workspaceSessionArchiveStatusOptions(workspaceId: string) {
  return queryOptions({
    queryKey: sessionArchiveKeys.workspaceStatus(workspaceId),
    queryFn: () => api.getWorkspaceSessionArchiveConfig(workspaceId),
    enabled: Boolean(workspaceId),
  });
}

export function issueSessionArchivesOptions(issueId: string) {
  return queryOptions({
    queryKey: sessionArchiveKeys.issueList(issueId),
    queryFn: () => api.listIssueSessionArchives(issueId),
    enabled: Boolean(issueId),
  });
}
