import type { Hono } from "hono";
import {
  compatibilityUserId,
  compatibilityWorkspaceId,
  denyCurrentUserWorkspaceAccess,
  denyPinOwnerAccess,
  isJsonApiError,
  readJson,
  readJsonStrict,
} from "../helpers.js";
import { cleanString, currentRequestUserId, pinCompatibilityErrorResponse, pinCompatibilityResponse } from "../wire/index.js";
import type { CreatePinnedItemInput, ReorderPinnedItemInput } from "@multiremi/contracts/types.js";
import type { RouterDeps } from "./deps.js";

export function registerPinRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;

  app.get("/api/multiremi/pins", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const userId = c.req.query("userId") ?? currentRequestUserId(c);
    const ownerDenied = denyPinOwnerAccess(c, userId);
    if (ownerDenied) return ownerDenied;
    const pins = store.listPinnedItems(workspaceId, userId);
    return c.json({ pins, total: pins.length });
  });
  app.post("/api/multiremi/pins", async (c) => {
    const body = await readJson<CreatePinnedItemInput>(c);
    const workspaceId = body.workspaceId ?? body.workspace_id ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const userId = body.userId ?? body.user_id ?? currentRequestUserId(c);
    const ownerDenied = denyPinOwnerAccess(c, userId);
    if (ownerDenied) return ownerDenied;
    return c.json({ pin: store.createPinnedItem({ ...body, workspaceId, userId }) }, 201);
  });
  app.put("/api/multiremi/pins/reorder", async (c) => {
    const body = await readJson<{ workspaceId?: string; workspace_id?: string; userId?: string; user_id?: string; items?: ReorderPinnedItemInput[] }>(c);
    const workspaceId = body.workspaceId ?? body.workspace_id ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const userId = body.userId ?? body.user_id ?? currentRequestUserId(c);
    const ownerDenied = denyPinOwnerAccess(c, userId);
    if (ownerDenied) return ownerDenied;
    const pins = store.reorderPinnedItems(workspaceId, userId, body.items ?? []);
    return c.json({ pins, total: pins.length });
  });
  app.delete("/api/multiremi/pins/:itemType/:itemId", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const userId = c.req.query("userId") ?? currentRequestUserId(c);
    const ownerDenied = denyPinOwnerAccess(c, userId);
    if (ownerDenied) return ownerDenied;
    store.deletePinnedItem(workspaceId, userId, c.req.param("itemType"), c.req.param("itemId"));
    return c.json({ ok: true });
  });

  app.get("/api/pins", (c) => {
    const workspaceId = compatibilityWorkspaceId(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const userId = compatibilityUserId(c);
    const ownerDenied = denyPinOwnerAccess(c, userId);
    if (ownerDenied) return ownerDenied;
    return c.json(store.listPinnedItems(workspaceId, userId).map(pinCompatibilityResponse));
  });
  app.post("/api/pins", async (c) => {
    const body = await readJsonStrict<{ id?: string; workspace_id?: string | null; user_id?: string | null; item_type?: string; item_id?: string }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const workspaceId = cleanString(body.workspace_id) ?? compatibilityWorkspaceId(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const userId = cleanString(body.user_id) ?? compatibilityUserId(c);
    const ownerDenied = denyPinOwnerAccess(c, userId);
    if (ownerDenied) return ownerDenied;
    try {
      const pin = store.createPinnedItem({
        id: body.id,
        workspace_id: workspaceId,
        user_id: userId,
        item_type: body.item_type,
        item_id: body.item_id,
      });
      return c.json(pinCompatibilityResponse(pin), 201);
    } catch (error) {
      return pinCompatibilityErrorResponse(c, error);
    }
  });
  app.put("/api/pins/reorder", async (c) => {
    const body = await readJsonStrict<{ workspace_id?: string; user_id?: string; items?: ReorderPinnedItemInput[] }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const workspaceId = body.workspace_id ?? compatibilityWorkspaceId(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const userId = body.user_id ?? compatibilityUserId(c);
    const ownerDenied = denyPinOwnerAccess(c, userId);
    if (ownerDenied) return ownerDenied;
    const pins = store.reorderPinnedItems(workspaceId, userId, body.items ?? []);
    return c.json(pins.map(pinCompatibilityResponse));
  });
  app.delete("/api/pins/:itemType/:itemId", (c) => {
    const workspaceId = compatibilityWorkspaceId(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const userId = compatibilityUserId(c);
    const ownerDenied = denyPinOwnerAccess(c, userId);
    if (ownerDenied) return ownerDenied;
    store.deletePinnedItem(workspaceId, userId, c.req.param("itemType"), c.req.param("itemId"));
    return c.body(null, 204);
  });
}
