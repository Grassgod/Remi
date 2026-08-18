"use client";

import { use } from "react";
import { IssueDetail } from "@multiremi/views/issues/components";
import { ErrorBoundary } from "@multiremi/ui/components/common/error-boundary";

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
  return (
    <ErrorBoundary resetKeys={[id]}>
      <IssueDetail issueId={id} initialIssueSessionId={initialIssueSessionId} />
    </ErrorBoundary>
  );
}
