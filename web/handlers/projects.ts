import type { Hono } from "hono";
import type { RemiData } from "../remi-data.js";
import { ProjectStore } from "../../src/project/store.js";

export function registerProjectHandlers(app: Hono, data: RemiData) {
  const store = new ProjectStore();

  // List all projects (from DB)
  app.get("/api/v1/projects", (c) => {
    return c.json(store.list());
  });

  // Simple create (alias + path, for backward compat)
  app.post("/api/v1/projects", async (c) => {
    const { alias, path } = (await c.req.json()) as { alias: string; path: string };
    if (!alias || !path) return c.json({ error: "alias and path required" }, 400);

    // Write to both DB and toml
    const existing = store.getById(alias);
    if (existing) {
      store.updateField(alias, "cwd", path);
    } else {
      store.create({
        alias,
        name: alias,
        dirMode: "existing",
        existingPath: path,
      });
      store.updateInitStatus(alias, "completed");
    }
    data.saveProject(alias, path);
    return c.json({ ok: true });
  });

  // Update path
  app.put("/api/v1/projects/:alias", async (c) => {
    const alias = decodeURIComponent(c.req.param("alias"));
    const { path } = (await c.req.json()) as { path: string };
    if (!path) return c.json({ error: "path required" }, 400);

    const existing = store.getById(alias);
    if (!existing) return c.json({ error: "not found" }, 404);

    store.updateField(alias, "cwd", path);
    data.saveProject(alias, path);
    return c.json({ ok: true });
  });

  // Delete
  app.delete("/api/v1/projects/:alias", (c) => {
    const alias = decodeURIComponent(c.req.param("alias"));
    const ok = store.delete(alias);
    if (!ok) return c.json({ error: "not found" }, 404);
    data.deleteProject(alias);
    return c.json({ ok: true });
  });
}
