/**
 * Webhook-delivery routes — port of the Go webhook_delivery handler's list
 * endpoint (server/internal/handler/webhook_delivery.go: ListAutopilotDeliveries),
 * backing the "Deliveries" UI behind autopilot webhooks.
 *
 *   GET /api/autopilots/:id/deliveries -> { deliveries: [...], total: N }
 *
 * Recent webhook_delivery rows for the autopilot, scoped to the workspace,
 * newest first (created_at DESC), as a slim projection — raw_body /
 * selected_headers / response_body are NOT returned (matches the Go slim list
 * response; the detail endpoint, which is out of scope here, opts into those).
 *
 * Behind the /api/* JWT gate and scoped to a workspace via the X-Workspace-ID
 * header + a membership check (multi-tenancy). The autopilot is resolved by
 * UUID and must belong to the requesting workspace, mirroring the Go loader.
 *
 * This is a standalone route factory declaring ABSOLUTE paths, so it composes
 * alongside the existing autopilot routes without editing that file.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import { getMembership } from "../../db/queries/issues.js";
import { getAutopilotInWorkspace } from "../../db/queries/autopilots.js";
import {
  listWebhookDeliveriesByAutopilot,
  type WebhookDeliverySlim,
} from "../../db/queries/webhookDeliveries.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

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

/** Map a slim list row into the snake_case wire response (mirrors Go slimDeliveryToResponse). */
function deliveryToResponse(d: WebhookDeliverySlim) {
  return {
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
    // raw_body / selected_headers / response_body are intentionally omitted
    // from the slim list response (matches Go).
  };
}

/**
 * Parse a non-negative integer query param, falling back to `fallback` on a
 * missing/invalid value (mirrors Go's strconv.Atoi guards).
 */
function intParam(raw: string | undefined, fallback: number, min: number): number {
  if (!raw) return fallback;
  const v = Number.parseInt(raw, 10);
  if (Number.isNaN(v) || v < min) return fallback;
  return v;
}

export function webhookDeliveryRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // GET /api/autopilots/:id/deliveries — recent deliveries for the autopilot.
  r.get("/api/autopilots/:id/deliveries", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    // Resolve the autopilot inside the workspace first (404 on miss / wrong
    // workspace), exactly like the Go loadAutopilotInWorkspace gate.
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "autopilot not found" }, 404);
    const autopilot = await getAutopilotInWorkspace(db, ws, id);
    if (!autopilot) return c.json({ error: "autopilot not found" }, 404);

    // limit defaults to 20, clamped to [1, 100]; offset defaults to 0 (mirrors Go).
    let limit = intParam(c.req.query("limit"), DEFAULT_LIMIT, 1);
    if (limit > MAX_LIMIT) limit = MAX_LIMIT;
    const offset = intParam(c.req.query("offset"), 0, 0);

    const rows = await listWebhookDeliveriesByAutopilot(
      db,
      autopilot.workspaceId,
      autopilot.id,
      limit,
      offset,
    );
    const deliveries = rows.map(deliveryToResponse);
    return c.json({ deliveries, total: deliveries.length });
  });

  return r;
}
