import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import type { ChatOriginFilter, ChatPendingTask, PendingChatTasksResponse } from "../types";
import type { ChatQueue } from "../api/schemas/chat-queue";

// NOTE on workspace scoping:
// `wsId` is used only as part of queryKey for cache isolation per workspace.
// The actual workspace context comes from ApiClient's X-Workspace-Slug header,
// which is set by the URL-driven [workspaceSlug] layout. Callers must ensure
// the header is in sync with the wsId they pass here — otherwise cache writes
// will be misattributed during a workspace switch race window.

export const chatKeys = {
  all: (wsId: string) => ["chat", wsId] as const,
  /** The user's own sessions, active + archived; the dropdown splits locally. Prefix of every list below. */
  sessions: (wsId: string) => [...chatKeys.all(wsId), "sessions"] as const,
  /** Position 3 is the status filter and position 4 the origin filter; absent means "all" and "user". */
  sessionList: (
    wsId: string,
    status: "all" | "active" | "archived" = "all",
    origin: ChatOriginFilter = "user",
  ) =>
    origin !== "user"
      ? [...chatKeys.sessions(wsId), status, origin] as const
      : status === "all" ? chatKeys.sessions(wsId) : [...chatKeys.sessions(wsId), status] as const,
  session: (wsId: string, id: string) => [...chatKeys.all(wsId), "session", id] as const,
  pendingTask: (sessionId: string) => ["chat", "pending-task", sessionId] as const,
  /** Aggregate of in-flight chat tasks for the current user — FAB reads this. */
  pendingTasks: (wsId: string) => [...chatKeys.all(wsId), "pending-tasks"] as const,
  humanRequests: (taskId: string) => ["task-human-requests", taskId] as const,
  /** Follow-up queue of one Chat (ADR 0020): live rows and the lane pause. */
  queue: (wsId: string, sessionId: string) => [...chatKeys.all(wsId), "queue", sessionId] as const,
};

/**
 * Fallback re-poll cadence for chat pending tasks (MUL-472 a / A6).
 *
 * WS events remain the primary refresh signal (`createChatHandlers` invalidates
 * both the per-session and the aggregate key on every chat/task lifecycle
 * event, which refetches immediately). This poll only reconciles events the
 * socket missed. At 3 s one open tab with a queued task kept ~136 SQL/s of
 * `pending-tasks` load alive (MUL-383 `cmt_lnvu0atqu87w`), so the steady state
 * is 10 s; `refetchIntervalInBackground: false` on the consumers stops it
 * entirely while the tab is hidden.
 */
export const CHAT_PENDING_REFETCH_INTERVAL_MS = 10_000;
export function pendingChatTaskRefetchInterval(query: {
  state: { data?: ChatPendingTask };
}): number | false {
  return query.state.data?.task_id
    ? CHAT_PENDING_REFETCH_INTERVAL_MS
    : false;
}

export function pendingChatTasksRefetchInterval(query: {
  state: { data?: PendingChatTasksResponse };
}): number | false {
  return (query.state.data?.tasks?.length ?? 0) > 0
    ? CHAT_PENDING_REFETCH_INTERVAL_MS
    : false;
}

export function chatSessionsOptions(
  wsId: string,
  status: "all" | "active" | "archived" = "all",
  /** MUL-472 b: the minimised chat window keeps cached sessions but stops fetching. */
  options: { enabled?: boolean } = {},
  origin: ChatOriginFilter = "user",
) {
  return queryOptions({
    queryKey: chatKeys.sessionList(wsId, status, origin),
    queryFn: () => api.listChatSessions({ status, origin }),
    enabled: options.enabled ?? true,
    staleTime: Infinity,
  });
}

export function chatSessionOptions(wsId: string, id: string) {
  return queryOptions({
    queryKey: chatKeys.session(wsId, id),
    queryFn: () => api.getChatSession(id),
    enabled: !!id,
    staleTime: Infinity,
  });
}

/**
 * Pending task for a chat session — the "is something still running?" signal.
 * Refetched via WS invalidation in useRealtimeSync when chat:done
 * / task:completed / task:failed arrive. While a task is pending, a low-rate
 * poll reconciles missed WS events so the UI cannot stay queued forever after
 * the server has already completed the task.
 */
export function pendingChatTaskOptions(
  sessionId: string,
  /** MUL-472 b: the minimised chat window keeps the cached task but stops fetching. */
  options: { enabled?: boolean } = {},
) {
  return queryOptions({
    queryKey: chatKeys.pendingTask(sessionId),
    queryFn: () => api.getPendingChatTask(sessionId),
    enabled: !!sessionId && (options.enabled ?? true),
    refetchInterval: pendingChatTaskRefetchInterval,
    refetchIntervalInBackground: false,
    staleTime: Infinity,
  });
}

/**
 * Aggregate of in-flight chat tasks for the current user in this workspace.
 * Drives the FAB "running" indicator while the chat window is minimised —
 * no per-session query is active then, so we need this roll-up.
 */
export function pendingChatTasksOptions(
  wsId: string,
  /** MUL-472 b: the FAB keeps reading a cached roll-up while the window is closed. */
  options: { enabled?: boolean } = {},
) {
  return queryOptions({
    queryKey: chatKeys.pendingTasks(wsId),
    queryFn: () => api.listPendingChatTasks(),
    enabled: options.enabled ?? true,
    refetchInterval: pendingChatTasksRefetchInterval,
    refetchIntervalInBackground: false,
    staleTime: Infinity,
  });
}

/**
 * Follow-up queue fallback poll. `chat:queue_updated` and pending-task
 * changes invalidate the key; the poll only reconciles a missed event while
 * the queue holds rows or is paused, and never while the tab is hidden.
 */
export const CHAT_QUEUE_REFETCH_INTERVAL_MS = 10_000;
export function chatQueueRefetchInterval(query: {
  state: { data?: ChatQueue };
}): number | false {
  const data = query.state.data;
  return data && (data.items.length > 0 || data.paused) ? CHAT_QUEUE_REFETCH_INTERVAL_MS : false;
}

/**
 * The Chat follow-up queue. Mount it only inside a visible chat (MUL-472):
 * `enabled` follows the window, and the cached rows stay readable while it
 * is closed.
 */
export function chatQueueOptions(
  wsId: string,
  sessionId: string,
  options: { enabled?: boolean } = {},
) {
  return queryOptions({
    queryKey: chatKeys.queue(wsId, sessionId),
    queryFn: () => api.getChatQueue(sessionId),
    enabled: !!sessionId && (options.enabled ?? true),
    refetchInterval: chatQueueRefetchInterval,
    refetchIntervalInBackground: false,
    staleTime: Infinity,
  });
}
