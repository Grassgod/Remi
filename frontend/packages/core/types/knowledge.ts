export interface KnowledgeIssueSummary {
  id: string;
  key: string;
  title: string;
}

export interface KnowledgeAgentSummary {
  id: string;
  name: string;
}

export interface KnowledgeTaskSummary {
  id: string;
  status: string;
}

export interface KnowledgeRunProvenance {
  automation_id: string;
  automation_title: string | null;
  automation_run_id: string;
  automation_source: string;
  event_type: string | null;
  repository_id: string | null;
  repository_name: string | null;
  change_number: number | null;
  change_title: string | null;
  change_url: string | null;
  target_branch: string | null;
  source_revision: string | null;
  occurred_at: string | null;
}

export interface KnowledgeSubmission {
  id: string;
  workspace_id: string;
  project_id: string | null;
  repository_id: string | null;
  scope: string;
  source_type: string;
  proposed_path: string | null;
  proposed_slug: string | null;
  body: string;
  patch: string | null;
  base_revision: string | null;
  source_task_id: string | null;
  source_issue_id: string | null;
  source_revision: string | null;
  author_agent_id: string | null;
  content_sha256: string;
  status: string;
  created_at: string;
  updated_at: string;
  source_issue: KnowledgeIssueSummary | null;
  author_agent: KnowledgeAgentSummary | null;
  source_task: KnowledgeTaskSummary | null;
}

export interface KnowledgeCompilationRun {
  id: string;
  workspace_id: string;
  project_id: string | null;
  repository_id: string | null;
  task_id: string | null;
  agent_id: string | null;
  autopilot_run_id: string | null;
  mode: string;
  status: string;
  result_summary: string | null;
  dedupe_key: string | null;
  created_at: string;
  completed_at: string | null;
  agent: KnowledgeAgentSummary | null;
  provenance: KnowledgeRunProvenance | null;
}

export interface KnowledgeCompilationSource {
  id: string;
  run_id: string;
  submission_id: string | null;
  source_type: string;
  source_ref: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  submission: KnowledgeSubmission | null;
}

export interface KnowledgeArtifactSummary {
  id: string;
  title: string;
  path: string;
}

export interface KnowledgeCompilationOutput {
  id: string;
  run_id: string;
  artifact_scope: string;
  doc_id: string | null;
  revision_id: string | null;
  version: number | null;
  action: string;
  content_sha256: string | null;
  created_at: string;
  artifact: KnowledgeArtifactSummary | null;
}

export interface KnowledgeRunDetail {
  run: KnowledgeCompilationRun;
  sources: KnowledgeCompilationSource[];
  outputs: KnowledgeCompilationOutput[];
}

export interface ListKnowledgeSubmissionsResponse {
  submissions: KnowledgeSubmission[];
}

export interface GetKnowledgeSubmissionResponse {
  submission: KnowledgeSubmission | null;
}

export interface ListKnowledgeRunsResponse {
  runs: KnowledgeRunDetail[];
}
