import type { ReactNode } from "react";
import { act, configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubFrame } from "@multiremi/contracts/live-hub";
import type { StreamSubscriptionHandlers } from "@multiremi/core/api/ws-client";
import { ApiError } from "@multiremi/core/api";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { ReplicaEnvProvider } from "@multiremi/core/platform/replica-env";
import { CHAT_SEND_TIMEOUT_MS, createChatStore, registerChatStore } from "@multiremi/core/chat";
import { CHAT_PENDING_REFETCH_INTERVAL_MS, chatKeys } from "@multiremi/core/chat/queries";
import { clearChatLogPool } from "@multiremi/core/session-log/chat-log-pool";
import { SessionLogEntrySchema, type LogWindowParams, type SessionLogRow, type SessionLogWindow } from "@multiremi/core/api/schemas/session-log";
import type { ChatSession, SendChatMessageResponse } from "@multiremi/core/types";
import enChat from "../../locales/en/chat.json";
import enCommon from "../../locales/en/common.json";
import enIssues from "../../locales/en/issues.json";
import enMessages from "../../locales/en/messages.json";

/**
 * The send flow through the real ChatPage, ChatWindow, ChatInput, editor,
 * store and session log replica. The API and the socket are mocked: a POST,
 * its turn read and the log reads can each be held, failed or answered.
 *
 * The clock is faked (it still moves with real time, so waits and the editor
 * work as usual): the send timeout, the fallback read's cadence, the
 * composer's draft debounce and the Sent label's fade are stepped over
 * explicitly, so no test depends on how fast the machine is.
 */
const backend = vi.hoisted(() => ({
  read: vi.fn(), send: vi.fn(), turn: vi.fn(), create: vi.fn(), list: vi.fn(), pending: vi.fn(),
  sessions: [] as ChatSession[],
}));
const socket = vi.hoisted(() => ({ subscribeStream: vi.fn(), onReconnect: vi.fn(() => () => {}) }));
const apiLog = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));
const router = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    search: "",
    /** The user follows a link (the nav's 「Chat」, a chat URL). */
    go(url: string) {
      state.search = url.includes("?") ? url.slice(url.indexOf("?")) : "";
      for (const listener of listeners) listener();
    },
    /** The page's own URL updates. */
    replace: vi.fn((url: string, _options?: { scroll?: boolean }) => state.go(url)),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return state;
});

vi.mock("@multiremi/core/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@multiremi/core/api")>(),
  api: {
    getSessionLog: backend.read,
    listMessages: async () => ({ messages: [], next_cursor: null }),
    getChatQueue: async () => ({ items: [], paused: null }),
    listAgents: async () => [{ id: "agent-a", name: "Alpha", archived_at: null, owner_id: "user-a" }],
    listMembers: async () => [{ id: "member-a", user_id: "user-a", role: "owner" }],
    listProjects: async () => ({ projects: [] }),
    listChatSessions: backend.list,
    getChatSession: async (id: string) => backend.sessions.find((session) => session.id === id),
    getPendingChatTask: backend.pending,
    markChatSessionRead: async () => {},
    createChatSession: backend.create,
    sendChatMessage: backend.send,
    getChatTurnPendingTask: backend.turn,
  },
}));
vi.mock("@multiremi/core/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multiremi/core/logger")>();
  return { ...actual, createLogger: (namespace: string) => namespace === "chat.api"
    ? { ...actual.noopLogger, warn: apiLog.warn, error: apiLog.error } : actual.noopLogger };
});
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
vi.mock("@multiremi/core/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multiremi/core/paths")>();
  return { ...actual, useWorkspacePaths: () => actual.paths.workspace("test"), useWorkspaceSlug: () => "test" };
});
vi.mock("@multiremi/views/issues/components", () => ({ canAssignAgent: () => true }));
vi.mock("../../navigation", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useNavigation: () => {
      const search = useSyncExternalStore(router.subscribe, () => router.search);
      return { searchParams: new URLSearchParams(search), replace: router.replace, push: router.go };
    },
    AppLink: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
  };
});
vi.mock("./use-chat-resize", () => ({ useChatResize: () => ({ boundsReady: true }) }));
vi.mock("./use-chat-context-items", () => ({ useChatContextItems: () => [] }));
vi.mock("./human-request-dock", () => ({ HumanRequestDock: () => null }));
vi.mock("./offline-banner", () => ({ OfflineBanner: () => null }));
vi.mock("./no-agent-banner", () => ({ NoAgentBanner: () => null }));
vi.mock("./agent-dropdown", () => ({ AgentDropdown: () => null }));
vi.mock("./chat-sidebar", () => ({
  ChatSidebar: ({ onNewChat }: { onNewChat: () => void }) => <button type="button" onClick={() => onNewChat()}>Sidebar new chat</button>,
}));
vi.mock("../../common/actor-avatar", () => ({ ActorAvatar: () => null }));
vi.mock("../../runtimes/components/runtime-workspace-picker", () => ({ WorkLocationPicker: () => null }));
vi.mock("../../common/task-transcript/use-task-trace", () => ({
  useTurnTrace: () => ({ turn: null, items: [], closed: false, loaded: false, error: false, retry: () => {}, read: null, head: 0 }),
  useCachedTurnTraces: (ids: readonly string[]) => ids.map(() => ({ turn: null, items: [] })),
}));
vi.mock("../../common/markdown", () => ({ Markdown: ({ children }: { children: string }) => <span>{children}</span> }));
vi.mock("../../issues/components/comment-card", () => ({ AttachmentList: () => null }));

import { ChatPage } from "./chat-page";

const existing: ChatSession = {
  id: "chat-x", workspace_id: "workspace-a", agent_id: "agent-a", creator_id: "user-a",
  project_id: null, title: "Existing chat", status: "active", has_unread: false, pinned: false, origin: null,
  unread_count: 0, last_message: null, created_at: "2026-10-18", updated_at: "2026-10-18",
};
/** Drafts of a chat not created yet, as `__new__:<agent>`. */
const newChatDrafts = (drafts: Record<string, string>) => Object.keys(drafts).filter((key) => key.startsWith("__new__"));

/** Every chat's read route; as on the server, every write bumps `log_version`. */
function chatLogs() {
  const rows = new Map<string, SessionLogRow[]>();
  let version = 0;
  const of = (id: string) => rows.get(id) ?? (rows.set(id, []), rows.get(id)!);
  return {
    rows: of,
    write(id: string, fields: Record<string, unknown>) {
      const seq = (of(id).at(-1)?.seq ?? -1) + 1;
      const row = SessionLogEntrySchema.parse({ session_id: id, seq, id: `${id}-row-${seq}`, revision: 1,
        body_html: null, render_version: null, visibility: "shown", metadata: { attachments: [], reactions: [] }, ...fields });
      of(id).push(row);
      version += 1;
      return row;
    },
    read(id: string, params: LogWindowParams): SessionLogWindow {
      const all = of(id);
      const head = all.at(-1)?.seq ?? 0;
      const anchor = params.anchor ?? head;
      const shown = all.filter((row) => row.visibility === "shown");
      const before = params.before ? shown.filter((row) => row.seq <= anchor).slice(-params.before) : [];
      const after = params.after ? shown.filter((row) => row.seq > anchor).slice(0, params.after) : [];
      return { entries: [...before, ...after], head_seq: head, log_version: version, has_more_before: false, has_more_after: false };
    },
  };
}
let logs = chatLogs();
const memberMessage = (body: string, clientId: string | null) => ({ kind: "message", sender_type: "member", sender_id: "member-a",
  to_type: "agent", to_agent_id: "agent-a", message_kind: "request", body_md: body, dedupe_key: clientId });

type CreateInput = { id: string; agent_id: string; title?: string };
/** The server's handling of a create: the chat, under the id the client made, and its log's head row. */
function serverCreate(input: CreateInput): ChatSession {
  const created = { ...existing, id: input.id, title: input.title ?? "" };
  backend.sessions = [created, ...backend.sessions];
  logs.write(created.id, { kind: "head", body_md: created.title });
  return created;
}

/** A request the test answers later. */
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}
const stall = () => new Promise<never>(() => {});

/** The server's handling of a POST: commits the row once per dedupe_key, and answers. */
function accept(sessionId: string, body: string, clientId: string): SendChatMessageResponse {
  const known = logs.rows(sessionId).find((row) => (row as SessionLogRow & { dedupe_key?: string | null }).dedupe_key === clientId);
  const row = known ?? logs.write(sessionId, memberMessage(body, clientId));
  return { message_id: row.id, turn_id: `turn-${row.seq}`, created_at: "2026-10-19T00:00:00Z" };
}

const streams = new Map<string, StreamSubscriptionHandlers>();
let storage = new Map<string, string>();
let client: QueryClient;

function mountPage(url = "/test/chat") {
  router.go(url);
  const store = createChatStore({ storage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => { storage.set(key, value); },
    removeItem: (key) => { storage.delete(key); },
  } });
  registerChatStore(store);
  const view = render(<QueryClientProvider client={client}>
    <I18nProvider locale="en" resources={{ en: { chat: enChat, common: enCommon, issues: enIssues, messages: enMessages } }}>
      <ReplicaEnvProvider env={{ hasOpfs: false }}><ChatPage /></ReplicaEnvProvider>
    </I18nProvider>
  </QueryClientProvider>);
  return { ...view, store };
}

const editor = () => (document.querySelector(".ProseMirror") as (HTMLElement & { editor?: Editor }) | null)?.editor;
const composerText = () => editor()?.getText() ?? null;
const conversation = () => document.querySelector<HTMLElement>('[data-perf-scroll="session-log"]');
const pageTitle = () => document.querySelector("[data-chat-page-header] h1");
/** Types into the real editor; its debounced update reaches the store and enables the button. */
async function type(text: string) {
  await waitFor(() => expect(editor()).toBeDefined());
  act(() => { editor()!.commands.insertContent(text); });
  await waitFor(() => expect(screen.getByRole("button", { name: /^(Send|Steer)$/ })).toBeEnabled());
}
/** ChatInput's `debounceMs`: how long the editor waits to save a draft. */
const DRAFT_DEBOUNCE_MS = 100;
/** How long ChatWindow shows the Sent label once the log holds the row. */
const SENT_LABEL_MS = 600;
/** Moves the faked clock: every timer due by then fires, and the page settles. */
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
/** Past the draft debounce: a late save of the emptied editor would have landed, under the chat the send created. */
const pastDraftDebounce = () => advance(DRAFT_DEBOUNCE_MS + 1);
const sentLabel = () => [...conversation()!.querySelectorAll<HTMLElement>('[aria-live="polite"]')]
  .find((node) => node.textContent?.includes("Sent"));
const submit = () => fireEvent.click(screen.getByRole("button", { name: /^(Send|Steer)$/ }));
const sentClientId = (call = 0) => backend.send.mock.calls[call]![3] as string;
/** The id the client made for the chat it created. */
const createdId = (call = 0) => (backend.create.mock.calls[call]![0] as { id: string }).id;

// Waits are on what the page shows; a slow runner gets room, the assertions stay the same.
beforeAll(() => configure({ asyncUtilTimeout: 5000 }));
afterAll(() => configure({ asyncUtilTimeout: 1000 }));
vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  // Timer functions and Date only: React's scheduler and the editor keep their own.
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  logs = chatLogs();
  logs.write(existing.id, { kind: "head", body_md: existing.title });
  logs.write(existing.id, memberMessage("Earlier question", null));
  backend.sessions = [existing];
  backend.read.mockImplementation(async (id: string, params: LogWindowParams) => logs.read(id, params));
  backend.send.mockImplementation(async (id: string, body: string, _attachments: unknown, clientId: string) => accept(id, body, clientId));
  backend.turn.mockImplementation(async (turnId: string) => ({ task_id: `attempt-of-${turnId}`, turn_id: turnId, status: "queued", supports_queue: true }));
  backend.list.mockImplementation(async () => backend.sessions);
  backend.pending.mockImplementation(async () => ({ supports_queue: true }));
  backend.create.mockImplementation(async (input: CreateInput) => serverCreate(input));
  socket.subscribeStream.mockImplementation((_stream: string, id: string, handlers: StreamSubscriptionHandlers) => {
    streams.set(id, handlers);
    return { unsubscribe: vi.fn() };
  });
  // The agent the user picked last; a new chat's draft is keyed by it.
  storage = new Map([["multimira:chat:selectedAgentId", "agent-a"]]);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(() => {
  client.clear();
  streams.clear();
  vi.clearAllMocks();
  // The chat log pool is module-level and every test reuses the chat ids.
  clearChatLogPool();
  vi.useRealTimers();
});

describe("a sent message is confirmed by the POST, not by the log or the turn read", () => {
  it("shows Sent with an empty composer while the turn read and every later log read hang", async () => {
    const view = mountPage(`/test/chat?session=${existing.id}`);
    await waitFor(() => expect(conversation()).toHaveTextContent("Earlier question"));
    backend.turn.mockImplementation(stall);
    await type("你的model string是啥?");
    // From here the log answers nothing: only the POST says the message landed.
    backend.read.mockImplementation(stall);
    submit();
    expect(composerText()).toBe("");
    await waitFor(() => expect(conversation()).toHaveTextContent("Sent"));
    expect(conversation()).toHaveTextContent("你的model string是啥?");
    expect(conversation()).not.toHaveTextContent("Sending…");
    expect(backend.send).toHaveBeenCalledOnce();
    expect(backend.turn).toHaveBeenCalledWith("turn-2");
    expect(composerText()).toBe("");
    expect(view.store.getState().inputDrafts[existing.id]).toBeUndefined();
    view.unmount();
  });

  it("restores the text into the composer when the server refuses the send", async () => {
    const view = mountPage(`/test/chat?session=${existing.id}`);
    await waitFor(() => expect(conversation()).toHaveTextContent("Earlier question"));
    backend.send.mockRejectedValueOnce(new ApiError("too long", 400, "Bad Request", { error: "too long" }));
    await type("Refused message");
    submit();
    expect(await screen.findByText("Message was not sent. Your draft is saved; try again.")).toBeInTheDocument();
    expect(composerText()).toBe("Refused message");
    expect(view.store.getState().inputDrafts[existing.id]).toBe("Refused message");
    expect(conversation()).toHaveTextContent("Failed to send");
    view.unmount();
  });
});

describe("a send without an answer is unconfirmed until the log says", () => {
  it("marks a POST past the timeout unconfirmed, and a later log read confirms it without a resend", async () => {
    const view = mountPage(`/test/chat?session=${existing.id}`);
    await waitFor(() => expect(conversation()).toHaveTextContent("Earlier question"));
    // The request reaches a slow server, which commits after the client gave up.
    let signal!: AbortSignal;
    backend.send.mockImplementationOnce((_id: string, _body: string, _attachments: unknown, _clientId: string, options: { signal: AbortSignal }) => {
      signal = options.signal;
      return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason)));
    });
    await type("Slow message");
    submit();
    await waitFor(() => expect(backend.send).toHaveBeenCalledOnce());
    // Halfway it is still sending (the faked clock also moves with real time).
    await advance(CHAT_SEND_TIMEOUT_MS / 2);
    expect(signal.aborted).toBe(false);
    expect(conversation()).toHaveTextContent("Sending…");
    await advance(CHAT_SEND_TIMEOUT_MS / 2);
    await waitFor(() => expect(conversation()).toHaveTextContent("Delivery unconfirmed"));
    expect(signal.aborted).toBe(true);
    expect(screen.getByRole("button", { name: "Retry sending this message" })).toBeInTheDocument();
    // The text stays in the bubble, not the composer: sending it anew could post it twice.
    expect(composerText()).toBe("");
    accept(existing.id, "Slow message", sentClientId());
    // The fallback read on the pending-task cadence finds the server's row.
    await advance(CHAT_PENDING_REFETCH_INTERVAL_MS);
    await waitFor(() => expect(conversation()).toHaveTextContent("Sent"));
    expect(conversation()).not.toHaveTextContent("Delivery unconfirmed");
    expect(backend.send).toHaveBeenCalledOnce();
    expect(logs.rows(existing.id).filter((row) => row.body_md === "Slow message")).toHaveLength(1);
    view.unmount();
  });

  it("retries an unconfirmed send with the same dedupe_key", async () => {
    const view = mountPage(`/test/chat?session=${existing.id}`);
    await waitFor(() => expect(conversation()).toHaveTextContent("Earlier question"));
    backend.send.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await type("Offline message");
    submit();
    await waitFor(() => expect(conversation()).toHaveTextContent("Delivery unconfirmed"));
    fireEvent.click(screen.getByRole("button", { name: "Retry sending this message" }));
    await waitFor(() => expect(backend.send).toHaveBeenCalledTimes(2));
    expect(sentClientId(1)).toBe(sentClientId(0));
    await waitFor(() => expect(conversation()).toHaveTextContent("Sent"));
    expect(logs.rows(existing.id).filter((row) => row.body_md === "Offline message")).toHaveLength(1);
    view.unmount();
  });

  it("reads the log again when no frame arrives and the read after the send failed", async () => {
    const view = mountPage(`/test/chat?session=${existing.id}`);
    await waitFor(() => expect(conversation()).toHaveTextContent("Earlier question"));
    await type("Quiet socket");
    // The read route fails from the moment the POST is answered, so the read
    // after the send fails (a fallback read while it is in flight would not).
    backend.send.mockImplementationOnce(async (id: string, body: string, _attachments: unknown, clientId: string) => {
      const accepted = accept(id, body, clientId);
      backend.read.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      return accepted;
    });
    const readsBefore = backend.read.mock.calls.length;
    submit();
    await waitFor(() => expect(apiLog.warn).toHaveBeenCalledWith("refreshSession.error", expect.objectContaining({ sessionId: existing.id })));
    await waitFor(() => expect(conversation()).toHaveTextContent("Sent"));
    expect(sentLabel()?.style.visibility).toBe("");
    const readsAfterFailure = backend.read.mock.calls.length;
    // The fallback read brings the server's row: the bubble is its row now, and its label fades.
    await advance(CHAT_PENDING_REFETCH_INTERVAL_MS);
    expect(backend.read.mock.calls.length).toBeGreaterThan(readsAfterFailure);
    await advance(SENT_LABEL_MS);
    await waitFor(() => expect(sentLabel()?.style.visibility).toBe("hidden"));
    expect(backend.read.mock.calls.length).toBeGreaterThan(readsBefore + 1);
    // Confirmed: the fallback stops.
    const reads = backend.read.mock.calls.length;
    await advance(CHAT_PENDING_REFETCH_INTERVAL_MS * 3);
    expect(backend.read.mock.calls.length).toBe(reads);
    view.unmount();
  });
});

describe("the composer follows the chat on screen", () => {
  it("sends from the new chat the nav's Chat link opens and leaves no draft behind", async () => {
    const view = mountPage(`/test/chat?session=${existing.id}`);
    await waitFor(() => expect(conversation()).toHaveTextContent("Earlier question"));
    // The left nav's 「Chat」 links to the bare route while a chat is shown.
    act(() => router.go("/test/chat"));
    await waitFor(() => expect(pageTitle()).toHaveTextContent("New chat"));
    expect(view.store.getState().activeSessionId).toBeNull();
    // The URL made this change, so the page does not navigate again.
    expect(router.replace).not.toHaveBeenCalled();
    await type("After the nav link");
    // The composer holds the draft of the new chat on screen.
    await waitFor(() => expect(view.store.getState().inputDrafts["__new__:agent-a"]).toBe("After the nav link"));
    submit();
    await waitFor(() => expect(backend.send).toHaveBeenCalledOnce());
    expect(backend.send.mock.calls[0]![0]).toBe(createdId());
    await waitFor(() => expect(conversation()).toHaveTextContent("Sent"));
    await pastDraftDebounce();
    expect(composerText()).toBe("");
    expect(view.store.getState().inputDrafts).toEqual({});
    act(() => router.go("/test/chat"));
    await waitFor(() => expect(pageTitle()).toHaveTextContent("New chat"));
    await waitFor(() => expect(editor()).toBeDefined());
    expect(composerText()).toBe("");
    view.unmount();
  });

  it("leaves no new-chat draft after a new chat's first message, also after the store is read again", async () => {
    const view = mountPage("/test/chat");
    await type("First message");
    await waitFor(() => expect(view.store.getState().inputDrafts["__new__:agent-a"]).toBe("First message"));
    submit();
    await waitFor(() => expect(router.search).toBe(`?session=${createdId()}`));
    await waitFor(() => expect(conversation()).toHaveTextContent("Sent"));
    // The created chat names the URL once, with no history entry or scroll jump.
    expect(router.replace.mock.calls).toEqual([[`/test/chat?session=${createdId()}`, { scroll: false }]]);
    await pastDraftDebounce();
    expect(composerText()).toBe("");
    expect(view.store.getState().inputDrafts).toEqual({});
    expect(storage.get("multimira:chat:drafts")).toBeUndefined();
    // 新对话: the next new chat with this agent starts empty.
    fireEvent.click(screen.getByRole("button", { name: "Sidebar new chat" }));
    await waitFor(() => expect(pageTitle()).toHaveTextContent("New chat"));
    await waitFor(() => expect(editor()).toBeDefined());
    expect(composerText()).toBe("");
    view.unmount();
    // A reload reads the drafts from storage again, with an empty log pool.
    clearChatLogPool();
    const reloaded = mountPage("/test/chat");
    await waitFor(() => expect(editor()).toBeDefined());
    expect(newChatDrafts(reloaded.store.getState().inputDrafts)).toEqual([]);
    expect(composerText()).toBe("");
    reloaded.unmount();
  });

  it("ends on a bare /chat URL when the chat on screen is deleted elsewhere", async () => {
    const view = mountPage(`/test/chat?session=${existing.id}`);
    await waitFor(() => expect(conversation()).toHaveTextContent("Earlier question"));
    // Another tab deletes it: the realtime handler clears the stored chat.
    backend.sessions = [];
    act(() => view.store.getState().setActiveSession(null));
    await waitFor(() => expect(pageTitle()).toHaveTextContent("New chat"));
    expect(router.search).toBe("");
    expect(router.replace.mock.calls).toEqual([["/test/chat", { scroll: false }]]);
    await waitFor(() => expect(editor()).toBeDefined());
    expect(composerText()).toBe("");
    view.unmount();
    // A reload, with an empty log pool, opens the bare URL, not the deleted chat.
    clearChatLogPool();
    const reloaded = mountPage(`/test/chat${router.search}`);
    await waitFor(() => expect(pageTitle()).toHaveTextContent("New chat"));
    expect(reloaded.store.getState().activeSessionId).toBeNull();
    reloaded.unmount();
  });

  it("keeps what the user types while the send is in flight", async () => {
    const view = mountPage("/test/chat");
    const post = gate<SendChatMessageResponse>();
    backend.send.mockImplementationOnce(() => post.promise);
    await type("First message");
    submit();
    expect(composerText()).toBe("");
    await waitFor(() => expect(backend.send).toHaveBeenCalledOnce());
    act(() => { editor()!.commands.insertContent("Next thought"); });
    const created = createdId();
    await waitFor(() => expect(view.store.getState().inputDrafts[created]).toBe("Next thought"));
    await act(async () => { post.resolve(accept(created, "First message", sentClientId())); });
    await waitFor(() => expect(conversation()).toHaveTextContent("Sent"));
    expect(composerText()).toBe("Next thought");
    expect(view.store.getState().inputDrafts[created]).toBe("Next thought");
    expect(newChatDrafts(view.store.getState().inputDrafts)).toEqual([]);
    view.unmount();
  });
});

describe("a new chat opens at the send, before the server has created it", () => {
  const CHAT_ID = /^chat_[0-9a-z]{12}$/;
  const createInput = () => backend.create.mock.calls[0]![0] as CreateInput;
  const readsOf = (mock: typeof backend.read, id: string) => mock.mock.calls.filter(([sessionId]) => sessionId === id);

  it("shows the chat, its URL and the message sending while the create hangs, and sends once the chat exists", async () => {
    const view = mountPage("/test/chat");
    const create = gate<ChatSession>();
    backend.create.mockImplementationOnce(() => create.promise);
    await type("First message");
    submit();
    // In the same interaction: the URL names the new chat, the header its
    // title, the conversation the message, sending; no empty state.
    const id = view.store.getState().activeSessionId!;
    expect(id).toMatch(CHAT_ID);
    expect(router.search).toBe(`?session=${id}`);
    expect(pageTitle()).toHaveTextContent("First message");
    expect(conversation()).toHaveTextContent("First message");
    expect(conversation()).toHaveTextContent("Sending…");
    expect(screen.queryByText("Hi, I'm Alpha")).not.toBeInTheDocument();
    expect(composerText()).toBe("");
    await waitFor(() => expect(backend.create).toHaveBeenCalledOnce());
    expect(createInput()).toEqual({ id, agent_id: "agent-a", title: "First message" });
    // Nothing reads the chat before it exists, the fallback read included, and nothing is posted to it.
    await advance(CHAT_PENDING_REFETCH_INTERVAL_MS);
    expect(readsOf(backend.read, id)).toEqual([]);
    expect(readsOf(backend.pending, id)).toEqual([]);
    expect(socket.subscribeStream).not.toHaveBeenCalledWith(expect.anything(), id, expect.anything());
    expect(backend.send).not.toHaveBeenCalled();
    expect(conversation()).toHaveTextContent("Sending…");
    // The server creates it: the message is posted to it, and its log is read.
    await act(async () => { create.resolve(serverCreate(createInput())); });
    await waitFor(() => expect(conversation()).toHaveTextContent("Sent"));
    expect(backend.send.mock.calls[0]![0]).toBe(id);
    await waitFor(() => expect(readsOf(backend.read, id).length).toBeGreaterThan(0));
    expect(conversation()).toHaveTextContent("First message");
    // The URL changed once, at the send.
    expect(router.replace.mock.calls).toEqual([[`/test/chat?session=${id}`, { scroll: false }]]);
    view.unmount();
  });

  it("does not wait for the session lists read again after the create", async () => {
    const view = mountPage("/test/chat");
    await waitFor(() => expect(backend.list).toHaveBeenCalled());
    const listReads = backend.list.mock.calls.length;
    // From here every list read hangs.
    backend.list.mockImplementation(stall);
    await type("Quick start");
    submit();
    await waitFor(() => expect(conversation()).toHaveTextContent("Sent"));
    expect(backend.send.mock.calls[0]![0]).toBe(createdId());
    // The lists are being read again behind the create; the chat keeps its record meanwhile.
    expect(backend.list.mock.calls.length).toBeGreaterThan(listReads);
    expect(pageTitle()).toHaveTextContent("Quick start");
    view.unmount();
  });

  it("goes back to the new chat, its draft and its location when the create fails", async () => {
    const view = mountPage("/test/chat");
    let refuse!: (error: unknown) => void;
    backend.create.mockImplementationOnce(() => new Promise((_resolve, reject) => { refuse = reject; }));
    act(() => view.store.getState().setDraftLocation({ projectId: "project-a", runtimeWorkspaceId: null }));
    await type("Will it fail?");
    submit();
    const id = view.store.getState().activeSessionId!;
    expect(router.search).toBe(`?session=${id}`);
    expect(conversation()).toHaveTextContent("Sending…");
    await waitFor(() => expect(backend.create).toHaveBeenCalledOnce());
    expect(createInput()).toEqual({ id, agent_id: "agent-a", title: "Will it fail?", project_id: "project-a" });
    await act(async () => { refuse(new ApiError("Chat session id has already been used", 409, "Conflict", { error: "Chat session id has already been used" })); });
    expect(await screen.findByText("Message was not sent. Your draft is saved; try again.")).toBeInTheDocument();
    expect(router.search).toBe("");
    expect(view.store.getState().activeSessionId).toBeNull();
    expect(pageTitle()).toHaveTextContent("New chat");
    expect(conversation()).toBeNull();
    expect(composerText()).toBe("Will it fail?");
    expect(view.store.getState().inputDrafts["__new__:agent-a"]).toBe("Will it fail?");
    expect(view.store.getState().draftProjectId).toBe("project-a");
    // The chat the create wrote into the cache is gone again.
    expect(client.getQueryData<ChatSession[]>(chatKeys.sessions("workspace-a"))?.map((session) => session.id)).not.toContain(id);
    expect(client.getQueryData(chatKeys.session("workspace-a", id))).toBeUndefined();
    expect(backend.send).not.toHaveBeenCalled();
    view.unmount();
  });

  it("keeps what the user types while the chat is being created, as the created chat's draft", async () => {
    const view = mountPage("/test/chat");
    const create = gate<ChatSession>();
    backend.create.mockImplementationOnce(() => create.promise);
    await type("First message");
    submit();
    act(() => { editor()!.commands.insertContent("Follow-up"); });
    await pastDraftDebounce();
    await waitFor(() => expect(backend.create).toHaveBeenCalledOnce());
    await act(async () => { create.resolve(serverCreate(createInput())); });
    await waitFor(() => expect(conversation()).toHaveTextContent("Sent"));
    const id = createdId();
    expect(composerText()).toBe("Follow-up");
    await waitFor(() => expect(view.store.getState().inputDrafts[id]).toBe("Follow-up"));
    expect(newChatDrafts(view.store.getState().inputDrafts)).toEqual([]);
    view.unmount();
  });
});

describe("the hub's hidden placeholder for the user's own row", () => {
  const placeholder = (sessionId: string, seq: number): HubFrame =>
    ({ seq, kind: "entry", payload: { session_id: sessionId, seq, revision: 1, visibility: "hidden" } });

  it.each(["after", "before"])("keeps the bubble when it arrives %s the read that loads the row", async (order) => {
    const view = mountPage(`/test/chat?session=${existing.id}`);
    await waitFor(() => expect(conversation()).toHaveTextContent("Earlier question"));
    await waitFor(() => expect(streams.has(existing.id)).toBe(true));
    const tail = gate<SessionLogWindow>();
    if (order === "before") backend.read.mockImplementationOnce(() => tail.promise);
    await type("My own row");
    submit();
    await waitFor(() => expect(backend.send).toHaveBeenCalledOnce());
    const seq = logs.rows(existing.id).at(-1)!.seq;
    if (order === "after") {
      // The read after the send has loaded the row: the label is there, then fades.
      await waitFor(() => expect(sentLabel()).toBeDefined());
      await advance(SENT_LABEL_MS);
      await waitFor(() => expect(sentLabel()?.style.visibility).toBe("hidden"));
    }
    // The projection could not check the new row and failed closed.
    await act(async () => { await streams.get(existing.id)!.onFrames?.([placeholder(existing.id, seq)]); });
    if (order === "before") await act(async () => { tail.resolve(logs.read(existing.id, { before: 30 })); });
    // The read the placeholder needs has landed, and the label has faded.
    await waitFor(() => expect(sentLabel()).toBeDefined());
    await advance(SENT_LABEL_MS);
    await waitFor(() => expect(sentLabel()?.style.visibility).toBe("hidden"));
    expect(conversation()).toHaveTextContent("My own row");
    expect(conversation()!.querySelectorAll('[data-perf-item="message"]')).toHaveLength(2);
    view.unmount();
  });
});
