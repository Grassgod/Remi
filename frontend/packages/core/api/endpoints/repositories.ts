import type {
  AtlasWikiSetupStatus,
  ImportWorkspaceRepositoryRequest,
  RepositoryInspectionResponse,
  RepositoryMutationResponse,
  UpdateWorkspaceRepositoryRequest,
  WorkspaceRepositoryListResponse,
  RepositoryWikiDoc,
  RepositoryWikiRevision,
  RepositoryWikiSummary,
  RepositoryWikiBuildResponse,
} from "../../types";
import type { HttpClient } from "../http";
import { parseWithFallback } from "../schema";
import {
  EMPTY_REPOSITORY_LIST_RESPONSE,
  EMPTY_REPOSITORY_INSPECTION_RESPONSE,
  EMPTY_REPOSITORY_MUTATION_RESPONSE,
  repositoryInspectionResponseSchema,
  repositoryListResponseSchema,
  repositoryMutationResponseSchema,
  repositoryWikiDocResponseSchema,
  repositoryWikiDocsResponseSchema,
  repositoryWikiRevisionsResponseSchema,
  repositoryWikiSummariesResponseSchema,
  atlasWikiSetupStatusSchema,
  EMPTY_ATLAS_WIKI_SETUP_STATUS,
  repositoryWikiBuildResponseSchema,
  EMPTY_REPOSITORY_WIKI_BUILD_RESPONSE,
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

  async inspectWorkspaceRepository(
    workspaceId: string,
    url: string,
  ): Promise<RepositoryInspectionResponse> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/repos/inspect`,
      {
        method: "POST",
        body: JSON.stringify({ url }),
      },
    );
    return parseWithFallback(
      raw,
      repositoryInspectionResponseSchema,
      EMPTY_REPOSITORY_INSPECTION_RESPONSE,
      { endpoint: "POST /api/workspaces/:id/repos/inspect" },
    );
  }

  async updateWorkspaceRepository(
    workspaceId: string,
    repositoryId: string,
    input: UpdateWorkspaceRepositoryRequest,
  ): Promise<RepositoryMutationResponse> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/repos/${encodeURIComponent(repositoryId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      },
    );
    return parseWithFallback(
      raw,
      repositoryMutationResponseSchema,
      EMPTY_REPOSITORY_MUTATION_RESPONSE,
      { endpoint: "PATCH /api/workspaces/:id/repos/:repositoryId" },
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

  async listRepositoryWikiSummaries(workspaceId: string): Promise<RepositoryWikiSummary[]> {
    const raw = await this.http.fetch<unknown>(`/api/workspaces/${encodeURIComponent(workspaceId)}/repository-wikis`);
    return parseWithFallback(raw, repositoryWikiSummariesResponseSchema, { repositories: [] }, {
      endpoint: "GET /api/workspaces/:id/repository-wikis",
    }).repositories;
  }

  async getAtlasWikiSetupStatus(workspaceId: string): Promise<AtlasWikiSetupStatus> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/repository-wikis/atlas`,
    );
    return parseWithFallback(raw, atlasWikiSetupStatusSchema, EMPTY_ATLAS_WIKI_SETUP_STATUS, {
      endpoint: "GET /api/workspaces/:id/repository-wikis/atlas",
    });
  }

  async configureAtlasWiki(workspaceId: string): Promise<AtlasWikiSetupStatus> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/repository-wikis/atlas`,
      { method: "POST" },
    );
    return parseWithFallback(raw, atlasWikiSetupStatusSchema, EMPTY_ATLAS_WIKI_SETUP_STATUS, {
      endpoint: "POST /api/workspaces/:id/repository-wikis/atlas",
    });
  }

  async listRepositoryWikiDocs(workspaceId: string, repositoryId: string, query = ""): Promise<RepositoryWikiDoc[]> {
    const params = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : "";
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/repos/${encodeURIComponent(repositoryId)}/wiki${params}`,
    );
    return parseWithFallback(raw, repositoryWikiDocsResponseSchema, { docs: [] }, {
      endpoint: "GET /api/workspaces/:id/repos/:repositoryId/wiki",
    }).docs;
  }

  async buildRepositoryWiki(workspaceId: string, repositoryId: string): Promise<RepositoryWikiBuildResponse> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/repos/${encodeURIComponent(repositoryId)}/wiki/build`,
      { method: "POST" },
    );
    return parseWithFallback(raw, repositoryWikiBuildResponseSchema, EMPTY_REPOSITORY_WIKI_BUILD_RESPONSE, {
      endpoint: "POST /api/workspaces/:id/repos/:repositoryId/wiki/build",
    });
  }

  async getRepositoryWikiDoc(workspaceId: string, repositoryId: string, ref: string): Promise<RepositoryWikiDoc | null> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/repos/${encodeURIComponent(repositoryId)}/wiki/${encodeURIComponent(ref)}`,
    );
    return parseWithFallback(raw, repositoryWikiDocResponseSchema, { doc: null }, {
      endpoint: "GET /api/workspaces/:id/repos/:repositoryId/wiki/:ref",
    }).doc;
  }

  async listRepositoryWikiRevisions(workspaceId: string, repositoryId: string, ref: string): Promise<RepositoryWikiRevision[]> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/repos/${encodeURIComponent(repositoryId)}/wiki/${encodeURIComponent(ref)}/revisions`,
    );
    return parseWithFallback(raw, repositoryWikiRevisionsResponseSchema, { revisions: [] }, {
      endpoint: "GET /api/workspaces/:id/repos/:repositoryId/wiki/:ref/revisions",
    }).revisions;
  }
}
