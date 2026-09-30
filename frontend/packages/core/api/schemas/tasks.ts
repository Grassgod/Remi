import { z } from "zod";

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

export const TraceEventSchema = z.object({
  seq: z.number().int().positive(),
  ts: z.string(),
  type: z.string(),
  tool: z.string().nullable().optional(),
  content: z.string().nullable().optional(),
  input: z.record(z.string(), z.unknown()).nullable().optional(),
  output: z.string().nullable().optional(),
  tool_call_id: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  meta: z.record(z.string(), z.unknown()).nullable().optional(),
}).loose();

export const TaskTraceReadSchema = z.object({
  events: z.array(TraceEventSchema),
  next_after_seq: z.number().int().nonnegative(),
  head: z.number().int().nonnegative(),
  eof: z.boolean(),
  closed: z.boolean(),
  source: z.enum(["daemon", "archive"]).nullable(),
  state: z.enum(["ok", "unreachable", "not_found", "backfilling", "lost"]),
  reason: z.string().optional(),
  retryable: z.boolean().optional(),
  runtime_id: z.string().optional(),
  runtime_name: z.string().optional(),
  last_seen_at: z.string().optional(),
}).loose();

export type TaskTraceRead = z.infer<typeof TaskTraceReadSchema>;
