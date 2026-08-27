import { z } from "zod";

export const SessionArchiveSchema = z.object({
  id: z.string().default(""),
  workspace_id: z.string().default(""),
  issue_id: z.string().default(""),
  runtime_id: z.string().default(""),
  daemon_id: z.string().nullable().default(null),
  source_revision: z.string().default(""),
  sha256: z.string().default(""),
  size_bytes: z.number().default(0),
  uploaded_size_bytes: z.number().default(0),
  file_count: z.number().nullable().default(null),
  status: z.string().default("unknown"),
  relative_path: z.string().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
  attempt_count: z.number().default(0),
  last_error: z.string().nullable().default(null),
  next_retry_at: z.string().nullable().default(null),
  retry_exhausted_at: z.string().nullable().default(null),
  retry_state: z.enum(["eligible", "backoff", "exhausted"]).catch("eligible").default("eligible"),
  created_at: z.string().default(""),
  updated_at: z.string().default(""),
  completed_at: z.string().nullable().default(null),
}).loose();

export type SessionArchive = z.infer<typeof SessionArchiveSchema>;

const SessionArchiveConfigSchema = z.object({
  backend: z.string().default("unknown"),
  root_hint: z.string().default(""),
  require_archive: z.boolean().nullable().default(null),
  max_bytes: z.number().nullable().default(null),
  min_free_bytes: z.number().nullable().default(null),
  workspace_ttl_ms: z.number().nullable().default(null),
  gc_interval_ms: z.number().nullable().default(null),
}).loose();

const SessionArchiveUsageSchema = z.object({
  total_archives: z.number().default(0),
  ready_archives: z.number().default(0),
  failed_archives: z.number().default(0),
  pending_archives: z.number().default(0),
  exhausted_archives: z.number().default(0),
  total_bytes: z.number().default(0),
}).loose();

const SessionArchiveFailureSchema = z.object({
  archive_id: z.string().default(""),
  issue_id: z.string().default(""),
  issue_key: z.string().nullable().default(null),
  error: z.string().default(""),
  updated_at: z.string().default(""),
}).loose();

export const WorkspaceSessionArchiveStatusSchema = z.object({
  config: SessionArchiveConfigSchema.default({
    backend: "unknown",
    root_hint: "",
    require_archive: null,
    max_bytes: null,
    min_free_bytes: null,
    workspace_ttl_ms: null,
    gc_interval_ms: null,
  }),
  usage: SessionArchiveUsageSchema.default({
    total_archives: 0,
    ready_archives: 0,
    failed_archives: 0,
    pending_archives: 0,
    exhausted_archives: 0,
    total_bytes: 0,
  }),
  last_failure: SessionArchiveFailureSchema.nullable().default(null),
}).loose();

export const WorkspaceSessionArchiveMutationResponseSchema = z.object({
  config: SessionArchiveConfigSchema,
  usage: SessionArchiveUsageSchema,
  last_failure: SessionArchiveFailureSchema.nullable(),
}).loose();

export type WorkspaceSessionArchiveStatus = z.infer<
  typeof WorkspaceSessionArchiveStatusSchema
>;

export const EMPTY_WORKSPACE_SESSION_ARCHIVE_STATUS: WorkspaceSessionArchiveStatus = {
  config: {
    backend: "unknown",
    root_hint: "",
    require_archive: null,
    max_bytes: null,
    min_free_bytes: null,
    workspace_ttl_ms: null,
    gc_interval_ms: null,
  },
  usage: {
    total_archives: 0,
    ready_archives: 0,
    failed_archives: 0,
    pending_archives: 0,
    exhausted_archives: 0,
    total_bytes: 0,
  },
  last_failure: null,
};

export const IssueSessionArchivesResponseSchema = z.object({
  archives: z.array(SessionArchiveSchema).default([]),
  latest: SessionArchiveSchema.nullable().default(null),
  latest_ready: SessionArchiveSchema.nullable().default(null),
}).loose();

export type IssueSessionArchivesResponse = z.infer<
  typeof IssueSessionArchivesResponseSchema
>;

export const EMPTY_ISSUE_SESSION_ARCHIVES: IssueSessionArchivesResponse = {
  archives: [],
  latest: null,
  latest_ready: null,
};

export const SessionArchiveVerifyResponseSchema = z.object({
  archive: SessionArchiveSchema,
  valid: z.boolean().default(false),
  actual_sha256: z.string().nullable().default(null),
  actual_size_bytes: z.number().nullable().default(null),
  error: z.string().nullable().default(null),
}).loose();

export type SessionArchiveVerifyResponse = z.infer<
  typeof SessionArchiveVerifyResponseSchema
>;

export const SessionArchiveRetryResponseSchema = z.object({
  archive: SessionArchiveSchema,
}).loose();

export type SessionArchiveRetryResponse = z.infer<
  typeof SessionArchiveRetryResponseSchema
>;
