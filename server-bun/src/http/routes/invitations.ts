/**
 * Invitation routes — port of the Go invitation handler
 * (server/internal/handler/invitation.go), registered in cmd/server/router.go.
 *
 * Workspace-scoped (admin path; workspace from the URL param like the Go routes,
 * owner/admin only):
 *   POST   /api/workspaces/:id/members              CreateInvitation
 *   GET    /api/workspaces/:id/invitations          ListWorkspaceInvitations
 *   DELETE /api/workspaces/:id/invitations/:invitationId  RevokeInvitation
 *
 * User-scoped (invitee path; current user from the JWT):
 *   GET    /api/invitations                         ListMyInvitations
 *   GET    /api/invitations/:id                     GetMyInvitation
 *   POST   /api/invitations/:id/accept              AcceptInvitation
 *   POST   /api/invitations/:id/decline             DeclineInvitation
 *
 * Behind the /api/* JWT gate. Paths are absolute so this factory mounts at "/".
 * Responses use the Go struct's snake_case field names.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import {
  acceptInvitation,
  createInvitation,
  declineInvitation,
  expireStalePendingInvitations,
  getInvitation,
  getMembership,
  getPendingInvitationByEmail,
  getUserByEmail,
  getUserById,
  getWorkspaceName,
  listPendingInvitationsByWorkspace,
  listPendingInvitationsForUser,
  revokeInvitation,
  type InvitationForUser,
  type InvitationWithInviter,
  type MemberWithUser,
  type WorkspaceInvitation,
} from "../../db/queries/invitations.js";
import { bus } from "../../realtime/bus.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mirrors Go InvitationResponse — snake_case, with optional enriched fields. */
function invitationToResponse(
  inv: WorkspaceInvitation,
  extra?: { workspaceName?: string; inviterName?: string; inviterEmail?: string },
) {
  const resp: Record<string, unknown> = {
    id: inv.id,
    workspace_id: inv.workspaceId,
    inviter_id: inv.inviterId,
    invitee_email: inv.inviteeEmail,
    invitee_user_id: inv.inviteeUserId,
    role: inv.role,
    status: inv.status,
    created_at: inv.createdAt,
    updated_at: inv.updatedAt,
    expires_at: inv.expiresAt,
  };
  // omitempty: only present when non-empty (matches Go's `,omitempty`).
  if (extra?.inviterName) resp.inviter_name = extra.inviterName;
  if (extra?.inviterEmail) resp.inviter_email = extra.inviterEmail;
  if (extra?.workspaceName) resp.workspace_name = extra.workspaceName;
  return resp;
}

function enrichedToResponse(row: InvitationWithInviter | InvitationForUser) {
  return invitationToResponse(row, {
    inviterName: row.inviterName,
    inviterEmail: row.inviterEmail,
    workspaceName: "workspaceName" in row ? row.workspaceName : undefined,
  });
}

function memberToResponse(m: MemberWithUser) {
  return {
    id: m.id,
    workspace_id: m.workspaceId,
    user_id: m.userId,
    role: m.role,
    created_at: m.createdAt,
    name: m.userName,
    email: m.userEmail,
    avatar_url: m.userAvatarUrl,
  };
}

/**
 * Normalize an invitation role. Empty defaults to "member". "owner" is invalid
 * for an invitation (Go rejects it explicitly; the DB CHECK only allows
 * admin/member). Returns null for any invalid role.
 */
function normalizeInviteRole(role: unknown): string | null {
  const r = typeof role === "string" ? role.trim() : "";
  if (r === "") return "member";
  if (r === "admin" || r === "member") return r;
  return null;
}

/**
 * Resolve + authorize the workspace from the URL param (Go's
 * RequireWorkspaceMemberFromURL). Returns the requester's membership row, or a
 * Response to short-circuit with (400 malformed id, 404 not-a-member). When
 * `roles` is given, also enforces the role (Go's RequireWorkspaceRoleFromURL →
 * 403 on insufficient role).
 */
async function requireWorkspaceMember(
  c: Context<AppEnv>,
  db: Db,
  roles?: readonly string[],
): Promise<{ wsId: string; role: string } | Response> {
  const wsId = c.req.param("id");
  if (!wsId || !UUID_RE.test(wsId)) {
    return c.json({ error: "workspace id is required" }, 400);
  }
  const m = await getMembership(db, c.get("user").sub, wsId);
  if (!m) return c.json({ error: "workspace not found" }, 404);
  if (roles && !roles.includes(m.role)) {
    return c.json({ error: "insufficient permissions" }, 403);
  }
  return { wsId, role: m.role };
}

/**
 * Confirm the invitation is addressed to the current user (Go's check:
 * lower(user.email) === invitee_email OR invitee_user_id === userId).
 */
function belongsToUser(
  inv: WorkspaceInvitation,
  u: { id: string; email: string },
): boolean {
  return u.email.toLowerCase() === inv.inviteeEmail || inv.inviteeUserId === u.id;
}

export function invitationRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // -- Workspace-scoped (admin) --------------------------------------------

  // POST /api/workspaces/:id/members — create an invitation (owner/admin).
  r.post("/api/workspaces/:id/members", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const gate = await requireWorkspaceMember(c, db, ["owner", "admin"]);
    if (gate instanceof Response) return gate;
    const { wsId } = gate;

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }

    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email) return c.json({ error: "email is required" }, 400);

    const role = normalizeInviteRole(body.role);
    if (role === null) {
      // "owner" lands here too (Go: "cannot invite as owner" vs "invalid role"),
      // both 400 — collapse to one message since the DB CHECK is identical.
      return c.json({ error: "invalid member role" }, 400);
    }

    // Already a member?
    const existing = await getUserByEmail(db, email);
    if (existing) {
      const m = await getMembership(db, existing.id, wsId);
      if (m) return c.json({ error: "user is already a member" }, 409);
    }

    // Clear stale past-due pending rows before the unique-pending check (#2055).
    await expireStalePendingInvitations(db, wsId, email);

    const pending = await getPendingInvitationByEmail(db, wsId, email);
    if (pending) {
      return c.json({ error: "invitation already pending for this email" }, 409);
    }

    let inv: WorkspaceInvitation;
    try {
      inv = await createInvitation(db, {
        workspaceId: wsId,
        inviterId: c.get("user").sub,
        inviteeEmail: email,
        inviteeUserId: existing?.id ?? null,
        role,
      });
    } catch (err) {
      // Unique violation on idx_invitation_unique_pending → race with a
      // concurrent create (Postgres error code 23505).
      if ((err as { code?: string }).code === "23505") {
        return c.json({ error: "invitation already pending for this email" }, 409);
      }
      throw err;
    }

    const workspaceName = await getWorkspaceName(db, wsId);
    bus.publish({
      type: "invitation.created",
      workspaceId: wsId,
      payload: { id: inv.id },
    });

    return c.json(
      invitationToResponse(inv, { workspaceName: workspaceName ?? undefined }),
      201,
    );
  });

  // GET /api/workspaces/:id/invitations — pending invitations (member-level).
  r.get("/api/workspaces/:id/invitations", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const gate = await requireWorkspaceMember(c, db);
    if (gate instanceof Response) return gate;
    const rows = await listPendingInvitationsByWorkspace(db, gate.wsId);
    return c.json(rows.map(enrichedToResponse));
  });

  // DELETE /api/workspaces/:id/invitations/:invitationId — revoke (owner/admin).
  r.delete("/api/workspaces/:id/invitations/:invitationId", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const gate = await requireWorkspaceMember(c, db, ["owner", "admin"]);
    if (gate instanceof Response) return gate;

    const invitationId = c.req.param("invitationId");
    if (!UUID_RE.test(invitationId)) {
      return c.json({ error: "invitation id is required" }, 400);
    }
    const inv = await getInvitation(db, invitationId);
    if (!inv || inv.workspaceId !== gate.wsId || inv.status !== "pending") {
      return c.json({ error: "invitation not found" }, 404);
    }

    await revokeInvitation(db, inv.id);
    bus.publish({
      type: "invitation.revoked",
      workspaceId: gate.wsId,
      payload: { id: inv.id, invitee_email: inv.inviteeEmail },
    });
    return c.body(null, 204);
  });

  // -- User-scoped (invitee) -----------------------------------------------

  // GET /api/invitations — current user's pending invitations, all workspaces.
  r.get("/api/invitations", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const u = await getUserById(db, c.get("user").sub);
    if (!u) return c.json({ error: "failed to load user" }, 500);
    const rows = await listPendingInvitationsForUser(db, u.id, u.email);
    return c.json(rows.map(enrichedToResponse));
  });

  // GET /api/invitations/:id — a single invitation (for the accept page).
  r.get("/api/invitations/:id", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invitation id is required" }, 400);
    const inv = await getInvitation(db, id);
    if (!inv) return c.json({ error: "invitation not found" }, 404);

    const u = await getUserById(db, c.get("user").sub);
    if (!u) return c.json({ error: "failed to load user" }, 500);
    if (!belongsToUser(inv, u)) {
      return c.json({ error: "invitation does not belong to you" }, 403);
    }

    const workspaceName = await getWorkspaceName(db, inv.workspaceId);
    const inviter = await getUserById(db, inv.inviterId);
    return c.json(
      invitationToResponse(inv, {
        workspaceName: workspaceName ?? undefined,
        inviterName: inviter?.name,
        inviterEmail: inviter?.email,
      }),
    );
  });

  // POST /api/invitations/:id/accept — accept; inserts a member row.
  r.post("/api/invitations/:id/accept", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invitation id is required" }, 400);
    const inv = await getInvitation(db, id);
    if (!inv) return c.json({ error: "invitation not found" }, 404);

    const u = await getUserById(db, c.get("user").sub);
    if (!u) return c.json({ error: "failed to load user" }, 500);
    if (!belongsToUser(inv, u)) {
      return c.json({ error: "invitation does not belong to you" }, 403);
    }
    if (inv.status !== "pending") {
      return c.json({ error: "invitation is not pending" }, 400);
    }
    if (inv.expiresAt && new Date(inv.expiresAt).getTime() < Date.now()) {
      return c.json({ error: "invitation has expired" }, 410);
    }

    let result;
    try {
      result = await acceptInvitation(db, inv, u);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        return c.json({ error: "you are already a member of this workspace" }, 409);
      }
      throw err;
    }

    const wsId = result.invitation.workspaceId;
    const memberResp = memberToResponse(result.member);
    bus.publish({ type: "member.added", workspaceId: wsId, payload: { member: memberResp } });
    bus.publish({
      type: "invitation.accepted",
      workspaceId: wsId,
      payload: { invitation_id: result.invitation.id, member: memberResp },
    });
    return c.json(memberResp);
  });

  // POST /api/invitations/:id/decline — decline.
  r.post("/api/invitations/:id/decline", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invitation id is required" }, 400);
    const inv = await getInvitation(db, id);
    if (!inv) return c.json({ error: "invitation not found" }, 404);

    const u = await getUserById(db, c.get("user").sub);
    if (!u) return c.json({ error: "failed to load user" }, 500);
    if (!belongsToUser(inv, u)) {
      return c.json({ error: "invitation does not belong to you" }, 403);
    }
    if (inv.status !== "pending") {
      return c.json({ error: "invitation is not pending" }, 400);
    }

    const declined = await declineInvitation(db, inv.id);
    if (declined) {
      bus.publish({
        type: "invitation.declined",
        workspaceId: declined.workspaceId,
        payload: { invitation_id: declined.id, invitee_email: declined.inviteeEmail },
      });
    }
    return c.body(null, 204);
  });

  return r;
}
