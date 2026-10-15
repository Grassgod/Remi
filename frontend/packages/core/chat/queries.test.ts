import { describe, expect, it } from "vitest";
import {
  CHAT_PENDING_REFETCH_INTERVAL_MS,
  CHAT_QUEUE_REFETCH_INTERVAL_MS,
  chatKeys,
  chatQueueOptions,
  chatQueueRefetchInterval,
  chatSessionsOptions,
  pendingChatTaskOptions,
  pendingChatTaskRefetchInterval,
  pendingChatTasksOptions,
  pendingChatTasksRefetchInterval,
} from "./queries";

describe("pending chat task polling", () => {
  it("isolates session status filters and workspaces", () => {
    expect(chatSessionsOptions("ws-1").queryKey).toEqual(chatKeys.sessions("ws-1"));
    expect(chatSessionsOptions("ws-1", "active").queryKey).not.toEqual(chatSessionsOptions("ws-1", "archived").queryKey);
    expect(chatSessionsOptions("ws-1", "archived").queryKey).not.toEqual(chatSessionsOptions("ws-2", "archived").queryKey);
  });

  it("keeps the user's own list under the sessions prefix and separates the other origins", () => {
    expect(chatSessionsOptions("ws-1", "all", {}, "user").queryKey).toEqual(chatKeys.sessions("ws-1"));
    const automation = chatSessionsOptions("ws-1", "all", {}, "automation").queryKey;
    const all = chatSessionsOptions("ws-1", "all", {}, "all").queryKey;
    expect(automation).not.toEqual(all);
    expect(automation).not.toEqual(chatKeys.sessions("ws-1"));
    expect(automation.slice(0, 3)).toEqual(chatKeys.sessions("ws-1"));
    expect(chatKeys.sessionList("ws-1", "archived", "automation")).toEqual([...chatKeys.sessions("ws-1"), "archived", "automation"]);
  });

  it("polls only while a per-session task is pending", () => {
    expect(pendingChatTaskRefetchInterval({ state: { data: { task_id: "tsk_1", status: "queued" } } }))
      .toBe(CHAT_PENDING_REFETCH_INTERVAL_MS);
    expect(pendingChatTaskRefetchInterval({ state: { data: {} } })).toBe(false);
  });

  it("stops the per-session pending poll while the tab is hidden", () => {
    const options = pendingChatTaskOptions("chat-1");
    expect(options.refetchIntervalInBackground).toBe(false);
    expect(options.refetchInterval).toBe(pendingChatTaskRefetchInterval);
  });

  it("stops the aggregate pending poll while the tab is hidden", () => {
    const options = pendingChatTasksOptions("ws-1");
    expect(options.refetchIntervalInBackground).toBe(false);
    expect(options.refetchInterval).toBe(pendingChatTasksRefetchInterval);
  });

  it("polls the aggregate only while it contains pending tasks", () => {
    expect(pendingChatTasksRefetchInterval({ state: { data: { tasks: [
      { task_id: "tsk_1", status: "running", chat_session_id: "chat-1" },
    ] } } })).toBe(CHAT_PENDING_REFETCH_INTERVAL_MS);
    expect(pendingChatTasksRefetchInterval({ state: { data: { tasks: [] } } })).toBe(false);
  });
});

describe("chat follow-up queue query", () => {
  it("keys the queue by workspace and chat", () => {
    expect(chatQueueOptions("ws-1", "chat-1").queryKey).toEqual(["chat", "ws-1", "queue", "chat-1"]);
    expect(chatKeys.queue("ws-1", "chat-1")).not.toEqual(chatKeys.queue("ws-2", "chat-1"));
  });

  it("stays disabled outside a visible chat or without a chat id", () => {
    expect(chatQueueOptions("ws-1", "chat-1", { enabled: false }).enabled).toBe(false);
    expect(chatQueueOptions("ws-1", "").enabled).toBe(false);
    expect(chatQueueOptions("ws-1", "chat-1").enabled).toBe(true);
  });

  it("falls back to a 10 s poll only while rows or a pause exist, never in the background", () => {
    const options = chatQueueOptions("ws-1", "chat-1");
    expect(options.refetchIntervalInBackground).toBe(false);
    expect(options.refetchInterval).toBe(chatQueueRefetchInterval);
    const row = { id: "q", session_id: "chat-1", body_md: "x", attachments: [], client_id: "c", status: "queued", error: null,
      revision: 1, released_message_id: null, released_via: null, released_at: null, created_at: "t", updated_at: "t" };
    expect(chatQueueRefetchInterval({ state: { data: { items: [row], paused: null } } })).toBe(CHAT_QUEUE_REFETCH_INTERVAL_MS);
    expect(chatQueueRefetchInterval({ state: { data: { items: [], paused: { reason: "interrupted", at: "t" } } } })).toBe(CHAT_QUEUE_REFETCH_INTERVAL_MS);
    expect(chatQueueRefetchInterval({ state: { data: { items: [], paused: null } } })).toBe(false);
    expect(chatQueueRefetchInterval({ state: {} })).toBe(false);
  });
});
