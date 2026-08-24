import type { Hono } from "hono";
import { getAgentTemplate, listAgentTemplates } from "../agent-templates.js";
import { currentTaskAccessToken } from "../wire/index.js";
import type { RouterDeps } from "./deps.js";

// Template listings are static JSON on disk — this domain needs no deps, but keeps
// the uniform register<Domain>Routes(app, deps) signature.
export function registerAgentTemplateRoutes(app: Hono, _deps: RouterDeps): void {
  app.get("/api/multiremi/agent-templates", (c) => {
    if (currentTaskAccessToken(c)) return c.json({ error: "this endpoint is only available to human actors" }, 403);
    const templates = listAgentTemplates();
    return c.json({ templates, total: templates.length });
  });
  app.get("/api/multiremi/agent-templates/:slug", (c) => {
    if (currentTaskAccessToken(c)) return c.json({ error: "this endpoint is only available to human actors" }, 403);
    const template = getAgentTemplate(c.req.param("slug"));
    if (!template) return c.json({ error: "template not found" }, 404);
    return c.json({ template });
  });
  app.get("/api/agent-templates", (c) => currentTaskAccessToken(c)
    ? c.json({ error: "this endpoint is only available to human actors" }, 403)
    : c.json(listAgentTemplates()));
  app.get("/api/agent-templates/:slug", (c) => {
    if (currentTaskAccessToken(c)) return c.json({ error: "this endpoint is only available to human actors" }, 403);
    const template = getAgentTemplate(c.req.param("slug"));
    if (!template) return c.json({ error: "template not found" }, 404);
    return c.json(template);
  });
}
