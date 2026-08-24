import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Accordion } from "@base-ui/react/accordion";
import { describe, expect, it, vi } from "vitest";
import type { Issue } from "@multiremi/core/types";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enIssues from "../../locales/en/issues.json";
import { ARCHIVED_ACCORDION_VALUE, ArchivedListItem } from "./archived-issues";

const listIssues = vi.hoisted(() => vi.fn());
const restoreIssue = vi.hoisted(() => vi.fn());

vi.mock("@multiremi/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multiremi/core/paths", () => ({
  useWorkspacePaths: () => ({ issueDetail: (id: string) => `/issues/${id}` }),
}));

vi.mock("@multiremi/core/api", () => ({
  api: { listIssues, restoreIssue },
}));

vi.mock("../../navigation", () => ({
  AppLink: ({ children, href, ...props }: React.ComponentProps<"a">) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const archivedIssue: Issue = {
  id: "issue-archived",
  workspace_id: "ws-1",
  number: 7,
  identifier: "TST-7",
  title: "Archived release task",
  description: null,
  status: "done",
  priority: "none",
  assignee_type: null,
  assignee_id: null,
  creator_type: "member",
  creator_id: "user-1",
  parent_issue_id: null,
  project_id: null,
  position: 0,
  start_date: null,
  due_date: null,
  completed_at: "2026-01-01T00:00:00Z",
  archived_at: "2026-01-04T00:00:00Z",
  metadata: {},
  created_at: "2025-12-01T00:00:00Z",
  updated_at: "2026-01-04T00:00:00Z",
};

function renderArchivedList(expanded: boolean, client: QueryClient) {
  return render(
    <I18nProvider locale="en" resources={{ en: { common: enCommon, issues: enIssues } }}>
      <QueryClientProvider client={client}>
        <Accordion.Root
          multiple
          value={expanded ? [ARCHIVED_ACCORDION_VALUE] : []}
        >
          <ArchivedListItem expanded={expanded} total={1} />
        </Accordion.Root>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe("ArchivedListItem", () => {
  it("loads archived issues only after the group expands and restores by id", async () => {
    listIssues.mockResolvedValue({ issues: [archivedIssue], total: 1 });
    restoreIssue.mockResolvedValue({
      ...archivedIssue,
      completed_at: null,
      archived_at: null,
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    const view = renderArchivedList(false, client);
    expect(listIssues).not.toHaveBeenCalled();

    view.rerender(
      <I18nProvider locale="en" resources={{ en: { common: enCommon, issues: enIssues } }}>
        <QueryClientProvider client={client}>
          <Accordion.Root multiple value={[ARCHIVED_ACCORDION_VALUE]}>
            <ArchivedListItem expanded total={1} />
          </Accordion.Root>
        </QueryClientProvider>
      </I18nProvider>,
    );

    expect(await screen.findByText("Archived release task")).toBeInTheDocument();
    expect(listIssues).toHaveBeenCalledWith({
      archived_only: true,
      limit: 50,
      offset: 0,
    });

    fireEvent.click(screen.getByRole("button", { name: "Restore issue" }));
    await waitFor(() => expect(restoreIssue).toHaveBeenCalledWith("issue-archived"));
  });
});
