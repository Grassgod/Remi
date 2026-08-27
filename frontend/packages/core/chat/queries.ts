import { infiniteQueryOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { ChatPendingTask, PendingChatTasksResponse, TaskMessagePayload } from "../types";

// NOTE on workspace scoping:
// `wsId` is used only as part of queryKey for cache isolation per workspace.
// The actual workspace context comes from ApiClient's X-Workspace-Slug header,
// which is set by the URL-driven [workspaceSlug] layout. Callers must ensure
// the header is in sync with the wsId they pass here — otherwise cache writes
// will be misattributed during a workspace switch race window.

export const chatKeys = {
  all: (wsId: string) => ["chat", wsId] as const,
  /** Full sessions list (active + archived); the dropdown splits locally. */
  sessions: (wsId: string) => [...chatKeys.all(wsId), "sessions"] as const,
  session: (wsId: string, id: string) => [...chatKeys.all(wsId), "session", id] as const,
  messages: (sessionId: string) => ["chat", "messages", sessionId] as const,
  messagesPage: (sessionId: string) => ["chat", "messages-page", sessionId] as const,
  pendingTask: (sessionId: string) => ["chat", "pending-task", sessionId] as const,
  /** Aggregate of in-flight chat tasks for the current user — FAB reads this. */
  pendingTasks: (wsId: string) => [...chatKeys.all(wsId), "pending-tasks"] as const,
  /** Per-task execution messages — shared with issue agent cards. */
  taskMessages: (taskId: string) => ["task-messages", taskId] as const,
  humanRequests: (taskId: string) => ["task-human-requests", taskId] as const,
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIXED_TASK_ID_PATTERN = /^tsk_[a-z0-9_]+$/i;
export const CHAT_PENDING_REFETCH_INTERVAL_MS = 3000;
const TASK_MESSAGE_IN_FLIGHT_MAX_PER_TASK = 200;
const TASK_MESSAGE_IN_FLIGHT_MAX_TASKS = 100;
const inFlightTaskMessages = new Map<string, TaskMessagePayload[]>();

export function isTaskMessageTaskId(taskId: string | null | undefined): taskId is string {
  return typeof taskId === "string"
    && (UUID_PATTERN.test(taskId) || PREFIXED_TASK_ID_PATTERN.test(taskId));
}

/**
 * Merge task-message snapshots and live frames by sequence. Later sources win:
 * the daemon assigns seq before persisting an immutable outbox payload, and WS
 * frames are broadcast from the post-upsert row, so they are equal to or newer
 * than a racing history response.
 */
export function mergeTaskMessages(
  ...sources: ReadonlyArray<readonly TaskMessagePayload[]>
): TaskMessagePayload[] {
  const bySeq = new Map<number, TaskMessagePayload>();
  for (const source of sources) {
    for (const message of source) bySeq.set(message.seq, message);
  }
  return Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
}

function bufferInFlightTaskMessages(
  taskId: string,
  pending: readonly TaskMessagePayload[],
): void {
  const existing = inFlightTaskMessages.get(taskId) ?? [];
  const bounded = mergeTaskMessages(existing, pending).slice(-TASK_MESSAGE_IN_FLIGHT_MAX_PER_TASK);
  inFlightTaskMessages.delete(taskId);
  while (inFlightTaskMessages.size >= TASK_MESSAGE_IN_FLIGHT_MAX_TASKS) {
    const oldestTaskId = inFlightTaskMessages.keys().next().value;
    if (oldestTaskId === undefined) break;
    inFlightTaskMessages.delete(oldestTaskId);
  }
  inFlightTaskMessages.set(taskId, bounded);
}

function mergeAndDrainInFlightTaskMessages(
  taskId: string,
  ...sources: ReadonlyArray<readonly TaskMessagePayload[]>
): TaskMessagePayload[] {
  const buffered = inFlightTaskMessages.get(taskId) ?? [];
  const merged = mergeTaskMessages(...sources, buffered);
  inFlightTaskMessages.delete(taskId);
  return merged;
}

/**
 * Append live frames only after a full task-message snapshot has hydrated.
 * During the initial fetch window, keep a bounded bridge buffer for queryFn to
 * drain. It is never rendered or treated as a second transcript data source.
 */
export function appendTaskMessagesToHydratedCache(
  client: QueryClient,
  taskId: string,
  pending: readonly TaskMessagePayload[],
): boolean {
  const key = chatKeys.taskMessages(taskId);
  const cached = client.getQueryData<TaskMessagePayload[]>(key);
  if (cached === undefined) {
    if (client.getQueryState(key)?.fetchStatus === "fetching") {
      bufferInFlightTaskMessages(taskId, pending);
    }
    return false;
  }

  const seen = new Set(cached.map((message) => message.seq));
  const additions = pending.filter((message) => {
    if (seen.has(message.seq)) return false;
    seen.add(message.seq);
    return true;
  });
  if (additions.length > 0) {
    client.setQueryData(key, mergeTaskMessages(cached, additions));
  }
  return true;
}

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

export function chatSessionsOptions(wsId: string) {
  return queryOptions({
    queryKey: chatKeys.sessions(wsId),
    queryFn: () => api.listChatSessions({ status: "all" }),
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

export function chatMessagesOptions(sessionId: string) {
  return queryOptions({
    queryKey: chatKeys.messages(sessionId),
    queryFn: () => api.listChatMessages(sessionId),
    enabled: !!sessionId,
    staleTime: Infinity,
  });
}

export function chatMessagesPageOptions(sessionId: string, limit = 50) {
  return infiniteQueryOptions({
    queryKey: chatKeys.messagesPage(sessionId),
    queryFn: ({ pageParam }) =>
      api.listChatMessagesPage(sessionId, { before: pageParam, limit }),
    initialPageParam: null as { created_at: string; id: string } | null,
    getNextPageParam: (lastPage) =>
      lastPage.has_more ? lastPage.next_cursor ?? undefined : undefined,
    enabled: !!sessionId,
    staleTime: Infinity,
  });
}

/**
 * Pending task for a chat session — the "is something still running?" signal.
 * Refetched via WS invalidation in useRealtimeSync when chat:message / chat:done
 * / task:completed / task:failed arrive. While a task is pending, a low-rate
 * poll reconciles missed WS events so the UI cannot stay queued forever after
 * the server has already completed the task.
 */
export function pendingChatTaskOptions(sessionId: string) {
  return queryOptions({
    queryKey: chatKeys.pendingTask(sessionId),
    queryFn: () => api.getPendingChatTask(sessionId),
    enabled: !!sessionId,
    refetchInterval: pendingChatTaskRefetchInterval,
    refetchIntervalInBackground: true,
    staleTime: Infinity,
  });
}

/**
 * Timeline for a single task — rendered by both the live chat view (while a
 * task is running) and AssistantMessage (for completed tasks). Once the full
 * history has hydrated this key, WS `task:message` events append to it via
 * useRealtimeSync.
 */
export function taskMessagesOptions(taskId: string) {
  return queryOptions({
    queryKey: chatKeys.taskMessages(taskId),
    queryFn: async ({ client }) => {
      try {
        const history = await api.listTaskMessages(taskId);
        const cached = client.getQueryData<TaskMessagePayload[]>(chatKeys.taskMessages(taskId)) ?? [];
        return mergeAndDrainInFlightTaskMessages(taskId, history, cached);
      } catch (error) {
        inFlightTaskMessages.delete(taskId);
        throw error;
      }
    },
    enabled: isTaskMessageTaskId(taskId),
    staleTime: Infinity,
  });
}

/**
 * Aggregate of in-flight chat tasks for the current user in this workspace.
 * Drives the FAB "running" indicator while the chat window is minimised —
 * no per-session query is active then, so we need this roll-up.
 */
export function pendingChatTasksOptions(wsId: string) {
  return queryOptions({
    queryKey: chatKeys.pendingTasks(wsId),
    queryFn: () => api.listPendingChatTasks(),
    refetchInterval: pendingChatTasksRefetchInterval,
    refetchIntervalInBackground: true,
    staleTime: Infinity,
  });
}
