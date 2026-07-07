import type { Hono } from "hono";
import type { RemiData } from "../remi-data.js";
import { ConfigStore } from "@shared/db/config-store.js";
import { getDb } from "@shared/db/index.js";

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

  app.get("/api/v1/config/:section", (c) => {
    const section = c.req.param("section");
    const store = new ConfigStore(getDb());
    const value = store.getSection(section);
    if (value === undefined) return c.json({ error: "section not found" }, 404);
    return c.json(value);
  });

  app.put("/api/v1/config/:section", async (c) => {
    const section = c.req.param("section");
    const body = await c.req.json();
    const store = new ConfigStore(getDb());
    store.setSection(section, body);
    return c.json({ ok: true });
  });
}
