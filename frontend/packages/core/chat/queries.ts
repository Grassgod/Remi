import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import { ApiError } from "../api/http";
import type { ChatBackgroundTasksSnapshot, ChatOriginFilter, ChatPendingTask, PendingChatTasksResponse } from "../types";
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
  /** Prefix of every session detail. */
  sessionDetails: (wsId: string) => [...chatKeys.all(wsId), "session"] as const,
  pendingTask: (sessionId: string) => ["chat", "pending-task", sessionId] as const,
  /** Aggregate of in-flight chat tasks for the current user — FAB reads this. */
  pendingTasks: (wsId: string) => [...chatKeys.all(wsId), "pending-tasks"] as const,
  humanRequests: (taskId: string) => ["task-human-requests", taskId] as const,
  /** Follow-up queue of one Chat (ADR 0020): live rows and the lane pause. */
  queue: (wsId: string, sessionId: string) => [...chatKeys.all(wsId), "queue", sessionId] as const,
  /** Prefix of every Chat's background tasks. */
  backgroundTasksAll: (wsId: string) => [...chatKeys.all(wsId), "background-tasks"] as const,
  /** One Chat's background tasks (PR 6): the session registry, never a trace. */
  backgroundTasks: (wsId: string, sessionId: string) => [...chatKeys.backgroundTasksAll(wsId), sessionId] as const,
  /** Prefix of every composer slash-command catalogue (ADR 0025). */
  slashCommandsAll: (wsId: string) => [...chatKeys.all(wsId), "slash-commands"] as const,
  /** The catalogue of one agent in one Chat; a Chat not created yet is `"new"`. */
  slashCommands: (wsId: string, agentId: string, sessionId: string | null) =>
    [...chatKeys.slashCommandsAll(wsId), agentId, sessionId ?? "new"] as const,
};

/**
 * The agent's command catalogue for the composer menu (ADR 0025). It changes
 * only when a turn ends, which invalidates it (`chat:done`, `task:failed`);
 * the stale time only bounds a missed event.
 */
export function chatSlashCommandsOptions(
  wsId: string,
  agentId: string | null,
  sessionId: string | null,
  options: { enabled?: boolean } = {},
) {
  return queryOptions({
    queryKey: chatKeys.slashCommands(wsId, agentId ?? "", sessionId),
    queryFn: () => api.getChatSlashCommands({ agentId: agentId!, sessionId }),
    enabled: !!wsId && !!agentId && (options.enabled ?? true),
    staleTime: 5 * 60_000,
  });
}

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
    queryFn: ({ client, queryKey }) => readPendingChatTask(sessionId, client.getQueryData<ChatPendingTask>(queryKey)),
    enabled: !!sessionId && (options.enabled ?? true),
    refetchInterval: pendingChatTaskRefetchInterval,
    refetchIntervalInBackground: false,
    staleTime: Infinity,
  });
}

/**
 * The chat's pending task, read again.
 *
 * `getPendingChatTask` lists the chat's turns once per active status, three
 * reads that are not one snapshot: a turn that changes status between them
 * (pending → running when it is claimed, running ↔ awaiting_human around an
 * agent's question) is in none of the answers. So when they find no turn while
 * the cache still holds one that no event settled (`chat:done`, a cancel or a
 * failure replace it first), that turn is read on its own, and it stays while
 * it is still in flight. An optimistic send seed names no turn yet.
 */
export async function readPendingChatTask(sessionId: string, held: ChatPendingTask | undefined): Promise<ChatPendingTask> {
  const listed = await api.getPendingChatTask(sessionId);
  if (listed.task_id) return listed;
  const turnId = held?.turn_id ?? (held?.task_id && !held.task_id.startsWith("optimistic-") ? held.task_id : undefined);
  if (!turnId) return listed;
  try {
    const turn = await api.getChatTurnPendingTask(turnId);
    return turn.task_id ? turn : listed;
  } catch (error) {
    // A turn that is gone, or an attempt id that names no turn, is not in flight.
    if (error instanceof ApiError && error.status === 404) return listed;
    throw error;
  }
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

/**
 * Background-task fallback poll (PR 6). `chat:background_tasks` keeps the
 * rows current; the daemon refreshes a running lane every 30 s, so this only
 * reconciles a missed event while a task runs, and never while the tab is
 * hidden.
 */
export const CHAT_BACKGROUND_TASKS_REFETCH_INTERVAL_MS = 30_000;
export function chatBackgroundTasksRefetchInterval(query: {
  state: { data?: ChatBackgroundTasksSnapshot };
}): number | false {
  return (query.state.data?.running ?? 0) > 0 ? CHAT_BACKGROUND_TASKS_REFETCH_INTERVAL_MS : false;
}

/**
 * One Chat's background tasks (PR 6 §8). Read only while the chat is on
 * screen and the session list says a task runs, or while the panel shows
 * them (MUL-472); other readers pass `enabled: false` and see the cache.
 */
export function chatBackgroundTasksOptions(
  wsId: string,
  sessionId: string,
  options: { enabled?: boolean } = {},
) {
  return queryOptions({
    queryKey: chatKeys.backgroundTasks(wsId, sessionId),
    queryFn: () => api.listChatBackgroundTasks(sessionId),
    enabled: !!sessionId && (options.enabled ?? true),
    refetchInterval: chatBackgroundTasksRefetchInterval,
    refetchIntervalInBackground: false,
    staleTime: Infinity,
  });
}
