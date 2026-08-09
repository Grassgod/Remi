import type { Hono } from "hono";
import {
  backfillWorkspaceRepositoryDefaultBranches,
  denyCurrentUserWorkspaceAccess,
  githubConnectResponse,
  importWorkspaceRepository,
  inspectWorkspaceRepository,
  isGitHubAppConfigured,
  isJsonApiError,
  loadCurrentWorkspaceMember,
  publishWorkspaceEvent,
  readJson,
  readJsonStrict,
  removeWorkspaceRepository,
  requireWorkspaceAdmin,
  safeCreateWorkspace,
  safeLeaveWorkspace,
  updateWorkspaceRepository,
  WorkspaceRepositoryError,
} from "../helpers.js";
import type {
  ImportWorkspaceRepositoryInput,
  InspectWorkspaceRepositoryInput,
  UpdateWorkspaceRepositoryInput,
} from "../helpers.js";
import {
  authenticatedRequestUserId,
  currentRequestUserId,
  memberRemovedPayload,
} from "../wire/index.js";
import type {
  CreateWorkspaceInput,
} from "@multiremi/contracts/types.js";
import {
  discoverGatewayModels,
  triggerGatewayDiscovery,
} from "@multiremi/relay/discovery.js";
import {
  extractBaseUrl,
  validateRelayFragment,
} from "@multiremi/relay/fragment.js";
import type { RouterDeps } from "./deps.js";

export function registerWorkspaceRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;

  app.get("/api/workspaces", (c) => {
    const userId = authenticatedRequestUserId(c);
    const all = store.listWorkspaces();
    // Master token / open mode (no identity) is admin and sees everything;
    // a logged-in user sees only the workspaces they are a member of.
    if (!userId) return c.json(all);
    return c.json(all.filter((ws) => store.getUserRoleInWorkspace(userId, ws.id) !== null));
  });
  app.post("/api/workspaces", async (c) => {
    const body = await readJson<any>(c);
    const result = safeCreateWorkspace(store, body, authenticatedRequestUserId(c));
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result, 201);
  });
  app.get("/api/workspaces/:id", (c) => {
    const workspaceId = c.req.param("id");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) return c.json({ error: "workspace not found" }, 404);
    return c.json(workspace);
  });
  app.put("/api/workspaces/:id", async (c) => {
    const denied = denyCurrentUserWorkspaceAccess(c, store, c.req.param("id"));
    if (denied) return denied;
    const body = await readJson<Partial<CreateWorkspaceInput>>(c);
    return c.json(store.updateWorkspace(c.req.param("id"), body));
  });
  app.patch("/api/workspaces/:id", async (c) => {
    const denied = denyCurrentUserWorkspaceAccess(c, store, c.req.param("id"));
    if (denied) return denied;
    const body = await readJson<Partial<CreateWorkspaceInput>>(c);
    return c.json(store.updateWorkspace(c.req.param("id"), body));
  });
  app.get("/api/workspaces/:id/repos", async (c) => {
    const workspaceId = c.req.param("id");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    try {
      const repositories = await backfillWorkspaceRepositoryDefaultBranches(
        store,
        workspaceId,
        deps.inspectGitRemoteRepository,
      );
      return c.json({ repositories, total: repositories.length });
    } catch (error) {
      if (error instanceof WorkspaceRepositoryError) {
        return c.json({ error: error.message }, error.status);
      }
      throw error;
    }
  });
  app.post("/api/workspaces/:id/repos/inspect", async (c) => {
    const workspaceId = c.req.param("id");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId)
      ?? requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<InspectWorkspaceRepositoryInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      return c.json(await inspectWorkspaceRepository(
        body,
        deps.inspectGitRemoteRepository,
      ));
    } catch (error) {
      if (error instanceof WorkspaceRepositoryError) {
        return c.json({ error: error.message }, error.status);
      }
      throw error;
    }
  });
  app.post("/api/workspaces/:id/repos", async (c) => {
    const workspaceId = c.req.param("id");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId)
      ?? requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<ImportWorkspaceRepositoryInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const result = await importWorkspaceRepository(
        store,
        workspaceId,
        body,
        deps.inspectGitRemoteRepository,
      );
      publishWorkspaceEvent(c, store, "workspace:updated", workspaceId, {
        workspace: result.workspace,
        repository: result.repository,
      });
      return c.json(result, 201);
    } catch (error) {
      if (error instanceof WorkspaceRepositoryError) {
        return c.json({ error: error.message }, error.status);
      }
      throw error;
    }
  });
  app.patch("/api/workspaces/:id/repos/:repositoryId", async (c) => {
    const workspaceId = c.req.param("id");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId)
      ?? requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<UpdateWorkspaceRepositoryInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const result = await updateWorkspaceRepository(
        store,
        workspaceId,
        c.req.param("repositoryId"),
        body,
        deps.inspectGitRemoteRepository,
      );
      publishWorkspaceEvent(c, store, "workspace:updated", workspaceId, {
        workspace: result.workspace,
        repository: result.repository,
      });
      return c.json(result);
    } catch (error) {
      if (error instanceof WorkspaceRepositoryError) {
        return c.json({ error: error.message }, error.status);
      }
      throw error;
    }
  });
  app.delete("/api/workspaces/:id/repos/:repositoryId", (c) => {
    const workspaceId = c.req.param("id");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId)
      ?? requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    try {
      const result = removeWorkspaceRepository(
        store,
        workspaceId,
        c.req.param("repositoryId"),
      );
      publishWorkspaceEvent(c, store, "workspace:updated", workspaceId, {
        workspace: result.workspace,
        repository_id: result.repository.id,
      });
      return c.json(result);
    } catch (error) {
      if (error instanceof WorkspaceRepositoryError) {
        return c.json({ error: error.message }, error.status);
      }
      throw error;
    }
  });
  app.delete("/api/workspaces/:id", (c) => {
    const denied = denyCurrentUserWorkspaceAccess(c, store, c.req.param("id"));
    if (denied) return denied;
    const deleted = store.deleteWorkspace(c.req.param("id"));
    if (!deleted) return c.json({ error: "workspace not found" }, 404);
    return c.body(null, 204);
  });

  // ── Model gateway: relay config (owner/admin only) ─────────────
  app.get("/api/workspaces/:id/relay-config", (c) => {
    const workspaceId = c.req.param("id");
    const denied = requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    return c.json(store.getRelayConfigForBrowser(workspaceId));
  });
  // Registered before the `/:engine` route so Hono's param matcher doesn't treat
  // "discovery" as an engine name.
  app.put("/api/workspaces/:id/relay-config/discovery", async (c) => {
    const workspaceId = c.req.param("id");
    const denied = requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<{ enabled?: boolean }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    store.setRelayModelDiscovery(workspaceId, Boolean(body.enabled));
    if (body.enabled) triggerGatewayDiscovery(store, workspaceId);
    return c.json({ model_discovery: store.getRelayModelDiscovery(workspaceId) });
  });
  app.put("/api/workspaces/:id/relay-config/:engine", async (c) => {
    const workspaceId = c.req.param("id");
    const engine = c.req.param("engine");
    if (engine !== "claude" && engine !== "codex") return c.json({ error: "invalid engine" }, 400);
    const denied = requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<{ fragment?: string; token_op?: string; auth_token?: string }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const fragment = String(body.fragment ?? "");
    const validation = validateRelayFragment(engine, fragment);
    if (!validation.ok) return c.json({ error: validation.error }, 400);
    const tokenOp = body.token_op === "set" || body.token_op === "clear" ? body.token_op : "keep";
    // A token must always ship with its gateway URL so the daemon never pairs the
    // central token with a stale local base_url. If the config will carry a token,
    // the fragment must define the gateway base_url.
    const willHaveToken = tokenOp === "set"
      ? Boolean(body.auth_token)
      : tokenOp === "keep"
        ? Boolean(store.getRelayConfigForDaemon(workspaceId)[engine]?.authToken)
        : false;
    if (willHaveToken && !extractBaseUrl(engine, fragment)) {
      return c.json({ error: "fragment must define the gateway base_url when a token is set" }, 400);
    }
    store.upsertRelayConfig(workspaceId, engine, {
      fragment,
      tokenOp,
      authToken: body.auth_token,
      actor: currentRequestUserId(c),
    });
    // Await discovery (bounded) so the returned catalog reflects the new gateway:
    // the client invalidates its fleet-model cache on success, and that refetch then
    // sees the fresh snapshot instead of the pre-save one. A slow/hung gateway can't
    // stall the save — the race resolves at 8s and discovery finishes in the background.
    await Promise.race([
      discoverGatewayModels(store, workspaceId, engine).catch(() => {}),
      new Promise<void>((resolve) => { setTimeout(resolve, 8_000); }),
    ]);
    return c.json(store.getRelayConfigForBrowser(workspaceId));
  });
  app.post("/api/workspaces/:id/relay-config/:engine/reveal", (c) => {
    const workspaceId = c.req.param("id");
    const engine = c.req.param("engine");
    if (engine !== "claude" && engine !== "codex") return c.json({ error: "invalid engine" }, 400);
    const denied = requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    c.header("Cache-Control", "no-store");
    return c.json({ token: store.revealRelayToken(workspaceId, engine) ?? "" });
  });
  app.post("/api/workspaces/:id/leave", async (c) => {
    const workspaceId = c.req.param("id");
    const requester = loadCurrentWorkspaceMember(c, store, workspaceId);
    if (requester instanceof Response) return requester;
    const left = safeLeaveWorkspace(store, workspaceId, requester.member.id);
    if ("error" in left) return c.json({ error: left.error }, left.status);
    publishWorkspaceEvent(c, store, "member:removed", workspaceId, memberRemovedPayload(requester.member));
    return c.body(null, 204);
  });

  app.get("/api/workspaces/:id/github/connect", (c) => c.json(githubConnectResponse(c.req.param("id"))));
  app.get("/api/workspaces/:id/github/installations", (c) => c.json({
    installations: [],
    configured: isGitHubAppConfigured(),
    can_manage: true,
  }));
  app.delete("/api/workspaces/:id/github/installations/:installationId", (c) => c.body(null, 204));
  app.get("/api/workspaces/:id/lark/installations", (c) => c.json({
    installations: [],
    configured: false,
    install_supported: false,
    workspace_id: c.req.param("id"),
  }));
  app.post("/api/workspaces/:id/lark/install/begin", (c) => c.json({
    session_id: `local-lark-${Date.now()}`,
    qr_code_url: "",
    expires_in_seconds: 0,
    poll_interval_seconds: 5,
    configured: false,
    status: "error",
    error_reason: "not_configured",
    error_message: "Lark integration is not configured in local Bun Multiremi",
  }, 202));
  app.get("/api/workspaces/:id/lark/install/:sessionId/status", (c) => c.json({
    status: "error",
    error_reason: "not_configured",
    error_message: "Lark integration is not configured in local Bun Multiremi",
    session_id: c.req.param("sessionId"),
  }));
  app.delete("/api/workspaces/:id/lark/installations/:installationId", (c) => c.body(null, 204));
}
