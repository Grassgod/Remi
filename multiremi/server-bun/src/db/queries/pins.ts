/**
 * Pinned-item queries — port of the Go pin handler's read path (list) plus the
 * simple pin (create) / unpin (delete) writes. Pins are workspace-scoped AND
 * user-scoped: every query filters by both workspace_id and user_id, mirroring
 * the sqlc queries in server/pkg/db/generated/pinned_item.sql.go.
 */

import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { pinnedItem } from "../schema.js";

export type PinnedItem = typeof pinnedItem.$inferSelect;
export type NewPinnedItem = typeof pinnedItem.$inferInsert;

/**
 * List a user's pins within a workspace, ordered by position then created_at
 * (mirrors Go ListPinnedItems: ORDER BY position ASC, created_at ASC).
 */
export async function listPinnedItems(
  db: Db,
  wsId: string,
  userId: string,
): Promise<PinnedItem[]> {
  return db
    .select()
    .from(pinnedItem)
    .where(and(eq(pinnedItem.workspaceId, wsId), eq(pinnedItem.userId, userId)))
    .orderBy(asc(pinnedItem.position), asc(pinnedItem.createdAt));
}

/**
 * Highest position among a user's pins in a workspace, or 0 when none exist
 * (mirrors Go GetMaxPinnedItemPosition: COALESCE(MAX(position), 0)). The caller
 * appends a new pin at maxPos + 1.
 */
export async function getMaxPinnedItemPosition(
  db: Db,
  wsId: string,
  userId: string,
): Promise<number> {
  const [row] = await db
    .select({ max: sql<number>`COALESCE(MAX(${pinnedItem.position}), 0)::float8` })
    .from(pinnedItem)
    .where(and(eq(pinnedItem.workspaceId, wsId), eq(pinnedItem.userId, userId)));
  return row?.max ?? 0;
}

/** Insert a pin (mirrors Go CreatePinnedItem). */
export async function createPinnedItem(db: Db, input: NewPinnedItem): Promise<PinnedItem> {
  const [p] = await db.insert(pinnedItem).values(input).returning();
  return p!;
}

/**
 * Delete a pin by its (workspace, user, item_type, item_id) tuple (mirrors Go
 * DeletePinnedItem). Returns true when a row was removed.
 */
export async function deletePinnedItem(
  db: Db,
  wsId: string,
  userId: string,
  itemType: string,
  itemId: string,
): Promise<boolean> {
  const res = await db
    .delete(pinnedItem)
    .where(
      and(
        eq(pinnedItem.workspaceId, wsId),
        eq(pinnedItem.userId, userId),
        eq(pinnedItem.itemType, itemType),
        eq(pinnedItem.itemId, itemId),
      ),
    )
    .returning({ id: pinnedItem.id });
  return res.length > 0;
}
