import type { TaskMessagePayload } from "../types/events";

/**
 * Task messages reach the same `["task-messages", taskId]` cache via two wires
 * with different casing: the browser GET returns the raw store object
 * (camelCase — `taskId`, `createdAt`, `toolCallId`), while the WS frame is
 * snake_case (`task_id`, `created_at`, `tool_call_id`). Left unnormalized they
 * mix, and a message that arrived live (snake) can't be reconciled with the
 * same message after a refetch (camel) — pairing and dedup silently break.
 *
 * This is the single canonical funnel: both entry points (ApiClient
 * .listTaskMessages and the WS handler in use-realtime-sync) run through it, so
 * everything downstream sees one snake_case shape. `task_id` is canonical
 * because existing consumers already key on it.
 */
export function normalizeTaskMessage(raw: unknown): TaskMessagePayload {
  const m = (raw ?? {}) as Record<string, unknown>;
  const pick = <T>(...keys: string[]): T | undefined => {
    for (const k of keys) {
      if (m[k] !== undefined && m[k] !== null) return m[k] as T;
    }
    return undefined;
  };
  return {
    task_id: pick<string>("task_id", "taskId") ?? "",
    issue_id: pick<string>("issue_id", "issueId") ?? "",
    chat_session_id: pick<string>("chat_session_id", "chatSessionId"),
    seq: Number(pick<number>("seq") ?? 0),
    type: (pick<string>("type") ?? "text") as TaskMessagePayload["type"],
    tool: pick<string>("tool"),
    content: pick<string>("content"),
    input: pick<Record<string, unknown>>("input"),
    output: pick<string>("output"),
    tool_call_id: pick<string>("tool_call_id", "toolCallId"),
    status: pick<string>("status"),
    meta: pick<Record<string, unknown>>("meta"),
    created_at: pick<string>("created_at", "createdAt"),
  };
}

export function normalizeTaskMessages(raw: unknown): TaskMessagePayload[] {
  return Array.isArray(raw) ? raw.map(normalizeTaskMessage) : [];
}
