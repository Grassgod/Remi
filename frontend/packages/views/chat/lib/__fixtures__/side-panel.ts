import type { SessionLogEntry } from "@multiremi/core/replica";
import { at } from "../../../test/trace-fixtures";

// Chat log rows (what `GET /api/sessions/:id/log` answers) for the side panel
// tests: member messages carry the turn they were delivered into, turn cards
// carry the completion facts the daemon reported (`type_histogram`,
// `late_subagents`), as the harness and the server tests write them.

export type LogRow = SessionLogEntry & {
  author_type?: string;
  sender_type?: string;
  task_id?: string | null;
  created_at?: string;
  metadata?: Record<string, unknown>;
};

let seq = 0;

function row(kind: string, fields: Partial<LogRow>): LogRow {
  seq += 1;
  return {
    session_id: "chat_1", seq, id: `row_${seq}`, revision: 1, kind, body_html: null, render_version: null, body_md: "",
    ...fields,
  };
}

export function memberMessage(turnId: string, body: string, seconds = 0): LogRow {
  return row("message", { author_type: "member", sender_type: "member", body_md: body, created_at: at(seconds),
    metadata: { delivery_turn_id: turnId } });
}

export function turnCard(attemptId: string, turnId: string, metadata: Record<string, unknown> = {}, seconds = 0): LogRow {
  return row("turn", { author_type: "agent", task_id: attemptId, created_at: at(seconds),
    metadata: { status: "completed", turn_id: turnId, current_attempt_id: attemptId, type_histogram: [], late_subagents: null, ...metadata } });
}

export const histogram = (...types: string[]) => types.map((type) => ({ type, tool: null, count: 1 }));

export function doorbell(taskId: string): LogRow {
  return row("message", { author_type: "system", sender_type: "platform", body_md: "", metadata: { background_task: {
    task_id: taskId, name: "npm test", task_type: "shell", status: "completed",
    origin_attempt_id: "att_1", origin_turn_id: "turn_1", provider_session_id: "ps_1",
  } } });
}

/**
 * Four turns: two ran subagents (one by its histogram, one only by its late
 * completions), one ran commands only, and one started a background task.
 */
export function chatLogWithSubagents(): LogRow[] {
  return [
    memberMessage("turn_1", "**Find** the trace readers\nand list them", 0),
    turnCard("att_1", "turn_1", { type_histogram: histogram("user_message", "subagent", "command", "agent_message") }, 1),
    memberMessage("turn_2", "Run the tests", 60),
    turnCard("att_2", "turn_2", { type_histogram: histogram("command", "background_task") }, 61),
    turnCard("att_3", "turn_3", { legacy_prompt: "Review the `diff`", late_subagents: [{ item_id: "sa:r", name: "Review", status: "completed", duration_ms: 1000 }] }, 120),
    memberMessage("turn_4", "Just answer", 180),
    turnCard("att_4", "turn_4", { type_histogram: histogram("agent_message") }, 181),
  ];
}
