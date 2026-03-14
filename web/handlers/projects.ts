import type { Hono } from "hono";
import type { RemiData } from "../remi-data.js";

export function registerProjectHandlers(app: Hono, data: RemiData) {
  app.get("/api/v1/projects", (c) => {
    return c.json(data.readProjects());
  });

  app.post("/api/v1/projects", async (c) => {
    const { alias, path } = await c.req.json() as { alias: string; path: string };
    if (!alias || !path) return c.json({ error: "alias and path required" }, 400);
    const ok = data.saveProject(alias, path);
    if (!ok) return c.json({ error: "failed to save" }, 500);
    return c.json({ ok: true });
  });

  app.put("/api/v1/projects/:alias", async (c) => {
    const { path } = await c.req.json() as { path: string };
    if (!path) return c.json({ error: "path required" }, 400);
    const ok = data.saveProject(decodeURIComponent(c.req.param("alias")), path);
    if (!ok) return c.json({ error: "failed to update" }, 500);
    return c.json({ ok: true });
  });

  app.delete("/api/v1/projects/:alias", (c) => {
    const ok = data.deleteProject(decodeURIComponent(c.req.param("alias")));
    if (!ok) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });
}
