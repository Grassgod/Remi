import type {
  ImportWorkspaceRepositoryRequest,
  RepositoryMutationResponse,
  WorkspaceRepositoryListResponse,
} from "../../types";
import type { HttpClient } from "../http";
import { parseWithFallback } from "../schema";
import {
  EMPTY_REPOSITORY_LIST_RESPONSE,
  EMPTY_REPOSITORY_MUTATION_RESPONSE,
  repositoryListResponseSchema,
  repositoryMutationResponseSchema,
} from "../schemas/repositories";

export class RepositoriesEndpoints {
  constructor(readonly http: HttpClient) {}

  async listWorkspaceRepositories(
    workspaceId: string,
  ): Promise<WorkspaceRepositoryListResponse> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/repos`,
    );
    return parseWithFallback(
      raw,
      repositoryListResponseSchema,
      EMPTY_REPOSITORY_LIST_RESPONSE,
      { endpoint: "GET /api/workspaces/:id/repos" },
    );
  }

  async importWorkspaceRepository(
    workspaceId: string,
    input: ImportWorkspaceRepositoryRequest,
  ): Promise<RepositoryMutationResponse> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/repos`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
    return parseWithFallback(
      raw,
      repositoryMutationResponseSchema,
      EMPTY_REPOSITORY_MUTATION_RESPONSE,
      { endpoint: "POST /api/workspaces/:id/repos" },
    );
  }

  async removeWorkspaceRepository(
    workspaceId: string,
    repositoryId: string,
  ): Promise<RepositoryMutationResponse> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/repos/${encodeURIComponent(repositoryId)}`,
      { method: "DELETE" },
    );
    return parseWithFallback(
      raw,
      repositoryMutationResponseSchema,
      EMPTY_REPOSITORY_MUTATION_RESPONSE,
      { endpoint: "DELETE /api/workspaces/:id/repos/:repositoryId" },
    );
  }
}
