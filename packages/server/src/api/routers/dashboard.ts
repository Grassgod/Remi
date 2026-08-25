import type { Hono } from "hono";
import { denyCurrentUserWorkspaceAccess, usageQuery } from "../helpers.js";
import {
  dashboardAgentRuntimeWire,
  dashboardRuntimeDailyWire,
  dashboardUsageByAgentWire,
  dashboardUsageDailyWire,
} from "../wire/dashboard.js";
import type { RouterDeps } from "./deps.js";

export function registerDashboardRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;

  app.get("/api/dashboard/usage/daily", (c) => {
    const query = usageQuery(c, { store });
    const denied = denyCurrentUserWorkspaceAccess(c, store, query.workspaceId ?? "local");
    if (denied) return denied;
    return c.json(store.listUsageDaily(query).map(dashboardUsageDailyWire));
  });
  app.get("/api/dashboard/usage/by-agent", (c) => {
    const query = usageQuery(c, { store });
    const denied = denyCurrentUserWorkspaceAccess(c, store, query.workspaceId ?? "local");
    if (denied) return denied;
    return c.json(store.listUsageByAgent(query).map(dashboardUsageByAgentWire));
  });
  // Leaderboard rollup: per-AGENT totals (agent_id + total_seconds +
  // task_count), not the per-date series — the frontend joins these rows with
  // usage/by-agent by agent_id to build the dashboard leaderboard.
  app.get("/api/dashboard/agent-runtime", (c) => {
    const query = usageQuery(c, { store });
    const denied = denyCurrentUserWorkspaceAccess(c, store, query.workspaceId ?? "local");
    if (denied) return denied;
    return c.json(store.listAgentRuntime(query).map(dashboardAgentRuntimeWire));
  });
  app.get("/api/dashboard/runtime/daily", (c) => {
    const query = usageQuery(c, { store });
    const denied = denyCurrentUserWorkspaceAccess(c, store, query.workspaceId ?? "local");
    if (denied) return denied;
    return c.json(store.listRuntimeDaily(query).map(dashboardRuntimeDailyWire));
  });
}
