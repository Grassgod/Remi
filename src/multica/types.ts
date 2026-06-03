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
  title: string;
  description: string | null;
  status: string;
  workspaceId: string;
  projectId: string | null;
  assigneeType: MulticaAssigneeType | null;
  assigneeId: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MulticaIssueWithTasks extends MulticaIssue {
  tasks: MulticaTask[];
}

export interface MulticaIssueComment {
  id: string;
  issueId: string;
  authorType: string;
  authorId: string | null;
  body: string;
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

export interface MulticaTask {
  id: string;
  agentId: string;
  runtimeId: string | null;
  issueId: string | null;
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
  body: string;
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
