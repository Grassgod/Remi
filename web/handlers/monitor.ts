import type { Hono } from "hono";
import type { RemiData } from "../remi-data.js";

export function registerMonitorHandlers(app: Hono, data: RemiData) {
  app.get("/api/v1/monitor/stats", (c) => {
    return c.json(data.getMonitorStats());
  });
}
