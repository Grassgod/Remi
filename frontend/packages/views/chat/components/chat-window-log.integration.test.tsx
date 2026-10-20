import { useState, type ReactNode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { HubFrame } from "@multiremi/contracts/live-hub";
import type { StreamSubscriptionHandlers } from "@multiremi/core/api/ws-client";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { ReplicaEnvProvider } from "@multiremi/core/platform/replica-env";
import { sharedTabsEnv } from "@multiremi/core/replica/test-tabs";
import { useIssueLog } from "@multiremi/core/session-log/use-issue-log";
import { clearChatLogPool } from "@multiremi/core/session-log/chat-log-pool";
import { createChatStore, registerChatStore } from "@multiremi/core/chat";
import {
  SessionLogEntrySchema, type IssueLogBootstrap, type LogWindowParams, type SessionLogRow, type SessionLogWindow,
} from "@multiremi/core/api/schemas/session-log";
import type { ChatSession } from "@multiremi/core/types";
import { at, message as traceMessage, traceTurn } from "../../test/trace-fixtures";
import enChat from "../../locales/en/chat.json";
import enIssues from "../../locales/en/issues.json";
import enMessages from "../../locales/en/messages.json";

const backend = vi.hoisted(() => ({
  read: vi.fn(), listMessages: vi.fn(), getChatQueue: vi.fn(),
  createChatSession: vi.fn(), getChatSession: vi.fn(), sendChatMessage: vi.fn(),
}));
const composer = vi.hoisted(() => ({ props: null as null | { agentName?: string; onSend: (content: string) => Promise<void> } }));
const socket = vi.hoisted(() => ({ subscribeStream: vi.fn(), onReconnect: vi.fn(() => () => {}) }));
vi.mock("@multiremi/core/api", async importOriginal => ({
  ...await importOriginal<typeof import("@multiremi/core/api")>(),
  api: {
    getSessionLog: backend.read, listMessages: backend.listMessages, getChatQueue: backend.getChatQueue,
    listAgents: async () => [{ id: "agent-a", name: "Alpha", archived_at: null, owner_id: "user-a" }],
    listMembers: async () => [{ id: "member-a", user_id: "user-a", role: "owner" }],
    listProjects: async () => ({ projects: [] }),
    listChatSessions: async () => [session],
    getPendingChatTask: async () => ({}),
    createChatSession: backend.createChatSession, getChatSession: backend.getChatSession,
    sendChatMessage: backend.sendChatMessage,
  },
}));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "workspace-a" }));
vi.mock("@multiremi/core/auth", () => ({ useAuthStore: (select: (s: unknown) => unknown) => select({ user: { id: "user-a" } }) }));
vi.mock("@multiremi/core/platform", async (importOriginal) => ({
  ...await importOriginal<typeof import("@multiremi/core/platform")>(),
  getCurrentWsId: () => "workspace-a",
}));
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
vi.mock("./chat-sidebar", () => ({ ChatSidebar: () => null }));
vi.mock("../../common/actor-avatar", () => ({ ActorAvatar: () => null }));
vi.mock("./chat-input", () => ({
  ChatInput: (props: NonNullable<typeof composer.props>) => { composer.props = props; return null; },
}));
vi.mock("../../runtimes/components/runtime-workspace-picker", () => ({ WorkLocationPicker: () => null }));
// A live turn reads its trace here: set one per attempt to show its steps and reply.
const traces = vi.hoisted(() => new Map<string, { turn: unknown; items: unknown[] }>());
vi.mock("../../common/task-transcript/use-task-trace", () => ({
  useTurnTrace: (id: string | null) => ({ turn: null, items: [], closed: false, loaded: false, error: false, retry: () => {}, read: null, head: 0,
    ...(id ? traces.get(id) : undefined) }),
  useCachedTurnTraces: (ids: readonly string[]) => ids.map((id) => traces.get(id) ?? { turn: null, items: [] }),
}));
vi.mock("../../common/markdown", () => ({ Markdown: ({ children }: { children: string }) => <span>{children}</span> }));
vi.mock("../../issues/components/comment-card", () => ({ AttachmentList: () => null }));

import { ChatWindow } from "./chat-window";

const session: ChatSession = {
  id: "chat-a", workspace_id: "workspace-a", agent_id: "agent-a", creator_id: "user-a",
  project_id: null, title: "Chat", status: "active", has_unread: false, pinned: false, origin: null,
  unread_count: 0, last_message: null, created_at: "2026-10-06", updated_at: "2026-10-06",
};
const memoryEnv = { hasOpfs: false };
const message = (seq: number, body: string) => SessionLogEntrySchema.parse({
  session_id: session.id, seq, id: `message-${seq}`, revision: 1, kind: "message",
  sender_type: "member", sender_id: "member-a", to_type: "agent", to_agent_id: "agent-a",
  message_kind: "request", body_md: body, body_html: null, render_version: null,
  metadata: { attachments: [], reactions: [] },
});
afterEach(() => { vi.clearAllMocks(); clearChatLogPool(); traces.clear(); });

it("N2 removes a deleted unread body through ChatWindow's real log chain before refresh or reconnect", async () => {
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
  backend.listMessages.mockImplementation(async () => ({ messages: [], next_cursor: null }));
  // An already deleted row is absent from the successful read route.
  backend.read.mockImplementation(async () => ({ ...initial.window, entries: [kept] }));
  backend.getChatQueue.mockResolvedValue({ items: [], paused: null });
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
    // The follow-up queue reads its own table; it does not list unread log rows.
    await waitFor(() => expect(backend.getChatQueue).toHaveBeenCalledWith(session.id));
    expect(screen.queryByRole("region", { name: "Queued messages" })).toBeNull();
    // The sender deletes the unread message (DELETE /api/messages/:id from the CLI or API).
    await act(async () => {
      onFrames!([{ seq: 2, kind: "patch", payload: {
        session_id: session.id, target_seq: 2, revision: 3,
        fields: { deleted_at: "2026-10-06T00:00:00Z" },
      } }]);
    });
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

it("reads the log tail once when the shown chat's pending turn settles, so its reply shows without frames", async () => {
  const sent = message(1, "QA_SETTLE_QUESTION");
  const reply = SessionLogEntrySchema.parse({
    session_id: session.id, seq: 3, id: "reply-3", revision: 2, kind: "message", sender_type: "agent", sender_id: "agent-a",
    author_type: "agent", to_type: "member", message_kind: "reply", body_md: "QA_SETTLE_REPLY", body_html: null, render_version: null,
    metadata: { attachments: [], reactions: [] },
  });
  const initial: IssueLogBootstrap = { sessionId: session.id, head: null, window: {
    entries: [sent], head_seq: 2, log_version: 1, has_more_before: false, has_more_after: false,
  } };
  // The stream delivers nothing: the turn's frames were lost or hidden.
  socket.subscribeStream.mockImplementation(() => ({ unsubscribe: vi.fn() }));
  backend.listMessages.mockImplementation(async () => ({ messages: [], next_cursor: null }));
  backend.read.mockImplementation(async () => ({ ...initial.window, entries: [sent, reply], head_seq: 3, log_version: 4 }));
  backend.getChatQueue.mockResolvedValue({ items: [], paused: null });
  registerChatStore(createChatStore({ storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const pendingKey = ["chat", "pending-task", session.id];
  client.setQueryData(pendingKey, { task_id: "task-1", turn_id: "task-1", status: "running", supports_queue: true });
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
    expect(main).toHaveTextContent(sent.body_md);
    expect(backend.read).not.toHaveBeenCalled();
    // chat:done settles the pending task: the live view goes away.
    await act(async () => { client.setQueryData(pendingKey, { supports_queue: true }); });
    await waitFor(() => expect(main).toHaveTextContent(reply.body_md));
    // The tail, then the seq between the window and the tail.
    expect(backend.read.mock.calls[0]).toEqual([session.id, { before: 30 }]);
  } finally { view.unmount(); client.clear(); }
});

it("keeps a finished turn's live reply on screen until the settle read brings its rows, then swaps them in", async () => {
  const sent = message(1, "QA_HANDOFF_QUESTION");
  const card = SessionLogEntrySchema.parse({
    session_id: session.id, seq: 2, id: "turn-1", revision: 3, kind: "turn", task_id: "attempt-1", author_type: "agent",
    body_md: "QA_HANDOFF_REPLY", body_html: null, render_version: null,
    metadata: { attachments: [], turn_id: "turn-1", status: "completed", final_entry_id: "reply-3" },
  });
  const reply = SessionLogEntrySchema.parse({
    session_id: session.id, seq: 3, id: "reply-3", revision: 1, kind: "message", sender_type: "agent", sender_id: "agent-a",
    author_type: "agent", to_type: "member", message_kind: "reply", task_id: "turn-1", body_md: "QA_HANDOFF_REPLY",
    body_html: null, render_version: null, metadata: { attachments: [], reactions: [] },
  });
  traces.set("attempt-1", {
    turn: traceTurn({ id: "attempt-1", turn_id: "turn-1", final_item_id: "final", final_started_at: at(5) }),
    items: [traceMessage("final", "QA_LIVE_REPLY", "final", { started_at: at(5) })],
  });
  const initial: IssueLogBootstrap = { sessionId: session.id, head: null, window: {
    entries: [sent], head_seq: 2, log_version: 1, has_more_before: false, has_more_after: false,
  } };
  // The turn's frames never come: only the read on settle brings its rows, late.
  socket.subscribeStream.mockImplementation(() => ({ unsubscribe: vi.fn() }));
  backend.listMessages.mockImplementation(async () => ({ messages: [], next_cursor: null }));
  let answer!: () => void;
  const answered = new Promise<void>((resolve) => { answer = resolve; });
  backend.read.mockImplementation(async () => {
    await answered;
    return { ...initial.window, entries: [sent, card, reply], head_seq: 3, log_version: 4 };
  });
  backend.getChatQueue.mockResolvedValue({ items: [], paused: null });
  registerChatStore(createChatStore({ storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const pendingKey = ["chat", "pending-task", session.id];
  client.setQueryData(pendingKey, { task_id: "attempt-1", turn_id: "turn-1", status: "running", supports_queue: true });
  const view = render(<QueryClientProvider client={client}>
    <I18nProvider locale="en" resources={{ en: { chat: enChat, issues: enIssues, messages: enMessages } }}>
      <ReplicaEnvProvider env={memoryEnv}>
        <ChatWindow presentation="page" initialSessionId={session.id} initialLog={initial} />
      </ReplicaEnvProvider>
    </I18nProvider>
  </QueryClientProvider>);
  try {
    const main = view.container.querySelector<HTMLElement>('[data-perf-scroll="session-log"]')!;
    await waitFor(() => expect(main).toHaveTextContent("QA_LIVE_REPLY"));
    // What each change to the list leaves on screen: the live reply, the row, or neither.
    const seen = new Set<string>();
    const observer = new MutationObserver(() => {
      seen.add(`${main.textContent!.includes("QA_LIVE_REPLY")}/${main.textContent!.includes("QA_HANDOFF_REPLY")}`);
    });
    observer.observe(main, { subtree: true, childList: true, characterData: true, attributes: true });
    // chat:done settles the pending task; the tail read it starts has not answered.
    await act(async () => { client.setQueryData(pendingKey, { supports_queue: true }); });
    await waitFor(() => expect(backend.read).toHaveBeenCalled());
    expect(main).toHaveTextContent("QA_LIVE_REPLY");
    expect(main.querySelector('[data-chat-live-turn="held"]')).not.toBeNull();
    expect(main).not.toHaveTextContent("QA_HANDOFF_REPLY");
    await act(async () => { answer(); });
    await waitFor(() => expect(main).toHaveTextContent("QA_HANDOFF_REPLY"));
    expect(main).not.toHaveTextContent("QA_LIVE_REPLY");
    expect(main.querySelector("[data-chat-live-turn]")).toBeNull();
    observer.disconnect();
    expect([...seen]).not.toContain("false/false");
    expect([...seen]).not.toContain("true/true");
  } finally { view.unmount(); client.clear(); }
});

/** One chat's read route. As on the server, every log write bumps `log_version`. */
function chatLog() {
  const rows: SessionLogRow[] = [];
  let version = 0;
  return {
    write(row: SessionLogRow) { rows.push(row); version += 1; },
    /** An in-place write: the same position at a higher revision. */
    replace(row: SessionLogRow) { rows.splice(rows.findIndex(existing => existing.seq === row.seq), 1, row); version += 1; },
    /** A write that changes no shown row, such as a turn status patch. */
    touch() { version += 1; },
    read(params: LogWindowParams): SessionLogWindow {
      const head = rows.at(-1)?.seq ?? 0;
      const anchor = params.anchor ?? head;
      const shown = rows.filter(row => row.visibility === "shown");
      const before = params.before ? shown.filter(row => row.seq <= anchor).slice(-params.before) : [];
      const after = params.after ? shown.filter(row => row.seq > anchor).slice(0, params.after) : [];
      return { entries: [...before, ...after], head_seq: head, log_version: version, has_more_before: false, has_more_after: false };
    },
  };
}

it("shows a new chat's first message as sent and its reply without a reload", async () => {
  const chatId = "chat-new";
  const created: ChatSession = { ...session, id: chatId, title: "Hello from a new chat" };
  const row = (seq: number, fields: Record<string, unknown>) => SessionLogEntrySchema.parse({
    session_id: chatId, seq, id: `row-${seq}`, revision: 1, body_html: null, render_version: null,
    metadata: { attachments: [], reactions: [] }, ...fields,
  });
  const log = chatLog();
  let routeLog: IssueLogBootstrap | undefined;
  backend.createChatSession.mockImplementation(async () => {
    log.write(row(0, { kind: "head", body_md: created.title }));
    return created;
  });
  backend.getChatSession.mockResolvedValue(created);
  backend.sendChatMessage.mockImplementation(async (_id: string, body: string, _attachments: unknown, clientId: string) => {
    // The page navigates to `?session=` before the send lands, so the route's
    // bootstrap read still holds an empty chat.
    routeLog = { sessionId: chatId, head: null, window: log.read({ before: 30 }) };
    log.write(row(1, { kind: "message", sender_type: "member", sender_id: "member-a", to_type: "agent",
      to_agent_id: "agent-a", message_kind: "request", body_md: body, dedupe_key: clientId }));
    log.write(row(2, { kind: "turn", visibility: "hidden", body_md: "" }));
    return { message_id: "row-1", task_id: "attempt-1", turn_id: "turn-1", created_at: "2026-10-16", supports_queue: true, queued: false };
  });
  backend.read.mockImplementation(async (_id: string, params: LogWindowParams) => log.read(params));
  backend.listMessages.mockResolvedValue({ messages: [], next_cursor: null });
  backend.getChatQueue.mockResolvedValue({ items: [], paused: null });
  // The Hub replays from the subscription's `from_seq`; message rows travel as
  // bare entries the replica hydrates through the read route.
  const streams = new Map<string, { handlers: StreamSubscriptionHandlers; fromSeq: number }>();
  socket.subscribeStream.mockImplementation((_stream, id: string, handlers: StreamSubscriptionHandlers, options?: { fromSeq?: number }) => {
    streams.set(id, { handlers, fromSeq: options?.fromSeq ?? 1 });
    return { unsubscribe: vi.fn() };
  });
  const publish = (frames: HubFrame[]) => {
    const stream = streams.get(chatId)!;
    const replay = frames.filter(frame => frame.seq >= stream.fromSeq);
    if (replay.length) stream.handlers.onFrames?.(replay);
  };
  const entry = (seq: number, kind: string): HubFrame => ({ seq, kind: "entry", payload: { session_id: chatId, seq, id: `row-${seq}`, kind, revision: 1 } });
  let showRoute!: (route: { sessionId?: string; log?: IssueLogBootstrap }) => void;
  function ChatRoute() {
    const [route, setRoute] = useState<{ sessionId?: string; log?: IssueLogBootstrap }>({});
    showRoute = setRoute;
    return <ChatWindow presentation="page" initialSessionId={route.sessionId} initialLog={route.log} />;
  }
  const store = createChatStore({ storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
  registerChatStore(store);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(<QueryClientProvider client={client}>
    <I18nProvider locale="en" resources={{ en: { chat: enChat, issues: enIssues, messages: enMessages } }}>
      <ReplicaEnvProvider env={memoryEnv}><ChatRoute /></ReplicaEnvProvider>
    </I18nProvider>
  </QueryClientProvider>);
  try {
    await waitFor(() => expect(composer.props?.agentName).toBe("Alpha"));
    await act(async () => { await composer.props!.onSend("Hello from a new chat"); });
    await waitFor(() => expect(streams.has(chatId)).toBe(true));
    // The route answers the navigation with its bootstrap after the chat is
    // already showing; the live log must not restart from that older read.
    await act(async () => { showRoute({ sessionId: chatId, log: routeLog }); });
    await act(async () => {
      streams.get(chatId)!.handlers.onAck?.({ stream: "log", id: chatId, first_seq: 0, head_seq: 2, log_version: null, gap: null });
      publish([entry(1, "message"), { seq: 2, kind: "entry", payload: { session_id: chatId, seq: 2, revision: 1, visibility: "hidden" } }]);
    });
    const main = () => view.container.querySelector<HTMLElement>('[data-perf-scroll="session-log"]');
    await waitFor(() => expect(main()).toHaveTextContent("Hello from a new chat"));
    await waitFor(() => expect(main()).toHaveTextContent("Sent"));
    expect(main()).not.toHaveTextContent("Sending…");

    // The turn's own writes move `log_version` past every window the page has read.
    log.touch();
    log.write(row(3, { kind: "message", sender_type: "agent", sender_id: "agent-a", to_type: "member",
      message_kind: "reply", body_md: "Reply from Alpha" }));
    await act(async () => { publish([entry(3, "message")]); });
    await waitFor(() => expect(main()).toHaveTextContent("Reply from Alpha"));
    expect(socket.subscribeStream.mock.calls.filter(([, id]) => id === chatId)).toHaveLength(1);
  } finally { view.unmount(); client.clear(); }
});

/**
 * The floating chat over an Issue detail: two session logs on one page share
 * the replica lock. The Issue log connected first, so it leads and its socket
 * carries the chat's stream; the chat follows. The leader used to refuse the
 * chat's frames, so a second turn's reply never appeared until a remount.
 */
it.each(["without", "with"])("shows a second turn's reply and finished fold live in a following chat, %s a released queued message", async (queue) => {
  const issueLog = chatLog();
  const log = chatLog();
  const chatRow = (seq: number, fields: Record<string, unknown>) => SessionLogEntrySchema.parse({
    session_id: session.id, seq, id: `row-${seq}`, revision: 1, body_html: null, render_version: null,
    visibility: "shown", metadata: { attachments: [], reactions: [] }, ...fields,
  });
  issueLog.write(SessionLogEntrySchema.parse({ session_id: "ises_issue", seq: 0, id: "issue-head", revision: 1, kind: "head",
    body_md: "Issue", body_html: null, render_version: null, metadata: { attachments: [] } }));
  log.write(chatRow(0, { kind: "head", body_md: session.title }));
  log.write(chatRow(1, { kind: "message", sender_type: "member", sender_id: "member-a", to_type: "agent", to_agent_id: "agent-a",
    message_kind: "request", body_md: "First question" }));
  log.write(chatRow(2, { kind: "message", sender_type: "agent", sender_id: "agent-a", to_type: "member", message_kind: "final",
    task_id: "turn-1", body_md: "First answer" }));
  backend.read.mockImplementation(async (id: string, params: LogWindowParams) => (id === session.id ? log : issueLog).read(params));
  backend.getChatSession.mockResolvedValue(session);
  backend.listMessages.mockResolvedValue({ messages: [], next_cursor: null });
  backend.getChatQueue.mockResolvedValue({ items: [], paused: null });
  backend.sendChatMessage.mockImplementation(async (_id: string, body: string, _attachments: unknown, clientId: string) => {
    log.write(chatRow(3, { kind: "message", sender_type: "member", sender_id: "member-a", to_type: "agent",
      to_agent_id: "agent-a", message_kind: "request", body_md: body, dedupe_key: clientId }));
    // The turn's card takes its position now and stays hidden while it runs.
    log.write(chatRow(4, { kind: "turn", visibility: "hidden", task_id: "attempt-2", body_md: "" }));
    return { message_id: "row-3", task_id: "attempt-2", turn_id: "turn-2", created_at: "2026-10-17", supports_queue: true, queued: false };
  });
  const streams = new Map<string, StreamSubscriptionHandlers[]>();
  socket.subscribeStream.mockImplementation((_stream, id: string, handlers: StreamSubscriptionHandlers) => {
    streams.set(id, [...(streams.get(id) ?? []), handlers]);
    return { unsubscribe: vi.fn() };
  });
  const publish = (frames: HubFrame[]) => { for (const handlers of streams.get(session.id) ?? []) handlers.onFrames?.(frames); };
  const entry = (seq: number, kind: string, revision = 1): HubFrame =>
    ({ seq, kind: "entry", payload: { session_id: session.id, seq, id: `row-${seq}`, kind, revision } });
  function IssueDetailLog() {
    useIssueLog("ises_issue", undefined, undefined, false, true);
    return null;
  }
  let showChat!: (shown: boolean) => void;
  function Page() {
    const [shown, setShown] = useState(false);
    showChat = setShown;
    return <><IssueDetailLog />{shown && <ChatWindow presentation="page" initialSessionId={session.id} />}</>;
  }
  const store = createChatStore({ storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
  registerChatStore(store);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(<QueryClientProvider client={client}>
    <I18nProvider locale="en" resources={{ en: { chat: enChat, issues: enIssues, messages: enMessages } }}>
      <ReplicaEnvProvider env={sharedTabsEnv()}><Page /></ReplicaEnvProvider>
    </I18nProvider>
  </QueryClientProvider>);
  const main = () => view.container.querySelector<HTMLElement>('[data-perf-scroll="session-log"]');
  try {
    // The Issue log leads.
    await waitFor(() => expect(streams.has("ises_issue")).toBe(true));
    await act(async () => { showChat(true); });
    await waitFor(() => expect(main()).toHaveTextContent("First answer"));
    // The chat follows: the leader's socket subscribes for it, once.
    await waitFor(() => expect(streams.get(session.id)).toHaveLength(1));
    await waitFor(() => expect(composer.props?.agentName).toBe("Alpha"));

    await act(async () => { await composer.props!.onSend("Second question"); });
    await act(async () => { publish([entry(3, "message"), { seq: 4, kind: "entry", payload: { session_id: session.id, seq: 4, revision: 1, visibility: "hidden" } }]); });
    await waitFor(() => expect(main()).toHaveTextContent("Second question"));

    // The turn ends: the reply, the card re-sent finished at its old position
    // (a higher revision), and a queued follow-up the lane released.
    log.write(chatRow(5, { kind: "message", sender_type: "agent", sender_id: "agent-a", to_type: "member", message_kind: "final",
      task_id: "turn-2", body_md: "Second answer" }));
    const finished = chatRow(4, { kind: "turn", task_id: "attempt-2", revision: 3, body_md: "",
      metadata: { attachments: [], turn_id: "turn-2", status: "completed", final_entry_id: "row-5", process_item_count: 2, worked_ms: 9000 } });
    log.replace(finished);
    if (queue === "with") log.write(chatRow(6, { kind: "message", sender_type: "member", sender_id: "member-a", to_type: "agent",
      to_agent_id: "agent-a", message_kind: "request", body_md: "Queued follow-up" }));
    await act(async () => { publish([entry(5, "message"), entry(4, "turn", 3), ...(queue === "with" ? [entry(6, "message")] : [])]); });

    await waitFor(() => expect(main()).toHaveTextContent("Second answer"));
    const reply = () => main()!.querySelector<HTMLElement>('[data-perf-key="row-5"]');
    await waitFor(() => expect(reply()?.querySelector('[data-chat-steps="finished"]')).not.toBeNull());
    if (queue === "with") {
      await waitFor(() => expect(main()).toHaveTextContent("Queued follow-up"));
      expect(main()!.textContent!.indexOf("Second answer")).toBeLessThan(main()!.textContent!.indexOf("Queued follow-up"));
    }
    expect(streams.get(session.id)).toHaveLength(1);
  } finally { view.unmount(); client.clear(); }
});

it("paints a chat shown again from the log pool before its tail read answers, then refreshes it once", async () => {
  const other: ChatSession = { ...session, id: "chat-b", title: "Other chat" };
  const logs = new Map([[session.id, chatLog()], [other.id, chatLog()]]);
  const chatRow = (sessionId: string, seq: number, body: string) => SessionLogEntrySchema.parse({
    session_id: sessionId, seq, id: `${sessionId}-${seq}`, revision: 1, kind: "message", visibility: "shown",
    sender_type: "member", sender_id: "member-a", to_type: "agent", to_agent_id: "agent-a", message_kind: "request",
    body_md: body, body_html: null, render_version: null, metadata: { attachments: [], reactions: [] },
  });
  logs.get(session.id)!.write(chatRow(session.id, 1, "Alpha question"));
  logs.get(other.id)!.write(chatRow(other.id, 1, "Beta question"));
  const reads: Array<[string, LogWindowParams]> = [];
  let hold: Promise<void> | null = null;
  backend.read.mockImplementation(async (id: string, params: LogWindowParams) => {
    reads.push([id, params]);
    if (hold && id === session.id) await hold;
    return logs.get(id)!.read(params);
  });
  backend.getChatSession.mockImplementation(async (id: string) => (id === other.id ? other : session));
  backend.listMessages.mockResolvedValue({ messages: [], next_cursor: null });
  backend.getChatQueue.mockResolvedValue({ items: [], paused: null });
  socket.subscribeStream.mockImplementation(() => ({ unsubscribe: vi.fn() }));
  let show!: (sessionId: string) => void;
  function ChatRoute() {
    const [sessionId, setSessionId] = useState(session.id);
    show = setSessionId;
    return <ChatWindow presentation="page" initialSessionId={sessionId} />;
  }
  const store = createChatStore({ storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
  registerChatStore(store);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(<QueryClientProvider client={client}>
    <I18nProvider locale="en" resources={{ en: { chat: enChat, issues: enIssues, messages: enMessages } }}>
      <ReplicaEnvProvider env={memoryEnv}><ChatRoute /></ReplicaEnvProvider>
    </I18nProvider>
  </QueryClientProvider>);
  const main = () => view.container.querySelector<HTMLElement>('[data-perf-scroll="session-log"]');
  try {
    await waitFor(() => expect(main()).toHaveTextContent("Alpha question"));
    await waitFor(() => expect(socket.subscribeStream).toHaveBeenCalledTimes(1));
    await act(async () => { show(other.id); });
    await waitFor(() => expect(main()).toHaveTextContent("Beta question"));
    await waitFor(() => expect(socket.subscribeStream).toHaveBeenCalledTimes(2));

    // The first chat is answered while the other is shown; its next read is slow.
    logs.get(session.id)!.write(chatRow(session.id, 2, "Alpha answer"));
    let answer!: () => void;
    hold = new Promise(resolve => { answer = resolve; });
    const before = reads.length;
    await act(async () => { show(session.id); });
    expect(main()).toHaveTextContent("Alpha question");
    expect(main()).not.toHaveTextContent("Beta question");
    expect(reads.slice(before)).toEqual([[session.id, { before: 30 }]]);

    await act(async () => { answer(); });
    await waitFor(() => expect(main()).toHaveTextContent("Alpha answer"));
    await waitFor(() => expect(socket.subscribeStream).toHaveBeenCalledTimes(3));
    // One background tail read on return, and Chat never reads the seq-0 head.
    expect(reads.slice(before)).toEqual([[session.id, { before: 30 }]]);
    expect(reads.some(([, params]) => params.anchor === 0 && params.before === 1)).toBe(false);
  } finally { view.unmount(); client.clear(); }
});
