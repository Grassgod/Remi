import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { AgentTask, Issue } from "@multiremi/core/types";
import enCommon from "../../locales/en/common.json";
import enWorkbench from "../../locales/en/workbench.json";

const TEST_RESOURCES = { en: { common: enCommon, workbench: enWorkbench } };

const listIssues = vi.hoisted(() => vi.fn());
const getAgentTaskSnapshot = vi.hoisted(() => vi.fn());
const navigationState = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
}));

// The real workbench/agents query modules stay in play — only the api
// singleton is stubbed — so this test exercises the actual query wiring
// (workbenchIssuesOptions + partitionReviewIssues + agentTaskSnapshotOptions).
vi.mock("@multiremi/core/api", () => ({
  api: {
    listIssues,
    getAgentTaskSnapshot,
  },
}));

vi.mock("@multiremi/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multiremi/core/paths", () => ({
  useWorkspacePaths: () => ({
    workbench: () => "/test/workbench",
    workbenchIssue: (issueId: string, sessionId?: string) =>
      `/test/workbench?issue=${issueId}${sessionId ? `&session=${sessionId}` : ""}`,
  }),
}));

vi.mock("../../issues/components", () => ({
  IssueDetail: ({
    issueId,
    initialIssueSessionId,
    onIssueSessionChange,
  }: {
    issueId: string;
    initialIssueSessionId?: string;
    onIssueSessionChange?: (sessionId: string) => void;
  }) => (
    <div
      data-testid="issue-detail"
      data-session-route-owned={String(Boolean(onIssueSessionChange))}
      data-initial-session={initialIssueSessionId}
    >
      {issueId}
      <button
        type="button"
        onClick={() => onIssueSessionChange?.("session-review")}
      >
        Select Review session
      </button>
    </div>
  ),
  StatusIcon: () => <span data-testid="status-icon" />,
}));

const replace = vi.hoisted(() => vi.fn());
vi.mock("../../navigation", () => ({
  useNavigation: () => ({
    searchParams: navigationState.searchParams,
    replace,
    push: vi.fn(),
  }),
}));

vi.mock("@multiremi/ui/hooks/use-mobile", () => ({ useIsMobile: () => false }));

vi.mock("react-resizable-panels", () => ({
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Separator: () => <div />,
  useDefaultLayout: () => ({ defaultLayout: undefined, onLayoutChanged: vi.fn() }),
  usePanelRef: () => ({ current: null }),
}));

import { WorkbenchPage } from "./workbench-page";

function issue(id: string, status: Issue["status"]): Issue {
  return {
    id,
    workspace_id: "ws-1",
    number: 1,
    identifier: `MUL-${id}`,
    title: `Issue ${id}`,
    description: null,
    status,
    priority: "none",
    assignee_type: null,
    assignee_id: null,
    creator_type: "member",
    creator_id: "u1",
    parent_issue_id: null,
    project_id: null,
    position: 0,
    start_date: null,
    due_date: null,
    completed_at: null,
    archived_at: null,
    metadata: {},
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function awaitingTask(issueId: string): AgentTask {
  return {
    id: `task-${issueId}`,
    agent_id: "agent-1",
    issue_id: issueId,
    status: "awaiting_human",
    priority: 0,
    dispatched_at: null,
    started_at: null,
    completed_at: null,
    result: null,
    error: null,
    created_at: "2026-01-01T00:00:00Z",
  } as AgentTask;
}

function failedTask(issueId: string, error: string): AgentTask {
  return {
    ...awaitingTask(issueId),
    id: `task-${issueId}-failed`,
    status: "failed",
    error,
    failure_reason: "agent_error",
    completed_at: "2026-01-01T00:01:00Z",
  } as AgentTask;
}

function mockIssueLists(lists: Partial<Record<Issue["status"], Issue[]>>) {
  listIssues.mockImplementation(({ status }: { status: Issue["status"] }) => {
    const issues = lists[status] ?? [];
    return Promise.resolve({ issues, total: issues.length });
  });
}

function renderWorkbench() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <QueryClientProvider client={queryClient}>
        <WorkbenchPage />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  navigationState.searchParams = new URLSearchParams();
  getAgentTaskSnapshot.mockResolvedValue([]);
});

describe("WorkbenchPage", () => {
  it("splits in_review issues into reply/review sections and lists in-progress ones", async () => {
    mockIssueLists({
      in_review: [issue("a", "in_review"), issue("b", "in_review")],
      in_progress: [issue("c", "in_progress")],
    });
    getAgentTaskSnapshot.mockResolvedValue([awaitingTask("a")]);
    renderWorkbench();

    expect(await screen.findByText("Waiting for your reply")).toBeInTheDocument();
    expect(screen.getByText("Ready for review")).toBeInTheDocument();
    expect(screen.getByText("In progress — can wait")).toBeInTheDocument();
    expect(screen.getByText("Issue a")).toBeInTheDocument();
    expect(screen.getByText("Issue b")).toBeInTheDocument();
    expect(screen.getByText("Issue c")).toBeInTheDocument();
  });

  it("shows blocked issues after the review queues with available failure context", async () => {
    mockIssueLists({
      in_review: [issue("a", "in_review"), issue("b", "in_review")],
      blocked: [issue("blocked", "blocked")],
      in_progress: [issue("c", "in_progress")],
    });
    getAgentTaskSnapshot.mockResolvedValue([
      awaitingTask("a"),
      failedTask("blocked", "Repository refresh failed after retries"),
    ]);
    renderWorkbench();

    const awaitingInput = await screen.findByText("Waiting for your reply");
    const awaitingReview = screen.getByText("Ready for review");
    const blocked = screen.getByText("Blocked");
    const inProgress = screen.getByText("In progress — can wait");
    expect(screen.getByText("Issue blocked")).toBeInTheDocument();
    expect(
      screen.getByText("Failure: Repository refresh failed after retries"),
    ).toBeInTheDocument();
    expect(awaitingInput.compareDocumentPosition(awaitingReview) & 4).toBeTruthy();
    expect(awaitingReview.compareDocumentPosition(blocked) & 4).toBeTruthy();
    expect(blocked.compareDocumentPosition(inProgress) & 4).toBeTruthy();
  });

  it("hides the blocked section when there are no blocked issues", async () => {
    mockIssueLists({ in_review: [issue("a", "in_review")] });
    renderWorkbench();

    expect(await screen.findByText("Issue a")).toBeInTheDocument();
    expect(screen.queryByText("Blocked")).not.toBeInTheDocument();
  });

  it("switches issue detail in place while keeping the workbench route", async () => {
    mockIssueLists({
      in_review: [issue("a", "in_review"), issue("b", "in_review")],
    });
    renderWorkbench();

    fireEvent.click(await screen.findByText("Issue a"));
    expect(screen.getByTestId("issue-detail")).toHaveTextContent("a");
    expect(screen.getByTestId("issue-detail")).toHaveAttribute(
      "data-session-route-owned",
      "true",
    );
    expect(replace).toHaveBeenCalledWith("/test/workbench?issue=a");

    fireEvent.click(screen.getByText("Issue b"));
    expect(screen.getByTestId("issue-detail")).toHaveTextContent("b");
    expect(replace).toHaveBeenLastCalledWith("/test/workbench?issue=b");

    fireEvent.click(screen.getByRole("button", { name: "Select Review session" }));
    expect(replace).toHaveBeenLastCalledWith(
      "/test/workbench?issue=b&session=session-review",
    );
    expect(
      replace.mock.calls.every(([path]) => String(path).startsWith("/test/workbench")),
    ).toBe(true);
  });

  it("restores a deep-linked Session inside the selected workbench issue", async () => {
    navigationState.searchParams = new URLSearchParams(
      "issue=a&session=session-main",
    );
    mockIssueLists({ in_review: [issue("a", "in_review")] });

    renderWorkbench();

    expect(await screen.findByTestId("issue-detail")).toHaveAttribute(
      "data-initial-session",
      "session-main",
    );
  });

  it("distinguishes a failed fetch from an empty workbench and offers a retry", async () => {
    listIssues.mockRejectedValue(new Error("500"));
    renderWorkbench();

    // Both panes say so: the list (with the retry) and the detail placeholder.
    expect(await screen.findAllByText("Something went wrong")).toHaveLength(2);
    expect(screen.queryByText("All caught up")).not.toBeInTheDocument();

    const callsBeforeRetry = listIssues.mock.calls.length;
    listIssues.mockResolvedValue({ issues: [], total: 0 });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No issues are waiting on you")).toBeInTheDocument();
    expect(listIssues.mock.calls.length).toBeGreaterThan(callsBeforeRetry);
  });

  it("shows the all-clear state when nothing needs attention", async () => {
    listIssues.mockResolvedValue({ issues: [], total: 0 });
    renderWorkbench();

    expect(await screen.findAllByText("All caught up")).not.toHaveLength(0);
    expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
  });
});
