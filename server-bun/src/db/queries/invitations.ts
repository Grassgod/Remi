/**
 * Invitation queries — port of the Go invitation handler's DB layer
 * (server/internal/handler/invitation.go + the WorkspaceInvitation queries).
 *
 * Covers the workspace-scoped admin path (create / list pending / revoke) and
 * the user-scoped invitee path (get / list mine / accept / decline). Accepting
 * an invitation marks the row 'accepted' and inserts a member row in one tx.
 */

import { and, eq, lt, or, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { member, user, workspace, workspaceInvitation, type Member, type User } from "../schema.js";

/** No `WorkspaceInvitation` type is exported from schema.ts; derive it here. */
export type WorkspaceInvitation = typeof workspaceInvitation.$inferSelect;

/** Membership gate (mirrors Go GetMemberByUserAndWorkspace). null = not a member. */
export async function getMembership(db: Db, userId: string, wsId: string): Promise<Member | null> {
  const [m] = await db
    .select()
    .from(member)
    .where(and(eq(member.userId, userId), eq(member.workspaceId, wsId)));
  return m ?? null;
}

/** Look up a user by (lowercased) email. null = no such user. */
export async function getUserByEmail(db: Db, email: string): Promise<User | null> {
  const [u] = await db.select().from(user).where(eq(user.email, email));
  return u ?? null;
}

/** Look up a user by id. null = no such user. */
export async function getUserById(db: Db, id: string): Promise<User | null> {
  const [u] = await db.select().from(user).where(eq(user.id, id));
  return u ?? null;
}

/** Workspace name (for enriching invitation responses). null = no such workspace. */
export async function getWorkspaceName(db: Db, wsId: string): Promise<string | null> {
  const [w] = await db.select({ name: workspace.name }).from(workspace).where(eq(workspace.id, wsId));
  return w?.name ?? null;
}

/** A single invitation by id. null = not found. */
export async function getInvitation(db: Db, id: string): Promise<WorkspaceInvitation | null> {
  const [inv] = await db
    .select()
    .from(workspaceInvitation)
    .where(eq(workspaceInvitation.id, id));
  return inv ?? null;
}

/**
 * Drop any past-due pending invitations for this (workspace, email) to
 * 'expired'. Mirrors Go ExpireStalePendingInvitations: the partial unique index
 * idx_invitation_unique_pending only filters status='pending', so a stale row
 * would otherwise block a fresh create (#2055).
 */
export async function expireStalePendingInvitations(
  db: Db,
  wsId: string,
  email: string,
): Promise<void> {
  await db
    .update(workspaceInvitation)
    .set({ status: "expired", updatedAt: sql`now()` })
    .where(
      and(
        eq(workspaceInvitation.workspaceId, wsId),
        eq(workspaceInvitation.inviteeEmail, email),
        eq(workspaceInvitation.status, "pending"),
        lt(workspaceInvitation.expiresAt, sql`now()`),
      ),
    );
}

/** A still-live pending invitation for (workspace, email). null = none. */
export async function getPendingInvitationByEmail(
  db: Db,
  wsId: string,
  email: string,
): Promise<WorkspaceInvitation | null> {
  const [inv] = await db
    .select()
    .from(workspaceInvitation)
    .where(
      and(
        eq(workspaceInvitation.workspaceId, wsId),
        eq(workspaceInvitation.inviteeEmail, email),
        eq(workspaceInvitation.status, "pending"),
      ),
    );
  return inv ?? null;
}

export interface CreateInvitationInput {
  workspaceId: string;
  inviterId: string;
  inviteeEmail: string;
  inviteeUserId: string | null;
  role: string;
}

export async function createInvitation(
  db: Db,
  input: CreateInvitationInput,
): Promise<WorkspaceInvitation> {
  const [inv] = await db.insert(workspaceInvitation).values(input).returning();
  return inv!;
}

/** Enriched pending invitation row (joined inviter name/email). */
export interface InvitationWithInviter extends WorkspaceInvitation {
  inviterName: string;
  inviterEmail: string;
}

/**
 * Pending invitations for a workspace, with the inviter's name/email joined
 * (mirrors ListPendingInvitationsByWorkspace). Ordered by created_at DESC.
 */
export async function listPendingInvitationsByWorkspace(
  db: Db,
  wsId: string,
): Promise<InvitationWithInviter[]> {
  return db
    .select({
      id: workspaceInvitation.id,
      workspaceId: workspaceInvitation.workspaceId,
      inviterId: workspaceInvitation.inviterId,
      inviteeEmail: workspaceInvitation.inviteeEmail,
      inviteeUserId: workspaceInvitation.inviteeUserId,
      role: workspaceInvitation.role,
      status: workspaceInvitation.status,
      createdAt: workspaceInvitation.createdAt,
      updatedAt: workspaceInvitation.updatedAt,
      expiresAt: workspaceInvitation.expiresAt,
      inviterName: user.name,
      inviterEmail: user.email,
    })
    .from(workspaceInvitation)
    .innerJoin(user, eq(user.id, workspaceInvitation.inviterId))
    .where(
      and(
        eq(workspaceInvitation.workspaceId, wsId),
        eq(workspaceInvitation.status, "pending"),
      ),
    )
    .orderBy(sql`${workspaceInvitation.createdAt} desc`);
}

/** Enriched invitation row for the invitee's own list (adds workspace name). */
export interface InvitationForUser extends InvitationWithInviter {
  workspaceName: string;
}

/**
 * Pending invitations addressed to a user — matched by either invitee_user_id
 * or (lowercased) invitee_email — with inviter + workspace joined. Mirrors
 * ListPendingInvitationsForUser. Ordered by created_at DESC.
 */
export async function listPendingInvitationsForUser(
  db: Db,
  userId: string,
  email: string,
): Promise<InvitationForUser[]> {
  return db
    .select({
      id: workspaceInvitation.id,
      workspaceId: workspaceInvitation.workspaceId,
      inviterId: workspaceInvitation.inviterId,
      inviteeEmail: workspaceInvitation.inviteeEmail,
      inviteeUserId: workspaceInvitation.inviteeUserId,
      role: workspaceInvitation.role,
      status: workspaceInvitation.status,
      createdAt: workspaceInvitation.createdAt,
      updatedAt: workspaceInvitation.updatedAt,
      expiresAt: workspaceInvitation.expiresAt,
      inviterName: user.name,
      inviterEmail: user.email,
      workspaceName: workspace.name,
    })
    .from(workspaceInvitation)
    .innerJoin(user, eq(user.id, workspaceInvitation.inviterId))
    .innerJoin(workspace, eq(workspace.id, workspaceInvitation.workspaceId))
    .where(
      and(
        eq(workspaceInvitation.status, "pending"),
        or(
          eq(workspaceInvitation.inviteeUserId, userId),
          eq(workspaceInvitation.inviteeEmail, email),
        ),
      ),
    )
    .orderBy(sql`${workspaceInvitation.createdAt} desc`);
}

/** Mark a pending invitation 'expired' is separate; this just sets status. */
async function setStatus(
  db: Db,
  id: string,
  status: string,
): Promise<WorkspaceInvitation | null> {
  const [inv] = await db
    .update(workspaceInvitation)
    .set({ status, updatedAt: sql`now()` })
    .where(eq(workspaceInvitation.id, id))
    .returning();
  return inv ?? null;
}

/** Admin cancels a pending invitation (status → 'expired'). */
export async function revokeInvitation(db: Db, id: string): Promise<void> {
  await setStatus(db, id, "expired");
}

/** Invitee declines a pending invitation (status → 'declined'). */
export async function declineInvitation(
  db: Db,
  id: string,
): Promise<WorkspaceInvitation | null> {
  return setStatus(db, id, "declined");
}

export interface AcceptResult {
  invitation: WorkspaceInvitation;
  member: MemberWithUser;
}

/** A member row joined with its user (mirrors Go memberWithUserResponse). */
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
 * Accept an invitation: mark it 'accepted', insert the member, and mark the
 * user onboarded — all in one transaction so member / status / onboarded_at can
 * never disagree (mirrors Go AcceptInvitation). Throws on unique violation if
 * the user is already a member; the route translates that to 409.
 */
export async function acceptInvitation(
  db: Db,
  inv: WorkspaceInvitation,
  u: User,
): Promise<AcceptResult> {
  return db.transaction(async (tx) => {
    const [accepted] = await tx
      .update(workspaceInvitation)
      .set({ status: "accepted", updatedAt: sql`now()` })
      .where(eq(workspaceInvitation.id, inv.id))
      .returning();

    const [m] = await tx
      .insert(member)
      .values({ workspaceId: accepted!.workspaceId, userId: u.id, role: accepted!.role })
      .returning();

    // COALESCE keeps this idempotent for users joining additional workspaces.
    await tx
      .update(user)
      .set({ onboardedAt: sql`COALESCE(${user.onboardedAt}, now())`, updatedAt: sql`now()` })
      .where(eq(user.id, u.id));

    return {
      invitation: accepted!,
      member: {
        id: m!.id,
        workspaceId: m!.workspaceId,
        userId: m!.userId,
        role: m!.role,
        createdAt: m!.createdAt,
        userName: u.name,
        userEmail: u.email,
        userAvatarUrl: u.avatarUrl,
      },
    };
  });
}
