// Agent and skill request plumbing: the `with*RequestContext` builders that fold caller identity
// and defaults into create/update inputs, the `load*For*` guards, and the provider/thinking-level
// validation shared by the agents, skills and agent-template routers.
import type { Context } from "hono";
import { getAgentTemplate } from "../agent-templates.js";
import { MultiremiStore } from "@multiremi/store/store.js";
import {
  MULTIREMI_DAEMON_PROVIDERS,
  cleanString,
  currentAccessToken,
  currentRequestUserId,
  currentTaskAccessToken,
  currentWorkspaceRoleStrict,
  hasRequestField,
  requestedSkillWorkspaceId,
} from "../wire/index.js";
import type {
  CreateAgentFromTemplateInput,
  CreateAgentInput,
  CreateSkillInput,
  ImportSkillInput,
  MultiremiAgent,
  MultiremiRuntime,
  MultiremiSkill,
  UpdateAgentInput,
  UpdateSkillInput,
} from "@multiremi/contracts/types.js";
import { canCurrentUserAccessAgent, denyCurrentUserWorkspaceAccess } from "./auth-guards.js";
import { canCurrentUserUseRuntime } from "./runtimes.js";

export const MAX_AGENT_DESCRIPTION_LENGTH = 255;

export const PROVIDER_THINKING_LEVELS: Record<string, Set<string>> = {
  claude: new Set(["low", "medium", "high", "xhigh", "max"]),
  codex: new Set(["none", "minimal", "low", "medium", "high", "xhigh"]),
};

export function requestedAgentWorkspaceId(c: Context, input?: Pick<CreateAgentInput, "workspaceId" | "workspace_id">): string {
  return cleanString(input?.workspaceId) ??
    cleanString(input?.workspace_id) ??
    cleanString(c.req.query("workspaceId")) ??
    cleanString(c.req.query("workspace_id")) ??
    currentAccessToken(c)?.workspaceId ??
    "local";
}

/**
 * Prefer server-discovered gateway models per engine when a snapshot exists (so the
 * dropdown reflects the real gateway even with zero online runtimes); otherwise keep
 * the per-runtime union. online_runtime_count still comes from the runtime buckets.
 */
export function overlayGatewayModels(
  store: MultiremiStore,
  workspaceId: string,
  providers: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  // Discovery off → never surface a (possibly stale) gateway snapshot; fall back
  // to the per-runtime union so turning the toggle off actually hides the models.
  if (!store.getRelayModelDiscovery(workspaceId)) return providers;
  const config = store.getRelayConfigForDaemon(workspaceId);
  const byEngine = new Map<string, Record<string, unknown>>();
  for (const provider of providers) byEngine.set(String(provider.provider), provider);
  for (const engine of ["claude", "codex"] as const) {
    const engineConfig = config[engine];
    // No live gateway credential → don't surface any (possibly stale) snapshot.
    if (!engineConfig || !engineConfig.authToken) continue;
    const snapshot = store.getGatewayModels(workspaceId, engine);
    if (!snapshot || snapshot.models.length === 0) continue;
    // Only show a snapshot discovered for the CURRENT config revision — a changed
    // gateway/token invalidates the old catalog until rediscovery catches up.
    if (snapshot.sourceRevision !== engineConfig.revision) continue;
    const models = snapshot.models.map((model) => ({ id: model.id, label: model.label, provider: engine }));
    const existing = byEngine.get(engine);
    if (existing) existing.models = models;
    else byEngine.set(engine, { provider: engine, online_runtime_count: 0, models });
  }
  return [...byEngine.values()].sort((a, b) => String(a.provider).localeCompare(String(b.provider)));
}

export function skillWorkspaceId(skill: MultiremiSkill): string {
  return skill.workspaceId ?? "local";
}

export function withSkillCreateRequestContext(
  c: Context,
  store: MultiremiStore,
  input: CreateSkillInput,
): CreateSkillInput | Response {
  const workspaceId = requestedSkillWorkspaceId(c, input);
  const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
  if (denied) return denied;
  const userId = currentRequestUserId(c);
  return {
    ...input,
    workspaceId,
    workspace_id: workspaceId,
    createdBy: userId,
    created_by: userId,
  };
}

export function withSkillImportRequestContext(
  c: Context,
  store: MultiremiStore,
  input: ImportSkillInput,
): ImportSkillInput | Response {
  const workspaceId = requestedSkillWorkspaceId(c, input);
  const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
  if (denied) return denied;
  const userId = currentRequestUserId(c);
  return {
    ...input,
    workspaceId,
    workspace_id: workspaceId,
    createdBy: userId,
    created_by: userId,
  };
}

export function withSkillUpdateRequestContext(current: MultiremiSkill, input: UpdateSkillInput): UpdateSkillInput {
  const workspaceId = skillWorkspaceId(current);
  return {
    ...input,
    workspaceId,
    workspace_id: workspaceId,
    createdBy: current.createdBy ?? null,
    created_by: current.createdBy ?? null,
  };
}

export function loadSkillForCurrentUser(
  c: Context,
  store: MultiremiStore,
  skillId: string,
): { skill: MultiremiSkill } | Response {
  const skill = store.getSkill(skillId);
  if (!skill) return c.json({ error: "skill not found" }, 404);
  const workspaceId = skillWorkspaceId(skill);
  if (requestedSkillWorkspaceId(c) !== workspaceId) return c.json({ error: "skill not found" }, 404);
  const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
  if (denied) return c.json({ error: "skill not found" }, 404);
  return { skill };
}

export function loadSkillForCurrentManager(
  c: Context,
  store: MultiremiStore,
  skillId: string,
): { skill: MultiremiSkill } | Response {
  const loaded = loadSkillForCurrentUser(c, store, skillId);
  if (loaded instanceof Response) return loaded;
  const role = currentWorkspaceRoleStrict(c, store, skillWorkspaceId(loaded.skill));
  if (!role) return c.json({ error: "skill not found" }, 404);
  if (role === "owner" || role === "admin" || loaded.skill.createdBy === currentRequestUserId(c)) {
    return loaded;
  }
  return c.json({ error: "only the skill creator can manage this skill" }, 403);
}

export function loadAgentForCurrentManager(
  c: Context,
  store: MultiremiStore,
  agentId: string,
): { agent: MultiremiAgent } | Response {
  if (currentTaskAccessToken(c)) return c.json({ error: "this endpoint is only available to human actors" }, 403);
  const loaded = loadAgentForCurrentUser(c, store, agentId);
  if (loaded instanceof Response) return loaded;
  const role = currentWorkspaceRoleStrict(c, store, loaded.agent.workspaceId);
  if (!role) return c.json({ error: "agent not found" }, 404);
  if (role === "owner" || role === "admin" || loaded.agent.ownerId === currentRequestUserId(c)) {
    return loaded;
  }
  return c.json({ error: "only the agent owner can manage this agent" }, 403);
}

export function loadAgentEnvForCurrentAdmin(
  c: Context,
  store: MultiremiStore,
  agentId: string,
): { agent: MultiremiAgent } | Response {
  if (currentTaskAccessToken(c)) return c.json({ error: "this endpoint is only available to human actors" }, 403);
  const loaded = loadAgentForCurrentUser(c, store, agentId);
  if (loaded instanceof Response) return loaded;
  const role = currentWorkspaceRoleStrict(c, store, loaded.agent.workspaceId);
  if (!role) return c.json({ error: "agent not found" }, 404);
  if (role === "owner" || role === "admin") return loaded;
  return c.json({ error: "insufficient permissions" }, 403);
}

export function runtimeForAgentInput(
  store: MultiremiStore,
  input: { runtimeId?: string | null; runtime_id?: string | null },
): MultiremiRuntime | null {
  const runtimeId = cleanString(input.runtimeId ?? input.runtime_id);
  return runtimeId ? store.getRuntime(runtimeId) : null;
}

export function agentAnalyticsProvider(agent: MultiremiAgent, runtime: MultiremiRuntime | null): string {
  if (runtime?.provider && runtime.provider !== "any") return runtime.provider;
  return agent.provider;
}

export function isFirstAgentInWorkspace(store: MultiremiStore, workspaceId: string): boolean {
  return store.listAgents().every((agent) => agent.workspaceId !== workspaceId);
}

export function parseExpectedActiveAgentIds(c: Context, value: unknown): string[] | Response {
  if (!Array.isArray(value)) {
    return c.json({ error: "expected_active_agent_ids must be a list of valid UUIDs" }, 400);
  }
  const ids = new Set<string>();
  for (const item of value) {
    const id = cleanString(typeof item === "string" ? item : null);
    if (!id) return c.json({ error: "expected_active_agent_ids must be a list of valid UUIDs" }, 400);
    ids.add(id);
  }
  return [...ids];
}

export function withAgentRequestContext(c: Context, store: MultiremiStore, input: CreateAgentInput): CreateAgentInput | Response {
  const workspaceId = requestedAgentWorkspaceId(c, input);
  const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
  if (denied) return denied;
  const name = cleanString(typeof input.name === "string" ? input.name : null);
  if (!name) return c.json({ error: "name is required" }, 400);
  const provider = resolveAgentRequestProvider(c, store, workspaceId, input);
  if (provider instanceof Response) return provider;
  const conflict = store.getAgentByWorkspaceAndName(workspaceId, name);
  if (conflict) return agentNameConflict(c, name);
  const maxConcurrentTasks = normalizeAgentRequestMaxConcurrentTasks(c, input.maxConcurrentTasks ?? input.max_concurrent_tasks);
  if (maxConcurrentTasks instanceof Response) return maxConcurrentTasks;
  const description = normalizeAgentRequestDescription(c, input.description);
  if (description instanceof Response) return description;
  const thinkingLevel = agentRequestThinkingLevel(input);
  if (!isKnownThinkingValue(provider, thinkingLevel)) {
    return agentThinkingLevelError(c, thinkingLevel, provider);
  }
  const ownerId = currentRequestUserId(c);
  return {
    ...input,
    name,
    description,
    provider,
    workspaceId,
    workspace_id: workspaceId,
    ownerId,
    owner_id: ownerId,
    runtimeId: null,
    runtime_id: null,
    maxConcurrentTasks,
    max_concurrent_tasks: maxConcurrentTasks,
  };
}

export function withAgentUpdateRequestContext(
  c: Context,
  store: MultiremiStore,
  current: MultiremiAgent,
  input: UpdateAgentInput,
): UpdateAgentInput | Response {
  const next: UpdateAgentInput = { ...input };
  if (hasRequestField(input, "custom_env", "customEnv", "env")) {
    return c.json({
      error: "custom_env is no longer accepted on this endpoint; use PUT /api/agents/{id}/env (or `multiremi agent env set`)",
    }, 400);
  }
  if (hasRequestField(input, "name")) {
    const name = cleanString(typeof input.name === "string" ? input.name : null);
    if (!name) return c.json({ error: "name is required" }, 400);
    const conflict = store.getAgentByWorkspaceAndName(current.workspaceId, name);
    if (conflict && conflict.id !== current.id) return agentNameConflict(c, name);
    next.name = name;
  }
  if (hasRequestField(input, "description")) {
    const description = normalizeAgentRequestDescription(c, input.description);
    if (description instanceof Response) return description;
    next.description = description;
  }
  let targetProvider = current.provider;
  let providerChanged = false;
  const applyProvider = (provider: string) => {
    targetProvider = provider;
    providerChanged = provider !== current.provider;
    next.provider = provider;
  };
  if (hasRequestField(input, "provider")) {
    const provider = cleanString(typeof input.provider === "string" ? input.provider : null);
    if (!provider || !MULTIREMI_DAEMON_PROVIDERS.has(provider)) {
      return c.json({ error: `unknown provider "${provider ?? ""}"` }, 400);
    }
    applyProvider(provider);
  }
  // Agents are pool workers now — machine binding is gone. A legacy "move to
  // runtime" request keeps its one observable effect, switching the agent's
  // engine, with full legacy validation (existence, workspace, the
  // private-runtime gate). The binding itself is dropped.
  if (hasRequestField(input, "runtimeId", "runtime_id")) {
    const legacyRuntimeId = cleanString(input.runtimeId ?? input.runtime_id);
    delete next.runtimeId;
    delete next.runtime_id;
    if (legacyRuntimeId) {
      const provider = resolveAgentRequestProvider(c, store, current.workspaceId, {
        runtime_id: legacyRuntimeId,
        // On an "any" runtime the request's provider falls through; default it
        // to the agent's CURRENT provider (not "claude") so a legacy move to an
        // any-runtime doesn't silently flip a Codex agent to Claude.
        provider: input.provider ?? current.provider,
      });
      if (provider instanceof Response) return provider;
      applyProvider(provider);
    }
  }
  if (hasRequestField(input, "thinkingLevel", "thinking_level")) {
    const thinkingLevel = agentRequestThinkingLevel(input);
    if (!isKnownThinkingValue(targetProvider, thinkingLevel)) {
      return agentThinkingLevelError(c, thinkingLevel, targetProvider);
    }
  } else if (providerChanged && current.thinkingLevel && !isKnownThinkingValue(targetProvider, current.thinkingLevel)) {
    return c.json({
      error: `existing thinking_level "${current.thinkingLevel}" is not valid for provider "${targetProvider}"; pass thinking_level="" to clear or set a value valid for the new provider`,
    }, 400);
  }
  // A model id is engine-specific — carrying e.g. a claude model onto codex
  // would hand the codex CLI an unknown model. Unless the request also picks
  // a model, an engine switch resets it to the engine default.
  if (providerChanged && !hasRequestField(input, "model")) {
    next.model = "";
  }
  if (hasRequestField(input, "maxConcurrentTasks", "max_concurrent_tasks")) {
    const maxConcurrentTasks = normalizeAgentRequestMaxConcurrentTasks(c, input.maxConcurrentTasks ?? input.max_concurrent_tasks);
    if (maxConcurrentTasks instanceof Response) return maxConcurrentTasks;
    next.maxConcurrentTasks = maxConcurrentTasks;
    next.max_concurrent_tasks = maxConcurrentTasks;
  }
  return next;
}

export function withAgentTemplateRequestContext(
  c: Context,
  store: MultiremiStore,
  input: CreateAgentFromTemplateInput,
): CreateAgentFromTemplateInput | Response {
  const workspaceId = requestedAgentWorkspaceId(c, input);
  const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
  if (denied) return denied;
  const name = cleanString(typeof input.name === "string" ? input.name : null);
  if (!name) return c.json({ error: "name is required" }, 400);
  const templateSlug = cleanString(input.templateSlug ?? input.template_slug);
  if (!templateSlug) return c.json({ error: "template_slug is required" }, 400);
  const template = getAgentTemplate(templateSlug);
  if (!template) return c.json({ error: `template not found: ${templateSlug}` }, 400);
  const conflict = store.getAgentByWorkspaceAndName(workspaceId, name);
  if (conflict) return agentNameConflict(c, name);
  const provider = resolveAgentRequestProvider(c, store, workspaceId, input);
  if (provider instanceof Response) return provider;
  const maxConcurrentTasks = normalizeAgentRequestMaxConcurrentTasks(c, input.maxConcurrentTasks ?? input.max_concurrent_tasks);
  if (maxConcurrentTasks instanceof Response) return maxConcurrentTasks;
  const description = normalizeAgentRequestDescription(c, input.description ?? template.description);
  if (description instanceof Response) return description;
  const ownerId = currentRequestUserId(c);
  return {
    ...input,
    name,
    description,
    provider,
    workspaceId,
    workspace_id: workspaceId,
    ownerId,
    owner_id: ownerId,
    runtimeId: null,
    runtime_id: null,
    maxConcurrentTasks,
    max_concurrent_tasks: maxConcurrentTasks,
  };
}

/**
 * Resolve the provider for an agent create request. Agents are pool workers —
 * they never bind to a runtime — but legacy clients still send runtime_id, so
 * a supplied one keeps its full validation (existence, workspace, visibility)
 * and contributes only its provider.
 */
export function resolveAgentRequestProvider(
  c: Context,
  store: MultiremiStore,
  workspaceId: string,
  input: { runtimeId?: string | null; runtime_id?: string | null; provider?: unknown },
): string | Response {
  const runtimeId = cleanString(input.runtimeId ?? input.runtime_id);
  if (runtimeId) {
    const runtime = store.getRuntime(runtimeId);
    if (!runtime || (runtime.workspaceId ?? "local") !== workspaceId) {
      return c.json({ error: "invalid runtime_id" }, 400);
    }
    if (!canCurrentUserUseRuntime(c, store, runtime)) {
      return c.json({ error: "this runtime is private; only its owner or a workspace admin can create agents on it" }, 403);
    }
    // An "any" runtime contributes no provider of its own — the requested one
    // falls through and must still pass the whitelist.
    const derived = agentProviderForRuntime(input.provider, runtime);
    if (!MULTIREMI_DAEMON_PROVIDERS.has(derived)) {
      return c.json({ error: `unknown provider "${derived}"` }, 400);
    }
    return derived;
  }
  const provider = cleanString(typeof input.provider === "string" ? input.provider : null) ?? "claude";
  if (!MULTIREMI_DAEMON_PROVIDERS.has(provider)) {
    return c.json({ error: `unknown provider "${provider}"` }, 400);
  }
  return provider;
}

export function agentProviderForRuntime(provider: unknown, runtime: MultiremiRuntime): CreateAgentInput["provider"] {
  if (runtime.provider && runtime.provider !== "any") return runtime.provider;
  return cleanString(typeof provider === "string" ? provider : null) ?? "claude";
}

export function normalizeAgentRequestDescription(c: Context, value: unknown): string | Response {
  const description = String(value ?? "");
  if (Array.from(description).length > MAX_AGENT_DESCRIPTION_LENGTH) {
    return c.json({ error: `description must be ${MAX_AGENT_DESCRIPTION_LENGTH} characters or fewer` }, 400);
  }
  return description;
}

export function agentRequestThinkingLevel(input: CreateAgentInput | UpdateAgentInput): string {
  return String(input.thinkingLevel ?? input.thinking_level ?? "");
}

export function isKnownThinkingValue(provider: string, value: string): boolean {
  if (!value) return true;
  return PROVIDER_THINKING_LEVELS[provider]?.has(value) ?? false;
}

export function agentThinkingLevelError(c: Context, value: string, provider: string): Response {
  return c.json({ error: `thinking_level "${value}" is not a recognised value for runtime "${provider}"` }, 400);
}

export function normalizeAgentRequestMaxConcurrentTasks(c: Context, value: unknown): number | Response {
  const concurrency = Number(value ?? 0);
  if (!concurrency) return 6;
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    return c.json({ error: "max_concurrent_tasks must be at least 1" }, 400);
  }
  return Math.trunc(concurrency);
}

export function agentNameConflict(c: Context, name: string): Response {
  return c.json({ error: `an agent named "${name}" already exists in this workspace` }, 409);
}

export function loadAgentForCurrentUser(
  c: Context,
  store: MultiremiStore,
  agentId: string,
): { agent: MultiremiAgent } | Response {
  const agent = store.getAgent(agentId);
  if (!agent) return c.json({ error: "agent not found" }, 404);
  const denied = denyCurrentUserWorkspaceAccess(c, store, agent.workspaceId);
  if (denied) return denied;
  if (!canCurrentUserAccessAgent(c, store, agent)) {
    return c.json({ error: "you do not have access to this agent" }, 403);
  }
  return { agent };
}

export function mergeAgentEnv(current: Record<string, string>, input: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(input)) {
    const cleanKey = key.trim();
    if (!cleanKey) continue;
    const value = String(rawValue ?? "");
    next[cleanKey] = value === "****" && current[cleanKey] !== undefined ? current[cleanKey] : value;
  }
  return next;
}
