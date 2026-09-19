import type { MultiremiRuntime, MultiremiRuntimeModel, MultiremiRuntimeModelThinking } from "@multiremi/contracts/types.js";
import { runtimeConnectionModels } from "@multiremi/contracts/runtime-connection";
import { commonThinkingLevels, modelThinkingLevels } from "@multiremi/contracts/model-thinking.js";
import type { GatewayModelReasoningDecl, MultiremiStore, RelayEngine } from "./store.js";

/** Minimal data source shared by API catalogs and dispatch capability checks. */
export type RuntimeModelCatalogSource = Pick<MultiremiStore,
  "getRelayModelDiscovery" | "getRelayConfigForDaemon" | "getGatewayModels" |
  "listGatewayModelReasoning" |
  "listWorkspaceCodexProfileModels" | "listWorkspaceClaudeProfileModels" | "getRuntimeExecutionProfile">;

/**
 * The effort values an administrator may declare per engine. Deliberately the
 * engines' own vocabularies rather than one normalised scale: the value is
 * forwarded to the CLI verbatim, so inventing a spelling it does not accept
 * would produce a declaration that routes fine and then fails at execution.
 * Claude's list matches what the gateway recognises for Anthropic models.
 */
export const GATEWAY_REASONING_LEVELS: Record<RelayEngine, readonly string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh", "max"],
};

/** Display labels for the declared enum, matching the CLIs' own spelling. */
const GATEWAY_REASONING_LEVEL_LABELS: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export function isGatewayReasoningLevel(engine: RelayEngine, value: unknown): value is string {
  return typeof value === "string" && GATEWAY_REASONING_LEVELS[engine].includes(value);
}

/**
 * Where a model's effective reasoning levels came from. Surfaced so the UI can
 * explain an outcome instead of showing an unexplained level list — and so an
 * administrator can see that a declaration of theirs is being outranked rather
 * than silently ignored.
 *
 *  - `gateway` — the model's own entry in a gateway/native catalog.
 *  - `runtime` — the execution engine's ACP `thought_level` report.
 *  - `manual`  — an administrator's explicit declaration (see
 *                `GatewayModelReasoningDecl`). A legitimate source: the operator
 *                states the levels, nothing is borrowed from another model.
 *  - `family`  — the Claude same-family consensus, an inference, not a statement.
 *  - `none`    — nobody declared anything; the model has no selectable levels.
 */
export type FleetModelThinkingSource = "gateway" | "runtime" | "manual" | "family" | "none";

export const MULTIREMI_DAEMON_PROVIDERS = new Set(["claude", "codex", "antigravity"]);

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
  /** Provenance of `thinking`; absent when the model has no reasoning entry at all. */
  thinking_source?: FleetModelThinkingSource;
  execution_status?: "available" | "unavailable" | "unknown";
  catalog?: MultiremiRuntimeModel["catalog"];
}

export interface FleetProviderModelsResponse {
  provider: string;
  online_runtime_count: number;
  models: FleetModelResponse[];
  /** ready: models is the authoritative selectable set, including an empty set. */
  model_catalog_status?: "ready" | "error" | "unknown";
  /** Runtime-side load outcome, independent of the control-plane snapshot. */
  runtime_catalog_status?: "ready" | "error";
  runtime_catalog_error?: string;
  default_thinking?: FleetModelThinkingResponse;
}

/**
 * Why a model exposes no reasoning levels. `modelThinkingLevels` collapses all
 * four into an empty array; routing must not, because they call for opposite
 * decisions (see docs/runtime-model-discovery.md):
 *
 *  - `supported`   — the model declares levels; the Agent's saved effort is a real
 *                    capability constraint and must be honoured.
 *  - `unsupported` — the model declares none at all. The effort is not applicable.
 *  - `unknown`     — nobody declared anything (gateway-only Claude aliases). Also
 *                    not applicable. Filling it from another model's levels is
 *                    exactly what this codebase forbids.
 *  - `error`       — the execution engine reported a failed capability load. That
 *                    is a transient state it recovers from, and it genuinely
 *                    cannot honour the model, so the Runtime stays out.
 */
export type ModelThinkingState = "supported" | "unsupported" | "unknown" | "error";

export function modelThinkingState(
  models: FleetModelResponse[],
  model: string,
  providerDefault?: FleetModelThinkingResponse,
): { state: ModelThinkingState; levels: FleetModelThinkingResponse["supported_levels"] } {
  // Reuse the selector's own resolution order so routing can never disagree with
  // the levels the UI offers.
  const levels = modelThinkingLevels(models, model, providerDefault);
  if (levels.length) return { state: "supported", levels };
  const thinking = model
    ? models.find((entry) => entry.id === model)?.thinking
    : providerDefault ?? models.find((entry) => entry.default)?.thinking;
  if (thinking?.status === "error") return { state: "error", levels: [] };
  if (thinking?.status === "unsupported") return { state: "unsupported", levels: [] };
  return { state: "unknown", levels: [] };
}

/**
 * Whether an empty level list is a statement about the model rather than missing
 * information — i.e. whether the provider can be taken at its word that this
 * model offers no reasoning levels.
 *
 * True for every provider except Claude. Codex's native catalog lists
 * `supported_reasoning_levels` per model, and the ACP `thought_level` probe feeds
 * the same fields for other ACP engines, so a model they cannot offer levels for
 * genuinely cannot honour an effort: the Runtime stays out and MUL-330/#220 keeps
 * REJECTING an explicitly requested effort rather than silently rewriting it.
 *
 * Claude is the exception because it publishes no reasoning metadata anywhere.
 * The gateway `/v1/models` inventory carries ids and labels only, and the bridge
 * reports the native selector solely for its own aliases, so a gateway-only alias
 * has no reasoning source behind it at all. There an empty level list says
 * nothing about the model — see `modelThinkingState` — and the only useful
 * reading is "not applicable".
 *
 * The default is deliberately "declares": a brand-new engine that is in fact like
 * Claude would keep its Agents queued (visible, recoverable, and how MUL-338 was
 * found), whereas assuming the opposite would silently run work at a default
 * effort on an engine that had stated it could not honour the requested one.
 */
export function providerDeclaresReasoningLevels(provider: string): boolean {
  return provider !== "claude";
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
  const provenance = model.catalog?.status === "ready" ? 20 : model.catalog?.status === "error" ? 10 : 0;
  if ((!thinking?.status || thinking.status === "supported") && (thinking?.supportedLevels ?? thinking?.supported_levels)?.length) return provenance + 3;
  if (thinking?.status === "error") return provenance + 2;
  if (thinking && thinking.status !== "unknown") return provenance + 1;
  return provenance;
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
    catalogStatuses: Array<"ready" | "error" | undefined>;
    catalogError?: string;
  }>();
  const bucket = (provider: string) => {
    let entry = buckets.get(provider);
    if (!entry) {
      entry = { online: 0, models: new Map(), defaultCapabilities: [], hasDefaultReport: false, catalogStatuses: [] };
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
        const native = models.find(model => model.catalog)?.catalog;
        const legacyError = models.length > 0 && models.every(model => model.thinking?.status === "error");
        entry.catalogStatuses.push(native?.status ?? (legacyError ? "error" : undefined));
        entry.catalogError ??= native?.error ?? (legacyError ? models[0]?.thinking?.error : undefined);
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
      ...(entry.catalogStatuses.length && entry.catalogStatuses.every(status => status === "error")
        ? { runtime_catalog_status: "error" as const, runtime_catalog_error: entry.catalogError }
        : entry.catalogStatuses.some(status => status === "ready") ? { runtime_catalog_status: "ready" as const } : {}),
      ...(entry.hasDefaultReport ? { default_thinking: commonThinkingCapabilities(entry.defaultCapabilities) } : {}),
    }));
}

export function runtimeModelCompatibilityResponse(model: MultiremiRuntimeModel): FleetModelResponse {
  const response: FleetModelResponse = {
    id: model.id,
    label: model.label,
  };
  if (model.catalog) {
    response.catalog = model.catalog;
    response.execution_status = "available";
  }
  if (model.provider) response.provider = model.provider;
  if (model.default) response.default = true;
  if (model.providerDefault) response.provider_default = true;
  if (model.thinking) {
    response.thinking = thinkingCompatibilityResponse(model.thinking);
    // This catalog is the union of what the engines reported, so anything it
    // carries is the engine's own statement.
    response.thinking_source = "runtime";
  }
  return response;
}

/**
 * Whether a thinking entry states something about the model, as opposed to being
 * an empty or unknown placeholder. Used to decide whether an administrator's
 * declaration is filling a gap or would be overriding a real statement.
 */
function declaresThinking(thinking: FleetModelThinkingResponse | undefined): boolean {
  if (!thinking) return false;
  if (thinking.status === "error" || thinking.status === "unsupported" || thinking.status === "supported") return true;
  return thinking.supported_levels.length > 0;
}

/** Project an administrator's declaration into the shared thinking response shape. */
export function manualThinkingResponse(decl: GatewayModelReasoningDecl): FleetModelThinkingResponse {
  return {
    supported_levels: decl.levels.map(value => ({ value, label: GATEWAY_REASONING_LEVEL_LABELS[value] ?? value })),
    ...(decl.defaultLevel ? { default_level: decl.defaultLevel } : {}),
    status: "supported",
  };
}

function manualReasoningByModel(store: RuntimeModelCatalogSource, workspaceId: string, engine: RelayEngine): Map<string, GatewayModelReasoningDecl> {
  return new Map(store.listGatewayModelReasoning(workspaceId, engine).map(decl => [decl.modelId, decl]));
}

/**
 * The precedence an administrator's declaration sits in:
 *
 *   gateway catalog  >  engine report  >  manual declaration  >  family consensus
 *
 * Below the two reports so it can never silently override something the model
 * actually stated (the one thing this codebase forbids), and above the family
 * consensus because a declared set beats an inferred one. With no declaration
 * stored the resolution is byte-for-byte the previous precedence.
 */
function resolveDeclaredThinking(input: {
  runtime?: FleetModelThinkingResponse;
  gateway?: FleetModelThinkingResponse;
  manual?: FleetModelThinkingResponse;
  family?: FleetModelThinkingResponse;
}): { thinking?: FleetModelThinkingResponse; source?: FleetModelThinkingSource } {
  const { runtime, gateway, manual, family } = input;
  // A runtime load failure is the engine saying it cannot honour the model at
  // all; it outranks every declaration, including the gateway's.
  if (runtime?.status === "error") return { thinking: runtime, source: "runtime" };
  if (gateway && gateway.status !== "unknown") return { thinking: gateway, source: "gateway" };
  if (declaresThinking(runtime)) return { thinking: runtime, source: "runtime" };
  if (manual) return { thinking: manual, source: "manual" };
  // A runtime that reported something uninformative still spoke; keep its entry
  // (and the family inference behind it) exactly as before.
  if (runtime) return { thinking: runtime, source: "runtime" };
  if (family) return { thinking: family, source: "family" };
  if (gateway) return { thinking: gateway, source: "gateway" };
  return {};
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
  options: { preserveCustomProfileModels?: boolean; requireRuntimeMembership?: boolean } = {},
): FleetProviderModelsResponse[] {
  // An administrator's declaration is a statement about the engine, not probe
  // output, so it is applied to whatever this function produced — before the
  // discovery check and after the snapshot overlay. It has to hold when a probe
  // never ran, failed, or dropped the alias: that is the whole point of the
  // manual source, and being a *snapshot annotation* kept it out of the catalog
  // exactly when the snapshot was the thing that was missing.
  //
  // Claude only, deliberately. For Codex the execution catalog decides which
  // models are executable at all (#220), so a declaration may state levels for a
  // model but must never make it selectable — see `catalogAllowsModel`.
  const claudeDecls = manualReasoningByModel(store, workspaceId, "claude");
  const withDeclarations = (list: FleetProviderModelsResponse[]): FleetProviderModelsResponse[] => {
    if (claudeDecls.size === 0) return list;
    const index = list.findIndex(entry => entry.provider === "claude");
    const entry = index >= 0 ? list[index] : { provider: "claude", online_runtime_count: 0, models: [] };
    const merged = withManualModels(entry, claudeDecls);
    if (merged === entry) return list;
    const next = [...list];
    if (index >= 0) next[index] = merged;
    else next.push(merged);
    return next;
  };
  // Discovery off → never surface a (possibly stale) gateway snapshot; fall back
  // to the per-runtime union so turning the toggle off actually hides the models.
  // A declaration is not snapshot data, so it survives the toggle.
  if (!store.getRelayModelDiscovery(workspaceId)) return withDeclarations(providers);
  const config = store.getRelayConfigForDaemon(workspaceId);
  const byEngine = new Map<string, FleetProviderModelsResponse>();
  for (const provider of providers) byEngine.set(provider.provider, provider);
  for (const engine of ["claude", "codex"] as const) {
    const engineConfig = config[engine];
    // No live gateway credential → don't surface any (possibly stale) snapshot.
    if (!engineConfig || !engineConfig.authToken) continue;
    const snapshot = store.getGatewayModels(workspaceId, engine);
    const existing = byEngine.get(engine);
    const manualDecls = manualReasoningByModel(store, workspaceId, engine);
    if (engine === "codex") {
      const current = snapshot?.sourceRevision === engineConfig.revision ? snapshot : null;
      const status = current ? current.lastError ? "error" : current.nativeCatalogStatus ?? "unknown" : "unknown";
      const runtimeStatus = existing?.runtime_catalog_status;
      const fallback = status === "error" || runtimeStatus === "error";
      const runtimeModels = new Map((existing?.models ?? []).map(model => [model.id, model]));
      const error = existing?.runtime_catalog_error ?? current?.lastError ?? "Codex model catalog unavailable";
      const source = current?.models ?? [];
      const models: FleetModelResponse[] = source.map(model => {
        const reported = runtimeModels.get(model.id);
        // Only entries from the actual ACP probe carry catalog provenance. Old
        // error reports included inventory-only IDs, so their membership is untrusted.
        const actual = reported?.catalog !== undefined;
        const modelFallback = fallback || reported?.catalog?.status === "error";
        const legacyFailure = !actual && reported?.thinking?.status === "error";
        const execution_status = status === "unknown" ? "unknown" as const
          : legacyFailure || (options.requireRuntimeMembership && !reported) ? "unavailable" as const
          : modelFallback ? actual ? "available" as const : "unavailable" as const
          : runtimeStatus === "ready" && !actual ? "unavailable" as const : "available" as const;
        const declaredSource: FleetModelThinkingSource | undefined = status === "unknown" ? "gateway"
          : modelFallback ? actual ? "runtime" : "gateway"
          : reported?.thinking?.status === "error" ? "runtime"
          : model.thinking && model.thinking.status !== "unknown" ? "gateway"
          : reported?.thinking ? "runtime"
          : model.thinking ? "gateway"
          : undefined;
        const declared = status === "unknown" ? { status: "unknown" as const, supported_levels: [] }
          : modelFallback ? actual ? reported.thinking : { status: "error" as const, supported_levels: [], error }
          : reported?.thinking?.status === "error" ? reported.thinking
          : model.thinking && model.thinking.status !== "unknown" ? thinkingCompatibilityResponse(model.thinking)
          : reported?.thinking ?? (model.thinking ? thinkingCompatibilityResponse(model.thinking) : undefined);
        // The native catalog stays authoritative: a declaration only fills an
        // entry nobody stated (or one the catalog could not load at all).
        const manualDecl = manualDecls.get(model.id);
        const manualFills = manualDecl !== undefined && !declaresThinking(declared);
        const thinking = manualFills ? manualThinkingResponse(manualDecl) : declared;
        const thinkingSource = manualFills ? "manual" as const : declaredSource;
        return { id: model.id, label: model.label, provider: engine, execution_status,
          ...(reported?.default && execution_status === "available" ? { default: true } : {}),
          ...(thinking ? { thinking } : {}),
          ...(thinking && thinkingSource ? { thinking_source: thinkingSource } : {}),
        };
      });
      // A failed native download falls back to Codex's actual bundled selector.
      // Keep those working members (and their real default/effort) visible too.
      if (status !== "unknown") for (const model of runtimeModels.values()) {
        if (model.catalog && (fallback || model.catalog.status === "error") && !models.some(candidate => candidate.id === model.id)) {
          models.push({ ...model, execution_status: "available" });
        }
      }
      if (options.preserveCustomProfileModels !== false) {
        const customIds = new Set(store.listWorkspaceCodexProfileModels(workspaceId));
        for (const model of runtimeModels.values()) if (customIds.has(model.id) && !models.some(candidate => candidate.id === model.id)) models.push(model);
      }
      byEngine.set(engine, {
        provider: engine, online_runtime_count: existing?.online_runtime_count ?? 0, models,
        model_catalog_status: status === "unknown" ? "unknown" : fallback ? "error" : "ready",
        ...(existing?.default_thinking ? { default_thinking: status === "unknown"
          ? { status: "unknown", supported_levels: [] }
          : existing.default_thinking.status === "error" ? existing.default_thinking : defaultModelThinking(models) } : {}),
      });
      continue;
    }
    if (!snapshot || snapshot.sourceRevision !== engineConfig.revision || snapshot.models.length === 0) continue;
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
    const models = snapshot.models.map((model): FleetModelResponse => {
      const runtimeModel = runtimeModels.get(model.id);
      const family = engine === "claude" ? claudeModelFamily(model.id) : undefined;
      const matchingFamilyModels = family ? familyModels.get(family) ?? [] : [];
      const familyMatched = matchingFamilyModels.length > 0;
      const gatewayThinking = model.thinking ? thinkingCompatibilityResponse(model.thinking) : undefined;
      const manualDecl = manualDecls.get(model.id);
      // Runtime loading failures mean the execution engine cannot honor even a
      // valid gateway declaration. Otherwise per-model gateway data is authoritative.
      const { thinking, source } = resolveDeclaredThinking({
        runtime: runtimeModel?.thinking,
        gateway: gatewayThinking,
        manual: manualDecl ? manualThinkingResponse(manualDecl) : undefined,
        family: familyMatched ? familyThinkingConsensus(matchingFamilyModels) : undefined,
      });
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
        ...(thinking && source ? { thinking_source: source } : {}),
      };
    });
    if (options.preserveCustomProfileModels !== false) {
      const customIds = new Set(store.listWorkspaceClaudeProfileModels(workspaceId));
      for (const model of existingModels) {
        if (customIds.has(model.id) && !models.some(candidate => candidate.id === model.id)) models.push(model);
      }
    }
    byEngine.set(engine, {
      provider: engine,
      online_runtime_count: existing?.online_runtime_count ?? 0,
      models,
      ...(existing?.default_thinking ? { default_thinking: existing.default_thinking } : {}),
    });
  }
  return withDeclarations([...byEngine.values()].sort((a, b) => a.provider.localeCompare(b.provider)));
}

/**
 * Add the models an administrator declared that no catalog offers yet.
 *
 * The declared levels are the model's only statement about itself, so the entry
 * carries them at `thinking_source: "manual"` — the same attribution the
 * snapshot path already uses when a declaration fills a gap. Ids the list
 * already has are left alone: those go through `resolveDeclaredThinking`, which
 * keeps a declaration below gateway and Runtime statements.
 */
function withManualModels(
  entry: FleetProviderModelsResponse,
  decls: Map<string, GatewayModelReasoningDecl>,
): FleetProviderModelsResponse {
  const missing = [...decls.keys()].filter(id => !entry.models.some(model => model.id === id));
  if (missing.length === 0) return entry;
  return {
    ...entry,
    models: [...entry.models, ...missing.map((id): FleetModelResponse => ({
      id,
      // Nothing ever discovered this id, so it is its own label.
      label: id,
      provider: entry.provider,
      thinking: manualThinkingResponse(decls.get(id)!),
      thinking_source: "manual",
    }))],
  };
}

/** Separate custom connections before applying workspace gateway load status. */
export function workspaceRuntimeModelCatalog(
  store: RuntimeModelCatalogSource, workspaceId: string, runtimes: MultiremiRuntime[], ownerId: string,
): FleetProviderModelsResponse[] {
  const custom = runtimes.filter(runtime => runtime.provider === "codex" && store.getRuntimeExecutionProfile(runtime.id, "codex"));
  const customIds = new Set(custom.map(runtime => runtime.id));
  const providers = overlayGatewayModels(store, workspaceId,
    fleetModelsResponse(runtimes.filter(runtime => !customIds.has(runtime.id)), ownerId));
  const customs = fleetModelsResponse(custom, ownerId).find(provider => provider.provider === "codex");
  if (!customs) return providers;
  const codex = providers.find(provider => provider.provider === "codex");
  if (!codex) return [...providers, customs].sort((a, b) => a.provider.localeCompare(b.provider));
  codex.online_runtime_count += customs.online_runtime_count;
  for (const model of customs.models) {
    const available = { ...model, execution_status: "available" as const };
    const index = codex.models.findIndex(candidate => candidate.id === model.id);
    if (index < 0) codex.models.push(available);
    else if (codex.models[index].execution_status !== "available") codex.models[index] = available;
  }
  return providers;
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
    const online_runtime_count = runtime.status === "online" ? 1 : 0;
    if (profile) {
      const models = runtimeConnectionModels(profile, entry.provider, entry.models);
      // Custom connections use their own catalog and never inherit a workspace
      // gateway's native membership constraint or loading status.
      return { ...entry, online_runtime_count, models, default_thinking: defaultModelThinking(models) };
    }
    const gateway = overlayGatewayModels(store, workspaceId, [entry], { preserveCustomProfileModels: entry.provider !== "codex", requireRuntimeMembership: entry.provider === "codex" })
      .find((candidate) => candidate.provider === entry.provider);
    return { ...(gateway ?? entry), online_runtime_count };
  });
}

/** Explicit Codex selections must be executable, regardless of effort overrides. */
export function catalogAllowsModel(catalog: FleetProviderModelsResponse | undefined, modelId: string): boolean {
  if (!modelId) return true;
  const model = catalog?.models.find(model => model.id === modelId);
  if (model?.execution_status === "available") return true;
  if (model?.execution_status === "unavailable" || model?.execution_status === "unknown") return false;
  if (catalog?.model_catalog_status === "unknown") return false;
  // Disabling the display overlay must not disable a Runtime's actual selector contract.
  if (catalog?.provider === "codex" && catalog.runtime_catalog_status) return Boolean(model?.catalog);
  if (catalog?.model_catalog_status === "ready" || catalog?.model_catalog_status === "error") return Boolean(model);
  return true;
}
