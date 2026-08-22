import { z } from "zod";
import type {
  Autopilot,
  AutopilotRun,
  AutopilotTrigger,
  GetAutopilotResponse,
  ListAutopilotRunsResponse,
  ListAutopilotsResponse,
  ListWebhookDeliveriesResponse,
  WebhookDelivery,
} from "../../types";

const AutopilotSystemEventConditionSchema = z.object({
  field: z.literal("status"),
  operator: z.literal("becomes"),
  value: z.string(),
}).loose();

export const AutopilotSystemEventConfigSchema = z.object({
  resource: z.literal("issue"),
  event: z.literal("status_changed"),
  conditions: z.array(AutopilotSystemEventConditionSchema).default([]),
  project_id: z.string().nullable().optional().default(null),
}).loose();

export const AutopilotScmEventConfigSchema = z.object({
  resource: z.literal("scm"),
  events: z.array(z.enum([
    "change.opened",
    "change.updated",
    "change.closed",
    "change.reopened",
    "change.merged",
    "comment.created",
    "comment.updated",
    "comment.deleted",
    "review.submitted",
    "review.dismissed",
    "pipeline.started",
    "pipeline.completed",
    "default_branch.updated",
    "push.observed",
  ])).default([]),
  connectionId: z.string().nullable().optional().default(null),
  repositoryIds: z.array(z.string()).optional().default([]),
  branch: z.string().nullable().optional().default(null),
}).loose();

export const AutopilotEventConfigSchema = z.union([
  AutopilotSystemEventConfigSchema,
  AutopilotScmEventConfigSchema,
]);

export const AutopilotSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  project_id: z.string().nullable().optional().default(null),
  assignee_type: z.enum(["agent", "squad"]).catch("agent").default("agent"),
  assignee_id: z.string(),
  status: z.string(),
  execution_mode: z.string(),
  session_policy: z.enum(["new", "reuse_latest"]).catch("new").default("new"),
  workspace_policy: z.literal("reuse_issue").catch("reuse_issue").default("reuse_issue"),
  issue_title_template: z.string().nullable(),
  created_by_type: z.string(),
  created_by_id: z.string(),
  last_run_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).loose();

export const AutopilotTriggerSchema = z.object({
  id: z.string(),
  autopilot_id: z.string(),
  kind: z.string(),
  enabled: z.boolean(),
  cron_expression: z.string().nullable(),
  timezone: z.string().nullable(),
  next_run_at: z.string().nullable(),
  webhook_token: z.string().nullable(),
  webhook_path: z.string().nullable().optional(),
  webhook_url: z.string().nullable().optional(),
  label: z.string().nullable(),
  event_filters: z.array(z.object({
    event: z.string(),
    actions: z.array(z.string()).optional(),
  }).loose()).nullable().optional(),
  event_config: AutopilotEventConfigSchema.nullable().catch(null).default(null),
  last_fired_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).loose();

export const AutopilotRunSchema = z.object({
  id: z.string(),
  autopilot_id: z.string(),
  trigger_id: z.string().nullable().default(null),
  source: z.string(),
  status: z.string(),
  issue_id: z.string().nullable(),
  issue_session_id: z.string().nullable().default(null),
  task_id: z.string().nullable(),
  triggered_at: z.string(),
  completed_at: z.string().nullable(),
  failure_reason: z.string().nullable(),
  trigger_payload: z.unknown().default(null),
  result: z.unknown().default(null),
  created_at: z.string(),
}).loose();

export const ListAutopilotsResponseSchema = z.object({
  autopilots: z.array(AutopilotSchema).default([]),
  total: z.number().default(0),
}).loose();

export const GetAutopilotResponseSchema = z.object({
  autopilot: AutopilotSchema,
  triggers: z.array(AutopilotTriggerSchema).default([]),
}).loose();

export const ListAutopilotRunsResponseSchema = z.object({
  runs: z.array(AutopilotRunSchema).default([]),
  total: z.number().default(0),
}).loose();

export const EMPTY_AUTOPILOT: Autopilot = {
  id: "",
  workspace_id: "",
  title: "",
  description: null,
  project_id: null,
  assignee_type: "agent",
  assignee_id: "",
  status: "paused",
  execution_mode: "create_issue",
  session_policy: "new",
  workspace_policy: "reuse_issue",
  issue_title_template: null,
  created_by_type: "system",
  created_by_id: "",
  last_run_at: null,
  created_at: "",
  updated_at: "",
};

export const EMPTY_AUTOPILOT_TRIGGER: AutopilotTrigger = {
  id: "",
  autopilot_id: "",
  kind: "api",
  enabled: false,
  cron_expression: null,
  timezone: null,
  next_run_at: null,
  webhook_token: null,
  label: null,
  event_config: null,
  last_fired_at: null,
  created_at: "",
  updated_at: "",
};

export const EMPTY_AUTOPILOT_RUN: AutopilotRun = {
  id: "",
  autopilot_id: "",
  trigger_id: null,
  source: "api",
  status: "failed",
  issue_id: null,
  issue_session_id: null,
  task_id: null,
  triggered_at: "",
  completed_at: null,
  failure_reason: null,
  trigger_payload: null,
  result: null,
  created_at: "",
};

export const EMPTY_LIST_AUTOPILOTS_RESPONSE: ListAutopilotsResponse = {
  autopilots: [],
  total: 0,
};

export const EMPTY_GET_AUTOPILOT_RESPONSE: GetAutopilotResponse = {
  autopilot: EMPTY_AUTOPILOT,
  triggers: [],
};

export const EMPTY_LIST_AUTOPILOT_RUNS_RESPONSE: ListAutopilotRunsResponse = {
  runs: [],
  total: 0,
};

// ---------------------------------------------------------------------------
// Webhook delivery schemas — backing the Autopilot Deliveries section. Enums
// (`status`, `signature_status`, `provider`) are kept as `z.string()` so a
// future server-side value (e.g. a Stripe provider, a new dedupe state)
// degrades to a generic UI fallback rather than collapsing the list into
// the empty array. `.loose()` lets unknown fields pass through, matching
// the rule used by every other endpoint here.
// ---------------------------------------------------------------------------

const WebhookDeliverySchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  autopilot_id: z.string(),
  trigger_id: z.string(),
  provider: z.string(),
  event: z.string(),
  dedupe_key: z.string().nullable(),
  dedupe_source: z.string().nullable(),
  signature_status: z.string(),
  status: z.string(),
  attempt_count: z.number().default(0),
  content_type: z.string().nullable(),
  response_status: z.number().nullable(),
  autopilot_run_id: z.string().nullable(),
  replayed_from_delivery_id: z.string().nullable(),
  error: z.string().nullable(),
  received_at: z.string(),
  last_attempt_at: z.string(),
  created_at: z.string(),
  // Detail-only fields. The list endpoint omits them; the detail endpoint
  // populates raw_body / selected_headers / response_body.
  selected_headers: z.record(z.string(), z.unknown()).nullable().optional(),
  raw_body: z.string().nullable().optional(),
  response_body: z.string().nullable().optional(),
}).loose();

export const ListWebhookDeliveriesResponseSchema = z.object({
  deliveries: z.array(WebhookDeliverySchema).default([]),
  total: z.number().default(0),
}).loose();

export const WebhookDeliveryResponseSchema = WebhookDeliverySchema;

export const EMPTY_LIST_WEBHOOK_DELIVERIES_RESPONSE: ListWebhookDeliveriesResponse = {
  deliveries: [],
  total: 0,
};

export const EMPTY_WEBHOOK_DELIVERY: WebhookDelivery = {
  id: "",
  workspace_id: "",
  autopilot_id: "",
  trigger_id: "",
  provider: "",
  event: "",
  dedupe_key: null,
  dedupe_source: null,
  signature_status: "not_required",
  status: "queued",
  attempt_count: 0,
  content_type: null,
  response_status: null,
  autopilot_run_id: null,
  replayed_from_delivery_id: null,
  error: null,
  received_at: "",
  last_attempt_at: "",
  created_at: "",
};
