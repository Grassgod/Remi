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

export interface RepositoryWikiSummary {
  repository_id: string;
  repository_name: string;
  status: RepositoryWikiStatus;
  status_message: string | null;
  source_revision: string | null;
  page_count: number;
  updated_at: string | null;
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
  created_at: string;
}

export type AtlasWikiSetupState =
  | "not_configured"
  | "plugin_required"
  | "scm_connection_required"
  | "incomplete"
  | "ready";

export interface AtlasWikiSetupStatus {
  state: AtlasWikiSetupState;
  configured: boolean;
  required_plugin: string;
  plugin_id: string | null;
  plugin_bound: boolean;
  agent_id: string | null;
  repository_autopilot_id: string | null;
  repository_trigger_id: string | null;
  project_autopilot_id: string | null;
  project_trigger_id: string | null;
  scm_warning?: string | null;
}

export interface RepositoryWikiBuildResponse {
  run_id: string;
  task_id: string | null;
  status: "issue_created" | "running" | "completed" | "failed" | "skipped";
}
