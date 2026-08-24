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
