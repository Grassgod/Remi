import { type SqlDatabase, openMultiremiDatabase } from "@multiremi/store/db/postgres.js";
import { runMigrations } from "@multiremi/store/migrations.js";
import { daemonRuntimeId, isTerminalStatus } from "@multiremi/store/helpers.js";
import { agentRoleAtLeast } from "@multiremi/store/agent-role.js";
import { FeedbackRepo } from "@multiremi/store/repos/feedback-repo.js";
import { AccessTokensRepo } from "@multiremi/store/repos/access-tokens-repo.js";
import { IssueSharesRepo } from "@multiremi/store/repos/issue-shares-repo.js";
import {
  NotificationChannelsRepo,
  type CreateNotificationChannelInput,
  type NotificationVisibilityScope,
  type NotificationDeliveryContext,
  type UpdateNotificationChannelInput,
} from "@multiremi/store/repos/notification-channels-repo.js";
import {
  AgentIssueUpdatesRepo,
  type AgentIssueUpdateFlushResult,
  type QueueAgentIssueUpdateInput,
} from "@multiremi/store/repos/agent-issue-updates-repo.js";
import {
  OutboundNotificationDispatcher,
  type NotificationSenderRegistry,
} from "@multiremi/notifications/outbound-dispatcher.js";
import { CloudRuntimeNodesRepo } from "@multiremi/store/repos/cloud-runtime-nodes-repo.js";
import { PlatformOperationsRepo } from "@multiremi/store/repos/platform-operations-repo.js";
import { PlatformMaintenanceRepo } from "@multiremi/store/repos/platform-maintenance-repo.js";
import { AgentsSkillsRepo } from "@multiremi/store/repos/agents-skills-repo.js";
import { AgentPluginsRepo } from "@multiremi/store/repos/agent-plugins-repo.js";
import {
  ScmRepo,
  type RecordScmCanonicalEventResult,
  type ScmConnectionWithRepositories,
} from "@multiremi/store/repos/scm-repo.js";
import { MessagingRepo } from "@multiremi/store/repos/messaging-repo.js";
import { MessagingOutcomeService } from "@multiremi/messaging/outcomes.js";
import {
  FeishuBotRepo,
  type FeishuBotStatusSnapshot,
} from "@multiremi/store/repos/feishu-bot-repo.js";
import {
  FeishuIngestRepo,
  type CreateFeishuInboxOutcomeInput,
  type CreateFeishuInboxOutcomeResult,
  type CreateFeishuIssueOutcomeInput,
  type CreateFeishuIssueOutcomeResult,
  type CreateFeishuIssueProposalInput,
  type CreateFeishuIssueProposalResult,
  type ResolveFeishuIssueProposalResult,
  type ClaimFeishuSyncStreamInput,
  type IngestedFeishuMessageInput,
  type IngestFeishuBatchResult,
  type ReconcileFeishuUnprocessedResult,
  type UpdateClaimedFeishuSyncCursorInput,
} from "@multiremi/store/repos/feishu-ingest-repo.js";
import type {
  ScmSnapshotEventFactory,
  ScmSnapshotEventWriteResult,
} from "@multiremi/scm/types.js";
import { UsageRepo } from "@multiremi/store/repos/usage-repo.js";
import { SquadsRepo } from "@multiremi/store/repos/squads-repo.js";
import { ProjectsRepo, type ProjectInstructionsWriteContext } from "@multiremi/store/repos/projects-repo.js";
import {
  RepositoryWikiRepo,
  type RepositoryWikiStorageJob,
  type RepositoryWikiStorageJobInput,
  type RepositoryWikiStorageFinalization,
  type RepositoryWikiStoreBatchOperation,
  type RepositoryWikiWriteControl,
} from "@multiremi/store/repos/repository-wiki-repo.js";
import {
  KnowledgeRepo,
  type KnowledgeListInput,
  type KnowledgeRunListInput,
  type RecordKnowledgeOutputInput,
  type RepositoryMergeKnowledgeEventInput,
} from "@multiremi/store/repos/knowledge-repo.js";
import { resolveRepositoryWikiAutomation } from "@multiremi/repository-wiki/automation.js";
import { IssueSessionsRepo } from "@multiremi/store/repos/issue-sessions-repo.js";
import { ChatRepo } from "@multiremi/store/repos/chat-repo.js";
import {
  IssuesRepo,
  type BeginIssueDeletionResult,
  type IssueMutationActivityContext,
} from "@multiremi/store/repos/issues-repo.js";
import { IssueWorkspacesRepo } from "@multiremi/store/repos/issue-workspaces-repo.js";
import {
  SessionArchivesRepo,
  type SessionArchiveStatusSnapshot,
  type SessionArchiveWorkspaceUsage,
} from "@multiremi/store/repos/session-archives-repo.js";
import {
  RuntimesRepo,
  type ArchiveAgentsAndDeleteRuntimeResult,
  type StrictRuntimeDeleteResult,
} from "@multiremi/store/repos/runtimes-repo.js";
import {
  DaemonProfilesRepo,
  type DaemonProfile,
} from "@multiremi/store/repos/daemon-profiles-repo.js";
import { RuntimeProvisionsRepo } from "@multiremi/store/repos/runtime-provisions-repo.js";
import {
  DaemonRetirementRepo,
  type DaemonInventoryEntry,
  type DaemonRetirementPlan,
  type DaemonRetirementSshMeshRekey,
  type DaemonRetirementSshMeshRekeyStatus,
  type RetireDaemonResult,
} from "@multiremi/store/repos/daemon-retirement-repo.js";
import {
  SshMeshRepo,
  type SshMeshBrowserOverview,
} from "@multiremi/store/repos/ssh-mesh-repo.js";
import type { SshMeshKeyMaterial } from "@multiremi/ssh-mesh/keys.js";
import { TasksRepo } from "@multiremi/store/repos/tasks-repo.js";
import { OrganizerActionError, readOrganizerMode } from "../organizer/settings.js";
import {
  AutopilotsRepo,
  type MultiremiAutopilotFailureThresholdCandidate,
  type MultiremiAutopilotFailureThresholdOptions,
  type MultiremiAutopilotRunRecord,
  type RunAutopilotStoreInput,
} from "@multiremi/store/repos/autopilots-repo.js";
// The autopilot failure-monitor option/candidate shapes used to be declared here; keep the public surface unchanged.
export type {
  MultiremiAutopilotFailureThresholdCandidate,
  MultiremiAutopilotFailureThresholdOptions,
  MultiremiAutopilotRunRecord,
  RunAutopilotStoreInput,
} from "@multiremi/store/repos/autopilots-repo.js";
import {
  AnalyticsRepo,
  type AgentCreatedAnalyticsInput,
  type RuntimeFailureAnalyticsInput,
} from "@multiremi/store/repos/analytics-repo.js";
import {
  WorkspacesRepo,
  type GatewayModelsSnapshot,
  type RelayConfigForBrowser,
  type RelayConfigForDaemon,
  type RelayEngine,
} from "@multiremi/store/repos/workspaces-repo.js";
// The relay/gateway config types used to be declared here; keep the public surface unchanged.
export type {
  GatewayModelsSnapshot,
  RelayConfigForBrowser,
  RelayConfigForDaemon,
  RelayEngine,
  RelayEngineBrowser,
  RelayEngineConfig,
} from "@multiremi/store/repos/workspaces-repo.js";
import {
  StoreContext,
  type TaskEnqueuedListener,
  type TaskEventListener,
  type TaskMessagesListener,
  type WorkspaceEventListener,
} from "@multiremi/store/context.js";
import type {
  AdvanceScmEntitySnapshotResult,
  AddSessionParticipantInput,
  AddSquadMemberInput,
  AssignIssueInput,
  AssignIssueResult,
  CreateAccessTokenInput,
  CreateBotMenuPublishRequestInput,
  CreateAgentInput,
  CreateAgentPluginBindingInput,
  CreateAgentPluginVersionInput,
  CreateAutopilotInput,
  CreateAutopilotTriggerInput,
  CreateCloudRuntimeNodeInput,
  CreateChatSessionInput,
  CreateAttachmentInput,
  CreateFeedbackInput,
  CreateIssueDependencyInput,
  CreateIssueCommentInput,
  CreateIssueInput,
  CreateIssueSessionInput,
  InitSessionArchiveInput,
  ReportSessionArchiveFailureInput,
  BatchDeleteIssuesInput,
  BatchUpdateIssuesInput,
  CreateLabelInput,
  CreatePinnedItemInput,
  CreateProjectDocInput,
  CreateProjectDeviceInput,
  CreateRepositoryWikiDocInput,
  CreateProjectInput,
  CreateProjectResourceInput,
  ReplaceProjectDevicesInput,
  CreateRuntimeUpdateInput,
  CreateRuntimeCommandInput,
  CreateWorkspaceRuntimeProvisionInput,
  CreateRuntimeLocalSkillImportInput,
  CreateSessionTaskInput,
  CreateSkillInput,
  ImportAgentPluginInput,
  CreateSquadInput,
  CreateTaskHumanRequestInput,
  CreateTaskInput,
  CreateTaskSteerMessageInput,
  CreateWorkspaceInvitationInput,
  CreateWorkspaceInput,
  CreateWorkspaceMemberInput,
  MultiremiAutopilot,
  MultiremiBotMenuPublishRequest,
  MultiremiAutopilotRun,
  MultiremiAutopilotTrigger,
  MultiremiWebhookDelivery,
  MultiremiWebhookDeliveryResult,
  MultiremiWebhookProvider,
  MultiremiWebhookSignatureStatus,
  MultiremiAccessToken,
  MultiremiCreatedAccessToken,
  MultiremiAccessTokenType,
  MultiremiAgent,
  MultiremiAgentPlugin,
  MultiremiAgentPluginBinding,
  MultiremiAgentPluginRuntimeDesiredSnapshot,
  MultiremiAgentPluginRuntimeState,
  MultiremiAgentPluginVersion,
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
  MultiremiDaemonSshMeshConfig,
  MultiremiDaemonSshMeshStatus,
  MultiremiSshMeshHeartbeatAck,
  MultiremiInboxItem,
  MultiremiInboxPage,
  MultiremiInboxSummary,
  MultiremiIssueActivity,
  MultiremiIssueChildProgress,
  MultiremiIssueComment,
  ListIssueCommentsInput,
  ListIssueCommentsResult,
  MultiremiIssueDependency,
  MultiremiIssue,
  CreateKnowledgeCompilationRunInput,
  CreateKnowledgeSubmissionInput,
  MultiremiKnowledgeCompilationOutput,
  MultiremiKnowledgeCompilationRun,
  MultiremiKnowledgeCompilationRunSource,
  MultiremiKnowledgeCompilationStatus,
  MultiremiKnowledgeCursorPage,
  MultiremiKnowledgeSubmission,
  MultiremiKnowledgeSubmissionStatus,
  MultiremiIssueShare,
  MultiremiIssueSession,
  MultiremiSessionArchive,
  MultiremiIssueAssigneeGroup,
  MultiremiIssueSearchResult,
  MultiremiFeedback,
  MultiremiLabel,
  MultiremiNotificationPreferences,
  MultiremiNotificationPreferenceResponse,
  MultiremiNotificationChannel,
  MultiremiNotificationDelivery,
  MultiremiNotificationDeliveryStatus,
  MultiremiAgentIssueUpdateSubscription,
  MultiremiOrganizerAction,
  MultiremiOrganizerActionKind,
  MultiremiPinnedItem,
  MultiremiIssueReaction,
  MultiremiIssueSubscriber,
  MultiremiIssueWithTasks,
  MultiremiIssueWorkspace,
  ListIssuesInput,
  MultiremiMetricCounter,
  MultiremiProject,
  MultiremiProjectDevice,
  MultiremiProjectDoc,
  MultiremiProjectDocRevision,
  MultiremiRepositoryWikiDoc,
  MultiremiRepositoryWikiDocRevision,
  RepositoryWikiBatchResult,
  MultiremiProjectDocsIndex,
  MultiremiProjectResource,
  MultiremiProjectSearchResult,
  MultiremiRuntimeDirectoryScanRequest,
  MultiremiRuntimeCommandRequest,
  MultiremiRuntimeProvisionState,
  MultiremiRuntimeLocalSkillImportRequest,
  MultiremiRuntimeLocalSkillListRequest,
  MultiremiRuntimeModelListRequest,
  MultiremiRuntimeUpdateRequest,
  MultiremiWorkspaceRuntimeProvision,
  MultiremiWorkspaceProjectDoc,
  PublishSessionResultInput,
  QuickCreateIssueInput,
  ReportRuntimeDirectoryScanInput,
  ReportBotMenuPublishInput,
  ReportRuntimeCommandInput,
  ReportRuntimeModelListInput,
  QuickCreateIssueResult,
  ReportRuntimeLocalSkillImportInput,
  ReportRuntimeLocalSkillListInput,
  ReportRuntimeUpdateInput,
  UpdateWorkspaceRuntimeProvisionInput,
  MultiremiAgentRuntime,
  MultiremiRuntime,
  MultiremiRuntimeDaily,
  MultiremiRuntimeModel,
  MultiremiRuntimeUsage,
  MultiremiSkill,
  MultiremiSkillFile,
  MultiremiSessionAgentLane,
  MultiremiSessionEvent,
  MultiremiSessionParticipant,
  MultiremiSessionProjection,
  MultiremiSessionResult,
  MultiremiSystemEvent,
  MultiremiSquad,
  MultiremiSquadMember,
  MultiremiTask,
  MultiremiTaskQueueBlocker,
  MultiremiTaskActivityByHour,
  MultiremiTaskHumanRequest,
  MultiremiTaskMessage,
  MultiremiTaskPromptArtifact,
  MultiremiTaskStatus,
  MultiremiTaskSteerMessage,
  MultiremiTaskTriggerMetadata,
  MultiremiTaskWithAgent,
  MultiremiTaskPluginSnapshotEntry,
  MultiremiTimelineEntry,
  MultiremiSubscriptionReason,
  MultiremiUsageByAgent,
  MultiremiUsageByHour,
  MultiremiUsageDaily,
  MultiremiUser,
  MultiremiWorkspace,
  MultiremiWorkspaceInvitation,
  MultiremiWorkspaceMember,
  MarkIssueWorkspaceCleanedInput,
  RegisterRuntimeInput,
  RecordTaskPromptInput,
  ReportAgentPluginRuntimeStateInput,
  ReportIssueWorkspaceInput,
  ReorderPinnedItemInput,
  RemoveSquadMemberInput,
  RunAutopilotInput,
  SendChatMessageInput,
  SendChatMessageResult,
  SetAgentSkillsInput,
  TaskMessageInput,
  TaskUsageEntry,
  UpdateAgentInput,
  UpdateAgentPluginBindingInput,
  UpdateAgentPluginInput,
  UpdateAutopilotInput,
  UpdateAutopilotTriggerInput,
  UpdateChatSessionInput,
  UpdateIssueInput,
  UpdateIssueCommentInput,
  UpdateIssueSessionInput,
  UpdateLabelInput,
  UpdateMultiremiUserInput,
  UpdateProjectDocInput,
  UpdateRepositoryWikiDocInput,
  UpdateProjectInput,
  UpdateProjectResourceInput,
  UpdateRuntimeInput,
  UpdateSkillInput,
  UpdateSquadInput,
  UpdateWorkspaceMemberInput,
} from "@multiremi/contracts/types.js";
import type { ProjectKnowledgeWriteControl } from "@multiremi/project-knowledge/types.js";
import type {
  CreatePlatformOperationInput,
  MultiremiPlatformDrainStatus,
  MultiremiPlatformMaintenance,
  MultiremiPlatformOperation,
  MultiremiPlatformRelease,
  MultiremiPlatformService,
  ReportPlatformOperationInput,
} from "@multiremi/contracts/types.js";
import type {
  ClaimScmSyncStreamInput,
  CreateScmConnectionInput,
  MultiremiScmCanonicalEvent,
  MultiremiScmCanonicalEventType,
  MultiremiScmChangeRequest,
  MultiremiScmConnection,
  MultiremiScmConnectionCredential,
  MultiremiScmVerificationResult,
  MultiremiScmEntitySnapshot,
  MultiremiScmEntityType,
  MultiremiScmEventEvidence,
  MultiremiScmIssueLink,
  MultiremiScmProvider,
  MultiremiScmRepositoryBinding,
  MultiremiScmSyncCursor,
  MultiremiScmSyncStream,
  CreateMultiremiFeishuSourceInput,
  FeishuBotAuditAction,
  MultiremiFeishuBotAuditEntry,
  MultiremiFeishuBotConfig,
  MultiremiFeishuBotDaemonConfig,
  MultiremiFeishuBotDirective,
  MultiremiFeishuBotOutboundDelivery,
  MultiremiFeishuBotRuntimeStatus,
  MultiremiFeishuMessage,
  MultiremiFeishuMessageOutcome,
  MultiremiFeishuSource,
  MultiremiFeishuSyncCursor,
  MultiremiFeishuSourceStatus,
  RecordScmCanonicalEventInput,
  ReportFeishuBotRuntimeStatusInput,
  ResolveMultiremiFeishuMessageInput,
  UpsertFeishuBotConfigInput,
  ReleaseScmSyncStreamInput,
  UpdateMultiremiFeishuSourceInput,
  UpdateScmConnectionInput,
  UpdateClaimedScmSyncCursorInput,
  UpsertScmEntitySnapshotInput,
  UpsertScmRepositoryBindingInput,
  UpsertScmSyncCursorInput,
} from "@multiremi/contracts/types.js";

// daemonRuntimeId / isTerminalStatus used to live here; api.ts and index.ts import them from this module.
export { daemonRuntimeId, isTerminalStatus };

export class MultiremiStore {
  private db: SqlDatabase;
  private ctx: StoreContext;
  private feedback: FeedbackRepo;
  private accessTokens: AccessTokensRepo;
  private issueShares: IssueSharesRepo;
  private notificationChannels: NotificationChannelsRepo;
  private notificationDispatcher: OutboundNotificationDispatcher;
  private agentIssueUpdates: AgentIssueUpdatesRepo;
  private cloudNodes: CloudRuntimeNodesRepo;
  private platformOperations: PlatformOperationsRepo;
  private platformMaintenance: PlatformMaintenanceRepo;
  private agents: AgentsSkillsRepo;
  private agentPlugins: AgentPluginsRepo;
  private workspaces: WorkspacesRepo;
  private scm: ScmRepo;
  private feishuIngest: FeishuIngestRepo;
  private feishuBot: FeishuBotRepo;
  /**
   * The Messaging Core's persistence, exposed whole rather than through
   * per-method delegates.
   *
   * The Core is a self-contained subsystem with its own contract, and it is
   * the only caller; mirroring its surface here would add a second place to
   * keep in step without adding a boundary.
   */
  readonly messaging: MessagingRepo;
  /**
   * What a reviewer or an agent decided about an ingested message.
   *
   * Separate from {@link messaging} because recording an outcome can create an
   * Inbox item or an Issue, which belong to other subsystems; keeping it out of
   * the repo is what lets the repo stay pure persistence.
   */
  readonly messagingOutcomes: MessagingOutcomeService;
  private usage: UsageRepo;
  private squads: SquadsRepo;
  private analytics: AnalyticsRepo;
  private projects: ProjectsRepo;
  private repositoryWiki: RepositoryWikiRepo;
  private knowledge: KnowledgeRepo;
  private sessions: IssueSessionsRepo;
  private chat: ChatRepo;
  private issues: IssuesRepo;
  private issueWorkspaces: IssueWorkspacesRepo;
  private sessionArchives: SessionArchivesRepo;
  private runtimes: RuntimesRepo;
  private daemonProfiles: DaemonProfilesRepo;
  private runtimeProvisions: RuntimeProvisionsRepo;
  private daemonRetirement: DaemonRetirementRepo;
  private sshMesh: SshMeshRepo;
  private autopilots: AutopilotsRepo;
  private tasks: TasksRepo;

  constructor(db?: SqlDatabase, options: {
    notificationSenders?: NotificationSenderRegistry;
    notificationMaxAttempts?: number;
    notificationRetryBaseDelayMs?: number;
    notificationSweepIntervalMs?: number;
    notificationLeaseMs?: number;
    notificationSendTimeoutMs?: number;
    agentIssueUpdateDebounceMs?: number;
    publicUrl?: string | null;
  } = {}) {
    this.db = db ?? openMultiremiDatabase();
    this.ctx = new StoreContext(this.db, () => this);
    this.feedback = new FeedbackRepo(this.db);
    this.accessTokens = new AccessTokensRepo(this.db);
    this.issueShares = new IssueSharesRepo(this.db);
    this.notificationChannels = new NotificationChannelsRepo(this.ctx);
    this.notificationDispatcher = new OutboundNotificationDispatcher({
      store: this,
      senders: options.notificationSenders,
      maxAttempts: options.notificationMaxAttempts,
      retryBaseDelayMs: options.notificationRetryBaseDelayMs,
      sweepIntervalMs: options.notificationSweepIntervalMs,
      leaseMs: options.notificationLeaseMs,
      sendTimeoutMs: options.notificationSendTimeoutMs,
      publicUrl: options.publicUrl,
    });
    this.cloudNodes = new CloudRuntimeNodesRepo(this.db);
    this.platformOperations = new PlatformOperationsRepo(this.db);
    this.platformMaintenance = new PlatformMaintenanceRepo(this.db);
    this.agents = new AgentsSkillsRepo(this.ctx);
    this.agentPlugins = new AgentPluginsRepo(this.ctx);
    this.workspaces = new WorkspacesRepo(this.ctx);
    this.scm = new ScmRepo(this.ctx);
    this.feishuIngest = new FeishuIngestRepo(this.ctx);
    this.feishuBot = new FeishuBotRepo(this.ctx);
    this.messaging = new MessagingRepo(this.ctx);
    this.messagingOutcomes = new MessagingOutcomeService(this.ctx, this.messaging);
    this.usage = new UsageRepo(this.ctx);
    this.squads = new SquadsRepo(this.ctx);
    this.analytics = new AnalyticsRepo(this.ctx);
    // The analytics recorders are not part of the public facade, so domains reach them through the
    // context rather than through `resolveHost`.
    this.ctx.registerAnalytics(this.analytics);
    this.projects = new ProjectsRepo(this.ctx);
    this.repositoryWiki = new RepositoryWikiRepo(this.ctx);
    this.knowledge = new KnowledgeRepo(this.ctx);
    this.sessions = new IssueSessionsRepo(this.ctx);
    this.chat = new ChatRepo(this.ctx);
    this.agentIssueUpdates = new AgentIssueUpdatesRepo(this.ctx, {
      debounceMs: options.agentIssueUpdateDebounceMs,
    });
    this.issues = new IssuesRepo(this.ctx);
    this.issueWorkspaces = new IssueWorkspacesRepo(this.ctx);
    this.sessionArchives = new SessionArchivesRepo(this.ctx);
    this.runtimes = new RuntimesRepo(this.ctx);
    this.daemonProfiles = new DaemonProfilesRepo(this.ctx);
    this.runtimeProvisions = new RuntimeProvisionsRepo(this.ctx);
    this.daemonRetirement = new DaemonRetirementRepo(this.ctx);
    this.sshMesh = new SshMeshRepo(this.ctx);
    this.autopilots = new AutopilotsRepo(this.ctx);
    this.tasks = new TasksRepo(this.ctx);
    this.migrate();
  }

  onTaskEnqueued(listener: TaskEnqueuedListener): () => void {
    this.ctx.taskEnqueuedListeners.add(listener);
    return () => {
      this.ctx.taskEnqueuedListeners.delete(listener);
    };
  }

  onTaskEvent(listener: TaskEventListener): () => void {
    this.ctx.taskEventListeners.add(listener);
    return () => {
      this.ctx.taskEventListeners.delete(listener);
    };
  }

  onTaskMessages(listener: TaskMessagesListener): () => void {
    this.ctx.taskMessagesListeners.add(listener);
    return () => {
      this.ctx.taskMessagesListeners.delete(listener);
    };
  }

  onWorkspaceEvent(listener: WorkspaceEventListener): () => void {
    this.ctx.workspaceEventListeners.add(listener);
    return () => {
      this.ctx.workspaceEventListeners.delete(listener);
    };
  }

  emitWorkspaceEvent(event: Parameters<WorkspaceEventListener>[0]): void {
    return this.ctx.emitWorkspaceEvent(event);
  }

  listAnalyticsEvents(options: {
    name?: string;
    includeMetricsOnly?: boolean;
  } = {}): MultiremiAnalyticsEvent[] {
    return this.analytics.listAnalyticsEvents(options);
  }

  listMetricCounters(options: { name?: string } = {}): MultiremiMetricCounter[] {
    return this.analytics.listMetricCounters(options);
  }

  migrate(): void {
runMigrations(this.db);
  }

  getPlatformState() {
    return this.platformOperations.getState();
  }

  setPlatformAutoUpdateStable(enabled: boolean) {
    return this.platformOperations.setAutoUpdateStable(enabled);
  }

  setPlatformAutoUpdateSettings(input: { enabled: boolean; time: string; timezone: string }, at?: Date) {
    return this.platformOperations.setAutoUpdateSettings(input, at);
  }

  claimDuePlatformAutoUpdateCheck(at?: Date) {
    return this.platformOperations.claimDueAutoUpdateCheck(at);
  }

  setPlatformAutoUpdateResult(result: import("@multiremi/contracts/types.js").MultiremiPlatformAutoUpdateResult) {
    return this.platformOperations.setAutoUpdateResult(result);
  }

  heartbeatPlatformUpdater(input: {
    driver: "systemd_release" | "docker_compose";
    currentRelease?: MultiremiPlatformRelease | null;
    latestRelease?: MultiremiPlatformRelease | null;
    recentReleases?: MultiremiPlatformRelease[];
    services?: MultiremiPlatformService[];
  }) {
    return this.platformOperations.heartbeat(input);
  }

  createPlatformOperation(
    input: CreatePlatformOperationInput,
    requestedBy: string,
  ): MultiremiPlatformOperation {
    return this.platformOperations.create(input, requestedBy);
  }

  getPlatformOperation(id: string): MultiremiPlatformOperation | null {
    return this.platformOperations.get(id);
  }

  getActivePlatformOperation(): MultiremiPlatformOperation | null {
    return this.platformOperations.active();
  }

  listPlatformOperations(limit?: number): MultiremiPlatformOperation[] {
    return this.platformOperations.list(limit);
  }

  claimPlatformOperation(): MultiremiPlatformOperation | null {
    return this.platformOperations.claim();
  }

  reportPlatformOperation(
    id: string,
    input: ReportPlatformOperationInput,
  ): MultiremiPlatformOperation | null {
    return this.platformOperations.report(id, input);
  }

  cancelPlatformOperation(id: string): MultiremiPlatformOperation {
    return this.platformOperations.requestCancel(id);
  }

  getPlatformMaintenance(): MultiremiPlatformMaintenance {
    return this.platformMaintenance.get();
  }

  beginPlatformDrain(input: { operationId: string; reason?: string | null; ttlMs?: number }): MultiremiPlatformMaintenance {
    return this.platformMaintenance.beginDrain(input);
  }

  renewPlatformDrain(operationId: string, ttlMs?: number): MultiremiPlatformMaintenance | null {
    return this.platformMaintenance.renewDrain(operationId, ttlMs);
  }

  releasePlatformDrain(operationId: string): MultiremiPlatformMaintenance {
    return this.platformMaintenance.releaseDrain(operationId);
  }

  recordRuntimeDrainAck(runtimeId: string, generation: number, activeTasks: number | null): void {
    this.platformMaintenance.recordRuntimeDrainAck(runtimeId, generation, activeTasks);
  }

  getPlatformDrainStatus(): MultiremiPlatformDrainStatus {
    return this.platformMaintenance.drainStatus();
  }

  getSessionArchive(id: string): MultiremiSessionArchive | null {
    return this.sessionArchives.get(id);
  }

  listSessionArchives(issueId: string): MultiremiSessionArchive[] {
    return this.sessionArchives.list(issueId);
  }

  getSessionArchiveWorkspaceUsage(workspaceId: string): SessionArchiveWorkspaceUsage {
    return this.sessionArchives.workspaceUsage(workspaceId);
  }

  getSessionArchiveStatus(
    issueId: string,
    sourceRevision?: string | null,
    sha256?: string | null,
  ): SessionArchiveStatusSnapshot {
    return this.sessionArchives.status(issueId, sourceRevision, sha256);
  }

  initSessionArchive(input: InitSessionArchiveInput, id: string, relativePath: string): {
    archive: MultiremiSessionArchive;
    created: boolean;
  } {
    const initialized = this.sessionArchives.init(input, id, relativePath);
    if (!initialized) {
      throw Object.assign(
        new Error("Issue is deleting or its workspace has already been cleaned"),
        { code: "issue_archive_lifecycle_closed" },
      );
    }
    return initialized;
  }

  reportSessionArchiveFailure(
    input: ReportSessionArchiveFailureInput,
    id: string,
    relativePath: string,
  ): { archive: MultiremiSessionArchive; created: boolean } {
    const reported = this.sessionArchives.reportFailure(input, id, relativePath);
    if (!reported) {
      throw Object.assign(
        new Error("Issue is deleting or its workspace has already been cleaned"),
        { code: "issue_archive_lifecycle_closed" },
      );
    }
    return reported;
  }

  touchWritableSessionArchive(id: string, runtimeId: string): MultiremiSessionArchive | null {
    return this.sessionArchives.touchWritableArchive(id, runtimeId);
  }

  claimSessionArchiveUploadAttempt(id: string, runtimeId: string): MultiremiSessionArchive | null {
    return this.sessionArchives.claimUploadAttempt(id, runtimeId);
  }

  beginSessionArchiveUploadAttempt(
    id: string,
    runtimeId: string,
    attemptCount: number,
  ): MultiremiSessionArchive | null {
    return this.sessionArchives.beginUploadAttempt(id, runtimeId, attemptCount);
  }

  markSessionArchiveUploadedAttempt(
    id: string,
    runtimeId: string,
    attemptCount: number,
    uploadedSizeBytes: number,
  ): MultiremiSessionArchive | null {
    return this.sessionArchives.markUploadedAttempt(id, runtimeId, attemptCount, uploadedSizeBytes);
  }

  markSessionArchiveReadyAttempt(
    id: string,
    runtimeId: string,
    attemptCount: number,
    uploadedSizeBytes: number,
  ): MultiremiSessionArchive | null {
    return this.sessionArchives.markReadyAttempt(id, runtimeId, attemptCount, uploadedSizeBytes);
  }

  markSessionArchiveFailedAttempt(
    id: string,
    runtimeId: string,
    attemptCount: number,
    error: string,
  ): MultiremiSessionArchive | null {
    return this.sessionArchives.markFailedAttempt(id, runtimeId, attemptCount, error);
  }

  markSessionArchiveFailed(id: string, error: string): MultiremiSessionArchive | null {
    return this.sessionArchives.markFailed(id, error);
  }

  markSessionArchiveVerificationFailedAttempt(
    id: string,
    attemptCount: number,
    error: string,
  ): MultiremiSessionArchive | null {
    return this.sessionArchives.markVerificationFailedAttempt(id, attemptCount, error);
  }

  retrySessionArchive(id: string): MultiremiSessionArchive | null {
    return this.sessionArchives.retry(id);
  }

  createAgent(input: CreateAgentInput): MultiremiAgent {
    return this.agents.createAgent(input);
  }

  updateAgent(id: string, input: UpdateAgentInput): MultiremiAgent {
    return this.db.transaction(() => {
      const current = this.agents.getAgent(id);
      if (!current) throw new Error(`Agent not found: ${id}`);
      const agent = this.agents.updateAgent(id, input);
      if (current.role !== agent.role) {
        for (const task of this.tasks.listAgentTasks(id)) this.accessTokens.revokeTaskAccessTokens(task.id);
      }
      return agent;
    })();
  }

  setAgentRole(id: string, role: MultiremiAgent["role"]): MultiremiAgent {
    return this.db.transaction(() => {
      const current = this.agents.getAgent(id);
      if (!current) throw new Error(`Agent not found: ${id}`);
      const agent = this.agents.setAgentRole(id, role);
      if (current.role !== agent.role) {
        for (const task of this.tasks.listAgentTasks(id)) this.accessTokens.revokeTaskAccessTokens(task.id);
      }
      return agent;
    })();
  }

  setAgentSupervisor(id: string, supervisor: boolean): MultiremiAgent {
    return this.db.transaction(() => {
      const current = this.agents.getAgent(id);
      if (!current) throw new Error(`Agent not found: ${id}`);
      const agent = this.agents.setAgentSupervisor(id, supervisor);
      if (current.role !== agent.role) {
        for (const task of this.tasks.listAgentTasks(id)) this.accessTokens.revokeTaskAccessTokens(task.id);
      }
      return agent;
    })();
  }

  archiveAgent(id: string): MultiremiAgent {
    return this.agents.archiveAgent(id);
  }

  restoreAgent(id: string): MultiremiAgent {
    return this.agents.restoreAgent(id);
  }

  cancelAgentTasks(agentId: string): number {
    return this.agents.cancelAgentTasks(agentId);
  }

  createSkill(input: CreateSkillInput): MultiremiSkill {
    return this.agents.createSkill(input);
  }

  /** Internal primitive for callers that already own a database transaction. */
  createSkillWithinTransaction(input: CreateSkillInput): MultiremiSkill {
    return this.agents.createSkillWithinTransaction(input);
  }

  updateSkill(id: string, input: UpdateSkillInput): MultiremiSkill {
    return this.agents.updateSkill(id, input);
  }

  upsertSkill(input: CreateSkillInput & { id: string }): MultiremiSkill {
    return this.agents.upsertSkill(input);
  }

  archiveSkill(id: string): MultiremiSkill {
    return this.agents.archiveSkill(id);
  }

  listSkills(workspaceId?: string | null, options: { includeArchived?: boolean; includeFiles?: boolean } = {}): MultiremiSkill[] {
    return this.agents.listSkills(workspaceId, options);
  }

  getSkill(id: string, options: { includeArchived?: boolean; includeFiles?: boolean } = { includeFiles: true }): MultiremiSkill | null {
    return this.agents.getSkill(id, options);
  }

  listSkillFiles(skillId: string, options: { includeArchived?: boolean } = {}): MultiremiSkillFile[] {
    return this.agents.listSkillFiles(skillId, options);
  }

  upsertSkillFile(skillId: string, file: MultiremiSkillFile): MultiremiSkillFile {
    return this.agents.upsertSkillFile(skillId, file);
  }

  deleteSkillFile(skillId: string, fileId: string): boolean {
    return this.agents.deleteSkillFile(skillId, fileId);
  }

  listAgentSkills(agentId: string, options: { includeFiles?: boolean } = { includeFiles: true }): MultiremiSkill[] {
    return this.agents.listAgentSkills(agentId, options);
  }

  setAgentSkills(agentId: string, input: SetAgentSkillsInput | string[]): MultiremiSkill[] {
    return this.agents.setAgentSkills(agentId, input);
  }

  /** Internal cross-domain primitive; callers must already own a DB transaction. */
  lockAgentPluginWorkspace(workspaceId: string): void {
    return this.agentPlugins.lockAgentPluginWorkspace(workspaceId);
  }

  assertAgentPluginWorkspaceMoveAllowed(agentId: string, targetWorkspaceId: string): void {
    return this.agentPlugins.assertAgentPluginWorkspaceMoveAllowed(agentId, targetWorkspaceId);
  }

  reconcileAgentPluginDesiredStateWithinLock(workspaceId: string): void {
    return this.agentPlugins.reconcileAgentPluginDesiredStateWithinLock(workspaceId);
  }

  listAgentPlugins(
    workspaceId = "local",
    options: { provider?: string | null; includeArchived?: boolean } = {},
  ): MultiremiAgentPlugin[] {
    return this.agentPlugins.listAgentPlugins(workspaceId, options);
  }

  getAgentPlugin(id: string, options: { includeArchived?: boolean } = {}): MultiremiAgentPlugin | null {
    return this.agentPlugins.getAgentPlugin(id, options);
  }

  importAgentPlugin(input: ImportAgentPluginInput): MultiremiAgentPlugin {
    return this.agentPlugins.importAgentPlugin(input);
  }

  createAgentPluginVersion(pluginId: string, input: CreateAgentPluginVersionInput): MultiremiAgentPluginVersion {
    return this.agentPlugins.createAgentPluginVersion(pluginId, input);
  }

  updateAgentPlugin(id: string, input: UpdateAgentPluginInput): MultiremiAgentPlugin {
    return this.agentPlugins.updateAgentPlugin(id, input);
  }

  archiveAgentPlugin(id: string): MultiremiAgentPlugin {
    return this.agentPlugins.archiveAgentPlugin(id);
  }

  restoreAgentPlugin(id: string): MultiremiAgentPlugin {
    return this.agentPlugins.restoreAgentPlugin(id);
  }

  listAgentPluginVersions(pluginId: string): MultiremiAgentPluginVersion[] {
    return this.agentPlugins.listAgentPluginVersions(pluginId);
  }

  getAgentPluginVersion(id: string): MultiremiAgentPluginVersion | null {
    return this.agentPlugins.getAgentPluginVersion(id);
  }

  activateAgentPluginVersion(pluginId: string, versionId: string): MultiremiAgentPlugin {
    return this.agentPlugins.activateAgentPluginVersion(pluginId, versionId);
  }

  rollbackAgentPluginVersion(pluginId: string, versionId?: string | null): MultiremiAgentPlugin {
    return this.agentPlugins.rollbackAgentPluginVersion(pluginId, versionId);
  }

  listAgentPluginBindings(agentId: string): MultiremiAgentPluginBinding[] {
    return this.agentPlugins.listAgentPluginBindings(agentId);
  }

  createAgentPluginBinding(agentId: string, input: CreateAgentPluginBindingInput): MultiremiAgentPluginBinding {
    return this.agentPlugins.createAgentPluginBinding(agentId, input);
  }

  updateAgentPluginBinding(
    agentId: string,
    bindingId: string,
    input: UpdateAgentPluginBindingInput,
  ): MultiremiAgentPluginBinding {
    return this.agentPlugins.updateAgentPluginBinding(agentId, bindingId, input);
  }

  deleteAgentPluginBinding(agentId: string, bindingId: string): boolean {
    return this.agentPlugins.deleteAgentPluginBinding(agentId, bindingId);
  }

  resolveAgentPluginSnapshot(agentId: string): MultiremiTaskPluginSnapshotEntry[] {
    return this.agentPlugins.resolveAgentPluginSnapshot(agentId);
  }

  getAgentPluginCapabilityRevision(agentId: string): string {
    return this.agentPlugins.getAgentPluginCapabilityRevision(agentId);
  }

  runtimeHasReadyAgentPlugins(runtimeId: string, agentId: string): boolean {
    return this.agentPlugins.runtimeHasReadyAgentPlugins(runtimeId, agentId);
  }

  assertAgentPluginProviderCompatible(agentId: string, provider: string): void {
    return this.agentPlugins.assertAgentPluginProviderCompatible(agentId, provider);
  }

  recordAgentPluginRuntimeHeartbeat(runtimeId: string): MultiremiAgentPluginRuntimeState[] {
    return this.agentPlugins.recordAgentPluginRuntimeHeartbeat(runtimeId);
  }

  listAgentPluginRuntimeStates(
    options: { workspaceId?: string; pluginId?: string; runtimeId?: string; includeHistorical?: boolean } = {},
  ): MultiremiAgentPluginRuntimeState[] {
    return this.agentPlugins.listAgentPluginRuntimeStates(options);
  }

  getRuntimeAgentPluginDesiredSnapshot(runtimeId: string): MultiremiAgentPluginRuntimeDesiredSnapshot {
    return this.agentPlugins.getRuntimeAgentPluginDesiredSnapshot(runtimeId);
  }

  reportAgentPluginRuntimeState(
    runtimeId: string,
    versionId: string,
    input: ReportAgentPluginRuntimeStateInput,
  ): MultiremiAgentPluginRuntimeState {
    return this.agentPlugins.reportAgentPluginRuntimeState(runtimeId, versionId, input);
  }

  reportAgentPluginRuntimeStateResult(
    runtimeId: string,
    versionId: string,
    input: ReportAgentPluginRuntimeStateInput,
  ): { state: MultiremiAgentPluginRuntimeState; changed: boolean } {
    return this.agentPlugins.reportAgentPluginRuntimeStateResult(runtimeId, versionId, input);
  }

  /** Internal cross-domain primitive; caller owns workspace lifecycle + Plugin locks. */
  recordAgentPluginRuntimeHeartbeatWithinLock(runtimeId: string): MultiremiAgentPluginRuntimeState[] {
    return this.agentPlugins.recordAgentPluginRuntimeHeartbeatWithinLock(runtimeId);
  }

  retryAgentPluginRuntime(
    pluginId: string,
    runtimeId?: string | null,
    versionId?: string | null,
  ): MultiremiAgentPluginRuntimeState[] {
    return this.agentPlugins.retryAgentPluginRuntime(pluginId, runtimeId, versionId);
  }

  getAgentPluginArtifactByDigest(digest: string, workspaceId?: string | null) {
    return this.agentPlugins.getAgentPluginArtifactByDigest(digest, workspaceId);
  }

  reconcileAgentPluginDesiredState(workspaceId: string): void {
    return this.agentPlugins.reconcileAgentPluginDesiredState(workspaceId);
  }

  ensureDefaultAgent(
    provider = "claude",
    options: {
      workspaceId?: string | null;
      ownerId?: string | null;
      issueCreationRequiresProposal?: boolean;
    } = {},
  ): MultiremiAgent {
    return this.agents.ensureDefaultAgent(provider, options);
  }

  getDefaultAgent(workspaceId: string, provider: string, ownerId: string): MultiremiAgent | null {
    return this.agents.getDefaultAgent(workspaceId, provider, ownerId);
  }

  getAgent(id: string): MultiremiAgent | null {
    return this.agents.getAgent(id);
  }

  getAgentByWorkspaceAndName(workspaceId: string, name: string): MultiremiAgent | null {
    return this.agents.getAgentByWorkspaceAndName(workspaceId, name);
  }

  getAgentByRef(ref: string, workspaceId?: string | null): MultiremiAgent | null {
    return this.agents.getAgentByRef(ref, workspaceId);
  }

  listAgents(options?: { includeArchived?: boolean }): MultiremiAgent[] {
    return this.agents.listAgents(options);
  }

  createWorkspaceMember(input: CreateWorkspaceMemberInput): MultiremiWorkspaceMember {
    return this.workspaces.createWorkspaceMember(input);
  }

  getWorkspaceMember(id: string): MultiremiWorkspaceMember | null {
    return this.workspaces.getWorkspaceMember(id);
  }

  getWorkspaceMemberByRef(ref: string, workspaceId?: string | null): MultiremiWorkspaceMember | null {
    return this.workspaces.getWorkspaceMemberByRef(ref, workspaceId);
  }

  listWorkspaceMembers(workspaceId?: string | null): MultiremiWorkspaceMember[] {
    return this.workspaces.listWorkspaceMembers(workspaceId);
  }

  updateWorkspaceMember(id: string, input: UpdateWorkspaceMemberInput): MultiremiWorkspaceMember {
    return this.workspaces.updateWorkspaceMember(id, input);
  }

  archiveWorkspaceMember(id: string): MultiremiWorkspaceMember {
    return this.workspaces.archiveWorkspaceMember(id);
  }

  getCurrentUser(): MultiremiUser {
    return this.workspaces.getCurrentUser();
  }

  getUser(id: string): MultiremiUser | null {
    return this.workspaces.getUser(id);
  }

  getUserByExternalId(externalId: string | null | undefined): MultiremiUser | null {
    return this.workspaces.getUserByExternalId(externalId);
  }

  getUserByFeishuUnionId(unionId: string | null | undefined): MultiremiUser | null {
    return this.workspaces.getUserByFeishuUnionId(unionId);
  }

  getUserByEmail(email: string | null | undefined): MultiremiUser | null {
    return this.workspaces.getUserByEmail(email);
  }

  getOrCreateUser(identity: {
    externalId?: string | null;
    feishuUnionId?: string | null;
    email?: string | null;
    name?: string | null;
  }): MultiremiUser {
    return this.workspaces.getOrCreateUser(identity);
  }

  getUserRoleInWorkspace(userId: string | null | undefined, workspaceId: string): string | null {
    return this.workspaces.getUserRoleInWorkspace(userId, workspaceId);
  }

  findWorkspaceMemberForUser(userId: string | null | undefined, workspaceId: string): MultiremiWorkspaceMember | null {
    return this.workspaces.findWorkspaceMemberForUser(userId, workspaceId);
  }

  listWorkspacesForUser(userId: string | null | undefined): MultiremiWorkspace[] {
    return this.workspaces.listWorkspacesForUser(userId);
  }

  updateCurrentUser(input: UpdateMultiremiUserInput): MultiremiUser {
    return this.workspaces.updateCurrentUser(input);
  }

  patchCurrentUserOnboarding(questionnaire: Record<string, unknown>): MultiremiUser {
    return this.workspaces.patchCurrentUserOnboarding(questionnaire);
  }

  markCurrentUserOnboarded(userId?: string | null): MultiremiUser {
    return this.workspaces.markCurrentUserOnboarded(userId);
  }

  listWorkspaces(): MultiremiWorkspace[] {
    return this.workspaces.listWorkspaces();
  }

  getWorkspace(id: string): MultiremiWorkspace | null {
    return this.workspaces.getWorkspace(id);
  }

  createWorkspace(input: CreateWorkspaceInput, actingUserId?: string | null): MultiremiWorkspace {
    return this.workspaces.createWorkspace(input, actingUserId);
  }

  updateWorkspace(id: string, input: Partial<CreateWorkspaceInput>): MultiremiWorkspace {
    return this.workspaces.updateWorkspace(id, input);
  }

  mutateWorkspaceRepositories<TResult>(
    id: string,
    mutate: (repositories: unknown[]) => { repositories: unknown[]; result: TResult },
  ): { workspace: MultiremiWorkspace; result: TResult } {
    return this.db.transaction(() => {
      const locked = this.db.query(
        "UPDATE multiremi_workspaces SET updated_at = updated_at WHERE id = ? RETURNING id",
      ).get(id) as { id?: string } | null;
      if (!locked) throw new Error(`Workspace not found: ${id}`);
      const current = this.workspaces.getWorkspace(id);
      if (!current) throw new Error(`Workspace not found: ${id}`);
      const next = mutate([...current.repos]);
      const workspace = this.workspaces.updateWorkspace(id, { repos: next.repositories });
      this.scm.reconcileRepositoryBindingsWithinTransaction(id, workspace.repos);
      return { workspace, result: next.result };
    })();
  }

  updateWorkspaceRepositories(id: string, repositories: unknown[]): MultiremiWorkspace {
    return this.mutateWorkspaceRepositories(id, () => ({
      repositories,
      result: undefined,
    })).workspace;
  }

  deleteWorkspace(id: string): boolean {
    return this.workspaces.deleteWorkspace(id);
  }

  leaveWorkspace(id: string, memberId = `mem_${id}_local`): boolean {
    return this.workspaces.leaveWorkspace(id, memberId);
  }

  ensureLocalWorkspace(): MultiremiWorkspace {
    return this.workspaces.ensureLocalWorkspace();
  }

  getWorkspaceEnv(workspaceId: string): Record<string, string> {
    return this.workspaces.getWorkspaceEnv(workspaceId);
  }

  setWorkspaceEnv(workspaceId: string, env: Record<string, string>): Record<string, string> {
    return this.workspaces.setWorkspaceEnv(workspaceId, env);
  }

  getSshMeshOverview(workspaceId: string): SshMeshBrowserOverview {
    return this.sshMesh.getOverview(workspaceId);
  }

  setSshMeshEnabled(
    workspaceId: string,
    enabled: boolean,
    keyMaterial: SshMeshKeyMaterial | null,
    createdBy: string | null,
  ): SshMeshBrowserOverview {
    return this.withSshMeshLifecycleLock(workspaceId, () => {
      const rollingDisable = !enabled
        && this.sshMesh.getMutationState(workspaceId).overview.rotation_state === "rolling_out";
      if (!rollingDisable) this.assertNoDaemonRetirementRekeyInProgress(workspaceId);
      return this.sshMesh.setEnabled(workspaceId, enabled, keyMaterial, createdBy);
    });
  }

  rotateSshMeshKey(workspaceId: string, keyMaterial: SshMeshKeyMaterial): SshMeshBrowserOverview {
    return this.withSshMeshLifecycleLock(workspaceId, () => {
      this.assertNoDaemonRetirementRekeyInProgress(workspaceId);
      return this.sshMesh.rotate(workspaceId, keyMaterial);
    });
  }

  invalidateSshMeshKey(workspaceId: string): SshMeshBrowserOverview {
    return this.withSshMeshLifecycleLock(workspaceId, () => {
      const overview = this.sshMesh.invalidate(workspaceId);
      this.daemonRetirement.markSshMeshRekeysRequiredAfterInvalidation(workspaceId);
      return overview;
    });
  }

  recordSshMeshHeartbeat(
    runtimeId: string,
    protocolVersion: number,
    status?: MultiremiDaemonSshMeshStatus,
  ): MultiremiSshMeshHeartbeatAck | null {
    const workspaceId = this.sshMesh.getRuntimeWorkspaceId(runtimeId);
    if (!workspaceId) return null;
    return this.withSshMeshLifecycleLock(workspaceId, () => {
      const ack = this.sshMesh.recordHeartbeat(runtimeId, protocolVersion, status);
      const mutation = this.sshMesh.getMutationState(workspaceId);
      if (mutation.overview.rotation_state === "stable") {
        this.daemonRetirement.completeSshMeshRekeyForOperation(
          workspaceId,
          mutation.activeOperationId,
          mutation.overview.key_version,
        );
      }
      return ack;
    });
  }

  recordControlPlaneSshMeshHeartbeat(
    workspaceId: string,
    nodeId: string,
    name: string,
    protocolVersion: number,
    status?: MultiremiDaemonSshMeshStatus,
  ): MultiremiSshMeshHeartbeatAck {
    return this.withSshMeshLifecycleLock(workspaceId, () => {
      const ack = this.sshMesh.recordControlPlaneHeartbeat(
        workspaceId,
        nodeId,
        name,
        protocolVersion,
        status,
      );
      const mutation = this.sshMesh.getMutationState(workspaceId);
      if (mutation.overview.rotation_state === "stable") {
        this.daemonRetirement.completeSshMeshRekeyForOperation(
          workspaceId,
          mutation.activeOperationId,
          mutation.overview.key_version,
        );
      }
      return ack;
    });
  }

  getSshMeshConfigForDaemon(runtimeId: string): MultiremiDaemonSshMeshConfig | null {
    return this.sshMesh.getDaemonConfig(runtimeId);
  }

  getSshMeshConfigForNode(workspaceId: string, nodeId: string): MultiremiDaemonSshMeshConfig | null {
    return this.sshMesh.getNodeConfig(workspaceId, nodeId);
  }

  requestSshMeshProbe(
    workspaceId: string,
    sourceNodeId: string,
    targetNodeId?: string | null,
  ): { request_id: string; probe_revision: number; status: "pending" } {
    return this.withSshMeshLifecycleLock(workspaceId, () => (
      this.sshMesh.requestProbe(workspaceId, sourceNodeId, targetNodeId)
    ));
  }

  getRelayConfigForDaemon(workspaceId: string): RelayConfigForDaemon {
    return this.workspaces.getRelayConfigForDaemon(workspaceId);
  }

  getRelayConfigForBrowser(workspaceId: string): RelayConfigForBrowser {
    return this.workspaces.getRelayConfigForBrowser(workspaceId);
  }

  revealRelayToken(workspaceId: string, engine: RelayEngine): string | null {
    return this.workspaces.revealRelayToken(workspaceId, engine);
  }

  upsertRelayConfig(
    workspaceId: string,
    engine: RelayEngine,
    input: { fragment: string; tokenOp: "keep" | "set" | "clear"; authToken?: string; actor?: string | null },
  ): number {
    return this.workspaces.upsertRelayConfig(workspaceId, engine, input);
  }

  getRelayModelDiscovery(workspaceId: string): boolean {
    return this.workspaces.getRelayModelDiscovery(workspaceId);
  }

  setRelayModelDiscovery(workspaceId: string, enabled: boolean): void {
    return this.workspaces.setRelayModelDiscovery(workspaceId, enabled);
  }

  getGatewayModels(workspaceId: string, engine: RelayEngine): GatewayModelsSnapshot | null {
    return this.workspaces.getGatewayModels(workspaceId, engine);
  }

  saveGatewayModels(
    workspaceId: string,
    engine: RelayEngine,
    input: { models?: Array<{ id: string; label: string }>; sourceRevision: number; error?: string | null },
  ): void {
    return this.workspaces.saveGatewayModels(workspaceId, engine, input);
  }

  createWorkspaceInvitation(workspaceId: string, input: CreateWorkspaceInvitationInput, inviterUserId?: string | null): MultiremiWorkspaceInvitation {
    return this.workspaces.createWorkspaceInvitation(workspaceId, input, inviterUserId);
  }

  listWorkspaceInvitations(workspaceId: string): MultiremiWorkspaceInvitation[] {
    return this.workspaces.listWorkspaceInvitations(workspaceId);
  }

  listCurrentUserInvitations(actingUserId?: string | null): MultiremiWorkspaceInvitation[] {
    return this.workspaces.listCurrentUserInvitations(actingUserId);
  }

  getInvitation(id: string): MultiremiWorkspaceInvitation | null {
    return this.workspaces.getInvitation(id);
  }

  revokeWorkspaceInvitation(workspaceId: string, invitationId: string): boolean {
    return this.workspaces.revokeWorkspaceInvitation(workspaceId, invitationId);
  }

  acceptInvitation(invitationId: string, actingUserId?: string | null): MultiremiWorkspaceInvitation | null {
    return this.workspaces.acceptInvitation(invitationId, actingUserId);
  }

  declineInvitation(invitationId: string, actingUserId?: string | null): MultiremiWorkspaceInvitation | null {
    return this.workspaces.declineInvitation(invitationId, actingUserId);
  }

  getNotificationPreferences(input: { workspaceId?: string | null; memberId?: string | null } = {}): MultiremiNotificationPreferenceResponse {
    return this.workspaces.getNotificationPreferences(input);
  }

  updateNotificationPreferences(input: {
    workspaceId?: string | null;
    memberId?: string | null;
    preferences: MultiremiNotificationPreferences;
  }): MultiremiNotificationPreferenceResponse {
    return this.workspaces.updateNotificationPreferences(input);
  }

  getNotificationChannel(id: string): MultiremiNotificationChannel | null {
    return this.notificationChannels.getChannel(id);
  }

  getAgentChatNotificationChannel(chatSessionId: string): MultiremiNotificationChannel | null {
    return this.notificationChannels.getAgentChatChannel(chatSessionId);
  }

  upsertAgentChatNotificationChannel(input: {
    workspaceId: string;
    chatSessionId: string;
    name: string;
    enabled: boolean;
    memberId?: string | null;
    createdBy?: string | null;
  }): MultiremiNotificationChannel {
    return this.notificationChannels.upsertAgentChatChannel(input);
  }

  deleteAgentChatNotificationChannel(chatSessionId: string): boolean {
    return this.notificationChannels.deleteAgentChatChannel(chatSessionId);
  }

  getAgentIssueUpdateSubscription(chatSessionId: string): MultiremiAgentIssueUpdateSubscription {
    return this.agentIssueUpdates.getSubscription(chatSessionId);
  }

  setAgentIssueUpdateSubscription(input: {
    chatSessionId: string;
    enabled: boolean;
    memberId?: string | null;
    createdBy?: string | null;
  }): MultiremiAgentIssueUpdateSubscription {
    return this.agentIssueUpdates.setSubscription(input);
  }

  queueAgentIssueUpdate(input: QueueAgentIssueUpdateInput): void {
    return this.agentIssueUpdates.queue(input);
  }

  flushDueAgentIssueUpdates(now?: string | Date): AgentIssueUpdateFlushResult {
    return this.agentIssueUpdates.flushDue(now);
  }

  flushAgentIssueUpdatesForIssueWithinTransaction(
    issueId: string,
    now?: string | Date,
  ): AgentIssueUpdateFlushResult {
    return this.agentIssueUpdates.flushIssueNowWithinTransaction(issueId, now);
  }

  listNotificationChannels(workspaceId: string): MultiremiNotificationChannel[] {
    return this.notificationChannels.listChannels(workspaceId);
  }

  listNotificationChannelsInScope(
    workspaceId: string,
    scope: NotificationVisibilityScope,
  ): MultiremiNotificationChannel[] {
    return this.notificationChannels.listChannelsInScope(workspaceId, scope);
  }

  createNotificationChannel(input: CreateNotificationChannelInput): MultiremiNotificationChannel {
    return this.notificationChannels.createChannel(input);
  }

  updateNotificationChannel(
    id: string,
    input: UpdateNotificationChannelInput,
  ): MultiremiNotificationChannel | null {
    return this.notificationChannels.updateChannel(id, input);
  }

  deleteNotificationChannel(id: string): boolean {
    return this.notificationChannels.deleteChannel(id);
  }

  matchNotificationRoutes(
    workspaceId: string,
    memberId: string,
    inboxType: string,
    severity: string,
  ): MultiremiNotificationChannel[] {
    return this.notificationChannels.matchRoutes(workspaceId, memberId, inboxType, severity);
  }

  recordPendingNotificationDelivery(
    item: MultiremiInboxItem,
    channel: MultiremiNotificationChannel,
  ): MultiremiNotificationDelivery {
    return this.notificationChannels.recordPending(item, channel);
  }

  getNotificationDelivery(id: string): MultiremiNotificationDelivery | null {
    return this.notificationChannels.getDelivery(id);
  }

  getNotificationDeliveryContext(id: string): NotificationDeliveryContext | null {
    return this.notificationChannels.getDeliveryContext(id);
  }

  listNotificationDeliveries(input: {
    workspaceId: string;
    status?: MultiremiNotificationDeliveryStatus | null;
    limit?: number;
    scope?: NotificationVisibilityScope;
  }): MultiremiNotificationDelivery[] {
    return this.notificationChannels.listDeliveries(input);
  }

  listPendingNotificationDeliveries(now: string, limit?: number): MultiremiNotificationDelivery[] {
    return this.notificationChannels.listPendingDeliveries(now, limit);
  }

  claimNotificationDeliveryAttempt(
    id: string,
    expectedAttempts: number,
    expectedClaimSeq: number,
    maxAttempts: number,
    claimedAt: string,
    leasedUntil: string,
  ): MultiremiNotificationDelivery | null {
    return this.notificationChannels.claimAttempt(
      id,
      expectedAttempts,
      expectedClaimSeq,
      maxAttempts,
      claimedAt,
      leasedUntil,
    );
  }

  markNotificationDeliverySent(id: string, expectedClaimSeq: number): MultiremiNotificationDelivery | null {
    return this.notificationChannels.markSent(id, expectedClaimSeq);
  }

  markNotificationDeliveryFailed(id: string, error: string, expectedClaimSeq: number): MultiremiNotificationDelivery | null {
    return this.notificationChannels.markFailed(id, error, expectedClaimSeq);
  }

  recordNotificationDeliveryError(id: string, error: string, expectedClaimSeq: number): MultiremiNotificationDelivery | null {
    return this.notificationChannels.recordRetryableError(id, error, expectedClaimSeq);
  }

  resetNotificationDeliveryForRetry(id: string, retryAt: string): MultiremiNotificationDelivery | null {
    return this.notificationChannels.resetForRetry(id, retryAt);
  }

  dispatchNotificationDelivery(id: string): Promise<void> {
    return this.notificationDispatcher.dispatch(id);
  }

  retryNotificationDelivery(id: string): MultiremiNotificationDelivery | null {
    return this.notificationDispatcher.retry(id);
  }

  startNotificationDeliverySweeper(): void {
    this.notificationDispatcher.start();
  }

  stopNotificationDeliverySweeper(): void {
    this.notificationDispatcher.stop();
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

  listFeishuSources(input: { workspaceId?: string | null; enabled?: boolean } = {}): MultiremiFeishuSource[] {
    return this.feishuIngest.listSources(input);
  }

  getFeishuSource(id: string): MultiremiFeishuSource | null {
    return this.feishuIngest.getSource(id);
  }

  createFeishuSource(input: CreateMultiremiFeishuSourceInput): MultiremiFeishuSource {
    return this.feishuIngest.createSource(input);
  }

  updateFeishuSource(id: string, input: UpdateMultiremiFeishuSourceInput): MultiremiFeishuSource {
    return this.feishuIngest.updateSource(id, input);
  }

  deleteFeishuSource(id: string): boolean {
    return this.feishuIngest.deleteSource(id);
  }

  getFeishuSyncCursor(sourceId: string, stream: string): MultiremiFeishuSyncCursor | null {
    return this.feishuIngest.getSyncCursor(sourceId, stream);
  }

  claimFeishuSyncStream(input: ClaimFeishuSyncStreamInput): MultiremiFeishuSyncCursor | null {
    return this.feishuIngest.claimSyncStream(input);
  }

  updateClaimedFeishuSyncCursor(input: UpdateClaimedFeishuSyncCursorInput): MultiremiFeishuSyncCursor | null {
    return this.feishuIngest.updateClaimedSyncCursor(input);
  }

  releaseFeishuSyncStream(sourceId: string, stream: string, leaseToken: string): boolean {
    return this.feishuIngest.releaseSyncStream(sourceId, stream, leaseToken);
  }

  ingestFeishuBatch(sourceId: string, messages: readonly IngestedFeishuMessageInput[]): IngestFeishuBatchResult {
    return this.feishuIngest.ingestBatch(sourceId, messages);
  }

  getFeishuMessage(messageId: string): MultiremiFeishuMessage | null {
    return this.feishuIngest.getMessage(messageId);
  }

  listFeishuMessages(input: {
    workspaceId: string;
    sourceId?: string | null;
    query?: string | null;
    processed?: boolean;
    unprocessed?: boolean;
    since?: string | null;
    until?: string | null;
    chatId?: string | null;
    limit?: number;
    offset?: number;
  }): MultiremiFeishuMessage[] {
    return this.feishuIngest.listMessages({
      ...input,
      processed: input.processed ?? (input.unprocessed === true ? false : undefined),
    }).messages;
  }

  listFeishuMessagesPage(input: Parameters<FeishuIngestRepo["listMessages"]>[0]): {
    messages: MultiremiFeishuMessage[];
    total: number;
  } {
    return this.feishuIngest.listMessages(input);
  }

  listFeishuMessageOutcomes(messageId: string): MultiremiFeishuMessageOutcome[] {
    return this.feishuIngest.listMessageOutcomes(messageId);
  }

  listFeishuMessageOutcomesByMessageIds(messageIds: readonly string[]): MultiremiFeishuMessageOutcome[] {
    return this.feishuIngest.listMessageOutcomesByMessageIds(messageIds);
  }

  listFeishuChats(workspaceId: string): ReturnType<FeishuIngestRepo["listChats"]> {
    return this.feishuIngest.listChats(workspaceId);
  }

  listFeishuIssueProposals(
    input: Parameters<FeishuIngestRepo["listIssueProposals"]>[0],
  ): ReturnType<FeishuIngestRepo["listIssueProposals"]> {
    return this.feishuIngest.listIssueProposals(input);
  }

  getFeishuSourceStatus(sourceId: string, now?: Date): MultiremiFeishuSourceStatus {
    return this.feishuIngest.getSourceStatus(sourceId, now);
  }

  recordFeishuConnectionSuccess(sourceId: string, completedAt: string): void {
    this.feishuIngest.recordConnectionSuccess(sourceId, completedAt);
  }

  recordFeishuConnectionFailure(sourceId: string, errorCode: string, failedAt: string): MultiremiInboxItem | null {
    return this.feishuIngest.recordConnectionFailure(sourceId, errorCode, failedAt);
  }

  hasDueUnprocessedFeishuMessages(sourceId: string, now: Date): boolean {
    return this.feishuIngest.hasDueUnprocessedMessages(sourceId, now);
  }

  reconcileUnprocessedFeishuMessages(
    sourceId: string,
    now: Date,
    limit?: number,
  ): ReconcileFeishuUnprocessedResult {
    return this.feishuIngest.reconcileUnprocessedMessages(sourceId, now, limit);
  }

  resolveFeishuMessage(messageId: string, input: ResolveMultiremiFeishuMessageInput): {
    message: MultiremiFeishuMessage;
    outcome: MultiremiFeishuMessageOutcome;
  } {
    return this.feishuIngest.resolveMessage(messageId, input);
  }

  createFeishuInboxOutcome(
    messageId: string,
    outcomeKind: "notified" | "reply_drafted",
    input: CreateFeishuInboxOutcomeInput,
  ): CreateFeishuInboxOutcomeResult {
    return this.feishuIngest.createInboxOutcome(messageId, outcomeKind, input);
  }

  createFeishuIssueOutcome(
    messageId: string,
    input: CreateFeishuIssueOutcomeInput,
  ): CreateFeishuIssueOutcomeResult {
    return this.feishuIngest.createIssueOutcome(messageId, input);
  }

  createFeishuIssueProposal(
    messageId: string,
    input: CreateFeishuIssueProposalInput,
  ): CreateFeishuIssueProposalResult {
    return this.feishuIngest.createIssueProposal(messageId, input);
  }

  approveFeishuIssueProposal(
    proposalId: string,
    input: { workspaceId: string; approvedBy: string },
  ): ResolveFeishuIssueProposalResult {
    return this.feishuIngest.approveIssueProposal(proposalId, input);
  }

  rejectFeishuIssueProposal(
    proposalId: string,
    input: { workspaceId: string; rejectedBy: string },
  ): ResolveFeishuIssueProposalResult {
    return this.feishuIngest.rejectIssueProposal(proposalId, input);
  }

  deleteExpiredFeishuMessages(now?: Date): number {
    return this.feishuIngest.deleteExpiredMessages(now);
  }

  // ── Workspace Feishu concierge bot (MUL-206) ──────────────────────────────
  // Secrets stay inside the repo: only `getFeishuBotDaemonConfig` and
  // `revealFeishuBotSecrets` decrypt, and both are reachable solely from the
  // daemon route and the admin-only test route.

  getFeishuBotConfig(workspaceId: string): MultiremiFeishuBotConfig | null {
    return this.feishuBot.getConfig(workspaceId);
  }

  upsertFeishuBotConfig(workspaceId: string, input: UpsertFeishuBotConfigInput): MultiremiFeishuBotConfig {
    return this.feishuBot.upsertConfig(workspaceId, input);
  }

  deleteFeishuBotConfig(workspaceId: string): boolean {
    return this.feishuBot.deleteConfig(workspaceId);
  }

  setFeishuBotEnabled(workspaceId: string, enabled: boolean, actor?: string | null): MultiremiFeishuBotConfig | null {
    return this.feishuBot.setEnabled(workspaceId, enabled, actor);
  }

  bumpFeishuBotRevision(workspaceId: string, actor?: string | null): MultiremiFeishuBotConfig | null {
    return this.feishuBot.bumpRevision(workspaceId, actor);
  }

  recordFeishuBotTestResult(
    workspaceId: string,
    result: Parameters<FeishuBotRepo["recordTestResult"]>[1],
  ): MultiremiFeishuBotConfig | null {
    return this.feishuBot.recordTestResult(workspaceId, result);
  }

  revealFeishuBotSecrets(workspaceId: string): ReturnType<FeishuBotRepo["revealSecrets"]> {
    return this.feishuBot.revealSecrets(workspaceId);
  }

  getFeishuBotDaemonConfig(workspaceId: string, runtimeId: string): MultiremiFeishuBotDaemonConfig | null {
    return this.feishuBot.getDaemonConfig(workspaceId, runtimeId);
  }

  submitFeishuBotMessage(
    workspaceId: string,
    runtimeId: string,
    input: Parameters<FeishuBotRepo["submitMessage"]>[2],
  ): ReturnType<FeishuBotRepo["submitMessage"]> {
    return this.feishuBot.submitMessage(workspaceId, runtimeId, input);
  }

  prepareFeishuIssueTopicWithinTransaction(issue: MultiremiIssue): boolean {
    return this.feishuBot.prepareIssueTopicWithinTransaction(issue);
  }

  prepareFeishuIssueRoundPushesWithinTransaction(input: {
    issue: MultiremiIssue;
    leaderTask: MultiremiTask;
  }): MultiremiTask[] {
    return this.feishuBot.prepareIssueRoundPushesWithinTransaction(input);
  }

  retargetFeishuRoundPushTaskWithinTransaction(fromTaskId: string, toTaskId: string): void {
    this.feishuBot.retargetRoundPushTaskWithinTransaction(fromTaskId, toTaskId);
  }

  completeFeishuRoundPushTaskWithinTransaction(task: MultiremiTask, body: string): void {
    this.feishuBot.completeRoundPushTaskWithinTransaction(task, body);
  }

  claimFeishuBotOutbound(
    workspaceId: string,
    runtimeId: string,
    now?: string | Date,
  ): MultiremiFeishuBotOutboundDelivery | null {
    return this.feishuBot.claimOutbound(workspaceId, runtimeId, now);
  }

  reportFeishuBotOutbound(
    workspaceId: string,
    runtimeId: string,
    deliveryId: string,
    input: Parameters<FeishuBotRepo["reportOutbound"]>[3],
    now?: string | Date,
  ): boolean {
    return this.feishuBot.reportOutbound(workspaceId, runtimeId, deliveryId, input, now);
  }

  resetFeishuBotSession(
    workspaceId: string,
    runtimeId: string,
    revision: number,
    externalSessionKey: string,
  ): boolean {
    return this.feishuBot.resetSession(workspaceId, runtimeId, revision, externalSessionKey);
  }

  cancelFeishuBotSessionTask(
    workspaceId: string,
    runtimeId: string,
    revision: number,
    externalSessionKey: string,
  ): string | null {
    return this.feishuBot.cancelSessionTask(workspaceId, runtimeId, revision, externalSessionKey);
  }

  inspectFeishuBotSession(
    workspaceId: string,
    runtimeId: string,
    revision: number,
    externalSessionKey: string,
  ): ReturnType<FeishuBotRepo["inspectSession"]> {
    return this.feishuBot.inspectSession(workspaceId, runtimeId, revision, externalSessionKey);
  }

  feishuBotDirectiveForRuntime(workspaceId: string, runtimeId: string): MultiremiFeishuBotDirective | null {
    return this.feishuBot.directiveForRuntime(workspaceId, runtimeId);
  }

  reportFeishuBotRuntimeStatus(
    workspaceId: string,
    runtimeId: string,
    input: ReportFeishuBotRuntimeStatusInput,
  ): MultiremiFeishuBotRuntimeStatus {
    return this.feishuBot.reportRuntimeStatus(workspaceId, runtimeId, input);
  }

  listFeishuBotRuntimeStatuses(workspaceId: string): MultiremiFeishuBotRuntimeStatus[] {
    return this.feishuBot.listRuntimeStatuses(workspaceId);
  }

  feishuBotStatusSnapshot(workspaceId: string): FeishuBotStatusSnapshot {
    return this.feishuBot.statusSnapshot(workspaceId);
  }

  recordFeishuBotAudit(
    workspaceId: string,
    action: FeishuBotAuditAction,
    input?: { actorType?: string; actorId?: string | null; details?: Record<string, unknown> },
  ): MultiremiFeishuBotAuditEntry {
    return this.feishuBot.recordAudit(workspaceId, action, input);
  }

  listFeishuBotAudit(workspaceId: string, limit?: number): MultiremiFeishuBotAuditEntry[] {
    return this.feishuBot.listAudit(workspaceId, limit);
  }

  disableFeishuBotConfigsReferencingAgent(agentId: string, actor?: string | null): string[] {
    return this.feishuBot.disableConfigsReferencingAgent(agentId, actor);
  }

  disableFeishuBotConfigsReferencingRuntime(runtimeId: string, actor?: string | null): string[] {
    return this.feishuBot.disableConfigsReferencingRuntime(runtimeId, actor);
  }

  listScmConnections(input: {
    workspaceId?: string | null;
    provider?: MultiremiScmProvider | null;
    enabled?: boolean;
  } = {}): MultiremiScmConnection[] {
    return this.scm.listConnections(input);
  }

  listScmConnectionsWithRepositories(input: {
    workspaceId?: string | null;
    provider?: MultiremiScmProvider | null;
    enabled?: boolean;
  } = {}): ScmConnectionWithRepositories[] {
    return this.scm.listConnectionsWithRepositories(input);
  }

  getScmConnection(id: string): MultiremiScmConnection | null {
    return this.scm.getConnection(id);
  }

  getScmConnectionWithRepositories(id: string): ScmConnectionWithRepositories | null {
    return this.scm.getConnectionWithRepositories(id);
  }

  createScmConnection(input: CreateScmConnectionInput): ScmConnectionWithRepositories {
    return this.scm.createConnection(input);
  }

  updateScmConnection(id: string, input: UpdateScmConnectionInput): ScmConnectionWithRepositories {
    return this.scm.updateConnection(id, input);
  }

  deleteScmConnection(id: string): boolean {
    return this.scm.deleteConnection(id);
  }

  getScmConnectionCredential(id: string): MultiremiScmConnectionCredential | null {
    return this.scm.getConnectionCredential(id);
  }

  listScmRepositoryBindings(input: {
    connectionId?: string | null;
    workspaceId?: string | null;
    enabled?: boolean;
  } = {}): MultiremiScmRepositoryBinding[] {
    return this.scm.listRepositoryBindings(input);
  }

  getScmRepositoryBinding(connectionId: string, repositoryId: string): MultiremiScmRepositoryBinding | null {
    return this.scm.getRepositoryBinding(connectionId, repositoryId);
  }

  findScmRepositoryBindingByUrl(workspaceId: string, repositoryUrl: string): MultiremiScmRepositoryBinding | null {
    return this.scm.findRepositoryBindingByUrl(workspaceId, repositoryUrl);
  }

  upsertScmRepositoryBinding(input: UpsertScmRepositoryBindingInput): MultiremiScmRepositoryBinding {
    return this.scm.upsertRepositoryBinding(input);
  }

  deleteScmRepositoryBinding(connectionId: string, repositoryId: string): boolean {
    return this.scm.deleteRepositoryBinding(connectionId, repositoryId);
  }

  reconcileScmRepositoryBindings(workspaceId: string): MultiremiScmRepositoryBinding[] {
    return this.scm.reconcileRepositoryBindings(workspaceId);
  }

  deleteScmRepositoryBindingsForWorkspaceRepository(workspaceId: string, repositoryId: string): number {
    return this.scm.deleteRepositoryBindingsForWorkspaceRepository(workspaceId, repositoryId);
  }

  markScmConnectionVerificationStarted(id: string): { connection: MultiremiScmConnection; runId: string } {
    return this.scm.markConnectionVerificationStarted(id);
  }

  recordScmConnectionVerification(
    id: string,
    result: MultiremiScmVerificationResult,
    runId: string,
  ): MultiremiScmConnection {
    return this.scm.recordConnectionVerification(id, result, runId);
  }

  getScmSyncCursor(connectionId: string, repositoryId: string, stream: MultiremiScmSyncStream): MultiremiScmSyncCursor | null {
    return this.scm.getSyncCursor(connectionId, repositoryId, stream);
  }

  upsertScmSyncCursor(input: UpsertScmSyncCursorInput): MultiremiScmSyncCursor {
    return this.scm.upsertSyncCursor(input);
  }

  claimScmSyncStream(input: ClaimScmSyncStreamInput): MultiremiScmSyncCursor | null {
    return this.scm.claimSyncStream(input);
  }

  updateClaimedScmSyncCursor(input: UpdateClaimedScmSyncCursorInput): MultiremiScmSyncCursor | null {
    return this.scm.updateClaimedSyncCursor(input);
  }

  releaseScmSyncStream(input: ReleaseScmSyncStreamInput): boolean {
    return this.scm.releaseSyncStream(input);
  }

  getScmEntitySnapshot(
    connectionId: string,
    repositoryId: string,
    entityType: MultiremiScmEntityType,
    externalId: string,
  ): MultiremiScmEntitySnapshot | null {
    return this.scm.getEntitySnapshot(connectionId, repositoryId, entityType, externalId);
  }

  upsertScmEntitySnapshot(input: UpsertScmEntitySnapshotInput): MultiremiScmEntitySnapshot {
    return this.scm.upsertEntitySnapshot(input);
  }

  advanceScmEntitySnapshot(input: UpsertScmEntitySnapshotInput): AdvanceScmEntitySnapshotResult {
    return this.scm.advanceEntitySnapshot(input);
  }

  advanceScmEntitySnapshotWithEvents(
    input: UpsertScmEntitySnapshotInput,
    createEvents: ScmSnapshotEventFactory,
  ): ScmSnapshotEventWriteResult {
    return this.scm.advanceEntitySnapshotWithEvents(input, createEvents);
  }

  recordScmCanonicalEvent(input: RecordScmCanonicalEventInput): RecordScmCanonicalEventResult {
    return this.scm.recordCanonicalEvent(input);
  }

  getScmChangeRequest(id: string): MultiremiScmChangeRequest | null {
    return this.scm.getChangeRequest(id);
  }

  listScmChangeRequestsForIssue(issueId: string): MultiremiScmChangeRequest[] | null {
    return this.scm.listChangeRequestsForIssue(issueId);
  }

  linkScmChangeRequestToIssue(issueId: string, changeRequestId: string): {
    changeRequest: MultiremiScmChangeRequest;
    link: MultiremiScmIssueLink;
  } {
    return this.scm.linkChangeRequestToIssue(issueId, changeRequestId);
  }

  unlinkScmChangeRequestFromIssue(issueId: string, changeRequestId: string): boolean {
    return this.scm.unlinkChangeRequestFromIssue(issueId, changeRequestId);
  }

  getScmCanonicalEvent(id: string): MultiremiScmCanonicalEvent | null {
    return this.scm.getCanonicalEvent(id);
  }

  listScmCanonicalEvents(input: {
    workspaceId: string;
    repositoryId?: string | null;
    connectionId?: string | null;
    type?: MultiremiScmCanonicalEventType | null;
    after?: string | null;
    limit?: number;
  }): MultiremiScmCanonicalEvent[] {
    return this.scm.listCanonicalEvents(input);
  }

  listScmEventEvidence(eventId: string): MultiremiScmEventEvidence[] {
    return this.scm.listEventEvidence(eventId);
  }

  dispatchPendingScmEvents(now: Date = new Date(), limit = 25): MultiremiAutopilotRun[] {
    return this.scm.dispatchPendingEvents(now, limit);
  }

  async createAccessToken(input: CreateAccessTokenInput): Promise<MultiremiCreatedAccessToken> {
    const type = String(input.type ?? "pat").trim().toLowerCase();
    const daemonId = type === "daemon" ? String(input.daemonId ?? input.daemon_id ?? "").trim() : "";
    if (!daemonId) return this.accessTokens.createAccessToken(input);
    const workspaceId = String(input.workspaceId ?? input.workspace_id ?? "local").trim() || "local";
    return this.accessTokens.createAccessToken({ ...input, workspaceId, daemonId }, () => {
      this.daemonRetirement.lockLifecycle(workspaceId, daemonId);
      this.daemonRetirement.assertCanRegister(workspaceId, daemonId);
      this.daemonRetirement.claimIdentityOwnerWithinLock(
        workspaceId,
        daemonId,
        String(input.userId ?? input.user_id ?? "local").trim() || "local",
      );
    });
  }

  async createTaskAccessToken(
    task: Pick<MultiremiTask, "id" | "agentId" | "workspaceId">,
    userId: string,
  ): Promise<MultiremiCreatedAccessToken> {
    const agent = this.getAgent(task.agentId);
    const scopes: string[] = [];
    if (agent && agentRoleAtLeast(agent.role, "supervisor")) scopes.push("organizer:supervisor");
    const storedTask = this.getTask(task.id);
    const run = storedTask?.autopilotRunId ? this.getAutopilotRun(storedTask.autopilotRunId) : null;
    const repositoryWikiAutomation = resolveRepositoryWikiAutomation(this, task.workspaceId);
    if (
      agent
      && agentRoleAtLeast(agent.role, "maintainer")
      && repositoryWikiAutomation
      && run?.autopilotId === repositoryWikiAutomation.id
      && repositoryWikiAutomation.assigneeId === agent.id
    ) {
      scopes.push("repository-wiki:maintainer");
    }
    return this.accessTokens.createTaskAccessToken(task, userId, scopes);
  }

  listAccessTokens(workspaceId?: string | null): MultiremiAccessToken[] {
    return this.accessTokens.listAccessTokens(workspaceId);
  }

  listPersonalAccessTokens(workspaceId: string, userId: string): MultiremiAccessToken[] {
    return this.accessTokens.listPersonalAccessTokens(workspaceId, userId);
  }

  listExpiringBoundDaemonTokens(workspaceId: string): MultiremiAccessToken[] {
    return this.accessTokens.listExpiringBoundDaemonTokens(workspaceId);
  }

  getAccessToken(id: string): MultiremiAccessToken | null {
    return this.accessTokens.getAccessToken(id);
  }

  bindDaemonAccessToken(id: string, daemonId: string): MultiremiAccessToken | null {
    const normalizedDaemonId = daemonId.trim();
    if (!normalizedDaemonId) return null;
    const initial = this.accessTokens.getAccessToken(id);
    if (!initial || initial.type !== "daemon" || initial.expiresAt) return null;
    return this.db.transaction(() => {
      this.daemonRetirement.lockLifecycle(initial.workspaceId, normalizedDaemonId);
      this.daemonRetirement.assertCanRegister(initial.workspaceId, normalizedDaemonId);
      const current = this.accessTokens.getAccessToken(id);
      if (!current || current.type !== "daemon" || current.workspaceId !== initial.workspaceId) return null;
      this.daemonRetirement.claimIdentityOwnerWithinLock(
        current.workspaceId,
        normalizedDaemonId,
        current.userId,
      );
      return this.accessTokens.bindDaemonAccessToken(id, normalizedDaemonId);
    })();
  }

  promoteCliAccessTokenToDaemon(
    id: string,
    workspaceId: string,
    daemonId: string,
  ): MultiremiAccessToken | null {
    const normalizedWorkspaceId = workspaceId.trim() || "local";
    const normalizedDaemonId = daemonId.trim();
    if (!normalizedDaemonId) return null;
    return this.db.transaction(() => {
      this.daemonRetirement.lockLifecycle(normalizedWorkspaceId, normalizedDaemonId);
      this.daemonRetirement.assertCanRegister(normalizedWorkspaceId, normalizedDaemonId);
      const current = this.accessTokens.getAccessToken(id);
      if (
        !current
        || current.workspaceId !== normalizedWorkspaceId
        || current.type !== "pat"
        || current.purpose !== "cli"
        || current.expiresAt
      ) return null;
      this.daemonRetirement.claimIdentityOwnerWithinLock(
        normalizedWorkspaceId,
        normalizedDaemonId,
        current.userId,
      );
      return this.accessTokens.promoteCliAccessTokenToDaemon(
        id,
        normalizedWorkspaceId,
        normalizedDaemonId,
      );
    })();
  }

  promoteCliAccessTokenForRuntime(
    id: string,
    runtimeId: string,
  ): MultiremiAccessToken | null {
    return this.db.transaction(() => {
      const token = this.accessTokens.getAccessToken(id);
      const runtime = this.runtimes.getRuntime(runtimeId);
      if (
        !token ||
        token.type !== "pat" ||
        token.purpose !== "cli" ||
        token.expiresAt ||
        !runtime
      ) {
        return null;
      }
      const workspaceId = String(runtime.workspaceId ?? "local").trim() || "local";
      const daemonId = String(runtime.daemonId ?? "").trim();
      const runtimeOwnerId = String(runtime.ownerId ?? "").trim();
      if (
        !daemonId ||
        token.workspaceId !== workspaceId ||
        !runtimeOwnerId ||
        token.userId !== runtimeOwnerId
      ) {
        return null;
      }
      this.daemonRetirement.lockLifecycle(workspaceId, daemonId);
      this.daemonRetirement.assertCanRegister(workspaceId, daemonId);
      this.daemonRetirement.claimIdentityOwnerWithinLock(workspaceId, daemonId, token.userId);
      return this.accessTokens.promoteCliAccessTokenToDaemon(
        id,
        workspaceId,
        daemonId,
      );
    })();
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
    const daemonId = String(input.daemonId ?? input.daemon_id ?? "").trim();
    if (!daemonId) {
      const runtime = this.runtimes.registerRuntime(input);
      this.runtimeProvisions.enqueueRuntimeOnRegister(runtime.id);
      return runtime;
    }
    const workspaceId = String(input.workspaceId ?? input.workspace_id ?? "local").trim() || "local";
    const tx = this.db.transaction(() => {
      this.daemonRetirement.lockLifecycle(workspaceId, daemonId);
      this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
      this.agentPlugins.lockAgentPluginWorkspace(workspaceId);
      this.daemonRetirement.assertCanRegister(workspaceId, daemonId);
      const requestedOwnerId = String(input.ownerId ?? input.owner_id ?? "").trim() || null;
      const ownerId = this.daemonRetirement.claimIdentityOwnerWithinLock(
        workspaceId,
        daemonId,
        requestedOwnerId,
      );
      const runtime = this.runtimes.registerRuntimeWithinTransaction({
        ...input,
        workspaceId,
        daemonId,
        ownerId,
      });
      this.agentPlugins.reconcileAgentPluginDesiredStateWithinLock(workspaceId);
      return runtime;
    });
    const runtime = tx();
    this.runtimeProvisions.enqueueRuntimeOnRegister(runtime.id);
    return runtime;
  }

  registerDaemonRuntimeBatch(
    inputs: RegisterRuntimeInput[],
    options: { displayName?: string | null } = {},
  ): MultiremiRuntime[] {
    if (inputs.length === 0) return [];
    const first = inputs[0];
    const workspaceId = String(first.workspaceId ?? first.workspace_id ?? "local").trim() || "local";
    const daemonId = String(first.daemonId ?? first.daemon_id ?? "").trim();
    if (!daemonId) throw new Error("daemonId is required for daemon Runtime registration");
    for (const input of inputs) {
      const inputWorkspaceId = String(input.workspaceId ?? input.workspace_id ?? "local").trim() || "local";
      const inputDaemonId = String(input.daemonId ?? input.daemon_id ?? "").trim();
      if (inputWorkspaceId !== workspaceId || inputDaemonId !== daemonId) {
        throw new Error("daemon Runtime batch must use one workspace and daemon identity");
      }
    }

    const runtimes = this.db.transaction(() => {
      this.daemonRetirement.lockLifecycle(workspaceId, daemonId);
      this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
      this.agentPlugins.lockAgentPluginWorkspace(workspaceId);
      this.daemonRetirement.assertCanRegister(workspaceId, daemonId);
      const requestedOwnerId = String(first.ownerId ?? first.owner_id ?? "").trim() || null;
      const ownerId = this.daemonRetirement.claimIdentityOwnerWithinLock(
        workspaceId,
        daemonId,
        requestedOwnerId,
      );
      const displayName = String(options.displayName ?? "").trim();
      if (displayName) {
        this.daemonProfiles.upsertDisplayName(workspaceId, daemonId, displayName, {
          customized: false,
        });
      }
      const runtimes = inputs.map((input) => this.runtimes.registerRuntimeWithinTransaction({
        ...input,
        workspaceId,
        daemonId,
        ownerId,
      }));
      this.agentPlugins.reconcileAgentPluginDesiredStateWithinLock(workspaceId);
      return runtimes;
    })();
    for (const runtime of runtimes) this.runtimeProvisions.enqueueRuntimeOnRegister(runtime.id);
    return runtimes;
  }

  isDaemonRetired(workspaceId: string, daemonId: string): boolean {
    return this.daemonRetirement.isRetired(workspaceId, daemonId);
  }

  listDaemonInventory(workspaceId: string): DaemonInventoryEntry[] {
    return this.daemonRetirement.listInventory(workspaceId);
  }

  getDaemonIdentityOwnerUserId(workspaceId: string, daemonId: string): string | null {
    return this.daemonRetirement.getIdentityOwnerUserId(workspaceId, daemonId);
  }

  getDaemonProfile(workspaceId: string, daemonId: string): DaemonProfile | null {
    return this.daemonProfiles.get(workspaceId, daemonId);
  }

  listDaemonProfiles(workspaceId: string): DaemonProfile[] {
    return this.daemonProfiles.list(workspaceId);
  }

  updateDaemonDisplayName(
    workspaceId: string,
    daemonId: string,
    displayName: string,
    updatedBy: string | null,
  ): DaemonProfile {
    return this.daemonProfiles.upsertDisplayName(workspaceId, daemonId, displayName, {
      customized: true,
      updatedBy,
    });
  }

  updateDaemonDedicated(
    workspaceId: string,
    daemonId: string,
    dedicated: boolean,
    updatedBy: string | null,
  ): DaemonProfile {
    return this.db.transaction(() => {
      this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
      const runtime = this.listRuntimes().find((candidate) => (
        (candidate.workspaceId ?? "local") === workspaceId && candidate.daemonId === daemonId
      ));
      if (!runtime) throw new Error(`Daemon not found: ${daemonId}`);
      const current = this.daemonProfiles.get(workspaceId, daemonId);
      return this.daemonProfiles.upsertDedicated(
        workspaceId,
        daemonId,
        current?.displayName ?? runtime.daemonDisplayName ?? daemonId,
        dedicated,
        updatedBy,
      );
    })();
  }

  getDaemonRetirementPlan(workspaceId: string, daemonId: string): DaemonRetirementPlan {
    return this.daemonRetirement.getPlan(workspaceId, daemonId);
  }

  getDaemonRetirementSshMeshRekey(
    workspaceId: string,
    daemonId: string,
  ): DaemonRetirementSshMeshRekey | null {
    return this.daemonRetirement.getSshMeshRekey(workspaceId, daemonId);
  }

  setDaemonRetirementSshMeshRekey(
    workspaceId: string,
    daemonId: string,
    status: DaemonRetirementSshMeshRekeyStatus,
    replacementKeyVersion: number | null,
  ): DaemonRetirementSshMeshRekey {
    return this.withSshMeshLifecycleLock(workspaceId, () => this.daemonRetirement.setSshMeshRekey(
      workspaceId,
      daemonId,
      status,
      replacementKeyVersion,
    ));
  }

  reconcileDaemonRetirementSshMeshRekey(
    workspaceId: string,
    daemonId: string,
    keyMaterial: SshMeshKeyMaterial | null,
  ): {
    status: DaemonRetirementSshMeshRekeyStatus;
    keyVersion: number | null;
    rotationState: string;
  } {
    return this.withSshMeshLifecycleLock(workspaceId, () => {
      let rekey = this.daemonRetirement.ensureSshMeshRekeyOperationId(workspaceId, daemonId);
      let mutation = this.sshMesh.getMutationState(workspaceId);
      if (rekey.status === "not_required" || rekey.status === "completed" || rekey.status === "rekey_required") {
        return {
          status: rekey.status,
          keyVersion: rekey.replacementKeyVersion ?? mutation.overview.key_version,
          rotationState: mutation.overview.rotation_state,
        };
      }

      if (rekey.status === "rolling_out") {
        const exactReplacement = rekey.operationId !== null
          && mutation.activeOperationId === rekey.operationId
          && rekey.replacementKeyVersion !== null
          && mutation.overview.key_version === rekey.replacementKeyVersion
          && mutation.overview.fingerprint !== null;
        if (exactReplacement) {
          const status = mutation.overview.rotation_state === "stable" ? "completed" : "rolling_out";
          rekey = this.daemonRetirement.setSshMeshRekey(
            workspaceId,
            daemonId,
            status,
            rekey.replacementKeyVersion,
          );
          return {
            status: rekey.status,
            keyVersion: rekey.replacementKeyVersion,
            rotationState: mutation.overview.rotation_state,
          };
        }
        return this.invalidateDaemonRetirementSshMeshRekey(workspaceId, rekey.operationId);
      }

      const canReplaceCompromisedGeneration = rekey.operationId !== null
        && rekey.compromisedKeyVersion !== null
        && keyMaterial !== null
        && mutation.overview.enabled
        && mutation.overview.rotation_state === "stable"
        && mutation.overview.fingerprint !== null
        && mutation.overview.key_version === rekey.compromisedKeyVersion;
      if (!canReplaceCompromisedGeneration) {
        return this.invalidateDaemonRetirementSshMeshRekey(workspaceId, rekey.operationId);
      }

      const overview = this.sshMesh.rotate(workspaceId, keyMaterial, rekey.operationId);
      const status = overview.rotation_state === "stable" ? "completed" : "rolling_out";
      rekey = this.daemonRetirement.setSshMeshRekey(
        workspaceId,
        daemonId,
        status,
        overview.key_version,
      );
      return {
        status: rekey.status,
        keyVersion: rekey.replacementKeyVersion,
        rotationState: overview.rotation_state,
      };
    });
  }

  private withSshMeshLifecycleLock<T>(workspaceId: string, operation: () => T): T {
    return this.db.transaction(() => {
      this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
      return operation();
    })();
  }

  private assertNoDaemonRetirementRekeyInProgress(workspaceId: string): void {
    if (this.daemonRetirement.hasSshMeshRekeyInProgress(workspaceId)) {
      throw new Error("A daemon retirement SSH key replacement is in progress");
    }
  }

  private invalidateDaemonRetirementSshMeshRekey(
    workspaceId: string,
    operationId: string | null,
  ): {
    status: DaemonRetirementSshMeshRekeyStatus;
    keyVersion: number | null;
    rotationState: string;
  } {
    const invalidated = this.sshMesh.invalidate(workspaceId, operationId);
    this.daemonRetirement.markSshMeshRekeysRequiredAfterInvalidation(workspaceId);
    return {
      status: "rekey_required",
      keyVersion: invalidated.key_version,
      rotationState: invalidated.rotation_state,
    };
  }

  retireDaemon(
    workspaceId: string,
    daemonId: string,
    expectedSnapshot: string,
    retiredBy: string | null,
    requiredOwnerUserId: string | null = null,
    options: { abandonIssueWorkspaces?: boolean } = {},
  ): RetireDaemonResult {
    return this.daemonRetirement.retire(
      workspaceId,
      daemonId,
      expectedSnapshot,
      retiredBy,
      requiredOwnerUserId,
      options,
    );
  }

  getRuntime(id: string): MultiremiRuntime | null {
    return this.runtimes.getRuntime(id);
  }

  listRuntimes(): MultiremiRuntime[] {
    return this.runtimes.listRuntimes();
  }

  listActiveAgentsByRuntime(runtimeId: string): MultiremiAgent[] {
    return this.agents.listActiveAgentsByRuntime(runtimeId);
  }

  updateRuntime(id: string, input: UpdateRuntimeInput): MultiremiRuntime {
    return this.runtimes.updateRuntime(id, input);
  }

  setRuntimeOffline(id: string): MultiremiRuntime | null {
    return this.runtimes.setRuntimeOffline(id);
  }

  recordRuntimeFailure(input: RuntimeFailureAnalyticsInput): MultiremiAnalyticsEvent {
    return this.analytics.recordRuntimeFailure(input);
  }

  recordAgentCreated(input: AgentCreatedAnalyticsInput): MultiremiAnalyticsEvent {
    return this.analytics.recordAgentCreated(input);
  }

  deleteRuntime(id: string): boolean {
    return this.runtimes.deleteRuntime(id);
  }

  deleteRuntimeWithArchivedAgentCleanup(id: string): StrictRuntimeDeleteResult {
    return this.runtimes.deleteRuntimeWithArchivedAgentCleanup(id);
  }

  archiveAgentsAndDeleteRuntime(
    id: string,
    expectedActiveAgentIds: string[],
  ): ArchiveAgentsAndDeleteRuntimeResult {
    return this.runtimes.archiveAgentsAndDeleteRuntime(id, expectedActiveAgentIds);
  }

  mergeRuntimeInto(
    oldRuntimeId: string,
    newRuntimeId: string,
    options: { legacyDaemonIds?: string[] } = {},
  ): { agentsReassigned: number; tasksReassigned: number; deleted: boolean } {
    return this.runtimes.mergeRuntimeInto(oldRuntimeId, newRuntimeId, options);
  }

  canonicalizeLegacyDaemonRouting(
    workspaceId: string,
    legacyDaemonIds: string[],
    canonicalDaemonId: string,
  ): void {
    this.runtimes.canonicalizeLegacyDaemonRouting(workspaceId, legacyDaemonIds, canonicalDaemonId);
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
    return this.runtimes.recordRuntimeLegacyDaemonId(runtimeId, legacyDaemonId, audit);
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
    return this.runtimes.listRuntimeModels(runtimeId);
  }

  updateRuntimeModels(runtimeId: string, models: MultiremiRuntimeModel[]): MultiremiRuntimeModel[] {
    return this.runtimes.updateRuntimeModels(runtimeId, models);
  }

  createRuntimeModelListRequest(runtimeId: string): MultiremiRuntimeModelListRequest {
    return this.runtimes.createRuntimeModelListRequest(runtimeId);
  }

  getRuntimeModelListRequest(runtimeId: string, requestId: string): MultiremiRuntimeModelListRequest | null {
    return this.runtimes.getRuntimeModelListRequest(runtimeId, requestId);
  }

  claimRuntimeModelListRequest(runtimeId: string): MultiremiRuntimeModelListRequest | null {
    return this.runtimes.claimRuntimeModelListRequest(runtimeId);
  }

  reportRuntimeModelListResult(runtimeId: string, requestId: string, input: ReportRuntimeModelListInput): MultiremiRuntimeModelListRequest {
    return this.runtimes.reportRuntimeModelListResult(runtimeId, requestId, input);
  }

  createRuntimeDirectoryScanRequest(runtimeId: string, params: { root?: string; maxDepth?: number; mode?: "scan" | "browse" } = {}): MultiremiRuntimeDirectoryScanRequest {
    return this.runtimes.createRuntimeDirectoryScanRequest(runtimeId, params);
  }

  getRuntimeDirectoryScanRequest(runtimeId: string, requestId: string): MultiremiRuntimeDirectoryScanRequest | null {
    return this.runtimes.getRuntimeDirectoryScanRequest(runtimeId, requestId);
  }

  claimRuntimeDirectoryScanRequest(runtimeId: string): MultiremiRuntimeDirectoryScanRequest | null {
    return this.runtimes.claimRuntimeDirectoryScanRequest(runtimeId);
  }

  reportRuntimeDirectoryScanResult(runtimeId: string, requestId: string, input: ReportRuntimeDirectoryScanInput): MultiremiRuntimeDirectoryScanRequest {
    return this.runtimes.reportRuntimeDirectoryScanResult(runtimeId, requestId, input);
  }

  createRuntimeUpdateRequest(runtimeId: string, input: CreateRuntimeUpdateInput): MultiremiRuntimeUpdateRequest {
    return this.runtimes.createRuntimeUpdateRequest(runtimeId, input);
  }

  reconcileRuntimeCliRelease(targetVersion: string): MultiremiRuntimeUpdateRequest[] {
    return this.runtimes.reconcileRuntimeCliRelease(targetVersion);
  }

  getRuntimeUpdateRequest(runtimeId: string, requestId: string): MultiremiRuntimeUpdateRequest | null {
    return this.runtimes.getRuntimeUpdateRequest(runtimeId, requestId);
  }

  hasCliUpdateDrainForRuntime(runtimeId: string): boolean {
    return this.runtimes.hasCliUpdateDrainForRuntime(runtimeId);
  }

  claimRuntimeUpdateRequest(runtimeId: string): MultiremiRuntimeUpdateRequest | null {
    return this.runtimes.claimRuntimeUpdateRequest(runtimeId);
  }

  reportRuntimeUpdateResult(runtimeId: string, requestId: string, input: ReportRuntimeUpdateInput): MultiremiRuntimeUpdateRequest {
    return this.runtimes.reportRuntimeUpdateResult(runtimeId, requestId, input);
  }

  createRuntimeCommandRequest(runtimeId: string, input: CreateRuntimeCommandInput): MultiremiRuntimeCommandRequest {
    return this.runtimes.createRuntimeCommandRequest(runtimeId, input);
  }

  getRuntimeCommandRequest(runtimeId: string, requestId: string): MultiremiRuntimeCommandRequest | null {
    return this.runtimes.getRuntimeCommandRequest(runtimeId, requestId);
  }

  claimRuntimeCommandRequest(runtimeId: string): MultiremiRuntimeCommandRequest | null {
    return this.runtimes.claimRuntimeCommandRequest(runtimeId);
  }

  reportRuntimeCommandResult(runtimeId: string, requestId: string, input: ReportRuntimeCommandInput): MultiremiRuntimeCommandRequest {
    const request = this.runtimes.reportRuntimeCommandResult(runtimeId, requestId, input);
    this.runtimeProvisions.recordCommandResult(request);
    return request;
  }

  createBotMenuPublishRequest(runtimeId: string, input: CreateBotMenuPublishRequestInput): MultiremiBotMenuPublishRequest {
    return this.runtimes.createBotMenuPublishRequest(runtimeId, input);
  }

  getBotMenuPublishRequest(runtimeId: string, requestId: string): MultiremiBotMenuPublishRequest | null {
    return this.runtimes.getBotMenuPublishRequest(runtimeId, requestId);
  }

  findBotMenuPublishRequest(workspaceId: string, requestId: string): MultiremiBotMenuPublishRequest | null {
    return this.runtimes.findBotMenuPublishRequest(workspaceId, requestId);
  }

  claimBotMenuPublishRequest(runtimeId: string): MultiremiBotMenuPublishRequest | null {
    return this.runtimes.claimBotMenuPublishRequest(runtimeId);
  }

  reportBotMenuPublishResult(runtimeId: string, requestId: string, input: ReportBotMenuPublishInput): MultiremiBotMenuPublishRequest {
    return this.runtimes.reportBotMenuPublishResult(runtimeId, requestId, input);
  }

  listWorkspaceRuntimeProvisions(workspaceId: string): MultiremiWorkspaceRuntimeProvision[] {
    return this.runtimeProvisions.list(workspaceId);
  }

  getWorkspaceRuntimeProvision(id: string): MultiremiWorkspaceRuntimeProvision | null {
    return this.runtimeProvisions.get(id);
  }

  createWorkspaceRuntimeProvision(
    workspaceId: string,
    input: CreateWorkspaceRuntimeProvisionInput,
  ): MultiremiWorkspaceRuntimeProvision {
    return this.runtimeProvisions.create(workspaceId, input);
  }

  updateWorkspaceRuntimeProvision(
    id: string,
    input: UpdateWorkspaceRuntimeProvisionInput,
  ): MultiremiWorkspaceRuntimeProvision {
    return this.runtimeProvisions.update(id, input);
  }

  deleteWorkspaceRuntimeProvision(id: string, actorId: string | null = null): boolean {
    return this.runtimeProvisions.delete(id, actorId);
  }

  listRuntimeProvisionStates(provisionId: string): MultiremiRuntimeProvisionState[] {
    return this.runtimeProvisions.listStates(provisionId);
  }

  enqueueWorkspaceRuntimeProvision(provisionId: string): number {
    return this.runtimeProvisions.enqueueWorkspaceProvision(provisionId);
  }

  createRuntimeLocalSkillListRequest(runtimeId: string): MultiremiRuntimeLocalSkillListRequest {
    return this.runtimes.createRuntimeLocalSkillListRequest(runtimeId);
  }

  getRuntimeLocalSkillListRequest(runtimeId: string, requestId: string): MultiremiRuntimeLocalSkillListRequest | null {
    return this.runtimes.getRuntimeLocalSkillListRequest(runtimeId, requestId);
  }

  claimRuntimeLocalSkillListRequest(runtimeId: string): MultiremiRuntimeLocalSkillListRequest | null {
    return this.runtimes.claimRuntimeLocalSkillListRequest(runtimeId);
  }

  reportRuntimeLocalSkillListResult(runtimeId: string, requestId: string, input: ReportRuntimeLocalSkillListInput): MultiremiRuntimeLocalSkillListRequest {
    return this.runtimes.reportRuntimeLocalSkillListResult(runtimeId, requestId, input);
  }

  createRuntimeLocalSkillImportRequest(runtimeId: string, input: CreateRuntimeLocalSkillImportInput): MultiremiRuntimeLocalSkillImportRequest {
    return this.runtimes.createRuntimeLocalSkillImportRequest(runtimeId, input);
  }

  getRuntimeLocalSkillImportRequest(runtimeId: string, requestId: string): MultiremiRuntimeLocalSkillImportRequest | null {
    return this.runtimes.getRuntimeLocalSkillImportRequest(runtimeId, requestId);
  }

  claimRuntimeLocalSkillImportRequests(runtimeId: string, limit = 10): MultiremiRuntimeLocalSkillImportRequest[] {
    return this.runtimes.claimRuntimeLocalSkillImportRequests(runtimeId, limit);
  }

  reportRuntimeLocalSkillImportResult(runtimeId: string, requestId: string, input: ReportRuntimeLocalSkillImportInput): MultiremiRuntimeLocalSkillImportRequest {
    return this.runtimes.reportRuntimeLocalSkillImportResult(runtimeId, requestId, input);
  }

  listRuntimeUsage(runtimeId?: string | null): MultiremiRuntimeUsage[] {
    return this.usage.listRuntimeUsage(runtimeId);
  }

  listUsageDaily(input: {
    workspaceId?: string | null;
    projectId?: string | null;
    runtimeId?: string | null;
    days?: number;
    tz?: string | null;
  } = {}): MultiremiUsageDaily[] {
    return this.usage.listUsageDaily(input);
  }

  listUsageByAgent(input: {
    workspaceId?: string | null;
    projectId?: string | null;
    runtimeId?: string | null;
    days?: number;
    tz?: string | null;
  } = {}): MultiremiUsageByAgent[] {
    return this.usage.listUsageByAgent(input);
  }

  listUsageByHour(input: {
    workspaceId?: string | null;
    projectId?: string | null;
    runtimeId?: string | null;
    days?: number;
    tz?: string | null;
  } = {}): MultiremiUsageByHour[] {
    return this.usage.listUsageByHour(input);
  }

  listTaskActivityByHour(input: {
    workspaceId?: string | null;
    projectId?: string | null;
    runtimeId?: string | null;
    days?: number;
    tz?: string | null;
  } = {}): MultiremiTaskActivityByHour[] {
    return this.usage.listTaskActivityByHour(input);
  }

  listRuntimeDaily(input: {
    workspaceId?: string | null;
    projectId?: string | null;
    runtimeId?: string | null;
    days?: number;
    tz?: string | null;
  } = {}): MultiremiRuntimeDaily[] {
    return this.usage.listRuntimeDaily(input);
  }

  listAgentRuntime(input: {
    workspaceId?: string | null;
    projectId?: string | null;
    runtimeId?: string | null;
    days?: number;
    tz?: string | null;
  } = {}): MultiremiAgentRuntime[] {
    return this.usage.listAgentRuntime(input);
  }
  heartbeatRuntime(runtimeId: string, options: {
    claimPending?: boolean;
    supportsBatchImport?: boolean;
    supportsDirectoryScan?: boolean;
    agentPluginProtocol?: number;
    supportsBotMenu?: boolean;
    supportsFeishuBotConfig?: boolean;
  } = {}): MultiremiDaemonHeartbeatAck {
    return this.runtimes.heartbeatRuntime(runtimeId, options);
  }

  createIssue(input: CreateIssueInput): MultiremiIssue {
    return this.issues.createIssue(input);
  }

  getIssue(id: string): MultiremiIssue | null {
    return this.issues.getIssue(id);
  }

  getIssueWorkspace(issueId: string): MultiremiIssueWorkspace | null {
    return this.issueWorkspaces.get(issueId);
  }

  reportIssueWorkspace(input: ReportIssueWorkspaceInput): MultiremiIssueWorkspace {
    return this.issueWorkspaces.report(input);
  }

  markIssueWorkspaceCleaned(input: MarkIssueWorkspaceCleanedInput): MultiremiIssueWorkspace {
    return this.issueWorkspaces.markCleaned(input);
  }

  getIssueByRef(ref: string, workspaceId?: string | null): MultiremiIssue | null {
    return this.issues.getIssueByRef(ref, workspaceId);
  }

  getIssueWithTasks(id: string): MultiremiIssueWithTasks | null {
    return this.issues.getIssueWithTasks(id);
  }

  getIssueShare(id: string): MultiremiIssueShare | null {
    return this.issueShares.get(id);
  }

  getActiveIssueShare(issueId: string): MultiremiIssueShare | null {
    return this.issueShares.getActiveForIssue(issueId);
  }

  ensureIssueShare(issueId: string, workspaceId: string, createdBy: string, days = 60): MultiremiIssueShare {
    return this.issueShares.ensure(issueId, workspaceId, createdBy, days);
  }

  extendIssueShare(id: string, days = 60): MultiremiIssueShare | null {
    return this.issueShares.extend(id, days);
  }

  revokeIssueShare(id: string): MultiremiIssueShare | null {
    return this.issueShares.revoke(id);
  }

  recordIssueShareView(id: string): void {
    return this.issueShares.recordView(id);
  }

  listIssues(input: ListIssuesInput = {}): MultiremiIssue[] {
    return this.issues.listIssues(input);
  }

  countIssues(input: ListIssuesInput = {}): number {
    return this.issues.countIssues(input);
  }

  listGroupedIssues(input: ListIssuesInput = {}): { groups: MultiremiIssueAssigneeGroup[] } {
    return this.issues.listGroupedIssues(input);
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
    return this.issues.listAssigneeFrequency(input);
  }

  batchUpdateIssues(input: BatchUpdateIssuesInput): { updated: number; issues: MultiremiIssue[] } {
    return this.issues.batchUpdateIssues(input);
  }

  deleteIssue(id: string): boolean {
    return this.issues.deleteIssue(id);
  }

  deleteIssuesAtomically(ids: string[]): { deleted: number } {
    return this.issues.deleteIssuesAtomically(ids);
  }

  beginIssueDeletion(id: string): BeginIssueDeletionResult {
    return this.issues.beginIssueDeletion(id);
  }

  abortIssueDeletion(id: string): void {
    this.issues.abortIssueDeletion(id);
  }

  getIssueDeletionLifecycleState(id: string): string | null {
    return this.issues.deletionLifecycleState(id);
  }

  batchDeleteIssues(input: BatchDeleteIssuesInput): { deleted: number } {
    return this.issues.batchDeleteIssues(input);
  }

  searchIssues(input: {
    q: string;
    workspaceId?: string | null;
    includeClosed?: boolean;
    includeCommentBodies?: boolean;
    limit?: number;
    offset?: number;
  }): { issues: MultiremiIssueSearchResult[]; total: number } {
    return this.issues.searchIssues(input);
  }

  listChildIssues(parentIssueId: string): MultiremiIssue[] {
    return this.issues.listChildIssues(parentIssueId);
  }

  listChildIssueProgress(workspaceId = "local"): MultiremiIssueChildProgress[] {
    return this.issues.listChildIssueProgress(workspaceId);
  }

  getChildIssueProgress(parentIssueId: string): MultiremiIssueChildProgress {
    return this.issues.getChildIssueProgress(parentIssueId);
  }

  listIssueDependencies(issueId: string): MultiremiIssueDependency[] {
    return this.issues.listIssueDependencies(issueId);
  }

  createIssueDependency(
    issueId: string,
    input: CreateIssueDependencyInput,
    activity?: IssueMutationActivityContext,
  ): MultiremiIssueDependency {
    return this.issues.createIssueDependency(issueId, input, activity);
  }

  getIssueDependency(id: string): MultiremiIssueDependency | null {
    return this.issues.getIssueDependency(id);
  }

  deleteIssueDependency(
    issueId: string,
    dependencyId: string,
    activity?: IssueMutationActivityContext,
  ): void {
    return this.issues.deleteIssueDependency(issueId, dependencyId, activity);
  }

  updateIssue(id: string, input: UpdateIssueInput): MultiremiIssue {
    return this.issues.updateIssue(id, input);
  }

  restoreIssue(id: string): MultiremiIssue {
    return this.issues.restoreIssue(id);
  }

  archiveEligibleIssues(now?: Date): MultiremiIssue[] {
    return this.issues.archiveEligibleIssues(now);
  }

  issueArchiveSweepIntervalMs(): number {
    return this.issues.issueArchiveSweepIntervalMs();
  }

  assignIssue(id: string, input: AssignIssueInput): AssignIssueResult {
    return this.issues.assignIssue(id, input);
  }

  quickCreateIssue(input: QuickCreateIssueInput): QuickCreateIssueResult {
    return this.issues.quickCreateIssue(input);
  }

  listGeneratedIssues(sourceIssueId: string): MultiremiIssue[] {
    return this.issues.listGeneratedIssues(sourceIssueId);
  }

  findGeneratedIssueByTitle(sourceIssueId: string, title: string): MultiremiIssue | null {
    return this.issues.findGeneratedIssueByTitle(sourceIssueId, title);
  }

  createIssueComment(issueId: string, input: CreateIssueCommentInput): MultiremiIssueComment {
    return this.issues.createIssueComment(issueId, input);
  }

  createTaskFailureSystemComment(
    issueId: string,
    issueSessionId: string | null,
    taskId: string,
    body: string,
  ): MultiremiIssueComment {
    return this.issues.createTaskFailureSystemComment(issueId, issueSessionId, taskId, body);
  }

  updateIssueComment(id: string, input: UpdateIssueCommentInput): MultiremiIssueComment {
    return this.issues.updateIssueComment(id, input);
  }

  deleteIssueComment(id: string): void {
    return this.issues.deleteIssueComment(id);
  }

  resolveIssueComment(id: string, input: { actorType?: string; actorId?: string | null } = {}): MultiremiIssueComment {
    return this.issues.resolveIssueComment(id, input);
  }

  unresolveIssueComment(id: string): MultiremiIssueComment {
    return this.issues.unresolveIssueComment(id);
  }

  getIssueComment(id: string): MultiremiIssueComment | null {
    return this.issues.getIssueComment(id);
  }

  listIssueComments(issueId: string): MultiremiIssueComment[] {
    return this.issues.listIssueComments(issueId);
  }

  listIssueCommentsForGoCli(issueId: string, input: ListIssueCommentsInput = {}): ListIssueCommentsResult {
    return this.issues.listIssueCommentsForGoCli(issueId, input);
  }

  listIssueActivity(issueId: string): MultiremiIssueActivity[] {
    return this.issues.listIssueActivity(issueId);
  }

  recordIssueDispatchSkipped(issueId: string, input: {
    reason: string;
    error?: string | null;
    assigneeType?: string | null;
    assigneeId?: string | null;
  }): MultiremiIssueActivity {
    return this.issues.recordDispatchSkipped(issueId, input);
  }

  recordSquadLeaderEvaluation(issueId: string, input: {
    outcome: "action" | "no_action" | "failed" | string;
    reason?: string | null;
    taskId?: string | null;
    actorId?: string | null;
  }): MultiremiIssueActivity {
    return this.issues.recordSquadLeaderEvaluation(issueId, input);
  }

  listIssueTimeline(issueId: string, options: { ascending?: boolean; issueSessionId?: string | null } = {}): MultiremiTimelineEntry[] {
    return this.issues.listIssueTimeline(issueId, options);
  }

  listIssueSubscribers(issueId: string): MultiremiIssueSubscriber[] {
    return this.issues.listIssueSubscribers(issueId);
  }

  addIssueSubscriber(issueId: string, memberId: string, reason: MultiremiSubscriptionReason = "manual"): MultiremiIssueSubscriber {
    return this.issues.addIssueSubscriber(issueId, memberId, reason);
  }

  addTypedIssueSubscriber(
    issueId: string,
    userType: string,
    userId: string,
    reason: MultiremiSubscriptionReason = "manual",
  ): MultiremiIssueSubscriber {
    return this.issues.addTypedIssueSubscriber(issueId, userType, userId, reason);
  }

  removeIssueSubscriber(issueId: string, memberId: string): void {
    return this.issues.removeIssueSubscriber(issueId, memberId);
  }

  removeTypedIssueSubscriber(issueId: string, userType: string, userId: string): void {
    return this.issues.removeTypedIssueSubscriber(issueId, userType, userId);
  }

  listLabels(workspaceId?: string | null): MultiremiLabel[] {
    return this.issues.listLabels(workspaceId);
  }

  getLabel(id: string): MultiremiLabel | null {
    return this.issues.getLabel(id);
  }

  createLabel(input: CreateLabelInput): MultiremiLabel {
    return this.issues.createLabel(input);
  }

  updateLabel(id: string, input: UpdateLabelInput): MultiremiLabel {
    return this.issues.updateLabel(id, input);
  }

  deleteLabel(id: string): MultiremiLabel {
    return this.issues.deleteLabel(id);
  }

  listLabelsForIssue(issueId: string): MultiremiLabel[] {
    return this.issues.listLabelsForIssue(issueId);
  }

  attachLabelToIssue(
    issueId: string,
    labelId: string,
    activity?: IssueMutationActivityContext,
  ): MultiremiLabel[] {
    return this.issues.attachLabelToIssue(issueId, labelId, activity);
  }

  detachLabelFromIssue(
    issueId: string,
    labelId: string,
    activity?: IssueMutationActivityContext,
  ): MultiremiLabel[] {
    return this.issues.detachLabelFromIssue(issueId, labelId, activity);
  }

  listInboxItems(memberId?: string | null): MultiremiInboxItem[] {
    return this.issues.listInboxItems(memberId);
  }

  listInboxItemsPage(
    memberId?: string | null,
    options: { limit?: number; cursor?: string | null } = {},
  ): MultiremiInboxPage {
    return this.issues.listInboxItemsPage(memberId, options);
  }

  getInboxSummary(memberId?: string | null, timezoneOffsetMinutes = 0): MultiremiInboxSummary {
    return this.issues.getInboxSummary(memberId, timezoneOffsetMinutes);
  }

  markInboxItemRead(id: string): MultiremiInboxItem {
    return this.issues.markInboxItemRead(id);
  }

  archiveInboxItem(id: string): MultiremiInboxItem {
    return this.issues.archiveInboxItem(id);
  }

  countUnreadInboxItems(memberId?: string | null): number {
    return this.issues.countUnreadInboxItems(memberId);
  }

  markAllInboxItemsRead(memberId?: string | null): number {
    return this.issues.markAllInboxItemsRead(memberId);
  }

  archiveAllInboxItems(memberId?: string | null, mode: "all" | "read" | "completed" = "all"): number {
    return this.issues.archiveAllInboxItems(memberId, mode);
  }

  listIssueReactions(issueId: string): MultiremiIssueReaction[] {
    return this.issues.listIssueReactions(issueId);
  }

  addIssueReaction(issueId: string, input: { actorType?: string; actorId?: string | null; emoji: string }): MultiremiIssueReaction {
    return this.issues.addIssueReaction(issueId, input);
  }

  removeIssueReaction(issueId: string, input: { actorType?: string; actorId?: string | null; emoji: string }): void {
    return this.issues.removeIssueReaction(issueId, input);
  }

  listCommentReactions(commentId: string): MultiremiCommentReaction[] {
    return this.issues.listCommentReactions(commentId);
  }

  addCommentReaction(commentId: string, input: { actorType?: string; actorId?: string | null; emoji: string }): MultiremiCommentReaction {
    return this.issues.addCommentReaction(commentId, input);
  }

  removeCommentReaction(commentId: string, input: { actorType?: string; actorId?: string | null; emoji: string }): void {
    return this.issues.removeCommentReaction(commentId, input);
  }

  createAttachment(input: CreateAttachmentInput): MultiremiAttachment {
    return this.issues.createAttachment(input);
  }

  getAttachment(id: string): MultiremiAttachment | null {
    return this.issues.getAttachment(id);
  }

  deleteAttachment(id: string): MultiremiAttachment | null {
    return this.issues.deleteAttachment(id);
  }

  listAttachmentsForIssue(issueId: string): MultiremiAttachment[] {
    return this.issues.listAttachmentsForIssue(issueId);
  }

  listAttachmentsForComment(commentId: string): MultiremiAttachment[] {
    return this.issues.listAttachmentsForComment(commentId);
  }

  listAttachmentsForChatMessage(chatMessageId: string): MultiremiAttachment[] {
    return this.issues.listAttachmentsForChatMessage(chatMessageId);
  }

  listAttachmentsForChatMessages(chatMessageIds: string[]): Map<string, MultiremiAttachment[]> {
    return this.issues.listAttachmentsForChatMessages(chatMessageIds);
  }

  linkAttachmentsToIssue(issueId: string, attachmentIds: string[]): void {
    return this.issues.linkAttachmentsToIssue(issueId, attachmentIds);
  }

  linkAttachmentsToChatMessage(chatSessionId: string, chatMessageId: string, attachmentIds: string[]): void {
    return this.issues.linkAttachmentsToChatMessage(chatSessionId, chatMessageId, attachmentIds);
  }

  listIssueMetadata(issueId: string): MultiremiIssue["metadata"] {
    return this.issues.listIssueMetadata(issueId);
  }

  setIssueMetadataKey(
    issueId: string,
    key: string,
    value: unknown,
    activity?: IssueMutationActivityContext,
  ): MultiremiIssue["metadata"] {
    return this.issues.setIssueMetadataKey(issueId, key, value, activity);
  }

  deleteIssueMetadataKey(
    issueId: string,
    key: string,
    activity?: IssueMutationActivityContext,
  ): MultiremiIssue["metadata"] {
    return this.issues.deleteIssueMetadataKey(issueId, key, activity);
  }

  setIssueAutoTitleMetadata(
    issueId: string,
    value: import("@multiremi/contracts/types.js").MultiremiIssueAutoTitleMetadata,
  ): MultiremiIssue {
    return this.issues.setIssueAutoTitleMetadata(issueId, value);
  }

  getIssueAutoTitleMetadata(
    issueId: string,
  ): import("@multiremi/contracts/types.js").MultiremiIssueAutoTitleMetadata {
    return this.issues.getIssueAutoTitleMetadata(issueId);
  }

  appendIssueActivity(issueId: string, input: {
    actorType: string;
    actorId?: string | null;
    type: string;
    body?: string | null;
    data?: unknown | null;
  }): void {
    this.issues.appendIssueActivity(issueId, input);
  }

  getOrCreateDefaultIssueSession(issueId: string, createdById: string | null = null): MultiremiIssueSession {
    return this.sessions.getOrCreateDefaultIssueSession(issueId, createdById);
  }

  createIssueSession(issueId: string, input: CreateIssueSessionInput = {}): MultiremiIssueSession {
    return this.sessions.createIssueSession(issueId, input);
  }

  createIssueSessionWithinTransaction(issueId: string, input: CreateIssueSessionInput = {}): MultiremiIssueSession {
    return this.sessions.createIssueSessionWithinTransaction(issueId, input);
  }

  getLatestActiveIssueSession(issueId: string): MultiremiIssueSession | null {
    return this.sessions.getLatestActiveIssueSession(issueId);
  }

  getIssueSession(id: string): MultiremiIssueSession | null {
    return this.sessions.getIssueSession(id);
  }

  listIssueSessions(issueId: string, includeArchived = false): MultiremiIssueSession[] {
    return this.sessions.listIssueSessions(issueId, includeArchived);
  }

  updateIssueSession(id: string, input: UpdateIssueSessionInput): MultiremiIssueSession {
    return this.sessions.updateIssueSession(id, input);
  }

  addSessionParticipant(sessionId: string, input: AddSessionParticipantInput): MultiremiSessionParticipant {
    return this.sessions.addSessionParticipant(sessionId, input);
  }

  removeSessionParticipant(sessionId: string, participantType: string, participantId: string): void {
    return this.sessions.removeSessionParticipant(sessionId, participantType, participantId);
  }

  listSessionParticipants(sessionId: string, includeLeft = false): MultiremiSessionParticipant[] {
    return this.sessions.listSessionParticipants(sessionId, includeLeft);
  }

  appendSessionEvent(sessionId: string, input: {
    authorType: string;
    authorId?: string | null;
    kind?: string;
    body?: string;
    taskId?: string | null;
    sourceCommentId?: string | null;
    metadata?: Record<string, unknown>;
    createdAt?: string;
  }): MultiremiSessionEvent {
    return this.sessions.appendSessionEvent(sessionId, input);
  }

  /** Internal primitive for callers that already own a database transaction. */
  appendSessionEventWithinTransaction(sessionId: string, input: {
    authorType: string;
    authorId?: string | null;
    kind?: string;
    body?: string;
    taskId?: string | null;
    sourceCommentId?: string | null;
    metadata?: Record<string, unknown>;
    createdAt?: string;
  }): MultiremiSessionEvent {
    return this.sessions.appendSessionEventWithinTransaction(sessionId, input);
  }

  listSessionEvents(sessionId: string, input: { sinceSeq?: number | null; toSeq?: number | null } = {}): MultiremiSessionEvent[] {
    return this.sessions.listSessionEvents(sessionId, input);
  }

  getOrCreateSessionAgentLane(sessionId: string, agentId: string): MultiremiSessionAgentLane {
    return this.sessions.getOrCreateSessionAgentLane(sessionId, agentId);
  }

  getSessionAgentLane(sessionId: string, agentId: string): MultiremiSessionAgentLane | null {
    return this.sessions.getSessionAgentLane(sessionId, agentId);
  }

  buildTaskSessionProjection(taskId: string): MultiremiSessionProjection | null {
    const task = this.tasks.getTask(taskId);
    if (task?.issueSessionId) return this.sessions.buildTaskSessionProjection(taskId);
    if (task?.chatSessionId) return this.chat.buildTaskSessionProjection(taskId);
    return null;
  }

  createSessionTask(sessionId: string, input: CreateSessionTaskInput): MultiremiTask {
    return this.sessions.createSessionTask(sessionId, input);
  }

  publishSessionResult(sessionId: string, input: PublishSessionResultInput): MultiremiSessionResult {
    return this.sessions.publishSessionResult(sessionId, input);
  }

  getSessionResult(id: string): MultiremiSessionResult | null {
    return this.sessions.getSessionResult(id);
  }

  listIssueSessionResults(issueId: string): MultiremiSessionResult[] {
    return this.sessions.listIssueSessionResults(issueId);
  }

  listTasksForIssue(issueId: string): MultiremiTask[] {
    return this.tasks.listTasksForIssue(issueId);
  }

  isSquadLeaderDelegation(input: {
    issue: MultiremiIssue;
    sourceTask: MultiremiTask | null;
    authorAgentId: string | null;
    targetAgentId: string;
    issueSessionId: string | null;
  }): boolean {
    return this.issues.isSquadLeaderDelegation(input);
  }

  getTaskQueueBlocker(taskId: string): MultiremiTaskQueueBlocker | null {
    return this.tasks.getTaskQueueBlocker(taskId);
  }

  createProject(input: CreateProjectInput, writeContext: ProjectInstructionsWriteContext = {}): MultiremiProject {
    return this.projects.createProject(input, writeContext);
  }

  getProject(id: string): MultiremiProject | null {
    return this.projects.getProject(id);
  }

  listProjects(workspaceId?: string | null): MultiremiProject[] {
    return this.projects.listProjects(workspaceId);
  }

  searchProjects(input: { q: string; workspaceId?: string | null; includeClosed?: boolean; limit?: number; offset?: number }): { projects: MultiremiProjectSearchResult[]; total: number } {
    return this.projects.searchProjects(input);
  }

  updateProject(id: string, input: UpdateProjectInput, writeContext: ProjectInstructionsWriteContext = {}): MultiremiProject {
    return this.projects.updateProject(id, input, writeContext);
  }

  archiveProject(id: string): MultiremiProject {
    return this.projects.archiveProject(id);
  }

  restoreProject(id: string): MultiremiProject {
    return this.projects.restoreProject(id);
  }

  listPinnedItems(workspaceId?: string | null, userId?: string | null): MultiremiPinnedItem[] {
    return this.projects.listPinnedItems(workspaceId, userId);
  }

  createPinnedItem(input: CreatePinnedItemInput): MultiremiPinnedItem {
    return this.projects.createPinnedItem(input);
  }

  getPinnedItem(id: string): MultiremiPinnedItem | null {
    return this.projects.getPinnedItem(id);
  }

  deletePinnedItem(workspaceId: string | null | undefined, userId: string | null | undefined, itemType: string, itemId: string): void {
    return this.projects.deletePinnedItem(workspaceId, userId, itemType, itemId);
  }

  reorderPinnedItems(workspaceId: string | null | undefined, userId: string | null | undefined, items: ReorderPinnedItemInput[]): MultiremiPinnedItem[] {
    return this.projects.reorderPinnedItems(workspaceId, userId, items);
  }

  listProjectResources(projectId: string): MultiremiProjectResource[] {
    return this.projects.listProjectResources(projectId);
  }

  listProjectDevices(projectId: string): MultiremiProjectDevice[] {
    return this.projects.listProjectDevices(projectId);
  }

  createProjectDevice(projectId: string, input: CreateProjectDeviceInput): MultiremiProjectDevice {
    return this.projects.createProjectDevice(projectId, input);
  }

  deleteProjectDevice(projectId: string, daemonId: string): void {
    return this.projects.deleteProjectDevice(projectId, daemonId);
  }

  replaceProjectDevices(projectId: string, input: ReplaceProjectDevicesInput): MultiremiProjectDevice[] {
    return this.projects.replaceProjectDevices(projectId, input);
  }

  listProjectsForDaemon(workspaceId: string, daemonId: string): MultiremiProject[] {
    return this.projects.listProjectsForDaemon(workspaceId, daemonId);
  }

  createProjectResource(projectId: string, input: CreateProjectResourceInput): MultiremiProjectResource {
    return this.projects.createProjectResource(projectId, input);
  }

  getProjectResource(id: string): MultiremiProjectResource | null {
    return this.projects.getProjectResource(id);
  }

  updateProjectResource(projectId: string, resourceId: string, input: UpdateProjectResourceInput): MultiremiProjectResource {
    return this.projects.updateProjectResource(projectId, resourceId, input);
  }

  deleteProjectResource(projectId: string, resourceId: string): void {
    return this.projects.deleteProjectResource(projectId, resourceId);
  }

  listProjectDocs(projectId: string, input: { kind?: string | null } = {}): MultiremiProjectDoc[] {
    return this.projects.listProjectDocs(projectId, input);
  }

  getProjectDoc(id: string): MultiremiProjectDoc | null {
    return this.projects.getProjectDoc(id);
  }

  getProjectDocByRef(projectId: string, ref: string): MultiremiProjectDoc | null {
    return this.projects.getProjectDocByRef(projectId, ref);
  }

  createProjectDoc(projectId: string, input: CreateProjectDocInput): MultiremiProjectDoc {
    return this.projects.createProjectDoc(projectId, input);
  }

  createProjectDocMetadata(
    projectId: string,
    input: CreateProjectDocInput,
    control: ProjectKnowledgeWriteControl,
  ): MultiremiProjectDoc {
    return this.projects.createProjectDocMetadata(projectId, input, control);
  }

  updateProjectDoc(projectId: string, ref: string, input: UpdateProjectDocInput): MultiremiProjectDoc {
    return this.projects.updateProjectDoc(projectId, ref, input);
  }

  replaceProjectDocMetadataExact(
    prepared: MultiremiProjectDoc,
    control: ProjectKnowledgeWriteControl,
  ): MultiremiProjectDoc {
    return this.projects.replaceProjectDocMetadataExact(prepared, control);
  }

  setProjectDocSyncState(
    docId: string,
    input: Partial<ProjectKnowledgeWriteControl> & { storageBackend?: "sql" | "openviking" },
  ): MultiremiProjectDoc {
    return this.projects.setProjectDocSyncState(docId, input);
  }

  setProjectDocRevisionStorage(docId: string, version: number, contentUri: string, contentSha256: string, snapshotOid: string | null): void {
    this.projects.setProjectDocRevisionStorage(docId, version, contentUri, contentSha256, snapshotOid);
  }

  listProjectDocsForMigration(workspaceId: string, statuses: string[] = []): MultiremiProjectDoc[] {
    return this.projects.listProjectDocsForMigration(workspaceId, statuses);
  }

  deleteProjectDoc(projectId: string, ref: string): void {
    return this.projects.deleteProjectDoc(projectId, ref);
  }

  listProjectDocRevisions(docId: string): MultiremiProjectDocRevision[] {
    return this.projects.listProjectDocRevisions(docId);
  }

  searchProjectDocs(projectId: string, query: string, input: { kind?: string | null; limit?: number } = {}): MultiremiProjectDoc[] {
    return this.projects.searchProjectDocs(projectId, query, input);
  }

  listWorkspaceDocs(workspaceId: string, input: { kind?: string | null; q?: string | null; limit?: number } = {}): MultiremiWorkspaceProjectDoc[] {
    return this.projects.listWorkspaceDocs(workspaceId, input);
  }

  ensureProjectDocSchema(projectId: string): MultiremiProjectDoc {
    return this.projects.ensureProjectDocSchema(projectId);
  }

  getProjectDocsIndex(projectId: string): MultiremiProjectDocsIndex {
    return this.projects.getProjectDocsIndex(projectId);
  }

  listRepositoryWikiDocs(workspaceId: string, repositoryId: string): MultiremiRepositoryWikiDoc[] {
    return this.repositoryWiki.list(workspaceId, repositoryId);
  }

  listWorkspaceRepositoryWikiDocs(workspaceId: string): MultiremiRepositoryWikiDoc[] {
    return this.repositoryWiki.listWorkspace(workspaceId);
  }

  getRepositoryWikiDocByRef(workspaceId: string, repositoryId: string, ref: string): MultiremiRepositoryWikiDoc | null {
    return this.repositoryWiki.getByRef(workspaceId, repositoryId, ref);
  }

  createRepositoryWikiDoc(
    workspaceId: string,
    repositoryId: string,
    input: CreateRepositoryWikiDocInput,
    control?: RepositoryWikiWriteControl,
  ): MultiremiRepositoryWikiDoc {
    return this.repositoryWiki.create(workspaceId, repositoryId, input, control);
  }

  updateRepositoryWikiDoc(
    current: MultiremiRepositoryWikiDoc,
    input: UpdateRepositoryWikiDocInput,
    control?: RepositoryWikiWriteControl,
  ): MultiremiRepositoryWikiDoc {
    return this.repositoryWiki.replaceExact(current, input, control);
  }

  deleteRepositoryWikiDoc(workspaceId: string, repositoryId: string, ref: string): MultiremiRepositoryWikiDoc {
    return this.repositoryWiki.delete(workspaceId, repositoryId, ref);
  }

  applyRepositoryWikiBatch(
    operations: readonly RepositoryWikiStoreBatchOperation[],
    storageJob?: RepositoryWikiStorageJobInput,
  ): RepositoryWikiBatchResult[] {
    return this.repositoryWiki.applyBatch(operations, storageJob);
  }

  finalizeRepositoryWikiBatchStorage(
    entries: readonly RepositoryWikiStorageFinalization[],
    storageJobId?: string,
  ): MultiremiRepositoryWikiDoc[] {
    return this.repositoryWiki.finalizeBatchStorage(entries, storageJobId);
  }

  listRepositoryWikiStorageJobs(workspaceId: string, repositoryId: string): RepositoryWikiStorageJob[] {
    return this.repositoryWiki.listStorageJobs(workspaceId, repositoryId);
  }

  listWorkspaceRepositoryWikiStorageJobs(workspaceId: string): RepositoryWikiStorageJob[] {
    return this.repositoryWiki.listWorkspaceStorageJobs(workspaceId);
  }

  recordRepositoryWikiStorageJobFailure(id: string, error: string): void {
    this.repositoryWiki.recordStorageJobFailure(id, error);
  }

  completeRepositoryWikiStorageJob(id: string): void {
    this.repositoryWiki.completeStorageJob(id);
  }

  listRepositoryWikiDocRevisions(docId: string): MultiremiRepositoryWikiDocRevision[] {
    return this.repositoryWiki.revisions(docId);
  }

  createKnowledgeSubmission(input: CreateKnowledgeSubmissionInput): {
    submission: MultiremiKnowledgeSubmission;
    deduplicated: boolean;
  } {
    return this.knowledge.createSubmission(input);
  }

  getKnowledgeSubmission(id: string): MultiremiKnowledgeSubmission | null {
    return this.knowledge.getSubmission(id);
  }

  listKnowledgeSubmissions(input: KnowledgeListInput): MultiremiKnowledgeSubmission[] {
    return this.knowledge.listSubmissions(input);
  }

  listKnowledgeSubmissionsPage(input: KnowledgeListInput): MultiremiKnowledgeCursorPage<MultiremiKnowledgeSubmission> {
    return this.knowledge.listSubmissionsPage(input);
  }

  updateKnowledgeSubmissionStatus(
    id: string,
    status: MultiremiKnowledgeSubmissionStatus,
  ): MultiremiKnowledgeSubmission {
    return this.knowledge.updateSubmissionStatus(id, status);
  }

  createKnowledgeCompilationRun(input: CreateKnowledgeCompilationRunInput): {
    run: MultiremiKnowledgeCompilationRun;
    deduplicated: boolean;
  } {
    return this.knowledge.createRun(input);
  }

  getKnowledgeCompilationRun(id: string): MultiremiKnowledgeCompilationRun | null {
    return this.knowledge.getRun(id);
  }

  listKnowledgeCompilationRuns(input: KnowledgeRunListInput): MultiremiKnowledgeCompilationRun[] {
    return this.knowledge.listRuns(input);
  }

  listKnowledgeCompilationRunsPage(input: KnowledgeRunListInput): MultiremiKnowledgeCursorPage<MultiremiKnowledgeCompilationRun> {
    return this.knowledge.listRunsPage(input);
  }

  completeKnowledgeCompilationRun(
    id: string,
    status: MultiremiKnowledgeCompilationStatus,
    resultSummary?: string | null,
  ): MultiremiKnowledgeCompilationRun {
    return this.knowledge.completeRun(id, status, resultSummary);
  }

  addKnowledgeRunSubmissionSource(
    runId: string,
    submissionId: string,
  ): MultiremiKnowledgeCompilationRunSource {
    return this.knowledge.addRunSubmissionSource(runId, submissionId);
  }

  addKnowledgeRunScmSource(
    runId: string,
    sourceRef: string,
    metadata: Record<string, unknown>,
  ): MultiremiKnowledgeCompilationRunSource {
    return this.knowledge.addRunScmSource(runId, sourceRef, metadata);
  }

  listKnowledgeRunSources(runId: string): MultiremiKnowledgeCompilationRunSource[] {
    return this.knowledge.listRunSources(runId);
  }

  recordKnowledgeCompilationOutput(input: RecordKnowledgeOutputInput): MultiremiKnowledgeCompilationOutput {
    return this.knowledge.recordOutput(input);
  }

  linkKnowledgeFormalVersion(input: Omit<RecordKnowledgeOutputInput, "revisionId">): MultiremiKnowledgeCompilationOutput {
    return this.knowledge.linkFormalVersion(input);
  }

  listKnowledgeRunOutputs(runId: string): MultiremiKnowledgeCompilationOutput[] {
    return this.knowledge.listRunOutputs(runId);
  }

  createIssueCompletionKnowledgeBundle(issue: MultiremiIssue): {
    submission: MultiremiKnowledgeSubmission;
    deduplicated: boolean;
  } | null {
    return this.knowledge.createIssueCompletionBundle(issue);
  }

  recordRepositoryMergeKnowledgeEvent(input: RepositoryMergeKnowledgeEventInput) {
    return this.knowledge.recordRepositoryMergeEvent(input);
  }

  createSquad(input: CreateSquadInput): MultiremiSquad {
    return this.squads.createSquad(input);
  }

  getSquad(id: string): MultiremiSquad | null {
    return this.squads.getSquad(id);
  }

  getSquadByRef(ref: string, workspaceId?: string | null): MultiremiSquad | null {
    return this.squads.getSquadByRef(ref, workspaceId);
  }

  listSquads(workspaceId?: string | null): MultiremiSquad[] {
    return this.squads.listSquads(workspaceId);
  }

  resolveAssigneeRef(
    assigneeType: MultiremiAssigneeType | null | undefined,
    assigneeId: string | null | undefined,
    workspaceId?: string | null,
  ): { assigneeType: MultiremiAssigneeType; assigneeId: string } | null {
    return this.squads.resolveAssigneeRef(assigneeType, assigneeId, workspaceId);
  }

  updateSquad(id: string, input: UpdateSquadInput): MultiremiSquad {
    return this.squads.updateSquad(id, input);
  }

  archiveSquad(id: string): MultiremiSquad {
    return this.squads.archiveSquad(id);
  }

  addSquadMember(squadId: string, input: AddSquadMemberInput): MultiremiSquadMember {
    return this.squads.addSquadMember(squadId, input);
  }

  removeSquadMember(squadId: string, input: RemoveSquadMemberInput): void {
    return this.squads.removeSquadMember(squadId, input);
  }

  getSquadMember(id: string): MultiremiSquadMember | null {
    return this.squads.getSquadMember(id);
  }

  listSquadMembers(squadId: string): MultiremiSquadMember[] {
    return this.squads.listSquadMembers(squadId);
  }


  createAutopilot(input: CreateAutopilotInput): MultiremiAutopilot {
    return this.autopilots.createAutopilot(input);
  }

  getAutopilot(id: string): MultiremiAutopilot | null {
    return this.autopilots.getAutopilot(id);
  }

  listAutopilots(workspaceId?: string | null): MultiremiAutopilot[] {
    return this.autopilots.listAutopilots(workspaceId);
  }

  updateAutopilot(id: string, input: UpdateAutopilotInput): MultiremiAutopilot {
    return this.autopilots.updateAutopilot(id, input);
  }

  archiveAutopilot(id: string): MultiremiAutopilot {
    return this.autopilots.archiveAutopilot(id);
  }

  listAutopilotTriggers(autopilotId: string): MultiremiAutopilotTrigger[] {
    return this.autopilots.listAutopilotTriggers(autopilotId);
  }

  getAutopilotTrigger(id: string): MultiremiAutopilotTrigger | null {
    return this.autopilots.getAutopilotTrigger(id);
  }

  getAutopilotTriggerSigningSecret(id: string): string | null {
    return this.autopilots.getAutopilotTriggerSigningSecret(id);
  }

  getAutopilotTriggerByWebhookToken(token: string): MultiremiAutopilotTrigger | null {
    return this.autopilots.getAutopilotTriggerByWebhookToken(token);
  }

  createAutopilotTrigger(autopilotId: string, input: CreateAutopilotTriggerInput = {}): MultiremiAutopilotTrigger {
    return this.autopilots.createAutopilotTrigger(autopilotId, input);
  }

  updateAutopilotTrigger(autopilotId: string, triggerId: string, input: UpdateAutopilotTriggerInput): MultiremiAutopilotTrigger {
    return this.autopilots.updateAutopilotTrigger(autopilotId, triggerId, input);
  }

  deleteAutopilotTrigger(autopilotId: string, triggerId: string): boolean {
    return this.autopilots.deleteAutopilotTrigger(autopilotId, triggerId);
  }

  rotateAutopilotTriggerWebhookToken(autopilotId: string, triggerId: string): MultiremiAutopilotTrigger {
    return this.autopilots.rotateAutopilotTriggerWebhookToken(autopilotId, triggerId);
  }

  setAutopilotTriggerSigningSecret(autopilotId: string, triggerId: string, secret: string | null | undefined): MultiremiAutopilotTrigger {
    return this.autopilots.setAutopilotTriggerSigningSecret(autopilotId, triggerId, secret);
  }

  claimDueScheduleTriggers(now: Date = new Date()): MultiremiAutopilotTrigger[] {
    return this.autopilots.claimDueScheduleTriggers(now);
  }

  advanceScheduleTriggerNextRun(triggerId: string, from: Date = new Date()): MultiremiAutopilotTrigger | null {
    return this.autopilots.advanceScheduleTriggerNextRun(triggerId, from);
  }

  recoverLostScheduleTriggers(now: Date = new Date()): number {
    return this.autopilots.recoverLostScheduleTriggers(now);
  }

  claimDueRuntimeProvisions(now: Date = new Date()): MultiremiWorkspaceRuntimeProvision[] {
    return this.runtimeProvisions.claimDue(now);
  }

  advanceRuntimeProvisionNextRun(id: string, from: Date = new Date()): MultiremiWorkspaceRuntimeProvision | null {
    return this.runtimeProvisions.advanceNextRun(id, from);
  }

  recoverLostRuntimeProvisionSchedules(now: Date = new Date()): number {
    return this.runtimeProvisions.recoverLostSchedules(now);
  }

  enqueueIssueStatusChangedEvent(input: {
    issue: MultiremiIssue;
    previousStatus: string;
    actorType?: string | null;
    actorId?: string | null;
    automationSourceEventId?: string | null;
    automationSourceTaskId?: string | null;
  }): MultiremiSystemEvent | null {
    return this.autopilots.enqueueIssueStatusChangedEvent(input);
  }

  getSystemEvent(id: string): MultiremiSystemEvent | null {
    return this.autopilots.getSystemEvent(id);
  }

  claimPendingSystemEvents(now: Date = new Date(), limit = 25): MultiremiSystemEvent[] {
    return this.autopilots.claimPendingSystemEvents(now, limit);
  }

  dispatchPendingSystemEvents(now: Date = new Date(), limit = 25): MultiremiAutopilotRun[] {
    return this.autopilots.dispatchPendingSystemEvents(now, limit);
  }

  listAutopilotRuns(autopilotId: string): MultiremiAutopilotRunRecord[] {
    return this.autopilots.listAutopilotRuns(autopilotId);
  }

  listLatestRepositoryAutopilotRuns(workspaceId: string): MultiremiAutopilotRunRecord[] {
    return this.autopilots.listLatestRepositoryAutopilotRuns(workspaceId);
  }

  isRepositoryWikiRunPublished(runId: string): boolean {
    return this.autopilots.isRepositoryWikiRunPublished(runId);
  }

  selectAutopilotsExceedingFailureThreshold(
    options: MultiremiAutopilotFailureThresholdOptions = {},
  ): MultiremiAutopilotFailureThresholdCandidate[] {
    return this.autopilots.selectAutopilotsExceedingFailureThreshold(options);
  }

  systemPauseAutopilot(id: string): MultiremiAutopilot | null {
    return this.autopilots.systemPauseAutopilot(id);
  }

  pauseAutopilotsExceedingFailureThreshold(
    options: MultiremiAutopilotFailureThresholdOptions = {},
  ): MultiremiAutopilotFailureThresholdCandidate[] {
    return this.autopilots.pauseAutopilotsExceedingFailureThreshold(options);
  }

  runAutopilot(autopilotId: string, input: RunAutopilotStoreInput = {}): MultiremiAutopilotRunRecord {
    return this.autopilots.runAutopilot(autopilotId, input);
  }

  getAutopilotRun(id: string): MultiremiAutopilotRunRecord | null {
    return this.autopilots.getAutopilotRun(id);
  }

  listWebhookDeliveries(autopilotId: string, options: { includeRawBody?: boolean; limit?: number } = {}): MultiremiWebhookDelivery[] {
    return this.autopilots.listWebhookDeliveries(autopilotId, options);
  }

  getWebhookDelivery(id: string): MultiremiWebhookDelivery | null {
    return this.autopilots.getWebhookDelivery(id);
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
    return this.autopilots.handleAutopilotWebhook(autopilotId, input);
  }

  replayWebhookDelivery(
    autopilotId: string,
    deliveryId: string,
    options: { sourceTaskId?: string | null } = {},
  ): MultiremiWebhookDeliveryResult {
    return this.autopilots.replayWebhookDelivery(autopilotId, deliveryId, options);
  }

  handleAutopilotWebhookByToken(token: string, input: {
    payload?: unknown | null;
    rawBody?: string | null;
    headers?: Record<string, string | null | undefined>;
    prompt?: string | null;
    provider?: MultiremiWebhookProvider | string | null;
    signatureStatus?: MultiremiWebhookSignatureStatus | string | null;
  } = {}): MultiremiWebhookDeliveryResult | null {
    return this.autopilots.handleAutopilotWebhookByToken(token, input);
  }

  createChatSession(input: CreateChatSessionInput): MultiremiChatSession {
    return this.chat.createChatSession(input);
  }

  listChatSessions(workspaceId?: string | null, options: { creatorId?: string | null; includeArchived?: boolean } = {}): MultiremiChatSession[] {
    return this.chat.listChatSessions(workspaceId, options);
  }

  getChatSession(id: string): MultiremiChatSession | null {
    return this.chat.getChatSession(id);
  }

  bindChatSessionIssueIfUnbound(chatSessionId: string, issueId: string): {
    session: MultiremiChatSession;
    bound: boolean;
  } {
    return this.chat.bindChatSessionIssueIfUnbound(chatSessionId, issueId);
  }

  updateChatSession(id: string, input: UpdateChatSessionInput): MultiremiChatSession {
    return this.chat.updateChatSession(id, input);
  }

  deleteChatSession(id: string): boolean {
    return this.chat.deleteChatSession(id);
  }

  markChatSessionRead(id: string): void {
    return this.chat.markChatSessionRead(id);
  }

  getPendingChatTask(chatSessionId: string): MultiremiTask | null {
    return this.chat.getPendingChatTask(chatSessionId);
  }

  listPendingChatTasks(workspaceId?: string | null, options: { creatorId?: string | null } = {}): MultiremiTask[] {
    return this.chat.listPendingChatTasks(workspaceId, options);
  }

  listChatMessages(chatSessionId: string): MultiremiChatMessage[] {
    return this.chat.listChatMessages(chatSessionId);
  }

  sendChatMessage(chatSessionId: string, input: SendChatMessageInput): SendChatMessageResult {
    return this.chat.sendChatMessage(chatSessionId, input);
  }

  createPendingAgentIssueUpdateWithinTransaction(chatSessionId: string, body: string): {
    session: MultiremiChatSession;
    message: MultiremiChatMessage;
  } {
    return this.chat.createPendingAgentIssueUpdateWithinTransaction(chatSessionId, body);
  }

  preparePendingAgentIssueUpdatesForTask(chatSessionId: string, taskId: string): {
    messages: MultiremiChatMessage[];
    omittedCount: number;
  } {
    return this.chat.preparePendingAgentIssueUpdatesForTask(chatSessionId, taskId);
  }

  preparePendingAgentIssueUpdatesForTaskWithinTransaction(chatSessionId: string, taskId: string): {
    messages: MultiremiChatMessage[];
    omittedCount: number;
  } {
    return this.chat.preparePendingAgentIssueUpdatesForTaskWithinTransaction(chatSessionId, taskId);
  }

  completePendingAgentIssueUpdatesForTaskWithinTransaction(chatSessionId: string, taskId: string): number {
    return this.chat.completePendingAgentIssueUpdatesForTaskWithinTransaction(chatSessionId, taskId);
  }

  discardPendingAgentIssueUpdatesWithinTransaction(chatSessionId: string): number {
    return this.chat.discardPendingAgentIssueUpdatesWithinTransaction(chatSessionId);
  }

  getChatMessage(id: string): MultiremiChatMessage | null {
    return this.chat.getChatMessage(id);
  }

  createTask(input: CreateTaskInput): MultiremiTask {
    return this.tasks.createTask(input);
  }

  createTaskWithinTransaction(input: CreateTaskInput): MultiremiTask {
    return this.tasks.createTaskWithinTransaction(input);
  }

  ensureDelegationWakeup(input: {
    sourceTaskId: string;
    requiredEventSeq: number;
    triggerCommentId?: string | null;
    terminalStatus?: "completed" | "failed" | "cancelled" | null;
    terminalBody?: string | null;
  }): { task: MultiremiTask | null; created: boolean; covered: boolean } {
    return this.tasks.ensureDelegationWakeup(input);
  }

  resetSessionAgentLane(sessionId: string, agentId: string): MultiremiSessionAgentLane | null {
    return this.tasks.resetSessionAgentLane(sessionId, agentId);
  }

  /**
   * May this runtime execute this agent? A claim hands the runtime the agent's
   * custom_env / mcp_config, so a private runtime is restricted to its owner's
   * agents. Mirrors the claim SQL's ownership predicate (COALESCE(...,'local')
   * so single-machine NULL owners still pair). The provider must also match.
   */
  runtimeCanRunAgent(runtime: MultiremiRuntime, agent: MultiremiAgent): boolean {
    return this.runtimes.runtimeCanRunAgent(runtime, agent);
  }

  getRuntimeByDaemonAndProvider(daemonId: string, provider: string): MultiremiRuntime | null {
    return this.runtimes.getRuntimeByDaemonAndProvider(daemonId, provider);
  }

  getTask(id: string): MultiremiTask | null {
    return this.tasks.getTask(id);
  }

  getTaskByRef(ref: string, input: { issueId?: string | null } = {}): MultiremiTask | null {
    return this.tasks.getTaskByRef(ref, input);
  }

  getTaskWithAgent(id: string): MultiremiTaskWithAgent | null {
    return this.tasks.getTaskWithAgent(id);
  }

  getTaskTriggerMetadata(task: MultiremiTask): MultiremiTaskTriggerMetadata | null {
    return this.tasks.getTaskTriggerMetadata(task);
  }

  listTasks(status?: MultiremiTaskStatus): MultiremiTask[] {
    return this.tasks.listTasks(status);
  }

  listAgentTasks(agentId: string): MultiremiTask[] {
    return this.tasks.listAgentTasks(agentId);
  }

  listWorkspaceAgentTaskSnapshot(workspaceId = "local"): MultiremiTask[] {
    return this.tasks.listWorkspaceAgentTaskSnapshot(workspaceId);
  }

  listWorkspaceAgentRunCounts(workspaceId = "local", days = 30): MultiremiAgentRunCount[] {
    return this.tasks.listWorkspaceAgentRunCounts(workspaceId, days);
  }

  listWorkspaceAgentActivity30d(workspaceId = "local"): MultiremiAgentActivityBucket[] {
    return this.tasks.listWorkspaceAgentActivity30d(workspaceId);
  }

  claimTask(runtimeId: string): MultiremiTaskWithAgent | null {
    return this.tasks.claimTask(runtimeId);
  }

  startTask(taskId: string): MultiremiTask {
    return this.tasks.startTask(taskId);
  }

  renewTaskDispatchLease(taskId: string): MultiremiTask {
    return this.tasks.renewTaskDispatchLease(taskId);
  }

  markTaskWaitingLocalDirectory(taskId: string, reason?: string | null): MultiremiTask {
    return this.tasks.markTaskWaitingLocalDirectory(taskId, reason);
  }

  createTaskHumanRequest(input: CreateTaskHumanRequestInput): MultiremiTaskHumanRequest {
    return this.tasks.createTaskHumanRequest(input);
  }

  getTaskHumanRequest(requestId: string): MultiremiTaskHumanRequest | null {
    return this.tasks.getTaskHumanRequest(requestId);
  }

  listTaskHumanRequests(taskId: string): MultiremiTaskHumanRequest[] {
    return this.tasks.listTaskHumanRequests(taskId);
  }

  respondTaskHumanRequest(
    requestId: string,
    input: { response: Record<string, unknown>; respondedBy?: string | null },
  ): MultiremiTaskHumanRequest | null {
    return this.tasks.respondTaskHumanRequest(requestId, input);
  }

  expireTaskHumanRequest(requestId: string, status: "timeout" | "cancelled"): MultiremiTaskHumanRequest | null {
    return this.tasks.expireTaskHumanRequest(requestId, status);
  }

  createTaskSteerMessage(input: CreateTaskSteerMessageInput): MultiremiTaskSteerMessage {
    return this.tasks.createTaskSteerMessage(input);
  }

  getTaskSteerMessage(steerId: string): MultiremiTaskSteerMessage | null {
    return this.tasks.getTaskSteerMessage(steerId);
  }

  listTaskSteerMessages(taskId: string): MultiremiTaskSteerMessage[] {
    return this.tasks.listTaskSteerMessages(taskId);
  }

  listPendingTaskSteerMessages(taskId: string): MultiremiTaskSteerMessage[] {
    return this.tasks.listPendingTaskSteerMessages(taskId);
  }

  consumeTaskSteerMessages(taskId: string, steerIds: string[]): MultiremiTaskSteerMessage[] {
    return this.tasks.consumeTaskSteerMessages(taskId, steerIds);
  }

  listOrganizerActionsForTask(taskId: string): MultiremiOrganizerAction[] {
    return this.tasks.listOrganizerActionsForTask(taskId);
  }

  performOrganizerAction(input: {
    supervisorTaskId: string;
    supervisorAgentId: string;
    targetTaskId: string;
    action: MultiremiOrganizerActionKind;
    reason: string;
    content?: string | null;
  }): {
    task: MultiremiTask;
    replacementTask: MultiremiTask | null;
    message: MultiremiTaskSteerMessage | null;
    audit: MultiremiOrganizerAction;
    comment: MultiremiIssueComment;
  } {
    let redispatchResult: ReturnType<TasksRepo["redispatchTaskWithinTransaction"]> | null = null;
    const result = this.db.transaction(() => {
      const supervisorTask = this.getTask(input.supervisorTaskId);
      const supervisorAgent = this.getAgent(input.supervisorAgentId);
      if (
        !supervisorTask
        || !supervisorAgent
        || !agentRoleAtLeast(supervisorAgent.role, "supervisor")
        || supervisorTask.agentId !== supervisorAgent.id
        || supervisorTask.workspaceId !== supervisorAgent.workspaceId
      ) {
        throw new OrganizerActionError("organizer_supervisor_required", "a current supervisor task is required");
      }
      const target = this.getTask(input.targetTaskId);
      if (!target || target.workspaceId !== supervisorTask.workspaceId) {
        throw new OrganizerActionError("organizer_target_forbidden", "target task is outside the supervisor workspace");
      }
      if (target.id === supervisorTask.id) {
        throw new OrganizerActionError("organizer_self_action_forbidden", "a supervisor cannot act on its own task");
      }
      const targetAgent = this.getAgent(target.agentId);
      if (targetAgent && agentRoleAtLeast(targetAgent.role, "supervisor")) {
        throw new OrganizerActionError("organizer_supervisor_target_forbidden", "a supervisor cannot act on another supervisor task");
      }
      const workspace = this.getWorkspace(supervisorTask.workspaceId);
      if (readOrganizerMode(workspace) !== "act") {
        throw new OrganizerActionError(
          "organizer_report_only",
          "cross-task actions are disabled while organizer.mode is report_only",
        );
      }
      const reportIssue = supervisorTask.issueId ? this.getIssue(supervisorTask.issueId) : null;
      if (!reportIssue || reportIssue.workspaceId !== supervisorTask.workspaceId) {
        throw new OrganizerActionError(
          "organizer_report_issue_required",
          "the supervisor task must belong to a patrol issue so the action can be disclosed",
          409,
        );
      }
      const reason = input.reason.trim();
      if (!reason) throw new OrganizerActionError("organizer_reason_required", "reason is required", 400);
      if (reason.length > 2_000) throw new OrganizerActionError("organizer_reason_too_long", "reason must be at most 2000 characters", 400);

      let task = target;
      let replacementTask: MultiremiTask | null = null;
      let message: MultiremiTaskSteerMessage | null = null;
      if (input.action === "cancel") {
        task = this.tasks.cancelTask(target.id);
      } else if (input.action === "redispatch") {
        redispatchResult = this.tasks.redispatchTaskWithinTransaction(target.id);
        task = redispatchResult.cancelled;
        replacementTask = redispatchResult.replacement;
      } else {
        const content = String(input.content ?? "").trim();
        if (!content) throw new OrganizerActionError("organizer_content_required", "steer content is required", 400);
        message = this.tasks.createTaskSteerMessage({
          taskId: target.id,
          kind: input.action,
          content,
          authorType: "agent",
          authorId: supervisorAgent.id,
        });
      }
      const audit = this.tasks.recordOrganizerAction({
        workspaceId: target.workspaceId,
        supervisorTaskId: supervisorTask.id,
        supervisorAgentId: supervisorAgent.id,
        targetTaskId: target.id,
        targetIssueId: target.issueId,
        replacementTaskId: replacementTask?.id ?? null,
        reportIssueId: reportIssue.id,
        action: input.action,
        reason,
      });
      const comment = this.issues.createIssueComment(reportIssue.id, {
        authorType: "agent",
        authorId: supervisorAgent.id,
        taskId: supervisorTask.id,
        body: [
          `Organizer action: ${input.action}`,
          `Target task: ${target.id}`,
          ...(target.issueId ? [`Target issue: ${target.issueId}`] : []),
          ...(replacementTask ? [`Replacement task: ${replacementTask.id}`] : []),
          `Criterion: ${reason}`,
          `Audit record: ${audit.id}`,
        ].join("\n"),
      }, { deferAgentMentionDispatch: true });
      this.issues.notifyOrganizerAction(reportIssue, comment.body, "agent", supervisorAgent.id, {
        organizer_action_id: audit.id,
        action: input.action,
        target_task_id: target.id,
        target_issue_id: target.issueId,
        replacement_task_id: replacementTask?.id ?? null,
        comment_id: comment.id,
      });
      return { task, replacementTask, message, audit, comment };
    })();
    if (redispatchResult) this.tasks.notifyRedispatchedTask(redispatchResult);
    this.issues.dispatchDeferredAgentCommentMentions(result.comment.id);
    return result;
  }

  reportProgress(taskId: string, summary: string, step?: number | null, total?: number | null, options?: { allowTerminal?: boolean }): MultiremiTask {
    return this.tasks.reportProgress(taskId, summary, step, total, options);
  }

  pinTaskSession(taskId: string, sessionId?: string | null, workDir?: string | null): MultiremiTask {
    return this.tasks.pinTaskSession(taskId, sessionId, workDir);
  }

  appendTaskMessages(taskId: string, messages: TaskMessageInput[]): MultiremiTaskMessage[] {
    return this.tasks.appendTaskMessages(taskId, messages);
  }

  listTaskMessages(taskId: string, sinceSeq?: number | null): MultiremiTaskMessage[] {
    return this.tasks.listTaskMessages(taskId, sinceSeq);
  }

  recordTaskPrompt(taskId: string, input: RecordTaskPromptInput): MultiremiTaskPromptArtifact {
    return this.tasks.recordTaskPrompt(taskId, input);
  }

  getTaskPrompt(taskId: string): MultiremiTaskPromptArtifact | null {
    return this.tasks.getTaskPrompt(taskId);
  }

  completeTask(taskId: string, input: {
    output: string;
    branchName?: string | null;
    sessionId?: string | null;
    workDir?: string | null;
  }): MultiremiTask {
    return this.tasks.completeTask(taskId, input);
  }

  failTask(taskId: string, input: {
    error: string;
    sessionId?: string | null;
    workDir?: string | null;
    failureReason?: string | null;
    failure_reason?: string | null;
  }): MultiremiTask {
    return this.tasks.failTask(taskId, input);
  }

  cancelTask(taskId: string): MultiremiTask {
    return this.tasks.cancelTask(taskId);
  }

  cancelTasksByTriggerComments(workspaceId: string, commentIds: string[]): number {
    return this.tasks.cancelTasksByTriggerComments(workspaceId, commentIds);
  }

  getTaskStatus(taskId: string): MultiremiTaskStatus {
    return this.tasks.getTaskStatus(taskId);
  }

  reportTaskUsage(taskId: string, usage: TaskUsageEntry[]): MultiremiTask {
    return this.tasks.reportTaskUsage(taskId, usage);
  }

  recoverOrphans(runtimeId: string): { orphaned: number; retried: number } {
    return this.tasks.recoverOrphans(runtimeId);
  }
}
