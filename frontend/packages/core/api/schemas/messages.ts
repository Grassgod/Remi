import { z } from "zod";
import { SessionLogEntrySchema } from "./session-log";
export const MessageAttachmentSchema = z.object({
  id: z.string(), workspaceId: z.string(), issueId: z.string().nullable(), commentId: z.string().nullable(),
  chatSessionId: z.string().nullable(), chatMessageId: z.string().nullable(), uploaderType: z.string(), uploaderId: z.string(),
  filename: z.string(), url: z.string(), contentType: z.string(), sizeBytes: z.number().nonnegative(), createdAt: z.string(),
}).transform(a => ({ id: a.id, workspace_id: a.workspaceId, issue_id: a.issueId, comment_id: a.commentId,
  chat_session_id: a.chatSessionId, chat_message_id: a.chatMessageId, uploader_type: a.uploaderType, uploader_id: a.uploaderId,
  filename: a.filename, url: a.url, download_url: `/api/attachments/${encodeURIComponent(a.id)}/file`, content_type: a.contentType,
  size_bytes: a.sizeBytes, created_at: a.createdAt }));
export const MessageReactionSchema = z.object({ id: z.string(), commentId: z.string(), actorType: z.string(), actorId: z.string(), emoji: z.string(), createdAt: z.string() })
  .transform(r => ({ id: r.id, comment_id: r.commentId, actor_type: r.actorType, actor_id: r.actorId, emoji: r.emoji, created_at: r.createdAt }));

// Display enums remain strings so a newer server can still be rendered.
export const MessageSchema = SessionLogEntrySchema.extend({
  kind: z.literal("message"), sender_type: z.string(), sender_id: z.string().nullable(),
  to_type: z.string(), to_ref: z.string().nullable(),
  to_agent_id: z.string().nullable(), to_member_id: z.string().nullable(),
  message_kind: z.string(), wake_requested: z.string(), wake_applied: z.string(), wake_reason: z.string(),
  reply_to_id: z.string().nullable(), dedupe_key: z.string().nullable(),
  options: z.array(z.object({ label: z.string(), value: z.string(), description: z.string().optional() })).nullable(),
  attachments: z.array(MessageAttachmentSchema).default([]), reactions: z.array(MessageReactionSchema).default([]),
});
export const MessageResponseSchema = z.object({ message: MessageSchema });
export const MessagesPageSchema = z.object({ messages: z.array(MessageSchema), next_cursor: z.string().nullable() });
export const SendMessageResponseSchema = MessageResponseSchema.extend({
  wake_applied: z.string(), wake_reason: z.string(), turn_id: z.string().optional(),
});
export const MessageInboxSchema = z.object({
  items: z.array(MessageSchema), unread_count: z.number().int().nonnegative(),
  attention_count: z.number().int().nonnegative(), next_cursor: z.string().nullable(),
});
export const ReadInboxSchema = z.object({ session_id: z.string(), cursor_seq: z.number().int().nonnegative() });
export const ReadAllInboxSchema = z.object({ conversations_read: z.number().int().nonnegative() });
export type Message = z.infer<typeof MessageSchema>;
export type MessageInboxPage = z.infer<typeof MessageInboxSchema>;
export interface SendMessageBody {
  body_md: string;
  message_kind?: "request" | "reply" | "report" | "decision" | "status" | "final";
  to?: { type: "none" } | { type: "agent" | "member" | "role"; ref: string };
  wake_requested?: "now" | "next_turn" | "inbox_only";
  reply_to_id?: string;
  dedupe_key?: string;
  attachment_ids?: string[];
  metadata?: Record<string, unknown>;
  response?: Record<string, unknown>;
}
export const TurnSchema = z.object({
  id: z.string(), session_id: z.string(), seq: z.number().int().nonnegative(), agent_id: z.string(),
  status: z.string(), current_attempt_id: z.string().nullable(),
  input_from_seq: z.number().nullable(), input_to_seq: z.number().nullable(),
  created_at: z.string(), started_at: z.string().nullable(), ended_at: z.string().nullable(),
  ended_reason: z.string().nullable(),
}).loose();
export const AttemptSchema = z.object({
  id: z.string(), turn_id: z.string(), attempt_no: z.number().int().positive(), status: z.string(),
  provider: z.string().nullable(), execution_model: z.string().nullable(),
  started_at: z.string().nullable(), ended_at: z.string().nullable(), error: z.string().nullable(),
}).loose();
export const TurnInputSchema = z.object({ from_seq: z.number().int().nonnegative(), to_seq: z.number().int().nonnegative(), messages: z.array(MessageSchema), legacy_prompt: z.string().nullable() });
export const TurnDetailSchema = z.object({ turn: TurnSchema, attempts: z.array(AttemptSchema).optional(), input: TurnInputSchema.optional() });
export const TurnsPageSchema = z.object({ turns: z.array(TurnSchema), next_cursor: z.string().nullable() });
