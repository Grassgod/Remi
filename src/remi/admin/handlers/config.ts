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

  // Raw TOML endpoints
  app.get("/api/v1/config/raw", (c) => {
    const result = data.readConfigRaw();
    if (!result) return c.json({ error: "config file not found" }, 404);
    return c.json(result);
  });

  app.put("/api/v1/config/raw", async (c) => {
    const { text } = await c.req.json();
    if (typeof text !== "string") return c.json({ error: "text field required" }, 400);
    const result = data.updateConfigRaw(text);
    if ("error" in result) return c.json(result, 422);
    return c.json(result);
  });
}
