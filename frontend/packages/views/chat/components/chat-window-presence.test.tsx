import type { ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { createChatStore, registerChatStore } from "@multiremi/core/chat";
import type { AgentPresenceDetail } from "@multiremi/core/agents";
import type { ChatSession } from "@multiremi/core/types";
import enChat from "../../locales/en/chat.json";
import enIssues from "../../locales/en/issues.json";
import enRuntimes from "../../locales/en/runtimes.json";

// The open chat's agent (Remi) and the composer's fallback (Other, first in the list).
const backend = vi.hoisted(() => ({
  sessions: Promise.resolve([] as unknown[]) as Promise<unknown[]>,
  byId: {} as Record<string, Promise<unknown>>,
  availability: {} as Record<string, "online" | "offline">,
  presenceCalls: [] as Array<string | undefined>,
}));
vi.mock("@multiremi/core/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multiremi/core/api")>();
  return { ...actual, api: {
    listAgents: async () => [
      { id: "agent-other", name: "Other", archived_at: null, owner_id: "user-a" },
      { id: "agent-remi", name: "Remi", archived_at: null, owner_id: "user-a" },
    ],
    listMembers: async () => [{ user_id: "user-a", role: "owner" }],
    listProjects: async () => ({ projects: [] }),
    listRuntimeWorkspaces: async () => [],
    listRuntimes: async () => [],
    listChatSessions: () => backend.sessions,
    getChatSession: (id: string) => backend.byId[id] ?? Promise.reject(new Error("not found")),
    getPendingChatTask: async () => ({}),
  } };
});
vi.mock("@multiremi/core/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multiremi/core/logger")>();
  return { ...actual, createLogger: () => actual.noopLogger };
});
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "workspace-a" }));
vi.mock("@multiremi/core/auth", () => ({ useAuthStore: (select: (s: unknown) => unknown) => select({ user: { id: "user-a" } }) }));
vi.mock("@multiremi/core/platform", async (importOriginal) => ({
  ...await importOriginal<typeof import("@multiremi/core/platform")>(),
  getCurrentWsId: () => "workspace-a",
}));
vi.mock("@multiremi/core/agents", () => ({
  useWorkspaceAgentAvailability: () => "available",
  useAgentPresenceDetail: (_wsId: string | undefined, agentId: string | undefined): AgentPresenceDetail | "loading" => {
    backend.presenceCalls.push(agentId);
    const availability = agentId ? backend.availability[agentId] : undefined;
    return availability
      ? { availability, workload: "idle", runningCount: 0, queuedCount: 0, capacity: 1 }
      : "loading";
  },
}));
vi.mock("@multiremi/core/hooks/use-file-upload", () => ({ useFileUpload: () => ({ uploadWithToast: vi.fn() }) }));
vi.mock("@multiremi/core/realtime", () => ({ useChatScopeSubscription: () => {}, useTraceStreamSubscription: () => {} }));
vi.mock("@multiremi/core/session-log/use-issue-log", () => ({ useChatLog: (sessionId: string) => ({
  replica: { sessionId, refreshTailPreservingWindow: vi.fn(async () => {}), getSnapshot: () => ({ entries: [] }) },
  snapshot: { entries: [], head: null, ready: true }, error: false,
}) }));
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
vi.mock("./chat-message-list", () => ({ ChatMessageList: () => null, ChatMessageSkeleton: () => null }));
vi.mock("./human-request-dock", () => ({ HumanRequestDock: () => null }));
vi.mock("./no-agent-banner", () => ({ NoAgentBanner: () => null }));
vi.mock("./chat-queue", () => ({ ChatQueue: () => null }));
vi.mock("./chat-empty-state", () => ({ EmptyState: () => null }));
vi.mock("./agent-dropdown", () => ({ AgentDropdown: () => null }));
vi.mock("./session-dropdown", () => ({ SessionDropdown: () => null }));
vi.mock("./chat-input", () => ({ ChatInput: () => null }));
vi.mock("../../common/actor-avatar", () => ({
  // Only the page header's avatar carries a status-dot decision; sidebar rows do not.
  ActorAvatar: ({ actorId, showStatusDot }: { actorId: string; showStatusDot?: boolean }) => (
    showStatusDot === undefined
      ? <span data-agent={actorId} />
      : <span data-testid="header-avatar" data-agent={actorId} data-status-dot={String(showStatusDot)} />
  ),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), dismiss: vi.fn() }) }));

import { ChatWindow } from "./chat-window";

const remiChat: ChatSession = {
  id: "chat-remi", workspace_id: "workspace-a", agent_id: "agent-remi", creator_id: "user-a",
  project_id: null, title: "Chat with Remi", status: "active", has_unread: false, pinned: false, origin: null,
  unread_count: 0, last_message: null, created_at: "2026-10-19", updated_at: "2026-10-19",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function mountChat(sessionId: string) {
  const values = new Map<string, string>();
  const store = createChatStore({ storage: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
  } });
  store.getState().setActiveSession(sessionId);
  registerChatStore(store);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <I18nProvider locale="en" resources={{ en: { chat: enChat, issues: enIssues, runtimes: enRuntimes } }}>
        <ChatWindow presentation="page" />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

const agentsLoaded = (client: QueryClient) =>
  waitFor(() => expect(client.getQueryData(["workspaces", "workspace-a", "agents"])).toBeDefined());
const offlineBanner = () => screen.queryByText(/No online machine can run/);
const headerAvatar = () => screen.getByTestId("header-avatar");

beforeEach(() => {
  backend.sessions = Promise.resolve([]);
  backend.byId = {};
  backend.availability = { "agent-other": "offline", "agent-remi": "online" };
  backend.presenceCalls = [];
});

describe("ChatWindow presence while the open chat loads", () => {
  it("shows no presence for the fallback agent while the chat list loads", async () => {
    const sessions = deferred<unknown[]>();
    backend.sessions = sessions.promise;
    const view = mountChat(remiChat.id);
    try {
      await agentsLoaded(view.client);
      expect(headerAvatar()).toHaveAttribute("data-agent", "agent-other");
      expect(headerAvatar()).toHaveAttribute("data-status-dot", "false");
      expect(backend.presenceCalls).not.toContain("agent-other");
      expect(offlineBanner()).toBeNull();

      sessions.resolve([remiChat]);
      await waitFor(() => expect(headerAvatar()).toHaveAttribute("data-agent", "agent-remi"));
      expect(headerAvatar()).toHaveAttribute("data-status-dot", "true");
      expect(offlineBanner()).toBeNull();
      expect(backend.presenceCalls).not.toContain("agent-other");
    } finally { view.unmount(); view.client.clear(); }
  });

  it("shows no presence for the fallback agent while a chat outside the list is read by id", async () => {
    const record = deferred<unknown>();
    backend.byId = { [remiChat.id]: record.promise };
    const view = mountChat(remiChat.id);
    try {
      await agentsLoaded(view.client);
      await waitFor(() => expect(view.client.getQueryData(["chat", "workspace-a", "sessions"])).toBeDefined());
      expect(headerAvatar()).toHaveAttribute("data-agent", "agent-other");
      expect(offlineBanner()).toBeNull();

      record.resolve(remiChat);
      await waitFor(() => expect(headerAvatar()).toHaveAttribute("data-agent", "agent-remi"));
      expect(offlineBanner()).toBeNull();
      expect(backend.presenceCalls).not.toContain("agent-other");
    } finally { view.unmount(); view.client.clear(); }
  });

  it("shows the banner for the chat's own agent once its record says who that is", async () => {
    backend.availability["agent-remi"] = "offline";
    backend.sessions = Promise.resolve([remiChat]);
    const view = mountChat(remiChat.id);
    try {
      expect(await screen.findByText(/No online machine can run Remi/)).toBeInTheDocument();
      expect(screen.queryByText(/No online machine can run Other/)).toBeNull();
    } finally { view.unmount(); view.client.clear(); }
  });
});
