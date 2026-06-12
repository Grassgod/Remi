/**
 * Agent template routes — port of agent_template.go ListAgentTemplates /
 * GetAgentTemplate:
 *   GET /api/agent-templates        — picker summaries (no instructions body)
 *   GET /api/agent-templates/:slug  — full detail (+ instructions)
 *
 * The catalog is global static data (not workspace-scoped), so these only sit
 * behind the /api/* JWT gate. Mounted at /api/agent-templates.
 */

import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { getAgentTemplate, loadAgentTemplates, type AgentTemplate } from "../../agent/templates.js";

function templateSkill(s: AgentTemplate["skills"][number]) {
  return { source_url: s.source_url, name: s.cached_name, description: s.cached_description };
}

/** Summary shape (picker card): everything except the instructions body. */
function toSummary(t: AgentTemplate) {
  return {
    slug: t.slug,
    name: t.name,
    description: t.description,
    category: t.category ?? "",
    icon: t.icon ?? "",
    accent: t.accent ?? "",
    skills: t.skills.map(templateSkill),
  };
}

/** Detail shape: summary + the verbatim instructions. */
function toDetail(t: AgentTemplate) {
  return { ...toSummary(t), instructions: t.instructions };
}

export function agentTemplateRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/", (c) => c.json(loadAgentTemplates().map(toSummary)));

  r.get("/:slug", (c) => {
    const t = getAgentTemplate(c.req.param("slug"));
    if (!t) return c.json({ error: "template not found" }, 404);
    return c.json(toDetail(t));
  });

  return r;
}
