// Autopilots domain (autopilots, schedule/webhook triggers, runs and webhook deliveries),
// extracted verbatim from MultiremiStore (the facade delegates every public method here).
import { computeScheduleNextRun } from "@multiremi/store/schedule.js";
import { createId, nowIso } from "@multiremi/ids.js";
import {
  cleanOptionalString,
  isRecord,
  normalizeOptionalTimezone,
  normalizePositiveInt,
  nullableString,
  parseJson,
  toJson,
} from "@multiremi/store/helpers.js";
import { type StoreContext } from "@multiremi/store/context.js";
import { SCM_PROVIDER_CAPABILITIES } from "@multiremi/scm/capabilities.js";
import { resolveAtlasRepositoryWikiAutopilot } from "@multiremi/repository-wiki/atlas.js";
import type {
  CreateAutopilotInput,
  CreateAutopilotTriggerInput,
  MultiremiAutopilot,
  MultiremiAutopilotEventConfig,
  MultiremiAutopilotFeishuEventConfig,
  MultiremiAutopilotRun,
  MultiremiAutopilotScmEventConfig,
  MultiremiAutopilotSystemEventConfig,
  MultiremiScmCanonicalEventType,
  MultiremiAutopilotTrigger,
  MultiremiIssue,
  MultiremiSystemEvent,
  MultiremiTask,
  MultiremiWebhookDelivery,
  MultiremiWebhookDeliveryResult,
  MultiremiWebhookDeliveryStatus,
  MultiremiWebhookEventFilter,
  MultiremiWebhookProvider,
  MultiremiWebhookSignatureStatus,
  RunAutopilotInput,
  UpdateAutopilotInput,
  UpdateAutopilotTriggerInput,
} from "@multiremi/contracts/types.js";

type Row = Record<string, unknown>;

/**
 * Store-level run input: RunAutopilotInput plus the optional repository scoping
 * used by repository Wiki builds. `dedupeKey` is `${repositoryId}:${mode}:${revision|"head"}`.
 * These fields live only in the server store (the contracts package is unchanged).
 */
export type RunAutopilotStoreInput = RunAutopilotInput & {
  repositoryId?: string | null;
  repository_id?: string | null;
  dedupeKey?: string | null;
  dedupe_key?: string | null;
  sourceTaskId?: string | null;
  source_task_id?: string | null;
};

/** Run row as persisted by this store, including repository Wiki build scoping. */
export interface MultiremiAutopilotRunRecord extends MultiremiAutopilotRun {
  repositoryId: string | null;
  dedupeKey: string | null;
  /** Set (not persisted) when runAutopilot returned an existing run instead of creating one. */
  deduplicated?: boolean;
}

/** Autopilot run statuses that still occupy the "one build per repository" slot. */
const ACTIVE_RUN_STATUSES = ["running", "issue_created"] as const;

/** Build a repository Wiki build idempotency key. */
export function repositoryWikiBuildDedupeKey(
  repositoryId: string,
  mode: string,
  revision: string | null | undefined,
): string {
  return `${repositoryId}:${mode}:${cleanOptionalString(revision) ?? "head"}`;
}

/** Best-effort revision extraction from an SCM canonical event provider payload. */
export function extractScmPayloadRevision(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  for (const field of ["merge_sha", "mergeSha", "head_sha", "headSha"]) {
    const value = cleanOptionalString(payload[field]);
    if (value) return value;
  }
  return null;
}

/**
 * The revision a run built from: the pinned revision segment of its dedupe key
 * when present ("head" is a moving target, not a revision), else the SCM
 * provider payload's merge/head sha.
 */
export function autopilotRunSourceRevision(
  run: Pick<MultiremiAutopilotRunRecord, "dedupeKey" | "payload">,
): string | null {
  if (run.dedupeKey) {
    const revision = run.dedupeKey.split(":").slice(2).join(":");
    if (revision && revision !== "head") return revision;
  }
  const payload = isRecord(run.payload) ? run.payload : null;
  return extractScmPayloadRevision(payload?.data);
}

const AUTOPILOT_FAILURE_MONITOR_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const AUTOPILOT_FAILURE_MONITOR_MIN_RUNS = 50;
const AUTOPILOT_FAILURE_MONITOR_FAIL_RATIO = 0.9;

export interface MultiremiAutopilotFailureThresholdOptions {
  since?: Date | string;
  lookbackMs?: number;
  minRuns?: number;
  failRatioThreshold?: number;
  workspaceId?: string | null;
}

export interface MultiremiAutopilotFailureThresholdCandidate {
  autopilot: MultiremiAutopilot;
  totalRuns: number;
  failedRuns: number;
  failRatio: number;
}

export class AutopilotsRepo {
  constructor(private ctx: StoreContext) {}

  createAutopilot(input: CreateAutopilotInput): MultiremiAutopilot {
    if (!input.title?.trim()) throw new Error("Autopilot title is required");
    const executionMode = input.executionMode ?? input.execution_mode ?? "create_issue";
    if (!isAutopilotExecutionMode(executionMode)) throw new Error("Invalid Autopilot execution_mode");
    const sessionPolicy = input.sessionPolicy ?? input.session_policy ?? "new";
    if (sessionPolicy !== "new" && sessionPolicy !== "reuse_latest") throw new Error("Invalid Autopilot session_policy");
    const workspacePolicy = input.workspacePolicy ?? input.workspace_policy ?? "reuse_issue";
    if (workspacePolicy !== "reuse_issue") throw new Error("Invalid Autopilot workspace_policy");
    const assigneeType = input.assigneeType ?? input.assignee_type ?? "agent";
    const assigneeId = input.assigneeId ?? input.assignee_id;
    if (!assigneeId) throw new Error("Autopilot assignee is required");
    const workspaceId = input.workspaceId ?? input.workspace_id ?? "local";
    // The assignee must live in the autopilot's workspace — otherwise a
    // run_only autopilot (no issue/chat, so the createTask workspace check
    // never fires) would drive another workspace's agent + machine.
    const assigneeAgent = assigneeType === "agent" ? this.ctx.agents().getAgent(assigneeId) : null;
    const assigneeSquad = assigneeType === "squad" ? this.ctx.squads().getSquad(assigneeId) : null;
    if (assigneeType === "agent" && !assigneeAgent) throw new Error(`Agent not found: ${assigneeId}`);
    if (assigneeType === "squad" && !assigneeSquad) throw new Error(`Squad not found: ${assigneeId}`);
    if (assigneeAgent && assigneeAgent.workspaceId !== workspaceId) throw new Error("Autopilot assignee is in a different workspace");
    if (assigneeSquad && assigneeSquad.workspaceId !== workspaceId) throw new Error("Autopilot assignee is in a different workspace");
    const projectId = input.projectId ?? input.project_id ?? null;
    if (projectId) {
      const project = this.ctx.projects().getProject(projectId);
      if (!project) throw new Error(`Project not found: ${projectId}`);
      if (project.workspaceId !== workspaceId) throw new Error("Autopilot project is in a different workspace");
    }
    const createdByType = normalizeAutopilotCreatorType(input.createdByType ?? input.created_by_type);
    const createdById = cleanOptionalString(input.createdById ?? input.created_by_id) ?? "local";
    const issueCreationRestricted = Boolean(input.issueCreationRestricted ?? input.issue_creation_restricted);
    const issueCreationRestrictedByTaskId = issueCreationRestricted
      ? cleanOptionalString(input.issueCreationRestrictedByTaskId)
      : null;
    const issueCreationRestrictionReason = issueCreationRestricted
      ? input.issueCreationRestrictionReason ?? (issueCreationRestrictedByTaskId ? "restricted_task" : "human_policy")
      : null;
    const id = input.id ?? createId("aut");
    const now = nowIso();
    this.ctx.db.run(
      `INSERT INTO multiremi_autopilots (
        id, title, description, project_id, workspace_id, assignee_type,
        assignee_id, status, execution_mode, session_policy, workspace_policy, issue_title_template,
        trigger_kind, trigger_label, cron_expression, issue_creation_restricted,
        issue_creation_restriction_reason, issue_creation_restricted_by_task_id, created_by_type,
        created_by_id, last_run_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      [
        id,
        input.title.trim(),
        input.description ?? null,
        projectId,
        workspaceId,
        assigneeType,
        assigneeId,
        input.status ?? "active",
        executionMode,
        sessionPolicy,
        workspacePolicy,
        input.issueTitleTemplate ?? input.issue_title_template ?? null,
        input.triggerKind ?? input.trigger_kind ?? "manual",
        input.triggerLabel ?? input.trigger_label ?? null,
        input.cronExpression ?? input.cron_expression ?? null,
        issueCreationRestricted ? 1 : 0,
        issueCreationRestrictionReason,
        issueCreationRestrictedByTaskId,
        createdByType,
        createdById,
        now,
        now,
      ],
    );
    const autopilot = this.getAutopilot(id)!;
    this.ctx.analytics().recordAutopilotCreatedAnalytics(autopilot);
    return autopilot;
  }

  getAutopilot(id: string): MultiremiAutopilot | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_autopilots WHERE id = ?").get(id) as Row | null;
    return row ? toAutopilot(row) : null;
  }

  setAutopilotManagedKind(
    id: string,
    managedKind: NonNullable<MultiremiAutopilot["managedKind"]>,
  ): MultiremiAutopilot {
    if (managedKind !== "atlas_project_knowledge" && managedKind !== "atlas_repository_wiki") {
      throw new Error("Invalid managed Autopilot kind");
    }
    const current = this.getAutopilot(id);
    if (!current) throw new Error(`Autopilot not found: ${id}`);
    const conflict = this.ctx.db.query(
      "SELECT id FROM multiremi_autopilots WHERE workspace_id = ? AND managed_kind = ? AND id != ?",
    ).get(current.workspaceId, managedKind, id) as Row | null;
    if (conflict) throw new Error(`Managed Autopilot already exists: ${managedKind}`);
    this.ctx.db.run(
      "UPDATE multiremi_autopilots SET managed_kind = ?, updated_at = ? WHERE id = ?",
      [managedKind, nowIso(), id],
    );
    return this.getAutopilot(id)!;
  }

  listAutopilots(workspaceId?: string | null): MultiremiAutopilot[] {
    const rows = workspaceId
      ? this.ctx.db.query("SELECT * FROM multiremi_autopilots WHERE workspace_id = ? AND status != 'archived' ORDER BY updated_at DESC").all(workspaceId) as Row[]
      : this.ctx.db.query("SELECT * FROM multiremi_autopilots WHERE status != 'archived' ORDER BY updated_at DESC").all() as Row[];
    return rows.map(toAutopilot);
  }

  updateAutopilot(id: string, input: UpdateAutopilotInput): MultiremiAutopilot {
    const current = this.getAutopilot(id);
    if (!current) throw new Error(`Autopilot not found: ${id}`);
    const nextAssigneeType = input.assigneeType ?? current.assigneeType;
    const nextAssigneeId = input.assigneeId ?? current.assigneeId;
    const nextExecutionMode = input.executionMode ?? current.executionMode;
    const nextSessionPolicy = input.sessionPolicy ?? current.sessionPolicy;
    const nextWorkspacePolicy = input.workspacePolicy ?? current.workspacePolicy;
    const restrictionInput = input.issueCreationRestricted ?? input.issue_creation_restricted;
    const nextIssueCreationRestricted = restrictionInput ?? current.issueCreationRestricted;
    const nextIssueCreationRestrictedByTaskId = nextIssueCreationRestricted
      ? restrictionInput === undefined
        ? current.issueCreationRestrictedByTaskId
        : cleanOptionalString(input.issueCreationRestrictedByTaskId)
      : null;
    const nextIssueCreationRestrictionReason = nextIssueCreationRestricted
      ? restrictionInput === undefined
        ? current.issueCreationRestrictionReason
        : input.issueCreationRestrictionReason
          ?? (nextIssueCreationRestrictedByTaskId ? "restricted_task" : "human_policy")
      : null;
    if (!isAutopilotExecutionMode(nextExecutionMode)) throw new Error("Invalid Autopilot execution_mode");
    if (nextSessionPolicy !== "new" && nextSessionPolicy !== "reuse_latest") throw new Error("Invalid Autopilot session_policy");
    if (nextWorkspacePolicy !== "reuse_issue") throw new Error("Invalid Autopilot workspace_policy");
    // Only validate the assignee when the request actually CHANGES it — the
    // edit dialog re-sends the current assignee_type/id on every save, so a
    // title/status/pause/archive update must not fail just because legacy or
    // since-moved data has a cross-workspace assignee. Compare values, not
    // mere field presence.
    const assigneeChanged =
      (input.assigneeType !== undefined && input.assigneeType !== current.assigneeType) ||
      (input.assigneeId !== undefined && input.assigneeId !== current.assigneeId);
    if (assigneeChanged) {
      const nextAgent = nextAssigneeType === "agent" ? this.ctx.agents().getAgent(nextAssigneeId) : null;
      const nextSquad = nextAssigneeType === "squad" ? this.ctx.squads().getSquad(nextAssigneeId) : null;
      if (nextAssigneeType === "agent" && !nextAgent) throw new Error(`Agent not found: ${nextAssigneeId}`);
      if (nextAssigneeType === "squad" && !nextSquad) throw new Error(`Squad not found: ${nextAssigneeId}`);
      if (nextAgent && nextAgent.workspaceId !== current.workspaceId) throw new Error("Autopilot assignee is in a different workspace");
      if (nextSquad && nextSquad.workspaceId !== current.workspaceId) throw new Error("Autopilot assignee is in a different workspace");
    }
    if (input.projectId) {
      const project = this.ctx.projects().getProject(input.projectId);
      if (!project) throw new Error(`Project not found: ${input.projectId}`);
      if (project.workspaceId !== current.workspaceId) throw new Error("Autopilot project is in a different workspace");
    }
    const nextProjectId = input.projectId === undefined ? current.projectId : input.projectId;
    const existingTriggers = this.listAutopilotTriggers(id);
    const systemEventTriggers = existingTriggers.filter((trigger) => trigger.kind === "system_event");
    if (systemEventTriggers.length && nextExecutionMode !== "trigger_issue") {
      throw new Error("system_event triggers require execution_mode trigger_issue");
    }
    if (
      nextExecutionMode === "trigger_issue"
      && (
        existingTriggers.some((trigger) => trigger.kind === "schedule" || trigger.kind === "webhook" || trigger.kind === "scm_event")
        || (existingTriggers.length === 0 && Boolean(current.cronExpression))
      )
    ) {
      throw new Error("trigger_issue execution does not support schedule or webhook triggers");
    }
    if (nextProjectId && systemEventTriggers.some((trigger) =>
      trigger.eventConfig?.resource === "issue"
      && trigger.eventConfig.projectId
      && trigger.eventConfig.projectId !== nextProjectId
    )) {
      throw new Error("event_config.project_id must match the Autopilot project");
    }
    for (const trigger of systemEventTriggers) {
      if (trigger.eventConfig?.resource === "feishu_source") {
        this.assertFeishuEventConfigScope(trigger.eventConfig, { ...current, projectId: nextProjectId });
      }
    }
    const now = nowIso();
    this.ctx.db.transaction(() => {
      this.ctx.db.run(
        `UPDATE multiremi_autopilots SET
        title = ?,
        description = ?,
        project_id = ?,
        assignee_type = ?,
        assignee_id = ?,
        status = ?,
        execution_mode = ?,
        session_policy = ?,
        workspace_policy = ?,
        issue_title_template = ?,
        trigger_kind = ?,
        trigger_label = ?,
        cron_expression = ?,
        issue_creation_restricted = ?,
        issue_creation_restriction_reason = ?,
        issue_creation_restricted_by_task_id = ?,
        updated_at = ?
       WHERE id = ?`,
      [
        input.title ?? current.title,
        input.description === undefined ? current.description : input.description,
        input.projectId === undefined ? current.projectId : input.projectId,
        nextAssigneeType,
        nextAssigneeId,
        input.status ?? current.status,
        nextExecutionMode,
        nextSessionPolicy,
        nextWorkspacePolicy,
        input.issueTitleTemplate === undefined ? current.issueTitleTemplate : input.issueTitleTemplate,
        input.triggerKind ?? current.triggerKind,
        input.triggerLabel === undefined ? current.triggerLabel : input.triggerLabel,
        input.cronExpression === undefined ? current.cronExpression : input.cronExpression,
        nextIssueCreationRestricted ? 1 : 0,
        nextIssueCreationRestrictionReason,
        nextIssueCreationRestrictedByTaskId,
        now,
        id,
        ],
      );
      if (restrictionInput === false) {
        this.ctx.db.run(
          `UPDATE multiremi_autopilot_triggers
           SET issue_creation_restricted = 0,
               issue_creation_restriction_reason = NULL,
               issue_creation_restricted_by_task_id = NULL,
               updated_at = ?
           WHERE autopilot_id = ?`,
          [now, id],
        );
      }
    })();
    return this.getAutopilot(id)!;
  }

  archiveAutopilot(id: string): MultiremiAutopilot {
    return this.updateAutopilot(id, { status: "archived" });
  }

  listAutopilotTriggers(autopilotId: string): MultiremiAutopilotTrigger[] {
    const rows = this.ctx.db.query(
      "SELECT * FROM multiremi_autopilot_triggers WHERE autopilot_id = ? ORDER BY created_at ASC",
    ).all(autopilotId) as Row[];
    return rows.map(toAutopilotTrigger);
  }

  getAutopilotTrigger(id: string): MultiremiAutopilotTrigger | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_autopilot_triggers WHERE id = ?").get(id) as Row | null;
    return row ? toAutopilotTrigger(row) : null;
  }

  getAutopilotTriggerSigningSecret(id: string): string | null {
    const row = this.ctx.db.query("SELECT signing_secret_hash FROM multiremi_autopilot_triggers WHERE id = ?").get(id) as Row | null;
    const secret = nullableString(row?.signing_secret_hash);
    return secret && secret !== "local-secret-set" ? secret : null;
  }

  getAutopilotTriggerByWebhookToken(token: string): MultiremiAutopilotTrigger | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_autopilot_triggers WHERE webhook_token = ?").get(token) as Row | null;
    return row ? toAutopilotTrigger(row) : null;
  }

  createAutopilotTrigger(autopilotId: string, input: CreateAutopilotTriggerInput = {}): MultiremiAutopilotTrigger {
    const autopilot = this.getAutopilot(autopilotId);
    if (!autopilot) throw new Error(`Autopilot not found: ${autopilotId}`);
    const kind = input.kind ?? (input.cronExpression || input.cron_expression ? "schedule" : "webhook");
    if (kind !== "schedule" && kind !== "webhook" && kind !== "api" && kind !== "system_event" && kind !== "scm_event") {
      throw new Error("Invalid Autopilot trigger kind");
    }
    const eventFilters = normalizeWebhookEventFilters(input.eventFilters ?? input.event_filters ?? null);
    const eventConfig = normalizeAutopilotEventConfig(input.eventConfig ?? input.event_config ?? null);
    if ((kind === "system_event" || kind === "scm_event") && !eventConfig) {
      throw new Error(`event_config is required for ${kind} triggers`);
    }
    if (kind === "system_event" && eventConfig?.resource !== "issue" && eventConfig?.resource !== "feishu_source") {
      throw new Error("system_event triggers require an issue or feishu_source event_config");
    }
    if (kind === "scm_event" && eventConfig?.resource !== "scm") {
      throw new Error("scm_event triggers require an SCM event_config");
    }
    if (eventConfig?.resource === "scm") {
      this.assertScmEventConfigScope(eventConfig, autopilot.workspaceId);
    }
    if (eventConfig?.resource === "feishu_source") {
      this.assertFeishuEventConfigScope(eventConfig, autopilot);
    }
    if (kind !== "system_event" && kind !== "scm_event" && eventConfig) {
      throw new Error("event_config is only valid for system_event or scm_event triggers");
    }
    if (eventConfig?.resource === "issue" && eventConfig.projectId) {
      const project = this.ctx.projects().getProject(eventConfig.projectId);
      if (!project || project.workspaceId !== autopilot.workspaceId) {
        throw new Error("event_config.project_id must reference a project in this workspace");
      }
      if (autopilot.projectId && autopilot.projectId !== eventConfig.projectId) {
        throw new Error("event_config.project_id must match the Autopilot project");
      }
    }
    if (kind === "system_event" && autopilot.executionMode !== "trigger_issue") {
      throw new Error("system_event triggers require execution_mode trigger_issue");
    }
    if (kind === "scm_event" && autopilot.executionMode === "trigger_issue") {
      throw new Error("scm_event triggers do not support execution_mode trigger_issue");
    }
    if (
      autopilot.executionMode === "trigger_issue"
      && (kind === "schedule" || kind === "webhook")
    ) {
      throw new Error("trigger_issue execution does not support schedule or webhook triggers");
    }
    const cronExpression = input.cronExpression ?? input.cron_expression ?? null;
    const timezone = normalizeOptionalTimezone(input.timezone);
    const provider = kind === "webhook" ? normalizeWebhookProvider(input.provider) : null;
    const enabled = input.enabled !== false;
    const nextRunAt = kind === "schedule" && enabled && cronExpression
      ? computeScheduleNextRun(cronExpression, timezone)
      : null;
    const id = createId("trg");
    const now = nowIso();
    const webhookToken = kind === "webhook" ? createId("awt", 18) : null;
    const issueCreationRestricted = Boolean(input.issueCreationRestricted ?? input.issue_creation_restricted);
    const issueCreationRestrictedByTaskId = issueCreationRestricted
      ? cleanOptionalString(input.issueCreationRestrictedByTaskId)
      : null;
    const issueCreationRestrictionReason = issueCreationRestricted
      ? input.issueCreationRestrictionReason ?? (issueCreationRestrictedByTaskId ? "restricted_task" : "human_policy")
      : null;
    this.ctx.db.transaction(() => {
      this.ctx.db.run(
        `INSERT INTO multiremi_autopilot_triggers (
        id, autopilot_id, kind, enabled, cron_expression, timezone, next_run_at,
        webhook_token, webhook_url, provider, label, event_filters, event_config,
        issue_creation_restricted, issue_creation_restriction_reason, issue_creation_restricted_by_task_id,
        signing_secret_hash, signing_secret_hint, last_fired_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
      [
        id,
        autopilotId,
        kind,
        enabled ? 1 : 0,
        cronExpression,
        timezone,
        nextRunAt,
        webhookToken,
        provider,
        input.label ?? null,
        eventFilters ? toJson(eventFilters) : null,
        eventConfig ? toJson(eventConfig) : null,
        issueCreationRestricted ? 1 : 0,
        issueCreationRestrictionReason,
        issueCreationRestrictedByTaskId,
        now,
        now,
        ],
      );
      this.ctx.db.run(
        `UPDATE multiremi_autopilots SET
           trigger_kind = ?, trigger_label = ?, cron_expression = ?,
           issue_creation_restricted = CASE WHEN ? = 1 THEN 1 ELSE issue_creation_restricted END,
           issue_creation_restriction_reason = CASE WHEN ? = 1 THEN ? ELSE issue_creation_restriction_reason END,
           issue_creation_restricted_by_task_id = CASE WHEN ? = 1 THEN ? ELSE issue_creation_restricted_by_task_id END,
           updated_at = ?
         WHERE id = ?`,
        [
          kind,
          input.label ?? autopilot.triggerLabel,
          input.cronExpression ?? input.cron_expression ?? autopilot.cronExpression,
          issueCreationRestricted ? 1 : 0,
          issueCreationRestricted ? 1 : 0,
          issueCreationRestrictionReason,
          issueCreationRestricted ? 1 : 0,
          issueCreationRestrictedByTaskId,
          now,
          autopilotId,
        ],
      );
    })();
    return this.getAutopilotTrigger(id)!;
  }

  updateAutopilotTrigger(autopilotId: string, triggerId: string, input: UpdateAutopilotTriggerInput): MultiremiAutopilotTrigger {
    const current = this.getAutopilotTrigger(triggerId);
    if (!current || current.autopilotId !== autopilotId) throw new Error(`Autopilot trigger not found: ${triggerId}`);
    const autopilot = this.getAutopilot(autopilotId);
    if (!autopilot) throw new Error(`Autopilot not found: ${autopilotId}`);
    const now = nowIso();
    const eventFiltersInput = input.eventFilters !== undefined ? input.eventFilters : input.event_filters;
    const eventFilters = eventFiltersInput === undefined ? current.eventFilters : normalizeWebhookEventFilters(eventFiltersInput);
    const eventConfigInput = input.eventConfig !== undefined ? input.eventConfig : input.event_config;
    const eventConfig = eventConfigInput === undefined ? current.eventConfig : normalizeAutopilotEventConfig(eventConfigInput);
    const enabled = input.enabled === undefined ? current.enabled : input.enabled;
    const restrictionInput = input.issueCreationRestricted ?? input.issue_creation_restricted;
    const nextIssueCreationRestricted = restrictionInput ?? current.issueCreationRestricted;
    const nextIssueCreationRestrictedByTaskId = nextIssueCreationRestricted
      ? restrictionInput === undefined
        ? current.issueCreationRestrictedByTaskId
        : cleanOptionalString(input.issueCreationRestrictedByTaskId)
      : null;
    const nextIssueCreationRestrictionReason = nextIssueCreationRestricted
      ? restrictionInput === undefined
        ? current.issueCreationRestrictionReason
        : input.issueCreationRestrictionReason
          ?? (nextIssueCreationRestrictedByTaskId ? "restricted_task" : "human_policy")
      : null;
    if ((current.kind === "system_event" || current.kind === "scm_event") && !eventConfig) {
      throw new Error(`event_config is required for ${current.kind} triggers`);
    }
    if (current.kind === "system_event" && eventConfig?.resource !== "issue" && eventConfig?.resource !== "feishu_source") {
      throw new Error("system_event triggers require an issue or feishu_source event_config");
    }
    if (current.kind === "scm_event" && eventConfig?.resource !== "scm") {
      throw new Error("scm_event triggers require an SCM event_config");
    }
    if (eventConfig?.resource === "scm" && enabled) {
      this.assertScmEventConfigScope(eventConfig, autopilot.workspaceId);
    }
    if (eventConfig?.resource === "feishu_source" && enabled) {
      this.assertFeishuEventConfigScope(eventConfig, autopilot);
    }
    if (current.kind !== "system_event" && current.kind !== "scm_event" && eventConfig) {
      throw new Error("event_config is only valid for system_event or scm_event triggers");
    }
    if (eventConfig?.resource === "issue" && eventConfig.projectId) {
      const project = this.ctx.projects().getProject(eventConfig.projectId);
      if (!project || project.workspaceId !== autopilot?.workspaceId) {
        throw new Error("event_config.project_id must reference a project in this workspace");
      }
      if (autopilot.projectId && autopilot.projectId !== eventConfig.projectId) {
        throw new Error("event_config.project_id must match the Autopilot project");
      }
    }
    const cronExpression = input.cronExpression ?? input.cron_expression ?? current.cronExpression;
    const timezone = input.timezone === undefined ? current.timezone : normalizeOptionalTimezone(input.timezone);
    const shouldRecomputeNextRun = current.kind === "schedule"
      && enabled
      && Boolean(cronExpression)
      && (
        current.nextRunAt == null
        || input.enabled !== undefined
        || input.cronExpression !== undefined
        || input.cron_expression !== undefined
        || input.timezone !== undefined
      );
    const nextRunAt = current.kind === "schedule" && enabled && cronExpression
      ? shouldRecomputeNextRun
        ? computeScheduleNextRun(cronExpression, timezone)
        : current.nextRunAt
      : null;
    this.ctx.db.transaction(() => {
      this.ctx.db.run(
        `UPDATE multiremi_autopilot_triggers SET
        enabled = ?,
        cron_expression = ?,
        timezone = ?,
        next_run_at = ?,
        label = ?,
        event_filters = ?,
        event_config = ?,
        issue_creation_restricted = ?,
        issue_creation_restriction_reason = ?,
        issue_creation_restricted_by_task_id = ?,
        updated_at = ?
       WHERE id = ?`,
      [
        enabled ? 1 : 0,
        cronExpression,
        timezone,
        nextRunAt,
        input.label === undefined ? current.label : input.label,
        eventFilters ? toJson(eventFilters) : null,
        eventConfig ? toJson(eventConfig) : null,
        nextIssueCreationRestricted ? 1 : 0,
        nextIssueCreationRestrictionReason,
        nextIssueCreationRestrictedByTaskId,
        now,
        triggerId,
        ],
      );
      this.ctx.db.run(
        `UPDATE multiremi_autopilots SET
           trigger_label = ?, cron_expression = ?,
           issue_creation_restricted = CASE WHEN ? = 1 THEN 1 ELSE issue_creation_restricted END,
           issue_creation_restriction_reason = CASE WHEN ? = 1 THEN ? ELSE issue_creation_restriction_reason END,
           issue_creation_restricted_by_task_id = CASE WHEN ? = 1 THEN ? ELSE issue_creation_restricted_by_task_id END,
           updated_at = ?
         WHERE id = ?`,
        [
          input.label === undefined ? current.label : input.label,
          input.cronExpression ?? input.cron_expression ?? current.cronExpression,
          restrictionInput === true ? 1 : 0,
          restrictionInput === true ? 1 : 0,
          nextIssueCreationRestrictionReason,
          restrictionInput === true ? 1 : 0,
          nextIssueCreationRestrictedByTaskId,
          now,
          autopilotId,
        ],
      );
    })();
    return this.getAutopilotTrigger(triggerId)!;
  }

  deleteAutopilotTrigger(autopilotId: string, triggerId: string): boolean {
    const result = this.ctx.db.run("DELETE FROM multiremi_autopilot_triggers WHERE id = ? AND autopilot_id = ?", [triggerId, autopilotId]);
    return result.changes > 0;
  }

  rotateAutopilotTriggerWebhookToken(autopilotId: string, triggerId: string): MultiremiAutopilotTrigger {
    const current = this.getAutopilotTrigger(triggerId);
    if (!current || current.autopilotId !== autopilotId) throw new Error(`Autopilot trigger not found: ${triggerId}`);
    const token = createId("awt", 18);
    this.ctx.db.run(
      "UPDATE multiremi_autopilot_triggers SET webhook_token = ?, updated_at = ? WHERE id = ?",
      [token, nowIso(), triggerId],
    );
    return this.getAutopilotTrigger(triggerId)!;
  }

  setAutopilotTriggerSigningSecret(autopilotId: string, triggerId: string, secret: string | null | undefined): MultiremiAutopilotTrigger {
    const current = this.getAutopilotTrigger(triggerId);
    if (!current || current.autopilotId !== autopilotId) throw new Error(`Autopilot trigger not found: ${triggerId}`);
    if (current.kind !== "webhook") throw new Error(`Autopilot trigger is not a webhook: ${triggerId}`);
    const cleanSecret = String(secret ?? "").trim();
    const signingSecret = cleanSecret || null;
    const hint = signingSecret && signingSecret.length >= 4 ? signingSecret.slice(-4) : null;
    this.ctx.db.run(
      "UPDATE multiremi_autopilot_triggers SET signing_secret_hash = ?, signing_secret_hint = ?, updated_at = ? WHERE id = ?",
      [signingSecret, hint, nowIso(), triggerId],
    );
    return this.getAutopilotTrigger(triggerId)!;
  }

  claimDueScheduleTriggers(now: Date = new Date()): MultiremiAutopilotTrigger[] {
    const dueAt = now.toISOString();
    const rows = this.ctx.db.query(
      `UPDATE multiremi_autopilot_triggers
       SET next_run_at = NULL, updated_at = ?
       WHERE id IN (
         SELECT t.id
         FROM multiremi_autopilot_triggers t
         JOIN multiremi_autopilots a ON a.id = t.autopilot_id
         WHERE t.kind = 'schedule'
           AND t.enabled = 1
           AND t.next_run_at IS NOT NULL
           AND t.next_run_at <= ?
           AND a.status = 'active'
       )
       RETURNING *`,
    ).all(nowIso(), dueAt) as Row[];
    return rows.map(toAutopilotTrigger);
  }

  advanceScheduleTriggerNextRun(triggerId: string, from: Date = new Date()): MultiremiAutopilotTrigger | null {
    const trigger = this.getAutopilotTrigger(triggerId);
    if (!trigger || trigger.kind !== "schedule" || !trigger.cronExpression) return trigger;
    const nextRunAt = trigger.enabled ? computeScheduleNextRun(trigger.cronExpression, trigger.timezone, from) : null;
    const now = nowIso();
    this.ctx.db.run(
      "UPDATE multiremi_autopilot_triggers SET next_run_at = ?, last_fired_at = ?, updated_at = ? WHERE id = ?",
      [nextRunAt, now, now, triggerId],
    );
    return this.getAutopilotTrigger(triggerId);
  }

  recoverLostScheduleTriggers(now: Date = new Date()): number {
    const rows = this.ctx.db.query(
      `SELECT t.*
       FROM multiremi_autopilot_triggers t
       JOIN multiremi_autopilots a ON a.id = t.autopilot_id
       WHERE t.kind = 'schedule'
         AND t.enabled = 1
         AND t.next_run_at IS NULL
         AND t.cron_expression IS NOT NULL
         AND a.status = 'active'
       ORDER BY t.id ASC`,
    ).all() as Row[];
    let recovered = 0;
    for (const row of rows) {
      const trigger = toAutopilotTrigger(row);
      if (!trigger.cronExpression) continue;
      const nextRunAt = computeScheduleNextRun(trigger.cronExpression, trigger.timezone, now);
      this.ctx.db.run("UPDATE multiremi_autopilot_triggers SET next_run_at = ?, updated_at = ? WHERE id = ?", [nextRunAt, nowIso(), trigger.id]);
      recovered += 1;
    }
    return recovered;
  }

  enqueueIssueStatusChangedEvent(input: {
    issue: MultiremiIssue;
    previousStatus: string;
    actorType?: string | null;
    actorId?: string | null;
    automationSourceEventId?: string | null;
    automationSourceTaskId?: string | null;
  }): MultiremiSystemEvent | null {
    if (input.previousStatus === input.issue.status) return null;
    const id = createId("sev");
    const now = nowIso();
    const payload = {
      issue_id: input.issue.id,
      issue_key: input.issue.key,
      workspace_id: input.issue.workspaceId,
      project_id: input.issue.projectId,
      previous_status: input.previousStatus,
      status: input.issue.status,
      actor_type: input.actorType ?? "system",
      actor_id: input.actorId ?? null,
      automation_source_event_id: cleanOptionalString(input.automationSourceEventId) ?? null,
      automation_source_task_id: cleanOptionalString(input.automationSourceTaskId) ?? null,
    };
    this.ctx.db.run(
      `INSERT INTO multiremi_system_events (
        id, workspace_id, resource, event, resource_id, project_id, payload,
        status, attempt_count, available_at, lease_until, last_error, created_at, processed_at
      ) VALUES (?, ?, 'issue', 'status_changed', ?, ?, ?, 'pending', 0, ?, NULL, NULL, ?, NULL)`,
      [id, input.issue.workspaceId, input.issue.id, input.issue.projectId, toJson(payload), now, now],
    );
    return this.getSystemEvent(id);
  }

  getSystemEvent(id: string): MultiremiSystemEvent | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_system_events WHERE id = ?").get(id) as Row | null;
    return row ? toSystemEvent(row) : null;
  }

  claimPendingSystemEvents(now: Date = new Date(), limit = 25): MultiremiSystemEvent[] {
    const claimedAt = now.toISOString();
    const leaseUntil = new Date(now.getTime() + 60_000).toISOString();
    const rows = this.ctx.db.query(
      `UPDATE multiremi_system_events
       SET status = 'processing',
           attempt_count = attempt_count + 1,
           lease_until = ?,
           last_error = NULL
       WHERE id IN (
         SELECT id FROM multiremi_system_events
         WHERE (status = 'pending' AND available_at <= ?)
            OR (status = 'processing' AND lease_until IS NOT NULL AND lease_until <= ?)
         ORDER BY created_at ASC, id ASC
         LIMIT ?
       )
         AND ((status = 'pending' AND available_at <= ?)
           OR (status = 'processing' AND lease_until IS NOT NULL AND lease_until <= ?))
       RETURNING *`,
    ).all(leaseUntil, claimedAt, claimedAt, Math.max(1, Math.min(100, Math.floor(limit))), claimedAt, claimedAt) as Row[];
    return rows.map(toSystemEvent);
  }

  dispatchPendingSystemEvents(now: Date = new Date(), limit = 25): MultiremiAutopilotRun[] {
    const runs: MultiremiAutopilotRun[] = [];
    for (const event of this.claimPendingSystemEvents(now, limit)) {
      try {
        const triggerRows = this.ctx.db.query(
          `SELECT t.*
           FROM multiremi_autopilot_triggers t
           JOIN multiremi_autopilots a ON a.id = t.autopilot_id
           WHERE t.kind = 'system_event'
             AND t.enabled = 1
             AND a.status = 'active'
             AND a.workspace_id = ?
           ORDER BY t.created_at ASC, t.id ASC`,
        ).all(event.workspaceId) as Row[];
        for (const row of triggerRows) {
          const trigger = toAutopilotTrigger(row);
          if (!systemEventMatchesConfig(event, trigger.eventConfig)) continue;
          const sourceTaskId = isRecord(event.payload)
            ? cleanOptionalString(event.payload.automation_source_task_id)
            : null;
          runs.push(this.runAutopilot(trigger.autopilotId, {
            source: "system_event",
            triggerId: trigger.id,
            eventId: event.id,
            sourceTaskId,
            triggerIssueId: trigger.eventConfig?.resource === "feishu_source"
              ? trigger.eventConfig.triggerIssueId
              : event.resourceId,
            payload: event.payload,
          }));
        }
        this.ctx.db.run(
          `UPDATE multiremi_system_events
           SET status = 'processed', processed_at = ?, lease_until = NULL, last_error = NULL
           WHERE id = ? AND status = 'processing'`,
          [nowIso(), event.id],
        );
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
        const terminal = event.attemptCount >= 8;
        const delayMs = Math.min(5 * 60_000, 1_000 * (2 ** Math.max(0, event.attemptCount - 1)));
        this.ctx.db.run(
          `UPDATE multiremi_system_events
           SET status = ?, available_at = ?, lease_until = NULL, last_error = ?
           WHERE id = ? AND status = 'processing'`,
          [terminal ? "failed" : "pending", new Date(Date.now() + delayMs).toISOString(), message, event.id],
        );
      }
    }
    return runs;
  }

  listAutopilotRuns(autopilotId: string): MultiremiAutopilotRunRecord[] {
    const rows = this.ctx.db.query(
      "SELECT * FROM multiremi_autopilot_runs WHERE autopilot_id = ? ORDER BY created_at DESC LIMIT 20",
    ).all(autopilotId) as Row[];
    return rows.map(toAutopilotRun);
  }

  /**
   * Latest repository-scoped run (repository Wiki builds) per repository in a
   * workspace — the source of the per-repository build status in summaries.
   * Run ids are random, so created_at ties are broken by preferring the still
   * active run (at most one exists per repository, enforced by runAutopilot).
   */
  listLatestRepositoryAutopilotRuns(workspaceId: string): MultiremiAutopilotRunRecord[] {
    const rows = this.ctx.db.query(
      `SELECT r.* FROM multiremi_autopilot_runs r
       JOIN multiremi_autopilots a ON a.id = r.autopilot_id
       WHERE a.workspace_id = ? AND r.repository_id IS NOT NULL
       ORDER BY r.created_at DESC, r.id DESC`,
    ).all(workspaceId) as Row[];
    const isActive = (status: MultiremiAutopilotRun["status"]): boolean =>
      (ACTIVE_RUN_STATUSES as readonly string[]).includes(status);
    const latest = new Map<string, MultiremiAutopilotRunRecord>();
    for (const row of rows.map(toAutopilotRun)) {
      const current = latest.get(row.repositoryId!);
      if (!current) {
        latest.set(row.repositoryId!, row);
      } else if (current.createdAt === row.createdAt && !isActive(current.status) && isActive(row.status)) {
        latest.set(row.repositoryId!, row);
      }
    }
    return [...latest.values()];
  }

  /**
   * A completed Wiki run is published only when the control-plane store has a
   * repository-scoped write attributable to it. A matching source revision in
   * either the current doc or revision history also represents a legitimate
   * no-op: that pinned revision was already published. Agent result text is
   * intentionally not trusted.
   */
  isRepositoryWikiRunPublished(runId: string): boolean {
    const run = this.getAutopilotRun(runId);
    if (!run?.repositoryId) return false;
    return this.repositoryWikiRunHasPublication(run);
  }

  selectAutopilotsExceedingFailureThreshold(
    options: MultiremiAutopilotFailureThresholdOptions = {},
  ): MultiremiAutopilotFailureThresholdCandidate[] {
    const since = normalizeFailureMonitorSince(options);
    const minRuns = normalizePositiveInt(options.minRuns, AUTOPILOT_FAILURE_MONITOR_MIN_RUNS);
    const failRatioThreshold = normalizeUnitRatio(options.failRatioThreshold, AUTOPILOT_FAILURE_MONITOR_FAIL_RATIO);
    const workspaceId = cleanOptionalString(options.workspaceId ?? null);
    const workspaceClause = workspaceId ? "AND a.workspace_id = ?" : "";
    const rows = this.ctx.db.query(
      `WITH stats AS (
         SELECT
           autopilot_id,
           SUM(CASE WHEN status IN ('completed', 'failed') THEN 1 ELSE 0 END) AS total_runs,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_runs
         FROM multiremi_autopilot_runs
         WHERE created_at >= ?
         GROUP BY autopilot_id
       )
       SELECT a.*, stats.total_runs, stats.failed_runs
       FROM multiremi_autopilots a
       JOIN stats ON stats.autopilot_id = a.id
       WHERE a.status = 'active'
         ${workspaceClause}
         AND stats.total_runs >= ?
         AND CAST(stats.failed_runs AS REAL) / NULLIF(stats.total_runs, 0) >= ?
       ORDER BY stats.failed_runs DESC, a.id ASC`,
    ).all(...(workspaceId ? [since, workspaceId, minRuns, failRatioThreshold] : [since, minRuns, failRatioThreshold])) as Row[];
    return rows.map((row) => {
      const totalRuns = Number(row.total_runs ?? 0);
      const failedRuns = Number(row.failed_runs ?? 0);
      return {
        autopilot: toAutopilot(row),
        totalRuns,
        failedRuns,
        failRatio: totalRuns > 0 ? failedRuns / totalRuns : 0,
      };
    });
  }

  systemPauseAutopilot(id: string): MultiremiAutopilot | null {
    const now = nowIso();
    const result = this.ctx.db.run(
      "UPDATE multiremi_autopilots SET status = 'paused', updated_at = ? WHERE id = ? AND status = 'active'",
      [now, id],
    );
    if (result.changes === 0) return null;
    return this.getAutopilot(id);
  }

  pauseAutopilotsExceedingFailureThreshold(
    options: MultiremiAutopilotFailureThresholdOptions = {},
  ): MultiremiAutopilotFailureThresholdCandidate[] {
    const paused: MultiremiAutopilotFailureThresholdCandidate[] = [];
    for (const candidate of this.selectAutopilotsExceedingFailureThreshold(options)) {
      const autopilot = this.systemPauseAutopilot(candidate.autopilot.id);
      if (!autopilot) continue;
      const pausedCandidate = { ...candidate, autopilot };
      this.emitAutopilotPausedNotifications(pausedCandidate, options);
      this.ctx.emitWorkspaceEvent({
        type: "autopilot:updated",
        workspaceId: autopilot.workspaceId,
        actorType: "system",
        actorId: null,
        payload: { autopilot, reason: "auto_paused_high_failure_rate" },
      });
      paused.push(pausedCandidate);
    }
    return paused;
  }

  private emitAutopilotPausedNotifications(
    candidate: MultiremiAutopilotFailureThresholdCandidate,
    options: MultiremiAutopilotFailureThresholdOptions,
  ): void {
    const { autopilot } = candidate;
    const recipients = this.ctx.resolveAutopilotNotificationRecipients(autopilot);
    if (!recipients.length) return;
    const failPct = Math.round(candidate.failRatio * 1000) / 10;
    const lookbackMs = normalizeFailureMonitorLookbackMs(options.lookbackMs);
    const minRuns = normalizePositiveInt(options.minRuns, AUTOPILOT_FAILURE_MONITOR_MIN_RUNS);
    const failRatioThreshold = normalizeUnitRatio(options.failRatioThreshold, AUTOPILOT_FAILURE_MONITOR_FAIL_RATIO);
    const title = `Autopilot paused: ${autopilot.title}`;
    const body = `Auto-paused after ${candidate.failedRuns} of ${candidate.totalRuns} runs failed (${failPct.toFixed(1)}%) in the last ${formatLookbackMs(lookbackMs)}. Investigate the failures, fix the root cause, then re-enable from the autopilot page.`;
    const details = {
      autopilot_id: autopilot.id,
      autopilot_title: autopilot.title,
      failed_runs: candidate.failedRuns,
      total_runs: candidate.totalRuns,
      fail_pct: failPct,
      lookback_seconds: Math.floor(lookbackMs / 1000),
      threshold_min_runs: minRuns,
      threshold_fail_ratio: failRatioThreshold,
      reason: "auto_paused_high_failure_rate",
    };
    const emitted = new Set<string>();
    for (const recipientId of recipients) {
      if (emitted.has(recipientId)) continue;
      emitted.add(recipientId);
      this.ctx.createInboxItem({
        workspaceId: autopilot.workspaceId,
        memberId: recipientId,
        recipientType: "member",
        recipientId,
        type: "autopilot_paused",
        severity: "attention",
        title,
        body,
        actorType: "system",
        actorId: null,
        details,
        emitEvent: true,
      });
    }
  }

  private assertFeishuEventConfigScope(
    config: MultiremiAutopilotFeishuEventConfig,
    autopilot: MultiremiAutopilot,
  ): void {
    const issue = this.ctx.issues().getIssue(config.triggerIssueId);
    if (!issue || issue.workspaceId !== autopilot.workspaceId) {
      throw new Error("event_config.trigger_issue_id must reference an issue in this workspace");
    }
    if (autopilot.projectId && issue.projectId !== autopilot.projectId) {
      throw new Error("event_config.trigger_issue_id must reference an issue in the Autopilot project");
    }
    for (const sourceId of config.sourceIds ?? config.source_ids ?? []) {
      const source = this.ctx.db.query(
        "SELECT workspace_id FROM multiremi_feishu_sources WHERE id = ?",
      ).get(sourceId) as Row | null;
      if (!source || String(source.workspace_id) !== autopilot.workspaceId) {
        throw new Error("event_config.source_ids must reference Feishu sources in this workspace");
      }
    }
  }
  private assertScmEventConfigScope(
    config: MultiremiAutopilotScmEventConfig,
    workspaceId: string,
  ): void {
    const connectionId = config.connectionId ?? config.connection_id ?? null;
    const repositoryIds = config.repositoryIds ?? config.repository_ids ?? [];
    if (connectionId) {
      const connection = this.ctx.db.query(
        "SELECT workspace_id FROM multiremi_scm_connections WHERE id = ?",
      ).get(connectionId) as Row | null;
      if (!connection || String(connection.workspace_id) !== workspaceId) {
        throw new Error("event_config.connection_id must reference an SCM connection in this workspace");
      }
    }
    for (const repositoryId of repositoryIds) {
      const binding = connectionId
        ? this.ctx.db.query(
          `SELECT 1 AS found FROM multiremi_scm_repository_bindings
           WHERE workspace_id = ? AND repository_id = ? AND connection_id = ?`,
        ).get(workspaceId, repositoryId, connectionId)
        : this.ctx.db.query(
          `SELECT 1 AS found FROM multiremi_scm_repository_bindings
           WHERE workspace_id = ? AND repository_id = ?`,
        ).get(workspaceId, repositoryId);
      if (!binding) {
        throw new Error("event_config.repository_ids must reference repositories bound in this workspace");
      }
    }
    if (config.branch && config.events.some((event) => event.startsWith("comment.") || event.startsWith("review."))) {
      throw new Error("event_config.branch is not supported for comment or review events because providers do not expose branch context");
    }

    const args: unknown[] = [workspaceId];
    const clauses = ["b.workspace_id = ?", "b.enabled = 1", "c.enabled = 1"];
    if (connectionId) {
      clauses.push("b.connection_id = ?");
      args.push(connectionId);
    }
    if (repositoryIds.length) {
      clauses.push(`b.repository_id IN (${repositoryIds.map(() => "?").join(", ")})`);
      args.push(...repositoryIds);
    }
    const scopes = this.ctx.db.query(
      `SELECT b.repository_id, b.default_branch, c.provider, c.mode
       FROM multiremi_scm_repository_bindings b
       JOIN multiremi_scm_connections c ON c.id = b.connection_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY b.repository_id ASC`,
    ).all(...args) as Row[];
    if (!scopes.length) {
      throw new Error("event_config must select at least one bound SCM repository");
    }
    for (const scope of scopes) {
      const provider = String(scope.provider);
      const mode = String(scope.mode);
      for (const event of config.events) {
        if (!scmConnectionCanProduceEvent(
          provider,
          mode,
          event,
          config.branch ?? null,
          cleanOptionalString(scope.default_branch) ?? null,
        )) {
          throw new Error(
            `event_config.events includes ${event}, which ${provider} ${mode} cannot produce for repository ${String(scope.repository_id)}`,
          );
        }
      }
    }
  }

  runAutopilot(autopilotId: string, input: RunAutopilotStoreInput = {}): MultiremiAutopilotRunRecord {
    const source = input.source ?? "manual";
    const triggerId = cleanOptionalString(input.triggerId ?? input.trigger_id) ?? null;
    const eventId = cleanOptionalString(input.eventId ?? input.event_id) ?? null;
    const triggerIssueId = cleanOptionalString(input.triggerIssueId ?? input.trigger_issue_id) ?? null;
    const repositoryId = cleanOptionalString(input.repositoryId ?? input.repository_id) ?? null;
    const dedupeKey = cleanOptionalString(input.dedupeKey ?? input.dedupe_key) ?? null;
    const sourceTaskId = cleanOptionalString(input.sourceTaskId ?? input.source_task_id) ?? null;
    if (eventId && !triggerId) throw new Error("event_id requires trigger_id");
    if (source === "system_event" && (!triggerId || !eventId)) {
      throw new Error("system_event runs require trigger_id and event_id");
    }

    let taskToNotify: MultiremiTask | null = null;
    let createdRun = false;
    let startedAutopilot: MultiremiAutopilot | null = null;
    const run = this.ctx.db.transaction(() => {
      const autopilot = this.getAutopilot(autopilotId);
      if (!autopilot) throw new Error(`Autopilot not found: ${autopilotId}`);
      this.assertRepositoryWikiBuildScope(autopilot, repositoryId, dedupeKey);
      let trigger: MultiremiAutopilotTrigger | null = null;
      if (triggerId) {
        trigger = this.getAutopilotTrigger(triggerId);
        if (!trigger || trigger.autopilotId !== autopilot.id) throw new Error(`Autopilot trigger not found: ${triggerId}`);
      }
      const sourceTask = sourceTaskId ? this.ctx.tasks().getTask(sourceTaskId) : null;
      if (sourceTaskId && !sourceTask) throw new Error(`Source task not found: ${sourceTaskId}`);
      if (sourceTask && sourceTask.workspaceId !== autopilot.workspaceId) {
        throw new Error("Source task belongs to another workspace");
      }

      if (triggerId && eventId) {
        const duplicate = this.ctx.db.query(
          "SELECT * FROM multiremi_autopilot_runs WHERE trigger_id = ? AND event_id = ? LIMIT 1",
        ).get(triggerId, eventId) as Row | null;
        if (duplicate) return toAutopilotRun(duplicate);
      }

      // Repository Wiki build idempotency (callers pass repositoryId/dedupeKey
      // only for the Atlas Repository Wiki autopilot; other autopilots are
      // unaffected). Two rules, both inside this transaction:
      //  1. one non-terminal build per (autopilot, repository) — a second
      //     request while a build is queued/running returns the existing run;
      //  2. a completed, store-verified published run for the same pinned-
      //     revision dedupe key is authoritative, so a late event for the same
      //     revision (for example default_branch.updated after change.merged)
      //     reuses it. A completed run without publication evidence never
      //     blocks retry. Keys ending in ":head" target a moving revision and
      //     never dedupe on success, so a manual rebuild after a completed
      //     build is always allowed.
      // failed / skipped runs are terminal and never block a retry.
      if (repositoryId) {
        const active = this.ctx.db.query(
          `SELECT * FROM multiremi_autopilot_runs
           WHERE autopilot_id = ? AND repository_id = ?
             AND status IN (${ACTIVE_RUN_STATUSES.map(() => "?").join(", ")})
           ORDER BY created_at DESC, id DESC LIMIT 1`,
        ).get(autopilotId, repositoryId, ...ACTIVE_RUN_STATUSES) as Row | null;
        if (active) return { ...toAutopilotRun(active), deduplicated: true };
      }
      if (dedupeKey && !dedupeKey.endsWith(":head")) {
        const completed = (this.ctx.db.query(
          `SELECT * FROM multiremi_autopilot_runs
           WHERE autopilot_id = ? AND dedupe_key = ? AND status = 'completed'
           ORDER BY created_at DESC, id DESC`,
        ).all(autopilotId, dedupeKey) as Row[])
          .map(toAutopilotRun)
          .find((candidate) => this.repositoryWikiRunHasPublication(candidate));
        if (completed) return { ...completed, deduplicated: true };
      }

      const now = nowIso();
      const runId = createId("run");
      const explicitPrompt = cleanOptionalString(input.prompt);
      const prompt = explicitPrompt
        ?? (autopilot.executionMode === "create_issue"
          ? autopilot.issueTitleTemplate || autopilot.title
          : autopilot.description || autopilot.issueTitleTemplate || autopilot.title);
      const agent = this.ctx.resolveAutopilotAgent(autopilot);
      const issueCreationRestricted = Boolean(
        autopilot.issueCreationRestricted
        || trigger?.issueCreationRestricted
        || sourceTask?.issueCreationRestricted
        || agent?.issueCreationRequiresProposal,
      );
      const skippedReason = !agent
        ? "No runnable agent"
        : autopilot.status !== "active"
          ? "Autopilot is not active"
          : null;
      const inserted = this.ctx.db.run(
        `INSERT OR IGNORE INTO multiremi_autopilot_runs (
          id, autopilot_id, source, status, issue_id, task_id, source_task_id, trigger_id, event_id,
          issue_session_id, repository_id, dedupe_key, triggered_at, completed_at,
          failure_reason, payload, result, created_at
        ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        [
          runId,
          autopilotId,
          source,
          skippedReason ? "skipped" : "running",
          sourceTaskId,
          triggerId,
          eventId,
          repositoryId,
          dedupeKey,
          now,
          skippedReason ? now : null,
          skippedReason,
          input.payload == null ? null : toJson(input.payload),
          now,
        ],
      );
      if (inserted.changes === 0 && triggerId && eventId) {
        const duplicate = this.ctx.db.query(
          "SELECT * FROM multiremi_autopilot_runs WHERE trigger_id = ? AND event_id = ? LIMIT 1",
        ).get(triggerId, eventId) as Row | null;
        if (duplicate) return toAutopilotRun(duplicate);
      }
      createdRun = true;
      this.ctx.db.run(
        "UPDATE multiremi_autopilots SET last_run_at = ?, updated_at = ? WHERE id = ?",
        [now, now, autopilotId],
      );
      if (skippedReason || !agent) return this.getAutopilotRun(runId)!;
      if (autopilot.executionMode === "create_issue" && issueCreationRestricted) {
        throw new Error("issue_creation_requires_proposal");
      }

      let issue: MultiremiIssue | null = null;
      let issueSessionId: string | null = null;
      if (autopilot.executionMode === "create_issue") {
        issue = this.ctx.issues().createIssue({
          title: prompt,
          description: autopilot.description,
          workspaceId: autopilot.workspaceId,
          projectId: autopilot.projectId,
          createdBy: autopilot.id,
        });
      } else if (autopilot.executionMode === "trigger_issue") {
        if (!triggerIssueId) throw new Error("trigger_issue runs require trigger_issue_id");
        issue = this.ctx.issues().getIssue(triggerIssueId);
        if (!issue) throw new Error(`Issue not found: ${triggerIssueId}`);
        if (issue.workspaceId !== autopilot.workspaceId) throw new Error("Trigger issue belongs to another workspace");
        if (autopilot.projectId && issue.projectId !== autopilot.projectId) {
          throw new Error("Trigger issue does not belong to the Autopilot project");
        }
        if (eventId) {
          const event = this.getSystemEvent(eventId);
          const trigger = triggerId ? this.getAutopilotTrigger(triggerId) : null;
          const feishuConfig = trigger?.eventConfig?.resource === "feishu_source"
            ? trigger.eventConfig
            : null;
          const eventBelongsToTarget = feishuConfig
            ? feishuConfig.triggerIssueId === issue.id
              && Boolean(event)
              && systemEventMatchesConfig(event!, feishuConfig)
            : event?.resourceId === issue.id;
          if (!event || !eventBelongsToTarget || event.workspaceId !== issue.workspaceId) {
            throw new Error("System event does not belong to the trigger issue");
          }
        }
        const issueSession = autopilot.sessionPolicy === "reuse_latest"
          ? this.ctx.issueSessions().getLatestActiveIssueSession(issue.id)
            ?? this.ctx.issueSessions().getOrCreateDefaultIssueSession(issue.id)
          : this.ctx.issueSessions().createIssueSessionWithinTransaction(issue.id, {
            title: `${autopilot.title} · ${issue.key}`,
            createdByType: "agent",
            createdById: agent.id,
            participantAgentIds: [agent.id],
          });
        issueSessionId = issueSession.id;
      }

      const task = this.ctx.tasks().createTaskWithinTransaction({
        agentId: agent.id,
        issueId: issue?.id ?? null,
        issueSessionId,
        workspaceId: autopilot.workspaceId,
        prompt,
        assignmentAuthorType: "system",
        assignmentAuthorId: autopilot.id,
        assignmentSourceEventId: eventId,
        parentTaskId: sourceTaskId,
        issueCreationRestricted,
      });
      taskToNotify = task;
      issueSessionId = task.issueSessionId ?? issueSessionId;
      this.ctx.db.run(
        `UPDATE multiremi_autopilot_runs
         SET issue_id = ?, task_id = ?, issue_session_id = ?, result = ?
         WHERE id = ?`,
        [
          issue?.id ?? null,
          task.id,
          issueSessionId,
          toJson({ taskId: task.id, issueId: issue?.id ?? null, issueSessionId }),
          runId,
        ],
      );
      startedAutopilot = autopilot;
      return this.getAutopilotRun(runId)!;
    })();

    if (taskToNotify) this.ctx.notifyTaskEnqueued(taskToNotify);
    if (createdRun && startedAutopilot && run.status === "running") {
      this.ctx.analytics().recordAutopilotRunStartedAnalytics(startedAutopilot, run);
    }
    return run;
  }

  private repositoryWikiRunHasPublication(run: MultiremiAutopilotRunRecord): boolean {
    if (!run.repositoryId) return false;
    const autopilot = this.getAutopilot(run.autopilotId);
    if (!autopilot) return false;
    const sourceRevision = autopilotRunSourceRevision(run);
    const predicates: string[] = [];
    const params = [autopilot.workspaceId, run.repositoryId];
    if (run.taskId) {
      predicates.push("doc.source_task_id = ?");
      params.push(run.taskId);
    }
    if (sourceRevision) {
      predicates.push("(doc.source_revision = ? OR revision.source_revision = ?)");
      params.push(sourceRevision, sourceRevision);
    }
    if (predicates.length === 0) return false;

    const row = this.ctx.db.query(
      `SELECT 1 AS published
       FROM multiremi_repository_wiki_docs doc
       LEFT JOIN multiremi_repository_wiki_doc_revisions revision ON revision.doc_id = doc.id
       WHERE doc.workspace_id = ? AND doc.repository_id = ?
         AND (${predicates.join(" OR ")})
       LIMIT 1`,
    ).get(...params) as { published: number } | null;
    return row != null;
  }

  private assertRepositoryWikiBuildScope(
    autopilot: MultiremiAutopilot,
    repositoryId: string | null,
    dedupeKey: string | null,
  ): void {
    if ((repositoryId == null) !== (dedupeKey == null)) {
      throw new Error("Repository Wiki build scope requires repository_id and dedupe_key together");
    }
    if (!repositoryId || !dedupeKey) return;

    const repositoryAutopilot = resolveAtlasRepositoryWikiAutopilot(
      autopilot.workspaceId,
      this.ctx.agents().listAgents(),
      this.listAutopilots(autopilot.workspaceId),
    );
    if (repositoryAutopilot?.id !== autopilot.id) {
      throw new Error("Repository Wiki build scope requires the server-owned Atlas Repository Wiki autopilot");
    }

    const separator = dedupeKey.indexOf(":");
    if (separator <= 0 || dedupeKey.slice(0, separator) !== repositoryId) {
      throw new Error("Repository Wiki build dedupe_key must start with its repository_id segment");
    }
  }

  getAutopilotRun(id: string): MultiremiAutopilotRunRecord | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_autopilot_runs WHERE id = ?").get(id) as Row | null;
    return row ? toAutopilotRun(row) : null;
  }

  listWebhookDeliveries(autopilotId: string, options: { includeRawBody?: boolean; limit?: number } = {}): MultiremiWebhookDelivery[] {
    const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 20)));
    const rawBodyColumn = options.includeRawBody ? "raw_body" : "NULL AS raw_body";
    const rows = this.ctx.db.query(
      `SELECT id, workspace_id, autopilot_id, trigger_id, provider, event, dedupe_key, dedupe_source,
        signature_status, status, attempt_count, selected_headers, content_type, ${rawBodyColumn},
        response_status, response_body, autopilot_run_id, replayed_from_delivery_id, error,
        received_at, last_attempt_at, created_at
       FROM multiremi_webhook_deliveries
       WHERE autopilot_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    ).all(autopilotId, limit) as Row[];
    return rows.map(toWebhookDelivery);
  }

  getWebhookDelivery(id: string): MultiremiWebhookDelivery | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_webhook_deliveries WHERE id = ?").get(id) as Row | null;
    return row ? toWebhookDelivery(row) : null;
  }

  handleAutopilotWebhook(autopilotId: string, input: {
    payload?: unknown | null;
    rawBody?: string | null;
    headers?: Record<string, string | null | undefined>;
    prompt?: string | null;
    provider?: MultiremiWebhookProvider | string | null;
    signatureStatus?: MultiremiWebhookSignatureStatus | string | null;
    replayedFromDeliveryId?: string | null;
    triggerId?: string | null;
    sourceTaskId?: string | null;
  } = {}): MultiremiWebhookDeliveryResult {
    const autopilot = this.getAutopilot(autopilotId);
    if (!autopilot) throw new Error(`Autopilot not found: ${autopilotId}`);
    const trigger = input.triggerId ? this.getAutopilotTrigger(input.triggerId) : null;
    if (input.triggerId && (!trigger || trigger.autopilotId !== autopilotId)) throw new Error(`Autopilot trigger not found: ${input.triggerId}`);
    const provider = normalizeWebhookProvider(input.provider);
    const headers = normalizeWebhookHeaders(input.headers ?? {});
    const now = nowIso();
    const envelope = normalizeWebhookEnvelope(headers, input.rawBody, input.payload, now);
    const event = envelope.event;
    const [dedupeKey, dedupeSource] = input.replayedFromDeliveryId ? ["", ""] : webhookDedupeKey(provider, headers);
    const signatureStatus = normalizeWebhookSignatureStatus(input.signatureStatus);
    const triggerId = trigger?.id ?? autopilot.id;
    if (dedupeKey) {
      const duplicate = this.ctx.db.query(
        `SELECT * FROM multiremi_webhook_deliveries
         WHERE trigger_id = ? AND dedupe_key = ? AND status NOT IN ('rejected', 'failed')
         ORDER BY created_at ASC LIMIT 1`,
      ).get(triggerId, dedupeKey) as Row | null;
      if (duplicate) {
        this.ctx.db.run(
          "UPDATE multiremi_webhook_deliveries SET attempt_count = attempt_count + 1, last_attempt_at = ? WHERE id = ?",
          [now, String(duplicate.id)],
        );
        const delivery = this.getWebhookDelivery(String(duplicate.id))!;
        const run = delivery.autopilotRunId ? this.getAutopilotRun(delivery.autopilotRunId) : null;
        return { status: "duplicate", duplicate: true, delivery, run };
      }
    }

    const deliveryId = createId("whd");
    this.ctx.db.run(
      `INSERT INTO multiremi_webhook_deliveries (
        id, workspace_id, autopilot_id, trigger_id, provider, event, dedupe_key, dedupe_source,
        signature_status, status, attempt_count, selected_headers, content_type, raw_body,
        source_task_id, response_status, response_body, autopilot_run_id, replayed_from_delivery_id, error,
        received_at, last_attempt_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 1, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, ?, ?, ?)`,
      [
        deliveryId,
        autopilot.workspaceId,
        autopilot.id,
        triggerId,
        provider,
        event,
        dedupeKey || null,
        dedupeSource || null,
        signatureStatus,
        toJson(selectedWebhookHeaders(headers)),
        envelope.request.contentType ?? null,
        input.rawBody ?? toJson(envelope.eventPayload),
        cleanOptionalString(input.sourceTaskId),
        input.replayedFromDeliveryId ?? null,
        now,
        now,
        now,
      ],
    );

    if (signatureStatus === "invalid" || signatureStatus === "missing") {
      const reason = signatureStatus === "missing" ? "missing_signature" : "invalid_signature";
      const responseBody = { status: "rejected", deliveryId, reason };
      const delivery = this.finalizeWebhookDelivery(deliveryId, {
        status: "rejected",
        responseStatus: 401,
        responseBody,
        error: reason,
      });
      return { status: "rejected", duplicate: false, delivery, run: null };
    }

    if (autopilot.status !== "active" || (trigger && !trigger.enabled) || (trigger && trigger.kind !== "webhook") || (!trigger && autopilot.triggerKind !== "webhook")) {
      const reason = autopilot.status !== "active"
        ? `autopilot_${autopilot.status}`
        : trigger && !trigger.enabled
          ? "trigger_disabled"
          : "trigger_not_webhook";
      const responseBody = { status: "ignored", deliveryId, reason };
      const delivery = this.finalizeWebhookDelivery(deliveryId, {
        status: "ignored",
        responseStatus: 200,
        responseBody,
        error: reason,
      });
      return { status: "ignored", duplicate: false, delivery, run: null };
    }

    if (!input.replayedFromDeliveryId && trigger && !webhookEventAllowedByTriggerScope(trigger.eventFilters, envelope)) {
      const responseBody = { status: "ignored", deliveryId, reason: "event_filtered", event };
      const delivery = this.finalizeWebhookDelivery(deliveryId, {
        status: "ignored",
        responseStatus: 200,
        responseBody,
        error: "event_filtered",
      });
      return { status: "ignored", duplicate: false, delivery, run: null };
    }

    try {
      const run = this.runAutopilot(autopilot.id, {
        prompt: input.prompt ?? null,
        payload: envelope,
        source: "webhook",
        sourceTaskId: input.sourceTaskId,
        triggerId: trigger?.id ?? null,
      });
      if (trigger) {
        this.ctx.db.run("UPDATE multiremi_autopilot_triggers SET last_fired_at = ?, updated_at = ? WHERE id = ?", [now, now, trigger.id]);
      }
      const responseStatus = run.status === "skipped" ? 200 : 201;
      const responseBody = { status: run.status === "skipped" ? "skipped" : "accepted", deliveryId, runId: run.id };
      const delivery = this.finalizeWebhookDelivery(deliveryId, {
        status: "dispatched",
        responseStatus,
        responseBody,
        autopilotRunId: run.id,
      });
      return { status: run.status === "skipped" ? "skipped" : "accepted", duplicate: false, delivery, run };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const responseBody = { status: "failed", deliveryId, error: message };
      const delivery = this.finalizeWebhookDelivery(deliveryId, {
        status: "failed",
        responseStatus: 500,
        responseBody,
        error: message,
      });
      return { status: "failed", duplicate: false, delivery, run: null };
    }
  }

  replayWebhookDelivery(
    autopilotId: string,
    deliveryId: string,
    options: { sourceTaskId?: string | null } = {},
  ): MultiremiWebhookDeliveryResult {
    const delivery = this.getWebhookDelivery(deliveryId);
    if (!delivery || delivery.autopilotId !== autopilotId) throw new Error(`Webhook delivery not found: ${deliveryId}`);
    if (delivery.status === "rejected" || delivery.signatureStatus === "invalid" || delivery.signatureStatus === "missing") {
      throw new Error("Cannot replay a rejected delivery");
    }
    const sourceRow = this.ctx.db.query(
      "SELECT source_task_id FROM multiremi_webhook_deliveries WHERE id = ?",
    ).get(delivery.id) as Row | null;
    const payload = delivery.rawBody ? parseJson(delivery.rawBody, null) : null;
    return this.handleAutopilotWebhook(autopilotId, {
      payload,
      rawBody: delivery.rawBody,
      headers: replayHeadersFromDelivery(delivery),
      provider: delivery.provider,
      signatureStatus: "not_required",
      replayedFromDeliveryId: delivery.id,
      sourceTaskId: options.sourceTaskId ?? nullableString(sourceRow?.source_task_id),
    });
  }

  handleAutopilotWebhookByToken(token: string, input: {
    payload?: unknown | null;
    rawBody?: string | null;
    headers?: Record<string, string | null | undefined>;
    prompt?: string | null;
    provider?: MultiremiWebhookProvider | string | null;
    signatureStatus?: MultiremiWebhookSignatureStatus | string | null;
  } = {}): MultiremiWebhookDeliveryResult | null {
    const trigger = this.getAutopilotTriggerByWebhookToken(token);
    if (!trigger) return null;
    return this.handleAutopilotWebhook(trigger.autopilotId, { ...input, triggerId: trigger.id });
  }

  private finalizeWebhookDelivery(id: string, input: {
    status: MultiremiWebhookDeliveryStatus;
    responseStatus: number;
    responseBody: unknown;
    autopilotRunId?: string | null;
    error?: string | null;
  }): MultiremiWebhookDelivery {
    this.ctx.db.run(
      `UPDATE multiremi_webhook_deliveries SET
        status = ?,
        response_status = ?,
        response_body = ?,
        autopilot_run_id = ?,
        error = ?,
        last_attempt_at = ?
       WHERE id = ?`,
      [
        input.status,
        input.responseStatus,
        typeof input.responseBody === "string" ? input.responseBody : toJson(input.responseBody),
        input.autopilotRunId ?? null,
        input.error ?? null,
        nowIso(),
        id,
      ],
    );
    const delivery = this.getWebhookDelivery(id)!;
    this.ctx.analytics().recordWebhookDeliveryMetric(delivery);
    return delivery;
  }
}

function normalizeAutopilotCreatorType(value: unknown): "member" | "agent" {
  return value === "agent" ? "agent" : "member";
}

function normalizeIssueCreationRestrictionReason(value: unknown): "restricted_task" | "human_policy" {
  return value === "restricted_task" ? "restricted_task" : "human_policy";
}

function isAutopilotExecutionMode(value: unknown): value is MultiremiAutopilot["executionMode"] {
  return value === "create_issue" || value === "run_only" || value === "trigger_issue";
}

function normalizeWebhookProvider(value: unknown): MultiremiWebhookProvider {
  if (value === "github" || value === "codebase") return value;
  return "generic";
}

function normalizeWebhookSignatureStatus(value: unknown): MultiremiWebhookSignatureStatus {
  if (value === "valid" || value === "invalid" || value === "missing") return value;
  return "not_required";
}

function normalizeWebhookDeliveryStatus(value: unknown): MultiremiWebhookDeliveryStatus {
  if (value === "dispatched" || value === "rejected" || value === "ignored" || value === "failed") return value;
  return "queued";
}

function normalizeWebhookHeaders(headers: Record<string, string | null | undefined>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue;
    normalized[key.toLowerCase()] = String(value);
  }
  return normalized;
}

function webhookDedupeKey(provider: MultiremiWebhookProvider, headers: Record<string, string>): [string, string] {
  if (provider === "github" && headers["x-github-delivery"]?.trim()) {
    return [headers["x-github-delivery"].trim(), "x-github-delivery"];
  }
  if (headers["idempotency-key"]?.trim()) return [headers["idempotency-key"].trim(), "idempotency-key"];
  if (headers["x-github-delivery"]?.trim()) return [headers["x-github-delivery"].trim(), "x-github-delivery"];
  return ["", ""];
}

function inferWebhookEvent(headers: Record<string, string>, payload: unknown): string {
  if (headers["x-github-event"]) {
    const action = isRecord(payload) && typeof payload.action === "string" ? "." + payload.action : "";
    return "github." + headers["x-github-event"] + action;
  }
  if (headers["x-gitlab-event"]) return "gitlab." + headers["x-gitlab-event"];
  if (headers["x-event-type"]) return headers["x-event-type"];
  if (isRecord(payload) && typeof payload.event === "string") return payload.event;
  if (isRecord(payload) && typeof payload.type === "string") return payload.type;
  if (isRecord(payload) && typeof payload.action === "string") return payload.action;
  return "webhook.received";
}

interface MultiremiWebhookEnvelope {
  event: string;
  eventPayload: unknown;
  request: {
    receivedAt: string;
    contentType?: string;
  };
}

function normalizeWebhookEnvelope(
  headers: Record<string, string>,
  rawBody: string | null | undefined,
  fallbackPayload: unknown,
  receivedAt: string,
): MultiremiWebhookEnvelope {
  const parsed = parseWebhookBody(rawBody, fallbackPayload);
  const contentType = normalizeWebhookContentType(headers["content-type"]);
  const request: MultiremiWebhookEnvelope["request"] = { receivedAt };
  if (contentType) request.contentType = contentType;
  if (isRecord(parsed) && typeof parsed.event === "string" && parsed.event.trim()) {
    return {
      event: parsed.event,
      eventPayload: Object.prototype.hasOwnProperty.call(parsed, "eventPayload") ? parsed.eventPayload : parsed,
      request,
    };
  }
  return {
    event: inferWebhookEvent(headers, parsed),
    eventPayload: parsed,
    request,
  };
}

function parseWebhookBody(rawBody: string | null | undefined, fallbackPayload: unknown): unknown {
  const text = stripWebhookBom(String(rawBody ?? "")).trim();
  if (text) {
    const parsed = parseJson(text, undefined);
    if (isRecord(parsed) || Array.isArray(parsed)) return parsed;
    throw new Error("body must be a JSON object or array");
  }
  if (fallbackPayload == null) return {};
  if (isRecord(fallbackPayload) || Array.isArray(fallbackPayload)) return fallbackPayload;
  throw new Error("body must be a JSON object or array");
}

function normalizeWebhookContentType(value: string | undefined): string {
  return String(value ?? "").split(";")[0]!.trim();
}

function stripWebhookBom(value: string): string {
  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value;
}

function normalizeWebhookEventFilters(value: unknown): MultiremiWebhookEventFilter[] | null {
  if (value == null) return null;
  if (!Array.isArray(value)) throw new Error("event_filters must be an array");
  const filters: MultiremiWebhookEventFilter[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!isRecord(item)) throw new Error(`event_filters[${index}] must be an object`);
    const event = typeof item.event === "string" ? item.event.trim() : "";
    if (!event) throw new Error(`event_filters[${index}].event must not be empty`);
    let actions: string[] | undefined;
    if (item.actions !== undefined) {
      if (!Array.isArray(item.actions)) throw new Error(`event_filters[${index}].actions must be an array`);
      actions = item.actions.map((action, actionIndex) => {
        const value = typeof action === "string" ? action.trim() : "";
        if (!value) throw new Error(`event_filters[${index}].actions[${actionIndex}] must not be empty`);
        return value;
      });
    }
    filters.push(actions && actions.length ? { event, actions } : { event });
  }
  return filters;
}

function parseWebhookEventFiltersRow(value: unknown): MultiremiWebhookEventFilter[] | null {
  if (value == null || value === "") return null;
  try {
    return normalizeWebhookEventFilters(parseJson(value, null));
  } catch {
    return [{ event: "__malformed_event_filters__" }];
  }
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

function normalizeAutopilotEventConfig(value: unknown): MultiremiAutopilotEventConfig | null {
  if (value == null) return null;
  if (!isRecord(value)) throw new Error("event_config must be an object");
  if (value.resource === "scm") return normalizeScmEventConfig(value);
  if (value.resource === "feishu_source") return normalizeFeishuEventConfig(value);
  return normalizeSystemEventConfig(value);
}

function normalizeFeishuEventConfig(value: Record<string, unknown>): MultiremiAutopilotFeishuEventConfig {
  if (value.event !== "messages_ingested") {
    throw new Error("event_config.event must be messages_ingested");
  }
  const triggerIssueId = cleanOptionalString(value.triggerIssueId ?? value.trigger_issue_id);
  if (!triggerIssueId) throw new Error("event_config.trigger_issue_id is required");
  const sourceIdsValue = value.sourceIds ?? value.source_ids;
  if (sourceIdsValue != null && !Array.isArray(sourceIdsValue)) {
    throw new Error("event_config.source_ids must be an array");
  }
  const sourceIds = sourceIdsValue == null
    ? []
    : [...new Set(sourceIdsValue.map((sourceId, index) => {
      const normalized = cleanOptionalString(sourceId);
      if (!normalized) throw new Error(`event_config.source_ids[${index}] must be a non-empty string`);
      return normalized;
    }))];
  return {
    resource: "feishu_source",
    event: "messages_ingested",
    triggerIssueId,
    trigger_issue_id: triggerIssueId,
    ...(sourceIds.length ? { sourceIds, source_ids: sourceIds } : {}),
  };
}

function normalizeSystemEventConfig(value: unknown): MultiremiAutopilotSystemEventConfig {
  if (!isRecord(value)) throw new Error("event_config must be an object");
  if (value.resource !== "issue") throw new Error("event_config.resource must be issue");
  if (value.event !== "status_changed") throw new Error("event_config.event must be status_changed");
  if (!Array.isArray(value.conditions) || value.conditions.length === 0) {
    throw new Error("event_config.conditions must be a non-empty array");
  }
  const conditions = value.conditions.map((condition, index) => {
    if (!isRecord(condition)) throw new Error(`event_config.conditions[${index}] must be an object`);
    if (condition.field !== "status") throw new Error(`event_config.conditions[${index}].field must be status`);
    if (condition.operator !== "becomes") throw new Error(`event_config.conditions[${index}].operator must be becomes`);
    const target = typeof condition.value === "string" ? condition.value.trim() : "";
    if (!SYSTEM_EVENT_ISSUE_STATUSES.has(target)) {
      throw new Error(`event_config.conditions[${index}].value must be a valid issue status`);
    }
    return { field: "status" as const, operator: "becomes" as const, value: target as MultiremiAutopilotSystemEventConfig["conditions"][number]["value"] };
  });
  const projectId = cleanOptionalString(value.projectId ?? value.project_id) ?? null;
  return {
    resource: "issue",
    event: "status_changed",
    conditions,
    ...(projectId ? { projectId, project_id: projectId } : {}),
  };
}

const SCM_EVENT_TYPES = new Set<MultiremiScmCanonicalEventType>([
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
]);

function scmConnectionCanProduceEvent(
  provider: string,
  mode: string,
  event: MultiremiScmCanonicalEventType,
  branch: string | null,
  defaultBranch: string | null,
): boolean {
  if (provider !== "github" && provider !== "codebase") return false;
  if (mode !== "poll" && mode !== "webhook" && mode !== "hybrid") return false;
  const stream = scmEventStream(event);
  const capabilities = SCM_PROVIDER_CAPABILITIES[provider];
  if (event === "default_branch.updated" && branch && branch !== defaultBranch) return false;
  const pollCanMatchBranch = !branch || branch === defaultBranch;
  const canPoll = (mode === "poll" || mode === "hybrid")
    && capabilities.streams[stream].poll
    && (event !== "push.observed" || pollCanMatchBranch)
    && (event !== "comment.deleted" || capabilities.supportsDeleteTombstones);
  const canWebhook = (mode === "webhook" || mode === "hybrid")
    && capabilities.streams[stream].webhook;
  return canPoll || canWebhook;
}

function scmEventStream(event: MultiremiScmCanonicalEventType): keyof typeof SCM_PROVIDER_CAPABILITIES.github.streams {
  if (event.startsWith("change.")) return "change_requests";
  if (event.startsWith("comment.")) return "comments";
  if (event.startsWith("review.")) return "reviews";
  if (event.startsWith("pipeline.")) return "pipelines";
  return "default_branch";
}

function normalizeScmEventConfig(value: Record<string, unknown>): MultiremiAutopilotScmEventConfig {
  if (!Array.isArray(value.events) || value.events.length === 0) {
    throw new Error("event_config.events must be a non-empty array");
  }
  const events = [...new Set(value.events.map((event, index) => {
    const normalized = typeof event === "string" ? event.trim() : "";
    if (!SCM_EVENT_TYPES.has(normalized as MultiremiScmCanonicalEventType)) {
      throw new Error(`event_config.events[${index}] must be a supported SCM event`);
    }
    return normalized as MultiremiScmCanonicalEventType;
  }))];
  const connectionId = cleanOptionalString(value.connectionId ?? value.connection_id) ?? null;
  const branch = cleanOptionalString(value.branch) ?? null;
  const repositoryIdsValue = value.repositoryIds ?? value.repository_ids;
  if (repositoryIdsValue != null && !Array.isArray(repositoryIdsValue)) {
    throw new Error("event_config.repositoryIds must be an array");
  }
  const repositoryIds = repositoryIdsValue == null
    ? []
    : [...new Set(repositoryIdsValue.map((repositoryId, index) => {
      const normalized = typeof repositoryId === "string" ? repositoryId.trim() : "";
      if (!normalized) throw new Error(`event_config.repositoryIds[${index}] must not be empty`);
      return normalized;
    }))];
  return {
    resource: "scm",
    events,
    ...(connectionId ? { connectionId, connection_id: connectionId } : {}),
    ...(repositoryIds.length ? { repositoryIds, repository_ids: repositoryIds } : {}),
    ...(branch ? { branch } : {}),
  };
}

function parseAutopilotEventConfigRow(value: unknown): MultiremiAutopilotEventConfig | null {
  if (value == null || value === "") return null;
  try {
    return normalizeAutopilotEventConfig(parseJson(value, null));
  } catch {
    return null;
  }
}

function webhookEventAllowedByTriggerScope(
  filters: MultiremiWebhookEventFilter[] | null,
  envelope: MultiremiWebhookEnvelope,
): boolean {
  if (!filters?.length) return true;
  const [, eventName, eventAction] = splitWebhookEvent(envelope.event);
  const candidates = webhookActionCandidates(eventAction, envelope.eventPayload);
  for (const filter of filters) {
    if (filter.event !== eventName) continue;
    if (!filter.actions?.length) return true;
    for (const action of candidates) {
      if (filter.actions.includes(action)) return true;
    }
  }
  return false;
}

function splitWebhookEvent(event: string): [string, string, string] {
  const parts = event.split(".");
  if (isKnownWebhookProviderPrefix(parts[0] ?? "")) {
    if (parts.length >= 3) return [parts[0]!, parts[1]!, parts.slice(2).join(".")];
    if (parts.length === 2) return [parts[0]!, parts[1]!, ""];
    return [parts[0] ?? "", "", ""];
  }
  if (parts.length >= 2) return ["", parts[0]!, parts.slice(1).join(".")];
  return ["", event, ""];
}

function isKnownWebhookProviderPrefix(value: string): boolean {
  return value === "github" || value === "gitlab" || value === "bitbucket" || value === "gitea";
}

function webhookActionCandidates(eventAction: string, payload: unknown): string[] {
  const seen = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed) seen.add(trimmed);
  };
  add(eventAction);
  if (isRecord(payload)) {
    for (const key of ["action", "state", "conclusion", "status"]) add(payload[key]);
  }
  return [...seen];
}

function selectedWebhookHeaders(headers: Record<string, string>): Record<string, unknown> {
  const selected: Record<string, unknown> = {};
  for (const key of ["user-agent", "x-github-event", "x-github-delivery", "x-gitlab-event", "x-event-type", "idempotency-key"]) {
    if (headers[key]) selected[key] = headers[key];
  }
  if (headers["x-hub-signature-256"]) selected["x-hub-signature-256-present"] = true;
  return selected;
}

function replayHeadersFromDelivery(delivery: MultiremiWebhookDelivery): Record<string, string> {
  const headers: Record<string, string> = {};
  if (delivery.contentType) headers["content-type"] = delivery.contentType;
  for (const key of ["user-agent", "x-github-event", "x-github-delivery", "idempotency-key", "x-gitlab-event", "x-event-type"]) {
    const value = delivery.selectedHeaders[key];
    if (typeof value === "string") headers[key] = value;
  }
  return headers;
}

function normalizeFailureMonitorSince(options: MultiremiAutopilotFailureThresholdOptions): string {
  if (options.since instanceof Date) {
    const time = options.since.getTime();
    return Number.isFinite(time) ? options.since.toISOString() : new Date(Date.now() - AUTOPILOT_FAILURE_MONITOR_LOOKBACK_MS).toISOString();
  }
  if (typeof options.since === "string" && options.since.trim()) {
    const time = Date.parse(options.since);
    return Number.isFinite(time) ? new Date(time).toISOString() : options.since.trim();
  }
  const normalizedLookbackMs = normalizeFailureMonitorLookbackMs(options.lookbackMs);
  return new Date(Date.now() - normalizedLookbackMs).toISOString();
}

function normalizeFailureMonitorLookbackMs(value: number | null | undefined): number {
  const lookbackMs = Number(value ?? AUTOPILOT_FAILURE_MONITOR_LOOKBACK_MS);
  const normalizedLookbackMs = Number.isFinite(lookbackMs) && lookbackMs > 0
    ? Math.floor(lookbackMs)
    : AUTOPILOT_FAILURE_MONITOR_LOOKBACK_MS;
  return normalizedLookbackMs;
}

function formatLookbackMs(value: number): string {
  if (value <= 0) return "0s";
  const hourMs = 60 * 60 * 1000;
  const dayMs = 24 * hourMs;
  if (value >= dayMs && value % dayMs === 0) {
    const days = value / dayMs;
    return days === 1 ? "1 day" : `${days} days`;
  }
  if (value >= hourMs && value % hourMs === 0) {
    const hours = value / hourMs;
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  return `${Math.floor(value / 1000)}s`;
}

function normalizeUnitRatio(value: number | null | undefined, fallback: number): number {
  const ratio = Number(value ?? fallback);
  if (!Number.isFinite(ratio)) return fallback;
  return Math.min(1, Math.max(0, ratio));
}

function toAutopilot(row: Row): MultiremiAutopilot {
  const workspaceId = String(row.workspace_id ?? "local");
  const projectId = nullableString(row.project_id);
  const assigneeType = String(row.assignee_type ?? "agent") as MultiremiAutopilot["assigneeType"];
  const assigneeId = String(row.assignee_id);
  const executionMode = String(row.execution_mode ?? "create_issue") as MultiremiAutopilot["executionMode"];
  const sessionPolicy = String(row.session_policy ?? "new") as MultiremiAutopilot["sessionPolicy"];
  const workspacePolicy = String(row.workspace_policy ?? "reuse_issue") as MultiremiAutopilot["workspacePolicy"];
  const issueTitleTemplate = nullableString(row.issue_title_template);
  const triggerKind = String(row.trigger_kind ?? "manual");
  const triggerLabel = nullableString(row.trigger_label);
  const cronExpression = nullableString(row.cron_expression);
  const issueCreationRestricted = Boolean(Number(row.issue_creation_restricted ?? 0));
  const issueCreationRestrictionReason = issueCreationRestricted
    ? normalizeIssueCreationRestrictionReason(row.issue_creation_restriction_reason)
    : null;
  const issueCreationRestrictedByTaskId = issueCreationRestricted
    ? nullableString(row.issue_creation_restricted_by_task_id)
    : null;
  const createdByType = normalizeAutopilotCreatorType(row.created_by_type);
  const createdById = String(row.created_by_id ?? "local");
  const lastRunAt = nullableString(row.last_run_at);
  const createdAt = String(row.created_at);
  const updatedAt = String(row.updated_at);
  const managedKind = nullableString(row.managed_kind) as MultiremiAutopilot["managedKind"];
  return {
    id: String(row.id),
    workspaceId,
    workspace_id: workspaceId,
    title: String(row.title),
    managedKind,
    managed_kind: managedKind,
    description: nullableString(row.description),
    projectId,
    project_id: projectId,
    assigneeType,
    assignee_type: assigneeType,
    assigneeId,
    assignee_id: assigneeId,
    status: String(row.status ?? "active") as MultiremiAutopilot["status"],
    executionMode,
    execution_mode: executionMode,
    sessionPolicy,
    session_policy: sessionPolicy,
    workspacePolicy,
    workspace_policy: workspacePolicy,
    issueTitleTemplate,
    issue_title_template: issueTitleTemplate,
    triggerKind,
    trigger_kind: triggerKind,
    triggerLabel,
    trigger_label: triggerLabel,
    cronExpression,
    cron_expression: cronExpression,
    issueCreationRestricted,
    issue_creation_restricted: issueCreationRestricted,
    issueCreationRestrictionReason,
    issue_creation_restriction_reason: issueCreationRestrictionReason,
    issueCreationRestrictedByTaskId,
    issue_creation_restricted_by_task_id: issueCreationRestrictedByTaskId,
    createdByType,
    created_by_type: createdByType,
    createdById,
    created_by_id: createdById,
    lastRunAt,
    last_run_at: lastRunAt,
    createdAt,
    created_at: createdAt,
    updatedAt,
    updated_at: updatedAt,
  };
}

function toAutopilotTrigger(row: Row): MultiremiAutopilotTrigger {
  const webhookToken = nullableString(row.webhook_token);
  const webhookPath = webhookToken ? `/api/webhooks/autopilots/${webhookToken}` : null;
  const webhookUrl = nullableString(row.webhook_url);
  const kind = String(row.kind ?? "webhook") as MultiremiAutopilotTrigger["kind"];
  const signingSecret = nullableString(row.signing_secret_hash);
  const issueCreationRestricted = Boolean(Number(row.issue_creation_restricted ?? 0));
  return {
    id: String(row.id),
    autopilotId: String(row.autopilot_id),
    kind,
    enabled: Boolean(Number(row.enabled ?? 1)),
    cronExpression: nullableString(row.cron_expression),
    timezone: nullableString(row.timezone),
    nextRunAt: nullableString(row.next_run_at),
    webhookToken,
    webhookPath,
    webhookUrl,
    provider: kind === "webhook" ? normalizeWebhookProvider(row.provider) : null,
    label: nullableString(row.label),
    eventFilters: parseWebhookEventFiltersRow(row.event_filters),
    eventConfig: parseAutopilotEventConfigRow(row.event_config),
    issueCreationRestricted,
    issueCreationRestrictionReason: issueCreationRestricted
      ? normalizeIssueCreationRestrictionReason(row.issue_creation_restriction_reason)
      : null,
    issueCreationRestrictedByTaskId: issueCreationRestricted
      ? nullableString(row.issue_creation_restricted_by_task_id)
      : null,
    signingSecretSet: Boolean(signingSecret),
    signingSecretHint: nullableString(row.signing_secret_hint),
    lastFiredAt: nullableString(row.last_fired_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toAutopilotRun(row: Row): MultiremiAutopilotRunRecord {
  return {
    id: String(row.id),
    autopilotId: String(row.autopilot_id),
    source: String(row.source ?? "manual") as MultiremiAutopilotRun["source"],
    status: String(row.status ?? "running") as MultiremiAutopilotRun["status"],
    issueId: nullableString(row.issue_id),
    taskId: nullableString(row.task_id),
    triggerId: nullableString(row.trigger_id),
    eventId: nullableString(row.event_id),
    issueSessionId: nullableString(row.issue_session_id),
    repositoryId: nullableString(row.repository_id),
    dedupeKey: nullableString(row.dedupe_key),
    triggeredAt: String(row.triggered_at),
    completedAt: nullableString(row.completed_at),
    failureReason: nullableString(row.failure_reason),
    payload: row.payload == null ? null : parseJson(row.payload, null),
    result: row.result == null ? null : parseJson(row.result, null),
    createdAt: String(row.created_at),
  };
}

function toSystemEvent(row: Row): MultiremiSystemEvent {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    resource: String(row.resource) as MultiremiSystemEvent["resource"],
    event: String(row.event) as MultiremiSystemEvent["event"],
    resourceId: String(row.resource_id),
    projectId: nullableString(row.project_id),
    payload: parseJson<Record<string, unknown>>(row.payload, {}),
    status: String(row.status ?? "pending") as MultiremiSystemEvent["status"],
    attemptCount: Number(row.attempt_count ?? 0),
    availableAt: String(row.available_at),
    leaseUntil: nullableString(row.lease_until),
    lastError: nullableString(row.last_error),
    createdAt: String(row.created_at),
    processedAt: nullableString(row.processed_at),
  };
}

function systemEventMatchesConfig(
  event: MultiremiSystemEvent,
  config: MultiremiAutopilotEventConfig | null,
): boolean {
  if (!config || config.resource === "scm" || config.resource !== event.resource) return false;
  if (config.resource === "feishu_source") {
    if (event.event !== config.event) return false;
    const sourceIds = config.sourceIds ?? config.source_ids ?? [];
    return sourceIds.length === 0 || sourceIds.includes(event.resourceId);
  }
  if (config.event !== event.event) return false;
  // Task lifecycle status writes belong to the automation run that assigned
  // the task. Keep them in the outbox for audit/replay visibility, but never
  // feed them back into system-event automations: otherwise an `in_review`
  // trigger creates a task whose completion creates another identical run.
  if (cleanOptionalString(event.payload.automation_source_event_id)) return false;
  const projectId = config.projectId ?? config.project_id ?? null;
  if (projectId && projectId !== event.projectId) return false;
  return config.conditions.every((condition) => {
    if (condition.field !== "status" || condition.operator !== "becomes") return false;
    return event.payload.status === condition.value;
  });
}

function toWebhookDelivery(row: Row): MultiremiWebhookDelivery {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    autopilotId: String(row.autopilot_id),
    triggerId: String(row.trigger_id),
    provider: normalizeWebhookProvider(row.provider),
    event: String(row.event ?? "webhook.received"),
    dedupeKey: nullableString(row.dedupe_key),
    dedupeSource: nullableString(row.dedupe_source),
    signatureStatus: normalizeWebhookSignatureStatus(row.signature_status),
    status: normalizeWebhookDeliveryStatus(row.status),
    attemptCount: Number(row.attempt_count ?? 1),
    selectedHeaders: parseJson<Record<string, unknown>>(row.selected_headers, {}),
    contentType: nullableString(row.content_type),
    rawBody: nullableString(row.raw_body),
    responseStatus: row.response_status == null ? null : Number(row.response_status),
    responseBody: nullableString(row.response_body),
    autopilotRunId: nullableString(row.autopilot_run_id),
    replayedFromDeliveryId: nullableString(row.replayed_from_delivery_id),
    error: nullableString(row.error),
    receivedAt: String(row.received_at),
    lastAttemptAt: String(row.last_attempt_at),
    createdAt: String(row.created_at),
  };
}
