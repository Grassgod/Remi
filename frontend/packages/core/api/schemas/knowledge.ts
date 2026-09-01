import { z } from "zod";
import type {
  GetKnowledgeSubmissionResponse,
  KnowledgeRunDetail,
  ListKnowledgeRunsResponse,
  ListKnowledgeSubmissionsResponse,
} from "../../types";

const nullableString = z.string().nullable().catch(null).default(null);

const KnowledgeIssueSummarySchema = z.object({
  id: z.string(),
  key: z.string().default(""),
  title: z.string().default(""),
}).loose();

const KnowledgeAgentSummarySchema = z.object({
  id: z.string(),
  name: z.string().default(""),
}).loose();

const KnowledgeTaskSummarySchema = z.object({
  id: z.string(),
  status: z.string().default("unknown"),
}).loose();

const KnowledgeRunProvenanceSchema = z.object({
  automation_id: z.string(),
  automation_title: nullableString,
  automation_run_id: z.string(),
  automation_source: z.string().catch("unknown").default("unknown"),
  event_type: nullableString,
  repository_id: nullableString,
  repository_name: nullableString,
  change_number: z.number().int().positive().nullable().catch(null).default(null),
  change_title: nullableString,
  change_url: nullableString,
  target_branch: nullableString,
  source_revision: nullableString,
  occurred_at: nullableString,
}).loose();

export const KnowledgeSubmissionSchema = z.object({
  id: z.string(),
  workspace_id: z.string().default(""),
  project_id: nullableString,
  repository_id: nullableString,
  scope: z.string().catch("unknown").default("unknown"),
  source_type: z.string().catch("unknown").default("unknown"),
  proposed_path: nullableString,
  proposed_slug: nullableString,
  body: z.string().catch("").default(""),
  patch: nullableString,
  base_revision: nullableString,
  source_task_id: nullableString,
  source_issue_id: nullableString,
  source_revision: nullableString,
  author_agent_id: nullableString,
  content_sha256: z.string().catch("").default(""),
  status: z.string().catch("unknown").default("unknown"),
  created_at: z.string().catch("").default(""),
  updated_at: z.string().catch("").default(""),
  source_issue: KnowledgeIssueSummarySchema.nullable().catch(null).default(null),
  author_agent: KnowledgeAgentSummarySchema.nullable().catch(null).default(null),
  source_task: KnowledgeTaskSummarySchema.nullable().catch(null).default(null),
}).loose();

export const KnowledgeCompilationRunSchema = z.object({
  id: z.string(),
  workspace_id: z.string().default(""),
  project_id: nullableString,
  repository_id: nullableString,
  task_id: nullableString,
  agent_id: nullableString,
  autopilot_run_id: nullableString,
  mode: z.string().catch("unknown").default("unknown"),
  status: z.string().catch("unknown").default("unknown"),
  result_summary: nullableString,
  dedupe_key: nullableString,
  created_at: z.string().catch("").default(""),
  completed_at: nullableString,
  agent: KnowledgeAgentSummarySchema.nullable().catch(null).default(null),
  skill_names: z.array(z.string()).catch([]).default([]),
  provenance: KnowledgeRunProvenanceSchema.nullable().catch(null).default(null),
}).loose();

export const KnowledgeCompilationSourceSchema = z.object({
  id: z.string(),
  run_id: z.string().default(""),
  submission_id: nullableString,
  source_type: z.string().catch("unknown").default("unknown"),
  source_ref: nullableString,
  metadata: z.record(z.string(), z.unknown()).catch({}).default({}),
  created_at: z.string().catch("").default(""),
  submission: KnowledgeSubmissionSchema.nullable().catch(null).default(null),
}).loose();

export const KnowledgeCompilationOutputSchema = z.object({
  id: z.string(),
  run_id: z.string().default(""),
  artifact_scope: z.string().catch("unknown").default("unknown"),
  doc_id: nullableString,
  revision_id: nullableString,
  version: z.number().int().positive().nullable().catch(null).default(null),
  action: z.string().catch("unknown").default("unknown"),
  content_sha256: nullableString,
  created_at: z.string().catch("").default(""),
  artifact: z.object({
    id: z.string(),
    title: z.string().default(""),
    path: z.string().default(""),
  }).loose().nullable().catch(null).default(null),
}).loose();

export const KnowledgeRunDetailSchema = z.object({
  run: KnowledgeCompilationRunSchema,
  sources: z.array(KnowledgeCompilationSourceSchema).catch([]).default([]),
  outputs: z.array(KnowledgeCompilationOutputSchema).catch([]).default([]),
}).loose();

function validRows<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (value) => Array.isArray(value)
      ? value.filter((entry) => schema.safeParse(entry).success)
      : [],
    z.array(schema),
  );
}

export const ListKnowledgeSubmissionsResponseSchema = z.object({
  submissions: validRows(KnowledgeSubmissionSchema),
}).loose();

export const GetKnowledgeSubmissionResponseSchema = z.object({
  submission: KnowledgeSubmissionSchema.nullable().catch(null).default(null),
}).loose();

export const ListKnowledgeRunsResponseSchema = z.object({
  runs: z.preprocess(
    (value) => Array.isArray(value)
      ? value.map((entry) => {
          if (entry && typeof entry === "object" && "run" in entry) return entry;
          const relationships = entry && typeof entry === "object"
            ? entry as { sources?: unknown; outputs?: unknown }
            : {};
          return {
            run: entry,
            sources: relationships.sources ?? [],
            outputs: relationships.outputs ?? [],
          };
        }).filter((entry) => KnowledgeRunDetailSchema.safeParse(entry).success)
      : [],
    z.array(KnowledgeRunDetailSchema),
  ),
}).loose();

export const EMPTY_LIST_KNOWLEDGE_SUBMISSIONS: ListKnowledgeSubmissionsResponse = { submissions: [] };
export const EMPTY_GET_KNOWLEDGE_SUBMISSION: GetKnowledgeSubmissionResponse = { submission: null };
export const EMPTY_LIST_KNOWLEDGE_RUNS: ListKnowledgeRunsResponse = { runs: [] };
export const EMPTY_KNOWLEDGE_RUN_DETAIL: KnowledgeRunDetail = {
  run: {
    id: "",
    workspace_id: "",
    project_id: null,
    repository_id: null,
    task_id: null,
    agent_id: null,
    autopilot_run_id: null,
    mode: "unknown",
    status: "unknown",
    result_summary: null,
    dedupe_key: null,
    created_at: "",
    completed_at: null,
    agent: null,
    skill_names: [],
    provenance: null,
  },
  sources: [],
  outputs: [],
};
