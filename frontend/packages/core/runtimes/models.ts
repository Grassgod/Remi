import { useMemo } from "react";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { RuntimeModel, RuntimeModelsResult } from "../types/agent";

export const runtimeModelsKeys = {
  all: () => ["runtimes", "models"] as const,
  forRuntime: (runtimeId: string) =>
    [...runtimeModelsKeys.all(), runtimeId] as const,
  fleet: (wsId: string) => [...runtimeModelsKeys.all(), "fleet", wsId] as const,
};

// Fleet-level catalog: the stored model lists of the workspace's online
// runtimes, unioned per provider server-side. Unlike resolveRuntimeModels
// this never fans out to a daemon — it reads what the daemons last
// reported, so it works before any machine is picked (there is none to
// pick anymore).
export function fleetModelsOptions(wsId: string) {
  return queryOptions({
    queryKey: runtimeModelsKeys.fleet(wsId),
    queryFn: () => api.listFleetModels({ workspace_id: wsId }),
    staleTime: 60_000,
  });
}

const NO_MODELS: RuntimeModel[] = [];

// One provider's slice of the fleet catalog, for the components that let the
// user pick an engine + model without ever seeing a machine. Memoised so the
// returned references stay stable across renders.
export function useFleetProviderModels(
  wsId: string,
  provider: string,
): {
  models: RuntimeModel[];
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
    onlineRuntimeCount: bucket?.online_runtime_count ?? 0,
    isLoading: query.isLoading,
    isError: query.isError,
  };
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
