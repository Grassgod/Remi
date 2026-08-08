import type { Hono } from "hono";
import { denyCurrentUserWorkspaceAccess, readJson } from "../helpers.js";
import type { MultiremiNotificationPreferences } from "@multiremi/contracts/types.js";
import type { RouterDeps } from "./deps.js";

export function registerNotificationPreferenceRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;

  app.get("/api/multiremi/notification-preferences", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    return c.json(store.getNotificationPreferences({
      workspaceId,
      memberId: c.req.query("memberId") ?? c.req.query("member_id"),
    }));
  });
  app.put("/api/multiremi/notification-preferences", async (c) => {
    const body = await readJson<{ workspaceId?: string | null; workspace_id?: string | null; memberId?: string | null; member_id?: string | null; preferences?: MultiremiNotificationPreferences }>(c);
    const workspaceId = body.workspaceId ?? body.workspace_id ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    return c.json(store.updateNotificationPreferences({
      workspaceId,
      memberId: body.memberId ?? body.member_id,
      preferences: body.preferences ?? {},
    }));
  });
  app.get("/api/notification-preferences", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    return c.json(store.getNotificationPreferences({
      workspaceId,
      memberId: c.req.query("memberId") ?? c.req.query("member_id"),
    }));
  });
  app.put("/api/notification-preferences", async (c) => {
    const body = await readJson<MultiremiNotificationPreferences & { workspaceId?: string | null; workspace_id?: string | null; memberId?: string | null; member_id?: string | null; preferences?: MultiremiNotificationPreferences }>(c);
    const workspaceId = body.workspaceId ?? body.workspace_id ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    return c.json(store.updateNotificationPreferences({
      workspaceId,
      memberId: body.memberId ?? body.member_id,
      preferences: body.preferences ?? body,
    }));
  });
}
