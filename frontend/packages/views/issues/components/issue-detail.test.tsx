import { forwardRef, useRef, useState, useImperativeHandle } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue, TimelineEntry } from "@multiremi/core/types";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enIssues from "../../locales/en/issues.json";

const TEST_RESOURCES = { en: { common: enCommon, issues: enIssues } };

const mockViewport = vi.hoisted(() => ({ isMobile: false }));
const mockNavigationReplace = vi.hoisted(() => vi.fn());
const mockToast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

vi.mock("@multiremi/ui/hooks/use-mobile", () => ({
  useIsMobile: () => mockViewport.isMobile,
}));

// useWorkspaceId() derives from useCurrentWorkspace (relative import inside
// @multiremi/core/hooks.tsx). vi.mock("@multiremi/core/paths") only intercepts
// the bare-specifier, not the internal relative import. Mock the hooks module
// directly so the bridge hook returns the test UUID.
vi.mock("@multiremi/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock @multiremi/core/auth
const mockAuthUser = { id: "user-1", email: "test@test.com", name: "Test User" };
vi.mock("@multiremi/core/auth", () => ({
  useAuthStore: Object.assign(
    (selector?: any) => {
      const state = { user: mockAuthUser, isAuthenticated: true };
      return selector ? selector(state) : state;
    },
    { getState: () => ({ user: mockAuthUser, isAuthenticated: true }) },
  ),
  registerAuthStore: vi.fn(),
  createAuthStore: vi.fn(),
}));

// Mock @multiremi/core/workspace/hooks
vi.mock("@multiremi/core/workspace/hooks", () => ({
  useActorName: () => ({
    getMemberName: (id: string) => (id === "user-1" ? "Test User" : "Unknown"),
    getAgentName: (id: string) => (id === "agent-1" ? "Claude Agent" : "Unknown Agent"),
    getActorName: (type: string, id: string) => {
      if (type === "member" && id === "user-1") return "Test User";
      if (type === "agent" && id === "agent-1") return "Claude Agent";
      return "Unknown";
    },
    getActorInitials: (type: string) => (type === "member" ? "TU" : "CA"),
    getActorAvatarUrl: () => null,
  }),
}));

// Mock workspace queries
vi.mock("@multiremi/core/workspace/queries", () => ({
  memberListOptions: () => ({
    queryKey: ["workspaces", "ws-1", "members"],
    queryFn: () => Promise.resolve([{ user_id: "user-1", name: "Test User", email: "test@test.com", role: "admin" }]),
  }),
  agentListOptions: () => ({
    queryKey: ["workspaces", "ws-1", "agents"],
    queryFn: () => Promise.resolve([]),
  }),
  squadListOptions: () => ({
    queryKey: ["workspaces", "ws-1", "squads"],
    queryFn: () => Promise.resolve([]),
  }),
  assigneeFrequencyOptions: () => ({
    queryKey: ["workspaces", "ws-1", "assignee-frequency"],
    queryFn: () => Promise.resolve([]),
  }),
  workspaceListOptions: () => ({
    queryKey: ["workspaces"],
    queryFn: () => Promise.resolve([{ id: "ws-1", name: "Test WS", slug: "test" }]),
  }),
}));

// Mock @multiremi/core/paths — after the URL-driven workspace refactor,
// useCurrentWorkspace / useWorkspacePaths derive from the workspace slug in
// URL Context. Tests don't mount a real route, so we short-circuit to fixtures.
vi.mock("@multiremi/core/paths", async () => {
  const actual = await vi.importActual<typeof import("@multiremi/core/paths")>(
    "@multiremi/core/paths",
  );
  return {
    ...actual,
    useCurrentWorkspace: () => ({ id: "ws-1", name: "Test WS", slug: "test" }),
    useWorkspacePaths: () => actual.paths.workspace("test"),
  };
});

// Mock navigation
vi.mock("../../navigation", () => ({
  AppLink: ({ children, href, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
  useNavigation: () => ({
    push: vi.fn(),
    replace: mockNavigationReplace,
    pathname: "/issues/issue-1",
    getShareableUrl: (p: string) => `https://app.multimira.com${p}`,
  }),
  NavigationProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock editor components (Tiptap requires real DOM)
vi.mock("../../editor", () => ({
  useFileDropZone: () => ({ isDragOver: false, dropZoneProps: {} }),
  FileDropOverlay: () => null,
  // No-op so comment-card's AttachmentList can render without hitting the
  // real API singleton; tests that care about download wiring should write
  // dedicated specs against `use-download-attachment.test.tsx`.
  useDownloadAttachment: () => vi.fn(),
  // Inert preview hook — comment-card's AttachmentList uses it to gate the
  // Eye button. Dedicated coverage lives in attachment-preview-modal.test.tsx.
  useAttachmentPreview: () => ({
    open: vi.fn(),
    tryOpen: () => false,
    modal: null,
  }),
  isPreviewable: () => false,
  ReadonlyContent: ({ content }: { content: string }) => (
    <div data-testid="readonly-content">{content}</div>
  ),
  ContentEditor: forwardRef(function MockContentEditor(
    { defaultValue, onUpdate, placeholder }: any,
    ref: any,
  ) {
    const valueRef = useRef(defaultValue || "");
    const [value, setValue] = useState(defaultValue || "");
    useImperativeHandle(ref, () => ({
      getMarkdown: () => valueRef.current,
      clearContent: () => { valueRef.current = ""; setValue(""); },
      focus: () => {},
      uploadFile: () => {},
    }));
    return (
      <textarea
        value={value}
        onChange={(e) => {
          valueRef.current = e.target.value;
          setValue(e.target.value);
          onUpdate?.(e.target.value);
        }}
        placeholder={placeholder}
        data-testid="rich-text-editor"
      />
    );
  }),
  TitleEditor: forwardRef(function MockTitleEditor(
    { defaultValue, placeholder, onBlur, onChange }: any,
    ref: any,
  ) {
    const valueRef = useRef(defaultValue || "");
    const [value, setValue] = useState(defaultValue || "");
    useImperativeHandle(ref, () => ({
      getText: () => valueRef.current,
      focus: () => {},
    }));
    return (
      <input
        value={value}
        onChange={(e) => {
          valueRef.current = e.target.value;
          setValue(e.target.value);
          onChange?.(e.target.value);
        }}
        onBlur={() => onBlur?.(valueRef.current)}
        placeholder={placeholder}
        data-testid="title-editor"
      />
    );
  }),
}));

// Mock common components
vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: ({ actorType, actorId }: any) => (
    <span data-testid="actor-avatar">
      {actorType}:{actorId}
    </span>
  ),
}));

vi.mock("../../projects/components/project-picker", () => ({
  ProjectPicker: () => <span data-testid="project-picker">Project</span>,
}));

// Mock api
const mockApiObj = vi.hoisted(() => ({
  getIssue: vi.fn(),
  listIssueSessions: vi.fn().mockResolvedValue([{
    id: "session-main",
    issue_id: "issue-1",
    workspace_id: "ws-1",
    title: "Main",
    status: "active",
    is_default: true,
    summary: null,
    created_by_type: "system",
    created_by_id: null,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    participants: [],
  }]),
  listSessionTasks: vi.fn().mockResolvedValue([]),
  listIssueSessionResults: vi.fn().mockResolvedValue([]),
  createIssueSession: vi.fn(),
  addSessionParticipant: vi.fn(),
  createSessionTask: vi.fn(),
  publishSessionResult: vi.fn(),
  listTimeline: vi.fn().mockResolvedValue([]),
  listComments: vi.fn().mockResolvedValue([]),
  createComment: vi.fn(),
  updateComment: vi.fn(),
  deleteComment: vi.fn(),
  deleteIssue: vi.fn(),
  updateIssue: vi.fn(),
  patchIssue: vi.fn(),
  retitleIssue: vi.fn(),
  listIssueSubscribers: vi.fn().mockResolvedValue([]),
  subscribeToIssue: vi.fn().mockResolvedValue(undefined),
  unsubscribeFromIssue: vi.fn().mockResolvedValue(undefined),
  getActiveTasksForIssue: vi.fn().mockResolvedValue({ tasks: [] }),
  listTasksByIssue: vi.fn().mockResolvedValue([]),
  listIssueSessionArchives: vi.fn().mockResolvedValue({
    archives: [],
    latest: null,
    latest_ready: null,
  }),
  listTaskMessages: vi.fn().mockResolvedValue([]),
  listChildIssues: vi.fn().mockResolvedValue({ issues: [] }),
  listIssues: vi.fn().mockResolvedValue({ issues: [], total: 0 }),
  uploadFile: vi.fn(),
  listIssueReactions: vi.fn().mockResolvedValue([]),
  addIssueReaction: vi.fn(),
  removeIssueReaction: vi.fn(),
  listAttachments: vi.fn().mockResolvedValue([]),
  addCommentReaction: vi.fn(),
  removeCommentReaction: vi.fn(),
  listMembers: vi.fn().mockResolvedValue([{ user_id: "user-1", name: "Test User", email: "test@test.com", role: "admin" }]),
  listAgents: vi.fn().mockResolvedValue([]),
  getProject: vi.fn(),
  listProjects: vi.fn().mockResolvedValue({ projects: [] }),
}));

vi.mock("@multiremi/core/api", () => ({
  api: mockApiObj,
  getApi: () => mockApiObj,
  setApiInstance: vi.fn(),
}));

// Mock issue config
vi.mock("@multiremi/core/issues/config", () => ({
  ALL_STATUSES: ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"],
  BOARD_STATUSES: ["backlog", "todo", "in_progress", "in_review", "done", "blocked"],
  STATUS_ORDER: ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"],
  STATUS_CONFIG: {
    backlog: { label: "Backlog", iconColor: "text-muted-foreground", hoverBg: "hover:bg-accent" },
    todo: { label: "Todo", iconColor: "text-muted-foreground", hoverBg: "hover:bg-accent" },
    in_progress: { label: "In Progress", iconColor: "text-warning", hoverBg: "hover:bg-warning/10" },
    in_review: { label: "In Review", iconColor: "text-success", hoverBg: "hover:bg-success/10" },
    done: { label: "Done", iconColor: "text-info", hoverBg: "hover:bg-info/10" },
    blocked: { label: "Blocked", iconColor: "text-destructive", hoverBg: "hover:bg-destructive/10" },
    cancelled: { label: "Cancelled", iconColor: "text-muted-foreground", hoverBg: "hover:bg-accent" },
  },
  PRIORITY_ORDER: ["urgent", "high", "medium", "low", "none"],
  PRIORITY_CONFIG: {
    urgent: { label: "Urgent", bars: 4, color: "text-destructive", badgeBg: "bg-destructive/10", badgeText: "text-destructive" },
    high: { label: "High", bars: 3, color: "text-warning", badgeBg: "bg-warning/10", badgeText: "text-warning" },
    medium: { label: "Medium", bars: 2, color: "text-warning", badgeBg: "bg-warning/10", badgeText: "text-warning" },
    low: { label: "Low", bars: 1, color: "text-info", badgeBg: "bg-info/10", badgeText: "text-info" },
    none: { label: "No priority", bars: 0, color: "text-muted-foreground", badgeBg: "bg-muted", badgeText: "text-muted-foreground" },
  },
}));

// Mock recent issues store
const mockRecordVisit = vi.fn();
vi.mock("@multiremi/core/issues/stores", () => ({
  useIssueDetailPreferencesStore: (selector: any) =>
    selector({
      sessionSidebarOpen: true,
      toggleSessionSidebar: vi.fn(),
    }),
  useRecentIssuesStore: Object.assign(
    (selector?: any) => {
      const state = { byWorkspace: {}, recordVisit: mockRecordVisit, pruneWorkspaces: vi.fn() };
      return selector ? selector(state) : state;
    },
    {
      getState: () => ({
        byWorkspace: {},
        recordVisit: mockRecordVisit,
        pruneWorkspaces: vi.fn(),
      }),
    },
  ),
  selectRecentIssues: () => () => [],
  useCommentDraftStore: Object.assign(
    (selector?: any) => {
      const state = {
        drafts: {} as Record<string, { content: string; updatedAt: number }>,
        getDraft: () => undefined,
        setDraft: () => {},
        clearDraft: () => {},
      };
      return selector ? selector(state) : state;
    },
    {
      getState: () => ({
        drafts: {} as Record<string, { content: string; updatedAt: number }>,
        getDraft: () => undefined,
        setDraft: () => {},
        clearDraft: () => {},
      }),
    },
  ),
}));

// Mock react-virtuoso: jsdom has no real layout, so the real Virtuoso would
// compute a 0-height viewport and render nothing. The mock renders every item
// inline so id="comment-..." nodes are always present in the DOM — this
// matches the production cold-path where `initialItemCount` force-mounts
// items[0..targetIdx], giving the native scrollIntoView a real target.
//
// scrollIntoViewSpy: we spy on Element.prototype.scrollIntoView (jsdom no-ops
// it by default) so tests can assert the deep-link effect dispatched a
// native scroll on the target node.
const scrollIntoViewSpy = vi.hoisted(() => vi.fn());
// Observed by the open-at-latest tests: the section's initial-land effect and
// the jump chip both go through the Virtuoso ref's scrollToIndex.
const virtuosoScrollToIndexSpy = vi.hoisted(() => vi.fn());
// Latest props handed to the mock, so tests can drive atBottomStateChange.
const virtuosoLatestProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock("react-virtuoso", () => ({
  Virtuoso: forwardRef(function MockVirtuoso(
    props: { data: unknown[]; itemContent: (i: number, item: unknown) => unknown },
    ref: any,
  ) {
    const { data, itemContent } = props;
    virtuosoLatestProps.current = props as Record<string, unknown>;
    useImperativeHandle(ref, () => ({
      // scrollIntoView is unexercised here — the deep-link cold-path uses
      // native scrollIntoView on the DOM node instead of the ref.
      scrollIntoView: vi.fn(),
      scrollToIndex: virtuosoScrollToIndexSpy,
    }));
    return (
      <div data-testid="virtuoso-mock">
        {data.map((item, i) => (
          <div key={i}>{itemContent(i, item) as React.ReactElement}</div>
        ))}
      </div>
    );
  }),
}));

// jsdom's HTMLElement.prototype.scrollIntoView is a no-op stub; replace it
// with a spy so the deep-link effect's call can be observed.
beforeEach(() => {
  mockNavigationReplace.mockClear();
  scrollIntoViewSpy.mockClear();
  virtuosoScrollToIndexSpy.mockClear();
  virtuosoLatestProps.current = null;
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: scrollIntoViewSpy,
  });
});

// Mock modals
vi.mock("@multiremi/core/modals", () => ({
  useModalStore: Object.assign(
    () => ({ open: vi.fn() }),
    { getState: () => ({ open: vi.fn() }) },
  ),
}));

// Mock core/hooks/use-file-upload
vi.mock("@multiremi/core/hooks/use-file-upload", () => ({
  useFileUpload: () => ({ uploadWithToast: vi.fn().mockResolvedValue("https://example.com/file.png") }),
}));

// Mock realtime
vi.mock("@multiremi/core/realtime", () => ({
  useWSEvent: vi.fn(),
  useWSReconnect: vi.fn(),
  useTaskScopeSubscription: vi.fn(),
  useWS: () => ({ subscribe: vi.fn(() => () => {}), onReconnect: vi.fn(() => () => {}) }),
  WSProvider: ({ children }: { children: React.ReactNode }) => children,
  useRealtimeSync: () => {},
}));

// Mock sonner
vi.mock("sonner", () => ({
  toast: mockToast,
}));

// Mock react-resizable-panels (used by @multiremi/ui/components/ui/resizable)
vi.mock("react-resizable-panels", () => ({
  Group: ({ children, ...props }: any) => <div data-testid="panel-group" {...props}>{children}</div>,
  Panel: ({ children, ...props }: any) => <div data-testid="panel" {...props}>{children}</div>,
  Separator: ({ children, ...props }: any) => <div data-testid="panel-handle" {...props}>{children}</div>,
  useDefaultLayout: () => ({ defaultLayout: undefined, onLayoutChanged: vi.fn() }),
  usePanelRef: () => ({ current: { isCollapsed: () => false, expand: vi.fn(), collapse: vi.fn() } }),
}));

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const mockIssue: Issue = {
  id: "issue-1",
  workspace_id: "ws-1",
  number: 1,
  identifier: "TES-1",
  title: "Implement authentication",
  description: "Add JWT auth to the backend",
  status: "in_progress",
  priority: "high",
  assignee_type: "member",
  assignee_id: "user-1",
  creator_type: "member",
  creator_id: "user-1",
  parent_issue_id: null,
  project_id: null,
  position: 0,
  start_date: null,
  due_date: "2026-06-01T00:00:00Z",
  completed_at: null,
  archived_at: null,
  metadata: {},
  created_at: "2026-01-15T00:00:00Z",
  updated_at: "2026-01-20T00:00:00Z",
};

const mockTimeline: TimelineEntry[] = [
  {
    type: "comment",
    id: "comment-1",
    actor_type: "member",
    actor_id: "user-1",
    content: "Started working on this",
    parent_id: null,
    created_at: "2026-01-16T00:00:00Z",
    updated_at: "2026-01-16T00:00:00Z",
    comment_type: "comment",
  },
  {
    type: "comment",
    id: "comment-2",
    actor_type: "agent",
    actor_id: "agent-1",
    content: "I can help with this",
    parent_id: null,
    created_at: "2026-01-17T00:00:00Z",
    updated_at: "2026-01-17T00:00:00Z",
    comment_type: "comment",
  },
];

// ---------------------------------------------------------------------------
// Import component under test (after mocks)
// ---------------------------------------------------------------------------

import { useIssueSelectionStore } from "@multiremi/core/issues/stores/selection-store";
import { IssueDetail } from "./issue-detail";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

function renderIssueDetail(
  issueId = "issue-1",
  initialIssueSessionId?: string,
  onIssueSessionChange?: (sessionId: string) => void,
) {
  const queryClient = createTestQueryClient();
  return render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <QueryClientProvider client={queryClient}>
        <IssueDetail
          issueId={issueId}
          initialIssueSessionId={initialIssueSessionId}
          onIssueSessionChange={onIssueSessionChange}
        />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

function renderIssueDetailWithHighlight(
  highlightCommentId: string,
  issueId = "issue-1",
  options: { seedTimeline?: boolean } = {},
) {
  const queryClient = createTestQueryClient();
  if (options.seedTimeline) {
    // Pre-populate the timeline cache so the first render sees timeline.length>0.
    // This reproduces the inbox-click race: timeline data is available before
    // the issue itself has finished loading, so the effect that scrolls to
    // the comment fires once with `loading=true` (skeleton still rendered,
    // no comment DOM) and must re-fire when `loading` flips to false.
    queryClient.setQueryData(["issues", "timeline", issueId, "session-main"], mockTimeline);
  }
  const result = render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <QueryClientProvider client={queryClient}>
        <IssueDetail issueId={issueId} highlightCommentId={highlightCommentId} />
      </QueryClientProvider>
    </I18nProvider>,
  );
  return { ...result, queryClient };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IssueDetail (shared)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockViewport.isMobile = false;
    // Default: issue loads successfully
    mockApiObj.getIssue.mockResolvedValue(mockIssue);
    mockApiObj.listIssueSessions.mockResolvedValue([{
      id: "session-main",
      issue_id: mockIssue.id,
      workspace_id: "ws-1",
      title: "Main",
      status: "active",
      is_default: true,
      summary: null,
      created_by_type: "system",
      created_by_id: null,
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
      participants: [],
    }]);
    mockApiObj.listSessionTasks.mockResolvedValue([]);
    mockApiObj.listIssueSessionResults.mockResolvedValue([]);
    // /timeline returns the entries flat in chronological order (oldest first).
    mockApiObj.listTimeline.mockResolvedValue(mockTimeline);
    mockApiObj.listIssueReactions.mockResolvedValue([]);
    mockApiObj.listIssueSubscribers.mockResolvedValue([]);
    mockApiObj.listChildIssues.mockResolvedValue({ issues: [] });
    mockApiObj.listIssues.mockResolvedValue({ issues: [], total: 0 });
    mockApiObj.getActiveTasksForIssue.mockResolvedValue({ tasks: [] });
    mockApiObj.listTasksByIssue.mockResolvedValue([]);
    mockApiObj.listMembers.mockResolvedValue([
      { user_id: "user-1", name: "Test User", email: "test@test.com", role: "admin" },
    ]);
    mockApiObj.listAgents.mockResolvedValue([]);
    // Reset project mock — individual tests override per case. Default fixture
    // has project_id: null so getProject is not invoked.
    mockApiObj.getProject.mockReset();
  });

  it("shows loading skeleton while data is loading", () => {
    // Make the API hang to keep loading state
    mockApiObj.getIssue.mockReturnValue(new Promise(() => {}));
    renderIssueDetail();

    expect(
      screen.getAllByRole("generic").some((el) => el.getAttribute("data-slot") === "skeleton"),
    ).toBe(true);
  });

  it("renders issue title and description after loading", async () => {
    renderIssueDetail();

    await waitFor(() => {
      expect(screen.getByDisplayValue("Implement authentication")).toBeInTheDocument();
    });

    expect(screen.getByDisplayValue("Add JWT auth to the backend")).toBeInTheDocument();
  });

  it("renames an issue with Luna and offers an undo action", async () => {
    let currentIssue = { ...mockIssue };
    mockApiObj.getIssue.mockImplementation(() => Promise.resolve(currentIssue));
    mockApiObj.retitleIssue.mockImplementation(async () => {
      currentIssue = { ...currentIssue, title: "Add JWT authentication" };
      return {
        title: currentIssue.title,
        previous_title: mockIssue.title,
        applied: true,
        reason: "generated",
      };
    });
    mockApiObj.patchIssue.mockImplementation(async (_id: string, updates: { title: string }) => {
      currentIssue = { ...currentIssue, title: updates.title };
      return currentIssue;
    });
    renderIssueDetail();

    fireEvent.click(await screen.findByRole("button", { name: "Rename with Luna" }));

    await waitFor(() => {
      expect(mockApiObj.retitleIssue).toHaveBeenCalledWith("issue-1");
      expect(screen.getByDisplayValue("Add JWT authentication")).toBeInTheDocument();
    });
    const successCall = mockToast.success.mock.calls.find(
      ([message]) => String(message).includes("Renamed:"),
    );
    expect(successCall).toBeDefined();

    const options = successCall?.[1] as { action?: { onClick?: () => void } } | undefined;
    options?.action?.onClick?.();

    await waitFor(() => {
      expect(mockApiObj.patchIssue).toHaveBeenCalledWith("issue-1", {
        title: "Implement authentication",
      });
      expect(screen.getByDisplayValue("Implement authentication")).toBeInTheDocument();
    });
  });

  it("offers result acceptance in the sidebar after the latest agent task completes", async () => {
    mockApiObj.getIssue.mockResolvedValue({ ...mockIssue, status: "in_review" });
    mockApiObj.listTasksByIssue.mockResolvedValue([
      {
        id: "task-completed",
        agent_id: "agent-1",
        issue_id: mockIssue.id,
        runtime_id: "runtime-1",
        status: "completed",
        priority: 0,
        dispatched_at: "2026-01-20T00:00:00Z",
        started_at: "2026-01-20T00:01:00Z",
        completed_at: "2026-01-20T00:02:00Z",
        result: { output: "Ready" },
        error: null,
        created_at: "2026-01-20T00:00:00Z",
      },
    ]);
    renderIssueDetail();

    const button = await screen.findByRole("button", { name: "Complete issue" });
    fireEvent.click(button);

    await waitFor(() => {
      expect(mockApiObj.updateIssue).toHaveBeenCalledWith("issue-1", { status: "done" });
    });
  });

  it("does not offer result acceptance while the latest agent task is active", async () => {
    mockApiObj.getIssue.mockResolvedValue({ ...mockIssue, status: "in_review" });
    mockApiObj.listTasksByIssue.mockResolvedValue([
      {
        id: "task-running",
        agent_id: "agent-1",
        issue_id: mockIssue.id,
        runtime_id: "runtime-1",
        status: "running",
        priority: 0,
        dispatched_at: "2026-01-20T01:00:00Z",
        started_at: "2026-01-20T01:01:00Z",
        completed_at: null,
        result: null,
        error: null,
        created_at: "2026-01-20T01:00:00Z",
      },
      {
        id: "task-completed",
        agent_id: "agent-1",
        issue_id: mockIssue.id,
        runtime_id: "runtime-1",
        status: "completed",
        priority: 0,
        dispatched_at: "2026-01-20T00:00:00Z",
        started_at: "2026-01-20T00:01:00Z",
        completed_at: "2026-01-20T00:02:00Z",
        result: { output: "Old result" },
        error: null,
        created_at: "2026-01-20T00:00:00Z",
      },
    ]);
    renderIssueDetail();

    await screen.findByDisplayValue("Implement authentication");
    await waitFor(() => expect(mockApiObj.listTasksByIssue).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Complete issue" })).not.toBeInTheDocument();
  });

  it("does not offer result acceptance while another agent task awaits review", async () => {
    mockApiObj.getIssue.mockResolvedValue({ ...mockIssue, status: "in_review" });
    mockApiObj.listTasksByIssue.mockResolvedValue([
      {
        id: "task-completed",
        agent_id: "agent-1",
        issue_id: mockIssue.id,
        runtime_id: "runtime-1",
        status: "completed",
        priority: 0,
        dispatched_at: "2026-01-20T01:00:00Z",
        started_at: "2026-01-20T01:01:00Z",
        completed_at: "2026-01-20T01:02:00Z",
        result: { output: "Partial result" },
        error: null,
        created_at: "2026-01-20T01:00:00Z",
      },
      {
        id: "task-awaiting-human",
        agent_id: "agent-2",
        issue_id: mockIssue.id,
        runtime_id: "runtime-1",
        status: "awaiting_human",
        priority: 0,
        dispatched_at: "2026-01-20T00:00:00Z",
        started_at: "2026-01-20T00:01:00Z",
        completed_at: null,
        result: null,
        error: null,
        created_at: "2026-01-20T00:00:00Z",
      },
    ]);
    renderIssueDetail();

    await screen.findByDisplayValue("Implement authentication");
    await waitFor(() => expect(mockApiObj.listTasksByIssue).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Complete issue" })).not.toBeInTheDocument();
  });

  it("opens the conversation landed on its newest entry", async () => {
    renderIssueDetail();

    await waitFor(() => {
      expect(virtuosoScrollToIndexSpy).toHaveBeenCalledWith(
        expect.objectContaining({ index: expect.any(Number), align: "end" }),
      );
    });
    // One-shot: the landing effect must not re-fire on subsequent renders.
    expect(virtuosoScrollToIndexSpy).toHaveBeenCalledTimes(1);
  });

  it("offers a jump-to-latest chip when scrolled away from the newest entry", async () => {
    renderIssueDetail();
    await waitFor(() => {
      expect(screen.getByTestId("virtuoso-mock")).toBeInTheDocument();
    });

    // No chip while the viewport sits at the bottom (initial state).
    expect(screen.queryByRole("button", { name: /jump to latest/i })).not.toBeInTheDocument();

    const atBottomStateChange = virtuosoLatestProps.current?.atBottomStateChange as
      | ((atBottom: boolean) => void)
      | undefined;
    expect(atBottomStateChange).toBeTypeOf("function");
    await waitFor(() => {
      atBottomStateChange!(false);
      expect(screen.getByRole("button", { name: /jump to latest/i })).toBeInTheDocument();
    });

    virtuosoScrollToIndexSpy.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /jump to latest/i }));
    expect(virtuosoScrollToIndexSpy).toHaveBeenCalledWith(
      expect.objectContaining({ index: "LAST", align: "end" }),
    );
  });

  it("switches the visible conversation by product Session", async () => {
    mockApiObj.listIssueSessions.mockResolvedValue([
      {
        id: "session-main",
        issue_id: mockIssue.id,
        workspace_id: "ws-1",
        title: "Main",
        status: "active",
        is_default: true,
        summary: null,
        created_by_type: "system",
        created_by_id: null,
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z",
        participants: [],
      },
      {
        id: "session-review",
        issue_id: mockIssue.id,
        workspace_id: "ws-1",
        title: "Review",
        status: "active",
        is_default: false,
        summary: null,
        created_by_type: "member",
        created_by_id: "user-1",
        created_at: "2025-01-02T00:00:00Z",
        updated_at: "2025-01-02T00:00:00Z",
        participants: [],
      },
    ]);
    renderIssueDetail();

    // The row's accessible name is "<title> <last activity>", so match on
    // the title prefix rather than the whole string.
    fireEvent.click(await screen.findByRole("button", { name: /^Review/ }));
    await waitFor(() => {
      expect(mockApiObj.listTimeline).toHaveBeenCalledWith("issue-1", "session-review");
    });
  });

  it("does not leave an embedding surface when the default Session resolves", async () => {
    renderIssueDetail();

    await waitFor(() => {
      expect(mockApiObj.listTimeline).toHaveBeenCalledWith("issue-1", "session-main");
    });
    expect(mockNavigationReplace).not.toHaveBeenCalled();
  });

  it("lets the host synchronize the resolved Session without hard-coding its route", async () => {
    const onIssueSessionChange = vi.fn();
    renderIssueDetail("issue-1", undefined, onIssueSessionChange);

    await waitFor(() => {
      expect(onIssueSessionChange).toHaveBeenCalledWith("session-main");
    });
    expect(mockNavigationReplace).not.toHaveBeenCalled();
  });

  it("keeps the session rail mounted on a single-session issue, with the only New-session control in its header", async () => {
    // Default fixture: one default "Main" session. The rail still mounts —
    // it is where sessions are read *and* created, so hiding it on the
    // single-session case hid the concept from everyone who never had two.
    renderIssueDetail();

    const railLabel = await screen.findByText("Sessions");
    expect(screen.getByRole("button", { name: /^Main/ })).toBeInTheDocument();

    // Exactly one create-session control in the whole page, and it lives in
    // the rail header.
    const newSessionControls = screen.getAllByRole("button", { name: "New session" });
    expect(newSessionControls).toHaveLength(1);
    expect(railLabel.parentElement).toContainElement(newSessionControls[0]!);

    // The panel keeps the per-session actions, one copy each.
    expect(screen.getAllByRole("button", { name: "Publish result" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Delegate task" })).toHaveLength(1);
  });

  it("mounts the rail in the panel's left gutter even for a single-session issue", async () => {
    // Default fixture: one default "Main" session.
    renderIssueDetail();

    await screen.findByDisplayValue("Implement authentication");
    const scrollRoot = document.querySelector<HTMLElement>("[data-tab-scroll-root]");
    expect(scrollRoot).not.toBeNull();
    // Sibling of the scroll container, immediately before it — same slot the
    // multi-session case uses, so the reading column never shifts when a
    // second session appears.
    expect(scrollRoot!.previousElementSibling).toContainElement(
      screen.getByText("Sessions"),
    );
  });

  it("explains the rail's scope without widening the column", async () => {
    renderIssueDetail();

    // The header text stays the bare word; the scope rides along as the
    // tooltip / accessible description.
    const railLabel = await screen.findByText("Sessions");
    expect(railLabel).toHaveAttribute("title", "Sessions on this issue");
  });

  it("shows the localized default-session name instead of the stored title", async () => {
    mockApiObj.listIssueSessions.mockResolvedValue([{
      id: "session-main",
      issue_id: mockIssue.id,
      workspace_id: "ws-1",
      // Server-side constant nobody typed — it must never reach the screen.
      title: "Main-RAW",
      status: "active",
      is_default: true,
      summary: null,
      created_by_type: "system",
      created_by_id: null,
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
      participants: [],
    }]);
    renderIssueDetail();

    expect(await screen.findByText("Main")).toBeInTheDocument();
    expect(screen.queryByText("Main-RAW")).not.toBeInTheDocument();
  });

  it("names the target session in the comment composer placeholder", async () => {
    const onIssueSessionChange = vi.fn();
    mockApiObj.listIssueSessions.mockResolvedValue([
      {
        id: "session-main",
        issue_id: mockIssue.id,
        workspace_id: "ws-1",
        title: "Main-RAW",
        status: "active",
        is_default: true,
        summary: null,
        created_by_type: "system",
        created_by_id: null,
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z",
        participants: [],
      },
      {
        id: "session-review",
        issue_id: mockIssue.id,
        workspace_id: "ws-1",
        title: "Review",
        status: "active",
        is_default: false,
        summary: null,
        created_by_type: "member",
        created_by_id: "user-1",
        created_at: "2025-01-02T00:00:00Z",
        updated_at: "2025-01-02T00:00:00Z",
        participants: [],
      },
    ]);
    renderIssueDetail("issue-1", undefined, onIssueSessionChange);

    // The composer sits far below the rail, so it has to say which of the
    // issue's parallel tracks a comment would join — under the localized
    // default name, not the raw stored title.
    expect(await screen.findByPlaceholderText("Comment in Main…")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Review/ }));
    expect(await screen.findByPlaceholderText("Comment in Review…")).toBeInTheDocument();
    await waitFor(() => {
      expect(onIssueSessionChange).toHaveBeenLastCalledWith("session-review");
    });
    expect(mockNavigationReplace).not.toHaveBeenCalled();
  });

  it("creates a second session from the rail header and switches to it", async () => {
    const sessionMain = {
      id: "session-main",
      issue_id: mockIssue.id,
      workspace_id: "ws-1",
      title: "Main",
      status: "active",
      is_default: true,
      summary: null,
      created_by_type: "system",
      created_by_id: null,
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
      participants: [],
    };
    const sessionReview = {
      ...sessionMain,
      id: "session-review",
      title: "Review",
      is_default: false,
      created_by_type: "member",
      created_by_id: "user-1",
      created_at: "2025-01-02T00:00:00Z",
      updated_at: "2025-01-02T00:00:00Z",
    };
    mockApiObj.listIssueSessions.mockResolvedValue([sessionMain]);
    // The mutation invalidates the sessions query on settle, so the refetch
    // must see the new session — that refetch is what mounts the column.
    mockApiObj.createIssueSession.mockImplementation(async () => {
      mockApiObj.listIssueSessions.mockResolvedValue([sessionMain, sessionReview]);
      return sessionReview;
    });
    renderIssueDetail();

    fireEvent.click(await screen.findByRole("button", { name: "New session" }));

    const createDialog = within(await screen.findByRole("dialog"));
    expect(createDialog.getByText("Create session")).toBeInTheDocument();
    fireEvent.change(createDialog.getByLabelText("Session name"), {
      target: { value: "Review" },
    });
    fireEvent.click(createDialog.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(mockApiObj.createIssueSession).toHaveBeenCalledWith("issue-1", "Review");
    });
    // Sessions refetched → the rail gains a second row and the new session
    // is the one being read.
    expect(await screen.findByRole("button", { name: /^Review/ })).toBeInTheDocument();
    await waitFor(() => {
      expect(mockApiObj.listTimeline).toHaveBeenCalledWith("issue-1", "session-review");
    });
  });

  it("renders one rail row per session, one New-session control, and the panel actions", async () => {
    mockApiObj.listIssueSessions.mockResolvedValue([
      {
        id: "session-main",
        issue_id: mockIssue.id,
        workspace_id: "ws-1",
        title: "Main",
        status: "active",
        is_default: true,
        summary: null,
        created_by_type: "system",
        created_by_id: null,
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z",
        participants: [],
      },
      {
        id: "session-review",
        issue_id: mockIssue.id,
        workspace_id: "ws-1",
        title: "Review",
        status: "active",
        is_default: false,
        summary: null,
        created_by_type: "member",
        created_by_id: "user-1",
        created_at: "2025-01-02T00:00:00Z",
        updated_at: "2025-01-02T00:00:00Z",
        participants: [],
      },
    ]);
    renderIssueDetail();

    expect(await screen.findByText("Sessions")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Main/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Review/ })).toBeInTheDocument();
    // The + affordance lives in the rail header — and only there, so the
    // panel must not mount a second copy.
    expect(screen.getAllByRole("button", { name: "New session" })).toHaveLength(1);
    // The panel carries publish / delegate for whichever session is open;
    // every *other* session is reached through its row's ⋯ menu.
    expect(screen.getAllByRole("button", { name: "Publish result" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Delegate task" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Session actions" })).toHaveLength(2);
  });

  it("mounts the session column at the panel's far left, outside the scrolling content", async () => {
    mockApiObj.listIssueSessions.mockResolvedValue([
      {
        id: "session-main",
        issue_id: mockIssue.id,
        workspace_id: "ws-1",
        title: "Main",
        status: "active",
        is_default: true,
        summary: null,
        created_by_type: "system",
        created_by_id: null,
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z",
        participants: [],
      },
      {
        id: "session-review",
        issue_id: mockIssue.id,
        workspace_id: "ws-1",
        title: "Review",
        status: "active",
        is_default: false,
        summary: null,
        created_by_type: "member",
        created_by_id: "user-1",
        created_at: "2025-01-02T00:00:00Z",
        updated_at: "2025-01-02T00:00:00Z",
        participants: [],
      },
    ]);
    renderIssueDetail();

    const sessionsLabel = await screen.findByText("Sessions");
    const scrollRoot = document.querySelector<HTMLElement>("[data-tab-scroll-root]");
    expect(scrollRoot).not.toBeNull();
    // Rendering the column inside the scroll container (its previous home,
    // mid-page in the activity section) both squeezed the centered reading
    // column and left the panel's left gutter empty. It must be a sibling…
    expect(scrollRoot!.contains(sessionsLabel)).toBe(false);
    // …placed immediately before the content, i.e. on the panel's far left.
    expect(scrollRoot!.previousElementSibling).toContainElement(sessionsLabel);
    // The timeline itself stays inside the scroll container.
    expect(scrollRoot!.contains(screen.getAllByText("Activity")[0]!)).toBe(true);
  });

  it("opens participant management from a session row's actions menu", async () => {
    mockApiObj.listIssueSessions.mockResolvedValue([
      {
        id: "session-main",
        issue_id: mockIssue.id,
        workspace_id: "ws-1",
        title: "Main",
        status: "active",
        is_default: true,
        summary: null,
        created_by_type: "system",
        created_by_id: null,
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z",
        participants: [],
      },
      {
        id: "session-review",
        issue_id: mockIssue.id,
        workspace_id: "ws-1",
        title: "Review",
        status: "active",
        is_default: false,
        summary: null,
        created_by_type: "member",
        created_by_id: "user-1",
        created_at: "2025-01-02T00:00:00Z",
        updated_at: "2025-01-02T00:00:00Z",
        participants: [],
      },
    ]);
    renderIssueDetail();

    const rowMenus = await screen.findAllByRole("button", { name: "Session actions" });
    fireEvent.click(rowMenus[0]!);

    fireEvent.click(await screen.findByRole("menuitem", { name: "Session participants" }));

    // "Add agent" only exists inside the participants dialog.
    expect(await screen.findByText("Add agent")).toBeInTheDocument();
    // The workspace fixture has no agents at all — the empty state has to name
    // that cause rather than the "already participating" one.
    expect(
      screen.getByText("This workspace has no agents yet. Create one before delegating work."),
    ).toBeInTheDocument();
  });

  it("keeps session agent runs out of the timeline", async () => {
    // Runs belong to the right panel's execution log; the timeline used to
    // repeat them as task cards.
    mockApiObj.listSessionTasks.mockResolvedValue([{
      id: "task-1",
      issue_id: mockIssue.id,
      issue_session_id: "session-main",
      agent_id: "agent-1",
      status: "running",
      prompt: "Investigate the flaky test",
      trigger_summary: null,
      created_at: "2025-01-03T00:00:00Z",
    }]);
    renderIssueDetail();

    await screen.findByDisplayValue("Implement authentication");
    expect(screen.queryByText("Investigate the flaky test")).not.toBeInTheDocument();
    expect(mockApiObj.listSessionTasks).not.toHaveBeenCalled();
  });

  it("opens the Session that owns an inbox deep-linked comment", async () => {
    mockApiObj.listIssueSessions.mockResolvedValue([
      {
        id: "session-main",
        issue_id: mockIssue.id,
        workspace_id: "ws-1",
        title: "Main",
        status: "active",
        is_default: true,
        summary: null,
        created_by_type: "system",
        created_by_id: null,
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z",
        participants: [],
      },
      {
        id: "session-review",
        issue_id: mockIssue.id,
        workspace_id: "ws-1",
        title: "Review",
        status: "active",
        is_default: false,
        summary: null,
        created_by_type: "member",
        created_by_id: "user-1",
        created_at: "2025-01-02T00:00:00Z",
        updated_at: "2025-01-02T00:00:00Z",
        participants: [],
      },
    ]);

    renderIssueDetail("issue-1", "session-review");

    await waitFor(() => {
      expect(mockApiObj.listTimeline).toHaveBeenCalledWith("issue-1", "session-review");
    });
  });

  it("shows and explicitly publishes reusable Session results", async () => {
    mockApiObj.listIssueSessionResults.mockResolvedValue([{
      id: "result-1",
      issue_id: mockIssue.id,
      source_session_id: "session-main",
      title: "Architecture decision",
      body: "Use an append-only canonical event log.",
      metadata: {},
      published_by_type: "member",
      published_by_id: "user-1",
      created_at: "2025-01-03T00:00:00Z",
    }]);
    mockApiObj.publishSessionResult.mockResolvedValue({
      id: "result-2",
      issue_id: mockIssue.id,
      source_session_id: "session-main",
      title: "API contract",
      body: "Sibling sessions consume explicit results only.",
      metadata: {},
      published_by_type: "member",
      published_by_id: "user-1",
      created_at: "2025-01-04T00:00:00Z",
    });
    renderIssueDetail();

    // The result itself lives in the right panel's key-results section; the
    // timeline only carries a one-line pointer at it.
    expect(await screen.findByText("Architecture decision")).toBeInTheDocument();
    expect(
      screen.getByText('published the result "Architecture decision"'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Use an append-only canonical event log."),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Publish result" }));
    // Scoped to the dialog: the panel card's generic kind icon is also
    // labelled "Result".
    const publishDialog = within(await screen.findByRole("dialog"));
    fireEvent.change(publishDialog.getByLabelText("Title (optional)"), {
      target: { value: "API contract" },
    });
    fireEvent.change(publishDialog.getByLabelText("Result"), {
      target: { value: "Sibling sessions consume explicit results only." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));

    await waitFor(() => {
      expect(mockApiObj.publishSessionResult).toHaveBeenCalledWith(
        "issue-1",
        "session-main",
        "API contract",
        "Sibling sessions consume explicit results only.",
      );
    });
  });

  it("points the timeline's published-result line at the key-results panel section", async () => {
    mockApiObj.listIssueSessionResults.mockResolvedValue([{
      id: "result-1",
      issue_id: mockIssue.id,
      source_session_id: "session-main",
      title: "Architecture decision",
      body: "Use an append-only canonical event log.",
      metadata: { kind: "decision" },
      published_by_type: "member",
      published_by_id: "user-1",
      created_at: "2025-01-03T00:00:00Z",
    }]);
    renderIssueDetail();

    // Panel section carries the typed card...
    expect(await screen.findByText("Key results")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Decision" })).toBeInTheDocument();

    // ...and the timeline line scrolls to it.
    fireEvent.click(screen.getByText('published the result "Architecture decision"'));
    expect(scrollIntoViewSpy).toHaveBeenCalledTimes(1);
    expect((scrollIntoViewSpy.mock.contexts[0] as HTMLElement).id).toBe("issue-key-results");
  });

  it("gives sub-issue selection localized, design-system checkboxes", async () => {
    const child: Issue = {
      ...mockIssue,
      id: "issue-2",
      number: 2,
      identifier: "TES-2",
      title: "Add refresh tokens",
      parent_issue_id: "issue-1",
      status: "todo",
    };
    mockApiObj.listChildIssues.mockResolvedValue({ issues: [child] });
    useIssueSelectionStore.getState().clear();
    renderIssueDetail();

    // aria-labels route through t(), so a zh/ja/ko user doesn't get English
    // accessible names, and both controls are the shadcn Checkbox.
    const rowBox = await screen.findByRole("checkbox", { name: "Select TES-2" });
    expect(screen.getByLabelText("Select all sub-issues")).toBeInTheDocument();
    expect(rowBox).toHaveAttribute("data-slot", "checkbox");
    expect(rowBox).toHaveAttribute("aria-checked", "false");

    fireEvent.click(rowBox);
    await waitFor(() => {
      expect(
        screen.getByRole("checkbox", { name: "Select TES-2" }),
      ).toHaveAttribute("aria-checked", "true");
    });
    useIssueSelectionStore.getState().clear();
  });

  it("keeps the activity skeleton up while the session list is still resolving", async () => {
    // The timeline query is disabled until a session id exists, and a disabled
    // TanStack query reports isLoading === false — without explicit gating the
    // activity area renders as a blank gap instead of a skeleton.
    mockApiObj.listIssueSessions.mockReturnValue(new Promise(() => {}));
    renderIssueDetail();

    await screen.findByText("Activity");
    expect(mockApiObj.listTimeline).not.toHaveBeenCalled();
    expect(
      screen.getAllByRole("generic").some((el) => el.getAttribute("data-slot") === "skeleton"),
    ).toBe(true);
    expect(
      screen.queryByText("Couldn't load this issue's sessions"),
    ).not.toBeInTheDocument();
  });

  it("offers a retry instead of a permanently blank activity area when sessions fail", async () => {
    mockApiObj.listIssueSessions.mockRejectedValue(new Error("boom"));
    renderIssueDetail();

    expect(
      await screen.findByText("Couldn't load this issue's sessions"),
    ).toBeInTheDocument();

    const callsBeforeRetry = mockApiObj.listIssueSessions.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => {
      expect(mockApiObj.listIssueSessions.mock.calls.length).toBeGreaterThan(callsBeforeRetry);
    });
  });

  it("treats an empty session list as unavailable rather than as an empty timeline", async () => {
    // No session id means no timeline query can ever run; silently rendering
    // an empty activity list would claim the issue has no history.
    mockApiObj.listIssueSessions.mockResolvedValue([]);
    renderIssueDetail();

    expect(
      await screen.findByText("Couldn't load this issue's sessions"),
    ).toBeInTheDocument();
    expect(mockApiObj.listTimeline).not.toHaveBeenCalled();
  });

  it("renders the issue title leaf as a link to the issue detail page", async () => {
    renderIssueDetail();

    // The breadcrumb leaf is the whole "identifier + title" string wrapped in a
    // single link to the issue's own detail route (used to open the full page
    // from the inline Inbox pane). A bare issue has no ancestor crumbs.
    const leaf = await screen.findByText("TES-1 Implement authentication");
    expect(leaf.closest("a")).toHaveAttribute("href", "/test/issues/issue-1");
  });

  it("omits the project breadcrumb segment when the issue has no project_id", async () => {
    // Default fixture has project_id: null.
    renderIssueDetail();

    // Leaf renders once loaded; a bare issue has no ancestor crumbs at all.
    await screen.findByText("TES-1 Implement authentication");

    // Project is never fetched and no project crumb appears.
    expect(mockApiObj.getProject).not.toHaveBeenCalled();
    expect(screen.queryByText("Marketing site refresh")).not.toBeInTheDocument();
  });

  it("renders the project breadcrumb segment when the issue belongs to a project", async () => {
    mockApiObj.getIssue.mockResolvedValue({ ...mockIssue, project_id: "p-1" });
    mockApiObj.getProject.mockResolvedValue({
      id: "p-1",
      workspace_id: "ws-1",
      title: "Marketing site refresh",
      description: null,
      icon: "🚀",
      status: "in_progress",
      priority: "none",
      lead_type: null,
      lead_id: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      issue_count: 0,
      done_count: 0,
      resource_count: 0,
    });

    renderIssueDetail();

    const projectLink = await screen.findByText("Marketing site refresh");
    // The whole project segment is a single AppLink pointing at the project
    // detail route under the active workspace slug.
    expect(projectLink.closest("a")).toHaveAttribute("href", "/test/projects/p-1");
  });

  it("renders properties sidebar with all core rows plus set optional rows", async () => {
    renderIssueDetail();

    await waitFor(() => {
      expect(screen.getByText("Properties")).toBeInTheDocument();
    });

    // Core rows — always rendered regardless of whether the issue has a value.
    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("Assignee")).toBeInTheDocument();
    // "Project" appears twice (row label + picker stub), so disambiguate by id.
    expect(screen.getByTestId("project-picker")).toBeInTheDocument();
    // priority="high" + due_date are set in the fixture, so both optional rows show.
    expect(screen.getByText("Priority")).toBeInTheDocument();
    expect(screen.getByText("Due date")).toBeInTheDocument();
    // No labels are attached in the fixture — the Labels optional row
    // must stay hidden by default.
    expect(screen.queryByText("Labels")).not.toBeInTheDocument();
    // Parent issue lives in its own section and only renders when the
    // issue actually has a parent — the fixture has none.
    expect(screen.queryByText("Parent issue")).not.toBeInTheDocument();
    // The "+ Add property" affordance is always offered while any
    // optional field is still hidden.
    expect(screen.getByText("Add property")).toBeInTheDocument();
  });

  it("hides every optional property row when none are set", async () => {
    // Override the default fixture: nothing optional set.
    mockApiObj.getIssue.mockResolvedValue({
      ...mockIssue,
      priority: "none",
      start_date: null,
      due_date: null,
    });

    renderIssueDetail();

    await waitFor(() => {
      expect(screen.getByText("Properties")).toBeInTheDocument();
    });

    expect(screen.queryByText("Priority")).not.toBeInTheDocument();
    expect(screen.queryByText("Due date")).not.toBeInTheDocument();
    expect(screen.queryByText("Labels")).not.toBeInTheDocument();
    // Project stays as a core row regardless of value.
    expect(screen.getByTestId("project-picker")).toBeInTheDocument();
    // No parent → no standalone Parent issue section either.
    expect(screen.queryByText("Parent issue")).not.toBeInTheDocument();
    expect(screen.getByText("Add property")).toBeInTheDocument();
  });

  it("uses a non-resizable layout with the sidebar sheet closed by default on mobile", async () => {
    mockViewport.isMobile = true;

    renderIssueDetail();

    await waitFor(() => {
      expect(screen.getByDisplayValue("Implement authentication")).toBeInTheDocument();
    });

    expect(screen.queryByTestId("panel-group")).not.toBeInTheDocument();
    expect(screen.queryByText("Properties")).not.toBeInTheDocument();
    const sessionsToggle = screen.getByRole("button", { name: "Toggle sessions" });
    expect(sessionsToggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText("Sessions")).not.toBeInTheDocument();

    fireEvent.click(sessionsToggle);
    expect(await screen.findByText("Sessions")).toBeInTheDocument();
    expect(sessionsToggle).toHaveAttribute("aria-pressed", "true");
  });

  it("hides metadata content from the sidebar and shows a button when the bag has keys", async () => {
    // Metadata is agent-facing; the sidebar only exposes a button that opens
    // the raw JSON on demand. Keys are NOT rendered inline anywhere.
    mockApiObj.getIssue.mockResolvedValue({
      ...mockIssue,
      metadata: {
        pr_url: "https://example.com/pr/1",
        pipeline_status: "running",
      },
    });

    renderIssueDetail();

    await waitFor(() => {
      // Trigger label includes a "· N" count so users can see payload size
      // before clicking — accept any count via regex.
      expect(screen.getByRole("button", { name: /^Metadata\b/ })).toBeInTheDocument();
    });

    // Key names are not rendered in the sidebar prior to opening the dialog.
    expect(screen.queryByText("pr_url")).not.toBeInTheDocument();
    expect(screen.queryByText("pipeline_status")).not.toBeInTheDocument();
  });

  it("opens a dialog with formatted JSON when the Metadata button is clicked", async () => {
    mockApiObj.getIssue.mockResolvedValue({
      ...mockIssue,
      metadata: {
        pr_url: "https://example.com/pr/1",
        pipeline_status: "running",
      },
    });

    renderIssueDetail();

    const button = await screen.findByRole("button", { name: /^Metadata\b/ });
    fireEvent.click(button);

    // The dialog renders a <pre> containing the formatted JSON; checking the
    // exact serialized payload also verifies the indent / structure.
    const expected = JSON.stringify(
      { pr_url: "https://example.com/pr/1", pipeline_status: "running" },
      null,
      2,
    );
    await waitFor(() => {
      const pre = document.querySelector("pre");
      expect(pre).not.toBeNull();
      expect(pre!.textContent).toBe(expected);
    });
  });

  it("hides the Metadata button entirely when the bag is empty", async () => {
    // Default fixture already has metadata: {}, asserted explicitly here.
    renderIssueDetail();

    await waitFor(() => {
      expect(screen.getByText("Details")).toBeInTheDocument();
    });

    expect(screen.queryByRole("button", { name: /^Metadata\b/ })).not.toBeInTheDocument();
  });

  it("renders Details section with Created by and dates", async () => {
    renderIssueDetail();

    await waitFor(() => {
      expect(screen.getByText("Details")).toBeInTheDocument();
    });

    expect(screen.getByText("Created by")).toBeInTheDocument();
    expect(screen.getByText("Created")).toBeInTheDocument();
    expect(screen.getByText("Updated")).toBeInTheDocument();
  });

  it("shows 'not found' message when issue does not exist", async () => {
    mockApiObj.getIssue.mockRejectedValue(new Error("Not found"));

    renderIssueDetail("nonexistent-id");

    await waitFor(() => {
      expect(
        screen.getByText("This issue does not exist or has been deleted in this workspace."),
      ).toBeInTheDocument();
    });
  });

  it("shows 'Back to Issues' button when issue is not found and no onDelete prop", async () => {
    mockApiObj.getIssue.mockRejectedValue(new Error("Not found"));

    renderIssueDetail("nonexistent-id");

    await waitFor(() => {
      expect(screen.getByText("Back to Issues")).toBeInTheDocument();
    });
  });

  it("renders Activity section header", async () => {
    renderIssueDetail();

    await waitFor(() => {
      expect(screen.getAllByText("Activity").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("renders comments from timeline", async () => {
    renderIssueDetail();

    await waitFor(() => {
      expect(screen.getByText("Started working on this")).toBeInTheDocument();
    });

    expect(screen.getByText("I can help with this")).toBeInTheDocument();
  });

  describe("flat session stream", () => {
    // comment-1 and comment-2 are roots; reply-1 answers comment-1 but was
    // written last. The old grouping hoisted it inside comment-1's card, so it
    // appeared *before* comment-2 — a second layer of parallelism inside a
    // session that is already one parallel track.
    const threadedTimeline: TimelineEntry[] = [
      {
        type: "comment", id: "comment-1", actor_type: "member", actor_id: "user-1",
        content: "Started working on this", parent_id: null,
        created_at: "2026-01-16T00:00:00Z", updated_at: "2026-01-16T00:00:00Z",
        comment_type: "comment",
      },
      {
        type: "comment", id: "comment-2", actor_type: "agent", actor_id: "agent-1",
        content: "I can help with this", parent_id: null,
        created_at: "2026-01-17T00:00:00Z", updated_at: "2026-01-17T00:00:00Z",
        comment_type: "comment",
      },
      {
        type: "comment", id: "reply-1", actor_type: "member", actor_id: "user-1",
        content: "Answering the first one", parent_id: "comment-1",
        created_at: "2026-01-18T00:00:00Z", updated_at: "2026-01-18T00:00:00Z",
        comment_type: "comment",
      },
    ] as TimelineEntry[];

    it("renders every comment as its own entry in created_at order", async () => {
      mockApiObj.listTimeline.mockResolvedValue(threadedTimeline);
      renderIssueDetail();

      await screen.findByText("Answering the first one");

      const ids = Array.from(document.querySelectorAll("[id^='comment-']")).map(
        (el) => el.id,
      );
      expect(ids).toEqual(["comment-comment-1", "comment-comment-2", "comment-reply-1"]);
      // Flat means flat: the reply is a sibling of its parent, not a child.
      expect(
        document.getElementById("comment-comment-1")!.contains(
          document.getElementById("comment-reply-1"),
        ),
      ).toBe(false);
      // No thread box, so no reply tally either.
      expect(screen.queryByText(/\d+ repl(y|ies)/)).not.toBeInTheDocument();
      // A session with entries is not an empty session.
      expect(screen.queryByText("Nothing in this session yet")).not.toBeInTheDocument();
    });

    it("renders messages as rows, with one composer for the whole session", async () => {
      mockApiObj.listTimeline.mockResolvedValue(threadedTimeline);
      renderIssueDetail();

      await screen.findByText("Answering the first one");

      // One editor for the description, one for the composer — and nothing
      // per message. A per-message input is what made the stream a stack of
      // little forms instead of a chat log.
      expect(screen.getByPlaceholderText("Comment in Main…")).toBeInTheDocument();
      expect(screen.queryByPlaceholderText("Leave a reply...")).not.toBeInTheDocument();
      expect(screen.getAllByTestId("rich-text-editor")).toHaveLength(2);

      // Each row keeps its own toolbar: react / reply / ⋯.
      expect(screen.getAllByRole("button", { name: "Reply" })).toHaveLength(3);
      expect(screen.getAllByRole("button", { name: "More actions" })).toHaveLength(3);
    });

    it("reveals the row toolbar on focus, not on hover alone", async () => {
      mockApiObj.listTimeline.mockResolvedValue(threadedTimeline);
      renderIssueDetail();

      await screen.findByText("Started working on this");

      // jsdom can't evaluate :hover, so the class list is the contract: a
      // keyboard user has to be able to reach these controls, which means
      // focus-within must reveal the toolbar alongside group-hover.
      const toolbar = screen.getAllByRole("button", { name: "Reply" })[0]!
        .parentElement!;
      expect(toolbar.className).toContain("group-hover/msg:opacity-100");
      expect(toolbar.className).toContain("focus-within:opacity-100");
      // Touch devices never fire hover at all.
      expect(toolbar.className).toContain("[@media(hover:none)]:opacity-100");
    });

    it("marks a reply with a reference chip that scrolls to its parent", async () => {
      mockApiObj.listTimeline.mockResolvedValue(threadedTimeline);
      renderIssueDetail();

      // Only the reply carries a chip; the two roots answer nobody.
      const chip = await screen.findByRole("button", {
        name: "Replying to Test User: Started working on this",
      });
      expect(screen.getAllByRole("button", { name: /^Replying to/ })).toHaveLength(1);

      fireEvent.click(chip);
      expect(scrollIntoViewSpy).toHaveBeenCalled();
      expect((scrollIntoViewSpy.mock.contexts[0] as HTMLElement).id).toBe(
        "comment-comment-1",
      );
    });

    it("strips markdown out of the quoted preview", async () => {
      // A raw slice would spend the 40-char budget on a mention URL and show
      // markdown punctuation the reader has to decode.
      mockApiObj.listTimeline.mockResolvedValue([
        {
          type: "comment", id: "comment-1", actor_type: "member", actor_id: "user-1",
          content:
            "**Ping** [@Claude Agent](mention://agent/agent-1), see [the plan](https://example.com/plan)",
          parent_id: null,
          created_at: "2026-01-16T00:00:00Z", updated_at: "2026-01-16T00:00:00Z",
          comment_type: "comment",
        },
        {
          type: "comment", id: "reply-1", actor_type: "agent", actor_id: "agent-1",
          content: "On it", parent_id: "comment-1",
          created_at: "2026-01-17T00:00:00Z", updated_at: "2026-01-17T00:00:00Z",
          comment_type: "comment",
        },
      ] as TimelineEntry[]);
      renderIssueDetail();

      expect(
        await screen.findByRole("button", {
          name: "Replying to Test User: Ping @Claude Agent, see the plan",
        }),
      ).toBeInTheDocument();
    });

    it("posts a reply through the single composer once a row sets the target", async () => {
      mockApiObj.listTimeline.mockResolvedValue(threadedTimeline);
      mockApiObj.createComment.mockResolvedValue({
        id: "reply-2",
        issue_id: "issue-1",
        issue_session_id: "session-main",
        author_type: "member",
        author_id: "user-1",
        content: "On it",
        parent_id: "comment-1",
        type: "comment",
        reactions: [],
        attachments: [],
        created_at: "2026-01-19T00:00:00Z",
        updated_at: "2026-01-19T00:00:00Z",
      });
      renderIssueDetail();

      await screen.findByText("Started working on this");
      const editor = await screen.findByPlaceholderText("Comment in Main…");
      // reply-1 already quotes comment-1 in the stream, so the chip has to be
      // read inside the composer to tell the two apart.
      const composer = within(editor.parentElement!.parentElement!);

      // First row in the stream is comment-1 — its toolbar aims the composer.
      fireEvent.click(screen.getAllByRole("button", { name: "Reply" })[0]!);

      // The composer says who it is answering…
      await waitFor(() => {
        expect(
          composer.getByText("Replying to Test User: Started working on this"),
        ).toBeInTheDocument();
      });
      fireEvent.change(editor, { target: { value: "On it" } });
      // …and sends with parent_id, from the one send control in the shell.
      const buttons = editor.parentElement!.parentElement!.querySelectorAll("button");
      fireEvent.click(buttons[buttons.length - 1]!);

      await waitFor(() => {
        expect(mockApiObj.createComment).toHaveBeenCalledWith(
          "issue-1",
          "On it",
          "comment",
          "comment-1",
          undefined,
          "session-main",
        );
      });
      // Sending consumes the context — the next message is a new one.
      await waitFor(() => {
        expect(
          composer.queryByText("Replying to Test User: Started working on this"),
        ).toBeNull();
      });
    });

    it("drops the reply target when × clears the chip", async () => {
      mockApiObj.listTimeline.mockResolvedValue(threadedTimeline);
      renderIssueDetail();

      await screen.findByText("Started working on this");
      const editor = await screen.findByPlaceholderText("Comment in Main…");
      const composer = within(editor.parentElement!.parentElement!);
      fireEvent.click(screen.getAllByRole("button", { name: "Reply" })[0]!);

      await waitFor(() => {
        expect(
          composer.getByText("Replying to Test User: Started working on this"),
        ).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole("button", { name: "Cancel reply" }));

      await waitFor(() => {
        expect(
          composer.queryByText("Replying to Test User: Started working on this"),
        ).toBeNull();
      });
    });

    it("offers a way forward instead of a blank column on an untouched session", async () => {
      mockApiObj.listTimeline.mockResolvedValue([]);
      mockApiObj.listIssueSessionResults.mockResolvedValue([]);
      renderIssueDetail();

      expect(
        await screen.findByText("Nothing in this session yet"),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          "Leave a comment, or delegate a task from the right panel to get started.",
        ),
      ).toBeInTheDocument();
    });
  });

  it("collapses non-trailing activity blocks and expands the last one by default", async () => {
    // Timeline shape:
    //   [activities: status_changed, priority_changed] ← block A (older)
    //   [comment-1]
    //   [activities: due_date_changed]                  ← block B (latest)
    // Block A should be collapsed; block B should be expanded.
    mockApiObj.listTimeline.mockResolvedValue([
      {
        type: "activity",
        id: "act-1",
        actor_type: "member",
        actor_id: "user-1",
        action: "status_changed",
        details: { from: "todo", to: "in_progress" },
        created_at: "2026-01-16T00:00:00Z",
      },
      {
        type: "activity",
        id: "act-2",
        actor_type: "member",
        actor_id: "user-1",
        action: "priority_changed",
        details: { from: "low", to: "high" },
        created_at: "2026-01-16T01:00:00Z",
      },
      {
        type: "comment",
        id: "comment-1",
        actor_type: "member",
        actor_id: "user-1",
        content: "Talking it through",
        parent_id: null,
        created_at: "2026-01-17T00:00:00Z",
        updated_at: "2026-01-17T00:00:00Z",
        comment_type: "comment",
      },
      {
        type: "activity",
        id: "act-3",
        actor_type: "member",
        actor_id: "user-1",
        action: "due_date_changed",
        details: { to: "2026-02-01T00:00:00Z" },
        created_at: "2026-01-18T00:00:00Z",
      },
    ] as TimelineEntry[]);

    renderIssueDetail();

    // Latest block (single activity) is expanded — its rendered text is visible.
    await waitFor(() => {
      expect(screen.getByText(/set due date to/i)).toBeInTheDocument();
    });

    // Older block is collapsed: shows the summary, hides the individual entries.
    expect(screen.getByText("2 activities")).toBeInTheDocument();
    expect(screen.queryByText(/changed status/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/changed priority/i)).not.toBeInTheDocument();

    // Clicking the summary expands the older block.
    fireEvent.click(screen.getByText("2 activities"));
    await waitFor(() => {
      expect(screen.getByText(/changed status/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/changed priority/i)).toBeInTheDocument();
  });

  it("truncates the trailing activity block to the most recent 8 entries with a show-more toggle", async () => {
    // 10 activities, all in the trailing block (no comment after them, so it's
    // the trailing block by definition). Alternating action types so the
    // 2-minute coalesce window never merges consecutive entries — we end up
    // with 10 distinct rows.
    const trailingBlock: TimelineEntry[] = [
      { type: "activity", id: "act-1", actor_type: "member", actor_id: "user-1", action: "status_changed", details: { from: "todo", to: "in_progress" }, created_at: "2026-01-18T00:00:00Z" },
      { type: "activity", id: "act-2", actor_type: "member", actor_id: "user-1", action: "priority_changed", details: { from: "low", to: "medium" }, created_at: "2026-01-18T00:01:00Z" },
      { type: "activity", id: "act-3", actor_type: "member", actor_id: "user-1", action: "status_changed", details: { from: "in_progress", to: "in_review" }, created_at: "2026-01-18T00:02:00Z" },
      { type: "activity", id: "act-4", actor_type: "member", actor_id: "user-1", action: "priority_changed", details: { from: "medium", to: "high" }, created_at: "2026-01-18T00:03:00Z" },
      { type: "activity", id: "act-5", actor_type: "member", actor_id: "user-1", action: "status_changed", details: { from: "in_review", to: "done" }, created_at: "2026-01-18T00:04:00Z" },
      { type: "activity", id: "act-6", actor_type: "member", actor_id: "user-1", action: "priority_changed", details: { from: "high", to: "urgent" }, created_at: "2026-01-18T00:05:00Z" },
      { type: "activity", id: "act-7", actor_type: "member", actor_id: "user-1", action: "status_changed", details: { from: "done", to: "blocked" }, created_at: "2026-01-18T00:06:00Z" },
      { type: "activity", id: "act-8", actor_type: "member", actor_id: "user-1", action: "priority_changed", details: { from: "urgent", to: "low" }, created_at: "2026-01-18T00:07:00Z" },
      { type: "activity", id: "act-9", actor_type: "member", actor_id: "user-1", action: "status_changed", details: { from: "blocked", to: "todo" }, created_at: "2026-01-18T00:08:00Z" },
      { type: "activity", id: "act-10", actor_type: "member", actor_id: "user-1", action: "due_date_changed", details: { to: "2026-02-01T00:00:00Z" }, created_at: "2026-01-18T00:09:00Z" },
    ] as TimelineEntry[];
    mockApiObj.listTimeline.mockResolvedValue(trailingBlock);

    renderIssueDetail();

    // In the truncated default state the "N activities" collapse header
    // stays hidden — the "Show N more" link is the only control we want
    // to expose for a glance at recent activity.
    await waitFor(() => {
      expect(screen.getByText("Show 2 more activities")).toBeInTheDocument();
    });
    expect(screen.queryByText("10 activities")).not.toBeInTheDocument();

    // Only the 8 most recent entries (act-3..act-10) are rendered by default.
    // act-1 and act-2 are folded behind the show-more line.
    expect(screen.getByText(/from In Progress to In Review/i)).toBeInTheDocument(); // act-3
    expect(screen.getByText(/set due date to/i)).toBeInTheDocument(); // act-10
    expect(screen.queryByText(/from Todo to In Progress/i)).not.toBeInTheDocument(); // act-1
    expect(screen.queryByText(/from Low to Medium/i)).not.toBeInTheDocument(); // act-2

    // Clicking the toggle reveals the older entries in place and brings the
    // full "N activities" header back (so the user can fold the block).
    fireEvent.click(screen.getByText("Show 2 more activities"));
    await waitFor(() => {
      expect(screen.getByText(/from Todo to In Progress/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/from Low to Medium/i)).toBeInTheDocument();
    expect(screen.getByText(/set due date to/i)).toBeInTheDocument();
    expect(screen.getByText("10 activities")).toBeInTheDocument();
    expect(screen.queryByText(/Show \d+ more activit/i)).not.toBeInTheDocument();
  });

  it("does not show the show-more toggle when the trailing block has 8 or fewer entries", async () => {
    const trailingBlock: TimelineEntry[] = [
      { type: "activity", id: "act-1", actor_type: "member", actor_id: "user-1", action: "status_changed", details: { from: "todo", to: "in_progress" }, created_at: "2026-01-18T00:00:00Z" },
      { type: "activity", id: "act-2", actor_type: "member", actor_id: "user-1", action: "priority_changed", details: { from: "low", to: "high" }, created_at: "2026-01-18T00:01:00Z" },
      { type: "activity", id: "act-3", actor_type: "member", actor_id: "user-1", action: "status_changed", details: { from: "in_progress", to: "in_review" }, created_at: "2026-01-18T00:02:00Z" },
      { type: "activity", id: "act-4", actor_type: "member", actor_id: "user-1", action: "priority_changed", details: { from: "high", to: "urgent" }, created_at: "2026-01-18T00:03:00Z" },
      { type: "activity", id: "act-5", actor_type: "member", actor_id: "user-1", action: "status_changed", details: { from: "in_review", to: "done" }, created_at: "2026-01-18T00:04:00Z" },
      { type: "activity", id: "act-6", actor_type: "member", actor_id: "user-1", action: "priority_changed", details: { from: "urgent", to: "low" }, created_at: "2026-01-18T00:05:00Z" },
      { type: "activity", id: "act-7", actor_type: "member", actor_id: "user-1", action: "status_changed", details: { from: "done", to: "blocked" }, created_at: "2026-01-18T00:06:00Z" },
      { type: "activity", id: "act-8", actor_type: "member", actor_id: "user-1", action: "due_date_changed", details: { to: "2026-02-01T00:00:00Z" }, created_at: "2026-01-18T00:07:00Z" },
    ] as TimelineEntry[];
    mockApiObj.listTimeline.mockResolvedValue(trailingBlock);

    renderIssueDetail();

    await waitFor(() => {
      expect(screen.getByText("8 activities")).toBeInTheDocument();
    });
    // Every one of the 8 entries should be visible — the trailing block fits
    // exactly within the limit, so no "Show N more activities" line appears.
    expect(screen.getByText(/from Todo to In Progress/i)).toBeInTheDocument();
    expect(screen.getByText(/from Low to High/i)).toBeInTheDocument();
    expect(screen.getByText(/from In Progress to In Review/i)).toBeInTheDocument();
    expect(screen.getByText(/from High to Urgent/i)).toBeInTheDocument();
    expect(screen.getByText(/from In Review to Done/i)).toBeInTheDocument();
    expect(screen.getByText(/from Urgent to Low/i)).toBeInTheDocument();
    expect(screen.getByText(/from Done to Blocked/i)).toBeInTheDocument();
    expect(screen.getByText(/set due date to/i)).toBeInTheDocument();
    expect(screen.queryByText(/Show \d+ more activit/i)).not.toBeInTheDocument();
  });

  it("expanding a non-trailing block shows every entry — only the trailing block truncates older ones", async () => {
    // Non-trailing block (10 activities) + comment + trailing block (1 activity).
    // Manually expanding the older block must reveal all 10 entries — the
    // truncate-to-8 rule applies only to the trailing block.
    const timeline: TimelineEntry[] = [
      { type: "activity", id: "old-1", actor_type: "member", actor_id: "user-1", action: "status_changed", details: { from: "backlog", to: "todo" }, created_at: "2026-01-16T00:00:00Z" },
      { type: "activity", id: "old-2", actor_type: "member", actor_id: "user-1", action: "priority_changed", details: { from: "none", to: "low" }, created_at: "2026-01-16T00:01:00Z" },
      { type: "activity", id: "old-3", actor_type: "member", actor_id: "user-1", action: "status_changed", details: { from: "todo", to: "in_progress" }, created_at: "2026-01-16T00:02:00Z" },
      { type: "activity", id: "old-4", actor_type: "member", actor_id: "user-1", action: "priority_changed", details: { from: "low", to: "medium" }, created_at: "2026-01-16T00:03:00Z" },
      { type: "activity", id: "old-5", actor_type: "member", actor_id: "user-1", action: "status_changed", details: { from: "in_progress", to: "in_review" }, created_at: "2026-01-16T00:04:00Z" },
      { type: "activity", id: "old-6", actor_type: "member", actor_id: "user-1", action: "priority_changed", details: { from: "medium", to: "high" }, created_at: "2026-01-16T00:05:00Z" },
      { type: "activity", id: "old-7", actor_type: "member", actor_id: "user-1", action: "status_changed", details: { from: "in_review", to: "done" }, created_at: "2026-01-16T00:06:00Z" },
      { type: "activity", id: "old-8", actor_type: "member", actor_id: "user-1", action: "priority_changed", details: { from: "high", to: "urgent" }, created_at: "2026-01-16T00:07:00Z" },
      { type: "activity", id: "old-9", actor_type: "member", actor_id: "user-1", action: "status_changed", details: { from: "done", to: "blocked" }, created_at: "2026-01-16T00:08:00Z" },
      { type: "activity", id: "old-10", actor_type: "member", actor_id: "user-1", action: "priority_changed", details: { from: "urgent", to: "low" }, created_at: "2026-01-16T00:09:00Z" },
      {
        type: "comment", id: "comment-mid", actor_type: "member", actor_id: "user-1",
        content: "Splitting the blocks", parent_id: null,
        created_at: "2026-01-17T00:00:00Z", updated_at: "2026-01-17T00:00:00Z",
        comment_type: "comment",
      },
      { type: "activity", id: "last-1", actor_type: "member", actor_id: "user-1", action: "due_date_changed", details: { to: "2026-02-01T00:00:00Z" }, created_at: "2026-01-18T00:00:00Z" },
    ] as TimelineEntry[];
    mockApiObj.listTimeline.mockResolvedValue(timeline);

    renderIssueDetail();

    // The older block defaults to collapsed; its summary reports 10.
    await waitFor(() => {
      expect(screen.getByText("10 activities")).toBeInTheDocument();
    });
    // None of the older entries are rendered before expansion.
    expect(screen.queryByText(/from Backlog to Todo/i)).not.toBeInTheDocument();

    // Expand the older block by clicking its summary line.
    fireEvent.click(screen.getByText("10 activities"));

    // Every one of the 10 entries should now be visible — even though the
    // block has more than 8 entries, the truncate-to-8 rule does not apply
    // to non-trailing blocks, so no "Show N more activities" line appears.
    await waitFor(() => {
      expect(screen.getByText(/from Backlog to Todo/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/from No priority to Low/i)).toBeInTheDocument();
    expect(screen.getByText(/from Todo to In Progress/i)).toBeInTheDocument();
    expect(screen.getByText(/from Low to Medium/i)).toBeInTheDocument();
    expect(screen.getByText(/from In Progress to In Review/i)).toBeInTheDocument();
    expect(screen.getByText(/from Medium to High/i)).toBeInTheDocument();
    expect(screen.getByText(/from In Review to Done/i)).toBeInTheDocument();
    expect(screen.getByText(/from High to Urgent/i)).toBeInTheDocument();
    expect(screen.getByText(/from Done to Blocked/i)).toBeInTheDocument();
    expect(screen.getByText(/from Urgent to Low/i)).toBeInTheDocument();
    expect(screen.queryByText(/Show \d+ more activit/i)).not.toBeInTheDocument();
  });

  describe("highlightCommentId scroll-to-comment", () => {
    it("scrolls to the highlighted comment after both issue and timeline finish loading", async () => {
      renderIssueDetailWithHighlight("comment-2");

      // Wait for the comment row to mount. With initialItemCount in
      // production, items[0..targetIdx] are force-mounted on first commit;
      // the mock unconditionally inline-renders every item, so this just
      // waits for the regular render pass.
      await waitFor(() => {
        expect(
          document.getElementById("comment-comment-2"),
        ).not.toBeNull();
      });

      // The deep-link useLayoutEffect calls native scrollIntoView on the
      // target node ({block: 'center'}).
      await waitFor(() => {
        expect(scrollIntoViewSpy).toHaveBeenCalled();
      });
      expect(scrollIntoViewSpy).toHaveBeenCalledWith(
        expect.objectContaining({ block: "center" }),
      );
    });

    it("still scrolls when the timeline is ready before the issue (regression for inbox click)", async () => {
      // Reproduces the inbox-click race: timeline data is in the cache
      // before the issue resolves. While loading is true, IssueDetail
      // renders the loading skeleton (Virtuoso never mounts), so no
      // scroll can fire. After the issue resolves, Virtuoso mounts and
      // the useLayoutEffect dispatches the native scroll.
      let resolveIssue: (value: Issue) => void = () => {};
      const issuePromise = new Promise<Issue>((resolve) => {
        resolveIssue = resolve;
      });
      mockApiObj.getIssue.mockReturnValue(issuePromise);

      renderIssueDetailWithHighlight("comment-2", "issue-1", { seedTimeline: true });

      expect(
        document.getElementById("comment-comment-2"),
      ).toBeNull();
      expect(scrollIntoViewSpy).not.toHaveBeenCalled();

      resolveIssue(mockIssue);

      await waitFor(() => {
        expect(
          document.getElementById("comment-comment-2"),
        ).not.toBeNull();
      });
      await waitFor(() => {
        expect(scrollIntoViewSpy).toHaveBeenCalledWith(
          expect.objectContaining({ block: "center" }),
        );
      });
    });

    it("lands directly on a reply whose parent is folded away as resolved", async () => {
      // comment-3 is resolved, so it renders as a collapsed bar. Its reply,
      // reply-1, is the deep-link target — and in the flat stream it is an
      // entry of its own, so there is no thread to unfold first: the
      // id="comment-reply-1" node is in the DOM on the first commit.
      const timelineWithResolvedThread: TimelineEntry[] = [
        ...mockTimeline,
        {
          type: "comment",
          id: "comment-3",
          actor_type: "member",
          actor_id: "user-1",
          content: "Resolved root",
          parent_id: null,
          created_at: "2026-01-18T00:00:00Z",
          updated_at: "2026-01-18T00:00:00Z",
          comment_type: "comment",
          resolved_at: "2026-01-19T00:00:00Z",
        } as TimelineEntry,
        {
          type: "comment",
          id: "reply-1",
          actor_type: "member",
          actor_id: "user-1",
          content: "Reply inside resolved thread",
          parent_id: "comment-3",
          created_at: "2026-01-18T01:00:00Z",
          updated_at: "2026-01-18T01:00:00Z",
          comment_type: "comment",
        } as TimelineEntry,
      ];
      mockApiObj.listTimeline.mockResolvedValue(timelineWithResolvedThread);

      const queryClient = createTestQueryClient();
      render(
        <I18nProvider locale="en" resources={TEST_RESOURCES}>
          <QueryClientProvider client={queryClient}>
            <IssueDetail issueId="issue-1" highlightCommentId="reply-1" />
          </QueryClientProvider>
        </I18nProvider>,
      );

      await waitFor(() => {
        expect(
          document.getElementById("comment-reply-1"),
        ).not.toBeNull();
      });
      await waitFor(() => {
        expect(scrollIntoViewSpy).toHaveBeenCalledWith(
          expect.objectContaining({ block: "center" }),
        );
      });
      // The parent stayed folded — the reply is readable without it.
      expect(screen.getByText("Reply inside resolved thread")).toBeInTheDocument();
      expect(screen.queryByText("Resolved root")).not.toBeInTheDocument();
    });
  });

  it("sends empty description when editor is cleared", async () => {
    renderIssueDetail();

    await waitFor(() => {
      expect(screen.getByDisplayValue("Add JWT auth to the backend")).toBeInTheDocument();
    });

    const editor = screen.getByPlaceholderText("Add description...");
    fireEvent.change(editor, { target: { value: "" } });

    await waitFor(() => {
      expect(mockApiObj.updateIssue).toHaveBeenCalledWith(
        "issue-1",
        expect.objectContaining({ description: "" }),
      );
    });
  });
});
