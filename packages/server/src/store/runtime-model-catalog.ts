import type { MultiremiRuntime, MultiremiRuntimeModel } from "@multiremi/contracts/types.js";
import { runtimeConnectionModels } from "@multiremi/contracts/runtime-connection";
import type { MultiremiStore } from "./store.js";

/** Minimal data source shared by API catalogs and dispatch capability checks. */
export type RuntimeModelCatalogSource = Pick<MultiremiStore,
  "getRelayModelDiscovery" | "getRelayConfigForDaemon" | "getGatewayModels" |
  "listWorkspaceCodexProfileModels" | "listWorkspaceClaudeProfileModels" | "getRuntimeExecutionProfile">;

export const MULTIREMI_DAEMON_PROVIDERS = new Set(["claude", "codex"]);

/**
 * Union of the online runtimes' model catalogs, grouped by provider — the
 * workspace catalog for unbound agents and CLI discovery. A bucket exists for
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

export interface FleetModelThinkingLevelResponse {
  value: string;
  label: string;
  description?: string;
}

export interface FleetModelThinkingResponse {
  supported_levels: FleetModelThinkingLevelResponse[];
  default_level?: string;
}

export interface FleetModelResponse {
  id: string;
  label: string;
  provider?: string;
  default?: boolean;
  thinking?: FleetModelThinkingResponse;
}

export interface FleetProviderModelsResponse {
  provider: string;
  online_runtime_count: number;
  models: FleetModelResponse[];
}

export function fleetModelsResponse(runtimes: MultiremiRuntime[], callerOwnerId: string): FleetProviderModelsResponse[] {
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

export function runtimeModelCompatibilityResponse(model: MultiremiRuntimeModel): FleetModelResponse {
  const response: FleetModelResponse = {
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

type ClaudeModelFamily = "opus" | "sonnet" | "haiku";

function claudeModelFamily(modelId: string): ClaudeModelFamily | undefined {
  const normalized = modelId.toLowerCase().replace(/\[1m\]$/, "");
  return normalized.match(
    /^(?:claude-)?(opus|sonnet|haiku)(?:-\d+(?:-\d+)*)?$/,
  )?.[1] as ClaudeModelFamily | undefined;
}

function thinkingLevelsKey(thinking: FleetModelThinkingResponse): string {
  return JSON.stringify([...thinking.supported_levels].sort((a, b) =>
    a.value.localeCompare(b.value)
      || a.label.localeCompare(b.label)
      || (a.description ?? "").localeCompare(b.description ?? "")
  ));
}

function familyThinkingConsensus(models: FleetModelResponse[]): FleetModelThinkingResponse | undefined {
  const first = models[0]?.thinking;
  const firstKey = first
    ? `${thinkingLevelsKey(first)}\0${first.default_level ?? ""}`
    : undefined;
  if (!models.every((model) => {
    if (!model.thinking) return firstKey === undefined;
    return `${thinkingLevelsKey(model.thinking)}\0${model.thinking.default_level ?? ""}` === firstKey;
  })) return undefined;
  return first;
}

/**
 * Last-resort tier for gateway models with no exact and no family counterpart
 * (e.g. `claude-fable-5`, which has no runtime id at all): if every effort-capable
 * runtime model of this provider agrees on one level set, assume a new model of the
 * same provider shares it. This is a heuristic, so it fails closed on any
 * disagreement — Codex, whose runtimes expose 4- and 6-level sets, never reaches a
 * consensus here. It never propagates `default`; only an exact or unambiguous family
 * hit may do that. Revisit if a future Claude model ships an effort set that diverges
 * from its siblings — it would be given the consensus set rather than its own.
 */
function providerThinkingConsensus(models: FleetModelResponse[]): FleetModelThinkingResponse | undefined {
  const capable = models.flatMap((model) =>
    model.thinking?.supported_levels.length ? [model.thinking] : []
  );
  const first = capable[0];
  if (!first) return undefined;
  const levelsKey = thinkingLevelsKey(first);
  if (!capable.every((thinking) => thinkingLevelsKey(thinking) === levelsKey)) return undefined;
  const defaultLevel = capable.every((thinking) => thinking.default_level === first.default_level)
    ? first.default_level
    : undefined;
  return {
    supported_levels: first.supported_levels,
    ...(defaultLevel ? { default_level: defaultLevel } : {}),
  };
}

/**
 * Prefer server-discovered gateway models per engine when a snapshot exists (so the
 * dropdown reflects the real gateway even with zero online runtimes); otherwise keep
 * the per-runtime union. online_runtime_count still comes from the runtime buckets.
 */
export function overlayGatewayModels(
  store: RuntimeModelCatalogSource,
  workspaceId: string,
  providers: FleetProviderModelsResponse[],
): FleetProviderModelsResponse[] {
  // Discovery off → never surface a (possibly stale) gateway snapshot; fall back
  // to the per-runtime union so turning the toggle off actually hides the models.
  if (!store.getRelayModelDiscovery(workspaceId)) return providers;
  const config = store.getRelayConfigForDaemon(workspaceId);
  const byEngine = new Map<string, FleetProviderModelsResponse>();
  for (const provider of providers) byEngine.set(provider.provider, provider);
  for (const engine of ["claude", "codex"] as const) {
    const engineConfig = config[engine];
    // No live gateway credential → don't surface any (possibly stale) snapshot.
    if (!engineConfig || !engineConfig.authToken) continue;
    const snapshot = store.getGatewayModels(workspaceId, engine);
    if (!snapshot || snapshot.models.length === 0) continue;
    // Only show a snapshot discovered for the CURRENT config revision — a changed
    // gateway/token invalidates the old catalog until rediscovery catches up.
    if (snapshot.sourceRevision !== engineConfig.revision) continue;
    const existing = byEngine.get(engine);
    const existingModels = existing?.models ?? [];
    const runtimeModels = new Map(existingModels.map((model) => [model.id, model]));
    const familyModels = new Map<ClaudeModelFamily, FleetModelResponse[]>();
    const gatewayFamilyCounts = new Map<ClaudeModelFamily, number>();
    if (engine === "claude") {
      for (const model of existingModels) {
        const family = claudeModelFamily(model.id);
        if (family) familyModels.set(family, [...(familyModels.get(family) ?? []), model]);
      }
      for (const model of snapshot.models) {
        const family = claudeModelFamily(model.id);
        if (family) gatewayFamilyCounts.set(family, (gatewayFamilyCounts.get(family) ?? 0) + 1);
      }
    }
    const providerThinking = providerThinkingConsensus(existingModels);
    const models = snapshot.models.map((model): FleetModelResponse => {
      const runtimeModel = runtimeModels.get(model.id);
      const family = engine === "claude" ? claudeModelFamily(model.id) : undefined;
      const matchingFamilyModels = family ? familyModels.get(family) ?? [] : [];
      const familyMatched = matchingFamilyModels.length > 0;
      // A match with no thinking metadata is a negative result and must not
      // continue to the broader provider fallback (notably for Claude Haiku).
      const thinking = runtimeModel
        ? runtimeModel.thinking
        : familyMatched
        ? familyThinkingConsensus(matchingFamilyModels)
        : providerThinking;
      const isDefault = runtimeModel
        ? runtimeModel.default === true
        : family !== undefined
          && familyMatched
          && gatewayFamilyCounts.get(family) === 1
          && matchingFamilyModels.filter((candidate) => candidate.default).length === 1;
      return {
        id: model.id,
        label: model.label,
        provider: engine,
        ...(isDefault ? { default: true } : {}),
        ...(thinking ? { thinking } : {}),
      };
    });
    if (engine === "codex" || engine === "claude") {
      const customIds = new Set(engine === "codex" ? store.listWorkspaceCodexProfileModels(workspaceId) : store.listWorkspaceClaudeProfileModels(workspaceId));
      for (const model of existingModels) {
        if (customIds.has(model.id) && !models.some(candidate => candidate.id === model.id)) models.push(model);
      }
    }
    byEngine.set(engine, {
      provider: engine,
      online_runtime_count: existing?.online_runtime_count ?? 0,
      models,
    });
  }
  return [...byEngine.values()].sort((a, b) => a.provider.localeCompare(b.provider));
}

/** The selected machine/type is one execution target; its catalog never includes peers. */
export function runtimeTargetModelCatalog(
  store: RuntimeModelCatalogSource,
  workspaceId: string,
  runtime: MultiremiRuntime,
): FleetProviderModelsResponse[] {
  // Keep the last reported catalog while offline so saved configurations remain editable.
  const providers = fleetModelsResponse([{ ...runtime, status: "online", visibility: "public" }], runtime.ownerId ?? "local");
  return providers.map((entry) => {
    const profile = store.getRuntimeExecutionProfile(runtime.id, entry.provider);
    const models = profile
      ? runtimeConnectionModels(profile, entry.provider, entry.models)
      : overlayGatewayModels(store, workspaceId, [entry]).find((candidate) => candidate.provider === entry.provider)?.models ?? [];
    return { ...entry, online_runtime_count: runtime.status === "online" ? 1 : 0, models };
  });
}
