import { MessageSchema, TurnSchema } from "./schemas/messages";
export const messageFixture = (fields: Record<string, unknown> = {}) => MessageSchema.parse({
  session_id: "chat_1", seq: 5, id: "msg_1", revision: 0, kind: "message", body_md: "Follow up", body_html: null, render_version: null,
  sender_type: "member", sender_id: "member_1", to_type: "agent", to_ref: "agent_1", to_agent_id: "agent_1", to_member_id: null,
  message_kind: "request", wake_requested: "now", wake_applied: "next_turn", wake_reason: "agent_pair_not_privileged",
  reply_to_id: null, dedupe_key: null, options: null, created_at: "2026-10-04T00:00:00Z", ...fields,
});
export const turnFixture = (fields: Record<string, unknown> = {}) => TurnSchema.parse({
  id: "turn_1", session_id: "chat_1", seq: 6, agent_id: "agent_1", status: "running", current_attempt_id: "attempt_2",
  input_from_seq: 0, input_to_seq: 5, created_at: "2026-10-04T00:00:00Z", started_at: null, ended_at: null, ended_reason: null, ...fields,
});
