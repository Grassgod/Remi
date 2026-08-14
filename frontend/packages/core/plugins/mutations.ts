import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { agentPluginKeys } from "./queries";
import type {
  CreateAgentPluginBindingInput,
  CreateAgentPluginVersionInput,
  ImportAgentPluginInput,
  RetryAgentPluginRuntimeInput,
  UpdateAgentPluginBindingInput,
} from "./types";

function invalidateAgentPluginQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  wsId: string,
) {
  return queryClient.invalidateQueries({ queryKey: agentPluginKeys.all(wsId) });
}

export function useImportAgentPlugin(wsId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ImportAgentPluginInput) =>
      api.importAgentPlugin({
        ...input,
        workspaceId: wsId,
        workspace_id: wsId,
      }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: agentPluginKeys.all(wsId) });
    },
  });
}

export function useCreateAgentPluginVersion(
  wsId: string,
  pluginId: string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAgentPluginVersionInput) =>
      api.createAgentPluginVersion(pluginId, input),
    onSettled: () => invalidateAgentPluginQueries(queryClient, wsId),
  });
}

export function useActivateAgentPluginVersion(
  wsId: string,
  pluginId: string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (versionId: string) =>
      api.activateAgentPluginVersion(pluginId, versionId),
    onSettled: () => invalidateAgentPluginQueries(queryClient, wsId),
  });
}

export function useRollbackAgentPluginVersion(
  wsId: string,
  pluginId: string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (versionId?: string) =>
      api.rollbackAgentPluginVersion(pluginId, versionId),
    onSettled: () => invalidateAgentPluginQueries(queryClient, wsId),
  });
}

export function useCreateAgentPluginBinding(wsId: string, agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAgentPluginBindingInput) =>
      api.createAgentPluginBinding(agentId, input),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: agentPluginKeys.all(wsId) });
    },
  });
}

export function useUpdateAgentPluginBinding(wsId: string, agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      bindingId,
      input,
    }: {
      bindingId: string;
      input: UpdateAgentPluginBindingInput;
    }) => api.updateAgentPluginBinding(agentId, bindingId, input),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: agentPluginKeys.all(wsId) });
    },
  });
}

export function useDeleteAgentPluginBinding(wsId: string, agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (bindingId: string) =>
      api.deleteAgentPluginBinding(agentId, bindingId),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: agentPluginKeys.all(wsId) });
    },
  });
}

export function useRetryAgentPluginRuntime(wsId: string, pluginId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ runtimeId, versionId }: RetryAgentPluginRuntimeInput) =>
      api.retryAgentPluginRuntime(pluginId, runtimeId, versionId),
    onSettled: () => invalidateAgentPluginQueries(queryClient, wsId),
  });
}
