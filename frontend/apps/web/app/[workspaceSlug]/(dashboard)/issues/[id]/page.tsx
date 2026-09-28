import { dehydrate, HydrationBoundary, QueryClient } from "@tanstack/react-query";
import { issueKeys } from "@multiremi/core/issues/queries";
import { readIssueLogBootstrap } from "../../../../../features/issues/server-log";
import IssuePageClient from "../../../../../features/issues/issue-page-client";

export default async function IssueDetailPage({ params, searchParams }: {
  params: Promise<{ workspaceSlug: string; id: string }>;
  searchParams: Promise<{ session?: string | string[] }>;
}) {
  const { workspaceSlug, id } = await params;
  const query = await searchParams;
  const sessionId = typeof query.session === "string" ? query.session : undefined;
  const initial = await readIssueLogBootstrap(workspaceSlug, id, sessionId);
  const queries = new QueryClient();
  if (initial) {
    queries.setQueryData(issueKeys.detail(initial.issue.workspace_id, id), initial.issue);
    queries.setQueryData(issueKeys.sessions(id), initial.sessions);
    if (initial.parentIssue) queries.setQueryData(issueKeys.detail(initial.issue.workspace_id, initial.parentIssue.id), initial.parentIssue);
  }
  return (
    <HydrationBoundary state={dehydrate(queries)}>
      <IssuePageClient issueId={id} initialIssueSessionId={sessionId} initialLog={initial?.log} />
    </HydrationBoundary>
  );
}
