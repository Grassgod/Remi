import type { Hono } from "hono";
import {
  MAX_TASK_MESSAGES_PER_REQUEST,
  bindDaemonTokenIdentityOrDeny,
  buildDaemonInstallInstructions,
  callerCanReceiveRelay,
  compareDaemonPendingTasks,
  daemonRegisterOwnerContext,
  daemonTaskMessageInput,
  daemonTaskUsageEntries,
  denyCurrentUserWorkspaceAccess,
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
  parseOptionalTaskMessageSince,
  readJson,
  readJsonStrict,
  readJsonStrictAllowEmpty,
  registerDaemonRuntimes,
  promoteLegacyCliPatForDaemonHeartbeat,
  promoteLegacyCliPatForDaemonRegistration,
} from "../helpers.js";
import {
  authenticatedRequestUserId,
  cleanString,
  currentAccessToken,
  currentRequestUserId,
  currentWorkspaceRoleStrict,
  daemonHeartbeatHttpResponse,
  daemonTaskClaimResponse,
  daemonTaskMessageWireResponse,
  daemonTaskWireResponse,
  workspaceReposResponse,
} from "../wire/index.js";
import type {
  MultiremiDaemonSshMeshStatus,
  MultiremiIssueWorkspaceRepo,
  MultiremiIssueWorkspaceStatus,
  MultiremiTask,
} from "@multiremi/contracts/types.js";
import { SshMeshKeyError } from "@multiremi/ssh-mesh/keys.js";
import { SessionArchiveError } from "@multiremi/session-archive/service.js";
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
  if (body.expiresInDays != null || body.expires_in_days != null) {
    return { error: "daemon tokens cannot expire; retire the daemon to revoke machine trust" };
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
    return c.json(buildDaemonInstallInstructions({
      requestUrl: c.req.url,
      serverUrl: c.req.query("serverUrl") ?? c.req.query("server_url"),
      workspaceId: c.req.query("workspaceId") ?? c.req.query("workspace_id"),
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
    const workspaceId = cleanString(
      body.workspaceId ?? body.workspace_id ?? c.req.query("workspaceId") ?? c.req.query("workspace_id"),
    ) ?? "local";
    const actorToken = currentAccessToken(c);
    if (actorToken?.type === "task" || actorToken?.type === "daemon") {
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
    const denied = denyDaemonTokenWorkspace(c, body.workspace_id);
    if (denied) return denied;
    const registerWorkspace = String(body.workspace_id ?? "").trim() || "local";
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
    const owner = daemonRegisterOwnerContext(c, store, body.workspace_id);
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
    const result = registerDaemonRuntimes(store, body, owner, includeRelay, {
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
  app.post("/api/daemon/heartbeat", async (c) => {
    const body = await readJsonStrict<{
      runtime_id?: string;
      supports_batch_import?: boolean;
      supports_directory_scan?: boolean;
      agent_plugin_protocol?: number;
      ssh_mesh_protocol?: number;
      ssh_mesh_status?: MultiremiDaemonSshMeshStatus;
      drain_ack_generation?: number;
      active_task_count?: number;
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
    const ack = store.heartbeatRuntime(runtimeId, {
      supportsBatchImport: body.supports_batch_import ?? false,
      supportsDirectoryScan: body.supports_directory_scan ?? false,
      agentPluginProtocol: reportsAgentPluginProtocol ? body.agent_plugin_protocol : undefined,
    });
    if (ack.status === "runtime_gone") return c.json({ error: "runtime not found" }, 404);
    if (reportsSshMeshProtocol) {
      const protocol = normalizeDaemonProtocolVersion(body.ssh_mesh_protocol);
      const meshAck = store.recordSshMeshHeartbeat(runtimeId, protocol, body.ssh_mesh_status);
      if (meshAck) ack.ssh_mesh = meshAck;
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
    const runtime = store.getRuntime(runtimeId);
    const workspaceId = runtime?.workspaceId ?? "local";
    const workspaceConfig = workspaceReposResponse(
      store,
      workspaceId,
      callerCanReceiveRelay(c, store, workspaceId),
    );
    if (workspaceConfig) {
      response.workspace_settings = workspaceConfig.settings ?? {};
      if (callerCanReceiveRelay(c, store, workspaceId)) response.relay = workspaceConfig.relay;
    }
    return c.json(response);
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
  // Multiremi daemon-compatible endpoints.
  app.post("/api/daemon/runtimes/:runtimeId/tasks/claim", async (c) => {
    const task = store.claimTask(c.req.param("runtimeId"));
    if (!task) return c.json({ task: null });
    let hydratedTask: typeof task;
    try {
      hydratedTask = await deps.projectKnowledge.hydrateTaskKnowledge(task);
      hydratedTask = await deps.repositoryWiki.hydrateTaskWiki(hydratedTask);
    } catch (error) {
      store.failTask(task.id, {
        error: `Project knowledge unavailable before agent startup: ${safeProjectKnowledgeError(error)}`,
        failureReason: "project_knowledge_unavailable",
      });
      return c.json({ error: "project knowledge unavailable", retryable: true }, 503);
    }
    const response = daemonTaskClaimResponse(store, hydratedTask, store.getTaskTriggerMetadata(task));
    const runtime = task.runtimeId ? store.getRuntime(task.runtimeId) : null;
    // Every claim gets a task capability, including ownerless runtimes left by
    // older releases. `local` matches the legacy owner semantics used by the
    // runtime claim predicate, while the task/agent/workspace bindings enforce
    // the actual authorization boundary.
    const ownerId = cleanString(runtime?.ownerId) ?? "local";
    const token = await store.createTaskAccessToken(task, ownerId);
    response.auth_token = token.token;
    return c.json({ task: response });
  });
  app.get("/api/daemon/runtimes/:runtimeId/tasks/pending", (c) => {
    const runtime = store.getRuntime(c.req.param("runtimeId"));
    if (!runtime) return c.json({ error: "runtime not found" }, 404);
    const tasks = store.listTasks()
      .filter((task) => isDaemonPendingTaskForRuntime(task, runtime.id))
      .sort(compareDaemonPendingTasks)
      .map((task) => daemonTaskWireResponse(task, store.getTaskTriggerMetadata(task)));
    return c.json(tasks);
  });
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
  app.post("/api/daemon/tasks/:taskId/human-requests", async (c) => {
    const taskId = c.req.param("taskId");
    const body = await readJsonStrict<{ kind?: string; payload?: Record<string, unknown> }>(c);
    if ("apiError" in body) return c.json({ error: body.apiError }, body.statusCode);
    const identityDenied = denyDaemonTokenTaskRuntimeIdentity(c, store, taskId);
    if (identityDenied) return identityDenied;
    const existing = store.getTask(taskId);
    if (!existing) return c.json({ error: "task not found" }, 404);
    if (isTerminalTaskStatus(existing.status)) return c.json({ error: "task is terminal" }, 400);
    const kind = body.kind === "question" ? "question" : "permission";
    const request = store.createTaskHumanRequest({ taskId, kind, payload: body.payload ?? {} });
    return c.json({ request }, 201);
  });
  app.get("/api/daemon/tasks/:taskId/human-requests/:requestId", (c) => {
    const identityDenied = denyDaemonTokenTaskRuntimeIdentity(c, store, c.req.param("taskId"));
    if (identityDenied) return identityDenied;
    const request = store.getTaskHumanRequest(c.req.param("requestId"));
    if (!request || request.taskId !== c.req.param("taskId")) return c.json({ error: "request not found" }, 404);
    return c.json({ request });
  });
  app.post("/api/daemon/tasks/:taskId/human-requests/:requestId/expire", async (c) => {
    const body = await readJsonStrict<{ status?: string }>(c);
    if ("apiError" in body) return c.json({ error: body.apiError }, body.statusCode);
    const taskId = c.req.param("taskId");
    const identityDenied = denyDaemonTokenTaskRuntimeIdentity(c, store, taskId);
    if (identityDenied) return identityDenied;
    const request = store.getTaskHumanRequest(c.req.param("requestId"));
    if (!request || request.taskId !== taskId) return c.json({ error: "request not found" }, 404);
    const status = body.status === "cancelled" ? "cancelled" : "timeout";
    const expired = store.expireTaskHumanRequest(request.id, status);
    // Lost the race to a human response: return the current row so the worker honors it.
    return c.json({ request: expired ?? store.getTaskHumanRequest(request.id) });
  });
  app.post("/api/daemon/tasks/:taskId/progress", async (c) => {
    const body = await readJsonStrict<{ summary?: string; step?: number; total?: number; final?: boolean }>(c);
    if ("apiError" in body) return c.json({ error: body.apiError }, body.statusCode);
    const taskId = c.req.param("taskId");
    const identityDenied = denyDaemonTokenTaskRuntimeIdentity(c, store, taskId);
    if (identityDenied) return identityDenied;
    const existing = store.getTask(taskId);
    if (!existing) return c.json({ error: "task not found" }, 404);
    // A `final` summary describes the run's terminal outcome and is produced
    // after the status flip, so it may land on an already-terminal task.
    const final = body.final === true;
    if (!isTerminalTaskStatus(existing.status) || final) {
      store.reportProgress(taskId, body.summary ?? "", body.step, body.total, { allowTerminal: final });
    }
    return c.json({ status: "ok" });
  });
  app.post("/api/daemon/tasks/:taskId/messages", async (c) => {
    const body = await readJsonStrict<{ messages?: any[] }>(c);
    if ("apiError" in body) return c.json({ error: body.apiError }, body.statusCode);
    const taskId = c.req.param("taskId");
    const identityDenied = denyDaemonTokenTaskRuntimeIdentity(c, store, taskId);
    if (identityDenied) return identityDenied;
    const rawMessages = Array.isArray(body.messages) ? body.messages : [];
    if (!rawMessages.length) return c.json({ status: "ok" });
    if (rawMessages.length > MAX_TASK_MESSAGES_PER_REQUEST) {
      return c.json({ error: "too many messages" }, 413);
    }
    if (!store.getTask(taskId)) return c.json({ error: "task not found" }, 404);
    // Whitelist each message to the known TaskMessageInput fields (accepting
    // both camel and snake casing) so a compromised/buggy daemon can't smuggle
    // arbitrary JSON into the row; the store layer additionally byte-caps every
    // field.
    store.appendTaskMessages(taskId, rawMessages.map(daemonTaskMessageInput));
    return c.json({ status: "ok" });
  });
  app.post("/api/daemon/tasks/:taskId/prompt", async (c) => {
    const body = await readJsonStrict<{ mode?: string; prompt?: string; sha256?: string }>(c);
    if ("apiError" in body) return c.json({ error: body.apiError }, body.statusCode);
    const taskId = c.req.param("taskId");
    const identityDenied = denyDaemonTokenTaskRuntimeIdentity(c, store, taskId);
    if (identityDenied) return identityDenied;
    if (!store.getTask(taskId)) return c.json({ error: "task not found" }, 404);
    try {
      const artifact = store.recordTaskPrompt(taskId, {
        mode: body.mode as "bootstrap" | "delta",
        prompt: body.prompt ?? "",
        sha256: body.sha256 ?? "",
      });
      return c.json({
        task_id: artifact.taskId,
        mode: artifact.mode,
        sha256: artifact.sha256,
        assembled_at: artifact.assembledAt,
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
  app.get("/api/daemon/tasks/:taskId/messages", (c) => {
    const taskId = c.req.param("taskId");
    const identityDenied = denyDaemonTokenTaskRuntimeIdentity(c, store, taskId);
    if (identityDenied) return identityDenied;
    const task = store.getTask(taskId);
    if (!task) return c.json({ error: "task not found" }, 404);
    const since = parseOptionalTaskMessageSince(c.req.query("since_seq") ?? c.req.query("sinceSeq") ?? c.req.query("since"));
    if (typeof since === "object" && since && "error" in since) return c.json({ error: since.error }, 400);
    return c.json(store.listTaskMessages(taskId, since).map((message) => daemonTaskMessageWireResponse(message, task)));
  });
  app.post("/api/daemon/tasks/:taskId/session", async (c) => {
    const taskId = c.req.param("taskId");
    const body = await readJsonStrict<{ session_id?: string; work_dir?: string }>(c);
    if ("apiError" in body) return c.json({ error: body.apiError }, body.statusCode);
    const identityDenied = denyDaemonTokenTaskRuntimeIdentity(c, store, taskId);
    if (identityDenied) return identityDenied;
    if (!store.getTask(taskId)) return c.json({ error: "task not found" }, 404);
    const sessionId = body.session_id ?? null;
    const workDir = body.work_dir ?? null;
    if (!sessionId && !workDir) return c.json({ error: "session_id or work_dir required" }, 400);
    store.pinTaskSession(
      taskId,
      sessionId,
      workDir,
    );
    return c.body(null, 204);
  });
  app.post("/api/daemon/tasks/:taskId/workspace", async (c) => {
    const taskId = c.req.param("taskId");
    const body = await readJsonStrict<{
      runtime_id?: string;
      root_path?: string;
      branch_name?: string;
      status?: MultiremiIssueWorkspaceStatus;
      repos?: Array<{
        repo_url?: string;
        repo_name?: string;
        worktree_path?: string;
        branch_name?: string;
        base_ref?: string;
        status?: "ready" | "dirty" | "error";
        dirty?: boolean;
        error?: string | null;
      }>;
    }>(c);
    if ("apiError" in body) return c.json({ error: body.apiError }, body.statusCode);
    const taskIdentityDenied = denyDaemonTokenTaskRuntimeIdentity(c, store, taskId);
    if (taskIdentityDenied) return taskIdentityDenied;
    const task = store.getTask(taskId);
    if (!task || !task.issueId) return c.json({ error: "issue task not found" }, 404);
    const runtimeId = body.runtime_id?.trim() ?? "";
    if (!runtimeId || runtimeId !== task.runtimeId) return c.json({ error: "runtime_id does not own task" }, 403);
    const denied = denyDaemonTokenRuntimeIdentity(c, store, runtimeId);
    if (denied) return denied;
    if (!body.root_path?.trim() || typeof body.branch_name !== "string" || !body.status) {
      return c.json({ error: "root_path, branch_name and status are required" }, 400);
    }
    const repos: MultiremiIssueWorkspaceRepo[] = (body.repos ?? []).map((repo) => ({
      repoUrl: repo.repo_url?.trim() ?? "",
      repoName: repo.repo_name?.trim() ?? "",
      worktreePath: repo.worktree_path?.trim() ?? "",
      branchName: repo.branch_name?.trim() ?? body.branch_name!,
      baseRef: repo.base_ref?.trim() ?? "",
      status: repo.status ?? (repo.dirty ? "dirty" : "ready"),
      dirty: repo.dirty ?? false,
      error: repo.error?.trim() || null,
    }));
    try {
      const workspace = store.reportIssueWorkspace({
        issueId: task.issueId,
        runtimeId,
        rootPath: body.root_path.trim(),
        branchName: body.branch_name.trim(),
        status: body.status,
        repos,
        lastTaskId: taskId,
      });
      return c.json({ issue_id: workspace.issueId, status: workspace.status });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, message.includes("does not own active") ? 409 : 400);
    }
  });
  app.post("/api/daemon/tasks/:taskId/complete", async (c) => {
    const taskId = c.req.param("taskId");
    const body = await readJsonStrict<{ output?: string; pr_url?: string; session_id?: string; work_dir?: string }>(c);
    if ("apiError" in body) return c.json({ error: body.apiError }, body.statusCode);
    const identityDenied = denyDaemonTokenTaskRuntimeIdentity(c, store, taskId);
    if (identityDenied) return identityDenied;
    const existing = store.getTask(taskId);
    if (!existing) return c.json({ error: "task not found" }, 404);
    if (existing.status !== "running") {
      return c.json(daemonTaskWireResponse(existing, store.getTaskTriggerMetadata(existing)));
    }
    const task = store.completeTask(taskId, {
      output: body.output ?? "",
      branchName: body.pr_url ?? null,
      sessionId: body.session_id ?? null,
      workDir: body.work_dir ?? null,
    });
    return c.json(daemonTaskWireResponse(task, store.getTaskTriggerMetadata(task)));
  });
  app.post("/api/daemon/tasks/:taskId/fail", async (c) => {
    const taskId = c.req.param("taskId");
    const body = await readJsonStrict<{ error?: string; session_id?: string; work_dir?: string; failure_reason?: string }>(c);
    if ("apiError" in body) return c.json({ error: body.apiError }, body.statusCode);
    const identityDenied = denyDaemonTokenTaskRuntimeIdentity(c, store, taskId);
    if (identityDenied) return identityDenied;
    const existing = store.getTask(taskId);
    if (!existing) return c.json({ error: "task not found" }, 404);
    if (existing.status !== "dispatched" && existing.status !== "running" && existing.status !== "waiting_local_directory") {
      return c.json(daemonTaskWireResponse(existing, store.getTaskTriggerMetadata(existing)));
    }
    const task = store.failTask(taskId, {
      error: body.error ?? "Task failed",
      sessionId: body.session_id ?? null,
      workDir: body.work_dir ?? null,
      failureReason: body.failure_reason ?? null,
    });
    return c.json(daemonTaskWireResponse(task, store.getTaskTriggerMetadata(task)));
  });
  app.post("/api/daemon/tasks/:taskId/usage", async (c) => {
    const taskId = c.req.param("taskId");
    const body = await readJsonStrict<{ usage?: any[] }>(c);
    if ("apiError" in body) return c.json({ error: body.apiError }, body.statusCode);
    const identityDenied = denyDaemonTokenTaskRuntimeIdentity(c, store, taskId);
    if (identityDenied) return identityDenied;
    if (!store.getTask(taskId)) return c.json({ error: "task not found" }, 404);
    store.reportTaskUsage(taskId, daemonTaskUsageEntries(body.usage));
    return c.json({ status: "ok" });
  });
  app.get("/api/daemon/tasks/:taskId/status", (c) => {
    const taskId = c.req.param("taskId");
    const identityDenied = denyDaemonTokenTaskRuntimeIdentity(c, store, taskId);
    if (identityDenied) return identityDenied;
    const task = store.getTask(taskId);
    if (!task) return c.json({ error: "task not found" }, 404);
    return c.json({ status: task.status });
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

function safeProjectKnowledgeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function normalizeDaemonProtocolVersion(value: unknown): number {
  const protocol = Number(value);
  return Number.isSafeInteger(protocol) && protocol >= 0 ? protocol : 0;
}
