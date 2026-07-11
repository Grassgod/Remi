import { Cron } from "croner";
import { type SqlDatabase, openMultiremiDatabase } from "@multiremi/store/db/sql-database.js";
import { runMigrations } from "@multiremi/store/migrations.js";
import { cleanOptionalString, nullableString, parseJson, toJson } from "@multiremi/store/helpers.js";
import { FeedbackRepo } from "@multiremi/store/repos/feedback-repo.js";
import { AccessTokensRepo } from "@multiremi/store/repos/access-tokens-repo.js";
import { CloudRuntimeNodesRepo } from "@multiremi/store/repos/cloud-runtime-nodes-repo.js";
import { createId, nowIso } from "@multiremi/ids.js";
import { createLogger } from "@shared/logger.js";
import type {
  AddSquadMemberInput,
  AssignIssueInput,
  AssignIssueResult,
  CreateAccessTokenInput,
  CreateAgentInput,
  CreateAutopilotInput,
  CreateAutopilotTriggerInput,
  CreateCloudRuntimeNodeInput,
  CreateChatSessionInput,
  CreateAttachmentInput,
  CreateFeedbackInput,
  CreateIssueDependencyInput,
  CreateIssueCommentInput,
  CreateIssueInput,
  BatchDeleteIssuesInput,
  BatchUpdateIssuesInput,
  CreateLabelInput,
  CreatePinnedItemInput,
  CreateProjectInput,
  CreateProjectResourceInput,
  CreateRuntimeUpdateInput,
  CreateRuntimeLocalSkillImportInput,
  CreateSkillInput,
  CreateSquadInput,
  CreateTaskHumanRequestInput,
  CreateTaskInput,
  CreateWorkspaceInvitationInput,
  CreateWorkspaceInput,
  CreateWorkspaceMemberInput,
  MultiremiAutopilot,
  MultiremiAutopilotRun,
  MultiremiAutopilotTrigger,
  MultiremiWebhookDelivery,
  MultiremiWebhookDeliveryResult,
  MultiremiWebhookDeliveryStatus,
  MultiremiWebhookEventFilter,
  MultiremiWebhookProvider,
  MultiremiWebhookSignatureStatus,
  MultiremiAccessToken,
  MultiremiCreatedAccessToken,
  MultiremiAccessTokenType,
  MultiremiAgent,
  MultiremiAnalyticsEvent,
  MultiremiAgentActivityBucket,
  MultiremiAgentRunCount,
  MultiremiAssigneeType,
  MultiremiAssigneeFrequencyEntry,
  MultiremiAttachment,
  MultiremiChatMessage,
  MultiremiChatSession,
  MultiremiCloudRuntimeNode,
  MultiremiCommentReaction,
  MultiremiDaemonHeartbeatAck,
  MultiremiInboxItem,
  MultiremiIssueActivity,
  MultiremiIssueChildProgress,
  MultiremiIssueComment,
  ListIssueCommentsInput,
  ListIssueCommentsResult,
  MultiremiIssueDependency,
  MultiremiIssueDependencyType,
  MultiremiIssue,
  MultiremiIssueAssigneeGroup,
  MultiremiIssuePriority,
  MultiremiIssueSearchResult,
  MultiremiGitHubChecksConclusion,
  MultiremiFeedback,
  MultiremiGitHubPullRequest,
  MultiremiGitHubPullRequestState,
  MultiremiGitHubSettings,
  MultiremiLabel,
  MultiremiNotificationGroupKey,
  MultiremiNotificationPreferences,
  MultiremiNotificationPreferenceResponse,
  MultiremiPinnedItem,
  MultiremiPinnedItemType,
  MultiremiIssueReaction,
  MultiremiIssueSubscriber,
  MultiremiIssueWithTasks,
  ListIssuesInput,
  MultiremiMetricCounter,
  MultiremiProject,
  MultiremiProjectResource,
  MultiremiProjectSearchResult,
  MultiremiRepoData,
  MultiremiRuntimeDirectoryCandidate,
  MultiremiRuntimeDirectoryScanParams,
  MultiremiRuntimeDirectoryScanRequest,
  MultiremiRuntimeDirectoryScanRequestStatus,
  MultiremiRuntimeLocalSkillImportRequest,
  MultiremiRuntimeLocalSkillListRequest,
  MultiremiRuntimeLocalSkillRequestStatus,
  MultiremiRuntimeLocalSkillSummary,
  MultiremiRuntimeModelListRequest,
  MultiremiRuntimeModelListRequestStatus,
  MultiremiRuntimeUpdateRequest,
  MultiremiRuntimeUpdateRequestStatus,
  QuickCreateIssueInput,
  ReportRuntimeDirectoryScanInput,
  ReportRuntimeModelListInput,
  QuickCreateIssueResult,
  ReportRuntimeLocalSkillImportInput,
  ReportRuntimeLocalSkillListInput,
  ReportRuntimeUpdateInput,
  MultiremiRuntime,
  MultiremiRuntimeDaily,
  MultiremiRuntimeModel,
  MultiremiRuntimeVisibility,
  MultiremiRuntimeUsage,
  MultiremiSkill,
  MultiremiSkillFile,
  MultiremiSquad,
  MultiremiSquadMember,
  MultiremiTask,
  MultiremiTaskActivityByHour,
  MultiremiTaskHumanRequest,
  MultiremiTaskHumanRequestKind,
  MultiremiTaskHumanRequestStatus,
  MultiremiTaskMessage,
  MultiremiTaskStatus,
  MultiremiTaskTriggerMetadata,
  MultiremiTaskWithAgent,
  MultiremiTimelineEntry,
  MultiremiSubscriptionReason,
  MultiremiUsageByAgent,
  MultiremiUsageByHour,
  MultiremiUsageDaily,
  MultiremiUser,
  MultiremiWorkspace,
  MultiremiWorkspaceInvitation,
  MultiremiWorkspaceMember,
  RegisterRuntimeInput,
  ReorderPinnedItemInput,
  RemoveSquadMemberInput,
  RunAutopilotInput,
  SendChatMessageInput,
  SendChatMessageResult,
  SetAgentSkillsInput,
  TaskMessageInput,
  TaskUsageEntry,
  UpdateAgentInput,
  UpdateAutopilotInput,
  UpdateAutopilotTriggerInput,
  UpdateChatSessionInput,
  UpdateIssueInput,
  UpdateIssueCommentInput,
  UpdateLabelInput,
  UpdateMultiremiUserInput,
  UpdateProjectInput,
  UpdateProjectResourceInput,
  UpdateRuntimeInput,
  UpdateSkillInput,
  UpdateSquadInput,
  UpdateWorkspaceMemberInput,
} from "@multiremi/contracts/types.js";

const log = createLogger("multiremi-store");

const TERMINAL_STATUSES: MultiremiTaskStatus[] = ["completed", "failed", "cancelled"];
const ACTIVE_TASK_STATUSES: MultiremiTaskStatus[] = ["queued", "dispatched", "running", "waiting_local_directory", "awaiting_human"];
const IN_FLIGHT_TASK_STATUSES: MultiremiTaskStatus[] = ["dispatched", "running", "waiting_local_directory", "awaiting_human"];
const ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"] as const;
const CLOSED_ISSUE_STATUSES = new Set(["done", "completed", "closed", "cancelled", "failed"]);
const AUTO_RETRY_FAILURE_REASONS = new Set(["runtime_offline", "runtime_recovery", "timeout", "codex_semantic_inactivity"]);
const RESUME_UNSAFE_FAILURE_REASONS = new Set([
  "iteration_limit",
  "agent_fallback_message",
  "api_invalid_request",
  "codex_semantic_inactivity",
]);
const CLAIM_RESPONSE_RECOVERY_MS = 90 * 1000;
const SYSTEM_AUTHOR_ID = "00000000-0000-0000-0000-000000000000";
const RUNTIME_HEARTBEAT_STALE_MS = 5 * 60 * 1000;
const RUNTIME_MODEL_LIST_PENDING_TIMEOUT_MS = 30 * 1000;
const RUNTIME_MODEL_LIST_RUNNING_TIMEOUT_MS = 60 * 1000;
const RUNTIME_UPDATE_PENDING_TIMEOUT_MS = 120 * 1000;
const RUNTIME_UPDATE_RUNNING_TIMEOUT_MS = 150 * 1000;
const RUNTIME_LOCAL_SKILL_PENDING_TIMEOUT_MS = 3 * 60 * 1000;
const RUNTIME_LOCAL_SKILL_RUNNING_TIMEOUT_MS = 60 * 1000;
const RUNTIME_DIRECTORY_SCAN_PENDING_TIMEOUT_MS = 3 * 60 * 1000;
const RUNTIME_DIRECTORY_SCAN_RUNNING_TIMEOUT_MS = 60 * 1000;
const PROJECT_REF_MAX_DEPTH = 5;
const AUTOPILOT_FAILURE_MONITOR_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const AUTOPILOT_FAILURE_MONITOR_MIN_RUNS = 50;
const AUTOPILOT_FAILURE_MONITOR_FAIL_RATIO = 0.9;
const MAX_ISSUE_METADATA_KEYS = 50;
const ISSUE_METADATA_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/;
const TRIGGER_SUMMARY_MAX_LENGTH = 200;
const COMMENT_HARD_CAP = 2000;
const COMMENT_SUMMARY_RUNES = 200;
const EVENT_RUNTIME_REGISTERED = "runtime_registered";
const EVENT_RUNTIME_READY = "runtime_ready";
const EVENT_RUNTIME_FAILED = "runtime_failed";
const EVENT_RUNTIME_OFFLINE = "runtime_offline";
const EVENT_AGENT_CREATED = "agent_created";
const EVENT_AUTOPILOT_CREATED = "autopilot_created";
const EVENT_AUTOPILOT_RUN_STARTED = "autopilot_run_started";
const EVENT_AUTOPILOT_RUN_COMPLETED = "autopilot_run_completed";
const EVENT_AUTOPILOT_RUN_FAILED = "autopilot_run_failed";
const METRICS_ONLY_EVENTS = new Set([
  EVENT_RUNTIME_REGISTERED,
  EVENT_RUNTIME_READY,
  EVENT_RUNTIME_FAILED,
  EVENT_RUNTIME_OFFLINE,
  EVENT_AUTOPILOT_RUN_STARTED,
  EVENT_AUTOPILOT_RUN_COMPLETED,
  EVENT_AUTOPILOT_RUN_FAILED,
]);
const METRIC_RUNTIME_REGISTERED = "multiremi_runtime_registered_total";
const METRIC_RUNTIME_READY = "multiremi_runtime_ready_total";
const METRIC_RUNTIME_FAILED = "multiremi_runtime_failed_total";
const METRIC_RUNTIME_OFFLINE = "multiremi_runtime_offline_total";
const METRIC_AGENT_CREATED = "multiremi_agent_created_total";
const METRIC_AUTOPILOT_CREATED = "multiremi_autopilot_created_total";
const METRIC_AUTOPILOT_RUN_STARTED = "multiremi_autopilot_run_started_total";
const METRIC_AUTOPILOT_RUN_TERMINAL = "multiremi_autopilot_run_terminal_total";
const METRIC_WEBHOOK_DELIVERY = "multiremi_webhook_delivery_total";
const KNOWN_ANALYTICS_SOURCES = new Set(["issue", "chat", "autopilot", "autopilot_issue", "quick_create", "manual", "api", "other"]);
const KNOWN_RUNTIME_MODES = new Set(["local", "cloud", "unknown"]);
const KNOWN_RUNTIME_PROVIDERS = new Set([
  "antigravity",
  "claude",
  "codex",
  "copilot",
  "cursor",
  "gemini",
  "hermes",
  "kiro",
  "kimi",
  "multiremi_agent",
  "openclaw",
  "opencode",
  "pi",
  "other",
]);
const KNOWN_FAILURE_REASONS = new Set([
  "api_invalid_request",
  "agent_blocked",
  "agent_error.agent_timeout",
  "agent_error.context_overflow",
  "agent_error.empty_or_unparseable_output",
  "agent_error.missing_config",
  "agent_error.model_not_found_or_unavailable",
  "agent_error.process_failure",
  "agent_error.provider_auth_or_access",
  "agent_error.provider_capacity_or_rate_limit",
  "agent_error.provider_network",
  "agent_error.provider_quota_limit",
  "agent_error.provider_server_error",
  "agent_error.runtime_missing_executable",
  "agent_error.runtime_version_unsupported",
  "agent_error.unknown",
  "agent_fallback_message",
  "context_limit",
  "codex_semantic_inactivity",
  "iteration_limit",
  "model_quota_exceeded",
  "provider_auth",
  "provider_error",
  "queued_expired",
  "registration_failed",
  "runtime_offline",
  "runtime_recovery",
  "timeout",
  "unknown",
]);
const KNOWN_AUTOPILOT_CADENCES = new Set(["hourly", "daily", "weekly", "monthly", "manual", "webhook", "unknown"]);
const KNOWN_AUTOPILOT_TRIGGERS = new Set(["schedule", "webhook", "manual", "unknown"]);
const KNOWN_WEBHOOK_PROVIDERS = new Set(["github", "generic", "gitlab", "stripe", "other"]);
const KNOWN_WEBHOOK_DELIVERY_STATUSES = new Set(["queued", "dispatched", "failed", "rejected", "ignored", "duplicate", "other"]);

interface RuntimeFailureAnalyticsInput {
  ownerId?: string | null;
  workspaceId?: string | null;
  daemonId?: string | null;
  provider?: string | null;
  failureReason: string;
  errorType: string;
  recoverable: boolean;
}

interface AgentCreatedAnalyticsInput {
  actorId: string;
  workspaceId: string;
  agentId: string;
  provider: string;
  runtimeMode: string;
  template?: string | null;
  isFirstAgentInWorkspace: boolean;
}

type TaskEnqueuedListener = (task: MultiremiTask) => void;
type TaskEventListener = (event: { type: string; task: MultiremiTask }) => void;
type WorkspaceEventListener = (event: {
  type: string;
  workspaceId: string;
  chatSessionId?: string;
  payload: Record<string, unknown>;
  actorType?: string;
  actorId?: string | null;
}) => void;

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

export class MultiremiStore {
  private db: SqlDatabase;
  private feedback: FeedbackRepo;
  private accessTokens: AccessTokensRepo;
  private cloudNodes: CloudRuntimeNodesRepo;
  private taskEnqueuedListeners = new Set<TaskEnqueuedListener>();
  private taskEventListeners = new Set<TaskEventListener>();
  private workspaceEventListeners = new Set<WorkspaceEventListener>();
  private analyticsEvents: MultiremiAnalyticsEvent[] = [];
  private metricCounters = new Map<string, MultiremiMetricCounter>();

  constructor(db?: SqlDatabase) {
    this.db = db ?? openMultiremiDatabase();
    this.feedback = new FeedbackRepo(this.db);
    this.accessTokens = new AccessTokensRepo(this.db);
    this.cloudNodes = new CloudRuntimeNodesRepo(this.db);
    this.migrate();
  }

  onTaskEnqueued(listener: TaskEnqueuedListener): () => void {
    this.taskEnqueuedListeners.add(listener);
    return () => {
      this.taskEnqueuedListeners.delete(listener);
    };
  }

  onTaskEvent(listener: TaskEventListener): () => void {
    this.taskEventListeners.add(listener);
    return () => {
      this.taskEventListeners.delete(listener);
    };
  }

  onWorkspaceEvent(listener: WorkspaceEventListener): () => void {
    this.workspaceEventListeners.add(listener);
    return () => {
      this.workspaceEventListeners.delete(listener);
    };
  }

  emitWorkspaceEvent(event: Parameters<WorkspaceEventListener>[0]): void {
    for (const listener of [...this.workspaceEventListeners]) {
      try {
        listener(event);
      } catch {
        // Realtime listeners are best-effort and must not roll back mutations.
      }
    }
  }

  private emitChatEvent(
    session: MultiremiChatSession,
    type: string,
    payload: Record<string, unknown>,
    actor: { actorType?: string; actorId?: string | null } = {},
  ): void {
    this.emitWorkspaceEvent({
      type,
      workspaceId: session.workspaceId,
      chatSessionId: session.id,
      actorType: actor.actorType ?? "member",
      actorId: actor.actorId ?? session.creatorId,
      payload: {
        chat_session_id: session.id,
        ...payload,
      },
    });
  }

  listAnalyticsEvents(options: {
    name?: string;
    includeMetricsOnly?: boolean;
  } = {}): MultiremiAnalyticsEvent[] {
    const includeMetricsOnly = options.includeMetricsOnly ?? true;
    return this.analyticsEvents
      .filter((event) => (!options.name || event.name === options.name) && (includeMetricsOnly || !event.metricsOnly))
      .map((event) => ({
        ...event,
        properties: { ...event.properties },
      }));
  }

  listMetricCounters(options: { name?: string } = {}): MultiremiMetricCounter[] {
    return [...this.metricCounters.values()]
      .filter((counter) => !options.name || counter.name === options.name)
      .map((counter) => ({
        name: counter.name,
        labels: { ...counter.labels },
        value: counter.value,
      }));
  }

  migrate(): void {
runMigrations(this.db);
  }

  createAgent(input: CreateAgentInput): MultiremiAgent {
    const id = input.id ?? createId("agt");
    const now = nowIso();
    const workspaceId = cleanOptionalString(input.workspaceId ?? input.workspace_id) ?? "local";
    const ownerId = cleanOptionalString(input.ownerId ?? input.owner_id) ?? "local";
    const visibility = normalizeAgentVisibility(input.visibility);
    this.db.run(
      `INSERT INTO multiremi_agents (
        id, workspace_id, name, description, avatar_url, provider, owner_id, visibility, runtime_id, instructions, skills, cwd, executable, model,
        max_concurrent_tasks, allowed_tools, custom_env, custom_args, mcp_config, thinking_level,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        workspaceId,
        input.name,
        input.description ?? "",
        input.avatarUrl ?? input.avatar_url ?? null,
        input.provider,
        ownerId,
        visibility,
        cleanOptionalString(input.runtimeId ?? input.runtime_id),
        input.instructions ?? "",
        toJson(input.skills ?? []),
        input.cwd ?? null,
        input.executable ?? null,
        input.model ?? null,
        normalizeRuntimeConcurrency(input.maxConcurrentTasks ?? input.max_concurrent_tasks ?? 6),
        toJson(input.allowedTools ?? input.allowed_tools ?? []),
        toJson(input.customEnv ?? input.custom_env ?? {}),
        toJson(input.customArgs ?? input.custom_args ?? []),
        (input.mcpConfig ?? input.mcp_config) == null ? null : toJson(input.mcpConfig ?? input.mcp_config),
        input.thinkingLevel ?? input.thinking_level ?? null,
        now,
        now,
      ],
    );
    return this.getAgent(id)!;
  }

  updateAgent(id: string, input: UpdateAgentInput): MultiremiAgent {
    const current = this.getAgent(id);
    if (!current) throw new Error(`Agent not found: ${id}`);
    const now = nowIso();
    const workspaceId = hasAnyField(input, "workspaceId", "workspace_id")
      ? cleanOptionalString(input.workspaceId ?? input.workspace_id) ?? "local"
      : current.workspaceId;
    const ownerId = hasAnyField(input, "ownerId", "owner_id")
      ? cleanOptionalString(input.ownerId ?? input.owner_id) ?? "local"
      : current.ownerId;
    const visibility = hasAnyField(input, "visibility")
      ? normalizeAgentVisibility(input.visibility)
      : current.visibility;
    this.db.run(
      `UPDATE multiremi_agents SET
        workspace_id = ?,
        name = ?,
        description = ?,
        avatar_url = ?,
        provider = ?,
        owner_id = ?,
        visibility = ?,
        runtime_id = ?,
        instructions = ?,
        skills = ?,
        cwd = ?,
        executable = ?,
        model = ?,
        max_concurrent_tasks = ?,
        allowed_tools = ?,
        custom_env = ?,
        custom_args = ?,
        mcp_config = ?,
        thinking_level = ?,
        updated_at = ?
       WHERE id = ?`,
      [
        workspaceId,
        input.name ?? current.name,
        hasAnyField(input, "description") ? input.description ?? "" : current.description,
        hasAnyField(input, "avatarUrl", "avatar_url")
          ? stringFieldOrCurrent(input.avatarUrl ?? input.avatar_url, current.avatarUrl)
          : current.avatarUrl,
        input.provider ?? current.provider,
        ownerId,
        visibility,
        hasAnyField(input, "runtimeId", "runtime_id")
          ? cleanOptionalString(input.runtimeId ?? input.runtime_id)
          : current.runtimeId,
        input.instructions ?? current.instructions,
        input.skills === undefined ? toJson(current.skills) : toJson(input.skills),
        input.cwd === undefined ? current.cwd : input.cwd,
        input.executable === undefined ? current.executable : input.executable,
        input.model === undefined ? current.model : input.model,
        hasAnyField(input, "maxConcurrentTasks", "max_concurrent_tasks")
          ? normalizeRuntimeConcurrency(input.maxConcurrentTasks ?? input.max_concurrent_tasks)
          : current.maxConcurrentTasks,
        hasAnyField(input, "allowedTools", "allowed_tools")
          ? toJson(input.allowedTools ?? input.allowed_tools ?? [])
          : toJson(current.allowedTools),
        hasAnyField(input, "customEnv", "custom_env")
          ? toJson(input.customEnv ?? input.custom_env ?? {})
          : toJson(current.customEnv),
        hasAnyField(input, "customArgs", "custom_args")
          ? toJson(input.customArgs ?? input.custom_args ?? [])
          : toJson(current.customArgs),
        hasAnyField(input, "mcpConfig", "mcp_config")
          ? (input.mcpConfig ?? input.mcp_config) == null ? null : toJson(input.mcpConfig ?? input.mcp_config)
          : current.mcpConfig == null ? null : toJson(current.mcpConfig),
        hasAnyField(input, "thinkingLevel", "thinking_level")
          ? input.thinkingLevel ?? input.thinking_level ?? null
          : current.thinkingLevel,
        now,
        id,
      ],
    );
    return this.getAgent(id)!;
  }

  archiveAgent(id: string): MultiremiAgent {
    if (!this.getAgent(id)) throw new Error(`Agent not found: ${id}`);
    const now = nowIso();
    this.db.run("UPDATE multiremi_agents SET archived_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
    return this.getAgent(id)!;
  }

  restoreAgent(id: string): MultiremiAgent {
    const row = this.db.query("SELECT id FROM multiremi_agents WHERE id = ?").get(id) as Row | null;
    if (!row) throw new Error(`Agent not found: ${id}`);
    const now = nowIso();
    this.db.run("UPDATE multiremi_agents SET archived_at = NULL, updated_at = ? WHERE id = ?", [now, id]);
    return this.getAgent(id)!;
  }

  cancelAgentTasks(agentId: string): number {
    if (!this.db.query("SELECT id FROM multiremi_agents WHERE id = ?").get(agentId)) throw new Error(`Agent not found: ${agentId}`);
    let cancelled = 0;
    for (const task of this.listAgentTasks(agentId)) {
      if (isActiveTaskStatus(task.status)) {
        this.cancelTask(task.id);
        cancelled += 1;
      }
    }
    return cancelled;
  }

  createSkill(input: CreateSkillInput): MultiremiSkill {
    const name = input.name?.trim();
    if (!name) throw new Error("Skill name is required");
    const id = input.id ?? createId("skl");
    const workspaceId = input.workspaceId ?? input.workspace_id ?? "local";
    const now = nowIso();
    const files = normalizeSkillFiles(input.files ?? []);
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO multiremi_skills (
          id, workspace_id, name, description, content, config, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          workspaceId,
          name,
          input.description ?? "",
          input.content ?? "",
          toJson(input.config ?? {}),
          input.createdBy ?? input.created_by ?? null,
          now,
          now,
        ],
      );
      this.replaceSkillFiles(id, files, now);
    })();
    return this.getSkill(id)!;
  }

  updateSkill(id: string, input: UpdateSkillInput): MultiremiSkill {
    const current = this.getSkill(id);
    if (!current) throw new Error(`Skill not found: ${id}`);
    const now = nowIso();
    const nextName = input.name === undefined ? current.name : input.name.trim();
    if (!nextName) throw new Error("Skill name is required");
    this.db.transaction(() => {
      this.db.run(
        `UPDATE multiremi_skills SET
          workspace_id = ?,
          name = ?,
          description = ?,
          content = ?,
          config = ?,
          created_by = ?,
          updated_at = ?
         WHERE id = ?`,
        [
          input.workspaceId ?? input.workspace_id ?? current.workspaceId ?? "local",
          nextName,
          input.description ?? current.description ?? "",
          input.content ?? current.content ?? "",
          input.config === undefined ? toJson(current.config ?? {}) : toJson(input.config ?? {}),
          input.createdBy ?? input.created_by ?? current.createdBy ?? null,
          now,
          id,
        ],
      );
      if (input.files !== undefined) this.replaceSkillFiles(id, normalizeSkillFiles(input.files), now);
    })();
    return this.getSkill(id)!;
  }

  upsertSkill(input: CreateSkillInput & { id: string }): MultiremiSkill {
    const existing = this.getSkill(input.id, { includeArchived: true });
    if (!existing) return this.createSkill(input);

    const nextName = input.name?.trim();
    if (!nextName) throw new Error("Skill name is required");
    const now = nowIso();
    this.db.transaction(() => {
      this.db.run(
        `UPDATE multiremi_skills SET
          workspace_id = ?,
          name = ?,
          description = ?,
          content = ?,
          config = ?,
          created_by = ?,
          archived_at = NULL,
          updated_at = ?
         WHERE id = ?`,
        [
          input.workspaceId ?? input.workspace_id ?? existing.workspaceId ?? "local",
          nextName,
          input.description ?? existing.description ?? "",
          input.content ?? existing.content ?? "",
          input.config === undefined ? toJson(existing.config ?? {}) : toJson(input.config ?? {}),
          input.createdBy ?? input.created_by ?? existing.createdBy ?? null,
          now,
          input.id,
        ],
      );
      if (input.files !== undefined) this.replaceSkillFiles(input.id, normalizeSkillFiles(input.files), now);
    })();
    return this.getSkill(input.id)!;
  }

  archiveSkill(id: string): MultiremiSkill {
    const current = this.getSkill(id);
    if (!current) throw new Error(`Skill not found: ${id}`);
    const now = nowIso();
    this.db.run("UPDATE multiremi_skills SET archived_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
    return this.getSkill(id, { includeArchived: true })!;
  }

  listSkills(workspaceId?: string | null, options: { includeArchived?: boolean; includeFiles?: boolean } = {}): MultiremiSkill[] {
    const archivedFilter = options.includeArchived ? "" : " AND archived_at IS NULL";
    const rows = workspaceId
      ? this.db.query(`SELECT * FROM multiremi_skills WHERE workspace_id = ?${archivedFilter} ORDER BY created_at DESC`).all(workspaceId) as Row[]
      : this.db.query(`SELECT * FROM multiremi_skills WHERE 1 = 1${archivedFilter} ORDER BY created_at DESC`).all() as Row[];
    return rows.map((row) => toSkill(row, options.includeFiles ? this.listSkillFiles(String(row.id)) : []));
  }

  getSkill(id: string, options: { includeArchived?: boolean; includeFiles?: boolean } = { includeFiles: true }): MultiremiSkill | null {
    const row = this.db.query(
      `SELECT * FROM multiremi_skills WHERE id = ?${options.includeArchived ? "" : " AND archived_at IS NULL"}`,
    ).get(id) as Row | null;
    return row ? toSkill(row, options.includeFiles === false ? [] : this.listSkillFiles(id, { includeArchived: options.includeArchived })) : null;
  }

  listSkillFiles(skillId: string, options: { includeArchived?: boolean } = {}): MultiremiSkillFile[] {
    const archivedFilter = options.includeArchived ? "" : " AND archived_at IS NULL";
    if (!this.db.query(`SELECT id FROM multiremi_skills WHERE id = ?${archivedFilter}`).get(skillId)) {
      throw new Error(`Skill not found: ${skillId}`);
    }
    const rows = this.db.query("SELECT * FROM multiremi_skill_files WHERE skill_id = ? ORDER BY path ASC").all(skillId) as Row[];
    return rows.map(toSkillFile);
  }

  upsertSkillFile(skillId: string, file: MultiremiSkillFile): MultiremiSkillFile {
    if (!this.db.query("SELECT id FROM multiremi_skills WHERE id = ? AND archived_at IS NULL").get(skillId)) {
      throw new Error(`Skill not found: ${skillId}`);
    }
    const normalized = normalizeSkillFiles([file])[0]!;
    const existing = this.db.query(
      "SELECT * FROM multiremi_skill_files WHERE skill_id = ? AND path = ?",
    ).get(skillId, normalized.path) as Row | null;
    const id = existing ? String(existing.id) : file.id ?? createId("skf");
    const createdAt = existing ? String(existing.created_at) : nowIso();
    const updatedAt = nowIso();
    this.db.run(
      `INSERT INTO multiremi_skill_files (id, skill_id, path, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(skill_id, path) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
      [id, skillId, normalized.path, normalized.content, createdAt, updatedAt],
    );
    const row = this.db.query("SELECT * FROM multiremi_skill_files WHERE skill_id = ? AND path = ?")
      .get(skillId, normalized.path) as Row | null;
    return toSkillFile(row!);
  }

  deleteSkillFile(skillId: string, fileId: string): boolean {
    if (!this.db.query("SELECT id FROM multiremi_skills WHERE id = ? AND archived_at IS NULL").get(skillId)) {
      throw new Error(`Skill not found: ${skillId}`);
    }
    const result = this.db.run("DELETE FROM multiremi_skill_files WHERE skill_id = ? AND id = ?", [skillId, fileId]);
    return result.changes > 0;
  }

  listAgentSkills(agentId: string, options: { includeFiles?: boolean } = { includeFiles: true }): MultiremiSkill[] {
    const row = this.db.query("SELECT * FROM multiremi_agents WHERE id = ?").get(agentId) as Row | null;
    if (!row) throw new Error(`Agent not found: ${agentId}`);
    const agent = toAgent(row);
    const rows = this.db.query(
      `SELECT s.*
       FROM multiremi_skills s
       JOIN multiremi_agent_skills aks ON aks.skill_id = s.id
       WHERE aks.agent_id = ? AND s.archived_at IS NULL
       ORDER BY aks.created_at ASC, s.name ASC`,
    ).all(agentId) as Row[];
    const structured = rows.map((row) => toSkill(row, options.includeFiles === false ? [] : this.listSkillFiles(String(row.id))));
    return mergeAgentSkills(agent.skills, structured);
  }

  setAgentSkills(agentId: string, input: SetAgentSkillsInput | string[]): MultiremiSkill[] {
    if (!this.db.query("SELECT id FROM multiremi_agents WHERE id = ?").get(agentId)) throw new Error(`Agent not found: ${agentId}`);
    const skillIds = Array.isArray(input) ? input : input.skillIds ?? input.skill_ids ?? [];
    const now = nowIso();
    this.db.transaction(() => {
      this.db.run("DELETE FROM multiremi_agent_skills WHERE agent_id = ?", [agentId]);
      for (const skillId of skillIds) {
        const skill = this.getSkill(skillId);
        if (!skill) throw new Error(`Skill not found: ${skillId}`);
        this.db.run(
          "INSERT OR IGNORE INTO multiremi_agent_skills (agent_id, skill_id, created_at) VALUES (?, ?, ?)",
          [agentId, skillId, now],
        );
      }
    })();
    return this.listAgentSkills(agentId);
  }

  ensureDefaultAgent(
    provider = "claude",
    options: { runtimeId?: string | null; workspaceId?: string | null; ownerId?: string | null } = {},
  ): MultiremiAgent {
    const runtimeId = cleanOptionalString(options.runtimeId);
    const workspaceId = cleanOptionalString(options.workspaceId) ?? "local";
    const ownerId = cleanOptionalString(options.ownerId) ?? "local";
    const id = runtimeId ? `agt_default_${safeIdSegment(workspaceId)}_${safeIdSegment(runtimeId)}` : `agt_default_${provider}`;
    const existing = this.getAgent(id);
    if (existing) {
      if (existing.archivedAt) {
        const now = nowIso();
        this.db.run("UPDATE multiremi_agents SET archived_at = NULL, updated_at = ? WHERE id = ?", [now, id]);
        return this.getAgent(id)!;
      }
      return existing;
    }
    return this.createAgent({
      id,
      name: provider === "codex" ? "Codex" : "Claude",
      description: provider === "codex" ? "Default Codex agent" : "Default Claude agent",
      provider,
      workspaceId,
      ownerId,
      runtimeId,
      instructions: "You are an autonomous coding agent. Complete the task and report the result clearly.",
    });
  }

  getAgent(id: string): MultiremiAgent | null {
    const row = this.db.query("SELECT * FROM multiremi_agents WHERE id = ?").get(id) as Row | null;
    return row ? this.hydrateAgent(toAgent(row)) : null;
  }

  getAgentByWorkspaceAndName(workspaceId: string, name: string): MultiremiAgent | null {
    const row = this.db
      .query("SELECT * FROM multiremi_agents WHERE workspace_id = ? AND name = ? ORDER BY created_at ASC LIMIT 1")
      .get(workspaceId, name) as Row | null;
    return row ? this.hydrateAgent(toAgent(row)) : null;
  }

  getAgentByRef(ref: string, workspaceId?: string | null): MultiremiAgent | null {
    const value = ref.trim();
    if (!value) return null;
    const exact = this.getAgent(value);
    if (exact && !exact.archivedAt && (!workspaceId || exact.workspaceId === workspaceId)) return exact;
    return uniqueRefMatch(
      this.listAgents().filter((agent) => !workspaceId || agent.workspaceId === workspaceId),
      value,
      (agent) => agent.id,
      (agent) => [agent.name],
    );
  }

  listAgents(): MultiremiAgent[] {
    const rows = this.db.query("SELECT * FROM multiremi_agents WHERE archived_at IS NULL ORDER BY created_at ASC").all() as Row[];
    return rows.map((row) => this.hydrateAgent(toAgent(row)));
  }

  private hydrateAgent(agent: MultiremiAgent): MultiremiAgent {
    return {
      ...agent,
      skills: this.listAgentSkillsForExistingAgent(agent),
    };
  }

  private listAgentSkillsForExistingAgent(agent: MultiremiAgent): MultiremiSkill[] {
    const rows = this.db.query(
      `SELECT s.*
       FROM multiremi_skills s
       JOIN multiremi_agent_skills aks ON aks.skill_id = s.id
       WHERE aks.agent_id = ? AND s.archived_at IS NULL
       ORDER BY aks.created_at ASC, s.name ASC`,
    ).all(agent.id) as Row[];
    const structured = rows.map((row) => toSkill(row, this.listSkillFiles(String(row.id))));
    return mergeAgentSkills(agent.skills, structured);
  }

  private replaceSkillFiles(skillId: string, files: MultiremiSkillFile[], now = nowIso()): void {
    this.db.run("DELETE FROM multiremi_skill_files WHERE skill_id = ?", [skillId]);
    for (const file of files) {
      this.db.run(
        `INSERT INTO multiremi_skill_files (
          id, skill_id, path, content, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(skill_id, path) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
        [file.id ?? createId("skf"), skillId, file.path, file.content, now, now],
      );
    }
  }

  createWorkspaceMember(input: CreateWorkspaceMemberInput): MultiremiWorkspaceMember {
    if (!input.name?.trim()) throw new Error("Member name is required");
    const id = input.id ?? createId("mem");
    const now = nowIso();
    this.db.run(
      `INSERT INTO multiremi_workspace_members (
        id, workspace_id, user_id, name, email, role, archived_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      [
        id,
        input.workspaceId ?? "local",
        cleanOptionalString(input.userId) ?? null,
        input.name.trim(),
        input.email ?? null,
        input.role ?? "member",
        now,
        now,
      ],
    );
    return this.getWorkspaceMember(id)!;
  }

  getWorkspaceMember(id: string): MultiremiWorkspaceMember | null {
    const row = this.db.query("SELECT * FROM multiremi_workspace_members WHERE id = ?").get(id) as Row | null;
    return row ? toWorkspaceMember(row) : null;
  }

  getWorkspaceMemberByRef(ref: string, workspaceId?: string | null): MultiremiWorkspaceMember | null {
    const value = ref.trim();
    if (!value) return null;
    const exact = this.getWorkspaceMember(value);
    if (exact && !exact.archivedAt && (!workspaceId || exact.workspaceId === workspaceId)) return exact;
    return uniqueRefMatch(
      this.listWorkspaceMembers(workspaceId),
      value,
      (member) => member.id,
      (member) => [member.name, member.email],
    );
  }

  listWorkspaceMembers(workspaceId?: string | null): MultiremiWorkspaceMember[] {
    const rows = workspaceId
      ? this.db.query("SELECT * FROM multiremi_workspace_members WHERE workspace_id = ? AND archived_at IS NULL ORDER BY name ASC").all(workspaceId) as Row[]
      : this.db.query("SELECT * FROM multiremi_workspace_members WHERE archived_at IS NULL ORDER BY workspace_id ASC, name ASC").all() as Row[];
    return rows.map(toWorkspaceMember);
  }

  updateWorkspaceMember(id: string, input: UpdateWorkspaceMemberInput): MultiremiWorkspaceMember {
    const current = this.getWorkspaceMember(id);
    if (!current) throw new Error(`Member not found: ${id}`);
    const nextWorkspaceId = input.workspaceId ?? current.workspaceId;
    const nextRole = input.role ?? current.role;
    if (current.role === "owner" && (nextRole !== "owner" || nextWorkspaceId !== current.workspaceId)) {
      this.assertWorkspaceKeepsOwner(current);
    }
    const now = nowIso();
    this.db.run(
      `UPDATE multiremi_workspace_members SET
        workspace_id = ?,
        name = ?,
        email = ?,
        role = ?,
        updated_at = ?
       WHERE id = ?`,
      [
        nextWorkspaceId,
        input.name ?? current.name,
        input.email === undefined ? current.email : input.email,
        nextRole,
        now,
        id,
      ],
    );
    return this.getWorkspaceMember(id)!;
  }

  archiveWorkspaceMember(id: string): MultiremiWorkspaceMember {
    const current = this.getWorkspaceMember(id);
    if (!current) throw new Error(`Member not found: ${id}`);
    if (current.role === "owner" && !current.archivedAt) this.assertWorkspaceKeepsOwner(current);
    const now = nowIso();
    this.db.run("UPDATE multiremi_workspace_members SET archived_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
    return this.getWorkspaceMember(id)!;
  }

  private assertWorkspaceKeepsOwner(member: MultiremiWorkspaceMember): void {
    const ownerCount = this.listWorkspaceMembers(member.workspaceId).filter((item) => item.role === "owner").length;
    if (ownerCount <= 1) throw new Error("workspace must have at least one owner");
  }

  getCurrentUser(): MultiremiUser {
    const existing = this.getUser("local");
    if (existing) return existing;
    const now = nowIso();
    this.db.run(
      `INSERT INTO multiremi_users (
        id, name, email, avatar_url, language, timezone, onboarded_at,
        onboarding_questionnaire, starter_content_state, profile_description,
        created_at, updated_at
      ) VALUES ('local', 'Local User', 'local@multiremi.local', NULL, NULL, NULL, NULL, '{}', NULL, '', ?, ?)`,
      [now, now],
    );
    return this.getUser("local")!;
  }

  getUser(id: string): MultiremiUser | null {
    const row = this.db.query("SELECT * FROM multiremi_users WHERE id = ?").get(id) as Row | null;
    return row ? toUser(row) : null;
  }

  getUserByExternalId(externalId: string | null | undefined): MultiremiUser | null {
    const value = cleanOptionalString(externalId);
    if (!value) return null;
    const row = this.db.query("SELECT * FROM multiremi_users WHERE external_id = ?").get(value) as Row | null;
    return row ? toUser(row) : null;
  }

  getUserByEmail(email: string | null | undefined): MultiremiUser | null {
    const value = cleanOptionalString(email)?.toLowerCase();
    if (!value) return null;
    const row = this.db.query("SELECT * FROM multiremi_users WHERE lower(email) = ?").get(value) as Row | null;
    return row ? toUser(row) : null;
  }

  // Resolve (or provision) the distinct user record behind a login identity.
  // Match order: stable external id (Feishu open_id) → email → mint a new user.
  // Never rewrites a different user's id — each identity keeps its own record so
  // concurrent logins can't overwrite one another.
  getOrCreateUser(identity: { externalId?: string | null; email?: string | null; name?: string | null }): MultiremiUser {
    const externalId = cleanOptionalString(identity.externalId);
    const email = cleanOptionalString(identity.email)?.toLowerCase() ?? null;
    const name = cleanOptionalString(identity.name);
    let user = externalId ? this.getUserByExternalId(externalId) : null;
    // Legacy/seed users may predate external_id; claim by email so we don't fork.
    // But never let an email match resolve to an account already bound to a
    // DIFFERENT external identity — that would let email login hijack an SSO user.
    if (!user && email) {
      const byEmail = this.getUserByEmail(email);
      if (byEmail && (!byEmail.externalId || byEmail.externalId === externalId)) user = byEmail;
    }
    if (user) return this.reconcileUserIdentity(user, { externalId, email, name });
    const id = createId("usr");
    const now = nowIso();
    this.db.run(
      `INSERT INTO multiremi_users (
        id, external_id, name, email, avatar_url, language, timezone, onboarded_at,
        onboarding_questionnaire, starter_content_state, profile_description,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, '{}', NULL, '', ?, ?)`,
      [id, externalId ?? null, name || email || "User", email ?? `${id}@multiremi.local`, now, now],
    );
    return this.getUser(id)!;
  }

  private reconcileUserIdentity(
    user: MultiremiUser,
    identity: { externalId?: string | null; email?: string | null; name?: string | null },
  ): MultiremiUser {
    const updates: string[] = [];
    const params: unknown[] = [];
    if (identity.externalId && user.externalId !== identity.externalId) {
      updates.push("external_id = ?");
      params.push(identity.externalId);
    }
    if (identity.email && user.email.toLowerCase() !== identity.email) {
      updates.push("email = ?");
      params.push(identity.email);
    }
    const newName = identity.name && user.name !== identity.name ? identity.name : null;
    if (newName) {
      updates.push("name = ?");
      params.push(newName);
    }
    if (!updates.length) return user;
    updates.push("updated_at = ?");
    params.push(nowIso());
    params.push(user.id);
    this.db.run(`UPDATE multiremi_users SET ${updates.join(", ")} WHERE id = ?`, params);
    // Member rows denormalize the display name; sync them so pickers/member
    // lists don't keep showing a stale seed snapshot (e.g. "Local User").
    if (newName) {
      this.db.run(
        "UPDATE multiremi_workspace_members SET name = ?, updated_at = ? WHERE user_id = ? AND name <> ?",
        [newName, nowIso(), user.id, newName],
      );
    }
    return this.getUser(user.id)!;
  }

  // Real role of a user in a workspace, or null when they are not a member.
  // Matches on the explicit user_id link, falling back to the legacy
  // `mem_<ws>_<userId>` id convention for members created before user_id existed.
  getUserRoleInWorkspace(userId: string | null | undefined, workspaceId: string): string | null {
    return this.findWorkspaceMemberForUser(userId, workspaceId)?.role ?? null;
  }

  // Active member row for a user in a workspace, or null when they are not a
  // member. Accepts a user id, a member row id, or the legacy `mem_<ws>_<userId>`
  // convention — request identities carry user ids while subscriber/inbox APIs
  // key on member row ids, so callers must translate through here.
  findWorkspaceMemberForUser(userId: string | null | undefined, workspaceId: string): MultiremiWorkspaceMember | null {
    const uid = cleanOptionalString(userId);
    if (!uid) return null;
    return this.listWorkspaceMembers(workspaceId).find((m) =>
      m.userId === uid || m.id === uid || m.id === `mem_${workspaceId}_${uid}`
    ) ?? null;
  }

  listWorkspacesForUser(userId: string | null | undefined): MultiremiWorkspace[] {
    const uid = cleanOptionalString(userId);
    if (!uid) return [];
    return this.listWorkspaces().filter((ws) => this.getUserRoleInWorkspace(uid, ws.id) !== null);
  }

  updateCurrentUser(input: UpdateMultiremiUserInput): MultiremiUser {
    const current = this.getCurrentUser();
    const name = input.name === undefined ? current.name : String(input.name).trim();
    if (!name) throw new Error("name is required");
    const email = input.email === undefined ? current.email : normalizeEmail(input.email);
    const language = hasAnyField(input, "language")
      ? normalizeOptionalLanguage(input.language)
      : current.language;
    const timezone = hasAnyField(input, "timezone")
      ? normalizeOptionalTimezone(input.timezone)
      : current.timezone;
    const profileDescription = hasAnyField(input, "profileDescription", "profile_description")
      ? String(input.profileDescription ?? input.profile_description ?? "").trim()
      : current.profileDescription;
    if ([...profileDescription].length > 2000) throw new Error("profile_description exceeds 2000 characters");
    const onboardingQuestionnaire = input.onboardingQuestionnaire ?? input.onboarding_questionnaire ?? current.onboardingQuestionnaire;
    const starterContentState = hasAnyField(input, "starterContentState", "starter_content_state")
      ? cleanOptionalString(input.starterContentState ?? input.starter_content_state)
      : current.starterContentState;
    const avatarUrl = hasAnyField(input, "avatarUrl", "avatar_url")
      ? cleanOptionalString(input.avatarUrl ?? input.avatar_url)
      : current.avatarUrl;
    const now = nowIso();
    this.db.run(
      `UPDATE multiremi_users SET
        name = ?,
        email = ?,
        avatar_url = ?,
        language = ?,
        timezone = ?,
        onboarding_questionnaire = ?,
        starter_content_state = ?,
        profile_description = ?,
        updated_at = ?
       WHERE id = ?`,
      [
        name,
        email,
        avatarUrl,
        language,
        timezone,
        toJson(onboardingQuestionnaire ?? {}),
        starterContentState,
        profileDescription,
        now,
        current.id,
      ],
    );
    return this.getUser(current.id)!;
  }

  patchCurrentUserOnboarding(questionnaire: Record<string, unknown>): MultiremiUser {
    return this.updateCurrentUser({ onboardingQuestionnaire: questionnaire });
  }

  markCurrentUserOnboarded(): MultiremiUser {
    const current = this.getCurrentUser();
    const now = nowIso();
    this.db.run(
      "UPDATE multiremi_users SET onboarded_at = COALESCE(onboarded_at, ?), updated_at = ? WHERE id = ?",
      [now, now, current.id],
    );
    return this.getUser(current.id)!;
  }

  listWorkspaces(): MultiremiWorkspace[] {
    const rows = this.db.query("SELECT * FROM multiremi_workspaces ORDER BY created_at ASC").all() as Row[];
    if (!rows.length) return [this.ensureLocalWorkspace()];
    return rows.map(toWorkspace);
  }

  getWorkspace(id: string): MultiremiWorkspace | null {
    const row = this.db.query("SELECT * FROM multiremi_workspaces WHERE id = ?").get(id) as Row | null;
    return row ? toWorkspace(row) : null;
  }

  createWorkspace(input: CreateWorkspaceInput, actingUserId?: string | null): MultiremiWorkspace {
    const name = String(input.name ?? "").trim();
    const slug = normalizeWorkspaceSlug(input.slug ?? slugifyWorkspaceName(name));
    if (!name || !slug) throw new Error("name and slug are required");
    const id = input.id ?? (slug === "local" ? "local" : createId("ws"));
    const now = nowIso();
    const issuePrefix = String(input.issuePrefix ?? input.issue_prefix ?? generateIssuePrefix(name)).trim().toUpperCase() || "MUL";
    this.db.run(
      `INSERT INTO multiremi_workspaces (
        id, name, slug, description, context, settings, repos, issue_prefix, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        name,
        slug,
        input.description ?? null,
        input.context ?? null,
        toJson(input.settings ?? {}),
        toJson(input.repos ?? []),
        issuePrefix,
        now,
        now,
      ],
    );
    // The authenticated creator (not the legacy "local" user) becomes the owner,
    // otherwise a new user could create a workspace they cannot access.
    const user = this.resolveActingUser(actingUserId);
    const memberId = `mem_${id}_${user.id}`;
    if (!this.getWorkspaceMember(memberId)) {
      this.createWorkspaceMember({
        id: memberId,
        workspaceId: id,
        userId: user.id,
        name: user.name,
        email: user.email,
        role: "owner",
      });
    }
    this.db.run("UPDATE multiremi_users SET onboarded_at = COALESCE(onboarded_at, ?), updated_at = ? WHERE id = ?", [now, now, user.id]);
    return this.getWorkspace(id)!;
  }

  updateWorkspace(id: string, input: Partial<CreateWorkspaceInput>): MultiremiWorkspace {
    const current = this.getWorkspace(id);
    if (!current) throw new Error(`Workspace not found: ${id}`);
    const nextName = input.name === undefined ? current.name : String(input.name ?? "").trim();
    if (!nextName) throw new Error("name is required");
    const nextSlug = input.slug === undefined ? current.slug : normalizeWorkspaceSlug(input.slug);
    const issuePrefix = input.issuePrefix ?? input.issue_prefix ?? current.issuePrefix;
    const now = nowIso();
    this.db.run(
      `UPDATE multiremi_workspaces SET
        name = ?,
        slug = ?,
        description = ?,
        context = ?,
        settings = ?,
        repos = ?,
        issue_prefix = ?,
        updated_at = ?
       WHERE id = ?`,
      [
        nextName,
        nextSlug,
        input.description === undefined ? current.description : input.description,
        input.context === undefined ? current.context : input.context,
        input.settings === undefined ? toJson(current.settings) : toJson(input.settings),
        input.repos === undefined ? toJson(current.repos) : toJson(input.repos),
        String(issuePrefix ?? "MUL").trim().toUpperCase() || "MUL",
        now,
        id,
      ],
    );
    return this.getWorkspace(id)!;
  }

  deleteWorkspace(id: string): boolean {
    if (id === "local") throw new Error("local workspace cannot be deleted");
    const result = this.db.run("DELETE FROM multiremi_workspaces WHERE id = ?", [id]);
    if (result.changes === 0) return false;
    const now = nowIso();
    this.db.run("UPDATE multiremi_workspace_members SET archived_at = COALESCE(archived_at, ?), updated_at = ? WHERE workspace_id = ?", [
      now,
      now,
      id,
    ]);
    return true;
  }

  leaveWorkspace(id: string, memberId = `mem_${id}_local`): boolean {
    const member = this.getWorkspaceMember(memberId) ?? this.listWorkspaceMembers(id).find((item) => item.email === this.getCurrentUser().email);
    if (!member || member.workspaceId !== id) return false;
    this.archiveWorkspaceMember(member.id);
    return true;
  }

  ensureLocalWorkspace(): MultiremiWorkspace {
    const existing = this.getWorkspace("local");
    if (existing) return existing;
    return this.createWorkspace({ id: "local", name: "Local Workspace", slug: "local", issuePrefix: "MUL" });
  }

  createWorkspaceInvitation(workspaceId: string, input: CreateWorkspaceInvitationInput, inviterUserId?: string | null): MultiremiWorkspaceInvitation {
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    const email = String(input.email ?? input.inviteeEmail ?? input.invitee_email ?? "").trim().toLowerCase();
    if (!email) throw new Error("email is required");
    const role = normalizeWorkspaceInvitationRole(input.role ?? "member");
    if (role === "owner") throw new Error("cannot invite as owner");
    const currentUser = this.resolveActingUser(inviterUserId);
    if (email === currentUser.email.toLowerCase()) {
      const existingMember = this.listWorkspaceMembers(workspaceId).find((member) => member.email?.toLowerCase() === email);
      if (existingMember) throw new Error("user is already a member");
    }
    this.expireStalePendingInvitations(workspaceId, email);
    const now = nowIso();
    const pending = this.db.query(
      `SELECT * FROM multiremi_workspace_invitations
       WHERE workspace_id = ? AND invitee_email = ? AND status = 'pending' AND expires_at > ?`,
    ).get(workspaceId, email, now) as Row | null;
    if (pending) throw new Error("invitation already pending for this email");
    const id = createId("inv");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    this.db.run(
      `INSERT INTO multiremi_workspace_invitations (
        id, workspace_id, inviter_id, invitee_email, invitee_user_id, role, status,
        expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [
        id,
        workspaceId,
        currentUser.id,
        email,
        email === currentUser.email.toLowerCase() ? currentUser.id : null,
        role,
        expiresAt,
        now,
        now,
      ],
    );
    return this.hydrateInvitation(this.getInvitation(id)!)!;
  }

  listWorkspaceInvitations(workspaceId: string): MultiremiWorkspaceInvitation[] {
    const now = nowIso();
    const rows = this.db.query(
      `SELECT * FROM multiremi_workspace_invitations
       WHERE workspace_id = ? AND status = 'pending' AND expires_at > ?
       ORDER BY created_at DESC`,
    ).all(workspaceId, now) as Row[];
    return rows.map((row) => this.hydrateInvitation(toInvitation(row))!);
  }

  // Resolve the user acting on a request. The API passes the authenticated user
  // id so invitation accept/decline/list operate on the real person; falling back
  // to the local user keeps CLI/single-user flows working.
  private resolveActingUser(actingUserId?: string | null): MultiremiUser {
    const uid = cleanOptionalString(actingUserId);
    if (uid) {
      const user = this.getUser(uid);
      if (user) return user;
    }
    return this.getCurrentUser();
  }

  listCurrentUserInvitations(actingUserId?: string | null): MultiremiWorkspaceInvitation[] {
    const user = this.resolveActingUser(actingUserId);
    const now = nowIso();
    const rows = this.db.query(
      `SELECT * FROM multiremi_workspace_invitations
       WHERE status = 'pending' AND (invitee_user_id = ? OR invitee_email = ?)
       AND expires_at > ?
       ORDER BY created_at DESC`,
    ).all(user.id, user.email.toLowerCase(), now) as Row[];
    return rows.map((row) => this.hydrateInvitation(toInvitation(row))!);
  }

  getInvitation(id: string): MultiremiWorkspaceInvitation | null {
    const row = this.db.query("SELECT * FROM multiremi_workspace_invitations WHERE id = ?").get(id) as Row | null;
    return row ? toInvitation(row) : null;
  }

  revokeWorkspaceInvitation(workspaceId: string, invitationId: string): boolean {
    const invitation = this.getInvitation(invitationId);
    if (!invitation || invitation.workspaceId !== workspaceId || invitation.status !== "pending") return false;
    this.updateInvitationStatus(invitationId, "revoked");
    return true;
  }

  acceptInvitation(invitationId: string, actingUserId?: string | null): MultiremiWorkspaceInvitation | null {
    const invitation = this.hydrateInvitation(this.getInvitation(invitationId));
    if (!invitation || invitation.status !== "pending") return null;
    const user = this.resolveActingUser(actingUserId);
    if (invitation.inviteeEmail !== user.email.toLowerCase() && invitation.inviteeUserId !== user.id) {
      throw new Error("invitation does not belong to you");
    }
    if (Date.parse(invitation.expiresAt) <= Date.now()) throw new Error("invitation has expired");
    const memberId = `mem_${invitation.workspaceId}_${user.id}`;
    if (this.getWorkspaceMember(memberId)) throw new Error("you are already a member of this workspace");
    const accepted = this.updateInvitationStatus(invitationId, "accepted");
    this.createWorkspaceMember({
      id: memberId,
      workspaceId: invitation.workspaceId,
      userId: user.id,
      name: user.name,
      email: user.email,
      role: invitation.role,
    });
    const now = nowIso();
    this.db.run("UPDATE multiremi_users SET onboarded_at = COALESCE(onboarded_at, ?), updated_at = ? WHERE id = ?", [now, now, user.id]);
    return this.hydrateInvitation(accepted)!;
  }

  declineInvitation(invitationId: string, actingUserId?: string | null): MultiremiWorkspaceInvitation | null {
    const invitation = this.getInvitation(invitationId);
    if (!invitation || invitation.status !== "pending") return null;
    const user = this.resolveActingUser(actingUserId);
    if (invitation.inviteeEmail !== user.email.toLowerCase() && invitation.inviteeUserId !== user.id) {
      throw new Error("invitation does not belong to you");
    }
    return this.hydrateInvitation(this.updateInvitationStatus(invitationId, "declined"))!;
  }

  private updateInvitationStatus(invitationId: string, status: MultiremiWorkspaceInvitation["status"]): MultiremiWorkspaceInvitation {
    const now = nowIso();
    this.db.run("UPDATE multiremi_workspace_invitations SET status = ?, updated_at = ? WHERE id = ?", [status, now, invitationId]);
    return this.getInvitation(invitationId)!;
  }

  private expireStalePendingInvitations(workspaceId: string, email: string): void {
    const now = nowIso();
    this.db.run(
      `UPDATE multiremi_workspace_invitations
       SET status = 'expired', updated_at = ?
       WHERE workspace_id = ? AND invitee_email = ? AND status = 'pending' AND expires_at <= ?`,
      [now, workspaceId, email, now],
    );
  }

  private hydrateInvitation(invitation: MultiremiWorkspaceInvitation | null): MultiremiWorkspaceInvitation | null {
    if (!invitation) return null;
    const inviter = this.getUser(invitation.inviterId);
    const workspace = this.getWorkspace(invitation.workspaceId);
    return {
      ...invitation,
      inviterName: inviter?.name,
      inviter_name: inviter?.name,
      inviterEmail: inviter?.email,
      inviter_email: inviter?.email,
      workspaceName: workspace?.name,
      workspace_name: workspace?.name,
    };
  }

  getNotificationPreferences(input: { workspaceId?: string | null; memberId?: string | null } = {}): MultiremiNotificationPreferenceResponse {
    const workspaceId = input.workspaceId ?? "local";
    const memberId = input.memberId ?? null;
    const row = this.db.query(
      "SELECT * FROM multiremi_notification_preferences WHERE workspace_id = ? AND member_id = ?",
    ).get(workspaceId, memberId ?? "") as Row | null;
    return {
      workspaceId,
      memberId,
      preferences: row ? normalizeNotificationPreferences(parseJson(row.preferences, {})) : {},
      updatedAt: row ? String(row.updated_at ?? "") : null,
    };
  }

  updateNotificationPreferences(input: {
    workspaceId?: string | null;
    memberId?: string | null;
    preferences: MultiremiNotificationPreferences;
  }): MultiremiNotificationPreferenceResponse {
    const workspaceId = input.workspaceId ?? "local";
    const memberId = input.memberId ?? null;
    const preferences = normalizeNotificationPreferences(input.preferences);
    const now = nowIso();
    this.db.run(
      `INSERT INTO multiremi_notification_preferences (workspace_id, member_id, preferences, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(workspace_id, member_id) DO UPDATE SET preferences = excluded.preferences, updated_at = excluded.updated_at`,
      [workspaceId, memberId ?? "", toJson(preferences), now],
    );
    return this.getNotificationPreferences({ workspaceId, memberId });
  }

  createFeedback(input: CreateFeedbackInput): MultiremiFeedback {
    return this.feedback.createFeedback(input);
  }

  getFeedback(id: string): MultiremiFeedback | null {
    return this.feedback.getFeedback(id);
  }

  listFeedback(workspaceId?: string | null): MultiremiFeedback[] {
    return this.feedback.listFeedback(workspaceId);
  }

  countRecentFeedbackByUser(userId: string, since = new Date(Date.now() - 60 * 60 * 1000).toISOString()): number {
    return this.feedback.countRecentFeedbackByUser(userId, since);
  }

  getGitHubSettings(workspaceId = "local"): MultiremiGitHubSettings {
    const row = this.db.query("SELECT * FROM multiremi_github_settings WHERE workspace_id = ?").get(workspaceId) as Row | null;
    return row ? toGitHubSettings(row) : {
      workspaceId,
      enabled: true,
      prSidebar: true,
      coAuthor: true,
      autoLinkPRs: true,
      updatedAt: null,
    };
  }

  updateGitHubSettings(input: {
    workspaceId?: string | null;
    enabled?: boolean;
    prSidebar?: boolean;
    coAuthor?: boolean;
    autoLinkPRs?: boolean;
  }): MultiremiGitHubSettings {
    const workspaceId = input.workspaceId ?? "local";
    const current = this.getGitHubSettings(workspaceId);
    const enabled = input.enabled ?? current.enabled;
    const prSidebar = input.prSidebar ?? current.prSidebar;
    const coAuthor = input.coAuthor ?? current.coAuthor;
    const autoLinkPRs = input.autoLinkPRs ?? current.autoLinkPRs;
    const now = nowIso();
    this.db.run(
      `INSERT INTO multiremi_github_settings (
        workspace_id, enabled, pr_sidebar, co_author, auto_link_prs, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET
        enabled = excluded.enabled,
        pr_sidebar = excluded.pr_sidebar,
        co_author = excluded.co_author,
        auto_link_prs = excluded.auto_link_prs,
        updated_at = excluded.updated_at`,
      [
        workspaceId,
        enabled ? 1 : 0,
        prSidebar ? 1 : 0,
        coAuthor ? 1 : 0,
        autoLinkPRs ? 1 : 0,
        now,
      ],
    );
    return this.getGitHubSettings(workspaceId);
  }

  listGitHubPullRequests(input: { workspaceId?: string | null; issueId?: string | null } = {}): MultiremiGitHubPullRequest[] {
    const workspaceId = input.workspaceId ?? "local";
    const rows = input.issueId
      ? this.db.query("SELECT * FROM multiremi_github_pull_requests WHERE workspace_id = ? AND issue_id = ? ORDER BY pr_updated_at DESC").all(workspaceId, input.issueId) as Row[]
      : this.db.query("SELECT * FROM multiremi_github_pull_requests WHERE workspace_id = ? ORDER BY pr_updated_at DESC").all(workspaceId) as Row[];
    return rows.map(toGitHubPullRequest);
  }

  listGitHubPullRequestsForIssue(issueId: string): MultiremiGitHubPullRequest[] | null {
    const issue = this.getIssue(issueId);
    if (!issue) return null;
    return this.listGitHubPullRequests({ workspaceId: issue.workspaceId, issueId });
  }

  upsertGitHubPullRequest(input: {
    id?: string;
    workspaceId?: string | null;
    issueId?: string | null;
    repoOwner: string;
    repoName: string;
    number: number;
    title: string;
    state?: MultiremiGitHubPullRequestState | string;
    htmlUrl?: string | null;
    branch?: string | null;
    authorLogin?: string | null;
    authorAvatarUrl?: string | null;
    mergedAt?: string | null;
    closedAt?: string | null;
    prCreatedAt?: string | null;
    prUpdatedAt?: string | null;
    mergeableState?: string | null;
    checksConclusion?: string | null;
    checksPassed?: number;
    checksFailed?: number;
    checksPending?: number;
    additions?: number;
    deletions?: number;
    changedFiles?: number;
  }): MultiremiGitHubPullRequest {
    const workspaceId = input.workspaceId ?? "local";
    if (!input.repoOwner?.trim()) throw new Error("GitHub repo owner is required");
    if (!input.repoName?.trim()) throw new Error("GitHub repo name is required");
    if (!Number.isFinite(Number(input.number)) || Number(input.number) < 1) throw new Error("GitHub PR number is required");
    const issueId = input.issueId ?? this.findIssueIdForGitHubPullRequest(workspaceId, input);
    if (issueId && !this.getIssue(issueId)) throw new Error(`Issue not found: ${issueId}`);
    const now = nowIso();
    const state = normalizeGitHubPullRequestState(input.state);
    const htmlUrl = input.htmlUrl || `https://github.com/${input.repoOwner}/${input.repoName}/pull/${input.number}`;
    const id = input.id ?? createId("ghp");
    this.db.run(
      `INSERT INTO multiremi_github_pull_requests (
        id, workspace_id, issue_id, repo_owner, repo_name, number, title, state, html_url, branch,
        author_login, author_avatar_url, merged_at, closed_at, pr_created_at, pr_updated_at,
        mergeable_state, checks_conclusion, checks_passed, checks_failed, checks_pending,
        additions, deletions, changed_files, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, repo_owner, repo_name, number) DO UPDATE SET
        issue_id = excluded.issue_id,
        title = excluded.title,
        state = excluded.state,
        html_url = excluded.html_url,
        branch = excluded.branch,
        author_login = excluded.author_login,
        author_avatar_url = excluded.author_avatar_url,
        merged_at = excluded.merged_at,
        closed_at = excluded.closed_at,
        pr_created_at = excluded.pr_created_at,
        pr_updated_at = excluded.pr_updated_at,
        mergeable_state = excluded.mergeable_state,
        checks_conclusion = excluded.checks_conclusion,
        checks_passed = excluded.checks_passed,
        checks_failed = excluded.checks_failed,
        checks_pending = excluded.checks_pending,
        additions = excluded.additions,
        deletions = excluded.deletions,
        changed_files = excluded.changed_files,
        updated_at = excluded.updated_at`,
      [
        id,
        workspaceId,
        issueId,
        input.repoOwner,
        input.repoName,
        input.number,
        input.title,
        state,
        htmlUrl,
        input.branch ?? null,
        input.authorLogin ?? null,
        input.authorAvatarUrl ?? null,
        input.mergedAt ?? null,
        input.closedAt ?? null,
        input.prCreatedAt ?? now,
        input.prUpdatedAt ?? now,
        input.mergeableState ?? null,
        normalizeGitHubChecksConclusion(input.checksConclusion),
        Math.max(0, Number(input.checksPassed ?? 0)),
        Math.max(0, Number(input.checksFailed ?? 0)),
        Math.max(0, Number(input.checksPending ?? 0)),
        Math.max(0, Number(input.additions ?? 0)),
        Math.max(0, Number(input.deletions ?? 0)),
        Math.max(0, Number(input.changedFiles ?? 0)),
        now,
        now,
      ],
    );
    const pr = this.db.query(
      "SELECT * FROM multiremi_github_pull_requests WHERE workspace_id = ? AND repo_owner = ? AND repo_name = ? AND number = ?",
    ).get(workspaceId, input.repoOwner, input.repoName, input.number) as Row;
    const result = toGitHubPullRequest(pr);
    if (result.issueId && state === "merged" && this.getGitHubSettings(workspaceId).autoLinkPRs) {
      const issue = this.getIssue(result.issueId);
      if (issue && issue.status !== "done") this.updateIssue(issue.id, { status: "done" });
    }
    return result;
  }

  async createAccessToken(input: CreateAccessTokenInput): Promise<MultiremiCreatedAccessToken> {
    return this.accessTokens.createAccessToken(input);
  }

  async createTaskAccessToken(
    task: Pick<MultiremiTask, "id" | "agentId" | "workspaceId">,
    userId: string,
  ): Promise<MultiremiCreatedAccessToken> {
    return this.accessTokens.createTaskAccessToken(task, userId);
  }

  listAccessTokens(workspaceId?: string | null): MultiremiAccessToken[] {
    return this.accessTokens.listAccessTokens(workspaceId);
  }

  getAccessToken(id: string): MultiremiAccessToken | null {
    return this.accessTokens.getAccessToken(id);
  }

  revokeAccessToken(id: string): MultiremiAccessToken | null {
    return this.accessTokens.revokeAccessToken(id);
  }

  revokeTaskAccessTokens(taskId: string): number {
    return this.accessTokens.revokeTaskAccessTokens(taskId);
  }

  async renewAccessTokenExpiry(
    id: string,
    options: { thresholdDays?: number; extensionDays?: number } = {},
  ): Promise<{ token: MultiremiAccessToken; renewed: boolean; rawToken?: string } | null> {
    return this.accessTokens.renewAccessTokenExpiry(id, options);
  }

  async verifyAccessToken(rawToken: string, allowedTypes?: MultiremiAccessTokenType[]): Promise<MultiremiAccessToken | null> {
    return this.accessTokens.verifyAccessToken(rawToken, allowedTypes);
  }

  registerRuntime(input: RegisterRuntimeInput): MultiremiRuntime {
    const id = input.id ?? createId("rt");
    const now = nowIso();
    const currentRow = this.db.query("SELECT * FROM multiremi_runtimes WHERE id = ?").get(id) as Row | null;
    const current = currentRow ? toRuntime(currentRow) : null;
    const inputOwnerId = hasAnyField(input, "ownerId", "owner_id")
      ? resolveOptionalStringField(input, "ownerId", "owner_id", current?.ownerId ?? null)
      : current?.ownerId ?? null;
    const ownerId = current && inputOwnerId == null ? current.ownerId : inputOwnerId;
    const visibility = hasAnyField(input, "visibility")
      ? normalizeRuntimeVisibility(input.visibility)
      : current?.visibility ?? "private";
    const daemonId = hasAnyField(input, "daemonId", "daemon_id")
      ? resolveOptionalStringField(input, "daemonId", "daemon_id", current?.daemonId ?? null)
      : current?.daemonId ?? null;
    const legacyDaemonId = hasAnyField(input, "legacyDaemonId", "legacy_daemon_id")
      ? resolveOptionalStringField(input, "legacyDaemonId", "legacy_daemon_id", current?.legacyDaemonId ?? null)
      : current?.legacyDaemonId ?? null;
    const runtimeMode = hasAnyField(input, "runtimeMode", "runtime_mode")
      ? cleanOptionalString(input.runtimeMode ?? input.runtime_mode) ?? "local"
      : current?.runtimeMode ?? "local";
    const deviceInfo = hasAnyField(input, "deviceInfo", "device_info")
      ? cleanOptionalString(input.deviceInfo ?? input.device_info) ?? ""
      : current?.deviceInfo ?? "";
    const metadata = hasAnyField(input, "metadata")
      ? preserveRuntimeMergeAudit(current?.metadata ?? {}, normalizeRuntimeMetadata(input.metadata ?? {}))
      : current?.metadata ?? {};
    const maxConcurrency = normalizeRuntimeConcurrency(input.maxConcurrency ?? input.max_concurrency ?? current?.maxConcurrency ?? 1);
    const status = input.status === "offline" ? "offline" : "online";
    this.db.run(
      `INSERT INTO multiremi_runtimes (
        id, name, provider, daemon_id, legacy_daemon_id, runtime_mode, device_info, metadata,
        workspace_id, owner_id, visibility, status, max_concurrency,
        last_heartbeat_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = CASE WHEN multiremi_runtimes.name_customized = 1 THEN multiremi_runtimes.name ELSE excluded.name END,
        provider = excluded.provider,
        daemon_id = excluded.daemon_id,
        legacy_daemon_id = excluded.legacy_daemon_id,
        runtime_mode = excluded.runtime_mode,
        device_info = excluded.device_info,
        metadata = excluded.metadata,
        workspace_id = excluded.workspace_id,
        owner_id = excluded.owner_id,
        visibility = excluded.visibility,
        status = excluded.status,
        max_concurrency = excluded.max_concurrency,
        last_heartbeat_at = excluded.last_heartbeat_at,
        updated_at = excluded.updated_at`,
      [
        id,
        input.name,
        input.provider,
        daemonId,
        legacyDaemonId,
        runtimeMode,
        deviceInfo,
        toJson(metadata),
        input.workspaceId ?? input.workspace_id ?? null,
        ownerId,
        visibility,
        status,
        maxConcurrency,
        now,
        now,
        now,
      ],
    );
    if (input.models !== undefined) this.replaceRuntimeModels(id, input.models, input.provider, now);
    const runtime = this.getRuntime(id)!;
    if (!current) {
      this.recordRuntimeRegisteredAnalytics(runtime);
      if (runtime.status === "online") this.recordRuntimeReadyAnalytics(runtime, 0);
    }
    return runtime;
  }

  bindUnboundAgentsToRuntime(runtime: MultiremiRuntime): number {
    const now = nowIso();
    const result = this.db.run(
      `UPDATE multiremi_agents SET runtime_id = ?, updated_at = ?
       WHERE workspace_id = ? AND provider = ?
         AND (runtime_id IS NULL OR runtime_id = '')
         AND archived_at IS NULL`,
      [runtime.id, now, runtime.workspaceId, runtime.provider],
    );
    return result.changes;
  }

  getRuntime(id: string): MultiremiRuntime | null {
    const row = this.db.query("SELECT * FROM multiremi_runtimes WHERE id = ?").get(id) as Row | null;
    return row ? withRuntimeLiveness(this.hydrateRuntime(toRuntime(row))) : null;
  }

  listRuntimes(): MultiremiRuntime[] {
    const rows = this.db.query("SELECT * FROM multiremi_runtimes ORDER BY updated_at DESC").all() as Row[];
    return rows.map((row) => withRuntimeLiveness(this.hydrateRuntime(toRuntime(row))));
  }

  listActiveAgentsByRuntime(runtimeId: string): MultiremiAgent[] {
    if (!this.getRuntime(runtimeId)) throw new Error(`Runtime not found: ${runtimeId}`);
    const rows = this.db.query(
      `SELECT * FROM multiremi_agents
       WHERE runtime_id = ? AND archived_at IS NULL
       ORDER BY lower(name) ASC, name ASC`,
    ).all(runtimeId) as Row[];
    return rows.map((row) => this.hydrateAgent(toAgent(row)));
  }

  updateRuntime(id: string, input: UpdateRuntimeInput): MultiremiRuntime {
    const current = this.getRuntime(id);
    if (!current) throw new Error(`Runtime not found: ${id}`);
    const ownerId = resolveOptionalStringField(input, "ownerId", "owner_id", current.ownerId);
    const visibility = hasAnyField(input, "visibility")
      ? normalizeRuntimeVisibility(input.visibility)
      : current.visibility;
    const maxConcurrency = hasAnyField(input, "maxConcurrency", "max_concurrency")
      ? normalizeRuntimeConcurrency(input.maxConcurrency ?? input.max_concurrency)
      : current.maxConcurrency;
    const runtimeMode = hasAnyField(input, "runtimeMode", "runtime_mode")
      ? cleanOptionalString(input.runtimeMode ?? input.runtime_mode) ?? "local"
      : current.runtimeMode;
    const deviceInfo = hasAnyField(input, "deviceInfo", "device_info")
      ? cleanOptionalString(input.deviceInfo ?? input.device_info) ?? ""
      : current.deviceInfo;
    const metadata = hasAnyField(input, "metadata")
      ? normalizeRuntimeMetadata(input.metadata ?? {})
      : current.metadata;
    const now = nowIso();
    this.db.run(
      `UPDATE multiremi_runtimes SET
        name = ?,
        name_customized = CASE WHEN ? = 1 THEN 1 ELSE name_customized END,
        runtime_mode = ?,
        device_info = ?,
        metadata = ?,
        owner_id = ?,
        visibility = ?,
        max_concurrency = ?,
        updated_at = ?
       WHERE id = ?`,
      [
        input.name ?? current.name,
        hasAnyField(input, "name") ? 1 : 0,
        runtimeMode,
        deviceInfo,
        toJson(metadata),
        ownerId,
        visibility,
        maxConcurrency,
        now,
        id,
      ],
    );
    if (input.models !== undefined) this.replaceRuntimeModels(id, input.models, current.provider, now);
    return this.getRuntime(id)!;
  }

  setRuntimeOffline(id: string): MultiremiRuntime | null {
    const current = this.getRuntime(id);
    if (!current) return null;
    const now = nowIso();
    this.db.run(
      "UPDATE multiremi_runtimes SET status = 'offline', updated_at = ? WHERE id = ?",
      [now, id],
    );
    const runtime = this.getRuntime(id);
    if (runtime && current.status !== "offline") this.recordRuntimeOfflineAnalytics(runtime);
    return runtime;
  }

  recordRuntimeFailure(input: RuntimeFailureAnalyticsInput): MultiremiAnalyticsEvent {
    const ownerId = input.ownerId ?? "";
    const workspaceId = input.workspaceId ?? null;
    const provider = input.provider?.trim() || "unknown";
    return this.recordAnalyticsEvent(
      EVENT_RUNTIME_FAILED,
      runtimeFailureDistinctId(ownerId, workspaceId),
      workspaceId,
      withAnalyticsCoreProperties({
        daemon_id: input.daemonId?.trim() ?? "",
        failure_reason: input.failureReason,
        error_type: input.errorType,
        recoverable: input.recoverable,
      }, {
        userId: ownerId,
        source: "manual",
        runtimeMode: "local",
        provider,
      }),
    );
  }

  recordAgentCreated(input: AgentCreatedAnalyticsInput): MultiremiAnalyticsEvent {
    return this.recordAnalyticsEvent(
      EVENT_AGENT_CREATED,
      input.actorId,
      input.workspaceId,
      withAnalyticsCoreProperties({
        agent_id: input.agentId,
        provider: input.provider,
        runtime_mode: input.runtimeMode,
        template: input.template ?? "",
        is_first_agent_in_workspace: input.isFirstAgentInWorkspace,
      }, {
        userId: input.actorId,
        agentId: input.agentId,
        source: "manual",
        runtimeMode: input.runtimeMode,
        provider: input.provider,
      }),
    );
  }

  deleteRuntime(id: string): boolean {
    const result = this.db.run("DELETE FROM multiremi_runtimes WHERE id = ?", [id]);
    return result.changes > 0;
  }

  deleteRuntimeWithArchivedAgentCleanup(id: string): boolean {
    if (!this.getRuntime(id)) return false;
    const tx = this.db.transaction(() => {
      this.pauseAutopilotsByAgentIds(this.listArchivedAgentIdsByRuntime(id));
      this.deleteArchivedAgentsByRuntime(id);
      return this.deleteRuntime(id);
    });
    return tx();
  }

  archiveAgentsAndDeleteRuntime(
    id: string,
    expectedActiveAgentIds: string[],
  ): { status: "ok"; agentsArchived: number; tasksCancelled: number } | { status: "plan_changed"; activeAgents: MultiremiAgent[] } {
    if (!this.getRuntime(id)) throw new Error(`Runtime not found: ${id}`);
    const expected = new Set(expectedActiveAgentIds);
    const tx = this.db.transaction(() => {
      const activeAgents = this.listActiveAgentsByRuntime(id);
      if (!activeAgentSetMatches(activeAgents, expected)) {
        return { status: "plan_changed" as const, activeAgents };
      }

      const activeAgentIds = activeAgents.map((agent) => agent.id);
      const now = nowIso();
      if (activeAgentIds.length) {
        this.db.run(
          `UPDATE multiremi_agents
           SET archived_at = ?, updated_at = ?
           WHERE id IN (${activeAgentIds.map(() => "?").join(",")}) AND archived_at IS NULL`,
          [now, now, ...activeAgentIds],
        );
      }

      const tasksCancelled = this.cancelActiveTasksByRuntimeOrAgentIds(id, activeAgentIds);
      this.pauseAutopilotsByAgentIds([...activeAgentIds, ...this.listArchivedAgentIdsByRuntime(id)]);
      const agentsArchived = activeAgentIds.length;
      this.deleteArchivedAgentsByRuntime(id);
      const deleted = this.deleteRuntime(id);
      if (!deleted) throw new Error(`Runtime not found: ${id}`);
      return { status: "ok" as const, agentsArchived, tasksCancelled };
    });
    return tx();
  }

  private listArchivedAgentIdsByRuntime(runtimeId: string): string[] {
    const rows = this.db.query(
      "SELECT id FROM multiremi_agents WHERE runtime_id = ? AND archived_at IS NOT NULL ORDER BY id ASC",
    ).all(runtimeId) as Array<{ id: string }>;
    return rows.map((row) => String(row.id));
  }

  private pauseAutopilotsByAgentIds(agentIds: string[]): number {
    const ids = [...new Set(agentIds)].filter(Boolean);
    if (!ids.length) return 0;
    const now = nowIso();
    const result = this.db.run(
      `UPDATE multiremi_autopilots
       SET status = 'paused', updated_at = ?
       WHERE assignee_type = 'agent'
         AND assignee_id IN (${ids.map(() => "?").join(",")})
         AND status != 'archived'`,
      [now, ...ids],
    );
    return result.changes;
  }

  private cancelActiveTasksByRuntimeOrAgentIds(runtimeId: string, agentIds: string[]): number {
    const agentSet = new Set(agentIds);
    const taskIds = [...new Set(
      this.listTasks()
        .filter((task) => isActiveTaskStatus(task.status) && (task.runtimeId === runtimeId || agentSet.has(task.agentId)))
        .map((task) => task.id),
    )];
    let cancelled = 0;
    for (const taskId of taskIds) {
      try {
        this.cancelTask(taskId);
        cancelled += 1;
      } catch {
        // Task may have reached a terminal state between the snapshot and cancel.
      }
    }
    return cancelled;
  }

  private deleteArchivedAgentsByRuntime(runtimeId: string): number {
    const ids = this.listArchivedAgentIdsByRuntime(runtimeId);
    if (!ids.length) return 0;
    const placeholders = ids.map(() => "?").join(",");
    this.db.run(`DELETE FROM multiremi_agent_skills WHERE agent_id IN (${placeholders})`, ids);
    this.db.run(`DELETE FROM multiremi_squad_members WHERE member_type = 'agent' AND member_id IN (${placeholders})`, ids);
    this.db.run(
      `UPDATE multiremi_squads
       SET leader_id = NULL, updated_at = ?
       WHERE leader_id IN (${placeholders})`,
      [nowIso(), ...ids],
    );
    return this.db.run(`DELETE FROM multiremi_agents WHERE id IN (${placeholders})`, ids).changes;
  }

  mergeRuntimeInto(oldRuntimeId: string, newRuntimeId: string): { agentsReassigned: number; tasksReassigned: number; deleted: boolean } {
    if (oldRuntimeId === newRuntimeId) return { agentsReassigned: 0, tasksReassigned: 0, deleted: false };
    const oldRuntime = this.getRuntime(oldRuntimeId);
    const newRuntime = this.getRuntime(newRuntimeId);
    if (!oldRuntime || !newRuntime) return { agentsReassigned: 0, tasksReassigned: 0, deleted: false };
    if (oldRuntime.workspaceId !== newRuntime.workspaceId || oldRuntime.provider !== newRuntime.provider) {
      return { agentsReassigned: 0, tasksReassigned: 0, deleted: false };
    }

    const now = nowIso();
    const tx = this.db.transaction(() => {
      const agents = this.db.run(
        "UPDATE multiremi_agents SET runtime_id = ?, updated_at = ? WHERE runtime_id = ?",
        [newRuntimeId, now, oldRuntimeId],
      ).changes;
      const tasks = this.db.run(
        "UPDATE multiremi_tasks SET runtime_id = ?, updated_at = ? WHERE runtime_id = ?",
        [newRuntimeId, now, oldRuntimeId],
      ).changes;
      const deleted = this.deleteRuntime(oldRuntimeId);
      return { agentsReassigned: agents, tasksReassigned: tasks, deleted };
    });
    return tx();
  }

  recordRuntimeLegacyDaemonId(
    runtimeId: string,
    legacyDaemonId: string,
    audit?: {
      oldRuntimeId: string;
      newRuntimeId: string;
      provider: string;
      agentsReassigned: number;
      tasksReassigned: number;
    },
  ): MultiremiRuntime | null {
    const runtime = this.getRuntime(runtimeId);
    const normalized = legacyDaemonId.trim();
    if (!runtime || !normalized) return runtime;
    const now = nowIso();
    const metadata = audit
      ? withLegacyRuntimeMergeAudit(runtime.metadata, {
          legacyDaemonId: normalized,
          oldRuntimeId: audit.oldRuntimeId,
          newRuntimeId: audit.newRuntimeId,
          provider: audit.provider,
          agentsReassigned: audit.agentsReassigned,
          tasksReassigned: audit.tasksReassigned,
          mergedAt: now,
        })
      : runtime.metadata;
    this.db.run(
      `UPDATE multiremi_runtimes
       SET legacy_daemon_id = COALESCE(legacy_daemon_id, ?), metadata = ?, updated_at = ?
       WHERE id = ?`,
      [normalized, toJson(metadata), now, runtimeId],
    );
    return this.getRuntime(runtimeId);
  }

  listCloudRuntimeNodes(options: { limit?: number; offset?: number; ownerId?: string | null } = {}): MultiremiCloudRuntimeNode[] {
    return this.cloudNodes.listCloudRuntimeNodes(options);
  }

  createCloudRuntimeNode(input: CreateCloudRuntimeNodeInput, ownerId = "local"): MultiremiCloudRuntimeNode {
    return this.cloudNodes.createCloudRuntimeNode(input, ownerId);
  }

  getCloudRuntimeNode(id: string): MultiremiCloudRuntimeNode | null {
    return this.cloudNodes.getCloudRuntimeNode(id);
  }

  deleteCloudRuntimeNode(id: string): boolean {
    return this.cloudNodes.deleteCloudRuntimeNode(id);
  }

  setCloudRuntimeNodeStatus(id: string, status: string): MultiremiCloudRuntimeNode | null {
    return this.cloudNodes.setCloudRuntimeNodeStatus(id, status);
  }

  execCloudRuntimeNode(id: string, command: string): { node: MultiremiCloudRuntimeNode; exit_code: number; stdout: string; stderr: string } | null {
    return this.cloudNodes.execCloudRuntimeNode(id, command);
  }

  listRuntimeModels(runtimeId: string): MultiremiRuntimeModel[] {
    if (!this.db.query("SELECT id FROM multiremi_runtimes WHERE id = ?").get(runtimeId)) {
      throw new Error(`Runtime not found: ${runtimeId}`);
    }
    return this.listRuntimeModelsForExistingRuntime(runtimeId);
  }

  updateRuntimeModels(runtimeId: string, models: MultiremiRuntimeModel[]): MultiremiRuntimeModel[] {
    const row = this.db.query("SELECT * FROM multiremi_runtimes WHERE id = ?").get(runtimeId) as Row | null;
    if (!row) throw new Error(`Runtime not found: ${runtimeId}`);
    this.replaceRuntimeModels(runtimeId, models, String(row.provider), nowIso());
    return this.listRuntimeModels(runtimeId);
  }

  createRuntimeModelListRequest(runtimeId: string): MultiremiRuntimeModelListRequest {
    const runtime = this.getRuntime(runtimeId);
    if (!runtime) throw new Error(`Runtime not found: ${runtimeId}`);
    if (runtime.status !== "online") throw new Error("runtime is offline");
    const id = createId("rml");
    const now = nowIso();
    this.db.run(
      `INSERT INTO multiremi_runtime_model_list_requests (
        id, runtime_id, status, models, supported, created_at, updated_at
      ) VALUES (?, ?, 'pending', '[]', 1, ?, ?)`,
      [id, runtimeId, now, now],
    );
    return this.getRuntimeModelListRequest(runtimeId, id)!;
  }

  getRuntimeModelListRequest(runtimeId: string, requestId: string): MultiremiRuntimeModelListRequest | null {
    this.expireRuntimeModelListRequests(runtimeId);
    const row = this.db.query(
      "SELECT * FROM multiremi_runtime_model_list_requests WHERE id = ? AND runtime_id = ?",
    ).get(requestId, runtimeId) as Row | null;
    return row ? toRuntimeModelListRequest(row) : null;
  }

  claimRuntimeModelListRequest(runtimeId: string): MultiremiRuntimeModelListRequest | null {
    this.expireRuntimeModelListRequests(runtimeId);
    const row = this.db.query(
      `SELECT * FROM multiremi_runtime_model_list_requests
       WHERE runtime_id = ? AND status = 'pending'
       ORDER BY created_at ASC
       LIMIT 1`,
    ).get(runtimeId) as Row | null;
    if (!row) return null;
    const now = nowIso();
    this.db.run(
      "UPDATE multiremi_runtime_model_list_requests SET status = 'running', run_started_at = ?, updated_at = ? WHERE id = ?",
      [now, now, String(row.id)],
    );
    return this.getRuntimeModelListRequest(runtimeId, String(row.id));
  }

  private expireRuntimeModelListRequests(runtimeId: string): void {
    const now = nowIso();
    const pendingCutoff = new Date(Date.now() - RUNTIME_MODEL_LIST_PENDING_TIMEOUT_MS).toISOString();
    const runningCutoff = new Date(Date.now() - RUNTIME_MODEL_LIST_RUNNING_TIMEOUT_MS).toISOString();
    this.db.run(
      `UPDATE multiremi_runtime_model_list_requests
       SET status = 'timeout', error = 'daemon did not respond within 30 seconds', updated_at = ?
       WHERE runtime_id = ? AND status = 'pending' AND created_at < ?`,
      [now, runtimeId, pendingCutoff],
    );
    this.db.run(
      `UPDATE multiremi_runtime_model_list_requests
       SET status = 'timeout', error = 'daemon did not finish within 60 seconds', updated_at = ?
       WHERE runtime_id = ? AND status = 'running' AND run_started_at IS NOT NULL AND run_started_at < ?`,
      [now, runtimeId, runningCutoff],
    );
  }

  reportRuntimeModelListResult(runtimeId: string, requestId: string, input: ReportRuntimeModelListInput): MultiremiRuntimeModelListRequest {
    const current = this.getRuntimeModelListRequest(runtimeId, requestId);
    if (!current) throw new Error("request not found");
    if (isTerminalRuntimeRequestStatus(current.status)) return current;
    const status = normalizeRuntimeModelListStatus(input.status);
    const now = nowIso();
    if (status === "completed") {
      const runtime = this.getRuntime(runtimeId);
      if (!runtime) throw new Error(`Runtime not found: ${runtimeId}`);
      const models = normalizeRuntimeModels(input.models ?? [], runtime.provider);
      this.db.transaction(() => {
        this.replaceRuntimeModels(runtimeId, models, runtime.provider, now);
        this.db.run(
          `UPDATE multiremi_runtime_model_list_requests
           SET status = 'completed', models = ?, supported = ?, error = NULL, updated_at = ?
           WHERE id = ?`,
          [toJson(models), input.supported === false ? 0 : 1, now, requestId],
        );
      })();
    } else {
      this.db.run(
        `UPDATE multiremi_runtime_model_list_requests
         SET status = 'failed', error = ?, updated_at = ?
         WHERE id = ?`,
        [input.error ?? "runtime model list failed", now, requestId],
      );
    }
    return this.getRuntimeModelListRequest(runtimeId, requestId)!;
  }

  createRuntimeDirectoryScanRequest(runtimeId: string, params: { root?: string; maxDepth?: number; mode?: "scan" | "browse" } = {}): MultiremiRuntimeDirectoryScanRequest {
    const runtime = this.getRuntime(runtimeId);
    if (!runtime) throw new Error(`Runtime not found: ${runtimeId}`);
    if (runtime.status !== "online") throw new Error("runtime is offline");
    const normalizedParams = normalizeRuntimeDirectoryScanParams(params);
    const id = createId("rds");
    const now = nowIso();
    this.db.run(
      `INSERT INTO multiremi_runtime_directory_scan_requests (
        id, runtime_id, status, params, candidates, supported, created_at, updated_at
      ) VALUES (?, ?, 'pending', ?, '[]', 1, ?, ?)`,
      [id, runtimeId, toJson(normalizedParams), now, now],
    );
    return this.getRuntimeDirectoryScanRequest(runtimeId, id)!;
  }

  getRuntimeDirectoryScanRequest(runtimeId: string, requestId: string): MultiremiRuntimeDirectoryScanRequest | null {
    this.expireRuntimeDirectoryScanRequests(runtimeId);
    const row = this.db.query(
      "SELECT * FROM multiremi_runtime_directory_scan_requests WHERE id = ? AND runtime_id = ?",
    ).get(requestId, runtimeId) as Row | null;
    return row ? toRuntimeDirectoryScanRequest(row) : null;
  }

  claimRuntimeDirectoryScanRequest(runtimeId: string): MultiremiRuntimeDirectoryScanRequest | null {
    this.expireRuntimeDirectoryScanRequests(runtimeId);
    const row = this.db.query(
      `SELECT * FROM multiremi_runtime_directory_scan_requests
       WHERE runtime_id = ? AND status = 'pending'
       ORDER BY created_at ASC
       LIMIT 1`,
    ).get(runtimeId) as Row | null;
    if (!row) return null;
    const now = nowIso();
    this.db.run(
      "UPDATE multiremi_runtime_directory_scan_requests SET status = 'running', run_started_at = ?, updated_at = ? WHERE id = ?",
      [now, now, String(row.id)],
    );
    return this.getRuntimeDirectoryScanRequest(runtimeId, String(row.id));
  }

  private expireRuntimeDirectoryScanRequests(runtimeId: string): void {
    const now = nowIso();
    const pendingCutoff = new Date(Date.now() - RUNTIME_DIRECTORY_SCAN_PENDING_TIMEOUT_MS).toISOString();
    const runningCutoff = new Date(Date.now() - RUNTIME_DIRECTORY_SCAN_RUNNING_TIMEOUT_MS).toISOString();
    this.db.run(
      `UPDATE multiremi_runtime_directory_scan_requests
       SET status = 'timeout', error = 'daemon did not respond within 3 minutes; the runtime daemon may need updating', updated_at = ?
       WHERE runtime_id = ? AND status = 'pending' AND created_at < ?`,
      [now, runtimeId, pendingCutoff],
    );
    this.db.run(
      `UPDATE multiremi_runtime_directory_scan_requests
       SET status = 'timeout', error = 'daemon did not finish within 60 seconds', updated_at = ?
       WHERE runtime_id = ? AND status = 'running' AND run_started_at IS NOT NULL AND run_started_at < ?`,
      [now, runtimeId, runningCutoff],
    );
  }

  reportRuntimeDirectoryScanResult(runtimeId: string, requestId: string, input: ReportRuntimeDirectoryScanInput): MultiremiRuntimeDirectoryScanRequest {
    const current = this.getRuntimeDirectoryScanRequest(runtimeId, requestId);
    if (!current) throw new Error("request not found");
    if (isTerminalRuntimeRequestStatus(current.status)) return current;
    const status = normalizeRuntimeDirectoryScanStatus(input.status);
    const now = nowIso();
    if (status === "completed") {
      // Browse mode echoes the expanded absolute root back; merge it into the
      // request params so the folder-picker can render/ascend on empty listings.
      const resolvedRoot = typeof input.resolvedRoot === "string" && input.resolvedRoot.trim() ? input.resolvedRoot.trim() : null;
      const params = resolvedRoot ? { ...current.params, resolvedRoot } : current.params;
      this.db.run(
        `UPDATE multiremi_runtime_directory_scan_requests
         SET status = 'completed', params = ?, candidates = ?, supported = ?, error = NULL, updated_at = ?
         WHERE id = ?`,
        [toJson(params), toJson(normalizeRuntimeDirectoryCandidates(input.candidates ?? [])), input.supported === false ? 0 : 1, now, requestId],
      );
    } else {
      this.db.run(
        `UPDATE multiremi_runtime_directory_scan_requests
         SET status = 'failed', error = ?, updated_at = ?
         WHERE id = ?`,
        [input.error ?? "runtime directory scan failed", now, requestId],
      );
    }
    return this.getRuntimeDirectoryScanRequest(runtimeId, requestId)!;
  }

  createRuntimeUpdateRequest(runtimeId: string, input: CreateRuntimeUpdateInput): MultiremiRuntimeUpdateRequest {
    const runtime = this.getRuntime(runtimeId);
    if (!runtime) throw new Error(`Runtime not found: ${runtimeId}`);
    if (runtime.status !== "online") throw new Error("runtime is offline");
    const scope = input.scope === "acp" || input.scope === "agent" ? input.scope : "cli";
    // ACP/agent updates always pull @latest, so no target version is required.
    const targetVersion = String(input.targetVersion ?? input.target_version ?? "").trim() || (scope !== "cli" ? "latest" : "");
    if (!targetVersion) throw new Error("target_version is required");
    const active = this.db.query(
      `SELECT id FROM multiremi_runtime_update_requests
       WHERE runtime_id = ? AND status IN ('pending', 'running')
       LIMIT 1`,
    ).get(runtimeId) as Row | null;
    if (active) throw new Error("an update is already in progress for this runtime");
    const id = createId("rup");
    const now = nowIso();
    this.db.run(
      `INSERT INTO multiremi_runtime_update_requests (
        id, runtime_id, status, scope, target_version, created_at, updated_at
      ) VALUES (?, ?, 'pending', ?, ?, ?, ?)`,
      [id, runtimeId, scope, targetVersion, now, now],
    );
    return this.getRuntimeUpdateRequest(runtimeId, id)!;
  }

  getRuntimeUpdateRequest(runtimeId: string, requestId: string): MultiremiRuntimeUpdateRequest | null {
    this.expireRuntimeUpdateRequests(runtimeId);
    const row = this.db.query(
      "SELECT * FROM multiremi_runtime_update_requests WHERE id = ? AND runtime_id = ?",
    ).get(requestId, runtimeId) as Row | null;
    return row ? toRuntimeUpdateRequest(row) : null;
  }

  claimRuntimeUpdateRequest(runtimeId: string): MultiremiRuntimeUpdateRequest | null {
    this.expireRuntimeUpdateRequests(runtimeId);
    const row = this.db.query(
      `SELECT * FROM multiremi_runtime_update_requests
       WHERE runtime_id = ? AND status = 'pending'
       ORDER BY created_at ASC
       LIMIT 1`,
    ).get(runtimeId) as Row | null;
    if (!row) return null;
    const now = nowIso();
    this.db.run(
      "UPDATE multiremi_runtime_update_requests SET status = 'running', run_started_at = ?, updated_at = ? WHERE id = ?",
      [now, now, String(row.id)],
    );
    return this.getRuntimeUpdateRequest(runtimeId, String(row.id));
  }

  private expireRuntimeUpdateRequests(runtimeId: string): void {
    const now = nowIso();
    const pendingCutoff = new Date(Date.now() - RUNTIME_UPDATE_PENDING_TIMEOUT_MS).toISOString();
    const runningCutoff = new Date(Date.now() - RUNTIME_UPDATE_RUNNING_TIMEOUT_MS).toISOString();
    this.db.run(
      `UPDATE multiremi_runtime_update_requests
       SET status = 'timeout', error = 'daemon did not respond within 120 seconds', updated_at = ?
       WHERE runtime_id = ? AND status = 'pending' AND created_at < ?`,
      [now, runtimeId, pendingCutoff],
    );
    this.db.run(
      `UPDATE multiremi_runtime_update_requests
       SET status = 'timeout', error = 'update did not complete within 150 seconds', updated_at = ?
       WHERE runtime_id = ? AND status = 'running' AND run_started_at IS NOT NULL AND run_started_at < ?`,
      [now, runtimeId, runningCutoff],
    );
  }

  reportRuntimeUpdateResult(runtimeId: string, requestId: string, input: ReportRuntimeUpdateInput): MultiremiRuntimeUpdateRequest {
    const current = this.getRuntimeUpdateRequest(runtimeId, requestId);
    if (!current) throw new Error("update not found");
    const status = normalizeRuntimeUpdateStatus(input.status);
    const now = nowIso();
    if (isTerminalRuntimeRequestStatus(current.status)) return current;
    if (status === "completed") {
      this.db.run(
        "UPDATE multiremi_runtime_update_requests SET status = 'completed', output = ?, error = NULL, updated_at = ? WHERE id = ?",
        [input.output ?? "", now, requestId],
      );
    } else if (status === "running") {
      this.db.run(
        "UPDATE multiremi_runtime_update_requests SET status = 'running', updated_at = ? WHERE id = ?",
        [now, requestId],
      );
    } else {
      this.db.run(
        "UPDATE multiremi_runtime_update_requests SET status = 'failed', error = ?, updated_at = ? WHERE id = ?",
        [input.error ?? "runtime update failed", now, requestId],
      );
    }
    return this.getRuntimeUpdateRequest(runtimeId, requestId)!;
  }

  createRuntimeLocalSkillListRequest(runtimeId: string): MultiremiRuntimeLocalSkillListRequest {
    const runtime = this.getRuntime(runtimeId);
    if (!runtime) throw new Error(`Runtime not found: ${runtimeId}`);
    if (runtime.status !== "online") throw new Error("runtime is offline");
    const id = createId("rls");
    const now = nowIso();
    this.db.run(
      `INSERT INTO multiremi_runtime_local_skill_list_requests (
        id, runtime_id, status, skills, supported, created_at, updated_at
      ) VALUES (?, ?, 'pending', '[]', 1, ?, ?)`,
      [id, runtimeId, now, now],
    );
    return this.getRuntimeLocalSkillListRequest(runtimeId, id)!;
  }

  getRuntimeLocalSkillListRequest(runtimeId: string, requestId: string): MultiremiRuntimeLocalSkillListRequest | null {
    this.expireRuntimeLocalSkillListRequests(runtimeId);
    const row = this.db.query(
      "SELECT * FROM multiremi_runtime_local_skill_list_requests WHERE id = ? AND runtime_id = ?",
    ).get(requestId, runtimeId) as Row | null;
    return row ? toRuntimeLocalSkillListRequest(row) : null;
  }

  claimRuntimeLocalSkillListRequest(runtimeId: string): MultiremiRuntimeLocalSkillListRequest | null {
    this.expireRuntimeLocalSkillListRequests(runtimeId);
    const row = this.db.query(
      `SELECT * FROM multiremi_runtime_local_skill_list_requests
       WHERE runtime_id = ? AND status = 'pending'
       ORDER BY created_at ASC
       LIMIT 1`,
    ).get(runtimeId) as Row | null;
    if (!row) return null;
    const now = nowIso();
    this.db.run(
      "UPDATE multiremi_runtime_local_skill_list_requests SET status = 'running', run_started_at = ?, updated_at = ? WHERE id = ?",
      [now, now, String(row.id)],
    );
    return this.getRuntimeLocalSkillListRequest(runtimeId, String(row.id));
  }

  private expireRuntimeLocalSkillListRequests(runtimeId: string): void {
    const now = nowIso();
    const pendingCutoff = new Date(Date.now() - RUNTIME_LOCAL_SKILL_PENDING_TIMEOUT_MS).toISOString();
    const runningCutoff = new Date(Date.now() - RUNTIME_LOCAL_SKILL_RUNNING_TIMEOUT_MS).toISOString();
    this.db.run(
      `UPDATE multiremi_runtime_local_skill_list_requests
       SET status = 'timeout', error = 'daemon did not respond within 3 minutes', updated_at = ?
       WHERE runtime_id = ? AND status = 'pending' AND created_at < ?`,
      [now, runtimeId, pendingCutoff],
    );
    this.db.run(
      `UPDATE multiremi_runtime_local_skill_list_requests
       SET status = 'timeout', error = 'daemon did not finish within 60 seconds', updated_at = ?
       WHERE runtime_id = ? AND status = 'running' AND run_started_at IS NOT NULL AND run_started_at < ?`,
      [now, runtimeId, runningCutoff],
    );
  }

  reportRuntimeLocalSkillListResult(runtimeId: string, requestId: string, input: ReportRuntimeLocalSkillListInput): MultiremiRuntimeLocalSkillListRequest {
    const current = this.getRuntimeLocalSkillListRequest(runtimeId, requestId);
    if (!current) throw new Error("request not found");
    if (isTerminalRuntimeRequestStatus(current.status)) return current;
    const status = normalizeRuntimeLocalSkillStatus(input.status);
    const now = nowIso();
    if (status === "completed") {
      this.db.run(
        `UPDATE multiremi_runtime_local_skill_list_requests
         SET status = 'completed', skills = ?, supported = ?, error = NULL, updated_at = ?
         WHERE id = ?`,
        [toJson(normalizeRuntimeLocalSkillSummaries(input.skills ?? [])), input.supported === false ? 0 : 1, now, requestId],
      );
    } else {
      this.db.run(
        `UPDATE multiremi_runtime_local_skill_list_requests
         SET status = 'failed', error = ?, updated_at = ?
         WHERE id = ?`,
        [input.error ?? "runtime local skill list failed", now, requestId],
      );
    }
    return this.getRuntimeLocalSkillListRequest(runtimeId, requestId)!;
  }

  createRuntimeLocalSkillImportRequest(runtimeId: string, input: CreateRuntimeLocalSkillImportInput): MultiremiRuntimeLocalSkillImportRequest {
    const runtime = this.getRuntime(runtimeId);
    if (!runtime) throw new Error(`Runtime not found: ${runtimeId}`);
    if (runtime.status !== "online") throw new Error("runtime is offline");
    const skillKey = String(input.skillKey ?? input.skill_key ?? "").trim();
    if (!skillKey) throw new Error("skill_key is required");
    const id = createId("rli");
    const now = nowIso();
    this.db.run(
      `INSERT INTO multiremi_runtime_local_skill_import_requests (
        id, runtime_id, skill_key, name, description, status, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [
        id,
        runtimeId,
        skillKey,
        cleanOptionalLocalSkillString(input.name),
        cleanOptionalLocalSkillString(input.description),
        input.createdBy ?? input.created_by ?? null,
        now,
        now,
      ],
    );
    return this.getRuntimeLocalSkillImportRequest(runtimeId, id)!;
  }

  getRuntimeLocalSkillImportRequest(runtimeId: string, requestId: string): MultiremiRuntimeLocalSkillImportRequest | null {
    this.expireRuntimeLocalSkillImportRequests(runtimeId);
    const row = this.db.query(
      "SELECT * FROM multiremi_runtime_local_skill_import_requests WHERE id = ? AND runtime_id = ?",
    ).get(requestId, runtimeId) as Row | null;
    return row ? this.hydrateRuntimeLocalSkillImportRequest(toRuntimeLocalSkillImportRequest(row)) : null;
  }

  claimRuntimeLocalSkillImportRequests(runtimeId: string, limit = 10): MultiremiRuntimeLocalSkillImportRequest[] {
    this.expireRuntimeLocalSkillImportRequests(runtimeId);
    const rows = this.db.query(
      `SELECT * FROM multiremi_runtime_local_skill_import_requests
       WHERE runtime_id = ? AND status = 'pending'
       ORDER BY created_at ASC
       LIMIT ?`,
    ).all(runtimeId, Math.max(1, Math.floor(limit))) as Row[];
    if (!rows.length) return [];
    const now = nowIso();
    for (const row of rows) {
      this.db.run(
        "UPDATE multiremi_runtime_local_skill_import_requests SET status = 'running', run_started_at = ?, updated_at = ? WHERE id = ?",
        [now, now, String(row.id)],
      );
    }
    return rows.map((row) => this.getRuntimeLocalSkillImportRequest(runtimeId, String(row.id))!).filter(Boolean);
  }

  private expireRuntimeLocalSkillImportRequests(runtimeId: string): void {
    const now = nowIso();
    const pendingCutoff = new Date(Date.now() - RUNTIME_LOCAL_SKILL_PENDING_TIMEOUT_MS).toISOString();
    const runningCutoff = new Date(Date.now() - RUNTIME_LOCAL_SKILL_RUNNING_TIMEOUT_MS).toISOString();
    this.db.run(
      `UPDATE multiremi_runtime_local_skill_import_requests
       SET status = 'timeout', error = 'daemon did not respond within 3 minutes', updated_at = ?
       WHERE runtime_id = ? AND status = 'pending' AND created_at < ?`,
      [now, runtimeId, pendingCutoff],
    );
    this.db.run(
      `UPDATE multiremi_runtime_local_skill_import_requests
       SET status = 'timeout', error = 'daemon did not finish within 60 seconds', updated_at = ?
       WHERE runtime_id = ? AND status = 'running' AND run_started_at IS NOT NULL AND run_started_at < ?`,
      [now, runtimeId, runningCutoff],
    );
  }

  reportRuntimeLocalSkillImportResult(runtimeId: string, requestId: string, input: ReportRuntimeLocalSkillImportInput): MultiremiRuntimeLocalSkillImportRequest {
    const current = this.getRuntimeLocalSkillImportRequest(runtimeId, requestId);
    if (!current) throw new Error("request not found");
    if (isTerminalRuntimeRequestStatus(current.status)) return current;
    const status = normalizeRuntimeLocalSkillStatus(input.status);
    const now = nowIso();
    if (status !== "completed") {
      this.db.run(
        "UPDATE multiremi_runtime_local_skill_import_requests SET status = 'failed', error = ?, updated_at = ? WHERE id = ?",
        [input.error ?? "runtime local skill import failed", now, requestId],
      );
      return this.getRuntimeLocalSkillImportRequest(runtimeId, requestId)!;
    }
    if (!input.skill) {
      this.db.run(
        "UPDATE multiremi_runtime_local_skill_import_requests SET status = 'failed', error = ?, updated_at = ? WHERE id = ?",
        ["daemon returned an empty skill bundle", now, requestId],
      );
      return this.getRuntimeLocalSkillImportRequest(runtimeId, requestId)!;
    }
    const skillName = cleanOptionalLocalSkillString(current.name) ?? String(input.skill.name ?? current.skillKey).trim();
    const description = cleanOptionalLocalSkillString(current.description) ?? String(input.skill.description ?? "");
    const runtime = this.getRuntime(runtimeId);
    const skill = this.createSkill({
      workspaceId: runtime?.workspaceId ?? "local",
      name: skillName,
      description,
      content: input.skill.content ?? "",
      createdBy: current.createdBy,
      files: input.skill.files ?? [],
      config: {
        origin: {
          type: "runtime_local",
          runtime_id: runtimeId,
          provider: input.skill.provider ?? runtime?.provider ?? "unknown",
          source_path: input.skill.sourcePath ?? input.skill.source_path ?? "",
        },
      },
    });
    const skillId = skill.id ?? "";
    this.db.run(
      `UPDATE multiremi_runtime_local_skill_import_requests
       SET status = 'completed', skill_id = ?, skill = ?, error = NULL, updated_at = ?
       WHERE id = ?`,
      [skillId, toJson(skill), now, requestId],
    );
    return this.getRuntimeLocalSkillImportRequest(runtimeId, requestId)!;
  }

  listRuntimeUsage(runtimeId?: string | null): MultiremiRuntimeUsage[] {
    if (runtimeId !== undefined && runtimeId !== null && !this.getRuntime(runtimeId)) {
      throw new Error(`Runtime not found: ${runtimeId}`);
    }
    const rows = runtimeId === undefined
      ? this.db.query("SELECT id, runtime_id, usage FROM multiremi_tasks WHERE runtime_id IS NOT NULL").all() as Row[]
      : runtimeId === null
        ? this.db.query("SELECT id, runtime_id, usage FROM multiremi_tasks WHERE runtime_id IS NULL").all() as Row[]
        : this.db.query("SELECT id, runtime_id, usage FROM multiremi_tasks WHERE runtime_id = ?").all(runtimeId) as Row[];
    const usage = new Map<string, MultiremiRuntimeUsage & { taskIds: Set<string> }>();
    for (const row of rows) {
      const rowRuntimeId = nullableString(row.runtime_id);
      for (const entry of parseTaskUsageEntries(row.usage)) {
        const key = [rowRuntimeId ?? "", entry.provider, entry.model].join("\u0000");
        const current = usage.get(key) ?? {
          runtimeId: rowRuntimeId,
          provider: entry.provider,
          model: entry.model,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          taskCount: 0,
          taskIds: new Set<string>(),
        };
        current.inputTokens += entry.inputTokens;
        current.outputTokens += entry.outputTokens;
        current.cacheReadTokens += entry.cacheReadTokens;
        current.cacheWriteTokens += entry.cacheWriteTokens;
        current.taskIds.add(String(row.id));
        usage.set(key, current);
      }
    }
    return [...usage.values()]
      .map(({ taskIds, ...entry }) => ({ ...entry, taskCount: taskIds.size }))
      .sort((left, right) =>
        (right.inputTokens + right.outputTokens + right.cacheReadTokens + right.cacheWriteTokens) -
        (left.inputTokens + left.outputTokens + left.cacheReadTokens + left.cacheWriteTokens) ||
        left.provider.localeCompare(right.provider) ||
        left.model.localeCompare(right.model),
      );
  }

  listUsageDaily(input: {
    workspaceId?: string | null;
    projectId?: string | null;
    runtimeId?: string | null;
    days?: number;
  } = {}): MultiremiUsageDaily[] {
    const rows = this.filteredUsageTaskRows(input);
    const buckets = new Map<string, MultiremiUsageDaily & { taskIds: Set<string> }>();
    for (const row of rows) {
      const date = usageDate(row);
      for (const entry of parseTaskUsageEntries(row.usage)) {
        const key = [date, nullableString(row.runtime_id) ?? "", entry.provider, entry.model].join("\u0000");
        const current = buckets.get(key) ?? {
          date,
          runtimeId: nullableString(row.runtime_id),
          provider: entry.provider,
          model: entry.model,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          taskCount: 0,
          taskIds: new Set<string>(),
        };
        addUsageTotals(current, entry);
        current.taskIds.add(String(row.id));
        buckets.set(key, current);
      }
    }
    return [...buckets.values()]
      .map(({ taskIds, ...row }) => ({ ...row, taskCount: taskIds.size }))
      .sort((left, right) => left.date.localeCompare(right.date) || left.model.localeCompare(right.model));
  }

  listUsageByAgent(input: {
    workspaceId?: string | null;
    projectId?: string | null;
    runtimeId?: string | null;
    days?: number;
  } = {}): MultiremiUsageByAgent[] {
    const rows = this.filteredUsageTaskRows(input);
    const buckets = new Map<string, MultiremiUsageByAgent & { taskIds: Set<string> }>();
    for (const row of rows) {
      const agentId = String(row.agent_id);
      for (const entry of parseTaskUsageEntries(row.usage)) {
        const key = [agentId, entry.model].join("\u0000");
        const current = buckets.get(key) ?? {
          agentId,
          model: entry.model,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          taskCount: 0,
          taskIds: new Set<string>(),
        };
        addUsageTotals(current, entry);
        current.taskIds.add(String(row.id));
        buckets.set(key, current);
      }
    }
    return [...buckets.values()]
      .map(({ taskIds, ...row }) => ({ ...row, taskCount: taskIds.size }))
      .sort((left, right) =>
        (right.inputTokens + right.outputTokens + right.cacheReadTokens + right.cacheWriteTokens) -
        (left.inputTokens + left.outputTokens + left.cacheReadTokens + left.cacheWriteTokens) ||
        left.agentId.localeCompare(right.agentId) ||
        left.model.localeCompare(right.model),
      );
  }

  listUsageByHour(input: {
    workspaceId?: string | null;
    projectId?: string | null;
    runtimeId?: string | null;
    days?: number;
  } = {}): MultiremiUsageByHour[] {
    const rows = this.filteredUsageTaskRows(input);
    const buckets = new Map<string, MultiremiUsageByHour & { taskIds: Set<string> }>();
    for (const row of rows) {
      const hour = usageHour(row);
      for (const entry of parseTaskUsageEntries(row.usage)) {
        const key = [hour, entry.model].join("\u0000");
        const current = buckets.get(key) ?? {
          hour,
          model: entry.model,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          taskCount: 0,
          taskIds: new Set<string>(),
        };
        addUsageTotals(current, entry);
        current.taskIds.add(String(row.id));
        buckets.set(key, current);
      }
    }
    return [...buckets.values()]
      .map(({ taskIds, ...row }) => ({ ...row, taskCount: taskIds.size }))
      .sort((left, right) => left.hour - right.hour || left.model.localeCompare(right.model));
  }

  listTaskActivityByHour(input: {
    workspaceId?: string | null;
    projectId?: string | null;
    runtimeId?: string | null;
    days?: number;
  } = {}): MultiremiTaskActivityByHour[] {
    const rows = this.filteredUsageTaskRows(input, { includeTasksWithoutUsage: true });
    const counts = new Map<number, number>();
    for (const row of rows) {
      const hour = usageHour(row);
      counts.set(hour, (counts.get(hour) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([hour, count]) => ({ hour, count }))
      .sort((left, right) => left.hour - right.hour);
  }

  listRuntimeDaily(input: {
    workspaceId?: string | null;
    projectId?: string | null;
    runtimeId?: string | null;
    days?: number;
  } = {}): MultiremiRuntimeDaily[] {
    const rows = this.filteredUsageTaskRows(input, { includeTasksWithoutUsage: true });
    const buckets = new Map<string, MultiremiRuntimeDaily>();
    for (const row of rows) {
      const date = usageDate(row);
      const current = buckets.get(date) ?? { date, totalSeconds: 0, taskCount: 0, failedCount: 0 };
      current.taskCount += 1;
      if (String(row.status ?? "") === "failed") current.failedCount += 1;
      current.totalSeconds += taskRunSeconds(row);
      buckets.set(date, current);
    }
    return [...buckets.values()].sort((left, right) => left.date.localeCompare(right.date));
  }

  heartbeatRuntime(runtimeId: string, options: { claimPending?: boolean; supportsBatchImport?: boolean; supportsDirectoryScan?: boolean } = {}): MultiremiDaemonHeartbeatAck {
    const runtime = this.getRuntime(runtimeId);
    if (!runtime) {
      return { runtime_id: runtimeId, status: "runtime_gone", runtime_gone: true };
    }
    const now = nowIso();
    this.db.run(
      "UPDATE multiremi_runtimes SET status = 'online', last_heartbeat_at = ?, updated_at = ? WHERE id = ?",
      [now, now, runtimeId],
    );
    const ack: MultiremiDaemonHeartbeatAck = { runtime_id: runtimeId, status: "ok" };
    if (options.claimPending === false) return ack;

    const pendingUpdate = this.claimRuntimeUpdateRequest(runtimeId);
    if (pendingUpdate) {
      ack.pending_update = {
        id: pendingUpdate.id,
        target_version: pendingUpdate.targetVersion,
        scope: pendingUpdate.scope,
      };
    }
    const pendingModelList = this.claimRuntimeModelListRequest(runtimeId);
    if (pendingModelList) {
      ack.pending_model_list = { id: pendingModelList.id };
    }
    const pendingLocalSkills = this.claimRuntimeLocalSkillListRequest(runtimeId);
    if (pendingLocalSkills) {
      ack.pending_local_skills = { id: pendingLocalSkills.id };
    }
    if (options.supportsDirectoryScan) {
      const pendingDirectoryScan = this.claimRuntimeDirectoryScanRequest(runtimeId);
      if (pendingDirectoryScan) {
        ack.pending_directory_scan = {
          id: pendingDirectoryScan.id,
          root: pendingDirectoryScan.params.root,
          max_depth: pendingDirectoryScan.params.maxDepth,
          mode: pendingDirectoryScan.params.mode,
        };
      }
    }
    const importLimit = options.supportsBatchImport ? 10 : 1;
    const pendingImports = this.claimRuntimeLocalSkillImportRequests(runtimeId, importLimit);
    if (pendingImports.length > 0) {
      ack.pending_local_skill_import = {
        id: pendingImports[0].id,
        skill_key: pendingImports[0].skillKey,
      };
      if (options.supportsBatchImport) {
        ack.pending_local_skill_imports = pendingImports.map((request) => ({
          id: request.id,
          skill_key: request.skillKey,
        }));
      }
    }
    return ack;
  }

  createIssue(input: CreateIssueInput): MultiremiIssue {
    const parentIssueId = input.parentIssueId ?? input.parent_issue_id ?? null;
    const explicitWorkspaceId = input.workspaceId ?? input.workspace_id ?? null;
    const workspaceId = explicitWorkspaceId ?? "local";
    const parent = parentIssueId ? this.getIssue(parentIssueId) : null;
    if (parentIssueId && !parent) throw new Error(`Parent issue not found: ${parentIssueId}`);
    if (parent && parent.workspaceId !== workspaceId) throw new Error("Parent issue belongs to another workspace");

    const projectId = input.projectId ?? input.project_id ?? (parent ? parent.projectId : null);
    if (projectId) {
      const project = this.getProject(projectId);
      if (!project) throw new Error(`Project not found: ${projectId}`);
      if (project.workspaceId !== workspaceId) throw new Error("Project belongs to another workspace");
    }

    let assigneeType = input.assigneeType ?? input.assignee_type ?? null;
    let assigneeId = input.assigneeId ?? input.assignee_id ?? null;
    if (assigneeType || assigneeId) {
      const resolvedAssignee = this.resolveAssigneeRef(assigneeType, assigneeId, workspaceId);
      assigneeType = resolvedAssignee?.assigneeType ?? null;
      assigneeId = resolvedAssignee?.assigneeId ?? null;
      this.validateIssueAssignee(assigneeType, assigneeId);
    }
    const id = input.id ?? createId("iss");
    const now = nowIso();
    const issueNumber = this.nextIssueNumber(workspaceId);
    const issueKey = formatIssueKey(issueNumber);
    const priority = normalizeIssuePriority(input.priority);
    const position = normalizeIssuePosition(input.position);
    const startDate = normalizeIssueDate(input.startDate ?? input.start_date ?? null, "start_date");
    const dueDate = normalizeIssueDate(input.dueDate ?? input.due_date ?? null, "due_date");
    const acceptanceCriteria = normalizeJsonArray(input.acceptanceCriteria ?? input.acceptance_criteria ?? []);
    const contextRefs = normalizeJsonArray(input.contextRefs ?? input.context_refs ?? []);
    const createdBy = input.createdBy ?? input.created_by ?? null;
    this.db.run(
      `INSERT INTO multiremi_issues (
        id, issue_number, issue_key, title, description, status, priority, workspace_id, project_id,
        parent_issue_id, assignee_type, assignee_id, position, start_date, due_date,
        acceptance_criteria, context_refs, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        issueNumber,
        issueKey,
        input.title,
        input.description ?? null,
        normalizeIssueStatus(input.status),
        priority,
        workspaceId,
        projectId,
        parentIssueId,
        assigneeType,
        assigneeId,
        position,
        startDate,
        dueDate,
        toJson(acceptanceCriteria),
        toJson(contextRefs),
        createdBy,
        now,
        now,
      ],
    );
    if (projectId) {
      this.db.run("UPDATE multiremi_projects SET updated_at = ? WHERE id = ?", [now, projectId]);
    }
    this.appendIssueActivity(id, {
      actorType: "system",
      actorId: createdBy,
      type: "issue_created",
      body: input.title,
      data: { projectId, parentIssueId, priority, startDate, dueDate },
    });
    if (createdBy) {
      const creator = this.findWorkspaceMemberForUser(createdBy, workspaceId);
      if (creator) this.addIssueSubscriber(id, creator.id, "created");
    }
    return this.getIssue(id)!;
  }

  getIssue(id: string): MultiremiIssue | null {
    const row = this.db.query("SELECT * FROM multiremi_issues WHERE id = ?").get(id) as Row | null;
    return row ? this.hydrateIssue(toIssue(row)) : null;
  }

  getIssueByRef(ref: string, workspaceId?: string | null): MultiremiIssue | null {
    const value = ref.trim();
    if (!value) return null;
    const exact = this.getIssue(value);
    if (exact && (!workspaceId || exact.workspaceId === workspaceId)) return exact;

    const rows: Row[] = [];
    const seen = new Set<string>();
    const addRows = (queryRows: Row[]) => {
      for (const row of queryRows) {
        const id = String(row.id);
        if (seen.has(id)) continue;
        seen.add(id);
        rows.push(row);
      }
    };
    const workspaceFilter = workspaceId ? " AND workspace_id = ?" : "";
    const workspaceParams = workspaceId ? [workspaceId] : [];
    addRows(this.db.query(`SELECT * FROM multiremi_issues WHERE lower(issue_key) = lower(?)${workspaceFilter}`).all(value, ...workspaceParams) as Row[]);
    if (/^\d+$/.test(value)) {
      addRows(this.db.query(`SELECT * FROM multiremi_issues WHERE issue_number = ?${workspaceFilter}`).all(Number(value), ...workspaceParams) as Row[]);
    }
    if (/^iss_[a-z0-9_]+$/i.test(value)) {
      addRows(this.db.query(`SELECT * FROM multiremi_issues WHERE id LIKE ?${workspaceFilter} ORDER BY created_at ASC`).all(`${value}%`, ...workspaceParams) as Row[]);
    }
    if (rows.length === 1) return this.hydrateIssue(toIssue(rows[0]!));
    if (!workspaceId && rows.length > 1) {
      const localRows = rows.filter((row) => String(row.workspace_id ?? "local") === "local");
      if (localRows.length === 1) return this.hydrateIssue(toIssue(localRows[0]!));
    }
    return null;
  }

  getIssueWithTasks(id: string): MultiremiIssueWithTasks | null {
    const issue = this.getIssue(id);
    if (!issue) return null;
    return {
      ...issue,
      tasks: this.listTasksForIssue(id),
      reactions: this.listIssueReactions(id),
      attachments: this.listAttachmentsForIssue(id),
      children: this.listChildIssues(id),
      childProgress: this.getChildIssueProgress(id),
      dependencies: this.listIssueDependencies(id),
    };
  }

  listIssues(input: ListIssuesInput = {}): MultiremiIssue[] {
    const { where, params } = buildIssueListWhere(input);
    const offset = normalizeListOffset(input.offset);
    const limit = input.limit === undefined ? Number.POSITIVE_INFINITY : normalizeListLimit(input.limit);
    // Metadata is a JSON column filtered in JS; when it (or an unbounded limit) is present we can't
    // safely push LIMIT/OFFSET into SQL, so we narrow the rows in SQL and paginate afterward.
    const hasMetadata = Boolean(input.metadata) && Object.keys(input.metadata!).length > 0;

    if (!hasMetadata && Number.isFinite(limit)) {
      const rows = this.db
        .query(`SELECT * FROM multiremi_issues ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset) as Row[];
      return this.hydrateIssues(rows.map((row) => toIssue(row)));
    }

    const rows = this.db
      .query(`SELECT * FROM multiremi_issues ${where} ORDER BY updated_at DESC`)
      .all(...params) as Row[];
    const issues = rows
      .map((row) => toIssue(row))
      .filter((issue) => issueMatchesListFilter(issue, input))
      .slice(offset, offset + limit);
    return this.hydrateIssues(issues);
  }

  listGroupedIssues(input: ListIssuesInput = {}): { groups: MultiremiIssueAssigneeGroup[] } {
    const limit = normalizeListLimit(input.limit, 50, 100);
    const offset = normalizeListOffset(input.offset);
    const issues = this.listIssues({ ...input, limit: undefined, offset: undefined })
      .sort((left, right) => {
        const typeRank = assigneeGroupRank(left.assigneeType) - assigneeGroupRank(right.assigneeType);
        if (typeRank !== 0) return typeRank;
        return String(left.assigneeId ?? "").localeCompare(String(right.assigneeId ?? ""))
          || left.position - right.position
          || Date.parse(right.createdAt) - Date.parse(left.createdAt);
      });
    const groups = new Map<string, MultiremiIssueAssigneeGroup>();
    for (const issue of issues) {
      const id = assigneeGroupId(issue.assigneeType, issue.assigneeId);
      const group = groups.get(id) ?? {
        id,
        assigneeType: issue.assigneeType,
        assigneeId: issue.assigneeId,
        issues: [],
        total: 0,
      };
      group.total += 1;
      if (group.total > offset && group.issues.length < limit) group.issues.push(issue);
      groups.set(id, group);
    }
    return { groups: [...groups.values()] };
  }

  listAssigneeFrequency(input: {
    workspaceId?: string | null;
    actorId?: string | null;
    actor_id?: string | null;
    memberId?: string | null;
    member_id?: string | null;
    userId?: string | null;
    user_id?: string | null;
  } = {}): MultiremiAssigneeFrequencyEntry[] {
    const workspaceId = input.workspaceId ?? "local";
    const actorId = input.actorId ?? input.actor_id ?? input.memberId ?? input.member_id ?? input.userId ?? input.user_id ?? null;
    const frequency = new Map<string, { assigneeType: MultiremiAssigneeType; assigneeId: string; frequency: number }>();
    const add = (assigneeType: unknown, assigneeId: unknown, count = 1) => {
      const type = nullableString(assigneeType) as MultiremiAssigneeType | null;
      const id = nullableString(assigneeId);
      if (!type || !id) return;
      if (type !== "agent" && type !== "member" && type !== "squad") return;
      const key = `${type}:${id}`;
      const current = frequency.get(key) ?? { assigneeType: type, assigneeId: id, frequency: 0 };
      current.frequency += count;
      frequency.set(key, current);
    };

    const issueRows = actorId
      ? this.db.query(`
          SELECT assignee_type, assignee_id, COUNT(*) AS frequency
          FROM multiremi_issues
          WHERE workspace_id = ? AND created_by = ? AND assignee_type IS NOT NULL AND assignee_id IS NOT NULL
          GROUP BY assignee_type, assignee_id
        `).all(workspaceId, actorId) as Row[]
      : this.db.query(`
          SELECT assignee_type, assignee_id, COUNT(*) AS frequency
          FROM multiremi_issues
          WHERE workspace_id = ? AND assignee_type IS NOT NULL AND assignee_id IS NOT NULL
          GROUP BY assignee_type, assignee_id
        `).all(workspaceId) as Row[];
    for (const row of issueRows) add(row.assignee_type, row.assignee_id, Number(row.frequency ?? 0));

    const activityRows = actorId
      ? this.db.query(`
          SELECT a.data
          FROM multiremi_issue_activity a
          JOIN multiremi_issues i ON i.id = a.issue_id
          WHERE i.workspace_id = ? AND a.actor_type = 'member' AND a.actor_id = ?
            AND a.type IN ('assignee_changed', 'issue_assigned')
        `).all(workspaceId, actorId) as Row[]
      : this.db.query(`
          SELECT a.data
          FROM multiremi_issue_activity a
          JOIN multiremi_issues i ON i.id = a.issue_id
          WHERE i.workspace_id = ? AND a.type IN ('assignee_changed', 'issue_assigned')
        `).all(workspaceId) as Row[];
    for (const row of activityRows) {
      const data = parseJson<Record<string, unknown>>(row.data, {});
      add(data.to_type ?? data.toType ?? data.assignee_type ?? data.assigneeType, data.to_id ?? data.toId ?? data.assignee_id ?? data.assigneeId);
    }

    return [...frequency.values()]
      .map((entry) => ({
        assigneeType: entry.assigneeType,
        assignee_type: entry.assigneeType,
        assigneeId: entry.assigneeId,
        assignee_id: entry.assigneeId,
        frequency: entry.frequency,
      }))
      .sort((left, right) => right.frequency - left.frequency || left.assigneeType.localeCompare(right.assigneeType) || left.assigneeId.localeCompare(right.assigneeId));
  }

  batchUpdateIssues(input: BatchUpdateIssuesInput): { updated: number; issues: MultiremiIssue[] } {
    const issueIds = input.issueIds ?? input.issue_ids ?? [];
    const updates = input.updates ?? {};
    if (issueIds.length === 0) throw new Error("issue_ids is required");
    if (!hasIssueMutation(updates)) return { updated: 0, issues: [] };
    const issues: MultiremiIssue[] = [];
    for (const issueId of issueIds) {
      try {
        issues.push(this.updateIssue(issueId, updates));
      } catch {
        // Match Multiremi's batch behavior: skip invalid or inaccessible rows.
      }
    }
    return { updated: issues.length, issues };
  }

  deleteIssue(id: string): boolean {
    const issue = this.getIssue(id);
    if (!issue) return false;
    this.db.transaction(() => {
      this.cancelActiveIssueTasks(id, "issue_deleted");
      this.db.run("UPDATE multiremi_autopilot_runs SET status = 'failed', completed_at = ?, failure_reason = ? WHERE issue_id = ? AND completed_at IS NULL", [
        nowIso(),
        "issue deleted",
        id,
      ]);
      this.db.run("UPDATE multiremi_autopilot_runs SET issue_id = NULL WHERE issue_id = ?", [id]);
      this.db.run("DELETE FROM multiremi_issues WHERE id = ?", [id]);
      if (issue.projectId) this.db.run("UPDATE multiremi_projects SET updated_at = ? WHERE id = ?", [nowIso(), issue.projectId]);
    })();
    return true;
  }

  batchDeleteIssues(input: BatchDeleteIssuesInput): { deleted: number } {
    const issueIds = input.issueIds ?? input.issue_ids ?? [];
    if (issueIds.length === 0) throw new Error("issue_ids is required");
    let deleted = 0;
    for (const issueId of issueIds) {
      if (this.deleteIssue(issueId)) deleted += 1;
    }
    return { deleted };
  }

  searchIssues(input: { q: string; workspaceId?: string | null; includeClosed?: boolean; limit?: number; offset?: number }): { issues: MultiremiIssueSearchResult[]; total: number } {
    const query = normalizeSearchQuery(input.q);
    if (!query) throw new Error("q parameter is required");
    const workspaceId = input.workspaceId ?? "local";
    const includeClosed = Boolean(input.includeClosed);
    const limit = clampSearchLimit(input.limit);
    const offset = Math.max(0, Number(input.offset ?? 0));
    const rows = this.listIssues().map((issue) => ({
      issue,
      matchedCommentSnippet: this.searchIssueCommentSnippet(issue.id, query),
    })).filter(({ issue, matchedCommentSnippet }) => {
      if (issue.workspaceId !== workspaceId) return false;
      if (!includeClosed && CLOSED_ISSUE_STATUSES.has(issue.status)) return false;
      return searchMatch(issue.key, query)
        || searchMatch(issue.title, query)
        || searchMatch(issue.description ?? "", query)
        || matchedCommentSnippet !== null;
    }).map(({ issue, matchedCommentSnippet }) => {
      const matchSource = searchMatch(issue.key, query)
        ? "key"
        : searchMatch(issue.title, query)
          ? "title"
          : searchMatch(issue.description ?? "", query)
            ? "description"
            : "comment";
      const result: MultiremiIssueSearchResult = {
        ...issue,
        matchSource,
      };
      if (matchSource === "description" && issue.description) result.matchedDescriptionSnippet = extractSearchSnippet(issue.description, query);
      if (matchedCommentSnippet !== null) {
        result.matchedCommentSnippet = matchedCommentSnippet;
        if (matchSource === "comment") result.matchedSnippet = matchedCommentSnippet;
      }
      return result;
    }).sort((left, right) => searchRank(left.matchSource) - searchRank(right.matchSource) || Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    return { issues: rows.slice(offset, offset + limit), total: rows.length };
  }

  private searchIssueCommentSnippet(issueId: string, query: string): string | null {
    const rows = this.db.query(
      "SELECT body FROM multiremi_issue_comments WHERE issue_id = ? ORDER BY created_at DESC",
    ).all(issueId) as Row[];
    const match = rows.find((row) => searchMatch(String(row.body ?? ""), query));
    return match ? extractSearchSnippet(String(match.body ?? ""), query) : null;
  }

  listTasksForIssue(issueId: string): MultiremiTask[] {
    const rows = this.db.query(
      "SELECT * FROM multiremi_tasks WHERE issue_id = ? ORDER BY created_at DESC",
    ).all(issueId) as Row[];
    return rows.map(toTask);
  }

  listChildIssues(parentIssueId: string): MultiremiIssue[] {
    const parent = this.getIssue(parentIssueId);
    if (!parent) throw new Error(`Issue not found: ${parentIssueId}`);
    const rows = this.db.query(
      "SELECT * FROM multiremi_issues WHERE parent_issue_id = ? ORDER BY position ASC, created_at DESC",
    ).all(parentIssueId) as Row[];
    return rows.map((row) => this.hydrateIssue(toIssue(row)));
  }

  listChildIssueProgress(workspaceId = "local"): MultiremiIssueChildProgress[] {
    const rows = this.db.query(
      `SELECT parent_issue_id, COUNT(*) AS total,
              SUM(CASE WHEN status IN ('done', 'completed', 'closed', 'cancelled') THEN 1 ELSE 0 END) AS done
       FROM multiremi_issues
       WHERE workspace_id = ? AND parent_issue_id IS NOT NULL
       GROUP BY parent_issue_id
       ORDER BY parent_issue_id ASC`,
    ).all(workspaceId) as Row[];
    return rows.map(toChildIssueProgress);
  }

  getChildIssueProgress(parentIssueId: string): MultiremiIssueChildProgress {
    const row = this.db.query(
      `SELECT parent_issue_id, COUNT(*) AS total,
              SUM(CASE WHEN status IN ('done', 'completed', 'closed', 'cancelled') THEN 1 ELSE 0 END) AS done
       FROM multiremi_issues
       WHERE parent_issue_id = ?
       GROUP BY parent_issue_id`,
    ).get(parentIssueId) as Row | null;
    return row ? toChildIssueProgress(row) : { parentIssueId, total: 0, done: 0 };
  }

  listIssueDependencies(issueId: string): MultiremiIssueDependency[] {
    if (!this.getIssue(issueId)) throw new Error(`Issue not found: ${issueId}`);
    const rows = this.db.query(
      `SELECT * FROM multiremi_issue_dependencies
       WHERE issue_id = ? OR depends_on_issue_id = ?
       ORDER BY created_at ASC`,
    ).all(issueId, issueId) as Row[];
    return rows.map((row) => this.hydrateIssueDependency(toIssueDependency(row)));
  }

  createIssueDependency(issueId: string, input: CreateIssueDependencyInput): MultiremiIssueDependency {
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const dependsOnIssueId = input.dependsOnIssueId ?? input.depends_on_issue_id ?? "";
    const dependsOnIssue = this.getIssue(dependsOnIssueId);
    if (!dependsOnIssue) throw new Error(`Dependent issue not found: ${dependsOnIssueId}`);
    if (issue.id === dependsOnIssue.id) throw new Error("An issue cannot depend on itself");
    if (issue.workspaceId !== dependsOnIssue.workspaceId) throw new Error("Issue dependency must stay within a workspace");
    const type = normalizeIssueDependencyType(input.type);
    const id = input.id ?? createId("dep");
    const now = nowIso();
    const existing = this.db.query(
      `SELECT * FROM multiremi_issue_dependencies
       WHERE issue_id = ? AND depends_on_issue_id = ? AND type = ?`,
    ).get(issue.id, dependsOnIssue.id, type) as Row | null;
    if (existing) return this.hydrateIssueDependency(toIssueDependency(existing));
    this.db.run(
      `INSERT INTO multiremi_issue_dependencies (
        id, workspace_id, issue_id, depends_on_issue_id, type, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, issue.workspaceId, issue.id, dependsOnIssue.id, type, now],
    );
    this.appendIssueActivity(issue.id, {
      actorType: "system",
      actorId: null,
      type: "issue_dependency_added",
      body: `${type} ${dependsOnIssue.key}`,
      data: { dependencyId: id, dependsOnIssueId: dependsOnIssue.id, type },
    });
    return this.getIssueDependency(id)!;
  }

  getIssueDependency(id: string): MultiremiIssueDependency | null {
    const row = this.db.query("SELECT * FROM multiremi_issue_dependencies WHERE id = ?").get(id) as Row | null;
    return row ? this.hydrateIssueDependency(toIssueDependency(row)) : null;
  }

  deleteIssueDependency(issueId: string, dependencyId: string): void {
    const dependency = this.getIssueDependency(dependencyId);
    if (!dependency) return;
    if (dependency.issueId !== issueId && dependency.dependsOnIssueId !== issueId) {
      throw new Error(`Dependency not found for issue: ${issueId}`);
    }
    this.db.run("DELETE FROM multiremi_issue_dependencies WHERE id = ?", [dependencyId]);
    this.appendIssueActivity(issueId, {
      actorType: "system",
      actorId: null,
      type: "issue_dependency_removed",
      body: dependency.type,
      data: { dependencyId, issueId: dependency.issueId, dependsOnIssueId: dependency.dependsOnIssueId, type: dependency.type },
    });
  }

  updateIssue(id: string, input: UpdateIssueInput): MultiremiIssue {
    const current = this.getIssue(id);
    if (!current) throw new Error(`Issue not found: ${id}`);
    const nextWorkspaceId = resolveOptionalStringField(input, "workspaceId", "workspace_id", current.workspaceId) ?? "local";
    const nextProjectId = resolveOptionalStringField(input, "projectId", "project_id", current.projectId);
    const nextParentIssueId = resolveOptionalStringField(input, "parentIssueId", "parent_issue_id", current.parentIssueId);
    let nextAssigneeType = resolveOptionalStringField(input, "assigneeType", "assignee_type", current.assigneeType) as MultiremiAssigneeType | null;
    let nextAssigneeId = resolveOptionalStringField(input, "assigneeId", "assignee_id", current.assigneeId);
    const nextStartDate = hasAnyField(input, "startDate", "start_date")
      ? normalizeIssueDate(input.startDate ?? input.start_date ?? null, "start_date")
      : current.startDate;
    const nextDueDate = hasAnyField(input, "dueDate", "due_date")
      ? normalizeIssueDate(input.dueDate ?? input.due_date ?? null, "due_date")
      : current.dueDate;
    const nextAcceptanceCriteria = hasAnyField(input, "acceptanceCriteria", "acceptance_criteria")
      ? normalizeJsonArray(input.acceptanceCriteria ?? input.acceptance_criteria ?? [])
      : current.acceptanceCriteria;
    const nextContextRefs = hasAnyField(input, "contextRefs", "context_refs")
      ? normalizeJsonArray(input.contextRefs ?? input.context_refs ?? [])
      : current.contextRefs;

    if (nextProjectId) {
      const project = this.getProject(nextProjectId);
      if (!project) throw new Error(`Project not found: ${nextProjectId}`);
      if (project.workspaceId !== nextWorkspaceId) throw new Error("Project belongs to another workspace");
    }
    if (nextParentIssueId) {
      const parent = this.getIssue(nextParentIssueId);
      if (!parent) throw new Error(`Parent issue not found: ${nextParentIssueId}`);
      if (parent.workspaceId !== nextWorkspaceId) throw new Error("Parent issue belongs to another workspace");
      this.validateIssueParent(id, nextParentIssueId);
    }
    if (hasAnyField(input, "assigneeType", "assignee_type", "assigneeId", "assignee_id")) {
      const requestedAssigneeType = hasAnyField(input, "assigneeType", "assignee_type")
        ? resolveOptionalStringField(input, "assigneeType", "assignee_type", current.assigneeType) as MultiremiAssigneeType | null
        : hasAnyField(input, "assigneeId", "assignee_id")
          ? null
          : nextAssigneeType;
      const resolvedAssignee = this.resolveAssigneeRef(requestedAssigneeType, nextAssigneeId, nextWorkspaceId);
      nextAssigneeType = resolvedAssignee?.assigneeType ?? null;
      nextAssigneeId = resolvedAssignee?.assigneeId ?? null;
      this.validateIssueAssignee(nextAssigneeType, nextAssigneeId);
    }

    const now = nowIso();
    this.db.run(
      `UPDATE multiremi_issues SET
        title = ?,
        description = ?,
        status = ?,
        priority = ?,
        workspace_id = ?,
        project_id = ?,
        parent_issue_id = ?,
        assignee_type = ?,
        assignee_id = ?,
        position = ?,
        start_date = ?,
        due_date = ?,
        acceptance_criteria = ?,
        context_refs = ?,
        updated_at = ?
       WHERE id = ?`,
      [
        input.title ?? current.title,
        input.description === undefined ? current.description : input.description,
        hasAnyField(input, "status") ? normalizeIssueStatus(input.status) : current.status,
        normalizeIssuePriority(input.priority ?? current.priority),
        nextWorkspaceId,
        nextProjectId,
        nextParentIssueId,
        nextAssigneeType,
        nextAssigneeId,
        input.position === undefined || input.position === null ? current.position : normalizeIssuePosition(input.position),
        nextStartDate,
        nextDueDate,
        toJson(nextAcceptanceCriteria),
        toJson(nextContextRefs),
        now,
        id,
      ],
    );
    this.appendIssueActivity(id, {
      actorType: "system",
      actorId: null,
      type: "issue_updated",
      body: null,
      data: input,
    });
    if (current.projectId) this.db.run("UPDATE multiremi_projects SET updated_at = ? WHERE id = ?", [now, current.projectId]);
    if (nextProjectId) this.db.run("UPDATE multiremi_projects SET updated_at = ? WHERE id = ?", [now, nextProjectId]);
    const updated = this.getIssue(id)!;
    this.notifyParentOfChildDone(current, updated);
    return updated;
  }

  private notifyParentOfChildDone(previous: MultiremiIssue, issue: MultiremiIssue): void {
    if (!issue.parentIssueId) return;
    if (previous.status === "done" || issue.status !== "done") return;
    const parent = this.getIssue(issue.parentIssueId);
    if (!parent) return;
    if (parent.status === "done" || parent.status === "cancelled") return;
    if (parent.assigneeType === "member") return;

    const body = childDoneSystemCommentBody({
      mentionPrefix: this.parentAssigneeMentionPrefix(parent),
      childKey: issue.key,
      childId: issue.id,
      childTitle: issue.title,
    });
    const comment = this.createSystemIssueComment(parent.id, body, {
      type: "child_done_parent_notification",
      childIssueId: issue.id,
      child_issue_id: issue.id,
    });
    this.triggerParentAssigneeForChildDone(parent, issue, comment);
  }

  private parentAssigneeMentionPrefix(parent: MultiremiIssue): string {
    if (!parent.assigneeType || !parent.assigneeId) return "";
    if (parent.assigneeType === "agent") {
      const agent = this.getAgent(parent.assigneeId);
      if (!agent || agent.archivedAt || agent.workspaceId !== parent.workspaceId) return "";
      return `[@${sanitizeChildDoneMentionLabel(agent.name)}](mention://agent/${agent.id}) `;
    }
    if (parent.assigneeType === "squad") {
      const squad = this.getSquad(parent.assigneeId);
      if (!squad || squad.archivedAt || squad.workspaceId !== parent.workspaceId) return "";
      return `[@${sanitizeChildDoneMentionLabel(squad.name)}](mention://squad/${squad.id}) `;
    }
    return "";
  }

  private createSystemIssueComment(issueId: string, body: string, data: Record<string, unknown>): MultiremiIssueComment {
    const id = createId("cmt");
    const now = nowIso();
    this.db.run(
      `INSERT INTO multiremi_issue_comments (id, issue_id, author_type, author_id, parent_id, body, type, created_at, updated_at)
       VALUES (?, ?, 'system', ?, NULL, ?, 'system', ?, ?)`,
      [id, issueId, SYSTEM_AUTHOR_ID, body, now, now],
    );
    this.db.run("UPDATE multiremi_issues SET updated_at = ? WHERE id = ?", [now, issueId]);
    this.appendIssueActivity(issueId, {
      actorType: "system",
      actorId: SYSTEM_AUTHOR_ID,
      type: "comment_created",
      body,
      data: { commentId: id, comment_id: id, ...data },
    });
    return this.getIssueComment(id)!;
  }

  private triggerParentAssigneeForChildDone(parent: MultiremiIssue, child: MultiremiIssue, systemComment: MultiremiIssueComment): void {
    if (!parent.assigneeType || !parent.assigneeId) return;
    if (parent.assigneeType === "agent") {
      const agent = this.getAgent(parent.assigneeId);
      if (!agent || agent.archivedAt || agent.workspaceId !== parent.workspaceId) return;
      this.enqueueChildDoneParentTask(parent, agent, systemComment, parent.assigneeType, parent.assigneeId);
      return;
    }
    if (parent.assigneeType !== "squad") return;
    const squad = this.getSquad(parent.assigneeId);
    if (!squad || squad.archivedAt || squad.workspaceId !== parent.workspaceId || !squad.leaderId) return;
    if (childAssigneeIsSquad(child, squad.id)) return;
    if (this.effectiveChildAgentOwner(child) === squad.leaderId) return;
    const leader = this.getAgent(squad.leaderId);
    if (!leader || leader.archivedAt || leader.workspaceId !== parent.workspaceId) return;
    this.enqueueChildDoneParentTask(parent, leader, systemComment, parent.assigneeType, parent.assigneeId);
  }

  private enqueueChildDoneParentTask(
    parent: MultiremiIssue,
    agent: MultiremiAgent,
    systemComment: MultiremiIssueComment,
    assigneeType: MultiremiAssigneeType,
    assigneeId: string,
  ): void {
    if (this.hasActiveTaskForIssueAndAgent(parent.id, agent.id)) return;
    const task = this.createTask({
      agentId: agent.id,
      issueId: parent.id,
      triggerCommentId: systemComment.id,
      workspaceId: parent.workspaceId,
      prompt: childDoneParentTaskPrompt(systemComment),
    });
    this.appendIssueActivity(parent.id, {
      actorType: "system",
      actorId: SYSTEM_AUTHOR_ID,
      type: "child_done_parent_triggered",
      body: `Queued ${agent.name}`,
      data: {
        commentId: systemComment.id,
        comment_id: systemComment.id,
        assigneeType,
        assignee_type: assigneeType,
        assigneeId,
        assignee_id: assigneeId,
        agentId: agent.id,
        agent_id: agent.id,
        taskId: task.id,
        task_id: task.id,
      },
    });
  }

  private effectiveChildAgentOwner(child: MultiremiIssue): string | null {
    if (!child.assigneeType || !child.assigneeId) return null;
    if (child.assigneeType === "agent") return child.assigneeId;
    if (child.assigneeType !== "squad") return null;
    const squad = this.getSquad(child.assigneeId);
    return squad?.leaderId ?? null;
  }

  assignIssue(id: string, input: AssignIssueInput): AssignIssueResult {
    const current = this.getIssue(id);
    if (!current) throw new Error(`Issue not found: ${id}`);
    const requestedAssigneeType = input.assigneeType ?? input.assignee_type ?? null;
    const requestedAssigneeId = input.assigneeId ?? input.assignee_id ?? null;
    const actorType = input.actorType ?? input.actor_type ?? "system";
    const actorId = input.actorId ?? input.actor_id ?? null;
    const now = nowIso();

    if (requestedAssigneeType && !requestedAssigneeId) {
      throw new Error("Assignee id is required when assignee type is provided");
    }
    if (!requestedAssigneeType && !requestedAssigneeId) {
      const cancelled = this.cancelActiveIssueTasks(id, "issue_unassigned");
      this.db.run(
        "UPDATE multiremi_issues SET assignee_type = NULL, assignee_id = NULL, updated_at = ? WHERE id = ?",
        [now, id],
      );
      this.appendIssueActivity(id, {
        actorType,
        actorId,
        type: "issue_unassigned",
        body: null,
        data: { cancelled },
      });
      return { issue: this.getIssue(id)!, task: null };
    }

    // requestedAssigneeId is non-null here (the early-return above handled the
    // unassign case), so resolveAssigneeRef either returns a match or throws.
    const resolvedAssignee = this.resolveAssigneeRef(requestedAssigneeType, requestedAssigneeId, current.workspaceId)!;
    const assigneeType = resolvedAssignee.assigneeType;
    const assigneeId = resolvedAssignee.assigneeId;
    this.validateIssueAssignee(assigneeType, assigneeId);
    const taskAgent = assigneeType === "member" ? null : this.resolveRunnableAgentForAssignee(assigneeType, assigneeId);
    if (assigneeType !== "member" && !taskAgent) {
      throw new Error(`No runnable agent for ${assigneeType}: ${assigneeId}`);
    }
    const cancelled = this.cancelActiveIssueTasks(id, "issue_reassigned");
    this.db.run(
      `UPDATE multiremi_issues
       SET assignee_type = ?, assignee_id = ?, status = ?, updated_at = ?
       WHERE id = ?`,
      [
        assigneeType,
        assigneeId,
        taskAgent ? "in_progress" : current.status,
        now,
        id,
      ],
    );

    let task: MultiremiTask | null = null;
    if (taskAgent) {
      task = this.createTask({
        agentId: taskAgent.id,
        issueId: id,
        workspaceId: current.workspaceId,
        prompt: input.prompt?.trim() || current.title,
      });
    }
    if (assigneeType === "member") {
      this.addIssueSubscriber(id, assigneeId, "assigned");
      this.createInboxItem({
        issueId: id,
        memberId: assigneeId,
        type: "issue_assigned",
        title: `${current.key} assigned to you`,
        body: current.title,
        actorType: "system",
        actorId: null,
      });
    }

    this.appendIssueActivity(id, {
      actorType,
      actorId,
      type: "issue_assigned",
      body: taskAgent ? `Queued ${taskAgent.name}` : null,
      data: {
        assigneeType,
        assignee_type: assigneeType,
        assigneeId,
        assignee_id: assigneeId,
        toType: assigneeType,
        to_type: assigneeType,
        toId: assigneeId,
        to_id: assigneeId,
        taskId: task?.id ?? null,
        task_id: task?.id ?? null,
        cancelled,
      },
    });
    if (current.projectId) this.db.run("UPDATE multiremi_projects SET updated_at = ? WHERE id = ?", [now, current.projectId]);
    return { issue: this.getIssue(id)!, task };
  }

  quickCreateIssue(input: QuickCreateIssueInput): QuickCreateIssueResult {
    const prompt = input.prompt?.trim();
    if (!prompt) throw new Error("prompt is required");
    const agentId = input.agentId ?? input.agent_id ?? null;
    const squadId = input.squadId ?? input.squad_id ?? null;
    if (Boolean(agentId) === Boolean(squadId)) throw new Error("exactly one of agent_id or squad_id is required");

    const workspaceId = input.workspaceId ?? input.workspace_id ?? "local";
    const projectId = input.projectId ?? input.project_id ?? null;
    if (projectId) {
      const project = this.getProject(projectId);
      if (!project) throw new Error(`Project not found: ${projectId}`);
      if (project.workspaceId !== workspaceId) throw new Error("Project belongs to another workspace");
    }

    const requestedAssigneeType: MultiremiAssigneeType = squadId ? "squad" : "agent";
    const requestedAssigneeId = squadId ?? agentId!;
    const resolvedAssignee = this.resolveAssigneeRef(requestedAssigneeType, requestedAssigneeId, workspaceId);
    const assigneeType = resolvedAssignee?.assigneeType ?? requestedAssigneeType;
    const assigneeId = resolvedAssignee?.assigneeId ?? requestedAssigneeId;
    this.validateIssueAssignee(assigneeType, assigneeId);
    const taskAgent = this.resolveRunnableAgentForAssignee(assigneeType, assigneeId);
    if (!taskAgent) throw new Error(`No runnable agent for ${assigneeType}: ${assigneeId}`);

    const issue = this.createIssue({
      title: quickCreateTitle(prompt),
      description: prompt,
      workspaceId,
      projectId,
      assigneeType,
      assigneeId,
      status: "in_progress",
      createdBy: input.requesterId ?? input.requester_id ?? null,
      contextRefs: [{ type: "quick_create", prompt }],
    });
    const task = this.createTask({
      agentId: taskAgent.id,
      issueId: issue.id,
      workspaceId,
      prompt: quickCreateTaskPrompt(prompt, projectId),
    });
    this.appendIssueActivity(issue.id, {
      actorType: "system",
      actorId: input.requesterId ?? input.requester_id ?? null,
      type: "quick_create_queued",
      body: prompt,
      data: { taskId: task.id, assigneeType, assigneeId, projectId },
    });
    return { issue: this.getIssue(issue.id)!, task };
  }

  createIssueComment(issueId: string, input: CreateIssueCommentInput): MultiremiIssueComment {
    const rawBody = input.body ?? input.content ?? "";
    if (!rawBody.trim()) throw new Error("Comment body is required");
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const parentId = input.parentId ?? input.parent_id ?? null;
    if (parentId) {
      const parent = this.getIssueComment(parentId);
      if (!parent || parent.issueId !== issueId) throw new Error(`Parent comment not found: ${parentId}`);
    }
    const id = createId("cmt");
    const now = nowIso();
    const body = rawBody.trim();
    this.db.run(
      `INSERT INTO multiremi_issue_comments (id, issue_id, author_type, author_id, parent_id, body, type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, issueId, input.authorType ?? "member", input.authorId ?? null, parentId, body, "comment", now, now],
    );
    const attachmentIds = input.attachmentIds ?? input.attachment_ids ?? [];
    if (attachmentIds.length) this.linkAttachmentsToComment(id, issueId, attachmentIds);
    this.db.run("UPDATE multiremi_issues SET updated_at = ? WHERE id = ?", [now, issueId]);
    if (parentId) this.unresolveThreadRoot(parentId);
    const authorType = input.authorType ?? "member";
    if (authorType === "member" && input.authorId) {
      // authorId is a request user id, not a member row id — translate before
      // subscribing, and skip (rather than fail the comment) when the author
      // has no member row in this workspace.
      const authorMember = this.findWorkspaceMemberForUser(input.authorId, issue.workspaceId);
      if (authorMember) this.addIssueSubscriber(issueId, authorMember.id, "commented");
    }
    this.appendIssueActivity(issueId, {
      actorType: authorType,
      actorId: input.authorId ?? null,
      type: "comment_created",
      body,
      data: { commentId: id },
    });
    const comment = this.getIssueComment(id)!;
    const mentionedMemberIds = this.triggerMemberMentions(issue, comment);
    this.notifySubscribedMembers(issue, "comment_created", "New comment", body, authorType, input.authorId ?? null, mentionedMemberIds);
    this.triggerCommentMentions(issue, comment);
    return comment;
  }

  updateIssueComment(id: string, input: UpdateIssueCommentInput): MultiremiIssueComment {
    const current = this.getRawIssueComment(id);
    if (!current) throw new Error(`Comment not found: ${id}`);
    const body = (input.body ?? input.content ?? "").trim();
    if (!body) throw new Error("Comment body is required");
    const now = nowIso();
    this.db.run(
      "UPDATE multiremi_issue_comments SET body = ?, updated_at = ? WHERE id = ?",
      [body, now, id],
    );
    const attachmentIds = input.attachmentIds ?? input.attachment_ids ?? [];
    if (attachmentIds.length) this.linkAttachmentsToComment(id, current.issueId, attachmentIds);
    if (current.body !== body) this.cancelTasksByTriggerComments([id]);
    this.db.run("UPDATE multiremi_issues SET updated_at = ? WHERE id = ?", [now, current.issueId]);
    this.appendIssueActivity(current.issueId, {
      actorType: "system",
      actorId: null,
      type: "comment_updated",
      body,
      data: { commentId: id },
    });
    return this.getIssueComment(id)!;
  }

  deleteIssueComment(id: string): void {
    const current = this.getRawIssueComment(id);
    if (!current) throw new Error(`Comment not found: ${id}`);
    const ids = this.collectCommentTreeIds(id);
    const now = nowIso();
    this.cancelTasksByTriggerComments(ids);
    for (const commentId of ids) {
      this.db.run("DELETE FROM multiremi_comment_reactions WHERE comment_id = ?", [commentId]);
      this.db.run("DELETE FROM multiremi_attachments WHERE comment_id = ?", [commentId]);
    }
    for (const commentId of ids.slice().reverse()) {
      this.db.run("DELETE FROM multiremi_issue_comments WHERE id = ?", [commentId]);
    }
    this.db.run("UPDATE multiremi_issues SET updated_at = ? WHERE id = ?", [now, current.issueId]);
    this.appendIssueActivity(current.issueId, {
      actorType: "system",
      actorId: null,
      type: "comment_deleted",
      body: current.body,
      data: { commentId: id, deletedCommentIds: ids },
    });
  }

  resolveIssueComment(id: string, input: { actorType?: string; actorId?: string | null } = {}): MultiremiIssueComment {
    const current = this.getRawIssueComment(id);
    if (!current) throw new Error(`Comment not found: ${id}`);
    if (current.parentId) throw new Error("Only root comments can be resolved");
    if (current.resolvedAt) return this.getIssueComment(id)!;
    const now = nowIso();
    this.db.run(
      `UPDATE multiremi_issue_comments
       SET resolved_at = ?, resolved_by_type = ?, resolved_by_id = ?, updated_at = ?
       WHERE id = ?`,
      [now, input.actorType ?? "member", input.actorId ?? "local", now, id],
    );
    this.db.run("UPDATE multiremi_issues SET updated_at = ? WHERE id = ?", [now, current.issueId]);
    this.appendIssueActivity(current.issueId, {
      actorType: input.actorType ?? "member",
      actorId: input.actorId ?? "local",
      type: "comment_resolved",
      body: current.body,
      data: { commentId: id },
    });
    return this.getIssueComment(id)!;
  }

  unresolveIssueComment(id: string): MultiremiIssueComment {
    const current = this.getRawIssueComment(id);
    if (!current) throw new Error(`Comment not found: ${id}`);
    if (current.parentId) throw new Error("Only root comments can be resolved");
    if (!current.resolvedAt) return this.getIssueComment(id)!;
    const now = nowIso();
    this.db.run(
      "UPDATE multiremi_issue_comments SET resolved_at = NULL, resolved_by_type = NULL, resolved_by_id = NULL, updated_at = ? WHERE id = ?",
      [now, id],
    );
    this.db.run("UPDATE multiremi_issues SET updated_at = ? WHERE id = ?", [now, current.issueId]);
    this.appendIssueActivity(current.issueId, {
      actorType: "system",
      actorId: null,
      type: "comment_unresolved",
      body: current.body,
      data: { commentId: id },
    });
    return this.getIssueComment(id)!;
  }

  getIssueComment(id: string): MultiremiIssueComment | null {
    const row = this.db.query("SELECT * FROM multiremi_issue_comments WHERE id = ?").get(id) as Row | null;
    return row ? this.hydrateIssueComment(toIssueComment(row)) : null;
  }

  listIssueComments(issueId: string): MultiremiIssueComment[] {
    const rows = this.db.query(
      "SELECT * FROM multiremi_issue_comments WHERE issue_id = ? ORDER BY created_at ASC",
    ).all(issueId) as Row[];
    return rows.map((row) => this.hydrateIssueComment(toIssueComment(row)));
  }

  listIssueCommentsForGoCli(issueId: string, input: ListIssueCommentsInput = {}): ListIssueCommentsResult {
    const comments = this.listIssueComments(issueId).slice(0, COMMENT_HARD_CAP);
    const since = parseCommentCursorTime(input.since);
    const rootsOnly = Boolean(input.rootsOnly ?? input.roots_only);
    const thread = normalizeCommentString(input.thread);
    const recent = normalizeNullableInteger(input.recent);
    const tail = normalizeNullableInteger(input.tail);
    const tailSet = input.tail !== undefined && input.tail !== null;
    const summary = Boolean(input.summary);
    const before = parseCommentCursorTime(input.before);
    const beforeId = normalizeCommentString(input.beforeId ?? input.before_id);

    validateCommentListOptions({ rootsOnly, thread, recent, tail, tailSet, before, beforeId });

    const byId = new Map(comments.map((comment) => [comment.id, comment]));
    let nextBefore: string | null = null;
    let nextBeforeId: string | null = null;
    let selected: MultiremiIssueComment[];

    if (thread) {
      const anchor = byId.get(thread);
      if (!anchor) throw new Error("thread anchor not found in this issue");
      const rootId = commentThreadRootId(anchor, byId);
      const threadRows = comments.filter((comment) => comment.id === rootId || commentHasAncestorId(comment, rootId, byId));
      if (tailSet) {
        const root = threadRows.find((comment) => comment.id === rootId);
        let replies = threadRows
          .filter((comment) => comment.id !== rootId)
          .filter((comment) => !before || compareCommentCursor(comment, before, beforeId) < 0);
        const requestedTail = Math.min(tail ?? 0, COMMENT_HARD_CAP);
        const page = replies.slice(-(requestedTail + 1));
        let hasMore = page.length > requestedTail;
        replies = hasMore ? page.slice(1) : page;
        const retainedReplies = since
          ? replies.filter((comment) => commentCreatedAfter(comment, since))
          : replies;
        selected = root ? [root, ...retainedReplies] : retainedReplies;
        if (hasMore && replies.length > 0) {
          if (since && !commentCreatedAfter(replies[0]!, since)) hasMore = false;
          if (hasMore) {
            nextBefore = cursorTimestamp(replies[0]!);
            nextBeforeId = replies[0]!.id;
          }
        }
      } else {
        selected = since
          ? threadRows.filter((comment) => commentCreatedAfter(comment, since))
          : threadRows;
      }
    } else if (recent && recent > 0) {
      const groups = commentThreadGroups(comments);
      let ranked = groups
        .filter((group) => !before || compareCommentGroupCursor(group, before, beforeId) < 0)
        .sort((a, b) => (b.lastActivityMs - a.lastActivityMs) || b.rootId.localeCompare(a.rootId));
      ranked = ranked.slice(0, Math.min(recent, COMMENT_HARD_CAP));
      ranked.sort((a, b) => (a.lastActivityMs - b.lastActivityMs) || a.rootId.localeCompare(b.rootId));
      selected = ranked.flatMap((group) => {
        return since ? group.comments.filter((comment) => commentCreatedAfter(comment, since)) : group.comments;
      });
      const head = ranked[0];
      const emitCursor = ranked.length >= recent
        && head
        && (!since || head.lastActivityMs > since.getTime());
      if (emitCursor && head) {
        nextBefore = new Date(head.lastActivityMs).toISOString();
        nextBeforeId = head.rootId;
      }
    } else if (rootsOnly) {
      selected = comments
        .filter((comment) => !comment.parentId)
        .filter((comment) => !since || commentCreatedAfter(comment, since))
        .map((comment) => withCommentRootStats(comment, comments, byId));
    } else {
      selected = since ? comments.filter((comment) => commentCreatedAfter(comment, since)) : comments;
    }

    const out = summary ? selected.map(withCommentSummary) : selected.map(cloneComment);
    return {
      comments: out,
      nextBefore,
      nextBeforeId,
      next_before: nextBefore,
      next_before_id: nextBeforeId,
    };
  }

  listIssueActivity(issueId: string): MultiremiIssueActivity[] {
    const rows = this.db.query(
      "SELECT * FROM multiremi_issue_activity WHERE issue_id = ? ORDER BY created_at ASC",
    ).all(issueId) as Row[];
    return rows.map(toIssueActivity);
  }

  recordSquadLeaderEvaluation(issueId: string, input: {
    outcome: "action" | "no_action" | "failed" | string;
    reason?: string | null;
    taskId?: string | null;
    actorId?: string | null;
  }): MultiremiIssueActivity {
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const outcome = String(input.outcome ?? "").trim();
    if (outcome !== "action" && outcome !== "no_action" && outcome !== "failed") {
      throw new Error("outcome must be 'action', 'no_action', or 'failed'");
    }
    if (issue.assigneeType !== "squad" || !issue.assigneeId) throw new Error("issue is not assigned to a squad");
    const squad = this.getSquad(issue.assigneeId);
    if (!squad) throw new Error("squad not found");
    const actorId = input.actorId ?? squad.leaderId;
    if (squad.leaderId && actorId !== squad.leaderId) throw new Error("only the squad leader agent can record evaluations");
    if (input.taskId) {
      const task = this.getTask(input.taskId);
      if (!task || task.issueId !== issue.id) throw new Error("task does not belong to issue");
    }
    const id = createId("act");
    const now = nowIso();
    this.db.run(
      `INSERT INTO multiremi_issue_activity (id, issue_id, actor_type, actor_id, type, body, data, created_at)
       VALUES (?, ?, 'agent', ?, 'squad_leader_evaluated', ?, ?, ?)`,
      [
        id,
        issue.id,
        actorId ?? null,
        input.reason ?? null,
        toJson({
          squad_id: squad.id,
          task_id: input.taskId ?? null,
          outcome,
          reason: input.reason ?? "",
        }),
        now,
      ],
    );
    return this.listIssueActivity(issue.id).find((activity) => activity.id === id)!;
  }

  listIssueTimeline(issueId: string, options: { ascending?: boolean } = {}): MultiremiTimelineEntry[] {
    if (!this.getIssue(issueId)) throw new Error(`Issue not found: ${issueId}`);
    const entries: MultiremiTimelineEntry[] = [
      ...this.listIssueComments(issueId).map(commentToTimelineEntry),
      ...this.listIssueActivity(issueId).map(activityToTimelineEntry),
    ];
    const ascending = options.ascending !== false;
    return entries.sort((left, right) => {
      if (left.createdAt !== right.createdAt) {
        return ascending ? left.createdAt.localeCompare(right.createdAt) : right.createdAt.localeCompare(left.createdAt);
      }
      return ascending ? left.id.localeCompare(right.id) : right.id.localeCompare(left.id);
    });
  }

  listIssueSubscribers(issueId: string): MultiremiIssueSubscriber[] {
    if (!this.getIssue(issueId)) throw new Error(`Issue not found: ${issueId}`);
    const rows = this.db.query(
      "SELECT * FROM multiremi_issue_subscribers WHERE issue_id = ? ORDER BY created_at ASC",
    ).all(issueId) as Row[];
    return rows.map(toIssueSubscriber);
  }

  addIssueSubscriber(issueId: string, memberId: string, reason: MultiremiSubscriptionReason = "manual"): MultiremiIssueSubscriber {
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const member = this.getWorkspaceMember(memberId);
    if (!member) throw new Error(`Member not found: ${memberId}`);
    if (member.archivedAt) throw new Error(`Member is archived: ${memberId}`);
    if (member.workspaceId !== issue.workspaceId) throw new Error("target user is not a member of this workspace");
    return this.addTypedIssueSubscriber(issueId, "member", memberId, reason);
  }

  addTypedIssueSubscriber(
    issueId: string,
    userType: string,
    userId: string,
    reason: MultiremiSubscriptionReason = "manual",
  ): MultiremiIssueSubscriber {
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const normalizedUserType = normalizeIssueSubscriberUserType(userType);
    if (!this.isWorkspaceSubscriberTarget(issue.workspaceId, normalizedUserType, userId)) {
      throw new Error("target user is not a member of this workspace");
    }
    const now = nowIso();
    const id = createId("sub");
    this.db.run(
      `INSERT INTO multiremi_issue_subscribers (id, issue_id, member_id, user_type, user_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(issue_id, user_type, user_id) DO UPDATE SET reason = excluded.reason`,
      [id, issueId, userId, normalizedUserType, userId, reason, now],
    );
    const row = this.db.query(
      "SELECT * FROM multiremi_issue_subscribers WHERE issue_id = ? AND user_type = ? AND user_id = ?",
    ).get(issueId, normalizedUserType, userId) as Row | null;
    return toIssueSubscriber(row!);
  }

  removeIssueSubscriber(issueId: string, memberId: string): void {
    this.removeTypedIssueSubscriber(issueId, "member", memberId);
  }

  removeTypedIssueSubscriber(issueId: string, userType: string, userId: string): void {
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const normalizedUserType = normalizeIssueSubscriberUserType(userType);
    if (!this.isWorkspaceSubscriberTarget(issue.workspaceId, normalizedUserType, userId)) {
      throw new Error("target user is not a member of this workspace");
    }
    this.db.run(
      "DELETE FROM multiremi_issue_subscribers WHERE issue_id = ? AND user_type = ? AND user_id = ?",
      [issueId, normalizedUserType, userId],
    );
  }

  private isWorkspaceSubscriberTarget(workspaceId: string, userType: string, userId: string): boolean {
    const id = cleanOptionalString(userId);
    if (!id) return false;
    if (userType === "member") {
      const member = this.getWorkspaceMember(id);
      return Boolean(member && !member.archivedAt && member.workspaceId === workspaceId);
    }
    if (userType === "agent") {
      const agent = this.getAgent(id);
      return Boolean(agent && !agent.archivedAt && agent.workspaceId === workspaceId);
    }
    return false;
  }

  listLabels(workspaceId?: string | null): MultiremiLabel[] {
    const rows = workspaceId
      ? this.db.query("SELECT * FROM multiremi_issue_labels WHERE workspace_id = ? ORDER BY lower(name) ASC").all(workspaceId) as Row[]
      : this.db.query("SELECT * FROM multiremi_issue_labels ORDER BY workspace_id ASC, lower(name) ASC").all() as Row[];
    return rows.map(toLabel);
  }

  getLabel(id: string): MultiremiLabel | null {
    const row = this.db.query("SELECT * FROM multiremi_issue_labels WHERE id = ?").get(id) as Row | null;
    return row ? toLabel(row) : null;
  }

  createLabel(input: CreateLabelInput): MultiremiLabel {
    const name = normalizeLabelName(input.name);
    const color = normalizeLabelColor(input.color);
    const workspaceId = input.workspaceId ?? input.workspace_id ?? "local";
    const existing = this.db.query(
      "SELECT id FROM multiremi_issue_labels WHERE workspace_id = ? AND lower(name) = lower(?)",
    ).get(workspaceId, name) as Row | null;
    if (existing) throw new Error(`Label already exists in workspace: ${name}`);
    const id = input.id ?? createId("lbl");
    const now = nowIso();
    this.db.run(
      `INSERT INTO multiremi_issue_labels (id, workspace_id, name, color, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, workspaceId, name, color, now, now],
    );
    return this.getLabel(id)!;
  }

  updateLabel(id: string, input: UpdateLabelInput): MultiremiLabel {
    const current = this.getLabel(id);
    if (!current) throw new Error(`Label not found: ${id}`);
    const name = input.name === undefined ? current.name : normalizeLabelName(input.name);
    const color = input.color === undefined ? current.color : normalizeLabelColor(input.color);
    const duplicate = this.db.query(
      "SELECT id FROM multiremi_issue_labels WHERE workspace_id = ? AND lower(name) = lower(?) AND id != ?",
    ).get(current.workspaceId, name, id) as Row | null;
    if (duplicate) throw new Error(`Label already exists in workspace: ${name}`);
    const now = nowIso();
    this.db.run(
      "UPDATE multiremi_issue_labels SET name = ?, color = ?, updated_at = ? WHERE id = ?",
      [name, color, now, id],
    );
    return this.getLabel(id)!;
  }

  deleteLabel(id: string): MultiremiLabel {
    const label = this.getLabel(id);
    if (!label) throw new Error(`Label not found: ${id}`);
    this.db.run("DELETE FROM multiremi_issue_labels WHERE id = ?", [id]);
    return label;
  }

  listLabelsForIssue(issueId: string): MultiremiLabel[] {
    const issue = this.db.query("SELECT id FROM multiremi_issues WHERE id = ?").get(issueId) as Row | null;
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const rows = this.db.query(
      `SELECT l.*
       FROM multiremi_issue_labels l
       JOIN multiremi_issue_to_labels il ON il.label_id = l.id
       WHERE il.issue_id = ?
       ORDER BY lower(l.name) ASC`,
    ).all(issueId) as Row[];
    return rows.map(toLabel);
  }

  attachLabelToIssue(issueId: string, labelId: string): MultiremiLabel[] {
    const issueRow = this.db.query("SELECT * FROM multiremi_issues WHERE id = ?").get(issueId) as Row | null;
    if (!issueRow) throw new Error(`Issue not found: ${issueId}`);
    const issue = toIssue(issueRow);
    const label = this.getLabel(labelId);
    if (!label) throw new Error(`Label not found: ${labelId}`);
    if (label.workspaceId !== issue.workspaceId) throw new Error("Label belongs to another workspace");
    const existing = this.db.query(
      "SELECT 1 FROM multiremi_issue_to_labels WHERE issue_id = ? AND label_id = ?",
    ).get(issueId, labelId) as Row | null;
    if (existing) return this.listLabelsForIssue(issueId);
    this.db.run(
      "INSERT OR IGNORE INTO multiremi_issue_to_labels (issue_id, label_id) VALUES (?, ?)",
      [issueId, labelId],
    );
    const now = nowIso();
    this.db.run("UPDATE multiremi_issues SET updated_at = ? WHERE id = ?", [now, issueId]);
    this.appendIssueActivity(issueId, {
      actorType: "system",
      actorId: null,
      type: "label_attached",
      body: label.name,
      data: { labelId, color: label.color },
    });
    return this.listLabelsForIssue(issueId);
  }

  detachLabelFromIssue(issueId: string, labelId: string): MultiremiLabel[] {
    const issueRow = this.db.query("SELECT * FROM multiremi_issues WHERE id = ?").get(issueId) as Row | null;
    if (!issueRow) throw new Error(`Issue not found: ${issueId}`);
    const issue = toIssue(issueRow);
    const label = this.getLabel(labelId);
    if (!label) throw new Error(`Label not found: ${labelId}`);
    if (label.workspaceId !== issue.workspaceId) throw new Error("Label belongs to another workspace");
    const existing = this.db.query(
      "SELECT 1 FROM multiremi_issue_to_labels WHERE issue_id = ? AND label_id = ?",
    ).get(issueId, labelId) as Row | null;
    if (!existing) return this.listLabelsForIssue(issueId);
    this.db.run("DELETE FROM multiremi_issue_to_labels WHERE issue_id = ? AND label_id = ?", [issueId, labelId]);
    const now = nowIso();
    this.db.run("UPDATE multiremi_issues SET updated_at = ? WHERE id = ?", [now, issueId]);
    this.appendIssueActivity(issueId, {
      actorType: "system",
      actorId: null,
      type: "label_detached",
      body: label.name,
      data: { labelId, color: label.color },
    });
    return this.listLabelsForIssue(issueId);
  }

  listInboxItems(memberId?: string | null): MultiremiInboxItem[] {
    const resolvedMemberId = memberId ?? this.listWorkspaceMembers()[0]?.id ?? null;
    if (!resolvedMemberId) return [];
    const rows = this.db.query(
      "SELECT * FROM multiremi_inbox_items WHERE member_id = ? AND archived = 0 ORDER BY created_at DESC",
    ).all(resolvedMemberId) as Row[];
    return rows.map((row) => {
      const issueId = nullableString(row.issue_id);
      return toInboxItem(row, issueId ? this.getIssue(issueId) : null);
    });
  }

  markInboxItemRead(id: string): MultiremiInboxItem {
    const existing = this.db.query("SELECT issue_id FROM multiremi_inbox_items WHERE id = ?").get(id) as { issue_id: string } | null;
    if (!existing) throw new Error(`Inbox item not found: ${id}`);
    this.db.run("UPDATE multiremi_inbox_items SET read = 1 WHERE id = ?", [id]);
    const row = this.db.query("SELECT * FROM multiremi_inbox_items WHERE id = ?").get(id) as Row | null;
    const issueId = nullableString(row!.issue_id);
    return toInboxItem(row!, issueId ? this.getIssue(issueId) : null);
  }

  archiveInboxItem(id: string): MultiremiInboxItem {
    const rowBefore = this.db.query("SELECT issue_id FROM multiremi_inbox_items WHERE id = ?").get(id) as { issue_id: string } | null;
    if (!rowBefore) throw new Error(`Inbox item not found: ${id}`);
    this.db.run("UPDATE multiremi_inbox_items SET archived = 1, read = 1 WHERE id = ?", [id]);
    const row = this.db.query("SELECT * FROM multiremi_inbox_items WHERE id = ?").get(id) as Row | null;
    const issueId = nullableString(row!.issue_id);
    return toInboxItem(row!, issueId ? this.getIssue(issueId) : null);
  }

  countUnreadInboxItems(memberId?: string | null): number {
    const resolvedMemberId = memberId ?? this.listWorkspaceMembers()[0]?.id ?? null;
    if (!resolvedMemberId) return 0;
    const row = this.db.query(
      "SELECT COUNT(*) AS count FROM multiremi_inbox_items WHERE member_id = ? AND archived = 0 AND read = 0",
    ).get(resolvedMemberId) as { count: number } | null;
    return Number(row?.count ?? 0);
  }

  markAllInboxItemsRead(memberId?: string | null): number {
    const resolvedMemberId = memberId ?? this.listWorkspaceMembers()[0]?.id ?? null;
    if (!resolvedMemberId) return 0;
    const result = this.db.run(
      "UPDATE multiremi_inbox_items SET read = 1 WHERE member_id = ? AND archived = 0 AND read = 0",
      [resolvedMemberId],
    );
    return result.changes;
  }

  archiveAllInboxItems(memberId?: string | null, mode: "all" | "read" | "completed" = "all"): number {
    const resolvedMemberId = memberId ?? this.listWorkspaceMembers()[0]?.id ?? null;
    if (!resolvedMemberId) return 0;
    if (mode === "read") {
      return this.db.run(
        "UPDATE multiremi_inbox_items SET archived = 1, read = 1 WHERE member_id = ? AND archived = 0 AND read = 1",
        [resolvedMemberId],
      ).changes;
    }
    if (mode === "completed") {
      return this.db.run(
        `UPDATE multiremi_inbox_items
         SET archived = 1, read = 1
         WHERE member_id = ?
           AND archived = 0
           AND issue_id IN (
             SELECT id FROM multiremi_issues WHERE status IN ('done', 'completed', 'closed', 'cancelled')
           )`,
        [resolvedMemberId],
      ).changes;
    }
    return this.db.run(
      "UPDATE multiremi_inbox_items SET archived = 1, read = 1 WHERE member_id = ? AND archived = 0",
      [resolvedMemberId],
    ).changes;
  }

  listIssueReactions(issueId: string): MultiremiIssueReaction[] {
    if (!this.getIssue(issueId)) throw new Error(`Issue not found: ${issueId}`);
    const rows = this.db.query(
      "SELECT * FROM multiremi_issue_reactions WHERE issue_id = ? ORDER BY created_at ASC",
    ).all(issueId) as Row[];
    return rows.map(toIssueReaction);
  }

  addIssueReaction(issueId: string, input: { actorType?: string; actorId?: string | null; emoji: string }): MultiremiIssueReaction {
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const actorType = input.actorType ?? "member";
    const actorId = input.actorId ?? "local";
    const emoji = input.emoji?.trim();
    if (!emoji) throw new Error("emoji is required");
    this.db.run(
      `INSERT INTO multiremi_issue_reactions (id, issue_id, workspace_id, actor_type, actor_id, emoji, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(issue_id, actor_type, actor_id, emoji) DO NOTHING`,
      [createId("rxn"), issueId, issue.workspaceId, actorType, actorId, emoji, nowIso()],
    );
    const row = this.db.query(
      "SELECT * FROM multiremi_issue_reactions WHERE issue_id = ? AND actor_type = ? AND actor_id = ? AND emoji = ?",
    ).get(issueId, actorType, actorId, emoji) as Row | null;
    return toIssueReaction(row!);
  }

  removeIssueReaction(issueId: string, input: { actorType?: string; actorId?: string | null; emoji: string }): void {
    const actorType = input.actorType ?? "member";
    const actorId = input.actorId ?? "local";
    const emoji = input.emoji?.trim();
    if (!emoji) throw new Error("emoji is required");
    this.db.run(
      "DELETE FROM multiremi_issue_reactions WHERE issue_id = ? AND actor_type = ? AND actor_id = ? AND emoji = ?",
      [issueId, actorType, actorId, emoji],
    );
  }

  listCommentReactions(commentId: string): MultiremiCommentReaction[] {
    if (!this.getRawIssueComment(commentId)) throw new Error(`Comment not found: ${commentId}`);
    const rows = this.db.query(
      "SELECT * FROM multiremi_comment_reactions WHERE comment_id = ? ORDER BY created_at ASC",
    ).all(commentId) as Row[];
    return rows.map(toCommentReaction);
  }

  addCommentReaction(commentId: string, input: { actorType?: string; actorId?: string | null; emoji: string }): MultiremiCommentReaction {
    const comment = this.getRawIssueComment(commentId);
    if (!comment) throw new Error(`Comment not found: ${commentId}`);
    const issue = this.getIssue(comment.issueId);
    const actorType = input.actorType ?? "member";
    const actorId = input.actorId ?? "local";
    const emoji = input.emoji?.trim();
    if (!emoji) throw new Error("emoji is required");
    this.db.run(
      `INSERT INTO multiremi_comment_reactions (id, comment_id, workspace_id, actor_type, actor_id, emoji, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(comment_id, actor_type, actor_id, emoji) DO NOTHING`,
      [createId("rxn"), commentId, issue?.workspaceId ?? "local", actorType, actorId, emoji, nowIso()],
    );
    const row = this.db.query(
      "SELECT * FROM multiremi_comment_reactions WHERE comment_id = ? AND actor_type = ? AND actor_id = ? AND emoji = ?",
    ).get(commentId, actorType, actorId, emoji) as Row | null;
    return toCommentReaction(row!);
  }

  removeCommentReaction(commentId: string, input: { actorType?: string; actorId?: string | null; emoji: string }): void {
    const actorType = input.actorType ?? "member";
    const actorId = input.actorId ?? "local";
    const emoji = input.emoji?.trim();
    if (!emoji) throw new Error("emoji is required");
    this.db.run(
      "DELETE FROM multiremi_comment_reactions WHERE comment_id = ? AND actor_type = ? AND actor_id = ? AND emoji = ?",
      [commentId, actorType, actorId, emoji],
    );
  }

  createAttachment(input: CreateAttachmentInput): MultiremiAttachment {
    if (!input.filename?.trim()) throw new Error("filename is required");
    if (!input.url?.trim()) throw new Error("url is required");
    const issueId = input.issueId ?? input.issue_id ?? null;
    const commentId = input.commentId ?? input.comment_id ?? null;
    const chatSessionId = input.chatSessionId ?? input.chat_session_id ?? null;
    const chatMessageId = input.chatMessageId ?? input.chat_message_id ?? null;
    const issue = issueId ? this.getIssue(issueId) : null;
    const comment = commentId ? this.getRawIssueComment(commentId) : null;
    const chatSession = chatSessionId ? this.getChatSession(chatSessionId) : null;
    const chatMessage = chatMessageId ? this.getChatMessage(chatMessageId) : null;
    if (issueId && !issue) throw new Error(`Issue not found: ${issueId}`);
    if (commentId && !comment) throw new Error(`Comment not found: ${commentId}`);
    if (chatSessionId && !chatSession) throw new Error(`Chat session not found: ${chatSessionId}`);
    if (chatMessageId && !chatMessage) throw new Error(`Chat message not found: ${chatMessageId}`);
    if (chatMessage && chatSessionId && chatMessage.chatSessionId !== chatSessionId) throw new Error(`Chat message belongs to another session: ${chatMessageId}`);
    const workspaceId = input.workspaceId
      ?? input.workspace_id
      ?? issue?.workspaceId
      ?? (comment ? this.getIssue(comment.issueId)?.workspaceId : null)
      ?? chatSession?.workspaceId
      ?? (chatMessage ? this.getChatSession(chatMessage.chatSessionId)?.workspaceId : null)
      ?? "local";
    const id = input.id ?? createId("att");
    const uploaderType = input.uploaderType ?? input.uploader_type ?? "member";
    const uploaderId = input.uploaderId ?? input.uploader_id ?? "local";
    this.db.run(
      `INSERT INTO multiremi_attachments (
        id, workspace_id, issue_id, comment_id, chat_session_id, chat_message_id,
        uploader_type, uploader_id, filename, url, content_type, size_bytes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        workspaceId,
        issueId,
        commentId,
        chatSessionId ?? chatMessage?.chatSessionId ?? null,
        chatMessageId,
        uploaderType,
        uploaderId,
        input.filename.trim(),
        input.url.trim(),
        input.contentType ?? input.content_type ?? "application/octet-stream",
        Math.max(0, Number(input.sizeBytes ?? input.size_bytes ?? 0)),
        nowIso(),
      ],
    );
    return this.getAttachment(id)!;
  }

  getAttachment(id: string): MultiremiAttachment | null {
    const row = this.db.query("SELECT * FROM multiremi_attachments WHERE id = ?").get(id) as Row | null;
    return row ? toAttachment(row) : null;
  }

  deleteAttachment(id: string): MultiremiAttachment | null {
    const attachment = this.getAttachment(id);
    if (!attachment) return null;
    this.db.run("DELETE FROM multiremi_attachments WHERE id = ?", [id]);
    return attachment;
  }

  listAttachmentsForIssue(issueId: string): MultiremiAttachment[] {
    if (!this.getIssue(issueId)) throw new Error(`Issue not found: ${issueId}`);
    const rows = this.db.query(
      "SELECT * FROM multiremi_attachments WHERE issue_id = ? AND comment_id IS NULL ORDER BY created_at ASC",
    ).all(issueId) as Row[];
    return rows.map(toAttachment);
  }

  listAttachmentsForComment(commentId: string): MultiremiAttachment[] {
    if (!this.getRawIssueComment(commentId)) throw new Error(`Comment not found: ${commentId}`);
    const rows = this.db.query(
      "SELECT * FROM multiremi_attachments WHERE comment_id = ? ORDER BY created_at ASC",
    ).all(commentId) as Row[];
    return rows.map(toAttachment);
  }

  listAttachmentsForChatMessage(chatMessageId: string): MultiremiAttachment[] {
    if (!this.getChatMessage(chatMessageId)) throw new Error(`Chat message not found: ${chatMessageId}`);
    const rows = this.db.query(
      "SELECT * FROM multiremi_attachments WHERE chat_message_id = ? ORDER BY created_at ASC",
    ).all(chatMessageId) as Row[];
    return rows.map(toAttachment);
  }

  listAttachmentsForChatMessages(chatMessageIds: string[]): Map<string, MultiremiAttachment[]> {
    const grouped = new Map<string, MultiremiAttachment[]>();
    const ids = [...new Set(chatMessageIds.filter(Boolean))];
    if (!ids.length) return grouped;
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db.query(
      `SELECT * FROM multiremi_attachments WHERE chat_message_id IN (${placeholders}) ORDER BY created_at ASC`,
    ).all(...ids) as Row[];
    for (const attachment of rows.map(toAttachment)) {
      const messageId = attachment.chatMessageId;
      if (!messageId) continue;
      const list = grouped.get(messageId) ?? [];
      list.push(attachment);
      grouped.set(messageId, list);
    }
    return grouped;
  }

  linkAttachmentsToIssue(issueId: string, attachmentIds: string[]): void {
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    for (const attachmentId of attachmentIds) {
      const attachment = this.getAttachment(attachmentId);
      if (!attachment) throw new Error(`Attachment not found: ${attachmentId}`);
      this.db.run(
        "UPDATE multiremi_attachments SET issue_id = ?, workspace_id = ? WHERE id = ? AND issue_id IS NULL",
        [issueId, issue.workspaceId, attachmentId],
      );
    }
  }

  linkAttachmentsToChatMessage(chatSessionId: string, chatMessageId: string, attachmentIds: string[]): void {
    const session = this.getChatSession(chatSessionId);
    if (!session) throw new Error(`Chat session not found: ${chatSessionId}`);
    const message = this.getChatMessage(chatMessageId);
    if (!message) throw new Error(`Chat message not found: ${chatMessageId}`);
    if (message.chatSessionId !== chatSessionId) throw new Error("Chat message belongs to another session");
    if (!attachmentIds.length) return;
    const placeholders = attachmentIds.map(() => "?").join(", ");
    this.db.run(
      `UPDATE multiremi_attachments
       SET chat_message_id = ?
       WHERE chat_session_id = ?
         AND chat_message_id IS NULL
         AND id IN (${placeholders})`,
      [chatMessageId, chatSessionId, ...attachmentIds],
    );
  }

  listIssueMetadata(issueId: string): Record<string, string | number | boolean> {
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    return issue.metadata;
  }

  setIssueMetadataKey(issueId: string, key: string, value: unknown): Record<string, string | number | boolean> {
    validateIssueMetadataKey(key);
    const normalized = validateIssueMetadataValue(value);
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const metadata = { ...issue.metadata };
    if (!(key in metadata) && Object.keys(metadata).length >= MAX_ISSUE_METADATA_KEYS) {
      throw new Error(`metadata cannot exceed ${MAX_ISSUE_METADATA_KEYS} keys`);
    }
    metadata[key] = normalized;
    validateIssueMetadataSize(metadata);
    const now = nowIso();
    this.db.run(
      "UPDATE multiremi_issues SET metadata = ?, updated_at = ? WHERE id = ?",
      [toJson(metadata), now, issueId],
    );
    this.appendIssueActivity(issueId, {
      actorType: "system",
      actorId: null,
      type: "issue_metadata_set",
      body: `${key}=${String(normalized)}`,
      data: { key, value: normalized },
    });
    return this.listIssueMetadata(issueId);
  }

  deleteIssueMetadataKey(issueId: string, key: string): Record<string, string | number | boolean> {
    validateIssueMetadataKey(key);
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const metadata = { ...issue.metadata };
    delete metadata[key];
    const now = nowIso();
    this.db.run(
      "UPDATE multiremi_issues SET metadata = ?, updated_at = ? WHERE id = ?",
      [toJson(metadata), now, issueId],
    );
    this.appendIssueActivity(issueId, {
      actorType: "system",
      actorId: null,
      type: "issue_metadata_deleted",
      body: key,
      data: { key },
    });
    return this.listIssueMetadata(issueId);
  }

  private appendIssueActivity(issueId: string, input: {
    actorType: string;
    actorId?: string | null;
    type: string;
    body?: string | null;
    data?: unknown | null;
  }): void {
    this.db.run(
      `INSERT INTO multiremi_issue_activity (id, issue_id, actor_type, actor_id, type, body, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        createId("act"),
        issueId,
        input.actorType,
        input.actorId ?? null,
        input.type,
        input.body ?? null,
        input.data == null ? null : toJson(input.data),
        nowIso(),
      ],
    );
  }

  createProject(input: CreateProjectInput): MultiremiProject {
    if (!input.title?.trim()) throw new Error("Project title is required");
    const id = input.id ?? createId("prj");
    const now = nowIso();
    const tx = this.db.transaction(() => {
      this.db.run(
        `INSERT INTO multiremi_projects (
          id, title, description, icon, status, priority, workspace_id,
          lead_type, lead_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.title.trim(),
          input.description ?? null,
          input.icon ?? null,
          input.status ?? "planned",
          input.priority ?? "none",
          input.workspaceId ?? input.workspace_id ?? "local",
          input.leadType === undefined ? input.lead_type ?? null : input.leadType,
          input.leadId === undefined ? input.lead_id ?? null : input.leadId,
          now,
          now,
        ],
      );
      for (const resource of input.resources ?? []) {
        this.createProjectResource(id, resource);
      }
      return this.getProject(id)!;
    });
    return tx();
  }

  getProject(id: string): MultiremiProject | null {
    const row = this.db.query(projectSelect("WHERE p.id = ?")).get(id) as Row | null;
    return row ? toProject(row) : null;
  }

  listProjects(workspaceId?: string | null): MultiremiProject[] {
    const rows = workspaceId
      ? this.db.query(projectSelect("WHERE p.workspace_id = ? ORDER BY p.updated_at DESC")).all(workspaceId) as Row[]
      : this.db.query(projectSelect("ORDER BY p.updated_at DESC")).all() as Row[];
    return rows.map(toProject);
  }

  searchProjects(input: { q: string; workspaceId?: string | null; includeClosed?: boolean; limit?: number; offset?: number }): { projects: MultiremiProjectSearchResult[]; total: number } {
    const query = normalizeSearchQuery(input.q);
    if (!query) throw new Error("q parameter is required");
    const workspaceId = input.workspaceId ?? "local";
    const includeClosed = Boolean(input.includeClosed);
    const limit = clampSearchLimit(input.limit);
    const offset = Math.max(0, Number(input.offset ?? 0));
    const rows = this.listProjects(workspaceId).filter((project) => {
      if (!includeClosed && ["completed", "cancelled"].includes(project.status)) return false;
      return searchMatch(project.title, query) || searchMatch(project.description ?? "", query);
    }).map((project) => {
      const matchSource = searchMatch(project.title, query) ? "title" : "description";
      const result: MultiremiProjectSearchResult = {
        ...project,
        matchSource,
      };
      if (matchSource === "description" && project.description) result.matchedSnippet = extractSearchSnippet(project.description, query);
      return result;
    }).sort((left, right) => searchRank(left.matchSource) - searchRank(right.matchSource) || Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    return { projects: rows.slice(offset, offset + limit), total: rows.length };
  }

  updateProject(id: string, input: UpdateProjectInput): MultiremiProject {
    const current = this.getProject(id);
    if (!current) throw new Error(`Project not found: ${id}`);
    const now = nowIso();
    this.db.run(
      `UPDATE multiremi_projects SET
        title = ?,
        description = ?,
        icon = ?,
        status = ?,
        priority = ?,
        lead_type = ?,
        lead_id = ?,
        updated_at = ?
       WHERE id = ?`,
      [
        input.title ?? current.title,
        input.description === undefined ? current.description : input.description,
        input.icon === undefined ? current.icon : input.icon,
        input.status ?? current.status,
        input.priority ?? current.priority,
        input.leadType === undefined ? input.lead_type === undefined ? current.leadType : input.lead_type : input.leadType,
        input.leadId === undefined ? input.lead_id === undefined ? current.leadId : input.lead_id : input.leadId,
        now,
        id,
      ],
    );
    return this.getProject(id)!;
  }

  archiveProject(id: string): MultiremiProject {
    return this.updateProject(id, { status: "cancelled" });
  }

  listPinnedItems(workspaceId?: string | null, userId?: string | null): MultiremiPinnedItem[] {
    const resolvedWorkspaceId = workspaceId ?? "local";
    const resolvedUserId = userId ?? "local";
    const rows = this.db.query(
      `SELECT * FROM multiremi_pinned_items
       WHERE workspace_id = ? AND user_id = ?
       ORDER BY position ASC, created_at ASC`,
    ).all(resolvedWorkspaceId, resolvedUserId) as Row[];
    return rows.map(toPinnedItem);
  }

  createPinnedItem(input: CreatePinnedItemInput): MultiremiPinnedItem {
    const itemType = normalizePinnedItemType(input.itemType ?? input.item_type);
    const itemId = String(input.itemId ?? input.item_id ?? "").trim();
    if (!itemId) throw new Error("item_id is required");
    const workspaceId = input.workspaceId ?? input.workspace_id ?? "local";
    const userId = input.userId ?? input.user_id ?? "local";
    this.validatePinnedItemTarget(workspaceId, itemType, itemId);
    const existing = this.db.query(
      "SELECT id FROM multiremi_pinned_items WHERE workspace_id = ? AND user_id = ? AND item_type = ? AND item_id = ?",
    ).get(workspaceId, userId, itemType, itemId) as Row | null;
    if (existing) throw new Error("Item already pinned");
    const maxRow = this.db.query(
      "SELECT COALESCE(MAX(position), 0) AS max_position FROM multiremi_pinned_items WHERE workspace_id = ? AND user_id = ?",
    ).get(workspaceId, userId) as Row | null;
    const id = input.id ?? createId("pin");
    const position = Number(maxRow?.max_position ?? 0) + 1;
    this.db.run(
      `INSERT INTO multiremi_pinned_items (id, workspace_id, user_id, item_type, item_id, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, workspaceId, userId, itemType, itemId, position, nowIso()],
    );
    return this.getPinnedItem(id)!;
  }

  getPinnedItem(id: string): MultiremiPinnedItem | null {
    const row = this.db.query("SELECT * FROM multiremi_pinned_items WHERE id = ?").get(id) as Row | null;
    return row ? toPinnedItem(row) : null;
  }

  deletePinnedItem(workspaceId: string | null | undefined, userId: string | null | undefined, itemType: string, itemId: string): void {
    const normalizedType = normalizePinnedItemType(itemType);
    this.db.run(
      "DELETE FROM multiremi_pinned_items WHERE workspace_id = ? AND user_id = ? AND item_type = ? AND item_id = ?",
      [workspaceId ?? "local", userId ?? "local", normalizedType, itemId],
    );
  }

  reorderPinnedItems(workspaceId: string | null | undefined, userId: string | null | undefined, items: ReorderPinnedItemInput[]): MultiremiPinnedItem[] {
    const resolvedWorkspaceId = workspaceId ?? "local";
    const resolvedUserId = userId ?? "local";
    const tx = this.db.transaction(() => {
      for (const item of items) {
        if (!item.id) throw new Error("items[].id is required");
        const position = Number(item.position);
        if (!Number.isFinite(position)) throw new Error("items[].position must be a finite number");
        this.db.run(
          "UPDATE multiremi_pinned_items SET position = ? WHERE id = ? AND workspace_id = ? AND user_id = ?",
          [position, item.id, resolvedWorkspaceId, resolvedUserId],
        );
      }
      return this.listPinnedItems(resolvedWorkspaceId, resolvedUserId);
    });
    return tx();
  }

  listProjectResources(projectId: string): MultiremiProjectResource[] {
    if (!this.getProject(projectId)) throw new Error(`Project not found: ${projectId}`);
    const rows = this.db.query(
      "SELECT * FROM multiremi_project_resources WHERE project_id = ? ORDER BY position ASC, created_at ASC",
    ).all(projectId) as Row[];
    return rows.map(toProjectResource);
  }

  createProjectResource(projectId: string, input: CreateProjectResourceInput): MultiremiProjectResource {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const resourceType = String(input.resourceType ?? input.resource_type ?? "").trim();
    const rawRef = input.resourceRef ?? input.resource_ref ?? {};
    const resourceRef = normalizeProjectResourceRef(resourceType, rawRef);
    this.assertNoLocalDirectoryDaemonConflict(projectId, resourceType, resourceRef, null, "create");
    if (resourceType === "project_ref") this.assertValidProjectRef(projectId, resourceRef, project.workspaceId);
    const id = input.id ?? createId("res");
    const now = nowIso();
    const position = normalizeProjectResourcePosition(input.position, this.countProjectResources(projectId));
    this.db.run(
      `INSERT INTO multiremi_project_resources (
        id, project_id, workspace_id, resource_type, resource_ref, label, position, created_at, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        projectId,
        project.workspaceId,
        resourceType,
        toJson(resourceRef),
        cleanProjectResourceLabel(input.label),
        position,
        now,
        input.createdBy ?? null,
      ],
    );
    this.db.run("UPDATE multiremi_projects SET updated_at = ? WHERE id = ?", [now, projectId]);
    return this.getProjectResource(id)!;
  }

  getProjectResource(id: string): MultiremiProjectResource | null {
    const row = this.db.query("SELECT * FROM multiremi_project_resources WHERE id = ?").get(id) as Row | null;
    return row ? toProjectResource(row) : null;
  }

  updateProjectResource(projectId: string, resourceId: string, input: UpdateProjectResourceInput): MultiremiProjectResource {
    if (!this.getProject(projectId)) throw new Error(`Project not found: ${projectId}`);
    const existing = this.getProjectResource(resourceId);
    if (!existing || existing.projectId !== projectId) throw new Error(`Project resource not found: ${resourceId}`);
    const hasRef = hasAnyField(input, "resourceRef", "resource_ref");
    const rawRef = hasRef ? input.resourceRef ?? input.resource_ref ?? {} : existing.resourceRef;
    const resourceRef = normalizeProjectResourceRef(existing.resourceType, rawRef);
    this.assertNoLocalDirectoryDaemonConflict(projectId, existing.resourceType, resourceRef, resourceId, "update");
    if (existing.resourceType === "project_ref") this.assertValidProjectRef(projectId, resourceRef, existing.workspaceId);
    const label = hasAnyField(input, "label") ? cleanProjectResourceLabel(input.label) : existing.label;
    const position = hasAnyField(input, "position")
      ? normalizeProjectResourcePosition(input.position, existing.position)
      : existing.position;
    const now = nowIso();
    const result = this.db.run(
      `UPDATE multiremi_project_resources
       SET resource_ref = ?, label = ?, position = ?
       WHERE project_id = ? AND id = ?`,
      [toJson(resourceRef), label, position, projectId, resourceId],
    );
    if (result.changes === 0) throw new Error(`Project resource not found: ${resourceId}`);
    this.db.run("UPDATE multiremi_projects SET updated_at = ? WHERE id = ?", [now, projectId]);
    return this.getProjectResource(resourceId)!;
  }

  deleteProjectResource(projectId: string, resourceId: string): void {
    if (!this.getProject(projectId)) throw new Error(`Project not found: ${projectId}`);
    const now = nowIso();
    const result = this.db.run(
      "DELETE FROM multiremi_project_resources WHERE project_id = ? AND id = ?",
      [projectId, resourceId],
    );
    if (result.changes === 0) throw new Error(`Project resource not found: ${resourceId}`);
    this.db.run("UPDATE multiremi_projects SET updated_at = ? WHERE id = ?", [now, projectId]);
  }

  createSquad(input: CreateSquadInput): MultiremiSquad {
    if (!input.name?.trim()) throw new Error("Squad name is required");
    if (input.leaderId && !this.getAgent(input.leaderId)) throw new Error(`Agent not found: ${input.leaderId}`);
    const id = input.id ?? createId("sqd");
    const now = nowIso();
    this.db.run(
      `INSERT INTO multiremi_squads (
        id, name, description, instructions, workspace_id, leader_id,
        creator_id, archived_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      [
        id,
        input.name.trim(),
        input.description ?? "",
        input.instructions ?? "",
        input.workspaceId ?? "local",
        input.leaderId ?? null,
        input.creatorId ?? null,
        now,
        now,
      ],
    );
    if (input.leaderId) this.addSquadMember(id, { memberType: "agent", memberId: input.leaderId, role: "leader" });
    for (const memberId of input.memberIds ?? []) {
      if (memberId !== input.leaderId) this.addSquadMember(id, { memberType: "agent", memberId, role: "member" });
    }
    return this.getSquad(id)!;
  }

  getSquad(id: string): MultiremiSquad | null {
    const row = this.db.query(squadSelect("WHERE s.id = ?")).get(id) as Row | null;
    return row ? toSquad(row) : null;
  }

  getSquadByRef(ref: string, workspaceId?: string | null): MultiremiSquad | null {
    const value = ref.trim();
    if (!value) return null;
    const exact = this.getSquad(value);
    if (exact && !exact.archivedAt && (!workspaceId || exact.workspaceId === workspaceId)) return exact;
    return uniqueRefMatch(
      this.listSquads(workspaceId),
      value,
      (squad) => squad.id,
      (squad) => [squad.name],
    );
  }

  listSquads(workspaceId?: string | null): MultiremiSquad[] {
    const rows = workspaceId
      ? this.db.query(squadSelect("WHERE s.workspace_id = ? AND s.archived_at IS NULL ORDER BY s.updated_at DESC")).all(workspaceId) as Row[]
      : this.db.query(squadSelect("WHERE s.archived_at IS NULL ORDER BY s.updated_at DESC")).all() as Row[];
    return rows.map(toSquad);
  }

  resolveAssigneeRef(
    assigneeType: MultiremiAssigneeType | null | undefined,
    assigneeId: string | null | undefined,
    workspaceId?: string | null,
  ): { assigneeType: MultiremiAssigneeType; assigneeId: string } | null {
    const ref = assigneeId?.trim();
    if (!assigneeType && !ref) return null;
    if (!ref) throw new Error("Assignee id is required when assignee type is provided");
    const normalizedType = assigneeType ?? inferAssigneeTypeFromRef(ref);
    const types: MultiremiAssigneeType[] = normalizedType ? [normalizedType] : ["agent", "member", "squad"];
    const matches: Array<{ assigneeType: MultiremiAssigneeType; assigneeId: string }> = [];
    for (const type of types) {
      const entity = type === "agent"
        ? this.getAgentByRef(ref, workspaceId)
        : type === "member"
          ? this.getWorkspaceMemberByRef(ref, workspaceId)
          : this.getSquadByRef(ref, workspaceId);
      if (entity) matches.push({ assigneeType: type, assigneeId: entity.id });
    }
    const unique = uniqueBy(matches, (match) => `${match.assigneeType}:${match.assigneeId}`);
    if (unique.length === 1) return unique[0]!;
    if (unique.length > 1) throw new Error(`Ambiguous assignee reference: ${ref}`);
    if (normalizedType) throw new Error(`${capitalizeAssigneeType(normalizedType)} not found: ${ref}`);
    throw new Error(`Assignee not found: ${ref}`);
  }

  updateSquad(id: string, input: UpdateSquadInput): MultiremiSquad {
    const current = this.getSquad(id);
    if (!current) throw new Error(`Squad not found: ${id}`);
    if (input.leaderId && !this.getAgent(input.leaderId)) throw new Error(`Agent not found: ${input.leaderId}`);
    const now = nowIso();
    this.db.run(
      `UPDATE multiremi_squads SET
        name = ?,
        description = ?,
        instructions = ?,
        leader_id = ?,
        updated_at = ?
       WHERE id = ?`,
      [
        input.name ?? current.name,
        input.description === undefined ? current.description : input.description ?? "",
        input.instructions === undefined ? current.instructions : input.instructions ?? "",
        input.leaderId === undefined ? current.leaderId : input.leaderId,
        now,
        id,
      ],
    );
    if (input.leaderId) this.addSquadMember(id, { memberType: "agent", memberId: input.leaderId, role: "leader" });
    return this.getSquad(id)!;
  }

  archiveSquad(id: string): MultiremiSquad {
    if (!this.getSquad(id)) throw new Error(`Squad not found: ${id}`);
    const now = nowIso();
    this.db.run("UPDATE multiremi_squads SET archived_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
    return this.getSquad(id)!;
  }

  addSquadMember(squadId: string, input: AddSquadMemberInput): MultiremiSquadMember {
    const squad = this.getSquad(squadId);
    if (!squad) throw new Error(`Squad not found: ${squadId}`);
    if (input.memberType === "agent") {
      const agent = this.getAgent(input.memberId);
      if (!agent) throw new Error(`Agent not found: ${input.memberId}`);
      if (agent.archivedAt) throw new Error(`Agent is archived: ${input.memberId}`);
    } else if (input.memberType === "member") {
      const member = this.getWorkspaceMember(input.memberId);
      if (!member) throw new Error(`Member not found: ${input.memberId}`);
      if (member.archivedAt) throw new Error(`Member is archived: ${input.memberId}`);
    }
    const now = nowIso();
    const existing = this.db.query(
      "SELECT * FROM multiremi_squad_members WHERE squad_id = ? AND member_type = ? AND member_id = ?",
    ).get(squadId, input.memberType, input.memberId) as Row | null;
    if (existing) {
      this.db.run(
        "UPDATE multiremi_squad_members SET role = ? WHERE id = ?",
        [input.role ?? "member", String(existing.id)],
      );
      return this.getSquadMember(String(existing.id))!;
    }
    const id = createId("sqm");
    this.db.run(
      `INSERT INTO multiremi_squad_members (id, squad_id, member_type, member_id, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, squadId, input.memberType, input.memberId, input.role ?? "member", now],
    );
    this.db.run("UPDATE multiremi_squads SET updated_at = ? WHERE id = ?", [now, squadId]);
    return this.getSquadMember(id)!;
  }

  removeSquadMember(squadId: string, input: RemoveSquadMemberInput): void {
    const now = nowIso();
    this.db.run(
      "DELETE FROM multiremi_squad_members WHERE squad_id = ? AND member_type = ? AND member_id = ?",
      [squadId, input.memberType, input.memberId],
    );
    const squad = this.getSquad(squadId);
    if (squad?.leaderId === input.memberId && input.memberType === "agent") {
      this.db.run("UPDATE multiremi_squads SET leader_id = NULL, updated_at = ? WHERE id = ?", [now, squadId]);
    } else {
      this.db.run("UPDATE multiremi_squads SET updated_at = ? WHERE id = ?", [now, squadId]);
    }
  }

  getSquadMember(id: string): MultiremiSquadMember | null {
    const row = this.db.query("SELECT * FROM multiremi_squad_members WHERE id = ?").get(id) as Row | null;
    return row ? toSquadMember(row) : null;
  }

  listSquadMembers(squadId: string): MultiremiSquadMember[] {
    const rows = this.db.query(
      "SELECT * FROM multiremi_squad_members WHERE squad_id = ? ORDER BY role = 'leader' DESC, created_at ASC",
    ).all(squadId) as Row[];
    return rows.map(toSquadMember);
  }

  private recordAnalyticsEvent(
    name: string,
    distinctId: string,
    workspaceId: string | null,
    properties: Record<string, unknown>,
  ): MultiremiAnalyticsEvent {
    const event: MultiremiAnalyticsEvent = {
      id: createId("ane"),
      name,
      distinctId,
      workspaceId,
      properties: { ...properties },
      metricsOnly: METRICS_ONLY_EVENTS.has(name),
      createdAt: nowIso(),
    };
    this.analyticsEvents.push(event);
    this.incrementMetricForAnalyticsEvent(event);
    return event;
  }

  private incrementMetricForAnalyticsEvent(event: MultiremiAnalyticsEvent): void {
    switch (event.name) {
      case EVENT_RUNTIME_REGISTERED:
        this.incrementMetricCounter(METRIC_RUNTIME_REGISTERED, {
          runtime_mode: normalizeRuntimeModeLabel(stringProp(event.properties, "runtime_mode")),
          provider: normalizeRuntimeProviderLabel(stringProp(event.properties, "provider")),
        });
        break;
      case EVENT_RUNTIME_READY: {
        const runtimeMode = normalizeRuntimeModeLabel(stringProp(event.properties, "runtime_mode"));
        const provider = normalizeRuntimeProviderLabel(stringProp(event.properties, "provider"));
        this.incrementMetricCounter(METRIC_RUNTIME_READY, { runtime_mode: runtimeMode, provider });
        break;
      }
      case EVENT_RUNTIME_FAILED:
        this.incrementMetricCounter(METRIC_RUNTIME_FAILED, {
          runtime_mode: normalizeRuntimeModeLabel(stringProp(event.properties, "runtime_mode")),
          provider: normalizeRuntimeProviderLabel(stringProp(event.properties, "provider")),
          failure_reason: normalizeFailureReasonLabel(stringProp(event.properties, "failure_reason")),
          recoverable: boolMetricLabel(Boolean(event.properties.recoverable)),
        });
        break;
      case EVENT_RUNTIME_OFFLINE:
        this.incrementMetricCounter(METRIC_RUNTIME_OFFLINE, {
          runtime_mode: normalizeRuntimeModeLabel(stringProp(event.properties, "runtime_mode")),
          provider: normalizeRuntimeProviderLabel(stringProp(event.properties, "provider")),
        });
        break;
      case EVENT_AGENT_CREATED:
        this.incrementMetricCounter(METRIC_AGENT_CREATED, {
          runtime_mode: normalizeRuntimeModeLabel(stringProp(event.properties, "runtime_mode")),
          source: normalizeAnalyticsSourceLabel(stringProp(event.properties, "source")),
        });
        break;
      case EVENT_AUTOPILOT_CREATED:
        this.incrementMetricCounter(METRIC_AUTOPILOT_CREATED, {
          cadence: normalizeAutopilotCadenceLabel(stringProp(event.properties, "cadence")),
        });
        break;
      case EVENT_AUTOPILOT_RUN_STARTED:
        this.incrementMetricCounter(METRIC_AUTOPILOT_RUN_STARTED, {
          cadence: normalizeAutopilotCadenceLabel(stringProp(event.properties, "cadence")),
          trigger_kind: normalizeAutopilotTriggerLabel(stringProp(event.properties, "trigger_kind")),
        });
        break;
      case EVENT_AUTOPILOT_RUN_COMPLETED:
        this.incrementMetricCounter(METRIC_AUTOPILOT_RUN_TERMINAL, {
          cadence: normalizeAutopilotCadenceLabel(stringProp(event.properties, "cadence")),
          trigger_kind: normalizeAutopilotTriggerLabel(stringProp(event.properties, "trigger_kind")),
          terminal_status: "completed",
        });
        break;
      case EVENT_AUTOPILOT_RUN_FAILED:
        this.incrementMetricCounter(METRIC_AUTOPILOT_RUN_TERMINAL, {
          cadence: normalizeAutopilotCadenceLabel(stringProp(event.properties, "cadence")),
          trigger_kind: normalizeAutopilotTriggerLabel(stringProp(event.properties, "trigger_kind")),
          terminal_status: "failed",
        });
        break;
    }
  }

  private incrementMetricCounter(name: string, labels: Record<string, string>): void {
    const key = metricCounterKey(name, labels);
    const current = this.metricCounters.get(key);
    if (current) {
      current.value += 1;
      return;
    }
    this.metricCounters.set(key, { name, labels: { ...labels }, value: 1 });
  }

  private recordRuntimeRegisteredAnalytics(runtime: MultiremiRuntime): void {
    const ownerId = runtime.ownerId ?? "";
    this.recordAnalyticsEvent(
      EVENT_RUNTIME_REGISTERED,
      runtimeDistinctId(ownerId, runtime.workspaceId),
      runtime.workspaceId,
      runtimeAnalyticsProperties(runtime, {
        runtime_version: stringMetadata(runtime.metadata, "version"),
        cli_version: stringMetadata(runtime.metadata, "cli_version"),
      }),
    );
  }

  private recordRuntimeReadyAnalytics(runtime: MultiremiRuntime, readyDurationMs: number): void {
    const ownerId = runtime.ownerId ?? "";
    this.recordAnalyticsEvent(
      EVENT_RUNTIME_READY,
      runtimeDistinctId(ownerId, runtime.workspaceId),
      runtime.workspaceId,
      runtimeAnalyticsProperties(runtime, readyDurationMs > 0 ? { ready_duration_ms: readyDurationMs } : {}),
    );
  }

  private recordRuntimeOfflineAnalytics(runtime: MultiremiRuntime): void {
    const ownerId = runtime.ownerId ?? "";
    this.recordAnalyticsEvent(
      EVENT_RUNTIME_OFFLINE,
      runtimeDistinctId(ownerId, runtime.workspaceId),
      runtime.workspaceId,
      runtimeAnalyticsProperties(runtime),
    );
  }

  private recordAutopilotCreatedAnalytics(autopilot: MultiremiAutopilot): void {
    const actorId = autopilotActorId(autopilot);
    this.recordAnalyticsEvent(EVENT_AUTOPILOT_CREATED, actorId, autopilot.workspaceId, withAnalyticsCoreProperties({
      autopilot_id: autopilot.id,
      cadence: "manual",
      trigger_kind: "manual",
    }, {
      userId: nonAgentUserId(actorId),
      source: "manual",
    }));
  }

  private recordAutopilotRunStartedAnalytics(autopilot: MultiremiAutopilot, run: MultiremiAutopilotRun): void {
    const actorId = autopilotActorId(autopilot);
    const assignee = this.autopilotAssigneeAnalytics(autopilot);
    this.recordAnalyticsEvent(EVENT_AUTOPILOT_RUN_STARTED, actorId, autopilot.workspaceId, this.autopilotRunAnalyticsProperties({
      autopilot,
      run,
      actorId,
      assignee,
      triggerSource: run.source,
    }));
  }

  private recordAutopilotRunCompletedAnalytics(autopilot: MultiremiAutopilot, run: MultiremiAutopilotRun): void {
    const actorId = autopilotActorId(autopilot);
    const assignee = this.autopilotAssigneeAnalytics(autopilot);
    this.recordAnalyticsEvent(EVENT_AUTOPILOT_RUN_COMPLETED, actorId, autopilot.workspaceId, this.autopilotRunAnalyticsProperties({
      autopilot,
      run,
      actorId,
      assignee,
      triggerSource: run.source,
      extra: {
        duration_ms: autopilotRunDurationMs(run),
      },
    }));
  }

  private recordAutopilotRunFailedAnalytics(autopilot: MultiremiAutopilot, run: MultiremiAutopilotRun, reason: string): void {
    const actorId = autopilotActorId(autopilot);
    const assignee = this.autopilotAssigneeAnalytics(autopilot);
    this.recordAnalyticsEvent(EVENT_AUTOPILOT_RUN_FAILED, actorId, autopilot.workspaceId, this.autopilotRunAnalyticsProperties({
      autopilot,
      run,
      actorId,
      assignee,
      triggerSource: run.source,
      extra: {
        duration_ms: autopilotRunDurationMs(run),
        failure_reason: reason || "unknown",
        error_type: autopilotErrorType(reason || "unknown"),
        will_retry: false,
      },
    }));
  }

  private autopilotRunAnalyticsProperties(input: {
    autopilot: MultiremiAutopilot;
    run: MultiremiAutopilotRun;
    actorId: string;
    assignee: { agentId: string; assigneeType: string; squadId: string };
    triggerSource: string;
    extra?: Record<string, unknown>;
  }): Record<string, unknown> {
    const props: Record<string, unknown> = {
      ...(input.extra ?? {}),
      trigger_source: input.triggerSource,
      trigger_kind: input.triggerSource,
    };
    if (input.triggerSource) props.cadence = input.triggerSource;
    const withCore = withAnalyticsCoreProperties(props, {
      userId: nonAgentUserId(input.actorId),
      agentId: input.assignee.agentId,
      autopilotRunId: input.run.id,
      source: "autopilot",
    });
    withCore.autopilot_id = input.autopilot.id;
    if (input.assignee.assigneeType) withCore.assignee_type = input.assignee.assigneeType;
    if (input.assignee.squadId) withCore.squad_id = input.assignee.squadId;
    return withCore;
  }

  private autopilotAssigneeAnalytics(autopilot: MultiremiAutopilot): { agentId: string; assigneeType: string; squadId: string } {
    if (autopilot.assigneeType === "squad") {
      return {
        agentId: this.resolveAutopilotAgent(autopilot)?.id ?? autopilot.assigneeId,
        assigneeType: "squad",
        squadId: autopilot.assigneeId,
      };
    }
    return {
      agentId: autopilot.assigneeId,
      assigneeType: "agent",
      squadId: "",
    };
  }

  private recordWebhookDeliveryMetric(delivery: MultiremiWebhookDelivery): void {
    this.incrementMetricCounter(METRIC_WEBHOOK_DELIVERY, {
      provider: normalizeWebhookProviderLabel(delivery.provider),
      status: normalizeWebhookDeliveryStatusLabel(delivery.status),
    });
  }

  createAutopilot(input: CreateAutopilotInput): MultiremiAutopilot {
    if (!input.title?.trim()) throw new Error("Autopilot title is required");
    const assigneeType = input.assigneeType ?? input.assignee_type ?? "agent";
    const assigneeId = input.assigneeId ?? input.assignee_id;
    if (!assigneeId) throw new Error("Autopilot assignee is required");
    if (assigneeType === "agent" && !this.getAgent(assigneeId)) throw new Error(`Agent not found: ${assigneeId}`);
    if (assigneeType === "squad" && !this.getSquad(assigneeId)) throw new Error(`Squad not found: ${assigneeId}`);
    const projectId = input.projectId ?? input.project_id ?? null;
    if (projectId && !this.getProject(projectId)) throw new Error(`Project not found: ${projectId}`);
    const workspaceId = input.workspaceId ?? input.workspace_id ?? "local";
    const createdByType = normalizeAutopilotCreatorType(input.createdByType ?? input.created_by_type);
    const createdById = cleanOptionalString(input.createdById ?? input.created_by_id) ?? "local";
    const id = input.id ?? createId("aut");
    const now = nowIso();
    this.db.run(
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
    this.recordAutopilotCreatedAnalytics(autopilot);
    return autopilot;
  }

  getAutopilot(id: string): MultiremiAutopilot | null {
    const row = this.db.query("SELECT * FROM multiremi_autopilots WHERE id = ?").get(id) as Row | null;
    return row ? toAutopilot(row) : null;
  }

  listAutopilots(workspaceId?: string | null): MultiremiAutopilot[] {
    const rows = workspaceId
      ? this.db.query("SELECT * FROM multiremi_autopilots WHERE workspace_id = ? AND status != 'archived' ORDER BY updated_at DESC").all(workspaceId) as Row[]
      : this.db.query("SELECT * FROM multiremi_autopilots WHERE status != 'archived' ORDER BY updated_at DESC").all() as Row[];
    return rows.map(toAutopilot);
  }

  updateAutopilot(id: string, input: UpdateAutopilotInput): MultiremiAutopilot {
    const current = this.getAutopilot(id);
    if (!current) throw new Error(`Autopilot not found: ${id}`);
    const nextAssigneeType = input.assigneeType ?? current.assigneeType;
    const nextAssigneeId = input.assigneeId ?? current.assigneeId;
    if (nextAssigneeType === "agent" && !this.getAgent(nextAssigneeId)) throw new Error(`Agent not found: ${nextAssigneeId}`);
    if (nextAssigneeType === "squad" && !this.getSquad(nextAssigneeId)) throw new Error(`Squad not found: ${nextAssigneeId}`);
    if (input.projectId && !this.getProject(input.projectId)) throw new Error(`Project not found: ${input.projectId}`);
    const now = nowIso();
    this.db.run(
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
    const rows = this.db.query(
      "SELECT * FROM multiremi_autopilot_triggers WHERE autopilot_id = ? ORDER BY created_at ASC",
    ).all(autopilotId) as Row[];
    return rows.map(toAutopilotTrigger);
  }

  getAutopilotTrigger(id: string): MultiremiAutopilotTrigger | null {
    const row = this.db.query("SELECT * FROM multiremi_autopilot_triggers WHERE id = ?").get(id) as Row | null;
    return row ? toAutopilotTrigger(row) : null;
  }

  getAutopilotTriggerSigningSecret(id: string): string | null {
    const row = this.db.query("SELECT signing_secret_hash FROM multiremi_autopilot_triggers WHERE id = ?").get(id) as Row | null;
    const secret = nullableString(row?.signing_secret_hash);
    return secret && secret !== "local-secret-set" ? secret : null;
  }

  getAutopilotTriggerByWebhookToken(token: string): MultiremiAutopilotTrigger | null {
    const row = this.db.query("SELECT * FROM multiremi_autopilot_triggers WHERE webhook_token = ?").get(token) as Row | null;
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
    this.db.run(
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
    this.db.run(
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
    this.db.run(
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
    this.db.run(
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
    const result = this.db.run("DELETE FROM multiremi_autopilot_triggers WHERE id = ? AND autopilot_id = ?", [triggerId, autopilotId]);
    return result.changes > 0;
  }

  rotateAutopilotTriggerWebhookToken(autopilotId: string, triggerId: string): MultiremiAutopilotTrigger {
    const current = this.getAutopilotTrigger(triggerId);
    if (!current || current.autopilotId !== autopilotId) throw new Error(`Autopilot trigger not found: ${triggerId}`);
    const token = createId("awt", 18);
    this.db.run(
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
    this.db.run(
      "UPDATE multiremi_autopilot_triggers SET signing_secret_hash = ?, signing_secret_hint = ?, updated_at = ? WHERE id = ?",
      [signingSecret, hint, nowIso(), triggerId],
    );
    return this.getAutopilotTrigger(triggerId)!;
  }

  claimDueScheduleTriggers(now: Date = new Date()): MultiremiAutopilotTrigger[] {
    const dueAt = now.toISOString();
    const rows = this.db.query(
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
    this.db.run(
      "UPDATE multiremi_autopilot_triggers SET next_run_at = ?, last_fired_at = ?, updated_at = ? WHERE id = ?",
      [nextRunAt, now, now, triggerId],
    );
    return this.getAutopilotTrigger(triggerId);
  }

  recoverLostScheduleTriggers(now: Date = new Date()): number {
    const rows = this.db.query(
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
      this.db.run("UPDATE multiremi_autopilot_triggers SET next_run_at = ?, updated_at = ? WHERE id = ?", [nextRunAt, nowIso(), trigger.id]);
      recovered += 1;
    }
    return recovered;
  }

  listAutopilotRuns(autopilotId: string): MultiremiAutopilotRun[] {
    const rows = this.db.query(
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
    const rows = this.db.query(
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
    const result = this.db.run(
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
      this.emitWorkspaceEvent({
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
      this.createInboxItem({
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
      const member = this.resolveWorkspaceMemberForNotification(autopilot.workspaceId, autopilot.createdById);
      return member ? [member.id] : [];
    }
    const agent = this.getAgent(autopilot.createdById);
    if (!agent?.ownerId) return [];
    const owner = this.resolveWorkspaceMemberForNotification(autopilot.workspaceId, agent.ownerId);
    return owner ? [owner.id] : [];
  }

  runAutopilot(autopilotId: string, input: RunAutopilotInput = {}): MultiremiAutopilotRun {
    const autopilot = this.getAutopilot(autopilotId);
    if (!autopilot) throw new Error(`Autopilot not found: ${autopilotId}`);
    const now = nowIso();
    const runId = createId("run");
    const source = input.source ?? "manual";
    const prompt = (input.prompt || autopilot.issueTitleTemplate || autopilot.title).trim();
    const agent = this.resolveAutopilotAgent(autopilot);
    if (!agent || autopilot.status !== "active") {
      this.db.run(
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
      this.db.run("UPDATE multiremi_autopilots SET last_run_at = ?, updated_at = ? WHERE id = ?", [now, now, autopilotId]);
      return this.getAutopilotRun(runId)!;
    }

    let issue: MultiremiIssue | null = null;
    if (autopilot.executionMode === "create_issue") {
      issue = this.createIssue({
        title: prompt,
        description: autopilot.description,
        workspaceId: autopilot.workspaceId,
        projectId: autopilot.projectId,
        createdBy: autopilot.id,
      });
    }
    const task = this.createTask({
      agentId: agent.id,
      issueId: issue?.id ?? null,
      workspaceId: autopilot.workspaceId,
      prompt,
    });
    this.db.run(
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
    this.db.run("UPDATE multiremi_autopilots SET last_run_at = ?, updated_at = ? WHERE id = ?", [now, now, autopilotId]);
    const run = this.getAutopilotRun(runId)!;
    this.recordAutopilotRunStartedAnalytics(autopilot, run);
    return run;
  }

  getAutopilotRun(id: string): MultiremiAutopilotRun | null {
    const row = this.db.query("SELECT * FROM multiremi_autopilot_runs WHERE id = ?").get(id) as Row | null;
    return row ? toAutopilotRun(row) : null;
  }

  listWebhookDeliveries(autopilotId: string, options: { includeRawBody?: boolean; limit?: number } = {}): MultiremiWebhookDelivery[] {
    const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 20)));
    const rawBodyColumn = options.includeRawBody ? "raw_body" : "NULL AS raw_body";
    const rows = this.db.query(
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
    const row = this.db.query("SELECT * FROM multiremi_webhook_deliveries WHERE id = ?").get(id) as Row | null;
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
      const duplicate = this.db.query(
        `SELECT * FROM multiremi_webhook_deliveries
         WHERE trigger_id = ? AND dedupe_key = ? AND status NOT IN ('rejected', 'failed')
         ORDER BY created_at ASC LIMIT 1`,
      ).get(triggerId, dedupeKey) as Row | null;
      if (duplicate) {
        this.db.run(
          "UPDATE multiremi_webhook_deliveries SET attempt_count = attempt_count + 1, last_attempt_at = ? WHERE id = ?",
          [now, String(duplicate.id)],
        );
        const delivery = this.getWebhookDelivery(String(duplicate.id))!;
        const run = delivery.autopilotRunId ? this.getAutopilotRun(delivery.autopilotRunId) : null;
        return { status: "duplicate", duplicate: true, delivery, run };
      }
    }

    const deliveryId = createId("whd");
    this.db.run(
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
        this.db.run("UPDATE multiremi_autopilot_triggers SET last_fired_at = ?, updated_at = ? WHERE id = ?", [now, now, trigger.id]);
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
    this.db.run(
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
    this.recordWebhookDeliveryMetric(delivery);
    return delivery;
  }

  createChatSession(input: CreateChatSessionInput): MultiremiChatSession {
    const agentId = input.agentId ?? input.agent_id;
    if (!agentId) throw new Error("agent_id is required");
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    if (agent.archivedAt) throw new Error(`Agent is archived: ${agentId}`);
    const workspaceId = input.workspaceId ?? input.workspace_id ?? "local";
    if (agent.workspaceId !== workspaceId) throw new Error("Agent belongs to another workspace");
    const id = input.id ?? createId("chat");
    const now = nowIso();
    const title = input.title?.trim() || `Chat with ${agent.name}`;
    this.db.run(
      `INSERT INTO multiremi_chat_sessions (
        id, workspace_id, creator_id, agent_id, title, status, session_id, work_dir, latest_task_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', NULL, NULL, NULL, ?, ?)`,
      [id, workspaceId, input.creatorId ?? input.creator_id ?? "local", agentId, title, now, now],
    );
    return this.getChatSession(id)!;
  }

  listChatSessions(workspaceId?: string | null, options: { creatorId?: string | null; includeArchived?: boolean } = {}): MultiremiChatSession[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (workspaceId) {
      clauses.push("workspace_id = ?");
      params.push(workspaceId);
    }
    if (options.creatorId) {
      clauses.push("creator_id = ?");
      params.push(options.creatorId);
    }
    if (!options.includeArchived) {
      clauses.push("status != 'archived'");
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.query(`SELECT * FROM multiremi_chat_sessions ${where} ORDER BY updated_at DESC`).all(...params) as Row[];
    return rows.map(toChatSession);
  }

  getChatSession(id: string): MultiremiChatSession | null {
    const row = this.db.query("SELECT * FROM multiremi_chat_sessions WHERE id = ?").get(id) as Row | null;
    return row ? toChatSession(row) : null;
  }

  updateChatSession(id: string, input: UpdateChatSessionInput): MultiremiChatSession {
    const current = this.getChatSession(id);
    if (!current) throw new Error(`Chat session not found: ${id}`);
    const now = nowIso();
    this.db.run(
      `UPDATE multiremi_chat_sessions
       SET title = ?, status = ?, updated_at = ?
       WHERE id = ?`,
      [input.title?.trim() || current.title, input.status ?? current.status, now, id],
    );
    const updated = this.getChatSession(id)!;
    this.emitChatEvent(updated, "chat:session_updated", {
      title: updated.title,
      updated_at: updated.updatedAt,
    });
    return updated;
  }

  deleteChatSession(id: string): boolean {
    const current = this.getChatSession(id);
    if (!current) return false;
    for (const task of this.listTasks().filter((task) => task.chatSessionId === id)) {
      if (isActiveTaskStatus(task.status)) {
        this.cancelTask(task.id);
      }
    }
    this.db.run("UPDATE multiremi_tasks SET chat_session_id = NULL WHERE chat_session_id = ?", [id]);
    this.db.run("DELETE FROM multiremi_attachments WHERE chat_session_id = ?", [id]);
    this.db.run("DELETE FROM multiremi_chat_messages WHERE chat_session_id = ?", [id]);
    const result = this.db.run("DELETE FROM multiremi_chat_sessions WHERE id = ?", [id]);
    if (result.changes > 0) {
      this.emitChatEvent(current, "chat:session_deleted", {});
    }
    return result.changes > 0;
  }

  markChatSessionRead(id: string): void {
    const session = this.getChatSession(id);
    if (!session) throw new Error(`Chat session not found: ${id}`);
    this.db.run("UPDATE multiremi_chat_sessions SET unread_since = NULL WHERE id = ?", [id]);
    this.emitChatEvent(session, "chat:session_read", {});
  }

  getPendingChatTask(chatSessionId: string): MultiremiTask | null {
    if (!this.getChatSession(chatSessionId)) throw new Error(`Chat session not found: ${chatSessionId}`);
    return this.listTasks()
      .filter((task) =>
        task.chatSessionId === chatSessionId &&
        isActiveTaskStatus(task.status)
      )
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] ?? null;
  }

  listPendingChatTasks(workspaceId?: string | null, options: { creatorId?: string | null } = {}): MultiremiTask[] {
    return this.listTasks()
      .filter((task) =>
        task.chatSessionId &&
        (workspaceId ? task.workspaceId === workspaceId : true) &&
        (options.creatorId ? this.getChatSession(task.chatSessionId)?.creatorId === options.creatorId : true) &&
        isActiveTaskStatus(task.status)
      )
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  }

  listChatMessages(chatSessionId: string): MultiremiChatMessage[] {
    if (!this.getChatSession(chatSessionId)) throw new Error(`Chat session not found: ${chatSessionId}`);
    const rows = this.db.query(
      "SELECT * FROM multiremi_chat_messages WHERE chat_session_id = ? ORDER BY created_at ASC",
    ).all(chatSessionId) as Row[];
    return rows.map(toChatMessage);
  }

  sendChatMessage(chatSessionId: string, input: SendChatMessageInput): SendChatMessageResult {
    const session = this.getChatSession(chatSessionId);
    if (!session) throw new Error(`Chat session not found: ${chatSessionId}`);
    if (session.status === "archived") throw new Error(`Chat session is archived: ${chatSessionId}`);
    const body = (input.body ?? input.content)?.trim();
    if (!body) throw new Error("Chat message body is required");
    const now = nowIso();
    const messageId = createId("msg");
    const task = this.createTask({
      agentId: session.agentId,
      chatSessionId: session.id,
      workspaceId: session.workspaceId,
      prompt: body,
      sessionId: session.sessionId,
      workDir: session.workDir,
    });
    this.db.run(
      `INSERT INTO multiremi_chat_messages (id, chat_session_id, task_id, role, body, created_at)
       VALUES (?, ?, ?, 'user', ?, ?)`,
      [messageId, session.id, task.id, body, now],
    );
    const attachmentIds = input.attachmentIds ?? input.attachment_ids ?? [];
    if (attachmentIds.length) this.linkAttachmentsToChatMessage(session.id, messageId, attachmentIds);
    this.db.run(
      "UPDATE multiremi_chat_sessions SET latest_task_id = ?, updated_at = ? WHERE id = ?",
      [task.id, now, session.id],
    );
    const result = {
      session: this.getChatSession(session.id)!,
      message: this.getChatMessage(messageId)!,
      task,
    };
    this.emitChatEvent(result.session, "chat:message", {
      message_id: result.message.id,
      role: "user",
      content: body,
      task_id: task.id,
      created_at: result.message.createdAt,
    });
    return result;
  }

  getChatMessage(id: string): MultiremiChatMessage | null {
    const row = this.db.query("SELECT * FROM multiremi_chat_messages WHERE id = ?").get(id) as Row | null;
    return row ? toChatMessage(row) : null;
  }

  createTask(input: CreateTaskInput): MultiremiTask {
    const agent = this.getAgent(input.agentId);
    if (!agent) throw new Error(`Agent not found: ${input.agentId}`);
    if (agent.archivedAt) throw new Error(`Agent is archived: ${input.agentId}`);
    const triggerCommentId = cleanOptionalString(input.triggerCommentId ?? input.trigger_comment_id);
    const triggerComment = triggerCommentId ? this.getRawIssueComment(triggerCommentId) : null;
    if (triggerCommentId && !triggerComment) throw new Error(`Comment not found: ${triggerCommentId}`);
    const issueId = input.issueId ?? triggerComment?.issueId ?? null;
    const issue = issueId ? this.getIssue(issueId) : null;
    if (issueId && !issue) throw new Error(`Issue not found: ${issueId}`);
    if (triggerComment && issue && triggerComment.issueId !== issue.id) throw new Error("Trigger comment does not belong to task issue");
    const chatSession = input.chatSessionId ? this.getChatSession(input.chatSessionId) : null;
    if (input.chatSessionId && !chatSession) throw new Error(`Chat session not found: ${input.chatSessionId}`);
    if (chatSession && chatSession.agentId !== input.agentId) throw new Error("Chat session agent does not match task agent");
    const runtimeId = resolveOptionalStringField(input, "runtimeId", "runtime_id", agent.runtimeId);
    if (runtimeId && !this.getRuntime(runtimeId)) throw new Error(`Runtime not found: ${runtimeId}`);

    const id = input.id ?? createId("tsk");
    const now = nowIso();
    const attempt = normalizePositiveInt(input.attempt, 1);
    const maxAttempts = Math.max(attempt, normalizePositiveInt(input.maxAttempts, 3));
    const triggerSummary = normalizeTriggerSummary(input.triggerSummary ?? input.trigger_summary ?? triggerComment?.body ?? null);
    this.db.run(
      `INSERT INTO multiremi_tasks (
        id, agent_id, runtime_id, issue_id, chat_session_id, trigger_comment_id, trigger_summary, workspace_id, status, priority, prompt,
        attempt, max_attempts, parent_task_id, session_id, work_dir, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.agentId,
        runtimeId,
        issueId,
        input.chatSessionId ?? null,
        triggerCommentId,
        triggerSummary,
        input.workspaceId ?? issue?.workspaceId ?? chatSession?.workspaceId ?? "local",
        input.priority ?? 0,
        input.prompt,
        attempt,
        maxAttempts,
        cleanOptionalString(input.parentTaskId ?? input.parent_task_id),
        input.sessionId ?? chatSession?.sessionId ?? null,
        input.workDir ?? chatSession?.workDir ?? agent.cwd ?? null,
        now,
        now,
      ],
    );
    const task = this.getTask(id)!;
    this.notifyTaskEnqueued(task);
    return task;
  }

  getTask(id: string): MultiremiTask | null {
    const row = this.db.query("SELECT * FROM multiremi_tasks WHERE id = ?").get(id) as Row | null;
    return row ? this.withTaskAutopilotRun(toTask(row)) : null;
  }

  getTaskByRef(ref: string, input: { issueId?: string | null } = {}): MultiremiTask | null {
    const value = ref.trim();
    if (!value) return null;
    const exact = this.getTask(value);
    if (exact && (!input.issueId || exact.issueId === input.issueId)) return exact;
    if (!/^tsk_[a-z0-9_]+$/i.test(value)) return null;
    const rows = input.issueId
      ? this.db.query("SELECT * FROM multiremi_tasks WHERE issue_id = ? AND id LIKE ? ORDER BY created_at DESC").all(input.issueId, `${value}%`) as Row[]
      : this.db.query("SELECT * FROM multiremi_tasks WHERE id LIKE ? ORDER BY created_at DESC").all(`${value}%`) as Row[];
    if (rows.length !== 1) return null;
    return this.withTaskAutopilotRun(toTask(rows[0]!));
  }

  getTaskWithAgent(id: string): MultiremiTaskWithAgent | null {
    const task = this.getTask(id);
    if (!task) return null;
    const issue = task.issueId ? this.getIssue(task.issueId) : null;
    const project = issue?.projectId ? this.getProject(issue.projectId) : null;
    const projectResources = project ? this.listProjectResources(project.id) : [];
    return {
      ...task,
      agent: this.getAgent(task.agentId),
      issue,
      project,
      projectResources,
      repos: this.resolveTaskRepos(task.workspaceId, projectResources),
    };
  }

  getTaskTriggerMetadata(task: MultiremiTask): MultiremiTaskTriggerMetadata | null {
    if (!task.triggerCommentId) return null;
    const comment = this.getRawIssueComment(task.triggerCommentId);
    if (!comment) return null;

    const lastStartedAt = this.getLastTaskStartedAtForIssueAndAgent(task.issueId ?? comment.issueId, task.agentId, task.id);
    const newCommentCount = lastStartedAt
      ? this.countNewCommentsSince(comment.issueId, lastStartedAt, comment.id, task.agentId)
      : 0;
    return {
      triggerThreadId: this.getThreadRootCommentId(comment),
      triggerCommentContent: comment.body,
      triggerAuthorType: comment.authorType,
      triggerAuthorName: this.getCommentAuthorName(comment),
      newCommentCount,
      newCommentsSince: newCommentCount > 0 ? lastStartedAt : null,
    };
  }

  private resolveTaskRepos(workspaceId: string, projectResources: MultiremiProjectResource[]): MultiremiRepoData[] {
    const ownProjectId = projectResources[0]?.projectId ?? null;
    const refs: Record<string, unknown>[] = [];
    const visited = new Set<string>();
    if (ownProjectId) visited.add(ownProjectId);
    // Own github_repo refs plus those of referenced projects, walked
    // recursively. The visited set is the real cycle defense (write-time
    // validation has a TOCTOU gap); dangling targets are silently skipped and
    // referenced projects' local_directory resources are never pulled.
    const collect = (resources: MultiremiProjectResource[], depth: number): void => {
      for (const resource of resources) {
        if (resource.resourceType === "github_repo") {
          refs.push(resource.resourceRef);
        } else if (resource.resourceType === "project_ref") {
          if (depth >= PROJECT_REF_MAX_DEPTH) continue;
          const targetId = String(resource.resourceRef.projectId ?? resource.resourceRef.project_id ?? "").trim();
          if (!targetId || visited.has(targetId)) continue;
          visited.add(targetId);
          if (!this.getProject(targetId)) continue;
          collect(this.listProjectResources(targetId), depth + 1);
        }
      }
    };
    collect(projectResources, 0);
    const projectRepos = normalizeRepos(refs);
    if (projectRepos.length) return projectRepos;
    return normalizeRepos(this.getWorkspace(workspaceId)?.repos ?? []);
  }

  listTasks(status?: MultiremiTaskStatus): MultiremiTask[] {
    const rows = status
      ? this.db.query("SELECT * FROM multiremi_tasks WHERE status = ? ORDER BY created_at DESC").all(status) as Row[]
      : this.db.query("SELECT * FROM multiremi_tasks ORDER BY created_at DESC").all() as Row[];
    return this.withTaskAutopilotRuns(rows.map(toTask));
  }

  listAgentTasks(agentId: string): MultiremiTask[] {
    if (!this.getAgent(agentId)) throw new Error(`Agent not found: ${agentId}`);
    const rows = this.db.query(
      "SELECT * FROM multiremi_tasks WHERE agent_id = ? ORDER BY created_at DESC",
    ).all(agentId) as Row[];
    return this.withTaskAutopilotRuns(rows.map(toTask));
  }

  listWorkspaceAgentTaskSnapshot(workspaceId = "local"): MultiremiTask[] {
    const tasks = this.listTasks().filter((task) => task.workspaceId === workspaceId);
    const snapshot = new Map<string, MultiremiTask>();
    for (const task of tasks) {
      if (isActiveTaskStatus(task.status)) {
        snapshot.set(task.id, task);
      }
    }
    const latestOutcomeByAgent = new Map<string, MultiremiTask>();
    for (const task of tasks.filter((item) => item.status === "completed" || item.status === "failed")) {
      const current = latestOutcomeByAgent.get(task.agentId);
      if (!current || outcomeTime(task) > outcomeTime(current)) latestOutcomeByAgent.set(task.agentId, task);
    }
    for (const task of latestOutcomeByAgent.values()) snapshot.set(task.id, task);
    return [...snapshot.values()].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }

  listWorkspaceAgentRunCounts(workspaceId = "local", days = 30): MultiremiAgentRunCount[] {
    const since = trailingWindowStart(days);
    const rows = this.db.query(
      `SELECT agent_id, COUNT(*) AS run_count
       FROM multiremi_tasks
       WHERE workspace_id = ? AND created_at > ?
       GROUP BY agent_id
       ORDER BY agent_id ASC`,
    ).all(workspaceId, since) as Row[];
    return rows.map((row) => {
      const agentId = String(row.agent_id);
      const runCount = Number(row.run_count ?? 0);
      return { agentId, agent_id: agentId, runCount, run_count: runCount };
    });
  }

  listWorkspaceAgentActivity30d(workspaceId = "local"): MultiremiAgentActivityBucket[] {
    const since = trailingWindowStart(30);
    const rows = this.db.query(
      `SELECT
         agent_id,
         substr(completed_at, 1, 10) AS bucket_date,
         COUNT(*) AS task_count,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count
       FROM multiremi_tasks
       WHERE workspace_id = ?
         AND completed_at IS NOT NULL
         AND completed_at > ?
       GROUP BY agent_id, bucket_date
       ORDER BY agent_id ASC, bucket_date ASC`,
    ).all(workspaceId, since) as Row[];
    return rows.map((row) => {
      const agentId = String(row.agent_id);
      const bucketAt = `${String(row.bucket_date)}T00:00:00.000Z`;
      const taskCount = Number(row.task_count ?? 0);
      const failedCount = Number(row.failed_count ?? 0);
      return {
        agentId,
        agent_id: agentId,
        bucketAt,
        bucket_at: bucketAt,
        taskCount,
        task_count: taskCount,
        failedCount,
        failed_count: failedCount,
      };
    });
  }

  claimTask(runtimeId: string): MultiremiTaskWithAgent | null {
    const tx = this.db.transaction(() => {
      const runtime = this.getRuntime(runtimeId);
      if (!runtime) throw new Error(`Runtime not found: ${runtimeId}`);
      this.heartbeatRuntime(runtimeId, { claimPending: false });

      const stale = this.reclaimStaleDispatchedTaskForRuntime(runtimeId);
      if (stale) return stale;

      return this.claimNextTaskForRuntime(runtime);
    });
    return tx();
  }

  private reclaimStaleDispatchedTaskForRuntime(runtimeId: string): MultiremiTaskWithAgent | null {
    const cutoff = new Date(Date.now() - CLAIM_RESPONSE_RECOVERY_MS).toISOString();
    const now = nowIso();
    const row = this.db.query(
      `UPDATE multiremi_tasks
       SET dispatched_at = ?, updated_at = ?
       WHERE id = (
         SELECT id
         FROM multiremi_tasks
         WHERE runtime_id = ?
           AND status = 'dispatched'
           AND started_at IS NULL
           AND dispatched_at IS NOT NULL
           AND dispatched_at < ?
         ORDER BY priority DESC, dispatched_at ASC
         LIMIT 1
       )
       AND status = 'dispatched'
       AND started_at IS NULL
       RETURNING *`,
    ).get(now, now, runtimeId, cutoff) as Row | null;
    if (!row) return null;
    return this.getTaskWithAgent(String(row.id));
  }

  private claimNextTaskForRuntime(runtime: MultiremiRuntime): MultiremiTaskWithAgent | null {
    const now = nowIso();
    const workspaceFilter = runtime.workspaceId ? "AND t.workspace_id = ?" : "";
    const params = runtime.workspaceId
      ? [
          runtime.id,
          now,
          now,
          runtime.id,
          runtime.maxConcurrency,
          runtime.workspaceId,
          runtime.id,
          runtime.id,
          runtime.provider,
          runtime.provider,
        ]
      : [
          runtime.id,
          now,
          now,
          runtime.id,
          runtime.maxConcurrency,
          runtime.id,
          runtime.id,
          runtime.provider,
          runtime.provider,
        ];
    const row = this.db.query(
      `UPDATE multiremi_tasks
       SET status = 'dispatched', runtime_id = ?, dispatched_at = ?, updated_at = ?
       WHERE id = (
         SELECT t.id
         FROM multiremi_tasks t
         JOIN multiremi_agents a ON a.id = t.agent_id
         WHERE t.status = 'queued'
           AND a.archived_at IS NULL
           AND (
             SELECT COUNT(*)
             FROM multiremi_tasks runtime_active
             WHERE runtime_active.runtime_id = ?
               AND runtime_active.status IN ('dispatched', 'running', 'waiting_local_directory', 'awaiting_human')
           ) < ?
           ${workspaceFilter}
           AND (t.runtime_id IS NULL OR t.runtime_id = ?)
           AND (a.runtime_id IS NULL OR a.runtime_id = ?)
           AND (? = 'any' OR a.provider = ?)
           AND (
             SELECT COUNT(*)
             FROM multiremi_tasks running
             WHERE running.agent_id = t.agent_id
               AND running.status IN ('dispatched', 'running', 'waiting_local_directory', 'awaiting_human')
           ) < a.max_concurrent_tasks
           AND NOT EXISTS (
             SELECT 1 FROM multiremi_tasks active
             WHERE active.agent_id = t.agent_id
               AND active.status IN ('dispatched', 'running', 'waiting_local_directory', 'awaiting_human')
               AND (
                 (t.issue_id IS NOT NULL AND active.issue_id = t.issue_id)
                 OR (t.chat_session_id IS NOT NULL AND active.chat_session_id = t.chat_session_id)
                 OR (
                   t.issue_id IS NULL
                   AND t.chat_session_id IS NULL
                   AND active.issue_id IS NULL
                   AND active.chat_session_id IS NULL
                 )
               )
           )
         ORDER BY t.priority DESC, t.created_at ASC
         LIMIT 1
       )
       AND status = 'queued'
       RETURNING *`,
    ).get(...params) as Row | null;
    if (!row) return null;

    const task = this.getTaskWithAgent(String(row.id));
    if (task) this.notifyTaskEvent("task:dispatch", task);
    return task;
  }

  startTask(taskId: string): MultiremiTask {
    const now = nowIso();
    const result = this.db.run(
      `UPDATE multiremi_tasks
       SET status = 'running', started_at = COALESCE(started_at, ?), wait_reason = NULL, updated_at = ?
       WHERE id = ? AND status IN ('dispatched', 'waiting_local_directory')`,
      [now, now, taskId],
    );
    if (result.changes === 0) throw new Error(`Task not found or not dispatched: ${taskId}`);
    const task = this.getTask(taskId)!;
    this.notifyTaskEvent("task:running", task);
    return task;
  }

  markTaskWaitingLocalDirectory(taskId: string, reason?: string | null): MultiremiTask {
    const cleanReason = cleanOptionalString(reason);
    const now = nowIso();
    const result = this.db.run(
      `UPDATE multiremi_tasks
       SET status = 'waiting_local_directory',
           wait_reason = ?,
           progress_summary = ?,
           updated_at = ?
       WHERE id = ? AND status = 'dispatched'`,
      [
        cleanReason,
        cleanReason ? `Waiting for local directory: ${cleanReason}` : "Waiting for local directory",
        now,
        taskId,
      ],
    );
    if (result.changes === 0) throw new Error(`Task not found or not dispatched: ${taskId}`);
    const task = this.getTask(taskId)!;
    this.notifyTaskEvent("task:waiting_local_directory", task);
    return task;
  }

  createTaskHumanRequest(input: CreateTaskHumanRequestInput): MultiremiTaskHumanRequest {
    const id = input.id ?? createId("hrq");
    const now = nowIso();
    this.db.run(
      `INSERT INTO multiremi_task_human_requests (id, task_id, kind, payload, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
      [id, input.taskId, input.kind, JSON.stringify(input.payload ?? {}), now],
    );
    const reason = input.kind === "permission" ? "Waiting for permission approval" : "Waiting for a human answer";
    const transition = this.db.run(
      `UPDATE multiremi_tasks
       SET status = 'awaiting_human', wait_reason = ?, progress_summary = ?, updated_at = ?
       WHERE id = ? AND status IN ('dispatched', 'running')`,
      [reason, reason, now, input.taskId],
    );
    if (transition.changes > 0) {
      const task = this.getTask(input.taskId);
      if (task) this.notifyTaskEvent("task:awaiting_human", task);
    }
    return this.getTaskHumanRequest(id)!;
  }

  getTaskHumanRequest(requestId: string): MultiremiTaskHumanRequest | null {
    const row = this.db.query("SELECT * FROM multiremi_task_human_requests WHERE id = ?").get(requestId) as Row | null;
    return row ? toTaskHumanRequest(row) : null;
  }

  listTaskHumanRequests(taskId: string): MultiremiTaskHumanRequest[] {
    const rows = this.db.query(
      "SELECT * FROM multiremi_task_human_requests WHERE task_id = ? ORDER BY created_at ASC, id ASC",
    ).all(taskId) as Row[];
    return rows.map(toTaskHumanRequest);
  }

  /** Atomic first-write-wins: returns null when the request is no longer pending. */
  respondTaskHumanRequest(
    requestId: string,
    input: { response: Record<string, unknown>; respondedBy?: string | null },
  ): MultiremiTaskHumanRequest | null {
    const now = nowIso();
    const result = this.db.run(
      `UPDATE multiremi_task_human_requests
       SET status = 'responded', response = ?, responded_by = ?, responded_at = ?
       WHERE id = ? AND status = 'pending'`,
      [JSON.stringify(input.response ?? {}), input.respondedBy ?? null, now, requestId],
    );
    if (result.changes === 0) return null;
    const request = this.getTaskHumanRequest(requestId)!;
    this.resumeTaskFromAwaitingHuman(request.taskId);
    return request;
  }

  /** Worker-initiated terminal transition (timeout, or task aborted while pending). */
  expireTaskHumanRequest(requestId: string, status: "timeout" | "cancelled"): MultiremiTaskHumanRequest | null {
    const result = this.db.run(
      `UPDATE multiremi_task_human_requests
       SET status = ?, responded_at = ?
       WHERE id = ? AND status = 'pending'`,
      [status, nowIso(), requestId],
    );
    if (result.changes === 0) return null;
    const request = this.getTaskHumanRequest(requestId)!;
    this.resumeTaskFromAwaitingHuman(request.taskId);
    return request;
  }

  private resumeTaskFromAwaitingHuman(taskId: string): void {
    const pending = this.db.query(
      "SELECT COUNT(*) AS n FROM multiremi_task_human_requests WHERE task_id = ? AND status = 'pending'",
    ).get(taskId) as { n: number } | null;
    if (pending && Number(pending.n) > 0) return;
    const result = this.db.run(
      `UPDATE multiremi_tasks
       SET status = 'running', wait_reason = NULL, updated_at = ?
       WHERE id = ? AND status = 'awaiting_human'`,
      [nowIso(), taskId],
    );
    if (result.changes > 0) {
      const task = this.getTask(taskId);
      if (task) this.notifyTaskEvent("task:running", task);
    }
  }

  reportProgress(taskId: string, summary: string, step?: number | null, total?: number | null): MultiremiTask {
    const result = this.db.run(
      `UPDATE multiremi_tasks
       SET progress_summary = ?, progress_step = ?, progress_total = ?, updated_at = ?
       WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled')`,
      [summary, step ?? null, total ?? null, nowIso(), taskId],
    );
    if (result.changes === 0) throw new Error(`Task not found or terminal: ${taskId}`);
    return this.getTask(taskId)!;
  }

  pinTaskSession(taskId: string, sessionId?: string | null, workDir?: string | null): MultiremiTask {
    if (!this.getTask(taskId)) throw new Error(`Task not found: ${taskId}`);
    this.db.run(
      `UPDATE multiremi_tasks
       SET session_id = COALESCE(?, session_id), work_dir = COALESCE(?, work_dir), updated_at = ?
       WHERE id = ? AND status IN ('dispatched', 'running')`,
      [sessionId ?? null, workDir ?? null, nowIso(), taskId],
    );
    return this.getTask(taskId)!;
  }

  appendTaskMessages(taskId: string, messages: TaskMessageInput[]): MultiremiTaskMessage[] {
    if (messages.length === 0) return [];
    if (!this.getTask(taskId)) throw new Error(`Task not found: ${taskId}`);
    const current = this.db.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM multiremi_task_messages WHERE task_id = ?")
      .get(taskId) as { seq: number } | null;
    let nextSeq = Number(current?.seq ?? 0) + 1;
    const insertedSeqs: number[] = [];
    const insert = this.db.prepare(
      `INSERT INTO multiremi_task_messages (
        id, task_id, seq, type, tool, content, input, output, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id, seq) DO UPDATE SET
        type = excluded.type,
        tool = excluded.tool,
        content = excluded.content,
        input = excluded.input,
        output = excluded.output`,
    );
    const tx = this.db.transaction(() => {
      for (const message of messages) {
        const seq = message.seq ?? nextSeq++;
        insertedSeqs.push(seq);
        const id = createId("msg");
        insert.run(
          id,
          taskId,
          seq,
          message.type,
          message.tool ?? null,
          message.content ?? null,
          message.input == null ? null : toJson(message.input),
          message.output ?? null,
          nowIso(),
        );
      }
      this.db.run("UPDATE multiremi_tasks SET updated_at = ? WHERE id = ?", [nowIso(), taskId]);
    });
    tx();
    const inserted: MultiremiTaskMessage[] = [];
    for (const seq of insertedSeqs) {
      const row = this.db.query(
        "SELECT * FROM multiremi_task_messages WHERE task_id = ? AND seq = ?",
      ).get(taskId, seq) as Row | null;
      if (row) inserted.push(toTaskMessage(row));
    }
    return inserted;
  }

  listTaskMessages(taskId: string, sinceSeq?: number | null): MultiremiTaskMessage[] {
    const since = sinceSeq == null ? null : Math.floor(Number(sinceSeq));
    const rows = since != null && Number.isFinite(since)
      ? this.db.query(
        "SELECT * FROM multiremi_task_messages WHERE task_id = ? AND seq > ? ORDER BY seq ASC",
      ).all(taskId, since) as Row[]
      : this.db.query(
        "SELECT * FROM multiremi_task_messages WHERE task_id = ? ORDER BY seq ASC",
      ).all(taskId) as Row[];
    return rows.map(toTaskMessage);
  }

  completeTask(taskId: string, input: {
    output: string;
    branchName?: string | null;
    sessionId?: string | null;
    workDir?: string | null;
  }): MultiremiTask {
    const now = nowIso();
    const storedResult = toJson(taskCompletionResultPayload(input));
    const result = this.db.run(
      `UPDATE multiremi_tasks
       SET status = 'completed',
           result = ?,
           branch_name = ?,
           session_id = COALESCE(?, session_id),
           work_dir = COALESCE(?, work_dir),
           wait_reason = NULL,
           failure_reason = NULL,
           completed_at = ?,
           updated_at = ?
       WHERE id = ? AND status IN ('dispatched', 'running', 'waiting_local_directory', 'awaiting_human')`,
      [storedResult, input.branchName ?? null, input.sessionId ?? null, input.workDir ?? null, now, now, taskId],
    );
    if (result.changes === 0) throw new Error(`Task not found or terminal: ${taskId}`);
    const task = this.getTask(taskId)!;
    this.afterTaskTerminal(task, "completed", input.output);
    this.notifyTaskEvent("task:completed", task);
    return task;
  }

  failTask(taskId: string, input: {
    error: string;
    sessionId?: string | null;
    workDir?: string | null;
    failureReason?: string | null;
    failure_reason?: string | null;
  }): MultiremiTask {
    const now = nowIso();
    const failureReason = cleanOptionalString(input.failureReason ?? input.failure_reason) ?? "agent_error";
    const result = this.db.run(
      `UPDATE multiremi_tasks
       SET status = 'failed',
           error = ?,
           failure_reason = ?,
           session_id = COALESCE(?, session_id),
           work_dir = COALESCE(?, work_dir),
           wait_reason = NULL,
           completed_at = ?,
           failed_at = ?,
           updated_at = ?
       WHERE id = ? AND status IN ('dispatched', 'running', 'waiting_local_directory', 'awaiting_human')`,
      [input.error, failureReason, input.sessionId ?? null, input.workDir ?? null, now, now, now, taskId],
    );
    if (result.changes === 0) throw new Error(`Task not found or terminal: ${taskId}`);
    const task = this.getTask(taskId)!;
    this.afterTaskTerminal(task, "failed", input.error);
    this.notifyTaskEvent("task:failed", task);
    return task;
  }

  cancelTask(taskId: string): MultiremiTask {
    const now = nowIso();
    const result = this.db.run(
      `UPDATE multiremi_tasks
       SET status = 'cancelled', wait_reason = NULL, failure_reason = NULL, completed_at = ?, cancelled_at = ?, updated_at = ?
       WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled')`,
      [now, now, now, taskId],
    );
    if (result.changes === 0) throw new Error(`Task not found or terminal: ${taskId}`);
    const task = this.getTask(taskId)!;
    this.afterTaskTerminal(task, "cancelled", null);
    this.notifyTaskEvent("task:cancelled", task);
    return task;
  }

  getTaskStatus(taskId: string): MultiremiTaskStatus {
    const row = this.db.query("SELECT status FROM multiremi_tasks WHERE id = ?").get(taskId) as { status: string } | null;
    if (!row) throw new Error(`Task not found: ${taskId}`);
    return row.status as MultiremiTaskStatus;
  }

  reportTaskUsage(taskId: string, usage: TaskUsageEntry[]): MultiremiTask {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const merged = new Map<string, RuntimeUsageEntry>();
    for (const entry of parseTaskUsageEntries(task.usage)) {
      merged.set(`${entry.provider}\u0000${entry.model}`, entry);
    }
    for (const entry of normalizeTaskUsageEntries(usage)) {
      merged.set(`${entry.provider}\u0000${entry.model}`, entry);
    }
    this.db.run(
      "UPDATE multiremi_tasks SET usage = ?, updated_at = ? WHERE id = ?",
      [toJson([...merged.values()]), nowIso(), taskId],
    );
    return this.getTask(taskId)!;
  }

  recoverOrphans(runtimeId: string): { orphaned: number; retried: number } {
    const orphanRows = this.db.query(
      "SELECT id FROM multiremi_tasks WHERE runtime_id = ? AND status IN ('dispatched', 'running', 'waiting_local_directory', 'awaiting_human')",
    ).all(runtimeId) as Array<{ id: string }>;
    if (!orphanRows.length) return { orphaned: 0, retried: 0 };

    const now = nowIso();
    const orphanIds = orphanRows.map((row) => String(row.id));
    const placeholders = orphanIds.map(() => "?").join(", ");
    this.db.run(
      `UPDATE multiremi_tasks
       SET status = 'failed',
           error = 'daemon restarted while task was in flight',
           failure_reason = 'runtime_recovery',
           wait_reason = NULL,
           completed_at = ?,
           failed_at = ?,
           updated_at = ?
       WHERE id IN (${placeholders})`,
      [now, now, now, ...orphanIds],
    );
    const failedRows = this.db.query(`SELECT * FROM multiremi_tasks WHERE id IN (${placeholders})`).all(...orphanIds) as Row[];
    const failedTasks = this.withTaskAutopilotRuns(failedRows.map(toTask));
    let retried = 0;

    for (const task of failedTasks) {
      const retry = this.afterTaskTerminal(task, "failed", task.error);
      this.notifyTaskEvent("task:failed", task);
      if (retry) retried++;
    }

    return { orphaned: orphanIds.length, retried };
  }

  private maybeRetryFailedTask(parent: MultiremiTask): MultiremiTask | null {
    if (parent.status !== "failed") return null;
    if (!parent.failureReason || !AUTO_RETRY_FAILURE_REASONS.has(parent.failureReason)) return null;
    if (parent.attempt >= parent.maxAttempts) return null;
    if (parent.autopilotRunId) return null;
    if (!parent.issueId && !parent.chatSessionId) return null;

    const resumeSafe = !RESUME_UNSAFE_FAILURE_REASONS.has(parent.failureReason);
    const retry = this.createTask({
      agentId: parent.agentId,
      runtimeId: parent.runtimeId,
      issueId: parent.issueId,
      chatSessionId: parent.chatSessionId,
      triggerCommentId: parent.triggerCommentId,
      triggerSummary: parent.triggerSummary,
      workspaceId: parent.workspaceId,
      priority: parent.priority,
      prompt: parent.prompt,
      sessionId: resumeSafe ? parent.sessionId : null,
      workDir: resumeSafe ? parent.workDir : null,
      attempt: parent.attempt + 1,
      maxAttempts: parent.maxAttempts,
      parentTaskId: parent.id,
    });
    if (retry.chatSessionId) {
      this.db.run(
        "UPDATE multiremi_chat_sessions SET latest_task_id = ?, updated_at = ? WHERE id = ?",
        [retry.id, nowIso(), retry.chatSessionId],
      );
    }
    return retry;
  }

  private resolveRunnableAgentForAssignee(assigneeType: MultiremiAssigneeType, assigneeId: string): MultiremiAgent | null {
    if (assigneeType === "agent") {
      const agent = this.getAgent(assigneeId);
      return agent?.archivedAt ? null : agent;
    }
    if (assigneeType !== "squad") return null;
    const squad = this.getSquad(assigneeId);
    if (!squad) return null;
    if (squad.archivedAt) return null;
    if (squad.leaderId) {
      const leader = this.getAgent(squad.leaderId);
      if (leader && !leader.archivedAt) return leader;
    }
    for (const member of this.listSquadMembers(squad.id).filter((m) => m.memberType === "agent")) {
      const agent = this.getAgent(member.memberId);
      if (agent && !agent.archivedAt) return agent;
    }
    return null;
  }

  private resolveAutopilotAgent(autopilot: MultiremiAutopilot): MultiremiAgent | null {
    return this.resolveRunnableAgentForAssignee(autopilot.assigneeType, autopilot.assigneeId);
  }

  private validateIssueAssignee(assigneeType: MultiremiAssigneeType | null, assigneeId: string | null): void {
    if (!assigneeType && !assigneeId) return;
    if (!assigneeType || !assigneeId) throw new Error("Assignee type and id are required together");
    if (assigneeType === "agent") {
      const agent = this.getAgent(assigneeId);
      if (!agent) throw new Error(`Agent not found: ${assigneeId}`);
      if (agent.archivedAt) throw new Error(`Agent is archived: ${assigneeId}`);
    } else if (assigneeType === "member") {
      const member = this.getWorkspaceMember(assigneeId);
      if (!member) throw new Error(`Member not found: ${assigneeId}`);
      if (member.archivedAt) throw new Error(`Member is archived: ${assigneeId}`);
    } else if (assigneeType === "squad") {
      const squad = this.getSquad(assigneeId);
      if (!squad) throw new Error(`Squad not found: ${assigneeId}`);
      if (squad.archivedAt) throw new Error(`Squad is archived: ${assigneeId}`);
    } else {
      throw new Error(`Unsupported assignee type: ${assigneeType}`);
    }
  }

  private validateIssueParent(issueId: string, parentIssueId: string): void {
    if (issueId === parentIssueId) throw new Error("An issue cannot be its own parent");
    let cursor: string | null = parentIssueId;
    const seen = new Set<string>();
    for (let depth = 0; cursor && depth < 100; depth++) {
      if (cursor === issueId) throw new Error("Circular parent issue relationship detected");
      if (seen.has(cursor)) throw new Error("Circular parent issue relationship detected");
      seen.add(cursor);
      cursor = this.getIssue(cursor)?.parentIssueId ?? null;
    }
  }

  private cancelActiveIssueTasks(issueId: string, reason: string): number {
    const active = this.db.query(
      "SELECT * FROM multiremi_tasks WHERE issue_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')",
    ).all(issueId) as Row[];
    if (!active.length) return 0;
    const now = nowIso();
    this.db.run(
      `UPDATE multiremi_tasks
       SET status = 'cancelled', completed_at = ?, cancelled_at = ?, updated_at = ?
       WHERE issue_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')`,
      [now, now, now, issueId],
    );
    for (const row of active) {
      this.appendIssueActivity(issueId, {
        actorType: "system",
        actorId: null,
        type: "task_cancelled",
        body: reason,
        data: { taskId: String(row.id), agentId: nullableString(row.agent_id) },
      });
    }
    return active.length;
  }

  private cancelTasksByTriggerComments(commentIds: string[]): number {
    if (!commentIds.length) return 0;
    const placeholders = commentIds.map(() => "?").join(", ");
    const rows = this.db.query(
      `SELECT id FROM multiremi_tasks
       WHERE trigger_comment_id IN (${placeholders})
         AND status NOT IN ('completed', 'failed', 'cancelled')`,
    ).all(...commentIds) as Row[];
    for (const row of rows) this.cancelTask(String(row.id));
    return rows.length;
  }

  private createInboxItem(input: {
    workspaceId?: string | null;
    issueId?: string | null;
    memberId?: string | null;
    recipientType?: string;
    recipientId?: string | null;
    severity?: string;
    type: string;
    title: string;
    body?: string | null;
    actorType?: string;
    actorId?: string | null;
    details?: unknown | null;
    emitEvent?: boolean;
  }): MultiremiInboxItem | null {
    const issueId = cleanOptionalString(input.issueId);
    const issue = issueId ? this.getIssue(issueId) : null;
    if (issueId && !issue) throw new Error(`Issue not found: ${issueId}`);
    const workspaceId = issue?.workspaceId ?? cleanOptionalString(input.workspaceId) ?? "local";
    const recipientType = input.recipientType ?? "member";
    const rawRecipientId = cleanOptionalString(input.recipientId ?? input.memberId);
    if (recipientType !== "member" || !rawRecipientId) return null;
    const member = this.resolveWorkspaceMemberForNotification(workspaceId, rawRecipientId);
    if (!member || member.archivedAt) return null;
    if (this.isNotificationMuted(workspaceId, member.id, input.type)) return null;
    const id = createId("inb");
    const now = nowIso();
    this.db.run(
      `INSERT INTO multiremi_inbox_items (
        id, workspace_id, issue_id, member_id, recipient_type, recipient_id, severity,
        actor_type, actor_id, type, title, body, details, read, archived, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
      [
        id,
        workspaceId,
        issue?.id ?? null,
        member.id,
        recipientType,
        member.id,
        input.severity ?? "info",
        input.actorType ?? "system",
        input.actorId ?? null,
        input.type,
        input.title,
        input.body ?? null,
        input.details == null ? null : toJson(input.details),
        now,
      ],
    );
    const row = this.db.query("SELECT * FROM multiremi_inbox_items WHERE id = ?").get(id) as Row | null;
    const item = toInboxItem(row!, issue);
    if (input.emitEvent) {
      this.emitWorkspaceEvent({
        type: "inbox:new",
        workspaceId,
        actorType: input.actorType ?? "system",
        actorId: input.actorId ?? null,
        payload: { item },
      });
    }
    return item;
  }

  private resolveWorkspaceMemberForNotification(workspaceId: string, idOrUserId: string): MultiremiWorkspaceMember | null {
    const exact = this.getWorkspaceMember(idOrUserId);
    if (exact && exact.workspaceId === workspaceId) return exact;
    return this.listWorkspaceMembers(workspaceId).find((member) =>
      member.id === idOrUserId || member.id === `mem_${workspaceId}_${idOrUserId}`
    ) ?? null;
  }

  private getRawIssueComment(id: string): MultiremiIssueComment | null {
    const row = this.db.query("SELECT * FROM multiremi_issue_comments WHERE id = ?").get(id) as Row | null;
    return row ? toIssueComment(row) : null;
  }

  private getThreadRootCommentId(comment: MultiremiIssueComment): string {
    let current = comment;
    const seen = new Set<string>();
    while (current.parentId && !seen.has(current.parentId)) {
      seen.add(current.id);
      const parent = this.getRawIssueComment(current.parentId);
      if (!parent) break;
      current = parent;
    }
    return current.id;
  }

  private getCommentAuthorName(comment: MultiremiIssueComment): string | null {
    if (!comment.authorId) return null;
    if (comment.authorType === "agent") return this.getAgent(comment.authorId)?.name ?? null;
    if (comment.authorType === "member") {
      return this.getWorkspaceMember(comment.authorId)?.name ?? this.getUser(comment.authorId)?.name ?? null;
    }
    return this.getUser(comment.authorId)?.name ?? null;
  }

  private getLastTaskStartedAtForIssueAndAgent(issueId: string, agentId: string, excludingTaskId: string): string | null {
    const row = this.db.query(
      `SELECT started_at FROM multiremi_tasks
       WHERE issue_id = ? AND agent_id = ? AND id <> ? AND started_at IS NOT NULL
       ORDER BY started_at DESC
       LIMIT 1`,
    ).get(issueId, agentId, excludingTaskId) as { started_at: string | null } | null;
    return nullableString(row?.started_at);
  }

  private countNewCommentsSince(issueId: string, since: string, anchorCommentId: string, agentId: string): number {
    const row = this.db.query(
      `SELECT COUNT(*) AS count
       FROM multiremi_issue_comments
       WHERE issue_id = ?
         AND created_at > ?
         AND id <> ?
         AND NOT (author_type = 'agent' AND author_id = ?)`,
    ).get(issueId, since, anchorCommentId, agentId) as { count: number } | null;
    return Number(row?.count ?? 0);
  }

  private hydrateIssue(issue: MultiremiIssue): MultiremiIssue {
    return {
      ...issue,
      labels: this.listLabelsForIssue(issue.id),
    };
  }

  private hydrateIssues(issues: MultiremiIssue[]): MultiremiIssue[] {
    if (issues.length === 0) return issues;
    const labelsByIssue = this.labelsForIssues(issues.map((issue) => issue.id));
    return issues.map((issue) => ({ ...issue, labels: labelsByIssue.get(issue.id) ?? [] }));
  }

  private labelsForIssues(issueIds: string[]): Map<string, MultiremiLabel[]> {
    const result = new Map<string, MultiremiLabel[]>();
    if (issueIds.length === 0) return result;
    const placeholders = issueIds.map(() => "?").join(", ");
    const rows = this.db.query(
      `SELECT il.issue_id AS __issue_id, l.*
       FROM multiremi_issue_labels l
       JOIN multiremi_issue_to_labels il ON il.label_id = l.id
       WHERE il.issue_id IN (${placeholders})
       ORDER BY lower(l.name) ASC`,
    ).all(...issueIds) as Row[];
    for (const row of rows) {
      const issueId = String(row.__issue_id);
      const list = result.get(issueId) ?? [];
      list.push(toLabel(row));
      result.set(issueId, list);
    }
    return result;
  }

  private hydrateRuntime(runtime: MultiremiRuntime): MultiremiRuntime {
    const stats = this.runtimeUsageSummary(runtime.id);
    return {
      ...runtime,
      ...stats,
      models: this.listRuntimeModelsForExistingRuntime(runtime.id),
    };
  }

  private hydrateRuntimeLocalSkillImportRequest(request: MultiremiRuntimeLocalSkillImportRequest): MultiremiRuntimeLocalSkillImportRequest {
    return {
      ...request,
      skill: request.skill ?? (request.skillId ? this.getSkill(request.skillId) : null),
    };
  }

  private listRuntimeModelsForExistingRuntime(runtimeId: string): MultiremiRuntimeModel[] {
    const rows = this.db.query("SELECT * FROM multiremi_runtime_models WHERE runtime_id = ? ORDER BY is_default DESC, label ASC").all(runtimeId) as Row[];
    return rows.map(toRuntimeModel);
  }

  private replaceRuntimeModels(runtimeId: string, models: MultiremiRuntimeModel[], provider: string, now = nowIso()): void {
    const normalized = normalizeRuntimeModels(models, provider);
    this.db.transaction(() => {
      this.db.run("DELETE FROM multiremi_runtime_models WHERE runtime_id = ?", [runtimeId]);
      for (const model of normalized) {
        this.db.run(
          `INSERT INTO multiremi_runtime_models (
            runtime_id, model_id, label, provider, is_default, thinking, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            runtimeId,
            model.id,
            model.label,
            model.provider,
            model.default ? 1 : 0,
            model.thinking ? toJson(model.thinking) : null,
            now,
            now,
          ],
        );
      }
    })();
  }

  private hydrateIssueComment(comment: MultiremiIssueComment): MultiremiIssueComment {
    return {
      ...comment,
      reactions: this.listCommentReactions(comment.id),
      attachments: this.listAttachmentsForComment(comment.id),
    };
  }

  private hydrateIssueDependency(dependency: MultiremiIssueDependency): MultiremiIssueDependency {
    return {
      ...dependency,
      issue: this.getIssue(dependency.issueId),
      dependsOnIssue: this.getIssue(dependency.dependsOnIssueId),
    };
  }

  private collectCommentTreeIds(commentId: string): string[] {
    const ids: string[] = [];
    const visit = (id: string) => {
      ids.push(id);
      const rows = this.db.query("SELECT id FROM multiremi_issue_comments WHERE parent_id = ? ORDER BY created_at ASC").all(id) as Row[];
      for (const row of rows) visit(String(row.id));
    };
    visit(commentId);
    return ids;
  }

  private unresolveThreadRoot(commentId: string): void {
    let current = this.getRawIssueComment(commentId);
    while (current?.parentId) current = this.getRawIssueComment(current.parentId);
    if (!current?.resolvedAt) return;
    this.db.run(
      "UPDATE multiremi_issue_comments SET resolved_at = NULL, resolved_by_type = NULL, resolved_by_id = NULL, updated_at = ? WHERE id = ?",
      [nowIso(), current.id],
    );
  }

  private validatePinnedItemTarget(workspaceId: string, itemType: MultiremiPinnedItemType, itemId: string): void {
    if (itemType === "issue") {
      const row = this.db.query("SELECT id FROM multiremi_issues WHERE id = ? AND workspace_id = ?").get(itemId, workspaceId) as Row | null;
      if (!row) throw new Error(`Issue not found: ${itemId}`);
      return;
    }
    const project = this.getProject(itemId);
    if (!project || project.workspaceId !== workspaceId) throw new Error(`Project not found: ${itemId}`);
  }

  private linkAttachmentsToComment(commentId: string, issueId: string, attachmentIds: string[]): void {
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    for (const attachmentId of attachmentIds) {
      const attachment = this.getAttachment(attachmentId);
      if (!attachment) throw new Error(`Attachment not found: ${attachmentId}`);
      if (attachment.issueId && attachment.issueId !== issueId) throw new Error(`Attachment belongs to another issue: ${attachmentId}`);
      this.db.run(
        `UPDATE multiremi_attachments
         SET issue_id = ?, comment_id = ?, workspace_id = ?
         WHERE id = ? AND comment_id IS NULL`,
        [issueId, commentId, issue.workspaceId, attachmentId],
      );
    }
  }

  private notifySubscribedMembers(
    issue: MultiremiIssue,
    type: string,
    title: string,
    body: string | null,
    actorType: string,
    actorId: string | null,
    excludedMemberIds: string[] = [],
  ): void {
    const subscribers = this.listIssueSubscribers(issue.id);
    const excluded = new Set(excludedMemberIds);
    for (const subscriber of subscribers) {
      if (subscriber.userType !== "member") continue;
      if (actorType === "member" && actorId === subscriber.userId) continue;
      if (excluded.has(subscriber.userId)) continue;
      this.createInboxItem({
        issueId: issue.id,
        memberId: subscriber.userId,
        type,
        title: `${issue.key}: ${title}`,
        body,
        actorType,
        actorId,
      });
    }
  }

  private isNotificationMuted(workspaceId: string, memberId: string, type: string): boolean {
    const group = notificationGroupForInboxType(type);
    if (!group) return false;
    const memberPreferences = this.getNotificationPreferences({ workspaceId, memberId }).preferences;
    if (memberPreferences[group] === "muted") return true;
    const workspacePreferences = this.getNotificationPreferences({ workspaceId }).preferences;
    return workspacePreferences[group] === "muted";
  }

  private findIssueIdForGitHubPullRequest(workspaceId: string, input: { title: string; branch?: string | null }): string | null {
    const settings = this.getGitHubSettings(workspaceId);
    if (!settings.enabled || !settings.autoLinkPRs) return null;
    const haystack = [input.title, input.branch ?? ""].join(" ");
    const issues = this.listIssues().filter((issue) => issue.workspaceId === workspaceId);
    const match = issues.find((issue) => issue.key && new RegExp("\\b" + escapeRegExp(issue.key) + "\\b", "i").test(haystack));
    return match?.id ?? null;
  }

  private triggerMemberMentions(issue: MultiremiIssue, comment: MultiremiIssueComment): string[] {
    const targets = this.resolveCommentMemberMentionTargets(comment.body, issue.workspaceId);
    const notified: string[] = [];
    for (const memberId of targets) {
      if (comment.authorType === "member" && comment.authorId === memberId) continue;
      this.addIssueSubscriber(issue.id, memberId, "mentioned");
      this.createInboxItem({
        issueId: issue.id,
        memberId,
        type: "comment_mention",
        title: `${issue.key}: mentioned you`,
        body: comment.body,
        actorType: comment.authorType,
        actorId: comment.authorId,
      });
      notified.push(memberId);
    }
    return notified;
  }

  private triggerCommentMentions(issue: MultiremiIssue, comment: MultiremiIssueComment): MultiremiTask[] {
    const targets = this.resolveCommentMentionTargets(comment.body);
    if (!targets.length) return [];

    const tasks: MultiremiTask[] = [];
    const seenAgents = new Set<string>();
    for (const target of targets) {
      const agent = this.resolveRunnableAgentForAssignee(target.assigneeType, target.assigneeId);
      if (!agent || seenAgents.has(agent.id)) continue;
      if (comment.authorType === "agent" && comment.authorId === agent.id) continue;
      seenAgents.add(agent.id);
      const task = this.createTask({
        agentId: agent.id,
        issueId: issue.id,
        triggerCommentId: comment.id,
        workspaceId: issue.workspaceId,
        prompt: commentMentionPrompt(comment),
      });
      tasks.push(task);
      this.appendIssueActivity(issue.id, {
        actorType: "system",
        actorId: null,
        type: "comment_mention_triggered",
        body: `Queued ${agent.name}`,
        data: {
          commentId: comment.id,
          assigneeType: target.assigneeType,
          assigneeId: target.assigneeId,
          agentId: agent.id,
          taskId: task.id,
        },
      });
    }
    return tasks;
  }

  private resolveCommentMentionTargets(body: string): Array<{ assigneeType: "agent" | "squad"; assigneeId: string }> {
    const targets: Array<{ assigneeType: "agent" | "squad"; assigneeId: string }> = [];
    const seen = new Set<string>();
    const addTarget = (assigneeType: "agent" | "squad", assigneeId: string) => {
      const key = `${assigneeType}:${assigneeId}`;
      if (seen.has(key)) return;
      seen.add(key);
      targets.push({ assigneeType, assigneeId });
    };

    const markdownMention = /mention:\/\/(agent|squad)\/([A-Za-z0-9_-]+)/g;
    for (const match of body.matchAll(markdownMention)) {
      addTarget(match[1] as "agent" | "squad", match[2]);
    }

    const withoutLinks = body.replace(/\[[^\]]+\]\(mention:\/\/[^)]+\)/g, " ");
    for (const agent of this.listAgents()) {
      if (hasPlainMention(withoutLinks, agent.name)) addTarget("agent", agent.id);
    }
    for (const squad of this.listSquads()) {
      if (hasPlainMention(withoutLinks, squad.name)) addTarget("squad", squad.id);
    }
    return targets;
  }

  private resolveCommentMemberMentionTargets(body: string, workspaceId: string): string[] {
    const targets: string[] = [];
    const seen = new Set<string>();
    const addTarget = (memberId: string) => {
      if (seen.has(memberId)) return;
      seen.add(memberId);
      targets.push(memberId);
    };

    const markdownMention = /mention:\/\/member\/([A-Za-z0-9_-]+)/g;
    for (const match of body.matchAll(markdownMention)) {
      const member = this.getWorkspaceMember(match[1]);
      if (member && !member.archivedAt) addTarget(member.id);
    }

    const withoutLinks = body.replace(/\[[^\]]+\]\(mention:\/\/[^)]+\)/g, " ");
    if (/(^|\s)@all(?=$|\s|[.,:;!?])/i.test(withoutLinks)) {
      for (const member of this.listWorkspaceMembers(workspaceId)) addTarget(member.id);
      return targets;
    }

    for (const member of this.listWorkspaceMembers(workspaceId)) {
      if (hasPlainMention(withoutLinks, member.name)) addTarget(member.id);
    }
    return targets;
  }

  private afterTaskTerminal(task: MultiremiTask, status: "completed" | "failed" | "cancelled", body: string | null): MultiremiTask | null {
    const now = nowIso();
    const retry = status === "failed" ? this.maybeRetryFailedTask(task) : null;
    this.revokeTaskAccessTokens(task.id);
    if (task.chatSessionId && (status === "completed" || (status === "failed" && !retry))) {
      const role = "assistant";
      const messageBody = status === "completed" ? (body || "Task completed.") : (body || `Task ${status}`);
      const failureReason = status === "failed" ? task.failureReason : null;
      const elapsedMs = computeChatElapsedMs(task);
      const messageId = createId("msg");
      this.db.run(
        `INSERT INTO multiremi_chat_messages (
          id, chat_session_id, task_id, role, body, failure_reason, elapsed_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [messageId, task.chatSessionId, task.id, role, messageBody, failureReason, elapsedMs, now],
      );
      const promoteSession = status !== "failed" || !RESUME_UNSAFE_FAILURE_REASONS.has(task.failureReason ?? "");
      this.db.run(
        `UPDATE multiremi_chat_sessions
         SET session_id = CASE WHEN ? = 1 THEN COALESCE(?, session_id) ELSE session_id END,
             work_dir = CASE WHEN ? = 1 THEN COALESCE(?, work_dir) ELSE work_dir END,
             latest_task_id = ?,
             unread_since = COALESCE(unread_since, ?),
             updated_at = ?
         WHERE id = ?`,
        [promoteSession ? 1 : 0, task.sessionId ?? null, promoteSession ? 1 : 0, task.workDir ?? null, task.id, now, now, task.chatSessionId],
      );
      if (status === "completed") {
        const session = this.getChatSession(task.chatSessionId);
        this.emitWorkspaceEvent({
          type: "chat:done",
          workspaceId: session?.workspaceId ?? task.workspaceId,
          chatSessionId: task.chatSessionId,
          actorType: "system",
          actorId: "",
          payload: {
            chat_session_id: task.chatSessionId,
            task_id: task.id,
            message_id: messageId,
            content: messageBody,
            elapsed_ms: elapsedMs,
            created_at: now,
          },
        });
      }
    }

    if (task.issueId) {
      const issueStatus = this.nextIssueStatusAfterTaskTerminal(task, status, retry);
      if (issueStatus) {
        this.db.run(
          "UPDATE multiremi_issues SET status = ?, updated_at = ? WHERE id = ?",
          [issueStatus, now, task.issueId],
        );
      }
      this.appendIssueActivity(task.issueId, {
        actorType: "agent",
        actorId: task.agentId,
        type: `task_${status}`,
        body,
        data: { taskId: task.id, runtimeId: task.runtimeId },
      });
      const issue = this.getIssue(task.issueId);
      if (issue?.projectId) this.db.run("UPDATE multiremi_projects SET updated_at = ? WHERE id = ?", [now, issue.projectId]);
    }

    const runRow = this.db.query(
      "SELECT id FROM multiremi_autopilot_runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(task.id) as { id: string } | null;
    if (runRow) {
      const runStatus = status === "completed" ? "completed" : "failed";
      const failureReason = autopilotTaskFailureReason(status, task);
      this.db.run(
        `UPDATE multiremi_autopilot_runs
         SET status = ?, completed_at = ?, failure_reason = ?, result = ?
         WHERE id = ?`,
        [
          runStatus,
          now,
          runStatus === "failed" ? failureReason : null,
          toJson({ taskId: task.id, status, output: task.result, error: task.error }),
          runRow.id,
        ],
      );
      const run = this.getAutopilotRun(runRow.id);
      const autopilot = run ? this.getAutopilot(run.autopilotId) : null;
      if (run && autopilot) {
        if (runStatus === "completed") this.recordAutopilotRunCompletedAnalytics(autopilot, run);
        else this.recordAutopilotRunFailedAnalytics(autopilot, run, failureReason);
      }
    }
    return retry;
  }

  private nextIssueStatusAfterTaskTerminal(
    task: MultiremiTask,
    status: "completed" | "failed" | "cancelled",
    retry: MultiremiTask | null,
  ): string | null {
    if (!task.issueId) return null;
    if (status === "completed") return "done";
    if (status === "cancelled") return "cancelled";
    if (retry) return "in_progress";
    const issue = this.getIssue(task.issueId);
    if (issue?.status === "in_progress" && !this.hasActiveTaskForIssue(task.issueId)) return "todo";
    return null;
  }

  private hasActiveTaskForIssue(issueId: string): boolean {
    const row = this.db.query(
      `SELECT 1 AS present FROM multiremi_tasks
       WHERE issue_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')
       LIMIT 1`,
    ).get(issueId) as { present: number } | null;
    return Boolean(row);
  }

  private hasActiveTaskForIssueAndAgent(issueId: string, agentId: string): boolean {
    const row = this.db.query(
      `SELECT 1 AS present FROM multiremi_tasks
       WHERE issue_id = ? AND agent_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')
       LIMIT 1`,
    ).get(issueId, agentId) as { present: number } | null;
    return Boolean(row);
  }

  private withTaskAutopilotRun(task: MultiremiTask): MultiremiTask {
    const row = this.db.query(
      "SELECT id FROM multiremi_autopilot_runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(task.id) as { id: string } | null;
    return { ...task, autopilotRunId: row?.id ?? task.autopilotRunId ?? null };
  }

  private withTaskAutopilotRuns(tasks: MultiremiTask[]): MultiremiTask[] {
    if (!tasks.length) return tasks;
    const placeholders = tasks.map(() => "?").join(", ");
    const rows = this.db.query(
      `SELECT task_id, id
       FROM multiremi_autopilot_runs
       WHERE task_id IN (${placeholders})
       ORDER BY created_at DESC`,
    ).all(...tasks.map((task) => task.id)) as Row[];
    const runByTask = new Map<string, string>();
    for (const row of rows) {
      const taskId = nullableString(row.task_id);
      const runId = nullableString(row.id);
      if (taskId && runId && !runByTask.has(taskId)) runByTask.set(taskId, runId);
    }
    return tasks.map((task) => ({ ...task, autopilotRunId: runByTask.get(task.id) ?? task.autopilotRunId ?? null }));
  }

  private countProjectResources(projectId: string): number {
    const row = this.db.query("SELECT COUNT(*) AS count FROM multiremi_project_resources WHERE project_id = ?")
      .get(projectId) as { count: number } | null;
    return Number(row?.count ?? 0);
  }

  private assertNoLocalDirectoryDaemonConflict(
    projectId: string,
    resourceType: string,
    resourceRef: Record<string, unknown>,
    excludeId: string | null,
    mode: "create" | "update",
  ): void {
    if (resourceType !== "local_directory") return;
    const daemonId = String(resourceRef.daemonId ?? resourceRef.daemon_id ?? "").trim();
    if (!daemonId) return;
    for (const resource of this.listProjectResources(projectId)) {
      if (resource.id === excludeId || resource.resourceType !== "local_directory") continue;
      const existingDaemonId = String(resource.resourceRef.daemonId ?? resource.resourceRef.daemon_id ?? "").trim();
      if (existingDaemonId !== daemonId) continue;
      if (mode === "create") {
        throw new Error("this daemon already has a local_directory attached to the project; remove it before adding another");
      }
      throw new Error("another local_directory on this daemon is already attached to the project");
    }
  }

  private assertValidProjectRef(owningProjectId: string, resourceRef: Record<string, unknown>, workspaceId: string): void {
    const targetId = String(resourceRef.projectId ?? resourceRef.project_id ?? "").trim();
    if (!targetId) throw new Error("project_ref project_id is required");
    if (targetId === owningProjectId) throw new Error("project_ref cannot reference its own project");
    const target = this.getProject(targetId);
    if (!target) throw new Error(`project_ref target project not found: ${targetId}`);
    if (target.workspaceId !== workspaceId) throw new Error("project_ref target belongs to another workspace");
    // Walk the target's project_ref graph; reaching the owning project again
    // means this edge would close a cycle. The visited set prunes shared
    // subtrees so a DAG diamond is not mistaken for a cycle. Write-time
    // rejection has a TOCTOU gap, so runtime resolution guards with its own
    // visited set — this keeps the graph acyclic under normal use.
    const visited = new Set<string>();
    const walk = (projectId: string, depth: number): void => {
      if (projectId === owningProjectId) throw new Error("project_ref would introduce a reference cycle");
      if (depth > PROJECT_REF_MAX_DEPTH || visited.has(projectId)) return;
      visited.add(projectId);
      for (const resource of this.listProjectResources(projectId)) {
        if (resource.resourceType !== "project_ref") continue;
        const nextId = String(resource.resourceRef.projectId ?? resource.resourceRef.project_id ?? "").trim();
        // Dangling targets are silently skipped (like resolveTaskRepos) so a
        // hard-deleted referenced project can't break a valid new edge.
        if (!nextId || !this.getProject(nextId)) continue;
        walk(nextId, depth + 1);
      }
    };
    walk(targetId, 1);
  }

  private nextIssueNumber(workspaceId: string): number {
    const row = this.db.query(
      "SELECT COALESCE(MAX(issue_number), 0) + 1 AS next FROM multiremi_issues WHERE workspace_id = ?",
    ).get(workspaceId) as { next: number } | null;
    return Number(row?.next ?? 1);
  }

  private notifyTaskEnqueued(task: MultiremiTask): void {
    for (const listener of [...this.taskEnqueuedListeners]) {
      try {
        listener(task);
      } catch {
        // Wakeup listeners are best-effort and must not roll back task enqueue.
      }
    }
  }

  private notifyTaskEvent(type: string, task: MultiremiTask): void {
    for (const listener of [...this.taskEventListeners]) {
      try {
        listener({ type, task });
      } catch {
        // Realtime listeners are best-effort and must not roll back task state.
      }
    }
  }

  private runtimeUsageSummary(runtimeId: string): Pick<MultiremiRuntime,
    "taskCount" |
    "activeTaskCount" |
    "completedTaskCount" |
    "failedTaskCount" |
    "inputTokens" |
    "outputTokens" |
    "cacheReadTokens" |
    "cacheWriteTokens"
  > {
    const rows = this.db.query(
      "SELECT id, status, usage FROM multiremi_tasks WHERE runtime_id = ?",
    ).all(runtimeId) as Row[];
    const stats = {
      taskCount: rows.length,
      activeTaskCount: 0,
      completedTaskCount: 0,
      failedTaskCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    for (const row of rows) {
      const status = String(row.status ?? "") as MultiremiTaskStatus;
      if (isInFlightTaskStatus(status)) stats.activeTaskCount += 1;
      if (status === "completed") stats.completedTaskCount += 1;
      if (status === "failed") stats.failedTaskCount += 1;
      for (const entry of parseTaskUsageEntries(row.usage)) {
        stats.inputTokens += entry.inputTokens;
        stats.outputTokens += entry.outputTokens;
        stats.cacheReadTokens += entry.cacheReadTokens;
        stats.cacheWriteTokens += entry.cacheWriteTokens;
      }
    }
    return stats;
  }

  private filteredUsageTaskRows(input: {
    workspaceId?: string | null;
    projectId?: string | null;
    runtimeId?: string | null;
    days?: number;
  }, options: { includeTasksWithoutUsage?: boolean } = {}): Row[] {
    const clauses = ["1 = 1"];
    const params: Array<string | number | null> = [];
    const workspaceId = input.workspaceId ?? "local";
    if (workspaceId) {
      clauses.push("t.workspace_id = ?");
      params.push(workspaceId);
    }
    if (input.projectId) {
      clauses.push("i.project_id = ?");
      params.push(input.projectId);
    }
    if (input.runtimeId !== undefined) {
      if (input.runtimeId === null) {
        clauses.push("t.runtime_id IS NULL");
      } else {
        if (!this.getRuntime(input.runtimeId)) throw new Error(`Runtime not found: ${input.runtimeId}`);
        clauses.push("t.runtime_id = ?");
        params.push(input.runtimeId);
      }
    }
    const since = usageSince(input.days);
    if (since) {
      clauses.push("COALESCE(t.completed_at, t.failed_at, t.cancelled_at, t.started_at, t.dispatched_at, t.updated_at, t.created_at) >= ?");
      params.push(since);
    }
    if (!options.includeTasksWithoutUsage) {
      clauses.push("t.usage IS NOT NULL AND t.usage != '[]' AND t.usage != ''");
    }
    return this.db.query(
      `SELECT t.*
       FROM multiremi_tasks t
       LEFT JOIN multiremi_issues i ON i.id = t.issue_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY COALESCE(t.completed_at, t.failed_at, t.cancelled_at, t.started_at, t.dispatched_at, t.updated_at, t.created_at) ASC`,
    ).all(...params) as Row[];
  }
}

type Row = Record<string, unknown>;

function parseJsonValue(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function metricCounterKey(name: string, labels: Record<string, string>): string {
  const labelKey = Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key]}`)
    .join("\0");
  return `${name}\0${labelKey}`;
}

function stringProp(props: Record<string, unknown>, key: string): string {
  const value = props[key];
  return typeof value === "string" ? value : "";
}

function normalizeMetricLabel(value: string | null | undefined, known: Set<string>, fallback: string): string {
  const label = String(value ?? "").trim().toLowerCase();
  return known.has(label) ? label : fallback;
}

function normalizeRuntimeModeLabel(value: string | null | undefined): string {
  return normalizeMetricLabel(value, KNOWN_RUNTIME_MODES, "unknown");
}

function normalizeRuntimeProviderLabel(value: string | null | undefined): string {
  return normalizeMetricLabel(value, KNOWN_RUNTIME_PROVIDERS, "other");
}

function normalizeAnalyticsSourceLabel(value: string | null | undefined): string {
  return normalizeMetricLabel(value, KNOWN_ANALYTICS_SOURCES, "other");
}

function normalizeFailureReasonLabel(value: string | null | undefined): string {
  const reason = String(value ?? "").trim();
  return KNOWN_FAILURE_REASONS.has(reason) ? reason : "agent_error.unknown";
}

function boolMetricLabel(value: boolean): string {
  return value ? "true" : "false";
}

function normalizeAutopilotCadenceLabel(value: string | null | undefined): string {
  return normalizeMetricLabel(value, KNOWN_AUTOPILOT_CADENCES, "unknown");
}

function normalizeAutopilotTriggerLabel(value: string | null | undefined): string {
  return normalizeMetricLabel(value, KNOWN_AUTOPILOT_TRIGGERS, "unknown");
}

function normalizeWebhookProviderLabel(value: string | null | undefined): string {
  return normalizeMetricLabel(value, KNOWN_WEBHOOK_PROVIDERS, "other");
}

function normalizeWebhookDeliveryStatusLabel(value: string | null | undefined): string {
  return normalizeMetricLabel(value, KNOWN_WEBHOOK_DELIVERY_STATUSES, "other");
}

function autopilotActorId(autopilot: MultiremiAutopilot): string {
  const id = autopilot.createdById;
  if (autopilot.createdByType === "agent" && id) return `agent:${id}`;
  return id || "system";
}

function nonAgentUserId(distinctId: string): string {
  return distinctId && !distinctId.includes(":") ? distinctId : "";
}

function runtimeDistinctId(ownerId: string, workspaceId: string | null): string {
  if (ownerId) return ownerId;
  return `workspace:${workspaceId ?? ""}`;
}

function runtimeFailureDistinctId(ownerId: string, workspaceId: string | null): string {
  if (ownerId) return ownerId;
  if (workspaceId) return `workspace:${workspaceId}`;
  return "";
}

function runtimeAnalyticsProperties(runtime: MultiremiRuntime, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return withAnalyticsCoreProperties({
    runtime_id: runtime.id,
    daemon_id: runtime.daemonId ?? "",
    provider: runtime.provider,
    runtime_mode: runtime.runtimeMode,
    ...extra,
  }, {
    userId: runtime.ownerId ?? "",
    source: "manual",
    runtimeMode: runtime.runtimeMode,
    provider: runtime.provider,
  });
}

function stringMetadata(metadata: Record<string, unknown>, key: string): string {
  const value = metadata[key];
  return typeof value === "string" ? value : "";
}

function withAnalyticsCoreProperties(
  props: Record<string, unknown>,
  core: {
    userId?: string;
    agentId?: string;
    autopilotRunId?: string;
    source?: string;
    runtimeMode?: string;
    provider?: string;
  },
): Record<string, unknown> {
  const next = { ...props };
  if (core.userId) next.user_id = core.userId;
  if (core.agentId) next.agent_id = core.agentId;
  if (core.autopilotRunId) next.autopilot_run_id = core.autopilotRunId;
  if (core.source) next.source = core.source;
  if (core.runtimeMode) next.runtime_mode = core.runtimeMode;
  if (core.provider) next.provider = core.provider;
  next.is_demo = false;
  return next;
}

function autopilotRunDurationMs(run: MultiremiAutopilotRun): number {
  if (!run.completedAt) return 0;
  const start = Date.parse(run.triggeredAt);
  const end = Date.parse(run.completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}

function autopilotErrorType(reason: string): string {
  if (reason.includes("unknown execution_mode")) return "configuration";
  if (reason.startsWith("issue ")) return "issue_terminal";
  if (reason.includes("create issue") || reason.includes("enqueue task") || reason.includes("dispatch")) return "dispatch_error";
  if (reason.startsWith("task ")) return "task_error";
  return "autopilot_error";
}

function autopilotTaskFailureReason(status: "completed" | "failed" | "cancelled", task: MultiremiTask): string {
  if (status === "failed") return task.error || "task failed";
  if (status === "cancelled") return task.error || "task cancelled";
  return "";
}

const NOTIFICATION_GROUPS: MultiremiNotificationGroupKey[] = [
  "assignments",
  "status_changes",
  "comments",
  "updates",
  "agent_activity",
  "system_notifications",
];

function normalizeNotificationPreferences(value: unknown): MultiremiNotificationPreferences {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const normalized: MultiremiNotificationPreferences = {};
  for (const group of NOTIFICATION_GROUPS) {
    const pref = raw[group];
    if (pref === "all" || pref === "muted") normalized[group] = pref;
  }
  return normalized;
}

function notificationGroupForInboxType(type: string): MultiremiNotificationGroupKey | null {
  if (type === "issue_assigned" || type === "unassigned") return "assignments";
  if (type === "comment_created" || type === "comment_mention") return "comments";
  if (type === "status_changed") return "status_changes";
  if (type.startsWith("agent_")) return "agent_activity";
  if (type.startsWith("system_") || type === "autopilot_paused") return "system_notifications";
  return "updates";
}

function normalizeAutopilotCreatorType(value: unknown): "member" | "agent" {
  return value === "agent" ? "agent" : "member";
}

function normalizeGitHubPullRequestState(value: unknown): MultiremiGitHubPullRequestState {
  if (value === "closed" || value === "merged" || value === "draft") return value;
  return "open";
}

function normalizeGitHubChecksConclusion(value: unknown): MultiremiGitHubChecksConclusion {
  if (value === "passed" || value === "failed" || value === "pending") return value;
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSkillFiles(files: MultiremiSkillFile[]): MultiremiSkillFile[] {
  return files.map((file) => {
    const path = normalizeSkillFilePath(file.path);
    return { path, content: String(file.content ?? "") };
  });
}

function normalizeSkillFilePath(path: string): string {
  const rawPath = String(path ?? "").replace(/\\/g, "/");
  const normalized = cleanRelativePath(rawPath);
  if (!normalized || rawPath.startsWith("/") || normalized === "." || normalized.startsWith("..")) {
    throw new Error(`Invalid skill file path: ${path}`);
  }
  if (normalized.toLowerCase() === "skill.md") throw new Error("Skill files should not include SKILL.md");
  return normalized;
}

function cleanRelativePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") {
        parts.pop();
      } else {
        parts.push("..");
      }
      continue;
    }
    parts.push(part);
  }
  return parts.length ? parts.join("/") : ".";
}

function mergeAgentSkills(inlineSkills: MultiremiSkill[], structuredSkills: MultiremiSkill[]): MultiremiSkill[] {
  const seen = new Set<string>();
  const merged: MultiremiSkill[] = [];
  for (const skill of [...structuredSkills, ...inlineSkills]) {
    const key = skill.id ?? skill.name;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(skill);
  }
  return merged;
}

function stringFieldOrCurrent(value: unknown, current: string | null): string | null {
  return typeof value === "string" ? value : current;
}

function usageTimestamp(row: Row): string {
  return String(
    row.completed_at ??
    row.failed_at ??
    row.cancelled_at ??
    row.started_at ??
    row.dispatched_at ??
    row.updated_at ??
    row.created_at,
  );
}

function usageDate(row: Row): string {
  const date = new Date(usageTimestamp(row));
  if (!Number.isFinite(date.getTime())) return String(row.created_at ?? "").slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function usageHour(row: Row): number {
  const date = new Date(usageTimestamp(row));
  if (!Number.isFinite(date.getTime())) return 0;
  return date.getUTCHours();
}

function usageSince(days: number | undefined): string | null {
  const value = Number(days ?? 30);
  if (!Number.isFinite(value) || value <= 0) return null;
  const capped = Math.min(365, Math.floor(value));
  return new Date(Date.now() - capped * 24 * 60 * 60 * 1000).toISOString();
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

function trailingWindowStart(days: number): string {
  const capped = Math.max(1, Math.min(365, Math.floor(days)));
  return new Date(Date.now() - capped * 24 * 60 * 60 * 1000).toISOString();
}

function taskRunSeconds(row: Row): number {
  const start = Date.parse(String(row.started_at ?? row.dispatched_at ?? row.created_at));
  const end = Date.parse(String(row.completed_at ?? row.failed_at ?? row.cancelled_at ?? row.updated_at));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return Math.floor((end - start) / 1000);
}

type RuntimeUsageEntry = Required<Pick<TaskUsageEntry,
  "provider" |
  "model" |
  "inputTokens" |
  "outputTokens" |
  "cacheReadTokens" |
  "cacheWriteTokens" |
  "totalTokens"
>>;

function parseTaskUsageEntries(value: unknown): RuntimeUsageEntry[] {
  const raw = Array.isArray(value) ? value : parseJson<unknown[]>(value, []);
  return normalizeTaskUsageEntries(raw);
}

function normalizeTaskUsageEntries(raw: unknown): RuntimeUsageEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: RuntimeUsageEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    entries.push({
      provider: String(record.provider ?? "unknown"),
      model: String(record.model ?? "unknown"),
      inputTokens: normalizeUsageNumber(record.inputTokens ?? record.input_tokens),
      outputTokens: normalizeUsageNumber(record.outputTokens ?? record.output_tokens),
      cacheReadTokens: normalizeUsageNumber(record.cacheReadTokens ?? record.cache_read_tokens),
      cacheWriteTokens: normalizeUsageNumber(record.cacheWriteTokens ?? record.cache_write_tokens),
      totalTokens: normalizeUsageNumber(record.totalTokens ?? record.total_tokens),
    });
  }
  return entries;
}

function addUsageTotals(
  target: Pick<RuntimeUsageEntry, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens"> & { totalTokens?: number },
  entry: RuntimeUsageEntry,
): void {
  target.inputTokens += entry.inputTokens;
  target.outputTokens += entry.outputTokens;
  target.cacheReadTokens += entry.cacheReadTokens;
  target.cacheWriteTokens += entry.cacheWriteTokens;
  if (target.totalTokens !== undefined) target.totalTokens += entry.totalTokens;
}

function normalizeUsageNumber(value: unknown): number {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.floor(number);
}

function formatIssueKey(number: number): string {
  return `MUL-${number}`;
}

function commentMentionPrompt(comment: MultiremiIssueComment): string {
  return [
    "A teammate mentioned you in an issue comment.",
    "",
    "## Triggering Comment",
    comment.body,
  ].join("\n");
}

function childDoneParentTaskPrompt(comment: MultiremiIssueComment): string {
  return [
    "A sub-issue assigned under this issue was marked done.",
    "",
    "## Platform Comment",
    comment.body,
  ].join("\n");
}

function childDoneSystemCommentBody(input: {
  mentionPrefix: string;
  childKey: string;
  childId: string;
  childTitle: string;
}): string {
  const title = sanitizeChildDoneTitle(input.childTitle);
  return [
    `${input.mentionPrefix}Sub-issue [${input.childKey}](mention://issue/${input.childId}) - "${title}" - is done.`,
    "Before promoting any waiting backlog sub-issue, read each sibling's description and only promote items whose stated dependencies are already satisfied.",
    "If a sibling's description conflicts with the parent breakdown, leave it backlog and post a comment to confirm first.",
  ].join(" ");
}

function sanitizeChildDoneTitle(title: string): string {
  return title.replaceAll("](mention://", "] (mention-stripped://").trim();
}

function sanitizeChildDoneMentionLabel(name: string): string {
  const cleaned = name.replaceAll("]", "").trim();
  return cleaned || "assignee";
}

function childAssigneeIsSquad(child: MultiremiIssue, squadId: string): boolean {
  return child.assigneeType === "squad" && child.assigneeId === squadId;
}

type CommentListValidationInput = {
  rootsOnly: boolean;
  thread: string | null;
  recent: number | null;
  tail: number | null;
  tailSet: boolean;
  before: Date | null;
  beforeId: string | null;
};

type CommentThreadGroup = {
  rootId: string;
  lastActivityMs: number;
  comments: MultiremiIssueComment[];
};

function validateCommentListOptions(input: CommentListValidationInput): void {
  if (input.rootsOnly && input.thread) throw new Error("roots_only and thread are mutually exclusive");
  if (input.rootsOnly && input.recent !== null) throw new Error("roots_only and recent are mutually exclusive");
  if (input.rootsOnly && input.tailSet) throw new Error("roots_only and tail are mutually exclusive");
  if (input.rootsOnly && (input.before || input.beforeId)) throw new Error("roots_only does not support before / before_id");
  if (input.thread && input.recent !== null) throw new Error("thread and recent are mutually exclusive");
  if (input.tailSet && !input.thread) throw new Error("tail requires thread (it is a thread-scoped limit)");
  if (input.recent !== null && (!Number.isFinite(input.recent) || input.recent <= 0)) {
    throw new Error("invalid recent parameter; expected positive integer");
  }
  if (input.tailSet && (input.tail === null || !Number.isFinite(input.tail) || input.tail < 0)) {
    throw new Error("invalid tail parameter; expected non-negative integer");
  }
  if (Boolean(input.before) !== Boolean(input.beforeId)) {
    throw new Error("before and before_id must be set together (composite cursor)");
  }
  if (input.before && input.recent === null && (!input.thread || !input.tailSet)) {
    throw new Error("before / before_id require recent (thread cursor) or thread + tail (reply cursor)");
  }
}

function normalizeNullableInteger(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return Number.NaN;
  return Math.floor(number);
}

function normalizeCommentString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseCommentCursorTime(value: unknown): Date | null {
  if (value === undefined || value === null || value === "") return null;
  const time = new Date(String(value));
  if (!Number.isFinite(time.getTime())) throw new Error("invalid timestamp parameter; expected RFC3339 format");
  return time;
}

function cloneComment(comment: MultiremiIssueComment): MultiremiIssueComment {
  return { ...comment };
}

function withCommentSummary(comment: MultiremiIssueComment): MultiremiIssueComment {
  const cloned = cloneComment(comment);
  const runes = Array.from(cloned.body);
  const truncated = runes.length > COMMENT_SUMMARY_RUNES;
  const body = truncated ? `${runes.slice(0, COMMENT_SUMMARY_RUNES).join("")}…` : cloned.body;
  return {
    ...cloned,
    body,
    content: body,
    contentTruncated: truncated,
    content_truncated: truncated,
  };
}

function commentCreatedAfter(comment: MultiremiIssueComment, since: Date): boolean {
  return Date.parse(comment.createdAt) > since.getTime();
}

function cursorTimestamp(comment: MultiremiIssueComment): string {
  const ms = Date.parse(comment.createdAt);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : comment.createdAt;
}

function compareCommentCursor(comment: MultiremiIssueComment, before: Date | number, beforeId: string | null): number {
  const left = Date.parse(comment.createdAt);
  const right = before instanceof Date ? before.getTime() : before;
  if (left !== right) return left < right ? -1 : 1;
  if (!beforeId || comment.id === beforeId) return 0;
  return comment.id < beforeId ? -1 : 1;
}

function compareCommentGroupCursor(group: CommentThreadGroup, before: Date | number, beforeId: string | null): number {
  const right = before instanceof Date ? before.getTime() : before;
  if (group.lastActivityMs !== right) return group.lastActivityMs < right ? -1 : 1;
  if (!beforeId || group.rootId === beforeId) return 0;
  return group.rootId < beforeId ? -1 : 1;
}

function commentThreadRootId(comment: MultiremiIssueComment, byId: Map<string, MultiremiIssueComment>): string {
  const seen = new Set<string>();
  let current = comment;
  while (current.parentId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = byId.get(current.parentId);
    if (!parent) break;
    current = parent;
  }
  return current.id;
}

function commentHasAncestorId(comment: MultiremiIssueComment, ancestorId: string, byId: Map<string, MultiremiIssueComment>): boolean {
  const seen = new Set<string>();
  let parentId = comment.parentId;
  while (parentId && !seen.has(parentId)) {
    if (parentId === ancestorId) return true;
    seen.add(parentId);
    parentId = byId.get(parentId)?.parentId ?? null;
  }
  return false;
}

function commentThreadGroups(comments: MultiremiIssueComment[]): CommentThreadGroup[] {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const grouped = new Map<string, MultiremiIssueComment[]>();
  for (const comment of comments) {
    const rootId = commentThreadRootId(comment, byId);
    const group = grouped.get(rootId) ?? [];
    group.push(comment);
    grouped.set(rootId, group);
  }
  return [...grouped.entries()].map(([rootId, groupComments]) => {
    const lastActivityMs = Math.max(...groupComments.map((comment) => Date.parse(comment.createdAt)).filter(Number.isFinite));
    return {
      rootId,
      lastActivityMs: Number.isFinite(lastActivityMs) ? lastActivityMs : 0,
      comments: groupComments.sort((a, b) => compareCommentCursor(a, Date.parse(b.createdAt), b.id)),
    };
  });
}

function withCommentRootStats(
  comment: MultiremiIssueComment,
  allComments: MultiremiIssueComment[],
  byId: Map<string, MultiremiIssueComment>,
): MultiremiIssueComment {
  const descendants = allComments.filter((item) => item.id !== comment.id && commentHasAncestorId(item, comment.id, byId));
  const activityTimes = [comment, ...descendants]
    .map((item) => Date.parse(item.createdAt))
    .filter(Number.isFinite);
  const lastActivityMs = Math.max(...activityTimes);
  const lastActivityAt = Number.isFinite(lastActivityMs) ? new Date(lastActivityMs).toISOString() : comment.createdAt;
  return {
    ...comment,
    replyCount: descendants.length,
    reply_count: descendants.length,
    lastActivityAt,
    last_activity_at: lastActivityAt,
  };
}

function hasPlainMention(body: string, name: string): boolean {
  const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return false;
  return new RegExp(`(^|\\s)@${escaped}(?=$|\\s|[.,:;!?])`, "i").test(body);
}

function validateIssueMetadataKey(key: string): void {
  if (!key) throw new Error("key is required");
  if (!ISSUE_METADATA_KEY_RE.test(key)) {
    throw new Error("key must match ^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$");
  }
}

function validateIssueMetadataValue(value: unknown): string | number | boolean {
  if (!isIssueMetadataPrimitive(value)) {
    if (value === null) throw new Error("value cannot be null");
    throw new Error("value must be a primitive: string, number, or bool");
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("value must be a finite number");
  }
  return value;
}

function isIssueMetadataPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "boolean" || typeof value === "number";
}

function validateIssueMetadataSize(metadata: Record<string, string | number | boolean>): void {
  if (Buffer.byteLength(toJson(metadata), "utf8") > 8 * 1024) {
    throw new Error("metadata exceeds the 8KB size limit");
  }
}

function normalizeIssuePriority(value: string | undefined): MultiremiIssuePriority {
  const priority = String(value ?? "none").trim().toLowerCase();
  if (priority === "urgent" || priority === "high" || priority === "medium" || priority === "low" || priority === "none") {
    return priority;
  }
  throw new Error("priority must be one of urgent, high, medium, low, or none");
}

function normalizeIssueDependencyType(value: string | undefined): MultiremiIssueDependencyType {
  const type = String(value ?? "related").trim().toLowerCase();
  if (type === "blocks" || type === "blocked_by" || type === "related") return type;
  throw new Error("dependency type must be one of blocks, blocked_by, or related");
}

function normalizeRuntimeVisibility(value: string | undefined): MultiremiRuntimeVisibility {
  const visibility = String(value ?? "private").trim().toLowerCase();
  if (visibility === "private" || visibility === "public") return visibility;
  throw new Error("visibility must be private or public");
}

function normalizeAgentVisibility(value: unknown): MultiremiAgent["visibility"] {
  const visibility = String(value ?? "private").trim().toLowerCase();
  if (visibility === "private" || visibility === "workspace") return visibility;
  throw new Error("visibility must be private or workspace");
}

function normalizeRuntimeConcurrency(value: number | null | undefined): number {
  const concurrency = Number(value ?? 1);
  if (!Number.isFinite(concurrency) || concurrency < 1) throw new Error("maxConcurrency must be at least 1");
  return Math.floor(concurrency);
}

function normalizeRuntimeMetadata(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (!isRecord(value)) throw new Error("metadata must be an object");
  const normalized = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  if (!isRecord(normalized)) throw new Error("metadata must be an object");
  if (Buffer.byteLength(toJson(normalized), "utf8") > 8 * 1024) {
    throw new Error("metadata exceeds the 8KB size limit");
  }
  return normalized;
}

function preserveRuntimeMergeAudit(
  current: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  if ("legacy_runtime_merges" in next) return next;
  const existing = current.legacy_runtime_merges;
  return Array.isArray(existing) ? { ...next, legacy_runtime_merges: existing } : next;
}

function withLegacyRuntimeMergeAudit(
  metadata: Record<string, unknown>,
  entry: {
    legacyDaemonId: string;
    oldRuntimeId: string;
    newRuntimeId: string;
    provider: string;
    agentsReassigned: number;
    tasksReassigned: number;
    mergedAt: string;
  },
): Record<string, unknown> {
  const existing = Array.isArray(metadata.legacy_runtime_merges)
    ? metadata.legacy_runtime_merges.filter(isRecord)
    : [];
  const nextEntry = {
    legacy_daemon_id: entry.legacyDaemonId,
    old_runtime_id: entry.oldRuntimeId,
    new_runtime_id: entry.newRuntimeId,
    provider: entry.provider,
    agents_reassigned: entry.agentsReassigned,
    tasks_reassigned: entry.tasksReassigned,
    merged_at: entry.mergedAt,
  };
  const audit = [...existing, nextEntry].slice(-25);
  let next = { ...metadata, legacy_runtime_merges: audit };
  while (Buffer.byteLength(toJson(next), "utf8") > 8 * 1024 && audit.length > 1) {
    audit.shift();
    next = { ...metadata, legacy_runtime_merges: audit };
  }
  return normalizeRuntimeMetadata(next);
}

const SUPPORTED_USER_LANGUAGES = new Set(["en", "zh-Hans", "zh-Hant", "ja", "ko"]);
const WORKSPACE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function normalizeOptionalLanguage(value: unknown): string | null {
  const language = String(value ?? "").trim();
  if (!language) return null;
  if (!SUPPORTED_USER_LANGUAGES.has(language)) throw new Error("unsupported language");
  return language;
}

function normalizeOptionalTimezone(value: unknown): string | null {
  const timezone = String(value ?? "").trim();
  if (!timezone) return null;
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    return timezone;
  } catch {
    throw new Error("invalid timezone");
  }
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

function normalizeWorkspaceSlug(value: unknown): string {
  const slug = String(value ?? "").trim().toLowerCase();
  if (!slug) return "";
  if (!WORKSPACE_SLUG_RE.test(slug)) throw new Error("slug must contain only lowercase letters, numbers, and hyphens");
  return slug;
}

function slugifyWorkspaceName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "workspace";
}

function generateIssuePrefix(name: string): string {
  const letters = name.replace(/[^a-zA-Z]/g, "").toUpperCase();
  if (!letters) return "WS";
  return letters.slice(0, Math.min(letters.length, 3));
}

function normalizeWorkspaceInvitationRole(value: unknown): string {
  const role = String(value ?? "member").trim().toLowerCase() || "member";
  if (role === "owner" || role === "admin" || role === "member") return role;
  throw new Error("invalid member role");
}

function normalizeRuntimeModels(models: MultiremiRuntimeModel[], provider: string): MultiremiRuntimeModel[] {
  const seen = new Set<string>();
  return (models ?? []).map((model) => {
    const id = String(model.id ?? "").trim();
    if (!id) throw new Error("model id is required");
    if (seen.has(id)) throw new Error(`Duplicate runtime model: ${id}`);
    seen.add(id);
    return {
      id,
      label: String(model.label ?? id).trim() || id,
      provider: String(model.provider ?? provider ?? "").trim() || provider,
      default: Boolean(model.default),
      thinking: normalizeRuntimeModelThinking(model.thinking),
    };
  });
}

function normalizeRuntimeModelThinking(value: MultiremiRuntimeModel["thinking"]): MultiremiRuntimeModel["thinking"] | undefined {
  if (!value) return undefined;
  const supportedLevels = (value.supportedLevels ?? value.supported_levels ?? []).map((level) => ({
    value: String(level.value ?? "").trim(),
    label: String(level.label ?? level.value ?? "").trim(),
    ...(level.description ? { description: String(level.description) } : {}),
  })).filter((level) => level.value);
  if (!supportedLevels.length) return undefined;
  return {
    supportedLevels,
    ...(value.defaultLevel || value.default_level ? { defaultLevel: String(value.defaultLevel ?? value.default_level) } : {}),
  };
}

function issueMatchesListFilter(issue: MultiremiIssue, input: ListIssuesInput): boolean {
  const workspaceId = input.workspaceId ?? input.workspace_id;
  if (workspaceId && issue.workspaceId !== workspaceId) return false;
  const statuses = normalizeIssueStatusList(input.statuses ?? input.status);
  if (statuses.length && !statuses.includes(issue.status)) return false;
  const priorities = normalizeStringList(input.priorities ?? input.priority);
  if (priorities.length && !priorities.includes(issue.priority)) return false;
  const assigneeTypes = normalizeStringList(input.assigneeTypes ?? input.assignee_types);
  if (assigneeTypes.length && (!issue.assigneeType || !assigneeTypes.includes(issue.assigneeType))) return false;
  const assigneeId = input.assigneeId ?? input.assignee_id;
  if (assigneeId && issue.assigneeId !== assigneeId) return false;
  const assigneeIds = normalizeStringList(input.assigneeIds ?? input.assignee_ids);
  if (assigneeIds.length && (!issue.assigneeId || !assigneeIds.includes(issue.assigneeId))) return false;
  if (input.includeNoAssignee && issue.assigneeId !== null) return false;
  const projectId = input.projectId ?? input.project_id;
  if (projectId && issue.projectId !== projectId) return false;
  const projectIds = normalizeStringList(input.projectIds ?? input.project_ids);
  if (projectIds.length && (!issue.projectId || !projectIds.includes(issue.projectId))) return false;
  if (input.includeNoProject && issue.projectId !== null) return false;
  if (input.metadata) {
    for (const [key, value] of Object.entries(input.metadata)) {
      if (issue.metadata[key] !== value) return false;
    }
  }
  return true;
}

// SQL equivalent of issueMatchesListFilter for every column-level filter (metadata, a JSON column,
// stays in JS). Kept in lockstep with issueMatchesListFilter so callers can push filters + pagination
// into SQL without changing results.
function buildIssueListWhere(input: ListIssuesInput): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const inClause = (column: string, values: string[]) => {
    clauses.push(`${column} IN (${values.map(() => "?").join(", ")})`);
    params.push(...values);
  };

  const workspaceId = input.workspaceId ?? input.workspace_id;
  if (workspaceId) {
    clauses.push("workspace_id = ?");
    params.push(workspaceId);
  }
  const statuses = normalizeIssueStatusList(input.statuses ?? input.status);
  if (statuses.length) inClause("status", statuses);
  const priorities = normalizeStringList(input.priorities ?? input.priority);
  if (priorities.length) inClause("priority", priorities);
  const assigneeTypes = normalizeStringList(input.assigneeTypes ?? input.assignee_types);
  if (assigneeTypes.length) inClause("assignee_type", assigneeTypes);
  const assigneeId = input.assigneeId ?? input.assignee_id;
  if (assigneeId) {
    clauses.push("assignee_id = ?");
    params.push(assigneeId);
  }
  const assigneeIds = normalizeStringList(input.assigneeIds ?? input.assignee_ids);
  if (assigneeIds.length) inClause("assignee_id", assigneeIds);
  if (input.includeNoAssignee) clauses.push("(assignee_id IS NULL OR assignee_id = '')");
  const projectId = input.projectId ?? input.project_id;
  if (projectId) {
    clauses.push("project_id = ?");
    params.push(projectId);
  }
  const projectIds = normalizeStringList(input.projectIds ?? input.project_ids);
  if (projectIds.length) inClause("project_id", projectIds);
  if (input.includeNoProject) clauses.push("(project_id IS NULL OR project_id = '')");

  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

function normalizeStringList(value: string[] | string | undefined | null): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

function normalizeIssueStatus(value: unknown): string {
  const status = String(value ?? "todo").trim();
  if (status === "open") return "todo";
  return (ISSUE_STATUSES as readonly string[]).includes(status) ? status : "todo";
}

function normalizeIssueStatusList(value: string[] | string | undefined | null): string[] {
  const statuses = normalizeStringList(value).map(normalizeIssueStatus);
  return [...new Set(statuses)];
}

function normalizeListOffset(value: number | undefined): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function normalizeListLimit(value: number | undefined, fallback = 200, max = 500): number {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(0, Math.floor(number)));
}

function normalizePositiveInt(value: number | null | undefined, fallback: number): number {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.floor(number);
}

function normalizeTriggerSummary(value: unknown): string | null {
  const text = cleanOptionalString(value)?.replace(/[\n\r\t]/g, " ").trim();
  if (!text) return null;
  const chars = Array.from(text);
  if (chars.length <= TRIGGER_SUMMARY_MAX_LENGTH) return text;
  return `${chars.slice(0, TRIGGER_SUMMARY_MAX_LENGTH).join("")}\u2026`;
}

function safeIdSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "local";
}

function assigneeGroupId(type: MultiremiAssigneeType | null, id: string | null): string {
  return type && id ? `${type}:${id}` : "none";
}

function assigneeGroupRank(type: MultiremiAssigneeType | null): number {
  if (type === "member") return 0;
  if (type === "agent") return 1;
  if (type === "squad") return 2;
  return 3;
}

function hasIssueMutation(input: UpdateIssueInput): boolean {
  return hasAnyField(
    input,
    "title",
    "description",
    "status",
    "priority",
    "projectId",
    "project_id",
    "workspaceId",
    "workspace_id",
    "parentIssueId",
    "parent_issue_id",
    "assigneeType",
    "assignee_type",
    "assigneeId",
    "assignee_id",
    "position",
    "startDate",
    "start_date",
    "dueDate",
    "due_date",
    "acceptanceCriteria",
    "acceptance_criteria",
    "contextRefs",
    "context_refs",
  );
}

function quickCreateTitle(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? prompt.trim();
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}

function quickCreateTaskPrompt(prompt: string, projectId: string | null): string {
  return [
    "Create or refine a Multiremi issue from this quick-create request.",
    projectId ? `Project ID: ${projectId}` : "Project ID: none",
    "",
    prompt,
  ].join("\n");
}

function outcomeTime(task: MultiremiTask): number {
  return Date.parse(task.completedAt ?? task.failedAt ?? task.updatedAt ?? task.createdAt);
}

function normalizeIssuePosition(value: number | null | undefined): number {
  const position = Number(value ?? 0);
  if (!Number.isFinite(position)) throw new Error("position must be a finite number");
  return position;
}

function normalizeProjectResourcePosition(value: number | null | undefined, fallback: number): number {
  if (value == null) return fallback;
  const position = Number(value);
  if (!Number.isInteger(position)) throw new Error("position must be an integer");
  return position;
}

function cleanProjectResourceLabel(value: string | null | undefined): string | null {
  if (value == null) return null;
  const label = String(value).trim();
  return label ? label : null;
}

function normalizeIssueDate(value: string | null | undefined, field: string): string | null {
  if (value == null || value === "") return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${field} must be a valid date`);
  return date.toISOString();
}

function normalizeJsonArray(value: unknown): unknown[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("value must be an array");
  return value;
}

function hasAnyField(target: object, ...keys: string[]): boolean {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(target, key));
}

function resolveOptionalStringField(
  target: object,
  camelKey: string,
  snakeKey: string,
  current: string | null,
): string | null {
  const values = target as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(values, camelKey)) return values[camelKey] == null ? null : String(values[camelKey]);
  if (Object.prototype.hasOwnProperty.call(values, snakeKey)) return values[snakeKey] == null ? null : String(values[snakeKey]);
  return current;
}

function normalizeLabelName(value: string | undefined): string {
  const name = value?.trim() ?? "";
  if (!name) throw new Error("Label name is required");
  if (name.length > 32) throw new Error("Label name cannot exceed 32 characters");
  return name;
}

function normalizeLabelColor(value: string | undefined): string {
  const color = value?.trim() ?? "";
  if (!/^#?[0-9a-fA-F]{6}$/.test(color)) throw new Error("Label color must be a 6-digit hex color");
  return (color.startsWith("#") ? color : `#${color}`).toLowerCase();
}

function normalizePinnedItemType(value: string | undefined): MultiremiPinnedItemType {
  if (value === "issue" || value === "project") return value;
  throw new Error("item_type must be 'issue' or 'project'");
}

function normalizeSearchQuery(value: string | undefined): string {
  return String(value ?? "").trim();
}

function clampSearchLimit(value: number | undefined): number {
  const limit = Number(value ?? 20);
  if (!Number.isFinite(limit) || limit <= 0) return 20;
  return Math.min(50, Math.floor(limit));
}

function searchMatch(value: string, query: string): boolean {
  const haystack = value.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return terms.length > 0 && terms.every((term) => haystack.includes(term));
}

function uniqueRefMatch<T>(
  items: T[],
  ref: string,
  getId: (item: T) => string,
  getAliases: (item: T) => Array<string | null | undefined>,
): T | null {
  const value = ref.trim();
  if (!value) return null;
  const lower = value.toLowerCase();
  const compact = compactRef(value);
  const aliasValues = (item: T) => getAliases(item).map((alias) => alias?.trim()).filter((alias): alias is string => Boolean(alias));
  const tiers: Array<(item: T) => boolean> = [
    (item) => getId(item) === value,
    (item) => getId(item).toLowerCase() === lower,
    (item) => aliasValues(item).some((alias) => alias.toLowerCase() === lower),
    (item) => getId(item).toLowerCase().startsWith(lower),
    (item) => aliasValues(item).some((alias) => compactRef(alias) === compact),
    (item) => aliasValues(item).some((alias) => alias.toLowerCase().startsWith(lower)),
    (item) => aliasValues(item).some((alias) => searchMatch(alias, value)),
  ];
  for (const tier of tiers) {
    const matches = uniqueBy(items.filter(tier), getId);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) return null;
  }
  return null;
}

function uniqueBy<T>(items: T[], keyFor: (item: T) => string): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const item of items) {
    const key = keyFor(item);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function compactRef(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function inferAssigneeTypeFromRef(ref: string): MultiremiAssigneeType | null {
  if (/^agt_/i.test(ref)) return "agent";
  if (/^mem_/i.test(ref)) return "member";
  if (/^sqd_/i.test(ref)) return "squad";
  return null;
}

function capitalizeAssigneeType(type: MultiremiAssigneeType): string {
  return `${type.slice(0, 1).toUpperCase()}${type.slice(1)}`;
}

function searchRank(matchSource: string): number {
  if (matchSource === "key") return 0;
  if (matchSource === "title") return 1;
  if (matchSource === "description") return 2;
  return 3;
}

function extractSearchSnippet(value: string, query: string): string {
  const text = String(value);
  const term = query.toLowerCase().split(/\s+/).filter(Boolean).find((item) => text.toLowerCase().includes(item)) ?? "";
  if (!term) return text.slice(0, 160);
  const index = text.toLowerCase().indexOf(term);
  const start = Math.max(0, index - 50);
  const end = Math.min(text.length, index + term.length + 80);
  return `${start > 0 ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`;
}

function normalizeProjectResourceRef(resourceType: string, rawRef: Record<string, unknown>): Record<string, unknown> {
  if (!resourceType) throw new Error("resource_type is required");
  if (resourceType === "local_directory") return normalizeLocalDirectoryResourceRef(rawRef);
  if (resourceType === "project_ref") return normalizeProjectRefResourceRef(rawRef);
  if (resourceType !== "github_repo") throw new Error(`unknown resource_type "${resourceType}"`);
  const url = String(rawRef.url ?? "").trim();
  if (!url) throw new Error("github_repo url is required");
  if (!isValidGitRepoUrl(url)) throw new Error("github_repo url must be a valid http(s), ssh, git, or scp-like URL");
  const defaultBranchHint = String(rawRef.defaultBranchHint ?? rawRef.default_branch_hint ?? "").trim();
  return defaultBranchHint
    ? { url, defaultBranchHint, default_branch_hint: defaultBranchHint }
    : { url };
}

function normalizeProjectRefResourceRef(rawRef: Record<string, unknown>): Record<string, unknown> {
  const projectId = String(rawRef.projectId ?? rawRef.project_id ?? "").trim();
  if (!projectId) throw new Error("project_ref project_id is required");
  // Fixed key order keeps toJson deterministic so the UNIQUE(project_id,
  // resource_type, resource_ref) index catches duplicate references.
  return { projectId, project_id: projectId };
}

function normalizeLocalDirectoryResourceRef(rawRef: Record<string, unknown>): Record<string, unknown> {
  const localPath = String(rawRef.localPath ?? rawRef.local_path ?? "").trim();
  if (!localPath) throw new Error("local_directory local_path is required");
  if (!isAbsolutePath(localPath)) throw new Error("local_directory local_path must be absolute");
  const daemonId = String(rawRef.daemonId ?? rawRef.daemon_id ?? "").trim();
  if (!daemonId) throw new Error("local_directory daemon_id is required");
  const label = String(rawRef.label ?? "").trim();
  return label
    ? { localPath, local_path: localPath, daemonId, daemon_id: daemonId, label }
    : { localPath, local_path: localPath, daemonId, daemon_id: daemonId };
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function isValidGitRepoUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return Boolean(url.host) && ["http", "https", "ssh", "git"].includes(url.protocol.replace(":", ""));
  } catch {
    if (value.includes(" ") || value.includes("://")) return false;
    const colon = value.indexOf(":");
    if (colon <= 0 || colon === value.length - 1) return false;
    const at = value.indexOf("@");
    if (at >= colon) return false;
    const host = value.slice(at >= 0 ? at + 1 : 0, colon);
    const path = value.slice(colon + 1);
    return Boolean(host && path);
  }
}

function projectSelect(suffix: string): string {
  return `
    SELECT p.*,
      COUNT(i.id) AS issue_count,
      COALESCE(SUM(CASE WHEN i.status IN ('done', 'completed', 'closed') THEN 1 ELSE 0 END), 0) AS done_count,
      (
        SELECT COUNT(*)
        FROM multiremi_project_resources pr
        WHERE pr.project_id = p.id
      ) AS resource_count
    FROM multiremi_projects p
    LEFT JOIN multiremi_issues i ON i.project_id = p.id
    ${suffix.includes("ORDER BY") ? suffix.replace("ORDER BY", "GROUP BY p.id ORDER BY") : `${suffix} GROUP BY p.id`}
  `;
}

function squadSelect(suffix: string): string {
  return `
    SELECT s.*, COUNT(m.id) AS member_count
    FROM multiremi_squads s
    LEFT JOIN multiremi_squad_members m ON m.squad_id = s.id
    ${suffix.includes("ORDER BY") ? suffix.replace("ORDER BY", "GROUP BY s.id ORDER BY") : `${suffix} GROUP BY s.id`}
  `;
}

function toAgent(row: Row): MultiremiAgent {
  const workspaceId = String(row.workspace_id ?? "local");
  const ownerId = String(row.owner_id ?? "local");
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description ?? ""),
    avatarUrl: nullableString(row.avatar_url),
    avatar_url: nullableString(row.avatar_url),
    provider: String(row.provider),
    workspaceId,
    workspace_id: workspaceId,
    ownerId,
    owner_id: ownerId,
    visibility: normalizeAgentVisibility(row.visibility),
    runtimeId: nullableString(row.runtime_id),
    runtime_id: nullableString(row.runtime_id),
    instructions: String(row.instructions ?? ""),
    skills: parseJson(row.skills, []),
    maxConcurrentTasks: Number(row.max_concurrent_tasks ?? 6),
    max_concurrent_tasks: Number(row.max_concurrent_tasks ?? 6),
    cwd: nullableString(row.cwd),
    executable: nullableString(row.executable),
    model: nullableString(row.model),
    allowedTools: parseJson(row.allowed_tools, []),
    customEnv: parseJson(row.custom_env, {}),
    customArgs: parseJson(row.custom_args, []),
    mcpConfig: row.mcp_config == null ? null : parseJson(row.mcp_config, null),
    thinkingLevel: nullableString(row.thinking_level),
    archivedAt: nullableString(row.archived_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toRuntime(row: Row): MultiremiRuntime {
  return {
    id: String(row.id),
    name: String(row.name),
    provider: String(row.provider),
    daemonId: nullableString(row.daemon_id),
    legacyDaemonId: nullableString(row.legacy_daemon_id),
    runtimeMode: String(row.runtime_mode ?? "local"),
    deviceInfo: String(row.device_info ?? ""),
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    workspaceId: nullableString(row.workspace_id),
    ownerId: nullableString(row.owner_id),
    visibility: normalizeRuntimeVisibility(String(row.visibility ?? "private")),
    status: String(row.status) as MultiremiRuntime["status"],
    maxConcurrency: Number(row.max_concurrency ?? 1),
    taskCount: 0,
    activeTaskCount: 0,
    completedTaskCount: 0,
    failedTaskCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    models: [],
    lastHeartbeatAt: nullableString(row.last_heartbeat_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toRuntimeLocalSkillListRequest(row: Row): MultiremiRuntimeLocalSkillListRequest {
  return {
    id: String(row.id),
    runtimeId: String(row.runtime_id),
    status: normalizeRuntimeLocalSkillStatus(row.status),
    skills: normalizeRuntimeLocalSkillSummaries(parseJson(row.skills, [])),
    supported: Number(row.supported ?? 1) !== 0,
    error: nullableString(row.error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    runStartedAt: nullableString(row.run_started_at),
  };
}

function toRuntimeLocalSkillImportRequest(row: Row): MultiremiRuntimeLocalSkillImportRequest {
  return {
    id: String(row.id),
    runtimeId: String(row.runtime_id),
    skillKey: String(row.skill_key),
    name: nullableString(row.name),
    description: nullableString(row.description),
    status: normalizeRuntimeLocalSkillStatus(row.status),
    skill: row.skill == null ? null : parseJson(row.skill, null),
    skillId: nullableString(row.skill_id),
    error: nullableString(row.error),
    createdBy: nullableString(row.created_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    runStartedAt: nullableString(row.run_started_at),
  };
}

function toRuntimeModelListRequest(row: Row): MultiremiRuntimeModelListRequest {
  return {
    id: String(row.id),
    runtimeId: String(row.runtime_id),
    status: normalizeRuntimeModelListStatus(row.status),
    models: parseJson(row.models, []),
    supported: Number(row.supported ?? 1) !== 0,
    error: nullableString(row.error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    runStartedAt: nullableString(row.run_started_at),
  };
}

function normalizeRuntimeModelListStatus(value: unknown): MultiremiRuntimeModelListRequestStatus {
  const status = String(value ?? "failed").trim();
  if (status === "pending" || status === "running" || status === "completed" || status === "failed" || status === "timeout") return status;
  return "failed";
}

function toRuntimeDirectoryScanRequest(row: Row): MultiremiRuntimeDirectoryScanRequest {
  return {
    id: String(row.id),
    runtimeId: String(row.runtime_id),
    status: normalizeRuntimeDirectoryScanStatus(row.status),
    params: normalizeRuntimeDirectoryScanParams(parseJson(row.params, {})),
    candidates: normalizeRuntimeDirectoryCandidates(parseJson(row.candidates, [])),
    supported: Number(row.supported ?? 1) !== 0,
    error: nullableString(row.error),
    runStartedAt: nullableString(row.run_started_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function normalizeRuntimeDirectoryScanStatus(value: unknown): MultiremiRuntimeDirectoryScanRequestStatus {
  const status = String(value ?? "failed").trim();
  if (status === "pending" || status === "running" || status === "completed" || status === "failed" || status === "timeout") return status;
  return "failed";
}

function normalizeRuntimeDirectoryScanParams(raw: unknown): MultiremiRuntimeDirectoryScanParams {
  if (!isRecord(raw)) return {};
  const params: MultiremiRuntimeDirectoryScanParams = {};
  const root = typeof raw.root === "string" ? raw.root.trim() : "";
  if (root) params.root = root;
  const maxDepth = Number(raw.maxDepth ?? raw.max_depth);
  if (Number.isFinite(maxDepth) && maxDepth > 0) params.maxDepth = Math.floor(maxDepth);
  const mode = normalizeRuntimeDirectoryScanMode(raw.mode);
  if (mode) params.mode = mode;
  const resolvedRoot = firstNonEmptyString(raw.resolvedRoot, raw.resolved_root);
  if (resolvedRoot) params.resolvedRoot = resolvedRoot;
  return params;
}

function normalizeRuntimeDirectoryScanMode(value: unknown): "scan" | "browse" | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "scan" || value === "browse") return value;
  throw new Error('directory scan mode must be "scan" or "browse"');
}

function normalizeRuntimeDirectoryCandidates(value: unknown): MultiremiRuntimeDirectoryCandidate[] {
  if (!Array.isArray(value)) return [];
  const candidates: MultiremiRuntimeDirectoryCandidate[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const path = typeof item.path === "string" ? item.path.trim() : "";
    if (!path) continue;
    const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : path;
    const remoteUrl = firstNonEmptyString(item.remoteUrl, item.remote_url);
    const currentBranch = firstNonEmptyString(item.currentBranch, item.current_branch);
    const isDirty = typeof item.isDirty === "boolean"
      ? item.isDirty
      : typeof item.is_dirty === "boolean" ? item.is_dirty : null;
    const candidate: MultiremiRuntimeDirectoryCandidate = { path, name, remoteUrl, currentBranch, isDirty };
    const isGitRepo = typeof item.isGitRepo === "boolean"
      ? item.isGitRepo
      : typeof item.is_git_repo === "boolean" ? item.is_git_repo : undefined;
    if (isGitRepo !== undefined) candidate.isGitRepo = isGitRepo;
    candidates.push(candidate);
  }
  return candidates;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function toRuntimeUpdateRequest(row: Row): MultiremiRuntimeUpdateRequest {
  const targetVersion = String(row.target_version ?? "");
  return {
    id: String(row.id),
    runtimeId: String(row.runtime_id),
    status: normalizeRuntimeUpdateStatus(row.status),
    scope: row.scope === "acp" || row.scope === "agent" ? row.scope : "cli",
    targetVersion,
    target_version: targetVersion,
    output: nullableString(row.output),
    error: nullableString(row.error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    runStartedAt: nullableString(row.run_started_at),
  };
}

function normalizeRuntimeUpdateStatus(value: unknown): MultiremiRuntimeUpdateRequestStatus {
  const status = String(value ?? "failed").trim();
  if (status === "pending" || status === "running" || status === "completed" || status === "failed" || status === "timeout") return status;
  return "failed";
}

function normalizeRuntimeLocalSkillStatus(value: unknown): MultiremiRuntimeLocalSkillRequestStatus {
  const status = String(value ?? "failed").trim();
  if (status === "pending" || status === "running" || status === "completed" || status === "failed" || status === "timeout") return status;
  return "failed";
}

function isTerminalRuntimeRequestStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "timeout";
}

function normalizeRuntimeLocalSkillSummaries(value: unknown): MultiremiRuntimeLocalSkillSummary[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = isRecord(item) ? item : {};
    const sourcePath = String(record.sourcePath ?? record.source_path ?? "");
    const fileCount = Number(record.fileCount ?? record.file_count ?? 0);
    return {
      key: String(record.key ?? record.name ?? "").trim(),
      name: String(record.name ?? record.key ?? "").trim(),
      description: String(record.description ?? ""),
      sourcePath,
      source_path: sourcePath,
      provider: String(record.provider ?? "unknown"),
      fileCount,
      file_count: fileCount,
    };
  }).filter((skill) => skill.key && skill.name);
}

function cleanOptionalLocalSkillString(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
}

function normalizeEmail(value: unknown): string {
  const email = String(value ?? "").trim().toLowerCase();
  if (!email) throw new Error("email is required");
  if (email.length > 254) throw new Error("email is too long");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("email is invalid");
  return email;
}

function withRuntimeLiveness(runtime: MultiremiRuntime): MultiremiRuntime {
  if (runtime.status === "offline") return runtime;
  if (!runtime.lastHeartbeatAt) return { ...runtime, status: "offline" };
  const heartbeat = Date.parse(runtime.lastHeartbeatAt);
  if (!Number.isFinite(heartbeat)) return { ...runtime, status: "offline" };
  return Date.now() - heartbeat > RUNTIME_HEARTBEAT_STALE_MS ? { ...runtime, status: "offline" } : runtime;
}

function toRuntimeModel(row: Row): MultiremiRuntimeModel {
  return {
    id: String(row.model_id),
    label: String(row.label ?? row.model_id),
    provider: String(row.provider ?? ""),
    default: Boolean(Number(row.is_default ?? 0)),
    thinking: row.thinking == null ? undefined : parseJson(row.thinking, undefined),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toWorkspaceMember(row: Row): MultiremiWorkspaceMember {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    userId: nullableString(row.user_id),
    name: String(row.name),
    email: nullableString(row.email),
    role: String(row.role ?? "member"),
    archivedAt: nullableString(row.archived_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toUser(row: Row): MultiremiUser {
  const onboardingQuestionnaire = parseJson<Record<string, unknown>>(row.onboarding_questionnaire, {});
  return {
    id: String(row.id),
    externalId: nullableString(row.external_id),
    external_id: nullableString(row.external_id),
    name: String(row.name),
    email: String(row.email),
    avatarUrl: nullableString(row.avatar_url),
    avatar_url: nullableString(row.avatar_url),
    language: nullableString(row.language),
    timezone: nullableString(row.timezone),
    onboardedAt: nullableString(row.onboarded_at),
    onboarded_at: nullableString(row.onboarded_at),
    onboardingQuestionnaire,
    onboarding_questionnaire: onboardingQuestionnaire,
    starterContentState: nullableString(row.starter_content_state),
    starter_content_state: nullableString(row.starter_content_state),
    profileDescription: String(row.profile_description ?? ""),
    profile_description: String(row.profile_description ?? ""),
    createdAt: String(row.created_at),
    created_at: String(row.created_at),
    updatedAt: String(row.updated_at),
    updated_at: String(row.updated_at),
  };
}

function toWorkspace(row: Row): MultiremiWorkspace {
  const settings = parseJson<Record<string, unknown>>(row.settings, {});
  const repos = parseJson<unknown[]>(row.repos, []);
  const issuePrefix = String(row.issue_prefix ?? "MUL");
  return {
    id: String(row.id),
    name: String(row.name),
    slug: String(row.slug),
    description: nullableString(row.description),
    context: nullableString(row.context),
    settings,
    repos,
    issuePrefix,
    issue_prefix: issuePrefix,
    createdAt: String(row.created_at),
    created_at: String(row.created_at),
    updatedAt: String(row.updated_at),
    updated_at: String(row.updated_at),
  };
}

function normalizeRepos(rawRepos: unknown[]): MultiremiRepoData[] {
  const repos: MultiremiRepoData[] = [];
  const seen = new Set<string>();
  for (const raw of rawRepos) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const url = typeof record.url === "string" ? record.url.trim() : "";
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const description = typeof record.description === "string" ? record.description : "";
    repos.push(description ? { url, description } : { url });
  }
  return repos;
}

function toInvitation(row: Row): MultiremiWorkspaceInvitation {
  const status = String(row.status ?? "pending") as MultiremiWorkspaceInvitation["status"];
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    workspace_id: String(row.workspace_id),
    inviterId: String(row.inviter_id),
    inviter_id: String(row.inviter_id),
    inviteeEmail: String(row.invitee_email),
    invitee_email: String(row.invitee_email),
    inviteeUserId: nullableString(row.invitee_user_id),
    invitee_user_id: nullableString(row.invitee_user_id),
    role: String(row.role ?? "member"),
    status,
    createdAt: String(row.created_at),
    created_at: String(row.created_at),
    updatedAt: String(row.updated_at),
    updated_at: String(row.updated_at),
    expiresAt: String(row.expires_at),
    expires_at: String(row.expires_at),
  };
}

function toGitHubSettings(row: Row): MultiremiGitHubSettings {
  const enabled = Boolean(Number(row.enabled ?? 1));
  return {
    workspaceId: String(row.workspace_id ?? "local"),
    enabled,
    prSidebar: Boolean(Number(row.pr_sidebar ?? 1)),
    coAuthor: Boolean(Number(row.co_author ?? 1)),
    autoLinkPRs: Boolean(Number(row.auto_link_prs ?? 1)),
    updatedAt: nullableString(row.updated_at),
  };
}

function toGitHubPullRequest(row: Row): MultiremiGitHubPullRequest {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    issueId: nullableString(row.issue_id),
    repoOwner: String(row.repo_owner ?? ""),
    repoName: String(row.repo_name ?? ""),
    number: Number(row.number ?? 0),
    title: String(row.title ?? ""),
    state: normalizeGitHubPullRequestState(row.state),
    htmlUrl: String(row.html_url ?? ""),
    branch: nullableString(row.branch),
    authorLogin: nullableString(row.author_login),
    authorAvatarUrl: nullableString(row.author_avatar_url),
    mergedAt: nullableString(row.merged_at),
    closedAt: nullableString(row.closed_at),
    prCreatedAt: String(row.pr_created_at),
    prUpdatedAt: String(row.pr_updated_at),
    mergeableState: nullableString(row.mergeable_state),
    checksConclusion: normalizeGitHubChecksConclusion(row.checks_conclusion),
    checksPassed: Number(row.checks_passed ?? 0),
    checksFailed: Number(row.checks_failed ?? 0),
    checksPending: Number(row.checks_pending ?? 0),
    additions: Number(row.additions ?? 0),
    deletions: Number(row.deletions ?? 0),
    changedFiles: Number(row.changed_files ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toSkill(row: Row, files: MultiremiSkillFile[] = []): MultiremiSkill {
  const config = parseJson<Record<string, unknown>>(row.config, {});
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    name: String(row.name ?? ""),
    description: String(row.description ?? ""),
    content: String(row.content ?? ""),
    config,
    files,
    createdBy: nullableString(row.created_by),
    archivedAt: nullableString(row.archived_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toSkillFile(row: Row): MultiremiSkillFile {
  return {
    id: String(row.id),
    skillId: String(row.skill_id),
    path: String(row.path ?? ""),
    content: String(row.content ?? ""),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toProject(row: Row): MultiremiProject {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    title: String(row.title),
    description: nullableString(row.description),
    icon: nullableString(row.icon),
    status: String(row.status ?? "planned") as MultiremiProject["status"],
    priority: String(row.priority ?? "none") as MultiremiProject["priority"],
    leadType: nullableString(row.lead_type) as MultiremiProject["leadType"],
    leadId: nullableString(row.lead_id),
    issueCount: Number(row.issue_count ?? 0),
    doneCount: Number(row.done_count ?? 0),
    resourceCount: Number(row.resource_count ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toProjectResource(row: Row): MultiremiProjectResource {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    workspaceId: String(row.workspace_id ?? "local"),
    resourceType: String(row.resource_type),
    resourceRef: parseJson(row.resource_ref, {}),
    label: nullableString(row.label),
    position: Number(row.position ?? 0),
    createdAt: String(row.created_at),
    createdBy: nullableString(row.created_by),
  };
}

function toIssue(row: Row): MultiremiIssue {
  const number = Number(row.issue_number ?? 0);
  return {
    id: String(row.id),
    key: String(row.issue_key || (number > 0 ? formatIssueKey(number) : row.id)),
    number,
    title: String(row.title),
    description: nullableString(row.description),
    status: normalizeIssueStatus(row.status),
    priority: normalizeIssuePriority(String(row.priority ?? "none")),
    workspaceId: String(row.workspace_id ?? "local"),
    projectId: nullableString(row.project_id),
    parentIssueId: nullableString(row.parent_issue_id),
    assigneeType: nullableString(row.assignee_type) as MultiremiIssue["assigneeType"],
    assigneeId: nullableString(row.assignee_id),
    position: Number(row.position ?? 0),
    startDate: nullableString(row.start_date),
    dueDate: nullableString(row.due_date),
    acceptanceCriteria: parseJson(row.acceptance_criteria, []),
    contextRefs: parseJson(row.context_refs, []),
    metadata: parseIssueMetadata(row.metadata),
    labels: [],
    createdBy: nullableString(row.created_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toChildIssueProgress(row: Row): MultiremiIssueChildProgress {
  return {
    parentIssueId: String(row.parent_issue_id),
    total: Number(row.total ?? 0),
    done: Number(row.done ?? 0),
  };
}

function toIssueDependency(row: Row): MultiremiIssueDependency {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    issueId: String(row.issue_id),
    dependsOnIssueId: String(row.depends_on_issue_id),
    type: normalizeIssueDependencyType(String(row.type ?? "related")),
    issue: null,
    dependsOnIssue: null,
    createdAt: String(row.created_at),
  };
}

function parseIssueMetadata(value: unknown): Record<string, string | number | boolean> {
  const raw = parseJson<Record<string, unknown>>(value, {});
  const metadata: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(raw)) {
    if (ISSUE_METADATA_KEY_RE.test(key) && isIssueMetadataPrimitive(item)) {
      metadata[key] = item;
    }
  }
  return metadata;
}

function toIssueComment(row: Row): MultiremiIssueComment {
  const issueId = String(row.issue_id);
  const authorType = String(row.author_type ?? "member");
  const authorId = nullableString(row.author_id);
  const parentId = nullableString(row.parent_id);
  const body = String(row.body ?? "");
  const type = String(row.type ?? "comment");
  const resolvedAt = nullableString(row.resolved_at);
  const resolvedByType = nullableString(row.resolved_by_type);
  const resolvedById = nullableString(row.resolved_by_id);
  const createdAt = String(row.created_at);
  const updatedAt = String(row.updated_at);
  return {
    id: String(row.id),
    issueId,
    issue_id: issueId,
    authorType,
    author_type: authorType,
    authorId,
    author_id: authorId,
    parentId,
    parent_id: parentId,
    body,
    content: body,
    type,
    resolvedAt,
    resolved_at: resolvedAt,
    resolvedByType,
    resolved_by_type: resolvedByType,
    resolvedById,
    resolved_by_id: resolvedById,
    reactions: [],
    attachments: [],
    createdAt,
    created_at: createdAt,
    updatedAt,
    updated_at: updatedAt,
  };
}

function toIssueActivity(row: Row): MultiremiIssueActivity {
  return {
    id: String(row.id),
    issueId: String(row.issue_id),
    actorType: String(row.actor_type ?? "system"),
    actorId: nullableString(row.actor_id),
    type: String(row.type),
    body: nullableString(row.body),
    data: row.data == null ? null : parseJson(row.data, null),
    createdAt: String(row.created_at),
  };
}

function commentToTimelineEntry(comment: MultiremiIssueComment): MultiremiTimelineEntry {
  return {
    type: "comment",
    id: comment.id,
    actorType: comment.authorType,
    actor_type: comment.authorType,
    actorId: comment.authorId,
    actor_id: comment.authorId,
    createdAt: comment.createdAt,
    created_at: comment.createdAt,
    content: comment.body,
    parentId: comment.parentId,
    parent_id: comment.parentId,
    updatedAt: comment.updatedAt,
    updated_at: comment.updatedAt,
    commentType: "comment",
    comment_type: "comment",
    reactions: comment.reactions,
    attachments: comment.attachments,
    resolvedAt: comment.resolvedAt,
    resolved_at: comment.resolvedAt,
    resolvedByType: comment.resolvedByType,
    resolved_by_type: comment.resolvedByType,
    resolvedById: comment.resolvedById,
    resolved_by_id: comment.resolvedById,
  };
}

function activityToTimelineEntry(activity: MultiremiIssueActivity): MultiremiTimelineEntry {
  return {
    type: "activity",
    id: activity.id,
    actorType: activity.actorType,
    actor_type: activity.actorType,
    actorId: activity.actorId,
    actor_id: activity.actorId,
    createdAt: activity.createdAt,
    created_at: activity.createdAt,
    action: activity.type,
    details: activity.data ?? (activity.body == null ? null : { body: activity.body }),
  };
}

function toIssueSubscriber(row: Row): MultiremiIssueSubscriber {
  const issueId = String(row.issue_id);
  const userType = normalizeIssueSubscriberUserType(String(row.user_type ?? "member"));
  const userId = String(row.user_id ?? row.member_id);
  const memberId = String(row.member_id ?? userId);
  const createdAt = String(row.created_at);
  return {
    id: String(row.id),
    issueId,
    issue_id: issueId,
    memberId,
    member_id: memberId,
    userType,
    user_type: userType,
    userId,
    user_id: userId,
    reason: String(row.reason ?? "manual") as MultiremiSubscriptionReason,
    createdAt,
    created_at: createdAt,
  };
}

function normalizeIssueSubscriberUserType(value: string): "member" | "agent" | string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "agent") return "agent";
  if (normalized === "member" || normalized === "") return "member";
  return normalized;
}

function toInboxItem(row: Row, issue: MultiremiIssue | null): MultiremiInboxItem {
  const workspaceId = String(row.workspace_id ?? "local");
  const issueId = nullableString(row.issue_id);
  const memberId = String(row.member_id);
  const recipientType = String(row.recipient_type ?? "member");
  const recipientId = nullableString(row.recipient_id) ?? memberId;
  const actorType = String(row.actor_type ?? "system");
  const actorId = nullableString(row.actor_id);
  const createdAt = String(row.created_at);
  return {
    id: String(row.id),
    workspaceId,
    workspace_id: workspaceId,
    issueId,
    issue_id: issueId,
    memberId,
    member_id: memberId,
    recipientType,
    recipient_type: recipientType,
    recipientId,
    recipient_id: recipientId,
    actorType,
    actor_type: actorType,
    actorId,
    actor_id: actorId,
    type: String(row.type),
    severity: String(row.severity ?? "info"),
    title: String(row.title ?? ""),
    body: nullableString(row.body),
    details: row.details == null ? null : parseJson(row.details, null),
    read: Number(row.read ?? 0) === 1,
    archived: Number(row.archived ?? 0) === 1,
    createdAt,
    created_at: createdAt,
    issue,
  };
}

function toIssueReaction(row: Row): MultiremiIssueReaction {
  return {
    id: String(row.id),
    issueId: String(row.issue_id),
    workspaceId: String(row.workspace_id ?? "local"),
    actorType: String(row.actor_type ?? "member"),
    actorId: String(row.actor_id ?? "local"),
    emoji: String(row.emoji ?? ""),
    createdAt: String(row.created_at),
  };
}

function toCommentReaction(row: Row): MultiremiCommentReaction {
  return {
    id: String(row.id),
    commentId: String(row.comment_id),
    workspaceId: String(row.workspace_id ?? "local"),
    actorType: String(row.actor_type ?? "member"),
    actorId: String(row.actor_id ?? "local"),
    emoji: String(row.emoji ?? ""),
    createdAt: String(row.created_at),
  };
}

function toAttachment(row: Row): MultiremiAttachment {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    issueId: nullableString(row.issue_id),
    commentId: nullableString(row.comment_id),
    chatSessionId: nullableString(row.chat_session_id),
    chatMessageId: nullableString(row.chat_message_id),
    uploaderType: String(row.uploader_type ?? "member"),
    uploaderId: String(row.uploader_id ?? "local"),
    filename: String(row.filename ?? ""),
    url: String(row.url ?? ""),
    contentType: String(row.content_type ?? "application/octet-stream"),
    sizeBytes: Number(row.size_bytes ?? 0),
    createdAt: String(row.created_at),
  };
}

function toLabel(row: Row): MultiremiLabel {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    name: String(row.name ?? ""),
    color: String(row.color ?? "#6b7280"),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toPinnedItem(row: Row): MultiremiPinnedItem {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    userId: String(row.user_id ?? "local"),
    itemType: String(row.item_type ?? "issue") as MultiremiPinnedItemType,
    itemId: String(row.item_id ?? ""),
    position: Number(row.position ?? 0),
    createdAt: String(row.created_at),
  };
}

function toSquad(row: Row): MultiremiSquad {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    name: String(row.name),
    description: String(row.description ?? ""),
    instructions: String(row.instructions ?? ""),
    leaderId: nullableString(row.leader_id),
    creatorId: nullableString(row.creator_id),
    archivedAt: nullableString(row.archived_at),
    memberCount: Number(row.member_count ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toSquadMember(row: Row): MultiremiSquadMember {
  return {
    id: String(row.id),
    squadId: String(row.squad_id),
    memberType: String(row.member_type) as MultiremiSquadMember["memberType"],
    memberId: String(row.member_id),
    role: String(row.role ?? "member"),
    createdAt: String(row.created_at),
  };
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

function toChatSession(row: Row): MultiremiChatSession {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    creatorId: nullableString(row.creator_id) ?? "local",
    agentId: String(row.agent_id),
    title: String(row.title ?? ""),
    status: String(row.status ?? "active") as MultiremiChatSession["status"],
    sessionId: nullableString(row.session_id),
    workDir: nullableString(row.work_dir),
    latestTaskId: nullableString(row.latest_task_id),
    unreadSince: nullableString(row.unread_since),
    hasUnread: Boolean(row.unread_since),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toChatMessage(row: Row): MultiremiChatMessage {
  return {
    id: String(row.id),
    chatSessionId: String(row.chat_session_id),
    taskId: nullableString(row.task_id),
    role: String(row.role ?? "system") as MultiremiChatMessage["role"],
    body: String(row.body ?? ""),
    failureReason: nullableString(row.failure_reason),
    elapsedMs: row.elapsed_ms == null ? null : Number(row.elapsed_ms),
    createdAt: String(row.created_at),
  };
}

function toTask(row: Row): MultiremiTask {
  const taskResult = normalizeStoredTaskResult(row.result);
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    runtimeId: nullableString(row.runtime_id),
    issueId: nullableString(row.issue_id),
    chatSessionId: nullableString(row.chat_session_id),
    autopilotRunId: nullableString(row.autopilot_run_id),
    triggerCommentId: nullableString(row.trigger_comment_id),
    triggerSummary: nullableString(row.trigger_summary),
    workspaceId: String(row.workspace_id ?? "local"),
    status: String(row.status) as MultiremiTaskStatus,
    priority: Number(row.priority ?? 0),
    prompt: String(row.prompt ?? ""),
    attempt: Number(row.attempt ?? 1),
    maxAttempts: Number(row.max_attempts ?? 3),
    parentTaskId: nullableString(row.parent_task_id),
    result: taskResult.output,
    error: nullableString(row.error),
    failureReason: nullableString(row.failure_reason),
    failure_reason: nullableString(row.failure_reason),
    branchName: nullableString(row.branch_name) ?? taskResult.prUrl,
    sessionId: nullableString(row.session_id) ?? taskResult.sessionId,
    workDir: nullableString(row.work_dir) ?? taskResult.workDir,
    progressSummary: nullableString(row.progress_summary),
    progressStep: row.progress_step == null ? null : Number(row.progress_step),
    progressTotal: row.progress_total == null ? null : Number(row.progress_total),
    waitReason: nullableString(row.wait_reason),
    wait_reason: nullableString(row.wait_reason),
    usage: parseJson(row.usage, []),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    dispatchedAt: nullableString(row.dispatched_at),
    startedAt: nullableString(row.started_at),
    completedAt: nullableString(row.completed_at),
    failedAt: nullableString(row.failed_at),
    cancelledAt: nullableString(row.cancelled_at),
  };
}

function taskCompletionResultPayload(input: {
  output: string;
  branchName?: string | null;
  sessionId?: string | null;
  workDir?: string | null;
}): { pr_url: string; output: string; session_id: string; work_dir: string } {
  return {
    pr_url: input.branchName ?? "",
    output: input.output,
    session_id: input.sessionId ?? "",
    work_dir: input.workDir ?? "",
  };
}

function normalizeStoredTaskResult(value: unknown): {
  output: string | null;
  prUrl: string | null;
  sessionId: string | null;
  workDir: string | null;
} {
  const raw = nullableString(value);
  if (raw == null) return { output: null, prUrl: null, sessionId: null, workDir: null };
  const parsed = parseJsonValue(raw);
  if (typeof parsed === "string") {
    return { output: parsed, prUrl: null, sessionId: null, workDir: null };
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const result = parsed as Record<string, unknown>;
    return {
      output: nullableString(result.output),
      prUrl: nullableString(result.pr_url),
      sessionId: nullableString(result.session_id),
      workDir: nullableString(result.work_dir),
    };
  }
  return { output: raw, prUrl: null, sessionId: null, workDir: null };
}

function toTaskMessage(row: Row): MultiremiTaskMessage {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    seq: Number(row.seq),
    type: String(row.type),
    tool: nullableString(row.tool),
    content: nullableString(row.content),
    input: row.input == null ? null : parseJson(row.input, null),
    output: nullableString(row.output),
    createdAt: String(row.created_at),
  };
}

function toTaskHumanRequest(row: Row): MultiremiTaskHumanRequest {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    kind: normalizeHumanRequestKind(row.kind),
    payload: parseJson(row.payload, {} as Record<string, unknown>) ?? {},
    status: normalizeHumanRequestStatus(row.status),
    response: row.response == null ? null : parseJson(row.response, null),
    respondedBy: nullableString(row.responded_by),
    createdAt: String(row.created_at),
    respondedAt: nullableString(row.responded_at),
  };
}

function normalizeHumanRequestKind(value: unknown): MultiremiTaskHumanRequestKind {
  return String(value ?? "") === "question" ? "question" : "permission";
}

function normalizeHumanRequestStatus(value: unknown): MultiremiTaskHumanRequestStatus {
  const status = String(value ?? "").trim();
  if (status === "pending" || status === "responded" || status === "timeout" || status === "cancelled") return status;
  return "cancelled";
}

function computeChatElapsedMs(task: MultiremiTask): number | null {
  const completedAt = task.completedAt ? Date.parse(task.completedAt) : Number.NaN;
  const createdAt = Date.parse(task.createdAt);
  if (!Number.isFinite(completedAt) || !Number.isFinite(createdAt)) return null;
  return Math.max(0, completedAt - createdAt);
}

export function isTerminalStatus(status: MultiremiTaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

function isActiveTaskStatus(status: MultiremiTaskStatus): boolean {
  return ACTIVE_TASK_STATUSES.includes(status);
}

function isInFlightTaskStatus(status: MultiremiTaskStatus): boolean {
  return IN_FLIGHT_TASK_STATUSES.includes(status);
}

function activeAgentSetMatches(current: MultiremiAgent[], expected: Set<string>): boolean {
  if (current.length !== expected.size) return false;
  return current.every((agent) => expected.has(agent.id));
}
