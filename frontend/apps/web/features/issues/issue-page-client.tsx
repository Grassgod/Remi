"use client";

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { issueKeys } from "@multiremi/core/issues/queries";
import { workspaceKeys } from "@multiremi/core/workspace/queries";
import type { Issue, IssueSession, MemberWithUser } from "@multiremi/core/types";
import type { AgentTask } from "@multiremi/core/types/agent";
import type { IssueLogBootstrap } from "@multiremi/core/api/schemas/session-log";
import { IssueDetail } from "@multiremi/views/issues/components";
import { useNavigation } from "@multiremi/views/navigation";
import { ErrorBoundary } from "@multiremi/ui/components/common/error-boundary";
import { useWorkspacePaths } from "@multiremi/core/paths";

export default function IssueDetailPage({
  issueId: id,
  initialIssueSessionId,
  highlightCommentId,
  initialLog,
  initialData,
}: {
  issueId: string;
  initialIssueSessionId?: string;
  highlightCommentId?: string;
  initialLog?: IssueLogBootstrap;
  initialData?: { issue: Issue; parentIssue: Issue | null; sessions: IssueSession[]; members: MemberWithUser[]; children: Issue[]; tasks: AgentTask[] };
}) {
  const navigation = useNavigation();
  const paths = useWorkspacePaths();
  const queryClient = useQueryClient();
  if (initialData) {
    const wsId = initialData.issue.workspace_id;
    if (!queryClient.getQueryData(issueKeys.detail(wsId, id))) queryClient.setQueryData(issueKeys.detail(wsId, id), initialData.issue);
    if (!queryClient.getQueryData(issueKeys.sessions(id))) queryClient.setQueryData(issueKeys.sessions(id), initialData.sessions);
    if (!queryClient.getQueryData(workspaceKeys.members(wsId))) queryClient.setQueryData(workspaceKeys.members(wsId), initialData.members);
    if (!queryClient.getQueryData(issueKeys.children(wsId, id))) queryClient.setQueryData(issueKeys.children(wsId, id), initialData.children);
    if (!queryClient.getQueryData(issueKeys.tasks(id))) queryClient.setQueryData(issueKeys.tasks(id), initialData.tasks);
    if (initialData.parentIssue && !queryClient.getQueryData(issueKeys.detail(wsId, initialData.parentIssue.id))) {
      queryClient.setQueryData(issueKeys.detail(wsId, initialData.parentIssue.id), initialData.parentIssue);
    }
  }
  const handleIssueSessionChange = useCallback(
    (sessionId: string) => navigation.replace(`${paths.issueSession(id, sessionId)}${highlightCommentId ? `&comment=${encodeURIComponent(highlightCommentId)}` : ""}`),
    [id, navigation, paths, highlightCommentId],
  );
  return (
    <ErrorBoundary resetKeys={[id]}>
      <IssueDetail
        issueId={id}
        initialLog={initialLog}
        highlightCommentId={highlightCommentId}
        initialIssueSessionId={initialIssueSessionId}
        onIssueSessionChange={handleIssueSessionChange}
      />
    </ErrorBoundary>
  );
}
