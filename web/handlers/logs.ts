import type { Hono } from "hono";
import type { RemiData } from "../remi-data.js";

export function registerLogsHandlers(app: Hono, data: RemiData) {
  app.get("/api/v1/logs", (c) => {
    const date = c.req.query("date") ?? new Date().toISOString().slice(0, 10);
    const level = c.req.query("level") ?? null;
    const module = c.req.query("module") ?? null;
    const traceId = c.req.query("traceId") ?? null;
    const limit = Math.min(parseInt(c.req.query("limit") ?? "200", 10), 1000);
    const offset = parseInt(c.req.query("offset") ?? "0", 10);
    return c.json(data.getLogs({ date, level, module, traceId, limit, offset }));
  });

  app.get("/api/v1/logs/modules", (c) => {
    const date = c.req.query("date") ?? new Date().toISOString().slice(0, 10);
    return c.json(data.getLogModules(date));
  });
}
