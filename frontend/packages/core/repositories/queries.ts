import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

export const repositoryKeys = {
  all: (workspaceId: string) => ["repositories", workspaceId] as const,
  list: (workspaceId: string) => ["repositories", workspaceId, "list"] as const,
};

export function repositoryListOptions(workspaceId: string) {
  return queryOptions({
    queryKey: repositoryKeys.list(workspaceId),
    queryFn: () => api.listWorkspaceRepositories(workspaceId),
    enabled: Boolean(workspaceId),
  });
}
