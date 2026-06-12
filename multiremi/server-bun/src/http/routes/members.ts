/**
 * Member routes (read path) — port of the Go member handler's join read path.
 *
 *   GET /api/workspaces/:id/members  — the canonical Go route
 *     (server cmd/server/router.go → h.ListMembersWithUser), workspace from the
 *     URL param, member-level access.
 *   GET /api/members                 — the same listing, but the workspace is
 *     taken from the X-Workspace-ID header (mirrors the header-routing
 *     convention used by the other /api/* read handlers).
 *
 * Both are behind the /api/* JWT gate and require the caller to be a member of
 * the target workspace (multi-tenancy). Both return the joined
 * MemberWithUserResponse shape with the Go struct's snake_case JSON field names.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import { getMembership, listMembersWithUser, type MemberWithUser } from "../../db/queries/members.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mirrors Go's MemberWithUserResponse (workspace.go) — snake_case JSON. */
function memberWithUserToResponse(m: MemberWithUser) {
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
 * Resolve + authorize a workspace by a candidate id (header or URL param).
 * Returns the validated workspace UUID, or a Response to short-circuit with
 * (400 missing/malformed, 404 not-a-member) — mirrors the Go workspace-member
 * gate (RequireWorkspaceMemberFromURL → 404 on a missing membership row).
 */
async function requireWorkspaceId(
  c: Context<AppEnv>,
  db: Db,
  candidate: string | undefined,
  missingMsg: string,
): Promise<string | Response> {
  if (!candidate || !UUID_RE.test(candidate)) {
    return c.json({ error: missingMsg }, 400);
  }
  const m = await getMembership(db, c.get("user").sub, candidate);
  if (!m) return c.json({ error: "workspace not found" }, 404);
  return candidate;
}

export function memberRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // Canonical Go route: workspace from the URL param, member-level access.
  r.get("/api/workspaces/:id/members", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspaceId(c, db, c.req.param("id"), "workspace id is required");
    if (ws instanceof Response) return ws;
    const members = await listMembersWithUser(db, ws);
    return c.json(members.map(memberWithUserToResponse));
  });

  // Header-routed variant: workspace from X-Workspace-ID (or the wsId the
  // app-level middleware resolved from X-Workspace-Slug / ?workspace_id).
  r.get("/api/members", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspaceId(
      c,
      db,
      c.req.header("X-Workspace-ID") ?? c.get("wsId"),
      "X-Workspace-ID header required",
    );
    if (ws instanceof Response) return ws;
    const members = await listMembersWithUser(db, ws);
    return c.json(members.map(memberWithUserToResponse));
  });

  return r;
}
