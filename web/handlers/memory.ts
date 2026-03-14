import type { Hono } from "hono";
import type { RemiData } from "../remi-data.js";

export function registerMemoryHandlers(app: Hono, data: RemiData) {
  // Global memory
  app.get("/api/v1/memory/global", (c) => {
    return c.json({ content: data.readGlobalMemory() });
  });

  app.put("/api/v1/memory/global", async (c) => {
    const body = await c.req.json();
    if (!body.content || typeof body.content !== "string") {
      return c.json({ error: "content required" }, 400);
    }
    data.writeGlobalMemory(body.content);
    return c.json({ ok: true });
  });

  // Entities
  app.get("/api/v1/memory/entities", (c) => {
    return c.json(data.listEntities());
  });

  app.get("/api/v1/memory/entities/:type/:name", (c) => {
    const entity = data.readEntity(c.req.param("type"), decodeURIComponent(c.req.param("name")));
    if (!entity) return c.json({ error: "not found" }, 404);
    return c.json(entity);
  });

  app.post("/api/v1/memory/entities", async (c) => {
    const body = await c.req.json();
    if (!body.type || !body.name) {
      return c.json({ error: "type and name required" }, 400);
    }
    data.createEntity(body);
    return c.json({ ok: true }, 201);
  });

  app.put("/api/v1/memory/entities/:type/:name", async (c) => {
    const body = await c.req.json();
    if (!body.content) {
      return c.json({ error: "content required" }, 400);
    }
    const ok = data.updateEntity(c.req.param("type"), decodeURIComponent(c.req.param("name")), body.content);
    if (!ok) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });

  app.delete("/api/v1/memory/entities/:type/:name", (c) => {
    const ok = data.deleteEntity(c.req.param("type"), decodeURIComponent(c.req.param("name")));
    if (!ok) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });

  // Search
  app.get("/api/v1/memory/search", (c) => {
    const q = c.req.query("q") ?? "";
    if (!q) return c.json([]);
    return c.json(data.searchMemory(q));
  });

  // Daily logs
  app.get("/api/v1/memory/daily", (c) => {
    return c.json(data.listDailyDates());
  });

  app.get("/api/v1/memory/daily/:date", (c) => {
    const date = c.req.param("date");
    const content = data.readDaily(date);
    if (!content) return c.json({ error: "not found" }, 404);
    return c.json({ date, content });
  });
}
