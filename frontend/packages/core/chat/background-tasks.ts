import type { QueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/http";
import { ChatBackgroundTasksSnapshotSchema } from "../api/schemas/chat";
import type { ChatBackgroundStopTarget, ChatBackgroundTask, ChatBackgroundTasksSnapshot, ChatSession } from "../types";
import { chatKeys } from "./queries";

/**
 * Background tasks of a Chat (PR 6) in the query cache: the session registry
 * rows under {@link chatKeys.backgroundTasks}, the session list's
 * `running_background_tasks` count, and a stop request's optimistic mark.
 * The realtime handler and the stop mutation share these.
 */

/** Statuses with a process still behind them. */
export function isLiveChatBackgroundTask(row: Pick<ChatBackgroundTask, "status">): boolean {
  return row.status === "running" || row.status === "paused";
}

/**
 * Rows merged by id: an incoming row replaces the cached one unless the cached
 * one is newer (`updated_at`), and rows the event does not name stay. The
 * `running` count is recomputed from the merged rows.
 */
export function mergeBackgroundTaskRows(
  current: ChatBackgroundTasksSnapshot | undefined,
  incoming: Pick<ChatBackgroundTasksSnapshot, "session_id" | "rows">,
): ChatBackgroundTasksSnapshot {
  const byId = new Map<string, ChatBackgroundTask>();
  for (const row of current?.rows ?? []) byId.set(row.id, row);
  for (const row of incoming.rows) {
    const cached = byId.get(row.id);
    // A row optimistically marked as stopping keeps the mark until the
    // registry reports a request of its own.
    if (cached && cached.updated_at && row.updated_at && cached.updated_at > row.updated_at) continue;
    byId.set(row.id, cached?.stop_requested_at && !row.stop_requested_at && isLiveChatBackgroundTask(row)
      ? { ...row, stop_requested_at: cached.stop_requested_at, stop_requested_by: cached.stop_requested_by } : row);
  }
  const rows = [...byId.values()];
  return { session_id: incoming.session_id, rows, running: rows.filter(isLiveChatBackgroundTask).length };
}

/** Writes the session's running count into every cached session list and its detail. */
export function patchSessionBackgroundCount(qc: QueryClient, wsId: string, sessionId: string, count: number): void {
  const patch = (session: ChatSession): ChatSession =>
    session.id === sessionId && session.running_background_tasks !== count ? { ...session, running_background_tasks: count } : session;
  for (const [key, previous] of qc.getQueriesData<ChatSession[]>({ queryKey: chatKeys.sessions(wsId) })) {
    if (!Array.isArray(previous) || !previous.some((session) => session.id === sessionId && session.running_background_tasks !== count)) continue;
    qc.setQueryData(key, previous.map(patch));
  }
  qc.setQueryData<ChatSession>(chatKeys.session(wsId, sessionId), (old) => old ? patch(old) : old);
}

/**
 * Applies a `chat:background_tasks` payload: merges its rows into a cached
 * list (an uncached chat stays unread: nothing on screen needs it) and moves
 * the session list's count. Returns false for a payload it cannot read.
 */
export function applyBackgroundTasksEvent(qc: QueryClient, wsId: string, payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const raw = payload as Record<string, unknown>;
  const sessionId = typeof raw.session_id === "string" ? raw.session_id
    : typeof raw.chat_session_id === "string" ? raw.chat_session_id : null;
  if (!sessionId) return false;
  const key = chatKeys.backgroundTasks(wsId, sessionId);
  const hasRows = Array.isArray(raw.rows);
  const parsed = hasRows ? ChatBackgroundTasksSnapshotSchema.safeParse({ ...raw, session_id: sessionId }) : null;
  let running = typeof raw.running === "number" && Number.isFinite(raw.running) && raw.running >= 0 ? Math.floor(raw.running) : null;
  if (parsed?.success) {
    const cached = qc.getQueryData<ChatBackgroundTasksSnapshot>(key);
    // Without a count, the rows say it: the merged ones when a list is loaded.
    const merged = cached ? mergeBackgroundTaskRows(cached, parsed.data) : null;
    running ??= merged ? merged.running : parsed.data.running;
    if (merged) qc.setQueryData<ChatBackgroundTasksSnapshot>(key, { ...merged, running });
  } else {
    // No rows to merge: a reader on screen rereads them.
    void qc.invalidateQueries({ queryKey: key });
  }
  if (running !== null) patchSessionBackgroundCount(qc, wsId, sessionId, running);
  return true;
}

/**
 * Marks the rows a stop asked for as stopping (`stop_requested_at` now), so
 * 「正在停止…」 shows before the daemon answers. Ended rows and rows that
 * cannot be stopped are left alone.
 */
export function markBackgroundStopRequested(
  qc: QueryClient,
  wsId: string,
  sessionId: string,
  target: ChatBackgroundStopTarget,
  requestedAt: string,
  by: string | null,
): void {
  qc.setQueryData<ChatBackgroundTasksSnapshot>(chatKeys.backgroundTasks(wsId, sessionId), (old) => old ? {
    ...old,
    rows: old.rows.map((row) => isLiveChatBackgroundTask(row) && row.can_stop && ("all" in target || row.task_id === target.task_id)
      ? { ...row, stop_requested_at: requestedAt, stop_requested_by: by, stop_outcome: "pending" } : row),
  } : old);
}

/**
 * Undoes {@link markBackgroundStopRequested} after a refused stop: each row
 * gets back the stop fields it had before, and keeps everything a realtime
 * event changed since.
 */
export function restoreBackgroundStopMarks(
  qc: QueryClient,
  wsId: string,
  sessionId: string,
  previous: ChatBackgroundTasksSnapshot | undefined,
): void {
  if (!previous) return;
  const before = new Map(previous.rows.map((row) => [row.id, row]));
  qc.setQueryData<ChatBackgroundTasksSnapshot>(chatKeys.backgroundTasks(wsId, sessionId), (old) => old ? {
    ...old,
    rows: old.rows.map((row) => {
      const prior = before.get(row.id);
      if (!prior || (row.stop_requested_at === prior.stop_requested_at && row.stop_outcome === prior.stop_outcome)) return row;
      return { ...row, stop_requested_at: prior.stop_requested_at, stop_requested_by: prior.stop_requested_by, stop_outcome: prior.stop_outcome };
    }),
  } : old);
}

/** Why the server refused a stop (`409 {code}`): the task already ended, or its computer is offline. */
export type BackgroundStopErrorCode = "task_not_running" | "runtime_offline" | "failed";

export function backgroundStopErrorCode(error: unknown): BackgroundStopErrorCode {
  if (!(error instanceof ApiError) || error.status !== 409) return "failed";
  const code = error.body && typeof error.body === "object" ? (error.body as { code?: unknown }).code : null;
  return code === "task_not_running" || code === "runtime_offline" ? code : "failed";
}
