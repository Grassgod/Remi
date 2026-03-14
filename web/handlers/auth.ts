import type { Hono } from "hono";
import type { RemiData } from "../remi-data.js";

export function registerAuthHandlers(app: Hono, data: RemiData) {
  app.get("/api/v1/auth/status", (c) => {
    return c.json(data.readTokenStatus());
  });
}
