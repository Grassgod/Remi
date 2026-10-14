import { z } from "zod";

const StorageSubjectRefSchema = z.object({
  kind: z.string(),
  id: z.string(),
}).loose();

const StoragePlanItemSchema = z.object({
  subject: StorageSubjectRefSchema,
  action: z.string(),
  reason: z.string(),
  bytes: z.number().nullable().default(null),
  unsaved_work: z.boolean().default(false),
}).loose();

export const StorageReportSchema = z.object({
  version: z.number(),
  generated_at: z.string(),
  mode: z.string(),
  root: z.string().default(""),
  bytes: z.object({
    work: z.number(),
    env: z.number(),
    traces: z.number(),
    shared: z.number(),
    legacy: z.number(),
  }).loose().nullable().default(null),
  bytes_measured_at: z.string().nullable().default(null),
  subjects: z.object({
    total: z.number(),
    active: z.number(),
    ended: z.number(),
    reclaimed: z.number(),
  }).loose(),
  retained: z.record(z.string(), z.number()).default({}),
  reclaimed_this_round: z.number().default(0),
  forgotten_this_round: z.number().default(0),
  freed_bytes: z.number().default(0),
  plan: z.array(StoragePlanItemSchema).default([]),
  errors: z.array(z.object({
    subject_id: z.string().nullable().default(null),
    message: z.string(),
  }).loose()).default([]),
}).loose();

const StorageSettingsOverridesSchema = z.object({
  ttl_ms: z.number().optional(),
  automation_ttl_ms: z.number().optional(),
  max_retained: z.number().optional(),
  orphan_ttl_ms: z.number().optional(),
  snapshot_max_bytes: z.number().optional(),
  chat_idle_days: z.number().optional(),
}).loose();

export const WorkspaceStorageResponseSchema = z.object({
  settings: z.object({
    ttl_ms: z.number(),
    automation_ttl_ms: z.number(),
    max_retained: z.number(),
    orphan_ttl_ms: z.number(),
    snapshot_max_bytes: z.number(),
    chat_idle_days: z.number(),
  }).loose(),
  overrides: StorageSettingsOverridesSchema.default({}),
}).loose();

// The server stores each daemon's report as sent, so the report is validated
// per daemon by the endpoint: one malformed report must not hide the others.
export const WorkspaceStorageDaemonsResponseSchema = z.object({
  daemons: z.array(z.object({
    daemon_id: z.string(),
    name: z.string().default(""),
    runtime_ids: z.array(z.string()).default([]),
    online: z.boolean().default(false),
    report: z.unknown().default(null),
    reported_at: z.string().nullable().default(null),
  }).loose()),
}).loose();

export const GcRunRequestSchema = z.object({
  id: z.string(),
  runtime_id: z.string(),
  daemon_id: z.string().nullable().default(null),
  mode: z.string(),
  status: z.string(),
  requested_by: z.string().nullable().default(null),
  created_at: z.string(),
  completed_at: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  report: StorageReportSchema.nullable().default(null),
}).loose();

export const GcRunResponseSchema = z.object({
  request: GcRunRequestSchema,
}).loose();
