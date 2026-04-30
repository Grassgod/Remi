import type { Hono } from "hono";
import type { RemiData } from "../remi-data.js";

export function registerSkillsHandlers(app: Hono, data: RemiData) {
  app.get("/api/v1/skills/scopes", (c) => {
    return c.json(data.listSkillScopes());
  });

  app.get("/api/v1/skills", (c) => {
    const scope = c.req.query("scope");
    return c.json(data.listSkills(scope));
  });

  // Get skills base path
  app.get("/api/v1/skills/base-path", (c) => {
    const scope = c.req.query("scope");
    return c.json({ basePath: data.getSkillsBasePath(scope) });
  });

  // Get file tree for a specific skill
  app.get("/api/v1/skills/:name/tree", (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    const scope = c.req.query("scope");
    const tree = data.getSkillTree(name, scope);
    if (!tree) return c.json({ error: "Skill not found" }, 404);
    return c.json(tree);
  });

  app.get("/api/v1/skills/:name/file", (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    const path = c.req.query("path") ?? "SKILL.md";
    const scope = c.req.query("scope");
    const content = data.readSkillFile(name, path, scope);
    if (content === null) return c.json({ error: "File not found" }, 404);
    return c.json({ content });
  });

  app.put("/api/v1/skills/:name/file", async (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    const path = c.req.query("path") ?? "SKILL.md";
    const scope = c.req.query("scope");
    const body = await c.req.json();
    if (!body.content || typeof body.content !== "string") {
      return c.json({ error: "content required" }, 400);
    }
    const ok = data.writeSkillFile(name, body.content, path, scope);
    if (!ok) return c.json({ error: "Write failed" }, 404);
    return c.json({ ok: true });
  });

  app.get("/api/v1/skills/:name/reports", (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    const scope = c.req.query("scope");
    const dates = data.listSkillReports(name, scope);
    return c.json(dates);
  });

  app.get("/api/v1/skills/:name/reports/:date", (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    const date = c.req.param("date");
    const scope = c.req.query("scope");
    const content = data.readSkillReport(name, date, scope);
    if (content === null) return c.json({ error: "Report not found" }, 404);
    return c.json({ content });
  });
}
