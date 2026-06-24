"use client";

import { IssuesPage } from "@multiremi/views/issues/components";
import { ErrorBoundary } from "@multiremi/ui/components/common/error-boundary";

export default function Page() {
  return (
    <ErrorBoundary>
      <IssuesPage />
    </ErrorBoundary>
  );
}
