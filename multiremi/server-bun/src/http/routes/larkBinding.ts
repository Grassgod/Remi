/**
 * Lark binding + installation-admin routes — port of the Go lark handlers:
 *
 *   POST   /api/lark/binding/redeem                                  (h.RedeemLarkBindingToken)
 *   POST   /api/workspaces/{id}/lark/install/begin                   (h.BeginLarkInstall)
 *   GET    /api/workspaces/{id}/lark/install/{installId}/status      (h.GetLarkInstallStatus)
 *   DELETE /api/workspaces/{id}/lark/installations/{installationId}  (h.RevokeLarkInstallation)
 *
 * Declares absolute paths → mount at "/". Behind the /api/* JWT gate. The
 * member-visible installations LIST lives in routes/larkInstallations.ts.
 *
 * Redeem is NOT workspace-scoped: the redeemer hits it before they have any
 * workspace context — the redemption itself mints their lark_user_binding row.
 * It is DB-only (no Feishu API round-trip) and is available whenever the
 * at-rest key (MULTIMIRA_LARK_SECRET_KEY) is set, mirroring the Go wiring where
 * the BindingTokenService exists iff that key is present.
 *
 * The workspace-scoped routes are admin-only (owner/admin), mirroring the Go
 * router's RequireWorkspaceRoleFromURL group. The device-flow install needs
 * the live Lark registration client, which the Bun port does not have —
 * begin/status return Go's not-configured 503 unconditionally (matching a Go
 * deployment without a RegistrationService; the UI hides the bind button via
 * install_supported=false on the list endpoint). Revoke is pure DB and works
 * without Feishu credentials.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import type { Member } from "../../db/schema.js";
import { getMembership } from "../../db/queries/issues.js";
import {
  getLarkInstallationInWorkspace,
  redeemAndBind,
  revokeLarkInstallation,
  type RedeemOutcome,
} from "../../db/queries/larkBinding.js";
import { boxFromEnv } from "../../util/secretbox.js";
import { bus } from "../../realtime/bus.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Env var holding the base64 AES-256-GCM at-rest key. Mirrors the Go wiring:
 * the InstallationService / BindingTokenService only exist when it is set. */
const LARK_SECRET_KEY_ENV = "MULTIMIRA_LARK_SECRET_KEY";

/** True when the at-rest key is set and well-formed. A set-but-invalid key
 * would fail the Go server at boot; here we degrade to "not configured"
 * (same choice as routes/larkInstallations.ts). */
function larkConfigured(): boolean {
  try {
    return boxFromEnv(LARK_SECRET_KEY_ENV) !== null;
  } catch {
    return false;
  }
}

/** Mirrors the Go roleAllowed gate for install/revoke (owner/admin only). */
function canManageRole(role: string): boolean {
  return role === "owner" || role === "admin";
}

/**
 * Resolve + authorize the workspace from the URL param at admin level —
 * mirrors the Go RequireWorkspaceRoleFromURL(id, owner, admin) middleware:
 * 400 malformed id, 404 not-a-member, 403 insufficient role.
 */
async function requireAdminWorkspace(c: Context<AppEnv>, db: Db): Promise<Member | Response> {
  const candidate = c.req.param("id");
  if (!candidate || !UUID_RE.test(candidate)) {
    return c.json({ error: "invalid workspace id" }, 400);
  }
  const m = await getMembership(db, c.get("user").sub, candidate);
  if (!m) return c.json({ error: "workspace not found" }, 404);
  if (!canManageRole(m.role)) return c.json({ error: "insufficient permissions" }, 403);
  return m;
}

export function larkBindingRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // POST /api/lark/binding/redeem — exchange a binding token for a
  // lark_user_binding row. Identity comes from the session, not the token, so
  // a stolen token cannot bind an open_id to an attacker's account. Status
  // codes mirror Go exactly: 410 token invalid/consumed/expired, 409 open_id
  // bound to a different user (token NOT consumed), 403 redeemer is not a
  // member of the token's workspace.
  r.post("/api/lark/binding/redeem", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    if (!larkConfigured()) return c.json({ error: "lark integration not configured" }, 503);

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }
    const token = typeof body.token === "string" ? body.token : "";
    if (token === "") return c.json({ error: "token is required" }, 400);

    let outcome: RedeemOutcome;
    try {
      outcome = await redeemAndBind(db, token, c.get("user").sub);
    } catch {
      return c.json({ error: "failed to redeem token" }, 500);
    }
    if (!outcome.ok) {
      switch (outcome.reason) {
        case "invalid":
          return c.json({ error: "binding token invalid or expired" }, 410);
        case "conflict":
          return c.json(
            { error: "this Lark account is already bound to a different Multiremi user" },
            409,
          );
        case "not_member":
          return c.json({ error: "binding refused (are you a workspace member?)" }, 403);
      }
    }
    return c.json({
      workspace_id: outcome.workspaceId,
      installation_id: outcome.installationId,
      lark_open_id: outcome.larkOpenId,
    });
  });

  // POST /api/workspaces/:id/lark/install/begin — device-flow install. The
  // Bun port has no Lark RegistrationService, so after the admin gate this
  // mirrors the Go not-configured branch (503). The UI never reaches it
  // through the normal flow: the list endpoint reports install_supported=false.
  r.post("/api/workspaces/:id/lark/install/begin", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const m = await requireAdminWorkspace(c, db);
    if (m instanceof Response) return m;
    return c.json({ error: "lark install not configured" }, 503);
  });

  // GET /api/workspaces/:id/lark/install/:installId/status — poll an in-flight
  // install session. Registration sessions are in-memory state of the (absent)
  // RegistrationService → same not-configured 503 as begin.
  r.get("/api/workspaces/:id/lark/install/:installId/status", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const m = await requireAdminWorkspace(c, db);
    if (m instanceof Response) return m;
    return c.json({ error: "lark install not configured" }, 503);
  });

  // DELETE /api/workspaces/:id/lark/installations/:installationId — flip the
  // installation to 'revoked' (row preserved for audit). Pure DB, so it works
  // without Feishu credentials — but only when the at-rest key is configured,
  // mirroring Go's nil-service 503.
  r.delete("/api/workspaces/:id/lark/installations/:installationId", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const m = await requireAdminWorkspace(c, db);
    if (m instanceof Response) return m;
    if (!larkConfigured()) return c.json({ error: "lark integration not configured" }, 503);

    const installationId = c.req.param("installationId");
    if (!installationId || !UUID_RE.test(installationId)) {
      return c.json({ error: "invalid installation id" }, 400);
    }
    const installation = await getLarkInstallationInWorkspace(db, installationId, m.workspaceId);
    if (!installation) return c.json({ error: "lark installation not found" }, 404);

    await revokeLarkInstallation(db, installation.id);
    // Same event type the Go server publishes (protocol.EventLarkInstallationRevoked);
    // the frontend's prefix router invalidates larkKeys.installations on it.
    bus.publish({
      type: "lark_installation:revoked",
      workspaceId: m.workspaceId,
      payload: { id: installation.id },
    });
    return c.body(null, 204);
  });

  return r;
}
