import type { MultiremiRuntime, MultiremiRuntimeModel, MultiremiRuntimeModelThinking } from "@multiremi/contracts/types.js";
import { runtimeConnectionModels } from "@multiremi/contracts/runtime-connection";
import { commonThinkingLevels, modelThinkingLevels } from "@multiremi/contracts/model-thinking.js";
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
  status?: MultiremiRuntimeModelThinking["status"];
  error?: string;
}

export interface FleetModelResponse {
  id: string;
  label: string;
  provider?: string;
  default?: boolean;
  provider_default?: boolean;
  thinking?: FleetModelThinkingResponse;
}

export interface FleetProviderModelsResponse {
  provider: string;
  online_runtime_count: number;
  models: FleetModelResponse[];
  default_thinking?: FleetModelThinkingResponse;
}

/** Intersect execution targets without losing why a capability is unavailable. */
export function commonThinkingCapabilities(capabilities: FleetModelThinkingResponse[]): FleetModelThinkingResponse {
  const supported_levels = commonThinkingLevels(capabilities.map((thinking) => modelThinkingLevels([], "", thinking)));
  const failed = capabilities.find((thinking) => thinking.status === "error");
  const explicitStatus = capabilities.some((thinking) => thinking.status !== undefined);
  const status = failed ? "error" : capabilities.some((thinking) => thinking.status === "unknown")
    ? "unknown" : supported_levels.length ? "supported" : "unsupported";
  const defaultLevel = capabilities[0]?.default_level;
  return {
    supported_levels,
    ...(explicitStatus ? { status } : {}),
    ...(failed?.error ? { error: failed.error } : {}),
    ...(defaultLevel && supported_levels.some((level) => level.value === defaultLevel)
      && capabilities.every((thinking) => thinking.default_level === defaultLevel) ? { default_level: defaultLevel } : {}),
  };
}

function defaultModelThinking(models: FleetModelResponse[]): FleetModelThinkingResponse {
  const selected = models.find((model) => model.default);
  if (selected?.thinking) return selected.thinking;
  const supported_levels = modelThinkingLevels(models, "");
  if (supported_levels.length) return { supported_levels };
  const failed = models.find((model) => model.thinking?.status === "error")?.thinking;
  if (failed) return { ...failed, supported_levels: [] };
  return { supported_levels, ...(models.some((model) => model.thinking?.status !== undefined)
    ? { status: models.every((model) => model.thinking?.status === "unsupported") ? "unsupported" as const : "unknown" as const } : {}) };
}

function capabilityRank(model: MultiremiRuntimeModel): number {
  const thinking = model.thinking;
  if ((!thinking?.status || thinking.status === "supported") && (thinking?.supportedLevels ?? thinking?.supported_levels)?.length) return 3;
  if (thinking?.status === "error") return 2;
  if (thinking && thinking.status !== "unknown") return 1;
  return 0;
}

export function fleetModelsResponse(runtimes: MultiremiRuntime[], callerOwnerId: string): FleetProviderModelsResponse[] {
  const usable = runtimes.filter(
    (r) => r.visibility === "public" || (r.ownerId ?? "local") === (callerOwnerId ?? "local"),
  );
  const buckets = new Map<string, {
    online: number;
    models: Map<string, MultiremiRuntimeModel>;
    defaultCapabilities: FleetModelThinkingResponse[];
    hasDefaultReport: boolean;
  }>();
  const bucket = (provider: string) => {
    let entry = buckets.get(provider);
    if (!entry) {
      entry = { online: 0, models: new Map(), defaultCapabilities: [], hasDefaultReport: false };
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
      if (model.providerDefault) continue;
      const existing = entry.models.get(model.id);
      // A fleet is a union of usable targets. Prefer a successful report; the
      // claim path still checks the selected runtime's own capabilities.
      if (!existing || capabilityRank(model) > capabilityRank(existing)
        || (capabilityRank(model) === capabilityRank(existing) && model.default && !existing.default)) entry.models.set(model.id, model);
    }
  }
  for (const runtime of usable) {
    if (runtime.status !== "online") continue;
    for (const [provider, entry] of buckets) {
      if (runtime.provider === provider || runtime.provider === "any") {
        entry.online += 1;
        const models = (runtime.models ?? []).filter((model) => runtime.provider !== "any"
          || MODEL_VENDOR_TO_ENGINE[model.provider ?? ""] === provider);
        const reported = models.find((model) => model.providerDefault);
        entry.hasDefaultReport ||= Boolean(reported);
        entry.defaultCapabilities.push(reported
          ? reported.thinking ? thinkingCompatibilityResponse(reported.thinking) : { status: "unknown", supported_levels: [] }
          : defaultModelThinking(models.filter((model) => !model.providerDefault).map(runtimeModelCompatibilityResponse)));
      }
    }
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, entry]) => ({
      provider,
      online_runtime_count: entry.online,
      models: [...entry.models.values()].map(runtimeModelCompatibilityResponse),
      ...(entry.hasDefaultReport ? { default_thinking: commonThinkingCapabilities(entry.defaultCapabilities) } : {}),
    }));
}

export function runtimeModelCompatibilityResponse(model: MultiremiRuntimeModel): FleetModelResponse {
  const response: FleetModelResponse = {
    id: model.id,
    label: model.label,
  };
  if (model.provider) response.provider = model.provider;
  if (model.default) response.default = true;
  if (model.providerDefault) response.provider_default = true;
  if (model.thinking) {
    response.thinking = thinkingCompatibilityResponse(model.thinking);
  }
  return response;
}

function thinkingCompatibilityResponse(thinking: MultiremiRuntimeModelThinking): FleetModelThinkingResponse {
  return {
    supported_levels: (thinking.supportedLevels ?? thinking.supported_levels ?? []).map((level) => ({
      value: level.value,
      label: level.label,
      ...(level.description ? { description: level.description } : {}),
    })),
    ...(thinking.defaultLevel ?? thinking.default_level
      ? { default_level: thinking.defaultLevel ?? thinking.default_level }
      : {}),
    ...(thinking.status ? { status: thinking.status } : {}),
    ...(thinking.error ? { error: thinking.error } : {}),
  };
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
    ? `${thinkingLevelsKey(first)}\0${first.default_level ?? ""}\0${first.status ?? ""}`
    : undefined;
  if (!models.every((model) => {
    if (!model.thinking) return firstKey === undefined;
    return `${thinkingLevelsKey(model.thinking)}\0${model.thinking.default_level ?? ""}\0${model.thinking.status ?? ""}` === firstKey;
  })) return undefined;
  return first;
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
    if (!snapshot) continue;
    // Only show a snapshot discovered for the CURRENT config revision — a changed
    // gateway/token invalidates the old catalog until rediscovery catches up.
    if (snapshot.sourceRevision !== engineConfig.revision) continue;
    const existing = byEngine.get(engine);
    const existingModels = existing?.models ?? [];
    // If both the native catalog and generic inventory failed on this machine,
    // its fallback report contains only bundled IDs. The failure still applies
    // to gateway-only models absent from that fallback report.
    const runtimeCatalogError = engine === "codex" && existingModels.length > 0
      && existingModels.every((model) => model.thinking?.status === "error")
      ? existingModels[0].thinking : undefined;
    if (snapshot.models.length === 0) {
      if (engine === "codex" && snapshot.lastError && existing) {
        byEngine.set(engine, { ...existing, models: existingModels.map((model) => ({
          ...model, thinking: { status: "error", supported_levels: [], error: snapshot.lastError! },
        })), default_thinking: { status: "error", supported_levels: [], error: snapshot.lastError } });
      }
      continue;
    }
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
    const models = snapshot.models.map((model): FleetModelResponse => {
      const runtimeModel = runtimeModels.get(model.id);
      const family = engine === "claude" ? claudeModelFamily(model.id) : undefined;
      const matchingFamilyModels = family ? familyModels.get(family) ?? [] : [];
      const familyMatched = matchingFamilyModels.length > 0;
      const gatewayThinking = model.thinking ? thinkingCompatibilityResponse(model.thinking) : undefined;
      // Runtime loading failures mean the execution engine cannot honor even a
      // valid gateway declaration. Otherwise per-model gateway data is authoritative.
      const thinking = runtimeCatalogError
        ?? (runtimeModel?.thinking?.status === "error"
        ? runtimeModel.thinking
        : engine === "codex" && snapshot.lastError
        ? { status: "error" as const, supported_levels: [], error: snapshot.lastError }
        : gatewayThinking && gatewayThinking.status !== "unknown"
        ? gatewayThinking
        : runtimeModel?.thinking
          ?? (familyMatched ? familyThinkingConsensus(matchingFamilyModels) : undefined)
          ?? gatewayThinking);
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
      ...(existing?.default_thinking ? { default_thinking: engine === "codex"
        ? existing.default_thinking.status === "error" ? existing.default_thinking : defaultModelThinking(models)
        : existing.default_thinking } : {}),
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
    return { ...entry, online_runtime_count: runtime.status === "online" ? 1 : 0, models,
      ...(profile ? { default_thinking: defaultModelThinking(models) } : {}),
    };
  });
}
