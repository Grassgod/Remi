/**
 * Autopilot routes (read + create path) — port of the Go autopilot handler's
 * GET /api/autopilots (list), GET /api/autopilots/:id (get, with triggers), and
 * POST /api/autopilots (create). Behind the /api/* JWT gate; scoped to a
 * workspace via the X-Workspace-ID header + a membership check (multi-tenancy).
 *
 * Out of scope (matches the Go cron scheduler / webhook dispatch being skipped):
 * update/delete, trigger create/update/rotate/signing-secret, runs, and the
 * manual /trigger dispatch. Those depend on the scheduler + dispatch service.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import {
  createAutopilot,
  getAutopilotInWorkspace,
  listAutopilots,
  listAutopilotTriggers,
  type Autopilot,
  type AutopilotTrigger,
} from "../../db/queries/autopilots.js";
import { getMembership } from "../../db/queries/issues.js";
import { getAgentInWorkspace } from "../../db/queries/agents.js";
import { getSquadInWorkspace } from "../../db/queries/squads.js";
import { getProjectInWorkspace } from "../../db/queries/projects.js";
import { bus } from "../../realtime/bus.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mirrors the Go AutopilotResponse struct (snake_case JSON). */
function autopilotToResponse(a: Autopilot) {
  // Older rows may surface assignee_type as "" against an out-of-date schema
  // view; default to "agent" so the API contract stays non-null (mirrors Go).
  const assigneeType = a.assigneeType && a.assigneeType !== "" ? a.assigneeType : "agent";
  return {
    id: a.id,
    workspace_id: a.workspaceId,
    title: a.title,
    description: a.description,
    project_id: a.projectId,
    assignee_type: assigneeType,
    assignee_id: a.assigneeId,
    status: a.status,
    execution_mode: a.executionMode,
    issue_title_template: a.issueTitleTemplate,
    created_by_type: a.createdByType,
    created_by_id: a.createdById,
    last_run_at: a.lastRunAt,
    created_at: a.createdAt,
    updated_at: a.updatedAt,
  };
}

// webhookPathForToken composes the public ingress path (mirrors Go).
function webhookPathForToken(token: string): string {
  return `/api/webhooks/autopilots/${token}`;
}

// signingSecretHint returns the last 4 characters of the signing secret so a
// configured-vs-rotated state is visible in the UI without exposing the secret
// itself (mirrors Go signingSecretHint).
function signingSecretHint(secret: string): string {
  return secret.length < 4 ? "" : secret.slice(-4);
}

/** Mirrors the Go AutopilotTriggerResponse struct (snake_case JSON). */
function triggerToResponse(t: AutopilotTrigger) {
  const resp: Record<string, unknown> = {
    id: t.id,
    autopilot_id: t.autopilotId,
    kind: t.kind,
    enabled: t.enabled,
    cron_expression: t.cronExpression,
    timezone: t.timezone,
    next_run_at: t.nextRunAt,
    webhook_token: t.webhookToken,
    webhook_path: null,
    webhook_url: null,
    provider: null,
    has_signing_secret: false,
    signing_secret_hint: null,
    label: t.label,
    last_fired_at: t.lastFiredAt,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
  };
  if (t.kind === "webhook" && t.webhookToken && t.webhookToken !== "") {
    resp.webhook_path = webhookPathForToken(t.webhookToken);
    resp.provider = t.provider && t.provider !== "" ? t.provider : "generic";
    if (t.signingSecret && t.signingSecret !== "") {
      resp.has_signing_secret = true;
      resp.signing_secret_hint = signingSecretHint(t.signingSecret);
    }
    if (Array.isArray(t.eventFilters) && t.eventFilters.length > 0) {
      resp.event_filters = t.eventFilters;
    }
  }
  return resp;
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

function isValidAssigneeType(t: string): boolean {
  return t === "agent" || t === "squad";
}

/**
 * Validate that the assignee (agent or squad) exists in the workspace, and for
 * squad assignees that the squad and its leader are not archived. Mirrors the
 * Go validateAutopilotAssignee save-time checks (minus the private-leader gate,
 * which depends on the actor-resolution service that is out of scope here).
 * Returns null on success, or a Response to short-circuit with.
 */
async function validateAssignee(
  c: Context<AppEnv>,
  db: Db,
  assigneeType: string,
  assigneeId: string,
  wsId: string,
): Promise<Response | null> {
  if (assigneeType === "agent") {
    const a = await getAgentInWorkspace(db, wsId, assigneeId);
    if (!a) return c.json({ error: "assignee must be a valid agent in this workspace" }, 400);
    return null;
  }
  // squad
  const squad = await getSquadInWorkspace(db, wsId, assigneeId);
  if (!squad) return c.json({ error: "assignee must be a valid squad in this workspace" }, 400);
  if (squad.archivedAt) {
    return c.json({ error: "squad is archived; pick a different squad" }, 422);
  }
  const leader = await getAgentInWorkspace(db, wsId, squad.leaderId);
  if (!leader) return c.json({ error: "squad leader agent not found" }, 400);
  if (leader.archivedAt) {
    return c.json(
      {
        error:
          "squad leader is archived; pick a different squad or rotate the leader before assigning autopilot",
      },
      422,
    );
  }
  return null;
}

export function autopilotRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const status = c.req.query("status");
    const autopilots = await listAutopilots(db, ws, status);
    const resp = autopilots.map(autopilotToResponse);
    return c.json({ autopilots: resp, total: resp.length });
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

    const title = typeof body.title === "string" ? body.title : "";
    if (!title) return c.json({ error: "title is required" }, 400);
    const assigneeId = typeof body.assignee_id === "string" ? body.assignee_id : "";
    if (!assigneeId) return c.json({ error: "assignee_id is required" }, 400);
    const executionMode = typeof body.execution_mode === "string" ? body.execution_mode : "";
    if (!executionMode) return c.json({ error: "execution_mode is required" }, 400);
    if (executionMode !== "create_issue" && executionMode !== "run_only") {
      return c.json({ error: "execution_mode must be create_issue or run_only" }, 400);
    }
    if (!UUID_RE.test(assigneeId)) {
      return c.json({ error: "assignee_id must be a valid UUID" }, 400);
    }

    let assigneeType = "agent";
    if (typeof body.assignee_type === "string" && body.assignee_type !== "") {
      assigneeType = body.assignee_type;
    }
    if (!isValidAssigneeType(assigneeType)) {
      return c.json({ error: "assignee_type must be agent or squad" }, 400);
    }
    const assigneeErr = await validateAssignee(c, db, assigneeType, assigneeId, ws);
    if (assigneeErr) return assigneeErr;

    // project_id is optional; when present it must reference a project in this
    // workspace (mirrors Go parseAutopilotProjectID).
    let projectId: string | null = null;
    if (typeof body.project_id === "string" && body.project_id !== "") {
      if (!UUID_RE.test(body.project_id)) {
        return c.json({ error: "project_id must be a valid UUID" }, 400);
      }
      const project = await getProjectInWorkspace(db, ws, body.project_id);
      if (!project) {
        return c.json({ error: "project_id must reference a project in this workspace" }, 400);
      }
      projectId = body.project_id;
    }

    const description = typeof body.description === "string" ? body.description : null;
    const issueTitleTemplate =
      typeof body.issue_title_template === "string" ? body.issue_title_template : null;

    const created = await createAutopilot(db, {
      workspaceId: ws,
      title,
      assigneeType,
      assigneeId,
      status: "active",
      executionMode,
      createdByType: "member",
      createdById: c.get("user").sub,
      description,
      issueTitleTemplate,
      projectId,
    });
    bus.publish({ type: "autopilot.created", workspaceId: ws, payload: { id: created.id } });
    return c.json(autopilotToResponse(created), 201);
  });

  r.get("/:id", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "autopilot not found" }, 404);
    const found = await getAutopilotInWorkspace(db, ws, id);
    if (!found) return c.json({ error: "autopilot not found" }, 404);
    const triggers = await listAutopilotTriggers(db, found.id);
    return c.json({
      autopilot: autopilotToResponse(found),
      triggers: triggers.map(triggerToResponse),
    });
  });

  return r;
}
