// Squads domain (squads, squad members and the shared assignee-ref resolver), extracted verbatim
// from MultiremiStore (the facade delegates every public method here).
import { createId, nowIso } from "@multiremi/ids.js";
import { nullableString, uniqueBy, uniqueRefMatch } from "@multiremi/store/helpers.js";
import { type StoreContext } from "@multiremi/store/context.js";
import type {
  AddSquadMemberInput,
  CreateSquadInput,
  MultiremiAssigneeType,
  MultiremiSquad,
  MultiremiSquadMember,
  RemoveSquadMemberInput,
  UpdateSquadInput,
} from "@multiremi/contracts/types.js";

type Row = Record<string, unknown>;

export class SquadsRepo {
  constructor(private ctx: StoreContext) {}

  createSquad(input: CreateSquadInput): MultiremiSquad {
    if (!input.name?.trim()) throw new Error("Squad name is required");
    const workspaceId = input.workspaceId ?? "local";
    // Validate the leader (and its workspace) BEFORE inserting the squad row —
    // otherwise a foreign leader leaves a persisted squad with a cross-workspace
    // leader_id after addSquadMember later throws.
    if (input.leaderId) {
      const leader = this.ctx.agents().getAgent(input.leaderId);
      if (!leader) throw new Error(`Agent not found: ${input.leaderId}`);
      if (leader.archivedAt) throw new Error(`Agent is archived: ${input.leaderId}`);
      if (leader.workspaceId !== workspaceId) throw new Error("Squad member is in a different workspace");
    }
    const id = input.id ?? createId("sqd");
    const now = nowIso();
    this.ctx.db.run(
      `INSERT INTO multiremi_squads (
        id, name, description, instructions, workspace_id, leader_id,
        creator_id, archived_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      [
        id,
        input.name.trim(),
        input.description ?? "",
        input.instructions ?? "",
        workspaceId,
        input.leaderId ?? null,
        input.creatorId ?? null,
        now,
        now,
      ],
    );
    if (input.leaderId) this.addSquadMember(id, { memberType: "agent", memberId: input.leaderId, role: "leader" });
    for (const memberId of input.memberIds ?? []) {
      if (memberId !== input.leaderId) this.addSquadMember(id, { memberType: "agent", memberId, role: "member" });
    }
    return this.getSquad(id)!;
  }

  getSquad(id: string): MultiremiSquad | null {
    const row = this.ctx.db.query(squadSelect("WHERE s.id = ?")).get(id) as Row | null;
    return row ? toSquad(row) : null;
  }

  getSquadByRef(ref: string, workspaceId?: string | null): MultiremiSquad | null {
    const value = ref.trim();
    if (!value) return null;
    const exact = this.getSquad(value);
    if (exact && !exact.archivedAt && (!workspaceId || exact.workspaceId === workspaceId)) return exact;
    return uniqueRefMatch(
      this.listSquads(workspaceId),
      value,
      (squad) => squad.id,
      (squad) => [squad.name],
    );
  }

  listSquads(workspaceId?: string | null): MultiremiSquad[] {
    const rows = workspaceId
      ? this.ctx.db.query(squadSelect("WHERE s.workspace_id = ? AND s.archived_at IS NULL ORDER BY s.updated_at DESC")).all(workspaceId) as Row[]
      : this.ctx.db.query(squadSelect("WHERE s.archived_at IS NULL ORDER BY s.updated_at DESC")).all() as Row[];
    return rows.map(toSquad);
  }

  resolveAssigneeRef(
    assigneeType: MultiremiAssigneeType | null | undefined,
    assigneeId: string | null | undefined,
    workspaceId?: string | null,
  ): { assigneeType: MultiremiAssigneeType; assigneeId: string } | null {
    const ref = assigneeId?.trim();
    if (!assigneeType && !ref) return null;
    if (!ref) throw new Error("Assignee id is required when assignee type is provided");
    const normalizedType = assigneeType ?? inferAssigneeTypeFromRef(ref);
    const types: MultiremiAssigneeType[] = normalizedType ? [normalizedType] : ["agent", "member", "squad"];
    const matches: Array<{ assigneeType: MultiremiAssigneeType; assigneeId: string }> = [];
    for (const type of types) {
      const entity = type === "agent"
        ? this.ctx.agents().getAgentByRef(ref, workspaceId)
        : type === "member"
          ? this.ctx.workspaces().getWorkspaceMemberByRef(ref, workspaceId)
          : this.getSquadByRef(ref, workspaceId);
      if (entity) matches.push({ assigneeType: type, assigneeId: entity.id });
    }
    const unique = uniqueBy(matches, (match) => `${match.assigneeType}:${match.assigneeId}`);
    if (unique.length === 1) return unique[0]!;
    if (unique.length > 1) throw new Error(`Ambiguous assignee reference: ${ref}`);
    if (normalizedType) throw new Error(`${capitalizeAssigneeType(normalizedType)} not found: ${ref}`);
    throw new Error(`Assignee not found: ${ref}`);
  }

  updateSquad(id: string, input: UpdateSquadInput): MultiremiSquad {
    const current = this.getSquad(id);
    if (!current) throw new Error(`Squad not found: ${id}`);
    if (input.leaderId) {
      const leader = this.ctx.agents().getAgent(input.leaderId);
      if (!leader) throw new Error(`Agent not found: ${input.leaderId}`);
      if (leader.archivedAt) throw new Error(`Agent is archived: ${input.leaderId}`);
      if (leader.workspaceId !== current.workspaceId) throw new Error("Squad member is in a different workspace");
    }
    const now = nowIso();
    const tx = this.ctx.db.transaction(() => {
      this.ctx.db.run(
        `UPDATE multiremi_squads SET
          name = ?,
          description = ?,
          instructions = ?,
          leader_id = ?,
          updated_at = ?
         WHERE id = ?`,
        [
          input.name ?? current.name,
          input.description === undefined ? current.description : input.description ?? "",
          input.instructions === undefined ? current.instructions : input.instructions ?? "",
          input.leaderId === undefined ? current.leaderId : input.leaderId,
          now,
          id,
        ],
      );
      if (input.leaderId !== undefined) {
        this.ctx.db.run(
          "UPDATE multiremi_squad_members SET role = 'member' WHERE squad_id = ? AND role = 'leader'",
          [id],
        );
        if (input.leaderId) {
          this.upsertSquadMemberRow(id, "agent", input.leaderId, "leader", now);
        }
      }
    });
    tx();
    return this.getSquad(id)!;
  }

  archiveSquad(id: string): MultiremiSquad {
    const squad = this.getSquad(id);
    if (!squad) throw new Error(`Squad not found: ${id}`);
    const now = nowIso();
    const affectedProjects: Array<{ id: string; workspace_id: string }> = [];
    const tx = this.ctx.db.transaction(() => {
      affectedProjects.push(...this.ctx.db.query(
        `SELECT id, workspace_id FROM multiremi_projects
         WHERE default_assignee_type = 'squad' AND default_assignee_id = ?`,
      ).all(id) as Array<{ id: string; workspace_id: string }>);
      this.ctx.db.run("UPDATE multiremi_squads SET archived_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
      this.ctx.db.run(
        `UPDATE multiremi_projects
         SET default_assignee_type = NULL, default_assignee_id = NULL, updated_at = ?
         WHERE default_assignee_type = 'squad' AND default_assignee_id = ?`,
        [now, id],
      );
    });
    tx();
    for (const project of affectedProjects) {
      this.ctx.emitWorkspaceEvent({
        type: "project:updated",
        workspaceId: project.workspace_id,
        actorType: "system",
        actorId: null,
        payload: {
          project: {
            id: project.id,
            default_assignee_type: null,
            default_assignee_id: null,
            updated_at: now,
          },
        },
      });
    }
    return this.getSquad(id)!;
  }

  addSquadMember(squadId: string, input: AddSquadMemberInput): MultiremiSquadMember {
    const squad = this.getSquad(squadId);
    if (!squad) throw new Error(`Squad not found: ${squadId}`);
    if (input.memberType === "agent") {
      const agent = this.ctx.agents().getAgent(input.memberId);
      if (!agent) throw new Error(`Agent not found: ${input.memberId}`);
      if (agent.archivedAt) throw new Error(`Agent is archived: ${input.memberId}`);
      // A squad and its agents must share a workspace — a cross-workspace
      // leader/member would let squad-driven tasks target another tenant's
      // agent (whose task the runnable-agent resolver would then dispatch).
      if (agent.workspaceId !== squad.workspaceId) throw new Error("Squad member is in a different workspace");
    } else if (input.memberType === "member") {
      const member = this.ctx.workspaces().getWorkspaceMember(input.memberId);
      if (!member) throw new Error(`Member not found: ${input.memberId}`);
      if (member.archivedAt) throw new Error(`Member is archived: ${input.memberId}`);
    }
    // Re-adding the current leader is an idempotent membership operation. Keep
    // the canonical role even if an older caller sends the default `member`.
    const isCurrentLeader = input.memberType === "agent" && squad.leaderId === input.memberId;
    const role = isCurrentLeader ? "leader" : input.role ?? "member";
    if (role === "leader" && input.memberType !== "agent") {
      throw new Error("Squad leader must be an agent");
    }
    const now = nowIso();
    let id = "";
    const tx = this.ctx.db.transaction(() => {
      if (role === "leader") {
        this.ctx.db.run(
          "UPDATE multiremi_squad_members SET role = 'member' WHERE squad_id = ? AND role = 'leader'",
          [squadId],
        );
      }
      id = this.upsertSquadMemberRow(squadId, input.memberType, input.memberId, role, now);
      this.ctx.db.run(
        role === "leader"
          ? "UPDATE multiremi_squads SET leader_id = ?, updated_at = ? WHERE id = ?"
          : "UPDATE multiremi_squads SET updated_at = ? WHERE id = ?",
        role === "leader" ? [input.memberId, now, squadId] : [now, squadId],
      );
    });
    tx();
    return this.getSquadMember(id)!;
  }

  removeSquadMember(squadId: string, input: RemoveSquadMemberInput): void {
    const now = nowIso();
    this.ctx.db.run(
      "DELETE FROM multiremi_squad_members WHERE squad_id = ? AND member_type = ? AND member_id = ?",
      [squadId, input.memberType, input.memberId],
    );
    const squad = this.getSquad(squadId);
    if (squad?.leaderId === input.memberId && input.memberType === "agent") {
      this.ctx.db.run("UPDATE multiremi_squads SET leader_id = NULL, updated_at = ? WHERE id = ?", [now, squadId]);
    } else {
      this.ctx.db.run("UPDATE multiremi_squads SET updated_at = ? WHERE id = ?", [now, squadId]);
    }
  }

  getSquadMember(id: string): MultiremiSquadMember | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_squad_members WHERE id = ?").get(id) as Row | null;
    return row ? toSquadMember(row) : null;
  }

  listSquadMembers(squadId: string): MultiremiSquadMember[] {
    const rows = this.ctx.db.query(
      `SELECT m.*,
              CASE
                WHEN m.member_type = 'agent' AND m.member_id = s.leader_id THEN 'leader'
                WHEN m.role = 'leader' THEN 'member'
                ELSE m.role
              END AS role
       FROM multiremi_squad_members m
       JOIN multiremi_squads s ON s.id = m.squad_id
       WHERE m.squad_id = ?
       ORDER BY (m.member_type = 'agent' AND m.member_id = s.leader_id) DESC, m.created_at ASC`,
    ).all(squadId) as Row[];
    return rows.map(toSquadMember);
  }

  private upsertSquadMemberRow(
    squadId: string,
    memberType: AddSquadMemberInput["memberType"],
    memberId: string,
    role: string,
    now: string,
  ): string {
    const existing = this.ctx.db.query(
      "SELECT id FROM multiremi_squad_members WHERE squad_id = ? AND member_type = ? AND member_id = ?",
    ).get(squadId, memberType, memberId) as Row | null;
    if (existing) {
      const id = String(existing.id);
      this.ctx.db.run("UPDATE multiremi_squad_members SET role = ? WHERE id = ?", [role, id]);
      return id;
    }
    const id = createId("sqm");
    this.ctx.db.run(
      `INSERT INTO multiremi_squad_members (id, squad_id, member_type, member_id, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, squadId, memberType, memberId, role, now],
    );
    return id;
  }
}

function inferAssigneeTypeFromRef(ref: string): MultiremiAssigneeType | null {
  if (/^agt_/i.test(ref)) return "agent";
  if (/^mem_/i.test(ref)) return "member";
  if (/^sqd_/i.test(ref)) return "squad";
  return null;
}

function capitalizeAssigneeType(type: MultiremiAssigneeType): string {
  return `${type.slice(0, 1).toUpperCase()}${type.slice(1)}`;
}

function squadSelect(suffix: string): string {
  return `
    SELECT s.*, COUNT(m.id) AS member_count
    FROM multiremi_squads s
    LEFT JOIN multiremi_squad_members m ON m.squad_id = s.id
    ${suffix.includes("ORDER BY") ? suffix.replace("ORDER BY", "GROUP BY s.id ORDER BY") : `${suffix} GROUP BY s.id`}
  `;
}

function toSquad(row: Row): MultiremiSquad {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    name: String(row.name),
    description: String(row.description ?? ""),
    instructions: String(row.instructions ?? ""),
    leaderId: nullableString(row.leader_id),
    creatorId: nullableString(row.creator_id),
    archivedAt: nullableString(row.archived_at),
    memberCount: Number(row.member_count ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toSquadMember(row: Row): MultiremiSquadMember {
  return {
    id: String(row.id),
    squadId: String(row.squad_id),
    memberType: String(row.member_type) as MultiremiSquadMember["memberType"],
    memberId: String(row.member_id),
    role: String(row.role ?? "member"),
    createdAt: String(row.created_at),
  };
}
