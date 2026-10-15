import type { TraceItemOf } from "@multiremi/contracts/trace";
import type { ChatBackgroundTask, ChatBackgroundTasksSnapshot } from "@multiremi/core/types";
import { T0, at } from "../../../test/trace-fixtures";

// Session registry rows (PR 6) for the background-task tests: what
// `GET /api/chat/sessions/:id/background-tasks` answers, and the trace item a
// row's origin attempt wrote.

export const BG_SESSION = "chat_1";

export function bgTask(id: string, overrides: Partial<ChatBackgroundTask> = {}): ChatBackgroundTask {
  return {
    id: `bgrow_${id}`,
    workspace_id: "ws-1",
    session_id: BG_SESSION,
    agent_id: "agt_1",
    execution_scope: "",
    runtime_id: "rt_1",
    provider_session_id: "ps_1",
    task_id: id,
    task_type: "shell",
    name: "npm run dev",
    command: "npm run dev -- --port 3000",
    origin_attempt_id: "att_1",
    origin_turn_id: "turn_1",
    origin_item_id: `bg:${id}`,
    status: "running",
    stop_reason: null,
    can_stop: true,
    stop_requested_at: null,
    stop_requested_by: null,
    stop_outcome: null,
    started_at: T0,
    ended_at: null,
    duration_ms: null,
    summary: null,
    output_tail: "ready in 312 ms\nLocal: http://localhost:3000/\n",
    usage: null,
    lane_state: "parked",
    parked_until: at(2 * 60 * 60),
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

export function bgSnapshot(rows: ChatBackgroundTask[], sessionId = BG_SESSION): ChatBackgroundTasksSnapshot {
  return { session_id: sessionId, rows, running: rows.filter((row) => row.status === "running" || row.status === "paused").length };
}

/** The trace item an attempt wrote for a task its call `toolItemId` started. */
export function bgItem(taskId: string, toolItemId: string, overrides: Partial<TraceItemOf<"background_task">> = {}): TraceItemOf<"background_task"> {
  return {
    id: `bg:${taskId}`, parent_id: null, status: "in_progress", started_at: T0, completed_at: null,
    type: "background_task", task_id: taskId, task_type: "shell", name: "npm run dev", description: "npm run dev -- --port 3000",
    tool_item_id: toolItemId, can_stop: true, summary: null, duration_ms: null, ...overrides,
  };
}
