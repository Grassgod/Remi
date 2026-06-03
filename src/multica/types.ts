export type MulticaAgentProvider = "claude" | "codex" | string;

export type MulticaTaskStatus =
  | "queued"
  | "dispatched"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type MulticaRuntimeStatus = "online" | "offline";
export type MulticaProjectStatus = "planned" | "in_progress" | "paused" | "completed" | "cancelled";
export type MulticaProjectPriority = "urgent" | "high" | "medium" | "low" | "none";
export type MulticaAssigneeType = "agent" | "member" | "squad";
export type MulticaSquadMemberType = "agent" | "member";
export type MulticaAutopilotStatus = "active" | "paused" | "archived";
export type MulticaAutopilotExecutionMode = "create_issue" | "run_only";
export type MulticaAutopilotAssigneeType = "agent" | "squad";
export type MulticaAutopilotRunStatus = "issue_created" | "running" | "completed" | "failed" | "skipped";
export type MulticaAutopilotRunSource = "manual" | "schedule" | "webhook" | "api";
export type MulticaChatSessionStatus = "active" | "archived";
export type MulticaChatMessageRole = "user" | "assistant" | "system";
export type MulticaSubscriptionReason = "created" | "assigned" | "commented" | "mentioned" | "manual";
export type MulticaPinnedItemType = "issue" | "project";

export interface MulticaSkillFile {
  path: string;
  content: string;
}

export interface MulticaSkill {
  name: string;
  description?: string;
  content: string;
  files?: MulticaSkillFile[];
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
  status: MulticaRuntimeStatus;
  maxConcurrency: number;
  lastHeartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
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
  workspaceId: string;
  projectId: string | null;
  assigneeType: MulticaAssigneeType | null;
  assigneeId: string | null;
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
  maxConcurrency?: number;
}

export interface CreateIssueInput {
  id?: string;
  title: string;
  description?: string | null;
  workspaceId?: string | null;
  projectId?: string | null;
  assigneeType?: MulticaAssigneeType | null;
  assigneeId?: string | null;
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
  projectId?: string | null;
  workspaceId?: string | null;
  assigneeType?: MulticaAssigneeType | null;
  assigneeId?: string | null;
}

export interface AssignIssueInput {
  assigneeType?: MulticaAssigneeType | null;
  assigneeId?: string | null;
  prompt?: string | null;
}

export interface AssignIssueResult {
  issue: MulticaIssue;
  task: MulticaTask | null;
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
