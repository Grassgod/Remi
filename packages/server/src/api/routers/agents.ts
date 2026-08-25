import type { Hono } from "hono";
import {
  createAgentFromTemplate,
} from "../agent-templates.js";
import {
  canCurrentUserAccessAgent,
  denyCurrentUserWorkspaceAccess,
  isFirstAgentInWorkspace,
  isJsonApiError,
  loadAgentEnvForCurrentAdmin,
  loadAgentForCurrentManager,
  loadAgentForCurrentUser,
  mergeAgentEnv,
  publishAgentLifecycleEvent,
  publishAgentSkillsEvent,
  readJson,
  readJsonStrict,
  recordAgentCreatedAnalytics,
  requestedAgentWorkspaceId,
  resolveAgentRequestProvider,
  runtimeForAgentInput,
  withAgentRequestContext,
  withAgentTemplateRequestContext,
  withAgentUpdateRequestContext,
} from "../helpers.js";
import {
  agentCompatibilityResponse,
  agentEnvResponse,
  currentRequestUserId,
  skillCompatibilityErrorResponse,
  skillSummaryCompatibilityResponse,
  taskPublicResponse,
} from "../wire/index.js";
import type {
  CreateAgentFromTemplateInput,
  CreateAgentInput,
  SetAgentSkillsInput,
  UpdateAgentInput,
} from "@multiremi/contracts/types.js";
import type { RouterDeps } from "./deps.js";

export function registerAgentRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;

  app.get("/api/multiremi/agents", (c) => {
    const workspaceId = requestedAgentWorkspaceId(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const agents = store.listAgents({
      includeArchived: c.req.query("include_archived") === "true" || c.req.query("includeArchived") === "true",
    }).filter((agent) =>
      agent.workspaceId === workspaceId && canCurrentUserAccessAgent(c, store, agent)
    );
    return c.json({ agents });
  });
  app.post("/api/multiremi/agents", async (c) => {
    const body = await readJsonStrict<CreateAgentInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const input = withAgentRequestContext(c, store, body);
    if (input instanceof Response) return input;
    const isFirstAgent = isFirstAgentInWorkspace(store, input.workspaceId ?? input.workspace_id ?? "local");
    const agent = store.createAgent(input);
    recordAgentCreatedAnalytics(c, store, agent, runtimeForAgentInput(store, body), {
      template: input.template,
      isFirstAgentInWorkspace: isFirstAgent,
    });
    publishAgentLifecycleEvent(c, store, "agent:created", agent);
    return c.json({ agent }, 201);
  });
  app.post("/api/multiremi/agents/default", async (c) => {
    const body = await readJsonStrict<{ provider?: string; runtimeId?: string | null; runtime_id?: string | null; workspaceId?: string | null; workspace_id?: string | null }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const workspaceId = requestedAgentWorkspaceId(c, body);
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const provider = resolveAgentRequestProvider(c, store, workspaceId, body);
    if (provider instanceof Response) return provider;
    const actingUserId = currentRequestUserId(c);
    const before = store.getDefaultAgent(workspaceId, provider, actingUserId);
    const isFirstAgent = isFirstAgentInWorkspace(store, workspaceId);
    const agent = store.ensureDefaultAgent(provider, {
      workspaceId,
      ownerId: actingUserId,
    });
    if (!before) {
      recordAgentCreatedAnalytics(c, store, agent, runtimeForAgentInput(store, body), {
        template: "default",
        isFirstAgentInWorkspace: isFirstAgent,
      });
      publishAgentLifecycleEvent(c, store, "agent:created", agent);
    }
    return c.json({ agent }, before ? 200 : 201);
  });
  app.get("/api/multiremi/agents/:id", (c) => {
    const loaded = loadAgentForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    return c.json({ agent: loaded.agent });
  });
  app.patch("/api/multiremi/agents/:id", async (c) => {
    const loaded = loadAgentForCurrentManager(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrict<UpdateAgentInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const input = withAgentUpdateRequestContext(c, store, loaded.agent, body);
    if (input instanceof Response) return input;
    const agent = store.updateAgent(loaded.agent.id, input);
    publishAgentLifecycleEvent(c, store, "agent:status", agent);
    return c.json({ agent });
  });
  app.delete("/api/multiremi/agents/:id", (c) => {
    const loaded = loadAgentForCurrentManager(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const agent = store.archiveAgent(loaded.agent.id);
    publishAgentLifecycleEvent(c, store, "agent:archived", agent);
    return c.json({ agent });
  });
  app.get("/api/multiremi/agents/:id/skills", (c) => {
    const loaded = loadAgentForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const skills = store.listAgentSkills(loaded.agent.id);
    return c.json({ skills, total: skills.length });
  });
  app.get("/api/multiremi/agents/:id/tasks", (c) => {
    const loaded = loadAgentForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const tasks = store.listAgentTasks(loaded.agent.id).map(taskPublicResponse);
    return c.json({ tasks, total: tasks.length });
  });
  app.put("/api/multiremi/agents/:id/skills", async (c) => {
    const loaded = loadAgentForCurrentManager(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJson<SetAgentSkillsInput>(c);
    const skills = store.setAgentSkills(loaded.agent.id, body);
    return c.json({ skills, total: skills.length });
  });
  app.get("/api/agents/:id/tasks", (c) => {
    const loaded = loadAgentForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    return c.json(store.listAgentTasks(loaded.agent.id).map(taskPublicResponse));
  });
  app.get("/api/agents/:id/skills", (c) => {
    const loaded = loadAgentForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    return c.json(store.listAgentSkills(loaded.agent.id, { includeFiles: false }).map(skillSummaryCompatibilityResponse));
  });
  app.put("/api/agents/:id/skills", async (c) => {
    const loaded = loadAgentForCurrentManager(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrict<SetAgentSkillsInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const skills = store.setAgentSkills(loaded.agent.id, body);
      publishAgentSkillsEvent(c, store, loaded.agent, skills);
      return c.json(skills.map(skillSummaryCompatibilityResponse));
    } catch (error) {
      return skillCompatibilityErrorResponse(c, error);
    }
  });
  app.post("/api/agents/:id/skills/add", async (c) => {
    const loaded = loadAgentForCurrentManager(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrict<SetAgentSkillsInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const currentSkillIds = store.listAgentSkills(loaded.agent.id, { includeFiles: false })
      .map((skill) => skill.id)
      .filter((id): id is string => Boolean(id));
    const nextSkillIds = Array.from(new Set([...currentSkillIds, ...(body.skillIds ?? body.skill_ids ?? [])]));
    try {
      const skills = store.setAgentSkills(loaded.agent.id, { skillIds: nextSkillIds });
      publishAgentSkillsEvent(c, store, loaded.agent, skills);
      return c.json(skills.map(skillSummaryCompatibilityResponse));
    } catch (error) {
      return skillCompatibilityErrorResponse(c, error);
    }
  });
  app.get("/api/agents/:id/env", (c) => {
    const loaded = loadAgentEnvForCurrentAdmin(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const { agent } = loaded;
    return c.json(agentEnvResponse(agent.id, agent.customEnv));
  });
  app.put("/api/agents/:id/env", async (c) => {
    const loaded = loadAgentEnvForCurrentAdmin(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const { agent } = loaded;
    const body = await readJsonStrict<{ custom_env?: Record<string, string>; customEnv?: Record<string, string>; env?: Record<string, string> }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const nextEnv = mergeAgentEnv(agent.customEnv, body.custom_env ?? body.customEnv ?? body.env ?? {});
    const updated = store.updateAgent(agent.id, { customEnv: nextEnv });
    return c.json(agentEnvResponse(updated.id, updated.customEnv));
  });
  app.get("/api/agents", (c) => {
    const workspaceId = requestedAgentWorkspaceId(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const agents = store.listAgents({
      includeArchived: c.req.query("include_archived") === "true" || c.req.query("includeArchived") === "true",
    }).filter((agent) =>
      agent.workspaceId === workspaceId && canCurrentUserAccessAgent(c, store, agent)
    );
    return c.json(agents.map((agent) => agentCompatibilityResponse(store, agent, c)));
  });
  app.post("/api/agents", async (c) => {
    const body = await readJsonStrict<CreateAgentInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const input = withAgentRequestContext(c, store, body);
    if (input instanceof Response) return input;
    const isFirstAgent = isFirstAgentInWorkspace(store, input.workspaceId ?? input.workspace_id ?? "local");
    const agent = store.createAgent(input);
    recordAgentCreatedAnalytics(c, store, agent, runtimeForAgentInput(store, body), {
      template: input.template,
      isFirstAgentInWorkspace: isFirstAgent,
    });
    publishAgentLifecycleEvent(c, store, "agent:created", agent);
    return c.json(agentCompatibilityResponse(store, agent, c), 201);
  });
  app.post("/api/agents/from-template", async (c) => {
    const body = await readJsonStrict<CreateAgentFromTemplateInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const input = withAgentTemplateRequestContext(c, store, body);
    if (input instanceof Response) return input;
    const isFirstAgent = isFirstAgentInWorkspace(store, input.workspaceId ?? input.workspace_id ?? "local");
    const result = await createAgentFromTemplate(store, input);
    recordAgentCreatedAnalytics(c, store, result.agent, runtimeForAgentInput(store, body), {
      template: input.templateSlug ?? input.template_slug,
      isFirstAgentInWorkspace: isFirstAgent,
    });
    publishAgentLifecycleEvent(c, store, "agent:created", result.agent);
    return c.json({
      agent: agentCompatibilityResponse(store, result.agent, c),
      imported_skill_ids: result.imported_skill_ids,
      reused_skill_ids: result.reused_skill_ids,
    }, 201);
  });
  app.get("/api/agents/:id", (c) => {
    const loaded = loadAgentForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    return c.json(agentCompatibilityResponse(store, loaded.agent, c));
  });
  app.put("/api/agents/:id", async (c) => {
    const loaded = loadAgentForCurrentManager(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrict<UpdateAgentInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const input = withAgentUpdateRequestContext(c, store, loaded.agent, body);
    if (input instanceof Response) return input;
    const agent = store.updateAgent(loaded.agent.id, input);
    publishAgentLifecycleEvent(c, store, "agent:status", agent);
    return c.json(agentCompatibilityResponse(store, agent, c));
  });
  app.post("/api/agents/:id/archive", (c) => {
    const loaded = loadAgentForCurrentManager(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const agent = store.archiveAgent(loaded.agent.id);
    publishAgentLifecycleEvent(c, store, "agent:archived", agent);
    return c.json(agentCompatibilityResponse(store, agent, c));
  });
  app.post("/api/agents/:id/restore", (c) => {
    const loaded = loadAgentForCurrentManager(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const agent = store.restoreAgent(loaded.agent.id);
    publishAgentLifecycleEvent(c, store, "agent:restored", agent);
    return c.json(agentCompatibilityResponse(store, agent, c));
  });
  app.post("/api/agents/:id/cancel-tasks", (c) => {
    const loaded = loadAgentForCurrentManager(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    return c.json({ cancelled: store.cancelAgentTasks(loaded.agent.id) });
  });
  app.post("/api/multiremi/agents/from-template", async (c) => {
    const body = await readJsonStrict<CreateAgentFromTemplateInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const input = withAgentTemplateRequestContext(c, store, body);
    if (input instanceof Response) return input;
    const isFirstAgent = isFirstAgentInWorkspace(store, input.workspaceId ?? input.workspace_id ?? "local");
    const result = await createAgentFromTemplate(store, input);
    recordAgentCreatedAnalytics(c, store, result.agent, runtimeForAgentInput(store, body), {
      template: input.templateSlug ?? input.template_slug,
      isFirstAgentInWorkspace: isFirstAgent,
    });
    publishAgentLifecycleEvent(c, store, "agent:created", result.agent);
    return c.json(result, 201);
  });
  app.get("/api/multiremi/agent-task-snapshot", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const tasks = store.listWorkspaceAgentTaskSnapshot(workspaceId).map(taskPublicResponse);
    return c.json({ tasks, total: tasks.length });
  });
  app.get("/api/agent-task-snapshot", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    return c.json(store.listWorkspaceAgentTaskSnapshot(workspaceId).map(taskPublicResponse));
  });
  app.get("/api/multiremi/agent-run-counts", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const counts = store.listWorkspaceAgentRunCounts(workspaceId);
    return c.json({ counts, total: counts.length });
  });
  app.get("/api/agent-run-counts", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    return c.json(store.listWorkspaceAgentRunCounts(workspaceId));
  });
  app.get("/api/multiremi/agent-activity-30d", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const activity = store.listWorkspaceAgentActivity30d(workspaceId);
    return c.json({ activity, total: activity.length });
  });
  app.get("/api/agent-activity-30d", (c) => {
    const workspaceId = c.req.query("workspaceId") ?? c.req.query("workspace_id") ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    return c.json(store.listWorkspaceAgentActivity30d(workspaceId));
  });
}
