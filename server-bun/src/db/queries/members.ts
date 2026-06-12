/**
 * Member queries — port of the Go member read path
 * (ListMembers + ListMembersWithUser from server/pkg/db/queries/member.sql).
 *
 * The user join mirrors `ListMembersWithUser`: member row + the joined user's
 * name/email/avatar_url, ordered by member.created_at ASC.
 */

import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { member, user, type Member } from "../schema.js";

/**
 * Membership gate (mirrors Go GetMemberByUserAndWorkspace). null = not a member.
 * Duplicated intentionally from issues.ts so this domain is self-contained.
 */
export async function getMembership(db: Db, userId: string, wsId: string): Promise<Member | null> {
  const [m] = await db
    .select()
    .from(member)
    .where(and(eq(member.userId, userId), eq(member.workspaceId, wsId)));
  return m ?? null;
}

/** A member row joined with its user (mirrors ListMembersWithUser's row shape). */
export interface MemberWithUser {
  id: string;
  workspaceId: string;
  userId: string;
  role: string;
  createdAt: string;
  userName: string;
  userEmail: string;
  userAvatarUrl: string | null;
}

/**
 * List a workspace's members with the joined user (name/email/avatar).
 * Mirrors the SQL `ListMembersWithUser`:
 *   JOIN "user" u ON u.id = m.user_id WHERE m.workspace_id = $1
 *   ORDER BY m.created_at ASC.
 */
export async function listMembersWithUser(db: Db, wsId: string): Promise<MemberWithUser[]> {
  return db
    .select({
      id: member.id,
      workspaceId: member.workspaceId,
      userId: member.userId,
      role: member.role,
      createdAt: member.createdAt,
      userName: user.name,
      userEmail: user.email,
      userAvatarUrl: user.avatarUrl,
    })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.workspaceId, wsId))
    .orderBy(asc(member.createdAt));
}
