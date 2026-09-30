// @vitest-environment jsdom
import { Suspense } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const replace = vi.hoisted(() => vi.fn());

vi.mock("@multiremi/views/navigation", () => ({
  useNavigation: () => ({ replace }),
}));

vi.mock("@multiremi/core/paths", () => ({
  useWorkspacePaths: () => ({
    issueSession: (issueId: string, sessionId: string) =>
      `/test/issues/${issueId}?session=${sessionId}`,
  }),
}));

vi.mock("@multiremi/ui/components/common/error-boundary", () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@multiremi/views/issues/components", () => ({
  IssueDetail: ({
    issueId,
    initialIssueSessionId,
    onIssueSessionChange,
  }: {
    issueId: string;
    initialIssueSessionId?: string;
    onIssueSessionChange?: (sessionId: string) => void;
  }) => (
    <button type="button" onClick={() => onIssueSessionChange?.("session-review")}>
      {issueId}:{initialIssueSessionId}
    </button>
  ),
}));

import IssueDetailPage from "../../../../../features/issues/issue-page-client";

describe("IssueDetailPage", () => {
  it("keeps Session deep links and lets the standalone route own Session navigation", async () => {
    const params = Promise.resolve({ id: "issue-1" });
    const searchParams = Promise.resolve({ session: "session-main" });
    await act(async () => {
      render(
        <QueryClientProvider client={new QueryClient()}>
          <Suspense fallback={null}>
            <IssueDetailPage issueId="issue-1" initialIssueSessionId="session-main" />
          </Suspense>
        </QueryClientProvider>,
      );
      await Promise.all([params, searchParams]);
    });

    fireEvent.click(await screen.findByRole("button", { name: "issue-1:session-main" }));

    expect(replace).toHaveBeenCalledWith(
      "/test/issues/issue-1?session=session-review",
    );
  });
});
