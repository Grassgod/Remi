import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { GcRunMode, StorageSettingsPatch } from "@multiremi/contracts/storage";
import { api } from "../api";
import { resolveRuntimeGcRun } from "./gc-run";
import { storageKeys } from "./queries";

export function useUpdateWorkspaceStorage(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: StorageSettingsPatch) => api.updateWorkspaceStorage(wsId, patch),
    onSuccess: (updated) => qc.setQueryData(storageKeys.settings(wsId), updated),
  });
}

/** Resolves with the finished request; its report carries the plan the daemon computed. */
export function useRuntimeGcRun(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ runtimeId, mode }: { runtimeId: string; mode: GcRunMode }) =>
      resolveRuntimeGcRun(runtimeId, mode),
    onSettled: () => qc.invalidateQueries({ queryKey: storageKeys.daemons(wsId) }),
  });
}
