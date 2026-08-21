"use client";

import { use, useCallback } from "react";
import { IssueDetail } from "@multiremi/views/issues/components";
import { useNavigation } from "@multiremi/views/navigation";
import { ErrorBoundary } from "@multiremi/ui/components/common/error-boundary";
import { useWorkspacePaths } from "@multiremi/core/paths";

export default function IssueDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ session?: string | string[] }>;
}) {
  const { id } = use(params);
  const query = use(searchParams);
  const initialIssueSessionId =
    typeof query.session === "string" ? query.session : undefined;
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
        initialIssueSessionId={initialIssueSessionId}
        onIssueSessionChange={handleIssueSessionChange}
      />
    </ErrorBoundary>
  );
}
