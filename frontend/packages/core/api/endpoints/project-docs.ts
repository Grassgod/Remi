import type {
  ListProjectDocRevisionsResponse,
  ListProjectDocsResponse,
  ListWorkspaceDocsResponse,
  ProjectDoc,
} from "../../types";
import type { HttpClient } from "../http";
import { parseWithFallback } from "../schema";
import {
  EMPTY_LIST_PROJECT_DOCS_RESPONSE,
  EMPTY_LIST_PROJECT_DOC_REVISIONS_RESPONSE,
  EMPTY_LIST_WORKSPACE_DOCS_RESPONSE,
  EMPTY_PROJECT_DOC,
  ListProjectDocRevisionsResponseSchema,
  ListProjectDocsResponseSchema,
  ListWorkspaceDocsResponseSchema,
  ProjectDocResponseSchema,
} from "../schemas/project-docs";

export class ProjectDocsEndpoints {
  constructor(readonly http: HttpClient) {}

  // Project docs (wiki pages + agent memory)
  async listProjectDocs(
    projectId: string,
    params?: { kind?: string; q?: string },
  ): Promise<ListProjectDocsResponse> {
    const search = new URLSearchParams();
    if (params?.kind) search.set("kind", params.kind);
    if (params?.q) search.set("q", params.q);
    const raw = await this.http.fetch<unknown>(
      `/api/projects/${projectId}/docs?${search}`,
    );
    return parseWithFallback(
      raw,
      ListProjectDocsResponseSchema,
      EMPTY_LIST_PROJECT_DOCS_RESPONSE,
      { endpoint: "GET /api/projects/:id/docs" },
    );
  }

  /** Every doc in the workspace, each carrying its project's title. */
  async listWorkspaceDocs(
    params?: { workspaceId?: string; kind?: string; q?: string; limit?: number; includeBody?: boolean },
  ): Promise<ListWorkspaceDocsResponse> {
    const search = new URLSearchParams();
    // Passed explicitly: the server resolves this endpoint's workspace from
    // workspace_id (not the X-Workspace-Slug header), and without it every
    // request would fall back to the token's default workspace.
    if (params?.workspaceId) search.set("workspace_id", params.workspaceId);
    if (params?.kind) search.set("kind", params.kind);
    if (params?.q) search.set("q", params.q);
    if (params?.limit) search.set("limit", String(params.limit));
    if (params?.includeBody === false) search.set("include_body", "false");
    const raw = await this.http.fetch<unknown>(`/api/project-docs?${search}`);
    return parseWithFallback(
      raw,
      ListWorkspaceDocsResponseSchema,
      EMPTY_LIST_WORKSPACE_DOCS_RESPONSE,
      { endpoint: "GET /api/project-docs" },
    );
  }

  /** `ref` is the doc id or its slug — the server resolves both. */
  async getProjectDoc(projectId: string, ref: string): Promise<ProjectDoc> {
    const raw = await this.http.fetch<unknown>(
      `/api/projects/${projectId}/docs/${encodeURIComponent(ref)}`,
    );
    return parseWithFallback(
      raw,
      ProjectDocResponseSchema,
      { doc: EMPTY_PROJECT_DOC },
      { endpoint: "GET /api/projects/:id/docs/:ref" },
    ).doc;
  }

  async listProjectDocRevisions(
    projectId: string,
    ref: string,
  ): Promise<ListProjectDocRevisionsResponse> {
    const raw = await this.http.fetch<unknown>(
      `/api/projects/${projectId}/docs/${encodeURIComponent(ref)}/revisions`,
    );
    return parseWithFallback(
      raw,
      ListProjectDocRevisionsResponseSchema,
      EMPTY_LIST_PROJECT_DOC_REVISIONS_RESPONSE,
      { endpoint: "GET /api/projects/:id/docs/:ref/revisions" },
    );
  }

  async listProjectDocBacklinks(projectId: string, ref: string): Promise<ProjectDoc[]> {
    const raw = await this.http.fetch<unknown>(
      `/api/projects/${projectId}/docs/${encodeURIComponent(ref)}/backlinks`,
    );
    return parseWithFallback(
      raw,
      ListProjectDocsResponseSchema,
      EMPTY_LIST_PROJECT_DOCS_RESPONSE,
      { endpoint: "GET /api/projects/:id/docs/:ref/backlinks" },
    ).docs;
  }
}
