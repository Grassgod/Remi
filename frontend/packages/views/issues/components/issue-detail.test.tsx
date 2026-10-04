import { forwardRef, useEffect, useRef, useState, useImperativeHandle } from "react";
import { renderToString } from "react-dom/server";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue, TimelineEntry } from "@multiremi/core/types";
import { MemorySessionReplica } from "@multiremi/core/replica";
import { useWSEvent } from "@multiremi/core/realtime";
import { SessionLogEntrySchema, type SessionLogRow } from "@multiremi/core/api/schemas/session-log";
import { ApiError } from "@multiremi/core/api";
import { activityPreferencesStore } from "@multiremi/core/issues/stores/activity-preferences-store";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enIssues from "../../locales/en/issues.json";
import zhCommon from "../../locales/zh-Hans/common.json";
import zhIssues from "../../locales/zh-Hans/issues.json";

const TEST_RESOURCES = { en: { common: enCommon, issues: enIssues }, "zh-Hans": { common: zhCommon, issues: zhIssues } };

const mockViewport = vi.hoisted(() => ({ isMobile: false }));
const mockNavigationReplace = vi.hoisted(() => vi.fn());
const mockToast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
const mockWorkspaceMembers = vi.hoisted(() => ({ query: vi.fn() }));
const timelinePageControl = vi.hoisted(() => ({
  hasMore: false,
  olderEntries: [] as TimelineEntry[],
}));
const issueLogOverride = vi.hoisted(() => ({ current: null as any }));
const mockWS = vi.hoisted(() => ({
  subscribe: vi.fn(() => () => {}),
  subscribeStream: vi.fn(() => ({ unsubscribe: vi.fn() })),
  onReconnect: vi.fn(() => () => {}),
}));

vi.mock("@multiremi/core/session-log/use-issue-log", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multiremi/core/session-log/use-issue-log")>();
  return { ...actual, useIssueLog: (...args: Parameters<typeof actual.useIssueLog>) =>
    issueLogOverride.current ?? actual.useIssueLog(...args) };
});

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
    queryFn: mockWorkspaceMembers.query,
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

vi.mock("../../runtimes/components/runtime-workspace-picker", () => ({
  WorkLocationPicker: () => <span data-testid="project-picker">Work location</span>,
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
  listTimeline: vi.fn().mockResolvedValue([]),
  getSessionLog: vi.fn(),
  locateSessionLogEntry: vi.fn(),
  listTimelinePage: vi.fn(async (
    issueId: string,
    params: { issueSessionId?: string; before?: string | null; limit?: number },
  ) => {
    let resolvedSessionId = params.issueSessionId;
    if (resolvedSessionId === "@default") {
      const sessions = await mockApiObj.listIssueSessions(issueId);
      resolvedSessionId = sessions.find((session: { is_default?: boolean }) => session.is_default)?.id
        ?? sessions[0]?.id;
    }
    const entries = params.before
      ? timelinePageControl.olderEntries
      : await mockApiObj.listTimeline(issueId, resolvedSessionId);
    return {
      entries,
      limit: params.limit ?? 40,
      has_more: !params.before && timelinePageControl.hasMore,
      has_more_before: !params.before && timelinePageControl.hasMore,
      has_more_after: false,
      next_cursor: !params.before && timelinePageControl.hasMore ? "older-cursor" : null,
      prev_cursor: null,
      issue_session_id: resolvedSessionId ?? null,
    };
  }),
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
  listIssueDependencies: vi.fn().mockResolvedValue([]),
  listIssueDecisions: vi.fn().mockResolvedValue({
    waiting_on_human: [],
    owner_and_answered: { pending: [], answered: [] },
    count: 0,
  }),
  listGeneratedIssues: vi.fn().mockResolvedValue({ issues: [] }),
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

vi.mock("@multiremi/core/api", async importOriginal => ({
  ApiError: (await importOriginal<typeof import("@multiremi/core/api")>()).ApiError,
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
vi.mock("@multiremi/core/issues/stores", async importOriginal => ({
  ...await importOriginal<typeof import("@multiremi/core/issues/stores")>(),
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
    props: {
      data: unknown[];
      itemContent: (i: number, item: unknown) => unknown;
      totalListHeightChanged?: (height: number) => void;
      rangeChanged?: (range: { startIndex: number; endIndex: number }) => void;
    },
    ref: any,
  ) {
    const { data, itemContent, totalListHeightChanged, rangeChanged } = props;
    virtuosoLatestProps.current = props as Record<string, unknown>;
    useImperativeHandle(ref, () => ({
      // scrollIntoView is unexercised here — the reveal hook positions the
      // deep-link target by setting scrollTop on the scroll root.
      scrollIntoView: vi.fn(),
      scrollToIndex: virtuosoScrollToIndexSpy,
    }));
    // The real component reports its measured height and rendered range once it
    // has laid out. jsdom gives every element a zero rect, so the real
    // `Virtuoso` never gets that far and the reveal's layout gate would never
    // open — this stands in for the measurement the browser actually performs.
    useEffect(() => {
      totalListHeightChanged?.(data.length * 40);
      rangeChanged?.({ startIndex: 0, endIndex: Math.max(0, data.length - 1) });
    });
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
  useWS: () => mockWS,
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
import { IssueActivitySection } from "./issue-activity-section";

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
  locale: "en" | "zh-Hans" = "en",
) {
  const queryClient = createTestQueryClient();
  return render(
    <I18nProvider locale={locale} resources={TEST_RESOURCES}>
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

/**
 * Waits for the reveal hook to publish a terminal state on the scroll root.
 *
 * MUL-390 hides the whole detail document until its gates hold, so anything
 * queried by role — or asserted to be visible — has to wait for this first.
 * `visibility: hidden` is exactly what the recorder reads, so the tests reuse
 * the same signal rather than a timer.
 */
async function waitForReveal() {
  await waitFor(() => {
    const state = document
      .querySelector("[data-tab-scroll-root]")
      ?.getAttribute("data-perf-state");
    expect(state === "ready" || state === "ready-forced").toBe(true);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IssueDetail (shared)", () => {
  beforeEach(() => {
    activityPreferencesStore("user-1", "ws-1").getState().setShowSystemDetails(false);
    vi.clearAllMocks();
    issueLogOverride.current = null;
    timelinePageControl.hasMore = false;
    timelinePageControl.olderEntries = [];
    mockViewport.isMobile = false;
    // Default: issue loads successfully
    mockApiObj.getIssue.mockResolvedValue(mockIssue);
    mockWorkspaceMembers.query.mockResolvedValue([
      { user_id: "user-1", name: "Test User", email: "test@test.com", role: "admin" },
    ]);
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
    mockApiObj.getSessionLog.mockImplementation(async (sessionId: string, params: { anchor?: number; before?: number; after?: number } = {}) => {
      const issue = await mockApiObj.getIssue();
      const timeline = params.anchor !== undefined && params.anchor > 0 && timelinePageControl.olderEntries.length
        ? timelinePageControl.olderEntries : await mockApiObj.listTimeline("issue-1", sessionId);
      const rows = (timeline as TimelineEntry[]).map((item, index) => ({
        session_id: sessionId, id: item.id, seq: index + 1, kind: item.details?.log_kind ?? (item.type === "comment" ? "message" : "system"),
        revision: 1, visibility: "shown", author_type: item.actor_type ?? "system", author_id: item.actor_id ?? null,
        task_id: item.task_id ?? null, parent_id: item.parent_id ?? null, body_md: item.content ?? "", body_html: null,
        render_version: null, metadata: { ...item.details, attachments: item.attachments ?? [], reactions: item.reactions ?? [] },
        resolved_at: item.resolved_at ?? null, resolved_by_type: item.resolved_by_type ?? null,
        resolved_by_id: item.resolved_by_id ?? null, created_at: item.created_at ?? "", updated_at: item.updated_at ?? "",
        deleted_at: null,
      }));
      const head = { session_id: sessionId, id: `head-${sessionId}`, seq: 0, kind: "head", revision: 1,
        visibility: "shown", author_type: "system", author_id: null, task_id: null, parent_id: null,
        body_md: issue.description ?? "", body_html: null, render_version: null, metadata: {},
        resolved_at: null, resolved_by_type: null, resolved_by_id: null, created_at: "", updated_at: "", deleted_at: null };
      return { entries: params.anchor === 0 ? [head] : rows,
        head_seq: rows.length, log_version: 1, has_more_before: timelinePageControl.hasMore,
        has_more_after: false };
    });
    mockApiObj.locateSessionLogEntry.mockReset().mockImplementation(async (sessionId: string, id: string) => {
      const window = await mockApiObj.getSessionLog(sessionId);
      const entry = window.entries.find((row: SessionLogRow) => row.id === id);
      if (!entry) throw new ApiError("entry not found", 404, "Not Found");
      return { id, seq: entry.seq, head_seq: window.head_seq };
    });
    mockApiObj.listIssueReactions.mockResolvedValue([]);
    mockApiObj.listIssueSubscribers.mockResolvedValue([]);
    mockApiObj.listChildIssues.mockResolvedValue({ issues: [] });
    mockApiObj.listIssueDecisions.mockResolvedValue({
      waiting_on_human: [],
      owner_and_answered: { pending: [], answered: [] },
      count: 0,
    });
    mockApiObj.listGeneratedIssues.mockResolvedValue({ issues: [] });
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

  describe("first-screen dependencies (MUL-499)", () => {
    it("does not request dependencies for a top-level issue", async () => {
      renderIssueDetail();
      await waitForReveal();
      expect(mockApiObj.listIssueDependencies).not.toHaveBeenCalled();
    });

    it("requests dependencies once for the child issue editor", async () => {
      mockApiObj.getIssue.mockResolvedValue({ ...mockIssue, parent_issue_id: "issue-parent" });
      renderIssueDetail();
      await waitForReveal();
      expect(mockApiObj.listIssueDependencies).toHaveBeenCalledExactlyOnceWith("issue-1");
    });

    it.each(["backlog", "in_progress"] as const)("uses blocked_by count only in backlog (%s)", async status => {
      mockApiObj.getIssue.mockResolvedValue({ ...mockIssue, status, blocked_by: ["prerequisite-1", "prerequisite-2"] });
      renderIssueDetail();
      await waitForReveal();
      const count = screen.queryByText("Waiting for 2 prerequisites");
      if (status === "backlog") {
        expect(count).toBeInTheDocument();
        expect(count).toHaveClass("h-[18px]");
      } else {
        expect(count).not.toBeInTheDocument();
      }
      expect(mockApiObj.listIssueDependencies).not.toHaveBeenCalled();
    });
  });

  it("keeps the detail skeleton until member and child gates resolve", async () => {
    let resolveMembers!: (members: Array<{ user_id: string; name: string; email: string; role: string }>) => void;
    let resolveChildren!: (value: { issues: Issue[] }) => void;
    mockWorkspaceMembers.query.mockReturnValue(new Promise((resolve) => {
      resolveMembers = resolve;
    }));
    mockApiObj.listChildIssues.mockReturnValue(new Promise((resolve) => {
      resolveChildren = resolve;
    }));

    renderIssueDetail();
    await waitFor(() => expect(mockApiObj.listChildIssues).toHaveBeenCalledWith("issue-1"));
    expect(document.querySelector("[data-tab-scroll-root][data-perf-state='ready']")).not.toBeInTheDocument();

    await act(async () => {
      resolveMembers([{ user_id: "user-1", name: "Test User", email: "test@test.com", role: "admin" }]);
    });
    expect(document.querySelector("[data-tab-scroll-root][data-perf-state='ready']")).not.toBeInTheDocument();

    await act(async () => {
      resolveChildren({ issues: [] });
    });
    expect(await screen.findByRole("button", { name: "Implement authentication" })).toBeInTheDocument();
  });

  it("renders issue title and description after loading", async () => {
    renderIssueDetail();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Implement authentication" })).toBeInTheDocument();
    });

    expect(screen.getByText("Add JWT auth to the backend")).toBeInTheDocument();
  });

  it("shows the completed-without-output empty state for a done intake", async () => {
    mockApiObj.getIssue.mockResolvedValue({
      ...mockIssue,
      issue_kind: "intake",
      status: "done",
    });

    renderIssueDetail();

    expect(await screen.findByText(
      "Triage is complete. No execution issues were created.",
    )).toBeInTheDocument();
    expect(screen.queryByText(
      "The agent is still triaging this request.",
    )).not.toBeInTheDocument();
  });

  it("keeps the triaging empty state for an in-progress intake", async () => {
    mockApiObj.getIssue.mockResolvedValue({
      ...mockIssue,
      issue_kind: "intake",
      status: "in_progress",
    });

    renderIssueDetail();

    expect(await screen.findByText(
      "The agent is still triaging this request.",
    )).toBeInTheDocument();
    expect(screen.queryByText(
      "Triage is complete. No execution issues were created.",
    )).not.toBeInTheDocument();
  });

  it("shows the generated issue count and linked issue", async () => {
    const generatedIssue: Issue = {
      ...mockIssue,
      id: "issue-2",
      number: 2,
      identifier: "TES-2",
      title: "Implement the execution step",
      issue_kind: "execution",
      source_issue_id: mockIssue.id,
    };
    mockApiObj.getIssue.mockResolvedValue({
      ...mockIssue,
      issue_kind: "intake",
      status: "done",
    });
    mockApiObj.listGeneratedIssues.mockResolvedValue({
      issues: [generatedIssue],
    });

    renderIssueDetail();

    expect(await screen.findByText("Generated issues · 1")).toBeInTheDocument();
    const generatedIssueLink = screen.getByRole("link", {
      name: /TES-2Implement the execution step/,
    });
    expect(generatedIssueLink).toHaveAttribute("href", "/test/issues/issue-2");
    expect(screen.queryByText(
      "Triage is complete. No execution issues were created.",
    )).not.toBeInTheDocument();
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
      expect(screen.getByRole("button", { name: "Add JWT authentication" })).toBeInTheDocument();
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
      expect(screen.getByRole("button", { name: "Implement authentication" })).toBeInTheDocument();
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

    await screen.findByRole("button", { name: "Implement authentication" });
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

    await screen.findByRole("button", { name: "Implement authentication" });
    await waitFor(() => expect(mockApiObj.listTasksByIssue).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Complete issue" })).not.toBeInTheDocument();
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

  it("skips the default-session primer for an explicit Session deep link", async () => {
    renderIssueDetail("issue-1", "session-main");

    await waitFor(() => {
      expect(mockApiObj.getSessionLog).toHaveBeenCalledWith("session-main", { before: 30 });
    });
    expect(mockApiObj.getSessionLog.mock.calls.some(([sessionId]) => sessionId === "@default")).toBe(false);
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

  });

  it("mounts the rail in the panel's left gutter even for a single-session issue", async () => {
    // Default fixture: one default "Main" session.
    renderIssueDetail();

    await screen.findByRole("button", { name: "Implement authentication" });
    const scrollRoot = document.querySelector<HTMLElement>("[data-tab-scroll-root]");
    expect(scrollRoot).not.toBeNull();
    // Sibling of the scroll container, immediately before it — same slot the
    // multi-session case uses, so the reading column never shifts when a
    // second session appears.
    expect(scrollRoot!.parentElement!.parentElement!.previousElementSibling).toContainElement(
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
      expect(mockApiObj.createIssueSession).toHaveBeenCalledWith("issue-1", {
        title: "Review",
        holds_workspace: true,
      });
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
    expect(scrollRoot!.parentElement!.parentElement!.previousElementSibling).toContainElement(sessionsLabel);
    // The timeline itself stays inside the scroll container.
    expect(scrollRoot!.contains(screen.getAllByText("Comments and activity")[0]!)).toBe(true);
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
      screen.getByText("This workspace has no agents yet. Create one before adding participants."),
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

    await screen.findByRole("button", { name: "Implement authentication" });
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

  it.each([
    ["deleted-comment", "session-main"], ["missing-comment", "session-main"],
    ["deleted-comment", undefined], ["missing-comment", undefined],
  ])("reveals a normal ready tail for unavailable %s (session: %s)", async (target, sessionId) => {
    mockApiObj.locateSessionLogEntry.mockRejectedValue(new ApiError("entry not found", 404, "Not Found"));
    const view = render(<I18nProvider locale="en" resources={TEST_RESOURCES}>
      <QueryClientProvider client={createTestQueryClient()}>
        <IssueDetail issueId="issue-1" initialIssueSessionId={sessionId} highlightCommentId={target} />
      </QueryClientProvider>
    </I18nProvider>);
    await waitFor(() => expect(view.container.querySelector("[data-tab-scroll-root]"))
      .toHaveAttribute("data-perf-state", "ready"));
    const root = view.container.querySelector("[data-tab-scroll-root]")!;
    expect(root).toHaveAttribute("data-perf-fresh", "1");
    expect(root).toHaveAttribute("data-stick-state", "pinned");
    expect(screen.getByText("Started working on this")).toBeVisible();
    expect(view.container.querySelector('[data-perf-anchor="target-comment"]')).toBeNull();
    expect(view.container.querySelector(".bg-warning\\/10")).toBeNull();
    expect(screen.getByRole("switch", { name: "Show system details" })).toHaveAttribute("aria-checked", "false");
    expect(activityPreferencesStore("user-1", "ws-1").getState().showSystemDetails).toBe(false);
    expect(mockApiObj.getSessionLog).toHaveBeenCalledWith("session-main", { before: 30 });
  });

  it.each(["session-main", undefined])("keeps a failed locate retryable (session: %s)", async sessionId => {
    mockApiObj.locateSessionLogEntry.mockRejectedValue(new TypeError("Failed to fetch"));
    const view = render(<I18nProvider locale="en" resources={TEST_RESOURCES}>
      <QueryClientProvider client={createTestQueryClient()}>
        <IssueDetail issueId="issue-1" initialIssueSessionId={sessionId} highlightCommentId="target" />
      </QueryClientProvider>
    </I18nProvider>);
    await screen.findByRole("button", { name: "Try again" });
    expect(view.container.querySelector("[data-tab-scroll-root]")).toBeNull();
    expect(mockApiObj.getSessionLog).not.toHaveBeenCalled();
    mockApiObj.locateSessionLogEntry.mockRejectedValue(new ApiError("entry not found", 404, "Not Found"));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(view.container.querySelector("[data-tab-scroll-root]"))
      .toHaveAttribute("data-perf-state", "ready"));
    expect(screen.getByText("Started working on this")).toBeVisible();
  });

  it("keeps a valid deep link positioned and highlighted", async () => {
    const view = render(<I18nProvider locale="en" resources={TEST_RESOURCES}>
      <QueryClientProvider client={createTestQueryClient()}>
        <IssueDetail issueId="issue-1" highlightCommentId="comment-2" />
      </QueryClientProvider>
    </I18nProvider>);
    await waitFor(() => expect(view.container.querySelector("[data-tab-scroll-root]"))
      .toHaveAttribute("data-perf-state", "ready"));
    expect(view.container.querySelector('[data-perf-anchor="target-comment"]'))
      .toHaveAttribute("id", "comment-comment-2");
    expect(document.getElementById("comment-comment-2")).toHaveClass("bg-warning/10");
    expect(view.container.querySelector("[data-tab-scroll-root]")).toHaveAttribute("data-stick-state", "released");
  });

  it.each([404, 503, 200])("uses the default session only when every candidate returns not-found (side: %s)", async status => {
    const [main] = await mockApiObj.listIssueSessions("issue-1");
    mockApiObj.listIssueSessions.mockResolvedValue([{ ...main, id: "session-side", is_default: false }, main]);
    mockApiObj.locateSessionLogEntry.mockImplementation(async (sessionId: string) => {
      const code = sessionId === "session-side" ? status : 404;
      if (code === 200) return { id: "another-comment", seq: 1, head_seq: 1 };
      throw new ApiError("unavailable", code, "Unavailable");
    });
    const view = render(<I18nProvider locale="en" resources={TEST_RESOURCES}>
      <QueryClientProvider client={createTestQueryClient()}>
        <IssueDetail issueId="issue-1" highlightCommentId="missing" />
      </QueryClientProvider>
    </I18nProvider>);
    if (status !== 404) {
      await screen.findByRole("button", { name: "Try again" });
      expect(mockApiObj.getSessionLog).not.toHaveBeenCalled();
    } else {
      await waitFor(() => expect(view.container.querySelector("[data-tab-scroll-root]"))
        .toHaveAttribute("data-perf-state", "ready"));
      expect(mockApiObj.getSessionLog).toHaveBeenCalledWith("session-main", { before: 30 });
      expect(mockApiObj.getSessionLog).not.toHaveBeenCalledWith("session-side", { before: 30 });
    }
  });

  it("replaces a stale SSR anchor with a ready bottom window", async () => {
    const window = await mockApiObj.getSessionLog("session-main");
    mockApiObj.locateSessionLogEntry.mockRejectedValue(new ApiError("entry not found", 404, "Not Found"));
    const view = render(<I18nProvider locale="en" resources={TEST_RESOURCES}>
      <QueryClientProvider client={createTestQueryClient()}>
        <IssueDetail issueId="issue-1" initialIssueSessionId="session-main" highlightCommentId="deleted"
          initialLog={{ sessionId: "session-main", head: null, window, targetCommentId: "deleted" }} />
      </QueryClientProvider>
    </I18nProvider>);
    await waitFor(() => expect(view.container.querySelector("[data-tab-scroll-root]"))
      .toHaveAttribute("data-perf-state", "ready"));
    expect(view.container.querySelector("[data-tab-scroll-root]")).toHaveAttribute("data-stick-state", "pinned");
    expect(view.container.querySelector('[data-perf-anchor="target-comment"]')).toBeNull();
    expect(screen.getByText("Started working on this")).toBeVisible();
    expect(mockApiObj.locateSessionLogEntry).toHaveBeenCalledWith("session-main", "deleted");
  });

  it("locates an inbox comment after the Issue resolves behind a ready log window", async () => {
    let resolveIssue!: (issue: Issue) => void;
    mockApiObj.getIssue.mockReturnValue(new Promise<Issue>((resolve) => { resolveIssue = resolve; }));
    const target: SessionLogRow = {
      session_id: "session-main", seq: 2, id: "comment-2", revision: 1, kind: "message",
      visibility: "shown", author_type: "agent", author_id: "agent-1", task_id: null,
      parent_id: null, body_md: "I can help with this", body_html: "<p>I can help with this</p>",
      render_version: "test", metadata: { attachments: [], reactions: [] }, resolved_at: null,
      resolved_by_type: null, resolved_by_id: null, created_at: "2026-01-17T00:00:00Z",
      updated_at: "2026-01-17T00:00:00Z", deleted_at: null,
    };
    const replica = new MemorySessionReplica({
      "session-main": { entries: [target], ready: true, fresh: true },
    });
    issueLogOverride.current = { replica, snapshot: replica.getSnapshot("session-main"), error: false };
    const queryClient = createTestQueryClient();
    render(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <QueryClientProvider client={queryClient}>
          <IssueDetail issueId="issue-1" initialIssueSessionId="session-main"
            highlightCommentId={target.id} initialLog={{ sessionId: "session-main", head: null,
              window: { entries: [], head_seq: 2, log_version: 1, has_more_before: false, has_more_after: false } }} />
        </QueryClientProvider>
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(queryClient.getQueryState(["workspaces", "ws-1", "members"])?.status).toBe("success");
    });
    expect(document.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    expect(document.getElementById("comment-comment-2")).toBeNull();
    resolveIssue(mockIssue);
    await waitForReveal();
    expect(document.querySelector('[data-perf-anchor="target-comment"]')).toHaveAttribute("id", "comment-comment-2");
    expect(document.getElementById("comment-comment-2")).toHaveClass("bg-warning/10");
    expect(document.querySelector('[data-session-log-scroll]')).toHaveAttribute("data-stick-state", "released");
  });

  it("shows reusable Session results without offering to publish one", async () => {
    mockApiObj.listIssueSessionResults.mockResolvedValue([{
      id: "result-1",
      issue_id: mockIssue.id,
      source_session_id: "session-main",
      title: "Architecture decision",
      body: "Use an append-only canonical event log.",
      metadata: {},
      published_by_type: "agent",
      published_by_id: "agent-1",
      created_at: "2025-01-03T00:00:00Z",
    }]);
    mockApiObj.listTimeline.mockResolvedValue([...mockTimeline, { type: "activity", id: "published-result", actor_type: "system",
      content: "Duplicate result body", details: { log_kind: "result_published", result_id: "result-1", title: "Architecture decision" } }]);
    renderIssueDetail();

    // The result itself lives in the right panel's key-results section; the
    // timeline only carries a one-line pointer at it.
    expect(await screen.findByText("Architecture decision")).toBeInTheDocument();
    await waitForReveal();
    expect(screen.queryByText(/published the result/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Show system details" }));
    expect(
      screen.getByText(/published the result "Architecture decision"/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Use an append-only canonical event log."),
    ).not.toBeInTheDocument();

    // Results are written by agents through the CLI, never from the dashboard,
    // so the panel is read-only — no publish/delegate buttons anywhere on the
    // page. Members never used them (MUL-204).
    expect(
      screen.queryByRole("button", { name: "Publish result" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delegate task" }),
    ).not.toBeInTheDocument();
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
    mockApiObj.listTimeline.mockResolvedValue([...mockTimeline, { type: "activity", id: "published-result", actor_type: "system",
      content: "Duplicate result body", details: { log_kind: "result_published", result_id: "result-1", title: "Architecture decision" } }]);
    renderIssueDetail();

    // Panel section carries the typed card...
    expect(await screen.findByText("Key results")).toBeInTheDocument();
    await waitForReveal();
    expect(screen.getByRole("img", { name: "Decision" })).toBeInTheDocument();

    // ...and the timeline line scrolls to it.
    expect(screen.queryByText(/published the result/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Show system details" }));
    fireEvent.click(screen.getByText(/published the result "Architecture decision"/));
    expect(scrollIntoViewSpy).toHaveBeenCalledTimes(1);
    expect((scrollIntoViewSpy.mock.contexts[0] as HTMLElement).id).toBe("issue-key-results");
  });

  it("keeps the child list in the sidebar and out of the document scroll region", async () => {
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

    const childLink = (await screen.findByText("Add refresh tokens")).closest("a");
    expect(childLink).toHaveAttribute("href", "/test/issues/issue-2");
    expect(childLink!.closest("[data-tab-scroll-root]")).toBeNull();
    expect(screen.getByText("0/1")).toBeInTheDocument();
    useIssueSelectionStore.getState().clear();
  });

  it("keeps the activity skeleton up while the session list is still resolving", async () => {
    // The timeline query is disabled until a session id exists, and a disabled
    // TanStack query reports isLoading === false — without explicit gating the
    // activity area renders as a blank gap instead of a skeleton.
    mockApiObj.listIssueSessions.mockReturnValue(new Promise(() => {}));
    renderIssueDetail();

    expect(mockApiObj.getSessionLog).not.toHaveBeenCalled();
    // Two skeletons are up at once now: the activity section's own placeholder
    // and the reveal overlay that covers the whole document until the gates
    // hold. Both carry `data-slot="skeleton"`, which is what the probe counts.
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    // No log viewport mounts before the Session exists; the skeleton fills its place.
    expect(document.querySelector("[data-tab-scroll-root]")).toBeNull();
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
    expect(mockApiObj.getSessionLog).not.toHaveBeenCalled();
  });

  it("renders the issue title leaf as a link to the issue detail page", async () => {
    renderIssueDetail();

    // The breadcrumb leaf is the whole "identifier + title" string wrapped in a
    // single link to the issue's own detail route (used to open the full page
    // from the inline Inbox pane). A bare issue has no ancestor crumbs.
    const identifier = await screen.findByRole("link", { name: "TES-1" });
    expect(identifier).toHaveAttribute("href", "/test/issues/issue-1");
    expect(screen.getByRole("button", { name: "Implement authentication" })).toBeInTheDocument();
  });

  it("omits the project breadcrumb segment when the issue has no project_id", async () => {
    // Default fixture has project_id: null.
    renderIssueDetail();

    // Leaf renders once loaded; a bare issue has no ancestor crumbs at all.
    await screen.findByRole("link", { name: "TES-1" });

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

  it("groups the parent section directly above sub-issues in the sidebar", async () => {
    // MUL-204: the two halves of the hierarchy used to sit on opposite sides
    // of the code-workspace and creation-relation sections, so a link to the
    // parent showed up in a different part of the rail than the children did.
    const parent: Issue = {
      ...mockIssue,
      id: "issue-parent",
      number: 9,
      identifier: "TES-9",
      title: "Authentication epic",
      parent_issue_id: null,
    };
    const child: Issue = {
      ...mockIssue,
      id: "issue-2",
      number: 2,
      identifier: "TES-2",
      title: "Add refresh tokens",
      parent_issue_id: "issue-1",
      status: "todo",
    };
    mockApiObj.getIssue.mockImplementation((id: string) =>
      Promise.resolve(
        id === "issue-parent" ? parent : { ...mockIssue, parent_issue_id: "issue-parent" },
      ),
    );
    mockApiObj.listChildIssues.mockResolvedValue({ issues: [child] });

    renderIssueDetail();

    const parentToggle = await screen.findByRole("button", { name: /Parent issue/ });
    // The main column carries a sub-issue list under the same label; only the
    // sidebar fold reports aria-expanded, so that is what disambiguates them.
    const subToggle = screen.getByRole("button", { name: /Sub-issues/, expanded: true });

    // Parent first — the rail reads in the same direction as the tree.
    expect(
      parentToggle.compareDocumentPosition(subToggle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // …and nothing is allowed between them.
    expect(parentToggle.parentElement?.nextElementSibling).toBe(subToggle.parentElement);
  });

  it("uses a non-resizable layout with the sidebar sheet closed by default on mobile", async () => {
    mockViewport.isMobile = true;

    renderIssueDetail();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Implement authentication" })).toBeInTheDocument();
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
      expect(screen.getAllByText("Comments and activity").length).toBeGreaterThanOrEqual(1);
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
    function activityRow(seq: number, kind: string, extra: Partial<SessionLogRow> = {}): SessionLogRow {
      return SessionLogEntrySchema.parse({ session_id: "session-main", seq, id: "row-" + seq, revision: 1, kind,
        author_type: "system", body_md: "Event " + seq, body_html: null, render_version: "test", metadata: {}, ...extra });
    }
    function renderActivityRows(entries: SessionLogRow[], userId: string, options: { target?: string; missing?: string; ssr?: boolean } = {}) {
      const queryClient = createTestQueryClient();
      let target = options.target;
      const makeView = () => <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <QueryClientProvider client={queryClient}>
          <IssueActivitySection issueId={mockIssue.id} issueTitle={mockIssue.title} projectId={null}
            members={[]} agents={[{ id: "agent-1", name: "QA" } as any]} currentUserId={userId}
            canModerateComments={false} activeIssueSessionId="session-main" activeIssueSession={null}
            sessionsPending={false} sessionsFetching={false} onRetrySessions={vi.fn()} scrollContainerEl={null}
            onScrollRoot={vi.fn()} onShowKeyResults={vi.fn()} highlightCommentId={target}
            initialLog={{ sessionId: "session-main", head: null, targetCommentId: options.missing ? undefined : target,
              missingCommentId: options.missing,
              window: { entries: [], head_seq: 10, log_version: 1, has_more_before: false, has_more_after: false } }} />
        </QueryClientProvider>
      </I18nProvider>;
      const install = (rows: SessionLogRow[]) => {
        const replica = new MemorySessionReplica({ "session-main": { entries: rows, ready: true, fresh: true } });
        Object.assign(replica, { missingCommentId: options.missing ?? null });
        issueLogOverride.current = { replica, snapshot: replica.getSnapshot("session-main"), error: false };
      };
      install(entries);
      const serverHtml = options.ssr ? renderToString(makeView()) : undefined;
      const view = render(makeView());
      return { ...view, serverHtml,
        replaceRows: (rows: SessionLogRow[]) => { install(rows); view.rerender(makeView()); },
        changeTarget: (next?: string) => { target = next; view.rerender(makeView()); } };
    }

    it("opens an SSR missing-target tail's gate after preferences, without temporary details", async () => {
      const user = "missing-ssr";
      const rows = [activityRow(0, "head"), activityRow(1, "message", { author_type: "member", body_md: "retained" }),
        activityRow(2, "system")];
      const view = renderActivityRows(rows, user, { target: "missing", missing: "missing", ssr: true });
      expect(view.serverHtml).toContain('data-ssr-display-ready="0"');
      expect(view.serverHtml).not.toContain('data-ssr-anchor-id=');
      expect(view.serverHtml).toContain("retained");
      expect(view.serverHtml).not.toContain('data-system-detail');
      await waitFor(() => expect(view.container.querySelector("[data-tab-scroll-root]"))
        .toHaveAttribute("data-ssr-display-ready", "1"));
      expect(activityPreferencesStore(user, "ws-1").getState().showSystemDetails).toBe(false);
      expect(view.container.querySelector('[role="switch"]')).toHaveAttribute("aria-checked", "false");
    });

    it.each([
      ["envelope", "system", { envelope: { kind: "report", to: { role: "delegator" }, outcome: "done" } }, "Agent-only instruction"],
      ["result", "result_published", { title: "Linked result" }, "Result body"],
      ["inbox", "turn", { assignee_agent_id: "agent-1" }, "读收件箱 ises_hidden cmt_env_hidden"],
      ["unknown", "follow_frozen", {}, "Frozen details"],
    ] as const)("renders a hidden %s deep-link target before SSR reveal without persisting the temporary display", async (name, kind, metadata, body) => {
      const user = "deep-link-" + name;
      const preference = activityPreferencesStore(user, "ws-1");
      const write = vi.spyOn(preference.getState(), "setShowSystemDetails");
      const target = activityRow(1, kind as string, { id: "linked-" + name, metadata, body_md: body as string });
      const view = renderActivityRows([activityRow(0, "head"), target], user, { target: target.id, ssr: true });
      const server = document.createElement("div");
      server.innerHTML = view.serverHtml!;
      const anchor = view.container.querySelector('[data-perf-anchor="target-comment"]');
      expect(anchor).toHaveAttribute("id", "comment-" + target.id);
      expect(anchor).toHaveClass("bg-warning/10");
      expect(server.querySelector('[data-perf-anchor="target-comment"]')).toHaveAttribute("id", "comment-" + target.id);
      expect(server.querySelector('[role="switch"]')).toHaveAttribute("aria-checked", "true");
      expect(server.querySelector("[data-session-log-scroll]")).toHaveAttribute("data-ssr-display-ready", "0");
      expect(view.container.querySelector("[data-session-log-scroll]")).toHaveAttribute("data-ssr-display-ready", "1");
      expect(screen.getByRole("switch", { hidden: true })).toHaveAttribute("aria-checked", "true");
      expect(preference.getState().showSystemDetails).toBe(false);
      expect(write).not.toHaveBeenCalled();
      view.changeTarget();
      expect(view.container.querySelector("[data-system-detail]")).toBeNull();
      expect(screen.getByRole("switch", { hidden: true })).toHaveAttribute("aria-checked", "false");
      expect(write).not.toHaveBeenCalled();
      write.mockRestore();
      await act(async () => {});
    });

    it("keeps ordinary comment deep links filtered and does not write their preference", () => {
      const user = "deep-link-comment";
      const preference = activityPreferencesStore(user, "ws-1");
      const write = vi.spyOn(preference.getState(), "setShowSystemDetails");
      const target = activityRow(1, "message", { author_type: "member", body_md: "Linked comment", body_html: "<p>Linked comment</p>" });
      const view = renderActivityRows([activityRow(0, "head"), target, activityRow(2, "system")], user, { target: target.id });
      expect(view.container.querySelector('[data-perf-anchor="target-comment"]')).toHaveAttribute("id", "comment-" + target.id);
      expect(view.container.querySelector("[data-system-detail]")).toBeNull();
      expect(screen.getByRole("switch", { hidden: true })).toHaveAttribute("aria-checked", "false");
      expect(write).not.toHaveBeenCalled();
      write.mockRestore();
    });

    it("waits for an unresolved deep-link target before enabling the display gate", async () => {
      const head = activityRow(0, "head");
      const target = activityRow(1, "system", { id: "late-system-target" });
      const view = renderActivityRows([head], "deep-link-late", { target: target.id });
      expect(view.container.querySelector("[data-session-log-scroll]")).toHaveAttribute("data-ssr-display-ready", "0");
      expect(document.getElementById("comment-" + target.id)).toBeNull();
      view.replaceRows([head, target]);
      expect(view.container.querySelector("[data-session-log-scroll]")).toHaveAttribute("data-ssr-display-ready", "1");
      expect(view.container.querySelector('[data-perf-anchor="target-comment"]')).toHaveAttribute("id", "comment-" + target.id);
      expect(screen.getByRole("switch", { hidden: true })).toHaveAttribute("aria-checked", "true");
      expect(activityPreferencesStore("deep-link-late", "ws-1").getState().showSystemDetails).toBe(false);
      await act(async () => {});
    });

    it("lets a manual switch override temporary deep-link display and persist the user's choice", async () => {
      const user = "deep-link-manual";
      const preference = activityPreferencesStore(user, "ws-1");
      const write = vi.spyOn(preference.getState(), "setShowSystemDetails");
      const rows = [activityRow(0, "head"), activityRow(1, "system")];
      const view = renderActivityRows(rows, user, { target: rows[1]!.id });
      const toggle = screen.getByRole("switch", { hidden: true });
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-checked", "false");
      expect(view.container.querySelector("[data-system-detail]")).toBeNull();
      expect(write).toHaveBeenLastCalledWith(false);
      view.replaceRows([...rows]);
      expect(toggle).toHaveAttribute("aria-checked", "false");
      fireEvent.click(toggle);
      expect(write).toHaveBeenLastCalledWith(true);
      expect(preference.getState().showSystemDetails).toBe(true);
      view.unmount();
      const later = renderActivityRows(rows, user);
      expect(later.container.querySelector("[data-system-detail]")).not.toBeNull();
      write.mockRestore();
      await act(async () => {});
    });

    it("filters all system detail types before rendering and only inserts them after the user's toggle", async () => {
      const head = activityRow(0, "head", { body_md: "" });
      const assignment = activityRow(1, "turn", { task_id: "task", body_md: "# Assignment\nFull task instructions", metadata: { assignee_agent_id: "agent-1", status: "completed" } });
      const comment = activityRow(2, "message", { author_type: "member", author_id: "user-1", body_md: "Ordinary comment", body_html: "<p>Ordinary comment</p>" });
      const hidden = [
        activityRow(3, "turn", { body_md: "读收件箱 ises_x cmt_env_x", metadata: { assignee_agent_id: "agent-1" } }),
        activityRow(4, "system", { body_md: "Read internal instructions dec_x", metadata: { envelope: { kind: "decision_needed" } } }),
        activityRow(5, "result_published", { body_md: "# Duplicate body", metadata: { title: "Result title" } }),
        activityRow(6, "follow_frozen", { body_md: "# Frozen tsk_x" }),
      ];
      const view = renderActivityRows([head, assignment, comment, ...hidden], "detail-filter");
      expect(view.container.querySelectorAll("[data-system-detail]")).toHaveLength(0);
      expect(document.getElementById("comment-row-1")).not.toBeNull();
      expect(document.getElementById("comment-row-2")).toHaveTextContent("Ordinary comment");
      for (const row of hidden) expect(document.getElementById("comment-" + row.id)).toBeNull();
      const toggle = screen.getByRole("switch", { hidden: true });
      expect(toggle).toHaveAttribute("aria-label", "Show system details");
      fireEvent.click(toggle);
      expect(view.container.querySelectorAll("[data-system-detail]")).toHaveLength(4);
      expect(view.container).not.toHaveTextContent(/Full task instructions|Read internal instructions|Duplicate body|ises_x|cmt_env_x|tsk_x|dec_x/);
      fireEvent.click(toggle);
      expect(view.container.querySelectorAll("[data-system-detail]")).toHaveLength(0);
      expect(document.getElementById("comment-row-2")).toHaveTextContent("Ordinary comment");
      await act(async () => {});
    });

    it("applies a persisted preference on the first client render and keeps it across remounts", () => {
      const preference = activityPreferencesStore("detail-persist", "ws-1");
      preference.getState().setShowSystemDetails(true);
      const rows = [activityRow(0, "head"), activityRow(1, "system", { body_md: "Visible from first render" })];
      const first = renderActivityRows(rows, "detail-persist");
      expect(first.container.querySelector("[data-system-detail]")).not.toBeNull();
      first.unmount();
      const second = renderActivityRows(rows, "detail-persist");
      expect(second.container.querySelector("[data-system-detail]")).not.toBeNull();
      second.unmount();
      const differentUser = renderActivityRows(rows, "detail-other");
      expect(differentUser.container.querySelector("[data-system-detail]")).toBeNull();
    });

    it("preserves a released reader's anchor when the user toggles details and keeps pinned scrolling at the end", async () => {
      const view = renderActivityRows([activityRow(0, "head"), activityRow(1, "system"),
        activityRow(2, "message", { author_type: "member", body_md: "Reader anchor", body_html: "<p>Reader anchor</p>" })], "detail-anchor");
      const root = view.container.querySelector<HTMLDivElement>("[data-session-log-scroll]")!;
      const comment = document.getElementById("comment-row-2")!;
      root.dataset.stickState = "released";
      root.scrollTop = 200;
      root.getBoundingClientRect = () => ({ top: 50, bottom: 500 } as DOMRect);
      comment.getBoundingClientRect = () => {
        const top = view.container.querySelector("[data-system-detail]") ? 100 : 60;
        return { top, bottom: top + 20 } as DOMRect;
      };
      const toggle = screen.getByRole("switch", { hidden: true });
      fireEvent.click(toggle);
      expect(root.scrollTop).toBe(240);
      root.dataset.stickState = "pinned";
      Object.defineProperty(root, "scrollHeight", { configurable: true, value: 800 });
      fireEvent.click(toggle);
      expect(root.scrollTop).toBe(800);
      await act(async () => {});
    });

    it("marks only the first assignee reply and does not retrofit references after earlier paging", () => {
      const head = activityRow(0, "head");
      const turn = activityRow(1, "turn", { task_id: "task", body_md: "# Task title", metadata: { assignee_agent_id: "agent-1" } });
      const first = activityRow(2, "message", { task_id: "task", author_type: "agent", author_id: "agent-1", body_md: "First reply", body_html: "<p>First reply</p>" });
      const second = activityRow(3, "message", { ...first, seq: 3, id: "second", body_md: "Second reply", body_html: "<p>Second reply</p>" });
      const view = renderActivityRows([head, turn, first, second], "detail-response");
      expect(view.container.querySelectorAll("[data-assignment-ref]")).toHaveLength(1);
      expect(document.getElementById("comment-row-2")?.querySelector("[data-assignment-ref]")).toHaveTextContent("Responding to assignment: Task title");
      expect(document.getElementById("comment-second")?.querySelector("[data-assignment-ref]")).toBeNull();
      view.unmount();
      const lateTurn = renderActivityRows([head, first, second], "detail-window");
      expect(lateTurn.container.querySelector("[data-assignment-ref]")).toBeNull();
      lateTurn.replaceRows([head, turn, first, second]);
      expect(lateTurn.container.querySelector("[data-assignment-ref]")).toBeNull();
    });
    it.each(["no rows", "protocol head only"])("marks an answered empty log ready immediately with %s", (caseName) => {
      const head: SessionLogRow = {
        session_id: "session-main", id: "head-session-main", seq: 0, kind: "head", revision: 1,
        visibility: "shown", author_type: "system", author_id: null, task_id: null, parent_id: null,
        body_md: "", body_html: "", render_version: "test", metadata: { attachments: [] },
        resolved_at: null, resolved_by_type: null, resolved_by_id: null, created_at: "", updated_at: "", deleted_at: null,
      };
      const entries = caseName === "protocol head only" ? [head] : [];
      const replica = new MemorySessionReplica({ "session-main": { entries, ready: true, fresh: true } });
      issueLogOverride.current = { replica, snapshot: replica.getSnapshot("session-main"), error: false };
      const onContentReady = vi.fn();

      render(
        <I18nProvider locale="en" resources={TEST_RESOURCES}>
          <QueryClientProvider client={createTestQueryClient()}>
            <IssueActivitySection issueId={mockIssue.id} issueTitle={mockIssue.title} projectId={null} members={[]} agents={[]}
              canModerateComments={false} activeIssueSessionId="session-main" activeIssueSession={null}
              sessionsPending={false} sessionsFetching={false} onRetrySessions={vi.fn()}
              scrollContainerEl={null} onScrollRoot={vi.fn()} onShowKeyResults={vi.fn()}
              onContentReady={onContentReady} />
          </QueryClientProvider>
        </I18nProvider>,
      );

      expect(onContentReady).toHaveBeenCalledOnce();
    });

    it("publishes a log 500 immediately, replacing old session content with a retry view", () => {
      const oldRow: SessionLogRow = {
        session_id: "session-main", id: "old-row", seq: 1, kind: "message", revision: 1,
        visibility: "shown", author_type: "member", author_id: "user-1", task_id: null, parent_id: null,
        body_md: "Old session body", body_html: "<p>Old session body</p>", render_version: "test",
        metadata: { attachments: [] }, resolved_at: null, resolved_by_type: null,
        resolved_by_id: null, created_at: "", updated_at: "", deleted_at: null,
      };
      const oldReplica = new MemorySessionReplica({ "session-main": { entries: [oldRow], ready: true, fresh: true } });
      issueLogOverride.current = { replica: oldReplica, snapshot: oldReplica.getSnapshot("session-main"), error: false };
      const onContentReady = vi.fn();
      const queryClient = createTestQueryClient();
      const view = (sessionId: string) => <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <QueryClientProvider client={queryClient}>
          <IssueActivitySection issueId={mockIssue.id} issueTitle={mockIssue.title} projectId={null} members={[]} agents={[]}
            canModerateComments={false} activeIssueSessionId={sessionId} activeIssueSession={null}
            sessionsPending={false} sessionsFetching={false} onRetrySessions={vi.fn()}
            scrollContainerEl={null} onScrollRoot={vi.fn()} onShowKeyResults={vi.fn()}
            onContentReady={onContentReady} />
        </QueryClientProvider>
      </I18nProvider>;
      const rendered = render(view("session-main"));
      expect(screen.getByText("Old session body")).toBeInTheDocument();
      onContentReady.mockClear();

      const failedReplica = new MemorySessionReplica({ "session-review": { entries: [], ready: false, fresh: false } });
      const refreshVisible = vi.fn(async () => {});
      issueLogOverride.current = { replica: Object.assign(failedReplica, { refreshVisible }),
        snapshot: failedReplica.getSnapshot("session-review"), error: true };
      rendered.rerender(view("session-review"));

      expect(onContentReady).toHaveBeenCalled();
      expect(screen.queryByText("Old session body")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /try again/i }));
      expect(refreshVisible).toHaveBeenCalledOnce();
    });

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

    it("deep-links to a reply while its resolved parent stays collapsed", async () => {
      const row = (seq: number, id: string, body: string, parentId: string | null,
        resolvedAt: string | null): SessionLogRow => ({
        session_id: "session-main", seq, id, revision: 1, kind: "message", visibility: "shown",
        author_type: "member", author_id: "user-1", task_id: null, parent_id: parentId,
        body_md: body, body_html: `<p>${body}</p>`, render_version: "test",
        metadata: { attachments: [], reactions: [] }, resolved_at: resolvedAt,
        resolved_by_type: resolvedAt ? "member" : null, resolved_by_id: resolvedAt ? "user-1" : null,
        created_at: "2026-01-18T00:00:00Z", updated_at: "2026-01-18T00:00:00Z", deleted_at: null,
      });
      const entries = [
        row(1, "resolved-parent", "Resolved root", null, "2026-01-19T00:00:00Z"),
        row(2, "reply-1", "Reply inside resolved thread", "resolved-parent", null),
      ];
      const replica = new MemorySessionReplica({ "session-main": { entries, ready: true, fresh: true } });
      issueLogOverride.current = { replica, snapshot: replica.getSnapshot("session-main"), error: false };
      const session = { id: "session-main", title: "Main", issue_id: mockIssue.id,
        workspace_id: "ws-1", status: "active", is_default: true, summary: null,
        created_by_type: "system", created_by_id: null, created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z", participants: [] } as any;
      render(
        <I18nProvider locale="en" resources={TEST_RESOURCES}>
          <QueryClientProvider client={createTestQueryClient()}>
            <IssueActivitySection issueId={mockIssue.id} issueTitle={mockIssue.title} projectId={null} members={[]} agents={[]}
              currentUserId="user-1" canModerateComments activeIssueSessionId="session-main"
              activeIssueSession={session} sessionsPending={false} sessionsFetching={false}
              onRetrySessions={vi.fn()} highlightCommentId="reply-1"
              initialLog={{ sessionId: "session-main", window: {
                entries: [], head_seq: 2, log_version: 1, has_more_before: false, has_more_after: false,
              }, head: null }} onScrollRoot={vi.fn()} onShowKeyResults={vi.fn()}
              scrollContainerEl={null} />
          </QueryClientProvider>
        </I18nProvider>,
      );

      await waitForReveal();
      expect(document.querySelector('[data-perf-anchor="target-comment"]')).toHaveAttribute("id", "comment-reply-1");
      expect(document.getElementById("comment-reply-1")).toHaveClass("bg-warning/10");
      expect(screen.getByText("Reply inside resolved thread")).toBeInTheDocument();
      expect(screen.queryByText("Resolved root")).not.toBeInTheDocument();
      expect(document.getElementById("comment-resolved-parent")).not.toBeNull();
    });

    it("renders every comment as its own entry in created_at order", async () => {
      mockApiObj.listTimeline.mockResolvedValue(threadedTimeline);
      renderIssueDetail();

      await screen.findByText("Answering the first one");

      const ids = Array.from(document.querySelectorAll("[id^='comment-']:not(#comment-head-session-main)")).map(
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
      // Role queries honour CSS visibility, and the reveal keeps the whole
      // document `visibility: hidden` until its gates hold.
      await waitForReveal();

      // The description is read-only until edited; only the session composer
      // mounts an editor, and no message gets its own form.
      expect(screen.getByPlaceholderText("Comment in Main…")).toBeInTheDocument();
      expect(screen.queryByPlaceholderText("Leave a reply...")).not.toBeInTheDocument();
      expect(screen.getAllByTestId("rich-text-editor")).toHaveLength(1);

      // Each row keeps its own toolbar: react / reply / ⋯.
      expect(screen.getAllByRole("button", { name: "Reply" })).toHaveLength(3);
      expect(screen.getAllByRole("button", { name: "More actions" })).toHaveLength(3);
    });

    it("reveals the row toolbar on focus, not on hover alone", async () => {
      mockApiObj.listTimeline.mockResolvedValue(threadedTimeline);
      renderIssueDetail();

      await screen.findByText("Started working on this");
      await waitForReveal();

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
      await waitForReveal();

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
      await waitForReveal();

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
      await waitForReveal();
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
          undefined,
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
      await waitForReveal();
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

      expect(await screen.findByText("Add JWT auth to the backend")).toBeInTheDocument();
      await waitForReveal();
      expect(screen.getByPlaceholderText("Comment in Main…")).toBeInTheDocument();
    });
  });

  it.each(["en", "zh-Hans"] as const)("renders workspace move system log rows in %s with literal names", async (locale) => {
    const name = '**x** [x](mention://agent/fake) <b>x</b>';
    mockApiObj.listTimeline.mockResolvedValue(["assignee", "project", "label"].map((field, index) => ({
      type: "activity", id: `move-${field}`, actor_type: "system", actor_id: "",
      content: "Server fallback body", details: { type: "workspace_move_cleared", field, name },
      created_at: `2026-01-01T00:00:0${index}Z`, updated_at: `2026-01-01T00:00:0${index}Z`,
    })));
    renderIssueDetail("issue-1", undefined, undefined, locale);

    const messages = locale === "en"
      ? [`cleared assignee “${name}” when moving workspaces`, `cleared project “${name}” when moving workspaces`, `removed label “${name}” when moving workspaces`]
      : [`移动工作区时清空了经办人「${name}」`, `移动工作区时清空了项目「${name}」`, `移动工作区时移除了标签「${name}」`];
    await screen.findByText(messages[0]!);
    for (const message of messages) expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.queryByText("Server fallback body")).not.toBeInTheDocument();
    for (const row of document.querySelectorAll("[data-log-kind='system']")) {
      expect(row.querySelector("a, strong, b")).toBeNull();
    }
  });

  it("refreshes workspace move system log rows on the committed comment event", async () => {
    mockApiObj.listTimeline.mockResolvedValue([]);
    renderIssueDetail();
    await screen.findByText("Add JWT auth to the backend");
    await waitForReveal();
    expect(screen.queryByText("cleared project “Original project” when moving workspaces")).not.toBeInTheDocument();
    mockApiObj.listTimeline.mockResolvedValue([{
      type: "activity", id: "move-project", actor_type: "system", actor_id: "",
      content: "Server fallback body", details: { type: "workspace_move_cleared", field: "project", name: "Original project" },
      created_at: "2026-01-01T00:00:01Z", updated_at: "2026-01-01T00:00:01Z",
    }]);
    const callbacks = vi.mocked(useWSEvent).mock.calls.filter(([event]) => event === "comment:created");
    expect(callbacks.length).toBeGreaterThan(0);
    await act(async () => {
      for (const [, handler] of callbacks) handler({ comment: { id: "move-project", issue_id: "issue-1", issue_session_id: "session-main" } });
    });
    expect(await screen.findByText("cleared project “Original project” when moving workspaces")).toBeInTheDocument();
  });

  it("renders system log rows in seq order only when system details are enabled", async () => {
    mockApiObj.listTimeline.mockResolvedValue(Array.from({ length: 10 }, (_, index) => ({
      type: "activity", id: `system-${index + 1}`, actor_type: "system", actor_id: "",
      content: `System event ${index + 1}`, parent_id: null,
      created_at: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
      updated_at: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
    })));
    renderIssueDetail();

    await waitForReveal();
    expect(screen.queryByText("System event 10")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Show system details" }));
    await screen.findByText("System event 10");
    const rows = Array.from(document.querySelectorAll("[data-log-kind='system']"));
    expect(rows).toHaveLength(10);
    expect(rows.map(row => row.querySelector(".flex-1")?.textContent)).toEqual(
      Array.from({ length: 10 }, (_, index) => `System event ${index + 1}`),
    );
    expect(screen.queryByText(/show \d+ more activities/i)).not.toBeInTheDocument();
    expect(rows.every(row => row.querySelector("[role='status']")?.classList.contains("h-8"))).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: "Show system details" }));
    expect(document.querySelectorAll("[data-log-kind='system']")).toHaveLength(0);
  });

  it("sends empty description when editor is cleared", async () => {
    renderIssueDetail();

    await waitFor(() => {
      expect(screen.getByText("Add JWT auth to the backend")).toBeInTheDocument();
    });
    await waitForReveal();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editor = await screen.findByPlaceholderText("Add description...");
    fireEvent.change(editor, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockApiObj.patchIssue).toHaveBeenCalledWith(
        "issue-1",
        expect.objectContaining({ description: "" }),
      );
    });
  });

  // MUL-172. Opening one issue used to subscribe to the workspace issue list,
  // which fans out to one request per board status. The seed it bought was a
  // `.find()` over that list, and a lookup-only caller has no sort to pass, so
  // its cache key could never match the entry the list page wrote under
  // `listSorted(wsId, sort)` — the fan-out was guaranteed to miss and re-fetch.
  // On production those six requests saturated the single-threaded DB bridge
  // before the timeline request was even sent.
  //
  // This asserts the request count directly, which is the metric the browser
  // A/B round is trying to measure. It does not depend on a proxy, a token, or
  // production being reachable.
  describe("issue list fan-out (MUL-172 regression)", () => {
    it("opens an issue without issuing a single list request", async () => {
      renderIssueDetail();

      await waitFor(() => {
        expect(screen.getByText("Add JWT auth to the backend")).toBeInTheDocument();
      });

      expect(mockApiObj.listIssues).not.toHaveBeenCalled();
    });

    it("does not let a list row suppress the authoritative detail request", async () => {
      const queryClient = createTestQueryClient();
      queryClient.setQueryData(["issues", "ws-1", "list", {}], {
        byStatus: {
          in_progress: { issues: [mockIssue], total: 1 },
        },
      });

      render(
        <I18nProvider locale="en" resources={TEST_RESOURCES}>
          <QueryClientProvider client={queryClient}>
            <IssueDetail issueId="issue-1" />
          </QueryClientProvider>
        </I18nProvider>,
      );

      await waitFor(() => expect(mockApiObj.getIssue).toHaveBeenCalledWith("issue-1"));
      expect(mockApiObj.listIssues).not.toHaveBeenCalled();
    });

    it("still issues no list request when the issue has a parent to resolve", async () => {
      // The parent card seeds itself from cache. A miss must fall through to
      // the single-issue endpoint, never to the whole list.
      mockApiObj.getIssue.mockResolvedValue({
        ...mockIssue,
        parent_issue_id: "issue-parent",
      });

      renderIssueDetail();

      await waitFor(() => {
        expect(screen.getByText("Add JWT auth to the backend")).toBeInTheDocument();
      });

      expect(mockApiObj.listIssues).not.toHaveBeenCalled();
    });
  });
});
