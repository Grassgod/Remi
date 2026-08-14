import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import type { AgentPluginProvider } from "./types";

export const agentPluginKeys = {
  all: (wsId: string) => ["workspaces", wsId, "agent-plugins"] as const,
  lists: (wsId: string) => [...agentPluginKeys.all(wsId), "list"] as const,
  list: (wsId: string, provider?: string) =>
    [...agentPluginKeys.lists(wsId), provider ?? "all"] as const,
  details: (wsId: string) => [...agentPluginKeys.all(wsId), "detail"] as const,
  detail: (wsId: string, pluginId: string) =>
    [...agentPluginKeys.details(wsId), pluginId] as const,
  versions: (wsId: string, pluginId: string) =>
    [...agentPluginKeys.detail(wsId, pluginId), "versions"] as const,
  runtimeStates: (wsId: string, pluginId: string) =>
    [...agentPluginKeys.detail(wsId, pluginId), "runtimes"] as const,
  runtimePluginStates: (wsId: string, runtimeId: string) =>
    [...agentPluginKeys.all(wsId), "runtimes", runtimeId, "plugins"] as const,
  agentBindings: (wsId: string, agentId: string) =>
    [...agentPluginKeys.all(wsId), "agents", agentId, "bindings"] as const,
};

export function pluginListOptions(
  wsId: string,
  provider?: AgentPluginProvider | string,
) {
  return queryOptions({
    queryKey: agentPluginKeys.list(wsId, provider),
    queryFn: () => api.listAgentPlugins(provider, wsId),
    enabled: Boolean(wsId),
  });
}

export function pluginDetailOptions(wsId: string, pluginId: string) {
  return queryOptions({
    queryKey: agentPluginKeys.detail(wsId, pluginId),
    queryFn: () => api.getAgentPlugin(pluginId),
    enabled: Boolean(wsId && pluginId),
  });
}

export function pluginVersionsOptions(wsId: string, pluginId: string) {
  return queryOptions({
    queryKey: agentPluginKeys.versions(wsId, pluginId),
    queryFn: () => api.listAgentPluginVersions(pluginId),
    enabled: Boolean(wsId && pluginId),
  });
}

export function pluginRuntimeStatesOptions(wsId: string, pluginId: string) {
  return queryOptions({
    queryKey: agentPluginKeys.runtimeStates(wsId, pluginId),
    queryFn: () => api.listAgentPluginRuntimeStates(pluginId),
    enabled: Boolean(wsId && pluginId),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function runtimePluginStatesOptions(wsId: string, runtimeId: string) {
  return queryOptions({
    queryKey: agentPluginKeys.runtimePluginStates(wsId, runtimeId),
    queryFn: () => api.listRuntimeAgentPluginStates(runtimeId),
    enabled: Boolean(wsId && runtimeId),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function agentPluginBindingsOptions(wsId: string, agentId: string) {
  return queryOptions({
    queryKey: agentPluginKeys.agentBindings(wsId, agentId),
    queryFn: () => api.listAgentPluginBindings(agentId),
    enabled: Boolean(wsId && agentId),
  });
}
