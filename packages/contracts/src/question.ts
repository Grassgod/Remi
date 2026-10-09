import type { DecisionOption } from './unified-model.js';

export interface QuestionActor { type: 'agent' | 'member'; id: string }
export type QuestionStage = 'issue_owner' | 'parent_owner' | 'human' | 'unavailable';
export type QuestionWaitStatus = 'waiting' | 'detached' | 'consumed' | 'continuation_pending' | 'continuation_consumed' | 'none';
export type QuestionAction = 'answer' | 'escalate' | 'transfer' | 'present' | 'revise' | 'continue' | 'close';
export interface QuestionAnswer {
  response: Record<string, unknown>;
  body_md: string;
  actor: QuestionActor;
  at: string;
  reply_message_id: string;
}
export interface QuestionHistoryEvent {
  type: 'created' | 'escalate' | 'transfer' | 'present' | 'answer' | 'revise' | 'detach' | 'continue' | 'consume' | 'close' | 'notify';
  at: string;
  actor: QuestionActor | null;
  route_revision: number;
  reason?: string;
  overturn?: string | null;
  handler?: QuestionActor | null;
  answer?: QuestionAnswer;
  source_message_id?: string;
  source_session_id?: string;
}
/** Projection of one original decision message. Notifications never create a second Q. */
export interface QuestionView {
  id: string;
  kind: 'question' | 'permission' | 'decision';
  session_id: string;
  workspace_id: string;
  source_issue_id: string | null;
  source_agent_id: string | null;
  source_turn_id: string | null;
  source_attempt_id: string | null;
  original_questions: unknown[];
  original_message: string;
  original_context: { text: string; truncated?: boolean } | null;
  options: DecisionOption[] | null;
  summary: { body_md: string; agent_id: string; at: string } | null;
  current_handler: QuestionActor | null;
  stage: QuestionStage;
  route_revision: number;
  route_reason: string | null;
  status: 'pending' | 'answered' | 'closed';
  wait_status: QuestionWaitStatus;
  wait_reason: string | null;
  /** Auditable execution references; native callback nonces are never public. */
  recovery: { consumer_turn_id: string | null; consumer_attempt_id: string | null; reply_message_id: string | null;
    continuation_message_id: string | null; consumed_at: string | null };
  answer: QuestionAnswer | null;
  answer_revision: number;
  history: QuestionHistoryEvent[];
  actions: { allowed: QuestionAction[] };
}
export interface QuestionMutationInput { expected_route_revision: number; reason?: string }
export interface QuestionAnswerInput extends QuestionMutationInput {
  response: Record<string, unknown>;
  body_md?: string;
  revise?: boolean;
  expected_answer_revision?: number;
}
