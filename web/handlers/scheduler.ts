import type { Hono } from "hono";
import type { RemiData } from "../remi-data.js";

export function registerSchedulerHandlers(app: Hono, data: RemiData) {
  // Current status of all jobs
  app.get("/api/v1/scheduler/status", (c) => {
    return c.json(data.getSchedulerStatus());
  });

  // Execution history (optionally filtered by jobId)
  app.get("/api/v1/scheduler/history", (c) => {
    const jobId = c.req.query("jobId") ?? undefined;
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 200);
    return c.json(data.getSchedulerHistory(jobId, limit));
  });

  // Daily summary for last N days
  app.get("/api/v1/scheduler/summary", (c) => {
    const days = Math.min(parseInt(c.req.query("days") ?? "7", 10), 30);
    return c.json(data.getSchedulerSummary(days));
  });
}
