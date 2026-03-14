import type { Hono } from "hono";
import type { RemiData } from "../remi-data.js";

export function registerTracesHandlers(app: Hono, data: RemiData) {
  app.get("/api/v1/traces", (c) => {
    const date = c.req.query("date") ?? new Date().toISOString().slice(0, 10);
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 200);
    return c.json(data.getTraces(date, limit));
  });

  app.get("/api/v1/traces/:traceId", (c) => {
    const trace = data.getTrace(c.req.param("traceId"));
    if (!trace) return c.json({ error: "Trace not found" }, 404);
    return c.json(trace);
  });
}
