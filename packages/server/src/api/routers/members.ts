import type { Hono } from "hono";
import {
  denyCurrentUserWorkspaceAccess,
  loadCurrentWorkspaceMember,
  loadCurrentWorkspaceRole,
  normalizeGoWorkspaceMemberRole,
  publishWorkspaceEvent,
  readJson,
  requireWorkspaceAdmin,
  safeArchiveWorkspaceMember,
  safeCreateInvitation,
  safeUpdateWorkspaceMember,
} from "../helpers.js";
import { currentRequestUserId, memberRemovedPayload, workspaceMemberToGoResponse, workspaceNamePayload } from "../wire/index.js";
import type { CreateWorkspaceMemberInput, UpdateWorkspaceMemberInput } from "@multiremi/contracts/types.js";
import type { RouterDeps } from "./deps.js";

export function registerMemberRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;

  app.get("/api/workspaces/:id/members", (c) => {
    const workspaceId = c.req.param("id");
    const requester = loadCurrentWorkspaceMember(c, store, workspaceId);
    if (requester instanceof Response) return requester;
    return c.json(store.listWorkspaceMembers(workspaceId).map((member) => workspaceMemberToGoResponse(member, { includeName: true })));
  });
  app.patch("/api/workspaces/:id/members/:memberId", async (c) => {
    const workspaceId = c.req.param("id");
    const requester = loadCurrentWorkspaceRole(c, store, workspaceId, ["owner", "admin"]);
    if (requester instanceof Response) return requester;
    const member = store.getWorkspaceMember(c.req.param("memberId"));
    if (!member || member.workspaceId !== workspaceId) return c.json({ error: "member not found" }, 404);
    const body = await readJson<UpdateWorkspaceMemberInput>(c);
    const role = normalizeGoWorkspaceMemberRole(body.role);
    if ("error" in role) return c.json({ error: role.error }, 400);
    if ((member.role === "owner" || role.role === "owner") && requester.member.role !== "owner") {
      return c.json({ error: "insufficient permissions" }, 403);
    }
    const updated = safeUpdateWorkspaceMember(store, c.req.param("memberId"), { ...body, role: role.role });
    if ("error" in updated) return c.json({ error: updated.error }, updated.status);
    const response = workspaceMemberToGoResponse(updated, { includeUser: true });
    publishWorkspaceEvent(c, store, "member:updated", workspaceId, { member: response });
    return c.json(response);
  });
  app.delete("/api/workspaces/:id/members/:memberId", (c) => {
    const workspaceId = c.req.param("id");
    const requester = loadCurrentWorkspaceRole(c, store, workspaceId, ["owner", "admin"]);
    if (requester instanceof Response) return requester;
    const member = store.getWorkspaceMember(c.req.param("memberId"));
    if (!member || member.workspaceId !== workspaceId) return c.json({ error: "member not found" }, 404);
    if (member.role === "owner" && requester.member.role !== "owner") {
      return c.json({ error: "insufficient permissions" }, 403);
    }
    const archived = safeArchiveWorkspaceMember(store, c.req.param("memberId"));
    if ("error" in archived) return c.json({ error: archived.error }, archived.status);
    publishWorkspaceEvent(c, store, "member:removed", workspaceId, memberRemovedPayload(member));
    return c.body(null, 204);
  });
  app.post("/api/workspaces/:id/members", async (c) => {
    const requester = loadCurrentWorkspaceRole(c, store, c.req.param("id"), ["owner", "admin"]);
    if (requester instanceof Response) return requester;
    const body = await readJson<any>(c);
    const result = safeCreateInvitation(store, c.req.param("id"), body, currentRequestUserId(c));
    if ("error" in result) return c.json({ error: result.error }, result.status);
    publishWorkspaceEvent(c, store, "invitation:created", c.req.param("id"), {
      invitation: result,
      ...workspaceNamePayload(store, c.req.param("id")),
    });
    return c.json(result, 201);
  });

  app.get("/api/multiremi/members", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const members = store.listWorkspaceMembers(workspaceId);
    return c.json({ members, total: members.length });
  });
  app.post("/api/multiremi/members", async (c) => {
    const body = await readJson<CreateWorkspaceMemberInput>(c);
    const workspaceId = body.workspaceId ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId)
      ?? requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    return c.json({ member: store.createWorkspaceMember(body) }, 201);
  });
  app.get("/api/multiremi/members/:id", (c) => {
    const member = store.getWorkspaceMember(c.req.param("id"));
    if (!member) return c.json({ error: "member not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, member.workspaceId);
    if (denied) return denied;
    return c.json({ member });
  });
  app.patch("/api/multiremi/members/:id", async (c) => {
    const current = store.getWorkspaceMember(c.req.param("id"));
    if (!current) return c.json({ error: "member not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, current.workspaceId)
      ?? requireWorkspaceAdmin(c, store, current.workspaceId);
    if (denied) return denied;
    const body = await readJson<UpdateWorkspaceMemberInput>(c);
    const member = safeUpdateWorkspaceMember(store, c.req.param("id"), body);
    if ("error" in member) return c.json({ error: member.error }, member.status);
    return c.json({ member });
  });
  app.delete("/api/multiremi/members/:id", (c) => {
    const current = store.getWorkspaceMember(c.req.param("id"));
    if (!current) return c.json({ error: "member not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, current.workspaceId)
      ?? requireWorkspaceAdmin(c, store, current.workspaceId);
    if (denied) return denied;
    const member = safeArchiveWorkspaceMember(store, c.req.param("id"));
    if ("error" in member) return c.json({ error: member.error }, member.status);
    return c.json({ member });
  });
}
