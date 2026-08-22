import type { Context, Hono } from "hono";
import {
  backfillWorkspaceRepositoryDefaultBranches,
  denyCurrentUserWorkspaceAccess,
  importWorkspaceRepository,
  inspectWorkspaceRepository,
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
  CreateRepositoryWikiDocInput,
  CreateWorkspaceInput,
  MultiremiAutopilot,
  MultiremiAutopilotEventConfig,
  MultiremiAutopilotExecutionMode,
  MultiremiAutopilotTriggerKind,
  MultiremiRepositoryWikiDoc,
  MultiremiRepositoryWikiDocRevision,
  UpdateRepositoryWikiDocInput,
  UpdateMultiremiPromptSettingsInput,
} from "@multiremi/contracts/types.js";
import { nowIso } from "@multiremi/ids.js";
import { RepositoryWikiUnavailableError } from "@multiremi/repository-wiki/service.js";
import {
  mergeWorkspacePromptSettings,
  readWorkspacePromptSettings,
  WorkspacePromptRevisionConflictError,
} from "../../prompts/workspace-settings.js";
import { listWorkspaceRepositories } from "../helpers/repositories.js";
import {
  discoverGatewayModels,
  triggerGatewayDiscovery,
} from "@multiremi/relay/discovery.js";
import {
  extractBaseUrl,
  validateRelayFragment,
} from "@multiremi/relay/fragment.js";
import type { RouterDeps } from "./deps.js";
import { createAgentFromTemplate, getAgentTemplate } from "../agent-templates.js";

const ATLAS_AGENT_NAME = "Atlas · LLM Wiki";
const ATLAS_REPOSITORY_AUTOPILOT_TITLE = "Atlas · Repository Wiki";
const ATLAS_PROJECT_AUTOPILOT_TITLE = "Atlas · Project Knowledge";

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
  app.get("/api/workspaces/:id/prompts", (c) => {
    const workspaceId = c.req.param("id");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) return c.json({ error: "workspace not found" }, 404);
    return c.json(readWorkspacePromptSettings(workspace));
  });
  app.put("/api/workspaces/:id/prompts", async (c) => {
    const workspaceId = c.req.param("id");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId)
      ?? requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<UpdateMultiremiPromptSettingsInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) return c.json({ error: "workspace not found" }, 404);
    try {
      const merged = mergeWorkspacePromptSettings(
        workspace,
        body,
        currentRequestUserId(c),
        nowIso(),
      );
      if (merged.settings !== workspace.settings) {
        store.updateWorkspace(workspaceId, { settings: merged.settings });
      }
      return c.json(merged.prompts);
    } catch (error) {
      if (error instanceof WorkspacePromptRevisionConflictError) {
        return c.json({
          error: error.message,
          code: error.code,
          expectedRevision: error.expectedRevision,
          currentRevision: error.currentRevision,
        }, 409);
      }
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, 400);
    }
  });
  app.put("/api/workspaces/:id", async (c) => {
    const denied = denyCurrentUserWorkspaceAccess(c, store, c.req.param("id"));
    if (denied) return denied;
    const body = await readJson<Partial<CreateWorkspaceInput>>(c);
    if (hasOwn(body, "settings")) {
      const adminDenied = requireWorkspaceAdmin(c, store, c.req.param("id"));
      if (adminDenied) return adminDenied;
    }
    if (hasOwn(body, "repos")) {
      return c.json({ error: "repositories can only be changed through the workspace repository API" }, 400);
    }
    return c.json(store.updateWorkspace(c.req.param("id"), body));
  });
  app.patch("/api/workspaces/:id", async (c) => {
    const denied = denyCurrentUserWorkspaceAccess(c, store, c.req.param("id"));
    if (denied) return denied;
    const body = await readJson<Partial<CreateWorkspaceInput>>(c);
    if (hasOwn(body, "settings")) {
      const adminDenied = requireWorkspaceAdmin(c, store, c.req.param("id"));
      if (adminDenied) return adminDenied;
    }
    if (hasOwn(body, "repos")) {
      return c.json({ error: "repositories can only be changed through the workspace repository API" }, 400);
    }
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
  app.get("/api/workspaces/:id/repository-wikis", async (c) => {
    const workspaceId = c.req.param("id");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    try {
      const repositories = listWorkspaceRepositories(store, workspaceId);
      const docs = await deps.repositoryWiki.listWorkspace(workspaceId);
      const docsByRepository = new Map<string, MultiremiRepositoryWikiDoc[]>();
      for (const doc of docs) {
        const current = docsByRepository.get(doc.repositoryId) ?? [];
        current.push(doc);
        docsByRepository.set(doc.repositoryId, current);
      }
      return c.json({ repositories: repositories.map((repository) => {
        const repositoryDocs = docsByRepository.get(repository.id) ?? [];
        const latest = repositoryDocs.reduce<MultiremiRepositoryWikiDoc | null>(
          (value, doc) => !value || doc.updatedAt > value.updatedAt ? doc : value,
          null,
        );
        return {
          repository_id: repository.id,
          repository_name: repository.name,
          status: latest?.status ?? "unbuilt",
          status_message: latest?.statusMessage ?? null,
          source_revision: latest?.sourceRevision ?? null,
          page_count: repositoryDocs.length,
          updated_at: latest?.updatedAt ?? null,
        };
      }) });
    } catch (error) {
      return repositoryWikiError(c, error);
    }
  });
  app.get("/api/workspaces/:id/repository-wikis/atlas", (c) => {
    const workspaceId = c.req.param("id");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    if (!store.getWorkspace(workspaceId)) return c.json({ error: "workspace not found" }, 404);
    return c.json(atlasSetupStatus(store, workspaceId));
  });
  app.post("/api/workspaces/:id/repository-wikis/atlas", async (c) => {
    const workspaceId = c.req.param("id");
    const denied = requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    if (!store.getWorkspace(workspaceId)) return c.json({ error: "workspace not found" }, 404);
    const plugin = store.listAgentPlugins(workspaceId, { provider: "claude" })
      .find((candidate) => candidate.name === "code-to-wiki");
    if (!plugin) {
      return c.json({
        ...atlasSetupStatus(store, workspaceId),
        error: "code-to-wiki plugin must be imported before Atlas can be configured",
        code: "atlas_plugin_required",
      }, 409);
    }

    let agent = store.getAgentByWorkspaceAndName(workspaceId, ATLAS_AGENT_NAME);
    if (!agent) {
      const created = await createAgentFromTemplate(store, {
        templateSlug: "atlas-llm-wiki",
        name: ATLAS_AGENT_NAME,
        workspaceId,
        ownerId: authenticatedRequestUserId(c) ?? "local",
        visibility: "workspace",
      });
      agent = created.agent;
    } else {
      const template = getAgentTemplate("atlas-llm-wiki")!;
      agent = store.updateAgent(agent.id, {
        description: template.description,
        instructions: template.instructions,
        provider: template.recommendedProvider,
        model: template.recommendedModel,
        visibility: "workspace",
      });
      const bindings = store.listAgentPluginBindings(agent.id);
      const existingBinding = bindings.find((binding) => binding.pluginId === plugin.id);
      if (existingBinding && !existingBinding.enabled) {
        store.updateAgentPluginBinding(agent.id, existingBinding.id, {
          enabled: true,
          versionPolicy: "follow_active",
        });
      } else if (!existingBinding) {
        store.createAgentPluginBinding(agent.id, {
          pluginId: plugin.id,
          versionPolicy: "follow_active",
          enabled: true,
        });
      }
    }

    const createdById = authenticatedRequestUserId(c) ?? "local";
    const projectAutopilot = ensureAtlasAutopilot(store, {
      workspaceId,
      agentId: agent.id,
      title: ATLAS_PROJECT_AUTOPILOT_TITLE,
      description: "When an Issue is completed, inspect its sessions and code evidence, then maintain durable Project Wiki and Memory with the remi CLI.",
      executionMode: "trigger_issue",
      createdById,
    });
    ensureAtlasTrigger(store, projectAutopilot.id, "system_event", {
      resource: "issue",
      event: "status_changed",
      conditions: [{ field: "status", operator: "becomes", value: "done" }],
    });

    const repositoryAutopilot = ensureAtlasAutopilot(store, {
      workspaceId,
      agentId: agent.id,
      title: ATLAS_REPOSITORY_AUTOPILOT_TITLE,
      description: "Use the canonical SCM event, checked-out target repository, and existing Repo Wiki to perform an incremental repository Wiki update with the remi CLI.",
      executionMode: "run_only",
      createdById,
    });
    let scmWarning: string | null = null;
    try {
      ensureAtlasTrigger(store, repositoryAutopilot.id, "scm_event", {
        resource: "scm",
        events: ["change.merged", "default_branch.updated"],
      });
    } catch (error) {
      scmWarning = error instanceof Error ? error.message : String(error);
    }
    deps.scheduler?.sync();
    return c.json({ ...atlasSetupStatus(store, workspaceId), scm_warning: scmWarning });
  });
  app.get("/api/workspaces/:id/repos/:repositoryId/wiki", async (c) => {
    const workspaceId = c.req.param("id");
    const repositoryId = c.req.param("repositoryId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const missing = requireWorkspaceRepository(store, workspaceId, repositoryId);
    if (missing) return c.json({ error: "repository not found" }, 404);
    try {
      const query = String(c.req.query("q") ?? "").trim();
      const docs = query
        ? await deps.repositoryWiki.search(workspaceId, repositoryId, query, Number(c.req.query("limit") ?? 20))
        : await deps.repositoryWiki.list(workspaceId, repositoryId);
      return c.json({ docs: docs.map(repositoryWikiDocResponse) });
    } catch (error) {
      return repositoryWikiError(c, error);
    }
  });
  app.post("/api/workspaces/:id/repos/:repositoryId/wiki", async (c) => {
    const workspaceId = c.req.param("id");
    const repositoryId = c.req.param("repositoryId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const missing = requireWorkspaceRepository(store, workspaceId, repositoryId);
    if (missing) return c.json({ error: "repository not found" }, 404);
    const body = await readJsonStrict<CreateRepositoryWikiDocInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const doc = await deps.repositoryWiki.create(workspaceId, repositoryId, {
        ...body,
        authorType: body.authorType ?? body.author_type ?? "member",
        authorId: body.authorId ?? body.author_id ?? authenticatedRequestUserId(c),
      });
      return c.json({ doc: repositoryWikiDocResponse(doc) }, 201);
    } catch (error) {
      return repositoryWikiError(c, error);
    }
  });
  app.post("/api/workspaces/:id/repos/:repositoryId/wiki/build", (c) => {
    const workspaceId = c.req.param("id");
    const repositoryId = c.req.param("repositoryId");
    const denied = requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    if (requireWorkspaceRepository(store, workspaceId, repositoryId)) {
      return c.json({ error: "repository not found" }, 404);
    }
    const setup = atlasSetupStatus(store, workspaceId);
    const autopilotId = typeof setup.repository_autopilot_id === "string"
      ? setup.repository_autopilot_id
      : null;
    if (!setup.configured || !autopilotId) {
      return c.json({ error: "Atlas must be configured before building a repository Wiki", code: "atlas_not_configured" }, 409);
    }
    const run = store.runAutopilot(autopilotId, {
      source: "api",
      prompt: "Bootstrap or refresh the target repository LLM Wiki from its checked-out default branch. Use the code-to-wiki plugin for analysis, preserve durable repository facts, resolve the checked-out HEAD revision, and publish changes with remi wiki push --source-revision <sha>.",
      payload: { atlas_repository_id: repositoryId, atlas_mode: "bootstrap_repository" },
    });
    return c.json({ run_id: run.id, task_id: run.taskId, status: run.status }, 202);
  });
  app.get("/api/workspaces/:id/repos/:repositoryId/wiki/:ref", async (c) => {
    const workspaceId = c.req.param("id");
    const repositoryId = c.req.param("repositoryId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    if (requireWorkspaceRepository(store, workspaceId, repositoryId)) return c.json({ error: "repository not found" }, 404);
    try {
      const doc = await deps.repositoryWiki.get(workspaceId, repositoryId, c.req.param("ref"));
      return doc ? c.json({ doc: repositoryWikiDocResponse(doc) }) : c.json({ error: "repository wiki doc not found" }, 404);
    } catch (error) {
      return repositoryWikiError(c, error);
    }
  });
  app.put("/api/workspaces/:id/repos/:repositoryId/wiki/:ref", async (c) => {
    const workspaceId = c.req.param("id");
    const repositoryId = c.req.param("repositoryId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    if (requireWorkspaceRepository(store, workspaceId, repositoryId)) return c.json({ error: "repository not found" }, 404);
    const body = await readJsonStrict<UpdateRepositoryWikiDocInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const doc = await deps.repositoryWiki.update(workspaceId, repositoryId, c.req.param("ref"), {
        ...body,
        updatedByType: body.updatedByType ?? body.updated_by_type ?? "member",
        updatedById: body.updatedById ?? body.updated_by_id ?? authenticatedRequestUserId(c),
      });
      return c.json({ doc: repositoryWikiDocResponse(doc) });
    } catch (error) {
      return repositoryWikiError(c, error);
    }
  });
  app.delete("/api/workspaces/:id/repos/:repositoryId/wiki/:ref", async (c) => {
    const workspaceId = c.req.param("id");
    const repositoryId = c.req.param("repositoryId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    if (requireWorkspaceRepository(store, workspaceId, repositoryId)) return c.json({ error: "repository not found" }, 404);
    try {
      const expectedVersion = c.req.query("expected_version");
      const doc = await deps.repositoryWiki.delete(
        workspaceId,
        repositoryId,
        c.req.param("ref"),
        expectedVersion ? Number(expectedVersion) : null,
      );
      return c.json({ doc: repositoryWikiDocResponse(doc) });
    } catch (error) {
      return repositoryWikiError(c, error);
    }
  });
  app.get("/api/workspaces/:id/repos/:repositoryId/wiki/:ref/revisions", async (c) => {
    const workspaceId = c.req.param("id");
    const repositoryId = c.req.param("repositoryId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    try {
      const revisions = await deps.repositoryWiki.revisions(workspaceId, repositoryId, c.req.param("ref"));
      return c.json({ revisions: revisions.map(repositoryWikiRevisionResponse) });
    } catch (error) {
      return repositoryWikiError(c, error);
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

function atlasSetupStatus(store: RouterDeps["store"], workspaceId: string): Record<string, unknown> {
  const agent = store.getAgentByWorkspaceAndName(workspaceId, ATLAS_AGENT_NAME);
  const plugin = store.listAgentPlugins(workspaceId, { provider: "claude" })
    .find((candidate) => candidate.name === "code-to-wiki") ?? null;
  const pluginBinding = agent && plugin
    ? store.listAgentPluginBindings(agent.id).find((binding) => binding.pluginId === plugin.id && binding.enabled) ?? null
    : null;
  const autopilots = agent
    ? store.listAutopilots(workspaceId).filter((autopilot) => autopilot.assigneeType === "agent" && autopilot.assigneeId === agent.id)
    : [];
  const projectAutopilot = autopilots.find((autopilot) => autopilot.title === ATLAS_PROJECT_AUTOPILOT_TITLE) ?? null;
  const repositoryAutopilot = autopilots.find((autopilot) => autopilot.title === ATLAS_REPOSITORY_AUTOPILOT_TITLE) ?? null;
  const projectTrigger = projectAutopilot
    ? store.listAutopilotTriggers(projectAutopilot.id).find((trigger) => trigger.kind === "system_event" && trigger.enabled) ?? null
    : null;
  const repositoryTrigger = repositoryAutopilot
    ? store.listAutopilotTriggers(repositoryAutopilot.id).find((trigger) => trigger.kind === "scm_event" && trigger.enabled) ?? null
    : null;
  const configured = Boolean(agent && pluginBinding && projectTrigger && repositoryTrigger);
  const state = !plugin
    ? "plugin_required"
    : !agent
      ? "not_configured"
      : !repositoryTrigger
        ? "scm_connection_required"
        : !projectTrigger || !pluginBinding
          ? "incomplete"
          : "ready";
  return {
    state,
    configured,
    required_plugin: "code-to-wiki",
    plugin_id: plugin?.id ?? null,
    plugin_bound: Boolean(pluginBinding),
    agent_id: agent?.id ?? null,
    repository_autopilot_id: repositoryAutopilot?.id ?? null,
    repository_trigger_id: repositoryTrigger?.id ?? null,
    project_autopilot_id: projectAutopilot?.id ?? null,
    project_trigger_id: projectTrigger?.id ?? null,
  };
}

function ensureAtlasAutopilot(
  store: RouterDeps["store"],
  input: {
    workspaceId: string;
    agentId: string;
    title: string;
    description: string;
    executionMode: MultiremiAutopilotExecutionMode;
    createdById: string;
  },
): MultiremiAutopilot {
  const existing = store.listAutopilots(input.workspaceId).find((autopilot) => autopilot.title === input.title);
  if (existing) {
    return store.updateAutopilot(existing.id, {
      description: input.description,
      assigneeType: "agent",
      assigneeId: input.agentId,
      status: "active",
      executionMode: input.executionMode,
      sessionPolicy: "new",
    });
  }
  return store.createAutopilot({
    title: input.title,
    description: input.description,
    workspaceId: input.workspaceId,
    assigneeType: "agent",
    assigneeId: input.agentId,
    executionMode: input.executionMode,
    sessionPolicy: "new",
    status: "active",
    createdByType: "member",
    createdById: input.createdById,
  });
}

function ensureAtlasTrigger(
  store: RouterDeps["store"],
  autopilotId: string,
  kind: MultiremiAutopilotTriggerKind,
  eventConfig: MultiremiAutopilotEventConfig,
): void {
  const existing = store.listAutopilotTriggers(autopilotId).find((trigger) => trigger.kind === kind);
  if (existing) {
    store.updateAutopilotTrigger(autopilotId, existing.id, { enabled: true, eventConfig });
    return;
  }
  store.createAutopilotTrigger(autopilotId, { kind, enabled: true, eventConfig });
}

function hasOwn(value: unknown, key: string): boolean {
  return typeof value === "object" && value !== null && Object.prototype.hasOwnProperty.call(value, key);
}

function requireWorkspaceRepository(store: RouterDeps["store"], workspaceId: string, repositoryId: string): boolean {
  return !listWorkspaceRepositories(store, workspaceId).some((repository) => repository.id === repositoryId);
}

function repositoryWikiDocResponse(doc: MultiremiRepositoryWikiDoc): Record<string, unknown> {
  return {
    id: doc.id,
    repository_id: doc.repositoryId,
    workspace_id: doc.workspaceId,
    path: doc.path,
    slug: doc.slug,
    title: doc.title,
    summary: doc.summary,
    body: doc.body,
    tags: doc.tags,
    refs: doc.refs,
    source_task_id: doc.sourceTaskId,
    source_issue_id: doc.sourceIssueId,
    author_type: doc.authorType,
    author_id: doc.authorId,
    updated_by_type: doc.updatedByType,
    updated_by_id: doc.updatedById,
    source_revision: doc.sourceRevision,
    status: doc.status,
    status_message: doc.statusMessage,
    version: doc.version,
    storage_backend: doc.storageBackend,
    content_uri: doc.contentUri,
    content_sha256: doc.contentSha256,
    sync_status: doc.syncStatus,
    sync_error: doc.syncError,
    snapshot_oid: doc.snapshotOid,
    created_at: doc.createdAt,
    updated_at: doc.updatedAt,
  };
}

function repositoryWikiRevisionResponse(revision: MultiremiRepositoryWikiDocRevision): Record<string, unknown> {
  return {
    id: revision.id,
    doc_id: revision.docId,
    version: revision.version,
    path: revision.path,
    title: revision.title,
    summary: revision.summary,
    body: revision.body,
    source_revision: revision.sourceRevision,
    author_type: revision.authorType,
    author_id: revision.authorId,
    content_uri: revision.contentUri,
    content_sha256: revision.contentSha256,
    snapshot_oid: revision.snapshotOid,
    created_at: revision.createdAt,
  };
}

function repositoryWikiError(c: Context, error: unknown): Response {
  const message = error instanceof Error ? error.message : "repository wiki request failed";
  if (error instanceof RepositoryWikiUnavailableError) return c.json({ error: message }, 503);
  if (message.includes("not found")) return c.json({ error: message }, 404);
  if (message.includes("conflict") || message.includes("already exists")) return c.json({ error: message }, 409);
  return c.json({ error: message }, 400);
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
