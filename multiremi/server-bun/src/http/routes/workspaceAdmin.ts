/**
 * Workspace admin routes — port of the Go workspace settings write path
 * (server/internal/handler/workspace.go, wired in cmd/server/router.go):
 *
 *   GET    /api/workspaces/:id                    GetWorkspace    (member)
 *   PATCH  /api/workspaces/:id                    UpdateWorkspace (owner/admin)
 *   PUT    /api/workspaces/:id                    UpdateWorkspace (Go wires both verbs)
 *   DELETE /api/workspaces/:id                    DeleteWorkspace (owner only)
 *   POST   /api/workspaces/:id/leave              LeaveWorkspace  (member; last-owner guard)
 *   PATCH  /api/workspaces/:id/members/:memberId  UpdateMember    (owner/admin; any owner-role
 *                                                 transition — either direction — needs owner)
 *   DELETE /api/workspaces/:id/members/:memberId  DeleteMember    (owner/admin; owner target
 *                                                 needs owner; last-owner guard)
 *
 * NOT here (already implemented elsewhere): GET+POST /api/workspaces
 * (workspaces.ts), GET /api/workspaces/:id/members (members.ts), and
 * POST /api/workspaces/:id/members — which creates an *invitation* in the Go
 * router, ported in invitations.ts.
 *
 * The :id URL param is UUID-only, exactly like Go: RequireWorkspace*FromURL
 * feeds chi.URLParam straight into util.ParseUUID (400 "invalid workspace_id"
 * on anything else); slugs resolve only via the X-Workspace-Slug header on
 * header-routed endpoints, never via this param.
 *
 * Member removal (kick + leave) runs the Go revocation transaction
 * (workspace_revoke.go): the leaver's runtimes go offline, agents pinned to
 * them are archived, their active tasks are cancelled, daemon tokens deleted,
 * member row removed — all-or-nothing — then the post-commit events fan out
 * in Go's order (task:cancelled → agent:archived → daemon:register).
 *
 * Behind the /api/* JWT gate. Paths are absolute so this factory mounts at "/".
 * Responses use the Go structs' snake_case field names.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import type { Agent, Member, User, Workspace } from "../../db/schema.js";
import { getMembership } from "../../db/queries/members.js";
import {
  countOwners,
  deleteWorkspaceById,
  getMemberById,
  getUserById,
  getWorkspaceById,
  listMembers,
  revokeAndRemoveMember,
  updateMemberRole,
  updateWorkspace,
  type RevocationResult,
  type UpdateWorkspacePatch,
} from "../../db/queries/workspaceAdmin.js";
import { bus } from "../../realtime/bus.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Mirrors Go WorkspaceResponse (workspace.go) — snake_case JSON; settings
 * defaults to {} and repos to [] when null (Go unmarshals nil → {} / []).
 */
function workspaceToResponse(ws: Workspace) {
  return {
    id: ws.id,
    name: ws.name,
    slug: ws.slug,
    description: ws.description,
    context: ws.context,
    settings: ws.settings ?? {},
    repos: ws.repos ?? [],
    issue_prefix: ws.issuePrefix,
    avatar_url: ws.avatarUrl,
    created_at: ws.createdAt,
    updated_at: ws.updatedAt,
  };
}

/** Mirrors Go memberWithUserResponse (workspace.go) — snake_case JSON. */
function memberWithUserToResponse(m: Member, u: User) {
  return {
    id: m.id,
    workspace_id: m.workspaceId,
    user_id: m.userId,
    role: m.role,
    created_at: m.createdAt,
    name: u.name,
    email: u.email,
    avatar_url: u.avatarUrl,
  };
}

/**
 * Compact port of Go's agentToResponse for the agent:archived event payload
 * (custom_env values never cross the wire — key count only, MUL-2600; the
 * archived agent carries no skills in the event, matching the Go publish).
 */
function archivedAgentToResponse(a: Agent) {
  const envKeyCount =
    a.customEnv && typeof a.customEnv === "object" && !Array.isArray(a.customEnv)
      ? Object.keys(a.customEnv as Record<string, unknown>).length
      : 0;
  return {
    id: a.id,
    workspace_id: a.workspaceId,
    runtime_id: a.runtimeId,
    name: a.name,
    description: a.description,
    instructions: a.instructions,
    avatar_url: a.avatarUrl,
    runtime_mode: a.runtimeMode,
    runtime_config: a.runtimeConfig && typeof a.runtimeConfig === "object" ? a.runtimeConfig : {},
    custom_args: Array.isArray(a.customArgs) ? a.customArgs : [],
    mcp_config: a.mcpConfig ?? null,
    has_custom_env: envKeyCount > 0,
    custom_env_key_count: envKeyCount,
    mcp_config_redacted: false,
    visibility: a.visibility,
    status: a.status,
    max_concurrent_tasks: a.maxConcurrentTasks,
    model: a.model ?? "",
    thinking_level: a.thinkingLevel ?? "",
    owner_id: a.ownerId,
    skills: [],
    created_at: a.createdAt,
    updated_at: a.updatedAt,
    archived_at: a.archivedAt,
    archived_by: a.archivedBy,
  };
}

/**
 * Mirrors Go normalizeMemberRole: empty defaults to "member",
 * owner/admin/member pass through, anything else is invalid (null).
 */
function normalizeMemberRole(role: string): string | null {
  if (role === "") return "member";
  const r = role.trim();
  if (r === "owner" || r === "admin" || r === "member") return r;
  return null;
}

/**
 * Resolve + authorize the workspace from the :id URL param. Mirrors Go's
 * RequireWorkspaceMemberFromURL / RequireWorkspaceRoleFromURL chain:
 * malformed UUID → 400 "invalid workspace_id"; no membership row → 404
 * "workspace not found"; role not allowed → 403 "insufficient permissions".
 * Returns the requester's full member row (leave needs id/userId).
 */
async function requireWorkspaceMember(
  c: Context<AppEnv>,
  db: Db,
  roles?: readonly string[],
): Promise<Member | Response> {
  const wsId = c.req.param("id");
  if (!wsId || !UUID_RE.test(wsId)) {
    return c.json({ error: "invalid workspace_id" }, 400);
  }
  const m = await getMembership(db, c.get("user").sub, wsId);
  if (!m) return c.json({ error: "workspace not found" }, 404);
  if (roles && !roles.includes(m.role)) {
    return c.json({ error: "insufficient permissions" }, 403);
  }
  return m;
}

/**
 * Post-commit revocation fanout, in Go publishRevocation's order: per-task
 * task:cancelled first, then agent:archived per agent, then one
 * daemon:register {action:"revoke"} so clients refresh the runtime list.
 */
function publishRevocation(result: RevocationResult, wsId: string): void {
  for (const t of result.cancelledTasks) {
    const payload: Record<string, unknown> = {
      task_id: t.id,
      agent_id: t.agentId,
      issue_id: t.issueId ?? "",
      status: t.status,
    };
    if (t.chatSessionId) payload.chat_session_id = t.chatSessionId;
    bus.publish({ type: "task:cancelled", workspaceId: wsId, payload });
  }
  for (const a of result.archivedAgents) {
    bus.publish({
      type: "agent:archived",
      workspaceId: wsId,
      payload: { agent: archivedAgentToResponse(a) },
    });
  }
  if (result.offlineRuntimeIds.length > 0) {
    bus.publish({ type: "daemon:register", workspaceId: wsId, payload: { action: "revoke" } });
  }
}

/** Fields of UpdateWorkspaceRequest that Go decodes into *string. */
const STRING_FIELDS = ["name", "description", "context", "issue_prefix", "avatar_url"] as const;

export function workspaceAdminRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // GET /api/workspaces/:id — member-level (Go GetWorkspace).
  r.get("/api/workspaces/:id", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const gate = await requireWorkspaceMember(c, db);
    if (gate instanceof Response) return gate;
    const ws = await getWorkspaceById(db, gate.workspaceId);
    if (!ws) return c.json({ error: "workspace not found" }, 404);
    return c.json(workspaceToResponse(ws));
  });

  // PATCH + PUT /api/workspaces/:id — owner/admin (Go UpdateWorkspace; the Go
  // router wires both verbs to the same handler).
  const update = async (c: Context<AppEnv>) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const gate = await requireWorkspaceMember(c, db, ["owner", "admin"]);
    if (gate instanceof Response) return gate;

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }
    // Go decodes these into *string: a present non-null non-string value fails
    // the whole decode → 400. JSON null → nil pointer → "leave unchanged".
    for (const f of STRING_FIELDS) {
      if (f in body && body[f] !== null && typeof body[f] !== "string") {
        return c.json({ error: "invalid request body" }, 400);
      }
    }

    const patch: UpdateWorkspacePatch = {};
    if (typeof body.name === "string") {
      const name = body.name.trim();
      if (name === "") return c.json({ error: "name is required" }, 400);
      patch.name = name;
    }
    if (typeof body.description === "string") patch.description = body.description;
    if (typeof body.context === "string") patch.context = body.context;
    if (body.settings !== undefined && body.settings !== null) patch.settings = body.settings;
    if (body.repos !== undefined && body.repos !== null) patch.repos = body.repos;
    if (typeof body.issue_prefix === "string") {
      // Go: uppercase + trim; an empty result is silently skipped (not an error).
      const prefix = body.issue_prefix.trim().toUpperCase();
      if (prefix !== "") patch.issuePrefix = prefix;
    }
    if (typeof body.avatar_url === "string") patch.avatarUrl = body.avatar_url;

    const ws = await updateWorkspace(db, gate.workspaceId, patch);
    if (!ws) return c.json({ error: "failed to update workspace" }, 500);

    const resp = workspaceToResponse(ws);
    bus.publish({ type: "workspace:updated", workspaceId: ws.id, payload: { workspace: resp } });
    return c.json(resp);
  };
  r.patch("/api/workspaces/:id", update);
  r.put("/api/workspaces/:id", update);

  // DELETE /api/workspaces/:id — owner only (Go DeleteWorkspace; the route is
  // gated RequireWorkspaceRoleFromURL("owner") and the handler re-checks).
  r.delete("/api/workspaces/:id", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const gate = await requireWorkspaceMember(c, db, ["owner"]);
    if (gate instanceof Response) return gate;
    await deleteWorkspaceById(db, gate.workspaceId);
    bus.publish({
      type: "workspace:deleted",
      workspaceId: gate.workspaceId,
      payload: { workspace_id: gate.workspaceId },
    });
    return c.body(null, 204);
  });

  // POST /api/workspaces/:id/leave — member-level (Go LeaveWorkspace).
  r.post("/api/workspaces/:id/leave", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const gate = await requireWorkspaceMember(c, db);
    if (gate instanceof Response) return gate;

    // Last-owner guard: an owner may leave only if another owner remains.
    if (gate.role === "owner") {
      const members = await listMembers(db, gate.workspaceId);
      if (countOwners(members) <= 1) {
        return c.json({ error: "workspace must have at least one owner" }, 400);
      }
    }

    // archivedBy = the leaver themselves.
    const result = await revokeAndRemoveMember(db, {
      workspaceId: gate.workspaceId,
      userId: gate.userId,
      memberId: gate.id,
      archivedBy: gate.userId,
    });
    publishRevocation(result, gate.workspaceId);
    bus.publish({
      type: "member:removed",
      workspaceId: gate.workspaceId,
      payload: { member_id: gate.id, workspace_id: gate.workspaceId, user_id: gate.userId },
    });
    return c.body(null, 204);
  });

  // PATCH /api/workspaces/:id/members/:memberId — owner/admin (Go UpdateMember).
  r.patch("/api/workspaces/:id/members/:memberId", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const gate = await requireWorkspaceMember(c, db, ["owner", "admin"]);
    if (gate instanceof Response) return gate;

    const memberId = c.req.param("memberId");
    if (!UUID_RE.test(memberId)) return c.json({ error: "invalid member id" }, 400);
    const target = await getMemberById(db, memberId);
    if (!target || target.workspaceId !== gate.workspaceId) {
      return c.json({ error: "member not found" }, 404);
    }

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }
    if ("role" in body && body.role !== null && typeof body.role !== "string") {
      return c.json({ error: "invalid request body" }, 400);
    }
    const rawRole = typeof body.role === "string" ? body.role : "";
    if (rawRole.trim() === "") return c.json({ error: "role is required" }, 400);
    const role = normalizeMemberRole(rawRole);
    if (role === null) return c.json({ error: "invalid member role" }, 400);

    // Any owner-role transition — promoting to owner OR touching an owner —
    // requires the requester to be an owner (admins manage admin/member only).
    if ((target.role === "owner" || role === "owner") && gate.role !== "owner") {
      return c.json({ error: "insufficient permissions" }, 403);
    }
    // Demoting an owner must never leave the workspace ownerless.
    if (target.role === "owner" && role !== "owner") {
      const members = await listMembers(db, target.workspaceId);
      if (countOwners(members) <= 1) {
        return c.json({ error: "workspace must have at least one owner" }, 400);
      }
    }

    const updated = await updateMemberRole(db, target.id, role);
    if (!updated) return c.json({ error: "failed to update member" }, 500);
    const u = await getUserById(db, updated.userId);
    if (!u) return c.json({ error: "failed to load member" }, 500);

    const resp = memberWithUserToResponse(updated, u);
    bus.publish({ type: "member:updated", workspaceId: gate.workspaceId, payload: { member: resp } });
    return c.json(resp);
  });

  // DELETE /api/workspaces/:id/members/:memberId — owner/admin (Go DeleteMember).
  r.delete("/api/workspaces/:id/members/:memberId", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const gate = await requireWorkspaceMember(c, db, ["owner", "admin"]);
    if (gate instanceof Response) return gate;

    const memberId = c.req.param("memberId");
    if (!UUID_RE.test(memberId)) return c.json({ error: "invalid member id" }, 400);
    const target = await getMemberById(db, memberId);
    if (!target || target.workspaceId !== gate.workspaceId) {
      return c.json({ error: "member not found" }, 404);
    }

    // Kicking an owner requires an owner.
    if (target.role === "owner" && gate.role !== "owner") {
      return c.json({ error: "insufficient permissions" }, 403);
    }
    // Removing an owner must never leave the workspace ownerless.
    if (target.role === "owner") {
      const members = await listMembers(db, target.workspaceId);
      if (countOwners(members) <= 1) {
        return c.json({ error: "workspace must have at least one owner" }, 400);
      }
    }

    // archivedBy = the requester doing the kick.
    const result = await revokeAndRemoveMember(db, {
      workspaceId: target.workspaceId,
      userId: target.userId,
      memberId: target.id,
      archivedBy: c.get("user").sub,
    });
    publishRevocation(result, gate.workspaceId);
    bus.publish({
      type: "member:removed",
      workspaceId: gate.workspaceId,
      payload: { member_id: target.id, workspace_id: gate.workspaceId, user_id: target.userId },
    });
    return c.body(null, 204);
  });

  return r;
}
