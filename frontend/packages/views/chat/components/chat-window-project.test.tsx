import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { createChatStore, registerChatStore } from "@multiremi/core/chat";
import type { ChatSession } from "@multiremi/core/types";
import enChat from "../../locales/en/chat.json";
import enIssues from "../../locales/en/issues.json";

const backend = vi.hoisted(() => ({
  sessions: [] as ChatSession[],
  pending: {} as Record<string, unknown>,
  create: vi.fn(), update: vi.fn(), send: vi.fn(),
}));
vi.mock("@multiremi/core/api", () => ({ api: {
  listAgents: async () => [{ id: "agent-a", name: "Alpha", archived_at: null, owner_id: "user-a" }],
  listMembers: async () => [{ user_id: "user-a", role: "owner" }],
  listProjects: async () => ({ projects: [
    { id: "project-a", title: "Remi", archived_at: null, icon: null },
    { id: "project-b", title: "Docs", archived_at: null, icon: null },
  ] }),
  listChatSessions: async () => backend.sessions,
  listChatMessagesPage: async () => ({ messages: [], limit: 50, has_more: false, next_cursor: null }),
  getPendingChatTask: async () => backend.pending,
  createChatSession: backend.create,
  updateChatSession: backend.update,
  sendChatMessage: backend.send,
} }));
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
  <button disabled={disabled} onClick={() => void onSend("Hello")}>Send test message</button>
) }));

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
      <I18nProvider locale="en" resources={{ en: { chat: enChat, issues: enIssues } }}>
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
});

describe("ChatWindow project settings", () => {
  it("creates a conversation with the selected draft project", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Project: No project · Just chat" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remi" }));
    expect(screen.getByRole("button", { name: "Project: Remi" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send test message" }));
    await waitFor(() => expect(backend.create).toHaveBeenCalledWith({ agent_id: "agent-a", title: "Hello", project_id: "project-a" }));
    await waitFor(() => expect(backend.send).toHaveBeenCalledWith("chat-a", "Hello", undefined));
  });

  it("keeps a new unbound chat's create request unchanged", async () => {
    const { client } = mount();
    await waitFor(() => expect(client.getQueryData(["workspaces", "workspace-a", "agents"])).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Send test message" }));
    await waitFor(() => expect(backend.create).toHaveBeenCalledWith({ agent_id: "agent-a", title: "Hello" }));
  });

  it("updates an existing binding and sends null to return to pure chat", async () => {
    backend.sessions = [session];
    mount(true);
    fireEvent.click(await screen.findByRole("button", { name: "Project: Remi" }));
    fireEvent.click(await screen.findByRole("button", { name: "Docs" }));
    await waitFor(() => expect(backend.update).toHaveBeenCalledWith("chat-a", { project_id: "project-b" }));
    fireEvent.click(await screen.findByRole("button", { name: "Project: Docs" }));
    fireEvent.click(await screen.findByRole("button", { name: "No project · Just chat" }));
    await waitFor(() => expect(backend.update).toHaveBeenLastCalledWith("chat-a", { project_id: null }));
    expect(await screen.findByRole("button", { name: "Project: No project · Just chat" })).toBeInTheDocument();
    expect(backend.create).not.toHaveBeenCalled();
  });

  it("retains the current binding and reports a failed update", async () => {
    backend.sessions = [session];
    backend.update.mockRejectedValueOnce(new Error("project cannot be changed"));
    mount(true);
    fireEvent.click(await screen.findByRole("button", { name: "Project: Remi" }));
    fireEvent.click(await screen.findByRole("button", { name: "Docs" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Action failed");
    expect(screen.getByRole("button", { name: "Project: Remi" })).toBeInTheDocument();
  });

  it("disables changes while a task runs and clears the project for a new chat", async () => {
    backend.sessions = [session];
    backend.pending = { task_id: "task-a", status: "running" };
    const { store } = mount(true);
    expect(await screen.findByRole("button", { name: "Project: Remi" })).toBeDisabled();
    act(() => store.getState().setDraftProjectId("project-b"));
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(store.getState().draftProjectId).toBeNull();
    expect(screen.getByRole("button", { name: "Project: No project · Just chat" })).toBeEnabled();
  });
});
