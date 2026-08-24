import type { Context, Hono } from "hono";
import {
  compatibilityUserId,
  compatibilityWorkspaceId,
  denyCurrentUserWorkspaceAccess,
  isJsonApiError,
  readJson,
  readJsonStrict,
} from "../helpers.js";
import {
  cleanString,
  currentTaskAccessToken,
  squadCompatibilityErrorResponse,
  squadCompatibilityResponse,
  squadMemberCompatibilityResponse,
  squadMemberStatusResponse,
} from "../wire/index.js";
import type {
  AddSquadMemberInput,
  CreateSquadInput,
  RemoveSquadMemberInput,
  UpdateSquadInput,
} from "@multiremi/contracts/types.js";
import type { RouterDeps } from "./deps.js";

export function registerSquadRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;
  const humanOnly = (c: Context): Response | null => currentTaskAccessToken(c)
    ? c.json({ error: "this endpoint is only available to human actors" }, 403)
    : null;
  const loadSquad = (c: Context, id: string) => {
    const squad = store.getSquad(id);
    if (!squad) return c.json({ error: "squad not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, squad.workspaceId);
    return denied ?? squad;
  };

  app.get("/api/multiremi/squads", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const squads = store.listSquads(workspaceId);
    return c.json({ squads, total: squads.length });
  });
  app.get("/api/squads", (c) => {
    const workspaceId = compatibilityWorkspaceId(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    return c.json(store.listSquads(workspaceId).map((squad) => squadCompatibilityResponse(store, squad)));
  });
  app.post("/api/squads", async (c) => {
    const actorDenied = humanOnly(c);
    if (actorDenied) return actorDenied;
    const body = await readJsonStrict<{
      id?: string;
      name?: string;
      description?: string | null;
      instructions?: string | null;
      workspace_id?: string | null;
      leader_id?: string | null;
      creator_id?: string | null;
      member_ids?: string[];
    }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const workspaceId = cleanString(body.workspace_id) ?? compatibilityWorkspaceId(c);
    const squadCreateDenied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (squadCreateDenied) return squadCreateDenied;
    const leaderId = cleanString(body.leader_id);
    const name = cleanString(body.name);
    if (!name) return c.json({ error: "name is required" }, 400);
    if (!leaderId) return c.json({ error: "leader_id is required" }, 400);
    const leader = store.getAgent(leaderId);
    if (!leader || leader.workspaceId !== workspaceId) return c.json({ error: "leader must be a valid agent in this workspace" }, 400);
    try {
      const squad = store.createSquad({
        id: body.id,
        name,
        description: body.description,
        instructions: body.instructions,
        workspaceId,
        leaderId,
        creatorId: cleanString(body.creator_id) ?? compatibilityUserId(c),
        memberIds: body.member_ids,
      });
      return c.json(squadCompatibilityResponse(store, squad), 201);
    } catch (error) {
      return squadCompatibilityErrorResponse(c, error);
    }
  });
  app.post("/api/multiremi/squads", async (c) => {
    const actorDenied = humanOnly(c);
    if (actorDenied) return actorDenied;
    const body = await readJson<CreateSquadInput>(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, body.workspaceId ?? "local");
    if (denied) return denied;
    return c.json({ squad: store.createSquad(body) }, 201);
  });
  app.get("/api/multiremi/squads/:id", (c) => {
    const squad = loadSquad(c, c.req.param("id"));
    if (squad instanceof Response) return squad;
    return c.json({ squad, members: store.listSquadMembers(squad.id) });
  });
  app.patch("/api/multiremi/squads/:id", async (c) => {
    const actorDenied = humanOnly(c);
    if (actorDenied) return actorDenied;
    const squad = loadSquad(c, c.req.param("id"));
    if (squad instanceof Response) return squad;
    const body = await readJson<UpdateSquadInput>(c);
    return c.json({ squad: store.updateSquad(squad.id, body) });
  });
  app.delete("/api/multiremi/squads/:id", (c) => {
    const actorDenied = humanOnly(c);
    if (actorDenied) return actorDenied;
    const squad = loadSquad(c, c.req.param("id"));
    if (squad instanceof Response) return squad;
    return c.json({ squad: store.archiveSquad(squad.id) });
  });
  app.get("/api/multiremi/squads/:id/members", (c) => {
    const squad = loadSquad(c, c.req.param("id"));
    if (squad instanceof Response) return squad;
    return c.json({ members: store.listSquadMembers(squad.id) });
  });
  app.post("/api/multiremi/squads/:id/members", async (c) => {
    const actorDenied = humanOnly(c);
    if (actorDenied) return actorDenied;
    const squad = loadSquad(c, c.req.param("id"));
    if (squad instanceof Response) return squad;
    const body = await readJson<AddSquadMemberInput>(c);
    return c.json({ member: store.addSquadMember(squad.id, body) }, 201);
  });
  app.patch("/api/multiremi/squads/:id/members", async (c) => {
    const actorDenied = humanOnly(c);
    if (actorDenied) return actorDenied;
    const squad = loadSquad(c, c.req.param("id"));
    if (squad instanceof Response) return squad;
    const body = await readJson<AddSquadMemberInput>(c);
    return c.json({ member: store.addSquadMember(squad.id, body) });
  });
  app.delete("/api/multiremi/squads/:id/members", async (c) => {
    const actorDenied = humanOnly(c);
    if (actorDenied) return actorDenied;
    const squad = loadSquad(c, c.req.param("id"));
    if (squad instanceof Response) return squad;
    const body = await readJson<RemoveSquadMemberInput>(c);
    store.removeSquadMember(squad.id, body);
    return c.json({ ok: true });
  });
  app.get("/api/squads/:id", (c) => {
    const squad = store.getSquad(c.req.param("id"));
    if (!squad) return c.json({ error: "squad not found" }, 404);
    const workspaceId = compatibilityWorkspaceId(c);
    if (squad.workspaceId !== workspaceId) return c.json({ error: "squad not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, squad.workspaceId);
    if (denied) return denied;
    return c.json(squadCompatibilityResponse(store, squad));
  });
  app.put("/api/squads/:id", async (c) => {
    const actorDenied = humanOnly(c);
    if (actorDenied) return actorDenied;
    const existing = store.getSquad(c.req.param("id"));
    if (!existing || existing.workspaceId !== compatibilityWorkspaceId(c)) return c.json({ error: "squad not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, existing.workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<{
      name?: string;
      description?: string | null;
      instructions?: string | null;
      leader_id?: string | null;
    }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const leaderId = body.leader_id === undefined ? undefined : cleanString(body.leader_id) ?? null;
    if (leaderId) {
      const leader = store.getAgent(leaderId);
      if (!leader || leader.workspaceId !== existing.workspaceId) return c.json({ error: "leader must be a valid agent in this workspace" }, 400);
    }
    try {
      const squad = store.updateSquad(c.req.param("id"), {
        name: body.name,
        description: body.description,
        instructions: body.instructions,
        leaderId,
      });
      return c.json(squadCompatibilityResponse(store, squad));
    } catch (error) {
      return squadCompatibilityErrorResponse(c, error);
    }
  });
  app.delete("/api/squads/:id", (c) => {
    const actorDenied = humanOnly(c);
    if (actorDenied) return actorDenied;
    const existing = store.getSquad(c.req.param("id"));
    if (!existing || existing.workspaceId !== compatibilityWorkspaceId(c)) return c.json({ error: "squad not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, existing.workspaceId);
    if (denied) return denied;
    store.archiveSquad(c.req.param("id"));
    return c.body(null, 204);
  });
  app.get("/api/squads/:id/members", (c) => {
    const squad = store.getSquad(c.req.param("id"));
    if (!squad || squad.workspaceId !== compatibilityWorkspaceId(c)) return c.json({ error: "squad not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, squad.workspaceId);
    if (denied) return denied;
    return c.json(store.listSquadMembers(c.req.param("id")).map(squadMemberCompatibilityResponse));
  });
  app.get("/api/squads/:id/members/status", (c) => {
    const squad = store.getSquad(c.req.param("id"));
    if (!squad || squad.workspaceId !== compatibilityWorkspaceId(c)) return c.json({ error: "squad not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, squad.workspaceId);
    if (denied) return denied;
    return c.json(squadMemberStatusResponse(store, c.req.param("id")));
  });
  app.post("/api/squads/:id/members", async (c) => {
    const actorDenied = humanOnly(c);
    if (actorDenied) return actorDenied;
    const squad = store.getSquad(c.req.param("id"));
    if (!squad || squad.workspaceId !== compatibilityWorkspaceId(c)) return c.json({ error: "squad not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, squad.workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<{ member_type?: string; member_id?: string; role?: string }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const memberType = cleanString(body.member_type);
    const memberId = cleanString(body.member_id);
    if (memberType !== "agent" && memberType !== "member") return c.json({ error: "member_type must be 'agent' or 'member'" }, 400);
    if (!memberId) return c.json({ error: "member_id is required" }, 400);
    try {
      const member = store.addSquadMember(c.req.param("id"), {
        memberType,
        memberId,
        role: body.role,
      });
      return c.json(squadMemberCompatibilityResponse(member), 201);
    } catch (error) {
      return squadCompatibilityErrorResponse(c, error);
    }
  });
  app.patch("/api/squads/:id/members/role", async (c) => {
    const actorDenied = humanOnly(c);
    if (actorDenied) return actorDenied;
    const squad = store.getSquad(c.req.param("id"));
    if (!squad || squad.workspaceId !== compatibilityWorkspaceId(c)) return c.json({ error: "squad not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, squad.workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<{ member_type?: string; member_id?: string; role?: string }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const memberType = cleanString(body.member_type);
    const memberId = cleanString(body.member_id);
    if (memberType !== "agent" && memberType !== "member") return c.json({ error: "member_type must be 'agent' or 'member'" }, 400);
    if (!memberId) return c.json({ error: "member_id is required" }, 400);
    try {
      const member = store.addSquadMember(c.req.param("id"), {
        memberType,
        memberId,
        role: body.role,
      });
      return c.json(squadMemberCompatibilityResponse(member));
    } catch (error) {
      return squadCompatibilityErrorResponse(c, error);
    }
  });
  app.delete("/api/squads/:id/members", async (c) => {
    const actorDenied = humanOnly(c);
    if (actorDenied) return actorDenied;
    const squad = store.getSquad(c.req.param("id"));
    if (!squad || squad.workspaceId !== compatibilityWorkspaceId(c)) return c.json({ error: "squad not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, squad.workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<{ member_type?: string; member_id?: string }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const memberType = cleanString(body.member_type);
    const memberId = cleanString(body.member_id);
    if (memberType !== "agent" && memberType !== "member") return c.json({ error: "member_type must be 'agent' or 'member'" }, 400);
    if (!memberId) return c.json({ error: "member_id is required" }, 400);
    store.removeSquadMember(c.req.param("id"), {
      memberType,
      memberId,
    });
    return c.body(null, 204);
  });
}
