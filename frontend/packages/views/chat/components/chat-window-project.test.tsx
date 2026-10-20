import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { createChatStore, registerChatStore } from "@multiremi/core/chat";
import { chatKeys } from "@multiremi/core/chat/queries";
import type { ChatSession } from "@multiremi/core/types";
import enChat from "../../locales/en/chat.json";
import enIssues from "../../locales/en/issues.json";
import enRuntimes from "../../locales/en/runtimes.json";
import { CHAT_COLUMN_CLASS, CHAT_PANE_CLASS } from "../lib/chat-column";

const backend = vi.hoisted(() => ({
  sessions: [] as ChatSession[],
  byId: {} as Record<string, ChatSession>,
  pending: {} as Record<string, unknown>,
  logReady: true,
  projectsHeld: false,
  create: vi.fn(), update: vi.fn(), send: vi.fn(), refresh: vi.fn(), markRead: vi.fn(),
  enqueue: vi.fn(), updateQueued: vi.fn(), cancel: vi.fn(),
}));
const apiLogger = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("@multiremi/core/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multiremi/core/api")>();
  return { ...actual, api: {
    listAgents: async () => [{ id: "agent-a", name: "Alpha", archived_at: null, owner_id: "user-a" }],
    listMembers: async () => [{ user_id: "user-a", role: "owner" }],
    listProjects: async () => backend.projectsHeld ? new Promise<never>(() => {}) : ({ projects: [
      { id: "project-a", title: "Remi", archived_at: null, icon: null },
      { id: "project-b", title: "Docs", archived_at: null, icon: null },
    ] }),
    listRuntimeWorkspaces: async () => [{ id: "rws-a", name: "Local workbench", root_path: "/work", cwd: ".", daemon_id: "daemon-a", status: "available" }],
    listRuntimes: async () => [],
    listChatSessions: async () => {
      listChatSessionsCalls();
      return backend.sessions;
    },
    listChatMessagesPage: async () => {
      listChatMessagesPageCalls();
      return { messages: [], limit: 50, has_more: false, next_cursor: null };
    },
    getPendingChatTask: async () => {
      getPendingChatTaskCalls();
      return backend.pending;
    },
    getChatSession: async (id: string) => {
      getChatSessionCalls(id);
      return backend.byId[id];
    },
    createChatSession: backend.create,
    updateChatSession: backend.update,
    sendChatMessage: backend.send,
    markChatSessionRead: backend.markRead,
    enqueueChatMessage: backend.enqueue,
    updateQueuedChatMessage: backend.updateQueued,
    cancelTaskById: backend.cancel,
  } };
});
vi.mock("@multiremi/core/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multiremi/core/logger")>();
  return {
    ...actual,
    createLogger: (namespace: string) =>
      namespace === "chat.api"
        ? { ...actual.noopLogger, error: apiLogger.error }
        : actual.noopLogger,
  };
});
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "workspace-a" }));
vi.mock("@multiremi/core/auth", () => ({ useAuthStore: (select: (s: unknown) => unknown) => select({ user: { id: "user-a" } }) }));
vi.mock("@multiremi/core/platform", async (importOriginal) => ({
  ...await importOriginal<typeof import("@multiremi/core/platform")>(),
  getCurrentWsId: () => "workspace-a",
}));
vi.mock("@multiremi/core/agents", () => ({ useWorkspaceAgentAvailability: () => "available", useAgentPresenceDetail: () => "loading" }));
vi.mock("@multiremi/core/hooks/use-file-upload", () => ({ useFileUpload: () => ({ uploadWithToast: vi.fn() }) }));
vi.mock("@multiremi/core/realtime", () => ({ useChatScopeSubscription: () => {}, useTraceStreamSubscription: () => {} }));
vi.mock("@multiremi/core/session-log/use-issue-log", () => ({ useChatLog: (sessionId: string, _initial: unknown, enabled: boolean) => {
  // The 444 replica replaces listChatMessagesPage; observe its load gate here.
  if (enabled && sessionId) listChatMessagesPageCalls();
  return ({
  replica: { sessionId, refreshTailPreservingWindow: backend.refresh, getSnapshot: () => ({ entries: [] }) },
  snapshot: { entries: [], head: null, ready: backend.logReady }, error: false,
  });
} }));
vi.mock("@multiremi/core/paths", () => ({ useWorkspacePaths: () => ({
  chat: () => "/chat",
  autopilotDetail: (id: string) => `/autopilots/${id}`,
}) }));
vi.mock("@multiremi/views/issues/components", () => ({ canAssignAgent: () => true }));
vi.mock("../../navigation", () => ({
  useNavigation: () => ({ push: vi.fn() }),
  AppLink: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("../../layout/page-header", () => ({ PageHeader: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("./use-chat-resize", () => ({ useChatResize: () => ({ boundsReady: true }) }));
vi.mock("./use-chat-context-items", () => ({ useChatContextItems: () => [] }));
vi.mock("./chat-message-list", () => ({ ChatMessageList: () => <div data-testid="chat-message-list" />, ChatMessageSkeleton: () => null }));
vi.mock("./human-request-dock", () => ({ HumanRequestDock: ({ className }: { className?: string }) => <div data-testid="human-request-dock" className={className} /> }));
vi.mock("./offline-banner", () => ({ OfflineBanner: () => null }));
vi.mock("./no-agent-banner", () => ({ NoAgentBanner: () => null }));
const queueFlush = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./chat-queue", () => ({ ChatQueue: ({ controllerRef }: { controllerRef?: { current: unknown } }) => {
  if (controllerRef) controllerRef.current = { flushDeletes: queueFlush };
  return null;
} }));
vi.mock("./chat-empty-state", () => ({ EmptyState: () => null }));
vi.mock("./agent-dropdown", () => ({ AgentDropdown: () => null }));
vi.mock("./session-dropdown", () => ({ SessionDropdown: () => <div data-testid="session-dropdown" /> }));
vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: ({ actorId }: { actorId: string }) => <span data-testid={`avatar-${actorId}`} />,
}));
vi.mock("./chat-input", () => ({ ChatInput: ({ onSend, onSaveQueueEdit, onStop, disabled, leftAdornment }: {
  onSend: (value: string, ids?: string[], local?: unknown[], mode?: string) => Promise<void>;
  onSaveQueueEdit: (sessionId: string, edit: unknown, content: string, ids: string[]) => Promise<void>;
  onStop: () => void;
  disabled: boolean;
  leftAdornment?: ReactNode;
}) => (
  <>
    <div data-testid="composer-footer">{leftAdornment}</div>
    <button disabled={disabled} onClick={() => void onSend("Hello").catch(() => {})}>Send test message</button>
    <button onClick={() => void onSend("Steer this", undefined, [], "steer").catch(() => {})}>Steer test message</button>
    <button onClick={() => void onSend("Queue this", ["att-1"], [{ id: "att-1", filename: "a.png", content_type: "image/png", size_bytes: 4 }], "queue")
      .then(() => sent("resolved"), () => sent("rejected"))}>Queue test message</button>
    <button onClick={() => void onSaveQueueEdit("chat-a", queueEditFixture, "Edited", [])
      .then(() => sent("saved"), () => sent("save rejected"))}>Save queued edit</button>
    <button onClick={onStop}>Stop test run</button>
  </>
) }));
const sent = vi.hoisted(() => vi.fn());
const queueEditFixture = vi.hoisted(() => ({ itemId: "qmsg_1", revision: 3, stash: { draft: "my draft", attachments: {} } }));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), dismiss: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { ApiError } from "@multiremi/core/api";
import { setCurrentWorkspace } from "@multiremi/core/platform";
import { ChatWindow } from "./chat-window";

const listChatSessionsCalls = vi.hoisted(() => vi.fn());
const listChatMessagesPageCalls = vi.hoisted(() => vi.fn());
const getPendingChatTaskCalls = vi.hoisted(() => vi.fn());
const getChatSessionCalls = vi.hoisted(() => vi.fn());

/**
 * MUL-472 b: the floating window must not preload the conversation while it is
 * minimised. `mount()` uses `presentation="page"` (always visible) for the
 * other suites, so this one drives the floating presentation.
 */
function mountFloatingOpen(open: boolean, activeSessionId: string | null = session.id) {
  const values = new Map<string, string>();
  const store = createChatStore({ storage: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
  } });
  store.getState().setActiveSession(activeSessionId);
  store.getState().setOpen(open);
  registerChatStore(store);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const result = render(
    <QueryClientProvider client={client}>
      <I18nProvider locale="en" resources={{ en: { chat: enChat, issues: enIssues, runtimes: enRuntimes } }}>
        <ChatWindow />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { ...result, store, client };
}

const session: ChatSession = {
  id: "chat-a", workspace_id: "workspace-a", agent_id: "agent-a", creator_id: "user-a",
  project_id: "project-a", title: "Chat", status: "active", has_unread: false, pinned: false, origin: null,
  unread_count: 0, last_message: null, created_at: "2026-09-17", updated_at: "2026-09-17",
};

function mount(active: boolean = false) {
  const values = new Map<string, string>();
  const store = createChatStore({ storage: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
  } });
  if (active) store.getState().setActiveSession(session.id);
  registerChatStore(store);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const result = render(
    <QueryClientProvider client={client}>
      <I18nProvider locale="en" resources={{ en: { chat: enChat, issues: enIssues, runtimes: enRuntimes } }}>
        <ChatWindow presentation="page" />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { ...result, store, client };
}

beforeEach(() => {
  listChatSessionsCalls.mockReset();
  listChatMessagesPageCalls.mockReset();
  getPendingChatTaskCalls.mockReset();
  getChatSessionCalls.mockReset();
  backend.sessions = [];
  backend.byId = {};
  backend.pending = {};
  backend.logReady = true;
  backend.projectsHeld = false;
  backend.create.mockReset().mockImplementation(async (data) => {
    const created = { ...session, project_id: null, ...data };
    backend.sessions = [created];
    return created;
  });
  backend.update.mockReset().mockImplementation(async (_id, data) => {
    backend.sessions = backend.sessions.map(current => ({ ...current, ...data }));
    return backend.sessions[0];
  });
  backend.send.mockReset().mockResolvedValue({ task_id: "task-a", message_id: "message-a", created_at: "2026-09-17", supports_queue: true, queued: false });
  backend.refresh.mockReset().mockResolvedValue(undefined);
  backend.markRead.mockReset().mockImplementation(async (id: string) => {
    backend.sessions = backend.sessions.map(current => current.id === id
      ? { ...current, has_unread: false, unread_count: 0 } : current);
  });
  apiLogger.error.mockReset();
  backend.enqueue.mockReset();
  backend.updateQueued.mockReset();
  backend.cancel.mockReset().mockResolvedValue(undefined);
  sent.mockReset();
  toast.mockReset();
  queueFlush.mockClear();
});

describe("ChatWindow automatic read", () => {
  it("stops after the acknowledged list refresh and reads again only for a new reply", async () => {
    backend.sessions = [{ ...session, has_unread: true, unread_count: 1 }];
    const view = mount(true);
    try {
      await waitFor(() => expect(backend.markRead).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(view.client.getQueryData<ChatSession[]>(chatKeys.sessions("workspace-a"))?.[0]?.has_unread).toBe(false));
      await act(async () => { await view.client.invalidateQueries({ queryKey: ["chat"] }); });
      expect(backend.markRead).toHaveBeenCalledTimes(1);
      backend.sessions = [{ ...session, has_unread: true, unread_count: 1, updated_at: "2026-10-05" }];
      await act(async () => { await view.client.invalidateQueries({ queryKey: ["chat"] }); });
      await waitFor(() => expect(backend.markRead).toHaveBeenCalledTimes(2));
      await act(async () => { await view.client.invalidateQueries({ queryKey: ["chat"] }); });
      expect(backend.markRead).toHaveBeenCalledTimes(2);
    } finally { view.unmount(); view.client.clear(); }
  });
});

describe("ChatWindow automation origin", () => {
  const automationChat: ChatSession = { ...session, origin: { autopilot_id: "ap-1", run_id: "run-1" } };

  it("reads an automation chat by id and links back to its automation", async () => {
    backend.byId = { [session.id]: automationChat };
    const view = mount(true);
    try {
      expect(await screen.findByText("Opened by an automation run")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "View automation" })).toHaveAttribute("href", "/autopilots/ap-1");
      expect(getChatSessionCalls).toHaveBeenCalledWith(session.id);
    } finally { view.unmount(); view.client.clear(); }
  });

  it("shows no origin bar and reads no extra session for the user's own chat", async () => {
    backend.sessions = [session];
    const view = mount(true);
    try {
      expect(await screen.findByRole("button", { name: "Send test message" })).toBeInTheDocument();
      expect(screen.queryByText("Opened by an automation run")).toBeNull();
      expect(getChatSessionCalls).not.toHaveBeenCalled();
    } finally { view.unmount(); view.client.clear(); }
  });
});

describe("ChatWindow plain HTTP sends", () => {
  const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);

  beforeEach(() => {
    vi.stubGlobal("crypto", { getRandomValues });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates a new session and sends its first message without randomUUID", async () => {
    const { client } = mount();
    await waitFor(() => expect(client.getQueryData(["workspaces", "workspace-a", "agents"])).toBeDefined());

    expect(globalThis.crypto.randomUUID).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Send test message" }));

    await waitFor(() => expect(backend.create).toHaveBeenCalledWith({ agent_id: "agent-a", title: "Hello" }));
    await waitFor(() => expect(backend.send).toHaveBeenCalledWith("chat-a", "Hello", undefined, expect.any(String), { signal: expect.any(AbortSignal) }));
    await waitFor(() => expect(backend.refresh).toHaveBeenCalledOnce());
  });

  it("sends a follow-up in an existing session without randomUUID", async () => {
    backend.sessions = [session];
    const { client } = mount(true);
    await waitFor(() => expect(client.getQueryData(["workspaces", "workspace-a", "agents"])).toBeDefined());

    expect(globalThis.crypto.randomUUID).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Send test message" }));

    await waitFor(() => expect(backend.send).toHaveBeenCalledWith("chat-a", "Hello", undefined, expect.any(String), { signal: expect.any(AbortSignal) }));
    expect(backend.create).not.toHaveBeenCalled();
  });

  it("logs only allowlisted error details when message submission fails", async () => {
    const sensitiveToken = "secret-send-token";
    const sensitiveBody = "private user message in response";
    const sensitiveCause = "https://gateway.example/?token=secret";
    const error = new ApiError("upstream rejected send", 503, "Unavailable", {
      token: sensitiveToken,
      content: sensitiveBody,
    });
    Object.defineProperty(error, "cause", {
      value: new Error(sensitiveCause),
      enumerable: true,
    });
    backend.sessions = [session];
    backend.send.mockRejectedValueOnce(error);
    const { client } = mount(true);
    await waitFor(() => expect(client.getQueryData(["workspaces", "workspace-a", "agents"])).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: "Send test message" }));

    await waitFor(() => expect(apiLogger.error).toHaveBeenCalledWith(
      "sendChatMessage.error",
      {
        sessionId: "chat-a",
        error: {
          name: "ApiError",
          message: "upstream rejected send",
          status: 503,
          statusText: "Unavailable",
        },
      },
    ));
    const logged = JSON.stringify(apiLogger.error.mock.calls[0]?.[1]);
    expect(logged).not.toContain(sensitiveToken);
    expect(logged).not.toContain(sensitiveBody);
    expect(logged).not.toContain(sensitiveCause);
  });
});

describe("ChatWindow project settings", () => {
  it("replaces a project draft with a fixed local working directory", async () => {
    const { store } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Work location: No project" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remi" }));
    expect(store.getState().draftProjectId).toBe("project-a");
    fireEvent.click(screen.getByRole("button", { name: "Work location: Remi" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Local workbench/ }));
    expect(store.getState().draftProjectId).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send test message" }));
    await waitFor(() => expect(backend.create).toHaveBeenCalledWith({ agent_id: "agent-a", title: "Hello", runtime_workspace_id: "rws-a" }));
    // The page names a fixed location in its header; no picker is left to change it.
    expect(await screen.findByRole("group", { name: "Work location: Local workbench" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Work location:/ })).not.toBeInTheDocument();
  });

  it("replaces a local directory draft with a project without sending both bindings", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Work location: No project" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Local workbench/ }));
    fireEvent.click(screen.getByRole("button", { name: "Work location: Local workbench" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remi" }));
    fireEvent.click(screen.getByRole("button", { name: "Send test message" }));
    await waitFor(() => expect(backend.create).toHaveBeenCalledWith({ agent_id: "agent-a", title: "Hello", project_id: "project-a" }));
  });

  it("creates a conversation with the selected draft project", async () => {
    const { store } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Work location: No project" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remi" }));
    expect(screen.getByRole("button", { name: "Work location: Remi" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send test message" }));
    await waitFor(() => expect(backend.create).toHaveBeenCalledWith({ agent_id: "agent-a", title: "Hello", project_id: "project-a" }));
    await waitFor(() => expect(backend.send).toHaveBeenCalledWith("chat-a", "Hello", undefined, expect.any(String), { signal: expect.any(AbortSignal) }));
    expect(await screen.findByRole("group", { name: "Project: Remi" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Project:/ })).not.toBeInTheDocument();
    // The created chat consumed the draft: the next new chat starts unbound.
    expect(store.getState().draftProjectId).toBeNull();
  });

  it("keeps a new unbound chat's create request unchanged", async () => {
    const { client } = mount();
    await waitFor(() => expect(client.getQueryData(["workspaces", "workspace-a", "agents"])).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Send test message" }));
    await waitFor(() => expect(backend.create).toHaveBeenCalledWith({ agent_id: "agent-a", title: "Hello" }));
  });

  it("can clear a project draft before creating a pure chat", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Work location: No project" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remi" }));
    fireEvent.click(screen.getByRole("button", { name: "Work location: Remi" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /No project/ }));
    fireEvent.click(screen.getByRole("button", { name: "Send test message" }));
    await waitFor(() => expect(backend.create).toHaveBeenCalledWith({ agent_id: "agent-a", title: "Hello" }));
    // A started chat with nothing bound shows no location: the footer would
    // only restate that nothing is bound.
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Work location:/ })).not.toBeInTheDocument());
    expect(screen.queryByRole("group", { name: /^Project:/ })).not.toBeInTheDocument();
    expect(backend.update).not.toHaveBeenCalled();
  });

  it("shows an existing binding without any project-changing control", async () => {
    backend.sessions = [session];
    mount(true);
    const project = await screen.findByRole("group", { name: "Project: Remi" });
    expect(project).toHaveTextContent("Remi");
    fireEvent.click(project);
    expect(screen.queryByRole("button", { name: /^Project:/ })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Search projects…")).not.toBeInTheDocument();
    expect(backend.update).not.toHaveBeenCalled();
    expect(backend.create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send test message" }));
    await waitFor(() => expect(backend.send).toHaveBeenCalledWith("chat-a", "Hello", undefined, expect.any(String), { signal: expect.any(AbortSignal) }));
  });

  it("keeps no location strip for an existing chat with nothing bound", async () => {
    backend.sessions = [{ ...session, project_id: null }];
    mount(true);
    await screen.findByRole("button", { name: "Send test message" });
    expect(screen.queryByRole("group", { name: /^Project:/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Work location:/ })).not.toBeInTheDocument();
    expect(backend.update).not.toHaveBeenCalled();
  });

  it("does not allow an existing session with a missing project to change its binding", async () => {
    backend.sessions = [{ ...session, project_id: "missing" }];
    mount(true);
    const project = await screen.findByRole("group", { name: "Project: Linked project unavailable" });
    fireEvent.click(project);
    expect(screen.queryByRole("button", { name: /^Project:/ })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Search projects…")).not.toBeInTheDocument();
    expect(backend.update).not.toHaveBeenCalled();
  });

  it("keeps archived sessions disabled until restoration succeeds", async () => {
    backend.sessions = [{ ...session, status: "archived" }];
    let resolveRestore!: (value: ChatSession) => void;
    backend.update.mockImplementationOnce(() => new Promise<ChatSession>(resolve => { resolveRestore = resolve; }));
    mount(true);
    const restore = await screen.findByRole("button", { name: "Restore chat" });
    expect(screen.getByRole("button", { name: "Send test message" })).toBeDisabled();
    fireEvent.click(restore);
    await waitFor(() => expect(restore).toBeDisabled());
    expect(backend.update).toHaveBeenCalledWith("chat-a", { status: "active" });
    expect(screen.getByRole("button", { name: "Send test message" })).toBeDisabled();
    backend.sessions = [session];
    await act(async () => resolveRestore(session));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send test message" })).toBeEnabled());
    expect(screen.getByRole("group", { name: "Project: Remi" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Project:/ })).not.toBeInTheDocument();
  });

  it("keeps running sessions read-only and clears the project for a new chat", async () => {
    backend.sessions = [session];
    backend.pending = { task_id: "task-a", status: "running" };
    const { store } = mount(true);
    expect(await screen.findByRole("group", { name: "Project: Remi" })).toBeInTheDocument();
    act(() => store.getState().setDraftProjectId("project-b"));
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(store.getState().draftProjectId).toBeNull();
    expect(screen.getByRole("button", { name: "Work location: No project" })).toBeEnabled();
  });
});

describe("ChatWindow work location in the composer footer", () => {
  it("offers a new chat's location beside the agent, with no row of its own", async () => {
    mount();
    const footer = screen.getByTestId("composer-footer");
    const picker = within(footer).getByRole("button", { name: "Work location: No project" });
    expect(picker).toBeEnabled();
    // The only picker on the page is the footer's.
    expect(screen.getAllByRole("button", { name: /^Work location:/ })).toEqual([picker]);
    fireEvent.click(picker);
    expect(await screen.findByText(/By default there is no project/)).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /No project/ })).toHaveTextContent("Works in this chat's own folder; pulls no code");
  });

  it("shows a started chat's bound location read-only in the floating window", async () => {
    backend.sessions = [session];
    mountFloatingOpen(true);
    const chip = await within(screen.getByTestId("composer-footer")).findByRole("group", { name: "Work location: Remi" });
    expect(chip).toHaveAttribute("title", expect.stringContaining("The work location is fixed after the session starts."));
    expect(screen.queryByRole("button", { name: /^Work location:/ })).not.toBeInTheDocument();
  });

  it("shows nothing for a started chat with no location", async () => {
    backend.sessions = [{ ...session, project_id: null }];
    mountFloatingOpen(true);
    await waitFor(() => expect(listChatSessionsCalls).toHaveBeenCalled());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const footer = screen.getByTestId("composer-footer");
    expect(within(footer).queryByRole("group", { name: /^Work location:/ })).not.toBeInTheDocument();
    expect(within(footer).queryByRole("button", { name: /^Work location:/ })).not.toBeInTheDocument();
  });

  it("starts the next new chat at No project after a bound chat is created and deleted", async () => {
    const { store } = mountFloatingOpen(true, null);
    fireEvent.click(within(screen.getByTestId("composer-footer")).getByRole("button", { name: "Work location: No project" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Local workbench/ }));
    fireEvent.click(screen.getByRole("button", { name: "Send test message" }));
    await waitFor(() => expect(backend.create).toHaveBeenCalledWith({ agent_id: "agent-a", title: "Hello", runtime_workspace_id: "rws-a" }));
    expect(await within(screen.getByTestId("composer-footer")).findByRole("group", { name: "Work location: Local workbench" })).toBeInTheDocument();
    expect(store.getState().draftRuntimeWorkspaceId).toBeNull();
    // useDeleteChatSession and chat:session_deleted clear the active chat.
    act(() => store.getState().setActiveSession(null));
    expect(await within(screen.getByTestId("composer-footer")).findByRole("button", { name: "Work location: No project" })).toBeEnabled();
  });
});

describe("minimised chat window preloads nothing (MUL-472 b)", () => {
  it("does not fetch sessions, messages or the pending task while closed", async () => {
    mountFloatingOpen(false);

    // Give the queries a couple of macrotasks to start if they were enabled.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(listChatSessionsCalls).not.toHaveBeenCalled();
    expect(listChatMessagesPageCalls).not.toHaveBeenCalled();
    expect(getPendingChatTaskCalls).not.toHaveBeenCalled();
  });

  it("starts fetching as soon as the window is opened", async () => {
    const { store } = mountFloatingOpen(false);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(listChatSessionsCalls).not.toHaveBeenCalled();

    await act(async () => {
      store.getState().setOpen(true);
    });

    await waitFor(() => expect(listChatSessionsCalls).toHaveBeenCalled());
    await waitFor(() => expect(getPendingChatTaskCalls).toHaveBeenCalled());
    await waitFor(() => expect(listChatMessagesPageCalls).toHaveBeenCalled());
  });
});

describe("ChatWindow page shell", () => {
  it("names the agent, title and bound location without the page banner or session controls", async () => {
    backend.sessions = [{ ...session, title: "Release prep" }];
    mount(true);
    const header = await waitFor(() => {
      const element = document.querySelector<HTMLElement>("[data-chat-page-header]");
      expect(element).toHaveTextContent("Release prep");
      return element!;
    });
    expect(header.querySelector('[data-testid="avatar-agent-a"]')).not.toBeNull();
    await waitFor(() => expect(header).toHaveTextContent("Remi"));
    expect(screen.queryByText("Private conversations with your agents")).toBeNull();
    // New chat and history moved to the sidebar; the header only hides and shows it.
    expect(screen.queryByTestId("session-dropdown")).toBeNull();
    expect([...header.querySelectorAll("button")].map((button) => button.getAttribute("aria-label")))
      .toEqual(["Hide sidebar", "Chat history"]);
  });

  it("shows a placeholder, not 'unavailable', while the Project list loads", async () => {
    backend.sessions = [{ ...session, title: "Release prep" }];
    backend.projectsHeld = true;
    mount(true);
    const header = await waitFor(() => {
      const element = document.querySelector<HTMLElement>("[data-chat-page-header]");
      expect(element).toHaveTextContent("Release prep");
      return element!;
    });
    expect(within(header).getByRole("group", { name: "Project: …" })).toBeInTheDocument();
    expect(header).not.toHaveTextContent("Linked project unavailable");
  });

  it("calls the unsaved draft New chat and an existing untitled chat Untitled", async () => {
    const view = mount();
    await waitFor(() => expect(document.querySelector("[data-chat-page-header]")).toHaveTextContent("New chat"));
    view.unmount();
    backend.sessions = [{ ...session, title: "" }];
    mount(true);
    await waitFor(() => expect(document.querySelector("[data-chat-page-header] h1")).toHaveTextContent("Untitled"));
  });

  it("starts a chat bound to a sidebar group's Project", async () => {
    backend.sessions = [session];
    const { store } = mount(true);
    fireEvent.click(await screen.findByRole("button", { name: "Start new chat in Remi" }));
    expect(store.getState().activeSessionId).toBeNull();
    expect(store.getState().draftProjectId).toBe("project-a");
    expect(await screen.findByRole("button", { name: "Work location: Remi" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Send test message" }));
    await waitFor(() => expect(backend.create).toHaveBeenCalledWith({ agent_id: "agent-a", title: "Hello", project_id: "project-a" }));
  });

  it("starts a chat bound to a sidebar group's local directory", async () => {
    backend.sessions = [{ ...session, project_id: null, runtime_workspace_id: "rws-a" }];
    const { store } = mount(true);
    fireEvent.click(await screen.findByRole("button", { name: "Start new chat in Local workbench" }));
    expect(store.getState().draftProjectId).toBeNull();
    expect(await screen.findByRole("button", { name: "Work location: Local workbench" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Send test message" }));
    await waitFor(() => expect(backend.create).toHaveBeenCalledWith({ agent_id: "agent-a", title: "Hello", runtime_workspace_id: "rws-a" }));
  });

  it("waits 400ms before showing the first-load spinner", async () => {
    backend.sessions = [session];
    backend.logReady = false;
    mount(true);
    await screen.findByRole("button", { name: "Send test message" });
    expect(screen.queryByRole("status", { name: "Loading conversation…" })).toBeNull();
    expect(await screen.findByRole("status", { name: "Loading conversation…" }, { timeout: 1500 })).toBeInTheDocument();
  });
});

describe("ChatWindow follow-up delivery", () => {
  // The queue mutations compare the workspace they started in with the current one.
  beforeEach(() => setCurrentWorkspace("acme", "workspace-a"));
  const agentsLoaded = (client: QueryClient) =>
    waitFor(() => expect(client.getQueryData(["workspaces", "workspace-a", "agents"])).toBeDefined());
  const queuedRow = { id: "qmsg_1", session_id: "chat-a", body_md: "Queue this", attachments: [], client_id: "x", status: "queued",
    error: null, revision: 1, released_message_id: null, released_via: null, released_at: null, created_at: "t", updated_at: "t" };

  it("steers through the message route, sent now", async () => {
    backend.sessions = [session];
    const { client } = mount(true);
    await agentsLoaded(client);
    fireEvent.click(await screen.findByRole("button", { name: "Steer test message" }));
    await waitFor(() => expect(backend.send).toHaveBeenCalledWith("chat-a", "Steer this", undefined, expect.any(String), { signal: expect.any(AbortSignal) }));
    expect(backend.enqueue).not.toHaveBeenCalled();
  });

  it("queues with a client id and refreshes the log only when the row was released at once", async () => {
    backend.sessions = [session];
    backend.enqueue.mockResolvedValueOnce({ item: queuedRow, released: null });
    const { store, client } = mount(true);
    await agentsLoaded(client);
    fireEvent.click(await screen.findByRole("button", { name: "Queue test message" }));
    await waitFor(() => expect(sent).toHaveBeenCalledWith("resolved"));
    expect(backend.enqueue).toHaveBeenCalledWith("chat-a", { body_md: "Queue this", attachment_ids: ["att-1"], client_id: expect.any(String) });
    // Deletes still behind their undo go out first: an idle lane releases its oldest queued row.
    expect(queueFlush.mock.invocationCallOrder[0]).toBeLessThan(backend.enqueue.mock.invocationCallOrder[0]!);
    expect(backend.send).not.toHaveBeenCalled();
    expect(backend.refresh).not.toHaveBeenCalled();
    expect(store.getState().queueOutbox).toEqual({});

    backend.enqueue.mockImplementationOnce(async (_id: string, input: { client_id: string }) =>
      ({ item: { ...queuedRow, client_id: input.client_id, status: "released" }, released: { message: { id: "msg_1" } } }));
    fireEvent.click(screen.getByRole("button", { name: "Queue test message" }));
    await waitFor(() => expect(backend.refresh).toHaveBeenCalledOnce());
  });

  it("hands an unconfirmed enqueue to the queue, but rejects a refused one so the draft stays", async () => {
    backend.sessions = [session];
    backend.enqueue.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const { store, client } = mount(true);
    await agentsLoaded(client);
    fireEvent.click(await screen.findByRole("button", { name: "Queue test message" }));
    await waitFor(() => expect(sent).toHaveBeenCalledWith("resolved"));
    expect(store.getState().queueOutbox["chat-a"]).toEqual([expect.objectContaining({
      body_md: "Queue this", attachment_ids: ["att-1"], state: "unconfirmed",
      attachments: [{ id: "att-1", filename: "a.png", content_type: "image/png", size: 4 }],
    })]);
    backend.enqueue.mockRejectedValueOnce(new ApiError("full", 400, "Bad Request", { error: "full", code: "queue_full" }));
    fireEvent.click(screen.getByRole("button", { name: "Queue test message" }));
    await waitFor(() => expect(sent).toHaveBeenCalledWith("rejected"));
  });

  it("saves an edit with its revision and restores the stashed draft", async () => {
    backend.sessions = [session];
    backend.updateQueued.mockResolvedValue({ ...queuedRow, body_md: "Edited", revision: 4 });
    const { store } = mount(true);
    act(() => store.getState().setInputDraft("chat-a", "my draft"));
    act(() => store.getState().startQueueEdit("chat-a", { itemId: "qmsg_1", revision: 3, body_md: "Queue this", attachments: {} }));
    fireEvent.click(screen.getByRole("button", { name: "Save queued edit" }));
    await waitFor(() => expect(sent).toHaveBeenCalledWith("saved"));
    expect(backend.updateQueued).toHaveBeenCalledWith("chat-a", "qmsg_1", { body_md: "Edited", attachment_ids: [], expected_revision: 3 });
    expect(store.getState().queueEdit).toEqual({});
    expect(store.getState().inputDrafts["chat-a"]).toBe("my draft");
  });

  it("keeps the edited text when the row was already sent, and stays in edit mode on other failures", async () => {
    backend.sessions = [session];
    const { store } = mount(true);
    act(() => store.getState().startQueueEdit("chat-a", { itemId: "qmsg_1", revision: 3, body_md: "Queue this", attachments: {} }));
    backend.updateQueued.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "Save queued edit" }));
    await waitFor(() => expect(sent).toHaveBeenCalledWith("save rejected"));
    expect(store.getState().queueEdit["chat-a"]).toBeDefined();
    backend.updateQueued.mockRejectedValueOnce(new ApiError("sent", 409, "Conflict", { error: "sent", code: "queued_message_consumed" }));
    // The stored draft lags the editor by its debounce; the submitted text wins.
    act(() => store.getState().setInputDraft("chat-a", "Edit"));
    fireEvent.click(screen.getByRole("button", { name: "Save queued edit" }));
    await waitFor(() => expect(sent).toHaveBeenCalledWith("saved"));
    expect(store.getState().queueEdit).toEqual({});
    expect(store.getState().inputDrafts["chat-a"]).toBe("Edited");
    expect(toast).toHaveBeenCalledWith("This message was already sent and can no longer be changed");
  });

  it("says a row deleted elsewhere was deleted, not sent", async () => {
    backend.sessions = [session];
    const { store } = mount(true);
    act(() => store.getState().startQueueEdit("chat-a", { itemId: "qmsg_1", revision: 3, body_md: "Queue this", attachments: {} }));
    backend.updateQueued.mockRejectedValueOnce(new ApiError("gone", 404, "Not Found", { error: "gone", code: "queued_message_not_found" }));
    fireEvent.click(screen.getByRole("button", { name: "Save queued edit" }));
    await waitFor(() => expect(sent).toHaveBeenCalledWith("saved"));
    expect(store.getState().queueEdit).toEqual({});
    expect(toast).toHaveBeenCalledWith("This queued message was deleted. Your edit stays in the input.");
  });

  it("refreshes the queue after a stop, which pauses it", async () => {
    backend.sessions = [session];
    backend.pending = { task_id: "task-a", turn_id: "turn-a", status: "running", supports_queue: true };
    const { client } = mount(true);
    await waitFor(() => expect(client.getQueryData(chatKeys.pendingTask("chat-a"))).toMatchObject({ task_id: "task-a" }));
    client.setQueryData(chatKeys.queue("workspace-a", "chat-a"), { items: [], paused: null });
    fireEvent.click(screen.getByRole("button", { name: "Stop test run" }));
    await waitFor(() => expect(backend.cancel).toHaveBeenCalledWith("turn-a"));
    await waitFor(() => expect(client.getQueryState(chatKeys.queue("workspace-a", "chat-a"))?.isInvalidated).toBe(true));
  });
});

describe("ChatWindow Chat column", () => {
  it("puts the question lines, the archived-chat row and the action error in the shared Chat column", async () => {
    backend.sessions = [{ ...session, status: "archived" }];
    backend.update.mockRejectedValueOnce(new Error("offline"));
    mount(true);
    const column = CHAT_COLUMN_CLASS.split(" ");
    // The question lines drop the dock's own band and sit edge to edge with the composer.
    expect(screen.getByTestId("human-request-dock")).toHaveClass(...column, "border-t-0", "bg-transparent", "py-0");
    const restore = await screen.findByRole("button", { name: "Restore chat" });
    expect(restore.parentElement).toHaveClass(...column);
    fireEvent.click(restore);
    expect(await screen.findByText("Action failed. Please try again.")).toHaveClass(...column);
  });

  it("sizes the page's column from one pane holding the message list, the rows above the composer and the composer", async () => {
    backend.sessions = [session];
    backend.pending = { task_id: "task-a", turn_id: "turn-a", status: "running", supports_queue: true };
    mount(true);
    const pane = (await screen.findByTestId("chat-message-list")).parentElement!;
    expect(pane).toHaveClass(CHAT_PANE_CLASS);
    expect(pane).toContainElement(screen.getByTestId("human-request-dock"));
    expect(pane).toContainElement(screen.getByTestId("composer-footer"));
  });

  it("gives the floating window no pane, so its column keeps 768px however wide the window grows", async () => {
    backend.sessions = [session];
    mountFloatingOpen(true);
    expect(await screen.findByTestId("human-request-dock")).toHaveClass(...CHAT_COLUMN_CLASS.split(" "));
    expect(document.querySelector(`[class~="${CHAT_PANE_CLASS}"]`)).toBeNull();
  });
});
