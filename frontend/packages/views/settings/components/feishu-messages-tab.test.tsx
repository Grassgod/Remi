import { useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type {
  FeishuEndpointHealth,
  FeishuMessage,
  FeishuMessageOutcome,
  FeishuSource,
  FeishuSourceStatus,
} from "@multiremi/core/feishu";
import enCommon from "../../locales/en/common.json";
import enSettings from "../../locales/en/settings.json";
import { NavigationProvider } from "../../navigation";
import type { NavigationAdapter } from "../../navigation";

const server = vi.hoisted(() => ({
  role: "owner" as string | undefined,
  endpoints: null as { configured: boolean; endpoints: unknown[] } | null,
  endpointsPending: false,
  endpointsError: false,
  sources: null as { sources: unknown[]; total: number } | null,
  sourcesPending: false,
  statuses: {} as Record<string, unknown>,
  messages: null as Record<string, unknown> | null,
  messagesPending: false,
  messagesFetching: false,
  messagesError: false,
  chats: { chats: [] as unknown[], total: 0 },
  availableChats: { chats: [] as unknown[], total: 0, limit: 0 },
  isMobile: false,
}));

/** Every option factory call, so a test can assert what the component asked the
 *  server for — including the `enabled` flag that keeps a Member from ever
 *  issuing the operator-only requests. */
const calls = vi.hoisted(() => ({
  endpoints: [] as { enabled: boolean }[],
  sources: [] as { enabled: boolean }[],
  statuses: [] as { sourceId: string; enabled: boolean }[],
  messages: [] as Record<string, unknown>[],
  availableChats: [] as { sourceId: string; enabled: boolean }[],
}));

const mutations = vi.hoisted(() => ({
  check: { mutate: vi.fn(), isPending: false },
  create: { mutate: vi.fn(), isPending: false },
  update: { mutate: vi.fn(), isPending: false },
  remove: { mutate: vi.fn(), isPending: false },
  resolve: { mutate: vi.fn(), isPending: false },
  notify: { mutate: vi.fn(), isPending: false },
  draft: { mutate: vi.fn(), isPending: false },
  propose: { mutate: vi.fn(), isPending: false },
  approve: { mutate: vi.fn(), isPending: false },
  reject: { mutate: vi.fn(), isPending: false },
}));

vi.mock("@tanstack/react-query", () => {
  const resolve = (options: { __kind?: string; enabled?: boolean; sourceId?: string }) => {
    const idle = { data: undefined, isPending: false, isError: false, isFetching: false, dataUpdatedAt: 0 };
    if (options.enabled === false) return idle;
    switch (options.__kind) {
      case "members":
        return {
          data: server.role ? [{ user_id: "user-1", role: server.role }] : [],
          isPending: false,
          isError: false,
          isFetching: false,
          dataUpdatedAt: 1,
        };
      case "endpoints":
        return {
          data: server.endpoints ?? undefined,
          isPending: server.endpointsPending,
          isError: server.endpointsError,
          isFetching: false,
          dataUpdatedAt: 1,
        };
      case "sources":
        return {
          data: server.sources ?? undefined,
          isPending: server.sourcesPending,
          isError: false,
          isFetching: false,
          dataUpdatedAt: 1,
        };
      case "source-status":
        return {
          data: server.statuses[options.sourceId ?? ""],
          isPending: false,
          isError: false,
          isFetching: false,
          dataUpdatedAt: 1,
        };
      case "messages":
        return {
          data: server.messages ?? undefined,
          isPending: server.messagesPending,
          isError: server.messagesError,
          isFetching: server.messagesFetching,
          dataUpdatedAt: 1,
        };
      case "chats":
        return { data: server.chats, isPending: false, isError: false, isFetching: false, dataUpdatedAt: 1 };
      case "available-chats":
        return {
          data: server.availableChats,
          isPending: false,
          isError: false,
          isFetching: false,
          dataUpdatedAt: 1,
        };
      default:
        return idle;
    }
  };
  return {
    useQuery: resolve,
    useQueries: ({ queries }: { queries: { __kind?: string; enabled?: boolean; sourceId?: string }[] }) =>
      queries.map(resolve),
  };
});

vi.mock("@multiremi/core/feishu", async () => {
  const state = await import("@multiremi/core/feishu/state");
  // The inbox helpers are pure functions with no query/mutation surface, so the
  // real implementations are what we want under test.
  const inbox = await import("@multiremi/core/feishu/inbox");
  return {
    ...state,
    ...inbox,
    feishuEndpointsOptions: (_workspaceId: string, enabled = true) => {
      calls.endpoints.push({ enabled });
      return { __kind: "endpoints", enabled };
    },
    feishuSourcesOptions: (_workspaceId: string, enabled = true) => {
      calls.sources.push({ enabled });
      return { __kind: "sources", enabled };
    },
    feishuSourceStatusOptions: (_workspaceId: string, sourceId: string, enabled = true) => {
      calls.statuses.push({ sourceId, enabled });
      return { __kind: "source-status", sourceId, enabled };
    },
    feishuMessagesOptions: (_workspaceId: string, params: Record<string, unknown>) => {
      calls.messages.push(params);
      return { __kind: "messages", enabled: true };
    },
    feishuChatsOptions: () => ({ __kind: "chats", enabled: true }),
    feishuAvailableChatsOptions: (
      _workspaceId: string,
      sourceId: string,
      _params: unknown,
      enabled = true,
    ) => {
      calls.availableChats.push({ sourceId, enabled });
      return { __kind: "available-chats", sourceId, enabled };
    },
    useCheckFeishuEndpoint: () => mutations.check,
    useCreateFeishuSource: () => mutations.create,
    useUpdateFeishuSource: () => mutations.update,
    useDeleteFeishuSource: () => mutations.remove,
    useResolveFeishuMessage: () => mutations.resolve,
    useNotifyFeishuMessage: () => mutations.notify,
    useDraftFeishuMessageReply: () => mutations.draft,
    useProposeFeishuMessageIssue: () => mutations.propose,
    useApproveFeishuProposal: () => mutations.approve,
    useRejectFeishuProposal: () => mutations.reject,
  };
});

vi.mock("@multiremi/core/auth", () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) => selector({ user: { id: "user-1" } }),
}));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multiremi/core/workspace/queries", () => ({
  memberListOptions: () => ({ __kind: "members", enabled: true }),
}));
vi.mock("@multiremi/ui/hooks/use-mobile", () => ({ useIsMobile: () => server.isMobile }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Base UI renders menu content in a portal behind a real pointer interaction
// that jsdom cannot simulate faithfully. Rendering the items inline keeps these
// tests about what the actions do, not about popup mechanics.
vi.mock("@multiremi/ui/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => null,
  DropdownMenuTrigger: () => null,
  DropdownMenuItem: ({ children, onClick, disabled }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" role="menuitem" onClick={onClick} disabled={disabled === true}>
      {children}
    </button>
  ),
}));

import { FeishuMessagesTab } from "./feishu-messages-tab";

const TEST_RESOURCES = { en: { common: enCommon, settings: enSettings } };

function endpoint(overrides: Partial<FeishuEndpointHealth> = {}): FeishuEndpointHealth {
  return {
    name: "personal",
    status: "ready",
    checkedAt: "2026-08-27T09:00:00.000Z",
    latencyMs: 14,
    version: "0.4.1",
    capabilities: ["messages"],
    errorCode: null,
    sourceCount: 1,
    ...overrides,
  };
}

function source(overrides: Partial<FeishuSource> = {}): FeishuSource {
  return {
    id: "src-1",
    workspaceId: "ws-1",
    name: "Personal automation",
    type: "personal_automation",
    endpointName: "personal",
    allowlist: [{ chatId: "oc_alpha", addedAt: "2026-08-01T00:00:00.000Z" }],
    enabled: true,
    retentionDays: 30,
    pollIntervalSeconds: 60,
    unprocessedRetrySeconds: 900,
    unprocessedRetryLimit: 3,
    accessTokenSet: true,
    accessTokenHint: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function status(overrides: Partial<FeishuSourceStatus> = {}): FeishuSourceStatus {
  return {
    sourceId: "src-1",
    unprocessedCount: 3,
    timedOutCount: 1,
    mutedDeliveryCount: 0,
    pendingIssueProposalCount: 2,
    oldestUnprocessedAt: "2026-08-27T08:00:00.000Z",
    maximumRetryCount: 1,
    lastSuccessfulIngestAt: "2026-08-27T08:58:00.000Z",
    lastErrorCode: null,
    lastErrorAt: null,
    lagSeconds: 120,
    consecutiveFailures: 0,
    connectionAlertedAt: null,
    connectionAlertDeliveryFailureCount: 0,
    connectionAlertDeliveryErrorCode: null,
    connectionAlertDeliveryFailedAt: null,
    ...overrides,
  };
}

function outcome(overrides: Partial<FeishuMessageOutcome> = {}): FeishuMessageOutcome {
  return {
    id: "out-1",
    workspaceId: "ws-1",
    messageId: "om_1",
    outcomeKind: "issue_proposed",
    ref: "prop-1",
    reason: null,
    taskId: null,
    createdAt: "2026-08-27T09:00:00.000Z",
    ...overrides,
  };
}

function message(overrides: Partial<FeishuMessage> = {}): FeishuMessage {
  return {
    messageId: "om_1",
    workspaceId: "ws-1",
    sourceId: "src-1",
    chatId: "oc_alpha",
    chatType: "group",
    chatName: "Ops room",
    threadId: null,
    rootId: null,
    parentId: null,
    sender: { name: "Wang Li" },
    content: {},
    searchableText: "The nightly sync failed again",
    contentFingerprint: "fp-1",
    messageAppLink: null,
    createdAt: "2026-08-27T09:00:00.000Z",
    updatedAt: null,
    recalled: false,
    edited: false,
    ingestedAt: "2026-08-27T09:00:05.000Z",
    processedAt: null,
    retryCount: 0,
    lastRetryAt: null,
    outcomes: [],
    ...overrides,
  };
}

function messageList(messages: FeishuMessage[], overrides: Record<string, unknown> = {}) {
  return { messages, total: messages.length, limit: 25, offset: 0, hasMore: false, ...overrides };
}

/** The tab reads and writes filters through the navigation adapter, so the
 *  harness has to behave like a real URL bar: a `replace` must be visible on the
 *  next render's `searchParams`. */
function renderTab() {
  const replace = vi.fn();
  function Harness() {
    const [search, setSearch] = useState("");
    const adapter: NavigationAdapter = {
      push: vi.fn(),
      replace: (path: string) => {
        replace(path);
        const index = path.indexOf("?");
        setSearch(index === -1 ? "" : path.slice(index + 1));
      },
      back: vi.fn(),
      pathname: "/acme/settings",
      searchParams: new URLSearchParams(search),
      getShareableUrl: (path: string) => path,
    };
    return (
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <NavigationProvider value={adapter}>
          <FeishuMessagesTab />
        </NavigationProvider>
      </I18nProvider>
    );
  }
  render(<Harness />);
  return { replace };
}

function lastMessageParams() {
  return calls.messages[calls.messages.length - 1] ?? {};
}

beforeEach(() => {
  vi.clearAllMocks();
  server.role = "owner";
  server.endpoints = { configured: true, endpoints: [endpoint()] };
  server.endpointsPending = false;
  server.endpointsError = false;
  server.sources = { sources: [], total: 0 };
  server.sourcesPending = false;
  server.statuses = {};
  server.messages = messageList([]);
  server.messagesPending = false;
  server.messagesFetching = false;
  server.messagesError = false;
  server.chats = { chats: [], total: 0 };
  server.availableChats = { chats: [], total: 0, limit: 0 };
  server.isMobile = false;
  calls.endpoints = [];
  calls.sources = [];
  calls.statuses = [];
  calls.messages = [];
  calls.availableChats = [];
});

describe("ingestion service panel", () => {
  it("reports a reachable sidecar with its name, version and latency", () => {
    renderTab();
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByText("personal")).toBeTruthy();
    expect(screen.getByText("0.4.1")).toBeTruthy();
    expect(screen.getByText("14 ms")).toBeTruthy();
  });

  it("never renders an internal address for the endpoint", () => {
    // The API returns a registered name and health only. This asserts the
    // contract end-to-end: nothing URL-shaped may reach the DOM, because a URL
    // on screen is a URL the panel could round-trip back to the server.
    server.endpoints = {
      configured: true,
      endpoints: [{ ...endpoint(), url: "http://127.0.0.1:8042" } as FeishuEndpointHealth],
    };
    renderTab();
    expect(document.body.innerHTML).not.toContain("127.0.0.1");
    expect(document.body.innerHTML).not.toContain("8042");
  });

  it("reports an unreachable sidecar with its error code", () => {
    server.endpoints = {
      configured: true,
      endpoints: [endpoint({ status: "unreachable", errorCode: "connection_refused" })],
    };
    renderTab();
    expect(screen.getByText("Unreachable")).toBeTruthy();
    expect(screen.getAllByText(/connection_refused/).length).toBeGreaterThan(0);
  });

  it("tells the operator to register a sidecar when none is configured", () => {
    server.endpoints = { configured: false, endpoints: [] };
    renderTab();
    expect(screen.getByText("Not configured")).toBeTruthy();
    expect(screen.getByText(/No ingestion sidecar is registered/)).toBeTruthy();
    // Nothing to probe, so no button that would probe it.
    expect(screen.queryByRole("button", { name: /Check again/ })).toBeNull();
  });

  it("rechecks by endpoint name, never by address", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByRole("button", { name: /Check again/ }));
    expect(mutations.check.mutate).toHaveBeenCalledTimes(1);
    expect(mutations.check.mutate.mock.calls[0]?.[0]).toBe("personal");
  });
});

describe("permissions", () => {
  it("does not issue operator queries for a Member", () => {
    server.role = "member";
    renderTab();
    // Hiding the controls is not enough — the requests themselves must not be
    // made, or the data shows up in the network tab anyway.
    expect(calls.endpoints.every((call) => call.enabled === false)).toBe(true);
    expect(calls.sources.every((call) => call.enabled === false)).toBe(true);
    expect(screen.getByText(/Only workspace owners and admins can see the ingestion service/)).toBeTruthy();
    expect(screen.getByText(/Only workspace owners and admins can manage message sources/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /New source/ })).toBeNull();
  });

  it("issues them for an Admin", () => {
    server.role = "admin";
    renderTab();
    expect(calls.endpoints.some((call) => call.enabled === true)).toBe(true);
    expect(screen.getByRole("button", { name: /New source/ })).toBeTruthy();
  });
});

describe("message sources", () => {
  it("flags an enabled source whose allowlist is empty", () => {
    // An empty allowlist ingests nothing. The row has to say that instead of
    // showing a healthy state next to a pipeline that moves zero messages.
    server.sources = { sources: [source({ allowlist: [] })], total: 1 };
    server.statuses = { "src-1": status() };
    renderTab();
    expect(screen.getByText("Empty allowlist")).toBeTruthy();
  });

  it("blocks every source while the sidecar is unreachable", () => {
    server.endpoints = { configured: true, endpoints: [endpoint({ status: "unreachable" })] };
    server.sources = { sources: [source()], total: 1 };
    renderTab();
    expect(screen.getByText("Blocked")).toBeTruthy();
  });

  it("shows the backlog counters an operator triages by", () => {
    server.sources = { sources: [source()], total: 1 };
    server.statuses = { "src-1": status() };
    renderTab();
    expect(screen.getByText(/3 unprocessed · 1 timed out · 0 muted · 2 proposals/)).toBeTruthy();
    expect(screen.getByText("2m")).toBeTruthy();
  });

  it("requires a second confirmation before deleting a source", async () => {
    const user = userEvent.setup();
    server.sources = { sources: [source()], total: 1 };
    server.statuses = { "src-1": status() };
    renderTab();

    await user.click(screen.getByRole("menuitem", { name: /Delete/ }));
    expect(mutations.remove.mutate).not.toHaveBeenCalled();

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/Delete Personal automation\?/)).toBeTruthy();
    // The counts are what make this a real confirmation rather than a speed bump.
    expect(within(dialog).getByText(/1 chats, 3 unprocessed messages and 2 pending proposals/)).toBeTruthy();

    await user.click(within(dialog).getByRole("button", { name: /^Delete source$/ }));
    expect(mutations.remove.mutate).toHaveBeenCalledTimes(1);
    expect(mutations.remove.mutate.mock.calls[0]?.[0]).toBe("src-1");
  });

  it("requires a second confirmation before pausing a source", async () => {
    const user = userEvent.setup();
    server.sources = { sources: [source()], total: 1 };
    renderTab();

    await user.click(screen.getByRole("menuitem", { name: /^Pause$/ }));
    expect(mutations.update.mutate).not.toHaveBeenCalled();

    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /^Pause source$/ }));
    expect(mutations.update.mutate).toHaveBeenCalledTimes(1);
    expect(mutations.update.mutate.mock.calls[0]?.[0]).toEqual({
      sourceId: "src-1",
      input: { enabled: false },
    });
  });

  it("enables a paused source directly, since that is the reversible direction", async () => {
    const user = userEvent.setup();
    server.sources = { sources: [source({ enabled: false })], total: 1 };
    renderTab();

    await user.click(screen.getByRole("menuitem", { name: /^Enable$/ }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(mutations.update.mutate.mock.calls[0]?.[0]).toEqual({
      sourceId: "src-1",
      input: { enabled: true },
    });
  });

  it("renders cards instead of a table on a phone", () => {
    server.isMobile = true;
    server.sources = { sources: [source()], total: 1 };
    renderTab();
    // Mutually exclusive rather than CSS-hidden, so there is exactly one copy
    // of every action in the accessibility tree.
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getAllByRole("menuitem", { name: /Delete/ })).toHaveLength(1);
  });
});

describe("source dialog", () => {
  it("offers registered endpoint names and no address field", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByRole("button", { name: /New source/ }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Ingestion endpoint")).toBeTruthy();
    // No text input anywhere in the dialog accepts a URL: the endpoint control
    // is a Select over server-registered names.
    for (const field of within(dialog).getAllByRole("textbox")) {
      expect(field.getAttribute("type")).not.toBe("url");
    }
    expect(within(dialog).getByText(/Endpoints are registered by an operator/)).toBeTruthy();
  });

  it("warns that an empty allowlist ingests nothing and defers chat selection", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByRole("button", { name: /New source/ }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/An empty allowlist ingests nothing/)).toBeTruthy();
    expect(within(dialog).getByText(/Chats can be added after the source exists/)).toBeTruthy();
    // The directory is source-scoped, so the create dialog must not query it.
    expect(calls.availableChats.every((call) => call.enabled === false)).toBe(true);
  });
});

describe("message list", () => {
  it("shows the ingested messages with their processing state", () => {
    server.messages = messageList([
      message(),
      message({ messageId: "om_2", processedAt: "2026-08-27T09:10:00.000Z", searchableText: "Handled" }),
    ]);
    renderTab();
    expect(screen.getByText("The nightly sync failed again")).toBeTruthy();
    // Scoped to the cards: the same words label the segmented state filter.
    const cards = screen.getAllByRole("listitem");
    expect(within(cards[0]!).getByText("Unprocessed")).toBeTruthy();
    expect(within(cards[1]!).getByText("Processed")).toBeTruthy();
    expect(screen.getByText("Showing 2 of 2")).toBeTruthy();
  });

  it("filters by processing state through the URL", async () => {
    const user = userEvent.setup();
    server.messages = messageList([message()]);
    const { replace } = renderTab();

    await user.click(screen.getByRole("button", { name: "Unprocessed", pressed: false }));

    expect(replace).toHaveBeenCalledWith("/acme/settings?processed=unprocessed");
    await waitFor(() => expect(lastMessageParams().processed).toBe(false));
  });

  it("drops the filter from the URL when returning to All", async () => {
    const user = userEvent.setup();
    server.messages = messageList([message()]);
    const { replace } = renderTab();

    await user.click(screen.getByRole("button", { name: "Processed", pressed: false }));
    await waitFor(() => expect(lastMessageParams().processed).toBe(true));
    await user.click(screen.getByRole("button", { name: "All", pressed: false }));

    expect(replace).toHaveBeenLastCalledWith("/acme/settings");
    await waitFor(() => expect(lastMessageParams().processed).toBeUndefined());
  });

  it("debounces the text search before querying", async () => {
    const user = userEvent.setup();
    server.messages = messageList([message()]);
    renderTab();

    await user.type(screen.getByLabelText("Search message text"), "sync");
    // Mid-typing the query must not have moved yet.
    expect(lastMessageParams().q).toBeUndefined();

    await waitFor(() => expect(lastMessageParams().q).toBe("sync"), { timeout: 2000 });
  });

  it("converts the date range filters to timestamps", async () => {
    const user = userEvent.setup();
    server.messages = messageList([message()]);
    renderTab();

    await user.type(screen.getByLabelText("From date"), "2026-08-01");
    await waitFor(() => expect(lastMessageParams().since).toBe("2026-08-01T00:00:00.000Z"));
  });

  it("grows the window when loading more", async () => {
    const user = userEvent.setup();
    server.messages = messageList([message()], { total: 60, hasMore: true });
    renderTab();

    expect(lastMessageParams().limit).toBe(25);
    await user.click(screen.getByRole("button", { name: /Load more/ }));
    await waitFor(() => expect(lastMessageParams().limit).toBe(50));
    expect(lastMessageParams().offset).toBe(0);
  });

  it("distinguishes an empty result from an empty filtered result", async () => {
    const user = userEvent.setup();
    server.messages = messageList([]);
    renderTab();
    expect(screen.getByText("No messages ingested yet.")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Processed", pressed: false }));
    await waitFor(() => expect(screen.getByText("No message matches these filters.")).toBeTruthy());
  });

  it("surfaces a load failure instead of an empty list", () => {
    server.messagesError = true;
    server.messages = null;
    renderTab();
    expect(screen.getByText("Couldn't load messages")).toBeTruthy();
  });
});

describe("message actions", () => {
  it("requires a reason before ignoring a message", async () => {
    const user = userEvent.setup();
    server.messages = messageList([message()]);
    renderTab();

    await user.click(screen.getByRole("menuitem", { name: /^Ignore$/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^Confirm$/ }));
    expect(mutations.resolve.mutate).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("alert").textContent).toContain("A reason is required");

    await user.type(within(dialog).getByLabelText("Reason"), "duplicate report");
    await user.click(within(dialog).getByRole("button", { name: /^Confirm$/ }));
    expect(mutations.resolve.mutate.mock.calls[0]?.[0]).toEqual({
      messageId: "om_1",
      outcome: "ignored",
      reason: "duplicate report",
    });
  });

  it("drafts a reply without sending anything to Feishu", async () => {
    const user = userEvent.setup();
    server.messages = messageList([message()]);
    renderTab();

    await user.click(screen.getByRole("menuitem", { name: /Draft a reply/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/never sent to Feishu automatically/)).toBeTruthy();

    await user.type(within(dialog).getByLabelText("Draft reply"), "On it");
    await user.click(within(dialog).getByRole("button", { name: /^Confirm$/ }));
    expect(mutations.draft.mutate.mock.calls[0]?.[0]).toEqual({ messageId: "om_1", draftText: "On it" });
  });

  it("proposes an Issue seeded from the message text", async () => {
    const user = userEvent.setup();
    server.messages = messageList([message()]);
    renderTab();

    await user.click(screen.getByRole("menuitem", { name: /Propose an Issue/ }));
    const dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByLabelText("Issue title") as HTMLInputElement).value)
      .toBe("The nightly sync failed again");

    await user.click(within(dialog).getByRole("button", { name: /^Confirm$/ }));
    expect(mutations.propose.mutate.mock.calls[0]?.[0]).toEqual({
      messageId: "om_1",
      input: { title: "The nightly sync failed again", description: null },
    });
  });

  it("leaves a pending proposal for a human to approve or reject", async () => {
    const user = userEvent.setup();
    server.messages = messageList([message({ outcomes: [outcome()] })]);
    renderTab();

    expect(screen.getByText("1 pending proposals")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /^Approve$/ }));
    expect(mutations.approve.mutate).toHaveBeenCalledWith("prop-1");
  });

  it("stops offering approval once the proposal is settled", () => {
    server.messages = messageList([message({
      outcomes: [outcome(), outcome({ id: "out-2", outcomeKind: "issue_created", ref: "MUL-9" })],
    })]);
    renderTab();
    expect(screen.queryByRole("button", { name: /^Approve$/ })).toBeNull();
    expect(screen.getByText("Issue created")).toBeTruthy();
  });

  it("renders an outcome kind the server invented instead of blanking the row", () => {
    server.messages = messageList([message({
      outcomes: [outcome({ outcomeKind: "escalated_to_pager" })],
    })]);
    renderTab();
    expect(screen.getByText("escalated_to_pager")).toBeTruthy();
  });

  it("does not offer processing actions for an already-processed message", () => {
    server.messages = messageList([message({ processedAt: "2026-08-27T09:10:00.000Z" })]);
    renderTab();
    expect(screen.getByRole("menuitem", { name: /^Ignore$/ }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("menuitem", { name: /Mark processed/ }).hasAttribute("disabled")).toBe(true);
  });
});
