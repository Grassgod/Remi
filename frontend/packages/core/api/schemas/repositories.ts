import { z } from "zod";
import type {
  AtlasWikiSetupStatus,
  RepositoryWikiBuildResponse,
  RepositoryInspectionResponse,
  RepositoryMutationResponse,
  WorkspaceRepositoryListResponse,
} from "../../types";

export const workspaceRepositorySchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  source: z.string().transform((source) =>
    source === "github" || source === "codebase" ? source : "unknown"
  ),
  description: z.string().nullable().default(null),
  default_branch: z.string().nullable().default(null),
  imported_at: z.string().nullable().default(null),
  updated_at: z.string().nullable().default(null),
}).loose();

export const repositoryListResponseSchema = z.object({
  repositories: z.array(workspaceRepositorySchema),
  total: z.number(),
}).loose();

export const repositoryMutationResponseSchema = z.object({
  repository: workspaceRepositorySchema,
}).loose();

export const repositoryInspectionResponseSchema = z.object({
  metadata: z.object({
    url: z.string(),
    name: z.string(),
    default_branch: z.string(),
    branches: z.array(z.string()),
  }).loose(),
}).loose();

export const repositoryWikiStatusSchema = z.enum(["unbuilt", "building", "healthy", "stale", "failed"]);

export const repositoryWikiSummarySchema = z.object({
  repository_id: z.string(),
  repository_name: z.string(),
  status: repositoryWikiStatusSchema,
  status_message: z.string().nullable().default(null),
  source_revision: z.string().nullable().default(null),
  page_count: z.number().int().nonnegative(),
  updated_at: z.string().nullable().default(null),
}).loose();

export const repositoryWikiDocSchema = z.object({
  id: z.string(),
  repository_id: z.string(),
  workspace_id: z.string(),
  path: z.string(),
  slug: z.string(),
  title: z.string(),
  summary: z.string().nullable().default(null),
  body: z.string(),
  tags: z.array(z.string()).default([]),
  refs: z.array(z.object({ type: z.string(), value: z.string() }).loose()).default([]),
  source_revision: z.string().nullable().default(null),
  status: repositoryWikiStatusSchema,
  status_message: z.string().nullable().default(null),
  version: z.number().int().positive(),
  updated_at: z.string(),
}).loose();

export const repositoryWikiSummariesResponseSchema = z.object({
  repositories: z.array(repositoryWikiSummarySchema),
}).loose();

export const repositoryWikiDocsResponseSchema = z.object({ docs: z.array(repositoryWikiDocSchema) }).loose();

export const repositoryWikiDocResponseSchema = z.object({ doc: repositoryWikiDocSchema }).loose();

export const repositoryWikiRevisionsResponseSchema = z.object({
  revisions: z.array(z.object({
    id: z.string(), doc_id: z.string(), version: z.number().int().positive(), path: z.string(),
    title: z.string(), summary: z.string().nullable().default(null), body: z.string(),
    source_revision: z.string().nullable().default(null), created_at: z.string(),
  }).loose()),
}).loose();

export const atlasWikiSetupStatusSchema = z.object({
  state: z.enum(["not_configured", "plugin_required", "scm_connection_required", "incomplete", "ready"]),
  configured: z.boolean(),
  required_plugin: z.string().default("code-to-wiki"),
  plugin_id: z.string().nullable().default(null),
  plugin_bound: z.boolean().default(false),
  agent_id: z.string().nullable().default(null),
  repository_autopilot_id: z.string().nullable().default(null),
  repository_trigger_id: z.string().nullable().default(null),
  project_autopilot_id: z.string().nullable().default(null),
  project_trigger_id: z.string().nullable().default(null),
  scm_warning: z.string().nullable().optional(),
}).loose();

export const repositoryWikiBuildResponseSchema = z.object({
  run_id: z.string(),
  task_id: z.string().nullable().default(null),
  status: z.enum(["issue_created", "running", "completed", "failed", "skipped"]),
}).loose();

export const EMPTY_REPOSITORY_WIKI_BUILD_RESPONSE: RepositoryWikiBuildResponse = {
  run_id: "",
  task_id: null,
  status: "skipped",
};

export const EMPTY_ATLAS_WIKI_SETUP_STATUS: AtlasWikiSetupStatus = {
  state: "not_configured",
  configured: false,
  required_plugin: "code-to-wiki",
  plugin_id: null,
  plugin_bound: false,
  agent_id: null,
  repository_autopilot_id: null,
  repository_trigger_id: null,
  project_autopilot_id: null,
  project_trigger_id: null,
};

export const EMPTY_REPOSITORY_LIST_RESPONSE: WorkspaceRepositoryListResponse = {
  repositories: [],
  total: 0,
};

export const EMPTY_REPOSITORY_MUTATION_RESPONSE: RepositoryMutationResponse = {
  repository: null,
};

export const EMPTY_REPOSITORY_INSPECTION_RESPONSE: RepositoryInspectionResponse = {
  metadata: null,
};
