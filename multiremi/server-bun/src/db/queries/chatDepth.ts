/**
 * Chat depth queries — port of the Go chat handler's paged / pending read path:
 *   - ListChatMessagesPage           (keyset pagination, newest window first)
 *   - GetPendingChatTask             (most recent in-flight task for a session)
 *   - ListAttachmentsByChatMessageIDs (file-card metadata for chat bubbles)
 *
 * Session loading/authorization stays in src/db/queries/chat.ts
 * (getChatSessionInWorkspace) — these helpers key off a session id the route
 * has already resolved + authorized, mirroring how the Go handlers run every
 * query off the loaded session's primary key.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { agentTaskQueue, attachment, chatMessage } from "../schema.js";

export type ChatMessageRow = typeof chatMessage.$inferSelect;
export type AttachmentRow = typeof attachment.$inferSelect;

/** Keyset cursor: strictly-older-than this (created_at, id) pair. */
export interface ChatMessagesCursor {
  createdAt: string;
  id: string;
}

/**
 * In-flight statuses for a chat task — mirrors the Go GetPendingChatTask
 * predicate exactly: queued / dispatched / running / waiting_local_directory.
 */
const PENDING_CHAT_TASK_STATUSES = [
  "queued",
  "dispatched",
  "running",
  "waiting_local_directory",
] as const;

/**
 * One window of a session's transcript, newest first. Mirrors the Go
 * ListChatMessagesPage SQL: `(created_at, id) < (cursor)` row-value keyset so
 * messages sharing a timestamp page deterministically, ORDER BY created_at
 * DESC, id DESC. The caller passes limit+1 and uses the extra row as the
 * has_more probe (exactly like the Go handler).
 */
export async function listChatMessagesPage(
  db: Db,
  sessionId: string,
  limitPlusOne: number,
  before: ChatMessagesCursor | null,
): Promise<ChatMessageRow[]> {
  const conditions = [eq(chatMessage.chatSessionId, sessionId)];
  if (before) {
    // Raw row-value comparison — drizzle has no native (a, b) < (x, y). The
    // cursor strings are bound as parameters and cast server-side, so the
    // PG-text format we emit (microsecond precision) round-trips losslessly.
    conditions.push(
      sql`(${chatMessage.createdAt}, ${chatMessage.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
    );
  }
  return db
    .select()
    .from(chatMessage)
    .where(and(...conditions))
    .orderBy(desc(chatMessage.createdAt), desc(chatMessage.id))
    .limit(limitPlusOne);
}

/**
 * The most recent in-flight task for a chat session, if any. Mirrors Go
 * GetPendingChatTask — the frontend polls it on mount / session switch so the
 * StatusPill timer survives refresh (created_at is the elapsed-time anchor).
 */
export async function getPendingChatTask(
  db: Db,
  sessionId: string,
): Promise<{ id: string; status: string; createdAt: string } | null> {
  const [row] = await db
    .select({
      id: agentTaskQueue.id,
      status: agentTaskQueue.status,
      createdAt: agentTaskQueue.createdAt,
    })
    .from(agentTaskQueue)
    .where(
      and(
        eq(agentTaskQueue.chatSessionId, sessionId),
        inArray(agentTaskQueue.status, [...PENDING_CHAT_TASK_STATUSES]),
      ),
    )
    .orderBy(desc(agentTaskQueue.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Attachments linked to any of the given chat messages, oldest first, scoped
 * to the workspace (tenant guard). Mirrors Go ListAttachmentsByChatMessageIDs;
 * the route groups rows by chat_message_id to avoid an N+1 per bubble.
 */
export async function listAttachmentsByChatMessageIds(
  db: Db,
  wsId: string,
  messageIds: string[],
): Promise<AttachmentRow[]> {
  if (messageIds.length === 0) return [];
  return db
    .select()
    .from(attachment)
    .where(and(inArray(attachment.chatMessageId, messageIds), eq(attachment.workspaceId, wsId)))
    .orderBy(sql`${attachment.createdAt} ASC`);
}
