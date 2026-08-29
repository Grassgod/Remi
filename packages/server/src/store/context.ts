// Cross-domain shared surface for the MultiremiStore domain split (docs/SPLIT-PLAN.md §1.1).
// Holds the db handle, the realtime listener registries, the analytics/metric buffers and the
// private helpers that more than one domain calls. Every member here was moved verbatim out of
// MultiremiStore; the facade now calls through `this.ctx`.
//
// Domain stores carved out in later stages reach each other through lazy getters on this object
// (never constructor injection, which would deadlock the carve order). Most resolve through `host`,
// the MultiremiStore facade, which delegates on to the owning repo. Repo methods the facade does not
// expose publicly (today: the analytics recorders) are instead registered on this object by the
// facade's constructor and resolved at call time.
import { type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { createId, nowIso } from "@multiremi/ids.js";
import { cleanOptionalString, nullableString, parseJson, toJson } from "@multiremi/store/helpers.js";
import { createLogger } from "@shared/logger.js";
import { INBOX_ROUTING, inboxRouteFor } from "@multiremi/store/inbox-routing.js";
import type {
  AddSessionParticipantInput,
  CreateIssueCommentInput,
  CreateIssueInput,
  CreateIssueSessionInput,
  CreateSkillInput,
  CreateTaskInput,
  ListIssuesInput,
  UpdateIssueInput,
  MultiremiAgent,
  MultiremiAgentPlugin,
  MultiremiAgentPluginBinding,
  MultiremiAgentPluginRuntimeState,
  MultiremiTaskPluginSnapshotEntry,
  MultiremiAnalyticsEvent,
  MultiremiAutopilotRun,
  MultiremiDaemonHeartbeatAck,
  MultiremiProjectDocsIndex,
  MultiremiSessionAgentLane,
  MultiremiSkill,
  MultiremiWorkspace,
  MultiremiChatMessage,
  MultiremiChatSession,
  MultiremiInboxItem,
  MultiremiIssueComment,
  MultiremiIssue,
  MultiremiIssueSession,
  MultiremiMetricCounter,
  MultiremiNotificationGroupKey,
  MultiremiNotificationChannel,
  MultiremiNotificationDelivery,
  MultiremiNotificationPreferenceResponse,
  MultiremiAssigneeType,
  MultiremiAutopilot,
  MultiremiAutopilotTrigger,
  MultiremiProject,
  MultiremiProjectDoc,
  MultiremiProjectResource,
  MultiremiRuntime,
  MultiremiRuntimeCommandRequest,
  MultiremiSessionEvent,
  MultiremiSessionParticipant,
  MultiremiSystemEvent,
  MultiremiSquad,
  MultiremiSquadMember,
  MultiremiTask,
  MultiremiTaskMessage,
  MultiremiTaskStatus,
  MultiremiUser,
  MultiremiWebhookDelivery,
  MultiremiWorkspaceMember,
} from "@multiremi/contracts/types.js";

const log = createLogger("multiremi-store");

type Row = Record<string, unknown>;

export const EVENT_RUNTIME_REGISTERED = "runtime_registered";
export const EVENT_RUNTIME_READY = "runtime_ready";
export const EVENT_RUNTIME_FAILED = "runtime_failed";
export const EVENT_RUNTIME_OFFLINE = "runtime_offline";
export const EVENT_AGENT_CREATED = "agent_created";
export const EVENT_AUTOPILOT_CREATED = "autopilot_created";
export const EVENT_AUTOPILOT_RUN_STARTED = "autopilot_run_started";
export const EVENT_AUTOPILOT_RUN_COMPLETED = "autopilot_run_completed";
export const EVENT_AUTOPILOT_RUN_FAILED = "autopilot_run_failed";
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
export const METRIC_WEBHOOK_DELIVERY = "multiremi_webhook_delivery_total";
const KNOWN_ANALYTICS_SOURCES = new Set(["issue", "chat", "autopilot", "autopilot_issue", "quick_create", "manual", "api", "system_event", "other"]);
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
  "agent_error.stale_session",
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
const KNOWN_AUTOPILOT_CADENCES = new Set(["hourly", "daily", "weekly", "monthly", "manual", "webhook", "system_event", "unknown"]);
const KNOWN_AUTOPILOT_TRIGGERS = new Set(["schedule", "webhook", "system_event", "manual", "unknown"]);

export type TaskEnqueuedListener = (task: MultiremiTask) => void;
export type TaskEventListener = (event: { type: string; task: MultiremiTask }) => void;
export type TaskMessagesListener = (event: { task: MultiremiTask; messages: MultiremiTaskMessage[] }) => void;
export type WorkspaceEventListener = (event: {
  type: string;
  workspaceId: string;
  chatSessionId?: string;
  payload: Record<string, unknown>;
  actorType?: string;
  actorId?: string | null;
}) => void;

// The domain surfaces the shared helpers and the carved-out repos need to reach. Resolved lazily so
// that carve order never becomes a construction-order constraint. Each surface is the slice one
// not-yet-carved domain owes the rest; when that domain is carved the accessor below is repointed
// at its repo and nothing else changes.
export interface IssuesSurface {
  createIssue(input: CreateIssueInput): MultiremiIssue;
  createIssueComment(issueId: string, input: CreateIssueCommentInput): MultiremiIssueComment;
  createTaskFailureSystemComment(
    issueId: string,
    issueSessionId: string | null,
    taskId: string,
    body: string,
  ): MultiremiIssueComment;
  getIssue(id: string): MultiremiIssue | null;
  getIssueByRef(ref: string, workspaceId?: string | null): MultiremiIssue | null;
  getIssueComment(id: string): MultiremiIssueComment | null;
  linkAttachmentsToChatMessage(chatSessionId: string, chatMessageId: string, attachmentIds: string[]): void;
  listIssues(input?: ListIssuesInput): MultiremiIssue[];
  listGeneratedIssues(sourceIssueId: string): MultiremiIssue[];
  updateIssue(id: string, input: UpdateIssueInput): MultiremiIssue;
  restoreIssue(id: string): MultiremiIssue;
  archiveEligibleIssues(now?: Date): MultiremiIssue[];
  issueArchiveSweepIntervalMs(): number;
  isSquadLeaderDelegation(input: {
    issue: MultiremiIssue;
    sourceTask: MultiremiTask | null;
    authorAgentId: string | null;
    targetAgentId: string;
    issueSessionId: string | null;
  }): boolean;
}

export interface AgentsSurface {
  getAgent(id: string): MultiremiAgent | null;
  listAgents(options?: { includeArchived?: boolean }): MultiremiAgent[];
  getAgentByRef(ref: string, workspaceId?: string | null): MultiremiAgent | null;
  listActiveAgentsByRuntime(runtimeId: string): MultiremiAgent[];
  createSkill(input: CreateSkillInput): MultiremiSkill;
  createSkillWithinTransaction(input: CreateSkillInput): MultiremiSkill;
  getSkill(id: string, options?: { includeArchived?: boolean; includeFiles?: boolean }): MultiremiSkill | null;
}

export interface AgentPluginsSurface {
  listAgentPlugins(
    workspaceId?: string,
    options?: { provider?: string | null; includeArchived?: boolean },
  ): MultiremiAgentPlugin[];
  listAgentPluginBindings(agentId: string): MultiremiAgentPluginBinding[];
  lockAgentPluginWorkspace(workspaceId: string): void;
  assertAgentPluginWorkspaceMoveAllowed(agentId: string, targetWorkspaceId: string): void;
  reconcileAgentPluginDesiredStateWithinLock(workspaceId: string): void;
  resolveAgentPluginSnapshot(agentId: string): MultiremiTaskPluginSnapshotEntry[];
  getAgentPluginCapabilityRevision(agentId: string): string;
  runtimeHasReadyAgentPlugins(runtimeId: string, agentId: string): boolean;
  assertAgentPluginProviderCompatible(agentId: string, provider: string): void;
  recordAgentPluginRuntimeHeartbeat(runtimeId: string): MultiremiAgentPluginRuntimeState[];
  recordAgentPluginRuntimeHeartbeatWithinLock(runtimeId: string): MultiremiAgentPluginRuntimeState[];
}

// The analytics recorders are shared by the runtimes, autopilots and tasks domains but are not part
// of the MultiremiStore public surface, so they cannot be reached through `resolveHost`. The facade
// registers the AnalyticsRepo here as it constructs it and callers resolve it at call time.
export interface AnalyticsSurface {
  recordRuntimeRegisteredAnalytics(runtime: MultiremiRuntime): void;
  recordRuntimeReadyAnalytics(runtime: MultiremiRuntime, readyDurationMs: number): void;
  recordRuntimeOfflineAnalytics(runtime: MultiremiRuntime): void;
  recordAutopilotCreatedAnalytics(autopilot: MultiremiAutopilot): void;
  recordAutopilotRunStartedAnalytics(autopilot: MultiremiAutopilot, run: MultiremiAutopilotRun): void;
  recordAutopilotRunCompletedAnalytics(autopilot: MultiremiAutopilot, run: MultiremiAutopilotRun): void;
  recordAutopilotRunFailedAnalytics(autopilot: MultiremiAutopilot, run: MultiremiAutopilotRun, reason: string): void;
  recordWebhookDeliveryMetric(delivery: MultiremiWebhookDelivery): void;
}

export interface WorkspacesSurface {
  getUser(id: string): MultiremiUser | null;
  listWorkspaces(): MultiremiWorkspace[];
  getWorkspace(id: string): MultiremiWorkspace | null;
  findWorkspaceMemberForUser(userId: string | null | undefined, workspaceId: string): MultiremiWorkspaceMember | null;
  getWorkspaceMember(id: string): MultiremiWorkspaceMember | null;
  getWorkspaceMemberByRef(ref: string, workspaceId?: string | null): MultiremiWorkspaceMember | null;
  listWorkspaceMembers(workspaceId?: string | null): MultiremiWorkspaceMember[];
  getNotificationPreferences(input?: { workspaceId?: string | null; memberId?: string | null }): MultiremiNotificationPreferenceResponse;
}

export interface NotificationChannelsSurface {
  matchNotificationRoutes(
    workspaceId: string,
    memberId: string,
    inboxType: string,
    severity: string,
  ): MultiremiNotificationChannel[];
  recordPendingNotificationDelivery(
    item: MultiremiInboxItem,
    channel: MultiremiNotificationChannel,
  ): MultiremiNotificationDelivery;
  dispatchNotificationDelivery(id: string): Promise<void>;
}

export interface SquadsSurface {
  getSquad(id: string): MultiremiSquad | null;
  listSquads(workspaceId?: string | null): MultiremiSquad[];
  listSquadMembers(squadId: string): MultiremiSquadMember[];
  resolveAssigneeRef(
    assigneeType: MultiremiAssigneeType | null | undefined,
    assigneeId: string | null | undefined,
    workspaceId?: string | null,
  ): { assigneeType: MultiremiAssigneeType; assigneeId: string } | null;
}

export interface ProjectsSurface {
  getProject(id: string): MultiremiProject | null;
  listProjects(workspaceId?: string | null): MultiremiProject[];
  getProjectDocsIndex(projectId: string): MultiremiProjectDocsIndex;
  listProjectDocs(projectId: string, input?: { kind?: string | null }): MultiremiProjectDoc[];
  listProjectResources(projectId: string): MultiremiProjectResource[];
}

export interface AutopilotsSurface {
  getAutopilot(id: string): MultiremiAutopilot | null;
  listAutopilots(workspaceId?: string | null): MultiremiAutopilot[];
  listAutopilotTriggers(autopilotId: string): MultiremiAutopilotTrigger[];
  getAutopilotRun(id: string): MultiremiAutopilotRun | null;
  runAutopilot(autopilotId: string, input?: import("@multiremi/contracts/types.js").RunAutopilotInput): MultiremiAutopilotRun;
  enqueueIssueStatusChangedEvent(input: {
    issue: MultiremiIssue;
    previousStatus: string;
    actorType?: string | null;
    actorId?: string | null;
    automationSourceEventId?: string | null;
    automationSourceTaskId?: string | null;
  }): MultiremiSystemEvent | null;
}

export interface AccessTokensSurface {
  revokeTaskAccessTokens(taskId: string): number;
}

export interface TasksSurface {
  createTask(input: CreateTaskInput): MultiremiTask;
  /** Internal primitive for a caller that already owns a database transaction. */
  createTaskWithinTransaction(input: CreateTaskInput): MultiremiTask;
  ensureDelegationWakeup(input: {
    sourceTaskId: string;
    requiredEventSeq: number;
    triggerCommentId?: string | null;
    terminalStatus?: "completed" | "failed" | "cancelled" | null;
    terminalBody?: string | null;
  }): { task: MultiremiTask | null; created: boolean; covered: boolean };
  getTask(id: string): MultiremiTask | null;
  listTasks(status?: MultiremiTaskStatus): MultiremiTask[];
  listTasksForIssue(issueId: string): MultiremiTask[];
  cancelTask(taskId: string): MultiremiTask;
  cancelTasksByTriggerComments(workspaceId: string, commentIds: string[]): number;
  listAgentTasks(agentId: string): MultiremiTask[];
}

export interface ChatSurface {
  getChatSession(id: string): MultiremiChatSession | null;
  getChatMessage(id: string): MultiremiChatMessage | null;
}

export interface IssueSessionsSurface {
  getIssueSession(id: string): MultiremiIssueSession | null;
  getOrCreateDefaultIssueSession(issueId: string, createdById?: string | null): MultiremiIssueSession;
  createIssueSessionWithinTransaction(issueId: string, input?: CreateIssueSessionInput): MultiremiIssueSession;
  getLatestActiveIssueSession(issueId: string): MultiremiIssueSession | null;
  addSessionParticipant(sessionId: string, input: AddSessionParticipantInput): MultiremiSessionParticipant;
  getOrCreateSessionAgentLane(sessionId: string, agentId: string): MultiremiSessionAgentLane;
  getSessionAgentLane(sessionId: string, agentId: string): MultiremiSessionAgentLane | null;
  appendSessionEvent(sessionId: string, input: {
    authorType: string;
    authorId?: string | null;
    kind?: string;
    body?: string;
    taskId?: string | null;
    sourceCommentId?: string | null;
    metadata?: Record<string, unknown>;
    createdAt?: string;
  }): MultiremiSessionEvent;
  appendSessionEventWithinTransaction(sessionId: string, input: {
    authorType: string;
    authorId?: string | null;
    kind?: string;
    body?: string;
    taskId?: string | null;
    sourceCommentId?: string | null;
    metadata?: Record<string, unknown>;
    createdAt?: string;
  }): MultiremiSessionEvent;
}

export interface RuntimesSurface {
  getRuntime(id: string): MultiremiRuntime | null;
  listRuntimes(): MultiremiRuntime[];
  createRuntimeCommandRequest(runtimeId: string, input: import("@multiremi/contracts/types.js").CreateRuntimeCommandInput): MultiremiRuntimeCommandRequest;
  getRuntimeCommandRequest(runtimeId: string, requestId: string): MultiremiRuntimeCommandRequest | null;
  getRuntimeByDaemonAndProvider(daemonId: string, provider: string): MultiremiRuntime | null;
  heartbeatRuntime(runtimeId: string, options?: {
    claimPending?: boolean;
    supportsBatchImport?: boolean;
    supportsDirectoryScan?: boolean;
    agentPluginProtocol?: number;
  }): MultiremiDaemonHeartbeatAck;
  runtimeCanRunAgent(runtime: MultiremiRuntime, agent: MultiremiAgent): boolean;
}

export interface StoreContextHost extends AgentsSurface, AgentPluginsSurface, IssuesSurface, WorkspacesSurface, NotificationChannelsSurface, SquadsSurface, ProjectsSurface, TasksSurface, RuntimesSurface, ChatSurface, IssueSessionsSurface, AutopilotsSurface, AccessTokensSurface {}

export class StoreContext {
  readonly taskEnqueuedListeners = new Set<TaskEnqueuedListener>();
  readonly taskEventListeners = new Set<TaskEventListener>();
  readonly taskMessagesListeners = new Set<TaskMessagesListener>();
  readonly workspaceEventListeners = new Set<WorkspaceEventListener>();
  readonly analyticsEvents: MultiremiAnalyticsEvent[] = [];
  readonly metricCounters = new Map<string, MultiremiMetricCounter>();

  private analyticsRepo: AnalyticsSurface | null = null;

  constructor(readonly db: SqlDatabase, private readonly resolveHost: () => StoreContextHost) {}

  private get host(): StoreContextHost {
    return this.resolveHost();
  }

  /**
   * Wire the analytics recorders onto this context. `MultiremiStore`'s constructor does this for
   * every context it owns; anything that builds a StoreContext by hand (tests, tools) must call it
   * too, or the first {@link analytics} call throws.
   */
  registerAnalytics(repo: AnalyticsSurface): void {
    this.analyticsRepo = repo;
  }

  /**
   * The analytics recorders, used by the runtimes, autopilots and tasks repos.
   *
   * Unlike the other cross-domain accessors this one is not resolved through `resolveHost` — the
   * recorders are not on the MultiremiStore public surface — so it can only fail at call time, long
   * after the context was built. {@link registerAnalytics} is the wiring that prevents that.
   *
   * @throws if `registerAnalytics` was never called on this context.
   */
  analytics(): AnalyticsSurface {
    if (!this.analyticsRepo) {
      throw new Error(
        "analytics repo is not registered on this StoreContext — call ctx.registerAnalytics(new AnalyticsRepo(ctx)) " +
          "after constructing it, the way the MultiremiStore constructor does",
      );
    }
    return this.analyticsRepo;
  }

  /**
   * Serialize workspace-scoped Runtime lifecycle mutations across SQLite and
   * Postgres. Daemon retirement holds this row lock while it re-reads its plan
   * and removes Runtime-affine state; every write that can add such state must
   * take the same lock and revalidate after acquiring it.
   *
   * The caller must already be inside a database transaction.
   */
  lockWorkspaceRuntimeLifecycle(workspaceId: string): void {
    this.db.run(
      "UPDATE multiremi_workspaces SET updated_at = updated_at WHERE id = ?",
      [workspaceId],
    );
  }

  /** Serialize repository topology and project repository-resource mutations. */
  lockWorkspaceRepositoryTopology(workspaceId: string): void {
    this.db.run(
      "UPDATE multiremi_workspaces SET updated_at = updated_at WHERE id = ?",
      [workspaceId],
    );
  }

  /** Caller holds the workspace lifecycle lock and is inside a transaction. */
  lockIssueArchiveLifecycle(issueId: string): void {
    this.db.run(
      "UPDATE multiremi_issues SET lifecycle_state = lifecycle_state WHERE id = ?",
      [issueId],
    );
  }

  // Lazy cross-domain accessors. A carved-out repo reaches a domain it does not own through these,
  // never through a constructor-injected sibling (which would deadlock the carve order). Today they
  // all resolve to the still-monolithic facade.
  agents(): AgentsSurface {
    return this.resolveHost();
  }

  agentPlugins(): AgentPluginsSurface {
    return this.resolveHost();
  }

  issues(): IssuesSurface {
    return this.resolveHost();
  }

  workspaces(): WorkspacesSurface {
    return this.resolveHost();
  }

  squads(): SquadsSurface {
    return this.resolveHost();
  }

  projects(): ProjectsSurface {
    return this.resolveHost();
  }

  tasks(): TasksSurface {
    return this.resolveHost();
  }

  runtimes(): RuntimesSurface {
    return this.resolveHost();
  }

  autopilots(): AutopilotsSurface {
    return this.resolveHost();
  }

  accessTokens(): AccessTokensSurface {
    return this.resolveHost();
  }

  chat(): ChatSurface {
    return this.resolveHost();
  }

  issueSessions(): IssueSessionsSurface {
    return this.resolveHost();
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

  emitChatEvent(
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

  notifyTaskEnqueued(task: MultiremiTask): void {
    for (const listener of [...this.taskEnqueuedListeners]) {
      try {
        listener(task);
      } catch {
        // Wakeup listeners are best-effort and must not roll back task enqueue.
      }
    }
  }

  notifyTaskMessages(task: MultiremiTask, messages: MultiremiTaskMessage[]): void {
    if (messages.length === 0) return;
    for (const listener of [...this.taskMessagesListeners]) {
      try {
        listener({ task, messages });
      } catch {
        // Realtime broadcast is best-effort and must not roll back the append.
      }
    }
  }

  notifyTaskEvent(type: string, task: MultiremiTask): void {
    for (const listener of [...this.taskEventListeners]) {
      try {
        listener({ type, task });
      } catch {
        // Realtime listeners are best-effort and must not roll back task state.
      }
    }
  }

  recordAnalyticsEvent(
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

  incrementMetricForAnalyticsEvent(event: MultiremiAnalyticsEvent): void {
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

  incrementMetricCounter(name: string, labels: Record<string, string>): void {
    const key = metricCounterKey(name, labels);
    const current = this.metricCounters.get(key);
    if (current) {
      current.value += 1;
      return;
    }
    this.metricCounters.set(key, { name, labels: { ...labels }, value: 1 });
  }

  appendIssueActivity(issueId: string, input: {
    actorType: string;
    actorId?: string | null;
    type: string;
    body?: string | null;
    data?: unknown | null;
  }): void {
    const id = createId("act");
    const now = nowIso();
    this.db.run(
      `INSERT INTO multiremi_issue_activity (id, issue_id, actor_type, actor_id, type, body, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        issueId,
        input.actorType,
        input.actorId ?? null,
        input.type,
        input.body ?? null,
        input.data == null ? null : toJson(input.data),
        now,
      ],
    );
    // Browsers listen for activity:created to append the timeline row live.
    // Emitting here (not in the HTTP layer) covers agent/daemon-driven writes,
    // which never pass through an HTTP mutation. `entry` mirrors the activity
    // shape of GET /api/issues/:id/timeline. Best-effort: the activity is
    // already persisted, so a lookup/broadcast failure must not escape and
    // fail the caller's mutation after the fact.
    try {
      const workspaceId = this.issueWorkspaceId(issueId);
      if (!workspaceId) return;
      this.emitWorkspaceEvent({
        type: "activity:created",
        workspaceId,
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        payload: {
          issue_id: issueId,
          entry: {
            type: "activity",
            id,
            actor_type: input.actorType,
            actor_id: input.actorId ?? null,
            created_at: now,
            action: input.type,
            details: input.data ?? (input.body == null ? null : { body: input.body }),
          },
        },
      });
    } catch (err) {
      log.warn(`activity:created broadcast skipped for ${issueId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Cross-domain: the agent that actually runs work for an assignee ref. Called by the tasks,
  // autopilots and analytics bands, so it lives here rather than in any one of them.
  resolveRunnableAgentForAssignee(assigneeType: MultiremiAssigneeType, assigneeId: string): MultiremiAgent | null {
    if (assigneeType === "agent") {
      const agent = this.agents().getAgent(assigneeId);
      return agent?.archivedAt ? null : agent;
    }
    if (assigneeType !== "squad") return null;
    const squad = this.squads().getSquad(assigneeId);
    if (!squad) return null;
    if (squad.archivedAt) return null;
    if (squad.leaderId) {
      const leader = this.agents().getAgent(squad.leaderId);
      if (leader && !leader.archivedAt) return leader;
    }
    for (const member of this.squads().listSquadMembers(squad.id).filter((m) => m.memberType === "agent")) {
      const agent = this.agents().getAgent(member.memberId);
      if (agent && !agent.archivedAt) return agent;
    }
    return null;
  }

  resolveAutopilotAgent(autopilot: MultiremiAutopilot): MultiremiAgent | null {
    return this.resolveRunnableAgentForAssignee(autopilot.assigneeType, autopilot.assigneeId);
  }

  // Cross-domain: read by the agents (updateAgent rescheduling), runtimes and tasks bands.
  localDirectoryDaemonForTask(taskRow: Row): string | null {
    const issueId = cleanOptionalString(taskRow.issue_id);
    if (!issueId) return null;
    const issue = this.issues().getIssue(issueId);
    if (!issue?.projectId) return null;
    for (const resource of this.projects().listProjectResources(issue.projectId)) {
      if (resource.resourceType !== "local_directory") continue;
      const daemonId = String(resource.resourceRef.daemonId ?? resource.resourceRef.daemon_id ?? "").trim();
      if (daemonId) return daemonId;
    }
    return null;
  }

  // Cross-domain: the un-hydrated comment row. Read by the issues band and by the tasks band
  // (createTask / getTaskTriggerMetadata / getThreadRootCommentId), so it lives here.
  getRawIssueComment(id: string): MultiremiIssueComment | null {
    const row = this.db.query("SELECT * FROM multiremi_issue_comments WHERE id = ?").get(id) as Row | null;
    return row ? toIssueComment(row) : null;
  }

  // Lightweight workspace lookup for realtime broadcasts — the hydrated
  // getIssue() runs several queries, which is wasted work on hot write paths.
  issueWorkspaceId(issueId: string): string | null {
    const row = this.db.query("SELECT workspace_id FROM multiremi_issues WHERE id = ?").get(issueId) as { workspace_id?: unknown } | null;
    return row ? String(row.workspace_id ?? "local") : null;
  }

  createInboxItem(input: {
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
    bypassMute?: boolean;
    issueStatus?: string | null;
  }): MultiremiInboxItem | null {
    const routing = INBOX_ROUTING[input.type];
    const route = inboxRouteFor(input.type, { issueStatus: input.issueStatus, actorType: input.actorType });
    if (route === "workbench_only" || route === "activity_only") return null;
    const issueId = cleanOptionalString(input.issueId);
    const issue = issueId ? this.host.getIssue(issueId) : null;
    if (issueId && !issue) throw new Error(`Issue not found: ${issueId}`);
    const workspaceId = issue?.workspaceId ?? cleanOptionalString(input.workspaceId) ?? "local";
    const recipientType = input.recipientType ?? "member";
    const rawRecipientId = cleanOptionalString(input.recipientId ?? input.memberId);
    if (recipientType !== "member" || !rawRecipientId) return null;
    const member = this.resolveWorkspaceMemberForNotification(workspaceId, rawRecipientId);
    if (!member || member.archivedAt) return null;
    if (!input.bypassMute && this.isNotificationMuted(workspaceId, member.id, input.type)) return null;
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
        input.severity ?? routing?.severity ?? "info",
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
    this.fanOutInboxItem(item);
    return item;
  }

  private fanOutInboxItem(item: MultiremiInboxItem): void {
    try {
      const routes = this.host.matchNotificationRoutes(
        item.workspaceId,
        item.memberId,
        item.type,
        item.severity,
      );
      for (const route of routes) {
        const delivery = this.host.recordPendingNotificationDelivery(item, route);
        queueMicrotask(() => void this.host.dispatchNotificationDelivery(delivery.id));
      }
    } catch (error) {
      log.warn(
        `notification fan-out skipped for inbox item ${item.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  resolveWorkspaceMemberForNotification(workspaceId: string, idOrUserId: string): MultiremiWorkspaceMember | null {
    const exact = this.host.getWorkspaceMember(idOrUserId);
    if (exact && exact.workspaceId === workspaceId) return exact;
    return this.host.listWorkspaceMembers(workspaceId).find((member) =>
      member.id === idOrUserId || member.id === `mem_${workspaceId}_${idOrUserId}`
    ) ?? null;
  }

  resolveAutopilotNotificationRecipients(autopilot: MultiremiAutopilot): string[] {
    if (autopilot.createdByType === "member") {
      const member = this.resolveWorkspaceMemberForNotification(autopilot.workspaceId, autopilot.createdById);
      return member ? [member.id] : [];
    }
    const agent = this.agents().getAgent(autopilot.createdById);
    if (!agent?.ownerId) return [];
    const owner = this.resolveWorkspaceMemberForNotification(autopilot.workspaceId, agent.ownerId);
    return owner ? [owner.id] : [];
  }

  isNotificationMuted(workspaceId: string, memberId: string, type: string): boolean {
    const group = notificationGroupForInboxType(type);
    if (!group) return false;
    const memberPreferences = this.host.getNotificationPreferences({ workspaceId, memberId }).preferences;
    if (memberPreferences[group] === "muted") return true;
    const workspacePreferences = this.host.getNotificationPreferences({ workspaceId }).preferences;
    return workspacePreferences[group] === "muted";
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

export function normalizeMetricLabel(value: string | null | undefined, known: Set<string>, fallback: string): string {
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

function notificationGroupForInboxType(type: string): MultiremiNotificationGroupKey | null {
  if (type === "issue_assigned" || type === "unassigned") return "assignments";
  if (type === "comment_created" || type === "comment_mention") return "comments";
  if (type === "status_changed") return "status_changes";
  if (
    type === "feishu_message_notification"
    || type === "feishu_reply_draft"
    || type === "feishu_issue_proposal"
  ) return "feishu_messages";
  if (type === "feishu_ingest_connection_alert") return "system_notifications";
  if (type.startsWith("agent_")) return "agent_activity";
  if (
    type.startsWith("system_")
    || type === "autopilot_paused"
    || type === "autopilot_run_completed"
    || type === "autopilot_run_failed"
    || type === "organizer_action"
  ) return "system_notifications";
  return "updates";
}

export function toInboxItem(row: Row, issue: MultiremiIssue | null): MultiremiInboxItem {
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

export function toIssueComment(row: Row): MultiremiIssueComment {
  const issueId = String(row.issue_id);
  const issueSessionId = nullableString(row.issue_session_id);
  const authorType = String(row.author_type ?? "member");
  const authorId = nullableString(row.author_id);
  const taskId = nullableString(row.task_id);
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
    issueSessionId,
    issue_session_id: issueSessionId,
    authorType,
    author_type: authorType,
    authorId,
    author_id: authorId,
    taskId,
    task_id: taskId,
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
