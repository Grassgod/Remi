import { describe, expect, it } from "vitest";
import {
  CHAT_PENDING_REFETCH_INTERVAL_MS,
  chatKeys,
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
