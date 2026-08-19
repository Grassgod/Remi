import type { Context, Hono } from "hono";
import {
  backfillWorkspaceRepositoryDefaultBranches,
  denyCurrentUserWorkspaceAccess,
  githubConnectResponse,
  importWorkspaceRepository,
  inspectWorkspaceRepository,
  isGitHubAppConfigured,
  isJsonApiError,
  loadCurrentWorkspaceMember,
  mergeAgentEnv,
  publishWorkspaceEvent,
  readJson,
  readJsonStrict,
  readJsonStrictAllowEmpty,
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
  currentAccessToken,
  currentRequestUserId,
  memberRemovedPayload,
} from "../wire/index.js";
import {
  generateSshMeshKeyMaterial,
  SshMeshKeyError,
} from "@multiremi/ssh-mesh/keys.js";
import {
  WorkspaceDaemonRetirementRequiredError,
  WorkspaceSshMeshCleanupRequiredError,
} from "@multiremi/store/repos/workspaces-repo.js";
import {
  SshMeshMutationConflictError,
  SshMeshProbeConflictError,
} from "@multiremi/store/repos/ssh-mesh-repo.js";
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
    const workspaceId = c.req.param("id");
    const actorToken = currentAccessToken(c);
    if (actorToken?.type === "task" || actorToken?.type === "daemon") {
      return c.json({
        error: `forbidden for ${actorToken.type} token`,
        code: "human_admin_required",
      }, 403);
    }
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId)
      ?? requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    try {
      const deleted = store.deleteWorkspace(workspaceId);
      if (!deleted) return c.json({ error: "workspace not found" }, 404);
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof WorkspaceDaemonRetirementRequiredError) {
        return c.json({
          error: error.message,
          code: error.code,
          daemon_ids: error.daemonIds,
        }, 409);
      }
      if (error instanceof WorkspaceSshMeshCleanupRequiredError) {
        return c.json({
          error: error.message,
          code: error.code,
          ssh_mesh: {
            enabled: error.enabled,
            rotation_state: error.rotationState,
            uncleared_daemon_ids: error.daemonIds,
          },
        }, 409);
      }
      throw error;
    }
  });

  // ── Workspace env (owner/admin only) ───────────────────────────
  // Same contract as the agent env endpoints: GET returns plaintext to admins
  // (the UI masks by default), PUT replaces the whole map where a "****" value
  // keeps the currently stored value for that key.
  app.get("/api/workspaces/:id/env", (c) => {
    const workspaceId = c.req.param("id");
    const denied = requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    if (!store.getWorkspace(workspaceId)) return c.json({ error: "workspace not found" }, 404);
    c.header("Cache-Control", "no-store");
    return c.json({ workspace_id: workspaceId, env: store.getWorkspaceEnv(workspaceId) });
  });
  app.put("/api/workspaces/:id/env", async (c) => {
    const workspaceId = c.req.param("id");
    const denied = requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    if (!store.getWorkspace(workspaceId)) return c.json({ error: "workspace not found" }, 404);
    const body = await readJsonStrict<{ env?: Record<string, string> }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const nextEnv = mergeAgentEnv(store.getWorkspaceEnv(workspaceId), body.env ?? {});
    c.header("Cache-Control", "no-store");
    return c.json({ workspace_id: workspaceId, env: store.setWorkspaceEnv(workspaceId, nextEnv) });
  });

  // ── Trusted-machine SSH Mesh (owner/admin only) ───────────────
  // Browser routes intentionally expose only fingerprints and rollout state.
  // Private key material is generated server-side and only leaves through the
  // authenticated daemon config endpoint.
  app.get("/api/workspaces/:id/ssh-mesh", (c) => {
    const workspaceId = c.req.param("id");
    const denied = requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    if (!store.getWorkspace(workspaceId)) return c.json({ error: "workspace not found" }, 404);
    c.header("Cache-Control", "no-store");
    return c.json(store.getSshMeshOverview(workspaceId));
  });
  app.put("/api/workspaces/:id/ssh-mesh", async (c) => {
    const workspaceId = c.req.param("id");
    const denied = requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    if (!store.getWorkspace(workspaceId)) return c.json({ error: "workspace not found" }, 404);
    const body = await readJsonStrict<{ enabled?: boolean; invalidate_keys?: boolean }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    if (typeof body.enabled !== "boolean") return c.json({ error: "enabled must be a boolean" }, 400);
    if (Object.keys(body).some((key) => key !== "enabled" && key !== "invalidate_keys")) {
      return c.json({ error: "only server-generated SSH Mesh keys are supported" }, 400);
    }
    if (body.invalidate_keys !== undefined && body.invalidate_keys !== true) {
      return c.json({ error: "invalidate_keys must be true when provided" }, 400);
    }
    if (body.invalidate_keys === true && body.enabled) {
      return c.json({ error: "invalidate_keys is only valid when enabled is false" }, 400);
    }
    if (body.enabled) {
      const expiringCredentials = store.listExpiringBoundDaemonTokens(workspaceId);
      if (expiringCredentials.length) {
        return c.json({
          error: "SSH Mesh requires non-expiring daemon credentials; retire and reprovision the affected daemons",
          code: "ssh_mesh_expiring_daemon_credentials",
          daemon_ids: [...new Set(expiringCredentials.map((token) => token.daemonId).filter(Boolean))],
        }, 409);
      }
    }
    try {
      if (body.invalidate_keys === true) {
        c.header("Cache-Control", "no-store");
        return c.json(store.invalidateSshMeshKey(workspaceId));
      }
      const current = store.getSshMeshOverview(workspaceId);
      const keyMaterial = body.enabled && (current.key_version === 0 || current.rotation_state === "rekey_required")
        ? await generateSshMeshKeyMaterial(workspaceId)
        : null;
      c.header("Cache-Control", "no-store");
      return c.json(store.setSshMeshEnabled(
        workspaceId,
        body.enabled,
        keyMaterial,
        currentRequestUserId(c),
      ));
    } catch (error) {
      return sshMeshErrorResponse(c, error);
    }
  });
  app.post("/api/workspaces/:id/ssh-mesh/rotate", async (c) => {
    const workspaceId = c.req.param("id");
    const denied = requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    if (!store.getWorkspace(workspaceId)) return c.json({ error: "workspace not found" }, 404);
    const body = await readJsonStrictAllowEmpty<Record<string, never>>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    if (Object.keys(body).length) return c.json({ error: "rotate does not accept key material" }, 400);
    try {
      const keyMaterial = await generateSshMeshKeyMaterial(workspaceId);
      c.header("Cache-Control", "no-store");
      return c.json(store.rotateSshMeshKey(workspaceId, keyMaterial));
    } catch (error) {
      return sshMeshErrorResponse(c, error);
    }
  });
  app.post("/api/workspaces/:id/ssh-mesh/test", async (c) => {
    const workspaceId = c.req.param("id");
    const denied = requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    if (!store.getWorkspace(workspaceId)) return c.json({ error: "workspace not found" }, 404);
    const body = await readJsonStrict<{
      source_node_id?: string;
      target_node_id?: string;
      source_daemon_id?: string;
      target_daemon_id?: string;
    }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const sourceNodeId = String(body.source_node_id ?? body.source_daemon_id ?? "").trim();
    const targetNodeId = String(body.target_node_id ?? body.target_daemon_id ?? "").trim() || null;
    if (
      body.source_node_id !== undefined
      && body.source_daemon_id !== undefined
      && String(body.source_node_id).trim() !== String(body.source_daemon_id).trim()
    ) {
      return c.json({ error: "source_node_id and source_daemon_id must match when both are provided" }, 400);
    }
    if (
      body.target_node_id !== undefined
      && body.target_daemon_id !== undefined
      && String(body.target_node_id).trim() !== String(body.target_daemon_id).trim()
    ) {
      return c.json({ error: "target_node_id and target_daemon_id must match when both are provided" }, 400);
    }
    if (!sourceNodeId) return c.json({ error: "source_node_id is required" }, 400);
    try {
      return c.json(store.requestSshMeshProbe(workspaceId, sourceNodeId, targetNodeId), 202);
    } catch (error) {
      if (error instanceof SshMeshProbeConflictError) {
        return c.json({
          error: error.message,
          code: error.code,
          source_node_id: error.sourceNodeId,
          source_daemon_id: error.sourceDaemonId,
        }, 409);
      }
      return c.json({ error: error instanceof Error ? error.message : "could not request SSH test" }, 400);
    }
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

function sshMeshErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof SshMeshMutationConflictError) {
    return c.json({ error: error.message, code: error.code }, 409);
  }
  if (error instanceof SshMeshKeyError) {
    const unavailable = error.code === "encryption_key_missing"
      || error.code === "encryption_key_invalid"
      || error.code === "ssh_keygen_missing"
      || error.code === "key_generation_failed";
    return c.json({ error: error.message, code: error.code }, unavailable ? 503 : 400);
  }
  const message = error instanceof Error ? error.message : "SSH Mesh operation failed";
  const status = message === "workspace not found" ? 404 : 409;
  return c.json({ error: message }, status);
}
