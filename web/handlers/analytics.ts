import type { Hono } from "hono";
import type { RemiData } from "../remi-data.js";

export function registerAnalyticsHandlers(app: Hono, data: RemiData) {
  app.get("/api/v1/analytics/summary", async (c) => {
    // Refresh usage quotas from API (non-blocking on failure)
    await data.refreshUsageQuotas().catch(() => {});
    return c.json(data.getAnalyticsSummary());
  });

  app.get("/api/v1/analytics/daily", (c) => {
    const start = c.req.query("start") ?? new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
    const end = c.req.query("end") ?? new Date().toISOString().slice(0, 10);
    return c.json(data.getAnalyticsDaily(start, end));
  });

  app.get("/api/v1/analytics/recent", (c) => {
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 200);
    return c.json(data.getRecentMetrics(limit));
  });

  app.post("/api/v1/analytics/scan-cli", (c) => {
    const result = data.scanCliUsage();
    return c.json(result);
  });
}
