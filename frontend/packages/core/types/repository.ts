export type WorkspaceRepositorySource = "github" | "codebase";

export interface WorkspaceRepository {
  id: string;
  name: string;
  url: string;
  source: WorkspaceRepositorySource | "unknown";
  description: string | null;
  default_branch: string | null;
  imported_at: string | null;
  updated_at: string | null;
}

export interface WorkspaceRepositoryListResponse {
  repositories: WorkspaceRepository[];
  total: number;
}

export interface ImportWorkspaceRepositoryRequest {
  url: string;
  name?: string;
  description?: string;
}

export interface RepositoryMutationResponse {
  repository: WorkspaceRepository | null;
}
