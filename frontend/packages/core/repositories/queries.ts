import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import type { RepositoryWikiSummary } from "../types";

// Poll cadence while a wiki build is queued/building. Kept in one place so
// the page-side "did the build just finish?" effect and tests agree with it.
export const WIKI_BUILD_POLL_INTERVAL_MS = 2_500;

export function isWikiBuildActive(summary: Pick<RepositoryWikiSummary, "status" | "build"> | undefined): boolean {
  if (!summary) return false;
  const buildStatus = summary.build?.status;
  return buildStatus === "queued" || buildStatus === "building" || summary.status === "building";
}

// Conditional polling: only tick while at least one repository has an active
// build; otherwise stay idle (no background polling).
export function wikiSummariesRefetchInterval(
  summaries: RepositoryWikiSummary[] | undefined,
): number | false {
  return summaries?.some((summary) => isWikiBuildActive(summary))
    ? WIKI_BUILD_POLL_INTERVAL_MS
    : false;
}

export const repositoryKeys = {
  all: (workspaceId: string) => ["repositories", workspaceId] as const,
  list: (workspaceId: string) => ["repositories", workspaceId, "list"] as const,
  wikiSummaries: (workspaceId: string) => ["repositories", workspaceId, "wiki-summaries"] as const,
  wiki: (workspaceId: string, repositoryId: string) => ["repositories", workspaceId, repositoryId, "wiki"] as const,
};

export function repositoryListOptions(workspaceId: string) {
  return queryOptions({
    queryKey: repositoryKeys.list(workspaceId),
    queryFn: () => api.listWorkspaceRepositories(workspaceId),
    enabled: Boolean(workspaceId),
  });
}

export function repositoryWikiSummariesOptions(workspaceId: string) {
  return queryOptions({
    queryKey: repositoryKeys.wikiSummaries(workspaceId),
    queryFn: () => api.listRepositoryWikiSummaries(workspaceId),
    enabled: Boolean(workspaceId),
    refetchInterval: (query) => wikiSummariesRefetchInterval(query.state.data),
  });
}

export function repositoryWikiDocsOptions(workspaceId: string, repositoryId: string) {
  return queryOptions({
    queryKey: repositoryKeys.wiki(workspaceId, repositoryId),
    queryFn: () => api.listRepositoryWikiDocs(workspaceId, repositoryId),
    enabled: Boolean(workspaceId && repositoryId),
  });
}
