import type { RemiData } from "../remi-data.js";

export function registerSchedulerHandlers(router: any, data: RemiData) {
  // Current status of all jobs
  router.get("/api/v1/scheduler/status", () => {
    return Response.json(data.getSchedulerStatus());
  });

  // Execution history (optionally filtered by jobId)
  router.get("/api/v1/scheduler/history", (req: Request) => {
    const url = new URL(req.url);
    const jobId = url.searchParams.get("jobId") ?? undefined;
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
    return Response.json(data.getSchedulerHistory(jobId, limit));
  });

  // Daily summary for last N days
  router.get("/api/v1/scheduler/summary", (req: Request) => {
    const url = new URL(req.url);
    const days = Math.min(parseInt(url.searchParams.get("days") ?? "7", 10), 30);
    return Response.json(data.getSchedulerSummary(days));
  });
}
