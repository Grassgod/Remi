// Wire serializers for the squads domain, moved verbatim out of api.ts.
// Go-compat (`*Compatibility*`) and native shapers sit side by side on purpose:
// the two route prefixes are intentionally divergent and must stay diffable.
import type { MultiremiSquad, MultiremiSquadMember } from "@multiremi/contracts/types.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import type { Context } from "hono";

export function squadCompatibilityResponse(store: MultiremiStore, squad: MultiremiSquad): Record<string, unknown> {
  const members = store.listSquadMembers(squad.id);
  return {
    id: squad.id,
    workspace_id: squad.workspaceId,
    name: squad.name,
    description: squad.description,
    instructions: squad.instructions,
    avatar_url: squad.avatarUrl,
    leader_id: squad.leaderId,
    creator_id: squad.creatorId,
    created_at: squad.createdAt,
    updated_at: squad.updatedAt,
    archived_at: squad.archivedAt,
    archived_by: null,
    member_count: members.length,
    member_preview: members.slice(0, 3).map(squadMemberCompatibilityResponse),
  };
}

export function squadMemberCompatibilityResponse(member: MultiremiSquadMember): Record<string, unknown> {
  return {
    id: member.id,
    squad_id: member.squadId,
    member_type: member.memberType,
    member_id: member.memberId,
    role: member.role,
    created_at: member.createdAt,
  };
}

export function squadCompatibilityErrorResponse(c: Context, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("Squad not found")) return c.json({ error: "squad not found" }, 404);
  if (message.startsWith("Agent not found")) return c.json({ error: "agent not found in this workspace" }, 400);
  if (message.startsWith("Member not found")) return c.json({ error: "member not found in this workspace" }, 400);
  if (message === "Squad name is required") return c.json({ error: "name is required" }, 400);
  if (!message || message === "undefined") return c.json({ error: "invalid request body" }, 400);
  return c.json({ error: message }, 400);
}

export function squadMemberStatusResponse(store: MultiremiStore, squadId: string): Array<{
  member_type: string;
  member_id: string;
  status: string;
}> {
  return store.listSquadMembers(squadId).map((member) => {
    if (member.memberType === "agent") {
      const agent = store.getAgent(member.memberId);
      return {
        member_type: member.memberType,
        member_id: member.memberId,
        status: agent?.archivedAt ? "archived" : agent ? "available" : "missing",
      };
    }
    const workspaceMember = store.getWorkspaceMember(member.memberId);
    return {
      member_type: member.memberType,
      member_id: member.memberId,
      status: workspaceMember?.archivedAt ? "archived" : workspaceMember ? "available" : "missing",
    };
  });
}
