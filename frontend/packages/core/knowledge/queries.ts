import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

export const knowledgeKeys = {
  all: (workspaceId: string) => ["knowledge", workspaceId] as const,
  submissions: (workspaceId: string, q = "") =>
    [...knowledgeKeys.all(workspaceId), "submissions", q] as const,
  submission: (workspaceId: string, submissionId: string) =>
    [...knowledgeKeys.all(workspaceId), "submission", submissionId] as const,
  runs: (workspaceId: string) => [...knowledgeKeys.all(workspaceId), "runs"] as const,
  run: (workspaceId: string, runId: string) => [...knowledgeKeys.runs(workspaceId), runId] as const,
};

/**
 * Raw-submission list. Rows carry only `body_excerpt`; the full body is fetched
 * per id through `knowledgeSubmissionOptions` when a row is actually opened
 * (MUL-386 C.2). `q` is answered by the server so body/path matches do not
 * require shipping bodies to the client.
 */
export function knowledgeSubmissionsOptions(workspaceId: string, q = "") {
  const query = q.trim();
  return queryOptions({
    queryKey: knowledgeKeys.submissions(workspaceId, query),
    queryFn: () => api.listKnowledgeSubmissions(workspaceId, { q: query }),
    enabled: Boolean(workspaceId),
    select: (response) => response.submissions,
  });
}

/**
 * One submission with full `body` and `patch`.
 *
 * Used by the row preview and tooltip: the list no longer returns either field.
 */
export function knowledgeSubmissionOptions(workspaceId: string, submissionId: string | null | undefined) {
  return queryOptions({
    queryKey: knowledgeKeys.submission(workspaceId, submissionId ?? ""),
    queryFn: () => api.getKnowledgeSubmission(submissionId!),
    enabled: Boolean(workspaceId && submissionId),
    staleTime: 5 * 60_000,
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
