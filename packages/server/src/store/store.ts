import { type SqlDatabase, openMultiremiDatabase } from "@multiremi/store/db/postgres.js";
import { runMigrations } from "@multiremi/store/migrations.js";
import { daemonRuntimeId, isTerminalStatus } from "@multiremi/store/helpers.js";
import { FeedbackRepo } from "@multiremi/store/repos/feedback-repo.js";
import { AccessTokensRepo } from "@multiremi/store/repos/access-tokens-repo.js";
import { CloudRuntimeNodesRepo } from "@multiremi/store/repos/cloud-runtime-nodes-repo.js";
import { AgentsSkillsRepo } from "@multiremi/store/repos/agents-skills-repo.js";
import { AgentPluginsRepo } from "@multiremi/store/repos/agent-plugins-repo.js";
import { GitHubRepo } from "@multiremi/store/repos/github-repo.js";
import { UsageRepo } from "@multiremi/store/repos/usage-repo.js";
import { SquadsRepo } from "@multiremi/store/repos/squads-repo.js";
import { ProjectsRepo } from "@multiremi/store/repos/projects-repo.js";
import { IssueSessionsRepo } from "@multiremi/store/repos/issue-sessions-repo.js";
import { ChatRepo } from "@multiremi/store/repos/chat-repo.js";
import { IssuesRepo } from "@multiremi/store/repos/issues-repo.js";
import { IssueWorkspacesRepo } from "@multiremi/store/repos/issue-workspaces-repo.js";
import { RuntimesRepo } from "@multiremi/store/repos/runtimes-repo.js";
import { TasksRepo } from "@multiremi/store/repos/tasks-repo.js";
import {
  AutopilotsRepo,
  type MultiremiAutopilotFailureThresholdCandidate,
  type MultiremiAutopilotFailureThresholdOptions,
} from "@multiremi/store/repos/autopilots-repo.js";
// The autopilot failure-monitor option/candidate shapes used to be declared here; keep the public surface unchanged.
export type {
  MultiremiAutopilotFailureThresholdCandidate,
  MultiremiAutopilotFailureThresholdOptions,
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
  AddSessionParticipantInput,
  AddSquadMemberInput,
  AssignIssueInput,
  AssignIssueResult,
  CreateAccessTokenInput,
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
  BatchDeleteIssuesInput,
  BatchUpdateIssuesInput,
  CreateLabelInput,
  CreatePinnedItemInput,
  CreateProjectDocInput,
  CreateProjectInput,
  CreateProjectResourceInput,
  CreateRuntimeUpdateInput,
  CreateRuntimeLocalSkillImportInput,
  CreateSessionTaskInput,
  CreateSkillInput,
  ImportAgentPluginInput,
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
  MultiremiInboxItem,
  MultiremiIssueActivity,
  MultiremiIssueChildProgress,
  MultiremiIssueComment,
  ListIssueCommentsInput,
  ListIssueCommentsResult,
  MultiremiIssueDependency,
  MultiremiIssue,
  MultiremiIssueSession,
  MultiremiIssueAssigneeGroup,
  MultiremiIssueSearchResult,
  MultiremiFeedback,
  MultiremiGitHubPullRequest,
  MultiremiGitHubPullRequestState,
  MultiremiGitHubSettings,
  MultiremiLabel,
  MultiremiNotificationPreferences,
  MultiremiNotificationPreferenceResponse,
  MultiremiPinnedItem,
  MultiremiIssueReaction,
  MultiremiIssueSubscriber,
  MultiremiIssueWithTasks,
  MultiremiIssueWorkspace,
  ListIssuesInput,
  MultiremiMetricCounter,
  MultiremiProject,
  MultiremiProjectDoc,
  MultiremiProjectDocRevision,
  MultiremiProjectDocsIndex,
  MultiremiProjectResource,
  MultiremiProjectSearchResult,
  MultiremiRuntimeDirectoryScanRequest,
  MultiremiRuntimeLocalSkillImportRequest,
  MultiremiRuntimeLocalSkillListRequest,
  MultiremiRuntimeModelListRequest,
  MultiremiRuntimeUpdateRequest,
  MultiremiWorkspaceProjectDoc,
  PublishSessionResultInput,
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
  MultiremiRuntimeUsage,
  MultiremiSkill,
  MultiremiSkillFile,
  MultiremiSessionAgentLane,
  MultiremiSessionEvent,
  MultiremiSessionParticipant,
  MultiremiSessionProjection,
  MultiremiSessionResult,
  MultiremiSquad,
  MultiremiSquadMember,
  MultiremiTask,
  MultiremiTaskActivityByHour,
  MultiremiTaskHumanRequest,
  MultiremiTaskMessage,
  MultiremiTaskStatus,
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
  RegisterRuntimeInput,
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
  UpdateProjectInput,
  UpdateProjectResourceInput,
  UpdateRuntimeInput,
  UpdateSkillInput,
  UpdateSquadInput,
  UpdateWorkspaceMemberInput,
} from "@multiremi/contracts/types.js";

// daemonRuntimeId / isTerminalStatus used to live here; api.ts and index.ts import them from this module.
export { daemonRuntimeId, isTerminalStatus };

export class MultiremiStore {
  private db: SqlDatabase;
  private ctx: StoreContext;
  private feedback: FeedbackRepo;
  private accessTokens: AccessTokensRepo;
  private cloudNodes: CloudRuntimeNodesRepo;
  private agents: AgentsSkillsRepo;
  private agentPlugins: AgentPluginsRepo;
  private workspaces: WorkspacesRepo;
  private github: GitHubRepo;
  private usage: UsageRepo;
  private squads: SquadsRepo;
  private analytics: AnalyticsRepo;
  private projects: ProjectsRepo;
  private sessions: IssueSessionsRepo;
  private chat: ChatRepo;
  private issues: IssuesRepo;
  private issueWorkspaces: IssueWorkspacesRepo;
  private runtimes: RuntimesRepo;
  private autopilots: AutopilotsRepo;
  private tasks: TasksRepo;

  constructor(db?: SqlDatabase) {
    this.db = db ?? openMultiremiDatabase();
    this.ctx = new StoreContext(this.db, () => this);
    this.feedback = new FeedbackRepo(this.db);
    this.accessTokens = new AccessTokensRepo(this.db);
    this.cloudNodes = new CloudRuntimeNodesRepo(this.db);
    this.agents = new AgentsSkillsRepo(this.ctx);
    this.agentPlugins = new AgentPluginsRepo(this.ctx);
    this.workspaces = new WorkspacesRepo(this.ctx);
    this.github = new GitHubRepo(this.ctx);
    this.usage = new UsageRepo(this.ctx);
    this.squads = new SquadsRepo(this.ctx);
    this.analytics = new AnalyticsRepo(this.ctx);
    // The analytics recorders are not part of the public facade, so domains reach them through the
    // context rather than through `resolveHost`.
    this.ctx.registerAnalytics(this.analytics);
    this.projects = new ProjectsRepo(this.ctx);
    this.sessions = new IssueSessionsRepo(this.ctx);
    this.chat = new ChatRepo(this.ctx);
    this.issues = new IssuesRepo(this.ctx);
    this.issueWorkspaces = new IssueWorkspacesRepo(this.ctx);
    this.runtimes = new RuntimesRepo(this.ctx);
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

  createAgent(input: CreateAgentInput): MultiremiAgent {
    return this.agents.createAgent(input);
  }

  updateAgent(id: string, input: UpdateAgentInput): MultiremiAgent {
    return this.agents.updateAgent(id, input);
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
    options: { workspaceId?: string | null; ownerId?: string | null } = {},
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

  listAgents(): MultiremiAgent[] {
    return this.agents.listAgents();
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

  getUserByEmail(email: string | null | undefined): MultiremiUser | null {
    return this.workspaces.getUserByEmail(email);
  }

  getOrCreateUser(identity: { externalId?: string | null; email?: string | null; name?: string | null }): MultiremiUser {
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

  deleteWorkspace(id: string): boolean {
    return this.workspaces.deleteWorkspace(id);
  }

  leaveWorkspace(id: string, memberId = `mem_${id}_local`): boolean {
    return this.workspaces.leaveWorkspace(id, memberId);
  }

  ensureLocalWorkspace(): MultiremiWorkspace {
    return this.workspaces.ensureLocalWorkspace();
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
    return this.github.getGitHubSettings(workspaceId);
  }

  updateGitHubSettings(input: {
    workspaceId?: string | null;
    enabled?: boolean;
    prSidebar?: boolean;
    coAuthor?: boolean;
    autoLinkPRs?: boolean;
  }): MultiremiGitHubSettings {
    return this.github.updateGitHubSettings(input);
  }

  listGitHubPullRequests(input: { workspaceId?: string | null; issueId?: string | null } = {}): MultiremiGitHubPullRequest[] {
    return this.github.listGitHubPullRequests(input);
  }

  listGitHubPullRequestsForIssue(issueId: string): MultiremiGitHubPullRequest[] | null {
    return this.github.listGitHubPullRequestsForIssue(issueId);
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
    return this.github.upsertGitHubPullRequest(input);
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

  bindDaemonAccessToken(id: string, daemonId: string): MultiremiAccessToken | null {
    return this.accessTokens.bindDaemonAccessToken(id, daemonId);
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
    return this.runtimes.registerRuntime(input);
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

  deleteRuntimeWithArchivedAgentCleanup(id: string): boolean {
    return this.runtimes.deleteRuntimeWithArchivedAgentCleanup(id);
  }

  archiveAgentsAndDeleteRuntime(
    id: string,
    expectedActiveAgentIds: string[],
  ): { status: "ok"; agentsArchived: number; tasksCancelled: number } | { status: "plan_changed"; activeAgents: MultiremiAgent[] } {
    return this.runtimes.archiveAgentsAndDeleteRuntime(id, expectedActiveAgentIds);
  }

  mergeRuntimeInto(oldRuntimeId: string, newRuntimeId: string): { agentsReassigned: number; tasksReassigned: number; deleted: boolean } {
    return this.runtimes.mergeRuntimeInto(oldRuntimeId, newRuntimeId);
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

  getRuntimeUpdateRequest(runtimeId: string, requestId: string): MultiremiRuntimeUpdateRequest | null {
    return this.runtimes.getRuntimeUpdateRequest(runtimeId, requestId);
  }

  claimRuntimeUpdateRequest(runtimeId: string): MultiremiRuntimeUpdateRequest | null {
    return this.runtimes.claimRuntimeUpdateRequest(runtimeId);
  }

  reportRuntimeUpdateResult(runtimeId: string, requestId: string, input: ReportRuntimeUpdateInput): MultiremiRuntimeUpdateRequest {
    return this.runtimes.reportRuntimeUpdateResult(runtimeId, requestId, input);
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
  } = {}): MultiremiUsageDaily[] {
    return this.usage.listUsageDaily(input);
  }

  listUsageByAgent(input: {
    workspaceId?: string | null;
    projectId?: string | null;
    runtimeId?: string | null;
    days?: number;
  } = {}): MultiremiUsageByAgent[] {
    return this.usage.listUsageByAgent(input);
  }

  listUsageByHour(input: {
    workspaceId?: string | null;
    projectId?: string | null;
    runtimeId?: string | null;
    days?: number;
  } = {}): MultiremiUsageByHour[] {
    return this.usage.listUsageByHour(input);
  }

  listTaskActivityByHour(input: {
    workspaceId?: string | null;
    projectId?: string | null;
    runtimeId?: string | null;
    days?: number;
  } = {}): MultiremiTaskActivityByHour[] {
    return this.usage.listTaskActivityByHour(input);
  }

  listRuntimeDaily(input: {
    workspaceId?: string | null;
    projectId?: string | null;
    runtimeId?: string | null;
    days?: number;
  } = {}): MultiremiRuntimeDaily[] {
    return this.usage.listRuntimeDaily(input);
  }
  heartbeatRuntime(runtimeId: string, options: { claimPending?: boolean; supportsBatchImport?: boolean; supportsDirectoryScan?: boolean } = {}): MultiremiDaemonHeartbeatAck {
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

  markIssueWorkspaceCleaned(issueId: string, runtimeId: string): MultiremiIssueWorkspace {
    return this.issueWorkspaces.markCleaned(issueId, runtimeId);
  }

  getIssueByRef(ref: string, workspaceId?: string | null): MultiremiIssue | null {
    return this.issues.getIssueByRef(ref, workspaceId);
  }

  getIssueWithTasks(id: string): MultiremiIssueWithTasks | null {
    return this.issues.getIssueWithTasks(id);
  }

  listIssues(input: ListIssuesInput = {}): MultiremiIssue[] {
    return this.issues.listIssues(input);
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

  createIssueDependency(issueId: string, input: CreateIssueDependencyInput): MultiremiIssueDependency {
    return this.issues.createIssueDependency(issueId, input);
  }

  getIssueDependency(id: string): MultiremiIssueDependency | null {
    return this.issues.getIssueDependency(id);
  }

  deleteIssueDependency(issueId: string, dependencyId: string): void {
    return this.issues.deleteIssueDependency(issueId, dependencyId);
  }

  updateIssue(id: string, input: UpdateIssueInput): MultiremiIssue {
    return this.issues.updateIssue(id, input);
  }

  assignIssue(id: string, input: AssignIssueInput): AssignIssueResult {
    return this.issues.assignIssue(id, input);
  }

  quickCreateIssue(input: QuickCreateIssueInput): QuickCreateIssueResult {
    return this.issues.quickCreateIssue(input);
  }

  createIssueComment(issueId: string, input: CreateIssueCommentInput): MultiremiIssueComment {
    return this.issues.createIssueComment(issueId, input);
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

  attachLabelToIssue(issueId: string, labelId: string): MultiremiLabel[] {
    return this.issues.attachLabelToIssue(issueId, labelId);
  }

  detachLabelFromIssue(issueId: string, labelId: string): MultiremiLabel[] {
    return this.issues.detachLabelFromIssue(issueId, labelId);
  }

  listInboxItems(memberId?: string | null): MultiremiInboxItem[] {
    return this.issues.listInboxItems(memberId);
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

  listIssueMetadata(issueId: string): Record<string, string | number | boolean> {
    return this.issues.listIssueMetadata(issueId);
  }

  setIssueMetadataKey(issueId: string, key: string, value: unknown): Record<string, string | number | boolean> {
    return this.issues.setIssueMetadataKey(issueId, key, value);
  }

  deleteIssueMetadataKey(issueId: string, key: string): Record<string, string | number | boolean> {
    return this.issues.deleteIssueMetadataKey(issueId, key);
  }

  getOrCreateDefaultIssueSession(issueId: string, createdById: string | null = null): MultiremiIssueSession {
    return this.sessions.getOrCreateDefaultIssueSession(issueId, createdById);
  }

  createIssueSession(issueId: string, input: CreateIssueSessionInput = {}): MultiremiIssueSession {
    return this.sessions.createIssueSession(issueId, input);
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
    return this.sessions.buildTaskSessionProjection(taskId);
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

  createProject(input: CreateProjectInput): MultiremiProject {
    return this.projects.createProject(input);
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

  updateProject(id: string, input: UpdateProjectInput): MultiremiProject {
    return this.projects.updateProject(id, input);
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

  updateProjectDoc(projectId: string, ref: string, input: UpdateProjectDocInput): MultiremiProjectDoc {
    return this.projects.updateProjectDoc(projectId, ref, input);
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

  listAutopilotRuns(autopilotId: string): MultiremiAutopilotRun[] {
    return this.autopilots.listAutopilotRuns(autopilotId);
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

  runAutopilot(autopilotId: string, input: RunAutopilotInput = {}): MultiremiAutopilotRun {
    return this.autopilots.runAutopilot(autopilotId, input);
  }

  getAutopilotRun(id: string): MultiremiAutopilotRun | null {
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
  } = {}): MultiremiWebhookDeliveryResult {
    return this.autopilots.handleAutopilotWebhook(autopilotId, input);
  }

  replayWebhookDelivery(autopilotId: string, deliveryId: string): MultiremiWebhookDeliveryResult {
    return this.autopilots.replayWebhookDelivery(autopilotId, deliveryId);
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

  getChatMessage(id: string): MultiremiChatMessage | null {
    return this.chat.getChatMessage(id);
  }

  createTask(input: CreateTaskInput): MultiremiTask {
    return this.tasks.createTask(input);
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

  reportProgress(taskId: string, summary: string, step?: number | null, total?: number | null): MultiremiTask {
    return this.tasks.reportProgress(taskId, summary, step, total);
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
