import type { Context, Hono } from "hono";
import { refreshStaleGatewayModels } from "@multiremi/relay/discovery.js";
import {
  bindDaemonTokenIdentityOrDeny,
  daemonLocalSkillImportReportBody,
  daemonLocalSkillListReportBody,
  daemonRegisterOwnerContext,
  denyCurrentUserWorkspaceAccess,
  denyDaemonOwnerWorkspaceMembership,
  denyUnprivilegedOwnerlessDaemonClaim,
  denyDaemonRuntimeObservedStateAccess,
  denyDaemonTokenRuntimeIdentity,
  denyDaemonTokenRuntimeWorkspace,
  denyDaemonTokenWorkspace,
  isJsonApiError,
  isTerminalRuntimeRequestForDaemon,
  isValidRuntimeUpdateReportStatus,
  listRuntimesForCurrentUser,
  loadRuntimeForCurrentEditor,
  loadRuntimeForCurrentOwner,
  loadRuntimeForCurrentUser,
  overlayGatewayModels,
  parseExpectedActiveAgentIds,
  promoteLegacyCliPatForDaemonHeartbeat,
  promoteLegacyCliPatForDaemonRegistration,
  readJson,
  readJsonStrict,
  requireWorkspaceAdmin,
  safeCreateRuntimeUpdateRequest,
  usageQuery,
  validateMultiremiRuntimeProvider,
} from "../helpers.js";
import {
  authenticatedRequestUserId,
  cleanString,
  compareRuntimeUsageDailyCompatibilityRows,
  currentAccessToken,
  currentRequestUserId,
  directoryScanErrorResponse,
  fleetModelsResponse,
  hasRequestField,
  parseOptionalInt,
  runtimeCompatibilityResponse,
  runtimeCommandRequestResponse,
  runtimeDirectoryScanRequestCompatibilityResponse,
  runtimeHasActiveAgentsResponse,
  runtimeLocalSkillImportRequestCompatibilityResponse,
  runtimeLocalSkillListRequestCompatibilityResponse,
  runtimeModelCompatibilityResponse,
  runtimeModelListRequestCompatibilityResponse,
  runtimeTaskActivityCompatibilityResponse,
  runtimeUpdateRequestCompatibilityResponse,
  runtimeUsageByAgentCompatibilityResponse,
  runtimeUsageByHourCompatibilityResponse,
  runtimeUsageDailyCompatibilityResponse,
} from "../wire/index.js";
import type {
  CreateRuntimeDirectoryScanInput,
  CreateRuntimeCommandInput,
  CreateRuntimeLocalSkillImportInput,
  CreateRuntimeUpdateInput,
  RegisterRuntimeInput,
  ReportRuntimeDirectoryScanInput,
  ReportRuntimeCommandInput,
  ReportRuntimeLocalSkillImportInput,
  ReportRuntimeLocalSkillListInput,
  ReportRuntimeModelListInput,
  ReportRuntimeUpdateInput,
  MultiremiRuntimeModel,
  UpdateRuntimeInput,
} from "@multiremi/contracts/types.js";
import type { RouterDeps } from "./deps.js";

export function registerRuntimeRoutes(app: Hono, deps: RouterDeps): void {
  const { store, authToken } = deps;

  app.get("/api/multiremi/runtimes", (c) => {
    const loaded = listRuntimesForCurrentUser(c, store);
    if (loaded instanceof Response) return loaded;
    return c.json({ runtimes: loaded.runtimes });
  });
  app.post("/api/multiremi/runtimes", async (c) => {
    const body = await readJson<RegisterRuntimeInput>(c);
    const workspaceId = body.workspaceId ?? body.workspace_id ?? "local";
    const ownerMembershipDenied = denyDaemonOwnerWorkspaceMembership(c, store);
    if (ownerMembershipDenied) return ownerMembershipDenied;
    const denied = denyDaemonTokenWorkspace(c, workspaceId) ??
      (currentAccessToken(c)?.type === "daemon" ? null : denyCurrentUserWorkspaceAccess(c, store, workspaceId));
    if (denied) return denied;
    const provider = validateMultiremiRuntimeProvider(body.provider);
    if ("error" in provider) return c.json({ error: provider.error }, provider.status);
    let accessToken = currentAccessToken(c);
    const requestedRuntimeId = cleanString(body.id);
    const existingRuntime = requestedRuntimeId ? store.getRuntime(requestedRuntimeId) : null;
    if (existingRuntime && accessToken?.type !== "daemon") {
      const editable = loadRuntimeForCurrentEditor(c, store, requestedRuntimeId!, "edit");
      if (editable instanceof Response) return editable;
    }
    const bodyDaemonId = cleanString(body.daemonId ?? body.daemon_id);
    if (accessToken?.type === "daemon" && !bodyDaemonId) {
      return c.json({ error: "daemonId is required", code: "daemon_identity_required" }, 403);
    }
    const requestedDaemonId = bodyDaemonId;
    const registrationOwner = requestedDaemonId
      ? daemonRegisterOwnerContext(c, store, workspaceId)
      : null;
    if (registrationOwner && "error" in registrationOwner) {
      return c.json({ error: registrationOwner.error }, registrationOwner.status);
    }
    if (requestedDaemonId && store.isDaemonRetired(workspaceId, requestedDaemonId)) {
      return c.json({ error: "daemon has been retired", code: "daemon_retired" }, 410);
    }
    const ownerlessClaimDenied = denyUnprivilegedOwnerlessDaemonClaim(
      c,
      store,
      workspaceId,
      requestedDaemonId,
    );
    if (ownerlessClaimDenied) return ownerlessClaimDenied;
    if (accessToken?.type === "pat" && accessToken.purpose === "cli") {
      const upgradeDenied = promoteLegacyCliPatForDaemonRegistration(
        c,
        store,
        workspaceId,
        requestedDaemonId ?? "",
      );
      if (upgradeDenied) return upgradeDenied;
      accessToken = currentAccessToken(c);
    }
    if (accessToken?.type === "daemon") {
      if (existingRuntime && requestedRuntimeId) {
        const existingWorkspaceDenied = denyDaemonTokenRuntimeWorkspace(c, store, requestedRuntimeId);
        if (existingWorkspaceDenied) return existingWorkspaceDenied;
        const effectiveDaemonId = cleanString(accessToken.daemonId) ?? requestedDaemonId;
        const existingDaemonId = cleanString(existingRuntime.daemonId);
        if (existingDaemonId && existingDaemonId !== effectiveDaemonId) {
          return c.json({ error: "forbidden for daemon identity", code: "daemon_identity_forbidden" }, 403);
        }
      }
      const identityDenied = bindDaemonTokenIdentityOrDeny(c, store, requestedDaemonId);
      if (identityDenied) return identityDenied;
    }
    const registration = requestedDaemonId
      ? {
        ...body,
        daemonId: requestedDaemonId,
        ownerId: registrationOwner && "ownerId" in registrationOwner
          ? registrationOwner.ownerId
          : null,
      }
      : body;
    return c.json({ runtime: store.registerRuntime(registration) }, 201);
  });
  app.get("/api/multiremi/runtimes/:id", (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const { runtime } = loaded;
    return c.json({ runtime, usage: store.listRuntimeUsage(runtime.id) });
  });
  app.patch("/api/multiremi/runtimes/:id", async (c) => {
    const loaded = loadRuntimeForCurrentEditor(c, store, c.req.param("id"), "edit");
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrict<UpdateRuntimeInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    return c.json({ runtime: store.updateRuntime(loaded.runtime.id, body) });
  });
  app.get("/api/multiremi/runtimes/:id/models", (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const { runtime } = loaded;
    return c.json({ runtimeId: runtime.id, supported: true, models: store.listRuntimeModels(runtime.id) });
  });
  app.put("/api/multiremi/runtimes/:id/models", async (c) => {
    const loaded = loadRuntimeForCurrentEditor(c, store, c.req.param("id"), "edit");
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrict<{ models?: any[]; supported?: boolean }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    return c.json({ runtimeId: loaded.runtime.id, supported: body.supported !== false, models: store.updateRuntimeModels(loaded.runtime.id, body.models ?? []) });
  });
  app.post("/api/multiremi/runtimes/:id/models", (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    if (loaded.runtime.status !== "online") return c.json({ error: "runtime is offline" }, 503);
    return c.json(store.createRuntimeModelListRequest(loaded.runtime.id));
  });
  app.get("/api/multiremi/runtimes/:id/models/:requestId", (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const request = store.getRuntimeModelListRequest(loaded.runtime.id, c.req.param("requestId"));
    if (!request) return c.json({ error: "request not found" }, 404);
    return c.json(request);
  });
  app.get("/api/runtimes/:id/models", (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const { runtime } = loaded;
    return c.json({ runtime_id: runtime.id, supported: true, models: store.listRuntimeModels(runtime.id).map(runtimeModelCompatibilityResponse) });
  });
  app.put("/api/runtimes/:id/models", async (c) => {
    const loaded = loadRuntimeForCurrentEditor(c, store, c.req.param("id"), "edit");
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrict<{ models?: any[]; supported?: boolean }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    return c.json({
      runtime_id: loaded.runtime.id,
      supported: body.supported !== false,
      models: store.updateRuntimeModels(loaded.runtime.id, body.models ?? []).map(runtimeModelCompatibilityResponse),
    });
  });
  app.post("/api/runtimes/:id/models", (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    if (loaded.runtime.status !== "online") return c.json({ error: "runtime is offline" }, 503);
    return c.json(runtimeModelListRequestCompatibilityResponse(store.createRuntimeModelListRequest(loaded.runtime.id)));
  });
  app.get("/api/runtimes/:id/models/:requestId", (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const request = store.getRuntimeModelListRequest(loaded.runtime.id, c.req.param("requestId"));
    if (!request) return c.json({ error: "request not found" }, 404);
    return c.json(runtimeModelListRequestCompatibilityResponse(request));
  });
  app.put("/api/daemon/runtimes/:runtimeId/models", async (c) => {
    const runtimeId = c.req.param("runtimeId");
    const denied = denyDaemonRuntimeObservedStateAccess(c, store, runtimeId, authToken);
    if (denied) return denied;
    const body = await readJsonStrict<{ models?: MultiremiRuntimeModel[]; supported?: boolean }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    return c.json({
      runtime_id: runtimeId,
      supported: body.supported !== false,
      models: store.updateRuntimeModels(runtimeId, body.models ?? []),
    });
  });
  app.post("/api/daemon/runtimes/:runtimeId/models/claim", (c) => {
    const runtimeId = c.req.param("runtimeId");
    const denied = denyDaemonRuntimeObservedStateAccess(c, store, runtimeId, authToken);
    if (denied) return denied;
    return c.json({ request: store.claimRuntimeModelListRequest(runtimeId) });
  });
  app.post("/api/daemon/runtimes/:runtimeId/models/:requestId/result", async (c) => {
    const runtimeId = c.req.param("runtimeId");
    const denied = denyDaemonRuntimeObservedStateAccess(c, store, runtimeId, authToken);
    if (denied) return denied;
    const requestId = c.req.param("requestId");
    const request = store.getRuntimeModelListRequest(runtimeId, requestId);
    if (!request) return c.json({ error: "request not found" }, 404);
    if (isTerminalRuntimeRequestForDaemon(request.status)) return c.json({ status: "ok" });
    const body = await readJsonStrict<ReportRuntimeModelListInput>(c);
    if ("apiError" in body) return c.json({ error: body.apiError }, body.statusCode);
    store.reportRuntimeModelListResult(runtimeId, requestId, body);
    return c.json({ status: "ok" });
  });
  app.post("/api/multiremi/runtimes/:id/update", async (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrict<CreateRuntimeUpdateInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const result = safeCreateRuntimeUpdateRequest(store, loaded.runtime.id, body);
    if ("apiError" in result) return c.json({ error: result.apiError }, result.statusCode);
    return c.json(result);
  });
  app.get("/api/multiremi/runtimes/:id/update/:updateId", (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const request = store.getRuntimeUpdateRequest(loaded.runtime.id, c.req.param("updateId"));
    if (!request) return c.json({ error: "update not found" }, 404);
    return c.json(request);
  });
  app.post("/api/runtimes/:id/update", async (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrict<CreateRuntimeUpdateInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const result = safeCreateRuntimeUpdateRequest(store, loaded.runtime.id, { target_version: body.target_version, scope: body.scope });
    if ("apiError" in result) return c.json({ error: result.apiError }, result.statusCode);
    return c.json(runtimeUpdateRequestCompatibilityResponse(result));
  });
  app.get("/api/runtimes/:id/update/:updateId", (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const request = store.getRuntimeUpdateRequest(loaded.runtime.id, c.req.param("updateId"));
    if (!request) return c.json({ error: "update not found" }, 404);
    return c.json(runtimeUpdateRequestCompatibilityResponse(request));
  });
  app.post("/api/daemon/runtimes/:runtimeId/update/claim", (c) => {
    return c.json({ request: store.claimRuntimeUpdateRequest(c.req.param("runtimeId")) });
  });
  app.post("/api/daemon/runtimes/:runtimeId/update/:updateId/result", async (c) => {
    const runtimeId = c.req.param("runtimeId");
    const updateId = c.req.param("updateId");
    const request = store.getRuntimeUpdateRequest(runtimeId, updateId);
    if (!request) return c.json({ error: "update not found" }, 404);
    if (isTerminalRuntimeRequestForDaemon(request.status)) return c.json({ status: "ok" });
    const body = await readJsonStrict<ReportRuntimeUpdateInput>(c);
    if ("apiError" in body) return c.json({ error: body.apiError }, body.statusCode);
    if (!isValidRuntimeUpdateReportStatus(body.status)) {
      return c.json({ error: `invalid status: ${String(body.status ?? "")}` }, 400);
    }
    store.reportRuntimeUpdateResult(runtimeId, updateId, body);
    return c.json({ status: "ok" });
  });
  app.post("/api/runtimes/:id/commands", async (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const denied = requireWorkspaceAdmin(c, store, loaded.runtime.workspaceId ?? "local");
    if (denied) return denied;
    const body = await readJsonStrict<CreateRuntimeCommandInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const request = store.createRuntimeCommandRequest(loaded.runtime.id, {
        command: body.command,
        args: body.args,
        timeoutMs: body.timeoutMs ?? body.timeout_ms,
        createdBy: currentRequestUserId(c),
        created_by: currentRequestUserId(c),
      });
      return c.json(runtimeCommandRequestResponse(request), 202);
    } catch (error) {
      const response = runtimeCommandErrorResponse(c, error);
      if (response) return response;
      throw error;
    }
  });
  app.get("/api/runtimes/:id/commands/:requestId", (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const denied = requireWorkspaceAdmin(c, store, loaded.runtime.workspaceId ?? "local");
    if (denied) return denied;
    const request = store.getRuntimeCommandRequest(loaded.runtime.id, c.req.param("requestId"));
    if (!request) return c.json({ error: "request not found" }, 404);
    return c.json(runtimeCommandRequestResponse(request));
  });
  app.post("/api/daemon/runtimes/:runtimeId/commands/claim", (c) => {
    const runtimeId = c.req.param("runtimeId");
    const denied = denyDaemonRuntimeObservedStateAccess(c, store, runtimeId, authToken);
    if (denied) return denied;
    return c.json({ request: store.claimRuntimeCommandRequest(runtimeId) });
  });
  app.post("/api/daemon/runtimes/:runtimeId/commands/:requestId/result", async (c) => {
    const runtimeId = c.req.param("runtimeId");
    const denied = denyDaemonRuntimeObservedStateAccess(c, store, runtimeId, authToken);
    if (denied) return denied;
    const requestId = c.req.param("requestId");
    const request = store.getRuntimeCommandRequest(runtimeId, requestId);
    if (!request) return c.json({ error: "request not found" }, 404);
    if (isTerminalRuntimeRequestForDaemon(request.status)) return c.json({ status: "ok" });
    const body = await readJsonStrict<ReportRuntimeCommandInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    if (body.status !== "completed" && body.status !== "failed" && body.status !== "timeout") {
      return c.json({ error: `invalid status: ${String(body.status ?? "")}` }, 400);
    }
    store.reportRuntimeCommandResult(runtimeId, requestId, body);
    return c.json({ status: "ok" });
  });
  app.post("/api/multiremi/runtimes/:id/local-skills", (c) => {
    const loaded = loadRuntimeForCurrentOwner(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    return c.json(store.createRuntimeLocalSkillListRequest(loaded.runtime.id));
  });
  app.post("/api/runtimes/:id/local-skills", (c) => {
    const loaded = loadRuntimeForCurrentOwner(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    return c.json(runtimeLocalSkillListRequestCompatibilityResponse(store.createRuntimeLocalSkillListRequest(loaded.runtime.id)));
  });
  app.get("/api/multiremi/runtimes/:id/local-skills/:requestId", (c) => {
    const loaded = loadRuntimeForCurrentOwner(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const request = store.getRuntimeLocalSkillListRequest(loaded.runtime.id, c.req.param("requestId"));
    if (!request) return c.json({ error: "request not found" }, 404);
    return c.json(request);
  });
  app.get("/api/runtimes/:id/local-skills/:requestId", (c) => {
    const loaded = loadRuntimeForCurrentOwner(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const request = store.getRuntimeLocalSkillListRequest(loaded.runtime.id, c.req.param("requestId"));
    if (!request) return c.json({ error: "request not found" }, 404);
    return c.json(runtimeLocalSkillListRequestCompatibilityResponse(request));
  });
  app.post("/api/multiremi/runtimes/:id/local-skills/import", async (c) => {
    const loaded = loadRuntimeForCurrentOwner(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrict<CreateRuntimeLocalSkillImportInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    return c.json(store.createRuntimeLocalSkillImportRequest(loaded.runtime.id, body));
  });
  app.post("/api/runtimes/:id/local-skills/import", async (c) => {
    const loaded = loadRuntimeForCurrentOwner(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrict<CreateRuntimeLocalSkillImportInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    return c.json(runtimeLocalSkillImportRequestCompatibilityResponse(store.createRuntimeLocalSkillImportRequest(loaded.runtime.id, body)));
  });
  app.get("/api/multiremi/runtimes/:id/local-skills/import/:requestId", (c) => {
    const loaded = loadRuntimeForCurrentOwner(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const request = store.getRuntimeLocalSkillImportRequest(loaded.runtime.id, c.req.param("requestId"));
    if (!request) return c.json({ error: "request not found" }, 404);
    return c.json(request);
  });
  app.get("/api/runtimes/:id/local-skills/import/:requestId", (c) => {
    const loaded = loadRuntimeForCurrentOwner(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const request = store.getRuntimeLocalSkillImportRequest(loaded.runtime.id, c.req.param("requestId"));
    if (!request) return c.json({ error: "request not found" }, 404);
    return c.json(runtimeLocalSkillImportRequestCompatibilityResponse(request));
  });
  app.post("/api/daemon/runtimes/:runtimeId/local-skills/claim", (c) => {
    return c.json({ request: store.claimRuntimeLocalSkillListRequest(c.req.param("runtimeId")) });
  });
  app.post("/api/daemon/runtimes/:runtimeId/local-skills/:requestId/result", async (c) => {
    const runtimeId = c.req.param("runtimeId");
    const requestId = c.req.param("requestId");
    const request = store.getRuntimeLocalSkillListRequest(runtimeId, requestId);
    if (!request) return c.json({ error: "request not found" }, 404);
    if (isTerminalRuntimeRequestForDaemon(request.status)) return c.json({ status: "ok" });
    const body = await readJsonStrict<ReportRuntimeLocalSkillListInput>(c);
    if ("apiError" in body) return c.json({ error: body.apiError }, body.statusCode);
    store.reportRuntimeLocalSkillListResult(runtimeId, requestId, daemonLocalSkillListReportBody(body));
    return c.json({ status: "ok" });
  });
  app.post("/api/daemon/runtimes/:runtimeId/local-skills/import/claim", (c) => {
    const limit = parseOptionalInt(c.req.query("limit")) ?? 10;
    return c.json({ requests: store.claimRuntimeLocalSkillImportRequests(c.req.param("runtimeId"), limit) });
  });
  app.post("/api/daemon/runtimes/:runtimeId/local-skills/import/:requestId/result", async (c) => {
    const runtimeId = c.req.param("runtimeId");
    const requestId = c.req.param("requestId");
    const request = store.getRuntimeLocalSkillImportRequest(runtimeId, requestId);
    if (!request) return c.json({ error: "request not found" }, 404);
    if (isTerminalRuntimeRequestForDaemon(request.status)) return c.json({ status: "ok" });
    const body = await readJsonStrict<ReportRuntimeLocalSkillImportInput>(c);
    if ("apiError" in body) return c.json({ error: body.apiError }, body.statusCode);
    store.reportRuntimeLocalSkillImportResult(runtimeId, requestId, daemonLocalSkillImportReportBody(body));
    return c.json({ status: "ok" });
  });
  app.post("/api/multiremi/runtimes/:id/directory-scans", async (c) => {
    const loaded = loadRuntimeForCurrentOwner(c, store, c.req.param("id"), "directory scans");
    if (loaded instanceof Response) return loaded;
    if (loaded.runtime.status !== "online") return c.json({ error: "runtime is offline" }, 503);
    const body = await readJsonStrict<CreateRuntimeDirectoryScanInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      return c.json(store.createRuntimeDirectoryScanRequest(loaded.runtime.id, { root: body.root, maxDepth: body.maxDepth ?? body.max_depth, mode: body.mode }));
    } catch (err) {
      const response = directoryScanErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
  app.post("/api/runtimes/:id/directory-scans", async (c) => {
    const loaded = loadRuntimeForCurrentOwner(c, store, c.req.param("id"), "directory scans");
    if (loaded instanceof Response) return loaded;
    if (loaded.runtime.status !== "online") return c.json({ error: "runtime is offline" }, 503);
    const body = await readJsonStrict<CreateRuntimeDirectoryScanInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      return c.json(runtimeDirectoryScanRequestCompatibilityResponse(store.createRuntimeDirectoryScanRequest(loaded.runtime.id, { root: body.root, maxDepth: body.maxDepth ?? body.max_depth, mode: body.mode })));
    } catch (err) {
      const response = directoryScanErrorResponse(c, err);
      if (response) return response;
      throw err;
    }
  });
  app.get("/api/multiremi/runtimes/:id/directory-scans/:requestId", (c) => {
    const loaded = loadRuntimeForCurrentOwner(c, store, c.req.param("id"), "directory scans");
    if (loaded instanceof Response) return loaded;
    const request = store.getRuntimeDirectoryScanRequest(loaded.runtime.id, c.req.param("requestId"));
    if (!request) return c.json({ error: "request not found" }, 404);
    return c.json(request);
  });
  app.get("/api/runtimes/:id/directory-scans/:requestId", (c) => {
    const loaded = loadRuntimeForCurrentOwner(c, store, c.req.param("id"), "directory scans");
    if (loaded instanceof Response) return loaded;
    const request = store.getRuntimeDirectoryScanRequest(loaded.runtime.id, c.req.param("requestId"));
    if (!request) return c.json({ error: "request not found" }, 404);
    return c.json(runtimeDirectoryScanRequestCompatibilityResponse(request));
  });
  app.post("/api/daemon/runtimes/:runtimeId/directory-scans/claim", (c) => {
    return c.json({ request: store.claimRuntimeDirectoryScanRequest(c.req.param("runtimeId")) });
  });
  app.post("/api/daemon/runtimes/:runtimeId/directory-scans/:requestId/result", async (c) => {
    const runtimeId = c.req.param("runtimeId");
    const requestId = c.req.param("requestId");
    const request = store.getRuntimeDirectoryScanRequest(runtimeId, requestId);
    if (!request) return c.json({ error: "request not found" }, 404);
    if (isTerminalRuntimeRequestForDaemon(request.status)) return c.json({ status: "ok" });
    const body = await readJsonStrict<ReportRuntimeDirectoryScanInput>(c);
    if ("apiError" in body) return c.json({ error: body.apiError }, body.statusCode);
    store.reportRuntimeDirectoryScanResult(runtimeId, requestId, body);
    return c.json({ status: "ok" });
  });
  app.get("/api/multiremi/runtimes/:id/usage", (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const { runtime } = loaded;
    return c.json({ runtimeId: runtime.id, usage: store.listRuntimeUsage(runtime.id) });
  });
  app.get("/api/multiremi/runtimes/:id/usage/by-agent", (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const { runtime } = loaded;
    return c.json({ usage: store.listUsageByAgent(usageQuery(c, { runtimeId: runtime.id })) });
  });
  app.get("/api/multiremi/runtimes/:id/usage/by-hour", (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const { runtime } = loaded;
    return c.json({ usage: store.listUsageByHour(usageQuery(c, { runtimeId: runtime.id })) });
  });
  app.get("/api/multiremi/runtimes/:id/task-activity", (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const { runtime } = loaded;
    return c.json({ activity: store.listTaskActivityByHour(usageQuery(c, { runtimeId: runtime.id })) });
  });
  app.get("/api/runtimes", (c) => {
    const loaded = listRuntimesForCurrentUser(c, store);
    if (loaded instanceof Response) return loaded;
    return c.json(loaded.runtimes.map(runtimeCompatibilityResponse));
  });
  const fleetModelsHandler = (c: Context) => {
    const loaded = listRuntimesForCurrentUser(c, store);
    if (loaded instanceof Response) return loaded;
    const providers = fleetModelsResponse(loaded.runtimes, currentRequestUserId(c));
    // Prefer the explicitly requested workspace over reverse-deriving from the
    // first runtime (which is wrong / absent when the workspace has no runtimes).
    const workspaceId = cleanString(c.req.query("workspace_id")) ?? loaded.runtimes[0]?.workspaceId ?? "local";
    refreshStaleGatewayModels(store, workspaceId);
    return c.json({ providers: overlayGatewayModels(store, workspaceId, providers) });
  };
  app.get("/api/models", fleetModelsHandler);
  app.get("/api/multiremi/models", fleetModelsHandler);
  app.get("/api/runtimes/:id", (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const { runtime } = loaded;
    return c.json({ runtime, usage: store.listRuntimeUsage(runtime.id) });
  });
  app.patch("/api/runtimes/:id", async (c) => {
    const loaded = loadRuntimeForCurrentEditor(c, store, c.req.param("id"), "edit");
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrict<UpdateRuntimeInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    if (hasRequestField(body, "name")) {
      const name = cleanString(typeof body.name === "string" ? body.name : null);
      if (!name) return c.json({ error: "name must be a non-empty string" }, 400);
      if (name.length > 100) return c.json({ error: "name must be at most 100 characters" }, 400);
      return c.json(runtimeCompatibilityResponse(store.updateRuntime(loaded.runtime.id, { name })));
    }
    if (hasRequestField(body, "visibility")) {
      const visibility = cleanString(typeof body.visibility === "string" ? body.visibility : null);
      if (visibility !== "private" && visibility !== "public") {
        return c.json({ error: "visibility must be 'private' or 'public'" }, 400);
      }
      return c.json(runtimeCompatibilityResponse(store.updateRuntime(loaded.runtime.id, { visibility })));
    }
    return c.json(runtimeCompatibilityResponse(loaded.runtime));
  });
  app.get("/api/runtimes/:id/usage", (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const { runtime } = loaded;
    return c.json(store.listUsageDaily(usageQuery(c, { runtimeId: runtime.id }))
      .map(runtimeUsageDailyCompatibilityResponse)
      .sort(compareRuntimeUsageDailyCompatibilityRows));
  });
  app.get("/api/runtimes/:id/usage/by-agent", (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const { runtime } = loaded;
    return c.json(store.listUsageByAgent(usageQuery(c, { runtimeId: runtime.id })).map(runtimeUsageByAgentCompatibilityResponse));
  });
  app.get("/api/runtimes/:id/usage/by-hour", (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const { runtime } = loaded;
    return c.json(store.listUsageByHour(usageQuery(c, { runtimeId: runtime.id })).map(runtimeUsageByHourCompatibilityResponse));
  });
  app.get("/api/runtimes/:id/task-activity", (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const { runtime } = loaded;
    return c.json(store.listTaskActivityByHour(usageQuery(c, { runtimeId: runtime.id })).map(runtimeTaskActivityCompatibilityResponse));
  });
  app.get("/api/runtimes/:id/activity", (c) => {
    const loaded = loadRuntimeForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const { runtime } = loaded;
    return c.json(store.listTaskActivityByHour(usageQuery(c, { runtimeId: runtime.id })).map(runtimeTaskActivityCompatibilityResponse));
  });
  app.delete("/api/runtimes/:id", (c) => {
    const loaded = loadRuntimeForCurrentEditor(c, store, c.req.param("id"), "delete");
    if (loaded instanceof Response) return loaded;
    const activeAgents = store.listActiveAgentsByRuntime(loaded.runtime.id);
    if (activeAgents.length) return c.json(runtimeHasActiveAgentsResponse(activeAgents), 409);
    const result = store.deleteRuntimeWithArchivedAgentCleanup(loaded.runtime.id);
    if (result.status === "active_agents") return c.json(runtimeHasActiveAgentsResponse(result.activeAgents), 409);
    if (result.status === "active_tasks") {
      return c.json({
        error: "cannot delete runtime while it has active tasks",
        code: "runtime_has_active_tasks",
      }, 409);
    }
    if (result.status === "daemon_last_runtime") {
      return c.json({
        error: "cannot delete the last runtime of a daemon; retire the machine instead",
        code: "daemon_last_runtime",
        daemon_id: result.daemonId,
      }, 409);
    }
    if (result.status === "not_found") return c.json({ error: "runtime not found" }, 404);
    return c.json({ status: "ok" });
  });
  app.post("/api/runtimes/:id/archive-agents-and-delete", async (c) => {
    const body = await readJsonStrict<{ expected_active_agent_ids?: string[] }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const loaded = loadRuntimeForCurrentEditor(c, store, c.req.param("id"), "delete");
    if (loaded instanceof Response) return loaded;
    const expectedIds = parseExpectedActiveAgentIds(c, body.expected_active_agent_ids ?? []);
    if (expectedIds instanceof Response) return expectedIds;
    const result = store.archiveAgentsAndDeleteRuntime(loaded.runtime.id, expectedIds);
    if (result.status === "daemon_last_runtime") {
      return c.json({
        error: "cannot delete the last runtime of a daemon; retire the machine instead",
        code: "daemon_last_runtime",
        daemon_id: result.daemonId,
      }, 409);
    }
    if (result.status === "plan_changed") {
      return c.json(runtimeHasActiveAgentsResponse(
        result.activeAgents,
        "runtime_delete_plan_changed",
        "the active agent set changed; please review and confirm again.",
      ), 409);
    }
    return c.json({
      status: "ok",
      agents_archived: result.agentsArchived,
      tasks_cancelled: result.tasksCancelled,
    });
  });
  app.post("/api/multiremi/runtimes/:id/heartbeat", (c) => {
    let token = currentAccessToken(c);
    const runtimeId = c.req.param("id");
    if (token?.type === "pat" && token.purpose === "cli") {
      const upgradeDenied = promoteLegacyCliPatForDaemonHeartbeat(c, store, runtimeId);
      if (upgradeDenied) return upgradeDenied;
      token = currentAccessToken(c);
    }
    const isMaster = Boolean(authToken) && c.req.header("Authorization") === `Bearer ${authToken}`;
    if (
      token?.type !== "daemon"
      && !isMaster
      && authenticatedRequestUserId(c) !== null
    ) {
      return c.json({ error: "daemon token required", code: "daemon_token_required" }, 403);
    }
    const ownerMembershipDenied = denyDaemonOwnerWorkspaceMembership(c, store);
    if (ownerMembershipDenied) return ownerMembershipDenied;
    const denied = denyDaemonTokenRuntimeIdentity(c, store, runtimeId);
    if (denied) return denied;
    const ack = store.heartbeatRuntime(runtimeId, {
      supportsBatchImport: c.req.query("supports_batch_import") === "true" || c.req.query("supportsBatchImport") === "true",
      supportsDirectoryScan: c.req.query("supports_directory_scan") === "true" || c.req.query("supportsDirectoryScan") === "true",
    });
    if (ack.status === "runtime_gone") return c.json({ error: "runtime not found" }, 404);
    return c.json(ack);
  });
}

function runtimeCommandErrorResponse(c: Context, error: unknown): Response | null {
  if (!(error instanceof Error)) return null;
  if (
    error.message === "command is required"
    || error.message === "args must be an array of strings"
    || error.message.startsWith("command must not exceed")
    || error.message.startsWith("args must not contain")
    || error.message.startsWith("each command arg must not exceed")
    || error.message.startsWith("timeout_ms must be")
  ) {
    return c.json({ error: error.message }, 400);
  }
  return null;
}
