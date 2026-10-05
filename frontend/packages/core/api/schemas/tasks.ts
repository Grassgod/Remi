import { z } from "zod";

/** Native task detail mapped to the existing transcript view model. */
export const TaskDetailResponseSchema = z.object({
  task: z.object({
    id: z.string(), agentId: z.string(), runtimeId: z.string().nullable(),
    issueId: z.string().nullable(), chatSessionId: z.string().nullable().optional(),
    status: z.enum(["queued", "dispatched", "running", "waiting_local_directory", "awaiting_human", "completed", "failed", "cancelled"]),
    priority: z.number(), prompt: z.string().optional(),
    createdAt: z.string(), dispatchedAt: z.string().nullable(), startedAt: z.string().nullable(), completedAt: z.string().nullable(),
    result: z.unknown(), error: z.string().nullable(),
    agent: z.object({ name: z.string() }).loose().nullable().optional(),
    usage: z.array(z.object({
      provider: z.string().optional(), model: z.string().optional(), inputTokens: z.number().optional(),
      outputTokens: z.number().optional(), totalTokens: z.number().optional(),
      cacheReadTokens: z.number().optional(), cacheWriteTokens: z.number().optional(),
    })).optional(),
    executionModel: z.string().nullable().optional(), executionThinkingLevel: z.string().nullable().optional(),
    fallbackSwitched: z.boolean().optional(), switchReason: z.string().nullable().optional(),
  }).loose(),
}).transform(({ task }) => ({
  id: task.id, agent_id: task.agentId, runtime_id: task.runtimeId, issue_id: task.issueId ?? "",
  chat_session_id: task.chatSessionId ?? undefined, status: task.status, priority: task.priority,
  prompt: task.prompt, created_at: task.createdAt, dispatched_at: task.dispatchedAt,
  started_at: task.startedAt, completed_at: task.completedAt, result: task.result, error: task.error,
  usage: task.usage, executionModel: task.executionModel, executionThinkingLevel: task.executionThinkingLevel,
  fallbackSwitched: task.fallbackSwitched, switchReason: task.switchReason, agent_name: task.agent?.name,
}));

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
