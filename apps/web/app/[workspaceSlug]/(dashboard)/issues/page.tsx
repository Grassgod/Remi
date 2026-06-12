"use client";

import { IssuesPage } from "@multimira/views/issues/components";
import { ErrorBoundary } from "@multimira/ui/components/common/error-boundary";

export default function Page() {
  return (
    <ErrorBoundary>
      <IssuesPage />
    </ErrorBoundary>
  );
}
