/**
 * Notification-preference routes — port of the Go notification_preference
 * handler: GET /api/notification-preferences (the authed user's prefs for the
 * workspace) and PUT /api/notification-preferences (upsert). Behind the /api/*
 * JWT gate; scoped to a workspace via the X-Workspace-ID header + a membership
 * check (multi-tenancy — mirrors the Go RequireWorkspaceMember middleware that
 * wraps these routes).
 *
 * The prefs themselves are keyed on (workspace_id, user_id): the recipient is
 * the requesting user, so a member only ever reads/writes their own prefs.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import { getMembership } from "../../db/queries/issues.js";
import {
  getNotificationPreference,
  upsertNotificationPreference,
  VALID_NOTIF_GROUPS,
  VALID_NOTIF_VALUES,
} from "../../db/queries/notifications.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * Coerce a stored jsonb preferences blob into a string→string map. Defensive:
 * non-string values are dropped (mirrors Go's json.Unmarshal into
 * map[string]string, which falls back to an empty map on a type mismatch).
 */
function coercePreferences(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
  }
  return out;
}

interface UpdateNotifPrefRequest {
  preferences?: Record<string, string> | null;
}

export function notificationRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // GET /api/notification-preferences — the authed user's prefs for the
  // workspace. No row yet → empty preferences map (mirrors Go pgx.ErrNoRows).
  r.get("/", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    const userId = c.get("user").sub;
    const pref = await getNotificationPreference(db, ws, userId);
    return c.json({
      workspace_id: ws,
      preferences: pref ? coercePreferences(pref.preferences) : {},
    });
  });

  // PUT /api/notification-preferences — upsert the authed user's prefs.
  // Validates each group/value against the allowed sets (mirrors Go
  // validNotifGroups / validNotifValues).
  r.put("/", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    let body: UpdateNotifPrefRequest;
    try {
      body = (await c.req.json()) as UpdateNotifPrefRequest;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }

    const preferences = body?.preferences;
    if (preferences == null || typeof preferences !== "object" || Array.isArray(preferences)) {
      return c.json({ error: "preferences field is required" }, 400);
    }

    for (const [k, v] of Object.entries(preferences)) {
      if (!VALID_NOTIF_GROUPS.has(k)) {
        return c.json({ error: `invalid preference group: ${k}` }, 400);
      }
      if (typeof v !== "string" || !VALID_NOTIF_VALUES.has(v)) {
        return c.json({ error: `invalid preference value: ${String(v)}` }, 400);
      }
    }

    const userId = c.get("user").sub;
    const pref = await upsertNotificationPreference(db, ws, userId, preferences);
    return c.json({
      workspace_id: ws,
      preferences: coercePreferences(pref.preferences),
    });
  });

  return r;
}
