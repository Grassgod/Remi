import type { Context, Hono } from "hono";
import {
  denyCurrentUserWorkspaceAccess,
  denyDaemonRuntimeObservedStateAccess,
  denyDaemonTokenWorkspace,
  isJsonApiError,
  loadAgentForCurrentManager,
  loadAgentForCurrentUser,
  publishWorkspaceEvent,
  readJsonStrict,
} from "../helpers.js";
import {
  currentRequestUserId,
  currentAccessToken,
  currentWorkspaceRoleStrict,
  daemonAgentPluginDesiredResponse,
  daemonAgentPluginStateResponse,
} from "../wire/index.js";
import { AgentPluginStoreError } from "@multiremi/store/repos/agent-plugins-repo.js";
import { AgentPluginValidationError } from "@multiremi/agent-plugins/import.js";
import {
  AgentPluginGitImportError,
  type ResolvedAgentPluginGitSource,
} from "@multiremi/agent-plugins/git-import.js";
import type {
  CreateAgentPluginBindingInput,
  CreateAgentPluginVersionInput,
  ImportAgentPluginInput,
  ImportAgentPluginFromGitInput,
  ImportAgentPluginRequest,
  InspectAgentPluginRepositoryInput,
  ReportAgentPluginRuntimeStateInput,
  UpdateAgentPluginBindingInput,
  UpdateAgentPluginInput,
} from "@multiremi/contracts/types.js";
import type { RouterDeps } from "./deps.js";

export function registerAgentPluginRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;

  app.get("/api/multiremi/agent-plugins", (c) => {
    const workspaceId = requestedWorkspaceId(c);
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    try {
      const plugins = store.listAgentPlugins(workspaceId, {
        provider: c.req.query("provider"),
        includeArchived: c.req.query("include_archived") === "true" || c.req.query("includeArchived") === "true",
      });
      return c.json({ plugins, total: plugins.length });
    } catch (error) {
      return pluginErrorResponse(c, error);
    }
  });

  app.post("/api/multiremi/agent-plugins/inspect", async (c) => {
    const body = await readJsonStrict<InspectAgentPluginRepositoryInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const workspaceId = requestedWorkspaceId(c, body);
    const denied = requireWorkspaceManager(c, deps, workspaceId);
    if (denied) return denied;
    try {
      const resolved = await deps.resolveAgentPluginGitSource({
        sourceUrl: requiredString(body.sourceUrl ?? body.source_url, "source_url"),
        sourceRef: body.sourceRef ?? body.source_ref,
        sourceSubdir: body.sourceSubdir ?? body.source_subdir,
      });
      return c.json({ inspection: repositoryInspectionResponse(resolved) });
    } catch (error) {
      return pluginErrorResponse(c, error);
    }
  });

  app.post("/api/multiremi/agent-plugins/import", async (c) => {
    const body = await readJsonStrict<ImportAgentPluginRequest>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const target = body.id ? store.getAgentPlugin(body.id) : null;
    if (body.id && !target) {
      return c.json({ error: "plugin not found", code: "plugin_not_found" }, 404);
    }
    const workspaceId = requestedWorkspaceId(c, body, target?.workspaceId ?? "local");
    const denied = requireWorkspaceManager(c, deps, target?.workspaceId ?? workspaceId);
    if (denied) {
      if (target && denied.status === 404) {
        return c.json({ error: "plugin not found", code: "plugin_not_found" }, 404);
      }
      return denied;
    }
    if (target && target.workspaceId !== workspaceId) {
      return c.json({
        error: "plugin and import source must belong to the same workspace",
        code: "workspace_mismatch",
      }, 400);
    }
    try {
      const input: ImportAgentPluginInput = isGitImportRequest(body)
        ? await gitImportInput(c, deps, workspaceId, body)
        : {
            ...body,
            workspaceId,
            workspace_id: workspaceId,
            createdBy: currentRequestUserId(c),
            created_by: currentRequestUserId(c),
          };
      const plugin = store.importAgentPlugin(input);
      publishWorkspaceEvent(c, store, "agent_plugin:imported", workspaceId, { plugin });
      return c.json({ plugin }, 201);
    } catch (error) {
      return pluginErrorResponse(c, error);
    }
  });

  app.get("/api/multiremi/agent-plugins/:id", (c) => {
    const plugin = store.getAgentPlugin(c.req.param("id"));
    if (!plugin) return c.json({ error: "plugin not found", code: "plugin_not_found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, plugin.workspaceId);
    if (denied) return denied;
    return c.json({ plugin });
  });

  app.patch("/api/multiremi/agent-plugins/:id", async (c) => {
    const loaded = loadPluginForManager(c, deps, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrict<UpdateAgentPluginInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const plugin = store.updateAgentPlugin(loaded.id, body);
      publishWorkspaceEvent(c, store, "agent_plugin:updated", plugin.workspaceId, { plugin });
      return c.json({ plugin });
    } catch (error) {
      return pluginErrorResponse(c, error);
    }
  });

  app.delete("/api/multiremi/agent-plugins/:id", (c) => {
    const loaded = loadPluginForManager(c, deps, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    try {
      const plugin = store.archiveAgentPlugin(loaded.id);
      publishWorkspaceEvent(c, store, "agent_plugin:archived", plugin.workspaceId, { plugin_id: plugin.id });
      return c.json({ plugin });
    } catch (error) {
      return pluginErrorResponse(c, error);
    }
  });

  app.post("/api/multiremi/agent-plugins/:id/restore", (c) => {
    const plugin = store.getAgentPlugin(c.req.param("id"), { includeArchived: true });
    if (!plugin) return c.json({ error: "plugin not found", code: "plugin_not_found" }, 404);
    const denied = requireWorkspaceManager(c, deps, plugin.workspaceId);
    if (denied) return denied;
    try {
      const restored = store.restoreAgentPlugin(plugin.id);
      publishWorkspaceEvent(c, store, "agent_plugin:restored", restored.workspaceId, { plugin: restored });
      return c.json({ plugin: restored });
    } catch (error) {
      return pluginErrorResponse(c, error);
    }
  });

  app.get("/api/multiremi/agent-plugins/:id/versions", (c) => {
    const plugin = store.getAgentPlugin(c.req.param("id"));
    if (!plugin) return c.json({ error: "plugin not found", code: "plugin_not_found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, plugin.workspaceId);
    if (denied) return denied;
    const versions = store.listAgentPluginVersions(plugin.id);
    return c.json({ versions, total: versions.length });
  });

  app.post("/api/multiremi/agent-plugins/:id/versions", async (c) => {
    const plugin = loadPluginForManager(c, deps, c.req.param("id"));
    if (plugin instanceof Response) return plugin;
    const body = await readJsonStrict<CreateAgentPluginVersionInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const version = store.createAgentPluginVersion(plugin.id, {
        ...body,
        createdBy: currentRequestUserId(c),
        created_by: currentRequestUserId(c),
      });
      const updatedPlugin = store.getAgentPlugin(plugin.id)!;
      publishWorkspaceEvent(c, store, "agent_plugin:version_created", plugin.workspaceId, {
        plugin: updatedPlugin,
        version,
      });
      return c.json({ plugin: updatedPlugin, version }, 201);
    } catch (error) {
      return pluginErrorResponse(c, error);
    }
  });

  app.post("/api/multiremi/agent-plugins/:id/activate", async (c) => {
    const plugin = loadPluginForManager(c, deps, c.req.param("id"));
    if (plugin instanceof Response) return plugin;
    const body = await readJsonStrict<{ versionId?: string; version_id?: string }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const versionId = String(body.versionId ?? body.version_id ?? "").trim();
    if (!versionId) return c.json({ error: "version_id is required", code: "missing_version_id" }, 400);
    try {
      const activated = store.activateAgentPluginVersion(plugin.id, versionId);
      publishWorkspaceEvent(c, store, "agent_plugin:activated", plugin.workspaceId, { plugin: activated });
      return c.json({ plugin: activated });
    } catch (error) {
      return pluginErrorResponse(c, error);
    }
  });

  app.post("/api/multiremi/agent-plugins/:id/rollback", async (c) => {
    const plugin = loadPluginForManager(c, deps, c.req.param("id"));
    if (plugin instanceof Response) return plugin;
    const body = await readJsonStrict<{ versionId?: string | null; version_id?: string | null }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const rolledBack = store.rollbackAgentPluginVersion(plugin.id, body.versionId ?? body.version_id);
      publishWorkspaceEvent(c, store, "agent_plugin:rolled_back", plugin.workspaceId, { plugin: rolledBack });
      return c.json({ plugin: rolledBack });
    } catch (error) {
      return pluginErrorResponse(c, error);
    }
  });

  app.get("/api/multiremi/agent-plugins/:id/runtimes", (c) => {
    const plugin = store.getAgentPlugin(c.req.param("id"));
    if (!plugin) return c.json({ error: "plugin not found", code: "plugin_not_found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, plugin.workspaceId);
    if (denied) return denied;
    const states = store.listAgentPluginRuntimeStates({
      pluginId: plugin.id,
      includeHistorical: c.req.query("include_historical") === "true" || c.req.query("includeHistorical") === "true",
    });
    return c.json({ states, total: states.length });
  });

  app.post("/api/multiremi/agent-plugins/:id/runtimes/retry", async (c) => {
    const plugin = loadPluginForManager(c, deps, c.req.param("id"));
    if (plugin instanceof Response) return plugin;
    const body = await readJsonStrict<{
      runtimeId?: string | null;
      runtime_id?: string | null;
      versionId?: string | null;
      version_id?: string | null;
    }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const states = store.retryAgentPluginRuntime(
        plugin.id,
        body.runtimeId ?? body.runtime_id,
        body.versionId ?? body.version_id,
      );
      publishWorkspaceEvent(c, store, "agent_plugin:runtime_retry", plugin.workspaceId, {
        plugin_id: plugin.id,
        state_ids: states.map((state) => state.id),
      });
      return c.json({ states, total: states.length });
    } catch (error) {
      return pluginErrorResponse(c, error);
    }
  });

  app.get("/api/multiremi/runtimes/:runtimeId/agent-plugins", (c) => {
    const runtime = store.getRuntime(c.req.param("runtimeId"));
    if (!runtime) return c.json({ error: "runtime not found", code: "runtime_not_found" }, 404);
    const workspaceId = runtime.workspaceId ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const states = store.listAgentPluginRuntimeStates({
      runtimeId: runtime.id,
      includeHistorical: c.req.query("include_historical") === "true" || c.req.query("includeHistorical") === "true",
    });
    return c.json({ states, total: states.length });
  });

  app.get("/api/multiremi/agents/:id/plugins", (c) => {
    const loaded = loadAgentForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    try {
      const bindings = store.listAgentPluginBindings(loaded.agent.id);
      return c.json({ bindings, capabilityRevision: store.getAgentPluginCapabilityRevision(loaded.agent.id), total: bindings.length });
    } catch (error) {
      return pluginErrorResponse(c, error);
    }
  });

  app.post("/api/multiremi/agents/:id/plugins", async (c) => {
    const loaded = loadAgentForCurrentManager(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrict<CreateAgentPluginBindingInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const unsupported = unsupportedBindingConfiguration(body);
    if (unsupported) return c.json(unsupported, 400);
    try {
      const binding = store.createAgentPluginBinding(loaded.agent.id, body);
      publishWorkspaceEvent(c, store, "agent_plugin:bound", loaded.agent.workspaceId, { agent_id: loaded.agent.id, binding });
      return c.json({ binding, capabilityRevision: store.getAgentPluginCapabilityRevision(loaded.agent.id) }, 201);
    } catch (error) {
      return pluginErrorResponse(c, error);
    }
  });

  app.patch("/api/multiremi/agents/:id/plugins/:bindingId", async (c) => {
    const loaded = loadAgentForCurrentManager(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrict<UpdateAgentPluginBindingInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const unsupported = unsupportedBindingConfiguration(body);
    if (unsupported) return c.json(unsupported, 400);
    try {
      const binding = store.updateAgentPluginBinding(loaded.agent.id, c.req.param("bindingId"), body);
      publishWorkspaceEvent(c, store, "agent_plugin:binding_updated", loaded.agent.workspaceId, {
        agent_id: loaded.agent.id,
        binding,
      });
      return c.json({ binding, capabilityRevision: store.getAgentPluginCapabilityRevision(loaded.agent.id) });
    } catch (error) {
      return pluginErrorResponse(c, error);
    }
  });

  app.delete("/api/multiremi/agents/:id/plugins/:bindingId", (c) => {
    const loaded = loadAgentForCurrentManager(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    try {
      store.deleteAgentPluginBinding(loaded.agent.id, c.req.param("bindingId"));
      const capabilityRevision = store.getAgentPluginCapabilityRevision(loaded.agent.id);
      publishWorkspaceEvent(c, store, "agent_plugin:unbound", loaded.agent.workspaceId, {
        agent_id: loaded.agent.id,
        binding_id: c.req.param("bindingId"),
      });
      return c.json({ deleted: true, capabilityRevision });
    } catch (error) {
      return pluginErrorResponse(c, error);
    }
  });

  app.get("/api/daemon/runtimes/:runtimeId/agent-plugins/desired", (c) => {
    const denied = denyDaemonRuntimeObservedStateAccess(c, store, c.req.param("runtimeId"));
    if (denied) return denied;
    try {
      return c.json(daemonAgentPluginDesiredResponse(
        store.getRuntimeAgentPluginDesiredSnapshot(c.req.param("runtimeId")),
      ));
    } catch (error) {
      return pluginErrorResponse(c, error);
    }
  });

  app.post("/api/daemon/runtimes/:runtimeId/agent-plugins/:versionId/state", async (c) => {
    const denied = denyDaemonRuntimeObservedStateAccess(c, store, c.req.param("runtimeId"));
    if (denied) return denied;
    const body = await readJsonStrict<ReportAgentPluginRuntimeStateInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const state = store.reportAgentPluginRuntimeState(c.req.param("runtimeId"), c.req.param("versionId"), body);
      publishWorkspaceEvent(c, store, "agent_plugin:runtime_state", state.workspaceId, {
        state: daemonAgentPluginStateResponse(state),
      });
      return c.json({ state: daemonAgentPluginStateResponse(state) });
    } catch (error) {
      return pluginErrorResponse(c, error);
    }
  });

  app.get("/api/daemon/agent-plugin-artifacts/:digest", (c) => {
    const digest = c.req.param("digest").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(digest)) {
      return c.json({ error: "invalid artifact digest", code: "invalid_artifact_digest" }, 400);
    }
    const token = currentAccessToken(c);
    const loaded = store.getAgentPluginArtifactByDigest(digest, token?.type === "daemon" ? token.workspaceId : null);
    if (!loaded) return c.json({ error: "plugin artifact not found", code: "artifact_not_found" }, 404);
    const denied = token?.type === "daemon"
      ? denyDaemonTokenWorkspace(c, loaded.plugin.workspaceId, { hideForbiddenAsNotFound: true })
      : denyCurrentUserWorkspaceAccess(c, store, loaded.plugin.workspaceId);
    if (denied) return denied;
    return c.body(loaded.artifactJson, 200, {
      "Content-Type": "application/vnd.multiremi.agent-plugin+json",
      "Content-Length": String(Buffer.byteLength(loaded.artifactJson, "utf8")),
      ETag: `"sha256-${loaded.version.artifactDigest}"`,
      "Cache-Control": "private, max-age=31536000, immutable",
    });
  });
}

function repositoryInspectionResponse(resolved: ResolvedAgentPluginGitSource) {
  return {
    sourceUrl: resolved.sourceUrl,
    sourceRef: resolved.sourceRef,
    defaultBranch: resolved.defaultBranch,
    branches: resolved.branches,
    sourceRevision: resolved.sourceRevision,
    candidates: resolved.candidates.map((candidate) => ({
      provider: candidate.provider,
      name: candidate.name,
      description: candidate.description,
      version: candidate.version,
      sourceSubdir: candidate.pluginSubdir,
      manifestPath: candidate.manifestPath,
      manifest: candidate.manifest,
      fileCount: candidate.fileCount,
      artifactSize: candidate.artifactSize,
    })),
  };
}

function isGitImportRequest(
  input: ImportAgentPluginRequest,
): input is ImportAgentPluginFromGitInput {
  return "mode" in input && input.mode === "git";
}

async function gitImportInput(
  c: Context,
  deps: RouterDeps,
  workspaceId: string,
  input: ImportAgentPluginFromGitInput,
): Promise<ImportAgentPluginInput> {
  const target = input.id ? deps.store.getAgentPlugin(input.id) : null;
  if (input.id && !target) {
    throw new AgentPluginStoreError("plugin not found", "plugin_not_found", 404);
  }
  if (target && target.workspaceId !== workspaceId) {
    throw new AgentPluginValidationError(
      "plugin and import source must belong to the same workspace",
      "workspace_mismatch",
    );
  }

  const rawSubdir = input.sourceSubdir ?? input.source_subdir;
  const selectedSubdir = rawSubdir === undefined || rawSubdir === null
    ? target
      ? (target.sourceSubdir ?? "")
      : undefined
    : String(rawSubdir).trim().replace(/\/$/, "");
  const selectedProvider = input.provider ?? target?.provider ?? null;
  const selectedManifestPath = String(
    input.manifestPath ?? input.manifest_path ?? "",
  ).trim() || null;
  const resolved = await deps.resolveAgentPluginGitSource({
    sourceUrl: requiredString(
      input.sourceUrl ?? input.source_url ?? target?.sourceUrl,
      "source_url",
    ),
    sourceRef: input.sourceRef ?? input.source_ref ?? target?.sourceRef,
    sourceSubdir: selectedSubdir,
    provider: selectedProvider,
    manifestPath: selectedManifestPath,
    includeFiles: true,
    exactSourceSubdir: true,
  });
  const expectedRevision = String(
    input.expectedRevision ?? input.expected_revision ?? "",
  ).trim().toLowerCase();
  if (expectedRevision && expectedRevision !== resolved.sourceRevision) {
    throw new AgentPluginGitImportError(
      "Plugin repository changed after inspection; read it again before importing",
      "plugin_git_revision_changed",
      409,
    );
  }

  const matchingCandidates = resolved.candidates.filter((item) => (
    (selectedSubdir === null || selectedSubdir === undefined || item.pluginSubdir === selectedSubdir)
    && (!selectedProvider || item.provider === selectedProvider)
    && (!selectedManifestPath || item.manifestPath === selectedManifestPath)
  ));
  const candidate = matchingCandidates.length === 1 ? matchingCandidates[0] : null;
  if (!candidate) {
    throw new AgentPluginGitImportError(
      matchingCandidates.length > 1
        ? "select one Plugin from the repository before importing"
        : "the selected Plugin was not found in the repository",
      matchingCandidates.length > 1
        ? "plugin_selection_required"
        : "plugin_manifest_not_found",
    );
  }
  if (target && target.provider !== candidate.provider) {
    throw new AgentPluginValidationError(
      `${candidate.provider} plugin cannot update ${target.provider} plugin`,
      "provider_mismatch",
    );
  }

  return {
    ...(target
      ? {
          id: target.id,
          name: target.name,
          description: target.description,
        }
      : {}),
    workspaceId,
    workspace_id: workspaceId,
    provider: candidate.provider,
    version: candidate.version,
    manifestPath: candidate.manifestPath,
    manifest: candidate.manifest,
    files: candidate.files ?? [],
    sourceType: "git",
    sourceUrl: resolved.sourceUrl,
    sourceRef: resolved.sourceRef,
    sourceSubdir: candidate.pluginSubdir,
    sourceRevision: resolved.sourceRevision,
    requirements:
      input.requirements ?? target?.activeVersion?.requirements ?? {},
    metadata: {
      source_default_branch: resolved.defaultBranch,
      source_url: resolved.sourceUrl,
      source_ref: resolved.sourceRef,
      source_subdir: candidate.pluginSubdir,
      source_manifest_path: candidate.manifestPath,
      source_provider: candidate.provider,
    },
    activate: input.activate,
    createdBy: currentRequestUserId(c),
    created_by: currentRequestUserId(c),
  };
}

function requiredString(value: unknown, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized) return normalized;
  throw new AgentPluginGitImportError(
    `${field} is required`,
    `missing_${field}`,
  );
}

function requestedWorkspaceId(
  c: Context,
  input: { workspaceId?: string | null; workspace_id?: string | null } = {},
  fallback = "local",
): string {
  return String(
    input.workspaceId
      ?? input.workspace_id
      ?? c.req.query("workspace_id")
      ?? c.req.query("workspaceId")
      ?? fallback,
  ).trim() || fallback;
}

function requireWorkspaceManager(c: Context, deps: RouterDeps, workspaceId: string): Response | null {
  const denied = denyCurrentUserWorkspaceAccess(c, deps.store, workspaceId);
  if (denied) return denied;
  const role = currentWorkspaceRoleStrict(c, deps.store, workspaceId);
  if (role === "owner" || role === "admin") return null;
  return c.json({ error: "workspace admin access required", code: "workspace_admin_required" }, 403);
}

function loadPluginForManager(c: Context, deps: RouterDeps, pluginId: string) {
  const plugin = deps.store.getAgentPlugin(pluginId);
  if (!plugin) return c.json({ error: "plugin not found", code: "plugin_not_found" }, 404);
  const denied = requireWorkspaceManager(c, deps, plugin.workspaceId);
  return denied ?? plugin;
}

function unsupportedBindingConfiguration(
  input: CreateAgentPluginBindingInput | UpdateAgentPluginBindingInput,
): { error: string; code: string } | null {
  const connectionId = String(input.connectionId ?? input.connection_id ?? "").trim();
  const config = input.config as unknown;
  const emptyConfig = config === undefined
    || config === null
    || (typeof config === "object" && !Array.isArray(config) && Object.keys(config).length === 0);
  if (!connectionId && emptyConfig) return null;
  return {
    error: "plugin connections and runtime configuration are not supported yet",
    code: "plugin_binding_configuration_unsupported",
  };
}

function pluginErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof AgentPluginGitImportError) {
    const body = { error: error.message, code: error.code };
    if (error.status === 409) return c.json(body, 409);
    if (error.status === 502) return c.json(body, 502);
    if (error.status === 503) return c.json(body, 503);
    if (error.status === 504) return c.json(body, 504);
    return c.json(body, 400);
  }
  if (error instanceof AgentPluginValidationError) {
    return c.json({ error: error.message, code: error.code }, 400);
  }
  if (error instanceof AgentPluginStoreError) {
    const body = { error: error.message, code: error.code };
    if (error.status === 404) return c.json(body, 404);
    if (error.status === 409) return c.json(body, 409);
    if (error.status === 403) return c.json(body, 403);
    return c.json(body, 400);
  }
  throw error;
}
