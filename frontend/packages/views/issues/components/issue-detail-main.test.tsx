import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Issue } from "@multiremi/core/types";
import type { UseIssueActionsResult } from "../actions";
import type { IssueSessionSelection } from "../hooks/use-issue-session-selection";

vi.mock("./issue-detail-header", () => ({
  IssueDetailHeader: ({
    sessionSidebarOpen,
    onToggleSessionSidebar,
  }: {
    sessionSidebarOpen: boolean;
    onToggleSessionSidebar: () => void;
  }) => (
    <button
      type="button"
      aria-label="Toggle sessions"
      aria-pressed={sessionSidebarOpen}
      onClick={onToggleSessionSidebar}
    />
  ),
}));

vi.mock("./issue-session-list", () => ({
  IssueSessionList: () => <aside data-testid="session-sidebar" />,
}));

vi.mock("./issue-description-section", () => ({
  IssueDescriptionSection: () => null,
}));

vi.mock("./issue-sub-issues-section", () => ({
  IssueSubIssuesSection: () => null,
}));

vi.mock("./issue-activity-section", () => ({
  IssueActivitySection: () => null,
}));

import { IssueDetailMain } from "./issue-detail-main";

function renderMain(sessionSidebarOpen: boolean, onToggleSessionSidebar = vi.fn()) {
  const issue = { id: "issue-1", project_id: null } as Issue;
  const sessions: IssueSessionSelection = {
    list: [],
    activeId: "",
    active: null,
    select: vi.fn(),
    pending: false,
    fetching: false,
    refetch: vi.fn(),
  };

  const result = render(
    <IssueDetailMain
      issue={issue}
      issueId={issue.id}
      parentIssue={null}
      breadcrumbProject={null}
      actions={{} as UseIssueActionsResult}
      sidebarOpen
      onToggleSidebar={vi.fn()}
      sessionSidebarOpen={sessionSidebarOpen}
      onToggleSessionSidebar={onToggleSessionSidebar}
      sessions={sessions}
      members={[]}
      agents={[]}
      canModerateComments={false}
      onShowKeyResults={vi.fn()}
      onScrollContainerRef={vi.fn()}
      scrollContainerEl={null}
    />,
  );

  return { ...result, onToggleSessionSidebar };
}

describe("IssueDetailMain session sidebar", () => {
  it("renders the session sidebar only while its preference is open", () => {
    const { unmount } = renderMain(true);
    expect(screen.getByTestId("session-sidebar")).toBeInTheDocument();

    unmount();
    renderMain(false);
    expect(screen.queryByTestId("session-sidebar")).not.toBeInTheDocument();
  });

  it("forwards the persistent sidebar toggle to the header control", () => {
    const onToggleSessionSidebar = vi.fn();
    renderMain(false, onToggleSessionSidebar);

    fireEvent.click(screen.getByRole("button", { name: "Toggle sessions" }));
    expect(onToggleSessionSidebar).toHaveBeenCalledOnce();
  });
});
