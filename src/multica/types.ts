export type MulticaAgentProvider = "claude" | "codex" | string;

export type MulticaTaskStatus =
  | "queued"
  | "dispatched"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type MulticaRuntimeStatus = "online" | "offline";
export type MulticaRuntimeVisibility = "private" | "public";
export type MulticaRuntimeLocalSkillRequestStatus = "pending" | "running" | "completed" | "failed" | "timeout";
export type MulticaRuntimeModelListRequestStatus = "pending" | "running" | "completed" | "failed" | "timeout";
export type MulticaRuntimeUpdateRequestStatus = "pending" | "running" | "completed" | "failed" | "timeout";
export type MulticaIssuePriority = "urgent" | "high" | "medium" | "low" | "none";
export type MulticaIssueDependencyType = "blocks" | "blocked_by" | "related";
export type MulticaProjectStatus = "planned" | "in_progress" | "paused" | "completed" | "cancelled";
export type MulticaProjectPriority = "urgent" | "high" | "medium" | "low" | "none";
export type MulticaAssigneeType = "agent" | "member" | "squad";
export type MulticaSquadMemberType = "agent" | "member";
export type MulticaAutopilotStatus = "active" | "paused" | "archived";
export type MulticaAutopilotExecutionMode = "create_issue" | "run_only";
export type MulticaAutopilotAssigneeType = "agent" | "squad";
export type MulticaAutopilotTriggerKind = "schedule" | "webhook" | "api";
export type MulticaAutopilotRunStatus = "issue_created" | "running" | "completed" | "failed" | "skipped";
export type MulticaAutopilotRunSource = "manual" | "schedule" | "webhook" | "api";
export type MulticaWebhookProvider = "generic" | "github";
export type MulticaWebhookSignatureStatus = "not_required" | "valid" | "invalid" | "missing";
export type MulticaWebhookDeliveryStatus = "queued" | "dispatched" | "rejected" | "ignored" | "failed";
export type MulticaWebhookDeliveryResultStatus = "accepted" | "duplicate" | "rejected" | "ignored" | "failed" | "skipped";
export type MulticaChatSessionStatus = "active" | "archived";
export type MulticaChatMessageRole = "user" | "assistant" | "system";
export type MulticaSubscriptionReason = "created" | "assigned" | "commented" | "mentioned" | "manual";
export type MulticaPinnedItemType = "issue" | "project";
export type MulticaNotificationGroupKey =
  | "assignments"
  | "status_changes"
  | "comments"
  | "updates"
  | "agent_activity"
  | "system_notifications";
export type MulticaNotificationGroupValue = "all" | "muted";
export type MulticaNotificationPreferences = Partial<Record<MulticaNotificationGroupKey, MulticaNotificationGroupValue>>;
export type MulticaGitHubPullRequestState = "open" | "closed" | "merged" | "draft";
export type MulticaGitHubChecksConclusion = "passed" | "failed" | "pending" | null;
export type MulticaSkillImportSource = "github" | "skills_sh" | "clawhub";

export interface MulticaSkillFile {
  id?: string;
  skillId?: string;
  path: string;
  content: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface MulticaSkill {
  id?: string;
  workspaceId?: string;
  name: string;
  description?: string;
  content: string;
  config?: Record<string, unknown>;
  files?: MulticaSkillFile[];
  createdBy?: string | null;
  archivedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface MulticaAgentTemplateSkill {
  sourceUrl: string;
  source_url?: string;
  cachedName: string;
  cached_name?: string;
  cachedDescription: string;
  cached_description?: string;
}

export interface MulticaAgentTemplateSummary {
  slug: string;
  name: string;
  description: string;
  category?: string;
  icon?: string;
  accent?: string;
  skills: MulticaAgentTemplateSkill[];
}

export interface MulticaAgentTemplate extends MulticaAgentTemplateSummary {
  instructions: string;
}

export interface MulticaAgent {
  id: string;
  name: string;
  provider: MulticaAgentProvider;
  instructions: string;
  skills: MulticaSkill[];
  cwd: string | null;
  executable: string | null;
  model: string | null;
  allowedTools: string[];
  customEnv: Record<string, string>;
  customArgs: string[];
  mcpConfig: unknown | null;
  thinkingLevel: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MulticaRuntime {
  id: string;
  name: string;
  provider: MulticaAgentProvider | "any";
  workspaceId: string | null;
  ownerId: string | null;
  visibility: MulticaRuntimeVisibility;
  status: MulticaRuntimeStatus;
  maxConcurrency: number;
  taskCount: number;
  activeTaskCount: number;
  completedTaskCount: number;
  failedTaskCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  models: MulticaRuntimeModel[];
  lastHeartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MulticaRuntimeLocalSkillSummary {
  key: string;
  name: string;
  description?: string;
  sourcePath: string;
  source_path?: string;
  provider: string;
  fileCount: number;
  file_count?: number;
}

export interface MulticaRuntimeLocalSkillListRequest {
  id: string;
  runtimeId: string;
  status: MulticaRuntimeLocalSkillRequestStatus;
  skills: MulticaRuntimeLocalSkillSummary[];
  supported: boolean;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  runStartedAt: string | null;
}

export interface MulticaRuntimeLocalSkillImportRequest {
  id: string;
  runtimeId: string;
  skillKey: string;
  name: string | null;
  description: string | null;
  status: MulticaRuntimeLocalSkillRequestStatus;
  skill: MulticaSkill | null;
  skillId: string | null;
  error: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  runStartedAt: string | null;
}

export interface MulticaRuntimeModelListRequest {
  id: string;
  runtimeId: string;
  status: MulticaRuntimeModelListRequestStatus;
  models: MulticaRuntimeModel[];
  supported: boolean;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  runStartedAt: string | null;
}

export interface MulticaRuntimeUpdateRequest {
  id: string;
  runtimeId: string;
  status: MulticaRuntimeUpdateRequestStatus;
  targetVersion: string;
  target_version?: string;
  output: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  runStartedAt: string | null;
}

export interface MulticaDaemonHeartbeatAck {
  runtime_id: string;
  status: "ok" | "runtime_gone";
  runtime_gone?: boolean;
  pending_update?: {
    id: string;
    target_version: string;
  };
  pending_model_list?: {
    id: string;
  };
  pending_local_skills?: {
    id: string;
  };
  pending_local_skill_import?: {
    id: string;
    skill_key: string;
  };
  pending_local_skill_imports?: Array<{
    id: string;
    skill_key: string;
  }>;
}

export interface MulticaRuntimeModelThinkingLevel {
  value: string;
  label: string;
  description?: string;
}

export interface MulticaRuntimeModelThinking {
  supportedLevels: MulticaRuntimeModelThinkingLevel[];
  supported_levels?: MulticaRuntimeModelThinkingLevel[];
  defaultLevel?: string;
  default_level?: string;
}

export interface MulticaRuntimeModel {
  id: string;
  label: string;
  provider: string;
  default: boolean;
  thinking?: MulticaRuntimeModelThinking;
  createdAt?: string;
  updatedAt?: string;
}

export interface MulticaRuntimeUsage {
  runtimeId: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  taskCount: number;
}

export interface MulticaUsageDaily {
  date: string;
  runtimeId?: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  taskCount: number;
}

export interface MulticaUsageByAgent {
  agentId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  taskCount: number;
}

export interface MulticaUsageByHour {
  hour: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  taskCount: number;
}

export interface MulticaRuntimeDaily {
  date: string;
  totalSeconds: number;
  taskCount: number;
  failedCount: number;
}

export interface MulticaTaskActivityByHour {
  hour: number;
  count: number;
}

export interface MulticaAgentRunCount {
  agentId: string;
  agent_id?: string;
  runCount: number;
  run_count?: number;
}

export interface MulticaAgentActivityBucket {
  agentId: string;
  agent_id?: string;
  bucketAt: string;
  bucket_at?: string;
  taskCount: number;
  task_count?: number;
  failedCount: number;
  failed_count?: number;
}

export interface MulticaWorkspaceMember {
  id: string;
  workspaceId: string;
  name: string;
  email: string | null;
  role: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MulticaUser {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  avatar_url: string | null;
  language: string | null;
  timezone: string | null;
  onboardedAt: string | null;
  onboarded_at: string | null;
  onboardingQuestionnaire: Record<string, unknown>;
  onboarding_questionnaire: Record<string, unknown>;
  starterContentState: string | null;
  starter_content_state: string | null;
  profileDescription: string;
  profile_description: string;
  createdAt: string;
  created_at: string;
  updatedAt: string;
  updated_at: string;
}

export interface MulticaWorkspace {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  context: string | null;
  settings: Record<string, unknown>;
  repos: unknown[];
  issuePrefix: string;
  issue_prefix: string;
  createdAt: string;
  created_at: string;
  updatedAt: string;
  updated_at: string;
}

export type MulticaWorkspaceInvitationStatus = "pending" | "accepted" | "declined" | "revoked" | "expired";

export interface MulticaWorkspaceInvitation {
  id: string;
  workspaceId: string;
  workspace_id: string;
  inviterId: string;
  inviter_id: string;
  inviteeEmail: string;
  invitee_email: string;
  inviteeUserId: string | null;
  invitee_user_id: string | null;
  role: string;
  status: MulticaWorkspaceInvitationStatus;
  createdAt: string;
  created_at: string;
  updatedAt: string;
  updated_at: string;
  expiresAt: string;
  expires_at: string;
  inviterName?: string;
  inviter_name?: string;
  inviterEmail?: string;
  inviter_email?: string;
  workspaceName?: string;
  workspace_name?: string;
}

export type MulticaAccessTokenType = "pat" | "daemon";

export interface MulticaAccessToken {
  id: string;
  workspaceId: string;
  name: string;
  type: MulticaAccessTokenType;
  tokenPrefix: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface MulticaCreatedAccessToken extends MulticaAccessToken {
  token: string;
}

export interface MulticaNotificationPreferenceResponse {
  workspaceId: string;
  memberId: string | null;
  preferences: MulticaNotificationPreferences;
  updatedAt: string | null;
}

export interface MulticaFeedback {
  id: string;
  workspaceId: string;
  userId: string;
  memberId: string | null;
  message: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface MulticaGitHubSettings {
  workspaceId: string;
  enabled: boolean;
  prSidebar: boolean;
  coAuthor: boolean;
  autoLinkPRs: boolean;
  updatedAt: string | null;
}

export interface MulticaGitHubPullRequest {
  id: string;
  workspaceId: string;
  issueId: string | null;
  repoOwner: string;
  repoName: string;
  number: number;
  title: string;
  state: MulticaGitHubPullRequestState;
  htmlUrl: string;
  branch: string | null;
  authorLogin: string | null;
  authorAvatarUrl: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  prCreatedAt: string;
  prUpdatedAt: string;
  mergeableState: string | null;
  checksConclusion: MulticaGitHubChecksConclusion;
  checksPassed: number;
  checksFailed: number;
  checksPending: number;
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAccessTokenInput {
  id?: string;
  workspaceId?: string | null;
  workspace_id?: string | null;
  name: string;
  type?: MulticaAccessTokenType | string;
  expiresInDays?: number | null;
  expires_in_days?: number | null;
}

export interface CreateFeedbackInput {
  id?: string;
  message: string;
  url?: string | null;
  workspaceId?: string | null;
  workspace_id?: string | null;
  userId?: string | null;
  user_id?: string | null;
  memberId?: string | null;
  member_id?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface MulticaProject {
  id: string;
  workspaceId: string;
  title: string;
  description: string | null;
  icon: string | null;
  status: MulticaProjectStatus;
  priority: MulticaProjectPriority;
  leadType: "member" | "agent" | null;
  leadId: string | null;
  issueCount: number;
  doneCount: number;
  resourceCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface MulticaProjectResource {
  id: string;
  projectId: string;
  workspaceId: string;
  resourceType: string;
  resourceRef: Record<string, unknown>;
  label: string | null;
  position: number;
  createdAt: string;
  createdBy: string | null;
}

export interface MulticaIssue {
  id: string;
  key: string;
  number: number;
  title: string;
  description: string | null;
  status: string;
  priority: MulticaIssuePriority;
  workspaceId: string;
  projectId: string | null;
  parentIssueId: string | null;
  assigneeType: MulticaAssigneeType | null;
  assigneeId: string | null;
  position: number;
  startDate: string | null;
  dueDate: string | null;
  acceptanceCriteria: unknown[];
  contextRefs: unknown[];
  metadata: Record<string, string | number | boolean>;
  labels: MulticaLabel[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MulticaIssueWithTasks extends MulticaIssue {
  tasks: MulticaTask[];
  reactions: MulticaIssueReaction[];
  attachments: MulticaAttachment[];
  children: MulticaIssue[];
  childProgress: MulticaIssueChildProgress;
  dependencies: MulticaIssueDependency[];
}

export interface MulticaIssueAssigneeGroup {
  id: string;
  assigneeType: MulticaAssigneeType | null;
  assigneeId: string | null;
  issues: MulticaIssue[];
  total: number;
}

export interface MulticaAssigneeFrequencyEntry {
  assigneeType: MulticaAssigneeType;
  assignee_type: MulticaAssigneeType;
  assigneeId: string;
  assignee_id: string;
  frequency: number;
}

export interface MulticaIssueChildProgress {
  parentIssueId: string;
  total: number;
  done: number;
}

export interface MulticaIssueDependency {
  id: string;
  workspaceId: string;
  issueId: string;
  dependsOnIssueId: string;
  type: MulticaIssueDependencyType;
  issue: MulticaIssue | null;
  dependsOnIssue: MulticaIssue | null;
  createdAt: string;
}

export interface MulticaIssueComment {
  id: string;
  issueId: string;
  authorType: string;
  authorId: string | null;
  parentId: string | null;
  body: string;
  resolvedAt: string | null;
  resolvedByType: string | null;
  resolvedById: string | null;
  reactions: MulticaCommentReaction[];
  attachments: MulticaAttachment[];
  createdAt: string;
  updatedAt: string;
}

export interface MulticaIssueActivity {
  id: string;
  issueId: string;
  actorType: string;
  actorId: string | null;
  type: string;
  body: string | null;
  data: unknown | null;
  createdAt: string;
}

export interface MulticaTimelineEntry {
  type: "activity" | "comment";
  id: string;
  actorType: string;
  actor_type?: string;
  actorId: string | null;
  actor_id?: string | null;
  createdAt: string;
  created_at?: string;
  action?: string | null;
  details?: unknown | null;
  content?: string | null;
  parentId?: string | null;
  parent_id?: string | null;
  updatedAt?: string | null;
  updated_at?: string | null;
  commentType?: string | null;
  comment_type?: string | null;
  reactions?: MulticaCommentReaction[];
  attachments?: MulticaAttachment[];
  resolvedAt?: string | null;
  resolved_at?: string | null;
  resolvedByType?: string | null;
  resolved_by_type?: string | null;
  resolvedById?: string | null;
  resolved_by_id?: string | null;
}

export interface MulticaTimelinePage {
  entries: MulticaTimelineEntry[];
  next_cursor: null;
  prev_cursor: null;
  has_more_before: false;
  has_more_after: false;
  target_index?: number;
}

export interface MulticaIssueSubscriber {
  id: string;
  issueId: string;
  memberId: string;
  reason: MulticaSubscriptionReason;
  createdAt: string;
}

export interface MulticaInboxItem {
  id: string;
  workspaceId: string;
  issueId: string;
  memberId: string;
  actorType: string;
  actorId: string | null;
  type: string;
  title: string;
  body: string | null;
  read: boolean;
  archived: boolean;
  createdAt: string;
  issue: MulticaIssue | null;
}

export interface MulticaIssueReaction {
  id: string;
  issueId: string;
  workspaceId: string;
  actorType: string;
  actorId: string;
  emoji: string;
  createdAt: string;
}

export interface MulticaCommentReaction {
  id: string;
  commentId: string;
  workspaceId: string;
  actorType: string;
  actorId: string;
  emoji: string;
  createdAt: string;
}

export interface MulticaAttachment {
  id: string;
  workspaceId: string;
  issueId: string | null;
  commentId: string | null;
  uploaderType: string;
  uploaderId: string;
  filename: string;
  url: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface MulticaLabel {
  id: string;
  workspaceId: string;
  name: string;
  color: string;
  createdAt: string;
  updatedAt: string;
}

export interface MulticaPinnedItem {
  id: string;
  workspaceId: string;
  userId: string;
  itemType: MulticaPinnedItemType;
  itemId: string;
  position: number;
  createdAt: string;
}

export interface MulticaIssueSearchResult extends MulticaIssue {
  matchSource: "key" | "title" | "description";
  matchedDescriptionSnippet?: string;
}

export interface MulticaProjectSearchResult extends MulticaProject {
  matchSource: "title" | "description";
  matchedSnippet?: string;
}

export interface MulticaSquad {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  instructions: string;
  leaderId: string | null;
  creatorId: string | null;
  archivedAt: string | null;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface MulticaSquadMember {
  id: string;
  squadId: string;
  memberType: MulticaSquadMemberType;
  memberId: string;
  role: string;
  createdAt: string;
}

export interface MulticaAutopilot {
  id: string;
  workspaceId: string;
  title: string;
  description: string | null;
  projectId: string | null;
  assigneeType: MulticaAutopilotAssigneeType;
  assigneeId: string;
  status: MulticaAutopilotStatus;
  executionMode: MulticaAutopilotExecutionMode;
  issueTitleTemplate: string | null;
  triggerKind: string;
  triggerLabel: string | null;
  cronExpression: string | null;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MulticaAutopilotTrigger {
  id: string;
  autopilotId: string;
  kind: MulticaAutopilotTriggerKind;
  enabled: boolean;
  cronExpression: string | null;
  timezone: string | null;
  nextRunAt: string | null;
  webhookToken: string | null;
  webhookPath: string | null;
  webhookUrl: string | null;
  label: string | null;
  signingSecretSet: boolean;
  lastFiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MulticaAutopilotRun {
  id: string;
  autopilotId: string;
  source: MulticaAutopilotRunSource;
  status: MulticaAutopilotRunStatus;
  issueId: string | null;
  taskId: string | null;
  triggeredAt: string;
  completedAt: string | null;
  failureReason: string | null;
  payload: unknown | null;
  result: unknown | null;
  createdAt: string;
}

export interface MulticaWebhookDelivery {
  id: string;
  workspaceId: string;
  autopilotId: string;
  triggerId: string;
  provider: MulticaWebhookProvider;
  event: string;
  dedupeKey: string | null;
  dedupeSource: string | null;
  signatureStatus: MulticaWebhookSignatureStatus;
  status: MulticaWebhookDeliveryStatus;
  attemptCount: number;
  selectedHeaders: Record<string, unknown>;
  contentType: string | null;
  rawBody: string | null;
  responseStatus: number | null;
  responseBody: string | null;
  autopilotRunId: string | null;
  replayedFromDeliveryId: string | null;
  error: string | null;
  receivedAt: string;
  lastAttemptAt: string;
  createdAt: string;
}

export interface MulticaWebhookDeliveryResult {
  status: MulticaWebhookDeliveryResultStatus;
  duplicate: boolean;
  delivery: MulticaWebhookDelivery;
  run: MulticaAutopilotRun | null;
}

export interface MulticaChatSession {
  id: string;
  workspaceId: string;
  agentId: string;
  title: string;
  status: MulticaChatSessionStatus;
  sessionId: string | null;
  workDir: string | null;
  latestTaskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MulticaChatMessage {
  id: string;
  chatSessionId: string;
  taskId: string | null;
  role: MulticaChatMessageRole;
  body: string;
  createdAt: string;
}

export interface MulticaTask {
  id: string;
  agentId: string;
  runtimeId: string | null;
  issueId: string | null;
  chatSessionId: string | null;
  workspaceId: string;
  status: MulticaTaskStatus;
  priority: number;
  prompt: string;
  result: string | null;
  error: string | null;
  branchName: string | null;
  sessionId: string | null;
  workDir: string | null;
  progressSummary: string | null;
  progressStep: number | null;
  progressTotal: number | null;
  usage: TaskUsageEntry[];
  createdAt: string;
  updatedAt: string;
  dispatchedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  cancelledAt: string | null;
}

export interface MulticaTaskWithAgent extends MulticaTask {
  agent: MulticaAgent | null;
  issue: MulticaIssue | null;
  project: MulticaProject | null;
  projectResources: MulticaProjectResource[];
}

export interface MulticaTaskMessage {
  id: string;
  taskId: string;
  seq: number;
  type: string;
  tool: string | null;
  content: string | null;
  input: Record<string, unknown> | null;
  output: string | null;
  createdAt: string;
}

export interface TaskUsageEntry {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface CreateAgentInput {
  id?: string;
  name: string;
  provider: MulticaAgentProvider;
  instructions?: string;
  skills?: MulticaSkill[];
  cwd?: string | null;
  executable?: string | null;
  model?: string | null;
  allowedTools?: string[];
  customEnv?: Record<string, string>;
  customArgs?: string[];
  mcpConfig?: unknown | null;
  thinkingLevel?: string | null;
}

export interface CreateAgentFromTemplateInput {
  templateSlug?: string;
  template_slug?: string;
  name: string;
  runtimeId?: string | null;
  runtime_id?: string | null;
  provider?: MulticaAgentProvider | null;
  model?: string | null;
  visibility?: string;
  maxConcurrentTasks?: number;
  max_concurrent_tasks?: number;
  description?: string | null;
  instructions?: string | null;
  avatarUrl?: string | null;
  avatar_url?: string | null;
  extraSkillIds?: string[];
  extra_skill_ids?: string[];
  workspaceId?: string | null;
  workspace_id?: string | null;
  ownerId?: string | null;
  owner_id?: string | null;
}

export interface CreateAgentFromTemplateResult {
  agent: MulticaAgent;
  importedSkillIds: string[];
  imported_skill_ids: string[];
  reusedSkillIds: string[];
  reused_skill_ids: string[];
}

export interface CreateSkillInput {
  id?: string;
  workspaceId?: string | null;
  workspace_id?: string | null;
  name: string;
  description?: string;
  content?: string;
  config?: Record<string, unknown> | null;
  files?: MulticaSkillFile[];
  createdBy?: string | null;
  created_by?: string | null;
}

export interface ImportSkillInput {
  url?: string;
  sourceUrl?: string;
  source_url?: string;
  workspaceId?: string | null;
  workspace_id?: string | null;
  name?: string | null;
  description?: string | null;
  createdBy?: string | null;
  created_by?: string | null;
}

export interface UpdateSkillInput {
  workspaceId?: string | null;
  workspace_id?: string | null;
  name?: string;
  description?: string;
  content?: string;
  config?: Record<string, unknown> | null;
  files?: MulticaSkillFile[];
  createdBy?: string | null;
  created_by?: string | null;
}

export interface SetAgentSkillsInput {
  skillIds?: string[];
  skill_ids?: string[];
}

export interface CreateWorkspaceMemberInput {
  id?: string;
  workspaceId?: string | null;
  name: string;
  email?: string | null;
  role?: string;
}

export interface UpdateWorkspaceMemberInput {
  name?: string;
  email?: string | null;
  role?: string;
  workspaceId?: string | null;
}

export interface UpdateAgentInput {
  name?: string;
  provider?: MulticaAgentProvider;
  instructions?: string;
  skills?: MulticaSkill[];
  cwd?: string | null;
  executable?: string | null;
  model?: string | null;
  allowedTools?: string[];
  customEnv?: Record<string, string>;
  customArgs?: string[];
  mcpConfig?: unknown | null;
  thinkingLevel?: string | null;
}

export interface RegisterRuntimeInput {
  id?: string;
  name: string;
  provider: MulticaAgentProvider | "any";
  workspaceId?: string | null;
  workspace_id?: string | null;
  ownerId?: string | null;
  owner_id?: string | null;
  visibility?: MulticaRuntimeVisibility | string;
  maxConcurrency?: number;
  max_concurrency?: number;
  models?: MulticaRuntimeModel[];
}

export interface UpdateMulticaUserInput {
  name?: string;
  avatarUrl?: string | null;
  avatar_url?: string | null;
  language?: string | null;
  profileDescription?: string | null;
  profile_description?: string | null;
  timezone?: string | null;
  onboardingQuestionnaire?: Record<string, unknown>;
  onboarding_questionnaire?: Record<string, unknown>;
  starterContentState?: string | null;
  starter_content_state?: string | null;
}

export interface CreateWorkspaceInput {
  id?: string;
  name: string;
  slug?: string;
  description?: string | null;
  context?: string | null;
  settings?: Record<string, unknown>;
  repos?: unknown[];
  issuePrefix?: string;
  issue_prefix?: string;
}

export interface CreateWorkspaceInvitationInput {
  email?: string;
  inviteeEmail?: string;
  invitee_email?: string;
  role?: string;
}

export interface UpdateRuntimeInput {
  name?: string;
  ownerId?: string | null;
  owner_id?: string | null;
  visibility?: MulticaRuntimeVisibility | string;
  maxConcurrency?: number;
  max_concurrency?: number;
  models?: MulticaRuntimeModel[];
}

export interface CreateRuntimeLocalSkillImportInput {
  skillKey?: string;
  skill_key?: string;
  name?: string | null;
  description?: string | null;
  createdBy?: string | null;
  created_by?: string | null;
}

export interface ReportRuntimeLocalSkillListInput {
  status?: string;
  skills?: MulticaRuntimeLocalSkillSummary[];
  supported?: boolean;
  error?: string;
}

export interface ReportRuntimeLocalSkillImportInput {
  status?: string;
  skill?: {
    name?: string;
    description?: string;
    content?: string;
    sourcePath?: string;
    source_path?: string;
    provider?: string;
    files?: MulticaSkillFile[];
  } | null;
  error?: string;
}

export interface ReportRuntimeModelListInput {
  status?: string;
  models?: MulticaRuntimeModel[];
  supported?: boolean;
  error?: string;
}

export interface CreateRuntimeUpdateInput {
  targetVersion?: string;
  target_version?: string;
}

export interface ReportRuntimeUpdateInput {
  status?: string;
  output?: string;
  error?: string;
}

export interface CreateIssueInput {
  id?: string;
  title: string;
  description?: string | null;
  status?: string;
  priority?: MulticaIssuePriority | string;
  workspaceId?: string | null;
  workspace_id?: string | null;
  projectId?: string | null;
  project_id?: string | null;
  parentIssueId?: string | null;
  parent_issue_id?: string | null;
  assigneeType?: MulticaAssigneeType | null;
  assignee_type?: MulticaAssigneeType | null;
  assigneeId?: string | null;
  assignee_id?: string | null;
  position?: number | null;
  startDate?: string | null;
  start_date?: string | null;
  dueDate?: string | null;
  due_date?: string | null;
  acceptanceCriteria?: unknown[];
  acceptance_criteria?: unknown[];
  contextRefs?: unknown[];
  context_refs?: unknown[];
  createdBy?: string | null;
}

export interface CreateIssueWithTaskInput extends CreateIssueInput {
  agentId?: string;
  prompt?: string;
}

export interface UpdateIssueInput {
  title?: string;
  description?: string | null;
  status?: string;
  priority?: MulticaIssuePriority | string;
  projectId?: string | null;
  project_id?: string | null;
  workspaceId?: string | null;
  workspace_id?: string | null;
  parentIssueId?: string | null;
  parent_issue_id?: string | null;
  assigneeType?: MulticaAssigneeType | null;
  assignee_type?: MulticaAssigneeType | null;
  assigneeId?: string | null;
  assignee_id?: string | null;
  position?: number | null;
  startDate?: string | null;
  start_date?: string | null;
  dueDate?: string | null;
  due_date?: string | null;
  acceptanceCriteria?: unknown[];
  acceptance_criteria?: unknown[];
  contextRefs?: unknown[];
  context_refs?: unknown[];
}

export interface BatchUpdateIssuesInput {
  issueIds?: string[];
  issue_ids?: string[];
  updates?: UpdateIssueInput;
}

export interface BatchDeleteIssuesInput {
  issueIds?: string[];
  issue_ids?: string[];
}

export interface ListIssuesInput {
  workspaceId?: string | null;
  workspace_id?: string | null;
  statuses?: string[];
  status?: string[];
  priorities?: string[];
  priority?: string[];
  assigneeTypes?: MulticaAssigneeType[];
  assignee_types?: MulticaAssigneeType[];
  assigneeId?: string | null;
  assignee_id?: string | null;
  assigneeIds?: string[];
  assignee_ids?: string[];
  projectId?: string | null;
  project_id?: string | null;
  projectIds?: string[];
  project_ids?: string[];
  includeNoAssignee?: boolean;
  includeNoProject?: boolean;
  limit?: number;
  offset?: number;
}

export interface AssignIssueInput {
  assigneeType?: MulticaAssigneeType | null;
  assignee_type?: MulticaAssigneeType | null;
  assigneeId?: string | null;
  assignee_id?: string | null;
  prompt?: string | null;
  actorType?: string | null;
  actor_type?: string | null;
  actorId?: string | null;
  actor_id?: string | null;
}

export interface AssignIssueResult {
  issue: MulticaIssue;
  task: MulticaTask | null;
}

export interface QuickCreateIssueInput {
  agentId?: string | null;
  agent_id?: string | null;
  squadId?: string | null;
  squad_id?: string | null;
  prompt: string;
  projectId?: string | null;
  project_id?: string | null;
  workspaceId?: string | null;
  workspace_id?: string | null;
  requesterId?: string | null;
  requester_id?: string | null;
}

export interface QuickCreateIssueResult {
  issue: MulticaIssue;
  task: MulticaTask;
}

export interface CreateIssueDependencyInput {
  id?: string;
  dependsOnIssueId?: string;
  depends_on_issue_id?: string;
  type?: MulticaIssueDependencyType | string;
}

export interface CreateIssueCommentInput {
  authorType?: string;
  authorId?: string | null;
  parentId?: string | null;
  parent_id?: string | null;
  attachmentIds?: string[];
  attachment_ids?: string[];
  body: string;
}

export interface UpdateIssueCommentInput {
  body?: string;
  content?: string;
  attachmentIds?: string[];
  attachment_ids?: string[];
}

export interface CreateMulticaReactionInput {
  actorType?: string;
  actor_type?: string;
  actorId?: string | null;
  actor_id?: string | null;
  emoji: string;
}

export interface CreateAttachmentInput {
  id?: string;
  workspaceId?: string | null;
  workspace_id?: string | null;
  issueId?: string | null;
  issue_id?: string | null;
  commentId?: string | null;
  comment_id?: string | null;
  uploaderType?: string;
  uploader_type?: string;
  uploaderId?: string | null;
  uploader_id?: string | null;
  filename: string;
  url: string;
  contentType?: string | null;
  content_type?: string | null;
  sizeBytes?: number | null;
  size_bytes?: number | null;
}

export interface CreateLabelInput {
  id?: string;
  workspaceId?: string | null;
  workspace_id?: string | null;
  name: string;
  color: string;
}

export interface UpdateLabelInput {
  name?: string;
  color?: string;
}

export interface CreatePinnedItemInput {
  id?: string;
  workspaceId?: string | null;
  workspace_id?: string | null;
  userId?: string | null;
  user_id?: string | null;
  itemType?: MulticaPinnedItemType | string;
  item_type?: MulticaPinnedItemType | string;
  itemId?: string;
  item_id?: string;
}

export interface ReorderPinnedItemInput {
  id: string;
  position: number;
}

export interface CreateProjectInput {
  id?: string;
  title: string;
  description?: string | null;
  icon?: string | null;
  workspaceId?: string | null;
  status?: MulticaProjectStatus;
  priority?: MulticaProjectPriority;
  leadType?: "member" | "agent" | null;
  leadId?: string | null;
  resources?: CreateProjectResourceInput[];
}

export interface UpdateProjectInput {
  title?: string;
  description?: string | null;
  icon?: string | null;
  status?: MulticaProjectStatus;
  priority?: MulticaProjectPriority;
  leadType?: "member" | "agent" | null;
  leadId?: string | null;
}

export interface CreateProjectResourceInput {
  id?: string;
  resourceType?: string;
  resource_type?: string;
  resourceRef?: Record<string, unknown>;
  resource_ref?: Record<string, unknown>;
  label?: string | null;
  position?: number | null;
  createdBy?: string | null;
}

export interface CreateSquadInput {
  id?: string;
  name: string;
  description?: string | null;
  instructions?: string | null;
  workspaceId?: string | null;
  leaderId?: string | null;
  creatorId?: string | null;
  memberIds?: string[];
}

export interface UpdateSquadInput {
  name?: string;
  description?: string | null;
  instructions?: string | null;
  leaderId?: string | null;
}

export interface AddSquadMemberInput {
  memberType: MulticaSquadMemberType;
  memberId: string;
  role?: string;
}

export interface RemoveSquadMemberInput {
  memberType: MulticaSquadMemberType;
  memberId: string;
}

export interface CreateAutopilotInput {
  id?: string;
  title: string;
  description?: string | null;
  projectId?: string | null;
  workspaceId?: string | null;
  assigneeType?: MulticaAutopilotAssigneeType;
  assigneeId: string;
  status?: MulticaAutopilotStatus;
  executionMode?: MulticaAutopilotExecutionMode;
  issueTitleTemplate?: string | null;
  triggerKind?: string;
  triggerLabel?: string | null;
  cronExpression?: string | null;
}

export interface CreateAutopilotTriggerInput {
  kind?: MulticaAutopilotTriggerKind;
  cronExpression?: string | null;
  cron_expression?: string | null;
  timezone?: string | null;
  label?: string | null;
  enabled?: boolean;
}

export interface UpdateAutopilotTriggerInput {
  enabled?: boolean;
  cronExpression?: string | null;
  cron_expression?: string | null;
  timezone?: string | null;
  label?: string | null;
}

export interface UpdateAutopilotInput {
  title?: string;
  description?: string | null;
  projectId?: string | null;
  assigneeType?: MulticaAutopilotAssigneeType;
  assigneeId?: string;
  status?: MulticaAutopilotStatus;
  executionMode?: MulticaAutopilotExecutionMode;
  issueTitleTemplate?: string | null;
  triggerKind?: string;
  triggerLabel?: string | null;
  cronExpression?: string | null;
}

export interface RunAutopilotInput {
  source?: MulticaAutopilotRunSource;
  prompt?: string | null;
  payload?: unknown | null;
}

export interface CreateTaskInput {
  id?: string;
  agentId: string;
  issueId?: string | null;
  chatSessionId?: string | null;
  workspaceId?: string | null;
  priority?: number;
  prompt: string;
  workDir?: string | null;
  sessionId?: string | null;
}

export interface TaskMessageInput {
  seq?: number;
  type: string;
  tool?: string | null;
  content?: string | null;
  input?: Record<string, unknown> | null;
  output?: string | null;
}

export interface CreateChatSessionInput {
  id?: string;
  agentId: string;
  workspaceId?: string | null;
  title?: string | null;
}

export interface UpdateChatSessionInput {
  title?: string;
  status?: MulticaChatSessionStatus;
}

export interface SendChatMessageInput {
  body: string;
}

export interface SendChatMessageResult {
  session: MulticaChatSession;
  message: MulticaChatMessage;
  task: MulticaTask;
}
