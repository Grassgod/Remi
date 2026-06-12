/**
 * Squad routes (read path) — port of the Go squad handler's GET /api/squads
 * (list) and GET /api/squads/{id} (get). Behind the /api/* JWT gate; scoped to
 * a workspace via the X-Workspace-ID header + a membership check (multi-tenancy).
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import { getMembership } from "../../db/queries/issues.js";
import { getAgentInWorkspace } from "../../db/queries/agents.js";
import {
  addSquadMember,
  archiveSquad,
  createSquad,
  getSquadInWorkspace,
  isSquadMember,
  listSquadMemberPreviewRows,
  listSquadMemberPreviewRowsBySquad,
  listSquads,
  removeSquadMember,
  updateSquad,
  type Squad,
  type SquadMember,
  type SquadMemberPreviewRow,
} from "../../db/queries/squads.js";
import { bus } from "../../realtime/bus.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PREVIEW_LIMIT = 3;

/** Mirrors the Go SquadMemberPreviewResponse struct (snake_case JSON). */
interface SquadMemberPreviewResponse {
  member_type: string;
  member_id: string;
  role: string;
}

/**
 * Running summary for one squad: the full member count plus the first
 * PREVIEW_LIMIT rows (mirrors Go squadMemberSummary + addSquadMemberPreview).
 */
interface SquadMemberSummary {
  count: number;
  preview: SquadMemberPreviewResponse[];
}

function newSummary(): SquadMemberSummary {
  return { count: 0, preview: [] };
}

function addPreview(summary: SquadMemberSummary, row: SquadMemberPreviewRow): void {
  summary.count++;
  if (summary.preview.length >= PREVIEW_LIMIT) return;
  summary.preview.push({
    member_type: row.memberType,
    member_id: row.memberId,
    role: row.role,
  });
}

/** Mirrors the Go SquadMemberResponse struct (snake_case JSON). */
function squadMemberToResponse(m: SquadMember) {
  return {
    id: m.id,
    squad_id: m.squadId,
    member_type: m.memberType,
    member_id: m.memberId,
    role: m.role,
    created_at: m.createdAt,
  };
}

/**
 * Postgres unique-violation detection (mirrors Go isUniqueViolation). Drizzle
 * wraps the driver error in a DrizzleQueryError, so the SQLSTATE "23505" lives
 * on `.cause.code`; postgres.js surfaces it on `.code` directly. Check both.
 */
function isUniqueViolation(err: unknown): boolean {
  const code = (e: unknown): unknown =>
    typeof e === "object" && e !== null && "code" in e ? (e as { code: unknown }).code : undefined;
  if (code(err) === "23505") return true;
  const cause = typeof err === "object" && err !== null && "cause" in err ? (err as { cause: unknown }).cause : undefined;
  return code(cause) === "23505";
}

/**
 * Mirrors the Go SquadResponse struct (snake_case JSON). member_count defaults
 * to 0 and member_preview to [] (Go zero values) when no summary is supplied.
 */
function squadToResponse(s: Squad, summary?: SquadMemberSummary) {
  return {
    id: s.id,
    workspace_id: s.workspaceId,
    name: s.name,
    description: s.description,
    instructions: s.instructions,
    avatar_url: s.avatarUrl,
    leader_id: s.leaderId,
    creator_id: s.creatorId,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
    archived_at: s.archivedAt,
    archived_by: s.archivedBy,
    member_count: summary?.count ?? 0,
    member_preview: summary?.preview ?? [],
  };
}

/**
 * Resolve + authorize the workspace for this request. Returns the validated
 * workspace UUID, or a Response to short-circuit with (400 missing/malformed
 * header, 404 not-a-member — mirrors the Go workspace-member gate).
 */
async function requireWorkspace(c: Context<AppEnv>, db: Db): Promise<string | Response> {
  const wsId = c.req.header("X-Workspace-ID") ?? c.get("wsId");
  if (!wsId || !UUID_RE.test(wsId)) {
    return c.json({ error: "X-Workspace-ID header required" }, 400);
  }
  const m = await getMembership(db, c.get("user").sub, wsId);
  if (!m) return c.json({ error: "workspace not found" }, 404);
  return wsId;
}

/**
 * Resolve the workspace AND assert the caller holds an owner/admin role for the
 * write path (mirrors the Go requireWorkspaceRole gate). Returns the validated
 * workspace UUID, or a Response (400 bad header, 404 not-a-member or
 * insufficient role — the Go side collapses both to "workspace not found").
 */
async function requireWorkspaceRole(c: Context<AppEnv>, db: Db): Promise<string | Response> {
  const wsId = c.req.header("X-Workspace-ID") ?? c.get("wsId");
  if (!wsId || !UUID_RE.test(wsId)) {
    return c.json({ error: "X-Workspace-ID header required" }, 400);
  }
  const m = await getMembership(db, c.get("user").sub, wsId);
  if (!m || (m.role !== "owner" && m.role !== "admin")) {
    return c.json({ error: "workspace not found" }, 404);
  }
  return wsId;
}

export function squadRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    const [squads, previewRows] = await Promise.all([
      listSquads(db, ws),
      listSquadMemberPreviewRows(db, ws),
    ]);

    // Group preview rows by squad; the SQL already orders leader-first then by
    // insertion, so addPreview keeps the leader in the capped preview.
    const summaries = new Map<string, SquadMemberSummary>();
    for (const row of previewRows) {
      let summary = summaries.get(row.squadId);
      if (!summary) {
        summary = newSummary();
        summaries.set(row.squadId, summary);
      }
      addPreview(summary, row);
    }

    return c.json(squads.map((s) => squadToResponse(s, summaries.get(s.id))));
  });

  r.get("/:id", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid squad id" }, 400);

    const found = await getSquadInWorkspace(db, ws, id);
    if (!found) return c.json({ error: "squad not found" }, 404);

    const previewRows = await listSquadMemberPreviewRowsBySquad(db, found.id);
    const summary = newSummary();
    for (const row of previewRows) addPreview(summary, row);

    return c.json(squadToResponse(found, summary));
  });

  // Build a squad response with its (capped) member preview — used by the
  // write routes so the create/update echo matches the GET shape exactly.
  async function withPreview(squad: Squad) {
    const rows = await listSquadMemberPreviewRowsBySquad(db!, squad.id);
    const summary = newSummary();
    for (const row of rows) addPreview(summary, row);
    return squadToResponse(squad, summary);
  }

  // POST /api/squads — create a squad (name + leader agent). The leader must be
  // a valid, in-workspace agent; it is auto-added as a member with role
  // "leader" (mirrors Go CreateSquad). 201 on success.
  r.post("/", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspaceRole(c, db);
    if (ws instanceof Response) return ws;

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return c.json({ error: "name is required" }, 400);
    const leaderId = typeof body.leader_id === "string" ? body.leader_id : "";
    if (!leaderId) return c.json({ error: "leader_id is required" }, 400);
    if (!UUID_RE.test(leaderId)) return c.json({ error: "invalid leader_id" }, 400);

    // Leader must be an agent in this workspace.
    const leader = await getAgentInWorkspace(db, ws, leaderId);
    if (!leader) return c.json({ error: "leader must be a valid agent in this workspace" }, 400);

    const description = typeof body.description === "string" ? body.description : undefined;
    const avatarUrl = typeof body.avatar_url === "string" ? body.avatar_url : null;

    const created = await createSquad(db, {
      workspaceId: ws,
      name,
      description,
      leaderId,
      creatorId: c.get("user").sub,
      avatarUrl,
    });

    // Auto-add the leader as a member with role "leader".
    await addSquadMember(db, {
      squadId: created.id,
      memberType: "agent",
      memberId: leaderId,
      role: "leader",
    });

    bus.publish({ type: "squad.created", workspaceId: ws, payload: { id: created.id } });
    return c.json(await withPreview(created), 201);
  });

  // PUT /api/squads/:id — partial update. Any subset of name/description/
  // instructions/avatar_url/leader_id (mirrors Go UpdateSquad). Changing the
  // leader validates the new agent and auto-adds it as a member if absent.
  r.put("/:id", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspaceRole(c, db);
    if (ws instanceof Response) return ws;

    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid squad id" }, 400);
    const found = await getSquadInWorkspace(db, ws, id);
    if (!found) return c.json({ error: "squad not found" }, 404);

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }

    const patch: Parameters<typeof updateSquad>[2] = {};
    if (typeof body.name === "string") patch.name = body.name;
    if (typeof body.description === "string") patch.description = body.description;
    if (typeof body.instructions === "string") patch.instructions = body.instructions;
    if (typeof body.avatar_url === "string") patch.avatarUrl = body.avatar_url;

    if (typeof body.leader_id === "string") {
      const leaderId = body.leader_id;
      if (!UUID_RE.test(leaderId)) return c.json({ error: "invalid leader_id" }, 400);
      const leader = await getAgentInWorkspace(db, ws, leaderId);
      if (!leader) return c.json({ error: "leader must be a valid agent in this workspace" }, 400);
      // Ensure the new leader is a member; auto-add if not (mirrors Go).
      if (!(await isSquadMember(db, found.id, "agent", leaderId))) {
        await addSquadMember(db, { squadId: found.id, memberType: "agent", memberId: leaderId, role: "leader" });
      }
      patch.leaderId = leaderId;
    }

    const updated = await updateSquad(db, found.id, patch);
    bus.publish({ type: "squad.updated", workspaceId: ws, payload: { id: found.id } });
    return c.json(await withPreview(updated ?? found));
  });

  // DELETE /api/squads/:id — soft delete (archive). Already-archived squads are
  // a 400 (mirrors Go DeleteSquad). 204 on success.
  r.delete("/:id", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspaceRole(c, db);
    if (ws instanceof Response) return ws;

    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid squad id" }, 400);
    const found = await getSquadInWorkspace(db, ws, id);
    if (!found) return c.json({ error: "squad not found" }, 404);
    if (found.archivedAt) return c.json({ error: "squad is already archived" }, 400);

    await archiveSquad(db, found.id, c.get("user").sub);
    bus.publish({
      type: "squad.deleted",
      workspaceId: ws,
      payload: { id: found.id, leader_id: found.leaderId },
    });
    return c.body(null, 204);
  });

  // POST /api/squads/:id/members — add a member (agent or workspace member).
  // The member must belong to this workspace (mirrors Go AddSquadMember).
  // 201 on success; 409 if already in the squad.
  r.post("/:id/members", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspaceRole(c, db);
    if (ws instanceof Response) return ws;

    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid squad id" }, 400);
    const found = await getSquadInWorkspace(db, ws, id);
    if (!found) return c.json({ error: "squad not found" }, 404);

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }
    const memberType = typeof body.member_type === "string" ? body.member_type : "";
    if (memberType !== "agent" && memberType !== "member") {
      return c.json({ error: "member_type must be 'agent' or 'member'" }, 400);
    }
    const memberId = typeof body.member_id === "string" ? body.member_id : "";
    if (!memberId) return c.json({ error: "member_id is required" }, 400);
    if (!UUID_RE.test(memberId)) return c.json({ error: "invalid member_id" }, 400);
    const role = typeof body.role === "string" ? body.role : "";

    // Validate the member belongs to this workspace.
    if (memberType === "agent") {
      const a = await getAgentInWorkspace(db, ws, memberId);
      if (!a) return c.json({ error: "agent not found in this workspace" }, 400);
    } else {
      const m = await getMembership(db, memberId, ws);
      if (!m) return c.json({ error: "member not found in this workspace" }, 400);
    }

    try {
      const sm = await addSquadMember(db, { squadId: found.id, memberType, memberId, role });
      bus.publish({ type: "squad.updated", workspaceId: ws, payload: { id: found.id } });
      return c.json(squadMemberToResponse(sm), 201);
    } catch (err) {
      if (isUniqueViolation(err)) return c.json({ error: "member already in squad" }, 409);
      throw err;
    }
  });

  // DELETE /api/squads/:id/members — remove a member. The leader cannot be
  // removed (mirrors Go RemoveSquadMember). 204 on success; 404 if not a member.
  r.delete("/:id/members", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspaceRole(c, db);
    if (ws instanceof Response) return ws;

    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid squad id" }, 400);
    const found = await getSquadInWorkspace(db, ws, id);
    if (!found) return c.json({ error: "squad not found" }, 404);

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }
    const memberType = typeof body.member_type === "string" ? body.member_type : "";
    const memberId = typeof body.member_id === "string" ? body.member_id : "";
    if (!UUID_RE.test(memberId)) return c.json({ error: "invalid member_id" }, 400);

    // Prevent removing the leader (mirrors Go).
    if (memberType === "agent" && found.leaderId === memberId) {
      return c.json({ error: "cannot remove the squad leader; change leader first" }, 400);
    }

    const removed = await removeSquadMember(db, found.id, memberType, memberId);
    if (removed === 0) return c.json({ error: "squad member not found" }, 404);

    bus.publish({ type: "squad.updated", workspaceId: ws, payload: { id: found.id } });
    return c.body(null, 204);
  });

  return r;
}
