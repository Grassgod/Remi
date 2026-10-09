import { z } from "zod";
export const IssueResponsibilityMigrationSchema = z.object({
  workspaceId: z.string(), total: z.number().int().nonnegative(), rootCount: z.number().int().nonnegative(), legacyMemberExecutionCount: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative().nullable(),
  items: z.array(z.object({ issueId: z.string(), key: z.string(), title: z.string(), responsibleMemberId: z.string().nullable(), revision: z.string(), assigneeType: z.string().nullable(), assigneeId: z.string().nullable(), createdById: z.string().nullable(),
    unresolved: z.array(z.object({ issueId: z.string(), reason: z.string() })), candidates: z.array(z.object({ memberId: z.string(), name: z.string(), source: z.string(), available: z.boolean() })) })),
});

export const ResponsibilityActorSchema = z.object({ type: z.string(), id: z.string(), issueId: z.string(), name: z.string() });
export const IssueResponsibilitySchema = z.object({
  issueId: z.string(), workspaceId: z.string().nullable(), executionOwner: ResponsibilityActorSchema.nullable(),
  reviewOwner: ResponsibilityActorSchema.nullable(), rootHuman: ResponsibilityActorSchema.nullable(),
  rootIssueId: z.string().nullable(), chain: z.array(z.unknown()),
  unresolved: z.array(z.object({ issueId: z.string(), reason: z.string() })), revision: z.string(),
});
export const IssueDeliverySchema = z.object({
  id: z.string(), issueId: z.string(), sourceSessionId: z.string(), summary: z.string(), status: z.string(),
  submittedBy: ResponsibilityActorSchema, reviewOwner: ResponsibilityActorSchema,
  reviewUnavailableReason: z.string().nullable().optional(),
  isLatest: z.boolean().optional(), invalidatedAt: z.string().optional(), invalidatedReason: z.string().optional(),
  responsibilityRevision: z.string(), responseMessageId: z.string().nullable(), createdAt: z.string(), respondedAt: z.string().nullable(),
  responseBody: z.string().nullable().optional(),
  authorization: z.object({ agentId: z.string(), grantedBy: z.string(), responsibilityRevision: z.string(), grantedAt: z.string() }).nullable().optional(),
}).loose();
const HandlerSchema = z.object({ type: z.string(), id: z.string() });
const AnswerSchema = z.object({ response: z.record(z.string(), z.unknown()), body_md: z.string(), actor: HandlerSchema, at: z.string(), reply_message_id: z.string() });
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
export type IssueResponsibilityView = z.infer<typeof IssueResponsibilitySchema>;
export type IssueDeliveryView = z.infer<typeof IssueDeliverySchema>;
