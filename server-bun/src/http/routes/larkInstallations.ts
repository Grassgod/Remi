/**
 * Lark installation routes (READ path) — port of the Go lark handler's
 *   GET /api/workspaces/{id}/lark/installations  (h.ListLarkInstallations)
 *
 * Declares an absolute path (like githubRoutes) → mount at "/". Behind the
 * /api/* JWT gate. Member-visible (the Integrations tab must not render
 * blank for non-admins). With no Feishu at-rest key configured this returns
 * an EMPTY list with configured=false — never an error.
 *
 * The revoke / device-flow install writes (admin-gated) are not ported: they
 * need the live Lark registration service + API client.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import { getMembership } from "../../db/queries/issues.js";
import {
  listLarkInstallationsByWorkspace,
  type LarkInstallation,
} from "../../db/queries/lark.js";
import { boxFromEnv } from "../../util/secretbox.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Env var holding the base64 AES-256-GCM key that encrypts app secrets at
 * rest. Mirrors the Go wiring: the InstallationService only exists when the
 * key is set, and `configured` reflects exactly that. */
const LARK_SECRET_KEY_ENV = "MULTIMIRA_LARK_SECRET_KEY";

/**
 * Mirrors the Go LarkInstallationResponse struct (snake_case JSON).
 * `app_secret_encrypted` is INTENTIONALLY absent — the encrypted blob is
 * server-internal. The WS lease columns are runtime state, not API surface.
 * tenant_key carries Go's omitempty: the field is omitted when NULL.
 */
function installationToResponse(row: LarkInstallation) {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    agent_id: row.agentId,
    app_id: row.appId,
    ...(row.tenantKey != null ? { tenant_key: row.tenantKey } : {}),
    bot_open_id: row.botOpenId,
    installer_user_id: row.installerUserId,
    status: row.status,
    region: row.region,
    installed_at: row.installedAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

/**
 * Resolve + authorize the workspace from the URL param. Returns the member
 * row or a Response to short-circuit with (400 malformed id, 404 not-a-member
 * — mirrors the Go RequireWorkspaceMemberFromURL gate).
 */
async function requireMembership(c: Context<AppEnv>, db: Db) {
  const candidate = c.req.param("id");
  if (!candidate || !UUID_RE.test(candidate)) {
    return c.json({ error: "workspace id is required" }, 400);
  }
  const m = await getMembership(db, c.get("user").sub, candidate);
  if (!m) return c.json({ error: "workspace not found" }, 404);
  return m;
}

export function larkInstallationsRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // GET /api/workspaces/:id/lark/installations — every installation rooted at
  // the workspace, active and revoked, oldest first (mirrors Go
  // ListLarkInstallations).
  //
  //   - configured: the at-rest encryption key is set. When false no install
  //     flow can succeed at all; the UI hides the tab — and we return the
  //     empty list WITHOUT touching the DB (mirrors the Go nil-service path).
  //   - install_supported: the device-flow install path is wired end-to-end.
  //     Always false here — the Bun port has no RegistrationService / live
  //     Lark API client; already-installed bots still appear and render.
  r.get("/api/workspaces/:id/lark/installations", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const m = await requireMembership(c, db);
    if (m instanceof Response) return m;

    let configured = false;
    try {
      configured = boxFromEnv(LARK_SECRET_KEY_ENV) !== null;
    } catch {
      // A set-but-invalid key would fail the Go server at boot; for a read
      // endpoint we degrade to "not configured" instead of a 500.
      configured = false;
    }
    if (!configured) {
      return c.json({ installations: [], configured: false, install_supported: false });
    }

    const rows = await listLarkInstallationsByWorkspace(db, m.workspaceId);
    return c.json({
      installations: rows.map(installationToResponse),
      configured: true,
      install_supported: false,
    });
  });

  return r;
}
