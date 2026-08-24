import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { platformLifecycleKeys } from "./queries";

export function useCreatePlatformOperation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      kind: "check_updates" | "restart" | "update" | "rollback";
      targetVersion?: string | null;
      targetRef?: string | null;
    }) => api.createPlatformOperation(input),
    onSettled: () => queryClient.invalidateQueries({ queryKey: platformLifecycleKeys.all }),
  });
}

export function useCancelPlatformOperation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.cancelPlatformOperation(id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: platformLifecycleKeys.all }),
  });
}

export function useUpdatePlatformSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => api.updatePlatformSettings(enabled),
    onSettled: () => queryClient.invalidateQueries({ queryKey: platformLifecycleKeys.all }),
  });
}
