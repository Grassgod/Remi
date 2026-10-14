// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { setApiInstance } from "@multiremi/core/api";
import { chatKeys } from "@multiremi/core/chat/queries";
import { runtimeWorkspaceKeys } from "@multiremi/core/runtimes/workspaces";
import { setCurrentWorkspace } from "@multiremi/core/platform";
import type { ChatSession, PendingChatTasksResponse, Project } from "@multiremi/core/types";
import enChat from "../../locales/en/chat.json";
import { useSearchStore } from "../../search/search-store";

const state = vi.hoisted(() => ({
  update: vi.fn(),
  remove: vi.fn(),
  removePending: false,
  select: vi.fn(),
  activeId: null as string | null,
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

vi.mock("sonner", () => ({ toast: state.toast }));
vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: ({ actorId }: { actorId: string }) => <span data-testid={`avatar-${actorId}`} />,
}));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multiremi/core/chat/mutations", () => ({
  useUpdateChatSession: () => ({ mutateAsync: state.update, isPending: false }),
  useDeleteChatSession: () => ({ mutateAsync: state.remove, isPending: state.removePending }),
}));
vi.mock("@multiremi/core/chat", () => ({
  useChatStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({ setActiveSession: state.select, activeSessionId: state.activeId }),
    { getState: () => ({ setActiveSession: state.select, activeSessionId: state.activeId }) },
  ),
}));

import { ChatSidebar, groupChatSessions, visibleItems } from "./chat-sidebar";

const api = {
  listChatSessions: vi.fn(async () => [] as ChatSession[]),
  listPendingChatTasks: vi.fn(async () => ({ tasks: [] })),
  listRuntimeWorkspaces: vi.fn(async () => [{ id: "rws-1", name: "Workbench" }]),
  cancelTaskById: vi.fn(async () => undefined),
};

let clock = 0;
function chat(id: string, overrides: Partial<ChatSession> = {}): ChatSession {
  clock += 1;
  return {
    id, workspace_id: "ws-1", agent_id: `agent-${id}`, creator_id: "user-1", title: `Chat ${id}`,
    status: "active", has_unread: false, pinned: false, origin: null, unread_count: 0, last_message: null,
    project_id: null, runtime_workspace_id: null,
    created_at: "2026-10-01T00:00:00Z",
    // Later fixtures are newer unless a test says otherwise.
    updated_at: new Date(Date.UTC(2026, 9, 1, 0, 0, clock)).toISOString(),
    ...overrides,
  };
}

const projects = [
  { id: "project-1", title: "Remi", icon: null, archived_at: null },
  { id: "project-2", title: "Docs", icon: null, archived_at: null },
] as unknown as Project[];

function mount({
  sessions,
  automation = [],
  pending = { tasks: [] },
  activeSessionId = null,
  onNewChat = vi.fn(),
  onSelectSession = vi.fn(),
  onSessionDeleted = vi.fn(),
}: {
  sessions: ChatSession[];
  automation?: ChatSession[];
  pending?: PendingChatTasksResponse;
  activeSessionId?: string | null;
  onNewChat?: (location?: { project_id: string | null; runtime_workspace_id: string | null }) => void;
  onSelectSession?: (session: ChatSession) => void;
  onSessionDeleted?: () => void;
}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(chatKeys.sessionList("ws-1", "all", "automation"), automation);
  client.setQueryData(chatKeys.pendingTasks("ws-1"), pending);
  const ui = (list: ChatSession[]) => (
    <QueryClientProvider client={client}>
      <I18nProvider locale="en" resources={{ en: { chat: enChat } }}>
        <ChatSidebar
          sessions={list}
          projects={projects}
          activeSessionId={activeSessionId}
          loading={false}
          error={false}
          onRetry={vi.fn()}
          onSelectSession={onSelectSession}
          onNewChat={onNewChat}
          onSessionDeleted={onSessionDeleted}
        />
      </I18nProvider>
    </QueryClientProvider>
  );
  const view = render(ui(sessions));
  return { ...view, client, rerenderWith: (next: ChatSession[]) => view.rerender(ui(next)) };
}

const section = (name: string) => screen.getByRole("region", { name });
const rowTitles = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>("[data-chat-session-row]")].map(
    (row) => row.querySelector("[data-chat-row-title]")!.textContent,
  );
const row = (title: string) => screen.getByText(title).closest<HTMLElement>("[data-chat-session-row]")!;

function openMenu(title: string) {
  fireEvent.click(within(row(title)).getByRole("button", { name: "More actions" }));
}

beforeEach(() => {
  clock = 0;
  setCurrentWorkspace("demo", "ws-1");
  state.update.mockReset().mockResolvedValue({});
  state.remove.mockReset().mockResolvedValue(undefined);
  state.removePending = false;
  state.select.mockReset();
  state.activeId = null;
  state.toast.mockReset();
  state.toast.error.mockReset();
  for (const fn of Object.values(api)) fn.mockClear();
  setApiInstance(api as never);
  useSearchStore.setState({ open: false });
});

describe("groupChatSessions", () => {
  it("keeps pinned chats only under Pinned and bound chats only in their group", () => {
    const sessions = [
      chat("plain-old"),
      chat("project-a", { project_id: "project-1" }),
      chat("dir-a", { runtime_workspace_id: "rws-1" }),
      chat("pinned-project", { project_id: "project-1", pinned: true }),
      chat("project-b", { project_id: "project-2" }),
      chat("archived", { status: "archived" }),
      chat("plain-new"),
    ];
    const { pinned, groups, recent } = groupChatSessions(sessions);
    expect(pinned.map((s) => s.id)).toEqual(["pinned-project"]);
    // Groups follow their newest chat.
    expect(groups.map((g) => g.key)).toEqual(["project:project-2", "directory:rws-1", "project:project-1"]);
    expect(groups.find((g) => g.key === "project:project-1")!.sessions.map((s) => s.id)).toEqual(["project-a"]);
    expect(recent.map((s) => s.id)).toEqual(["plain-new", "plain-old"]);
  });

  it("does not hide a single item behind Show more, and keeps a requested item visible", () => {
    expect(visibleItems([1, 2, 3, 4, 5, 6], 5)).toHaveLength(6);
    expect(visibleItems([1, 2, 3, 4, 5, 6, 7], 5)).toEqual([1, 2, 3, 4, 5]);
    expect(visibleItems([1, 2, 3, 4, 5, 6, 7, 8], 5, (n) => n === 8)).toEqual([1, 2, 3, 4, 5, 8]);
  });

  it("counts hidden items after keeping the requested one", () => {
    // Keeping 7 leaves only 6 hidden: one item is not worth a Show more row.
    expect(visibleItems([1, 2, 3, 4, 5, 6, 7], 5, (n) => n === 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe("ChatSidebar sections", () => {
  it("groups chats by Project and directory and never repeats them under Recent or Pinned", async () => {
    mount({
      sessions: [
        chat("r1", { title: "Plain question" }),
        chat("p1", { title: "Ship sidebar", project_id: "project-1" }),
        chat("d1", { title: "Local build", runtime_workspace_id: "rws-1" }),
        chat("pin", { title: "Pinned plan", project_id: "project-1", pinned: true }),
        chat("p2", { title: "Docs rewrite", project_id: "project-2" }),
      ],
    });
    expect(rowTitles(section("Pinned"))).toEqual(["Pinned plan"]);
    expect(rowTitles(section("Recent"))).toEqual(["Plain question"]);
    const projectsSection = section("Projects");
    expect(within(projectsSection).getAllByRole("group").map((g) => g.getAttribute("aria-label")))
      .toEqual(["Docs", "…", "Remi"]);
    expect(rowTitles(within(projectsSection).getByRole("group", { name: "Remi" }))).toEqual(["Ship sidebar"]);
    // The directory name arrives from the runtime-workspace list.
    expect(await within(projectsSection).findByRole("group", { name: "Workbench" })).toBeInTheDocument();
    expect(rowTitles(within(projectsSection).getByRole("group", { name: "Workbench" }))).toEqual(["Local build"]);
  });

  it("reads runtime directories only when some chat is bound to one", async () => {
    mount({ sessions: [chat("r1"), chat("p1", { project_id: "project-1" })] });
    await act(async () => {});
    expect(api.listRuntimeWorkspaces).not.toHaveBeenCalled();
  });

  it("starts a new chat, or one bound to a group's Project or directory", () => {
    const onNewChat = vi.fn();
    const view = mount({
      sessions: [chat("p1", { project_id: "project-1" }), chat("d1", { runtime_workspace_id: "rws-1" })],
      onNewChat,
    });
    view.client.setQueryData(runtimeWorkspaceKeys.all("ws-1"), [{ id: "rws-1", name: "Workbench" }]);
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(onNewChat).toHaveBeenLastCalledWith();
    fireEvent.click(screen.getByRole("button", { name: "Start new chat in Remi" }));
    expect(onNewChat).toHaveBeenLastCalledWith({ project_id: "project-1", runtime_workspace_id: null });
  });

  it("opens the global search palette", () => {
    mount({ sessions: [chat("r1")] });
    fireEvent.click(screen.getByRole("button", { name: /Search/ }));
    expect(useSearchStore.getState().open).toBe(true);
  });

  it("pages Recent by ten and never hides a single chat", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => chat(`r${i}`));
    const view = mount({ sessions: eleven });
    expect(rowTitles(section("Recent"))).toHaveLength(11);
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
    view.unmount();

    mount({ sessions: Array.from({ length: 23 }, (_, i) => chat(`m${i}`)) });
    expect(rowTitles(section("Recent"))).toHaveLength(10);
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(rowTitles(section("Recent"))).toHaveLength(20);
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(rowTitles(section("Recent"))).toHaveLength(23);
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("shows five groups and five chats per group, each with its own Show more", () => {
    const sessions = [
      ...Array.from({ length: 7 }, (_, i) => chat(`g${i}`, { project_id: `project-x${i}` })),
      ...Array.from({ length: 7 }, (_, i) => chat(`remi${i}`, { project_id: "project-1" })),
    ];
    mount({ sessions });
    const projectsSection = section("Projects");
    const groups = within(projectsSection).getAllByRole("group");
    expect(groups).toHaveLength(5);
    const remi = within(projectsSection).getByRole("group", { name: "Remi" });
    expect(rowTitles(remi)).toHaveLength(5);
    fireEvent.click(within(remi).getByRole("button", { name: "Show more" }));
    expect(rowTitles(remi)).toHaveLength(7);
    // The group list pages separately.
    const more = within(projectsSection).getAllByRole("button", { name: "Show more" });
    fireEvent.click(more.at(-1)!);
    expect(within(projectsSection).getAllByRole("group")).toHaveLength(8);
  });

  it("shows running, needs-answer and unread state in the row status slot", () => {
    mount({
      sessions: [chat("a", { title: "Running chat" }), chat("b", { title: "Asking chat" }), chat("c", { title: "Unread chat", has_unread: true })],
      pending: { tasks: [
        { task_id: "task-a", chat_session_id: "a", status: "running" },
        { task_id: "task-b", chat_session_id: "b", status: "awaiting_human" },
      ] },
    });
    expect(within(row("Running chat")).getByRole("img", { name: "Running" })).toBeInTheDocument();
    expect(within(row("Asking chat")).getByText("Needs answer")).toBeInTheDocument();
    expect(within(row("Unread chat")).getByRole("img", { name: "New reply" })).toBeInTheDocument();
  });

  it("names rows as buttons by title and status, and calls an untitled chat Untitled", () => {
    mount({
      sessions: [chat("a", { title: "Running chat" }), chat("b", { title: "  " })],
      pending: { tasks: [{ task_id: "task-a", chat_session_id: "a", status: "running" }] },
    });
    expect(screen.getByRole("button", { name: "Running chat, Running" })).toHaveAttribute("data-chat-session-row", "a");
    expect(screen.getByRole("button", { name: "Untitled" })).toHaveAttribute("data-chat-session-row", "b");
    expect(screen.queryByText("New chat", { selector: "[data-chat-row-title]" })).toBeNull();
  });

  it("shows a loading placeholder, not 'unavailable', while Projects load", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(chatKeys.sessionList("ws-1", "all", "automation"), []);
    client.setQueryData(chatKeys.pendingTasks("ws-1"), { tasks: [] });
    render(
      <QueryClientProvider client={client}>
        <I18nProvider locale="en" resources={{ en: { chat: enChat } }}>
          <ChatSidebar sessions={[chat("p1", { project_id: "project-1" })]} projects={undefined} activeSessionId={null}
            loading={false} error={false} onRetry={vi.fn()} onSelectSession={vi.fn()} onNewChat={vi.fn()} onSessionDeleted={vi.fn()} />
        </I18nProvider>
      </QueryClientProvider>,
    );
    expect(within(section("Projects")).getByRole("group", { name: "…" })).toBeInTheDocument();
    expect(screen.queryByText("Linked project unavailable")).toBeNull();
  });

  it("selects a row by click and by Enter, and marks the active one", () => {
    const onSelectSession = vi.fn();
    mount({ sessions: [chat("a", { title: "First" }), chat("b", { title: "Second" })], activeSessionId: "b", onSelectSession });
    expect(row("Second")).toHaveAttribute("aria-current", "page");
    expect(row("First")).not.toHaveAttribute("aria-current");
    fireEvent.click(row("First"));
    expect(onSelectSession).toHaveBeenLastCalledWith(expect.objectContaining({ id: "a" }));
    fireEvent.keyDown(row("Second"), { key: "Enter" });
    expect(onSelectSession).toHaveBeenLastCalledWith(expect.objectContaining({ id: "b" }));
  });
});

describe("ChatSidebar row actions", () => {
  it("asks before archiving a running chat and offers no Undo afterwards", async () => {
    mount({
      sessions: [chat("a", { title: "Running chat" })],
      pending: { tasks: [{ task_id: "task-a", turn_id: "turn-a", chat_session_id: "a", status: "running" }] },
    });
    fireEvent.click(within(row("Running chat")).getByRole("button", { name: "Archive" }));
    expect(await screen.findByText("Stop and archive this chat?")).toBeInTheDocument();
    expect(state.update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Stop and archive" }));
    await waitFor(() => expect(state.update).toHaveBeenCalledWith({ sessionId: "a", status: "archived" }));
    // The stopped run cannot come back, so the confirmation is the last word.
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith("Archived “Running chat”"));
    expect(state.toast.mock.calls[0]).toHaveLength(1);
  });

  it("archives an idle chat at once and offers Undo", async () => {
    mount({ sessions: [chat("a", { title: "Idle chat" })] });
    fireEvent.click(within(row("Idle chat")).getByRole("button", { name: "Archive" }));
    expect(screen.queryByText("Stop and archive this chat?")).toBeNull();
    expect(state.update).toHaveBeenCalledWith({ sessionId: "a", status: "archived" });
    await waitFor(() => expect(state.toast).toHaveBeenCalled());
    const [message, options] = state.toast.mock.calls[0] as [string, { action: { label: string; onClick: () => void } }];
    expect(message).toBe("Archived “Idle chat”");
    expect(options.action.label).toBe("Undo");
    options.action.onClick();
    expect(state.update).toHaveBeenLastCalledWith({ sessionId: "a", status: "active" });
  });

  it("shows the failure copy when a row action fails", async () => {
    state.update.mockRejectedValue(new Error("offline"));
    mount({ sessions: [chat("a", { title: "Idle chat" })] });
    fireEvent.click(within(row("Idle chat")).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(state.toast.error).toHaveBeenCalledWith("Action failed. Please try again."));
    expect(state.toast).not.toHaveBeenCalled();
  });

  it("opens the same menu on right-click", async () => {
    mount({ sessions: [chat("a", { title: "Context chat" })] });
    expect(screen.queryByRole("menuitem", { name: "Rename…" })).toBeNull();
    fireEvent.contextMenu(row("Context chat"));
    expect(await screen.findByRole("menuitem", { name: "Rename…" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Pin" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Archive" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete…" })).toBeInTheDocument();
    // Stop run appears only while the chat runs.
    expect(screen.queryByRole("menuitem", { name: "Stop run" })).toBeNull();
  });

  it("renames through a dialog and skips an unchanged title", async () => {
    mount({ sessions: [chat("a", { title: "Old title" })] });
    openMenu("Old title");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename…" }));
    const input = await screen.findByRole("textbox", { name: "Rename chat" });
    expect(input).toHaveValue("Old title");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(state.update).not.toHaveBeenCalled();

    openMenu("Old title");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename…" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Rename chat" }), { target: { value: "  New title " } });
    fireEvent.submit(screen.getByRole("textbox", { name: "Rename chat" }).closest("form")!);
    expect(state.update).toHaveBeenCalledWith({ sessionId: "a", title: "New title" });
  });

  it("pins and unpins from the menu", async () => {
    mount({ sessions: [chat("a", { title: "Pin me" }), chat("b", { title: "Unpin me", pinned: true })] });
    openMenu("Pin me");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Pin" }));
    expect(state.update).toHaveBeenLastCalledWith({ sessionId: "a", pinned: true });
    openMenu("Unpin me");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Unpin" }));
    expect(state.update).toHaveBeenLastCalledWith({ sessionId: "b", pinned: false });
  });

  it("stops a running chat through its turn", async () => {
    mount({
      sessions: [chat("a", { title: "Running chat" })],
      pending: { tasks: [{ task_id: "attempt-a", turn_id: "turn-a", chat_session_id: "a", status: "running" }] },
    });
    openMenu("Running chat");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Stop run" }));
    await waitFor(() => expect(api.cancelTaskById).toHaveBeenCalledWith("turn-a"));
  });

  it("deletes only after confirmation and clears the open chat", async () => {
    const onSessionDeleted = vi.fn();
    state.activeId = "a";
    mount({ sessions: [chat("a", { title: "Doomed" })], activeSessionId: "a", onSessionDeleted });
    openMenu("Doomed");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete…" }));
    expect(await screen.findByText("Delete this chat?")).toBeInTheDocument();
    expect(state.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(state.remove).toHaveBeenCalledWith("a"));
    await waitFor(() => expect(onSessionDeleted).toHaveBeenCalled());
    expect(state.select).toHaveBeenCalledWith(null);
  });

  it("keeps a newer selection when a deletion completes", async () => {
    let finish!: () => void;
    state.remove.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const onSessionDeleted = vi.fn();
    state.activeId = "a";
    mount({ sessions: [chat("a", { title: "Doomed" })], activeSessionId: "a", onSessionDeleted });
    openMenu("Doomed");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    state.activeId = "b";
    await act(async () => finish());
    expect(onSessionDeleted).not.toHaveBeenCalled();
    expect(state.select).not.toHaveBeenCalled();
  });

  it("keeps the delete dialog and the chat when deletion fails", async () => {
    state.remove.mockRejectedValue(new Error("offline"));
    const onSessionDeleted = vi.fn();
    mount({ sessions: [chat("a", { title: "Kept" })], activeSessionId: "a", onSessionDeleted });
    openMenu("Kept");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(state.toast.error).toHaveBeenCalledWith("Action failed. Please try again."));
    expect(screen.getByText("Delete this chat?")).toBeInTheDocument();
    expect(onSessionDeleted).not.toHaveBeenCalled();
  });
});

describe("ChatSidebar Automations and Archived views", () => {
  const automationChat = (id: string, overrides: Partial<ChatSession> = {}) =>
    chat(id, { origin: { autopilot_id: "ap-1", run_id: `run-${id}` }, ...overrides });

  it("flags unread automation chats and lists them behind a back header", async () => {
    const onSelectSession = vi.fn();
    mount({
      sessions: [chat("mine", { title: "My chat" })],
      automation: [
        automationChat("auto-1", { title: "Nightly digest", has_unread: true }),
        automationChat("auto-2", { title: "Quiet run", status: "archived" }),
      ],
      onSelectSession,
    });
    expect(screen.getByRole("img", { name: "1 unread automation chat" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Automations/ }));
    expect(screen.getByRole("heading", { name: "Automations" })).toBeInTheDocument();
    expect(screen.getByText("Nightly digest")).toBeInTheDocument();
    expect(screen.queryByText("Quiet run")).toBeNull();
    expect(screen.queryByText("My chat")).toBeNull();
    fireEvent.click(row("Nightly digest"));
    expect(onSelectSession).toHaveBeenCalledWith(expect.objectContaining({ id: "auto-1" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("My chat")).toBeInTheDocument();
  });

  it("lists every archived chat and restores one", async () => {
    mount({
      sessions: [chat("mine", { title: "Active chat" }), chat("old", { title: "Old chat", status: "archived" })],
      automation: [automationChat("auto-2", { title: "Quiet run", status: "archived" })],
    });
    expect(screen.queryByText("Old chat")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Archived" }));
    expect(screen.getByRole("heading", { name: "Archived" })).toBeInTheDocument();
    expect(screen.getByText("Old chat")).toBeInTheDocument();
    expect(screen.getByText("Quiet run")).toBeInTheDocument();
    expect(screen.queryByText("Active chat")).toBeNull();
    fireEvent.click(within(row("Old chat")).getByRole("button", { name: "Restore" }));
    expect(state.update).toHaveBeenCalledWith({ sessionId: "old", status: "active" });
    openMenu("Quiet run");
    expect(await screen.findByRole("menuitem", { name: "Restore" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Archive" })).toBeNull();
  });

  it("removes an archived row from the main list", async () => {
    const view = mount({ sessions: [chat("a", { title: "Leaving" }), chat("b", { title: "Staying" })] });
    view.rerenderWith([chat("a", { title: "Leaving", status: "archived" }), chat("b", { title: "Staying" })]);
    await waitFor(() => expect(screen.queryByText("Leaving")).toBeNull());
    expect(screen.getByText("Staying")).toBeInTheDocument();
  });
});
