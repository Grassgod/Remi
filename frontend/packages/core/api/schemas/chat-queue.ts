import { z } from "zod";
import { MessageSchema } from "./messages";

/**
 * Chat follow-up queue (ADR 0020). A queued row lives outside the
 * conversation log until it is released as an ordinary member message.
 *
 * Display enums (`status`, `released_via`, the pause `reason`) stay strings so
 * a newer server still renders; consumers compare against known values.
 */
export const QueuedMessageAttachmentSchema = z.object({
  id: z.string(), filename: z.string(), content_type: z.string(), size: z.number().nonnegative(),
}).loose();

export const QueuedMessageSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  body_md: z.string(),
  attachments: z.array(QueuedMessageAttachmentSchema).default([]),
  client_id: z.string(),
  status: z.string(),
  error: z.string().nullable().default(null),
  revision: z.number().int().positive(),
  released_message_id: z.string().nullable().default(null),
  released_via: z.string().nullable().default(null),
  released_at: z.string().nullable().default(null),
  created_at: z.string(),
  updated_at: z.string(),
}).loose();

export const QueuePauseSchema = z.object({ reason: z.string(), at: z.string() }).loose();

export const SessionQueueSchema = z.object({
  items: z.array(QueuedMessageSchema),
  paused: QueuePauseSchema.nullable(),
});

/** The ordinary log message a released row became. */
export const QueuedMessageReleaseSchema = z.object({ message: MessageSchema, turn_id: z.string().optional() });

export const EnqueueQueuedMessageResponseSchema = z.object({
  item: QueuedMessageSchema, released: QueuedMessageReleaseSchema.nullable(),
});
export const QueuedMessageItemResponseSchema = z.object({ item: QueuedMessageSchema });
export const SteerQueuedMessageResponseSchema = QueuedMessageReleaseSchema.extend({ item: QueuedMessageSchema });
export const ResumeQueueResponseSchema = SessionQueueSchema.extend({ released: z.array(QueuedMessageReleaseSchema) });

/** `{error, code}` bodies of the queue routes; a failed steer also carries the row. */
export const QueueErrorBodySchema = z.object({
  error: z.string(), code: z.string(), item: QueuedMessageSchema.optional(),
}).loose();

export type QueuedMessageAttachment = z.infer<typeof QueuedMessageAttachmentSchema>;
export type QueuedChatMessage = z.infer<typeof QueuedMessageSchema>;
export type ChatQueuePause = z.infer<typeof QueuePauseSchema>;
export type ChatQueue = z.infer<typeof SessionQueueSchema>;
export type QueuedMessageRelease = z.infer<typeof QueuedMessageReleaseSchema>;
export type EnqueueQueuedMessageResponse = z.infer<typeof EnqueueQueuedMessageResponseSchema>;
export type SteerQueuedMessageResponse = z.infer<typeof SteerQueuedMessageResponseSchema>;
export type ResumeQueueResponse = z.infer<typeof ResumeQueueResponseSchema>;
