/** Squad queries — port of the Go squad handler's read + write paths. */

import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { squad, squadMember } from "../schema.js";

export type Squad = typeof squad.$inferSelect;
export type SquadMember = typeof squadMember.$inferSelect;

/** One row of the static squad-membership preview (mirrors Go preview rows). */
export interface SquadMemberPreviewRow {
  squadId: string;
  memberType: string;
  memberId: string;
  role: string;
}

/**
 * List a workspace's non-archived squads, oldest first (mirrors Go ListSquads:
 * WHERE workspace_id = $1 AND archived_at IS NULL ORDER BY created_at ASC).
 */
export async function listSquads(db: Db, wsId: string): Promise<Squad[]> {
  return db
    .select()
    .from(squad)
    .where(and(eq(squad.workspaceId, wsId), isNull(squad.archivedAt)))
    .orderBy(asc(squad.createdAt));
}

/**
 * Resolve a squad by UUID, scoped to the workspace (multi-tenancy). Mirrors Go
 * GetSquadInWorkspace (id + workspace_id; archived squads are still returned).
 * null = not found / wrong workspace.
 */
export async function getSquadInWorkspace(
  db: Db,
  wsId: string,
  id: string,
): Promise<Squad | null> {
  const [s] = await db
    .select()
    .from(squad)
    .where(and(eq(squad.id, id), eq(squad.workspaceId, wsId)));
  return s ?? null;
}

/**
 * Static squad-membership preview rows for every non-archived squad in the
 * workspace (mirrors Go ListSquadMemberPreviewRows). Ordered by squad, then
 * leader first, then insertion order — so the caller can take the first N as
 * the preview and count the rest.
 */
export async function listSquadMemberPreviewRows(
  db: Db,
  wsId: string,
): Promise<SquadMemberPreviewRow[]> {
  return db
    .select({
      squadId: squadMember.squadId,
      memberType: squadMember.memberType,
      memberId: squadMember.memberId,
      role: squadMember.role,
    })
    .from(squadMember)
    .innerJoin(squad, eq(squad.id, squadMember.squadId))
    .where(and(eq(squad.workspaceId, wsId), isNull(squad.archivedAt)))
    .orderBy(
      asc(squadMember.squadId),
      desc(sql`(${squadMember.memberType} = 'agent' AND ${squadMember.memberId} = ${squad.leaderId})`),
      asc(squadMember.createdAt),
    );
}

/**
 * Static squad-membership preview rows for a single squad (mirrors Go
 * ListSquadMemberPreviewRowsBySquad). Leader first, then insertion order.
 */
export async function listSquadMemberPreviewRowsBySquad(
  db: Db,
  squadId: string,
): Promise<SquadMemberPreviewRow[]> {
  return db
    .select({
      squadId: squadMember.squadId,
      memberType: squadMember.memberType,
      memberId: squadMember.memberId,
      role: squadMember.role,
    })
    .from(squadMember)
    .innerJoin(squad, eq(squad.id, squadMember.squadId))
    .where(eq(squadMember.squadId, squadId))
    .orderBy(
      desc(sql`(${squadMember.memberType} = 'agent' AND ${squadMember.memberId} = ${squad.leaderId})`),
      asc(squadMember.createdAt),
    );
}

// ── Write path ──────────────────────────────────────────────────────────────

/** Fields accepted when creating a squad (mirrors Go CreateSquadParams). */
export interface CreateSquadInput {
  workspaceId: string;
  name: string;
  description?: string;
  leaderId: string;
  creatorId: string;
  avatarUrl?: string | null;
}

/**
 * Insert a squad and return the new row (mirrors Go CreateSquad). Defaults for
 * description/instructions are supplied by the column DEFAULTs.
 */
export async function createSquad(db: Db, input: CreateSquadInput): Promise<Squad> {
  const [s] = await db
    .insert(squad)
    .values({
      workspaceId: input.workspaceId,
      name: input.name,
      description: input.description ?? "",
      leaderId: input.leaderId,
      creatorId: input.creatorId,
      avatarUrl: input.avatarUrl ?? null,
    })
    .returning();
  return s!;
}

/** Patchable squad columns (mirrors Go UpdateSquadParams' COALESCE pattern). */
export interface UpdateSquadInput {
  name?: string;
  description?: string;
  instructions?: string;
  avatarUrl?: string | null;
  leaderId?: string;
}

/**
 * Apply a partial update to a squad (only the provided fields are touched) and
 * bump updated_at. Mirrors Go UpdateSquad. Returns the updated row, or null if
 * the id no longer exists. With no fields set it still refreshes updated_at.
 */
export async function updateSquad(
  db: Db,
  id: string,
  patch: UpdateSquadInput,
): Promise<Squad | null> {
  const set: Partial<typeof squad.$inferInsert> = {
    updatedAt: new Date().toISOString(),
  };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.instructions !== undefined) set.instructions = patch.instructions;
  if (patch.avatarUrl !== undefined) set.avatarUrl = patch.avatarUrl;
  if (patch.leaderId !== undefined) set.leaderId = patch.leaderId;

  const [s] = await db.update(squad).set(set).where(eq(squad.id, id)).returning();
  return s ?? null;
}

/**
 * Archive a squad (soft delete) by stamping archived_at/archived_by. Mirrors Go
 * ArchiveSquad. Returns the archived row, or null if the id no longer exists.
 */
export async function archiveSquad(db: Db, id: string, archivedBy: string): Promise<Squad | null> {
  const now = new Date().toISOString();
  const [s] = await db
    .update(squad)
    .set({ archivedAt: now, archivedBy, updatedAt: now })
    .where(eq(squad.id, id))
    .returning();
  return s ?? null;
}

/**
 * Insert a squad member (mirrors Go AddSquadMember). Returns the new row. The
 * caller is responsible for catching the unique-violation on
 * (squad_id, member_type, member_id) and mapping it to 409.
 */
export async function addSquadMember(
  db: Db,
  input: { squadId: string; memberType: string; memberId: string; role: string },
): Promise<SquadMember> {
  const [m] = await db
    .insert(squadMember)
    .values({
      squadId: input.squadId,
      memberType: input.memberType,
      memberId: input.memberId,
      role: input.role,
    })
    .returning();
  return m!;
}

/**
 * True if (squad_id, member_type, member_id) already exists (mirrors Go
 * IsSquadMember). Used to decide whether a new leader needs auto-adding.
 */
export async function isSquadMember(
  db: Db,
  squadId: string,
  memberType: string,
  memberId: string,
): Promise<boolean> {
  const [m] = await db
    .select({ id: squadMember.id })
    .from(squadMember)
    .where(
      and(
        eq(squadMember.squadId, squadId),
        eq(squadMember.memberType, memberType),
        eq(squadMember.memberId, memberId),
      ),
    );
  return !!m;
}

/**
 * Delete a squad member by (squad_id, member_type, member_id). Mirrors Go
 * RemoveSquadMember. Returns the number of rows removed (0 = not found).
 */
export async function removeSquadMember(
  db: Db,
  squadId: string,
  memberType: string,
  memberId: string,
): Promise<number> {
  const removed = await db
    .delete(squadMember)
    .where(
      and(
        eq(squadMember.squadId, squadId),
        eq(squadMember.memberType, memberType),
        eq(squadMember.memberId, memberId),
      ),
    )
    .returning({ id: squadMember.id });
  return removed.length;
}
