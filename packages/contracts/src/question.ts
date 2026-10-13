import type { DecisionOption } from './unified-model.js';

/** Historical IssueDecision records carry an Issue identity; ordinary choices only carry status. */
export function isHistoricalIssueQuestionRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return [record.source_issue_id, record.issue_id].some(id => typeof id === 'string' && id.trim().length > 0);
}

export interface QuestionActor { type: 'agent' | 'member'; id: string }
/**
 * Issue Qs climb the execution-owner chain, then reach `human`. That Issue human
 * stage names nobody: any active real member of the frozen source workspace acts.
 * Chat Qs without an Issue keep one explicit member at `human`.
 */
export type QuestionStage = 'issue_owner' | 'parent_owner' | 'human' | 'unavailable';
export type QuestionWaitStatus = 'waiting' | 'detached' | 'consumed' | 'continuation_pending' | 'continuation_consumed' | 'none';
/** Responsibility changes re-route a Q automatically; there is no explicit transfer action. */
export type QuestionAction = 'answer' | 'escalate' | 'present' | 'revise' | 'continue' | 'close';
export interface QuestionAnswer {
  response: Record<string, unknown>;
  body_md: string;
  actor: QuestionActor;
  at: string;
  reply_message_id: string;
}
export interface QuestionHistoryEvent {
  /** `transfer` records a system re-route after responsibility facts changed. */
  type: 'created' | 'escalate' | 'transfer' | 'present' | 'answer' | 'revise' | 'detach' | 'continue' | 'consume' | 'close' | 'notify';
  at: string;
  actor: QuestionActor | null;
  route_revision: number;
  reason?: string;
  overturn?: string | null;
  /** Null when the step is the Issue human stage, which names no member. */
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
  /** Null at the Issue `human` stage (any active member acts) and when `stage` is `unavailable`. */
  current_handler: QuestionActor | null;
  stage: QuestionStage;
  route_revision: number;
  /**
   * Why an Issue Q reached `human` before the chain's root, as comma-joined
   * `<issueId>:<IssueResponsibilityFailure>` entries; `source_workspace_changed`
   * freezes the Q. Historical rows may keep older free-form values.
   */
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
