import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { RuntimeProvision, RuntimeProvisionInput } from "./types";
import { runtimeKeys } from "./queries";

export function runtimeProvisionsOptions(wsId: string) {
  return queryOptions({
    queryKey: runtimeKeys.provisions(wsId),
    queryFn: () => api.listRuntimeProvisions(wsId),
    enabled: Boolean(wsId),
    staleTime: 30_000,
  });
}

export function runtimeProvisionStatesOptions(wsId: string, provisionId: string | null) {
  return queryOptions({
    queryKey: provisionId
      ? runtimeKeys.provisionStates(wsId, provisionId)
      : [...runtimeKeys.provisions(wsId), "states"] as const,
    queryFn: () => api.listRuntimeProvisionStates(wsId, provisionId as string),
    enabled: Boolean(wsId && provisionId),
    staleTime: 15_000,
  });
}

export function useCreateRuntimeProvision(wsId: string) {
  const queryClient = useQueryClient();
  const queryKey = runtimeKeys.provisions(wsId);
  return useMutation({
    mutationFn: (input: RuntimeProvisionInput) => api.createRuntimeProvision(wsId, input),
    onSuccess: (created) => {
      queryClient.setQueryData<RuntimeProvision[]>(queryKey, (current) => [
        ...(current ?? []),
        created,
      ]);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
}

export function useUpdateRuntimeProvision(wsId: string) {
  const queryClient = useQueryClient();
  const queryKey = runtimeKeys.provisions(wsId);
  return useMutation({
    mutationFn: ({
      provisionId,
      input,
    }: {
      provisionId: string;
      input: RuntimeProvisionInput;
    }) => api.updateRuntimeProvision(wsId, provisionId, input),
    onMutate: async ({ provisionId, input }) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<RuntimeProvision[]>(queryKey);
      queryClient.setQueryData<RuntimeProvision[]>(queryKey, (current) =>
        current?.map((provision) =>
          provision.id === provisionId ? { ...provision, ...input } : provision,
        ),
      );
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
    },
    onSuccess: (updated) => {
      queryClient.setQueryData<RuntimeProvision[]>(queryKey, (current) =>
        current?.map((provision) => provision.id === updated.id ? updated : provision),
      );
    },
    onSettled: (_data, _error, variables) => {
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({
        queryKey: runtimeKeys.provisionStates(wsId, variables.provisionId),
      });
    },
  });
}

export function useDeleteRuntimeProvision(wsId: string) {
  const queryClient = useQueryClient();
  const queryKey = runtimeKeys.provisions(wsId);
  return useMutation({
    mutationFn: (provisionId: string) => api.deleteRuntimeProvision(wsId, provisionId),
    onMutate: async (provisionId) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<RuntimeProvision[]>(queryKey);
      queryClient.setQueryData<RuntimeProvision[]>(queryKey, (current) =>
        current?.filter((provision) => provision.id !== provisionId),
      );
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
    },
    onSettled: (_data, _error, provisionId) => {
      queryClient.invalidateQueries({ queryKey });
      queryClient.removeQueries({ queryKey: runtimeKeys.provisionStates(wsId, provisionId) });
    },
  });
}
