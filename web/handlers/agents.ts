import type { Hono } from "hono";
import type { RemiData } from "../remi-data.js";

export function registerAgentsHandlers(app: Hono, data: RemiData) {
  // List all agents with config + stats
  app.get("/api/v1/agents", (c) => {
    return c.json(data.listAgents());
  });

  // Agent detail (CLAUDE.md, settings, skills)
  app.get("/api/v1/agents/:name", (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    const detail = data.getAgentDetail(name);
    if (!detail) return c.json({ error: "agent not found" }, 404);
    return c.json(detail);
  });

  // Agent run history
  app.get("/api/v1/agents/:name/runs", (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 200);
    return c.json(data.getAgentRuns(name, limit));
  });

  // Update CLAUDE.md
  app.put("/api/v1/agents/:name/claude-md", async (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    const { content } = await c.req.json();
    if (typeof content !== "string") return c.json({ error: "content required" }, 400);
    const ok = data.updateAgentClaudeMd(name, content);
    if (!ok) return c.json({ error: "agent not found" }, 404);
    return c.json({ ok: true });
  });

  // Update settings.local.json
  app.put("/api/v1/agents/:name/settings", async (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    const { content } = await c.req.json();
    if (typeof content !== "string") return c.json({ error: "content required" }, 400);
    const ok = data.updateAgentSettings(name, content);
    if (!ok) return c.json({ error: "invalid JSON or agent not found" }, 400);
    return c.json({ ok: true });
  });

  // Update SKILL.md
  app.put("/api/v1/agents/:name/skills/:skill", async (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    const skill = decodeURIComponent(c.req.param("skill"));
    const { content } = await c.req.json();
    if (typeof content !== "string") return c.json({ error: "content required" }, 400);
    const ok = data.updateAgentSkill(name, skill, content);
    if (!ok) return c.json({ error: "skill not found" }, 404);
    return c.json({ ok: true });
  });

  // Agent skill file tree
  app.get("/api/v1/agents/:name/skills/:skill/tree", (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    const skill = decodeURIComponent(c.req.param("skill"));
    const tree = data.getAgentSkillTree(name, skill);
    if (!tree) return c.json({ error: "skill not found" }, 404);
    return c.json(tree);
  });

  // Agent skill file content
  app.get("/api/v1/agents/:name/skills/:skill/file", (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    const skill = decodeURIComponent(c.req.param("skill"));
    const path = c.req.query("path") || "SKILL.md";
    const content = data.readAgentSkillFile(name, skill, path);
    if (content === null) return c.json({ error: "file not found" }, 404);
    return c.json({ content });
  });

  // List MCP servers
  app.get("/api/v1/mcp", (c) => {
    return c.json(data.listMcpServers());
  });
}
