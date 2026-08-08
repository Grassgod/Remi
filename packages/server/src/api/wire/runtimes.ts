// Wire serializers for the runtimes domain, moved verbatim out of api.ts.
// Go-compat (`*Compatibility*`) and native shapers sit side by side on purpose:
// the two route prefixes are intentionally divergent and must stay diffable.
import type {
  MultiremiAgent,
  MultiremiRuntime,
  MultiremiRuntimeDirectoryCandidate,
  MultiremiRuntimeDirectoryScanRequest,
  MultiremiRuntimeLocalSkillImportRequest,
  MultiremiRuntimeLocalSkillListRequest,
  MultiremiRuntimeLocalSkillSummary,
  MultiremiRuntimeModel,
  MultiremiRuntimeModelListRequest,
  MultiremiRuntimeUpdateRequest,
} from "@multiremi/contracts/types.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import type { Context } from "hono";
import { skillWithFilesCompatibilityResponse } from "./skills.js";

export const MULTIREMI_DAEMON_PROVIDERS = new Set(["claude", "codex"]);

export function runtimeWorkspaceId(runtime: MultiremiRuntime): string {
  return runtime.workspaceId ?? "local";
}

export function runtimeHasActiveAgentsResponse(
  agents: MultiremiAgent[],
  code = "runtime_has_active_agents",
  error = "cannot delete runtime: it has active agents bound to it. Archive or reassign the agents first.",
): { error: string; code: string; active_agents: MultiremiAgent[] } {
  return { error, code, active_agents: agents };
}

export function runtimeCompatibilityResponse(runtime: MultiremiRuntime): Record<string, unknown> {
  return {
    id: runtime.id,
    workspace_id: runtimeWorkspaceId(runtime),
    daemon_id: runtime.daemonId,
    name: runtime.name,
    runtime_mode: runtime.runtimeMode,
    provider: runtime.provider,
    launch_header: runtimeLaunchHeader(runtime.provider),
    status: runtime.status,
    device_info: runtime.deviceInfo,
    metadata: runtime.metadata,
    owner_id: runtime.ownerId,
    visibility: runtime.visibility,
    last_seen_at: runtime.lastHeartbeatAt,
    created_at: runtime.createdAt,
    updated_at: runtime.updatedAt,
  };
}

/**
 * Union of the online runtimes' model catalogs, grouped by provider — the
 * fleet-level catalog behind machine-less agent creation. A bucket exists for
 * every provider that has a runtime at all (even offline, count 0) so the UI
 * can still offer the engine with a capacity hint.
 *
 * Only runtimes the caller's agents could actually be claimed by are counted:
 * a private runtime an agent's task can never reach (different owner) must not
 * inflate the engine's online capacity. `callerOwnerId` is the acting user —
 * the owner their newly created agents will carry.
 */
// Maps a model's vendor (as the daemon reports it) to the engine that runs it,
// for the rare "any" runtime that carries a model catalog but no fixed engine.
const MODEL_VENDOR_TO_ENGINE: Record<string, string> = { openai: "codex", anthropic: "claude" };

export function fleetModelsResponse(runtimes: MultiremiRuntime[], callerOwnerId: string): Array<Record<string, unknown>> {
  const usable = runtimes.filter(
    (r) => r.visibility === "public" || (r.ownerId ?? "local") === (callerOwnerId ?? "local"),
  );
  const buckets = new Map<string, { online: number; models: Map<string, MultiremiRuntimeModel> }>();
  const bucket = (provider: string) => {
    let entry = buckets.get(provider);
    if (!entry) {
      entry = { online: 0, models: new Map() };
      buckets.set(provider, entry);
    }
    return entry;
  };
  for (const runtime of usable) {
    if (runtime.provider && runtime.provider !== "any") bucket(runtime.provider);
    // An "any" runtime can execute every known engine — surface those engines
    // (with its capacity counted below) even when no dedicated runtime exists.
    if (runtime.provider === "any") for (const provider of MULTIREMI_DAEMON_PROVIDERS) bucket(provider);
    if (runtime.status !== "online") continue;
    for (const model of runtime.models ?? []) {
      // Bucket by the runtime's ENGINE, not model.provider. The daemon reports
      // model.provider as the model vendor ("openai" / "anthropic"), but the
      // UI (and scheduling) key on the engine that runs it ("codex" / "claude").
      // An "any" runtime has no single engine, so map the vendor to its engine;
      // a vendor we don't recognise is skipped rather than minting a phantom
      // bucket the UI never queries.
      const engine = runtime.provider !== "any" ? runtime.provider : MODEL_VENDOR_TO_ENGINE[model.provider ?? ""];
      if (!engine) continue;
      const entry = bucket(engine);
      const existing = entry.models.get(model.id);
      if (!existing || (model.default && !existing.default)) entry.models.set(model.id, model);
    }
  }
  for (const runtime of usable) {
    if (runtime.status !== "online") continue;
    for (const [provider, entry] of buckets) {
      if (runtime.provider === provider || runtime.provider === "any") entry.online += 1;
    }
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, entry]) => ({
      provider,
      online_runtime_count: entry.online,
      models: [...entry.models.values()].map(runtimeModelCompatibilityResponse),
    }));
}

export function runtimeModelCompatibilityResponse(model: MultiremiRuntimeModel): Record<string, unknown> {
  const response: Record<string, unknown> = {
    id: model.id,
    label: model.label,
  };
  if (model.provider) response.provider = model.provider;
  if (model.default) response.default = true;
  if (model.thinking) {
    response.thinking = {
      supported_levels: (model.thinking.supportedLevels ?? model.thinking.supported_levels ?? []).map((level) => ({
        value: level.value,
        label: level.label,
        ...(level.description ? { description: level.description } : {}),
      })),
      ...(model.thinking.defaultLevel ?? model.thinking.default_level
        ? { default_level: model.thinking.defaultLevel ?? model.thinking.default_level }
        : {}),
    };
  }
  return response;
}

export function runtimeModelListRequestCompatibilityResponse(request: MultiremiRuntimeModelListRequest): Record<string, unknown> {
  const response: Record<string, unknown> = {
    id: request.id,
    runtime_id: request.runtimeId,
    status: request.status,
    supported: request.supported,
    created_at: request.createdAt,
    updated_at: request.updatedAt,
  };
  if (request.models.length) response.models = request.models.map(runtimeModelCompatibilityResponse);
  if (request.error) response.error = request.error;
  return response;
}

export function runtimeUpdateRequestCompatibilityResponse(request: MultiremiRuntimeUpdateRequest): Record<string, unknown> {
  const response: Record<string, unknown> = {
    id: request.id,
    runtime_id: request.runtimeId,
    status: request.status,
    scope: request.scope,
    target_version: request.targetVersion,
    created_at: request.createdAt,
    updated_at: request.updatedAt,
  };
  if (request.output) response.output = request.output;
  if (request.error) response.error = request.error;
  return response;
}

function runtimeLocalSkillSummaryCompatibilityResponse(skill: MultiremiRuntimeLocalSkillSummary): Record<string, unknown> {
  const response: Record<string, unknown> = {
    key: skill.key,
    name: skill.name,
    source_path: skill.sourcePath,
    provider: skill.provider,
    file_count: skill.fileCount,
  };
  if (skill.description) response.description = skill.description;
  return response;
}

export function runtimeLocalSkillListRequestCompatibilityResponse(request: MultiremiRuntimeLocalSkillListRequest): Record<string, unknown> {
  const response: Record<string, unknown> = {
    id: request.id,
    runtime_id: request.runtimeId,
    status: request.status,
    supported: request.supported,
    created_at: request.createdAt,
    updated_at: request.updatedAt,
  };
  if (request.skills.length) response.skills = request.skills.map(runtimeLocalSkillSummaryCompatibilityResponse);
  if (request.error) response.error = request.error;
  return response;
}

export function directoryScanErrorResponse(c: Context, err: unknown): Response | null {
  if (!(err instanceof Error)) return null;
  if (err.message === 'directory scan mode must be "scan" or "browse"') return c.json({ error: err.message }, 400);
  return null;
}

function runtimeDirectoryCandidateCompatibilityResponse(candidate: MultiremiRuntimeDirectoryCandidate): Record<string, unknown> {
  return {
    path: candidate.path,
    name: candidate.name,
    remote_url: candidate.remoteUrl,
    current_branch: candidate.currentBranch,
    is_dirty: candidate.isDirty,
    is_git_repo: candidate.isGitRepo ?? null,
  };
}

export function runtimeDirectoryScanRequestCompatibilityResponse(request: MultiremiRuntimeDirectoryScanRequest): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (request.params.root !== undefined) params.root = request.params.root;
  if (request.params.maxDepth !== undefined) params.max_depth = request.params.maxDepth;
  if (request.params.mode !== undefined) params.mode = request.params.mode;
  if (request.params.resolvedRoot !== undefined) params.resolved_root = request.params.resolvedRoot;
  return {
    id: request.id,
    runtime_id: request.runtimeId,
    status: request.status,
    params,
    candidates: request.candidates.map(runtimeDirectoryCandidateCompatibilityResponse),
    supported: request.supported,
    error: request.error,
    run_started_at: request.runStartedAt,
    created_at: request.createdAt,
    updated_at: request.updatedAt,
  };
}

export function runtimeLocalSkillImportRequestCompatibilityResponse(request: MultiremiRuntimeLocalSkillImportRequest): Record<string, unknown> {
  const response: Record<string, unknown> = {
    id: request.id,
    runtime_id: request.runtimeId,
    skill_key: request.skillKey,
    status: request.status,
    created_at: request.createdAt,
    updated_at: request.updatedAt,
  };
  if (request.name) response.name = request.name;
  if (request.description) response.description = request.description;
  if (request.skill) response.skill = skillWithFilesCompatibilityResponse(request.skill);
  if (request.error) response.error = request.error;
  return response;
}

export function runtimeUsageDailyCompatibilityResponse(row: {
  date: string;
  runtimeId?: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}): Record<string, unknown> {
  return {
    runtime_id: row.runtimeId ?? null,
    date: row.date,
    provider: row.provider,
    model: row.model,
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    cache_read_tokens: row.cacheReadTokens,
    cache_write_tokens: row.cacheWriteTokens,
  };
}

export function compareRuntimeUsageDailyCompatibilityRows(left: Record<string, unknown>, right: Record<string, unknown>): number {
  return String(right.date ?? "").localeCompare(String(left.date ?? "")) ||
    String(left.provider ?? "").localeCompare(String(right.provider ?? "")) ||
    String(left.model ?? "").localeCompare(String(right.model ?? ""));
}

export function runtimeUsageByAgentCompatibilityResponse(row: {
  agentId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  taskCount: number;
}): Record<string, unknown> {
  return {
    agent_id: row.agentId,
    model: row.model,
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    cache_read_tokens: row.cacheReadTokens,
    cache_write_tokens: row.cacheWriteTokens,
    task_count: row.taskCount,
  };
}

export function runtimeUsageByHourCompatibilityResponse(row: {
  hour: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  taskCount: number;
}): Record<string, unknown> {
  return {
    hour: row.hour,
    model: row.model,
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    cache_read_tokens: row.cacheReadTokens,
    cache_write_tokens: row.cacheWriteTokens,
    task_count: row.taskCount,
  };
}

export function runtimeTaskActivityCompatibilityResponse(row: { hour: number; count: number }): Record<string, unknown> {
  return {
    hour: row.hour,
    count: row.count,
  };
}

function runtimeLaunchHeader(provider: string): string {
  if (provider === "claude") return "claude (stream-json)";
  if (provider === "codex") return "codex app-server";
  return "";
}

/** Snake-case wire shape of relay config for the daemon register response. */
export function relayForDaemonWire(store: MultiremiStore, workspaceId: string): Record<string, unknown> {
  const config = store.getRelayConfigForDaemon(workspaceId);
  const engine = (e: { fragment: string; authToken: string; revision: number } | null) =>
    e ? { fragment: e.fragment, auth_token: e.authToken, revision: e.revision } : null;
  return { claude: engine(config.claude), codex: engine(config.codex), model_discovery: config.modelDiscovery };
}

function launchHeader(provider: string): string {
  if (provider === "claude") return "Claude";
  if (provider === "codex") return "Codex";
  return provider ? provider[0].toUpperCase() + provider.slice(1) : "Runtime";
}

export function daemonRuntimeResponse(
  runtime: MultiremiRuntime,
  metadata: {
    daemonId: string;
    version: string;
    cliVersion: string;
    launchedBy: string;
  },
): {
  id: string;
  workspace_id: string | null;
  daemon_id: string | null;
  name: string;
  runtime_mode: string;
  provider: string;
  launch_header: string;
  status: string;
  device_info: string;
  metadata: Record<string, unknown>;
  owner_id: string | null;
  visibility: string;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
} {
  return {
    id: runtime.id,
    workspace_id: runtime.workspaceId,
    daemon_id: runtime.daemonId ?? metadata.daemonId,
    name: runtime.name,
    runtime_mode: runtime.runtimeMode,
    provider: runtime.provider,
    launch_header: launchHeader(String(runtime.provider)),
    status: runtime.status,
    device_info: runtime.deviceInfo,
    metadata: Object.keys(runtime.metadata).length ? runtime.metadata : {
      version: metadata.version,
      cli_version: metadata.cliVersion,
      launched_by: metadata.launchedBy,
    },
    owner_id: runtime.ownerId,
    visibility: runtime.visibility,
    last_seen_at: runtime.lastHeartbeatAt,
    created_at: runtime.createdAt,
    updated_at: runtime.updatedAt,
  };
}
