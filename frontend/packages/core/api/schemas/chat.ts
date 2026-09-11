import { z } from "zod";

export const ChatSessionSchema = z.object({
  id: z.string(), workspace_id: z.string(), creator_id: z.string(), agent_id: z.string(),
  title: z.string(), status: z.string(), has_unread: z.boolean().default(false),
  pinned: z.boolean().default(false), unread_count: z.number().int().nonnegative().default(0),
  last_message: z.object({ content: z.string(), role: z.string(), created_at: z.string() }).nullable().default(null),
  created_at: z.string(), updated_at: z.string(),
}).loose();
export const ChatSessionListSchema = z.array(ChatSessionSchema);
/** An update must explicitly confirm pin state; a read default cannot acknowledge an unpin. */
export const ChatSessionUpdateResponseSchema = ChatSessionSchema.extend({ pinned: z.boolean() });

export const ChatQueuedTaskSchema = z.object({
  task_id: z.string().min(1),
  content: z.string(),
  attachment_ids: z.array(z.string()),
  created_at: z.string(),
}).loose();

export const ChatPendingTaskSchema = z.object({
  task_id: z.string().min(1).optional(),
  status: z.string().optional(),
  created_at: z.string().optional(),
  supports_queue: z.literal(true),
  queued_tasks: z.array(ChatQueuedTaskSchema),
}).loose().refine(data => data.task_id
  ? data.status !== undefined && data.created_at !== undefined
  : data.status === undefined && data.created_at === undefined,
{ message: "Pending head fields must be present together" });

export const SendChatMessageResponseSchema = z.object({
  message_id: z.string().min(1),
  task_id: z.string().min(1),
  created_at: z.string(),
  supports_queue: z.literal(true),
  queued: z.boolean(),
}).loose();

export const PrioritizeChatQueuedTaskResponseSchema = z.object({
  task_id: z.string().min(1),
  active_task_id: z.string().nullable(),
}).loose();

export const PendingChatTasksResponseSchema = z.object({
  tasks: z.array(z.object({
    task_id: z.string(), status: z.string(), chat_session_id: z.string(),
  }).loose()),
}).loose();

/** Mutations returning 204 must not treat an unexpected JSON body as success. */
export const ChatNoContentSchema = z.undefined();

export const ChatCancelledTaskSchema = z.object({ id: z.string().min(1), status: z.literal("cancelled") }).loose();
