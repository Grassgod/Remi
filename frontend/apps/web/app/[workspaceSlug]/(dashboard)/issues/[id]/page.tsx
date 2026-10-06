import { dehydrate, HydrationBoundary, QueryClient } from "@tanstack/react-query";
import { issueKeys } from "@multiremi/core/issues/queries";
import { workspaceKeys } from "@multiremi/core/workspace/queries";
import { readIssuePageBootstrap } from "../../../../../features/issues/server-log";
import IssuePageClient from "../../../../../features/issues/issue-page-client";

export default async function IssueDetailPage({ params, searchParams }: {
  params: Promise<{ workspaceSlug: string; id: string }>;
  searchParams: Promise<{ session?: string | string[]; comment?: string | string[] }>;
}) {
  const { workspaceSlug, id } = await params;
  const query = await searchParams;
  const sessionId = typeof query.session === "string" ? query.session : undefined;
  const commentId = typeof query.comment === "string" ? query.comment : undefined;
  const { initial, status } = await readIssuePageBootstrap(workspaceSlug, id, sessionId, commentId);
  const queries = new QueryClient();
  if (initial) {
    queries.setQueryData(issueKeys.detail(initial.issue.workspace_id, id), initial.issue);
    queries.setQueryData(issueKeys.sessions(id), initial.sessions);
    queries.setQueryData(workspaceKeys.members(initial.issue.workspace_id), initial.members);
    queries.setQueryData(issueKeys.children(initial.issue.workspace_id, id), initial.children);
    queries.setQueryData(issueKeys.tasks(id), initial.tasks);
    if (initial.parentIssue) queries.setQueryData(issueKeys.detail(initial.issue.workspace_id, initial.parentIssue.id), initial.parentIssue);
  }
  return (
    <div className={status === "soft-nav"
      ? "contents [&_[data-issue-detail-loading]]:invisible [&_[data-session-log-scroll]_[data-slot=skeleton]]:invisible" : "contents"}
      data-issue-page="" data-ssr-seed={status}>
      <HydrationBoundary state={dehydrate(queries)}>
        <IssuePageClient issueId={id} initialIssueSessionId={sessionId ?? initial?.log.sessionId} highlightCommentId={commentId}
          initialLog={initial?.log} initialData={initial ?? undefined} />
      </HydrationBoundary>
    </div>
  );
}
