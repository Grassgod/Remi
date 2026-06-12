/**
 * Chat queries — port of the Go chat handler's read path:
 *   - ListChatSessionsByCreator  (active sessions the user created, + has_unread)
 *   - GetChatSessionInWorkspace  (workspace-scoped session loader)
 *   - ListChatMessages           (messages for a session, chronological)
 *
 * Chat sessions are private to their creator: the "user as participant" gate is
 * `creator_id = <user>` within the workspace (mirrors the Go handler, which keys
 * the session list and the transcript off the JWT user's id, not membership).
 */

import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { chatMessage, chatSession } from "../schema.js";

export type ChatSession = typeof chatSession.$inferSelect;
export type ChatMessage = typeof chatMessage.$inferSelect;
export type NewChatSession = typeof chatSession.$inferInsert;

/** A list row carries the derived `hasUnread` flag (unread_since IS NOT NULL). */
export type ChatSessionListRow = ChatSession & { hasUnread: boolean };

/**
 * Active chat sessions the user created in this workspace, newest-touched first.
 * Mirrors Go ListChatSessionsByCreator: status='active', ordered by updated_at
 * DESC, with the per-session `has_unread` boolean derived from unread_since.
 */
export async function listChatSessionsByCreator(
  db: Db,
  wsId: string,
  creatorId: string,
): Promise<ChatSessionListRow[]> {
  const rows = await db
    .select()
    .from(chatSession)
    .where(
      and(
        eq(chatSession.workspaceId, wsId),
        eq(chatSession.creatorId, creatorId),
        eq(chatSession.status, "active"),
      ),
    )
    .orderBy(desc(chatSession.updatedAt));
  return rows.map((s) => ({ ...s, hasUnread: s.unreadSince !== null }));
}

/**
 * Load a chat session by id within a workspace (multi-tenancy guard). Mirrors
 * Go GetChatSessionInWorkspace. The ownership check (creator_id == user) is
 * applied by the route, mirroring loadChatSessionForUser.
 */
export async function getChatSessionInWorkspace(
  db: Db,
  wsId: string,
  sessionId: string,
): Promise<ChatSession | null> {
  const [s] = await db
    .select()
    .from(chatSession)
    .where(and(eq(chatSession.id, sessionId), eq(chatSession.workspaceId, wsId)));
  return s ?? null;
}

/**
 * All messages in a session, oldest first. Mirrors Go ListChatMessages
 * (ORDER BY created_at ASC). The caller resolves + authorizes the session id
 * first, so this keys off the trusted primary key.
 */
export async function listChatMessages(db: Db, sessionId: string): Promise<ChatMessage[]> {
  return db
    .select()
    .from(chatMessage)
    .where(eq(chatMessage.chatSessionId, sessionId))
    .orderBy(asc(chatMessage.createdAt));
}

// ── Write path ──────────────────────────────────────────────────────────────

/** Create a chat session. */
export async function createChatSession(db: Db, input: NewChatSession): Promise<ChatSession> {
  const [s] = await db.insert(chatSession).values(input).returning();
  return s!;
}

/** Append a message to a session. role ∈ {user, assistant}. */
export async function createChatMessage(
  db: Db,
  input: { chatSessionId: string; role: "user" | "assistant"; content: string; taskId?: string | null },
): Promise<ChatMessage> {
  const [m] = await db.insert(chatMessage).values(input).returning();
  return m!;
}

/** Patch a session's title/status (caller authorizes ownership first). */
export async function updateChatSession(
  db: Db,
  id: string,
  fields: { title?: string; status?: string },
): Promise<ChatSession | null> {
  const [s] = await db
    .update(chatSession)
    .set({ ...fields, updatedAt: sql`now()` })
    .where(eq(chatSession.id, id))
    .returning();
  return s ?? null;
}

/** Bump updated_at and mark unread (an assistant turn is pending). */
export async function touchChatSessionUnread(db: Db, id: string): Promise<void> {
  await db.update(chatSession).set({ updatedAt: sql`now()`, unreadSince: sql`now()` }).where(eq(chatSession.id, id));
}

/** Clear the unread marker (the creator has read the latest turn). */
export async function markChatSessionRead(db: Db, id: string): Promise<void> {
  await db.update(chatSession).set({ unreadSince: null }).where(eq(chatSession.id, id));
}

/** Delete a session and its messages (messages first — no ON DELETE CASCADE). */
export async function deleteChatSession(db: Db, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(chatMessage).where(eq(chatMessage.chatSessionId, id));
    await tx.delete(chatSession).where(eq(chatSession.id, id));
  });
}
