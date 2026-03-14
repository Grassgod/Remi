import type { Hono } from "hono";
import type { RemiData } from "../remi-data.js";

export function registerConfigHandlers(app: Hono, data: RemiData) {
  app.get("/api/v1/config", (c) => {
    return c.json(data.readConfig());
  });

  app.put("/api/v1/config", async (c) => {
    const body = await c.req.json();
    const ok = data.updateConfig(body);
    if (!ok) return c.json({ error: "failed to update config" }, 500);
    return c.json({ ok: true });
  });
}
