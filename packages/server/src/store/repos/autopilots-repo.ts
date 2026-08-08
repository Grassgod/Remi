// Autopilots domain (autopilots, schedule/webhook triggers, runs and webhook deliveries),
// extracted verbatim from MultiremiStore (the facade delegates every public method here).
import { Cron } from "croner";
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
import type {
  CreateAutopilotInput,
  CreateAutopilotTriggerInput,
  MultiremiAutopilot,
  MultiremiAutopilotRun,
  MultiremiAutopilotTrigger,
  MultiremiIssue,
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
    const id = input.id ?? createId("aut");
    const now = nowIso();
    this.ctx.db.run(
      `INSERT INTO multiremi_autopilots (
        id, title, description, project_id, workspace_id, assignee_type,
        assignee_id, status, execution_mode, issue_title_template,
        trigger_kind, trigger_label, cron_expression, created_by_type,
        created_by_id, last_run_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      [
        id,
        input.title.trim(),
        input.description ?? null,
        projectId,
        workspaceId,
        assigneeType,
        assigneeId,
        input.status ?? "active",
        input.executionMode ?? input.execution_mode ?? "create_issue",
        input.issueTitleTemplate ?? input.issue_title_template ?? null,
        input.triggerKind ?? input.trigger_kind ?? "manual",
        input.triggerLabel ?? input.trigger_label ?? null,
        input.cronExpression ?? input.cron_expression ?? null,
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
    const now = nowIso();
    this.ctx.db.run(
      `UPDATE multiremi_autopilots SET
        title = ?,
        description = ?,
        project_id = ?,
        assignee_type = ?,
        assignee_id = ?,
        status = ?,
        execution_mode = ?,
        issue_title_template = ?,
        trigger_kind = ?,
        trigger_label = ?,
        cron_expression = ?,
        updated_at = ?
       WHERE id = ?`,
      [
        input.title ?? current.title,
        input.description === undefined ? current.description : input.description,
        input.projectId === undefined ? current.projectId : input.projectId,
        nextAssigneeType,
        nextAssigneeId,
        input.status ?? current.status,
        input.executionMode ?? current.executionMode,
        input.issueTitleTemplate === undefined ? current.issueTitleTemplate : input.issueTitleTemplate,
        input.triggerKind ?? current.triggerKind,
        input.triggerLabel === undefined ? current.triggerLabel : input.triggerLabel,
        input.cronExpression === undefined ? current.cronExpression : input.cronExpression,
        now,
        id,
      ],
    );
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
    const eventFilters = normalizeWebhookEventFilters(input.eventFilters ?? input.event_filters ?? null);
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
    this.ctx.db.run(
      `INSERT INTO multiremi_autopilot_triggers (
        id, autopilot_id, kind, enabled, cron_expression, timezone, next_run_at,
        webhook_token, webhook_url, provider, label, event_filters, signing_secret_hash, signing_secret_hint, last_fired_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
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
        now,
        now,
      ],
    );
    this.ctx.db.run(
      "UPDATE multiremi_autopilots SET trigger_kind = ?, trigger_label = ?, cron_expression = ?, updated_at = ? WHERE id = ?",
      [kind, input.label ?? autopilot.triggerLabel, input.cronExpression ?? input.cron_expression ?? autopilot.cronExpression, now, autopilotId],
    );
    return this.getAutopilotTrigger(id)!;
  }

  updateAutopilotTrigger(autopilotId: string, triggerId: string, input: UpdateAutopilotTriggerInput): MultiremiAutopilotTrigger {
    const current = this.getAutopilotTrigger(triggerId);
    if (!current || current.autopilotId !== autopilotId) throw new Error(`Autopilot trigger not found: ${triggerId}`);
    const now = nowIso();
    const eventFiltersInput = input.eventFilters !== undefined ? input.eventFilters : input.event_filters;
    const eventFilters = eventFiltersInput === undefined ? current.eventFilters : normalizeWebhookEventFilters(eventFiltersInput);
    const enabled = input.enabled === undefined ? current.enabled : input.enabled;
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
    this.ctx.db.run(
      `UPDATE multiremi_autopilot_triggers SET
        enabled = ?,
        cron_expression = ?,
        timezone = ?,
        next_run_at = ?,
        label = ?,
        event_filters = ?,
        updated_at = ?
       WHERE id = ?`,
      [
        enabled ? 1 : 0,
        cronExpression,
        timezone,
        nextRunAt,
        input.label === undefined ? current.label : input.label,
        eventFilters ? toJson(eventFilters) : null,
        now,
        triggerId,
      ],
    );
    this.ctx.db.run(
      "UPDATE multiremi_autopilots SET trigger_label = ?, cron_expression = ?, updated_at = ? WHERE id = ?",
      [
        input.label === undefined ? current.label : input.label,
        input.cronExpression ?? input.cron_expression ?? current.cronExpression,
        now,
        autopilotId,
      ],
    );
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

  listAutopilotRuns(autopilotId: string): MultiremiAutopilotRun[] {
    const rows = this.ctx.db.query(
      "SELECT * FROM multiremi_autopilot_runs WHERE autopilot_id = ? ORDER BY created_at DESC LIMIT 20",
    ).all(autopilotId) as Row[];
    return rows.map(toAutopilotRun);
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
    const recipients = this.resolveAutopilotPausedRecipients(autopilot);
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

  private resolveAutopilotPausedRecipients(autopilot: MultiremiAutopilot): string[] {
    if (autopilot.createdByType === "member") {
      const member = this.ctx.resolveWorkspaceMemberForNotification(autopilot.workspaceId, autopilot.createdById);
      return member ? [member.id] : [];
    }
    const agent = this.ctx.agents().getAgent(autopilot.createdById);
    if (!agent?.ownerId) return [];
    const owner = this.ctx.resolveWorkspaceMemberForNotification(autopilot.workspaceId, agent.ownerId);
    return owner ? [owner.id] : [];
  }

  runAutopilot(autopilotId: string, input: RunAutopilotInput = {}): MultiremiAutopilotRun {
    const autopilot = this.getAutopilot(autopilotId);
    if (!autopilot) throw new Error(`Autopilot not found: ${autopilotId}`);
    const now = nowIso();
    const runId = createId("run");
    const source = input.source ?? "manual";
    const prompt = (input.prompt || autopilot.issueTitleTemplate || autopilot.title).trim();
    const agent = this.ctx.resolveAutopilotAgent(autopilot);
    if (!agent || autopilot.status !== "active") {
      this.ctx.db.run(
        `INSERT INTO multiremi_autopilot_runs (
          id, autopilot_id, source, status, issue_id, task_id, triggered_at,
          completed_at, failure_reason, payload, result, created_at
        ) VALUES (?, ?, ?, 'skipped', NULL, NULL, ?, ?, ?, ?, NULL, ?)`,
        [
          runId,
          autopilotId,
          source,
          now,
          now,
          agent ? "Autopilot is not active" : "No runnable agent",
          input.payload == null ? null : toJson(input.payload),
          now,
        ],
      );
      this.ctx.db.run("UPDATE multiremi_autopilots SET last_run_at = ?, updated_at = ? WHERE id = ?", [now, now, autopilotId]);
      return this.getAutopilotRun(runId)!;
    }

    let issue: MultiremiIssue | null = null;
    if (autopilot.executionMode === "create_issue") {
      issue = this.ctx.issues().createIssue({
        title: prompt,
        description: autopilot.description,
        workspaceId: autopilot.workspaceId,
        projectId: autopilot.projectId,
        createdBy: autopilot.id,
      });
    }
    const task = this.ctx.tasks().createTask({
      agentId: agent.id,
      issueId: issue?.id ?? null,
      workspaceId: autopilot.workspaceId,
      prompt,
    });
    this.ctx.db.run(
      `INSERT INTO multiremi_autopilot_runs (
        id, autopilot_id, source, status, issue_id, task_id, triggered_at,
        completed_at, failure_reason, payload, result, created_at
      ) VALUES (?, ?, ?, 'running', ?, ?, ?, NULL, NULL, ?, ?, ?)`,
      [
        runId,
        autopilotId,
        source,
        issue?.id ?? null,
        task.id,
        now,
        input.payload == null ? null : toJson(input.payload),
        toJson({ taskId: task.id, issueId: issue?.id ?? null }),
        now,
      ],
    );
    this.ctx.db.run("UPDATE multiremi_autopilots SET last_run_at = ?, updated_at = ? WHERE id = ?", [now, now, autopilotId]);
    const run = this.getAutopilotRun(runId)!;
    this.ctx.analytics().recordAutopilotRunStartedAnalytics(autopilot, run);
    return run;
  }

  getAutopilotRun(id: string): MultiremiAutopilotRun | null {
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
        response_status, response_body, autopilot_run_id, replayed_from_delivery_id, error,
        received_at, last_attempt_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 1, ?, ?, ?, NULL, NULL, NULL, ?, NULL, ?, ?, ?)`,
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

  replayWebhookDelivery(autopilotId: string, deliveryId: string): MultiremiWebhookDeliveryResult {
    const delivery = this.getWebhookDelivery(deliveryId);
    if (!delivery || delivery.autopilotId !== autopilotId) throw new Error(`Webhook delivery not found: ${deliveryId}`);
    if (delivery.status === "rejected" || delivery.signatureStatus === "invalid" || delivery.signatureStatus === "missing") {
      throw new Error("Cannot replay a rejected delivery");
    }
    const payload = delivery.rawBody ? parseJson(delivery.rawBody, null) : null;
    return this.handleAutopilotWebhook(autopilotId, {
      payload,
      rawBody: delivery.rawBody,
      headers: replayHeadersFromDelivery(delivery),
      provider: delivery.provider,
      signatureStatus: "not_required",
      replayedFromDeliveryId: delivery.id,
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

function normalizeWebhookProvider(value: unknown): MultiremiWebhookProvider {
  return value === "github" ? "github" : "generic";
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

function computeScheduleNextRun(expression: string, timezone: string | null | undefined, from: Date = new Date()): string {
  const job = new Cron(expression, {
    paused: true,
    ...(timezone ? { timezone } : {}),
  });
  try {
    const next = job.nextRun(from);
    if (!next) throw new Error("schedule has no future run");
    return next.toISOString();
  } finally {
    job.stop();
  }
}

function toAutopilot(row: Row): MultiremiAutopilot {
  const workspaceId = String(row.workspace_id ?? "local");
  const projectId = nullableString(row.project_id);
  const assigneeType = String(row.assignee_type ?? "agent") as MultiremiAutopilot["assigneeType"];
  const assigneeId = String(row.assignee_id);
  const executionMode = String(row.execution_mode ?? "create_issue") as MultiremiAutopilot["executionMode"];
  const issueTitleTemplate = nullableString(row.issue_title_template);
  const triggerKind = String(row.trigger_kind ?? "manual");
  const triggerLabel = nullableString(row.trigger_label);
  const cronExpression = nullableString(row.cron_expression);
  const createdByType = normalizeAutopilotCreatorType(row.created_by_type);
  const createdById = String(row.created_by_id ?? "local");
  const lastRunAt = nullableString(row.last_run_at);
  const createdAt = String(row.created_at);
  const updatedAt = String(row.updated_at);
  return {
    id: String(row.id),
    workspaceId,
    workspace_id: workspaceId,
    title: String(row.title),
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
    issueTitleTemplate,
    issue_title_template: issueTitleTemplate,
    triggerKind,
    trigger_kind: triggerKind,
    triggerLabel,
    trigger_label: triggerLabel,
    cronExpression,
    cron_expression: cronExpression,
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
    signingSecretSet: Boolean(signingSecret),
    signingSecretHint: nullableString(row.signing_secret_hint),
    lastFiredAt: nullableString(row.last_fired_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toAutopilotRun(row: Row): MultiremiAutopilotRun {
  return {
    id: String(row.id),
    autopilotId: String(row.autopilot_id),
    source: String(row.source ?? "manual") as MultiremiAutopilotRun["source"],
    status: String(row.status ?? "running") as MultiremiAutopilotRun["status"],
    issueId: nullableString(row.issue_id),
    taskId: nullableString(row.task_id),
    triggeredAt: String(row.triggered_at),
    completedAt: nullableString(row.completed_at),
    failureReason: nullableString(row.failure_reason),
    payload: row.payload == null ? null : parseJson(row.payload, null),
    result: row.result == null ? null : parseJson(row.result, null),
    createdAt: String(row.created_at),
  };
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
