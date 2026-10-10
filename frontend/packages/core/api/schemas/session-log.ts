import { z } from "zod";

export const MessageTriggerSourceSchema = z.object({
  actor_type: z.string(), actor_id: z.string().nullable(), actor_name: z.string().nullable(),
  message_id: z.string(), session_id: z.string(), issue_id: z.string().nullable(),
  issue_key: z.string().nullable(), parent_issue_key: z.string().nullable().optional(), parent_issue: z.boolean(),
});

export const SessionLogEntrySchema = z.object({
  session_id: z.string(), seq: z.number().int().nonnegative(), id: z.string(),
  revision: z.number().int().nonnegative(), kind: z.string(),
  visibility: z.enum(["shown", "hidden"]).default("shown"),
  author_type: z.string().default("system"), author_id: z.string().nullable().default(null),
  task_id: z.string().nullable().default(null), parent_id: z.string().nullable().default(null),
  body_md: z.string(), body_html: z.string().nullable(), render_version: z.string().nullable(),
  resolved_at: z.string().nullable().default(null),
  resolved_by_type: z.string().nullable().default(null), resolved_by_id: z.string().nullable().default(null),
  trigger_source: z.preprocess(value => MessageTriggerSourceSchema.safeParse(value).success ? value : null, MessageTriggerSourceSchema.nullable()).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  created_at: z.string().default(""), updated_at: z.string().default(""),
  sender_type: z.string().nullish(), sender_id: z.string().nullable().optional(),
  to_type: z.string().nullish(), to_ref: z.string().nullable().optional(),
  to_agent_id: z.string().nullable().optional(), to_member_id: z.string().nullable().optional(),
  message_kind: z.string().nullish(), wake_applied: z.string().nullish(), wake_reason: z.string().nullish(),
  reply_to_id: z.string().nullable().optional(), dedupe_key: z.string().nullish(),
  options: z.preprocess(value => {
    if (typeof value !== "string") return value;
    try { return JSON.parse(value); } catch { return value; }
  }, z.array(z.object({ label: z.string(), value: z.string(), description: z.string().optional() })).nullable().optional()),
  deleted_at: z.string().nullable().default(null),
});
export const IssueActivityEntrySchema = z.object({
  type: z.literal("activity"), id: z.string(), actor_type: z.string(),
  actor_id: z.string().nullable(), created_at: z.string(), action: z.string(),
  details: z.record(z.string(), z.unknown()).nullable(),
});
export const SessionLogWindowSchema = z.object({
  entries: z.array(SessionLogEntrySchema), head_seq: z.number().int().nonnegative(),
  log_version: z.number().int().nonnegative(), has_more_before: z.boolean(), has_more_after: z.boolean(),
  before_visible_count: z.number().int().nonnegative().optional(),
  before_visible_count_capped: z.boolean().optional(),
  prev_entry_created_at: z.string().nullable().optional(),
  activities: z.array(IssueActivityEntrySchema).optional(),
  activities_truncated: z.boolean().optional(),
});
export const SessionLogLocationSchema = z.object({ id: z.string(), seq: z.number().int().nonnegative(), head_seq: z.number().int().nonnegative() });
export type SessionLogRow = z.infer<typeof SessionLogEntrySchema>;
export type SessionLogWindow = z.infer<typeof SessionLogWindowSchema>;
export type LogWindowParams = { anchor?: number; before?: number; after?: number; with_activity?: 1 };

export interface IssueLogBootstrap {
  sessionId: string;
  window: SessionLogWindow;
  head: SessionLogRow | null;
  targetCommentId?: string;
  /** locate returned 404; this bootstrap already contains the fallback tail. */
  missingCommentId?: string;
}
