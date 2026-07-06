import type {
  MultiremiDaemonHeartbeatAck,
  MultiremiRepoData,
  MultiremiRuntimeDirectoryCandidate,
  MultiremiRuntimeModel,
  MultiremiRuntimeLocalSkillSummary,
  MultiremiSkillFile,
  MultiremiTaskStatus,
  MultiremiTaskWithAgent,
  RegisterRuntimeInput,
  TaskMessageInput,
  TaskUsageEntry,
} from "@multiremi/contracts/types.js";

export interface MultiremiWorkspaceReposResponse {
  workspace_id: string;
  repos: MultiremiRepoData[];
  repos_version: string;
  settings?: Record<string, unknown>;
}

export interface MultiremiDaemonRegisterRuntimeInput {
  workspaceId: string;
  daemonId: string;
  deviceName?: string;
  cliVersion?: string;
  launchedBy?: string | null;
  runtime: {
    name: string;
    type: string;
    version: string;
    status?: "online" | "offline";
    maxConcurrency?: number;
    acpVersion?: string | null;
    agentVersion?: string | null;
  };
}

export interface MultiremiDaemonRegisterResponse {
  workspace_id?: string;
  repos: MultiremiRepoData[];
  repos_version: string;
  settings?: Record<string, unknown>;
  runtimes: Array<{ id: string; provider?: string; type?: string }>;
}

export interface MultiremiDaemonGcStatus {
  status: string;
  updated_at?: string | null;
  completed_at?: string | null;
}

export interface MultiremiRecoverOrphansResult {
  orphaned: number;
  retried: number;
}

export class MultiremiDaemonClient {
  private baseUrl: string;
  private token: string | null;

  constructor(baseUrl: string, token?: string | null) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token ?? null;
  }

  async registerRuntime(input: RegisterRuntimeInput): Promise<{ runtime: { id: string } }> {
    return this.post("/api/multiremi/runtimes", input);
  }

  async registerDaemonRuntime(input: MultiremiDaemonRegisterRuntimeInput): Promise<MultiremiDaemonRegisterResponse> {
    return this.post("/api/daemon/register", {
      workspace_id: input.workspaceId,
      daemon_id: input.daemonId,
      device_name: input.deviceName ?? "",
      cli_version: input.cliVersion ?? "",
      launched_by: input.launchedBy ?? "",
      runtimes: [input.runtime],
    });
  }

  async recoverOrphans(runtimeId: string): Promise<MultiremiRecoverOrphansResult> {
    return this.post(`/api/daemon/runtimes/${runtimeId}/recover-orphans`, {});
  }

  async claimTask(runtimeId: string): Promise<any | null> {
    const resp = await this.post<{ task: any | null }>(`/api/daemon/runtimes/${runtimeId}/tasks/claim`, {});
    return normalizeDaemonClaimTask(resp.task);
  }

  async heartbeatRuntime(runtimeId: string): Promise<MultiremiDaemonHeartbeatAck> {
    let resp: Partial<MultiremiDaemonHeartbeatAck>;
    try {
      resp = await this.post<Partial<MultiremiDaemonHeartbeatAck>>("/api/daemon/heartbeat", {
        runtime_id: runtimeId,
        supports_batch_import: true,
        supports_directory_scan: true,
      });
    } catch (error) {
      if (isRuntimeGoneHeartbeatError(error)) {
        return { runtime_id: runtimeId, status: "runtime_gone", runtime_gone: true };
      }
      throw error;
    }
    return {
      runtime_id: runtimeId,
      status: resp.status ?? "ok",
      ...resp,
    } as MultiremiDaemonHeartbeatAck;
  }

  async getWorkspaceRepos(workspaceId: string): Promise<MultiremiWorkspaceReposResponse> {
    return this.get<MultiremiWorkspaceReposResponse>(`/api/daemon/workspaces/${encodeURIComponent(workspaceId)}/repos`);
  }

  async reportRuntimeUpdateResult(runtimeId: string, requestId: string, result: { status: string; output?: string; error?: string }): Promise<void> {
    await this.post(`/api/daemon/runtimes/${runtimeId}/update/${requestId}/result`, result);
  }

  async reportRuntimeModelListResult(runtimeId: string, requestId: string, result: {
    status: string;
    models?: MultiremiRuntimeModel[];
    supported?: boolean;
    error?: string;
  }): Promise<void> {
    await this.post(`/api/daemon/runtimes/${runtimeId}/models/${requestId}/result`, result);
  }

  async reportRuntimeLocalSkillListResult(runtimeId: string, requestId: string, result: {
    status: string;
    skills?: MultiremiRuntimeLocalSkillSummary[];
    supported?: boolean;
    error?: string;
  }): Promise<void> {
    await this.post(`/api/daemon/runtimes/${runtimeId}/local-skills/${requestId}/result`, result);
  }

  async reportRuntimeDirectoryScanResult(runtimeId: string, requestId: string, result: {
    status: string;
    candidates?: MultiremiRuntimeDirectoryCandidate[];
    supported?: boolean;
    error?: string;
    resolvedRoot?: string;
  }): Promise<void> {
    await this.post(`/api/daemon/runtimes/${runtimeId}/directory-scans/${requestId}/result`, result);
  }

  async reportRuntimeLocalSkillImportResult(runtimeId: string, requestId: string, result: {
    status: string;
    skill?: {
      name?: string;
      description?: string;
      content?: string;
      source_path?: string;
      provider?: string;
      files?: MultiremiSkillFile[];
    } | null;
    error?: string;
  }): Promise<void> {
    await this.post(`/api/daemon/runtimes/${runtimeId}/local-skills/import/${requestId}/result`, result);
  }

  async startTask(taskId: string): Promise<void> {
    await this.post(`/api/daemon/tasks/${taskId}/start`, {});
  }

  async markTaskWaitingLocalDirectory(taskId: string, reason: string): Promise<void> {
    await this.post(`/api/daemon/tasks/${taskId}/wait-local-directory`, { reason });
  }

  async reportProgress(taskId: string, summary: string, step?: number, total?: number): Promise<void> {
    await this.post(`/api/daemon/tasks/${taskId}/progress`, { summary, step, total });
  }

  async reportTaskMessages(taskId: string, messages: TaskMessageInput[]): Promise<void> {
    await this.post(`/api/daemon/tasks/${taskId}/messages`, { messages });
  }

  async pinTaskSession(taskId: string, sessionId?: string | null, workDir?: string | null): Promise<void> {
    await this.post(`/api/daemon/tasks/${taskId}/session`, {
      session_id: sessionId ?? undefined,
      work_dir: workDir ?? undefined,
    });
  }

  async completeTask(taskId: string, output: string, sessionId?: string | null, workDir?: string | null): Promise<void> {
    await this.post(`/api/daemon/tasks/${taskId}/complete`, {
      output,
      session_id: sessionId ?? undefined,
      work_dir: workDir ?? undefined,
    });
  }

  async failTask(taskId: string, error: string, sessionId?: string | null, workDir?: string | null, failureReason?: string | null): Promise<void> {
    await this.post(`/api/daemon/tasks/${taskId}/fail`, {
      error,
      session_id: sessionId ?? undefined,
      work_dir: workDir ?? undefined,
      failure_reason: failureReason ?? undefined,
    });
  }

  async reportTaskUsage(taskId: string, usage: TaskUsageEntry[]): Promise<void> {
    if (usage.length === 0) return;
    await this.post(`/api/daemon/tasks/${taskId}/usage`, {
      usage: usage.map((entry) => ({
        provider: entry.provider,
        model: entry.model,
        input_tokens: entry.inputTokens,
        output_tokens: entry.outputTokens,
        cache_read_tokens: entry.cacheReadTokens ?? 0,
        cache_write_tokens: entry.cacheWriteTokens ?? 0,
      })),
    });
  }

  async getTaskStatus(taskId: string): Promise<MultiremiTaskStatus> {
    const resp = await this.get<{ status: MultiremiTaskStatus }>(`/api/daemon/tasks/${taskId}/status`);
    return resp.status;
  }

  async getIssueGcCheck(issueId: string): Promise<MultiremiDaemonGcStatus> {
    return this.get<MultiremiDaemonGcStatus>(`/api/daemon/issues/${encodeURIComponent(issueId)}/gc-check`);
  }

  async getChatSessionGcCheck(sessionId: string): Promise<MultiremiDaemonGcStatus> {
    return this.get<MultiremiDaemonGcStatus>(`/api/daemon/chat-sessions/${encodeURIComponent(sessionId)}/gc-check`);
  }

  async getAutopilotRunGcCheck(runId: string): Promise<MultiremiDaemonGcStatus> {
    return this.get<MultiremiDaemonGcStatus>(`/api/daemon/autopilot-runs/${encodeURIComponent(runId)}/gc-check`);
  }

  async getTaskGcCheck(taskId: string): Promise<MultiremiDaemonGcStatus> {
    return this.get<MultiremiDaemonGcStatus>(`/api/daemon/tasks/${encodeURIComponent(taskId)}/gc-check`);
  }

  private async get<T>(path: string): Promise<T> {
    const resp = await fetch(this.baseUrl + path, { headers: this.headers() });
    return parseResponse<T>(resp, "GET", path);
  }

  private async post<T = unknown>(path: string, body: unknown): Promise<T> {
    const resp = await fetch(this.baseUrl + path, {
      method: "POST",
      headers: this.headers("application/json"),
      body: JSON.stringify(body),
    });
    return parseResponse<T>(resp, "POST", path);
  }

  private headers(contentType?: string): HeadersInit {
    const headers: Record<string, string> = {};
    if (contentType) headers["Content-Type"] = contentType;
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }
}

async function parseResponse<T>(resp: Response, method: string, path: string): Promise<T> {
  if (resp.ok) {
    if (resp.status === 204) return undefined as T;
    const text = await resp.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
  const text = await resp.text();
  throw new Error(`${method} ${path} returned ${resp.status}: ${text}`);
}

function isRuntimeGoneHeartbeatError(error: unknown): boolean {
  return error instanceof Error
    && error.message.includes("POST /api/daemon/heartbeat returned 404")
    && error.message.includes("runtime not found");
}

function normalizeDaemonClaimTask(raw: any | null): MultiremiTaskWithAgent | null {
  if (!raw) return null;
  const normalized = {
    ...raw,
    agentId: stringOrNull(raw.agent_id ?? raw.agentId) ?? "",
    runtimeId: stringOrNull(raw.runtime_id ?? raw.runtimeId),
    issueId: stringOrNull(raw.issue_id ?? raw.issueId),
    chatSessionId: stringOrNull(raw.chat_session_id ?? raw.chatSessionId),
    autopilotRunId: stringOrNull(raw.autopilot_run_id ?? raw.autopilotRunId),
    triggerCommentId: stringOrNull(raw.trigger_comment_id ?? raw.triggerCommentId),
    triggerSummary: stringOrNull(raw.trigger_summary ?? raw.triggerSummary),
    triggerThreadId: stringOrNull(raw.trigger_thread_id ?? raw.triggerThreadId),
    triggerCommentContent: stringOrNull(raw.trigger_comment_content ?? raw.triggerCommentContent),
    triggerAuthorType: stringOrNull(raw.trigger_author_type ?? raw.triggerAuthorType),
    triggerAuthorName: stringOrNull(raw.trigger_author_name ?? raw.triggerAuthorName),
    newCommentCount: numberOrNull(raw.new_comment_count ?? raw.newCommentCount),
    newCommentsSince: stringOrNull(raw.new_comments_since ?? raw.newCommentsSince),
    workspaceId: stringOrNull(raw.workspace_id ?? raw.workspaceId) ?? "local",
    maxAttempts: numberOrDefault(raw.max_attempts ?? raw.maxAttempts, 1),
    parentTaskId: stringOrNull(raw.parent_task_id ?? raw.parentTaskId),
    failureReason: stringOrNull(raw.failure_reason ?? raw.failureReason),
    branchName: stringOrNull(raw.branch_name ?? raw.branchName),
    sessionId: stringOrNull(raw.session_id ?? raw.sessionId ?? raw.prior_session_id),
    priorSessionId: stringOrNull(raw.prior_session_id ?? raw.priorSessionId ?? raw.session_id ?? raw.sessionId),
    workDir: stringOrNull(raw.work_dir ?? raw.workDir),
    priorWorkDir: stringOrNull(raw.prior_work_dir ?? raw.priorWorkDir ?? raw.work_dir ?? raw.workDir),
    authToken: stringOrNull(raw.auth_token ?? raw.authToken),
    chatMessage: stringOrNull(raw.chat_message ?? raw.chatMessage),
    chatMessageAttachments: Array.isArray(raw.chat_message_attachments)
      ? raw.chat_message_attachments
      : Array.isArray(raw.chatMessageAttachments)
        ? raw.chatMessageAttachments
        : [],
    autopilotId: stringOrNull(raw.autopilot_id ?? raw.autopilotId),
    autopilotSource: stringOrNull(raw.autopilot_source ?? raw.autopilotSource),
    autopilotTitle: stringOrNull(raw.autopilot_title ?? raw.autopilotTitle),
    autopilotDescription: stringOrNull(raw.autopilot_description ?? raw.autopilotDescription),
    autopilotTriggerPayload: raw.autopilot_trigger_payload ?? raw.autopilotTriggerPayload ?? null,
    quickCreatePrompt: stringOrNull(raw.quick_create_prompt ?? raw.quickCreatePrompt),
    workspaceContext: stringOrNull(raw.workspace_context ?? raw.workspaceContext),
    requestingUserName: stringOrNull(raw.requesting_user_name ?? raw.requestingUserName),
    requestingUserProfileDescription: stringOrNull(raw.requesting_user_profile_description ?? raw.requestingUserProfileDescription),
    progressSummary: stringOrNull(raw.progress_summary ?? raw.progressSummary),
    progressStep: numberOrNull(raw.progress_step ?? raw.progressStep),
    progressTotal: numberOrNull(raw.progress_total ?? raw.progressTotal),
    waitReason: stringOrNull(raw.wait_reason ?? raw.waitReason),
    createdAt: stringOrNull(raw.created_at ?? raw.createdAt) ?? "",
    updatedAt: stringOrNull(raw.updated_at ?? raw.updatedAt) ?? stringOrNull(raw.created_at) ?? "",
    dispatchedAt: stringOrNull(raw.dispatched_at ?? raw.dispatchedAt),
    startedAt: stringOrNull(raw.started_at ?? raw.startedAt),
    completedAt: stringOrNull(raw.completed_at ?? raw.completedAt),
    failedAt: stringOrNull(raw.failed_at ?? raw.failedAt),
    cancelledAt: stringOrNull(raw.cancelled_at ?? raw.cancelledAt),
    agent: normalizeDaemonClaimAgent(raw.agent),
    issue: normalizeDaemonClaimIssue(raw.issue),
    project: normalizeDaemonClaimProject(raw.project),
    projectResources: normalizeDaemonClaimProjectResources(raw.project_resources ?? raw.projectResources),
    repos: Array.isArray(raw.repos) ? raw.repos : [],
    usage: Array.isArray(raw.usage) ? raw.usage : [],
  };
  return normalized as MultiremiTaskWithAgent;
}

function normalizeDaemonClaimAgent(raw: any): MultiremiTaskWithAgent["agent"] {
  if (!raw || typeof raw !== "object") return null;
  return {
    ...raw,
    workspaceId: stringOrNull(raw.workspace_id ?? raw.workspaceId) ?? "",
    ownerId: stringOrNull(raw.owner_id ?? raw.ownerId) ?? "",
    runtimeId: stringOrNull(raw.runtime_id ?? raw.runtimeId),
    maxConcurrentTasks: numberOrDefault(raw.max_concurrent_tasks ?? raw.maxConcurrentTasks, 1),
    allowedTools: Array.isArray(raw.allowed_tools) ? raw.allowed_tools : Array.isArray(raw.allowedTools) ? raw.allowedTools : [],
    customEnv: objectOrDefault(raw.custom_env ?? raw.customEnv),
    customArgs: Array.isArray(raw.custom_args) ? raw.custom_args : Array.isArray(raw.customArgs) ? raw.customArgs : [],
    mcpConfig: raw.mcp_config ?? raw.mcpConfig ?? null,
    thinkingLevel: stringOrNull(raw.thinking_level ?? raw.thinkingLevel),
    archivedAt: stringOrNull(raw.archived_at ?? raw.archivedAt),
    createdAt: stringOrNull(raw.created_at ?? raw.createdAt) ?? "",
    updatedAt: stringOrNull(raw.updated_at ?? raw.updatedAt) ?? "",
    cwd: stringOrNull(raw.cwd),
    executable: stringOrNull(raw.executable),
    model: stringOrNull(raw.model),
    skills: Array.isArray(raw.skills) ? raw.skills : [],
  };
}

function normalizeDaemonClaimIssue(raw: any): MultiremiTaskWithAgent["issue"] {
  if (!raw || typeof raw !== "object") return null;
  return {
    ...raw,
    key: stringOrNull(raw.key ?? raw.identifier) ?? "",
    workspaceId: stringOrNull(raw.workspace_id ?? raw.workspaceId) ?? "",
    projectId: stringOrNull(raw.project_id ?? raw.projectId),
    parentIssueId: stringOrNull(raw.parent_issue_id ?? raw.parentIssueId),
    assigneeType: stringOrNull(raw.assignee_type ?? raw.assigneeType) as any,
    assigneeId: stringOrNull(raw.assignee_id ?? raw.assigneeId),
    startDate: stringOrNull(raw.start_date ?? raw.startDate),
    dueDate: stringOrNull(raw.due_date ?? raw.dueDate),
    createdBy: stringOrNull(raw.creator_id ?? raw.created_by ?? raw.createdBy),
    createdAt: stringOrNull(raw.created_at ?? raw.createdAt) ?? "",
    updatedAt: stringOrNull(raw.updated_at ?? raw.updatedAt) ?? "",
    acceptanceCriteria: Array.isArray(raw.acceptance_criteria) ? raw.acceptance_criteria : Array.isArray(raw.acceptanceCriteria) ? raw.acceptanceCriteria : [],
    contextRefs: Array.isArray(raw.context_refs) ? raw.context_refs : Array.isArray(raw.contextRefs) ? raw.contextRefs : [],
    metadata: objectOrDefault(raw.metadata),
    labels: Array.isArray(raw.labels) ? raw.labels : [],
  };
}

function normalizeDaemonClaimProject(raw: any): MultiremiTaskWithAgent["project"] {
  if (!raw || typeof raw !== "object") return null;
  return {
    ...raw,
    workspaceId: stringOrNull(raw.workspace_id ?? raw.workspaceId) ?? "",
    leadType: stringOrNull(raw.lead_type ?? raw.leadType) as any,
    leadId: stringOrNull(raw.lead_id ?? raw.leadId),
    issueCount: numberOrDefault(raw.issue_count ?? raw.issueCount, 0),
    doneCount: numberOrDefault(raw.done_count ?? raw.doneCount, 0),
    resourceCount: numberOrDefault(raw.resource_count ?? raw.resourceCount, 0),
    createdAt: stringOrNull(raw.created_at ?? raw.createdAt) ?? "",
    updatedAt: stringOrNull(raw.updated_at ?? raw.updatedAt) ?? "",
  };
}

function normalizeDaemonClaimProjectResources(raw: any): MultiremiTaskWithAgent["projectResources"] {
  if (!Array.isArray(raw)) return [];
  return raw.map((resource) => ({
    ...resource,
    projectId: stringOrNull(resource.project_id ?? resource.projectId) ?? "",
    workspaceId: stringOrNull(resource.workspace_id ?? resource.workspaceId) ?? "",
    resourceType: stringOrNull(resource.resource_type ?? resource.resourceType) ?? "",
    resourceRef: objectOrDefault(resource.resource_ref ?? resource.resourceRef),
    createdAt: stringOrNull(resource.created_at ?? resource.createdAt) ?? "",
    createdBy: stringOrNull(resource.created_by ?? resource.createdBy),
  }));
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberOrDefault(value: unknown, fallback: number): number {
  return numberOrNull(value) ?? fallback;
}

function objectOrDefault(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}
