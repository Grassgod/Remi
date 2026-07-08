import type { Hono } from "hono";
import type { RemiData } from "../remi-data.js";

export function registerAuthHandlers(app: Hono, data: RemiData) {
  app.get("/api/v1/auth/status", (c) => {
    return c.json(data.readTokenStatus());
  });

  app.get("/api/v1/auth/sync-rules", (c) => {
    return c.json(data.readSyncRules());
  });

  app.get("/api/v1/auth/sync-preview", (c) => {
    const source = c.req.query("source") ?? "";
    const target = c.req.query("target") ?? "";
    if (!source || !target) return c.json({ error: "source and target required" }, 400);
    return c.json(data.previewSyncRule(source, target));
  });

  app.put("/api/v1/auth/sync-rules", async (c) => {
    const rules = await c.req.json();
    if (!Array.isArray(rules)) return c.json({ error: "Expected array" }, 400);
    const ok = data.saveSyncRules(rules);
    return ok ? c.json({ ok: true }) : c.json({ error: "Failed to save" }, 500);
  });
}
