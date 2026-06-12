/**
 * Autopilot action routes — port of the Go autopilot detail-page actions
 * (server/internal/handler/autopilot.go + webhook_delivery.go):
 *
 *   PATCH  /api/autopilots/:id                                        update
 *   DELETE /api/autopilots/:id                                        delete
 *   POST   /api/autopilots/:id/trigger                                manual run ("Run now")
 *   POST   /api/autopilots/:id/triggers                               create trigger
 *   PATCH  /api/autopilots/:id/triggers/:triggerId                    update trigger
 *   DELETE /api/autopilots/:id/triggers/:triggerId                    delete trigger
 *   POST   /api/autopilots/:id/triggers/:triggerId/rotate-webhook-token
 *   GET    /api/autopilots/:id/deliveries/:deliveryId                 delivery detail
 *   POST   /api/autopilots/:id/deliveries/:deliveryId/replay          replay delivery
 *
 * Behind the /api/* JWT gate; workspace-scoped via the X-Workspace-ID header
 * (falling back to the wsId context var) + a membership check. Standalone
 * factory declaring ABSOLUTE paths so it composes alongside ./autopilots.ts
 * (read/create) and ./webhookDeliveries.ts (delivery list) without editing
 * those files.
 *
 * Scheduler note: schedule triggers need no push-style refresh — both the Go
 * scheduler and src/agent/autopilotScheduler.ts re-read due triggers from the
 * DB on every sweep tick, so writing cron/timezone/next_run_at here IS the
 * refresh.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { randomBytes } from "node:crypto";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import {
  getAutopilotInWorkspace,
  type Autopilot,
  type AutopilotTrigger,
} from "../../db/queries/autopilots.js";
import {
  createAutopilotTrigger,
  createWebhookDelivery,
  deleteAutopilot,
  deleteAutopilotTrigger,
  finaliseWebhookDeliveryTerminal,
  finaliseWebhookDeliveryWithRun,
  getAutopilotRun,
  getAutopilotTrigger,
  getWebhookDelivery,
  getWebhookDeliveryInWorkspace,
  rotateAutopilotTriggerWebhookToken,
  touchAutopilotTriggerFiredAt,
  updateAutopilot,
  updateAutopilotTrigger,
  type AutopilotRun,
  type NewAutopilotTrigger,
  type WebhookDelivery,
} from "../../db/queries/autopilotActions.js";
import { getMembership } from "../../db/queries/issues.js";
import { getAgentInWorkspace } from "../../db/queries/agents.js";
import { getSquadInWorkspace } from "../../db/queries/squads.js";
import { getProjectInWorkspace } from "../../db/queries/projects.js";
import { dispatchAutopilot } from "../../agent/autopilot.js";
import { computeNextRun } from "../../agent/cron.js";
import { bus } from "../../realtime/bus.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Webhook token minting (mirrors Go autopilot_webhook.go) ─────────────────

/**
 * "awt_" + URL-safe base64(32 random bytes, no padding) — 47 chars. Mirrors Go
 * generateWebhookToken: the prefix makes a leaked token recognisable in logs,
 * and 256 bits of entropy beats a UUID's 122 while staying URL-friendly.
 */
function generateWebhookToken(): string {
  return "awt_" + randomBytes(32).toString("base64url");
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

// ── Validation helpers (mirror Go service validators) ───────────────────────

/** Go service.ValidateTimezone (time.LoadLocation). null = valid. */
function validateTimezone(tz: string): string | null {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return null;
  } catch {
    return `invalid timezone ${JSON.stringify(tz)}`;
  }
}

const TEMPLATE_TOKEN_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;
const SUPPORTED_TEMPLATE_VARS = ["date"];

/**
 * Go service.ValidateIssueTitleTemplate: every {{...}} token must name a
 * supported variable; empty template is valid. null = valid.
 */
function validateIssueTitleTemplate(tmpl: string): string | null {
  if (tmpl === "") return null;
  for (const m of tmpl.matchAll(TEMPLATE_TOKEN_RE)) {
    const name = m[1] ?? "";
    if (!SUPPORTED_TEMPLATE_VARS.includes(name)) {
      return `unknown template variable ${JSON.stringify(name)}; supported: {{${SUPPORTED_TEMPLATE_VARS.join("}}, {{")}}}`;
    }
  }
  return null;
}

/** Declared event scope on a webhook trigger (mirrors Go WebhookEventFilter). */
type WebhookEventFilter = { event: string; actions?: string[] };

/**
 * Decode + validate an event_filters value from a request body. Returns the
 * cleaned filter list (actions omitted when empty, matching the Go struct's
 * omitempty so the stored JSONB shape is identical), or an error string.
 * Shape mismatches map to "invalid request body" — the Go decoder would have
 * failed the whole unmarshal there.
 */
function parseEventFilters(raw: unknown): { filters: WebhookEventFilter[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: "invalid request body" };
  const filters: WebhookEventFilter[] = [];
  for (let i = 0; i < raw.length; i++) {
    const f = raw[i];
    if (typeof f !== "object" || f === null || Array.isArray(f)) {
      return { error: "invalid request body" };
    }
    const event = (f as Record<string, unknown>).event;
    if (typeof event !== "string" && event !== undefined && event !== null) {
      return { error: "invalid request body" };
    }
    if (typeof event !== "string" || event.trim() === "") {
      return { error: `event_filters[${i}].event must not be empty` };
    }
    const rawActions = (f as Record<string, unknown>).actions;
    let actions: string[] | undefined;
    if (rawActions !== undefined && rawActions !== null) {
      if (!Array.isArray(rawActions)) return { error: "invalid request body" };
      actions = [];
      for (let j = 0; j < rawActions.length; j++) {
        const a = rawActions[j];
        if (typeof a !== "string") return { error: "invalid request body" };
        if (a.trim() === "") {
          return { error: `event_filters[${i}].actions[${j}] must not be empty` };
        }
        actions.push(a);
      }
    }
    filters.push(actions && actions.length > 0 ? { event, actions } : { event });
  }
  return { filters };
}

function isValidAssigneeType(t: string): boolean {
  return t === "agent" || t === "squad";
}

function isAllowedWebhookProvider(p: string): boolean {
  return p === "generic" || p === "github";
}

// ── Response mappers (snake_case, mirror the Go structs) ────────────────────

/** Mirrors the Go AutopilotResponse struct (same mapper as ./autopilots.ts). */
function autopilotToResponse(a: Autopilot) {
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

function webhookPathForToken(token: string): string {
  return `/api/webhooks/autopilots/${token}`;
}

function signingSecretHint(secret: string): string {
  return secret.length < 4 ? "" : secret.slice(-4);
}

/** Mirrors the Go AutopilotTriggerResponse struct (same mapper as ./autopilots.ts). */
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

/** Mirrors the Go AutopilotRunResponse struct. */
function runToResponse(r: AutopilotRun) {
  return {
    id: r.id,
    autopilot_id: r.autopilotId,
    trigger_id: r.triggerId,
    source: r.source,
    status: r.status,
    issue_id: r.issueId,
    task_id: r.taskId,
    triggered_at: r.triggeredAt,
    completed_at: r.completedAt,
    failure_reason: r.failureReason,
    trigger_payload: r.triggerPayload ?? null,
    result: r.result ?? null,
    created_at: r.createdAt,
  };
}

/**
 * Mirrors the Go WebhookDeliveryResponse in detail mode: the slim fields plus
 * selected_headers / raw_body / response_body (each omitted when absent —
 * matches the Go struct's omitempty).
 */
function deliveryDetailToResponse(d: WebhookDelivery) {
  const resp: Record<string, unknown> = {
    id: d.id,
    workspace_id: d.workspaceId,
    autopilot_id: d.autopilotId,
    trigger_id: d.triggerId,
    provider: d.provider,
    event: d.event,
    dedupe_key: d.dedupeKey,
    dedupe_source: d.dedupeSource,
    signature_status: d.signatureStatus,
    status: d.status,
    attempt_count: d.attemptCount,
    content_type: d.contentType,
    response_status: d.responseStatus,
    autopilot_run_id: d.autopilotRunId,
    replayed_from_delivery_id: d.replayedFromDeliveryId,
    error: d.error,
    received_at: d.receivedAt,
    last_attempt_at: d.lastAttemptAt,
    created_at: d.createdAt,
  };
  if (d.selectedHeaders !== null && d.selectedHeaders !== undefined) {
    resp.selected_headers = d.selectedHeaders;
  }
  if (d.rawBody && d.rawBody.length > 0) {
    resp.raw_body = Buffer.from(d.rawBody).toString("utf8");
  }
  if (d.responseBody !== null) {
    resp.response_body = d.responseBody;
  }
  return resp;
}

// ── Request-scoped loaders / gates ──────────────────────────────────────────

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
 * Resolve the autopilot inside the workspace (mirrors Go
 * loadAutopilotInWorkspace). Returns the row or a 404 Response — malformed
 * UUIDs collapse into the same 404, matching the sibling Bun routes.
 */
async function loadAutopilot(
  c: Context<AppEnv>,
  db: Db,
  wsId: string,
): Promise<Autopilot | Response> {
  const id = c.req.param("id");
  if (!id || !UUID_RE.test(id)) return c.json({ error: "autopilot not found" }, 404);
  const found = await getAutopilotInWorkspace(db, wsId, id);
  if (!found) return c.json({ error: "autopilot not found" }, 404);
  return found;
}

/**
 * Resolve a trigger belonging to the given autopilot (mirrors the Go
 * GetAutopilotTrigger + ownership cross-check). 404 on miss / cross-autopilot.
 */
async function loadTrigger(
  c: Context<AppEnv>,
  db: Db,
  ap: Autopilot,
): Promise<AutopilotTrigger | Response> {
  const triggerId = c.req.param("triggerId");
  if (!triggerId || !UUID_RE.test(triggerId)) return c.json({ error: "trigger not found" }, 404);
  const trig = await getAutopilotTrigger(db, triggerId);
  if (!trig || trig.autopilotId !== ap.id) return c.json({ error: "trigger not found" }, 404);
  return trig;
}

/**
 * Validate that the assignee (agent or squad) exists in the workspace, and for
 * squad assignees that the squad and its leader are not archived. Mirrors the
 * Go validateAutopilotAssignee save-time checks (same helper as ./autopilots.ts,
 * minus the private-leader gate which depends on the actor-resolution service).
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

// ── Route factory ───────────────────────────────────────────────────────────

export function autopilotActionsRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // PATCH /api/autopilots/:id — partial update (mirrors Go UpdateAutopilot).
  // description / issue_title_template / project_id distinguish "absent" from
  // "explicit null" (null clears); title / status / execution_mode only apply
  // when sent as strings; assignee_type + assignee_id are validated as a pair.
  r.patch("/api/autopilots/:id", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const prev = await loadAutopilot(c, db, ws);
    if (prev instanceof Response) return prev;

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return c.json({ error: "invalid request body" }, 400);
    }

    // Pre-fill from the loaded row, exactly like the Go handler's params —
    // these three columns are written unconditionally by the UPDATE.
    const set: Partial<typeof prev> = {
      description: prev.description,
      issueTitleTemplate: prev.issueTitleTemplate,
      projectId: prev.projectId,
    };

    if (typeof body.title === "string") set.title = body.title;
    if (typeof body.status === "string") set.status = body.status;
    if (typeof body.execution_mode === "string") set.executionMode = body.execution_mode;
    if ("description" in body) {
      set.description = typeof body.description === "string" ? body.description : null;
    }
    if ("issue_title_template" in body) {
      if (typeof body.issue_title_template === "string") {
        const msg = validateIssueTitleTemplate(body.issue_title_template);
        if (msg) return c.json({ error: msg }, 400);
        set.issueTitleTemplate = body.issue_title_template;
      } else {
        set.issueTitleTemplate = null;
      }
    }
    if ("project_id" in body) {
      if (typeof body.project_id === "string" && body.project_id !== "") {
        if (!UUID_RE.test(body.project_id)) {
          return c.json({ error: "invalid project_id" }, 400);
        }
        const project = await getProjectInWorkspace(db, ws, body.project_id);
        if (!project) {
          return c.json({ error: "project_id must reference a project in this workspace" }, 400);
        }
        set.projectId = body.project_id;
      } else {
        set.projectId = null;
      }
    }

    // assignee_type and assignee_id are validated as a pair: switching between
    // agent and squad without supplying a new id would leave the row pointing
    // at the wrong table (mirrors the Go pairing rules).
    const typeSent = "assignee_type" in body;
    const idSent = "assignee_id" in body;
    if (typeSent || idSent) {
      let nextType = prev.assigneeType;
      if (typeSent && typeof body.assignee_type === "string" && body.assignee_type !== "") {
        nextType = body.assignee_type;
      }
      if (!isValidAssigneeType(nextType)) {
        return c.json({ error: "assignee_type must be agent or squad" }, 400);
      }
      let nextId = prev.assigneeId;
      if (idSent) {
        if (body.assignee_id === null) {
          return c.json({ error: "assignee_id cannot be null" }, 400);
        }
        if (typeof body.assignee_id !== "string" || !UUID_RE.test(body.assignee_id)) {
          return c.json({ error: "invalid assignee_id" }, 400);
        }
        nextId = body.assignee_id;
      }
      if (typeSent && !idSent && nextType !== prev.assigneeType) {
        return c.json({ error: "assignee_id is required when changing assignee_type" }, 400);
      }
      const assigneeErr = await validateAssignee(c, db, nextType, nextId, ws);
      if (assigneeErr) return assigneeErr;
      if (typeSent) set.assigneeType = nextType;
      if (idSent) set.assigneeId = nextId;
    }

    const updated = await updateAutopilot(db, prev.id, set);
    if (!updated) return c.json({ error: "failed to update autopilot" }, 500);

    bus.publish({ type: "autopilot.updated", workspaceId: ws, payload: { id: updated.id } });
    return c.json(autopilotToResponse(updated));
  });

  // DELETE /api/autopilots/:id (mirrors Go DeleteAutopilot).
  r.delete("/api/autopilots/:id", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const found = await loadAutopilot(c, db, ws);
    if (found instanceof Response) return found;

    await deleteAutopilot(db, found.id);
    bus.publish({ type: "autopilot.deleted", workspaceId: ws, payload: { id: found.id } });
    return c.body(null, 204);
  });

  // POST /api/autopilots/:id/trigger — the "Run now" button (mirrors Go
  // TriggerAutopilot): manual-source dispatch through the shared helper, then
  // the created run is returned in full.
  r.post("/api/autopilots/:id/trigger", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const found = await loadAutopilot(c, db, ws);
    if (found instanceof Response) return found;
    if (found.status !== "active") {
      return c.json({ error: "autopilot is not active" }, 400);
    }

    let runId: string;
    try {
      const res = await dispatchAutopilot(db, { autopilotId: found.id, source: "manual" });
      runId = res.runId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `failed to trigger autopilot: ${msg}` }, 500);
    }

    const run = await getAutopilotRun(db, runId);
    if (!run) return c.json({ error: "failed to trigger autopilot: run not found" }, 500);

    // Go's dispatch service publishes autopilot:run_start from inside the
    // service; the Bun dispatch helper is bus-free, so the route publishes.
    bus.publish({
      type: "autopilot.run_start",
      workspaceId: ws,
      payload: { run_id: run.id, autopilot_id: found.id, source: "manual", status: run.status },
    });
    return c.json(runToResponse(run));
  });

  // POST /api/autopilots/:id/triggers (mirrors Go CreateAutopilotTrigger).
  r.post("/api/autopilots/:id/triggers", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const ap = await loadAutopilot(c, db, ws);
    if (ap instanceof Response) return ap;

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }

    const kind = typeof body.kind === "string" ? body.kind : "";
    if (kind === "") return c.json({ error: "kind is required" }, 400);
    if (kind !== "schedule" && kind !== "webhook") {
      // "api" kind is deprecated (reserved-but-inert in Go) — reject loudly.
      return c.json({ error: "kind must be schedule or webhook" }, 400);
    }
    const cronExpression =
      typeof body.cron_expression === "string" ? body.cron_expression : null;
    const timezone = typeof body.timezone === "string" ? body.timezone : null;
    const label = typeof body.label === "string" ? body.label : null;

    if (kind === "schedule" && (!cronExpression || cronExpression === "")) {
      return c.json({ error: "cron_expression is required for schedule triggers" }, 400);
    }
    if (kind === "webhook" && timezone && timezone !== "") {
      // Webhook triggers fire on demand — no next_run_at, so a timezone is
      // meaningless. Reject loudly instead of silently dropping the field.
      return c.json({ error: "timezone is not valid for webhook triggers" }, 400);
    }

    let eventFilters: WebhookEventFilter[] = [];
    if (body.event_filters !== undefined && body.event_filters !== null) {
      const parsed = parseEventFilters(body.event_filters);
      if ("error" in parsed) return c.json({ error: parsed.error }, 400);
      eventFilters = parsed.filters;
    }
    if (kind !== "webhook" && eventFilters.length > 0) {
      return c.json({ error: "event_filters is only valid for webhook triggers" }, 400);
    }

    // Provider only applies to webhook triggers; the value space is closed.
    let provider = "generic";
    if (typeof body.provider === "string" && body.provider !== "") {
      if (kind !== "webhook") {
        return c.json({ error: "provider is only valid for webhook triggers" }, 400);
      }
      if (!isAllowedWebhookProvider(body.provider)) {
        return c.json({ error: "provider must be generic or github" }, 400);
      }
      provider = body.provider;
    }

    if (timezone && timezone !== "") {
      const msg = validateTimezone(timezone);
      if (msg) return c.json({ error: msg }, 400);
    }

    let trigger: AutopilotTrigger;
    if (kind === "webhook") {
      // Mint the token BEFORE the INSERT so the row never exists in a
      // half-written kind=webhook + webhook_token=NULL state; retry on the
      // (vanishingly rare) unique-index collision (mirrors Go
      // createWebhookTriggerWithMintedToken).
      let created: AutopilotTrigger | null = null;
      for (let attempt = 0; attempt < 3 && !created; attempt++) {
        try {
          created = await createAutopilotTrigger(db, {
            autopilotId: ap.id,
            kind: "webhook",
            enabled: true,
            label,
            webhookToken: generateWebhookToken(),
            provider,
            // nil on empty (column stays NULL → matcher allows every event);
            // never write an explicit [] on create (mirrors Go).
            eventFilters: eventFilters.length > 0 ? eventFilters : null,
          });
        } catch (err) {
          if (!isUniqueViolation(err)) {
            return c.json({ error: "failed to create trigger" }, 500);
          }
        }
      }
      if (!created) return c.json({ error: "failed to create trigger" }, 500);
      trigger = created;
    } else {
      const tz = timezone && timezone !== "" ? timezone : "UTC";
      let nextRunAt: string;
      try {
        nextRunAt = computeNextRun(cronExpression!, tz).toISOString();
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
      trigger = await createAutopilotTrigger(db, {
        autopilotId: ap.id,
        kind: "schedule",
        enabled: true,
        cronExpression,
        timezone,
        nextRunAt,
        label,
      });
    }

    bus.publish({
      type: "autopilot.updated",
      workspaceId: ws,
      payload: { id: ap.id, trigger_id: trigger.id },
    });
    return c.json(triggerToResponse(trigger), 201);
  });

  // PATCH /api/autopilots/:id/triggers/:triggerId (mirrors Go
  // UpdateAutopilotTrigger, incl. the tri-state event_filters PATCH).
  r.patch("/api/autopilots/:id/triggers/:triggerId", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const ap = await loadAutopilot(c, db, ws);
    if (ap instanceof Response) return ap;
    const prev = await loadTrigger(c, db, ap);
    if (prev instanceof Response) return prev;

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }

    // Go pointer semantics: a field counts as "sent" when present AND non-null.
    const cronSent = body.cron_expression !== undefined && body.cron_expression !== null;
    const tzSent = body.timezone !== undefined && body.timezone !== null;

    // Kind-specific validation: cron/timezone only make sense on schedule
    // triggers; enabled and label remain valid on every kind (mirrors Go).
    if (prev.kind !== "schedule") {
      if (cronSent) {
        return c.json({ error: "cron_expression is only valid for schedule triggers" }, 400);
      }
      if (tzSent) {
        return c.json({ error: "timezone is only valid for schedule triggers" }, 400);
      }
    }

    // Pre-fill next_run_at from the loaded row — the Go UPDATE writes it
    // unconditionally (recomputed below for schedule triggers).
    const set: Partial<NewAutopilotTrigger> = { nextRunAt: prev.nextRunAt };

    if (typeof body.enabled === "boolean") set.enabled = body.enabled;
    if (cronSent && typeof body.cron_expression === "string") {
      set.cronExpression = body.cron_expression;
    }
    if (tzSent && typeof body.timezone === "string") {
      if (body.timezone !== "") {
        const msg = validateTimezone(body.timezone);
        if (msg) return c.json({ error: msg }, 400);
      }
      set.timezone = body.timezone;
    }
    if (typeof body.label === "string") set.label = body.label;

    // Tri-state PATCH for event_filters: omitted / null → leave untouched;
    // explicit [] → clear (stored as the JSONB literal []); [...] → replace.
    if (body.event_filters !== undefined && body.event_filters !== null) {
      if (prev.kind !== "webhook") {
        return c.json({ error: "event_filters is only valid for webhook triggers" }, 400);
      }
      const parsed = parseEventFilters(body.event_filters);
      if ("error" in parsed) return c.json({ error: parsed.error }, 400);
      set.eventFilters = parsed.filters;
    }

    // Recompute next_run_at if this is a schedule trigger (mirrors Go: the
    // effective cron/timezone — new value when sent, else previous — drives it).
    let cronExpr = prev.cronExpression ?? "";
    if (typeof set.cronExpression === "string") cronExpr = set.cronExpression;
    let tz = prev.timezone && prev.timezone !== "" ? prev.timezone : "UTC";
    if (typeof set.timezone === "string" && set.timezone !== "") tz = set.timezone;
    if (prev.kind === "schedule" && cronExpr !== "") {
      try {
        set.nextRunAt = computeNextRun(cronExpr, tz).toISOString();
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    }

    const updated = await updateAutopilotTrigger(db, prev.id, set);
    if (!updated) return c.json({ error: "failed to update trigger" }, 500);

    bus.publish({
      type: "autopilot.updated",
      workspaceId: ws,
      payload: { id: ap.id, trigger_id: updated.id },
    });
    return c.json(triggerToResponse(updated));
  });

  // DELETE /api/autopilots/:id/triggers/:triggerId (mirrors Go
  // DeleteAutopilotTrigger).
  r.delete("/api/autopilots/:id/triggers/:triggerId", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const ap = await loadAutopilot(c, db, ws);
    if (ap instanceof Response) return ap;
    const trig = await loadTrigger(c, db, ap);
    if (trig instanceof Response) return trig;

    await deleteAutopilotTrigger(db, trig.id);
    bus.publish({
      type: "autopilot.updated",
      workspaceId: ws,
      payload: { id: ap.id, trigger_id: trig.id },
    });
    return c.body(null, 204);
  });

  // POST /api/autopilots/:id/triggers/:triggerId/rotate-webhook-token —
  // issues a fresh bearer token; the old one stops working immediately
  // (mirrors Go RotateAutopilotTriggerWebhookToken).
  r.post("/api/autopilots/:id/triggers/:triggerId/rotate-webhook-token", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const ap = await loadAutopilot(c, db, ws);
    if (ap instanceof Response) return ap;
    const prev = await loadTrigger(c, db, ap);
    if (prev instanceof Response) return prev;
    if (prev.kind !== "webhook") {
      return c.json({ error: "trigger is not a webhook trigger" }, 400);
    }

    let rotated: AutopilotTrigger | null = null;
    for (let attempt = 0; attempt < 3 && !rotated; attempt++) {
      try {
        rotated = await rotateAutopilotTriggerWebhookToken(db, prev.id, generateWebhookToken());
      } catch (err) {
        if (!isUniqueViolation(err)) {
          return c.json({ error: "failed to rotate webhook token" }, 500);
        }
      }
    }
    if (!rotated) return c.json({ error: "failed to rotate webhook token" }, 500);

    bus.publish({
      type: "autopilot.updated",
      workspaceId: ws,
      payload: { id: ap.id, trigger_id: rotated.id },
    });
    return c.json(triggerToResponse(rotated));
  });

  // GET /api/autopilots/:id/deliveries/:deliveryId — one delivery in full,
  // including raw_body + selected_headers (mirrors Go GetAutopilotDelivery;
  // the slim list lives in ./webhookDeliveries.ts).
  r.get("/api/autopilots/:id/deliveries/:deliveryId", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const ap = await loadAutopilot(c, db, ws);
    if (ap instanceof Response) return ap;

    const deliveryId = c.req.param("deliveryId");
    if (!deliveryId || !UUID_RE.test(deliveryId)) {
      return c.json({ error: "delivery not found" }, 404);
    }
    const delivery = await getWebhookDeliveryInWorkspace(db, ap.workspaceId, deliveryId);
    // Cross-autopilot IDs are 404 too — defense in depth against ID guessing.
    if (!delivery || delivery.autopilotId !== ap.id) {
      return c.json({ error: "delivery not found" }, 404);
    }
    return c.json(deliveryDetailToResponse(delivery));
  });

  // POST /api/autopilots/:id/deliveries/:deliveryId/replay — creates a NEW
  // delivery row from a prior one and dispatches the autopilot synchronously
  // (mirrors Go ReplayAutopilotDelivery). The new row carries
  // replayed_from_delivery_id and a NULL dedupe_key (a replay is explicitly
  // "run this again", so it must not collapse onto the original via the
  // dedupe index). Replays of signature-failed deliveries are rejected.
  r.post("/api/autopilots/:id/deliveries/:deliveryId/replay", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const ap = await loadAutopilot(c, db, ws);
    if (ap instanceof Response) return ap;

    const deliveryId = c.req.param("deliveryId");
    if (!deliveryId || !UUID_RE.test(deliveryId)) {
      return c.json({ error: "delivery not found" }, 404);
    }
    const original = await getWebhookDeliveryInWorkspace(db, ap.workspaceId, deliveryId);
    if (!original || original.autopilotId !== ap.id) {
      return c.json({ error: "delivery not found" }, 404);
    }
    if (original.status === "rejected" || original.signatureStatus === "invalid") {
      return c.json({ error: "cannot replay a delivery that failed signature verification" }, 400);
    }
    if (!original.rawBody || original.rawBody.length === 0) {
      return c.json({ error: "original delivery has no raw body to replay" }, 400);
    }
    if (ap.status !== "active") {
      return c.json({ error: "autopilot is not active" }, 400);
    }

    const trigger = await getAutopilotTrigger(db, original.triggerId);
    if (!trigger) return c.json({ error: "trigger not found" }, 404);
    if (!trigger.enabled) return c.json({ error: "trigger is disabled" }, 400);

    // Re-parse the stored raw body. The Bun ingress dispatches the parsed
    // body as the trigger payload (Go wraps it in a WebhookEnvelope via
    // normalizeWebhookPayload; the stored `event` column already carries the
    // header-inferred event, so we reuse it). Scalars are rejected like Go.
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(original.rawBody).toString("utf8"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `stored body no longer parses: ${msg}` }, 400);
    }
    if (typeof payload !== "object" || payload === null) {
      return c.json({ error: "stored body no longer parses: not a JSON object or array" }, 400);
    }

    const replay = await createWebhookDelivery(db, {
      workspaceId: ap.workspaceId,
      autopilotId: ap.id,
      triggerId: original.triggerId,
      provider: original.provider,
      event: original.event,
      signatureStatus: "not_required",
      status: "queued",
      selectedHeaders: original.selectedHeaders ?? {},
      contentType: original.contentType && original.contentType !== "" ? original.contentType : null,
      rawBody: Buffer.from(original.rawBody),
      replayedFromDeliveryId: original.id,
      // dedupe_key intentionally NULL — replays bypass per-trigger dedupe.
    });

    let runId: string;
    try {
      const res = await dispatchAutopilot(db, {
        autopilotId: ap.id,
        source: "webhook",
        triggerId: trigger.id,
        payload,
      });
      runId = res.runId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await finaliseWebhookDeliveryTerminal(
        db,
        replay.id,
        "failed",
        msg,
        500,
        JSON.stringify({ error: "failed to dispatch autopilot" }),
      );
      return c.json({ error: msg }, 500);
    }

    await touchAutopilotTriggerFiredAt(db, trigger.id);

    // Delivery is `dispatched` once a run is produced (mirrors Go).
    const respBody = {
      status: "accepted",
      delivery_id: replay.id,
      run_id: runId,
      autopilot_id: ap.id,
      trigger_id: trigger.id,
      replayed_from_delivery_id: original.id,
    };
    await finaliseWebhookDeliveryWithRun(
      db,
      replay.id,
      "dispatched",
      runId,
      201,
      JSON.stringify(respBody),
    );

    const final = await getWebhookDelivery(db, replay.id);
    if (!final) return c.json(respBody, 201);
    return c.json(deliveryDetailToResponse(final), 201);
  });

  return r;
}
