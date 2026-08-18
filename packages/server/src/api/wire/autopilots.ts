// Wire serializers for the autopilots domain, moved verbatim out of api.ts.
// Go-compat (`*Compatibility*`) and native shapers sit side by side on purpose:
// the two route prefixes are intentionally divergent and must stay diffable.
import type {
  CreateAutopilotInput,
  CreateAutopilotTriggerInput,
  MultiremiAutopilot,
  MultiremiAutopilotRun,
  MultiremiAutopilotTrigger,
  MultiremiWebhookProvider,
  UpdateAutopilotInput,
  UpdateAutopilotTriggerInput,
} from "@multiremi/contracts/types.js";
import type { Context } from "hono";
import { cleanString, currentAccessToken, currentRequestUserId, hasOwn } from "./context.js";

export function autopilotCreateInput(c: Context, input: CreateAutopilotInput): CreateAutopilotInput {
  const workspaceId = cleanString(input.workspaceId) ??
    cleanString(input.workspace_id) ??
    currentAccessToken(c)?.workspaceId ??
    "local";
  return {
    ...input,
    workspaceId,
    createdByType: input.createdByType ?? input.created_by_type ?? "member",
    createdById: input.createdById ?? input.created_by_id ?? currentRequestUserId(c),
  };
}

export type AutopilotCompatibilityUpdateInput = {
  project_id?: string | null;
  assignee_type?: UpdateAutopilotInput["assigneeType"] | null;
  assignee_id?: string | null;
  execution_mode?: UpdateAutopilotInput["executionMode"] | null;
  session_policy?: UpdateAutopilotInput["sessionPolicy"] | null;
  workspace_policy?: UpdateAutopilotInput["workspacePolicy"] | null;
  issue_title_template?: string | null;
  trigger_kind?: string | null;
  trigger_label?: string | null;
  cron_expression?: string | null;
};

export function autopilotCompatibilityResponse(autopilot: MultiremiAutopilot): Record<string, unknown> {
  return {
    id: autopilot.id,
    workspace_id: autopilot.workspaceId,
    title: autopilot.title,
    description: autopilot.description,
    project_id: autopilot.projectId,
    assignee_type: autopilot.assigneeType,
    assignee_id: autopilot.assigneeId,
    status: autopilot.status,
    execution_mode: autopilot.executionMode,
    session_policy: autopilot.sessionPolicy,
    workspace_policy: autopilot.workspacePolicy,
    issue_title_template: autopilot.issueTitleTemplate,
    created_by_type: autopilot.createdByType,
    created_by_id: autopilot.createdById,
    last_run_at: autopilot.lastRunAt,
    created_at: autopilot.createdAt,
    updated_at: autopilot.updatedAt,
  };
}

export function autopilotCreateCompatibilityInput(
  c: Context,
  input: CreateAutopilotInput,
): CreateAutopilotInput | { apiError: string; statusCode: 400 } {
  if (!cleanString(input.title)) return { apiError: "title is required", statusCode: 400 };
  const assigneeId = cleanString(input.assignee_id);
  if (!assigneeId) return { apiError: "assignee_id is required", statusCode: 400 };
  const executionMode = cleanString(input.execution_mode);
  if (!executionMode) return { apiError: "execution_mode is required", statusCode: 400 };
  if (!isAutopilotExecutionMode(executionMode)) {
    return { apiError: "execution_mode must be create_issue, trigger_issue, or run_only", statusCode: 400 };
  }
  const sessionPolicy = cleanString(input.session_policy) ?? "new";
  if (!isAutopilotSessionPolicy(sessionPolicy)) return { apiError: "session_policy must be new or reuse_latest", statusCode: 400 };
  const workspacePolicy = cleanString(input.workspace_policy) ?? "reuse_issue";
  if (!isAutopilotWorkspacePolicy(workspacePolicy)) return { apiError: "workspace_policy must be reuse_issue", statusCode: 400 };
  const assigneeType = cleanString(input.assignee_type) ?? "agent";
  if (!isAutopilotAssigneeType(assigneeType)) return { apiError: "assignee_type must be agent or squad", statusCode: 400 };
  const issueTitleTemplate = input.issue_title_template ?? null;
  const templateError = validateIssueTitleTemplateCompatibility(issueTitleTemplate);
  if (templateError) return { apiError: templateError, statusCode: 400 };
  const projectId = cleanString(input.project_id) ?? null;
  return autopilotCreateInput(c, {
    id: input.id,
    title: input.title,
    description: input.description,
    workspace_id: input.workspace_id,
    status: input.status,
    projectId,
    project_id: projectId,
    assigneeType,
    assignee_type: assigneeType,
    assigneeId,
    assignee_id: assigneeId,
    executionMode,
    execution_mode: executionMode,
    sessionPolicy,
    session_policy: sessionPolicy,
    workspacePolicy,
    workspace_policy: workspacePolicy,
    issueTitleTemplate,
    issue_title_template: issueTitleTemplate,
    triggerKind: input.trigger_kind,
    trigger_kind: input.trigger_kind,
    triggerLabel: input.trigger_label ?? null,
    trigger_label: input.trigger_label ?? null,
    cronExpression: input.cron_expression ?? null,
    cron_expression: input.cron_expression ?? null,
    created_by_type: input.created_by_type,
    created_by_id: input.created_by_id,
  });
}

export function autopilotUpdateCompatibilityInput(
  input: UpdateAutopilotInput & AutopilotCompatibilityUpdateInput,
): UpdateAutopilotInput | { apiError: string; statusCode: 400 } {
  const output: UpdateAutopilotInput = {};
  if (hasOwn(input, "title")) output.title = input.title;
  if (hasOwn(input, "description")) output.description = input.description ?? null;
  if (hasOwn(input, "project_id")) output.projectId = cleanString(input.project_id ?? undefined) ?? null;

  const assigneeTypeSent = hasOwn(input, "assignee_type");
  const assigneeIdSent = hasOwn(input, "assignee_id");
  if (assigneeTypeSent) {
    const assigneeType = cleanString(input.assignee_type);
    if (assigneeType && !isAutopilotAssigneeType(assigneeType)) return { apiError: "assignee_type must be agent or squad", statusCode: 400 };
    if (!assigneeIdSent) return { apiError: "assignee_id is required when changing assignee_type", statusCode: 400 };
    if (assigneeType && isAutopilotAssigneeType(assigneeType)) output.assigneeType = assigneeType;
  }
  if (assigneeIdSent) {
    const assigneeId = cleanString(input.assignee_id);
    if (!assigneeId) return { apiError: "assignee_id cannot be null", statusCode: 400 };
    output.assigneeId = assigneeId;
  }
  if (hasOwn(input, "status")) {
    if (input.status && !isAutopilotStatus(input.status)) return { apiError: "status must be active, paused, or archived", statusCode: 400 };
    output.status = input.status;
  }
  if (hasOwn(input, "execution_mode")) {
    const executionMode = cleanString(input.execution_mode);
    if (executionMode && !isAutopilotExecutionMode(executionMode)) {
      return { apiError: "execution_mode must be create_issue, trigger_issue, or run_only", statusCode: 400 };
    }
    if (executionMode && isAutopilotExecutionMode(executionMode)) output.executionMode = executionMode;
  }
  if (hasOwn(input, "session_policy")) {
    const sessionPolicy = cleanString(input.session_policy);
    if (sessionPolicy && !isAutopilotSessionPolicy(sessionPolicy)) {
      return { apiError: "session_policy must be new or reuse_latest", statusCode: 400 };
    }
    if (sessionPolicy && isAutopilotSessionPolicy(sessionPolicy)) output.sessionPolicy = sessionPolicy;
  }
  if (hasOwn(input, "workspace_policy")) {
    const workspacePolicy = cleanString(input.workspace_policy);
    if (workspacePolicy && !isAutopilotWorkspacePolicy(workspacePolicy)) {
      return { apiError: "workspace_policy must be reuse_issue", statusCode: 400 };
    }
    if (workspacePolicy && isAutopilotWorkspacePolicy(workspacePolicy)) output.workspacePolicy = workspacePolicy;
  }
  if (hasOwn(input, "issue_title_template")) {
    const issueTitleTemplate = input.issue_title_template ?? null;
    const templateError = validateIssueTitleTemplateCompatibility(issueTitleTemplate);
    if (templateError) return { apiError: templateError, statusCode: 400 };
    output.issueTitleTemplate = issueTitleTemplate;
  }
  if (hasOwn(input, "trigger_kind")) output.triggerKind = input.trigger_kind ?? undefined;
  if (hasOwn(input, "trigger_label")) output.triggerLabel = input.trigger_label ?? null;
  if (hasOwn(input, "cron_expression")) output.cronExpression = input.cron_expression ?? null;
  return output;
}

export function autopilotTriggerCompatibilityResponse(trigger: MultiremiAutopilotTrigger): Record<string, unknown> {
  const isWebhook = trigger.kind === "webhook";
  const response: Record<string, unknown> = {
    id: trigger.id,
    autopilot_id: trigger.autopilotId,
    kind: trigger.kind,
    enabled: trigger.enabled,
    cron_expression: trigger.cronExpression,
    timezone: trigger.timezone,
    next_run_at: trigger.nextRunAt,
    webhook_token: trigger.webhookToken,
    webhook_path: trigger.webhookPath,
    webhook_url: trigger.webhookUrl,
    provider: isWebhook ? trigger.provider ?? "generic" : null,
    has_signing_secret: isWebhook ? trigger.signingSecretSet : false,
    signing_secret_hint: isWebhook ? trigger.signingSecretHint : null,
    label: trigger.label,
    last_fired_at: trigger.lastFiredAt,
    created_at: trigger.createdAt,
    updated_at: trigger.updatedAt,
    event_config: trigger.eventConfig,
  };
  if (isWebhook && trigger.eventFilters?.length) response.event_filters = trigger.eventFilters;
  return response;
}

export function autopilotRunCompatibilityResponse(
  run: MultiremiAutopilotRun,
  options: { slim?: boolean } = {},
): Record<string, unknown> {
  return {
    id: run.id,
    autopilot_id: run.autopilotId,
    trigger_id: run.triggerId,
    event_id: run.eventId,
    source: run.source,
    status: run.status,
    issue_id: run.issueId,
    issue_session_id: run.issueSessionId,
    task_id: run.taskId,
    triggered_at: run.triggeredAt,
    completed_at: run.completedAt,
    failure_reason: run.failureReason,
    trigger_payload: options.slim ? null : run.payload,
    result: run.result,
    created_at: run.createdAt,
  };
}

export function validateAutopilotTriggerCompatibilityInput(input: CreateAutopilotTriggerInput): string | null {
  if (!input.kind) return "kind is required";
  if (input.kind !== "schedule" && input.kind !== "webhook" && input.kind !== "system_event") {
    return "kind must be schedule, webhook, or system_event";
  }
  const cronExpression = cleanString(input.cron_expression);
  if (input.kind === "schedule" && !cronExpression) return "cron_expression is required for schedule triggers";
  if (input.kind === "webhook" && cleanString(input.timezone)) return "timezone is not valid for webhook triggers";
  const provider = cleanString(input.provider);
  if (provider) {
    if (input.kind !== "webhook") return "provider is only valid for webhook triggers";
    if (!isAllowedWebhookProvider(provider)) return "provider must be generic or github";
  }
  const eventFilters = input.event_filters;
  if (input.kind !== "webhook" && Array.isArray(eventFilters) && eventFilters.length > 0) {
    return "event_filters is only valid for webhook triggers";
  }
  const eventConfig = input.event_config;
  if (input.kind === "system_event") return validateSystemEventConfig(eventConfig);
  if (eventConfig != null) return "event_config is only valid for system_event triggers";
  return null;
}

export function validateAutopilotTriggerUpdateCompatibilityInput(trigger: MultiremiAutopilotTrigger, input: UpdateAutopilotTriggerInput): string | null {
  const cronExpression = input.cron_expression;
  if (trigger.kind !== "schedule") {
    if (cronExpression != null) return "cron_expression is only valid for schedule triggers";
    if (input.timezone != null) return "timezone is only valid for schedule triggers";
  }
  const eventFilters = input.event_filters;
  if (trigger.kind !== "webhook" && eventFilters != null) return "event_filters is only valid for webhook triggers";
  const eventConfig = input.event_config;
  if (trigger.kind === "system_event") {
    if (eventConfig !== undefined) return validateSystemEventConfig(eventConfig);
  } else if (eventConfig != null) {
    return "event_config is only valid for system_event triggers";
  }
  return null;
}

export function autopilotTriggerCreateCompatibilityInput(input: CreateAutopilotTriggerInput): CreateAutopilotTriggerInput {
  const cronExpression = input.cron_expression ?? null;
  const eventFilters = input.event_filters ?? null;
  const eventConfig = input.event_config ?? null;
  return {
    kind: input.kind,
    cronExpression,
    cron_expression: cronExpression,
    timezone: input.timezone,
    label: input.label,
    provider: input.provider,
    enabled: input.enabled,
    eventFilters,
    event_filters: eventFilters,
    eventConfig,
    event_config: eventConfig,
  };
}

export function autopilotTriggerUpdateCompatibilityInput(input: UpdateAutopilotTriggerInput): UpdateAutopilotTriggerInput {
  const output: UpdateAutopilotTriggerInput = {};
  if (typeof input.enabled === "boolean") output.enabled = input.enabled;
  const cronExpression = input.cron_expression;
  if (cronExpression != null) {
    output.cronExpression = cronExpression;
    output.cron_expression = cronExpression;
  }
  if (input.timezone != null) output.timezone = input.timezone;
  if (input.label != null) output.label = input.label;
  const eventFilters = input.event_filters;
  if (eventFilters != null) {
    output.eventFilters = eventFilters;
    output.event_filters = eventFilters;
  }
  const eventConfig = input.event_config;
  if (eventConfig !== undefined) {
    output.eventConfig = eventConfig;
    output.event_config = eventConfig;
  }
  return output;
}

export function autopilotCompatibilityErrorResponse(c: Context, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("Autopilot not found")) return c.json({ error: "autopilot not found" }, 404);
  if (message.startsWith("Autopilot trigger not found")) return c.json({ error: "trigger not found" }, 404);
  if (message.startsWith("Autopilot trigger is not a webhook")) return c.json({ error: "trigger is not a webhook trigger" }, 400);
  if (message.startsWith("Project not found")) return c.json({ error: "project_id must reference a project in this workspace" }, 400);
  if (message.startsWith("Agent not found")) return c.json({ error: "assignee must be a valid agent in this workspace" }, 400);
  if (message.startsWith("Squad not found")) return c.json({ error: "assignee must be a valid squad in this workspace" }, 400);
  if (message === "Autopilot title is required") return c.json({ error: "title is required" }, 400);
  if (message === "Autopilot assignee is required") return c.json({ error: "assignee_id is required" }, 400);
  if (message.startsWith("Invalid Autopilot")) return c.json({ error: message }, 400);
  if (message.includes("event_filters") || message.includes("event_config") || message.includes("cron_expression") || message.includes("timezone") || message.includes("trigger_issue")) {
    return c.json({ error: message }, 400);
  }
  return c.json({ error: message }, 500);
}

const SYSTEM_EVENT_ISSUE_STATUSES = new Set([
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "blocked",
  "cancelled",
]);

function validateSystemEventConfig(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "event_config is required for system_event triggers";
  const config = value as Record<string, unknown>;
  const allowedKeys = new Set(["resource", "event", "conditions", "project_id", "projectId"]);
  if (Object.keys(config).some((key) => !allowedKeys.has(key))) return "event_config contains unsupported fields";
  if (config.resource !== "issue") return "event_config.resource must be issue";
  if (config.event !== "status_changed") return "event_config.event must be status_changed";
  if (!Array.isArray(config.conditions) || config.conditions.length === 0) {
    return "event_config.conditions must be a non-empty array";
  }
  for (let index = 0; index < config.conditions.length; index += 1) {
    const condition = config.conditions[index];
    if (!condition || typeof condition !== "object" || Array.isArray(condition)) {
      return `event_config.conditions[${index}] must be an object`;
    }
    const record = condition as Record<string, unknown>;
    if (Object.keys(record).some((key) => !["field", "operator", "value"].includes(key))) {
      return `event_config.conditions[${index}] contains unsupported fields`;
    }
    if (record.field !== "status") return `event_config.conditions[${index}].field must be status`;
    if (record.operator !== "becomes") return `event_config.conditions[${index}].operator must be becomes`;
    if (typeof record.value !== "string" || !SYSTEM_EVENT_ISSUE_STATUSES.has(record.value)) {
      return `event_config.conditions[${index}].value must be a valid issue status`;
    }
  }
  const projectId = config.project_id ?? config.projectId;
  if (projectId !== undefined && projectId !== null && (typeof projectId !== "string" || !projectId.trim())) {
    return "event_config.project_id must be a non-empty string or null";
  }
  return null;
}

function isAutopilotExecutionMode(value: string): value is NonNullable<UpdateAutopilotInput["executionMode"]> {
  return value === "create_issue" || value === "trigger_issue" || value === "run_only";
}

function isAutopilotSessionPolicy(value: string): value is NonNullable<UpdateAutopilotInput["sessionPolicy"]> {
  return value === "new" || value === "reuse_latest";
}

function isAutopilotWorkspacePolicy(value: string): value is NonNullable<UpdateAutopilotInput["workspacePolicy"]> {
  return value === "reuse_issue";
}

function isAutopilotAssigneeType(value: string): value is NonNullable<UpdateAutopilotInput["assigneeType"]> {
  return value === "agent" || value === "squad";
}

function isAutopilotStatus(value: string): value is NonNullable<UpdateAutopilotInput["status"]> {
  return value === "active" || value === "paused" || value === "archived";
}

function isAllowedWebhookProvider(value: string): value is MultiremiWebhookProvider {
  return value === "generic" || value === "github";
}

function validateIssueTitleTemplateCompatibility(template: string | null | undefined): string | null {
  if (!template) return null;
  const tokenPattern = /\{\{\s*([^{}]*?)\s*\}\}/g;
  for (const match of template.matchAll(tokenPattern)) {
    const name = match[1] ?? "";
    if (name !== "date") return `unknown template variable "${name}"; supported: {{date}}`;
  }
  return null;
}

export function autopilotTriggerResponse(trigger: MultiremiAutopilotTrigger): MultiremiAutopilotTrigger & {
  autopilot_id: string;
  cron_expression: string | null;
  next_run_at: string | null;
  webhook_token: string | null;
  webhook_path: string | null;
  webhook_url: string | null;
  event_filters: MultiremiAutopilotTrigger["eventFilters"];
  event_config: MultiremiAutopilotTrigger["eventConfig"];
  signing_secret_set: boolean;
  last_fired_at: string | null;
  created_at: string;
  updated_at: string;
} {
  return {
    ...trigger,
    autopilot_id: trigger.autopilotId,
    cron_expression: trigger.cronExpression,
    next_run_at: trigger.nextRunAt,
    webhook_token: trigger.webhookToken,
    webhook_path: trigger.webhookPath,
    webhook_url: trigger.webhookUrl,
    event_filters: trigger.eventFilters,
    event_config: trigger.eventConfig,
    signing_secret_set: trigger.signingSecretSet,
    last_fired_at: trigger.lastFiredAt,
    created_at: trigger.createdAt,
    updated_at: trigger.updatedAt,
  };
}
