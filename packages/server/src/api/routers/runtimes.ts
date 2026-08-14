import type { Context, Hono } from "hono";
import { refreshStaleGatewayModels } from "@multiremi/relay/discovery.js";
import {
  bindDaemonTokenIdentityOrDeny,
  daemonLocalSkillImportReportBody,
  daemonLocalSkillListReportBody,
  denyCurrentUserWorkspaceAccess,
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
  readJson,
  readJsonStrict,
  safeCreateRuntimeUpdateRequest,
  usageQuery,
  validateMultiremiRuntimeProvider,
} from "../helpers.js";
import {
  cleanString,
  compareRuntimeUsageDailyCompatibilityRows,
  currentAccessToken,
  currentRequestUserId,
  directoryScanErrorResponse,
  fleetModelsResponse,
  hasRequestField,
  parseOptionalInt,
  runtimeCompatibilityResponse,
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
  CreateRuntimeLocalSkillImportInput,
  CreateRuntimeUpdateInput,
  RegisterRuntimeInput,
  ReportRuntimeDirectoryScanInput,
  ReportRuntimeLocalSkillImportInput,
  ReportRuntimeLocalSkillListInput,
  ReportRuntimeModelListInput,
  ReportRuntimeUpdateInput,
  UpdateRuntimeInput,
} from "@multiremi/contracts/types.js";
import type { RouterDeps } from "./deps.js";

export function registerRuntimeRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;

  app.get("/api/multiremi/runtimes", (c) => {
    const loaded = listRuntimesForCurrentUser(c, store);
    if (loaded instanceof Response) return loaded;
    return c.json({ runtimes: loaded.runtimes });
  });
  app.post("/api/multiremi/runtimes", async (c) => {
    const body = await readJson<RegisterRuntimeInput>(c);
    const workspaceId = body.workspaceId ?? body.workspace_id ?? "local";
    const denied = denyDaemonTokenWorkspace(c, workspaceId) ??
      (currentAccessToken(c)?.type === "daemon" ? null : denyCurrentUserWorkspaceAccess(c, store, workspaceId));
    if (denied) return denied;
    const provider = validateMultiremiRuntimeProvider(body.provider);
    if ("error" in provider) return c.json({ error: provider.error }, provider.status);
    if (currentAccessToken(c)?.type === "daemon") {
      const identityDenied = bindDaemonTokenIdentityOrDeny(c, store, body.daemonId ?? body.daemon_id);
      if (identityDenied) return identityDenied;
    }
    return c.json({ runtime: store.registerRuntime(body) }, 201);
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
  app.post("/api/daemon/runtimes/:runtimeId/models/claim", (c) => {
    return c.json({ request: store.claimRuntimeModelListRequest(c.req.param("runtimeId")) });
  });
  app.post("/api/daemon/runtimes/:runtimeId/models/:requestId/result", async (c) => {
    const runtimeId = c.req.param("runtimeId");
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
    const deleted = store.deleteRuntimeWithArchivedAgentCleanup(loaded.runtime.id);
    if (!deleted) return c.json({ error: "runtime not found" }, 404);
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
    const denied = denyDaemonTokenRuntimeWorkspace(c, store, c.req.param("id"));
    if (denied) return denied;
    const ack = store.heartbeatRuntime(c.req.param("id"), {
      supportsBatchImport: c.req.query("supports_batch_import") === "true" || c.req.query("supportsBatchImport") === "true",
      supportsDirectoryScan: c.req.query("supports_directory_scan") === "true" || c.req.query("supportsDirectoryScan") === "true",
    });
    if (ack.status === "runtime_gone") return c.json({ error: "runtime not found" }, 404);
    return c.json(ack);
  });
}
