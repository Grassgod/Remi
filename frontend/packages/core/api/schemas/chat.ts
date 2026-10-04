import { z } from "zod";

export const ChatSessionSchema = z.object({
  id: z.string(), workspace_id: z.string(), creator_id: z.string(), agent_id: z.string(),
  project_id: z.string().nullable().optional(),
  title: z.string(), status: z.string(), has_unread: z.boolean().default(false),
  pinned: z.boolean().default(false), unread_count: z.number().int().nonnegative().default(0),
  last_message: z.object({ content: z.string(), role: z.string(), created_at: z.string() }).nullable().default(null),
  runtime_workspace_id: z.string().nullable().optional(),
  created_at: z.string(), updated_at: z.string(),
}).loose();
export const ChatSessionListSchema = z.array(ChatSessionSchema);
/** An update must explicitly confirm pin state; a read default cannot acknowledge an unpin. */
export const ChatSessionUpdateResponseSchema = ChatSessionSchema.extend({ pinned: z.boolean() });

/** Mutations returning 204 must not treat an unexpected JSON body as success. */
export const ChatNoContentSchema = z.undefined();
