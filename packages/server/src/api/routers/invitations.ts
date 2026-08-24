import type { Hono } from "hono";
import {
  loadCurrentWorkspaceMember,
  loadCurrentWorkspaceRole,
  publishWorkspaceEvent,
  safeAcceptInvitation,
  safeDeclineInvitation,
} from "../helpers.js";
import {
  acceptedInvitationMemberToGoResponse,
  authenticatedRequestUserId,
  currentRequestUserId,
  isMemberResponseError,
  workspaceNamePayload,
} from "../wire/index.js";
import type { RouterDeps } from "./deps.js";

export function registerInvitationRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;

  app.get("/api/workspaces/:id/invitations", (c) => {
    const requester = loadCurrentWorkspaceMember(c, store, c.req.param("id"));
    if (requester instanceof Response) return requester;
    return c.json(store.listWorkspaceInvitations(c.req.param("id")));
  });

  app.delete("/api/workspaces/:id/invitations/:invitationId", (c) => {
    const requester = loadCurrentWorkspaceRole(c, store, c.req.param("id"), ["owner", "admin"]);
    if (requester instanceof Response) return requester;
    const invitation = store.getInvitation(c.req.param("invitationId"));
    const revoked = store.revokeWorkspaceInvitation(c.req.param("id"), c.req.param("invitationId"));
    if (!revoked) return c.json({ error: "invitation not found" }, 404);
    publishWorkspaceEvent(c, store, "invitation:revoked", c.req.param("id"), {
      invitation_id: c.req.param("invitationId"),
      invitee_email: invitation?.inviteeEmail ?? null,
      invitee_user_id: invitation?.inviteeUserId ?? null,
    });
    return c.body(null, 204);
  });
  app.get("/api/invitations", (c) => c.json(store.listCurrentUserInvitations(currentRequestUserId(c))));
  app.get("/api/invitations/:id", (c) => {
    const invitation = store.getInvitation(c.req.param("id"));
    if (!invitation) return c.json({ error: "invitation not found" }, 404);
    const userId = authenticatedRequestUserId(c);
    const user = userId ? store.getUser(userId) : null;
    const isInvitee = userId !== null && (
      invitation.inviteeUserId === userId
      || invitation.inviteeEmail === user?.email.toLowerCase()
    );
    const isWorkspaceMember = userId !== null && store.getUserRoleInWorkspace(userId, invitation.workspaceId) !== null;
    if (userId !== null && !isInvitee && !isWorkspaceMember) return c.json({ error: "invitation not found" }, 404);
    return c.json(invitation);
  });
  app.post("/api/invitations/:id/accept", (c) => {
    const result = safeAcceptInvitation(store, c.req.param("id"), currentRequestUserId(c));
    if ("error" in result) return c.json({ error: result.error }, result.status);
    const member = acceptedInvitationMemberToGoResponse(store, result);
    if (isMemberResponseError(member)) return c.json({ error: member.error }, member.status);
    publishWorkspaceEvent(c, store, "member:added", result.workspaceId, {
      member,
      ...workspaceNamePayload(store, result.workspaceId),
    });
    publishWorkspaceEvent(c, store, "invitation:accepted", result.workspaceId, {
      invitation_id: result.id,
      member,
    });
    return c.json(member);
  });
  app.post("/api/invitations/:id/decline", (c) => {
    const result = safeDeclineInvitation(store, c.req.param("id"), currentRequestUserId(c));
    if ("error" in result) return c.json({ error: result.error }, result.status);
    publishWorkspaceEvent(c, store, "invitation:declined", result.workspaceId, {
      invitation_id: result.id,
      invitee_email: result.inviteeEmail,
    });
    return c.body(null, 204);
  });
}
