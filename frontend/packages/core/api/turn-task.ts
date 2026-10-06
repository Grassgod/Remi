import type { z } from "zod";
import type { AgentTask } from "../types";
import type { TurnSchema, AttemptSchema } from "./schemas/messages";
const text = (value: unknown): string | null => typeof value === "string" ? value : null;
export function turnToTask(turn: z.infer<typeof TurnSchema>, attempt?: z.infer<typeof AttemptSchema>): AgentTask {
  const state = attempt && attempt.id !== turn.current_attempt_id ? attempt.status : turn.status;
  const status: AgentTask["status"] = state === "pending" || state === "offered" ? "queued"
    : state === "accepted" ? "dispatched" : state === "lost" ? "failed"
    : state === "completed" || state === "failed" || state === "cancelled" || state === "awaiting_human" || state === "waiting_local_directory" ? state : "running";
  return {
    id: attempt?.id ?? turn.current_attempt_id ?? turn.id, turn_id: turn.id,
    agent_id: turn.agent_id, issue_id: text(turn.issue_id) ?? "", issue_session_id: turn.session_id,
    chat_session_id: turn.session_id.startsWith("chat_") ? turn.session_id : undefined,
    runtime_id: text(attempt?.runtime_id), status, priority: typeof turn.priority === "number" ? turn.priority : 0,
    dispatched_at: text(attempt?.accepted_at), started_at: attempt?.started_at ?? turn.started_at,
    completed_at: attempt?.ended_at ?? turn.ended_at, created_at: turn.created_at,
    error: attempt?.error ?? null, result: null, attempt: attempt?.attempt_no,
    execution_model: attempt?.execution_model ?? null, execution_thinking_level: text(attempt?.execution_thinking_level),
    executionModel: attempt?.execution_model ?? null, executionThinkingLevel: attempt?.execution_thinking_level,
    usage: attempt?.usage, fallbackSwitched: attempt?.fallback_switched, switchReason: attempt?.switch_reason,
    progress_summary: text(attempt?.progress_summary), wait_reason: text(attempt?.wait_reason),
    prompt: text(turn.legacy_prompt) ?? undefined,
  };
}
