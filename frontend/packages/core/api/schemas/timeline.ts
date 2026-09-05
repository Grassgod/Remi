import { z } from "zod";
import type { TimelineEntry, TimelinePage } from "../../types";
import { AttachmentSchema, ReactionSchema } from "./primitives";

// All object schemas use `.loose()` so unknown server-side fields pass
// through unchanged. zod 4's `.object()` defaults to STRIP, which would
// silently drop new fields and surface as a "field neither showed up in
// the UI" mystery the next time the TS type adopted them but the schema
// wasn't updated in lock-step. `.loose()` removes that synchronisation
// hazard — the schema validates the shape it knows about and leaves the
// rest alone.
export const TimelineEntrySchema = z.object({
  type: z.string(),
  id: z.string(),
  actor_type: z.string(),
  // System activities (issue_assigned, issue_updated, …) come back with
  // actor_id: null. A single null used to fail the whole array and blank the
  // activity feed via the fallback — normalize to "" instead.
  actor_id: z.preprocess((value) => value ?? "", z.string()),
  // Agent auto-reply comments only; null/absent everywhere else.
  task_id: z.string().nullable().optional(),
  created_at: z.string(),
  action: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  content: z.string().optional(),
  parent_id: z.string().nullable().optional(),
  updated_at: z.string().optional(),
  comment_type: z.string().optional(),
  reactions: z.array(ReactionSchema).optional(),
  attachments: z.array(AttachmentSchema).optional(),
  coalesced_count: z.number().optional(),
}).loose();

// The no-parameter compatibility endpoint still returns this legacy shape.
export const TimelineEntriesSchema = z.array(TimelineEntrySchema);

export const TimelinePageSchema = z.object({
  entries: TimelineEntriesSchema,
  limit: z.number().int().positive().default(40),
  has_more: z.boolean().default(false),
  has_more_before: z.boolean().default(false),
  has_more_after: z.boolean().default(false),
  next_cursor: z.string().nullable().optional(),
  prev_cursor: z.string().nullable().optional(),
  issue_session_id: z.string().nullable(),
  target_index: z.number().int().nonnegative().optional(),
}).loose();

export const EMPTY_TIMELINE_ENTRIES: TimelineEntry[] = [];

export const EMPTY_TIMELINE_PAGE: TimelinePage = {
  entries: [],
  limit: 40,
  has_more: false,
  has_more_before: false,
  has_more_after: false,
  next_cursor: null,
  prev_cursor: null,
  issue_session_id: null,
};
