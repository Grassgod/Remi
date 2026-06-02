export type MulticaAgentProvider = "claude" | "codex" | string;

export type MulticaTaskStatus =
  | "queued"
  | "dispatched"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type MulticaRuntimeStatus = "online" | "offline";

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

export interface MulticaIssue {
  id: string;
  title: string;
  description: string | null;
  status: string;
  workspaceId: string;
  projectId: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
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
  createdBy?: string | null;
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
