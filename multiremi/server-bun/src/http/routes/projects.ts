/**
 * Project routes (read path) — port of the Go project handler's
 * GET /api/projects (list) and GET /api/projects/{id} (get). Behind the /api/*
 * JWT gate; scoped to a workspace via the X-Workspace-ID header + a membership
 * check (multi-tenancy).
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import type { Project } from "../../db/schema.js";
import { getMembership } from "../../db/queries/issues.js";
import {
  createProject,
  deleteProject,
  getProjectInWorkspace,
  getProjectIssueStats,
  getProjectResourceCounts,
  listProjects,
  updateProject,
  type NewProject,
} from "../../db/queries/projects.js";
import { bus } from "../../realtime/bus.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Mirrors the Go ProjectResponse struct (snake_case JSON). issue_count,
 * done_count and resource_count default to 0 (Go int64 zero value) and are
 * filled in by the caller from the batch stats maps.
 */
function projectToResponse(
  p: Project,
  counts: { issueCount?: number; doneCount?: number; resourceCount?: number } = {},
) {
  return {
    id: p.id,
    workspace_id: p.workspaceId,
    title: p.title,
    description: p.description,
    icon: p.icon,
    status: p.status,
    priority: p.priority,
    lead_type: p.leadType,
    lead_id: p.leadId,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
    issue_count: counts.issueCount ?? 0,
    done_count: counts.doneCount ?? 0,
    resource_count: counts.resourceCount ?? 0,
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

export function projectRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    const status = c.req.query("status") || undefined;
    const priority = c.req.query("priority") || undefined;
    const projects = await listProjects(db, ws, { status, priority });

    const ids = projects.map((p) => p.id);
    const [stats, resourceCounts] = await Promise.all([
      getProjectIssueStats(db, ids),
      getProjectResourceCounts(db, ids),
    ]);

    const resp = projects.map((p) => {
      const s = stats.get(p.id);
      return projectToResponse(p, {
        issueCount: s?.totalCount,
        doneCount: s?.doneCount,
        resourceCount: resourceCounts.get(p.id),
      });
    });
    return c.json({ projects: resp, total: resp.length });
  });

  r.post("/", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) return c.json({ error: "title is required" }, 400);

    const str = (v: unknown) => (typeof v === "string" && v ? v : null);
    const created = await createProject(db, {
      workspaceId: ws,
      title,
      description: str(body.description),
      icon: str(body.icon),
      status: str(body.status) ?? "planned",
      priority: str(body.priority) ?? "none",
      leadType: str(body.lead_type),
      leadId: str(body.lead_id),
    });
    bus.publish({ type: "project.created", workspaceId: ws, payload: { id: created.id } });
    return c.json(projectToResponse(created), 201);
  });

  r.get("/:id", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid project id" }, 400);

    const found = await getProjectInWorkspace(db, ws, id);
    if (!found) return c.json({ error: "project not found" }, 404);

    const [stats, resourceCounts] = await Promise.all([
      getProjectIssueStats(db, [found.id]),
      getProjectResourceCounts(db, [found.id]),
    ]);
    const s = stats.get(found.id);
    return c.json(
      projectToResponse(found, {
        issueCount: s?.totalCount,
        doneCount: s?.doneCount,
        resourceCount: resourceCounts.get(found.id),
      }),
    );
  });

  r.put("/:id", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid project id" }, 400);

    const found = await getProjectInWorkspace(db, ws, id);
    if (!found) return c.json({ error: "project not found" }, 404);

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }

    // Partial update: only the fields present in the body are touched (mirrors
    // Go UpdateProjectRequest's pointer fields). For nullable columns, a present
    // key with null clears it; an absent key preserves the current value.
    const f: Partial<NewProject> = {};
    const nstr = (v: unknown) => (typeof v === "string" ? v : null);
    if (typeof body.title === "string") f.title = body.title;
    if (typeof body.status === "string") f.status = body.status;
    if (typeof body.priority === "string") f.priority = body.priority;
    if ("description" in body) f.description = nstr(body.description);
    if ("icon" in body) f.icon = nstr(body.icon);
    if ("lead_type" in body) f.leadType = nstr(body.lead_type);
    if ("lead_id" in body) f.leadId = nstr(body.lead_id);

    const updated = await updateProject(db, found.id, f);
    bus.publish({ type: "project.updated", workspaceId: ws, payload: { id: found.id } });

    const target = updated ?? found;
    const [stats, resourceCounts] = await Promise.all([
      getProjectIssueStats(db, [target.id]),
      getProjectResourceCounts(db, [target.id]),
    ]);
    const s = stats.get(target.id);
    return c.json(
      projectToResponse(target, {
        issueCount: s?.totalCount,
        doneCount: s?.doneCount,
        resourceCount: resourceCounts.get(target.id),
      }),
    );
  });

  r.delete("/:id", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid project id" }, 400);

    const found = await getProjectInWorkspace(db, ws, id);
    if (!found) return c.json({ error: "project not found" }, 404);

    await deleteProject(db, found.id);
    bus.publish({ type: "project.deleted", workspaceId: ws, payload: { id: found.id } });
    return c.body(null, 204);
  });

  return r;
}
