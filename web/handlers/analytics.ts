import type { RemiData } from "../remi-data.js";

export function registerAnalyticsHandlers(router: any, data: RemiData) {
  router.get("/api/v1/analytics/summary", async () => {
    // Refresh usage quotas from API (non-blocking on failure)
    await data.refreshUsageQuotas().catch(() => {});
    return Response.json(data.getAnalyticsSummary());
  });

  router.get("/api/v1/analytics/daily", (req: Request) => {
    const url = new URL(req.url);
    const start = url.searchParams.get("start") ?? new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
    const end = url.searchParams.get("end") ?? new Date().toISOString().slice(0, 10);
    return Response.json(data.getAnalyticsDaily(start, end));
  });

  router.get("/api/v1/analytics/recent", (req: Request) => {
    const url = new URL(req.url);
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
    return Response.json(data.getRecentMetrics(limit));
  });

  router.add("POST", "/api/v1/analytics/scan-cli", () => {
    const result = data.scanCliUsage();
    return Response.json(result);
  });
}
