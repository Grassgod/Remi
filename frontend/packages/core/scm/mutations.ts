import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  CreateScmConnectionRequest,
  UpdateScmConnectionRequest,
  UpdateScmRepositoryBindingRequest,
} from "../types";
import { api } from "../api";
import { scmKeys } from "./queries";

export function useCreateScmConnection(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateScmConnectionRequest) =>
      api.createScmConnection(workspaceId, input),
    onSettled: () => queryClient.invalidateQueries({ queryKey: scmKeys.all(workspaceId) }),
  });
}

export function useUpdateScmConnection(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ connectionId, input }: {
      connectionId: string;
      input: UpdateScmConnectionRequest;
    }) => api.updateScmConnection(workspaceId, connectionId, input),
    onSettled: () => queryClient.invalidateQueries({ queryKey: scmKeys.all(workspaceId) }),
  });
}

export function useDeleteScmConnection(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (connectionId: string) => api.deleteScmConnection(workspaceId, connectionId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: scmKeys.all(workspaceId) }),
  });
}

export function useBindScmRepository(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ connectionId, repositoryId, input = {} }: {
      connectionId: string;
      repositoryId: string;
      input?: UpdateScmRepositoryBindingRequest;
    }) => api.bindScmRepository(workspaceId, connectionId, repositoryId, input),
    onSettled: () => queryClient.invalidateQueries({ queryKey: scmKeys.all(workspaceId) }),
  });
}

export function useUnbindScmRepository(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ connectionId, repositoryId }: {
      connectionId: string;
      repositoryId: string;
    }) => api.unbindScmRepository(workspaceId, connectionId, repositoryId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: scmKeys.all(workspaceId) }),
  });
}
