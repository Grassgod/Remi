import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { Issue, IssueStatus } from "@multiremi/core/types";
import enCommon from "../../locales/en/common.json";
import enIssues from "../../locales/en/issues.json";
import type { SidebarSectionsState } from "../hooks/use-sidebar-sections";

const TEST_RESOURCES = { en: { common: enCommon, issues: enIssues } };
const mockApiObj = vi.hoisted(() => ({ listChildIssues: vi.fn() }));

vi.mock("@multiremi/core/api", () => ({
  api: mockApiObj,
  getApi: () => mockApiObj,
  setApiInstance: vi.fn(),
}));

vi.mock("@multiremi/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multiremi/core/paths", () => ({
  useWorkspacePaths: () => ({ issueDetail: (id: string) => `/test/issues/${id}` }),
}));

vi.mock("../../navigation", () => ({
  AppLink: ({ children, href, className }: React.ComponentProps<"a">) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

import { IssueSubIssuesSummary } from "./issue-sub-issues-summary";

const sections: SidebarSectionsState = {
  isOpen: () => true,
  toggle: vi.fn(),
  setOpen: vi.fn(),
};

function makeIssue(id: string, status: IssueStatus): Issue {
  const number = Number(id.replace("child-", ""));
  return {
    id,
    workspace_id: "ws-1",
    number,
    identifier: `MUL-${number}`,
    title: `Child issue ${number}`,
    description: null,
    status,
    priority: "none",
    assignee_type: null,
    assignee_id: null,
    creator_type: "member",
    creator_id: "member-1",
    parent_issue_id: "parent-1",
    project_id: null,
    position: number,
    start_date: null,
    due_date: null,
    metadata: {},
    completed_at: status === "done" ? "2026-08-01T00:00:00Z" : null,
    archived_at: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
  };
}

function renderSummary(childIssues: Issue[]) {
  mockApiObj.listChildIssues.mockResolvedValue({ issues: childIssues });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider resources={TEST_RESOURCES} locale="en">
        <IssueSubIssuesSummary issueId="parent-1" sections={sections} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("IssueSubIssuesSummary", () => {
  it("does not render when the issue has no children", async () => {
    renderSummary([]);

    await vi.waitFor(() => expect(mockApiObj.listChildIssues).toHaveBeenCalledWith("parent-1"));
    expect(screen.queryByText("Sub-issues")).not.toBeInTheDocument();
  });

  it("counts only done children in the progress summary", async () => {
    renderSummary([
      makeIssue("child-201", "done"),
      makeIssue("child-202", "in_review"),
      makeIssue("child-203", "cancelled"),
    ]);

    expect(await screen.findByText("1/3")).toBeInTheDocument();
  });

  it("links every compact row to the child issue detail", async () => {
    renderSummary([makeIssue("child-203", "todo")]);

    expect((await screen.findByText("MUL-203")).closest("a")).toHaveAttribute(
      "href",
      "/test/issues/child-203",
    );
  });
});
