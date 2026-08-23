import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type {
  ImportWorkspaceRepositoryRequest,
  UpdateWorkspaceRepositoryRequest,
  WorkspaceRepositoryListResponse,
} from "../types";
import { workspaceKeys } from "../workspace/queries";
import { repositoryKeys } from "./queries";

export function useImportWorkspaceRepository(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ImportWorkspaceRepositoryRequest) =>
      api.importWorkspaceRepository(workspaceId, input),
    onSuccess: (response) => {
      const repository = response.repository;
      if (!repository) return;
      queryClient.setQueryData<WorkspaceRepositoryListResponse>(
        repositoryKeys.list(workspaceId),
        (current) => ({
          repositories: [...(current?.repositories ?? []), repository],
          total: (current?.repositories.length ?? 0) + 1,
        }),
      );
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: repositoryKeys.all(workspaceId) });
      queryClient.invalidateQueries({ queryKey: workspaceKeys.list() });
    },
  });
}

export function useInspectWorkspaceRepository(workspaceId: string) {
  return useMutation({
    mutationFn: (url: string) => api.inspectWorkspaceRepository(workspaceId, url),
  });
}

export function useConfigureAtlasWiki(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.configureAtlasWiki(workspaceId),
    onSuccess: (status) => {
      queryClient.setQueryData(repositoryKeys.atlas(workspaceId), status);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: repositoryKeys.atlas(workspaceId) });
    },
  });
}

export function useBuildRepositoryWiki(workspaceId: string, repositoryId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.buildRepositoryWiki(workspaceId, repositoryId),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: repositoryKeys.wiki(workspaceId, repositoryId) });
      queryClient.invalidateQueries({ queryKey: repositoryKeys.wikiSummaries(workspaceId) });
    },
  });
}

export function useUpdateWorkspaceRepository(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ repositoryId, input }: {
      repositoryId: string;
      input: UpdateWorkspaceRepositoryRequest;
    }) => api.updateWorkspaceRepository(workspaceId, repositoryId, input),
    onSuccess: (response) => {
      const repository = response.repository;
      if (!repository) return;
      queryClient.setQueryData<WorkspaceRepositoryListResponse>(
        repositoryKeys.list(workspaceId),
        (current) => {
          const repositories = (current?.repositories ?? []).map((candidate) =>
            candidate.id === repository.id ? repository : candidate
          );
          return { repositories, total: repositories.length };
        },
      );
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: repositoryKeys.all(workspaceId) });
      queryClient.invalidateQueries({ queryKey: workspaceKeys.list() });
    },
  });
}

export function useRemoveWorkspaceRepository(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (repositoryId: string) =>
      api.removeWorkspaceRepository(workspaceId, repositoryId),
    onMutate: async (repositoryId) => {
      await queryClient.cancelQueries({ queryKey: repositoryKeys.list(workspaceId) });
      const previous = queryClient.getQueryData<WorkspaceRepositoryListResponse>(
        repositoryKeys.list(workspaceId),
      );
      queryClient.setQueryData<WorkspaceRepositoryListResponse>(
        repositoryKeys.list(workspaceId),
        (current) => {
          const repositories = (current?.repositories ?? []).filter(
            (repository) => repository.id !== repositoryId,
          );
          return { repositories, total: repositories.length };
        },
      );
      return { previous };
    },
    onError: (_error, _repositoryId, context) => {
      if (context?.previous) {
        queryClient.setQueryData(
          repositoryKeys.list(workspaceId),
          context.previous,
        );
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: repositoryKeys.all(workspaceId) });
      queryClient.invalidateQueries({ queryKey: workspaceKeys.list() });
    },
  });
}
