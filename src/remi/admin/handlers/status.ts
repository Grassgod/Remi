import type { Hono } from "hono";
import type { RemiData } from "../remi-data.js";

export function registerStatusHandlers(app: Hono, data: RemiData) {
  app.get("/api/v1/status", (c) => {
    return c.json(data.getStatus());
  });
}
