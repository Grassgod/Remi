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

  // ── Create a draft agent (scaffold-only) ──────────────────
  // Creates <agentsDir>/<name>/.claude/{CLAUDE.md,settings.local.json}.
  // Does NOT register with the runtime — registration lives in
  // src/agents/registry.ts and requires a daemon edit; the UI surfaces
  // this clearly so users can draft + iterate from here.
  app.post("/api/v1/agents", async (c) => {
    const { name, description } = (await c.req.json()) as { name?: string; description?: string };
    if (!name || !/^[a-z0-9][a-z0-9-]*$/i.test(name)) {
      return c.json({ error: "name must be alphanumeric (dashes ok), got: " + name }, 400);
    }
    const { mkdirSync, existsSync, writeFileSync } = require("node:fs");
    const { join } = require("node:path");
    const { homedir } = require("node:os");
    const agentsDir = join(homedir(), ".remi", "agents");
    const dir = join(agentsDir, name, ".claude");
    if (existsSync(dir)) {
      return c.json({ error: `agent '${name}' already exists` }, 409);
    }
    mkdirSync(dir, { recursive: true });
    const claudeMd = `# ${name}\n\n${description ?? "Describe what this agent does. The first non-heading line becomes the registry description."}\n`;
    writeFileSync(join(dir, "CLAUDE.md"), claudeMd);
    writeFileSync(join(dir, "settings.local.json"), JSON.stringify({ permissions: { allow: [], deny: [] } }, null, 2) + "\n");
    return c.json({ ok: true, name, draft: true });
  });

  // ── Delete an agent's on-disk content ─────────────────────
  // Refuses to delete agents present in the static runtime registry
  // (src/agents/registry.ts) — that requires a daemon edit so the runtime
  // doesn't end up referring to a missing directory.
  app.delete("/api/v1/agents/:name", (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    try {
      const { AGENTS } = require("../../src/agents/registry.js");
      if (AGENTS && Object.prototype.hasOwnProperty.call(AGENTS, name)) {
        return c.json({ error: `'${name}' is in the runtime registry; remove from src/agents/registry.ts first` }, 409);
      }
    } catch { /* ignore — proceed with disk-only delete */ }
    const { rmSync, existsSync } = require("node:fs");
    const { join } = require("node:path");
    const { homedir } = require("node:os");
    const dir = join(homedir(), ".remi", "agents", name);
    if (!existsSync(dir)) return c.json({ error: "agent not found" }, 404);
    rmSync(dir, { recursive: true, force: true });
    return c.json({ ok: true });
  });
}
