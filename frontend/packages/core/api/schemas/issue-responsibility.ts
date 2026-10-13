import { z } from "zod";
const HandlerSchema = z.object({ type: z.string(), id: z.string() });
const AnswerSchema = z.object({ response: z.record(z.string(), z.unknown()), body_md: z.string(), actor: HandlerSchema, at: z.string(), reply_message_id: z.string() });
/** An Issue Q at `stage: "human"` names nobody (`current_handler: null`); `actions.allowed` says what this viewer may do. */
export const QuestionViewSchema = z.object({
  kind: z.string(),
  id: z.string(), session_id: z.string(), workspace_id: z.string(), source_issue_id: z.string().nullable(),
  source_agent_id: z.string().nullable(), source_turn_id: z.string().nullable(), source_attempt_id: z.string().nullable(),
  original_questions: z.array(z.unknown()), original_message: z.string(),
  original_context: z.object({ text: z.string(), truncated: z.boolean().optional() }).nullable().optional(),
  options: z.array(z.object({ label: z.string(), value: z.string() })).nullable(),
  summary: z.object({ body_md: z.string(), agent_id: z.string(), at: z.string() }).nullable(),
  current_handler: HandlerSchema.nullable(), stage: z.string(), route_revision: z.number().int().nonnegative(),
  route_reason: z.string().nullable().optional(),
  status: z.string(), answer_revision: z.number().int().nonnegative(), wait_status: z.string(), wait_reason: z.string().nullable(), answer: AnswerSchema.nullable(),
  recovery: z.object({ consumer_turn_id: z.string().nullable(), consumer_attempt_id: z.string().nullable(), reply_message_id: z.string().nullable(), continuation_message_id: z.string().nullable(), consumed_at: z.string().nullable() }).optional(),
  history: z.array(z.object({ type: z.string(), at: z.string(), actor: HandlerSchema.nullable(), route_revision: z.number(),
    reason: z.string().optional(), handler: HandlerSchema.nullable().optional(), answer: z.unknown().optional(),
    overturn: z.string().nullable().optional(),
    source_message_id: z.string().optional(), source_session_id: z.string().optional(),
  }).loose()), actions: z.object({ allowed: z.array(z.string()) }),
}).loose();
export type QuestionView = z.infer<typeof QuestionViewSchema>;
