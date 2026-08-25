import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api";
import type {
  ImportWorkspaceRepositoryRequest,
  RepositoryWikiSummary,
  UpdateWorkspaceRepositoryRequest,
  WorkspaceRepositoryListResponse,
} from "../types";
import { autopilotKeys } from "../autopilots/queries";
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

export const REPOSITORY_WIKI_BUILD_IN_PROGRESS_CODE = "repository_wiki_build_in_progress";

// A 409 from POST .../wiki/build means "a build is already running" — for the
// UI that is the same outcome as a successful 202: show the building state.
export function isWikiBuildInProgressError(error: unknown): error is ApiError {
  if (!(error instanceof ApiError)) return false;
  if (error.status !== 409) return false;
  const body = error.body as { code?: unknown } | undefined;
  // A 409 without a machine-readable code still means the build endpoint
  // refused because of a conflicting build — treat any 409 as in-progress,
  // but prefer the explicit code when present.
  return body?.code === undefined || body.code === REPOSITORY_WIKI_BUILD_IN_PROGRESS_CODE;
}

// Optimistically flip the summaries cache to "queued" so the page reflects
// the build immediately, before the invalidated queries come back.
function markWikiBuildQueued(
  queryClient: QueryClient,
  workspaceId: string,
  repositoryId: string,
  ids: { run_id?: string | null; task_id?: string | null },
) {
  queryClient.setQueryData<RepositoryWikiSummary[]>(
    repositoryKeys.wikiSummaries(workspaceId),
    (current) => current?.map((summary) =>
      summary.repository_id === repositoryId && !isActiveBuildStatus(summary.build?.status)
        ? {
            ...summary,
            build: {
              status: "queued",
              run_id: ids.run_id ?? null,
              task_id: ids.task_id ?? null,
              failure_reason: null,
              started_at: null,
              updated_at: null,
              source_revision: null,
              published: null,
            },
          }
        : summary,
    ),
  );
}

function isActiveBuildStatus(status: string | undefined): boolean {
  return status === "queued" || status === "building";
}

export function useBuildRepositoryWiki(workspaceId: string, repositoryId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.buildRepositoryWiki(workspaceId, repositoryId),
    onSuccess: (response) => {
      markWikiBuildQueued(queryClient, workspaceId, repositoryId, response);
    },
    onError: (error) => {
      if (!isWikiBuildInProgressError(error)) return;
      const body = error.body as { run_id?: string | null; task_id?: string | null } | undefined;
      markWikiBuildQueued(queryClient, workspaceId, repositoryId, body ?? {});
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: repositoryKeys.wiki(workspaceId, repositoryId) });
      queryClient.invalidateQueries({ queryKey: repositoryKeys.wikiSummaries(workspaceId) });
      // The build runs through the Atlas autopilot — refresh its run history
      // so an open detail page picks up the new run right away.
      queryClient.invalidateQueries({ queryKey: autopilotKeys.all(workspaceId) });
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
