// @vitest-environment jsdom

import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { Project } from "@multiremi/core/types";
import enCommon from "../../locales/en/common.json";
import enIssues from "../../locales/en/issues.json";
import enProjects from "../../locales/en/projects.json";

const TEST_RESOURCES = {
  en: { common: enCommon, issues: enIssues, projects: enProjects },
};

const state = vi.hoisted(() => ({
  project: null as unknown,
  projectLoading: false,
  issues: [] as unknown[],
  issuesLoading: false,
  issuesError: false,
  issuesErrorValue: null as unknown,
  members: [] as unknown[],
}));

const refetchIssues = vi.hoisted(() => vi.fn());
const updateProject = vi.hoisted(() => vi.fn());
const archiveProject = vi.hoisted(() => vi.fn());
const restoreProject = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options?: { queryKey?: readonly unknown[] }) => {
    const key = Array.isArray(options?.queryKey) ? options.queryKey[0] : null;
    switch (key) {
      case "project":
        return { data: state.project, isLoading: state.projectLoading };
      case "issues":
        return {
          data: state.issuesLoading || state.issuesError ? undefined : state.issues,
          isLoading: state.issuesLoading,
          isError: state.issuesError,
          error: state.issuesErrorValue,
          refetch: refetchIssues,
        };
      case "members":
        return { data: state.members };
      default:
        return { data: undefined };
    }
  },
}));

vi.mock("@multiremi/core/projects/queries", () => ({
  projectDetailOptions: () => ({ queryKey: ["project"] }),
}));

vi.mock("@multiremi/core/projects/mutations", () => ({
  useUpdateProject: () => ({ mutate: updateProject }),
  useArchiveProject: () => ({ mutate: archiveProject, isPending: false }),
  useRestoreProject: () => ({ mutate: restoreProject, isPending: false }),
}));

vi.mock("@multiremi/core/pins", () => ({
  pinListOptions: () => ({ queryKey: ["pins"] }),
  useCreatePin: () => ({ mutate: vi.fn() }),
  useDeletePin: () => ({ mutate: vi.fn() }),
}));

vi.mock("@multiremi/core/issues/queries", () => ({
  myIssueListOptions: () => ({ queryKey: ["issues"] }),
  myIssueAssigneeGroupsOptions: () => ({ queryKey: ["assigneeGroups"] }),
  projectGanttIssuesOptions: () => ({ queryKey: ["gantt"] }),
  childIssueProgressOptions: () => ({ queryKey: ["childProgress"] }),
}));

vi.mock("@multiremi/core/issues/mutations", () => ({
  useUpdateIssue: () => ({ mutate: vi.fn() }),
}));

vi.mock("@multiremi/core/workspace/queries", () => ({
  memberListOptions: () => ({ queryKey: ["members"] }),
  // Consumed by the default-assignee AssigneePicker in the sidebar; the
  // useQuery mock's default branch serves them as empty lists.
  agentListOptions: () => ({ queryKey: ["agents"] }),
  squadListOptions: () => ({ queryKey: ["squads"] }),
  assigneeFrequencyOptions: () => ({ queryKey: ["assigneeFrequency"] }),
}));

vi.mock("@multiremi/core/agents", () => ({
  agentTaskSnapshotOptions: () => ({ queryKey: ["snapshot"] }),
}));

vi.mock("@multiremi/core/modals", () => ({
  useModalStore: { getState: () => ({ open: vi.fn() }) },
}));

vi.mock("@multiremi/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multiremi/core/chat", () => ({
  useRecentContextStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ recordVisit: vi.fn() }),
}));

vi.mock("@multiremi/core/auth", () => ({
  useAuthStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ user: { id: "user-1" } }),
}));

vi.mock("@multiremi/core/paths", () => ({
  useWorkspacePaths: () => ({ projects: () => "/ws/projects" }),
}));

vi.mock("@multiremi/core/workspace/hooks", () => ({
  useActorName: () => ({
    getActorName: (type: string, id: string) => `${type}:${id}`,
  }),
}));

vi.mock("@multiremi/core/issues/stores/view-store", () => ({
  createIssueViewStore: () => ({}),
}));

vi.mock("@multiremi/core/issues/stores/view-store-context", () => ({
  ViewStoreProvider: ({ children }: { children: ReactNode }) => children,
  useViewStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      viewMode: "list",
      grouping: "status",
      sortBy: "position",
      sortDirection: "asc",
      statusFilters: [],
      priorityFilters: [],
      assigneeFilters: [],
      includeNoAssignee: false,
      creatorFilters: [],
      labelFilters: [],
      agentRunningFilter: false,
    }),
}));

vi.mock("react-resizable-panels", () => ({
  useDefaultLayout: () => ({ defaultLayout: undefined, onLayoutChanged: vi.fn() }),
  usePanelRef: () => ({ current: null }),
}));

vi.mock("@multiremi/ui/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => null,
}));

vi.mock("@multiremi/ui/components/common/emoji-picker", () => ({
  EmojiPicker: () => <div data-testid="emoji-picker" />,
}));

vi.mock("../../editor", () => ({
  TitleEditor: ({ defaultValue }: { defaultValue: string }) => <div>{defaultValue}</div>,
  ContentEditor: () => <div data-testid="content-editor" />,
  ReadonlyContent: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.mock("../../navigation", () => ({
  useNavigation: () => ({ push: vi.fn() }),
}));

vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: ({ actorId }: { actorId: string }) => (
    <span data-testid={`avatar-${actorId}`} />
  ),
}));

vi.mock("../../layout/breadcrumb-header", () => ({
  BreadcrumbHeader: ({ actions }: { actions: ReactNode }) => <div>{actions}</div>,
}));

vi.mock("./project-resources-section", () => ({
  ProjectResourcesSection: ({ editable = true }: { editable?: boolean }) => (
    <div data-testid="resources" data-editable={String(editable)} />
  ),
}));

vi.mock("./wiki/project-content-tabs", () => ({
  ProjectContentTabs: ({
    issues,
    contentTab,
    wikiSlug,
  }: {
    issues: ReactNode;
    contentTab: string;
    wikiSlug?: string;
  }) => (
    <div
      data-testid="content-tabs"
      data-tab={contentTab}
      data-wiki-slug={wikiSlug ?? ""}
    >
      {issues}
    </div>
  ),
}));

vi.mock("../../issues/components/issues-header", () => ({
  IssuesHeader: () => <div data-testid="issues-header" />,
}));
vi.mock("../../issues/components/board-view", () => ({
  BoardView: () => <div data-testid="board-view" />,
}));
vi.mock("../../issues/components/list-view", () => ({
  ListView: ({ issues }: { issues: { id: string }[] }) => (
    <div data-testid="list-view">{issues.length}</div>
  ),
}));
vi.mock("../../issues/components/gantt-view", () => ({
  GanttView: () => <div data-testid="gantt-view" />,
}));
vi.mock("../../issues/components/swimlane-view", () => ({
  SwimLaneView: () => <div data-testid="swimlane-view" />,
}));
vi.mock("../../issues/components/batch-action-toolbar", () => ({
  BatchActionToolbar: () => null,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ProjectDetail } from "./project-detail";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj-1",
    workspace_id: "ws-1",
    title: "Apollo",
    description: null,
    icon: null,
    status: "in_progress",
    priority: "medium",
    lead_type: null,
    lead_id: null,
    default_assignee_type: null,
    default_assignee_id: null,
    archived_at: null,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    issue_count: 4,
    done_count: 1,
    resource_count: 0,
    ...overrides,
  };
}

function renderDetail(
  props: { contentTab?: "issues" | "wiki"; wikiSlug?: string } = {},
) {
  render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <ProjectDetail projectId="proj-1" {...props} />
    </I18nProvider>,
  );
}

describe("ProjectDetail issues surface", () => {
  beforeEach(() => {
    state.project = makeProject();
    state.projectLoading = false;
    state.issues = [];
    state.issuesLoading = false;
    state.issuesError = false;
    state.issuesErrorValue = null;
    state.members = [];
    refetchIssues.mockClear();
    updateProject.mockClear();
  });

  it("shows a skeleton while the issue query is loading, not the empty-project CTA", () => {
    state.issuesLoading = true;

    renderDetail();

    expect(
      document.querySelectorAll('[data-slot="skeleton"]').length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("No issues linked")).not.toBeInTheDocument();
    expect(screen.queryByTestId("list-view")).not.toBeInTheDocument();
  });

  it("shows a retryable error when the issue query fails", () => {
    state.issuesError = true;
    state.issuesErrorValue = new Error("gateway timeout");

    renderDetail();

    expect(screen.getByText("Couldn't load issues")).toBeInTheDocument();
    expect(screen.getByText("gateway timeout")).toBeInTheDocument();
    // The lie the empty CTA would have told a project with 400 issues.
    expect(screen.queryByText("No issues linked")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refetchIssues).toHaveBeenCalledTimes(1);
  });

  it("falls back to the generic hint when the error carries no message", () => {
    state.issuesError = true;
    state.issuesErrorValue = "boom";

    renderDetail();

    expect(
      screen.getByText("Something went wrong fetching this project's issues."),
    ).toBeInTheDocument();
  });

  it("only claims the project is empty once the query has settled", () => {
    renderDetail();

    expect(screen.getByText("No issues linked")).toBeInTheDocument();
  });

  it("renders the list once the settled query has issues", () => {
    state.issues = [{ id: "MUL-1", status: "todo", priority: "medium" }];

    renderDetail();

    expect(screen.getByTestId("list-view")).toHaveTextContent("1");
  });

  it("hands the content tabs the route's tab and wiki ref, issues by default", () => {
    renderDetail();

    expect(screen.getByTestId("content-tabs")).toHaveAttribute(
      "data-tab",
      "issues",
    );

    cleanup();
    renderDetail({ contentTab: "wiki", wikiSlug: "runbook" });

    const tabs = screen.getByTestId("content-tabs");
    expect(tabs).toHaveAttribute("data-tab", "wiki");
    expect(tabs).toHaveAttribute("data-wiki-slug", "runbook");
  });
});

describe("ProjectDetail lead picker", () => {
  beforeEach(() => {
    state.project = makeProject();
    state.projectLoading = false;
    state.issues = [];
    state.issuesLoading = false;
    state.issuesError = false;
    state.issuesErrorValue = null;
    state.members = [{ user_id: "user-2", name: "张三" }];
    updateProject.mockClear();
  });

  it("uses the shared picker shell — search box, grouped sections, checked current lead", () => {
    state.project = makeProject({ lead_type: "member", lead_id: "user-2" });

    renderDetail();
    fireEvent.click(screen.getByText("member:user-2"));

    // The shared shell's search input carries the picker's own aria-label —
    // the hand-rolled <input> it replaced had none.
    expect(
      screen.getByRole("textbox", { name: "Filter options" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Members")).toBeInTheDocument();
    expect(screen.queryByText("Agents")).not.toBeInTheDocument();
  });

  it("assigns a member as lead and closes", () => {
    renderDetail();
    fireEvent.click(screen.getByText("No owner"));

    fireEvent.click(screen.getByText("张三"));

    expect(updateProject).toHaveBeenCalledWith({
      id: "proj-1",
      lead_type: "member",
      lead_id: "user-2",
    });
  });

  it("filters by pinyin and falls back to the shared empty state", () => {
    renderDetail();
    fireEvent.click(screen.getByText("No owner"));

    const search = screen.getByRole("textbox", { name: "Filter options" });
    fireEvent.change(search, { target: { value: "zhang" } });
    expect(screen.getByText("张三")).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "nobody-here" } });
    expect(screen.getByText("No results")).toBeInTheDocument();
  });

  it("clears the lead", () => {
    state.project = makeProject({ lead_type: "member", lead_id: "user-2" });

    renderDetail();
    fireEvent.click(screen.getByText("member:user-2"));
    fireEvent.click(screen.getByText("No owner"));

    expect(updateProject).toHaveBeenCalledWith({
      id: "proj-1",
      lead_type: null,
      lead_id: null,
    });
  });
});

describe("ProjectDetail semantic tokens", () => {
  beforeEach(() => {
    state.project = makeProject();
    state.projectLoading = false;
    state.issues = [];
    state.issuesLoading = false;
    state.issuesError = false;
    state.members = [];
  });

  it("paints the progress bar with the success token, not a palette literal", () => {
    renderDetail();

    expect(document.querySelector(".bg-success")).not.toBeNull();
    expect(document.querySelector(".bg-emerald-500")).toBeNull();
  });
});

describe("ProjectDetail archived state", () => {
  beforeEach(() => {
    state.project = makeProject({
      archived_at: "2026-08-10T00:00:00Z",
      description: "Historical context",
    });
    state.projectLoading = false;
    state.issues = [];
    state.issuesLoading = false;
    state.issuesError = false;
    state.members = [];
    restoreProject.mockClear();
  });

  it("renders project metadata read-only and offers restore", () => {
    renderDetail();

    expect(screen.getByText("Archived")).toBeInTheDocument();
    expect(screen.getByText("Historical context")).toBeInTheDocument();
    expect(screen.queryByTestId("content-editor")).not.toBeInTheDocument();
    expect(screen.getByTestId("resources")).toHaveAttribute("data-editable", "false");

    fireEvent.click(screen.getByRole("button", { name: "Restore project" }));
    expect(restoreProject).toHaveBeenCalledWith("proj-1", expect.any(Object));
  });
});
