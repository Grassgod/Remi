import { createLogger } from "@shared/logger.js";
import { workspaceRuntimeModelCatalog, catalogAllowsModel, commonThinkingCapabilities, modelThinkingState, providerDeclaresReasoningLevels, runtimeTargetModelCatalog } from "@multiremi/store/runtime-model-catalog.js";
import { GATEWAY_REASONING_LEVELS, manualThinkingResponse } from "@multiremi/store/runtime-model-catalog.js";
import type { FleetModelThinkingResponse, FleetModelThinkingSource } from "@multiremi/store/runtime-model-catalog.js";
import type { RelayEngine } from "@multiremi/store/store.js";
export { workspaceRuntimeModelCatalog, overlayGatewayModels, runtimeTargetModelCatalog } from "@multiremi/store/runtime-model-catalog.js";
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
import {
  canCurrentUserAccessAgent,
  denyCurrentUserWorkspaceAccess,
  requireHumanWorkspaceAdmin,
} from "./auth-guards.js";
import { canCurrentUserUseRuntime } from "./runtimes.js";
import { resolveRequestWorkspaceId } from "./workspace-context.js";
import {
  type FleetModelResponse,
  type FleetProviderModelsResponse,
} from "../wire/runtimes.js";
import { isAgentRole } from "@multiremi/store/agent-role.js";
import { currentTaskIssueCreationRestricted } from "./issues.js";
import { modelThinkingLevels } from "@multiremi/contracts/model-thinking.js";

export const MAX_AGENT_DESCRIPTION_LENGTH = 255;

const log = createLogger("agent-selection");

export function requestedAgentWorkspaceId(
  c: Context,
  store: MultiremiStore,
  input?: Pick<CreateAgentInput, "workspaceId" | "workspace_id">,
): string | Response {
  const explicitId = cleanString(input?.workspaceId) ??
    cleanString(input?.workspace_id) ??
    cleanString(c.req.query("workspaceId")) ??
    cleanString(c.req.query("workspace_id"));
  return resolveRequestWorkspaceId(c, store, explicitId);
}

/** Return only members that can execute this owner's agents, including offline members. */
export function executionGroupRuntimes(store: MultiremiStore, workspaceId: string, groupId: string, ownerId: string): MultiremiRuntime[] {
  const group = store.getExecutionGroup(groupId, workspaceId);
  if (!group) return [];
  const ids = new Set(group.runtimeIds);
  return store.listRuntimes().filter((runtime) => ids.has(runtime.id)
    && (runtime.workspaceId ?? "local") === workspaceId
    && (runtime.visibility === "public" || (runtime.ownerId ?? "local") === ownerId));
}

/** An explicit group model must be supported by every currently eligible member. */
export function executionGroupModelCatalog(store: MultiremiStore, workspaceId: string, groupId: string, ownerId: string): FleetProviderModelsResponse[] {
  const group = store.getExecutionGroup(groupId, workspaceId);
  if (!group) return [];
  const runtimes = executionGroupRuntimes(store, workspaceId, groupId, ownerId).sort((a, b) => a.id.localeCompare(b.id));
  const providers = runtimes.map((runtime) => runtimeTargetModelCatalog(store, workspaceId, runtime)
    .find((entry) => entry.provider === group.provider));
  const catalogs = providers.map((entry) => entry?.models ?? []);
  const models = (catalogs[0] ?? []).flatMap((model): FleetModelResponse[] => {
    const matches = catalogs.map((catalog) => catalog.find((candidate) => candidate.id === model.id));
    if (matches.some((candidate) => !candidate)) return [];
    const supported = modelThinkingLevels([model], model.id).filter((level) => matches.every((candidate) =>
      candidate && modelThinkingLevels([candidate], candidate.id).some((entry) => entry.value === level.value)));
    const failed = matches.find((candidate) => candidate?.thinking?.status === "error")?.thinking;
    const unknown = matches.some((candidate) => !candidate?.thinking || candidate.thinking.status === "unknown");
    const status = failed ? "error" : unknown ? "unknown" : supported.length ? "supported" : "unsupported";
    const explicitStatus = matches.some((candidate) => candidate?.thinking?.status !== undefined);
    const defaultLevel = model.thinking?.default_level;
    const thinkingDefault = defaultLevel && supported.some((level) => level.value === defaultLevel)
      && matches.every((candidate) => candidate?.thinking?.default_level === defaultLevel) ? defaultLevel : undefined;
    return [{
      id: model.id, label: model.label, provider: group.provider,
      ...(matches.some(candidate => candidate?.execution_status !== undefined) ? {
        execution_status: matches.some(candidate => candidate?.execution_status === "unknown") ? "unknown" as const
          : matches.some(candidate => candidate?.execution_status === "unavailable") ? "unavailable" as const : "available" as const,
      } : {}),
      ...(matches.every((candidate) => candidate?.default) ? { default: true } : {}),
      ...(supported.length || explicitStatus || matches.every((candidate) => candidate?.thinking) ? { thinking: {
        supported_levels: supported,
        ...(explicitStatus ? { status } : {}),
        ...(failed?.error ? { error: failed.error } : {}),
        ...(thinkingDefault ? { default_level: thinkingDefault } : {}),
      } } : {}),
    }];
  });
  return [{ provider: group.provider, models, online_runtime_count: runtimes.filter((runtime) => runtime.status === "online").length,
    ...(providers.some((entry) => entry?.model_catalog_status === "unknown")
      ? { model_catalog_status: "unknown" as const }
      : providers.some((entry) => entry?.model_catalog_status === "error")
      ? { model_catalog_status: "error" as const }
      : providers.some((entry) => entry?.model_catalog_status === "ready")
      ? { model_catalog_status: "ready" as const } : {}),
    ...(providers.some((entry) => entry?.default_thinking) ? { default_thinking: commonThinkingCapabilities(providers.map((entry) =>
      entry?.default_thinking ?? { supported_levels: modelThinkingLevels(entry?.models ?? [], "") })),
    } : {}),
  }];
}

export function executionGroupRequestOwner(c: Context, store: MultiremiStore, workspaceId: string): string | Response {
  const agentId = cleanString(c.req.query("agent_id"));
  if (!agentId) return currentRequestUserId(c);
  const loaded = loadAgentForCurrentManager(c, store, agentId);
  if (loaded instanceof Response) return loaded;
  if (loaded.agent.workspaceId !== workspaceId) return c.json({ error: "agent not found" }, 404);
  return loaded.agent.ownerId ?? "local";
}

/** Build the same workspace/provider catalog used by GET /api/models. */
export function workspaceProviderModelCatalog(
  store: MultiremiStore,
  workspaceId: string,
  provider: string,
  callerOwnerId: string,
  runtimeId?: string | null,
): FleetModelResponse[] {
  return workspaceProviderCatalog(store, workspaceId, provider, callerOwnerId, runtimeId)?.models ?? [];
}

function workspaceProviderCatalog(
  store: MultiremiStore,
  workspaceId: string,
  provider: string,
  callerOwnerId: string,
  runtimeId?: string | null,
): FleetProviderModelsResponse | undefined {
  if (runtimeId) {
    const runtime = store.getRuntime(runtimeId);
    return runtime && (runtime.workspaceId ?? "local") === workspaceId
      ? runtimeTargetModelCatalog(store, workspaceId, runtime).find((entry) => entry.provider === provider)
      : undefined;
  }
  const runtimes = store.listRuntimes().filter((runtime) => (runtime.workspaceId ?? "local") === workspaceId);
  const providers = workspaceRuntimeModelCatalog(store, workspaceId, runtimes, callerOwnerId);
  return providers.find((entry) => entry.provider === provider);
}

/** One gateway model's declared reasoning levels and what they resolve to. */
export interface GatewayReasoningLevelRow {
  model_id: string;
  label: string;
  /** The administrator's stored declaration, or null when none is stored. */
  manual: GatewayReasoningLevelManual | null;
  /** What routing will use, or null when the model has no reasoning entry. */
  effective: (FleetModelThinkingResponse & { source: FleetModelThinkingSource }) | null;
}

export interface GatewayReasoningLevelManual {
  levels: string[];
  default_level?: string;
  updated_by: string | null;
  updated_at: string;
}

function gatewayReasoningLevelManual(decl: {
  levels: string[]; defaultLevel?: string; updatedBy: string | null; updatedAt: string;
}): GatewayReasoningLevelManual {
  return {
    levels: decl.levels,
    ...(decl.defaultLevel ? { default_level: decl.defaultLevel } : {}),
    updated_by: decl.updatedBy,
    updated_at: decl.updatedAt,
  };
}

/**
 * The gateway model list for one engine, each row carrying the stored
 * declaration and the levels that actually take effect.
 *
 * `effective` is read from the same catalog an Agent's selection is validated
 * against, so the page cannot disagree with routing. `source` says where those
 * levels came from — that is what lets the UI tell an administrator their
 * declaration is being outranked by a real gateway/Runtime statement instead of
 * silently ignoring it.
 */
export function gatewayReasoningLevels(
  store: MultiremiStore,
  workspaceId: string,
  engine: RelayEngine,
  callerOwnerId: string,
): { engine: RelayEngine; allowed_levels: readonly string[]; models: GatewayReasoningLevelRow[] } {
  const snapshot = store.getGatewayModels(workspaceId, engine);
  const declarations = store.listGatewayModelReasoning(workspaceId, engine);
  const effectiveModels = new Map(
    workspaceProviderModelCatalog(store, workspaceId, engine, callerOwnerId).map(model => [model.id, model]),
  );
  const rows = new Map<string, GatewayReasoningLevelRow>();
  for (const model of snapshot?.models ?? []) {
    rows.set(model.id, { model_id: model.id, label: model.label, manual: null, effective: null });
  }
  // A declaration outlives the model's gateway entry: the snapshot is replaced on
  // every probe, so an alias that disappears would otherwise become impossible to
  // clear from the page that created it.
  for (const decl of declarations) {
    const existing = rows.get(decl.modelId);
    rows.set(decl.modelId, {
      model_id: decl.modelId,
      label: existing?.label ?? decl.modelId,
      manual: gatewayReasoningLevelManual(decl),
      effective: null,
    });
  }
  for (const [modelId, row] of rows) {
    const resolved = effectiveModels.get(modelId);
    if (!resolved?.thinking) continue;
    row.effective = { ...resolved.thinking, source: resolved.thinking_source ?? "none" };
  }
  return {
    engine,
    allowed_levels: GATEWAY_REASONING_LEVELS[engine],
    models: [...rows.values()].sort((a, b) => a.model_id.localeCompare(b.model_id)),
  };
}

/**
 * Validate one declaration request. Returns the normalized pair or an error
 * string; the enum is checked server-side because the values are forwarded to the
 * CLI verbatim — an unknown spelling would route as if declared and then fail at
 * execution, which is worse than a 400 here.
 */
export function validateGatewayReasoningLevels(
  engine: RelayEngine,
  input: { model?: unknown; levels?: unknown; default_level?: unknown },
): { ok: true; modelId: string; levels: string[]; defaultLevel?: string } | { ok: false; error: string } {
  const modelId = cleanString(typeof input.model === "string" ? input.model : "");
  if (!modelId) return { ok: false, error: "model is required" };
  if (!Array.isArray(input.levels)) return { ok: false, error: "levels must be an array" };
  const allowed = GATEWAY_REASONING_LEVELS[engine];
  const levels: string[] = [];
  for (const value of input.levels) {
    if (!allowed.includes(value as string)) {
      return { ok: false, error: `unsupported reasoning level "${String(value)}" for engine "${engine}" (allowed: ${allowed.join(", ")})` };
    }
    if (!levels.includes(value as string)) levels.push(value as string);
  }
  if (input.default_level !== undefined && input.default_level !== null && input.default_level !== "") {
    if (typeof input.default_level !== "string" || !levels.includes(input.default_level)) {
      return { ok: false, error: "default_level must be one of levels" };
    }
    return { ok: true, modelId, levels, defaultLevel: input.default_level };
  }
  return { ok: true, modelId, levels };
}

/** The catalog the selection is validated against: the execution group's common
 *  set when one is selected, otherwise the workspace/provider (or pinned Runtime). */
function agentSelectionCatalog(
  c: Context,
  store: MultiremiStore,
  input: {
    workspaceId: string;
    provider: string;
    runtimeId?: string | null;
    executionGroupId?: string | null;
    ownerId?: string;
  },
): FleetProviderModelsResponse | undefined {
  return input.executionGroupId && !input.runtimeId
    ? executionGroupModelCatalog(store, input.workspaceId, input.executionGroupId, input.ownerId ?? currentRequestUserId(c))[0]
    : workspaceProviderCatalog(store, input.workspaceId, input.provider, currentRequestUserId(c), input.runtimeId);
}

/**
 * Drop a reasoning level the target model cannot honour, instead of storing it.
 *
 * Gateway-only models — Claude has no `supported_reasoning_levels`, and the
 * Runtime reports the native ACP selector only for its own aliases — declare no
 * levels at all. The Agent can still carry a level from before that was true
 * (MUL-338), and validation only ever looked at an EXPLICITLY sent level, so any
 * later metadata-only edit preserved the unusable value forever. Clearing it is
 * what the capability contract actually says: `docs/runtime-model-discovery.md`
 * forbids borrowing another model's levels, so "no declaration" means the effort
 * is not applicable rather than pending. Routing ignores such a level too, but
 * leaving it stored keeps the Agent pinned to a value the UI cannot even render.
 *
 * This only rewrites a level the caller did NOT freshly choose. An effort named
 * while also changing the selection is judged as before and rejected with a 400
 * when the catalog cannot confirm it, so an API client is told its request was
 * not honoured instead of silently getting something else. Everything else is a
 * leftover: no level sent at all, or the saved selection echoed back verbatim —
 * the case that used to short-circuit validation, which is why the stale value
 * survived every later edit.
 *
 * It also only applies where nothing declares levels at all. Engines that do
 * (`providerDeclaresReasoningLevels`) are left alone: clearing their stored value
 * would turn a selection routing still refuses into a claimable one running at
 * the default effort, which is exactly what MUL-330/#220 forbids.
 *
 * Finally, only a catalog that actually lists the model (or identifies the
 * provider default) may clear it: an absent entry is missing metadata, not an
 * answer.
 */
function convergeAgentThinkingLevel(
  c: Context,
  store: MultiremiStore,
  input: {
    workspaceId: string;
    provider: string;
    model: string;
    thinkingLevel: string;
    runtimeId?: string | null;
    executionGroupId?: string | null;
    ownerId?: string;
    /** True when the level comes from the stored Agent rather than this request. */
    carriedOver: boolean;
    /** True when this request changes model/provider/target, not just metadata. */
    selectionChanged: boolean;
  },
): string {
  if (!input.thinkingLevel) return "";
  if (!input.carriedOver) return input.thinkingLevel;
  // Engines that report reasoning levels answer for themselves: leave the stored
  // value alone and let validation (or task eligibility) judge it. Clearing it
  // here would silently turn a rejected selection into a runnable one at the
  // default effort, which is the one thing MUL-330/#220 forbids.
  if (providerDeclaresReasoningLevels(input.provider)) return input.thinkingLevel;
  const catalog = agentSelectionCatalog(c, store, input);
  const models = catalog?.models ?? [];
  const known = input.model
    ? models.some((model) => model.id === input.model)
    : Boolean(catalog?.default_thinking);
  if (!known) return input.thinkingLevel;
  const capability = modelThinkingState(models, input.model, catalog?.default_thinking);
  if (capability.state === "supported") {
    // The model does declare levels — from the engine, or from an administrator's
    // gateway declaration (MUL-338). A stored level inside that set is a valid
    // selection and is preserved here; one outside it is not usable at all.
    if (capability.levels.some((level) => level.value === input.thinkingLevel)) return input.thinkingLevel;
    // Unusable, and the model itself did not change: nothing can make this value
    // valid, so clear it rather than keep it stored forever. When the selection IS
    // changing, the caller is moving to a model that does offer efforts, and the
    // carried value is a mismatch it must be told about — leave it for validation
    // to reject, which is MUL-330/#220's atomic model+effort contract.
    return input.selectionChanged ? input.thinkingLevel : "";
  }
  log.info(`clearing carried-over thinking_level "${input.thinkingLevel}" for ${input.provider} model "${input.model || "default"}": the model declares no reasoning levels`);
  return "";
}

function validateAgentModelSelection(
  c: Context,
  store: MultiremiStore,
  input: {
    workspaceId: string;
    provider: string;
    model: string;
    thinkingLevel: string;
    runtimeId?: string | null;
    executionGroupId?: string | null;
    ownerId?: string;
    preserveSavedSelection?: boolean;
  },
): Response | null {
  const profile = input.runtimeId ? store.getRuntimeExecutionProfile(input.runtimeId, input.provider) : null;
  if (profile && input.model && input.model !== profile.model) {
    return c.json({ error: `model "${input.model}" is not supported by the selected Runtime connection; expected "${profile.model}"` }, 400);
  }
  // Unrelated edits may resend the saved selection. Discovery must never force
  // users to replace a saved model/effort just to edit an Agent's metadata.
  if (input.preserveSavedSelection) return null;
  const groupCatalog = !input.runtimeId && input.executionGroupId
    ? executionGroupModelCatalog(store, input.workspaceId, input.executionGroupId, input.ownerId ?? currentRequestUserId(c))[0]
    : undefined;
  const groupModels = !input.runtimeId && input.executionGroupId
    ? groupCatalog?.models ?? []
    : null;
  if (groupModels && input.model && !groupModels.some((model) => model.id === input.model)) {
    return c.json({ error: `model "${input.model}" is not supported by every available member of the selected execution group` }, 400);
  }
  const catalog = input.executionGroupId && !input.runtimeId ? groupCatalog : agentSelectionCatalog(c, store, input);
  const models = catalog?.models ?? [];
  if (!catalogAllowsModel(catalog, input.model)) {
    return c.json({
      code: catalog?.model_catalog_status === "unknown" ? "model_execution_catalog_unknown" : "model_not_in_execution_catalog",
      error: catalog?.model_catalog_status === "unknown"
        ? `model "${input.model}" cannot be selected while the Codex execution catalog is unknown or loading`
        : `model "${input.model}" is not in the available Codex execution catalog and cannot be executed`,
    }, 400);
  }
  // Unmanaged/custom connections retain their own model selection behavior.
  if (!input.thinkingLevel) return null;
  const supportedLevels = modelThinkingLevels(models, input.model, catalog?.default_thinking);
  const selectedModel = input.model
    ? models.find((model) => model.id === input.model)
    : models.find((model) => model.default);

  if (!selectedModel && (input.model || (supportedLevels.length === 0 && !catalog?.default_thinking))) {
    if (input.model && models.length > 0) {
      return c.json({
        error: `thinking_level "${input.thinkingLevel}" cannot be set because model "${input.model}" is not available for provider "${input.provider}" in workspace "${input.workspaceId}"`,
      }, 400);
    }
    if (models.length > 0) {
      return c.json({
        error: `thinking_level "${input.thinkingLevel}" cannot be set because no default model is identified for provider "${input.provider}" in workspace "${input.workspaceId}"; select a model explicitly`,
      }, 400);
    }
    return c.json({
      error: `thinking_level "${input.thinkingLevel}" cannot be set because no model catalog is available for provider "${input.provider}" in workspace "${input.workspaceId}"`,
    }, 400);
  }
  if (!supportedLevels.some((level) => level.value === input.thinkingLevel)) {
    return c.json({
      // Name the concrete model whenever one is identifiable; "default" is
      // reserved for the provider-default capability, which has no model id.
      error: `thinking_level "${input.thinkingLevel}" is not supported by model "${input.model || selectedModel?.id || "default"}" for provider "${input.provider}"`,
    }, 400);
  }
  return null;
}

function validateAgentFallbackSelection(
  c: Context,
  store: MultiremiStore,
  input: {
    workspaceId: string;
    provider: string;
    model: string;
    fallbackModel: string;
    fallbackThinkingLevel: string;
    runtimeId?: string | null;
    executionGroupId?: string | null;
    ownerId?: string;
    preserveSavedSelection?: boolean;
  },
): Response | null {
  if (!input.fallbackModel || input.preserveSavedSelection) return null;
  const profile = input.runtimeId ? store.getRuntimeExecutionProfile(input.runtimeId, input.provider) : null;
  const catalog = agentSelectionCatalog(c, store, input);
  const effectiveModel = input.model || profile?.model || catalog?.models.find((model) => model.default)?.id;
  if (effectiveModel === input.fallbackModel) {
    return c.json({ error: "fallback_model must be different from the primary model" }, 400);
  }
  if (profile && input.fallbackModel !== profile.model) {
    return c.json({
      code: "model_not_in_execution_catalog",
      error: `fallback_model "${input.fallbackModel}" is not supported by the selected Runtime connection`,
    }, 400);
  }
  if (!catalogAllowsModel(catalog, input.fallbackModel)
    || (input.executionGroupId && !input.runtimeId && !catalog?.models.some((model) => model.id === input.fallbackModel))) {
    return c.json({
      code: catalog?.model_catalog_status === "unknown" ? "model_execution_catalog_unknown" : "model_not_in_execution_catalog",
      error: `fallback_model "${input.fallbackModel}" is not in the selected execution target's model catalog`,
    }, 400);
  }
  if (input.fallbackThinkingLevel && !modelThinkingLevels(catalog?.models ?? [], input.fallbackModel, catalog?.default_thinking)
    .some((level) => level.value === input.fallbackThinkingLevel)) {
    return c.json({ error: `fallback_thinking_level "${input.fallbackThinkingLevel}" is not supported by model "${input.fallbackModel}"` }, 400);
  }
  return null;
}

export function skillWorkspaceId(skill: MultiremiSkill): string {
  return skill.workspaceId ?? "local";
}

export function withSkillCreateRequestContext(
  c: Context,
  store: MultiremiStore,
  input: CreateSkillInput,
): CreateSkillInput | Response {
  const workspaceId = requestedSkillWorkspaceId(c, store, input);
  if (workspaceId instanceof Response) return workspaceId;
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
  const workspaceId = requestedSkillWorkspaceId(c, store, input);
  if (workspaceId instanceof Response) return workspaceId;
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
  // A skill ID determines its workspace. Preserve an explicit query constraint,
  // but do not let a login token or the currently viewed workspace hide it.
  const explicitWorkspaceId = cleanString(c.req.query("workspaceId")) ?? cleanString(c.req.query("workspace_id"));
  if (explicitWorkspaceId && explicitWorkspaceId !== workspaceId) return c.json({ error: "skill not found" }, 404);
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
  const issuePolicy = agentIssueProposalPolicyInput(c, store, input, true);
  if (issuePolicy instanceof Response) return issuePolicy;
  const workspaceId = requestedAgentWorkspaceId(c, store, input);
  if (workspaceId instanceof Response) return workspaceId;
  const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
  if (denied) return denied;
  const role = agentRoleRequestInput(c, store, workspaceId, input);
  if (role instanceof Response) return role;
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
  const model = agentRequestModel(input);
  const fallbackModel = agentRequestFallbackModel(input);
  const runtimeId = cleanString(input.runtimeId ?? input.runtime_id);
  const executionGroupId = cleanString(input.executionGroupId ?? input.execution_group_id);
  // A new Agent has no stored selection to carry over, so an effort named here is
  // a deliberate request: validation judges it, and rejects what it cannot confirm.
  const thinkingLevel = agentRequestThinkingLevel(input);
  const fallbackThinkingLevel = fallbackModel ? agentRequestFallbackThinkingLevel(input) : "";
  const invalidSelection = validateAgentModelSelection(c, store, {
    workspaceId,
    provider,
    model,
    thinkingLevel,
    runtimeId,
    executionGroupId,
  });
  if (invalidSelection) return invalidSelection;
  const ownerId = currentRequestUserId(c);
  const invalidFallback = validateAgentFallbackSelection(c, store, {
    workspaceId, provider, model, fallbackModel, fallbackThinkingLevel,
    runtimeId, executionGroupId, ownerId,
  });
  if (invalidFallback) return invalidFallback;
  return {
    ...input,
    name,
    description,
    provider,
    workspaceId,
    workspace_id: workspaceId,
    ownerId,
    owner_id: ownerId,
    runtimeId: runtimeId ?? null,
    runtime_id: runtimeId ?? null,
    executionGroupId: executionGroupId ?? null,
    execution_group_id: executionGroupId ?? null,
    model: model || null,
    fallbackModel: fallbackModel || null,
    fallback_model: fallbackModel || null,
    thinkingLevel: thinkingLevel || null,
    thinking_level: thinkingLevel || null,
    fallbackThinkingLevel: fallbackThinkingLevel || null,
    fallback_thinking_level: fallbackThinkingLevel || null,
    maxConcurrentTasks,
    max_concurrent_tasks: maxConcurrentTasks,
    ...role,
    ...issuePolicy,
  };
}

export function withAgentUpdateRequestContext(
  c: Context,
  store: MultiremiStore,
  current: MultiremiAgent,
  input: UpdateAgentInput,
): UpdateAgentInput | Response {
  const issuePolicy = agentIssueProposalPolicyInput(c, store, input, false);
  if (issuePolicy instanceof Response) return issuePolicy;
  const next: UpdateAgentInput = { ...input };
  Object.assign(next, issuePolicy);
  if (hasRequestField(input, "custom_env", "customEnv", "env")) {
    return c.json({
      error: "custom_env is no longer accepted on this endpoint; use PUT /api/agents/{id}/env (or `multiremi agent env set`)",
    }, 400);
  }
  const targetWorkspaceId = hasRequestField(input, "workspaceId", "workspace_id")
    ? cleanString(input.workspaceId ?? input.workspace_id) ?? "local"
    : current.workspaceId;
  const role = agentRoleRequestInput(c, store, current.workspaceId, input);
  if (role instanceof Response) return role;
  Object.assign(next, role);
  if (targetWorkspaceId !== current.workspaceId) {
    const denied = denyCurrentUserWorkspaceAccess(c, store, targetWorkspaceId);
    if (denied) return denied;
    if (store.listAgentPluginBindings(current.id).length > 0) {
      return c.json({
        error: "remove all plugin bindings before moving this agent to another workspace",
        code: "agent_plugin_workspace_move_blocked",
      }, 409);
    }
    next.workspaceId = targetWorkspaceId;
    next.workspace_id = targetWorkspaceId;
  }
  if (hasRequestField(input, "name")) {
    const name = cleanString(typeof input.name === "string" ? input.name : null);
    if (!name) return c.json({ error: "name is required" }, 400);
    const conflict = store.getAgentByWorkspaceAndName(targetWorkspaceId, name);
    if (conflict && conflict.id !== current.id) return agentNameConflict(c, name);
    next.name = name;
  } else if (targetWorkspaceId !== current.workspaceId) {
    const conflict = store.getAgentByWorkspaceAndName(targetWorkspaceId, current.name);
    if (conflict && conflict.id !== current.id) return agentNameConflict(c, current.name);
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
  const runtimeProvided = hasRequestField(input, "runtimeId", "runtime_id");
  const groupProvided = hasRequestField(input, "executionGroupId", "execution_group_id");
  const requestedRuntimeId = cleanString(input.runtimeId ?? input.runtime_id) ?? null;
  const requestedGroupId = cleanString(input.executionGroupId ?? input.execution_group_id) ?? null;
  if (runtimeProvided && groupProvided && requestedRuntimeId && requestedGroupId) return c.json({ error: "select either runtime_id or execution_group_id" }, 400);
  const targetRuntimeId = runtimeProvided ? requestedRuntimeId : groupProvided ? null : current.runtimeId ?? null;
  const targetGroupId = groupProvided ? requestedGroupId : runtimeProvided ? null : current.executionGroupId ?? null;
  const runtimeChanged = targetRuntimeId !== (current.runtimeId ?? null);
  const groupChanged = !targetRuntimeId && targetGroupId !== (current.executionGroupId ?? null);
  const targetOwnerId = hasRequestField(input, "ownerId", "owner_id")
    ? cleanString(input.ownerId ?? input.owner_id) ?? "local"
    : current.ownerId ?? "local";
  if ((targetRuntimeId || targetGroupId) && (runtimeProvided || groupProvided || providerChanged || targetOwnerId !== (current.ownerId ?? "local") || targetWorkspaceId !== current.workspaceId)) {
    const provider = resolveAgentRequestProvider(c, store, targetWorkspaceId, {
      runtime_id: targetRuntimeId,
      execution_group_id: targetRuntimeId ? null : targetGroupId,
      provider: hasRequestField(input, "provider") ? input.provider
        : targetRuntimeId && store.getRuntime(targetRuntimeId)?.provider === "any" ? current.provider : undefined,
    }, targetOwnerId);
    if (provider instanceof Response) return provider;
    applyProvider(provider);
  }
  if (runtimeProvided || groupProvided) {
    next.runtimeId = targetRuntimeId;
    next.runtime_id = targetRuntimeId;
    if (groupProvided && !targetRuntimeId) {
      next.executionGroupId = targetGroupId;
      next.execution_group_id = targetGroupId;
    } else {
      delete next.executionGroupId;
      delete next.execution_group_id;
    }
  }
  if (providerChanged) {
    const incompatible = store.listAgentPluginBindings(current.id).find((binding) =>
      binding.enabled && binding.plugin.provider !== targetProvider
    );
    if (incompatible) {
      return c.json({
        error: `unbind ${incompatible.plugin.provider} plugin "${incompatible.plugin.name}" before switching agent provider to ${targetProvider}`,
        code: "provider_mismatch",
      }, 409);
    }
  }
  // Changing execution targets must not carry a model or effort from another machine.
  const targetChanged = providerChanged || runtimeChanged || groupChanged || targetWorkspaceId !== current.workspaceId;
  const modelProvided = hasRequestField(input, "model");
  const thinkingLevelProvided = hasRequestField(input, "thinkingLevel", "thinking_level");
  const fallbackModelProvided = hasRequestField(input, "fallbackModel", "fallback_model");
  const fallbackThinkingLevelProvided = hasRequestField(input, "fallbackThinkingLevel", "fallback_thinking_level");
  const targetModel = modelProvided
    ? agentRequestModel(input)
    : targetChanged ? "" : cleanString(current.model) ?? "";
  const targetThinkingLevel = thinkingLevelProvided
    ? agentRequestThinkingLevel(input)
    : targetChanged ? "" : cleanString(current.thinkingLevel) ?? "";
  const targetFallbackModel = fallbackModelProvided
    ? agentRequestFallbackModel(input)
    : targetChanged ? "" : cleanString(current.fallbackModel) ?? "";
  const targetFallbackThinkingLevel = !targetFallbackModel ? "" : fallbackThinkingLevelProvided
    ? agentRequestFallbackThinkingLevel(input)
    : targetChanged ? "" : cleanString(current.fallbackThinkingLevel) ?? "";
  const currentModel = cleanString(current.model) ?? "";
  const currentThinkingLevel = cleanString(current.thinkingLevel) ?? "";
  const selectionChanged = runtimeChanged || groupChanged || targetOwnerId !== (current.ownerId ?? "local") || targetWorkspaceId !== current.workspaceId ||
    targetProvider !== current.provider ||
    targetModel !== currentModel ||
    targetThinkingLevel !== currentThinkingLevel;
  // MUL-338: a model that declares no reasoning levels must not keep one stored.
  // This runs on EVERY update, including one that changed nothing else, because
  // the unusable level is usually already saved and no later edit ever revisited it.
  // A level the caller actively named while changing the selection is the one case
  // that stays a request rather than a leftover; everything else — no level sent,
  // or the saved selection echoed back verbatim — is the stored value surviving.
  const carriedOver = !thinkingLevelProvided || !selectionChanged;
  const effectiveThinkingLevel = convergeAgentThinkingLevel(c, store, {
    workspaceId: targetWorkspaceId, provider: targetProvider, model: targetModel,
    thinkingLevel: targetThinkingLevel, runtimeId: targetRuntimeId,
    executionGroupId: targetGroupId, ownerId: targetOwnerId,
    carriedOver, selectionChanged,
  });
  const effectiveFallbackThinkingLevel = !targetFallbackModel ? "" : convergeAgentThinkingLevel(c, store, {
    workspaceId: targetWorkspaceId, provider: targetProvider, model: targetFallbackModel,
    thinkingLevel: targetFallbackThinkingLevel, runtimeId: targetRuntimeId,
    executionGroupId: targetGroupId, ownerId: targetOwnerId,
    carriedOver: !fallbackThinkingLevelProvided || !selectionChanged,
    selectionChanged,
  });
  if (modelProvided) {
    next.model = targetModel;
  } else if (targetChanged) {
    next.model = "";
  }
  if (thinkingLevelProvided || targetChanged || effectiveThinkingLevel !== targetThinkingLevel) {
    next.thinkingLevel = effectiveThinkingLevel;
    next.thinking_level = effectiveThinkingLevel;
  }
  if (fallbackModelProvided || targetChanged) {
    next.fallbackModel = targetFallbackModel || null;
    next.fallback_model = targetFallbackModel || null;
  }
  if (fallbackThinkingLevelProvided || fallbackModelProvided && !targetFallbackModel || targetChanged
    || effectiveFallbackThinkingLevel !== targetFallbackThinkingLevel) {
    next.fallbackThinkingLevel = effectiveFallbackThinkingLevel || null;
    next.fallback_thinking_level = effectiveFallbackThinkingLevel || null;
  }
  if (selectionChanged || modelProvided) {
    const invalidSelection = validateAgentModelSelection(c, store, {
      workspaceId: targetWorkspaceId,
      provider: targetProvider,
      model: targetModel,
      // Metadata edits may resend an unchanged selection while discovery is unavailable.
      // Still enforce a fixed connection model, but revalidate effort only when it changes.
      thinkingLevel: selectionChanged ? effectiveThinkingLevel : "",
      runtimeId: targetRuntimeId,
      executionGroupId: targetGroupId,
      ownerId: targetOwnerId,
      preserveSavedSelection: !selectionChanged,
    });
    if (invalidSelection) return invalidSelection;
  }
  const fallbackSelectionChanged = selectionChanged ||
    targetFallbackModel !== (cleanString(current.fallbackModel) ?? "") ||
    targetFallbackThinkingLevel !== (cleanString(current.fallbackThinkingLevel) ?? "");
  if (fallbackSelectionChanged) {
    const invalidFallback = validateAgentFallbackSelection(c, store, {
      workspaceId: targetWorkspaceId, provider: targetProvider, model: targetModel,
      fallbackModel: targetFallbackModel, fallbackThinkingLevel: effectiveFallbackThinkingLevel,
      runtimeId: targetRuntimeId, executionGroupId: targetGroupId, ownerId: targetOwnerId,
    });
    if (invalidFallback) return invalidFallback;
  }
  if (hasRequestField(input, "maxConcurrentTasks", "max_concurrent_tasks")) {
    const maxConcurrentTasks = normalizeAgentRequestMaxConcurrentTasks(c, input.maxConcurrentTasks ?? input.max_concurrent_tasks);
    if (maxConcurrentTasks instanceof Response) return maxConcurrentTasks;
    next.maxConcurrentTasks = maxConcurrentTasks;
    next.max_concurrent_tasks = maxConcurrentTasks;
  }
  return next;
}

function agentIssueProposalPolicyInput(
  c: Context,
  store: MultiremiStore,
  input: CreateAgentInput | CreateAgentFromTemplateInput | UpdateAgentInput,
  inheritOnCreate: boolean,
): Pick<CreateAgentInput, "issueCreationRequiresProposal" | "issue_creation_requires_proposal"> | Response {
  const hasExplicitPolicy = hasRequestField(input, "issueCreationRequiresProposal", "issue_creation_requires_proposal");
  if (hasExplicitPolicy && currentAccessToken(c)?.type === "task") {
    return c.json({
      error: "only a human can change an agent's Issue proposal policy",
      code: "human_agent_policy_required",
    }, 403);
  }
  if (!hasExplicitPolicy) {
    if (!inheritOnCreate || !currentTaskIssueCreationRestricted(c, store)) return {};
    return {
      issueCreationRequiresProposal: true,
      issue_creation_requires_proposal: true,
    };
  }
  const value = input.issueCreationRequiresProposal ?? input.issue_creation_requires_proposal;
  if (typeof value !== "boolean") {
    return c.json({ error: "issue_creation_requires_proposal must be a boolean" }, 400);
  }
  return {
    issueCreationRequiresProposal: value,
    issue_creation_requires_proposal: value,
  };
}

export function withAgentTemplateRequestContext(
  c: Context,
  store: MultiremiStore,
  input: CreateAgentFromTemplateInput,
): CreateAgentFromTemplateInput | Response {
  const issuePolicy = agentIssueProposalPolicyInput(c, store, input, true);
  if (issuePolicy instanceof Response) return issuePolicy;
  const workspaceId = requestedAgentWorkspaceId(c, store, input);
  if (workspaceId instanceof Response) return workspaceId;
  const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
  if (denied) return denied;
  const role = agentRoleRequestInput(c, store, workspaceId, input);
  if (role instanceof Response) return role;
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
  const model = agentRequestModel(input);
  const fallbackModel = agentRequestFallbackModel(input);
  const fallbackThinkingLevel = fallbackModel ? agentRequestFallbackThinkingLevel(input) : "";
  const effectiveModel = model || ((input.runtimeId ?? input.runtime_id ?? input.executionGroupId ?? input.execution_group_id)
    ? "" : cleanString(template.recommendedModel) ?? "");
  const runtimeId = cleanString(input.runtimeId ?? input.runtime_id);
  const executionGroupId = cleanString(input.executionGroupId ?? input.execution_group_id);
  // Like the create path: nothing stored to carry over, so the request is judged
  // as what it is — a fresh selection.
  const requestedThinkingLevel = agentRequestThinkingLevel(input);
  const thinkingLevel = requestedThinkingLevel;
  const effectiveFallbackThinkingLevel = !fallbackModel ? "" : fallbackThinkingLevel;
  const invalidSelection = validateAgentModelSelection(c, store, {
    workspaceId, provider, model, thinkingLevel,
    runtimeId, executionGroupId,
  });
  if (invalidSelection) return invalidSelection;
  const invalidFallback = validateAgentFallbackSelection(c, store, {
    workspaceId, provider, model: effectiveModel, fallbackModel,
    fallbackThinkingLevel: effectiveFallbackThinkingLevel,
    runtimeId, executionGroupId,
  });
  if (invalidFallback) return invalidFallback;
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
    runtimeId: runtimeId ?? null,
    runtime_id: runtimeId ?? null,
    executionGroupId: executionGroupId ?? null,
    execution_group_id: executionGroupId ?? null,
    model: model || null,
    fallbackModel: fallbackModel || null,
    fallback_model: fallbackModel || null,
    // Only override the passthrough when convergence actually dropped a level.
    ...(thinkingLevel === requestedThinkingLevel ? {} : { thinkingLevel: thinkingLevel || null, thinking_level: thinkingLevel || null }),
    fallbackThinkingLevel: effectiveFallbackThinkingLevel || null,
    fallback_thinking_level: effectiveFallbackThinkingLevel || null,
    maxConcurrentTasks,
    max_concurrent_tasks: maxConcurrentTasks,
    ...role,
    ...issuePolicy,
  };
}

function agentRoleRequestInput(
  c: Context,
  store: MultiremiStore,
  workspaceId: string,
  input: Pick<CreateAgentInput, "role">,
): Pick<CreateAgentInput, "role"> | Response {
  if (!hasRequestField(input, "role")) return {};
  const denied = requireHumanWorkspaceAdmin(c, store, workspaceId);
  if (denied) return denied;
  if (!isAgentRole(input.role)) {
    return c.json({ error: "role must be normal, maintainer, or supervisor" }, 400);
  }
  return { role: input.role };
}

/** Validate the selected execution target and resolve its engine. */
export function resolveAgentRequestProvider(
  c: Context,
  store: MultiremiStore,
  workspaceId: string,
  input: { runtimeId?: string | null; runtime_id?: string | null; executionGroupId?: string | null; execution_group_id?: string | null; provider?: unknown },
  agentOwnerId = currentRequestUserId(c),
): string | Response {
  const runtimeId = cleanString(input.runtimeId ?? input.runtime_id);
  const groupId = cleanString(input.executionGroupId ?? input.execution_group_id);
  if (runtimeId && groupId) return c.json({ error: "select either runtime_id or execution_group_id" }, 400);
  if (groupId) {
    const group = store.getExecutionGroup(groupId, workspaceId);
    if (!group) return c.json({ error: "invalid execution_group_id" }, 400);
    const requestedProvider = cleanString(typeof input.provider === "string" ? input.provider : null);
    if (requestedProvider && requestedProvider !== group.provider) return c.json({ error: "provider does not match the selected execution group" }, 400);
    if (!executionGroupRuntimes(store, workspaceId, groupId, agentOwnerId).length) {
      return c.json({ error: "no execution group member can run this owner's agents" }, 403);
    }
    return group.provider;
  }
  if (runtimeId) {
    const runtime = store.getRuntime(runtimeId);
    if (!runtime || (runtime.workspaceId ?? "local") !== workspaceId) {
      return c.json({ error: "invalid runtime_id" }, 400);
    }
    if (!canCurrentUserUseRuntime(c, store, runtime)) {
      return c.json({ error: "this runtime is private; only its owner or a workspace admin can create agents on it" }, 403);
    }
    if (runtime.visibility !== "public" && (runtime.ownerId ?? "local") !== agentOwnerId) {
      return c.json({ error: "a private runtime can only execute agents owned by its owner" }, 403);
    }
    const requestedProvider = cleanString(typeof input.provider === "string" ? input.provider : null);
    if (runtime.provider !== "any" && requestedProvider && requestedProvider !== runtime.provider) {
      return c.json({ error: "provider does not match the selected runtime" }, 400);
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

export function agentRequestModel(
  input: Pick<CreateAgentInput, "model"> | Pick<UpdateAgentInput, "model"> | Pick<CreateAgentFromTemplateInput, "model">,
): string {
  return cleanString(input.model) ?? "";
}

function agentRequestFallbackModel(input: Pick<CreateAgentInput, "fallbackModel" | "fallback_model">): string {
  return cleanString(input.fallbackModel ?? input.fallback_model) ?? "";
}

function agentRequestFallbackThinkingLevel(input: Pick<CreateAgentInput, "fallbackThinkingLevel" | "fallback_thinking_level">): string {
  return cleanString(input.fallbackThinkingLevel ?? input.fallback_thinking_level) ?? "";
}

export function agentRequestThinkingLevel(input: Pick<CreateAgentInput, "thinkingLevel" | "thinking_level">): string {
  return cleanString(input.thinkingLevel ?? input.thinking_level) ?? "";
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
