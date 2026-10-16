import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatPendingTask, ChatSession } from "../../types";
import { chatKeys, pendingChatTasksOptions } from "../../chat/queries";
import { issueKeys } from "../../issues/queries";
import { applyChatDoneToCache, createChatHandlers } from "./chat";

vi.mock("../../platform/workspace-storage", () => ({ getCurrentWsId: () => "ws-1" }));
const store = vi.hoisted(() => ({ setActiveSession: vi.fn(), clearInputDraft: vi.fn(), clearQueueState: vi.fn() }));
vi.mock("../../chat", () => ({ useChatStore: { getState: () => ({ activeSessionId: "chat-1", ...store }) } }));

const session: ChatSession = {
  id: "chat-1", workspace_id: "ws-1", creator_id: "user-1", agent_id: "agent-1",
  title: "Chat", status: "active", pinned: false, origin: null, has_unread: false, unread_count: 0,
  last_message: null, created_at: "2026-09-11T00:00:00Z", updated_at: "2026-09-11T00:00:00Z",
};
let qc: QueryClient;
let handlers: ReturnType<typeof createChatHandlers>["handlers"];
beforeEach(() => {
  vi.clearAllMocks();
  qc = new QueryClient();
  handlers = createChatHandlers({ qc } as Parameters<typeof createChatHandlers>[0]).handlers;
  qc.setQueryData(chatKeys.pendingTask("chat-1"), { task_id: "task-1", status: "running", supports_queue: true });
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
      task_id: "task-1", status: "queued", wait_reason: "Waiting for model support", supports_queue: true,
    };
    const observer = new QueryObserver(qc, {
      queryKey: chatKeys.pendingTask("chat-1"), queryFn: async () => pending,
    });
    const unsubscribe = observer.subscribe(() => {});
    try {
      await observer.refetch();
      expect(qc.getQueryData<ChatPendingTask>(chatKeys.pendingTask("chat-1"))?.wait_reason).toBe(pending.wait_reason);
      pending = { task_id: "task-1", status: "queued", supports_queue: true };
      handlers["task:queued"]?.({ chat_session_id: "chat-1", task_id: "task-1" });
      await vi.waitFor(() => expect(qc.getQueryData(chatKeys.pendingTask("chat-1"))).toEqual(pending));
    } finally {
      unsubscribe();
    }
  });

  it.each(["task:dispatch", "task:running"] as const)("clears a queued reason when %s starts execution", event => {
    qc.setQueryData(chatKeys.pendingTask("chat-1"), {
      task_id: "task-1", status: "queued", wait_reason: "Waiting for model support", supports_queue: true,
    });
    handlers[event]?.({ chat_session_id: "chat-1", task_id: "task-2" });
    expect(qc.getQueryData<ChatPendingTask>(chatKeys.pendingTask("chat-1"))?.wait_reason).toBe("Waiting for model support");
    handlers[event]?.({ chat_session_id: "chat-1", task_id: "task-1" });
    expect(qc.getQueryData(chatKeys.pendingTask("chat-1"))).toMatchObject({
      task_id: "task-1", status: "running", wait_reason: null,
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
      task_id: "task-1", status: "running", progress_summary: "正在准备项目仓库…",
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

  it("patches a running subagent count into the pending list without a refetch (PR 5 §6.7)", () => {
    const list = { tasks: [
      { task_id: "task-1", turn_id: "turn-1", chat_session_id: "chat-1", status: "running" },
      { task_id: "task-9", turn_id: "turn-9", chat_session_id: "chat-9", status: "running", running_subagents: 1 },
    ] };
    qc.setQueryData(chatKeys.pendingTasks("ws-1"), list);
    handlers["task:subagents"]?.({ chat_session_id: "chat-1", task_id: "task-1", running_subagents: 2 });
    expect(qc.getQueryData(chatKeys.pendingTasks("ws-1"))).toEqual({ tasks: [
      { ...list.tasks[0], running_subagents: 2 }, list.tasks[1],
    ] });
    expect(qc.getQueryState(chatKeys.pendingTasks("ws-1"))?.isInvalidated).toBe(false);
    // The same count keeps the cached object; null reads as none running.
    const before = qc.getQueryData(chatKeys.pendingTasks("ws-1"));
    handlers["task:subagents"]?.({ chat_session_id: "chat-1", task_id: "task-1", running_subagents: 2 });
    expect(qc.getQueryData(chatKeys.pendingTasks("ws-1"))).toBe(before);
    handlers["task:subagents"]?.({ chat_session_id: "chat-9", task_id: "task-9", running_subagents: null });
    expect(qc.getQueryData<{ tasks: Array<{ running_subagents?: number }> }>(chatKeys.pendingTasks("ws-1"))?.tasks[1]?.running_subagents).toBe(0);
    // Malformed or unknown frames change nothing.
    const settled = qc.getQueryData(chatKeys.pendingTasks("ws-1"));
    for (const payload of [null, { task_id: 7, running_subagents: 1 }, { task_id: "task-1" }, { task_id: "task-404", running_subagents: 3 }]) {
      handlers["task:subagents"]?.(payload);
    }
    expect(qc.getQueryData(chatKeys.pendingTasks("ws-1"))).toBe(settled);
  });

  it("patches the attempt's background-task count from the same report when it carries one (PR 6)", () => {
    qc.setQueryData(chatKeys.pendingTasks("ws-1"), { tasks: [{ task_id: "task-1", chat_session_id: "chat-1", status: "running", running_subagents: 1 }] });
    handlers["task:subagents"]?.({ chat_session_id: "chat-1", task_id: "task-1", running_subagents: 1, running_background_tasks: 2 });
    expect(qc.getQueryData(chatKeys.pendingTasks("ws-1"))).toEqual({ tasks: [
      { task_id: "task-1", chat_session_id: "chat-1", status: "running", running_subagents: 1, running_background_tasks: 2 },
    ] });
  });

  it("does not replace a running head or reset its status when a follow-up is queued", () => {
    handlers["task:queued"]?.({ chat_session_id: "chat-1", task_id: "task-2" });
    handlers["task:queued"]?.({ chat_session_id: "chat-1", task_id: "task-1" });
    expect(qc.getQueryData(chatKeys.pendingTask("chat-1"))).toMatchObject({ task_id: "task-1", status: "running" });
    expect(qc.getQueryState(chatKeys.pendingTask("chat-1"))?.isInvalidated).toBe(true);
  });

  it("retains follow-ups until the authoritative next head arrives and ignores older completions", () => {
    applyChatDoneToCache(qc, { chat_session_id: "chat-1", task_id: "task-1" });
    expect(qc.getQueryData(chatKeys.pendingTask("chat-1"))).toEqual({ supports_queue: true });
    qc.setQueryData(chatKeys.pendingTask("chat-1"), { task_id: "task-2", status: "running", supports_queue: true });
    applyChatDoneToCache(qc, { chat_session_id: "chat-1", task_id: "task-1" });
    expect(qc.getQueryData(chatKeys.pendingTask("chat-1"))).toMatchObject({ task_id: "task-2", status: "running" });
  });

  it("removes a cancelled follow-up without stopping the active head", () => {
    handlers["task:cancelled"]?.({ chat_session_id: "chat-1", task_id: "task-2" });
    expect(qc.getQueryData(chatKeys.pendingTask("chat-1"))).toMatchObject({ task_id: "task-1", status: "running" });
  });

  it("preserves pending queue metadata when the final head fails", () => {
    handlers["task:failed"]?.({ chat_session_id: "chat-1", task_id: "task-1" });
    handlers["task:failed"]?.({ chat_session_id: "chat-1", task_id: "task-2" });
    expect(qc.getQueryData<ChatPendingTask>(chatKeys.pendingTask("chat-1"))).toEqual({ supports_queue: true });
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
      handlers["chat:queue_updated"]?.({ chat_session_id: "chat-1" });
      await vi.waitFor(() => expect(listPendingChatTasks).toHaveBeenCalledTimes(2));
    } finally {
      unsubscribe();
    }
  });

  it("refetches the mounted follow-up queue of that chat only", async () => {
    const getChatQueue = vi.fn(async () => ({ items: [], paused: null }));
    const other = vi.fn(async () => ({ items: [], paused: null }));
    const observers = [
      new QueryObserver(qc, { queryKey: chatKeys.queue("ws-1", "chat-1"), queryFn: getChatQueue, staleTime: Infinity }),
      new QueryObserver(qc, { queryKey: chatKeys.queue("ws-1", "chat-2"), queryFn: other, staleTime: Infinity }),
    ];
    const unsubscribe = observers.map(observer => observer.subscribe(() => {}));
    try {
      await vi.waitFor(() => expect(getChatQueue).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(other).toHaveBeenCalledTimes(1));
      handlers["chat:queue_updated"]?.({ chat_session_id: "chat-1" });
      await vi.waitFor(() => expect(getChatQueue).toHaveBeenCalledTimes(2));
      expect(other).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe.forEach(stop => stop());
    }
  });

  it("refreshes queue, summaries and detail in the current workspace", () => {
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    handlers["chat:queue_updated"]?.({ chat_session_id: "chat-1" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: chatKeys.queue("ws-1", "chat-1") });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: chatKeys.pendingTask("chat-1") });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: chatKeys.pendingTasks("ws-1") });
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

  it("removes session detail and selected draft after a remote session deletion", () => {
    handlers["chat:session_deleted"]?.({ chat_session_id: "chat-1" });
    expect(qc.getQueryData(chatKeys.session("ws-1", "chat-1"))).toBeUndefined();
    expect(qc.getQueryData(chatKeys.sessionList("ws-1", "active"))).toEqual([]);
    expect(store.clearInputDraft).toHaveBeenCalledWith("chat-1");
    expect(store.clearQueueState).toHaveBeenCalledWith("chat-1");
    expect(store.setActiveSession).toHaveBeenCalledWith(null);
  });
});

describe("chat:background_tasks (PR 6 §7)", () => {
  const row = (id: string, overrides: Record<string, unknown> = {}) => ({
    id: `row-${id}`, session_id: "chat-1", task_id: id, task_type: "shell", name: id, command: id,
    origin_attempt_id: "task-1", status: "running", can_stop: true, started_at: "2026-10-16T00:00:00Z",
    lane_state: "parked", updated_at: "2026-10-16T00:00:01Z", ...overrides,
  });
  const key = chatKeys.backgroundTasks("ws-1", "chat-1");

  it("moves the session's count everywhere and reads nothing for a chat no one shows", () => {
    handlers["chat:background_tasks"]?.({ session_id: "chat-1", running: 2, rows: [row("a"), row("b")] });
    expect(qc.getQueryData<ChatSession[]>(chatKeys.sessions("ws-1"))?.[0]?.running_background_tasks).toBe(2);
    expect(qc.getQueryData<ChatSession[]>(chatKeys.sessionList("ws-1", "active"))?.[0]?.running_background_tasks).toBe(2);
    expect(qc.getQueryData<ChatSession>(chatKeys.session("ws-1", "chat-1"))?.running_background_tasks).toBe(2);
    // Another workspace's list is left alone, and no list is created.
    expect(qc.getQueryData<ChatSession[]>(chatKeys.sessions("ws-2"))?.[0]?.running_background_tasks).toBeUndefined();
    expect(qc.getQueryData(key)).toBeUndefined();
  });

  it("merges rows into a loaded list by id, keeping rows the event does not name and newer cached rows", () => {
    qc.setQueryData(key, { session_id: "chat-1", running: 2, rows: [
      row("a"), row("old", { status: "completed", ended_at: "2026-10-15T00:00:00Z" }),
      row("b", { status: "stopped", stop_reason: "user", updated_at: "2026-10-16T00:00:09Z" }),
    ] });
    handlers["chat:background_tasks"]?.({ chat_session_id: "chat-1", rows: [
      row("a", { status: "completed", ended_at: "2026-10-16T00:00:05Z", updated_at: "2026-10-16T00:00:05Z" }),
      row("b", { updated_at: "2026-10-16T00:00:02Z" }),
      row("c", { status: "mystery" }),
      { id: "broken" },
    ] });
    const data = qc.getQueryData<{ running: number; rows: Array<{ task_id: string; status: string }> }>(key)!;
    expect(data.rows.map((r) => [r.task_id, r.status])).toEqual([["a", "completed"], ["old", "completed"], ["b", "stopped"], ["c", "unknown"]]);
    expect(data.running).toBe(0);
    // Without `running`, the merged rows' count goes to the session list.
    expect(qc.getQueryData<ChatSession[]>(chatKeys.sessions("ws-1"))?.[0]?.running_background_tasks).toBe(0);
  });

  it("rereads a loaded list when the event carries no rows, and ignores a payload with no session", async () => {
    const observer = new QueryObserver(qc, { queryKey: key, queryFn: async () => ({ session_id: "chat-1", running: 1, rows: [row("z")] }) });
    const unsubscribe = observer.subscribe(() => {});
    try {
      await vi.waitFor(() => expect(qc.getQueryData(key)).toBeTruthy());
      qc.setQueryData(key, { session_id: "chat-1", running: 0, rows: [] });
      handlers["chat:background_tasks"]?.({ session_id: "chat-1", running: 1 });
      await vi.waitFor(() => expect(qc.getQueryData<{ rows: unknown[] }>(key)?.rows).toHaveLength(1));
      const before = qc.getQueryData(chatKeys.sessions("ws-1"));
      handlers["chat:background_tasks"]?.({ running: 3 });
      handlers["chat:background_tasks"]?.(null);
      expect(qc.getQueryData(chatKeys.sessions("ws-1"))).toBe(before);
    } finally { unsubscribe(); }
  });
});
