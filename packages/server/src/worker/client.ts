import { readFile } from "node:fs/promises";
import type {
  MultiremiDaemonHeartbeatAck,
  MultiremiProjectDocIndexEntry,
  MultiremiRepoData,
  MultiremiRuntimeDirectoryCandidate,
  MultiremiRuntimeModel,
  MultiremiRuntimeLocalSkillSummary,
  MultiremiSkillFile,
  MultiremiTaskHumanRequest,
  MultiremiTaskStatus,
  MultiremiTaskWithAgent,
  RegisterRuntimeInput,
  TaskMessageInput,
  TaskUsageEntry,
  MultiremiIssueWorkspaceRepo,
  MultiremiIssueWorkspaceStatus,
  MultiremiIssueWorkspaceArchiveBinding,
  MultiremiDaemonSshMeshConfig,
  MultiremiDaemonSshMeshStatus,
  ReportAgentPluginRuntimeStateInput,
} from "@multiremi/contracts/types.js";
import {
  MULTIREMI_AGENT_PLUGIN_PROTOCOL_VERSION,
  MULTIREMI_SSH_MESH_PROTOCOL_VERSION,
} from "@multiremi/contracts/types.js";

export interface MultiremiWorkspaceReposResponse {
  workspace_id: string;
  repos: MultiremiRepoData[];
  repos_version: string;
  settings?: Record<string, unknown>;
  relay?: MultiremiRelayWire;
}

export interface MultiremiDaemonRegisterRuntimeInput {
  workspaceId: string;
  daemonId: string;
  deviceName?: string;
  cliVersion?: string;
  launchedBy?: string | null;
  agentPluginProtocol?: number;
  sshMeshProtocol?: number;
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

export interface MultiremiRelayEngineWire {
  fragment: string;
  auth_token: string;
  revision: number;
}
export interface MultiremiRelayWire {
  claude: MultiremiRelayEngineWire | null;
  codex: MultiremiRelayEngineWire | null;
  model_discovery?: boolean;
}

export interface MultiremiDaemonRegisterResponse {
  workspace_id?: string;
  repos: MultiremiRepoData[];
  repos_version: string;
  settings?: Record<string, unknown>;
  relay?: MultiremiRelayWire;
  runtimes: Array<{ id: string; provider?: string; type?: string }>;
}

export interface MultiremiDaemonHeartbeatConfigAck extends MultiremiDaemonHeartbeatAck {
  workspace_settings?: Record<string, unknown>;
  relay?: MultiremiRelayWire;
}

export interface MultiremiDaemonGcStatus {
  status: string;
  updated_at?: string | null;
  completed_at?: string | null;
}

export interface MultiremiDaemonSessionArchiveWire {
  id: string;
  status: "pending" | "uploading" | "ready" | "failed" | "superseded";
  source_revision: string;
  sha256: string;
  size_bytes: number;
  attempt_count?: number;
  last_error?: string | null;
}

export interface MultiremiDaemonSessionArchiveStatus {
  latest: MultiremiDaemonSessionArchiveWire | null;
  latest_ready: MultiremiDaemonSessionArchiveWire | null;
  requested_ready: MultiremiDaemonSessionArchiveWire | null;
  gc_ready: boolean;
}

export interface MultiremiDaemonSessionArchiveInitResponse {
  archive: MultiremiDaemonSessionArchiveWire;
  upload_attempt: number | null;
  upload_url: string | null;
}

export interface MultiremiRecoverOrphansResult {
  orphaned: number;
  retried: number;
}

export interface MultiremiDaemonAgentPluginDesiredResponse {
  runtime_id: string;
  revision: string;
  plugins: unknown[];
}

export class MultiremiDaemonHttpError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly responseBody: string,
    readonly code: string | null,
  ) {
    super(`${method} ${path} returned ${status}: ${responseBody}`);
    this.name = "MultiremiDaemonHttpError";
  }
}

/** Authentication/retirement failures require operator action, not polling. */
export function isTerminalDaemonAuthorityError(error: unknown): boolean {
  return error instanceof MultiremiDaemonHttpError
    && (error.status === 401 || error.status === 403 || error.status === 410);
}

export class MultiremiDaemonClient {
  private baseUrl: string;
  private token: string | null;
  private sessionArchiveUploadAttempts = new Map<string, number>();

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
      capabilities: {
        agent_plugins: input.agentPluginProtocol ?? MULTIREMI_AGENT_PLUGIN_PROTOCOL_VERSION,
        ssh_mesh: input.sshMeshProtocol ?? MULTIREMI_SSH_MESH_PROTOCOL_VERSION,
      },
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

  async heartbeatRuntime(
    runtimeId: string,
    sshMeshStatus?: MultiremiDaemonSshMeshStatus,
    drainStatus?: { ackGeneration: number; activeTaskCount: number },
  ): Promise<MultiremiDaemonHeartbeatConfigAck> {
    let resp: Partial<MultiremiDaemonHeartbeatConfigAck>;
    try {
      resp = await this.post<Partial<MultiremiDaemonHeartbeatAck>>("/api/daemon/heartbeat", {
        runtime_id: runtimeId,
        supports_batch_import: true,
        supports_directory_scan: true,
        agent_plugin_protocol: MULTIREMI_AGENT_PLUGIN_PROTOCOL_VERSION,
        ssh_mesh_protocol: MULTIREMI_SSH_MESH_PROTOCOL_VERSION,
        ...(sshMeshStatus ? { ssh_mesh_status: sshMeshStatus } : {}),
        ...(drainStatus
          ? {
              drain_ack_generation: drainStatus.ackGeneration,
              active_task_count: drainStatus.activeTaskCount,
            }
          : {}),
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
    } as MultiremiDaemonHeartbeatConfigAck;
  }

  async getSshMeshConfig(runtimeId: string, signal?: AbortSignal): Promise<MultiremiDaemonSshMeshConfig> {
    return this.get<MultiremiDaemonSshMeshConfig>(
      `/api/daemon/ssh-mesh/config?runtime_id=${encodeURIComponent(runtimeId)}`,
      signal,
    );
  }

  async getRuntimeAgentPluginDesired(
    runtimeId: string,
  ): Promise<MultiremiDaemonAgentPluginDesiredResponse> {
    const path = `/api/daemon/runtimes/${encodeURIComponent(runtimeId)}/agent-plugins/desired`;
    try {
      return await this.get<MultiremiDaemonAgentPluginDesiredResponse>(path);
    } catch (error) {
      // A new daemon may connect to a server from before Agent Plugins existed.
      // Missing routes return an unstructured 404; a structured runtime-not-found
      // response still needs to propagate so the daemon can re-register.
      if (
        error instanceof MultiremiDaemonHttpError
        && (error.status === 404 || error.status === 405)
        && error.code !== "runtime_not_found"
        && !error.responseBody.toLowerCase().includes("runtime not found")
      ) {
        return { runtime_id: runtimeId, revision: "unsupported", plugins: [] };
      }
      throw error;
    }
  }

  async reportRuntimeAgentPluginState(
    runtimeId: string,
    versionId: string,
    input: ReportAgentPluginRuntimeStateInput,
  ): Promise<void> {
    await this.post(
      `/api/daemon/runtimes/${encodeURIComponent(runtimeId)}/agent-plugins/${encodeURIComponent(versionId)}/state`,
      input,
    );
  }

  async getWorkspaceRepos(workspaceId: string): Promise<MultiremiWorkspaceReposResponse> {
    return this.get<MultiremiWorkspaceReposResponse>(`/api/daemon/workspaces/${encodeURIComponent(workspaceId)}/repos`);
  }

  async createTaskHumanRequest(taskId: string, input: { kind: "permission" | "question"; payload: Record<string, unknown> }): Promise<MultiremiTaskHumanRequest> {
    const resp = await this.post<{ request: MultiremiTaskHumanRequest }>(`/api/daemon/tasks/${taskId}/human-requests`, input);
    return resp.request;
  }

  async getTaskHumanRequest(taskId: string, requestId: string): Promise<MultiremiTaskHumanRequest | null> {
    const resp = await this.get<{ request: MultiremiTaskHumanRequest | null }>(`/api/daemon/tasks/${taskId}/human-requests/${requestId}`);
    return resp.request ?? null;
  }

  async expireTaskHumanRequest(taskId: string, requestId: string, status: "timeout" | "cancelled"): Promise<MultiremiTaskHumanRequest | null> {
    const resp = await this.post<{ request: MultiremiTaskHumanRequest | null }>(`/api/daemon/tasks/${taskId}/human-requests/${requestId}/expire`, { status });
    return resp.request ?? null;
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

  async updateRuntimeModels(
    runtimeId: string,
    models: MultiremiRuntimeModel[],
    signal?: AbortSignal,
  ): Promise<MultiremiRuntimeModel[]> {
    const response = await this.put<{ models: MultiremiRuntimeModel[] }>(
      `/api/daemon/runtimes/${encodeURIComponent(runtimeId)}/models`,
      { models, supported: true },
      signal,
    );
    return response.models;
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

  async reportProgress(taskId: string, summary: string, step?: number, total?: number, options?: { final?: boolean }): Promise<void> {
    // `final: true` marks a terminal summary, which the server accepts even
    // after the task reached a terminal status.
    await this.post(`/api/daemon/tasks/${taskId}/progress`, {
      summary,
      step,
      total,
      ...(options?.final ? { final: true } : {}),
    });
  }

  async reportTaskMessages(taskId: string, messages: TaskMessageInput[]): Promise<void> {
    await this.post(`/api/daemon/tasks/${taskId}/messages`, { messages });
  }

  async reportTaskPrompt(taskId: string, input: { mode: "bootstrap" | "delta"; prompt: string; sha256: string }): Promise<void> {
    await this.post(`/api/daemon/tasks/${taskId}/prompt`, input);
  }

  async pinTaskSession(taskId: string, sessionId?: string | null, workDir?: string | null): Promise<void> {
    await this.post(`/api/daemon/tasks/${taskId}/session`, {
      session_id: sessionId ?? undefined,
      work_dir: workDir ?? undefined,
    });
  }

  async reportIssueWorkspace(taskId: string, input: {
    runtimeId: string;
    rootPath: string;
    branchName: string;
    status: MultiremiIssueWorkspaceStatus;
    repos: MultiremiIssueWorkspaceRepo[];
  }): Promise<void> {
    await this.post(`/api/daemon/tasks/${taskId}/workspace`, {
      runtime_id: input.runtimeId,
      root_path: input.rootPath,
      branch_name: input.branchName,
      status: input.status,
      repos: input.repos.map((repo) => ({
        repo_url: repo.repoUrl,
        repo_name: repo.repoName,
        worktree_path: repo.worktreePath,
        branch_name: repo.branchName,
        base_ref: repo.baseRef,
        status: repo.status,
        dirty: repo.dirty,
        error: repo.error,
      })),
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
        total_tokens: entry.totalTokens ?? 0,
      })),
    });
  }

  /**
   * Publish a session result on the task's issue. Sent with the task's own
   * auth token when available so the result is attributed to the agent (the
   * same identity the in-task CLI publishes with), falling back to the
   * daemon's runtime token.
   */
  async publishTaskSessionResult(
    issueId: string,
    sessionId: string,
    input: { title: string; body: string; metadata?: Record<string, unknown> },
    taskToken?: string | null,
  ): Promise<void> {
    await this.post(
      `/api/issues/${encodeURIComponent(issueId)}/sessions/${encodeURIComponent(sessionId)}/results`,
      input,
      taskToken,
    );
  }

  async getTaskStatus(taskId: string): Promise<MultiremiTaskStatus> {
    const resp = await this.get<{ status: MultiremiTaskStatus }>(`/api/daemon/tasks/${taskId}/status`);
    return resp.status;
  }

  async getIssueGcCheck(issueId: string): Promise<MultiremiDaemonGcStatus> {
    return this.get<MultiremiDaemonGcStatus>(`/api/daemon/issues/${encodeURIComponent(issueId)}/gc-check`);
  }

  async getIssueSessionArchiveStatus(
    runtimeId: string,
    issueId: string,
    sourceRevision: string,
    sha256: string,
    verifyReady = false,
  ): Promise<MultiremiDaemonSessionArchiveStatus> {
    const query = new URLSearchParams({ source_revision: sourceRevision, sha256 });
    if (verifyReady) query.set("verify_ready", "1");
    return this.get<MultiremiDaemonSessionArchiveStatus>(
      `/api/daemon/runtimes/${encodeURIComponent(runtimeId)}/issues/${encodeURIComponent(issueId)}/session-archives/status?${query}`,
    );
  }

  async initIssueSessionArchive(runtimeId: string, issueId: string, input: {
    sourceRevision: string;
    sha256: string;
    sizeBytes: number;
    fileCount: number;
    metadata?: Record<string, unknown>;
  }): Promise<MultiremiDaemonSessionArchiveInitResponse> {
    const response = await this.post<MultiremiDaemonSessionArchiveInitResponse>(
      `/api/daemon/runtimes/${encodeURIComponent(runtimeId)}/issues/${encodeURIComponent(issueId)}/session-archives/init`,
      {
        source_revision: input.sourceRevision,
        sha256: input.sha256,
        size_bytes: input.sizeBytes,
        file_count: input.fileCount,
        metadata: input.metadata ?? {},
      },
    );
    const key = sessionArchiveAttemptKey(runtimeId, issueId, response.archive.id);
    if (Number.isSafeInteger(response.upload_attempt) && Number(response.upload_attempt) > 0) {
      this.sessionArchiveUploadAttempts.set(key, Number(response.upload_attempt));
    } else {
      this.sessionArchiveUploadAttempts.delete(key);
    }
    return response;
  }

  async reportIssueSessionArchiveFailure(
    runtimeId: string,
    issueId: string,
    input: { stage: "prepare"; error: string },
  ): Promise<MultiremiDaemonSessionArchiveWire> {
    const response = await this.post<{ archive: MultiremiDaemonSessionArchiveWire }>(
      `/api/daemon/runtimes/${encodeURIComponent(runtimeId)}/issues/${encodeURIComponent(issueId)}/session-archives/failure`,
      input,
    );
    return response.archive;
  }

  async uploadIssueSessionArchive(
    runtimeId: string,
    issueId: string,
    archiveId: string,
    archivePath: string,
  ): Promise<MultiremiDaemonSessionArchiveWire> {
    const attempt = this.requireSessionArchiveUploadAttempt(runtimeId, issueId, archiveId);
    const path = `/api/daemon/runtimes/${encodeURIComponent(runtimeId)}/issues/${encodeURIComponent(issueId)}/session-archives/${encodeURIComponent(archiveId)}/content?attempt=${attempt}`;
    // Bun 1.3.14 can crash when Bun.file is used as a fetch body in the co-resident ACP daemon.
    const archive = await readFile(archivePath);
    const resp = await fetch(this.baseUrl + path, {
      method: "PUT",
      headers: this.headers("application/octet-stream"),
      body: archive,
    });
    return (await parseResponse<{ archive: MultiremiDaemonSessionArchiveWire }>(resp, "PUT", path)).archive;
  }

  async completeIssueSessionArchive(
    runtimeId: string,
    issueId: string,
    archiveId: string,
  ): Promise<MultiremiDaemonSessionArchiveWire> {
    const attempt = this.requireSessionArchiveUploadAttempt(runtimeId, issueId, archiveId);
    const key = sessionArchiveAttemptKey(runtimeId, issueId, archiveId);
    const response = await this.post<{ archive: MultiremiDaemonSessionArchiveWire }>(
      `/api/daemon/runtimes/${encodeURIComponent(runtimeId)}/issues/${encodeURIComponent(issueId)}/session-archives/${encodeURIComponent(archiveId)}/complete?attempt=${attempt}`,
      {},
    );
    if (response.archive.status === "ready") this.sessionArchiveUploadAttempts.delete(key);
    return response.archive;
  }

  private requireSessionArchiveUploadAttempt(runtimeId: string, issueId: string, archiveId: string): number {
    const attempt = this.sessionArchiveUploadAttempts.get(sessionArchiveAttemptKey(runtimeId, issueId, archiveId));
    if (!attempt) throw new Error("Session archive must be initialized before upload or completion");
    return attempt;
  }

  async reportIssueWorkspaceCleaned(
    issueId: string,
    runtimeId: string,
    archive: MultiremiIssueWorkspaceArchiveBinding,
  ): Promise<void> {
    await this.post(`/api/daemon/issues/${encodeURIComponent(issueId)}/workspace/cleaned`, {
      runtime_id: runtimeId,
      archive_id: archive.archiveId,
      source_revision: archive.sourceRevision,
      sha256: archive.sha256,
    });
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

  private async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const resp = await fetch(this.baseUrl + path, { headers: this.headers(), signal });
    return parseResponse<T>(resp, "GET", path);
  }

  private async post<T = unknown>(path: string, body: unknown, tokenOverride?: string | null): Promise<T> {
    const resp = await fetch(this.baseUrl + path, {
      method: "POST",
      headers: this.headers("application/json", tokenOverride),
      body: JSON.stringify(body),
    });
    return parseResponse<T>(resp, "POST", path);
  }

  private async put<T = unknown>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const resp = await fetch(this.baseUrl + path, {
      method: "PUT",
      headers: this.headers("application/json"),
      body: JSON.stringify(body),
      signal,
    });
    return parseResponse<T>(resp, "PUT", path);
  }

  private headers(contentType?: string, tokenOverride?: string | null): HeadersInit {
    const headers: Record<string, string> = {};
    if (contentType) headers["Content-Type"] = contentType;
    const token = tokenOverride ?? this.token;
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }
}

function sessionArchiveAttemptKey(runtimeId: string, issueId: string, archiveId: string): string {
  return JSON.stringify([runtimeId, issueId, archiveId]);
}

async function parseResponse<T>(resp: Response, method: string, path: string): Promise<T> {
  if (resp.ok) {
    if (resp.status === 204) return undefined as T;
    const text = await resp.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
  const text = await resp.text();
  throw new MultiremiDaemonHttpError(
    resp.status,
    method,
    path,
    text,
    responseErrorCode(text),
  );
}

function responseErrorCode(text: string): string | null {
  try {
    const body = JSON.parse(text) as { code?: unknown; error?: { code?: unknown } | unknown };
    const nestedError = body.error && typeof body.error === "object"
      ? body.error as Record<string, unknown>
      : null;
    const code = typeof body.code === "string"
      ? body.code
      : typeof nestedError?.code === "string"
        ? nestedError.code
        : null;
    return code?.trim() || null;
  } catch {
    return null;
  }
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
    taskKind: raw.task_kind === "quick_create" || raw.kind === "quick_create" ? "quick_create" : "direct",
    agentId: stringOrNull(raw.agent_id ?? raw.agentId) ?? "",
    runtimeId: stringOrNull(raw.runtime_id ?? raw.runtimeId),
    issueId: stringOrNull(raw.issue_id ?? raw.issueId),
    issueSessionId: stringOrNull(raw.issue_session_id ?? raw.issueSessionId),
    issueSessionGeneration: numberOrNull(raw.issue_session_generation ?? raw.issueSessionGeneration),
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
    pluginSnapshot: Array.isArray(raw.plugin_snapshot)
      ? raw.plugin_snapshot
      : Array.isArray(raw.pluginSnapshot)
        ? raw.pluginSnapshot
        : [],
    executionFingerprint: stringOrNull(raw.execution_fingerprint ?? raw.executionFingerprint),
    branchName: stringOrNull(raw.branch_name ?? raw.branchName),
    sessionId: stringOrNull(raw.session_id ?? raw.sessionId ?? raw.prior_session_id),
    priorSessionId: stringOrNull(raw.prior_session_id ?? raw.priorSessionId ?? raw.session_id ?? raw.sessionId),
    workDir: stringOrNull(raw.work_dir ?? raw.workDir),
    priorWorkDir: stringOrNull(raw.prior_work_dir ?? raw.priorWorkDir ?? raw.work_dir ?? raw.workDir),
    authToken: stringOrNull(raw.auth_token ?? raw.authToken),
    chatMessage: stringOrNull(raw.chat_message ?? raw.chatMessage),
    chatBootstrapTranscript: stringOrNull(raw.chat_bootstrap_transcript ?? raw.chatBootstrapTranscript),
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
    workspaceBootstrapPrompt: stringOrNull(raw.workspace_bootstrap_prompt ?? raw.workspaceBootstrapPrompt),
    workspaceDeltaPrompt: stringOrNull(raw.workspace_delta_prompt ?? raw.workspaceDeltaPrompt),
    workspaceEnv: objectOrDefault(raw.workspace_env ?? raw.workspaceEnv),
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
    issueSession: raw.issue_session ?? raw.issueSession ?? null,
    sessionProjection: raw.session_projection ?? raw.sessionProjection ?? null,
    issueSessionResults: Array.isArray(raw.issue_session_results)
      ? raw.issue_session_results
      : Array.isArray(raw.issueSessionResults)
        ? raw.issueSessionResults
        : [],
    project: normalizeDaemonClaimProject(raw.project),
    projectResources: normalizeDaemonClaimProjectResources(raw.project_resources ?? raw.projectResources),
    projectDocs: normalizeDaemonClaimProjectDocs(raw.project_docs ?? raw.projectDocs),
    projectWikiDocs: normalizeDaemonClaimProjectWikiDocs(raw.project_wiki_docs ?? raw.projectWikiDocs),
    repositoryWikiContexts: normalizeDaemonClaimRepositoryWikiContexts(raw.repository_wiki_contexts ?? raw.repositoryWikiContexts),
    projectContexts: normalizeDaemonClaimProjectContexts(raw.project_contexts ?? raw.projectContexts),
    squadContext: normalizeDaemonClaimSquadContext(raw.squad_context ?? raw.squadContext),
    repos: Array.isArray(raw.repos) ? raw.repos : [],
    usage: Array.isArray(raw.usage) ? raw.usage : [],
  };
  return normalized as MultiremiTaskWithAgent;
}

function normalizeDaemonClaimSquadContext(raw: any): any | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return {
    id: stringOrNull(raw.id) ?? "",
    name: stringOrNull(raw.name) ?? "",
    leaderAgentId: stringOrNull(raw.leader_agent_id ?? raw.leaderAgentId) ?? "",
    members: Array.isArray(raw.members)
      ? raw.members.map((member: any) => ({
        agentId: stringOrNull(member.agent_id ?? member.agentId) ?? "",
        name: stringOrNull(member.name) ?? "",
        role: stringOrNull(member.role) ?? "member",
        description: stringOrNull(member.description),
      })).filter((member: any) => member.agentId && member.name)
      : [],
  };
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
    issueKind: raw.issue_kind === "intake" || raw.issueKind === "intake" ? "intake" : "execution",
    sourceIssueId: stringOrNull(raw.source_issue_id ?? raw.sourceIssueId),
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
    instructions: typeof raw.instructions === "string" ? raw.instructions : "",
    deltaInstructions: typeof (raw.delta_instructions ?? raw.deltaInstructions) === "string"
      ? raw.delta_instructions ?? raw.deltaInstructions
      : "",
    instructionsRevision: numberOrDefault(raw.instructions_revision ?? raw.instructionsRevision, 0),
    instructionsUpdatedAt: stringOrNull(raw.instructions_updated_at ?? raw.instructionsUpdatedAt),
    instructionsUpdatedBy: stringOrNull(raw.instructions_updated_by ?? raw.instructionsUpdatedBy),
    leadType: stringOrNull(raw.lead_type ?? raw.leadType) as any,
    leadId: stringOrNull(raw.lead_id ?? raw.leadId),
    issueCount: numberOrDefault(raw.issue_count ?? raw.issueCount, 0),
    doneCount: numberOrDefault(raw.done_count ?? raw.doneCount, 0),
    resourceCount: numberOrDefault(raw.resource_count ?? raw.resourceCount, 0),
    archivedAt: stringOrNull(raw.archived_at ?? raw.archivedAt),
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

function normalizeDaemonClaimProjectDocs(raw: any): MultiremiTaskWithAgent["projectDocs"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return {
    memory: normalizeDaemonClaimProjectDocEntries(raw.memory),
    wiki: normalizeDaemonClaimProjectDocEntries(raw.wiki),
    schema: stringOrNull(raw.schema),
  };
}

function normalizeDaemonClaimProjectWikiDocs(raw: any): NonNullable<MultiremiTaskWithAgent["projectWikiDocs"]> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((doc: any) => {
    if (!doc || typeof doc !== "object" || doc.kind !== "wiki") return [];
    const id = stringOrNull(doc.id);
    const projectId = stringOrNull(doc.project_id ?? doc.projectId);
    const workspaceId = stringOrNull(doc.workspace_id ?? doc.workspaceId);
    const slug = stringOrNull(doc.slug);
    const title = stringOrNull(doc.title);
    if (!id || !projectId || !workspaceId || !slug || !title) return [];
    return [{
      ...doc,
      id,
      projectId,
      workspaceId,
      kind: "wiki" as const,
      slug,
      title,
      summary: stringOrNull(doc.summary),
      body: typeof doc.body === "string" ? doc.body : "",
      tags: Array.isArray(doc.tags) ? doc.tags.filter((value: unknown): value is string => typeof value === "string") : [],
      pinned: doc.pinned === true || Number(doc.pinned) === 1,
      refs: Array.isArray(doc.refs) ? doc.refs : [],
      sourceTaskId: stringOrNull(doc.source_task_id ?? doc.sourceTaskId),
      sourceIssueId: stringOrNull(doc.source_issue_id ?? doc.sourceIssueId),
      authorType: stringOrNull(doc.author_type ?? doc.authorType) as "member" | "agent" | null,
      authorId: stringOrNull(doc.author_id ?? doc.authorId),
      updatedByType: stringOrNull(doc.updated_by_type ?? doc.updatedByType) as "member" | "agent" | null,
      updatedById: stringOrNull(doc.updated_by_id ?? doc.updatedById),
      version: numberOrDefault(doc.version, 1),
      createdAt: stringOrNull(doc.created_at ?? doc.createdAt) ?? "",
      updatedAt: stringOrNull(doc.updated_at ?? doc.updatedAt) ?? "",
    }];
  });
}

function normalizeDaemonClaimRepositoryWikiContexts(raw: any): NonNullable<MultiremiTaskWithAgent["repositoryWikiContexts"]> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((context: any) => {
    if (!context || typeof context !== "object" || !context.repository || !Array.isArray(context.docs)) return [];
    const repository = context.repository;
    const id = stringOrNull(repository.id);
    const name = stringOrNull(repository.name);
    const url = stringOrNull(repository.url);
    if (!id || !name || !url) return [];
    return [{
      repository: {
        id,
        name,
        url,
        defaultBranch: stringOrNull(repository.default_branch ?? repository.defaultBranch),
      },
      docs: context.docs.flatMap((doc: any) => {
        const docId = stringOrNull(doc?.id);
        const path = stringOrNull(doc?.path);
        const title = stringOrNull(doc?.title);
        if (!docId || !path || !title) return [];
        return [{
          ...doc,
          id: docId,
          repositoryId: stringOrNull(doc.repository_id ?? doc.repositoryId) ?? id,
          workspaceId: stringOrNull(doc.workspace_id ?? doc.workspaceId) ?? "",
          path,
          slug: stringOrNull(doc.slug) ?? path.replace(/\.md$/i, ""),
          title,
          summary: stringOrNull(doc.summary),
          body: typeof doc.body === "string" ? doc.body : "",
          tags: Array.isArray(doc.tags) ? doc.tags.filter((value: unknown): value is string => typeof value === "string") : [],
          refs: Array.isArray(doc.refs) ? doc.refs : [],
          sourceRevision: stringOrNull(doc.source_revision ?? doc.sourceRevision),
          status: stringOrNull(doc.status) ?? "healthy",
          version: numberOrDefault(doc.version, 1),
          updatedAt: stringOrNull(doc.updated_at ?? doc.updatedAt) ?? "",
        }];
      }),
    }];
  });
}

function normalizeDaemonClaimProjectDocEntries(raw: any): MultiremiProjectDocIndexEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => ({
    ...entry,
    summary: stringOrNull(entry.summary),
    body: stringOrNull(entry.body),
    kind: entry.kind === "memory" ? "memory" : "wiki",
    pinned: entry.pinned === true || Number(entry.pinned) === 1,
    sourceIssueId: stringOrNull(entry.source_issue_id ?? entry.sourceIssueId),
    updatedAt: stringOrNull(entry.updated_at ?? entry.updatedAt) ?? "",
  }));
}

function normalizeDaemonClaimProjectContexts(raw: any): MultiremiTaskWithAgent["projectContexts"] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((context) => {
    const project = normalizeDaemonClaimProject(context?.project);
    if (!project) return [];
    const docs = Array.isArray(context.docs)
      ? context.docs.map((doc: any) => ({
          ...doc,
          projectId: stringOrNull(doc.project_id ?? doc.projectId) ?? project.id,
          workspaceId: stringOrNull(doc.workspace_id ?? doc.workspaceId) ?? project.workspaceId,
          summary: stringOrNull(doc.summary),
          tags: Array.isArray(doc.tags) ? doc.tags : [],
          pinned: doc.pinned === true || Number(doc.pinned) === 1,
          refs: Array.isArray(doc.refs) ? doc.refs : [],
          sourceTaskId: stringOrNull(doc.source_task_id ?? doc.sourceTaskId),
          sourceIssueId: stringOrNull(doc.source_issue_id ?? doc.sourceIssueId),
          authorType: stringOrNull(doc.author_type ?? doc.authorType) as any,
          authorId: stringOrNull(doc.author_id ?? doc.authorId),
          updatedByType: stringOrNull(doc.updated_by_type ?? doc.updatedByType) as any,
          updatedById: stringOrNull(doc.updated_by_id ?? doc.updatedById),
          createdAt: stringOrNull(doc.created_at ?? doc.createdAt) ?? "",
          updatedAt: stringOrNull(doc.updated_at ?? doc.updatedAt) ?? "",
        }))
      : [];
    return [{
      project,
      resources: normalizeDaemonClaimProjectResources(context.resources),
      docs,
      repos: Array.isArray(context.repos) ? context.repos : [],
    }];
  });
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
