/**
 * Activity-log routes (read path) — port of the Go activity handler's
 * activity_log reads. Behind the /api/* JWT gate; scoped to a workspace via the
 * X-Workspace-ID header + a membership check (multi-tenancy).
 *
 *   GET /api/activity              → workspace-wide activity log (newest first)
 *   GET /api/activity/issues/:id   → one issue's activity log (oldest first)
 *
 * The per-issue endpoint resolves the issue inside the workspace before reading,
 * so an issue from another workspace 404s (mirrors the Go loadIssueForUser gate).
 * Response objects match the activity portion of the Go TimelineEntry struct
 * (type/id/actor_type/actor_id/action/details/created_at), snake_case JSON.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import { getMembership, getIssueByIdentifier } from "../../db/queries/issues.js";
import {
  listActivitiesForIssue,
  listActivitiesForWorkspace,
  type ActivityLog,
} from "../../db/queries/activity.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mirrors the activity branch of the Go TimelineEntry struct (snake_case JSON). */
function activityToResponse(a: ActivityLog) {
  return {
    type: "activity",
    id: a.id,
    actor_type: a.actorType ?? "",
    actor_id: a.actorId,
    action: a.action,
    details: a.details ?? {},
    created_at: a.createdAt,
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

export function activityRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // Workspace-wide activity log, newest first.
  r.get("/", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const rows = await listActivitiesForWorkspace(db, ws);
    return c.json(rows.map(activityToResponse));
  });

  // One issue's activity log, oldest first. The issue must live in the
  // workspace (resolved by UUID or "MUL-123"), else 404.
  r.get("/issues/:id", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const found = await getIssueByIdentifier(db, ws, c.req.param("id"));
    if (!found) return c.json({ error: "issue not found" }, 404);
    const rows = await listActivitiesForIssue(db, found.id);
    return c.json(rows.map(activityToResponse));
  });

  return r;
}
