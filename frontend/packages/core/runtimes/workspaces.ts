import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { CreateRuntimeWorkspaceRequest } from "./workspace-types";
export type { RuntimeWorkspace, CreateRuntimeWorkspaceRequest } from "./workspace-types";

export const runtimeWorkspaceKeys = { all: (wsId: string) => ["runtime-workspaces", wsId] as const };

export function runtimeWorkspacesOptions(wsId: string) {
  return queryOptions({
    queryKey: runtimeWorkspaceKeys.all(wsId), queryFn: () => api.listRuntimeWorkspaces(wsId),
    enabled: Boolean(wsId), staleTime: 10_000, refetchInterval: 30_000,
  });
}

export function useCreateRuntimeWorkspace(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ runtimeId, input }: { runtimeId: string; input: CreateRuntimeWorkspaceRequest }) => api.createRuntimeWorkspace(runtimeId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: runtimeWorkspaceKeys.all(wsId) }),
  });
}

export function useArchiveRuntimeWorkspace(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.archiveRuntimeWorkspace(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: runtimeWorkspaceKeys.all(wsId) }),
  });
}
