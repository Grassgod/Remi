import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import type { SshMeshOverview } from "./types";

export const SSH_MESH_ACTIVE_REFRESH_MS = 1_500;
export const SSH_MESH_IDLE_REFRESH_MS = 60_000;
export const RUNTIME_LIST_REFRESH_MS = 30_000;
export const RUNTIME_HEARTBEAT_REFRESH_MIN_INTERVAL_MS = 15_000;

export function shouldRefreshOnHeartbeat(
  lastRefreshAt: number | null,
  now: number,
  minIntervalMs = RUNTIME_HEARTBEAT_REFRESH_MIN_INTERVAL_MS,
): boolean {
  return lastRefreshAt === null || now - lastRefreshAt >= minIntervalMs;
}

export function getSshMeshRefreshInterval(
  overview: SshMeshOverview | undefined,
): number {
  const applying =
    overview?.rotation_state === "rolling_out" ||
    overview?.nodes.some(
      (node) =>
        node.status === "syncing" ||
        node.desired_probe_revision > node.probe_revision,
    );
  return applying
    ? SSH_MESH_ACTIVE_REFRESH_MS
    : SSH_MESH_IDLE_REFRESH_MS;
}

export const runtimeKeys = {
  all: (wsId: string) => ["runtimes", wsId] as const,
  list: (wsId: string) => [...runtimeKeys.all(wsId), "list"] as const,
  listMine: (wsId: string) => [...runtimeKeys.all(wsId), "list", "mine"] as const,
  usage: (rid: string, days: number, tz: string) =>
    ["runtimes", "usage", rid, days, tz] as const,
  usageByAgent: (rid: string, days: number, tz: string) =>
    ["runtimes", "usage", "by-agent", rid, days, tz] as const,
  // by-hour now follows the viewer's tz, like the other reports.
  usageByHour: (rid: string, days: number, tz: string) =>
    ["runtimes", "usage", "by-hour", rid, days, tz] as const,
  latestVersion: () => ["runtimes", "latestVersion"] as const,
  daemonInventory: (wsId: string) =>
    ["runtimes", "daemons", "inventory", wsId] as const,
  daemonRetirementPlan: (wsId: string, daemonId: string) =>
    ["runtimes", wsId, "daemons", daemonId, "retirement-plan"] as const,
  sshMesh: (wsId: string) =>
    ["runtimes", wsId, "ssh-mesh"] as const,
  provisions: (wsId: string) =>
    ["runtimes", wsId, "provisions"] as const,
  provisionStates: (wsId: string, provisionId: string) =>
    ["runtimes", wsId, "provisions", provisionId, "states"] as const,
};

export function daemonInventoryOptions(wsId: string) {
  return queryOptions({
    queryKey: runtimeKeys.daemonInventory(wsId),
    queryFn: () => api.getDaemonInventory(wsId),
    staleTime: 30_000,
  });
}

export function daemonRetirementPlanOptions(wsId: string, daemonId: string) {
  return queryOptions({
    queryKey: runtimeKeys.daemonRetirementPlan(wsId, daemonId),
    queryFn: () => api.getDaemonRetirementPlan(wsId, daemonId),
    staleTime: 0,
  });
}

export function sshMeshOptions(wsId: string) {
  return queryOptions({
    queryKey: runtimeKeys.sshMesh(wsId),
    queryFn: () => api.getSshMeshOverview(wsId),
    staleTime: 30_000,
    refetchInterval: (query) => getSshMeshRefreshInterval(query.state.data),
  });
}

// `tz` is the viewer's IANA name — all reports follow the viewer's tz.
export function runtimeUsageOptions(
  runtimeId: string,
  days: number,
  tz: string,
) {
  return queryOptions({
    queryKey: runtimeKeys.usage(runtimeId, days, tz),
    queryFn: () => api.getRuntimeUsage(runtimeId, { days, tz }),
    staleTime: 60 * 1000,
  });
}

export function runtimeUsageByAgentOptions(
  runtimeId: string,
  days: number,
  tz: string,
) {
  return queryOptions({
    queryKey: runtimeKeys.usageByAgent(runtimeId, days, tz),
    queryFn: () => api.getRuntimeUsageByAgent(runtimeId, { days, tz }),
    staleTime: 60 * 1000,
  });
}

export function runtimeUsageByHourOptions(runtimeId: string, days: number, tz: string) {
  return queryOptions({
    queryKey: runtimeKeys.usageByHour(runtimeId, days, tz),
    queryFn: () => api.getRuntimeUsageByHour(runtimeId, { days, tz }),
    staleTime: 60 * 1000,
  });
}

export function runtimeListOptions(wsId: string, owner?: "me") {
  return queryOptions({
    queryKey: owner === "me" ? runtimeKeys.listMine(wsId) : runtimeKeys.list(wsId),
    queryFn: () => api.listRuntimes({ workspace_id: wsId, owner }),
    staleTime: 10_000,
    refetchInterval: RUNTIME_LIST_REFRESH_MS,
    refetchIntervalInBackground: false,
  });
}

export function latestCliVersionOptions() {
  return queryOptions({
    queryKey: runtimeKeys.latestVersion(),
    // Proxied through the backend: a direct api.github.com call from the
    // browser hits rate limits and logs a console error on every page.
    queryFn: () => api.getLatestCliVersion(),
    staleTime: 10 * 60 * 1000, // 10 minutes
  });
}
