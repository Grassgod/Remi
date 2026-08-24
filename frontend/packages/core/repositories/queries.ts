import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

export const repositoryKeys = {
  all: (workspaceId: string) => ["repositories", workspaceId] as const,
  list: (workspaceId: string) => ["repositories", workspaceId, "list"] as const,
  wikiSummaries: (workspaceId: string) => ["repositories", workspaceId, "wiki-summaries"] as const,
  atlas: (workspaceId: string) => ["repositories", workspaceId, "atlas"] as const,
  wiki: (workspaceId: string, repositoryId: string) => ["repositories", workspaceId, repositoryId, "wiki"] as const,
};

export function repositoryListOptions(workspaceId: string) {
  return queryOptions({
    queryKey: repositoryKeys.list(workspaceId),
    queryFn: () => api.listWorkspaceRepositories(workspaceId),
    enabled: Boolean(workspaceId),
  });
}

export function atlasWikiSetupOptions(workspaceId: string) {
  return queryOptions({
    queryKey: repositoryKeys.atlas(workspaceId),
    queryFn: () => api.getAtlasWikiSetupStatus(workspaceId),
    enabled: Boolean(workspaceId),
  });
}

export function repositoryWikiSummariesOptions(workspaceId: string) {
  return queryOptions({
    queryKey: repositoryKeys.wikiSummaries(workspaceId),
    queryFn: () => api.listRepositoryWikiSummaries(workspaceId),
    enabled: Boolean(workspaceId),
  });
}

export function repositoryWikiDocsOptions(workspaceId: string, repositoryId: string) {
  return queryOptions({
    queryKey: repositoryKeys.wiki(workspaceId, repositoryId),
    queryFn: () => api.listRepositoryWikiDocs(workspaceId, repositoryId),
    enabled: Boolean(workspaceId && repositoryId),
  });
}
