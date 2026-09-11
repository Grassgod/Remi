// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type {
  Agent,
  ChatSession,
  PendingChatTasksResponse,
} from "@multiremi/core/types";
import { setCurrentWorkspace } from "@multiremi/core/platform";
import enChat from "../../locales/en/chat.json";
import enIssues from "../../locales/en/issues.json";

const state = vi.hoisted(() => ({
  tasks: [] as unknown[],
  update: vi.fn(),
  remove: vi.fn(),
  select: vi.fn(),
  activeId: null as string | null,
}));

vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: ({ actorId }: { actorId: string }) => (
    <span data-testid={`avatar-${actorId}`} />
  ),
}));

vi.mock("@multiremi/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@tanstack/react-query", () => ({
  queryOptions: (options: unknown) => options,
  infiniteQueryOptions: (options: unknown) => options,
  useQuery: () => ({ data: { tasks: state.tasks } }),
  useInfiniteQuery: () => ({ data: undefined }),
  useQueryClient: () => ({
    setQueryData: vi.fn(),
    invalidateQueries: vi.fn(),
  }),
}));

vi.mock("@multiremi/core/chat/mutations", () => ({
  useCreateChatSession: () => ({ mutateAsync: vi.fn() }),
  useDeleteChatSession: () => ({ mutate: state.remove, isPending: false }),
  useMarkChatSessionRead: () => ({ mutate: vi.fn() }),
  useUpdateChatSession: () => ({ mutate: state.update, isPending: false }),
}));

vi.mock("@multiremi/core/chat", () => ({
  useChatStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        setActiveSession: state.select,
        activeSessionId: state.activeId,
      }),
    {
      getState: () => ({
        setActiveSession: state.select,
        activeSessionId: state.activeId,
      }),
    },
  ),
  reconcileSettledPendingChatTask: vi.fn(),
}));

import { SessionDropdown } from "./session-dropdown";

beforeEach(() => setCurrentWorkspace("demo", "ws-1"));

const TEST_RESOURCES = { en: { chat: enChat, issues: enIssues } };

const agent = { id: "agent-1", name: "Alpha" } as Agent;

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "session-1",
    workspace_id: "ws-1",
    agent_id: "agent-1",
    title: "Ship the release",
    status: "active",
    has_unread: false,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    ...overrides,
  } as ChatSession;
}

function pendingTask(
  sessionId: string,
): PendingChatTasksResponse["tasks"][number] {
  return {
    task_id: "task-1",
    chat_session_id: sessionId,
    status: "running",
    created_at: new Date(0).toISOString(),
  } as PendingChatTasksResponse["tasks"][number];
}

function renderDropdown(sessions: ChatSession[]) {
  const view = render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <SessionDropdown
        sessions={sessions}
        agents={[agent]}
        activeSessionId={null}
        onSelectSession={vi.fn()}
      />
    </I18nProvider>,
  );
  const rerenderWith = (next: ChatSession[]) =>
    view.rerender(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <SessionDropdown
          sessions={next}
          agents={[agent]}
          activeSessionId={null}
          onSelectSession={vi.fn()}
        />
      </I18nProvider>,
    );
  return { rerenderWith };
}

function openHistory() {
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
}

describe("SessionDropdown history row", () => {
  beforeEach(() => {
    state.tasks = [];
    state.update.mockReset();
    state.remove.mockReset();
    state.select.mockReset();
  });

  it("keeps rename and delete reachable from the keyboard, not just on hover", () => {
    renderDropdown([makeSession()]);
    openHistory();

    const rename = screen.getByRole("button", { name: "Rename chat session" });
    const actions = rename.parentElement!;

    // `hidden` alone leaves the row's only rename/delete/stop surface
    // unreachable without a mouse: display:none descendants aren't focusable,
    // and the row itself is the thing that takes focus.
    expect(actions).toHaveClass("group-focus-within/history-row:flex");
    expect(actions).toHaveClass("group-hover/history-row:flex");

    // …and the status readout they replace has to yield the slot on focus
    // too, otherwise both occupy the row at once.
    const status = actions.previousElementSibling!;
    expect(status).toHaveClass("group-focus-within/history-row:hidden");
    expect(status).toHaveClass("group-hover/history-row:hidden");
  });

  it("flashes the completion check with the success token, not a palette literal", () => {
    state.tasks = [pendingTask("session-1")];
    const { rerenderWith } = renderDropdown([makeSession()]);
    openHistory();

    expect(screen.getByText("Working")).toBeInTheDocument();

    // Task settles while the user is looking at another chat.
    state.tasks = [];
    rerenderWith([makeSession({ has_unread: true })]);

    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(document.querySelector(".text-success")).not.toBeNull();
    expect(document.querySelector(".text-emerald-500")).toBeNull();
  });
});

describe("SessionDropdown management", () => {
  beforeEach(() => {
    state.tasks = [];
    state.update.mockReset();
    state.remove.mockReset();
    state.select.mockReset();
  });
  it("keeps archived conversations discoverable and restores them", () => {
    renderDropdown([makeSession({ status: "archived" })]);
    openHistory();
    expect(screen.queryByText("Ship the release")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Archived" }));
    expect(screen.getByText("Ship the release")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restore chat" }));
    expect(state.update).toHaveBeenCalledWith(
      { sessionId: "session-1", status: "active" },
      expect.any(Object),
    );
  });
  it("pins and archives a conversation through the session mutation", () => {
    renderDropdown([makeSession()]);
    openHistory();
    fireEvent.click(screen.getByRole("button", { name: "Pin chat" }));
    expect(state.update).toHaveBeenLastCalledWith(
      { sessionId: "session-1", pinned: true },
      expect.any(Object),
    );
    fireEvent.click(screen.getByRole("button", { name: "Archive chat" }));
    expect(state.update).toHaveBeenLastCalledWith(
      { sessionId: "session-1", status: "archived" },
      expect.any(Object),
    );
  });
  it("does not clear the selected conversation when deletion fails", () => {
    state.remove.mockImplementation((_id, callbacks) =>
      callbacks.onError(new Error("offline")),
    );
    render(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <SessionDropdown
          presentation="list"
          sessions={[makeSession()]}
          agents={[agent]}
          activeSessionId="session-1"
          onSelectSession={vi.fn()}
        />
      </I18nProvider>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Delete chat session" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(state.select).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});

it("keeps a newer selection when deletion of another conversation completes", () => {
  let deleted: (() => void) | undefined;
  state.remove.mockImplementation((_id, callbacks) => {
    deleted = callbacks.onSuccess;
  });
  state.tasks = [];
  state.select.mockReset();
  state.activeId = "session-1";
  const onSessionDeleted = vi.fn();
  render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <SessionDropdown
        presentation="list"
        sessions={[makeSession()]}
        agents={[agent]}
        activeSessionId="session-1"
        onSelectSession={vi.fn()}
        onSessionDeleted={onSessionDeleted}
      />
    </I18nProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Delete chat session" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  state.activeId = "session-2";
  deleted?.();
  expect(state.select).not.toHaveBeenCalled();
  expect(onSessionDeleted).not.toHaveBeenCalled();
});

it("allows archiving and pinning a running conversation and displays unread counts", () => {
  state.tasks = [pendingTask("session-1")];
  state.update.mockReset();
  renderDropdown([
    makeSession(),
    makeSession({
      id: "session-2",
      title: "Other conversation",
      has_unread: true,
      unread_count: 3,
    }),
  ]);
  openHistory();
  fireEvent.click(screen.getAllByRole("button", { name: "Pin chat" })[0]!);
  expect(state.update).toHaveBeenLastCalledWith(
    { sessionId: "session-1", pinned: true },
    expect.any(Object),
  );
  fireEvent.click(screen.getAllByRole("button", { name: "Archive chat" })[0]!);
  expect(state.update).toHaveBeenLastCalledWith(
    { sessionId: "session-1", status: "archived" },
    expect.any(Object),
  );
  expect(screen.getByText("3")).toBeInTheDocument();
});
