import type { ReactNode } from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { ReplicaEnvProvider } from "@multiremi/core/platform/replica-env";
import { clearChatLogPool } from "@multiremi/core/session-log/chat-log-pool";
import { createChatStore, registerChatStore } from "@multiremi/core/chat";
import { SessionLogEntrySchema, type IssueLogBootstrap } from "@multiremi/core/api/schemas/session-log";
import type { ChatQueue as ChatQueueData, QueuedChatMessage } from "@multiremi/core/chat/queue";
import type { ChatSession } from "@multiremi/core/types";
import enChat from "../../locales/en/chat.json";
import enIssues from "../../locales/en/issues.json";
import enMessages from "../../locales/en/messages.json";

/**
 * A running Chat whose question lines, queued follow-ups and offline banner
 * answer after its log: each lands between the list and the composer once the
 * list is already revealed at its end, so the list's viewport shrinks while its
 * content does not. The real `HumanRequestDock`, `ChatQueue` and `OfflineBanner`
 * render here; jsdom has no layout, so the scroll root's height is derived from
 * which of them are on the page, the way the flex column would size it.
 */

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const backend = vi.hoisted(() => ({ listMessages: vi.fn(), getChatQueue: vi.fn() }));
const socket = vi.hoisted(() => ({ subscribeStream: vi.fn(() => ({ unsubscribe: () => {} })), onReconnect: vi.fn(() => () => {}) }));
const presence = vi.hoisted(() => ({ detail: "loading" as "loading" | { availability: "offline" } }));
const running = vi.hoisted(() => ({ task_id: "turn-1", turn_id: "turn-1", status: "awaiting_human", supports_queue: true }));
vi.mock("@multiremi/core/api", async importOriginal => ({
  ...await importOriginal<typeof import("@multiremi/core/api")>(),
  api: {
    getSessionLog: vi.fn(), listMessages: backend.listMessages, getChatQueue: backend.getChatQueue,
    // The question line's own read never answers: its skeleton line has the line's height.
    getQuestion: () => new Promise(() => {}),
    listAgents: async () => [{ id: "agent-a", name: "Alpha", archived_at: null, owner_id: "user-a" }],
    listMembers: async () => [{ id: "member-a", user_id: "user-a", role: "owner" }],
    listProjects: async () => ({ projects: [] }),
    listChatSessions: async () => [session],
    getPendingChatTask: async () => running,
  },
}));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "workspace-a" }));
vi.mock("@multiremi/core/auth", () => ({ useAuthStore: (select: (s: unknown) => unknown) => select({ user: { id: "user-a" } }) }));
vi.mock("@multiremi/core/platform", async (importOriginal) => ({
  ...await importOriginal<typeof import("@multiremi/core/platform")>(),
  getCurrentWsId: () => "workspace-a",
}));
vi.mock("@multiremi/core/agents", () => ({ useWorkspaceAgentAvailability: () => "available", useAgentPresenceDetail: () => presence.detail }));
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
vi.mock("./no-agent-banner", () => ({ NoAgentBanner: () => null }));
vi.mock("./agent-dropdown", () => ({ AgentDropdown: () => null }));
vi.mock("./session-dropdown", () => ({ SessionDropdown: () => null }));
vi.mock("./chat-sidebar", () => ({ ChatSidebar: () => null }));
vi.mock("../../common/actor-avatar", () => ({ ActorAvatar: () => null }));
vi.mock("./chat-input", () => ({ ChatInput: () => null }));
vi.mock("../../runtimes/components/runtime-workspace-picker", () => ({ WorkLocationPicker: () => null }));
vi.mock("../../common/task-transcript/use-task-trace", () => ({
  useTurnTrace: () => ({ turn: null, items: [], closed: false, loaded: false, error: false, retry: () => {}, read: null, head: 0 }),
  useCachedTurnTraces: (ids: readonly string[]) => ids.map(() => ({ turn: null, items: [] })),
}));
vi.mock("../../common/markdown", () => ({ Markdown: ({ children }: { children: string }) => <span>{children}</span> }));
vi.mock("../../issues/components/comment-card", () => ({ AttachmentList: () => null }));

import { ChatWindow } from "./chat-window";

const session: ChatSession = {
  id: "chat-a", workspace_id: "workspace-a", agent_id: "agent-a", creator_id: "user-a",
  project_id: null, title: "Chat", status: "active", has_unread: false, pinned: false, origin: null,
  unread_count: 0, last_message: null, created_at: "2026-10-06", updated_at: "2026-10-06",
};
const queued = (index: number): QueuedChatMessage => ({
  id: `qmsg_${index}`, session_id: session.id, body_md: `Follow-up ${index}`, attachments: [],
  client_id: `client-${index}`, status: "queued", error: null, revision: 1, released_message_id: null,
  released_via: null, released_at: null, created_at: "2026-10-06T00:00:00Z", updated_at: "2026-10-06T00:00:00Z",
});
const question = {
  id: "q-1", task_id: "turn-1", resolved_at: null, created_at: "2026-10-06T00:00:00Z",
  metadata: { human_request: { kind: "question", payload: { questions: [{ question: "Which tickets?", options: [{ label: "Last three" }] }] } } },
};

/** Viewport the column leaves the list once the chrome under it is on the page. */
const COLUMN_PX = 600;
const DOCK_PX = 48;
const QUEUE_PX = 120;
const BANNER_PX = 34;
const CONTENT_PX = 1500;

let observers: Array<{ callback: ResizeObserverCallback; targets: Set<Element> }>;
let originalResizeObserver: typeof ResizeObserver;
beforeEach(() => {
  observers = [];
  originalResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class implements ResizeObserver {
    private readonly state: { callback: ResizeObserverCallback; targets: Set<Element> };
    constructor(callback: ResizeObserverCallback) {
      this.state = { callback, targets: new Set() };
      observers.push(this.state);
    }
    observe(target: Element) { this.state.targets.add(target); }
    unobserve(target: Element) { this.state.targets.delete(target); }
    disconnect() { this.state.targets.clear(); }
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  globalThis.ResizeObserver = originalResizeObserver;
  vi.clearAllMocks();
  clearChatLogPool();
});

/** The browser's delivery after layout: observers of an element whose size changed. */
function resized(element: Element): void {
  for (const observer of [...observers]) {
    if (!observer.targets.has(element)) continue;
    observer.callback([{ target: element, contentRect: element.getBoundingClientRect() } as unknown as ResizeObserverEntry], {} as ResizeObserver);
  }
}

it("keeps a running chat at its end when its question lines and queued follow-ups load after the log", async () => {
  const rows = Array.from({ length: 6 }, (_, index) => SessionLogEntrySchema.parse({
    session_id: session.id, seq: index + 1, id: `message-${index + 1}`, revision: 1, kind: "message",
    sender_type: "member", sender_id: "member-a", to_type: "agent", to_agent_id: "agent-a",
    message_kind: "request", body_md: `Question ${index + 1}`, body_html: null, render_version: null,
    metadata: { attachments: [], reactions: [] },
  }));
  const initial: IssueLogBootstrap = { sessionId: session.id, head: null, window: {
    entries: rows, head_seq: rows.length, log_version: 1, has_more_before: false, has_more_after: false,
  } };
  const dock = deferred<{ messages: unknown[]; next_cursor: null }>();
  const queue = deferred<ChatQueueData>();
  backend.listMessages.mockImplementation((_id: string, params: { message_kind?: string }) =>
    params?.message_kind === "decision" ? dock.promise : Promise.resolve({ messages: [], next_cursor: null }));
  backend.getChatQueue.mockImplementation(() => queue.promise);
  registerChatStore(createChatStore({ storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(["chat", "pending-task", session.id], running);
  presence.detail = "loading";
  const tree = () => <QueryClientProvider client={client}>
    <I18nProvider locale="en" resources={{ en: { chat: enChat, issues: enIssues, messages: enMessages } }}>
      <ReplicaEnvProvider env={{ hasOpfs: false }}>
        <ChatWindow presentation="page" initialSessionId={session.id} initialLog={initial} />
      </ReplicaEnvProvider>
    </I18nProvider>
  </QueryClientProvider>;
  const view = render(tree());
  try {
    const root = await waitFor(() => {
      const element = view.container.querySelector<HTMLElement>('[data-perf-scroll="session-log"]');
      expect(element).not.toBeNull();
      return element!;
    });
    const dockShown = () => [...view.container.querySelectorAll("[data-question-summary]")].some((line) => !root.contains(line));
    const queueShown = () => view.container.querySelector("[data-chat-queue]") !== null;
    let scrollTop = 0;
    const bannerShown = () => (view.container.textContent ?? "").includes("No online machine can run Alpha");
    const clientHeight = () => COLUMN_PX - (dockShown() ? DOCK_PX : 0) - (queueShown() ? QUEUE_PX : 0)
      - (bannerShown() ? BANNER_PX : 0);
    Object.defineProperty(root, "scrollHeight", { configurable: true, get: () => CONTENT_PX });
    Object.defineProperty(root, "clientHeight", { configurable: true, get: clientHeight });
    Object.defineProperty(root, "clientWidth", { configurable: true, get: () => 800 });
    Object.defineProperty(root, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = Math.max(0, Math.min(value, CONTENT_PX - clientHeight())); },
    });
    const distance = () => root.scrollHeight - root.scrollTop - root.clientHeight;

    // The pre-paint script positions the server-rendered log at its end and
    // reveals it; the list confirms that from the attributes and starts sticking.
    await act(async () => {
      root.scrollTop = root.scrollHeight;
      root.dataset.ssrPositioned = "1";
      root.dataset.perfState = "ready";
    });
    expect(root.dataset.stickState).toBe("pinned");
    expect(distance()).toBe(0);
    expect(dockShown() || queueShown() || bannerShown()).toBe(false);

    // The follow-up queue answers, then the question lines, then presence: each
    // appears under the list, and the browser reports the scroll root's new
    // size after layout.
    await act(async () => { queue.resolve({ items: [queued(1), queued(2)], paused: null }); });
    await waitFor(() => expect(queueShown()).toBe(true));
    act(() => { resized(root); });
    expect(distance()).toBe(0);

    await act(async () => { dock.resolve({ messages: [question], next_cursor: null }); });
    await waitFor(() => expect(dockShown()).toBe(true));
    act(() => { resized(root); });
    expect(distance()).toBe(0);

    presence.detail = { availability: "offline" };
    view.rerender(tree());
    expect(bannerShown()).toBe(true);
    act(() => { resized(root); });
    expect(root.clientHeight).toBe(COLUMN_PX - DOCK_PX - QUEUE_PX - BANNER_PX);
    expect(distance()).toBe(0);

    // Whatever scroll event follows is not the reader leaving: no release, no arrow.
    act(() => { fireEvent.scroll(root); });
    expect(root.dataset.stickState).toBe("pinned");
    expect(view.container.querySelector("[data-session-log-scroll-bottom]")).toBeNull();
  } finally { view.unmount(); client.clear(); }
});
