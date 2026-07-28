import type { QueryClient } from "@tanstack/react-query";
import { chatKeys } from "./queries";

export interface PendingChatTaskRef {
  sessionId: string | null;
  taskId: string | null;
}

/**
 * Reconcile the rest of the chat cache when the pending-task poll observes a
 * terminal transition that a missed WS event would normally have delivered.
 */
export function reconcileSettledPendingChatTask(
  queryClient: QueryClient,
  wsId: string,
  previous: PendingChatTaskRef,
  current: PendingChatTaskRef,
): boolean {
  if (
    !previous.sessionId
    || !previous.taskId
    || previous.sessionId !== current.sessionId
    || current.taskId
  ) {
    return false;
  }

  void queryClient.invalidateQueries({
    queryKey: chatKeys.messages(previous.sessionId),
  });
  void queryClient.invalidateQueries({
    queryKey: chatKeys.messagesPage(previous.sessionId),
  });
  void queryClient.invalidateQueries({
    queryKey: chatKeys.sessions(wsId),
  });
  void queryClient.invalidateQueries({
    queryKey: chatKeys.pendingTasks(wsId),
  });
  return true;
}
