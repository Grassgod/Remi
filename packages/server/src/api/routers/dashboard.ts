import type { Hono } from "hono";
import { denyCurrentUserWorkspaceAccess, usageQuery } from "../helpers.js";
import type { RouterDeps } from "./deps.js";

export function registerDashboardRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;

  app.get("/api/dashboard/usage/daily", (c) => {
    const query = usageQuery(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, query.workspaceId ?? "local");
    if (denied) return denied;
    return c.json(store.listUsageDaily(query));
  });
  app.get("/api/dashboard/usage/by-agent", (c) => {
    const query = usageQuery(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, query.workspaceId ?? "local");
    if (denied) return denied;
    return c.json(store.listUsageByAgent(query));
  });
  app.get("/api/dashboard/agent-runtime", (c) => {
    const query = usageQuery(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, query.workspaceId ?? "local");
    if (denied) return denied;
    return c.json(store.listRuntimeDaily(query));
  });
  app.get("/api/dashboard/runtime/daily", (c) => {
    const query = usageQuery(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, query.workspaceId ?? "local");
    if (denied) return denied;
    return c.json(store.listRuntimeDaily(query));
  });
}
