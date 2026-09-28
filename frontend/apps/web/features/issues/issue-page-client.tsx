"use client";

import { useCallback } from "react";
import type { IssueLogBootstrap } from "@multiremi/core/api/schemas/session-log";
import { IssueDetail } from "@multiremi/views/issues/components";
import { useNavigation } from "@multiremi/views/navigation";
import { ErrorBoundary } from "@multiremi/ui/components/common/error-boundary";
import { useWorkspacePaths } from "@multiremi/core/paths";

export default function IssueDetailPage({
  issueId: id,
  initialIssueSessionId,
  initialLog,
}: {
  issueId: string;
  initialIssueSessionId?: string;
  initialLog?: IssueLogBootstrap;
}) {
  const navigation = useNavigation();
  const paths = useWorkspacePaths();
  const handleIssueSessionChange = useCallback(
    (sessionId: string) => navigation.replace(paths.issueSession(id, sessionId)),
    [id, navigation, paths],
  );
  return (
    <ErrorBoundary resetKeys={[id]}>
      <IssueDetail
        issueId={id}
        initialLog={initialLog}
        initialIssueSessionId={initialIssueSessionId}
        onIssueSessionChange={handleIssueSessionChange}
      />
    </ErrorBoundary>
  );
}
