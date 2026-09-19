import { useMemo } from "react";
import { queryOptions, useQuery, type Query } from "@tanstack/react-query";
import { api } from "../api";
import type { FleetModelsResponse, FleetProviderModels, RuntimeModel, RuntimeModelsResult } from "../types/agent";

export const runtimeModelsKeys = {
  all: () => ["runtimes", "models"] as const,
  forRuntime: (runtimeId: string) =>
    [...runtimeModelsKeys.all(), runtimeId] as const,
  fleet: (wsId: string) => [...runtimeModelsKeys.all(), "fleet", wsId] as const,
  group: (wsId: string, groupId: string, agentId?: string) =>
    [...runtimeModelsKeys.fleet(wsId), "group", groupId, agentId ?? ""] as const,
  target: (wsId: string, runtimeId: string) =>
    [...runtimeModelsKeys.fleet(wsId), "target", runtimeId] as const,
};

const isCatalogPending = (data?: FleetModelsResponse) =>
  data?.providers.some((entry) => entry.provider === "codex" && entry.model_catalog_status === "unknown") ?? false;

// A pre-refresh snapshot cannot be cached as an authoritative catalog. Bound
// recovery requests while discovery is pending; daemon WS events also invalidate
// this query when capabilities change, including after this short window ends.
const pendingRecoveryStarts = new WeakMap<Query<FleetModelsResponse>, number>();
const catalogFreshness = {
  staleTime: (query: Query<FleetModelsResponse>) => isCatalogPending(query.state.data) ? 0 : 60_000,
  refetchInterval: (query: Query<FleetModelsResponse>) => {
    if (!isCatalogPending(query.state.data)) {
      pendingRecoveryStarts.delete(query);
      return false;
    }
    const initialUpdate = pendingRecoveryStarts.get(query) ?? query.state.dataUpdateCount;
    pendingRecoveryStarts.set(query, initialUpdate);
    return query.state.dataUpdateCount - initialUpdate < 14 ? 2_000 : false;
  },
};

// Stored workspace catalog; target selections use the scoped query below.
export function fleetModelsOptions(wsId: string) {
  return queryOptions({
    queryKey: runtimeModelsKeys.fleet(wsId),
    queryFn: () => api.listFleetModels({ workspace_id: wsId }),
    ...catalogFreshness,
  });
}

const NO_MODELS: RuntimeModel[] = [];

export function executionTargetModelsOptions(wsId: string, runtimeId?: string | null, executionGroupId?: string | null, agentId?: string) {
  return queryOptions({
    queryKey: executionGroupId
      ? runtimeModelsKeys.group(wsId, executionGroupId, agentId)
      : runtimeId ? [...runtimeModelsKeys.target(wsId, runtimeId), agentId ?? ""]
        : [...runtimeModelsKeys.fleet(wsId), "automatic", agentId ?? ""],
    queryFn: () => api.listFleetModels({
      workspace_id: wsId,
      ...(executionGroupId ? { execution_group_id: executionGroupId } : runtimeId ? { runtime_id: runtimeId } : {}),
      agent_id: agentId,
    }),
    enabled: Boolean(wsId),
    ...catalogFreshness,
  });
}

/** Models of the selected group/Runtime, or the workspace pool for automatic scheduling. */
export function useExecutionTargetModels(wsId: string, provider: string, runtimeId?: string | null, executionGroupId?: string | null, agentId?: string) {
  const query = useQuery(executionTargetModelsOptions(wsId, runtimeId, executionGroupId, agentId));
  const bucket = query.data?.providers.find((entry) => entry.provider === provider);
  return {
    models: bucket?.models ?? NO_MODELS,
    modelCatalogStatus: bucket?.model_catalog_status,
    defaultThinking: bucket?.default_thinking,
    onlineRuntimeCount: bucket?.online_runtime_count ?? 0,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

// One provider's slice of the fleet catalog, for the components that let the
// user pick an engine + model without ever seeing a machine. Memoised so the
// returned references stay stable across renders.
export function useFleetProviderModels(
  wsId: string,
  provider: string,
): {
  models: RuntimeModel[];
  modelCatalogStatus: FleetProviderModels["model_catalog_status"];
  onlineRuntimeCount: number;
  isLoading: boolean;
  isError: boolean;
} {
  const query = useQuery(fleetModelsOptions(wsId));
  const bucket = useMemo(
    () => query.data?.providers.find((entry) => entry.provider === provider) ?? null,
    [query.data, provider],
  );
  return {
    models: bucket?.models ?? NO_MODELS,
    modelCatalogStatus: bucket?.model_catalog_status,
    onlineRuntimeCount: bucket?.online_runtime_count ?? 0,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

/** Relay catalogs constrain selection; older APIs and custom connections keep their behavior. */
export function isModelCatalogRestricted(
  provider: string,
  models: RuntimeModel[],
  catalogStatus?: FleetProviderModels["model_catalog_status"],
): boolean {
  return provider === "codex" && (catalogStatus === "ready" || catalogStatus === "unknown"
    || models.some((entry) => entry.execution_status !== undefined));
}

export function isModelExecutionUnknown(
  provider: string,
  model: string,
  models: RuntimeModel[],
  catalogStatus?: FleetProviderModels["model_catalog_status"],
): boolean {
  if (provider !== "codex") return false;
  const status = models.find((entry) => entry.id === model.trim())?.execution_status;
  return status === "unknown" || (status === undefined && catalogStatus === "unknown");
}

/** Unknown execution metadata never grants permission to select a model. */
export function isModelUnavailable(
  provider: string,
  model: string,
  models: RuntimeModel[],
  catalogStatus?: FleetProviderModels["model_catalog_status"],
): boolean {
  if (provider !== "codex" || !model.trim()) return false;
  const entry = models.find((entry) => entry.id === model.trim());
  if (entry?.execution_status !== undefined) return entry.execution_status !== "available";
  if (catalogStatus === "unknown") return true;
  return !entry && isModelCatalogRestricted(provider, models, catalogStatus);
}

/** Fallbacks must pass the selected target's catalog, even outside Codex. */
export function isFallbackModelUnavailable(
  provider: string,
  model: string,
  models: RuntimeModel[],
  catalogStatus?: FleetProviderModels["model_catalog_status"],
): boolean {
  if (!model.trim()) return false;
  if (isModelUnavailable(provider, model, models, catalogStatus)) return true;
  const entry = models.find((candidate) => candidate.id === model.trim());
  if (entry?.execution_status === "available") return false;
  if (entry?.execution_status === "unknown" || entry?.execution_status === "unavailable") return true;
  return catalogStatus === "unknown" ||
    ((catalogStatus === "ready" || catalogStatus === "error") && !entry);
}

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 30_000;

// resolveRuntimeModels initiates a list-models request against the daemon
// (via heartbeat piggyback) and polls until the daemon reports back or
// the request times out. Returns both the models list and a
// `supported` flag: `supported=false` means the provider ignores
// per-agent model selection entirely (hermes today) — the UI uses
// this to disable its dropdown instead of accepting a value that
// wouldn't be honoured at runtime.
export async function resolveRuntimeModels(
  runtimeId: string,
): Promise<RuntimeModelsResult> {
  const initial = await api.initiateListModels(runtimeId);
  const start = Date.now();
  let current = initial;
  while (current.status === "pending" || current.status === "running") {
    if (Date.now() - start > POLL_TIMEOUT_MS) {
      throw new Error("model discovery timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    current = await api.getListModelsResult(runtimeId, initial.id);
  }
  if (current.status === "failed" || current.status === "timeout") {
    throw new Error(current.error || "model discovery failed");
  }
  return { models: current.models ?? [], supported: current.supported };
}

export function runtimeModelsOptions(runtimeId: string | null | undefined) {
  return queryOptions({
    queryKey: runtimeId
      ? runtimeModelsKeys.forRuntime(runtimeId)
      : runtimeModelsKeys.all(),
    queryFn: () => resolveRuntimeModels(runtimeId as string),
    enabled: Boolean(runtimeId),
    // Models rarely change; cache for 60s to match the server-side
    // cache in agent.ListModels.
    staleTime: 60_000,
    retry: false,
  });
}
