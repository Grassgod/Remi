import { z } from "zod";

export const SessionLogEntrySchema = z.object({
  session_id: z.string(), seq: z.number().int().nonnegative(), id: z.string(),
  revision: z.number().int().nonnegative(), kind: z.string(),
  visibility: z.enum(["shown", "hidden"]).default("shown"),
  author_type: z.string().default("system"), author_id: z.string().nullable().default(null),
  task_id: z.string().nullable().default(null), parent_id: z.string().nullable().default(null),
  body_md: z.string(), body_html: z.string().nullable(), render_version: z.string().nullable(),
  resolved_at: z.string().nullable().default(null),
  resolved_by_type: z.string().nullable().default(null), resolved_by_id: z.string().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
  created_at: z.string().default(""), updated_at: z.string().default(""),
  deleted_at: z.string().nullable().default(null),
});
export const SessionLogWindowSchema = z.object({
  entries: z.array(SessionLogEntrySchema), head_seq: z.number().int().nonnegative(),
  log_version: z.number().int().nonnegative(), has_more_before: z.boolean(), has_more_after: z.boolean(),
  before_visible_count: z.number().int().nonnegative().optional(),
  before_visible_count_capped: z.boolean().optional(),
});
export const SessionLogLocationSchema = z.object({ id: z.string(), seq: z.number().int().nonnegative(), head_seq: z.number().int().nonnegative() });
export type SessionLogRow = z.infer<typeof SessionLogEntrySchema>;
export type SessionLogWindow = z.infer<typeof SessionLogWindowSchema>;
export type LogWindowParams = { anchor?: number; before?: number; after?: number };

export interface IssueLogBootstrap {
  sessionId: string;
  window: SessionLogWindow;
  head: SessionLogRow | null;
  targetCommentId?: string;
  /** locate returned 404; this bootstrap already contains the fallback tail. */
  missingCommentId?: string;
}
