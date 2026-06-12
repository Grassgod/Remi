/**
 * Agent routes (read path) — port of the Go agent handler's GET /api/agents
 * (list) and GET /api/agents/{id} (get). Behind the /api/* JWT gate; scoped to
 * a workspace via the X-Workspace-ID header + a membership check (multi-tenancy).
 *
 * Only the read path is ported here: agent execution/runtime wiring, the
 * private-agent actor gate, and mcp_config/custom_env secret redaction (which
 * depend on runtime + actor resolution) are intentionally out of scope. The
 * response shape mirrors Go's AgentResponse field-for-field, including the
 * MUL-2600 contract that custom_env is never serialized — only the coarse
 * has_custom_env / custom_env_key_count metadata is exposed.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import type { Agent } from "../../db/schema.js";
import {
  archiveAgent,
  cancelAgentTasks,
  createAgent,
  getAgentInWorkspace,
  getAgentRuntimeForWorkspace,
  getMembership,
  listAgentSkillSummaries,
  listAgentSkillsByWorkspace,
  listAgents,
  restoreAgent,
  updateAgent,
  type AgentSkillSummaryRow,
  type NewAgent,
} from "../../db/queries/agents.js";
import { bus } from "../../realtime/bus.js";
import { getAgentTemplate } from "../../agent/templates.js";
import { findOrCreateSkillByName } from "../../db/queries/skills.js";
import { addAgentSkills } from "../../db/queries/agentSkills.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Mirrors AGENT_DESCRIPTION_MAX_LENGTH (packages/core/agents/constants.ts) and
 * the agent_description_length CHECK constraint. Counted in unicode code
 * points, matching Postgres char_length and the Go handler's
 * utf8.RuneCountInString. [...str] iterates code points, so .length on the
 * spread array is the code-point count.
 */
const MAX_AGENT_DESCRIPTION_LENGTH = 255;

type AgentSkillSummary = { id: string; name: string; description: string };

/**
 * Maps a DB agent row to the wire shape, matching the Go AgentResponse JSON
 * field names exactly. custom_env values are never serialized (MUL-2600); the
 * UI gets has_custom_env + custom_env_key_count only. Nullable model /
 * thinking_level columns serialize as "" (empty string) like Go's
 * a.Model.String, not null.
 */
function agentToResponse(a: Agent, skills: AgentSkillSummary[]) {
  // runtime_config defaults to {} when null (Go: rc == nil → map[string]any{}).
  const runtimeConfig =
    a.runtimeConfig && typeof a.runtimeConfig === "object" ? a.runtimeConfig : {};

  // custom_args defaults to [] when null/non-array (Go: customArgs == nil → []).
  const customArgs = Array.isArray(a.customArgs) ? (a.customArgs as string[]) : [];

  // custom_env: count keys only; values never cross the API surface.
  const envKeyCount =
    a.customEnv && typeof a.customEnv === "object" && !Array.isArray(a.customEnv)
      ? Object.keys(a.customEnv as Record<string, unknown>).length
      : 0;

  // mcp_config is raw JSON or null; Drizzle has already parsed the jsonb.
  const mcpConfig = a.mcpConfig ?? null;

  return {
    id: a.id,
    workspace_id: a.workspaceId,
    runtime_id: a.runtimeId,
    name: a.name,
    description: a.description,
    instructions: a.instructions,
    avatar_url: a.avatarUrl,
    runtime_mode: a.runtimeMode,
    runtime_config: runtimeConfig,
    custom_args: customArgs,
    mcp_config: mcpConfig,
    has_custom_env: envKeyCount > 0,
    custom_env_key_count: envKeyCount,
    mcp_config_redacted: false,
    visibility: a.visibility,
    status: a.status,
    max_concurrent_tasks: a.maxConcurrentTasks,
    model: a.model ?? "",
    thinking_level: a.thinkingLevel ?? "",
    owner_id: a.ownerId,
    skills,
    created_at: a.createdAt,
    updated_at: a.updatedAt,
    archived_at: a.archivedAt,
    archived_by: a.archivedBy,
  };
}

/**
 * Resolve + authorize the workspace for this request. Returns the validated
 * workspace UUID, or a Response to short-circuit with (400 missing/malformed
 * header, 404 not-a-member — mirrors the Go workspace-member gate).
 */
async function requireWorkspace(c: Context<AppEnv>, db: Db): Promise<string | Response> {
  const wsId = c.req.header("X-Workspace-ID") ?? c.get("wsId");
  if (!wsId || !UUID_RE.test(wsId)) {
    return c.json({ error: "X-Workspace-ID header required" }, 400);
  }
  const m = await getMembership(db, c.get("user").sub, wsId);
  if (!m) return c.json({ error: "workspace not found" }, 404);
  return wsId;
}

export function agentRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    const includeArchived = c.req.query("include_archived") === "true";
    const [agents, skillRows] = await Promise.all([
      listAgents(db, ws, includeArchived),
      listAgentSkillsByWorkspace(db, ws),
    ]);

    // Bucket skills by agent_id to avoid N+1 (mirrors Go's skillMap).
    const skillMap = new Map<string, AgentSkillSummary[]>();
    for (const row of skillRows as AgentSkillSummaryRow[]) {
      const list = skillMap.get(row.agentId) ?? [];
      list.push({ id: row.id, name: row.name, description: row.description });
      skillMap.set(row.agentId, list);
    }

    return c.json(agents.map((a) => agentToResponse(a, skillMap.get(a.id) ?? [])));
  });

  // POST /api/agents — create a workspace-scoped agent. Mirrors Go CreateAgent:
  // name + runtime_id are required; the runtime must exist in this workspace;
  // runtime_mode is copied from the runtime; creator/owner = the requesting
  // user; visibility defaults to "private", max_concurrent_tasks to 6.
  r.post("/", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }

    const name = typeof body.name === "string" ? body.name : "";
    if (!name) return c.json({ error: "name is required" }, 400);

    const description = typeof body.description === "string" ? body.description : "";
    if ([...description].length > MAX_AGENT_DESCRIPTION_LENGTH) {
      return c.json(
        { error: `description must be ${MAX_AGENT_DESCRIPTION_LENGTH} characters or fewer` },
        400,
      );
    }

    const runtimeId = typeof body.runtime_id === "string" ? body.runtime_id : "";
    if (!runtimeId) return c.json({ error: "runtime_id is required" }, 400);
    if (!UUID_RE.test(runtimeId)) return c.json({ error: "invalid runtime_id" }, 400);

    // The runtime must exist in this workspace (mirrors Go's
    // GetAgentRuntimeForWorkspace gate — 400 on a missing/foreign runtime).
    const runtime = await getAgentRuntimeForWorkspace(db, ws, runtimeId);
    if (!runtime) return c.json({ error: "invalid runtime_id" }, 400);

    // jsonb fields: default to the same shapes Go marshals ({} / []).
    const runtimeConfig =
      body.runtime_config && typeof body.runtime_config === "object" ? body.runtime_config : {};
    const customEnv =
      body.custom_env && typeof body.custom_env === "object" && !Array.isArray(body.custom_env)
        ? (body.custom_env as Record<string, unknown>)
        : {};
    const customArgs = Array.isArray(body.custom_args) ? (body.custom_args as string[]) : [];
    const visibility = typeof body.visibility === "string" && body.visibility ? body.visibility : "private";
    const maxConcurrentTasks =
      typeof body.max_concurrent_tasks === "number" && body.max_concurrent_tasks > 0
        ? body.max_concurrent_tasks
        : 6;

    const insert: NewAgent = {
      workspaceId: ws,
      name,
      description,
      instructions: typeof body.instructions === "string" ? body.instructions : "",
      avatarUrl: typeof body.avatar_url === "string" && body.avatar_url ? body.avatar_url : null,
      runtimeMode: runtime.runtimeMode,
      runtimeConfig,
      runtimeId: runtime.id,
      visibility,
      maxConcurrentTasks,
      ownerId: c.get("user").sub,
      customEnv,
      customArgs,
      mcpConfig: body.mcp_config ?? null,
      model: typeof body.model === "string" && body.model ? body.model : null,
      thinkingLevel:
        typeof body.thinking_level === "string" && body.thinking_level ? body.thinking_level : null,
    };

    const created = await createAgent(db, insert);
    bus.publish({ type: "agent.created", workspaceId: ws, payload: { id: created.id } });
    return c.json(agentToResponse(created, []), 201);
  });

  r.get("/:id", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    const id = c.req.param("id");
    // Agent ids are always UUIDs (no human identifier), so reject malformed
    // input at the boundary rather than round-tripping it into the query.
    if (!UUID_RE.test(id)) return c.json({ error: "agent not found" }, 404);

    const found = await getAgentInWorkspace(db, ws, id);
    if (!found) return c.json({ error: "agent not found" }, 404);

    const skills = await listAgentSkillSummaries(db, found.id);
    return c.json(agentToResponse(found, skills));
  });

  // PUT /api/agents/:id — partial update. Mirrors Go UpdateAgent's pointer
  // fields: only keys present in the body are written; a runtime_id change
  // re-validates the runtime against this workspace and re-copies runtime_mode.
  r.put("/:id", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "agent not found" }, 404);
    const existing = await getAgentInWorkspace(db, ws, id);
    if (!existing) return c.json({ error: "agent not found" }, 404);

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }

    const f: Partial<NewAgent> = {};
    if (typeof body.name === "string") f.name = body.name;
    if (typeof body.description === "string") {
      if ([...body.description].length > MAX_AGENT_DESCRIPTION_LENGTH) {
        return c.json(
          { error: `description must be ${MAX_AGENT_DESCRIPTION_LENGTH} characters or fewer` },
          400,
        );
      }
      f.description = body.description;
    }
    if (typeof body.instructions === "string") f.instructions = body.instructions;
    if ("avatar_url" in body) {
      f.avatarUrl = typeof body.avatar_url === "string" && body.avatar_url ? body.avatar_url : null;
    }
    if (body.runtime_config && typeof body.runtime_config === "object") {
      f.runtimeConfig = body.runtime_config;
    }
    if (Array.isArray(body.custom_args)) f.customArgs = body.custom_args as string[];
    if ("mcp_config" in body) f.mcpConfig = body.mcp_config ?? null;
    if (typeof body.visibility === "string") f.visibility = body.visibility;
    if (typeof body.status === "string") f.status = body.status;
    if (typeof body.max_concurrent_tasks === "number") {
      f.maxConcurrentTasks = body.max_concurrent_tasks;
    }
    if ("model" in body) {
      f.model = typeof body.model === "string" && body.model ? body.model : null;
    }
    if ("thinking_level" in body) {
      f.thinkingLevel =
        typeof body.thinking_level === "string" && body.thinking_level ? body.thinking_level : null;
    }

    // A runtime change must validate the new runtime against this workspace
    // and re-copy its runtime_mode (mirrors Go's re-bind gate).
    if (typeof body.runtime_id === "string") {
      if (!UUID_RE.test(body.runtime_id)) return c.json({ error: "invalid runtime_id" }, 400);
      const runtime = await getAgentRuntimeForWorkspace(db, ws, body.runtime_id);
      if (!runtime) return c.json({ error: "invalid runtime_id" }, 400);
      f.runtimeId = runtime.id;
      f.runtimeMode = runtime.runtimeMode;
    }

    const updated = await updateAgent(db, existing.id, f);
    bus.publish({ type: "agent.updated", workspaceId: ws, payload: { id: existing.id } });
    const skills = await listAgentSkillSummaries(db, existing.id);
    return c.json(agentToResponse(updated ?? existing, skills));
  });

  // POST /api/agents/:id/archive — soft-delete: sets archived_at + archived_by.
  // Mirrors Go ArchiveAgent (409 when already archived). Publishes
  // agent.updated so subscribers refresh the agent list.
  r.post("/:id/archive", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "agent not found" }, 404);
    const existing = await getAgentInWorkspace(db, ws, id);
    if (!existing) return c.json({ error: "agent not found" }, 404);
    if (existing.archivedAt) return c.json({ error: "agent is already archived" }, 409);

    const archived = await archiveAgent(db, existing.id, c.get("user").sub);
    // Archiving an agent cancels its in-flight work (mirrors Go ArchiveAgent).
    await cancelAgentTasks(db, existing.id);
    bus.publish({ type: "agent.updated", workspaceId: ws, payload: { id: existing.id } });
    const skills = await listAgentSkillSummaries(db, existing.id);
    return c.json(agentToResponse(archived ?? existing, skills));
  });

  // POST /api/agents/from-template — create an agent from a catalog template.
  // The template supplies the instructions; its skill refs are materialised by
  // reusing a workspace skill of the same name or creating one (content fetch
  // from source_url is deferred). Runtime gating mirrors POST /.
  r.post("/from-template", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }

    const name = typeof body.name === "string" ? body.name : "";
    if (!name) return c.json({ error: "name is required" }, 400);
    const runtimeId = typeof body.runtime_id === "string" ? body.runtime_id : "";
    if (!runtimeId || !UUID_RE.test(runtimeId)) return c.json({ error: "runtime_id is required" }, 400);
    const slug = typeof body.template_slug === "string" ? body.template_slug : "";
    const tmpl = getAgentTemplate(slug);
    if (!tmpl) return c.json({ error: `template not found: ${slug}` }, 400);

    const runtime = await getAgentRuntimeForWorkspace(db, ws, runtimeId);
    if (!runtime) return c.json({ error: "invalid runtime_id" }, 400);

    const visibility = typeof body.visibility === "string" && body.visibility ? body.visibility : "private";
    const maxConcurrentTasks =
      typeof body.max_concurrent_tasks === "number" && body.max_concurrent_tasks > 0 ? body.max_concurrent_tasks : 6;

    const created = await createAgent(db, {
      workspaceId: ws,
      name,
      description: tmpl.description,
      instructions: tmpl.instructions,
      runtimeMode: runtime.runtimeMode,
      runtimeId: runtime.id,
      visibility,
      maxConcurrentTasks,
      ownerId: c.get("user").sub,
      model: typeof body.model === "string" && body.model ? body.model : null,
    });

    // Materialise the template's skills (reuse-by-name, else create).
    const skillIds: string[] = [];
    for (const ref of tmpl.skills) {
      if (!ref.cached_name?.trim()) continue;
      skillIds.push(await findOrCreateSkillByName(db, ws, ref.cached_name, ref.cached_description ?? "", c.get("user").sub));
    }
    if (skillIds.length) await addAgentSkills(db, created.id, skillIds);

    bus.publish({ type: "agent.created", workspaceId: ws, payload: { id: created.id } });
    const skills = await listAgentSkillSummaries(db, created.id);
    return c.json(agentToResponse(created, skills), 201);
  });

  // POST /api/agents/:id/restore — clear the archive marker (409 if not archived).
  r.post("/:id/restore", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "agent not found" }, 404);
    const existing = await getAgentInWorkspace(db, ws, id);
    if (!existing) return c.json({ error: "agent not found" }, 404);
    if (!existing.archivedAt) return c.json({ error: "agent is not archived" }, 409);

    const restored = await restoreAgent(db, existing.id);
    bus.publish({ type: "agent.updated", workspaceId: ws, payload: { id: existing.id } });
    const skills = await listAgentSkillSummaries(db, existing.id);
    return c.json(agentToResponse(restored ?? existing, skills));
  });

  // POST /api/agents/:id/cancel-tasks — cancel the agent's in-flight tasks.
  r.post("/:id/cancel-tasks", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;

    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "agent not found" }, 404);
    const existing = await getAgentInWorkspace(db, ws, id);
    if (!existing) return c.json({ error: "agent not found" }, 404);

    const cancelled = await cancelAgentTasks(db, existing.id);
    if (cancelled > 0) bus.publish({ type: "agent.updated", workspaceId: ws, payload: { id: existing.id } });
    return c.json({ cancelled });
  });

  return r;
}
