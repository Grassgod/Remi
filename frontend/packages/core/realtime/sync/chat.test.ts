import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatPendingTask, ChatSession } from "../../types";
import { chatKeys, pendingChatTasksOptions } from "../../chat/queries";
import { issueKeys } from "../../issues/queries";
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
  it("refetches queued reason changes, including recovery events that omit the cleared reason", async () => {
    let pending: ChatPendingTask = {
      task_id: "task-1", status: "queued", wait_reason: "Waiting for model support", supports_queue: true, queued_tasks: [queued],
    };
    const observer = new QueryObserver(qc, {
      queryKey: chatKeys.pendingTask("chat-1"), queryFn: async () => pending,
    });
    const unsubscribe = observer.subscribe(() => {});
    try {
      await observer.refetch();
      expect(qc.getQueryData<ChatPendingTask>(chatKeys.pendingTask("chat-1"))?.wait_reason).toBe(pending.wait_reason);
      pending = { task_id: "task-1", status: "queued", supports_queue: true, queued_tasks: [queued] };
      handlers["task:queued"]?.({ chat_session_id: "chat-1", task_id: "task-1" });
      await vi.waitFor(() => expect(qc.getQueryData(chatKeys.pendingTask("chat-1"))).toEqual(pending));
    } finally {
      unsubscribe();
    }
  });

  it.each(["task:dispatch", "task:running"] as const)("clears a queued reason when %s starts execution", event => {
    qc.setQueryData(chatKeys.pendingTask("chat-1"), {
      task_id: "task-1", status: "queued", wait_reason: "Waiting for model support", supports_queue: true, queued_tasks: [queued],
    });
    handlers[event]?.({ chat_session_id: "chat-1", task_id: "task-2" });
    expect(qc.getQueryData<ChatPendingTask>(chatKeys.pendingTask("chat-1"))?.wait_reason).toBe("Waiting for model support");
    handlers[event]?.({ chat_session_id: "chat-1", task_id: "task-1" });
    expect(qc.getQueryData(chatKeys.pendingTask("chat-1"))).toMatchObject({
      task_id: "task-1", status: "running", wait_reason: null, queued_tasks: [queued],
    });
  });

  it.each(["task:awaiting_human", "task:running"] as const)(
    "invalidates issue decision surfaces when %s changes a subtree human request",
    event => {
      qc.setQueryData(issueKeys.detail("ws-1", "parent-1"), { id: "parent-1" });
      qc.setQueryData(issueKeys.decisions("ws-1", "parent-1"), { count: 1 });
      qc.setQueryData(issueKeys.detail("ws-2", "parent-2"), { id: "parent-2" });

      handlers[event]?.({
        task_id: "task-issue",
        agent_id: "agent-1",
        issue_id: "child-1",
        status: event === "task:running" ? "running" : "awaiting_human",
      });

      expect(qc.getQueryState(issueKeys.detail("ws-1", "parent-1"))?.isInvalidated).toBe(true);
      expect(qc.getQueryState(issueKeys.decisions("ws-1", "parent-1"))?.isInvalidated).toBe(true);
      expect(qc.getQueryState(issueKeys.detail("ws-2", "parent-2"))?.isInvalidated).toBe(false);
    },
  );

  it("writes preparation progress only to the matching pending head", () => {
    handlers["task:progress"]?.({ chat_session_id: "chat-1", task_id: "task-1", progress_summary: "正在准备项目仓库…" });
    expect(qc.getQueryData(chatKeys.pendingTask("chat-1"))).toMatchObject({
      task_id: "task-1", status: "running", progress_summary: "正在准备项目仓库…", queued_tasks: [queued],
    });
    for (const payload of [
      null,
      { chat_session_id: "chat-1", task_id: "task-2", progress_summary: "Follow-up" },
      { chat_session_id: "chat-1", task_id: "task-1", progress_summary: {} },
      { chat_session_id: "chat-1", task_id: "task-1" },
      { task_id: "task-1", progress_summary: "Issue task" },
    ]) handlers["task:progress"]?.(payload);
    expect(qc.getQueryData<ChatPendingTask>(chatKeys.pendingTask("chat-1"))?.progress_summary).toBe("正在准备项目仓库…");
    handlers["task:progress"]?.({ chat_session_id: "chat-1", task_id: "task-1", progress_summary: null });
    expect(qc.getQueryData<ChatPendingTask>(chatKeys.pendingTask("chat-1"))?.progress_summary).toBeNull();
  });

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

  // MUL-472 (a): the front-end poll was cut from 3 s to 10 s (and stops while
  // the tab is hidden). That is only safe while the WS path still refreshes the
  // pending keys immediately, so assert the *effect* (a live observer refetches)
  // rather than the call to `invalidateQueries`.
  it("still refetches the mounted pending aggregate as soon as a chat event arrives", async () => {
    expect(pendingChatTasksOptions("ws-1").refetchIntervalInBackground).toBe(false);
    const listPendingChatTasks = vi.fn(async () => ({
      tasks: [{ task_id: "task-1", status: "running", chat_session_id: "chat-1" }],
    }));
    const observer = new QueryObserver(qc, {
      queryKey: chatKeys.pendingTasks("ws-1"),
      queryFn: listPendingChatTasks,
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});
    try {
      await observer.refetch();
      expect(listPendingChatTasks).toHaveBeenCalledTimes(1);
      handlers["chat:message"]?.({ chat_session_id: "chat-1" });
      await vi.waitFor(() => expect(listPendingChatTasks).toHaveBeenCalledTimes(2));
    } finally {
      unsubscribe();
    }
  });

  it("refreshes paged messages, queue, summaries and detail in the current workspace", () => {
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    handlers["chat:queue_updated"]?.({ chat_session_id: "chat-1" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: chatKeys.pendingTask("chat-1") });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: chatKeys.pendingTasks("ws-1") });
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
