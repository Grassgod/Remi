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
  default_branch?: string;
}

export interface WorkspaceRepositoryMetadata {
  url: string;
  name: string;
  default_branch: string;
  branches: string[];
}

export interface RepositoryInspectionResponse {
  metadata: WorkspaceRepositoryMetadata | null;
}

export interface UpdateWorkspaceRepositoryRequest {
  default_branch?: string;
  description?: string | null;
}

export interface RepositoryMutationResponse {
  repository: WorkspaceRepository | null;
}

export type RepositoryWikiStatus = "unbuilt" | "building" | "healthy" | "stale" | "failed";

// Server-driven build lifecycle for a repository wiki. `idle` covers both
// "never built" and "last build finished fine"; `queued`/`building` are the
// active states the UI polls on; `failed` carries `failure_reason`.
export type RepositoryWikiBuildStatus = "idle" | "queued" | "building" | "failed";

export interface RepositoryWikiBuildInfo {
  status: RepositoryWikiBuildStatus;
  run_id: string | null;
  task_id: string | null;
  failure_reason: string | null;
  started_at: string | null;
  updated_at: string | null;
  source_revision: string | null;
  // Null while the run is active or when talking to an older server.
  published: boolean | null;
}

export interface RepositoryWikiSummary {
  repository_id: string;
  repository_name: string;
  status: RepositoryWikiStatus;
  status_message: string | null;
  source_revision: string | null;
  page_count: number;
  updated_at: string | null;
  // Null when talking to an older server that predates build reporting.
  build: RepositoryWikiBuildInfo | null;
}

export interface RepositoryWikiDoc {
  id: string;
  repository_id: string;
  workspace_id: string;
  path: string;
  slug: string;
  title: string;
  summary: string | null;
  body: string;
  tags: string[];
  refs: Array<{ type: string; value: string }>;
  source_revision: string | null;
  status: RepositoryWikiStatus;
  status_message: string | null;
  compilation_run_id: string | null;
  version: number;
  updated_at: string;
}

export interface RepositoryWikiRevision {
  id: string;
  doc_id: string;
  version: number;
  path: string;
  title: string;
  summary: string | null;
  body: string;
  source_revision: string | null;
  compilation_run_id: string | null;
  created_at: string;
}

export interface RepositoryWikiBuildResponse {
  run_id: string;
  task_id: string | null;
  status: "issue_created" | "running" | "completed" | "failed" | "skipped";
}
