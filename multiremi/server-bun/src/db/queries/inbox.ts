/** Inbox queries — port of the Go inbox handler's read path (list + unread count + mark-read). */

import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { inboxItem, issue } from "../schema.js";

type InboxItem = typeof inboxItem.$inferSelect;

/** A list row: the inbox item plus the joined issue status (mirrors Go ListInboxItemsRow). */
export type InboxItemRow = InboxItem & { issueStatus: string | null };

/**
 * List a recipient's non-archived inbox items for a workspace, newest first,
 * LEFT JOINing the issue to expose its current status (mirrors Go
 * ListInboxItems: WHERE workspace_id = $1 AND recipient_type = $2 AND
 * recipient_id = $3 AND archived = false ORDER BY created_at DESC).
 */
export async function listInboxItems(
  db: Db,
  wsId: string,
  recipientType: string,
  recipientId: string,
): Promise<InboxItemRow[]> {
  const rows = await db
    .select({ item: inboxItem, issueStatus: issue.status })
    .from(inboxItem)
    .leftJoin(issue, eq(issue.id, inboxItem.issueId))
    .where(
      and(
        eq(inboxItem.workspaceId, wsId),
        eq(inboxItem.recipientType, recipientType),
        eq(inboxItem.recipientId, recipientId),
        eq(inboxItem.archived, false),
      ),
    )
    .orderBy(desc(inboxItem.createdAt));
  return rows.map((r) => ({ ...r.item, issueStatus: r.issueStatus }));
}

/**
 * Count a recipient's unread, non-archived inbox items for a workspace
 * (mirrors Go CountUnreadInbox).
 */
export async function countUnreadInbox(
  db: Db,
  wsId: string,
  recipientType: string,
  recipientId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(inboxItem)
    .where(
      and(
        eq(inboxItem.workspaceId, wsId),
        eq(inboxItem.recipientType, recipientType),
        eq(inboxItem.recipientId, recipientId),
        eq(inboxItem.read, false),
        eq(inboxItem.archived, false),
      ),
    );
  return row?.count ?? 0;
}

/**
 * Resolve an inbox item by UUID, scoped to the workspace (mirrors Go
 * GetInboxItemInWorkspace). null = not found / wrong workspace.
 */
export async function getInboxItemInWorkspace(
  db: Db,
  wsId: string,
  id: string,
): Promise<InboxItem | null> {
  const [i] = await db
    .select()
    .from(inboxItem)
    .where(and(eq(inboxItem.id, id), eq(inboxItem.workspaceId, wsId)));
  return i ?? null;
}

/** Mark an inbox item read (mirrors Go MarkInboxRead). Returns the updated row. */
export async function markInboxRead(db: Db, id: string): Promise<InboxItem> {
  const [i] = await db
    .update(inboxItem)
    .set({ read: true })
    .where(eq(inboxItem.id, id))
    .returning();
  return i!;
}

/** Fetch a single issue's status by id (mirrors Go enrichInboxResponse → GetIssue.Status). */
export async function getIssueStatus(db: Db, issueId: string): Promise<string | null> {
  const [i] = await db.select({ status: issue.status }).from(issue).where(eq(issue.id, issueId));
  return i?.status ?? null;
}
