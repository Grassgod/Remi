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
import type { MultiremiIssueWorkspaceRepo, MultiremiIssueWorkspaceStatus, MultiremiTask } from "@multiremi/contracts/types.js";
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
        expiresInDays: body.expiresInDays ?? body.expires_in_days ?? 90,
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
    }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const runtimeId = body.runtime_id ?? "";
    if (!runtimeId) return c.json({ error: "runtime_id is required" }, 400);
    const upgradeDenied = promoteLegacyCliPatForDaemonHeartbeat(c, store, runtimeId);
    if (upgradeDenied) return upgradeDenied;
    const denied = denyDaemonTokenRuntimeIdentity(c, store, runtimeId);
    if (denied) return denied;
    const reportsAgentPluginProtocol = Object.prototype.hasOwnProperty.call(body, "agent_plugin_protocol");
    const authorization = c.req.header("Authorization") ?? "";
    const usesMasterToken = Boolean(authToken) && authorization === `Bearer ${authToken}`;
    if (
      reportsAgentPluginProtocol &&
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
    return c.json(daemonHeartbeatHttpResponse(ack));
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
    } catch (error) {
      store.failTask(task.id, {
        error: `Project knowledge unavailable before agent startup: ${safeProjectKnowledgeError(error)}`,
        failureReason: "project_knowledge_unavailable",
      });
      return c.json({ error: "project knowledge unavailable", retryable: true }, 503);
    }
    const response = daemonTaskClaimResponse(store, hydratedTask, store.getTaskTriggerMetadata(task));
    const runtime = task.runtimeId ? store.getRuntime(task.runtimeId) : null;
    const ownerId = cleanString(runtime?.ownerId);
    if (ownerId) {
      const token = await store.createTaskAccessToken(task, ownerId);
      response.auth_token = token.token;
    }
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
    const body = await readJsonStrict<{ summary?: string; step?: number; total?: number }>(c);
    if ("apiError" in body) return c.json({ error: body.apiError }, body.statusCode);
    const taskId = c.req.param("taskId");
    const identityDenied = denyDaemonTokenTaskRuntimeIdentity(c, store, taskId);
    if (identityDenied) return identityDenied;
    const existing = store.getTask(taskId);
    if (!existing) return c.json({ error: "task not found" }, 404);
    if (!isTerminalTaskStatus(existing.status)) store.reportProgress(taskId, body.summary ?? "", body.step, body.total);
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
    const body = await readJsonStrict<{ runtime_id?: string }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const runtimeId = body.runtime_id?.trim() ?? "";
    if (!runtimeId) return c.json({ error: "runtime_id is required" }, 400);
    const denied = denyDaemonTokenRuntimeIdentity(c, store, runtimeId);
    if (denied) return denied;
    if (!store.getIssueWorkspace(c.req.param("issueId"))) return c.body(null, 204);
    try {
      const workspace = store.markIssueWorkspaceCleaned(c.req.param("issueId"), runtimeId);
      return c.json({ issue_id: workspace.issueId, status: workspace.status, cleaned_at: workspace.cleanedAt });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
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
