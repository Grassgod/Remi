/**
 * Agent skill assignment routes — port of the Go skill.go handlers
 * ListAgentSkills / SetAgentSkills / AddAgentSkills:
 *   GET  /api/agents/:id/skills       → the agent's assigned skills
 *   PUT  /api/agents/:id/skills       → replace the set ({ skill_ids: [...] })
 *   POST /api/agents/:id/skills/add   → add to the set ({ skill_ids: [...] })
 *
 * Standalone factory declaring absolute /api/* paths, mounted at "/" behind the
 * JWT gate. Workspace-scoped via X-Workspace-ID; every skill id must belong to
 * the same workspace as the agent (cross-tenant ids are rejected 400).
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import { getMembership } from "../../db/queries/issues.js";
import { getAgentInWorkspace } from "../../db/queries/agents.js";
import { addAgentSkills, listAgentSkills, setAgentSkills, skillIdsInWorkspace, type Skill } from "../../db/queries/agentSkills.js";
import { bus } from "../../realtime/bus.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function skillToSummary(s: Skill) {
  return {
    id: s.id,
    workspace_id: s.workspaceId,
    name: s.name,
    description: s.description,
    config: s.config,
    created_by: s.createdBy,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  };
}

async function requireWorkspace(c: Context<AppEnv>, db: Db): Promise<string | Response> {
  const wsId = c.req.header("X-Workspace-ID") ?? c.get("wsId");
  if (!wsId || !UUID_RE.test(wsId)) return c.json({ error: "X-Workspace-ID header required" }, 400);
  const m = await getMembership(db, c.get("user").sub, wsId);
  if (!m) return c.json({ error: "workspace not found" }, 404);
  return wsId;
}

/** Validate + collect the skill_ids body field. Returns ids or a 400 Response. */
function readSkillIds(c: Context<AppEnv>, body: Record<string, unknown>): string[] | Response {
  const raw = body.skill_ids;
  if (!Array.isArray(raw)) return c.json({ error: "skill_ids must be an array" }, 400);
  const ids: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || !UUID_RE.test(v)) return c.json({ error: "skill_ids must be UUIDs" }, 400);
    ids.push(v);
  }
  return ids;
}

export function agentSkillRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // Resolve the agent in the workspace, or short-circuit with a Response.
  const loadAgent = async (c: Context<AppEnv>): Promise<{ wsId: string; agentId: string } | Response> => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const agentId = c.req.param("id");
    if (!agentId || !UUID_RE.test(agentId)) return c.json({ error: "agent id is required" }, 400);
    const ag = await getAgentInWorkspace(db, ws, agentId);
    if (!ag) return c.json({ error: "agent not found" }, 404);
    return { wsId: ws, agentId: ag.id };
  };

  r.get("/api/agents/:id/skills", async (c) => {
    const gate = await loadAgent(c);
    if (gate instanceof Response) return gate;
    const skills = await listAgentSkills(db!, gate.agentId);
    return c.json(skills.map(skillToSummary));
  });

  r.put("/api/agents/:id/skills", async (c) => {
    const gate = await loadAgent(c);
    if (gate instanceof Response) return gate;
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }
    const ids = readSkillIds(c, body);
    if (ids instanceof Response) return ids;
    const valid = await skillIdsInWorkspace(db!, gate.wsId, ids);
    if (valid.size !== new Set(ids).size) return c.json({ error: "one or more skill_ids are not in this workspace" }, 400);

    await setAgentSkills(db!, gate.agentId, [...new Set(ids)]);
    bus.publish({ type: "agent.skills_changed", workspaceId: gate.wsId, payload: { agent_id: gate.agentId } });
    const skills = await listAgentSkills(db!, gate.agentId);
    return c.json(skills.map(skillToSummary));
  });

  r.post("/api/agents/:id/skills/add", async (c) => {
    const gate = await loadAgent(c);
    if (gate instanceof Response) return gate;
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }
    const ids = readSkillIds(c, body);
    if (ids instanceof Response) return ids;
    const valid = await skillIdsInWorkspace(db!, gate.wsId, ids);
    if (valid.size !== new Set(ids).size) return c.json({ error: "one or more skill_ids are not in this workspace" }, 400);

    await addAgentSkills(db!, gate.agentId, [...new Set(ids)]);
    bus.publish({ type: "agent.skills_changed", workspaceId: gate.wsId, payload: { agent_id: gate.agentId } });
    const skills = await listAgentSkills(db!, gate.agentId);
    return c.json(skills.map(skillToSummary));
  });

  return r;
}
