import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { chatKeys } from "./queries";
import { reconcileSettledPendingChatTask } from "./pending-task-reconciliation";

describe("reconcileSettledPendingChatTask", () => {
  it("refreshes messages and chat summaries when a pending task disappears", () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    expect(reconcileSettledPendingChatTask(
      queryClient,
      "ws-1",
      { sessionId: "chat-1", taskId: "tsk_1" },
      { sessionId: "chat-1", taskId: null },
    )).toBe(true);

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: chatKeys.messages("chat-1"),
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: chatKeys.messagesPage("chat-1"),
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: chatKeys.sessions("ws-1"),
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: chatKeys.pendingTasks("ws-1"),
    });
  });

  it("does nothing across a session switch or while the same task is pending", () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    expect(reconcileSettledPendingChatTask(
      queryClient,
      "ws-1",
      { sessionId: "chat-1", taskId: "tsk_1" },
      { sessionId: "chat-2", taskId: null },
    )).toBe(false);
    expect(reconcileSettledPendingChatTask(
      queryClient,
      "ws-1",
      { sessionId: "chat-1", taskId: "tsk_1" },
      { sessionId: "chat-1", taskId: "tsk_1" },
    )).toBe(false);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
