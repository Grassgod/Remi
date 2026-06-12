/**
 * Notification-preference queries — port of the Go notification_preference
 * handler's read/write path (GET + UPSERT of a user's per-workspace prefs).
 *
 * Prefs are keyed on (workspace_id, user_id) — the recipient is the requesting
 * user. Mirrors Go GetNotificationPreference / UpsertNotificationPreference.
 */

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { notificationPreference } from "../schema.js";

type NotificationPreference = typeof notificationPreference.$inferSelect;

/**
 * The set of allowed notification preference group keys (mirrors Go
 * validNotifGroups). `system_notifications` is a delivery-channel toggle, not
 * an inbox event group, but shares the same preferences map.
 */
export const VALID_NOTIF_GROUPS: ReadonlySet<string> = new Set([
  "assignments",
  "status_changes",
  "comments",
  "updates",
  "agent_activity",
  "system_notifications",
]);

/** The set of allowed preference values per group (mirrors Go validNotifValues). */
export const VALID_NOTIF_VALUES: ReadonlySet<string> = new Set(["all", "muted"]);

/**
 * Fetch a user's notification preferences for a workspace (mirrors Go
 * GetNotificationPreference). null = no row yet (Go pgx.ErrNoRows).
 */
export async function getNotificationPreference(
  db: Db,
  wsId: string,
  userId: string,
): Promise<NotificationPreference | null> {
  const [p] = await db
    .select()
    .from(notificationPreference)
    .where(
      and(
        eq(notificationPreference.workspaceId, wsId),
        eq(notificationPreference.userId, userId),
      ),
    );
  return p ?? null;
}

/**
 * Upsert a user's notification preferences for a workspace, conflicting on the
 * (workspace_id, user_id) unique key (mirrors Go UpsertNotificationPreference).
 * Returns the stored row.
 */
export async function upsertNotificationPreference(
  db: Db,
  wsId: string,
  userId: string,
  preferences: Record<string, string>,
): Promise<NotificationPreference> {
  const [p] = await db
    .insert(notificationPreference)
    .values({ workspaceId: wsId, userId, preferences })
    .onConflictDoUpdate({
      target: [notificationPreference.workspaceId, notificationPreference.userId],
      set: { preferences, updatedAt: sql`now()` },
    })
    .returning();
  return p!;
}
