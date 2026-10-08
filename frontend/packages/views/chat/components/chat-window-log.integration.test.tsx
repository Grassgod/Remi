import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { HubFrame } from "@multiremi/contracts/live-hub";
import type { StreamSubscriptionHandlers } from "@multiremi/core/api/ws-client";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { ReplicaEnvProvider } from "@multiremi/core/platform/replica-env";
import { createChatStore, registerChatStore } from "@multiremi/core/chat";
import { SessionLogEntrySchema, type IssueLogBootstrap } from "@multiremi/core/api/schemas/session-log";
import type { ChatSession } from "@multiremi/core/types";
import enChat from "../../locales/en/chat.json";
import enIssues from "../../locales/en/issues.json";
import enMessages from "../../locales/en/messages.json";

const backend = vi.hoisted(() => ({ read: vi.fn(), listMessages: vi.fn(), deleteMessage: vi.fn() }));
const socket = vi.hoisted(() => ({ subscribeStream: vi.fn(), onReconnect: vi.fn(() => () => {}) }));
vi.mock("@multiremi/core/api", async importOriginal => ({
  ...await importOriginal<typeof import("@multiremi/core/api")>(),
  api: {
    getSessionLog: backend.read, listMessages: backend.listMessages, deleteMessage: backend.deleteMessage,
    listAgents: async () => [{ id: "agent-a", name: "Alpha", archived_at: null, owner_id: "user-a" }],
    listMembers: async () => [{ id: "member-a", user_id: "user-a", role: "owner" }],
    listProjects: async () => ({ projects: [] }),
    listChatSessions: async () => [session],
    getPendingChatTask: async () => ({}),
  },
}));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "workspace-a" }));
vi.mock("@multiremi/core/auth", () => ({ useAuthStore: (select: (s: unknown) => unknown) => select({ user: { id: "user-a" } }) }));
vi.mock("@multiremi/core/platform", () => ({ getCurrentWsId: () => "workspace-a" }));
vi.mock("@multiremi/core/agents", () => ({ useWorkspaceAgentAvailability: () => "available", useAgentPresenceDetail: () => "loading" }));
vi.mock("@multiremi/core/hooks/use-file-upload", () => ({ useFileUpload: () => ({ uploadWithToast: vi.fn() }) }));
vi.mock("@multiremi/core/workspace/hooks", () => ({ useActorName: () => ({ getActorName: (_type: string, id: string) => id }) }));
vi.mock("@multiremi/core/realtime", () => ({ useWS: () => socket, useTraceStreamSubscription: vi.fn() }));
vi.mock("@multiremi/core/paths", async importOriginal => {
  const actual = await importOriginal<typeof import("@multiremi/core/paths")>();
  return { ...actual, useWorkspacePaths: () => actual.paths.workspace("test") };
});
vi.mock("@multiremi/views/issues/components", () => ({ canAssignAgent: () => true }));
vi.mock("../../navigation", () => ({ useNavigation: () => ({ push: vi.fn() }) }));
vi.mock("../../layout/page-header", () => ({ PageHeader: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("./use-chat-resize", () => ({ useChatResize: () => ({ boundsReady: true }) }));
vi.mock("./use-chat-context-items", () => ({ useChatContextItems: () => [] }));
vi.mock("./human-request-dock", () => ({ HumanRequestDock: () => null }));
vi.mock("./offline-banner", () => ({ OfflineBanner: () => null }));
vi.mock("./no-agent-banner", () => ({ NoAgentBanner: () => null }));
vi.mock("./agent-dropdown", () => ({ AgentDropdown: () => null }));
vi.mock("./session-dropdown", () => ({ SessionDropdown: () => null }));
vi.mock("./chat-input", () => ({ ChatInput: () => null }));
vi.mock("../../common/markdown", () => ({ Markdown: ({ children }: { children: string }) => <span>{children}</span> }));
vi.mock("../../issues/components/comment-card", () => ({ AttachmentList: () => null }));

import { ChatWindow } from "./chat-window";

const session: ChatSession = {
  id: "chat-a", workspace_id: "workspace-a", agent_id: "agent-a", creator_id: "user-a",
  project_id: null, title: "Chat", status: "active", has_unread: false, pinned: false,
  unread_count: 0, last_message: null, created_at: "2026-10-06", updated_at: "2026-10-06",
};
const memoryEnv = { hasOpfs: false };
const message = (seq: number, body: string) => SessionLogEntrySchema.parse({
  session_id: session.id, seq, id: `message-${seq}`, revision: 1, kind: "message",
  sender_type: "member", sender_id: "member-a", to_type: "agent", to_agent_id: "agent-a",
  message_kind: "request", body_md: body, body_html: null, render_version: null,
  metadata: { attachments: [], reactions: [] },
});
afterEach(() => { vi.clearAllMocks(); });

it("N2 removes an unread body through ChatWindow's real log chain before refresh or reconnect", async () => {
  const kept = message(1, "QA509_EDIT_AFTER");
  const deleted = message(2, "QA509_DELETE_NEVER");
  const initial: IssueLogBootstrap = { sessionId: session.id, head: null, window: {
    entries: [kept, deleted], head_seq: 2, log_version: 1, has_more_before: false, has_more_after: false,
  } };
  let onFrames: ((frames: readonly HubFrame[]) => void) | undefined;
  socket.subscribeStream.mockImplementation((_stream, _id, handlers: StreamSubscriptionHandlers) => {
    onFrames = handlers.onFrames;
    return { unsubscribe: vi.fn() };
  });
  let unread = [kept, deleted];
  backend.listMessages.mockImplementation(async () => ({ messages: unread, next_cursor: null }));
  // An already deleted row is absent from the successful read route.
  backend.read.mockImplementation(async () => ({ ...initial.window, entries: unread }));
  backend.deleteMessage.mockImplementation(async () => {
    unread = [kept];
    onFrames!([{ seq: 2, kind: "patch", payload: {
      session_id: session.id, target_seq: 2, revision: 3,
      fields: { deleted_at: "2026-10-06T00:00:00Z" },
    } }]);
  });
  const store = createChatStore({ storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
  registerChatStore(store);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(<QueryClientProvider client={client}>
    <I18nProvider locale="en" resources={{ en: { chat: enChat, issues: enIssues, messages: enMessages } }}>
      <ReplicaEnvProvider env={memoryEnv}>
        <ChatWindow presentation="page" initialSessionId={session.id} initialLog={initial} />
      </ReplicaEnvProvider>
    </I18nProvider>
  </QueryClientProvider>);
  try {
    await waitFor(() => expect(socket.subscribeStream).toHaveBeenCalledOnce());
    const main = view.container.querySelector<HTMLElement>('[data-perf-scroll="session-log"]')!;
    expect(main).toHaveTextContent(kept.body_md);
    expect(main).toHaveTextContent(deleted.body_md);
    const queue = await screen.findByRole("region", { name: "Unread messages" });
    await waitFor(() => expect(within(queue).getAllByRole("button", { name: "Remove queued message" })).toHaveLength(2));
    fireEvent.click(within(queue).getAllByRole("button", { name: "Remove queued message" })[1]!);
    await waitFor(() => expect(backend.deleteMessage).toHaveBeenCalledWith(deleted.id));
    await waitFor(() => expect(within(queue).getAllByRole("button", { name: "Remove queued message" })).toHaveLength(1));
    await waitFor(() => expect(main).not.toHaveTextContent(deleted.body_md));
    expect(main).toHaveTextContent(kept.body_md);
    expect(main.querySelectorAll('[data-perf-item="message"]')).toHaveLength(1);
    expect(backend.read).not.toHaveBeenCalled();
    expect(socket.subscribeStream).toHaveBeenCalledOnce();
    await act(async () => { onFrames!([{ seq: 2, kind: "entry", payload: deleted }]); });
    expect(main).not.toHaveTextContent(deleted.body_md);
    expect(main).toHaveTextContent(kept.body_md);
  } finally { view.unmount(); client.clear(); }
});
