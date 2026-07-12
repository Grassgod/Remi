export type MultiremiAgentProvider = "claude" | "codex" | string;
export type MultiremiAgentVisibility = "private" | "workspace";

export type MultiremiTaskStatus =
  | "queued"
  | "dispatched"
  | "running"
  | "waiting_local_directory"
  | "awaiting_human"
  | "completed"
  | "failed"
  | "cancelled";

export type MultiremiTaskHumanRequestKind = "permission" | "question";
export type MultiremiTaskHumanRequestStatus = "pending" | "responded" | "timeout" | "cancelled";

export interface MultiremiTaskHumanRequest {
  id: string;
  taskId: string;
  kind: MultiremiTaskHumanRequestKind;
  payload: Record<string, unknown>;
  status: MultiremiTaskHumanRequestStatus;
  response: Record<string, unknown> | null;
  respondedBy: string | null;
  createdAt: string;
  respondedAt: string | null;
}

export interface CreateTaskHumanRequestInput {
  id?: string;
  taskId: string;
  kind: MultiremiTaskHumanRequestKind;
  payload: Record<string, unknown>;
}

export type MultiremiRuntimeStatus = "online" | "offline";
export type MultiremiRuntimeVisibility = "private" | "public";
export type MultiremiRuntimeLocalSkillRequestStatus = "pending" | "running" | "completed" | "failed" | "timeout";
export type MultiremiRuntimeModelListRequestStatus = "pending" | "running" | "completed" | "failed" | "timeout";
export type MultiremiRuntimeDirectoryScanRequestStatus = "pending" | "running" | "completed" | "failed" | "timeout";
export type MultiremiRuntimeUpdateRequestStatus = "pending" | "running" | "completed" | "failed" | "timeout";
export type MultiremiIssuePriority = "urgent" | "high" | "medium" | "low" | "none";
export type MultiremiIssueDependencyType = "blocks" | "blocked_by" | "related";
export type MultiremiProjectStatus = "planned" | "in_progress" | "paused" | "completed" | "cancelled";
export type MultiremiProjectPriority = "urgent" | "high" | "medium" | "low" | "none";
export type MultiremiAssigneeType = "agent" | "member" | "squad";
export type MultiremiSquadMemberType = "agent" | "member";
export type MultiremiAutopilotStatus = "active" | "paused" | "archived";
export type MultiremiAutopilotExecutionMode = "create_issue" | "run_only";
export type MultiremiAutopilotAssigneeType = "agent" | "squad";
export type MultiremiAutopilotTriggerKind = "schedule" | "webhook" | "api";
export type MultiremiAutopilotRunStatus = "issue_created" | "running" | "completed" | "failed" | "skipped";
export type MultiremiAutopilotRunSource = "manual" | "schedule" | "webhook" | "api";
export type MultiremiWebhookProvider = "generic" | "github";
export type MultiremiWebhookSignatureStatus = "not_required" | "valid" | "invalid" | "missing";
export type MultiremiWebhookDeliveryStatus = "queued" | "dispatched" | "rejected" | "ignored" | "failed";
export type MultiremiWebhookDeliveryResultStatus = "accepted" | "duplicate" | "rejected" | "ignored" | "failed" | "skipped";
export type MultiremiAnalyticsEventName =
  | "runtime_registered"
  | "runtime_ready"
  | "runtime_failed"
  | "runtime_offline"
  | "autopilot_created"
  | "autopilot_run_started"
  | "autopilot_run_completed"
  | "autopilot_run_failed"
  | string;

export interface MultiremiWebhookEventFilter {
  event: string;
  actions?: string[];
}
export type MultiremiChatSessionStatus = "active" | "archived";
export type MultiremiChatMessageRole = "user" | "assistant" | "system";
export type MultiremiSubscriptionReason = "created" | "assigned" | "commented" | "mentioned" | "manual";
export type MultiremiPinnedItemType = "issue" | "project";
export type MultiremiNotificationGroupKey =
  | "assignments"
  | "status_changes"
  | "comments"
  | "updates"
  | "agent_activity"
  | "system_notifications";
export type MultiremiNotificationGroupValue = "all" | "muted";
export type MultiremiNotificationPreferences = Partial<Record<MultiremiNotificationGroupKey, MultiremiNotificationGroupValue>>;
export type MultiremiGitHubPullRequestState = "open" | "closed" | "merged" | "draft";
export type MultiremiGitHubChecksConclusion = "passed" | "failed" | "pending" | null;
export type MultiremiSkillImportSource = "github" | "skills_sh" | "clawhub";

export interface MultiremiSkillFile {
  id?: string;
  skillId?: string;
  path: string;
  content: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface MultiremiSkill {
  id?: string;
  workspaceId?: string;
  name: string;
  description?: string;
  content: string;
  config?: Record<string, unknown>;
  files?: MultiremiSkillFile[];
  createdBy?: string | null;
  archivedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface MultiremiAgentTemplateSkill {
  sourceUrl: string;
  source_url?: string;
  cachedName: string;
  cached_name?: string;
  cachedDescription: string;
  cached_description?: string;
}

export interface MultiremiAgentTemplateSummary {
  slug: string;
  name: string;
  description: string;
  category?: string;
  icon?: string;
  accent?: string;
  skills: MultiremiAgentTemplateSkill[];
}

export interface MultiremiAgentTemplate extends MultiremiAgentTemplateSummary {
  instructions: string;
}

export interface MultiremiAgent {
  id: string;
  name: string;
  description: string;
  avatarUrl: string | null;
  avatar_url?: string | null;
  provider: MultiremiAgentProvider;
  workspaceId: string;
  workspace_id?: string;
  ownerId: string;
  owner_id?: string;
  visibility: MultiremiAgentVisibility;
  runtimeId: string | null;
  runtime_id?: string | null;
  instructions: string;
  skills: MultiremiSkill[];
  maxConcurrentTasks: number;
  max_concurrent_tasks?: number;
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

export interface MultiremiRuntime {
  id: string;
  name: string;
  provider: MultiremiAgentProvider | "any";
  daemonId: string | null;
  legacyDaemonId: string | null;
  runtimeMode: string;
  deviceInfo: string;
  metadata: Record<string, unknown>;
  workspaceId: string | null;
  ownerId: string | null;
  visibility: MultiremiRuntimeVisibility;
  status: MultiremiRuntimeStatus;
  maxConcurrency: number;
  taskCount: number;
  activeTaskCount: number;
  completedTaskCount: number;
  failedTaskCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  models: MultiremiRuntimeModel[];
  lastHeartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MultiremiCloudRuntimeNode {
  id: string;
  ownerId: string;
  owner_id: string;
  instanceId: string;
  instance_id: string;
  region: string;
  instanceType: string;
  instance_type: string;
  imageId: string;
  image_id: string;
  subnetId: string;
  subnet_id: string;
  name: string;
  status: string;
  tags: Record<string, string>;
  metadata: Record<string, unknown>;
  createdAt: string;
  created_at: string;
  updatedAt: string;
  updated_at: string;
}

export interface MultiremiRuntimeLocalSkillSummary {
  key: string;
  name: string;
  description?: string;
  sourcePath: string;
  source_path?: string;
  provider: string;
  fileCount: number;
  file_count?: number;
}

export interface MultiremiRuntimeLocalSkillListRequest {
  id: string;
  runtimeId: string;
  status: MultiremiRuntimeLocalSkillRequestStatus;
  skills: MultiremiRuntimeLocalSkillSummary[];
  supported: boolean;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  runStartedAt: string | null;
}

export interface MultiremiRuntimeLocalSkillImportRequest {
  id: string;
  runtimeId: string;
  skillKey: string;
  name: string | null;
  description: string | null;
  status: MultiremiRuntimeLocalSkillRequestStatus;
  skill: MultiremiSkill | null;
  skillId: string | null;
  error: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  runStartedAt: string | null;
}

export interface MultiremiRuntimeModelListRequest {
  id: string;
  runtimeId: string;
  status: MultiremiRuntimeModelListRequestStatus;
  models: MultiremiRuntimeModel[];
  supported: boolean;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  runStartedAt: string | null;
}

export interface MultiremiRuntimeDirectoryCandidate {
  path: string;
  name: string;
  remoteUrl: string | null;
  currentBranch: string | null;
  isDirty: boolean | null;
  // Present in browse mode (true for git working trees, false for plain dirs);
  // scan-mode candidates may omit it.
  isGitRepo?: boolean;
}

export interface MultiremiRuntimeDirectoryScanParams {
  root?: string;
  maxDepth?: number;
  // "scan" (default) hunts for git working trees; "browse" lists immediate child dirs.
  mode?: "scan" | "browse";
  // Browse mode echoes the expanded absolute root back (e.g. "~" -> "/home/dev")
  // so the folder-picker UI can show the current dir and ascend even when the
  // listing is empty. Absent for scan mode / as-requested params.
  resolvedRoot?: string;
}

export interface MultiremiRuntimeDirectoryScanRequest {
  id: string;
  runtimeId: string;
  status: MultiremiRuntimeDirectoryScanRequestStatus;
  params: MultiremiRuntimeDirectoryScanParams;
  candidates: MultiremiRuntimeDirectoryCandidate[];
  supported: boolean;
  error: string | null;
  runStartedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * What a runtime update request targets: the remi CLI binary (`cli`), the ACP
 * bridges (`acp`), or the underlying agent CLI — claude/codex (`agent`).
 */
export type MultiremiRuntimeUpdateScope = "cli" | "acp" | "agent";

export interface MultiremiRuntimeUpdateRequest {
  id: string;
  runtimeId: string;
  status: MultiremiRuntimeUpdateRequestStatus;
  scope: MultiremiRuntimeUpdateScope;
  targetVersion: string;
  target_version?: string;
  output: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  runStartedAt: string | null;
}

export interface MultiremiDaemonHeartbeatAck {
  runtime_id: string;
  status: "ok" | "runtime_gone";
  runtime_gone?: boolean;
  pending_update?: {
    id: string;
    target_version: string;
    scope?: MultiremiRuntimeUpdateScope;
  };
  pending_model_list?: {
    id: string;
  };
  pending_local_skills?: {
    id: string;
  };
  pending_directory_scan?: {
    id: string;
    root?: string;
    max_depth?: number;
    mode?: string;
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

export interface MultiremiRuntimeModelThinkingLevel {
  value: string;
  label: string;
  description?: string;
}

export interface MultiremiRuntimeModelThinking {
  supportedLevels: MultiremiRuntimeModelThinkingLevel[];
  supported_levels?: MultiremiRuntimeModelThinkingLevel[];
  defaultLevel?: string;
  default_level?: string;
}

export interface MultiremiRuntimeModel {
  id: string;
  label: string;
  provider: string;
  default: boolean;
  thinking?: MultiremiRuntimeModelThinking;
  createdAt?: string;
  updatedAt?: string;
}

export interface MultiremiRuntimeUsage {
  runtimeId: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  taskCount: number;
}

export interface MultiremiUsageDaily {
  date: string;
  runtimeId?: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  taskCount: number;
}

export interface MultiremiUsageByAgent {
  agentId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  taskCount: number;
}

export interface MultiremiUsageByHour {
  hour: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  taskCount: number;
}

export interface MultiremiRuntimeDaily {
  date: string;
  totalSeconds: number;
  taskCount: number;
  failedCount: number;
}

export interface MultiremiTaskActivityByHour {
  hour: number;
  count: number;
}

export interface MultiremiAgentRunCount {
  agentId: string;
  agent_id?: string;
  runCount: number;
  run_count?: number;
}

export interface MultiremiAgentActivityBucket {
  agentId: string;
  agent_id?: string;
  bucketAt: string;
  bucket_at?: string;
  taskCount: number;
  task_count?: number;
  failedCount: number;
  failed_count?: number;
}

export interface MultiremiWorkspaceMember {
  id: string;
  workspaceId: string;
  userId: string | null;
  name: string;
  email: string | null;
  role: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MultiremiUser {
  id: string;
  externalId: string | null;
  external_id: string | null;
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

export interface MultiremiWorkspace {
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

export type MultiremiWorkspaceInvitationStatus = "pending" | "accepted" | "declined" | "revoked" | "expired";

export interface MultiremiWorkspaceInvitation {
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
  status: MultiremiWorkspaceInvitationStatus;
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

export type MultiremiAccessTokenType = "pat" | "daemon" | "task";

export interface MultiremiAccessToken {
  id: string;
  workspaceId: string;
  daemonId: string | null;
  taskId: string | null;
  agentId: string | null;
  userId: string;
  name: string;
  type: MultiremiAccessTokenType;
  tokenPrefix: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface MultiremiCreatedAccessToken extends MultiremiAccessToken {
  token: string;
}

export interface MultiremiNotificationPreferenceResponse {
  workspaceId: string;
  memberId: string | null;
  preferences: MultiremiNotificationPreferences;
  updatedAt: string | null;
}

export interface MultiremiFeedback {
  id: string;
  workspaceId: string;
  userId: string;
  memberId: string | null;
  message: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface MultiremiGitHubSettings {
  workspaceId: string;
  enabled: boolean;
  prSidebar: boolean;
  coAuthor: boolean;
  autoLinkPRs: boolean;
  updatedAt: string | null;
}

export interface MultiremiGitHubPullRequest {
  id: string;
  workspaceId: string;
  issueId: string | null;
  repoOwner: string;
  repoName: string;
  number: number;
  title: string;
  state: MultiremiGitHubPullRequestState;
  htmlUrl: string;
  branch: string | null;
  authorLogin: string | null;
  authorAvatarUrl: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  prCreatedAt: string;
  prUpdatedAt: string;
  mergeableState: string | null;
  checksConclusion: MultiremiGitHubChecksConclusion;
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
  daemonId?: string | null;
  daemon_id?: string | null;
  taskId?: string | null;
  task_id?: string | null;
  agentId?: string | null;
  agent_id?: string | null;
  name: string;
  type?: MultiremiAccessTokenType | string;
  expiresInDays?: number | null;
  expires_in_days?: number | null;
  userId?: string | null;
  user_id?: string | null;
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

export interface MultiremiProject {
  id: string;
  workspaceId: string;
  title: string;
  description: string | null;
  icon: string | null;
  status: MultiremiProjectStatus;
  priority: MultiremiProjectPriority;
  leadType: "member" | "agent" | null;
  leadId: string | null;
  issueCount: number;
  doneCount: number;
  resourceCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface MultiremiProjectResource {
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

export interface MultiremiRepoData {
  url: string;
  description?: string;
}

export interface MultiremiIssue {
  id: string;
  key: string;
  number: number;
  title: string;
  description: string | null;
  status: string;
  priority: MultiremiIssuePriority;
  workspaceId: string;
  projectId: string | null;
  parentIssueId: string | null;
  assigneeType: MultiremiAssigneeType | null;
  assigneeId: string | null;
  position: number;
  startDate: string | null;
  dueDate: string | null;
  acceptanceCriteria: unknown[];
  contextRefs: unknown[];
  metadata: Record<string, string | number | boolean>;
  labels: MultiremiLabel[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MultiremiIssueWithTasks extends MultiremiIssue {
  tasks: MultiremiTask[];
  reactions: MultiremiIssueReaction[];
  attachments: MultiremiAttachment[];
  children: MultiremiIssue[];
  childProgress: MultiremiIssueChildProgress;
  dependencies: MultiremiIssueDependency[];
}

export interface MultiremiIssueAssigneeGroup {
  id: string;
  assigneeType: MultiremiAssigneeType | null;
  assigneeId: string | null;
  issues: MultiremiIssue[];
  total: number;
}

export interface MultiremiAssigneeFrequencyEntry {
  assigneeType: MultiremiAssigneeType;
  assignee_type: MultiremiAssigneeType;
  assigneeId: string;
  assignee_id: string;
  frequency: number;
}

export interface MultiremiIssueChildProgress {
  parentIssueId: string;
  total: number;
  done: number;
}

export interface MultiremiIssueDependency {
  id: string;
  workspaceId: string;
  issueId: string;
  dependsOnIssueId: string;
  type: MultiremiIssueDependencyType;
  issue: MultiremiIssue | null;
  dependsOnIssue: MultiremiIssue | null;
  createdAt: string;
}

export interface MultiremiIssueComment {
  id: string;
  issueId: string;
  issue_id?: string;
  authorType: string;
  author_type?: string;
  authorId: string | null;
  author_id?: string | null;
  parentId: string | null;
  parent_id?: string | null;
  body: string;
  content?: string;
  type?: string;
  resolvedAt: string | null;
  resolved_at?: string | null;
  resolvedByType: string | null;
  resolved_by_type?: string | null;
  resolvedById: string | null;
  resolved_by_id?: string | null;
  reactions: MultiremiCommentReaction[];
  attachments: MultiremiAttachment[];
  replyCount?: number;
  reply_count?: number;
  lastActivityAt?: string;
  last_activity_at?: string;
  contentTruncated?: boolean;
  content_truncated?: boolean;
  createdAt: string;
  created_at?: string;
  updatedAt: string;
  updated_at?: string;
}

export interface ListIssueCommentsInput {
  since?: string | null;
  thread?: string | null;
  tail?: number | null;
  recent?: number | null;
  rootsOnly?: boolean;
  roots_only?: boolean;
  summary?: boolean;
  before?: string | null;
  beforeId?: string | null;
  before_id?: string | null;
}

export interface ListIssueCommentsResult {
  comments: MultiremiIssueComment[];
  nextBefore: string | null;
  nextBeforeId: string | null;
  next_before?: string | null;
  next_before_id?: string | null;
}

export interface MultiremiIssueActivity {
  id: string;
  issueId: string;
  actorType: string;
  actorId: string | null;
  type: string;
  body: string | null;
  data: unknown | null;
  createdAt: string;
}

export interface MultiremiTimelineEntry {
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
  reactions?: MultiremiCommentReaction[];
  attachments?: MultiremiAttachment[];
  resolvedAt?: string | null;
  resolved_at?: string | null;
  resolvedByType?: string | null;
  resolved_by_type?: string | null;
  resolvedById?: string | null;
  resolved_by_id?: string | null;
}

export interface MultiremiTimelinePage {
  entries: MultiremiTimelineEntry[];
  next_cursor: null;
  prev_cursor: null;
  has_more_before: false;
  has_more_after: false;
  target_index?: number;
}

export interface MultiremiIssueSubscriber {
  id: string;
  issueId: string;
  issue_id?: string;
  memberId: string;
  member_id?: string;
  userType: string;
  user_type?: string;
  userId: string;
  user_id?: string;
  reason: MultiremiSubscriptionReason;
  createdAt: string;
  created_at?: string;
}

export interface MultiremiInboxItem {
  id: string;
  workspaceId: string;
  workspace_id?: string;
  issueId: string | null;
  issue_id?: string | null;
  memberId: string;
  member_id?: string;
  recipientType: string;
  recipient_type?: string;
  recipientId: string;
  recipient_id?: string;
  actorType: string;
  actor_type?: string;
  actorId: string | null;
  actor_id?: string | null;
  type: string;
  severity: string;
  title: string;
  body: string | null;
  details: unknown | null;
  read: boolean;
  archived: boolean;
  createdAt: string;
  created_at?: string;
  issue: MultiremiIssue | null;
}

export interface MultiremiIssueReaction {
  id: string;
  issueId: string;
  workspaceId: string;
  actorType: string;
  actorId: string;
  emoji: string;
  createdAt: string;
}

export interface MultiremiCommentReaction {
  id: string;
  commentId: string;
  workspaceId: string;
  actorType: string;
  actorId: string;
  emoji: string;
  createdAt: string;
}

export interface MultiremiAttachment {
  id: string;
  workspaceId: string;
  issueId: string | null;
  commentId: string | null;
  chatSessionId: string | null;
  chatMessageId: string | null;
  uploaderType: string;
  uploaderId: string;
  filename: string;
  url: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface MultiremiLabel {
  id: string;
  workspaceId: string;
  name: string;
  color: string;
  createdAt: string;
  updatedAt: string;
}

export interface MultiremiPinnedItem {
  id: string;
  workspaceId: string;
  userId: string;
  itemType: MultiremiPinnedItemType;
  itemId: string;
  position: number;
  createdAt: string;
}

export interface MultiremiIssueSearchResult extends MultiremiIssue {
  matchSource: "key" | "title" | "description" | "comment";
  matchedSnippet?: string;
  matchedDescriptionSnippet?: string;
  matchedCommentSnippet?: string;
}

export interface MultiremiProjectSearchResult extends MultiremiProject {
  matchSource: "title" | "description";
  matchedSnippet?: string;
}

export interface MultiremiSquad {
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

export interface MultiremiSquadMember {
  id: string;
  squadId: string;
  memberType: MultiremiSquadMemberType;
  memberId: string;
  role: string;
  createdAt: string;
}

export interface MultiremiAutopilot {
  id: string;
  workspaceId: string;
  workspace_id?: string;
  title: string;
  description: string | null;
  projectId: string | null;
  project_id?: string | null;
  assigneeType: MultiremiAutopilotAssigneeType;
  assignee_type?: MultiremiAutopilotAssigneeType;
  assigneeId: string;
  assignee_id?: string;
  status: MultiremiAutopilotStatus;
  executionMode: MultiremiAutopilotExecutionMode;
  execution_mode?: MultiremiAutopilotExecutionMode;
  issueTitleTemplate: string | null;
  issue_title_template?: string | null;
  triggerKind: string;
  trigger_kind?: string;
  triggerLabel: string | null;
  trigger_label?: string | null;
  cronExpression: string | null;
  cron_expression?: string | null;
  createdByType: "member" | "agent";
  created_by_type?: "member" | "agent";
  createdById: string;
  created_by_id?: string;
  lastRunAt: string | null;
  last_run_at?: string | null;
  createdAt: string;
  created_at?: string;
  updatedAt: string;
  updated_at?: string;
}

export interface MultiremiAutopilotTrigger {
  id: string;
  autopilotId: string;
  kind: MultiremiAutopilotTriggerKind;
  enabled: boolean;
  cronExpression: string | null;
  timezone: string | null;
  nextRunAt: string | null;
  webhookToken: string | null;
  webhookPath: string | null;
  webhookUrl: string | null;
  provider: MultiremiWebhookProvider | null;
  label: string | null;
  eventFilters: MultiremiWebhookEventFilter[] | null;
  signingSecretSet: boolean;
  signingSecretHint: string | null;
  lastFiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MultiremiAutopilotRun {
  id: string;
  autopilotId: string;
  source: MultiremiAutopilotRunSource;
  status: MultiremiAutopilotRunStatus;
  issueId: string | null;
  taskId: string | null;
  triggeredAt: string;
  completedAt: string | null;
  failureReason: string | null;
  payload: unknown | null;
  result: unknown | null;
  createdAt: string;
}

export interface MultiremiWebhookDelivery {
  id: string;
  workspaceId: string;
  autopilotId: string;
  triggerId: string;
  provider: MultiremiWebhookProvider;
  event: string;
  dedupeKey: string | null;
  dedupeSource: string | null;
  signatureStatus: MultiremiWebhookSignatureStatus;
  status: MultiremiWebhookDeliveryStatus;
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

export interface MultiremiWebhookDeliveryResult {
  status: MultiremiWebhookDeliveryResultStatus;
  duplicate: boolean;
  delivery: MultiremiWebhookDelivery;
  run: MultiremiAutopilotRun | null;
}

export interface MultiremiAnalyticsEvent {
  id: string;
  name: MultiremiAnalyticsEventName;
  distinctId: string;
  workspaceId: string | null;
  properties: Record<string, unknown>;
  metricsOnly: boolean;
  createdAt: string;
}

export interface MultiremiMetricCounter {
  name: string;
  labels: Record<string, string>;
  value: number;
}

export interface MultiremiChatSession {
  id: string;
  workspaceId: string;
  creatorId: string | null;
  agentId: string;
  title: string;
  status: MultiremiChatSessionStatus;
  sessionId: string | null;
  workDir: string | null;
  latestTaskId: string | null;
  unreadSince: string | null;
  hasUnread: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MultiremiChatMessage {
  id: string;
  chatSessionId: string;
  taskId: string | null;
  role: MultiremiChatMessageRole;
  body: string;
  failureReason: string | null;
  elapsedMs: number | null;
  createdAt: string;
}

export interface MultiremiTask {
  id: string;
  agentId: string;
  runtimeId: string | null;
  issueId: string | null;
  chatSessionId: string | null;
  autopilotRunId: string | null;
  triggerCommentId: string | null;
  trigger_comment_id?: string | null;
  triggerSummary: string | null;
  trigger_summary?: string | null;
  triggerThreadId?: string | null;
  trigger_thread_id?: string | null;
  triggerCommentContent?: string | null;
  trigger_comment_content?: string | null;
  triggerAuthorType?: string | null;
  trigger_author_type?: string | null;
  triggerAuthorName?: string | null;
  trigger_author_name?: string | null;
  newCommentCount?: number | null;
  new_comment_count?: number | null;
  newCommentsSince?: string | null;
  new_comments_since?: string | null;
  priorSessionId?: string | null;
  prior_session_id?: string | null;
  priorWorkDir?: string | null;
  prior_work_dir?: string | null;
  session_id?: string | null;
  authToken?: string | null;
  auth_token?: string | null;
  chatMessage?: string | null;
  chat_message?: string | null;
  chatMessageAttachments?: unknown[];
  chat_message_attachments?: unknown[];
  autopilotId?: string | null;
  autopilot_id?: string | null;
  autopilotSource?: string | null;
  autopilot_source?: string | null;
  autopilotTitle?: string | null;
  autopilot_title?: string | null;
  autopilotDescription?: string | null;
  autopilot_description?: string | null;
  autopilotTriggerPayload?: unknown | null;
  autopilot_trigger_payload?: unknown | null;
  quickCreatePrompt?: string | null;
  quick_create_prompt?: string | null;
  workspaceContext?: string | null;
  workspace_context?: string | null;
  requestingUserName?: string | null;
  requesting_user_name?: string | null;
  requestingUserProfileDescription?: string | null;
  requesting_user_profile_description?: string | null;
  workspaceId: string;
  status: MultiremiTaskStatus;
  priority: number;
  prompt: string;
  attempt: number;
  maxAttempts: number;
  parentTaskId: string | null;
  result: string | null;
  error: string | null;
  failureReason: string | null;
  failure_reason?: string | null;
  branchName: string | null;
  sessionId: string | null;
  workDir: string | null;
  progressSummary: string | null;
  progressStep: number | null;
  progressTotal: number | null;
  waitReason: string | null;
  wait_reason?: string | null;
  usage: TaskUsageEntry[];
  createdAt: string;
  updatedAt: string;
  dispatchedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  cancelledAt: string | null;
}

export interface MultiremiTaskTriggerMetadata {
  triggerThreadId: string | null;
  triggerCommentContent: string | null;
  triggerAuthorType: string | null;
  triggerAuthorName: string | null;
  newCommentCount: number;
  newCommentsSince: string | null;
}

export interface MultiremiTaskWithAgent extends MultiremiTask {
  agent: MultiremiAgent | null;
  issue: MultiremiIssue | null;
  project: MultiremiProject | null;
  projectResources: MultiremiProjectResource[];
  repos: MultiremiRepoData[];
}

export interface MultiremiTaskMessage {
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
  /** Total context tokens consumed, for bridges (ACP `used`) that report no input/output split. */
  totalTokens?: number;
}

export interface CreateAgentInput {
  id?: string;
  name: string;
  provider: MultiremiAgentProvider;
  template?: string | null;
  description?: string | null;
  avatarUrl?: string | null;
  avatar_url?: string | null;
  workspaceId?: string | null;
  workspace_id?: string | null;
  ownerId?: string | null;
  owner_id?: string | null;
  visibility?: MultiremiAgentVisibility | string | null;
  runtimeId?: string | null;
  runtime_id?: string | null;
  instructions?: string;
  skills?: MultiremiSkill[];
  maxConcurrentTasks?: number;
  max_concurrent_tasks?: number;
  cwd?: string | null;
  executable?: string | null;
  model?: string | null;
  allowedTools?: string[];
  allowed_tools?: string[];
  customEnv?: Record<string, string>;
  custom_env?: Record<string, string>;
  customArgs?: string[];
  custom_args?: string[];
  mcpConfig?: unknown | null;
  mcp_config?: unknown | null;
  thinkingLevel?: string | null;
  thinking_level?: string | null;
}

export interface CreateAgentFromTemplateInput {
  templateSlug?: string;
  template_slug?: string;
  name: string;
  runtimeId?: string | null;
  runtime_id?: string | null;
  provider?: MultiremiAgentProvider | null;
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
  agent: MultiremiAgent;
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
  files?: MultiremiSkillFile[];
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
  files?: MultiremiSkillFile[];
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
  userId?: string | null;
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
  description?: string | null;
  avatarUrl?: string | null;
  avatar_url?: string | null;
  provider?: MultiremiAgentProvider;
  workspaceId?: string | null;
  workspace_id?: string | null;
  ownerId?: string | null;
  owner_id?: string | null;
  visibility?: MultiremiAgentVisibility | string | null;
  runtimeId?: string | null;
  runtime_id?: string | null;
  instructions?: string;
  skills?: MultiremiSkill[];
  maxConcurrentTasks?: number;
  max_concurrent_tasks?: number;
  cwd?: string | null;
  executable?: string | null;
  model?: string | null;
  allowedTools?: string[];
  allowed_tools?: string[];
  customEnv?: Record<string, string>;
  custom_env?: Record<string, string>;
  customArgs?: string[];
  custom_args?: string[];
  mcpConfig?: unknown | null;
  mcp_config?: unknown | null;
  thinkingLevel?: string | null;
  thinking_level?: string | null;
}

export interface RegisterRuntimeInput {
  id?: string;
  name: string;
  provider: MultiremiAgentProvider | "any";
  daemonId?: string | null;
  daemon_id?: string | null;
  legacyDaemonId?: string | null;
  legacy_daemon_id?: string | null;
  runtimeMode?: string | null;
  runtime_mode?: string | null;
  deviceInfo?: string | null;
  device_info?: string | null;
  metadata?: Record<string, unknown> | null;
  workspaceId?: string | null;
  workspace_id?: string | null;
  ownerId?: string | null;
  owner_id?: string | null;
  visibility?: MultiremiRuntimeVisibility | string;
  status?: MultiremiRuntimeStatus;
  maxConcurrency?: number;
  max_concurrency?: number;
  models?: MultiremiRuntimeModel[];
}

export interface UpdateMultiremiUserInput {
  name?: string;
  email?: string;
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

export interface CreateCloudRuntimeNodeInput {
  instanceType?: string;
  instance_type?: string;
  name?: string;
  region?: string;
  imageId?: string;
  image_id?: string;
  subnetId?: string;
  subnet_id?: string;
  tags?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export interface UpdateRuntimeInput {
  name?: string;
  ownerId?: string | null;
  owner_id?: string | null;
  visibility?: MultiremiRuntimeVisibility | string;
  maxConcurrency?: number;
  max_concurrency?: number;
  runtimeMode?: string | null;
  runtime_mode?: string | null;
  deviceInfo?: string | null;
  device_info?: string | null;
  metadata?: Record<string, unknown> | null;
  models?: MultiremiRuntimeModel[];
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
  skills?: MultiremiRuntimeLocalSkillSummary[];
  supported?: boolean;
  error?: string;
}

export interface CreateRuntimeDirectoryScanInput {
  root?: string;
  maxDepth?: number;
  max_depth?: number;
  mode?: "scan" | "browse";
}

export interface ReportRuntimeDirectoryScanInput {
  status?: "completed" | "failed";
  candidates?: MultiremiRuntimeDirectoryCandidate[];
  supported?: boolean;
  error?: string;
  // Expanded absolute root the daemon browsed (browse mode); merged into params.
  resolvedRoot?: string;
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
    files?: MultiremiSkillFile[];
  } | null;
  error?: string;
}

export interface ReportRuntimeModelListInput {
  status?: string;
  models?: MultiremiRuntimeModel[];
  supported?: boolean;
  error?: string;
}

export interface CreateRuntimeUpdateInput {
  targetVersion?: string;
  target_version?: string;
  scope?: MultiremiRuntimeUpdateScope;
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
  priority?: MultiremiIssuePriority | string;
  workspaceId?: string | null;
  workspace_id?: string | null;
  projectId?: string | null;
  project_id?: string | null;
  parentIssueId?: string | null;
  parent_issue_id?: string | null;
  assigneeType?: MultiremiAssigneeType | null;
  assignee_type?: MultiremiAssigneeType | null;
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
  created_by?: string | null;
}

export interface CreateIssueWithTaskInput extends CreateIssueInput {
  agentId?: string;
  prompt?: string;
}

export interface UpdateIssueInput {
  title?: string;
  description?: string | null;
  status?: string;
  priority?: MultiremiIssuePriority | string;
  projectId?: string | null;
  project_id?: string | null;
  workspaceId?: string | null;
  workspace_id?: string | null;
  parentIssueId?: string | null;
  parent_issue_id?: string | null;
  assigneeType?: MultiremiAssigneeType | null;
  assignee_type?: MultiremiAssigneeType | null;
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
  assigneeTypes?: MultiremiAssigneeType[];
  assignee_types?: MultiremiAssigneeType[];
  assigneeId?: string | null;
  assignee_id?: string | null;
  assigneeIds?: string[];
  assignee_ids?: string[];
  projectId?: string | null;
  project_id?: string | null;
  projectIds?: string[];
  project_ids?: string[];
  metadata?: Record<string, string | number | boolean> | null;
  includeNoAssignee?: boolean;
  includeNoProject?: boolean;
  limit?: number;
  offset?: number;
}

export interface AssignIssueInput {
  assigneeType?: MultiremiAssigneeType | null;
  assignee_type?: MultiremiAssigneeType | null;
  assigneeId?: string | null;
  assignee_id?: string | null;
  prompt?: string | null;
  actorType?: string | null;
  actor_type?: string | null;
  actorId?: string | null;
  actor_id?: string | null;
}

export interface AssignIssueResult {
  issue: MultiremiIssue;
  task: MultiremiTask | null;
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
  issue: MultiremiIssue;
  task: MultiremiTask;
}

export interface CreateIssueDependencyInput {
  id?: string;
  dependsOnIssueId?: string;
  depends_on_issue_id?: string;
  type?: MultiremiIssueDependencyType | string;
}

export interface CreateIssueCommentInput {
  authorType?: string;
  authorId?: string | null;
  parentId?: string | null;
  parent_id?: string | null;
  attachmentIds?: string[];
  attachment_ids?: string[];
  body?: string;
  content?: string;
}

export interface UpdateIssueCommentInput {
  body?: string;
  content?: string;
  attachmentIds?: string[];
  attachment_ids?: string[];
}

export interface CreateMultiremiReactionInput {
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
  chatSessionId?: string | null;
  chat_session_id?: string | null;
  chatMessageId?: string | null;
  chat_message_id?: string | null;
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
  itemType?: MultiremiPinnedItemType | string;
  item_type?: MultiremiPinnedItemType | string;
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
  workspace_id?: string | null;
  status?: MultiremiProjectStatus;
  priority?: MultiremiProjectPriority;
  leadType?: "member" | "agent" | null;
  lead_type?: "member" | "agent" | null;
  leadId?: string | null;
  lead_id?: string | null;
  resources?: CreateProjectResourceInput[];
}

export interface UpdateProjectInput {
  title?: string;
  description?: string | null;
  icon?: string | null;
  status?: MultiremiProjectStatus;
  priority?: MultiremiProjectPriority;
  leadType?: "member" | "agent" | null;
  lead_type?: "member" | "agent" | null;
  leadId?: string | null;
  lead_id?: string | null;
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

export interface UpdateProjectResourceInput {
  resourceRef?: Record<string, unknown>;
  resource_ref?: Record<string, unknown>;
  label?: string | null;
  position?: number | null;
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
  memberType: MultiremiSquadMemberType;
  memberId: string;
  role?: string;
}

export interface RemoveSquadMemberInput {
  memberType: MultiremiSquadMemberType;
  memberId: string;
}

export interface CreateAutopilotInput {
  id?: string;
  title: string;
  description?: string | null;
  projectId?: string | null;
  project_id?: string | null;
  workspaceId?: string | null;
  workspace_id?: string | null;
  assigneeType?: MultiremiAutopilotAssigneeType;
  assignee_type?: MultiremiAutopilotAssigneeType;
  assigneeId: string;
  assignee_id?: string;
  status?: MultiremiAutopilotStatus;
  executionMode?: MultiremiAutopilotExecutionMode;
  execution_mode?: MultiremiAutopilotExecutionMode;
  issueTitleTemplate?: string | null;
  issue_title_template?: string | null;
  triggerKind?: string;
  trigger_kind?: string;
  triggerLabel?: string | null;
  trigger_label?: string | null;
  cronExpression?: string | null;
  cron_expression?: string | null;
  createdByType?: "member" | "agent";
  created_by_type?: "member" | "agent";
  createdById?: string | null;
  created_by_id?: string | null;
}

export interface CreateAutopilotTriggerInput {
  kind?: MultiremiAutopilotTriggerKind;
  cronExpression?: string | null;
  cron_expression?: string | null;
  timezone?: string | null;
  label?: string | null;
  provider?: MultiremiWebhookProvider | string | null;
  enabled?: boolean;
  eventFilters?: MultiremiWebhookEventFilter[] | null;
  event_filters?: MultiremiWebhookEventFilter[] | null;
}

export interface UpdateAutopilotTriggerInput {
  enabled?: boolean;
  cronExpression?: string | null;
  cron_expression?: string | null;
  timezone?: string | null;
  label?: string | null;
  eventFilters?: MultiremiWebhookEventFilter[] | null;
  event_filters?: MultiremiWebhookEventFilter[] | null;
}

export interface UpdateAutopilotInput {
  title?: string;
  description?: string | null;
  projectId?: string | null;
  assigneeType?: MultiremiAutopilotAssigneeType;
  assigneeId?: string;
  status?: MultiremiAutopilotStatus;
  executionMode?: MultiremiAutopilotExecutionMode;
  issueTitleTemplate?: string | null;
  triggerKind?: string;
  triggerLabel?: string | null;
  cronExpression?: string | null;
}

export interface RunAutopilotInput {
  source?: MultiremiAutopilotRunSource;
  prompt?: string | null;
  payload?: unknown | null;
}

export interface CreateTaskInput {
  id?: string;
  agentId: string;
  runtimeId?: string | null;
  runtime_id?: string | null;
  issueId?: string | null;
  chatSessionId?: string | null;
  triggerCommentId?: string | null;
  trigger_comment_id?: string | null;
  triggerSummary?: string | null;
  trigger_summary?: string | null;
  workspaceId?: string | null;
  priority?: number;
  prompt: string;
  workDir?: string | null;
  sessionId?: string | null;
  attempt?: number | null;
  maxAttempts?: number | null;
  parentTaskId?: string | null;
  parent_task_id?: string | null;
  /**
   * Resume-unsafe retry: abandon the chat session's promoted provider session.
   * Skips session/work_dir inheritance and chat-session runtime affinity so the
   * task truly restarts in the pool rather than resuming the failed session on
   * the original machine. local_directory affinity still applies.
   */
  resetProviderSession?: boolean;
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
  agentId?: string;
  agent_id?: string;
  workspaceId?: string | null;
  workspace_id?: string | null;
  creatorId?: string | null;
  creator_id?: string | null;
  title?: string | null;
}

export interface UpdateChatSessionInput {
  title?: string;
  status?: MultiremiChatSessionStatus;
}

export interface SendChatMessageInput {
  body?: string | null;
  content?: string | null;
  attachmentIds?: string[];
  attachment_ids?: string[];
}

export interface SendChatMessageResult {
  session: MultiremiChatSession;
  message: MultiremiChatMessage;
  task: MultiremiTask;
}
