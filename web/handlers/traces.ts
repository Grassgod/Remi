import type { Hono } from "hono";
import type { RemiData } from "../remi-data.js";

export function registerTracesHandlers(app: Hono, data: RemiData) {
  // Stats (server-side aggregation)
  app.get("/api/v1/traces/stats", (c) => {
    const date = c.req.query("date") ?? new Date().toISOString().slice(0, 10);
    return c.json(data.getTraceStats(date));
  });

  // List (flat rows, no fake spans)
  app.get("/api/v1/traces", (c) => {
    const date = c.req.query("date") ?? new Date().toISOString().slice(0, 10);
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 200);
    const status = c.req.query("status") || undefined;
    return c.json(data.getTraces(date, limit, status));
  });

  // Detail (DB meta + JSONL tool calls)
  app.get("/api/v1/traces/:id/detail", (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
    const detail = data.getTraceDetail(id);
    if (!detail) return c.json({ error: "Trace not found" }, 404);
    return c.json(detail);
  });
}
