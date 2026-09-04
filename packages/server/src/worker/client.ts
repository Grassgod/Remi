import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type {
  MultiremiDaemonHeartbeatAck,
  MultiremiAgent,
  ReportBotMenuPublishInput,
  MultiremiProjectDocIndexEntry,
  MultiremiRepoData,
  MultiremiRuntimeDirectoryCandidate,
  MultiremiRuntimeModel,
  MultiremiRuntimeLocalSkillSummary,
  MultiremiSkillFile,
  MultiremiTaskHumanRequest,
  MultiremiTaskStatus,
  MultiremiTaskSteerMessage,
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
  FeishuBotErrorCode,
  FeishuBotRuntimeState,
  MultiremiFeishuBotDaemonConfig,
  MultiremiFeishuBotDaemonPayload,
  MultiremiFeishuBotOutboundDelivery,
  MultiremiTaskMessage,
  FeishuBotTaskSnapshot,
  FeishuBotSessionSnapshot,
  SubmitFeishuBotMessageInput,
  SubmitFeishuBotMessageResult,
} from "@multiremi/contracts/types.js";
import {
  FEISHU_CONCIERGE_OUTBOUND_PROTOCOL_VERSION,
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
  next_retry_at?: string | null;
  retry_exhausted_at?: string | null;
  retry_state?: "eligible" | "backoff" | "exhausted";
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

export interface MultiremiDaemonClientOptions {
  sessionArchiveUploadBaseUrl?: string | null;
  sessionArchiveProxyMaxBytes?: number;
  sessionArchiveDirectProbeTtlMs?: number;
  sessionArchiveDirectProbeTimeoutMs?: number;
  sessionArchiveUploadTimeoutMs?: number;
  sessionArchiveFailureReportTimeoutMs?: number;
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

/**
 * The concierge assignment as the daemon uses it: credentials plus the Agent
 * row normalized out of the same response.
 */
export interface MultiremiFeishuBotAssignment {
  config: MultiremiFeishuBotDaemonConfig;
  agent: MultiremiAgent;
}

/**
 * A named reason the assignment could not be used. Carrying the code means the
 * admin sees "agent unavailable" rather than a generic start failure.
 */
export class MultiremiFeishuBotAssignmentError extends Error {
  constructor(message: string, readonly code: FeishuBotErrorCode) {
    super(message);
    this.name = "MultiremiFeishuBotAssignmentError";
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
  private sessionArchiveUploadBaseUrl: URL | null;
  private sessionArchiveProxyMaxBytes: number;
  private sessionArchiveDirectProbeTtlMs: number;
  private sessionArchiveDirectProbeTimeoutMs: number;
  private sessionArchiveUploadTimeoutMs: number;
  private sessionArchiveFailureReportTimeoutMs: number;
  private sessionArchiveDirectRoutes = new Map<string, { direct: boolean; expiresAt: number }>();
  private sessionArchiveUploadAttempts = new Map<string, { attempt: number; uploadUrl: string | null }>();

  constructor(baseUrl: string, token?: string | null, options: MultiremiDaemonClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token ?? null;
    this.sessionArchiveUploadBaseUrl = normalizeSessionArchiveUploadBaseUrl(
      options.sessionArchiveUploadBaseUrl,
    );
    this.sessionArchiveProxyMaxBytes = normalizeSessionArchiveProxyMaxBytes(
      options.sessionArchiveProxyMaxBytes,
    );
    this.sessionArchiveDirectProbeTtlMs = normalizeSessionArchiveDurationMs(
      options.sessionArchiveDirectProbeTtlMs,
      5 * 60 * 1_000,
      "MULTIREMI_ARCHIVE_DIRECT_PROBE_TTL_MS",
    );
    this.sessionArchiveDirectProbeTimeoutMs = normalizeSessionArchiveDurationMs(
      options.sessionArchiveDirectProbeTimeoutMs,
      10_000,
      "MULTIREMI_ARCHIVE_DIRECT_PROBE_TIMEOUT_MS",
    );
    this.sessionArchiveUploadTimeoutMs = normalizeSessionArchiveDurationMs(
      options.sessionArchiveUploadTimeoutMs,
      15 * 60 * 1_000,
      "MULTIREMI_ARCHIVE_UPLOAD_TIMEOUT_MS",
    );
    this.sessionArchiveFailureReportTimeoutMs = normalizeSessionArchiveDurationMs(
      options.sessionArchiveFailureReportTimeoutMs,
      10_000,
      "MULTIREMI_ARCHIVE_FAILURE_REPORT_TIMEOUT_MS",
    );
  }

  async registerRuntime(input: RegisterRuntimeInput): Promise<{ runtime: { id: string } }> {
    return this.post("/api/multiremi/runtimes", input);
  }

  async registerDaemonRuntime(input: MultiremiDaemonRegisterRuntimeInput): Promise<MultiremiDaemonRegisterResponse> {
    return this.post<MultiremiDaemonRegisterResponse>("/api/daemon/register", {
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
    supportsBotMenu = false,
    supportsFeishuConcierge = false,
  ): Promise<MultiremiDaemonHeartbeatConfigAck> {
    let resp: Partial<MultiremiDaemonHeartbeatConfigAck>;
    try {
      resp = await this.post<Partial<MultiremiDaemonHeartbeatAck>>("/api/daemon/heartbeat", {
        runtime_id: runtimeId,
        supports_batch_import: true,
        supports_directory_scan: true,
        supports_bot_menu: supportsBotMenu,
        agent_plugin_protocol: MULTIREMI_AGENT_PLUGIN_PROTOCOL_VERSION,
        ssh_mesh_protocol: MULTIREMI_SSH_MESH_PROTOCOL_VERSION,
        ...(sshMeshStatus ? { ssh_mesh_status: sshMeshStatus } : {}),
        ...(drainStatus
          ? {
              drain_ack_generation: drainStatus.ackGeneration,
              active_task_count: drainStatus.activeTaskCount,
            }
          : {}),
        // Only claimed when this process can actually host the connector, so
        // the control plane never hands the bot to a Runtime that cannot run it.
        ...(supportsFeishuConcierge
          ? { feishu_concierge_protocol: FEISHU_CONCIERGE_OUTBOUND_PROTOCOL_VERSION }
          : {}),
      });
    } catch (error) {
      if (isRuntimeGoneHeartbeatError(error)) {
        return { runtime_id: runtimeId, status: "runtime_gone", runtime_gone: true };
      }
      throw error;
    }
    const rawOutbound = resp.pending_feishu_outbound as Record<string, unknown> | undefined;
    const pendingFeishuOutbound: MultiremiFeishuBotOutboundDelivery | undefined = rawOutbound
      ? {
          id: String(rawOutbound.id ?? ""),
          claimToken: String(rawOutbound.claim_token ?? rawOutbound.claimToken ?? ""),
          chatId: String(rawOutbound.chat_id ?? rawOutbound.chatId ?? ""),
          threadId: typeof (rawOutbound.thread_id ?? rawOutbound.threadId) === "string"
            ? String(rawOutbound.thread_id ?? rawOutbound.threadId)
            : null,
          replyToMessageId: typeof (rawOutbound.reply_to_message_id ?? rawOutbound.replyToMessageId) === "string"
            ? String(rawOutbound.reply_to_message_id ?? rawOutbound.replyToMessageId)
            : null,
          body: String(rawOutbound.body ?? ""),
          idempotencyKey: String(rawOutbound.idempotency_key ?? rawOutbound.idempotencyKey ?? rawOutbound.id ?? ""),
        }
      : undefined;
    return {
      runtime_id: runtimeId,
      status: resp.status ?? "ok",
      ...resp,
      ...(pendingFeishuOutbound ? { pending_feishu_outbound: pendingFeishuOutbound } : {}),
    } as MultiremiDaemonHeartbeatConfigAck;
  }

  async reportBotMenuPublishResult(
    runtimeId: string,
    requestId: string,
    input: ReportBotMenuPublishInput,
  ): Promise<void> {
    await this.post(
      `/api/daemon/runtimes/${encodeURIComponent(runtimeId)}/bot-menu/${encodeURIComponent(requestId)}/result`,
      input,
    );
  }

  /**
   * Fetch the decrypted concierge assignment for this Runtime. Returns null
   * when the control plane has not assigned the bot here — including on servers
   * from before MUL-206, which answer with an unstructured 404.
   */
  async getFeishuBotConfig(runtimeId: string): Promise<MultiremiFeishuBotAssignment | null> {
    const path = `/api/daemon/runtimes/${encodeURIComponent(runtimeId)}/feishu-bot`;
    let payload: MultiremiFeishuBotDaemonPayload;
    try {
      payload = await this.get<MultiremiFeishuBotDaemonPayload>(path);
    } catch (error) {
      if (
        error instanceof MultiremiDaemonHttpError
        && (error.status === 404 || error.status === 405)
        && error.code !== "runtime_not_found"
      ) {
        return null;
      }
      // The control plane names the failures it can name; anything else stays
      // an ordinary transport error for the caller to classify.
      if (error instanceof MultiremiDaemonHttpError && error.code === "agent_unavailable") {
        throw new MultiremiFeishuBotAssignmentError("the configured bot Agent is unavailable", "agent_unavailable");
      }
      throw error;
    }
    const { bot_agent: rawAgent, ...config } = payload;
    const agent = normalizeDaemonAgent(rawAgent);
    if (!agent) {
      throw new MultiremiFeishuBotAssignmentError("the control plane returned no bot Agent", "agent_unavailable");
    }
    return { config, agent };
  }

  async reportFeishuBotRuntimeStatus(
    runtimeId: string,
    input: {
      applied_revision: number;
      state: FeishuBotRuntimeState;
      bot_name?: string | null;
      bot_open_id?: string | null;
      error_code?: FeishuBotErrorCode | null;
      error_message?: string | null;
    },
  ): Promise<void> {
    await this.post(
      `/api/daemon/runtimes/${encodeURIComponent(runtimeId)}/feishu-bot/status`,
      input,
    );
  }

  async reportFeishuBotOutboundResult(
    runtimeId: string,
    deliveryId: string,
    input: {
      claimToken: string;
      status: "sent" | "failed";
      externalMessageId?: string | null;
      error?: string | null;
    },
  ): Promise<void> {
    await this.post(
      `/api/daemon/runtimes/${encodeURIComponent(runtimeId)}/feishu-bot/outbound/${encodeURIComponent(deliveryId)}/result`,
      {
        claim_token: input.claimToken,
        status: input.status,
        external_message_id: input.externalMessageId ?? undefined,
        error: input.error ?? undefined,
      },
    );
  }

  async submitFeishuBotMessage(
    runtimeId: string,
    input: SubmitFeishuBotMessageInput,
  ): Promise<SubmitFeishuBotMessageResult> {
    const response = await this.post<{
      chatSessionId: string;
      taskId: string;
      status: MultiremiTaskStatus;
      duplicate: boolean;
      steered: boolean;
      senderMembership: SubmitFeishuBotMessageResult["senderMembership"];
    }>(`/api/daemon/runtimes/${encodeURIComponent(runtimeId)}/feishu-bot/messages`, {
      revision: input.revision,
      external_session_key: input.externalSessionKey,
      external_message_id: input.externalMessageId,
      reply_to_message_id: input.replyToMessageId ?? undefined,
      sender_open_id: input.senderOpenId ?? undefined,
      sender_user_id: input.senderUserId ?? undefined,
      sender_union_id: input.senderUnionId ?? undefined,
      sender_tenant_key: input.senderTenantKey ?? undefined,
      sender_name: input.senderName ?? undefined,
      chat_id: input.chatId ?? undefined,
      thread_id: input.threadId ?? undefined,
      text: input.text,
    });
    return response;
  }

  async resetFeishuBotSession(runtimeId: string, revision: number, externalSessionKey: string): Promise<boolean> {
    const response = await this.post<{ reset: boolean }>(
      `/api/daemon/runtimes/${encodeURIComponent(runtimeId)}/feishu-bot/session/reset`,
      { revision, external_session_key: externalSessionKey },
    );
    return response.reset === true;
  }

  async cancelFeishuBotSessionTask(
    runtimeId: string,
    revision: number,
    externalSessionKey: string,
  ): Promise<{ cancelled: boolean; taskId: string | null }> {
    const response = await this.post<{ cancelled: boolean; task_id?: string | null }>(
      `/api/daemon/runtimes/${encodeURIComponent(runtimeId)}/feishu-bot/session/cancel`,
      { revision, external_session_key: externalSessionKey },
    );
    return { cancelled: response.cancelled === true, taskId: response.task_id ?? null };
  }

  async inspectFeishuBotSession(
    runtimeId: string,
    revision: number,
    externalSessionKey: string,
  ): Promise<FeishuBotSessionSnapshot> {
    const response = await this.post<{
      chat_session_id?: string | null;
      task?: {
        task_id: string;
        status: MultiremiTaskStatus;
        result?: string | null;
        error?: string | null;
        session_id?: string | null;
        work_dir?: string | null;
        usage?: TaskUsageEntry[];
      } | null;
    }>(`/api/daemon/runtimes/${encodeURIComponent(runtimeId)}/feishu-bot/session/inspect`, {
      revision,
      external_session_key: externalSessionKey,
    });
    return {
      chatSessionId: response.chat_session_id ?? null,
      task: response.task
        ? {
            taskId: response.task.task_id,
            status: response.task.status,
            result: response.task.result ?? null,
            error: response.task.error ?? null,
            sessionId: response.task.session_id ?? null,
            workDir: response.task.work_dir ?? null,
            usage: Array.isArray(response.task.usage) ? response.task.usage : [],
          }
        : null,
    };
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

  async checkExternalWorkspaceMembership(workspaceId: string, externalId: string): Promise<boolean> {
    const response = await this.post<{ allowed: boolean }>(
      `/api/daemon/workspaces/${encodeURIComponent(workspaceId)}/external-membership/check`,
      { external_id: externalId },
    );
    return response.allowed === true;
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

  async reportRuntimeCommandResult(runtimeId: string, requestId: string, result: {
    status: "completed" | "failed" | "timeout";
    exit_code: number | null;
    stdout: string;
    stderr: string;
    duration_ms: number;
    error?: string;
  }): Promise<void> {
    await this.post(`/api/daemon/runtimes/${runtimeId}/commands/${requestId}/result`, result);
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

  async renewTaskDispatchLease(taskId: string): Promise<MultiremiTaskStatus> {
    try {
      const resp = await this.post<{ status: MultiremiTaskStatus }>(
        `/api/daemon/tasks/${taskId}/dispatch-lease`,
        {},
      );
      return resp.status;
    } catch (error) {
      // Rolling upgrades may briefly run a new daemon against an older control
      // plane. Fall back to the legacy read-only status endpoint; a genuinely
      // missing task also returns 404 there and remains distinguishable.
      if (error instanceof MultiremiDaemonHttpError && error.status === 404) {
        return await this.getTaskStatus(taskId);
      }
      throw error;
    }
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

  async listTaskMessages(taskId: string, sinceSeq = 0): Promise<MultiremiTaskMessage[]> {
    const rows = await this.get<Array<{
      task_id: string;
      seq: number;
      type: string;
      tool?: string;
      content?: string;
      input?: Record<string, unknown>;
      output?: string;
      tool_call_id?: string;
      status?: string;
      meta?: Record<string, unknown>;
      created_at: string;
    }>>(`/api/daemon/tasks/${encodeURIComponent(taskId)}/messages?since_seq=${Math.max(0, Math.floor(sinceSeq))}`);
    return rows.map((row) => ({
      id: `${row.task_id}:${row.seq}`,
      taskId: row.task_id,
      seq: row.seq,
      type: row.type,
      tool: row.tool ?? null,
      content: row.content ?? null,
      input: row.input ?? null,
      output: row.output ?? null,
      toolCallId: row.tool_call_id ?? null,
      status: row.status ?? null,
      meta: row.meta ?? null,
      createdAt: row.created_at,
    }));
  }

  async getFeishuBotTaskSnapshot(taskId: string): Promise<FeishuBotTaskSnapshot> {
    const response = await this.get<{
      task_id: string;
      status: MultiremiTaskStatus;
      result?: string | null;
      error?: string | null;
      session_id?: string | null;
      work_dir?: string | null;
      usage?: TaskUsageEntry[];
    }>(`/api/daemon/tasks/${encodeURIComponent(taskId)}/status`);
    return {
      taskId: response.task_id ?? taskId,
      status: response.status,
      result: response.result ?? null,
      error: response.error ?? null,
      sessionId: response.session_id ?? null,
      workDir: response.work_dir ?? null,
      usage: Array.isArray(response.usage) ? response.usage : [],
    };
  }

  async respondTaskHumanRequest(
    taskId: string,
    requestId: string,
    response: Record<string, unknown>,
  ): Promise<MultiremiTaskHumanRequest> {
    const result = await this.post<{ request: MultiremiTaskHumanRequest }>(
      `/api/daemon/tasks/${encodeURIComponent(taskId)}/human-requests/${encodeURIComponent(requestId)}/respond`,
      { response, responded_by: "feishu" },
    );
    return result.request;
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

  async listPendingTaskSteerMessages(taskId: string): Promise<MultiremiTaskSteerMessage[]> {
    const resp = await this.get<{ messages?: MultiremiTaskSteerMessage[] }>(`/api/daemon/tasks/${taskId}/steer`);
    return Array.isArray(resp.messages) ? resp.messages : [];
  }

  async consumeTaskSteerMessages(taskId: string, ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.post(`/api/daemon/tasks/${taskId}/steer/consume`, { ids });
  }

  async getIssueGcCheck(issueId: string): Promise<MultiremiDaemonGcStatus> {
    return this.get<MultiremiDaemonGcStatus>(`/api/daemon/issues/${encodeURIComponent(issueId)}/gc-check`);
  }

  async getIssueSessionArchiveStatus(
    runtimeId: string,
    issueId: string,
    sourceRevision?: string,
    sha256?: string,
    verifyReady = false,
  ): Promise<MultiremiDaemonSessionArchiveStatus> {
    const query = new URLSearchParams();
    if (sourceRevision) query.set("source_revision", sourceRevision);
    if (sha256) query.set("sha256", sha256);
    if (verifyReady) query.set("verify_ready", "1");
    const suffix = query.size ? `?${query}` : "";
    return this.get<MultiremiDaemonSessionArchiveStatus>(
      `/api/daemon/runtimes/${encodeURIComponent(runtimeId)}/issues/${encodeURIComponent(issueId)}/session-archives/status${suffix}`,
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
      this.sessionArchiveUploadAttempts.set(key, {
        attempt: Number(response.upload_attempt),
        uploadUrl: typeof response.upload_url === "string" && response.upload_url.trim()
          ? response.upload_url.trim()
          : null,
      });
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
    const claim = this.requireSessionArchiveUploadAttempt(runtimeId, issueId, archiveId);
    const path = sessionArchiveUploadPath(runtimeId, issueId, archiveId, claim.attempt);
    try {
      const target = this.resolveSessionArchiveUploadTarget(path, claim.uploadUrl);
      const archiveStat = await stat(archivePath);
      if (!archiveStat.isFile()) throw new Error(`Session archive is not a regular file: ${archivePath}`);
      const direct = target.directCandidate
        ? await this.hasAttestedSessionArchiveDirectRoute(target.url)
        : false;
      if (!direct && archiveStat.size > this.sessionArchiveProxyMaxBytes) {
        throw new Error(
          `Session archive is ${archiveStat.size} bytes, exceeding the ${this.sessionArchiveProxyMaxBytes}-byte proxy fallback limit. `
          + "Configure MULTIREMI_DAEMON_DIRECT_BASE_URL on the API or MULTIREMI_ARCHIVE_UPLOAD_BASE_URL on the daemon, "
          + "and ensure the direct route returns X-Remi-Archive-Direct: 1 to its HEAD preflight.",
        );
      }

      // Bun 1.3.14 can crash when Bun.file is used as a fetch body in the co-resident ACP daemon.
      // A Node ReadStream stays incremental without entering that Bun.file native path.
      const archive = createReadStream(archivePath);
      try {
        const headers = new Headers(this.headers("application/octet-stream"));
        headers.set("Content-Length", String(archiveStat.size));
        const request: RequestInit & { duplex: "half" } = {
          method: "PUT",
          headers,
          body: archive as unknown as BodyInit,
          duplex: "half",
          redirect: "error",
          signal: AbortSignal.timeout(this.sessionArchiveUploadTimeoutMs),
        };
        let resp: Response;
        try {
          resp = await fetch(target.url, request);
        } catch (error) {
          if (request.signal?.aborted) {
            throw new Error(
              `Session archive upload timed out after ${this.sessionArchiveUploadTimeoutMs}ms`,
              { cause: error },
            );
          }
          throw error;
        }
        return (await parseResponse<{ archive: MultiremiDaemonSessionArchiveWire }>(resp, "PUT", path)).archive;
      } finally {
        archive.destroy();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await this.post(
          `/api/daemon/runtimes/${encodeURIComponent(runtimeId)}/issues/${encodeURIComponent(issueId)}/session-archives/${encodeURIComponent(archiveId)}/failure?attempt=${claim.attempt}`,
          { error: message },
          undefined,
          AbortSignal.timeout(this.sessionArchiveFailureReportTimeoutMs),
        );
        this.sessionArchiveUploadAttempts.delete(sessionArchiveAttemptKey(runtimeId, issueId, archiveId));
      } catch (reportError) {
        if (
          reportError instanceof MultiremiDaemonHttpError
          && reportError.status === 409
          && reportError.code === "session_archive_attempt_conflict"
        ) {
          this.sessionArchiveUploadAttempts.delete(sessionArchiveAttemptKey(runtimeId, issueId, archiveId));
          throw error;
        }
        const reportMessage = reportError instanceof Error ? reportError.message : String(reportError);
        throw new Error(`${message}; additionally failed to persist archive upload failure: ${reportMessage}`, {
          cause: error,
        });
      }
      throw error;
    }
  }

  async completeIssueSessionArchive(
    runtimeId: string,
    issueId: string,
    archiveId: string,
  ): Promise<MultiremiDaemonSessionArchiveWire> {
    const { attempt } = this.requireSessionArchiveUploadAttempt(runtimeId, issueId, archiveId);
    const key = sessionArchiveAttemptKey(runtimeId, issueId, archiveId);
    const response = await this.post<{ archive: MultiremiDaemonSessionArchiveWire }>(
      `/api/daemon/runtimes/${encodeURIComponent(runtimeId)}/issues/${encodeURIComponent(issueId)}/session-archives/${encodeURIComponent(archiveId)}/complete?attempt=${attempt}`,
      {},
    );
    if (response.archive.status === "ready") this.sessionArchiveUploadAttempts.delete(key);
    return response.archive;
  }

  private requireSessionArchiveUploadAttempt(
    runtimeId: string,
    issueId: string,
    archiveId: string,
  ): { attempt: number; uploadUrl: string | null } {
    const claim = this.sessionArchiveUploadAttempts.get(sessionArchiveAttemptKey(runtimeId, issueId, archiveId));
    if (!claim) throw new Error("Session archive must be initialized before upload or completion");
    return claim;
  }

  private resolveSessionArchiveUploadTarget(
    expectedPath: string,
    advertisedUploadUrl: string | null,
  ): { url: URL; directCandidate: boolean } {
    const controlBase = new URL(`${this.baseUrl}/`);
    const advertised = advertisedUploadUrl ?? expectedPath;
    let target: URL;
    try {
      target = new URL(advertised, controlBase);
    } catch {
      throw new Error("Session archive upload_url is not a valid URL");
    }
    const expected = new URL(expectedPath, controlBase);
    if (
      (target.protocol !== "http:" && target.protocol !== "https:")
      || target.username
      || target.password
      || target.hash
      || target.pathname !== expected.pathname
      || target.search !== expected.search
    ) {
      throw new Error("Session archive upload_url does not match the initialized archive attempt");
    }

    if (this.sessionArchiveUploadBaseUrl) {
      return {
        url: new URL(expectedPath, this.sessionArchiveUploadBaseUrl),
        directCandidate: true,
      };
    }

    const absoluteAdvertised = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(advertised)
      || advertised.startsWith("//");
    if (!absoluteAdvertised) return { url: expected, directCandidate: false };
    if (target.hostname !== controlBase.hostname) {
      throw new Error(
        `Refusing Session Archive upload_url for unexpected host ${target.hostname}; `
        + "set MULTIREMI_ARCHIVE_UPLOAD_BASE_URL to explicitly trust a different API host.",
      );
    }
    if (controlBase.protocol === "https:" && target.protocol !== "https:") {
      throw new Error("Refusing Session Archive upload_url that downgrades the HTTPS control-plane connection");
    }
    return { url: target, directCandidate: true };
  }

  private async hasAttestedSessionArchiveDirectRoute(target: URL): Promise<boolean> {
    const cacheKey = target.origin;
    const now = Date.now();
    const cached = this.sessionArchiveDirectRoutes.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.direct;

    let direct = false;
    try {
      const resp = await fetch(target, {
        method: "HEAD",
        headers: this.headers(),
        redirect: "error",
        signal: AbortSignal.timeout(this.sessionArchiveDirectProbeTimeoutMs),
      });
      direct = resp.status === 204
        && resp.headers.get("X-Remi-Archive-Direct")?.trim() === "1";
      await resp.body?.cancel().catch(() => undefined);
    } catch {
      direct = false;
    }
    this.sessionArchiveDirectRoutes.set(cacheKey, {
      direct,
      expiresAt: now + this.sessionArchiveDirectProbeTtlMs,
    });
    return direct;
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

  private async post<T = unknown>(
    path: string,
    body: unknown,
    tokenOverride?: string | null,
    signal?: AbortSignal,
  ): Promise<T> {
    const resp = await fetch(this.baseUrl + path, {
      method: "POST",
      headers: this.headers("application/json", tokenOverride),
      body: JSON.stringify(body),
      signal,
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

function sessionArchiveUploadPath(runtimeId: string, issueId: string, archiveId: string, attempt: number): string {
  return `/api/daemon/runtimes/${encodeURIComponent(runtimeId)}/issues/${encodeURIComponent(issueId)}/session-archives/${encodeURIComponent(archiveId)}/content?attempt=${attempt}`;
}

function normalizeSessionArchiveUploadBaseUrl(value: string | null | undefined): URL | null {
  const raw = value?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("MULTIREMI_ARCHIVE_UPLOAD_BASE_URL must be an absolute http(s) URL");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("MULTIREMI_ARCHIVE_UPLOAD_BASE_URL must be an http(s) origin without credentials, path, query, or fragment");
  }
  return url;
}

function normalizeSessionArchiveProxyMaxBytes(value: number | undefined): number {
  if (value === undefined) return 8 * 1024 * 1024;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("MULTIREMI_ARCHIVE_PROXY_MAX_BYTES must be a non-negative safe integer");
  }
  return value;
}

function normalizeSessionArchiveDurationMs(
  value: number | undefined,
  fallback: number,
  environmentName: string,
): number {
  const duration = value ?? fallback;
  if (!Number.isSafeInteger(duration) || duration < 1) {
    throw new Error(`${environmentName} must be a positive safe integer`);
  }
  return duration;
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
    holdsWorkspace: booleanOrDefault(raw.holds_workspace ?? raw.holdsWorkspace, true),
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
    boundIssueUpdates: Array.isArray(raw.bound_issue_updates)
      ? raw.bound_issue_updates.filter((value: unknown): value is string => typeof value === "string")
      : Array.isArray(raw.boundIssueUpdates)
        ? raw.boundIssueUpdates.filter((value: unknown): value is string => typeof value === "string")
        : [],
    boundIssueUpdatesOmittedCount: numberOrDefault(
      raw.bound_issue_updates_omitted_count ?? raw.boundIssueUpdatesOmittedCount,
      0,
    ),
    boundIssue: normalizeDaemonClaimBoundIssue(raw.bound_issue ?? raw.boundIssue),
    chatBootstrapTranscript: stringOrNull(raw.chat_bootstrap_transcript ?? raw.chatBootstrapTranscript),
    chatMessageAttachments: Array.isArray(raw.chat_message_attachments)
      ? raw.chat_message_attachments
      : Array.isArray(raw.chatMessageAttachments)
        ? raw.chatMessageAttachments
        : [],
    triggerCommentAttachments: Array.isArray(raw.trigger_comment_attachments)
      ? raw.trigger_comment_attachments.map(normalizeDaemonClaimAttachment)
      : Array.isArray(raw.triggerCommentAttachments)
        ? raw.triggerCommentAttachments.map(normalizeDaemonClaimAttachment)
        : [],
    autopilotId: stringOrNull(raw.autopilot_id ?? raw.autopilotId),
    autopilotSource: stringOrNull(raw.autopilot_source ?? raw.autopilotSource),
    autopilotTitle: stringOrNull(raw.autopilot_title ?? raw.autopilotTitle),
    autopilotDescription: stringOrNull(raw.autopilot_description ?? raw.autopilotDescription),
    autopilotTriggerPayload: raw.autopilot_trigger_payload ?? raw.autopilotTriggerPayload ?? null,
    scmRevision: stringOrNull(raw.scm_revision ?? raw.scmRevision),
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
    agent: normalizeDaemonAgent(raw.agent),
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
    instructions: stringOrNull(raw.instructions),
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

function normalizeDaemonClaimBoundIssue(raw: any): MultiremiTaskWithAgent["boundIssue"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = stringOrNull(raw.id);
  const key = stringOrNull(raw.key ?? raw.identifier);
  const title = stringOrNull(raw.title);
  const status = stringOrNull(raw.status);
  if (!id || !key || !title || !status) return null;
  return { id, key, title, status };
}

export function normalizeDaemonAgent(raw: any): MultiremiAgent | null {
  if (!raw || typeof raw !== "object") return null;
  return {
    ...raw,
    avatarUrl: stringOrNull(raw.avatar_url ?? raw.avatarUrl),
    workspaceId: stringOrNull(raw.workspace_id ?? raw.workspaceId) ?? "",
    ownerId: stringOrNull(raw.owner_id ?? raw.ownerId) ?? "",
    runtimeId: stringOrNull(raw.runtime_id ?? raw.runtimeId),
    maxConcurrentTasks: numberOrDefault(raw.max_concurrent_tasks ?? raw.maxConcurrentTasks, 1),
    allowedTools: Array.isArray(raw.allowed_tools) ? raw.allowed_tools : Array.isArray(raw.allowedTools) ? raw.allowedTools : [],
    customEnv: objectOrDefault(raw.custom_env ?? raw.customEnv),
    customArgs: Array.isArray(raw.custom_args) ? raw.custom_args : Array.isArray(raw.customArgs) ? raw.customArgs : [],
    mcpConfig: raw.mcp_config ?? raw.mcpConfig ?? null,
    thinkingLevel: stringOrNull(raw.thinking_level ?? raw.thinkingLevel),
    issueCreationRequiresProposal: Boolean(
      raw.issue_creation_requires_proposal ?? raw.issueCreationRequiresProposal,
    ),
    supervisor: raw.supervisor === true,
    archivedAt: stringOrNull(raw.archived_at ?? raw.archivedAt),
    createdAt: stringOrNull(raw.created_at ?? raw.createdAt) ?? "",
    updatedAt: stringOrNull(raw.updated_at ?? raw.updatedAt) ?? "",
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
    attachments: Array.isArray(raw.attachments) ? raw.attachments.map(normalizeDaemonClaimAttachment) : [],
  };
}

function normalizeDaemonClaimAttachment(raw: any): any {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  return {
    ...raw,
    workspaceId: stringOrNull(raw.workspace_id ?? raw.workspaceId) ?? "",
    issueId: stringOrNull(raw.issue_id ?? raw.issueId),
    commentId: stringOrNull(raw.comment_id ?? raw.commentId),
    chatSessionId: stringOrNull(raw.chat_session_id ?? raw.chatSessionId),
    chatMessageId: stringOrNull(raw.chat_message_id ?? raw.chatMessageId),
    uploaderType: stringOrNull(raw.uploader_type ?? raw.uploaderType) ?? "",
    uploaderId: stringOrNull(raw.uploader_id ?? raw.uploaderId) ?? "",
    contentType: stringOrNull(raw.content_type ?? raw.contentType) ?? "application/octet-stream",
    sizeBytes: numberOrDefault(raw.size_bytes ?? raw.sizeBytes, 0),
    createdAt: stringOrNull(raw.created_at ?? raw.createdAt) ?? "",
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
          statusMessage: stringOrNull(doc.status_message ?? doc.statusMessage),
          syncStatus: stringOrNull(doc.sync_status ?? doc.syncStatus),
          syncError: stringOrNull(doc.sync_error ?? doc.syncError),
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
    path: String(entry.path ?? `${String(entry.slug ?? entry.id ?? "wiki")}.md`),
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

function booleanOrDefault(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  return fallback;
}

function objectOrDefault(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}
