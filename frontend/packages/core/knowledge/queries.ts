import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

export const knowledgeKeys = {
  all: (workspaceId: string) => ["knowledge", workspaceId] as const,
  submissions: (workspaceId: string) => [...knowledgeKeys.all(workspaceId), "submissions"] as const,
  runs: (workspaceId: string) => [...knowledgeKeys.all(workspaceId), "runs"] as const,
  run: (workspaceId: string, runId: string) => [...knowledgeKeys.runs(workspaceId), runId] as const,
};

export function knowledgeSubmissionsOptions(workspaceId: string) {
  return queryOptions({
    queryKey: knowledgeKeys.submissions(workspaceId),
    queryFn: () => api.listKnowledgeSubmissions(workspaceId),
    enabled: Boolean(workspaceId),
    select: (response) => response.submissions,
  });
}

export function knowledgeRunsOptions(workspaceId: string) {
  return queryOptions({
    queryKey: knowledgeKeys.runs(workspaceId),
    queryFn: () => api.listKnowledgeRuns(workspaceId),
    enabled: Boolean(workspaceId),
    select: (response) => response.runs,
  });
}

export function knowledgeRunOptions(workspaceId: string, runId: string | null | undefined) {
  return queryOptions({
    queryKey: knowledgeKeys.run(workspaceId, runId ?? ""),
    queryFn: () => api.getKnowledgeRun(runId!),
    enabled: Boolean(workspaceId && runId),
  });
}
