import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatPendingTask, ChatSession } from "../../types";
import { chatKeys } from "../../chat/queries";
import { applyChatDoneToCache, createChatHandlers } from "./chat";

vi.mock("../../platform/workspace-storage", () => ({ getCurrentWsId: () => "ws-1" }));
const store = vi.hoisted(() => ({ setActiveSession: vi.fn(), clearInputDraft: vi.fn() }));
vi.mock("../../chat", () => ({ useChatStore: { getState: () => ({ activeSessionId: "chat-1", ...store }) } }));

const queued = { task_id: "task-2", content: "follow-up", attachment_ids: [], created_at: "2026-09-11T00:01:00Z" };
const session: ChatSession = {
  id: "chat-1", workspace_id: "ws-1", creator_id: "user-1", agent_id: "agent-1",
  title: "Chat", status: "active", pinned: false, has_unread: false, unread_count: 0,
  last_message: null, created_at: "2026-09-11T00:00:00Z", updated_at: "2026-09-11T00:00:00Z",
};
let qc: QueryClient;
let handlers: ReturnType<typeof createChatHandlers>["handlers"];
beforeEach(() => {
  vi.clearAllMocks();
  qc = new QueryClient();
  handlers = createChatHandlers({ qc } as Parameters<typeof createChatHandlers>[0]).handlers;
  qc.setQueryData(chatKeys.pendingTask("chat-1"), { task_id: "task-1", status: "running", supports_queue: true, queued_tasks: [queued] });
  qc.setQueryData(chatKeys.sessions("ws-1"), [session]);
  qc.setQueryData(chatKeys.sessionList("ws-1", "active"), [session]);
  qc.setQueryData(chatKeys.sessionList("ws-1", "archived"), []);
  qc.setQueryData(chatKeys.session("ws-1", "chat-1"), session);
  qc.setQueryData(chatKeys.sessions("ws-2"), [{ ...session, workspace_id: "ws-2" }]);
});
afterEach(() => qc.clear());

describe("chat queue realtime", () => {
  it("does not replace a running head or reset its status when a follow-up is queued", () => {
    handlers["task:queued"]?.({ chat_session_id: "chat-1", task_id: "task-2" });
    handlers["task:queued"]?.({ chat_session_id: "chat-1", task_id: "task-1" });
    expect(qc.getQueryData(chatKeys.pendingTask("chat-1"))).toMatchObject({ task_id: "task-1", status: "running", queued_tasks: [queued] });
    expect(qc.getQueryState(chatKeys.pendingTask("chat-1"))?.isInvalidated).toBe(true);
  });

  it("retains follow-ups until the authoritative next head arrives and ignores older completions", () => {
    applyChatDoneToCache(qc, { chat_session_id: "chat-1", task_id: "task-1" });
    expect(qc.getQueryData(chatKeys.pendingTask("chat-1"))).toEqual({ supports_queue: true, queued_tasks: [queued] });
    qc.setQueryData(chatKeys.pendingTask("chat-1"), { task_id: "task-2", status: "running", supports_queue: true, queued_tasks: [] });
    applyChatDoneToCache(qc, { chat_session_id: "chat-1", task_id: "task-1" });
    expect(qc.getQueryData(chatKeys.pendingTask("chat-1"))).toMatchObject({ task_id: "task-2", status: "running" });
  });

  it("removes a cancelled follow-up without stopping the active head", () => {
    handlers["task:cancelled"]?.({ chat_session_id: "chat-1", task_id: "task-2" });
    expect(qc.getQueryData(chatKeys.pendingTask("chat-1"))).toMatchObject({ task_id: "task-1", status: "running", queued_tasks: [] });
  });

  it("preserves pending queue metadata when the final head fails", () => {
    handlers["task:failed"]?.({ chat_session_id: "chat-1", task_id: "task-1" });
    handlers["task:failed"]?.({ chat_session_id: "chat-1", task_id: "task-2" });
    expect(qc.getQueryData<ChatPendingTask>(chatKeys.pendingTask("chat-1"))).toEqual({ supports_queue: true, queued_tasks: [] });
  });

  it("refreshes paged messages, queue, summaries and detail in the current workspace", () => {
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    handlers["chat:queue_updated"]?.({ chat_session_id: "chat-1" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: chatKeys.pendingTask("chat-1") });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: chatKeys.messagesPage("chat-1") });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: chatKeys.session("ws-1", "chat-1") });
    expect(qc.getQueryState(chatKeys.sessionList("ws-1", "active"))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(chatKeys.sessionList("ws-1", "archived"))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(chatKeys.sessions("ws-2"))?.isInvalidated).toBe(false);
  });

  it("patches archive and pin in list/detail caches and leaves other workspaces intact", () => {
    handlers["chat:session_updated"]?.({ chat_session_id: "chat-1", status: "archived", pinned: true });
    expect(qc.getQueryData(chatKeys.sessionList("ws-1", "active"))).toEqual([]);
    expect(qc.getQueryData<ChatSession[]>(chatKeys.sessionList("ws-1", "archived"))?.[0]).toMatchObject({ status: "archived", pinned: true });
    expect(qc.getQueryData(chatKeys.session("ws-1", "chat-1"))).toMatchObject({ status: "archived", pinned: true });
    expect(qc.getQueryData<ChatSession[]>(chatKeys.sessions("ws-2"))?.[0]).toMatchObject({ status: "active", pinned: false });
  });

  it("removes paged history and selected draft after a remote session deletion", () => {
    qc.setQueryData(chatKeys.messagesPage("chat-1"), { pages: [], pageParams: [] });
    handlers["chat:session_deleted"]?.({ chat_session_id: "chat-1" });
    expect(qc.getQueryData(chatKeys.messagesPage("chat-1"))).toBeUndefined();
    expect(qc.getQueryData(chatKeys.session("ws-1", "chat-1"))).toBeUndefined();
    expect(qc.getQueryData(chatKeys.sessionList("ws-1", "active"))).toEqual([]);
    expect(store.clearInputDraft).toHaveBeenCalledWith("chat-1");
    expect(store.setActiveSession).toHaveBeenCalledWith(null);
  });
});
