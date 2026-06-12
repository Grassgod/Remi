/**
 * Pin routes — port of the Go pin handler's read path (GET /api/pins, list a
 * user's pins) plus the simple pin (POST /api/pins) / unpin
 * (DELETE /api/pins/:itemType/:itemId) writes. Behind the /api/* JWT gate;
 * scoped to a workspace via the X-Workspace-ID header + a membership check
 * (multi-tenancy), then filtered to the requesting user (pins are per-user).
 *
 * The reorder path (PUT /api/pins/reorder) is intentionally not ported here.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import { getMembership } from "../../db/queries/issues.js";
import { getIssueByIdentifier } from "../../db/queries/issues.js";
import { getProjectInWorkspace } from "../../db/queries/projects.js";
import {
  createPinnedItem,
  deletePinnedItem,
  getMaxPinnedItemPosition,
  listPinnedItems,
  type PinnedItem,
} from "../../db/queries/pins.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Mirrors the Go PinnedItemResponse struct (snake_case JSON). Title / status /
 * identifier are intentionally omitted — clients derive them from their own
 * issue / project query cache (see the Go comment on PinnedItemResponse).
 */
function pinToResponse(p: PinnedItem) {
  return {
    id: p.id,
    workspace_id: p.workspaceId,
    user_id: p.userId,
    item_type: p.itemType,
    item_id: p.itemId,
    position: p.position,
    created_at: p.createdAt,
  };
}

/**
 * Resolve + authorize the workspace for this request. Returns the validated
 * workspace UUID, or a Response to short-circuit with (400 missing/malformed
 * header, 404 not-a-member — mirrors the Go RequireWorkspaceMember gate the
 * /api/pins group runs under).
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

export function pinRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const userId = c.get("user").sub;
    const pins = await listPinnedItems(db, ws, userId);
    return c.json(pins.map(pinToResponse));
  });

  r.post("/", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const userId = c.get("user").sub;

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }
    const itemType = typeof body.item_type === "string" ? body.item_type : "";
    if (itemType !== "issue" && itemType !== "project") {
      return c.json({ error: "item_type must be 'issue' or 'project'" }, 400);
    }
    const itemId = typeof body.item_id === "string" ? body.item_id : "";
    if (!itemId) return c.json({ error: "item_id is required" }, 400);
    if (!UUID_RE.test(itemId)) return c.json({ error: "invalid item_id" }, 400);

    // Verify the item exists in this workspace (mirrors the Go existence check).
    if (itemType === "issue") {
      const found = await getIssueByIdentifier(db, ws, itemId);
      if (!found) return c.json({ error: "issue not found" }, 404);
    } else {
      const found = await getProjectInWorkspace(db, ws, itemId);
      if (!found) return c.json({ error: "project not found" }, 404);
    }

    const maxPos = await getMaxPinnedItemPosition(db, ws, userId);
    try {
      const pin = await createPinnedItem(db, {
        workspaceId: ws,
        userId,
        itemType,
        itemId,
        position: maxPos + 1,
      });
      return c.json(pinToResponse(pin), 201);
    } catch (err) {
      if (isUniqueViolation(err)) return c.json({ error: "item already pinned" }, 409);
      throw err;
    }
  });

  r.delete("/:itemType/:itemId", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const userId = c.get("user").sub;
    const itemType = c.req.param("itemType");
    const itemId = c.req.param("itemId");
    if (!UUID_RE.test(itemId)) return c.json({ error: "invalid item id" }, 400);

    await deletePinnedItem(db, ws, userId, itemType, itemId);
    return c.body(null, 204);
  });

  return r;
}
