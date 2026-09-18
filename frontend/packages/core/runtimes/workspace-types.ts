export interface RuntimeWorkspace {
  id: string;
  workspace_id: string;
  daemon_id: string;
  owner_id: string;
  name: string;
  root_path: string;
  cwd: string;
  context_paths: string[];
  env_file: string | null;
  project_id: string | null;
  archived_at: string | null;
  status: string;
  runtime_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface CreateRuntimeWorkspaceRequest {
  name: string;
  root_path: string;
  cwd?: string;
  context_paths?: string[];
  env_file?: string | null;
  project_id?: string | null;
}
