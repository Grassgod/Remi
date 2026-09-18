import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { createChatStore, registerChatStore } from "@multiremi/core/chat";
import type { ChatSession } from "@multiremi/core/types";
import enChat from "../../locales/en/chat.json";
import enIssues from "../../locales/en/issues.json";
import enRuntimes from "../../locales/en/runtimes.json";

const backend = vi.hoisted(() => ({
  sessions: [] as ChatSession[],
  pending: {} as Record<string, unknown>,
  create: vi.fn(), update: vi.fn(), send: vi.fn(),
}));
const apiLogger = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("@multiremi/core/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multiremi/core/api")>();
  return { ...actual, api: {
    listAgents: async () => [{ id: "agent-a", name: "Alpha", archived_at: null, owner_id: "user-a" }],
    listMembers: async () => [{ user_id: "user-a", role: "owner" }],
    listProjects: async () => ({ projects: [
      { id: "project-a", title: "Remi", archived_at: null, icon: null },
      { id: "project-b", title: "Docs", archived_at: null, icon: null },
    ] }),
    listRuntimeWorkspaces: async () => [{ id: "rws-a", name: "Local workbench", root_path: "/work", cwd: ".", daemon_id: "daemon-a", status: "available" }],
    listRuntimes: async () => [],
    listChatSessions: async () => backend.sessions,
    listChatMessagesPage: async () => ({ messages: [], limit: 50, has_more: false, next_cursor: null }),
    getPendingChatTask: async () => backend.pending,
    createChatSession: backend.create,
    updateChatSession: backend.update,
    sendChatMessage: backend.send,
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
vi.mock("@multiremi/core/platform", () => ({ getCurrentWsId: () => "workspace-a" }));
vi.mock("@multiremi/core/agents", () => ({ useWorkspaceAgentAvailability: () => "available", useAgentPresenceDetail: () => "loading" }));
vi.mock("@multiremi/core/hooks/use-file-upload", () => ({ useFileUpload: () => ({ uploadWithToast: vi.fn() }) }));
vi.mock("@multiremi/core/realtime", () => ({ useChatScopeSubscription: () => {} }));
vi.mock("@multiremi/core/paths", () => ({ useWorkspacePaths: () => ({ chat: () => "/chat" }) }));
vi.mock("@multiremi/views/issues/components", () => ({ canAssignAgent: () => true }));
vi.mock("../../navigation", () => ({ useNavigation: () => ({ push: vi.fn() }) }));
vi.mock("../../layout/page-header", () => ({ PageHeader: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("./use-chat-resize", () => ({ useChatResize: () => ({ boundsReady: true }) }));
vi.mock("./use-chat-context-items", () => ({ useChatContextItems: () => [] }));
vi.mock("./chat-message-list", () => ({ ChatMessageList: () => null, ChatMessageSkeleton: () => null }));
vi.mock("./human-request-dock", () => ({ HumanRequestDock: () => null }));
vi.mock("./offline-banner", () => ({ OfflineBanner: () => null }));
vi.mock("./no-agent-banner", () => ({ NoAgentBanner: () => null }));
vi.mock("./chat-queue", () => ({ ChatQueue: () => null }));
vi.mock("./chat-empty-state", () => ({ EmptyState: () => null }));
vi.mock("./agent-dropdown", () => ({ AgentDropdown: () => null }));
vi.mock("./session-dropdown", () => ({ SessionDropdown: () => null }));
vi.mock("./chat-input", () => ({ ChatInput: ({ onSend, disabled }: { onSend: (value: string) => Promise<void>; disabled: boolean }) => (
  <button disabled={disabled} onClick={() => void onSend("Hello").catch(() => {})}>Send test message</button>
) }));

import { ApiError } from "@multiremi/core/api";
import { ChatWindow } from "./chat-window";

const session: ChatSession = {
  id: "chat-a", workspace_id: "workspace-a", agent_id: "agent-a", creator_id: "user-a",
  project_id: "project-a", title: "Chat", status: "active", has_unread: false, pinned: false,
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
  backend.sessions = [];
  backend.pending = {};
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
  apiLogger.error.mockReset();
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
    await waitFor(() => expect(backend.send).toHaveBeenCalledWith("chat-a", "Hello", undefined));
  });

  it("sends a follow-up in an existing session without randomUUID", async () => {
    backend.sessions = [session];
    const { client } = mount(true);
    await waitFor(() => expect(client.getQueryData(["workspaces", "workspace-a", "agents"])).toBeDefined());

    expect(globalThis.crypto.randomUUID).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Send test message" }));

    await waitFor(() => expect(backend.send).toHaveBeenCalledWith("chat-a", "Hello", undefined));
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
    fireEvent.click(screen.getByRole("button", { name: "Work location: Automatic" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remi" }));
    expect(store.getState().draftProjectId).toBe("project-a");
    fireEvent.click(screen.getByRole("button", { name: "Work location: Remi" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Local workbench/ }));
    expect(store.getState().draftProjectId).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send test message" }));
    await waitFor(() => expect(backend.create).toHaveBeenCalledWith({ agent_id: "agent-a", title: "Hello", runtime_workspace_id: "rws-a" }));
    expect(await screen.findByRole("button", { name: "Work location: Local workbench" })).toBeDisabled();
  });

  it("replaces a local directory draft with a project without sending both bindings", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Work location: Automatic" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Local workbench/ }));
    fireEvent.click(screen.getByRole("button", { name: "Work location: Local workbench" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remi" }));
    fireEvent.click(screen.getByRole("button", { name: "Send test message" }));
    await waitFor(() => expect(backend.create).toHaveBeenCalledWith({ agent_id: "agent-a", title: "Hello", project_id: "project-a" }));
  });

  it("creates a conversation with the selected draft project", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Work location: Automatic" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remi" }));
    expect(screen.getByRole("button", { name: "Work location: Remi" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send test message" }));
    await waitFor(() => expect(backend.create).toHaveBeenCalledWith({ agent_id: "agent-a", title: "Hello", project_id: "project-a" }));
    await waitFor(() => expect(backend.send).toHaveBeenCalledWith("chat-a", "Hello", undefined));
    expect(await screen.findByRole("group", { name: "Project: Remi" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Project:/ })).not.toBeInTheDocument();
  });

  it("keeps a new unbound chat's create request unchanged", async () => {
    const { client } = mount();
    await waitFor(() => expect(client.getQueryData(["workspaces", "workspace-a", "agents"])).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Send test message" }));
    await waitFor(() => expect(backend.create).toHaveBeenCalledWith({ agent_id: "agent-a", title: "Hello" }));
  });

  it("can clear a project draft before creating a pure chat", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Work location: Automatic" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remi" }));
    fireEvent.click(screen.getByRole("button", { name: "Work location: Remi" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Automatic" }));
    fireEvent.click(screen.getByRole("button", { name: "Send test message" }));
    await waitFor(() => expect(backend.create).toHaveBeenCalledWith({ agent_id: "agent-a", title: "Hello" }));
    expect(await screen.findByRole("group", { name: "Project: No project · Just chat" })).toBeInTheDocument();
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
    await waitFor(() => expect(backend.send).toHaveBeenCalledWith("chat-a", "Hello", undefined));
  });

  it.each([
    [null, "No project · Just chat"],
    ["missing", "Linked project unavailable"],
  ])("does not allow an existing session with project %s to change its binding", async (project_id, label) => {
    backend.sessions = [{ ...session, project_id }];
    mount(true);
    const project = await screen.findByRole("group", { name: `Project: ${label}` });
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
    expect(screen.getByRole("button", { name: "Work location: Automatic" })).toBeEnabled();
  });
});
