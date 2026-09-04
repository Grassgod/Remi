import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enInbox from "../../locales/en/inbox.json";

const TEST_RESOURCES = { en: { common: enCommon, inbox: enInbox } };

const listInbox = vi.hoisted(() => vi.fn());
const markItemsRead = vi.hoisted(() => vi.fn());
const archiveItems = vi.hoisted(() => vi.fn());
const navigationState = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
}));

vi.mock("@multiremi/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multiremi/core/paths", () => ({
  useWorkspacePaths: () => ({
    inbox: () => "/test/inbox",
    inboxIssue: (issueId: string, sessionId?: string) =>
      `/test/inbox?issue=${issueId}${sessionId ? `&session=${sessionId}` : ""}`,
    inboxItem: (itemId: string, sessionId?: string) =>
      `/test/inbox?item=${itemId}${sessionId ? `&session=${sessionId}` : ""}`,
    issueDetail: (id: string) => `/test/issues/${id}`,
    issueSession: (id: string, sessionId: string) =>
      `/test/issues/${id}?session=${sessionId}`,
  }),
}));

vi.mock("@multiremi/core/modals", () => ({
  useModalStore: Object.assign(() => ({ open: vi.fn() }), {
    getState: () => ({ open: vi.fn() }),
  }),
}));

vi.mock("@multiremi/core/issues/stores/draft-store", () => ({
  useIssueDraftStore: Object.assign(() => ({ setDraft: vi.fn() }), {
    getState: () => ({ setDraft: vi.fn() }),
  }),
}));

vi.mock("@multiremi/core/inbox/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multiremi/core/inbox/queries")>()),
  inboxPageOptions: (wsId: string) => ({
    queryKey: ["inbox", wsId, "pages"],
    queryFn: async ({ pageParam }: { pageParam: string | null }) => {
      const result = await listInbox(pageParam);
      return Array.isArray(result)
        ? { items: result, limit: 50, has_more: false, next_cursor: null }
        : result;
    },
    initialPageParam: null,
    getNextPageParam: (lastPage: { next_cursor: string | null }) =>
      lastPage.next_cursor ?? undefined,
  }),
  useInboxUnreadCount: () => 0,
}));

vi.mock("@multiremi/core/inbox/mutations", () => {
  const noopMutation = () => ({ mutate: vi.fn(), isPending: false });
  return {
    useMarkInboxRead: noopMutation,
    useArchiveInbox: noopMutation,
    useArchiveInboxItems: () => ({ mutate: archiveItems, isPending: false }),
    useMarkAllInboxRead: noopMutation,
    useArchiveAllInbox: noopMutation,
    useArchiveAllReadInbox: noopMutation,
    useArchiveCompletedInbox: noopMutation,
    useMarkInboxItemsRead: () => ({ mutate: markItemsRead, isPending: false }),
  };
});

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
}));

const replace = vi.hoisted(() => vi.fn());
vi.mock("../../navigation", () => ({
  useNavigation: () => ({
    searchParams: navigationState.searchParams,
    replace,
    push: vi.fn(),
  }),
}));

vi.mock("./inbox-list-item", () => ({
  InboxListItem: ({
    item,
    groupedItems,
    onClick,
    onArchive,
  }: {
    item: { id: string };
    groupedItems?: Array<{ id: string }>;
    onClick: () => void;
    onArchive: () => void;
  }) => (
    <div>
      <button type="button" data-testid="inbox-row" onClick={onClick}>
        {item.id}{groupedItems && groupedItems.length > 1 ? ` (${groupedItems.length})` : ""}
      </button>
      <button type="button" aria-label={`Archive ${item.id}`} onClick={onArchive}>Archive</button>
    </div>
  ),
  useTimeAgo: () => () => "just now",
}));

vi.mock("./autopilot-run-report", () => ({
  AutopilotRunReport: ({
    item,
    groupedItems,
    onSelectItem,
  }: {
    item: { id: string };
    groupedItems?: Array<{ id: string }>;
    onSelectItem?: (item: { id: string }) => void;
  }) => (
    <div data-testid="autopilot-run-report">
      {item.id}
      {groupedItems && groupedItems.length > 1 && (
        <button type="button" onClick={() => onSelectItem?.(groupedItems[1]!)}>Select child run</button>
      )}
    </div>
  ),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock("@multiremi/ui/hooks/use-mobile", () => ({ useIsMobile: () => false }));

vi.mock("react-resizable-panels", () => ({
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Separator: () => <div />,
  useDefaultLayout: () => ({ defaultLayout: undefined, onLayoutChanged: vi.fn() }),
  usePanelRef: () => ({ current: null }),
}));

import { InboxPage } from "./inbox-page";

function renderInbox() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <QueryClientProvider client={queryClient}>
        <InboxPage />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  navigationState.searchParams = new URLSearchParams();
});

describe("InboxPage", () => {
  it("distinguishes a failed fetch from an empty inbox and offers a retry", async () => {
    listInbox.mockRejectedValue(new Error("500"));
    renderInbox();

    // Both panes say so: the list (with the retry) and the detail placeholder.
    expect(await screen.findAllByText("Something went wrong")).toHaveLength(2);
    // The cheerful zero-states would be a lie here.
    expect(screen.queryByText("No notifications")).not.toBeInTheDocument();
    expect(screen.queryByText("Your inbox is empty")).not.toBeInTheDocument();

    const callsBeforeRetry = listInbox.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => {
      expect(listInbox.mock.calls.length).toBeGreaterThan(callsBeforeRetry);
    });
  });

  it("still shows the empty state when the request succeeds with no items", async () => {
    listInbox.mockResolvedValue([]);
    renderInbox();

    expect(await screen.findByText("No notifications")).toBeInTheDocument();
    expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
  });

  it("loads older notifications one page at a time", async () => {
    const item = (id: string, createdAt: string) => ({
      id,
      type: "comment_mention",
      issue_id: id,
      title: id,
      severity: "info",
      read: true,
      archived: false,
      created_at: createdAt,
    });
    listInbox
      .mockResolvedValueOnce({
        items: [item("newer", "2026-09-04T10:00:00.000Z")],
        limit: 1,
        has_more: true,
        next_cursor: "cursor-1",
      })
      .mockResolvedValueOnce({
        items: [item("older", "2026-09-03T10:00:00.000Z")],
        limit: 1,
        has_more: false,
        next_cursor: null,
      });
    renderInbox();

    expect(await screen.findByText("newer")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("older")).toBeInTheDocument();
    expect(listInbox).toHaveBeenNthCalledWith(1, null);
    expect(listInbox).toHaveBeenNthCalledWith(2, "cursor-1");
  });

  it("groups notifications by date and filters by source", async () => {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    listInbox.mockResolvedValue([
      {
        id: "automation-today",
        type: "autopilot_run_completed",
        issue_id: null,
        title: "Daily summary completed",
        read: false,
        archived: false,
        created_at: now.toISOString(),
      },
      {
        id: "assignment-yesterday",
        type: "issue_assigned",
        issue_id: "issue-2",
        title: "Assigned",
        read: false,
        archived: false,
        created_at: yesterday.toISOString(),
      },
    ]);
    renderInbox();

    expect(await screen.findByRole("heading", { name: "Today" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Yesterday" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Automation" }));
    expect(screen.getByText("automation-today")).toBeInTheDocument();
    expect(screen.queryByText("assignment-yesterday")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Mentions" }));
    expect(screen.getByText("No notifications match this filter")).toBeInTheDocument();
  });

  it("separates the ingested message stream from platform automation", async () => {
    const at = new Date().toISOString();
    listInbox.mockResolvedValue([
      {
        id: "feishu-message",
        type: "feishu_message_notification",
        issue_id: null,
        title: "飞书消息提醒",
        details: { message_id: "msg-1", chat_name: "Dev group" },
        read: false,
        archived: false,
        created_at: at,
      },
      {
        id: "autopilot-run",
        type: "autopilot_run_completed",
        issue_id: null,
        title: "Daily summary completed",
        read: false,
        archived: false,
        created_at: at,
      },
    ]);
    renderInbox();

    fireEvent.click(await screen.findByRole("button", { name: "Message stream" }));
    expect(screen.getByText("feishu-message")).toBeInTheDocument();
    expect(screen.queryByText("autopilot-run")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Automation" }));
    expect(screen.getByText("autopilot-run")).toBeInTheDocument();
    expect(screen.queryByText("feishu-message")).not.toBeInTheDocument();
  });

  it("renders same-issue ledger history independently from newer action rows", async () => {
    listInbox.mockResolvedValue([
      {
        id: "mention-latest",
        type: "comment_mention",
        issue_id: "issue-1",
        title: "Mention",
        severity: "info",
        read: false,
        archived: false,
        created_at: "2026-08-25T10:04:00.000Z",
      },
      {
        id: "assignment-hidden",
        type: "issue_assigned",
        issue_id: "issue-1",
        title: "Assignment",
        severity: "info",
        read: false,
        archived: false,
        created_at: "2026-08-25T10:03:00.000Z",
      },
      {
        id: "run-failed",
        type: "autopilot_run_failed",
        issue_id: "issue-1",
        title: "Run failed",
        severity: "attention",
        read: false,
        archived: false,
        created_at: "2026-08-25T10:02:00.000Z",
      },
      {
        id: "run-completed",
        type: "autopilot_run_completed",
        issue_id: "issue-1",
        title: "Run completed",
        severity: "info",
        read: false,
        archived: false,
        created_at: "2026-08-25T10:01:00.000Z",
      },
    ]);
    renderInbox();

    expect(await screen.findByText("mention-latest")).toBeInTheDocument();
    expect(screen.queryByText("assignment-hidden")).not.toBeInTheDocument();
    expect(screen.getByText("run-failed")).toBeInTheDocument();
    expect(screen.getByText("run-completed")).toBeInTheDocument();

    fireEvent.click(screen.getByText("run-failed"));
    expect(replace).toHaveBeenLastCalledWith("/test/inbox?item=run-failed");
    fireEvent.click(screen.getByRole("button", { name: "Select Review session" }));
    expect(replace).toHaveBeenLastCalledWith(
      "/test/inbox?item=run-failed&session=session-review",
    );
    fireEvent.click(screen.getByText("mention-latest"));
    expect(replace).toHaveBeenLastCalledWith("/test/inbox?issue=issue-1");
  });

  it("links an issue-less notification by inbox id instead of claiming it is an issue", async () => {
    listInbox.mockResolvedValue([
      {
        id: "legacy-failure",
        type: "quick_create_failed",
        issue_id: null,
        title: "legacy-failure",
        severity: "attention",
        read: false,
        archived: false,
        created_at: "2026-08-25T10:00:00.000Z",
      },
    ]);
    renderInbox();

    fireEvent.click(await screen.findByText("legacy-failure"));

    expect(replace).toHaveBeenLastCalledWith("/test/inbox?item=legacy-failure");
    expect(
      replace.mock.calls.some(([path]) => String(path).startsWith("/test/issues/")),
    ).toBe(false);
  });

  it("marks the unread rows in a date group as read", async () => {
    const now = new Date().toISOString();
    listInbox.mockResolvedValue([
      { id: "today-1", type: "comment_mention", issue_id: null, title: "One", read: false, archived: false, created_at: now },
      { id: "today-2", type: "issue_assigned", issue_id: null, title: "Two", read: false, archived: false, created_at: now },
    ]);
    renderInbox();

    fireEvent.click(await screen.findByRole("button", { name: "Mark group as read" }));
    expect(markItemsRead).toHaveBeenCalledWith(
      ["today-1", "today-2"],
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });

  it("applies collapsed-run read and archive operations to every covered row", async () => {
    const details = { autopilot_id: "autopilot-1", autopilot_title: "Atlas" };
    listInbox.mockResolvedValue([
      {
        id: "run-latest",
        type: "autopilot_run_completed",
        issue_id: null,
        title: "Latest",
        severity: "info",
        details,
        read: false,
        archived: false,
        created_at: "2026-08-27T10:00:00.000Z",
      },
      {
        id: "run-earlier",
        type: "autopilot_run_completed",
        issue_id: null,
        title: "Earlier",
        severity: "info",
        details,
        read: false,
        archived: false,
        created_at: "2026-08-27T09:00:00.000Z",
      },
    ]);
    renderInbox();

    fireEvent.click(await screen.findByRole("button", { name: "run-latest (2)" }));
    await waitFor(() => expect(markItemsRead).toHaveBeenCalledWith(
      ["run-latest", "run-earlier"],
      expect.objectContaining({ onError: expect.any(Function) }),
    ));

    fireEvent.click(screen.getByRole("button", { name: "Archive run-latest" }));
    expect(archiveItems).toHaveBeenCalledWith(
      ["run-latest", "run-earlier"],
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });

  it("opens issue notifications in place and keeps Session routing under inbox", async () => {
    listInbox.mockResolvedValue([
      {
        id: "inbox-1",
        workspace_id: "ws-1",
        user_id: "user-1",
        type: "comment",
        issue_id: "issue-1",
        title: "Needs review",
        body: null,
        details: { issue_session_id: "session-notification" },
        read: true,
        archived: false,
        created_at: "2026-01-01T00:00:00Z",
      },
    ]);
    renderInbox();

    fireEvent.click(await screen.findByTestId("inbox-row"));

    expect(screen.getByTestId("issue-detail")).toHaveTextContent("issue-1");
    expect(screen.getByTestId("issue-detail")).toHaveAttribute(
      "data-session-route-owned",
      "true",
    );
    expect(screen.getByTestId("issue-detail")).toHaveAttribute(
      "data-initial-session",
      "session-notification",
    );
    expect(replace).toHaveBeenLastCalledWith(
      "/test/inbox?issue=issue-1&session=session-notification",
    );

    fireEvent.click(screen.getByRole("button", { name: "Select Review session" }));
    expect(replace).toHaveBeenLastCalledWith(
      "/test/inbox?issue=issue-1&session=session-review",
    );
    expect(
      replace.mock.calls.every(([path]) => String(path).startsWith("/test/inbox")),
    ).toBe(true);
  });

  it("opens a structured autopilot report before IssueDetail even when the row has an issue", async () => {
    listInbox.mockResolvedValue([{
      id: "run-inbox-1",
      workspace_id: "ws-1",
      recipient_type: "member",
      recipient_id: "member-1",
      actor_type: "system",
      actor_id: null,
      type: "autopilot_run_completed",
      severity: "info",
      issue_id: "issue-1",
      issue_status: null,
      title: "Atlas",
      body: "Completed in 2m",
      details: {
        autopilot_id: "autopilot-1",
        autopilot_title: "Atlas",
        run_id: "run-1",
        outcome: {
          kind: "no_change",
          headline: null,
          text: null,
          links: [],
          counts: null,
          risks: [],
          action: { kind: "none", text: null },
        },
      },
      read: true,
      archived: false,
      created_at: "2026-08-28T05:28:37.614Z",
    }]);

    renderInbox();
    fireEvent.click(await screen.findByTestId("inbox-row"));

    expect(screen.getByTestId("autopilot-run-report")).toHaveTextContent("run-inbox-1");
    expect(screen.queryByTestId("issue-detail")).not.toBeInTheDocument();
  });

  it("uses single-run title and archive semantics after opening a child from a grouped report", async () => {
    const details = (runId: string, branch: string) => ({
      autopilot_id: "autopilot-1",
      autopilot_title: "Atlas",
      run_id: runId,
      trigger_object: {
        event_type: "default_branch.updated",
        repository_id: "repo-1",
        repository_name: "Remi",
        change_number: null,
        change_title: null,
        target_branch: branch,
        source_revision: null,
        occurred_at: "2026-08-28T05:28:37.614Z",
        wiki_build: true,
      },
      outcome: {
        kind: "no_change",
        headline: null,
        text: null,
        links: [],
        counts: null,
        risks: [],
        action: { kind: "none", text: null },
      },
    });
    listInbox.mockResolvedValue([
      {
        id: "run-latest",
        type: "autopilot_run_completed",
        issue_id: "issue-1",
        title: "Latest",
        severity: "info",
        details: details("run-1", "main"),
        read: true,
        archived: false,
        created_at: "2026-08-28T10:00:00.000Z",
      },
      {
        id: "run-earlier",
        type: "autopilot_run_completed",
        issue_id: "issue-1",
        title: "Earlier",
        severity: "info",
        details: details("run-2", "release"),
        read: true,
        archived: false,
        created_at: "2026-08-28T09:00:00.000Z",
      },
    ]);

    renderInbox();
    fireEvent.click(await screen.findByRole("button", { name: "run-latest (2)" }));
    fireEvent.click(screen.getByRole("button", { name: "Select child run" }));

    expect(screen.getByTestId("autopilot-run-report")).toHaveTextContent("run-earlier");
    expect(screen.getByRole("heading", { name: "Atlas · Remi@release" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(archiveItems).toHaveBeenLastCalledWith(
      ["run-earlier"],
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });

  it("prefers a deep-linked Session over the notification Session", async () => {
    navigationState.searchParams = new URLSearchParams(
      "issue=issue-1&session=session-url",
    );
    listInbox.mockResolvedValue([
      {
        id: "inbox-1",
        workspace_id: "ws-1",
        user_id: "user-1",
        type: "comment",
        issue_id: "issue-1",
        title: "Needs review",
        body: null,
        details: { issue_session_id: "session-notification" },
        read: true,
        archived: false,
        created_at: "2026-01-01T00:00:00Z",
      },
    ]);

    renderInbox();

    expect(await screen.findByTestId("issue-detail")).toHaveAttribute(
      "data-initial-session",
      "session-url",
    );
  });

  it("preserves a Session deep link when falling back to the issue page", async () => {
    navigationState.searchParams = new URLSearchParams(
      "issue=issue-missing&session=session-main",
    );
    listInbox.mockResolvedValue([]);

    renderInbox();

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith(
        "/test/issues/issue-missing?session=session-main",
      );
    });
  });

  it("keeps an unavailable ledger item link in the inbox instead of treating it as an issue", async () => {
    navigationState.searchParams = new URLSearchParams("item=inbox-missing");
    listInbox.mockResolvedValue([]);

    renderInbox();

    expect(
      await screen.findByText("This notification is no longer available"),
    ).toBeInTheDocument();
    expect(replace).toHaveBeenCalledWith("/test/inbox");
    expect(
      replace.mock.calls.some(([path]) => String(path).startsWith("/test/issues/")),
    ).toBe(false);
  });

  it("renders detached ledger history without an issue detail or broken navigation", async () => {
    navigationState.searchParams = new URLSearchParams("item=run-detached");
    listInbox.mockResolvedValue([{
      id: "run-detached",
      workspace_id: "ws-1",
      recipient_type: "member",
      recipient_id: "member-1",
      actor_type: "system",
      actor_id: null,
      type: "autopilot_run_failed",
      severity: "attention",
      issue_id: null,
      issue_status: null,
      title: "Nightly cleanup failed",
      body: "Failed after 12s · scheduled · disk full",
      details: { issue_id: "issue-deleted" },
      read: true,
      archived: false,
      created_at: "2026-08-25T10:00:00.000Z",
    }]);

    renderInbox();

    expect(await screen.findByText("Nightly cleanup failed")).toBeInTheDocument();
    expect(screen.getByText("Failed after 12s · scheduled · disk full")).toBeInTheDocument();
    expect(screen.queryByTestId("issue-detail")).not.toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });
});
