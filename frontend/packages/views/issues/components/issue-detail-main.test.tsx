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
  IssueSessionList: ({ onSelectSession }: { onSelectSession: (id: string) => void }) => (
    <aside data-testid="session-sidebar">
      <button type="button" onClick={() => onSelectSession("session-review")}>Select session</button>
    </aside>
  ),
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

function renderMain(
  sessionSidebarOpen: boolean,
  onToggleSessionSidebar = vi.fn(),
  isMobile = false,
) {
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
      isMobile={isMobile}
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

  it("renders the mobile session list in a left sheet and closes it after selection", () => {
    const onToggleSessionSidebar = vi.fn();
    renderMain(true, onToggleSessionSidebar, true);

    const rail = screen.getByTestId("session-sidebar");
    const scrollRoot = document.querySelector<HTMLElement>("[data-tab-scroll-root]");
    expect(rail.closest('[data-slot="sheet-content"]')).not.toBeNull();
    expect(scrollRoot?.parentElement?.contains(rail)).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Select session" }));
    expect(onToggleSessionSidebar).toHaveBeenCalledOnce();
  });
});
