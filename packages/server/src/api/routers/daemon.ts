import type { Hono } from "hono";
import { ensureDaemonProtocolUpgrade } from "../helpers/daemon-protocol-upgrade.js";
import { CHAT_ATTACHMENT_MAX_BYTES, sanitizeChatAttachmentFilename } from "@multiremi/contracts/attachments.js";
import { persistUploadedAttachments, detectContentTypeFromFilename,
  stringFormValue } from "../helpers/uploads.js";

import { resolveRequestWorkspaceId } from "../helpers/workspace-context.js";
import {
  bindDaemonTokenIdentityOrDeny,
  buildDaemonInstallInstructions,
  callerCanReceiveRelay,
  compareDaemonPendingTasks,
  daemonRegisterOwnerContext,
  denyCurrentUserWorkspaceAccess,
  denyDaemonTokenIssueDecisionAccess,
  denyDaemonTokenRuntimeIdentity,
  denyDaemonTokenTaskRuntimeIdentity,
  denyDaemonTokenWorkspace,
  denyUnprivilegedOwnerlessDaemonClaim,
  deregisterDaemonRuntimes,
  isDaemonPendingTaskForRuntime,
  isJsonApiError,
  isTerminalTaskStatus,
  issueFromParam,
  normalizeRuntimeIds,
  readJsonStrict,
  readJsonStrictAllowEmpty,
  registerDaemonRuntimes,
  promoteLegacyCliPatForDaemonHeartbeat,
  promoteLegacyCliPatForDaemonRegistration,
  localAttachmentFileResponse,
} from "../helpers.js";
import {
  authenticatedRequestUserId,
  cleanString,
  currentAccessToken,
  currentRequestUserId,
  currentWorkspaceRoleStrict,
  daemonBotAgentResponse,
  daemonHeartbeatHttpResponse,
  daemonTaskClaimResponse,
  daemonTaskWireResponse,
  workspaceReposResponse,
} from "../wire/index.js";
import {
  FEISHU_CONCIERGE_OUTBOUND_PROTOCOL_VERSION,
  FEISHU_DECISION_CARD_PROTOCOL_VERSION,
  FEISHU_ISSUE_DECISION_CARD_PROTOCOL_VERSION,
  FEISHU_DECISION_DEGRADE_REASONS,
  type FeishuDecisionDegradeReason,
  FEISHU_CONCIERGE_TASK_STREAM_PROTOCOL_VERSION,
  FEISHU_CONCIERGE_NATIVE_COT_PROTOCOL_VERSION,
  FEISHU_CONCIERGE_ATTACHMENT_PROTOCOL_VERSION,
  FEISHU_CONCIERGE_OUTBOUND_LEGACY_PROTOCOL_VERSION,
  FEISHU_CONCIERGE_OUTBOUND_CLAIM_HEADER,
  FEISHU_CONCIERGE_PROTOCOL_VERSION,
} from "@multiremi/contracts/types.js";
import { degradeMarkdownImages } from "@shared/feishu-markdown-images.js";
import { FeishuBotEncryptionError } from "@multiremi/feishu-bot/credentials.js";
import { isFeishuOpenId } from "@shared/feishu-mention.js";
import { normalizeFeishuBotErrorCode, redactFeishuBotError } from "@multiremi/feishu-bot/diagnostics.js";
import type {
  FeishuBotTaskSnapshot,
  MultiremiDaemonSshMeshStatus,
  MultiremiFeishuBotDaemonPayload,
  ReportBotMenuPublishInput,
  MultiremiIssueWorkspaceRepo,
  MultiremiIssueWorkspaceStatus,
  MultiremiTask,
  SubmitFeishuBotMessageInput,
} from "@multiremi/contracts/types.js";
import { TaskSteerPendingError } from "@multiremi/store/repos/tasks-repo.js";
import { SessionArchiveError } from "@multiremi/session-archive/service.js";
import { FeishuBotConfigError } from "@multiremi/store/repos/feishu-bot-repo.js";
import { IssueDecisionError } from "@multiremi/store/repos/issues-repo.js";
import { QuestionCardTokenError } from "@multiremi/store/question-card-token.js";
import { SshMeshKeyError } from "@multiremi/ssh-mesh/keys.js";

import { scmGitCredentialPassword } from "@multiremi/scm/access-token.js";
import { resolveScmRepositoryRemote } from "@multiremi/scm/repository-url.js";
import type { DaemonRegisterRequestBody } from "../helpers.js";
import type { RouterDeps } from "./deps.js";

type DaemonInstallRequestBody = {
  serverUrl?: string | null;
  server_url?: string | null;
  workspaceId?: string | null;
  workspace_id?: string | null;
  token?: string | null;
  provider?: string | null;
  version?: string | null;
  tokenName?: string | null;
  token_name?: string | null;
  expiresInDays?: number | null;
  expires_in_days?: number | null;
  createToken?: boolean | null;
  create_token?: boolean | null;
  daemonId?: string | null;
  daemon_id?: string | null;
};

const DAEMON_INSTALL_STRING_FIELDS = [
  "serverUrl",
  "server_url",
  "workspaceId",
  "workspace_id",
  "token",
  "provider",
  "version",
  "tokenName",
  "token_name",
  "daemonId",
  "daemon_id",
] as const;

function validateDaemonInstallRequestBody(
  value: unknown,
): { body: DaemonInstallRequestBody } | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "invalid request body" };
  }
  const body = value as Record<string, unknown>;
  for (const field of DAEMON_INSTALL_STRING_FIELDS) {
    if (body[field] != null && typeof body[field] !== "string") {
      return { error: `${field} must be a string` };
    }
  }
  const tokenName = body.tokenName ?? body.token_name;
  if (typeof tokenName === "string" && !tokenName.trim()) {
    return { error: "tokenName must not be empty" };
  }
  for (const field of ["expiresInDays", "expires_in_days"] as const) {
    const days = body[field];
    if (
      days != null &&
      (typeof days !== "number" || !Number.isFinite(days) || days <= 0)
    ) {
      return { error: `${field} must be a positive number` };
    }
  }
  for (const field of ["createToken", "create_token"] as const) {
    if (body[field] != null && typeof body[field] !== "boolean") {
      return { error: `${field} must be a boolean` };
    }
  }
  return { body: body as DaemonInstallRequestBody };
}

export function registerDaemonRoutes(app: Hono, deps: RouterDeps): void {
  const { store, authToken } = deps;

  app.post("/api/daemon/scm/git-credentials", async (c) => {
    const body = await readJsonStrict<{
      workspaceId?: string;
      workspace_id?: string;
      repositoryUrl?: string;
      repository_url?: string;
    }>(c);
    if ("apiError" in body) return c.json({ error: body.apiError }, body.statusCode);
    const repositoryUrl = cleanString(body.repositoryUrl ?? body.repository_url);
    if (!repositoryUrl) return c.json({ error: "repositoryUrl is required" }, 400);

    const token = currentAccessToken(c);
    const task = token?.type === "task" && token.taskId
      ? store.getTaskWithAgent(token.taskId)
      : null;
    if (token?.type === "task" && (!task || isTerminalTaskStatus(task.status))) {
      return c.json({ error: "task credential is no longer active", code: "task_credential_inactive" }, 403);
    }
    if (task?.issueSessionId && store.getIssueSession(task.issueSessionId)?.withCode) {
      return c.json({ error: "Read-only code snapshots cannot obtain Git credentials", code: "readonly_code_snapshot" }, 403);
    }
    const workspaceId = token?.workspaceId
      ?? cleanString(body.workspaceId ?? body.workspace_id)
      ?? "local";
    const assertedWorkspaceId = cleanString(body.workspaceId ?? body.workspace_id);
    if (assertedWorkspaceId && assertedWorkspaceId !== workspaceId) {
      return c.json({ error: "forbidden for token workspace" }, 403);
    }

    const binding = store.findScmRepositoryBindingByUrl(workspaceId, repositoryUrl);
    if (!binding?.enabled) return c.json({ error: "repository credential not found" }, 404);
    if (task) {
      const taskMayUseRepository = task.workspaceId === workspaceId && task.repos.some((repo) => {
        const allowed = store.findScmRepositoryBindingByUrl(workspaceId, repo.url);
        return allowed?.repositoryId === binding.repositoryId
          && allowed.connectionId === binding.connectionId;
      });
      if (!taskMayUseRepository) return c.json({ error: "repository credential not found" }, 404);
    }

    const connection = store.getScmConnection(binding.connectionId);
    if (!connection?.enabled) {
      return c.json({ error: "repository credential is not configured", code: "scm_credential_missing" }, 409);
    }
    let cloneUrl: string;
    try {
      cloneUrl = resolveScmRepositoryRemote(binding.repositoryUrl, connection.baseUrl).cloneUrl;
    } catch {
      return c.json({
        error: "repository does not match its SCM connection",
        code: "scm_repository_origin_mismatch",
      }, 409);
    }
    const credential = store.getScmConnectionCredential(binding.connectionId);
    if (!credential?.accessToken) {
      return c.json({ error: "repository credential is not configured", code: "scm_credential_missing" }, 409);
    }
    const password = scmGitCredentialPassword(connection.provider, credential.accessToken);
    if (!password || /[\r\n]/u.test(password)) {
      return c.json({ error: "repository credential is invalid", code: "scm_credential_invalid" }, 500);
    }
    // The stored PAT lifetime is independent of this timestamp. It only bounds
    // how long Git may cache the credential returned to its helper process.
    const helperCacheExpiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    c.header("Cache-Control", "no-store");
    return c.json({
      repositoryId: binding.repositoryId,
      repositoryUrl: binding.repositoryUrl,
      cloneUrl,
      username: connection.provider === "github" ? "x-access-token" : "oauth2",
      password,
      // Keep the wire key for Git credential-helper compatibility.
      expiresAt: helperCacheExpiresAt,
    });
  });

  app.get("/api/multiremi/install/daemon", (c) => {
    const workspaceId = resolveRequestWorkspaceId(c, store, c.req.query("workspaceId") ?? c.req.query("workspace_id"));
    if (workspaceId instanceof Response) return workspaceId;
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    return c.json(buildDaemonInstallInstructions({
      requestUrl: c.req.url,
      daemonServerUrl: deps.daemonDirectBaseUrl,
      serverUrl: c.req.query("serverUrl") ?? c.req.query("server_url"),
      workspaceId,
      token: c.req.query("token"),
      provider: c.req.query("provider"),
      version: c.req.query("version"),
      daemonId: c.req.query("daemonId") ?? c.req.query("daemon_id"),
    }));
  });
  app.post("/api/multiremi/install/daemon", async (c) => {
    const parsedBody = await readJsonStrict<unknown>(c);
    if (isJsonApiError(parsedBody)) {
      return c.json({ error: parsedBody.apiError }, parsedBody.statusCode);
    }
    const validatedBody = validateDaemonInstallRequestBody(parsedBody);
    if ("error" in validatedBody) {
      return c.json({ error: validatedBody.error }, 400);
    }
    const body = validatedBody.body;
    const workspaceId = resolveRequestWorkspaceId(c, store, cleanString(
      body.workspaceId ?? body.workspace_id ?? c.req.query("workspaceId") ?? c.req.query("workspace_id"),
    ));
    if (workspaceId instanceof Response) return workspaceId;
    const actorToken = currentAccessToken(c);
    if (actorToken?.type === "task") {
      return c.json({ error: "forbidden for task token", code: "task_token_hard_denied" }, 403);
    }
    if (actorToken?.type === "daemon") {
      return c.json({ error: "this endpoint is only available to human actors" }, 403);
    }
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const requestedDaemonId = cleanString(
      body.daemonId ?? body.daemon_id ?? c.req.query("daemonId") ?? c.req.query("daemon_id"),
    );
    if (requestedDaemonId) {
      const role = currentWorkspaceRoleStrict(c, store, workspaceId);
      const isOpenOrMaster = actorToken === null && authenticatedRequestUserId(c) === null;
      if (role !== "owner" && role !== "admin" && !isOpenOrMaster) {
        return c.json({
          error: "workspace admin access required to specify daemonId",
          code: "workspace_admin_required",
        }, 403);
      }
    }
    const daemonId = requestedDaemonId ?? `dmn_${crypto.randomUUID().replace(/-/g, "")}`;
    let token = body.token ?? c.req.query("token");
    let tokenId: string | null = null;
    const shouldCreateToken = (body.createToken ?? body.create_token ?? true) !== false;

    const installInput = {
      requestUrl: c.req.url,
      daemonServerUrl: deps.daemonDirectBaseUrl,
      serverUrl: body.serverUrl ?? body.server_url ?? c.req.query("serverUrl") ?? c.req.query("server_url"),
      workspaceId,
      token,
      daemonId,
      provider: body.provider ?? c.req.query("provider"),
      version: body.version ?? c.req.query("version"),
    };
    let instructions = buildDaemonInstallInstructions(installInput);
    if (!token && shouldCreateToken) {
      const created = await store.createAccessToken({
        workspaceId,
        // Own the daemon token by the user provisioning it, so runtimes it later
        // registers are attributed to that person (FR6/FR8).
        userId: currentRequestUserId(c),
        daemonId,
        name: body.tokenName ?? body.token_name ?? "Multiremi daemon",
        type: "daemon",
      });
      token = created.token;
      tokenId = created.id;
      instructions = buildDaemonInstallInstructions({
        ...installInput,
        token,
        tokenId,
      });
    }
    return tokenId ? c.json(instructions, 201) : c.json(instructions);
  });
  app.post("/api/daemon/register", async (c) => {
    const body = await readJsonStrict<DaemonRegisterRequestBody>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const registerWorkspace = resolveRequestWorkspaceId(c, store, cleanString(body.workspace_id));
    if (registerWorkspace instanceof Response) return registerWorkspace;
    const denied = denyDaemonTokenWorkspace(c, registerWorkspace);
    if (denied) return denied;
    const registerDaemonId = String(body.daemon_id ?? "").trim();
    if (registerDaemonId && store.isDaemonRetired(registerWorkspace, registerDaemonId)) {
      return c.json({ error: "daemon has been retired", code: "daemon_retired" }, 410);
    }
    const ownerlessClaimDenied = denyUnprivilegedOwnerlessDaemonClaim(
      c,
      store,
      registerWorkspace,
      registerDaemonId,
    );
    if (ownerlessClaimDenied) return ownerlessClaimDenied;
    const upgradeDenied = promoteLegacyCliPatForDaemonRegistration(
      c,
      store,
      registerWorkspace,
      registerDaemonId,
    );
    if (upgradeDenied) return upgradeDenied;
    const owner = daemonRegisterOwnerContext(c, store, registerWorkspace);
    if ("error" in owner) return c.json({ error: owner.error }, owner.status);
    const identityDenied = bindDaemonTokenIdentityOrDeny(c, store, body.daemon_id);
    if (identityDenied) return identityDenied;
    const includeRelay = callerCanReceiveRelay(c, store, registerWorkspace);
    // Legacy daemon ids are an unauthenticated migration hint, not proof that
    // one machine owns another. A bound daemon credential may never use that
    // hint to merge a sibling machine's Runtime; only the historical
    // master/open bootstrap path retains legacy migration compatibility.
    const usesMasterToken = Boolean(authToken)
      && c.req.header("Authorization") === `Bearer ${authToken}`;
    const result = registerDaemonRuntimes(store, { ...body, workspace_id: registerWorkspace }, owner, includeRelay, {
      allowLegacyDaemonMigration:
        currentAccessToken(c)?.type !== "daemon" && (!authToken || usesMasterToken),
    });
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result);
  });
  app.post("/api/daemon/deregister", async (c) => {
    const body = await readJsonStrict<{ runtime_ids?: string[] }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const runtimeIds = normalizeRuntimeIds(body.runtime_ids);
    if ("error" in runtimeIds) return c.json({ error: runtimeIds.error }, runtimeIds.status);
    deregisterDaemonRuntimes(c, store, runtimeIds.runtimeIds);
    return c.json({ status: "ok" });
  });
  app.post("/api/daemon/runtimes/:runtimeId/tasks/claim", (c) => c.json({ task: null }));
  app.post("/api/daemon/heartbeat", async (c) => {
    const body = await readJsonStrict<{
      runtime_id?: string;
      supports_batch_import?: boolean;
      supports_directory_scan?: boolean;
      supports_skill_directory?: boolean;
      agent_plugin_protocol?: number;
      ssh_mesh_protocol?: number;
      ssh_mesh_status?: MultiremiDaemonSshMeshStatus;
      drain_ack_generation?: number;
      active_task_count?: number;
      supports_bot_menu?: boolean;
      feishu_concierge_protocol?: number;
      feishu_decision_card?: number;
      feishu_issue_decision_card?: number;
      feishu_outbound_kinds?: number;
    }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const runtimeId = body.runtime_id ?? "";
    if (!runtimeId) return c.json({ error: "runtime_id is required" }, 400);
    const upgradeDenied = promoteLegacyCliPatForDaemonHeartbeat(c, store, runtimeId);
    if (upgradeDenied) return upgradeDenied;
    const denied = denyDaemonTokenRuntimeIdentity(c, store, runtimeId);
    if (denied) return denied;
    const reportsAgentPluginProtocol = Object.prototype.hasOwnProperty.call(body, "agent_plugin_protocol");
    const reportsSshMeshProtocol = Object.prototype.hasOwnProperty.call(body, "ssh_mesh_protocol");
    const authorization = c.req.header("Authorization") ?? "";
    const usesMasterToken = Boolean(authToken) && authorization === `Bearer ${authToken}`;
    if (
      (reportsAgentPluginProtocol || reportsSshMeshProtocol) &&
      currentAccessToken(c)?.type !== "daemon" &&
      authToken &&
      !usesMasterToken
    ) {
      return c.json({ error: "daemon token required", code: "daemon_token_required" }, 403);
    }
    // A daemon that can host the concierge says so on every heartbeat, so
    // silence is an answer: the build is older and must not be assigned the
    // connector. Letting the flag stay true from an earlier run could assign a
    // bot to code that cannot host it.
    const feishuConciergeProtocol = normalizeDaemonProtocolVersion(body.feishu_concierge_protocol);
    const supportsFeishuBotConfig = feishuConciergeProtocol >= FEISHU_CONCIERGE_PROTOCOL_VERSION;
    const ack = store.heartbeatRuntime(runtimeId, {
      supportsBatchImport: body.supports_batch_import ?? false,
      supportsDirectoryScan: body.supports_directory_scan ?? false,
      supportsSkillDirectory: body.supports_skill_directory === true,
      agentPluginProtocol: reportsAgentPluginProtocol ? body.agent_plugin_protocol : undefined,
      supportsBotMenu: body.supports_bot_menu,
      supportsFeishuBotConfig,
      supportsDecisionCard: normalizeDaemonProtocolVersion(body.feishu_decision_card)
        >= FEISHU_DECISION_CARD_PROTOCOL_VERSION,
      // MUL-412: a separate flag, so a host that predates decisions keeps its
      // human-request cards while the control plane leaves decision cards off
      // its queue entirely.
      supportsIssueDecisionCard: normalizeDaemonProtocolVersion(body.feishu_issue_decision_card)
        >= FEISHU_ISSUE_DECISION_CARD_PROTOCOL_VERSION,
    });
    if (ack.status === "runtime_gone") return c.json({ error: "runtime not found" }, 404);
    ensureDaemonProtocolUpgrade(store, runtimeId, ack);
    if (reportsSshMeshProtocol) {
      const protocol = normalizeDaemonProtocolVersion(body.ssh_mesh_protocol);
      const meshAck = store.recordSshMeshHeartbeat(runtimeId, protocol, body.ssh_mesh_status);
      void meshAck;
    } else {
      store.recordSshMeshHeartbeat(runtimeId, 0);
    }
    // Reading the maintenance row also enforces the drain lease TTL lazily,
    // so an expired lease flips back to normal on the very next heartbeat.
    const maintenance = store.getPlatformMaintenance();
    ack.drain = { mode: maintenance.mode, generation: maintenance.generation };
    const ackGeneration = Number(body.drain_ack_generation);
    if (Number.isSafeInteger(ackGeneration) && ackGeneration >= 0) {
      const activeCount = Number(body.active_task_count);
      store.recordRuntimeDrainAck(
        runtimeId,
        ackGeneration,
        Number.isSafeInteger(activeCount) && activeCount >= 0 ? activeCount : null,
      );
    }
    const response = daemonHeartbeatHttpResponse(ack);
    return c.json(response);
  });

  /**
   * The only route that hands out decrypted Feishu credentials, and it is
   * scoped twice over: the daemon token must be bound to this Runtime, and the
   * store returns null unless this Runtime is the one selected to host the bot.
   */
  app.get("/api/daemon/runtimes/:runtimeId/feishu-bot", (c) => {
    const runtimeId = c.req.param("runtimeId");
    if (currentAccessToken(c)?.type !== "daemon") {
      return c.json({ error: "daemon token required", code: "daemon_token_required" }, 403);
    }
    const denied = denyDaemonTokenRuntimeIdentity(c, store, runtimeId);
    if (denied) return denied;
    const runtime = store.getRuntime(runtimeId);
    if (!runtime) return c.json({ error: "runtime not found" }, 404);
    try {
      const workspaceId = runtime.workspaceId ?? "local";
      const config = store.getFeishuBotDaemonConfig(workspaceId, runtimeId);
      if (!config) return c.json({ error: "feishu bot is not assigned to this runtime" }, 404);
      // The Agent ships with the credentials so the daemon can boot the channel
      // from one fetch. An archived Agent already disables the config, so a
      // missing row here means it was deleted outright: say so with a code the
      // daemon can report instead of a generic start failure.
      const agent = store.getAgent(config.agent_id);
      if (!agent || agent.workspaceId !== workspaceId || agent.archivedAt) {
        return c.json({ error: "feishu bot agent is unavailable", code: "agent_unavailable" }, 409);
      }
      const payload: MultiremiFeishuBotDaemonPayload = {
        ...config,
        bot_agent: daemonBotAgentResponse(agent),
      };
      c.header("Cache-Control", "no-store");
      return c.json(payload);
    } catch (error) {
      if (error instanceof FeishuBotEncryptionError) {
        return c.json({ error: error.message, code: error.code }, 503);
      }
      throw error;
    }
  });

  /**
   * Cards this Runtime must keep answering clicks for (MUL-407). The host's
   * click map is process-local, so it re-registers from here on every start;
   * unlike a Task-stream card there is no presentation checkpoint to replay.
   */
  app.get("/api/daemon/runtimes/:runtimeId/feishu-bot/decision-cards", (c) => {
    const runtimeId = c.req.param("runtimeId");
    if (currentAccessToken(c)?.type !== "daemon") {
      return c.json({ error: "daemon token required", code: "daemon_token_required" }, 403);
    }
    const denied = denyDaemonTokenRuntimeIdentity(c, store, runtimeId);
    if (denied) return denied;
    const runtime = store.getRuntimeLite(runtimeId);
    if (!runtime) return c.json({ error: "runtime not found", code: "runtime_not_found" }, 404);
    const workspaceId = runtime.workspaceId ?? "local";
    // Two card families ride this route (MUL-407, MUL-412); each is listed only
    // for a host that declared the matching capability, exactly like the queue.
    const humanRequestCards = store.listFeishuBotLiveDecisionCards(workspaceId, runtimeId);
    const issueDecisionCards = store.listFeishuIssueDecisionCards(workspaceId, runtimeId);
    // The S5a rows keep exactly their old shape; only the new family carries a
    // discriminator, so an older daemon's parser is unaffected.
    const cards = [
      ...humanRequestCards,
      ...issueDecisionCards.map(card => ({
        lane: "issue_decision",
        issue_id: card.issue_id,
        decision_id: card.decision_id,
        chat_id: card.chat_id,
        message_id: card.message_id,
        recipient_open_id: card.recipient_open_id,
      })),
    ];
    c.header("Cache-Control", "no-store");
    return c.json({ cards });
  });

  app.get(
    "/api/daemon/runtimes/:runtimeId/feishu-bot/outbound/:deliveryId/attachments/:attachmentId",
    async (c) => {
      if (currentAccessToken(c)?.type !== "daemon") {
        return c.json({ error: "daemon token required", code: "daemon_token_required" }, 403);
      }
      const runtimeId = c.req.param("runtimeId");
      const runtime = store.getRuntime(runtimeId);
      if (!runtime) return c.json({ error: "attachment not available" }, 404);
      const claimToken = cleanString(c.req.header(FEISHU_CONCIERGE_OUTBOUND_CLAIM_HEADER));
      if (!claimToken) return c.json({ error: "attachment not available" }, 404);
      const attachment = store.getFeishuBotOutboundAttachment(
        runtime.workspaceId ?? "local",
        runtimeId,
        c.req.param("deliveryId"),
        claimToken,
        c.req.param("attachmentId"),
      );
      if (!attachment) return c.json({ error: "attachment not available" }, 404);
      if (
        !attachment.url.startsWith("/api/attachments/")
        || attachment.sizeBytes > CHAT_ATTACHMENT_MAX_BYTES
      ) {
        return c.json({ error: "attachment not available" }, 404);
      }
      return localAttachmentFileResponse(attachment);
    },
  );
  app.post("/api/daemon/runtimes/:runtimeId/feishu-bot/attachments", async (c) => {
    if (currentAccessToken(c)?.type !== "daemon") return c.json({ error: "daemon token required" }, 403);
    const runtimeId = c.req.param("runtimeId");
    const denied = denyDaemonTokenRuntimeIdentity(c, store, runtimeId);
    if (denied) return denied;
    const runtime = store.getRuntime(runtimeId);
    if (!runtime) return c.json({ error: "runtime not found" }, 404);
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return c.json({ error: "missing file field" }, 400);
    if (file.size > CHAT_ATTACHMENT_MAX_BYTES) return c.json({ error: "attachment exceeds the 20MB limit" }, 413);
    const scope = { revision: Number(form.get("revision")),
      externalSessionKey: stringFormValue(form.get("external_session_key")) ?? "",
      externalMessageId: stringFormValue(form.get("external_message_id")) ?? "" };
    const workspaceId = runtime.workspaceId ?? "local";
    try {
      store.assertFeishuBotInboundAttachmentScope(workspaceId, runtimeId, scope);
      const filename = sanitizeChatAttachmentFilename(file.name);
      const attachment = await persistUploadedAttachments(workspaceId, [{ filename,
        bytes: new Uint8Array(await file.arrayBuffer()), contentType: detectContentTypeFromFilename(filename) }],
        ([input]) => store.createFeishuBotInboundAttachment(workspaceId, runtimeId, scope, input!));
      return c.json({ attachment }, 201);
    } catch (error) {
      if (error instanceof FeishuBotConfigError) return c.json({ error: error.message, code: error.code }, error.status as 400 | 403 | 409);
      return c.json({ error: error instanceof Error ? error.message : "attachment upload failed" }, 400);
    }
  });
  app.post("/api/daemon/runtimes/:runtimeId/feishu-bot/messages", async (c) => {
    const runtimeId = c.req.param("runtimeId");
    const denied = denyDaemonTokenRuntimeIdentity(c, store, runtimeId);
    if (denied) return denied;
    const runtime = store.getRuntime(runtimeId);
    if (!runtime) return c.json({ error: "runtime not found", code: "runtime_not_found" }, 404);
    const body = await readJsonStrict<{
      revision?: unknown;
      external_session_key?: unknown;
      external_message_id?: unknown;
      chat_type?: unknown;
      reply_to_message_id?: unknown;
      sender_open_id?: unknown;
      sender_user_id?: unknown;
      sender_union_id?: unknown;
      sender_tenant_key?: unknown;
      sender_name?: unknown;
      chat_id?: unknown;
      thread_id?: unknown;
      delivery_mode?: unknown;
      attachment_ids?: unknown;
      text?: unknown;
    }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    if (body.attachment_ids !== undefined && (!Array.isArray(body.attachment_ids)
      || body.attachment_ids.length > 10 || body.attachment_ids.some(id => typeof id !== "string" || !id.trim()))) {
      return c.json({ error: "attachment_ids must contain at most 10 attachment IDs" }, 400);
    }
    const revision = Number(body.revision);
    const input: SubmitFeishuBotMessageInput = {
      attachmentIds: body.attachment_ids as string[] | undefined,
      revision: Number.isSafeInteger(revision) ? revision : -1,
      externalSessionKey: cleanString(typeof body.external_session_key === "string" ? body.external_session_key : null) ?? "",
      externalMessageId: cleanString(typeof body.external_message_id === "string" ? body.external_message_id : null) ?? "",
      chatType: body.chat_type === "p2p" || body.chat_type === "group" ? body.chat_type : null,
      replyToMessageId: cleanString(typeof body.reply_to_message_id === "string" ? body.reply_to_message_id : null),
      senderOpenId: cleanString(typeof body.sender_open_id === "string" ? body.sender_open_id : null),
      senderUserId: cleanString(typeof body.sender_user_id === "string" ? body.sender_user_id : null),
      senderUnionId: cleanString(typeof body.sender_union_id === "string" ? body.sender_union_id : null),
      senderTenantKey: cleanString(typeof body.sender_tenant_key === "string" ? body.sender_tenant_key : null),
      senderName: cleanString(typeof body.sender_name === "string" ? body.sender_name : null),
      chatId: cleanString(typeof body.chat_id === "string" ? body.chat_id : null),
      threadId: cleanString(typeof body.thread_id === "string" ? body.thread_id : null),
      text: typeof body.text === "string" ? body.text : "",
      deliveryMode: body.delivery_mode === "native_cot_v1" ? "native_cot_v1" : undefined,
    };
    try {
      return c.json(store.submitFeishuBotMessage(runtime.workspaceId ?? "local", runtimeId, input), 202);
    } catch (error) {
      if (error instanceof FeishuBotConfigError) {
        return c.json(
          { error: error.message, code: error.code },
          error.status as 400 | 403 | 409,
        );
      }
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
  app.post("/api/daemon/runtimes/:runtimeId/feishu-bot/session/reset", async (c) => {
    const runtimeId = c.req.param("runtimeId");
    const denied = denyDaemonTokenRuntimeIdentity(c, store, runtimeId);
    if (denied) return denied;
    const runtime = store.getRuntime(runtimeId);
    if (!runtime) return c.json({ error: "runtime not found" }, 404);
    const body = await readJsonStrict<{ revision?: unknown; external_session_key?: unknown }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    return c.json({
      reset: store.resetFeishuBotSession(
        runtime.workspaceId ?? "local",
        runtimeId,
        Number(body.revision),
        cleanString(typeof body.external_session_key === "string" ? body.external_session_key : null) ?? "",
      ),
    });
  });
  app.post("/api/daemon/runtimes/:runtimeId/feishu-bot/session/cancel", async (c) => {
    const runtimeId = c.req.param("runtimeId");
    const denied = denyDaemonTokenRuntimeIdentity(c, store, runtimeId);
    if (denied) return denied;
    const runtime = store.getRuntime(runtimeId);
    if (!runtime) return c.json({ error: "runtime not found" }, 404);
    const body = await readJsonStrict<{
      revision?: unknown;
      external_session_key?: unknown;
      chat_id?: unknown;
      sender_open_id?: unknown;
      target?: unknown;
    }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    // `chat_id`/`sender_open_id`/`target` are optional: an older daemon omits
    // them and keeps the original thread-scoped behaviour.
    const result = store.cancelFeishuBotSessionTask(
      runtime.workspaceId ?? "local",
      runtimeId,
      Number(body.revision),
      cleanString(typeof body.external_session_key === "string" ? body.external_session_key : null) ?? "",
      {
        chatId: cleanString(typeof body.chat_id === "string" ? body.chat_id : null),
        senderOpenId: cleanString(typeof body.sender_open_id === "string" ? body.sender_open_id : null),
        target: cleanString(typeof body.target === "string" ? body.target : null),
      },
    );
    return c.json({
      outcome: result.outcome,
      cancelled: result.outcome === "cancelled",
      task_id: result.taskId,
      agent_name: result.agentName,
      issue_key: result.issueKey,
      chat_title: result.chatTitle,
      candidates: result.candidates.map((candidate) => ({
        task_id: candidate.taskId,
        status: candidate.status,
        agent_name: candidate.agentName,
        issue_id: candidate.issueId,
        issue_key: candidate.issueKey,
        chat_title: candidate.chatTitle,
        started_at: candidate.startedAt,
      })),
      candidate_count: result.candidateCount,
      reason: result.reason,
    });
  });
  app.post("/api/daemon/runtimes/:runtimeId/feishu-bot/session/inspect", async (c) => {
    const runtimeId = c.req.param("runtimeId");
    const denied = denyDaemonTokenRuntimeIdentity(c, store, runtimeId);
    if (denied) return denied;
    const runtime = store.getRuntime(runtimeId);
    if (!runtime) return c.json({ error: "runtime not found" }, 404);
    const body = await readJsonStrict<{ revision?: unknown; external_session_key?: unknown }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const snapshot = store.inspectFeishuBotSession(
      runtime.workspaceId ?? "local",
      runtimeId,
      Number(body.revision),
      cleanString(typeof body.external_session_key === "string" ? body.external_session_key : null) ?? "",
    );
    return c.json({
      chat_session_id: snapshot.chatSessionId,
      agent_id: snapshot.agentId,
      agent_name: snapshot.agentName,
      task: snapshot.task
        ? {
            task_id: snapshot.task.taskId,
            status: snapshot.task.status,
            result: snapshot.task.result,
            error: snapshot.task.error,
            session_id: snapshot.task.sessionId,
            work_dir: snapshot.task.workDir,
            usage: snapshot.task.usage,
          }
        : null,
    });
  });

  app.get("/api/daemon/ssh-mesh/config", (c) => {
    const runtimeId = String(c.req.query("runtime_id") ?? "").trim();
    if (!runtimeId) return c.json({ error: "runtime_id is required" }, 400);
    if (currentAccessToken(c)?.type !== "daemon") {
      return c.json({ error: "daemon token required", code: "daemon_token_required" }, 403);
    }
    const denied = denyDaemonTokenRuntimeIdentity(c, store, runtimeId);
    if (denied) return denied;
    try {
      const config = store.getSshMeshConfigForDaemon(runtimeId);
      if (!config) return c.json({ error: "runtime not found" }, 404);
      c.header("Cache-Control", "no-store");
      return c.json(config);
    } catch (error) {
      if (error instanceof SshMeshKeyError) {
        return c.json({ error: error.message, code: error.code }, 503);
      }
      throw error;
    }
  });
  app.get("/api/daemon/workspaces/:workspaceId/repos", (c) => {
    const denied = denyDaemonTokenWorkspace(c, c.req.param("workspaceId"));
    if (denied) return denied;
    const includeRelay = callerCanReceiveRelay(c, store, c.req.param("workspaceId"));
    const response = workspaceReposResponse(store, c.req.param("workspaceId"), includeRelay);
    if (!response) return c.json({ error: "workspace not found" }, 404);
    return c.json(response);
  });
  app.post("/api/daemon/workspaces/:workspaceId/external-membership/check", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const denied = denyDaemonTokenWorkspace(c, workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<{ external_id?: string }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const externalId = cleanString(body.external_id);
    if (!externalId) return c.json({ error: "external_id is required" }, 400);

    const user = store.getUserByExternalId(externalId);
    // This user-table id must have an explicit membership link, not a member-row alias.
    const allowed = Boolean(user && store.findWorkspaceMemberForUser(user.id, workspaceId));
    c.header("Cache-Control", "no-store");
    return c.json({ allowed });
  });
  // Temporary HTTP orphan recovery remains until the v2 startup path is retired.
  app.post("/api/daemon/runtimes/:runtimeId/recover-orphans", (c) => {
    const runtimeId = c.req.param("runtimeId");
    if (!store.getRuntime(runtimeId)) return c.json({ error: "runtime not found" }, 404);
    return c.json(store.recoverOrphans(runtimeId));
  });

  app.post("/api/daemon/tasks/:taskId/start", (c) => {
    const taskId = c.req.param("taskId");
    const identityDenied = denyDaemonTokenTaskRuntimeIdentity(c, store, taskId);
    if (identityDenied) return identityDenied;
    const existing = store.getTask(taskId);
    if (!existing) return c.json({ error: "task not found" }, 404);
    if (existing.status !== "dispatched" && existing.status !== "waiting_local_directory") {
      return c.json({ error: "start task: no rows in result set" }, 400);
    }
    const task = store.startTask(taskId);
    return c.json(daemonTaskWireResponse(task, store.getTaskTriggerMetadata(task)));
  });
  app.post("/api/daemon/tasks/:taskId/wait-local-directory", async (c) => {
    const taskId = c.req.param("taskId");
    const body = await readJsonStrictAllowEmpty<{ reason?: string }>(c);
    if ("apiError" in body) return c.json({ error: body.apiError }, body.statusCode);
    const identityDenied = denyDaemonTokenTaskRuntimeIdentity(c, store, taskId);
    if (identityDenied) return identityDenied;
    const existing = store.getTask(taskId);
    if (!existing) return c.json({ error: "task not found" }, 404);
    if (existing.status !== "dispatched") {
      return c.json({ error: "mark task waiting_local_directory: no rows in result set" }, 400);
    }
    let task: MultiremiTask;
    try {
      task = store.markTaskWaitingLocalDirectory(taskId, body.reason);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    return c.json(daemonTaskWireResponse(task, store.getTaskTriggerMetadata(task)));
  });
  app.get("/api/daemon/tasks/:taskId/status", (c) => {
    const taskId = c.req.param("taskId");
    const identityDenied = denyDaemonTokenTaskRuntimeIdentity(c, store, taskId);
    if (identityDenied) return identityDenied;
    // MUL-474: the response fields, projected without `prompt`. The body is a
    // contract (the Feishu host renders `getFeishuBotTaskSnapshot` from it), so
    // every field it returned before is still returned here.
    const task = store.getTaskStatusSnapshot(taskId);
    if (!task) return c.json({ error: "task not found" }, 404);
    const snapshot: FeishuBotTaskSnapshot = {
      taskId: task.id,
      status: task.status,
      result: task.result,
      error: task.error,
      sessionId: task.sessionId,
      workDir: task.workDir,
      usage: task.usage,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
    };
    return c.json({
      task_id: snapshot.taskId,
      status: snapshot.status,
      result: snapshot.result,
      error: snapshot.error,
      session_id: snapshot.sessionId,
      work_dir: snapshot.workDir,
      usage: snapshot.usage,
      started_at: snapshot.startedAt,
      completed_at: snapshot.completedAt,
      receipt_message_ids: store.listFeishuBotTaskReceiptMessageIds(task.workspaceId, task.id),
    });
  });
  app.get("/api/daemon/issues/:issueId/gc-check", (c) => {
    const issue = issueFromParam(store, c, "issueId");
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const hasActiveTask = store.listTasksForIssue(issue.id).some(
      (task) => !["completed", "failed", "cancelled"].includes(task.status),
    );
    if (hasActiveTask) return c.json({ status: "active", updated_at: issue.updatedAt });
    return c.json({ status: issue.status, updated_at: issue.updatedAt });
  });
  app.post("/api/daemon/issues/:issueId/workspace/cleaned", async (c) => {
    const body = await readJsonStrict<{
      runtime_id?: string;
      archive_id?: string;
      source_revision?: string;
      sha256?: string;
    }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const runtimeId = body.runtime_id?.trim() ?? "";
    if (!runtimeId) return c.json({ error: "runtime_id is required" }, 400);
    const archiveId = body.archive_id?.trim() ?? "";
    const sourceRevision = body.source_revision?.trim() ?? "";
    const sha256 = body.sha256?.trim().toLowerCase() ?? "";
    const denied = denyDaemonTokenRuntimeIdentity(c, store, runtimeId);
    if (denied) return denied;
    if (!archiveId || !sourceRevision || !/^[a-f0-9]{64}$/.test(sha256)) {
      return c.json({
        error: "archive_id, source_revision and a 64-character sha256 are required",
      }, 400);
    }
    const issueId = c.req.param("issueId");
    if (!store.getIssue(issueId)) {
      return c.json({ error: "issue not found", code: "issue_not_found" }, 404);
    }
    const current = store.getIssueWorkspace(issueId);
    if (!current) {
      return c.json({
        error: "issue workspace not found",
        code: "issue_workspace_not_found",
      }, 404);
    }
    if (current.runtimeId !== runtimeId) {
      return c.json({
        error: "runtime does not own issue workspace",
        code: "issue_workspace_runtime_mismatch",
      }, 404);
    }
    try {
      const verified = await deps.sessionArchives.verify(archiveId);
      if (
        !verified.valid
        || verified.archive.issueId !== issueId
        || verified.archive.sourceRevision !== sourceRevision
        || verified.archive.sha256 !== sha256
      ) {
        return c.json({
          error: "workspace cleanup archive is missing, corrupt, or does not match the exact snapshot",
          code: "issue_workspace_archive_invalid",
        }, 409);
      }
      const workspace = store.markIssueWorkspaceCleaned({
        issueId,
        runtimeId,
        archiveId,
        sourceRevision,
        sha256,
      });
      return c.json({
        issue_id: workspace.issueId,
        status: workspace.status,
        cleaned_at: workspace.cleanedAt,
        archive_id: workspace.cleanedArchiveId,
        source_revision: workspace.cleanedArchiveSourceRevision,
        sha256: workspace.cleanedArchiveSha256,
      });
    } catch (err) {
      if (err instanceof SessionArchiveError) {
        return c.json({ error: err.message, code: err.code }, err.status as 400);
      }
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, message.includes("exact ready") ? 409 : 400);
    }
  });
  app.get("/api/daemon/chat-sessions/:sessionId/gc-check", (c) => {
    const session = store.getChatSession(c.req.param("sessionId"));
    if (!session) return c.json({ error: "chat session not found" }, 404);
    return c.json({ status: session.status, updated_at: session.updatedAt });
  });
  app.get("/api/daemon/autopilot-runs/:runId/gc-check", (c) => {
    const run = store.getAutopilotRun(c.req.param("runId"));
    if (!run) return c.json({ error: "autopilot run not found" }, 404);
    return c.json({ status: run.status, completed_at: run.completedAt });
  });
  app.get("/api/daemon/tasks/:taskId/gc-check", (c) => {
    const taskId = c.req.param("taskId");
    const identityDenied = denyDaemonTokenTaskRuntimeIdentity(c, store, taskId, {
      hideForbiddenAsNotFound: true,
    });
    if (identityDenied) return identityDenied;
    const task = store.getTask(taskId);
    if (!task) return c.json({ error: "task not found" }, 404);
    return c.json({ status: task.status, completed_at: task.completedAt });
  });
}

function normalizeDaemonProtocolVersion(value: unknown): number {
  const protocol = Number(value);
  return Number.isSafeInteger(protocol) && protocol >= 0 ? protocol : 0;
}

/** Decision lanes only; anything else is treated as "not reported". */
function normalizeDecisionDegradeReason(value: unknown): FeishuDecisionDegradeReason | undefined {
  return typeof value === "string" && FEISHU_DECISION_DEGRADE_REASONS.includes(value as FeishuDecisionDegradeReason)
    ? value as FeishuDecisionDegradeReason
    : undefined;
}
