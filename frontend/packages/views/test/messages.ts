import { MessageSchema, TurnSchema, AttemptSchema } from "@multiremi/core/api/schemas";
export const messageFixture = (fields: Record<string, unknown> = {}) => MessageSchema.parse({
  session_id: "sess_1", seq: 5, id: "msg_1", revision: 0, kind: "message", body_md: "Follow up", body_html: null, render_version: null,
  sender_type: "agent", sender_id: "agent_1", to_type: "member", to_ref: "member_1", to_agent_id: null, to_member_id: "member_1",
  message_kind: "report", wake_requested: "now", wake_applied: "inbox_only", wake_reason: "no_recipient", reply_to_id: null, dedupe_key: null, options: null,
  created_at: "2026-10-04T00:00:00Z", ...fields,
});
export const turnFixture = (fields: Record<string, unknown> = {}) => TurnSchema.parse({
  id: "turn_1", session_id: "sess_1", seq: 6, agent_id: "agent_1", status: "failed", current_attempt_id: "attempt_2", input_from_seq: 0,
  input_to_seq: 5, created_at: "2026-10-04T00:00:00Z", started_at: null, ended_at: null, ended_reason: null, ...fields,
});
export const attemptFixture = (fields: Record<string, unknown> = {}) => AttemptSchema.parse({
  id: "attempt_1", turn_id: "turn_1", attempt_no: 1, status: "failed", provider: "codex", execution_model: "test-model",
  started_at: null, ended_at: null, error: null, ...fields,
});
