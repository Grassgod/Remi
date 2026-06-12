/**
 * Issue routes (read path) — port of the Go issue handler's GET /api/issues
 * (list) and GET /api/issues/{id} (get). Behind the /api/* JWT gate; scoped to
 * a workspace via the X-Workspace-ID header + a membership check (multi-tenancy).
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import type { Issue } from "../../db/schema.js";
import {
  createIssue,
  deleteIssue,
  getIssueByIdentifier,
  getMembership,
  getWorkspacePrefix,
  childIssueProgress,
  listIssues,
  listIssuesFiltered,
  nextIssueNumber,
  updateIssue,
} from "../../db/queries/issues.js";
import type { NewIssue } from "../../db/schema.js";
import { notifyParentOfChildDone } from "../../agent/childDone.js";
import {
  dispatchOnCreate,
  enqueueForIssue,
  getReadyAgent,
  getReadySquadLeader,
  reconcileTasksOnIssueUpdate,
} from "../../agent/assignmentTrigger.js";
import { bus } from "../../realtime/bus.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

export function issueRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const q = (k: string) => c.req.query(k) || undefined;
    const intq = (k: string) => { const v = Number(c.req.query(k)); return Number.isFinite(v) ? v : undefined; };
    const dir = c.req.query("direction");
    const [{ issues, total }, prefix] = await Promise.all([
      listIssuesFiltered(db, ws, {
        status: q("status"),
        priority: q("priority"),
        assigneeId: q("assignee_id"),
        projectId: q("project_id"),
        creatorId: q("creator_id"),
        openOnly: c.req.query("open_only") === "true",
        limit: intq("limit"),
        offset: intq("offset"),
        sort: q("sort"),
        direction: dir === "asc" || dir === "desc" ? dir : undefined,
      }),
      getWorkspacePrefix(db, ws),
    ]);
    // Go ListIssues returns { issues, total }; the frontend parses that shape.
    return c.json({ issues: issues.map((i) => issueToResponse(i, prefix)), total });
  });

  // GET /api/issues/grouped — the board's main query: issues grouped by
  // assignee (default) or status. Each group: { id, assignee_type, assignee_id,
  // status?, issues, total }. (Cursor pagination is not yet ported — all of a
  // group's issues are returned; the frontend schema is .loose() so extra/absent
  // pagination fields are tolerated.)
  r.get("/grouped", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const [issues, prefix] = await Promise.all([listIssues(db, ws), getWorkspacePrefix(db, ws)]);
    const byStatus = c.req.query("group_by") === "status";

    const groups = new Map<string, { id: string; assignee_type: string | null; assignee_id: string | null; status?: string; issues: ReturnType<typeof issueToResponse>[] }>();
    for (const i of issues) {
      const key = byStatus ? i.status : `${i.assigneeType ?? "none"}:${i.assigneeId ?? "none"}`;
      if (!groups.has(key)) {
        groups.set(key, byStatus
          ? { id: i.status, assignee_type: null, assignee_id: null, status: i.status, issues: [] }
          : { id: key, assignee_type: i.assigneeType, assignee_id: i.assigneeId, issues: [] });
      }
      groups.get(key)!.issues.push(issueToResponse(i, prefix));
    }
    const out = [...groups.values()].map((g) => ({ ...g, total: g.issues.length }));
    return c.json({ groups: out });
  });

  // GET /api/issues/child-progress?parent_ids=a,b — sub-issue done/total per
  // parent (the parent cards' progress bars). { progress: [{ parent_issue_id, total, done }] }.
  r.get("/child-progress", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const parentIds = (c.req.query("parent_ids") ?? "").split(",").map((s) => s.trim()).filter((s) => UUID_RE.test(s));
    return c.json({ progress: await childIssueProgress(db, ws, parentIds) });
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
    const number = await nextIssueNumber(db, ws);
    const created = await createIssue(db, {
      workspaceId: ws,
      title,
      description: str(body.description),
      status: str(body.status) ?? "backlog",
      priority: str(body.priority) ?? "none",
      assigneeType: str(body.assignee_type),
      assigneeId: str(body.assignee_id),
      parentIssueId: str(body.parent_issue_id),
      projectId: str(body.project_id),
      startDate: str(body.start_date),
      dueDate: str(body.due_date),
      creatorType: "member",
      creatorId: c.get("user").sub,
      number,
    });
    bus.publish({ type: "issue.created", workspaceId: ws, payload: { id: created.id } });
    // Creating directly with a ready agent assignee dispatches immediately
    // (Go CreateIssue parity). Best-effort — never fail the create over it.
    try {
      await dispatchOnCreate(db, ws, created);
    } catch (err) {
      console.warn("issue: create dispatch failed:", err);
    }
    const prefix = await getWorkspacePrefix(db, ws);
    return c.json(issueToResponse(created, prefix), 201);
  });

  // POST /api/issues/quick-create — the agent-mode New Issue dialog. The Go
  // flow enqueues an issueless task and the agent creates the issue over the
  // CLI; the bun executor has no CLI write path, so the server creates the
  // issue up front (origin quick_create, prompt as the body) and dispatches
  // the assignee normally. Same UX, same {task_id} response contract.
  r.post("/quick-create", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) return c.json({ error: "prompt is required" }, 400);
    const agentId = typeof body.agent_id === "string" ? body.agent_id.trim() : "";
    const squadId = typeof body.squad_id === "string" ? body.squad_id.trim() : "";
    if (!!agentId === !!squadId) {
      return c.json({ error: "exactly one of agent_id or squad_id is required" }, 400);
    }
    if (agentId && !UUID_RE.test(agentId)) return c.json({ error: "invalid agent_id" }, 400);
    if (squadId && !UUID_RE.test(squadId)) return c.json({ error: "invalid squad_id" }, 400);

    const ready = agentId
      ? await getReadyAgent(db, ws, agentId)
      : await getReadySquadLeader(db, ws, squadId);
    if (!ready) return c.json({ error: "agent is not available for dispatch" }, 400);

    const projectId =
      typeof body.project_id === "string" && UUID_RE.test(body.project_id) ? body.project_id : null;
    const parentIssueId =
      typeof body.parent_issue_id === "string" && UUID_RE.test(body.parent_issue_id)
        ? body.parent_issue_id
        : null;

    // Title = first prompt line (sentence-clamped); the full prompt is the body.
    const firstLine = prompt.split("\n", 1)[0]!.trim();
    const title = firstLine.length > 120 ? firstLine.slice(0, 117) + "…" : firstLine;
    const number = await nextIssueNumber(db, ws);
    const created = await createIssue(db, {
      workspaceId: ws,
      title: title || "Quick task",
      description: prompt,
      status: "todo",
      priority: "none",
      assigneeType: agentId ? "agent" : "squad",
      assigneeId: agentId || squadId,
      projectId,
      parentIssueId,
      originType: "quick_create",
      creatorType: "member",
      creatorId: c.get("user").sub,
      number,
    });
    bus.publish({ type: "issue.created", workspaceId: ws, payload: { id: created.id } });

    // Dispatch to the resolved agent (squad picks run on the leader).
    const task = await enqueueForIssue(db, ws, created, ready);
    return c.json({ task_id: task.id }, 201);
  });

  r.get("/:id", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const found = await getIssueByIdentifier(db, ws, c.req.param("id"));
    if (!found) return c.json({ error: "issue not found" }, 404);
    const prefix = await getWorkspacePrefix(db, ws);
    return c.json(issueToResponse(found, prefix));
  });

  r.put("/:id", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const found = await getIssueByIdentifier(db, ws, c.req.param("id"));
    if (!found) return c.json({ error: "issue not found" }, 404);
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }
    // Partial update: only the fields present in the body are touched (mirrors
    // Go UpdateIssueRequest's pointer fields). null clears a nullable column.
    const f: Partial<NewIssue> = {};
    const nstr = (v: unknown) => (typeof v === "string" ? v : null);
    if (typeof body.title === "string") f.title = body.title;
    if ("description" in body) f.description = nstr(body.description);
    if (typeof body.status === "string") f.status = body.status;
    if (typeof body.priority === "string") f.priority = body.priority;
    if ("assignee_type" in body) f.assigneeType = nstr(body.assignee_type);
    if ("assignee_id" in body) f.assigneeId = nstr(body.assignee_id);
    if ("parent_issue_id" in body) f.parentIssueId = nstr(body.parent_issue_id);
    if ("project_id" in body) f.projectId = nstr(body.project_id);
    if ("start_date" in body) f.startDate = nstr(body.start_date);
    if ("due_date" in body) f.dueDate = nstr(body.due_date);
    if (typeof body.position === "number") f.position = body.position;
    const updated = await updateIssue(db, found.id, f);
    bus.publish({ type: "issue.updated", workspaceId: ws, payload: { id: found.id } });

    // On a fresh child-done transition, notify the parent's agent/squad assignee
    // with a system comment. Best-effort — never fail the status update over it.
    if (updated) {
      try {
        await notifyParentOfChildDone(db, found, updated);
      } catch (err) {
        console.warn("issue: child-done notify failed:", err);
      }
      // Assignment-driven dispatch (assign → enqueue, backlog promotion,
      // cancel-on-cancelled). Best-effort like the notify above.
      try {
        await reconcileTasksOnIssueUpdate(db, ws, found, updated);
      } catch (err) {
        console.warn("issue: task reconcile failed:", err);
      }
    }

    const prefix = await getWorkspacePrefix(db, ws);
    return c.json(issueToResponse(updated ?? found, prefix));
  });

  r.delete("/:id", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const found = await getIssueByIdentifier(db, ws, c.req.param("id"));
    if (!found) return c.json({ error: "issue not found" }, 404);
    await deleteIssue(db, found.id);
    bus.publish({ type: "issue.deleted", workspaceId: ws, payload: { id: found.id } });
    return c.body(null, 204);
  });

  return r;
}
