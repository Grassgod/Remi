import { z } from "zod";
import {
  isTraceItem,
  isTraceTimestamp,
  isTraceTurn,
  isTraceTurnPatch,
  type TraceEvent,
  type TraceItem,
  type TraceTurn,
  type TraceTurnPatch,
} from "@multiremi/contracts/trace";

export const TaskSteerMessageSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  authorType: z.string().default("user"),
  authorId: z.string().nullable().default(null),
  kind: z.enum(["steer", "force_answer"]),
  content: z.string(),
  createdAt: z.string(),
  consumedAt: z.string().nullable().default(null),
}).loose();

export type TaskSteerMessage = z.infer<typeof TaskSteerMessageSchema>;

export const TaskSteerResponseSchema = z.object({
  message: TaskSteerMessageSchema,
}).loose();

export type TaskSteerResponse = z.infer<typeof TaskSteerResponseSchema>;

export const TaskSteerListResponseSchema = z.object({
  messages: z.array(TaskSteerMessageSchema).default([]),
}).loose();

export type TaskSteerListResponse = z.infer<typeof TaskSteerListResponseSchema>;

export const EMPTY_TASK_STEER_LIST: TaskSteerListResponse = { messages: [] };

// ── Turn + items traces (PR 2) ──────────────────────────────────────────────
//
// The payload shapes live in `@multiremi/contracts/trace` with their runtime
// validators; these schemas wrap them so the trace endpoints and the trace
// socket parse through the same zod boundary as every other response.

const TraceTurnValue = z.custom<TraceTurn>(isTraceTurn, "invalid trace turn");
const TraceItemValue = z.custom<TraceItem>(isTraceItem, "invalid trace item");
const TraceTurnPatchValue = z.custom<TraceTurnPatch>(isTraceTurnPatch, "invalid trace turn patch");
const eventBase = {
  seq: z.number().int().positive(),
  ts: z.string().refine(isTraceTimestamp, "invalid trace timestamp"),
};

/**
 * One `trace:<attempt>` frame payload. A discriminated union on `type`: a frame
 * with an unknown type (a newer daemon) or a malformed body fails to parse and
 * the reader skips it, so one bad frame costs one event.
 */
export const TraceEventSchema = z.discriminatedUnion("type", [
  z.object({ ...eventBase, type: z.literal("turn.started"), turn: TraceTurnValue }).loose(),
  z.object({ ...eventBase, type: z.literal("turn.updated"), patch: TraceTurnPatchValue }).loose(),
  z.object({ ...eventBase, type: z.literal("turn.completed"), turn: TraceTurnValue }).loose(),
  z.object({ ...eventBase, type: z.literal("item.started"), item: TraceItemValue }).loose(),
  z.object({ ...eventBase, type: z.literal("item.updated"), item: TraceItemValue }).loose(),
  z.object({
    ...eventBase,
    type: z.literal("item.delta"),
    item_id: z.string().min(1),
    field: z.enum(["text", "output"]),
    delta: z.string(),
  }).loose(),
  z.object({ ...eventBase, type: z.literal("item.completed"), item: TraceItemValue }).loose(),
]);

/** Parse one socket payload; null for an unknown type or a malformed event. */
export function parseTraceEvent(payload: unknown): TraceEvent | null {
  const parsed = TraceEventSchema.safeParse(payload);
  return parsed.success ? (parsed.data as TraceEvent) : null;
}

/** The trace frames of one socket batch, in order, with unknown or bad ones skipped. */
export function parseTraceFrames(frames: readonly { kind: string; payload: unknown }[]): TraceEvent[] {
  const events: TraceEvent[] = [];
  for (const frame of frames) {
    if (frame.kind !== "trace") continue;
    const event = parseTraceEvent(frame.payload);
    if (event) events.push(event);
  }
  return events;
}

/** Items that fail the contract (a newer item type, a damaged row) are dropped one by one. */
const TraceItemListSchema = z.array(z.unknown()).transform(
  (items) => items.filter((item): item is TraceItem => isTraceItem(item)),
);

/**
 * `view=turn` page plus the read status every trace route adds. A read that is
 * not `ok` carries an empty page, so the page fields default. A v1 file answers
 * `format: "legacy"` with no turn and no items.
 */
export const TraceTurnPageSchema = z.object({
  view: z.literal("turn").default("turn"),
  format: z.enum(["v2", "legacy"]).default("v2"),
  turn: TraceTurnValue.nullable().default(null),
  items: TraceItemListSchema.default([]),
  next_item_cursor: z.number().int().nonnegative().nullable().default(null),
  head: z.number().int().nonnegative().default(0),
  closed: z.boolean().default(false),
  state: z.enum(["ok", "unreachable", "not_found", "lost"]),
  source: z.literal("daemon").nullable().optional(),
  turn_id: z.string().optional(),
  attempt_id: z.string().optional(),
  reason: z.string().optional(),
  retryable: z.boolean().optional(),
  runtime_id: z.string().optional(),
  runtime_name: z.string().nullable().optional(),
  last_seen_at: z.string().optional(),
}).loose();

export type TaskTraceRead = z.infer<typeof TraceTurnPageSchema>;
