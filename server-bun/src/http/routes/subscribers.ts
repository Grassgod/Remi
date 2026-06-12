/**
 * Issue-subscriber routes — port of the Go subscriber handler
 * (server/internal/handler/subscriber.go: ListIssueSubscribers,
 * SubscribeToIssue, UnsubscribeFromIssue).
 *
 * Subscribers are the watchers fanned out to on issue activity. Each row is a
 * (issue_id, user_type, user_id) composite with a `reason` ("manual" for an
 * explicit subscribe). There is no separate table beyond issue_subscriber and
 * no workspace_id column — the issue carries the workspace.
 *
 * Declared on absolute /api/issues/:id/subscribers paths in a standalone
 * factory so it composes alongside issueRoutes without editing that file.
 * Behind the /api/* JWT gate; scoped to a workspace via X-Workspace-ID + a
 * membership check (multi-tenancy), exactly like issueRoutes.
 *
 * Path shape: this port exposes the REST verbs on a single collection path
 * (GET = list, POST = subscribe, DELETE = unsubscribe). The Go router used
 * POST /subscribe + POST /unsubscribe sub-paths; the request/response shapes
 * and `reason` value ("manual") are preserved.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import { getIssueByIdentifier, getMembership } from "../../db/queries/issues.js";
import {
  addIssueSubscriber,
  listIssueSubscribers,
  removeIssueSubscriber,
  type IssueSubscriber,
} from "../../db/queries/subscribers.js";
import { bus } from "../../realtime/bus.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reason recorded for an explicit, user-initiated subscribe (mirrors Go). */
const REASON_MANUAL = "manual";

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

/** snake_case JSON shape returned per subscriber (mirrors Go SubscriberResponse). */
function subscriberToResponse(s: IssueSubscriber) {
  return {
    issue_id: s.issueId,
    user_type: s.userType,
    user_id: s.userId,
    reason: s.reason,
    created_at: s.createdAt,
  };
}

export function subscriberRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // GET /api/issues/:id/subscribers -> [{ issue_id, user_type, user_id, reason, created_at }]
  r.get("/api/issues/:id/subscribers", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const found = await getIssueByIdentifier(db, ws, c.req.param("id"));
    if (!found) return c.json({ error: "issue not found" }, 404);

    const subscribers = await listIssueSubscribers(db, found.id);
    return c.json(subscribers.map(subscriberToResponse));
  });

  // POST /api/issues/:id/subscribers -> subscribe the current member.
  // Idempotent (ON CONFLICT DO NOTHING); returns { subscribed: true } to match Go.
  r.post("/api/issues/:id/subscribers", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const found = await getIssueByIdentifier(db, ws, c.req.param("id"));
    if (!found) return c.json({ error: "issue not found" }, 404);

    const userId = c.get("user").sub;
    await addIssueSubscriber(db, {
      issueId: found.id,
      userType: "member",
      userId,
      reason: REASON_MANUAL,
    });

    bus.publish({
      type: "subscriber:added",
      workspaceId: ws,
      payload: {
        issue_id: found.id,
        user_type: "member",
        user_id: userId,
        reason: REASON_MANUAL,
      },
    });

    return c.json({ subscribed: true });
  });

  // DELETE /api/issues/:id/subscribers -> unsubscribe the current member.
  // Returns { subscribed: false } to match Go.
  r.delete("/api/issues/:id/subscribers", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const found = await getIssueByIdentifier(db, ws, c.req.param("id"));
    if (!found) return c.json({ error: "issue not found" }, 404);

    const userId = c.get("user").sub;
    await removeIssueSubscriber(db, {
      issueId: found.id,
      userType: "member",
      userId,
    });

    bus.publish({
      type: "subscriber:removed",
      workspaceId: ws,
      payload: { issue_id: found.id, user_type: "member", user_id: userId },
    });

    return c.json({ subscribed: false });
  });

  return r;
}
