import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enInbox from "../../locales/en/inbox.json";

const TEST_RESOURCES = { en: { common: enCommon, inbox: enInbox } };

const listInbox = vi.hoisted(() => vi.fn());

vi.mock("@multiremi/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multiremi/core/paths", () => ({
  useWorkspacePaths: () => ({
    inbox: () => "/test/inbox",
    issueDetail: (id: string) => `/test/issues/${id}`,
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

vi.mock("@multiremi/core/inbox/queries", () => ({
  inboxListOptions: (wsId: string) => ({
    queryKey: ["inbox", wsId],
    queryFn: listInbox,
  }),
  deduplicateInboxItems: (items: unknown[]) => items,
  useInboxUnreadCount: () => 0,
}));

vi.mock("@multiremi/core/inbox/mutations", () => {
  const noopMutation = () => ({ mutate: vi.fn(), isPending: false });
  return {
    useMarkInboxRead: noopMutation,
    useArchiveInbox: noopMutation,
    useMarkAllInboxRead: noopMutation,
    useArchiveAllInbox: noopMutation,
    useArchiveAllReadInbox: noopMutation,
    useArchiveCompletedInbox: noopMutation,
  };
});

vi.mock("../../issues/components", () => ({
  IssueDetail: () => <div data-testid="issue-detail" />,
}));

const replace = vi.hoisted(() => vi.fn());
vi.mock("../../navigation", () => ({
  useNavigation: () => ({
    searchParams: new URLSearchParams(),
    replace,
    push: vi.fn(),
  }),
}));

vi.mock("./inbox-list-item", () => ({
  InboxListItem: ({ item }: { item: { id: string } }) => (
    <div data-testid="inbox-row">{item.id}</div>
  ),
  useTimeAgo: () => () => "just now",
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
});
