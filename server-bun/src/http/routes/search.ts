/**
 * Search routes (read path) — port of the Go issue handler's search endpoint
 * (server/internal/handler/issue.go SearchIssues, GET /api/issues/search).
 * Behind the /api/* JWT gate; scoped to a workspace via the X-Workspace-ID
 * header + a membership check (multi-tenancy), mirroring the issues router.
 *
 * MOUNT NOTE: the Go route lives at /api/issues/search, but the Bun issues
 * router already owns a /:id catch-all that would swallow "search". This router
 * is therefore mounted at its own prefix (see app.route in app.ts). The query
 * contract (?q=, ?limit=, ?offset=, ?include_closed=) and the response envelope
 * { issues, total } match the Go handler exactly.
 *
 * SIMPLIFICATION: see search.ts — basic title/identifier ILIKE search, no
 * description/comment full-text, ranking, or snippets. The response still
 * carries match_source for shape-compatibility with the Go SearchIssueResponse;
 * it is always "title" here.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import type { Issue } from "../../db/schema.js";
import { getMembership, getWorkspacePrefix } from "../../db/queries/issues.js";
import { searchIssues } from "../../db/queries/search.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mirrors the Go IssueResponse struct (snake_case JSON). */
function issueToResponse(i: Issue, prefix: string) {
  return {
    id: i.id,
    workspace_id: i.workspaceId,
    number: i.number,
    identifier: `${prefix}-${i.number}`,
    title: i.title,
    description: i.description,
    status: i.status,
    priority: i.priority,
    assignee_type: i.assigneeType,
    assignee_id: i.assigneeId,
    creator_type: i.creatorType,
    creator_id: i.creatorId,
    parent_issue_id: i.parentIssueId,
    project_id: i.projectId,
    position: i.position,
    start_date: i.startDate,
    due_date: i.dueDate,
    created_at: i.createdAt,
    updated_at: i.updatedAt,
    metadata: i.metadata ?? {},
  };
}

/** Mirrors the Go SearchIssueResponse struct: IssueResponse + match_source. */
function searchIssueToResponse(i: Issue, prefix: string) {
  return { ...issueToResponse(i, prefix), match_source: "title" };
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

/** Parse a non-negative integer query param, falling back to a default. */
function intParam(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function searchRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    const q = c.req.query("q") ?? "";
    if (!q.trim()) return c.json({ error: "q parameter is required" }, 400);

    // Clamp limit to [1, 50] (mirrors the Go handler's default 20, max 50).
    let limit = intParam(c.req.query("limit"), 20);
    if (limit <= 0) limit = 20;
    if (limit > 50) limit = 50;
    const offset = intParam(c.req.query("offset"), 0);
    const includeClosed = c.req.query("include_closed") === "true";

    const [{ issues, total }, prefix] = await Promise.all([
      searchIssues(db, ws, q, { includeClosed, limit, offset }),
      getWorkspacePrefix(db, ws),
    ]);

    c.header("X-Total-Count", String(total));
    return c.json({
      issues: issues.map((i) => searchIssueToResponse(i, prefix)),
      total,
    });
  });

  return r;
}
