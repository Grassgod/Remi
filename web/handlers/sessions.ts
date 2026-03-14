import type { Hono } from "hono";
import type { RemiData } from "../remi-data.js";

export function registerSessionHandlers(app: Hono, data: RemiData) {
  app.get("/api/v1/sessions", (c) => {
    return c.json(data.readSessions());
  });

  app.delete("/api/v1/sessions/:key", (c) => {
    const ok = data.clearSession(decodeURIComponent(c.req.param("key")));
    if (!ok) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });

  app.delete("/api/v1/sessions", (c) => {
    const count = data.clearAllSessions();
    return c.json({ ok: true, cleared: count });
  });
}
