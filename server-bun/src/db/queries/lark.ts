/** Lark (Feishu) inbound queries — installation lookup + workspace owner. */

import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { larkInstallation, member } from "../schema.js";

export type LarkInstallation = typeof larkInstallation.$inferSelect;

/**
 * Every installation rooted at the workspace, active and revoked, oldest
 * first (mirrors Go ListLarkInstallationsByWorkspace) — the status column
 * lets the UI distinguish "wired up" from "torn down but kept for audit".
 */
export async function listLarkInstallationsByWorkspace(
  db: Db,
  wsId: string,
): Promise<LarkInstallation[]> {
  return db
    .select()
    .from(larkInstallation)
    .where(eq(larkInstallation.workspaceId, wsId))
    .orderBy(asc(larkInstallation.createdAt));
}

/** Find the installation for a Feishu app_id (maps the app → a workspace). */
export async function getLarkInstallationByAppId(
  db: Db,
  appId: string,
): Promise<LarkInstallation | null> {
  const [i] = await db.select().from(larkInstallation).where(eq(larkInstallation.appId, appId));
  return i ?? null;
}

/** An owner member of the workspace — used as the creator for lark-created issues
 * until the sender's lark_user_binding is wired in (a faithful follow-up). */
export async function getWorkspaceOwner(db: Db, wsId: string): Promise<{ userId: string } | null> {
  const [m] = await db
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.workspaceId, wsId), eq(member.role, "owner")));
  return m ?? null;
}
