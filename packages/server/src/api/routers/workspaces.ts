import type { Context, Hono } from "hono";
import {
  backfillWorkspaceRepositoryDefaultBranches,
  createScmAwareGitRemoteInspector,
  currentTaskParentId,
  currentTaskIssueCreationRestricted,
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
  readOrganizerMode,
  removeWorkspaceRepository,
  organizerSettings,
  parseOrganizerMode,
  requireHumanWorkspaceAdmin,
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
  CreateWorkspaceRuntimeProvisionInput,
  CreateWorkspaceInput,
  MultiremiAutopilot,
  MultiremiAutopilotEventConfig,
  MultiremiAutopilotExecutionMode,
  MultiremiAutopilotTriggerKind,
  MultiremiRepositoryWikiDoc,
  MultiremiRepositoryWikiDocRevision,
  UpdateRepositoryWikiDocInput,
  UpdateMultiremiPromptSettingsInput,
  UpdateWorkspaceRuntimeProvisionInput,
} from "@multiremi/contracts/types.js";
import { nowIso } from "@multiremi/ids.js";
import { RepositoryWikiUnavailableError } from "@multiremi/repository-wiki/service.js";
import {
  mergeWorkspacePromptSettings,
  readWorkspacePromptSettings,
  WorkspacePromptRevisionConflictError,
} from "../../prompts/workspace-settings.js";
import { buildPlatformPromptTemplatePreview } from "../../prompts/platform-template.js";
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
import { sanitizeWorkspaceProgressSummarySettings } from "@daemon/agent-runtime/workspace/progress-summary-policy.js";
import { sanitizeIssueAutoTitleSettings } from "@multiremi/issue-title/settings.js";
import { agentRoleAtLeast } from "@multiremi/store/agent-role.js";
import {
  autopilotRunSourceRevision,
  repositoryWikiBuildDedupeKey,
  type MultiremiAutopilotRunRecord,
} from "@multiremi/store/repos/autopilots-repo.js";
import {
  ATLAS_AGENT_NAME,
  ATLAS_PROJECT_AUTOPILOT_KIND,
  ATLAS_PROJECT_AUTOPILOT_TITLE,
  ATLAS_REPOSITORY_WIKI_AUTOPILOT_KIND,
  ATLAS_REPOSITORY_WIKI_AUTOPILOT_TITLE,
  resolveAtlasRepositoryWikiAutopilot,
} from "@multiremi/repository-wiki/atlas.js";

export function registerWorkspaceRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;

  app.get("/api/workspaces", (c) => {
    const userId = authenticatedRequestUserId(c);
    const token = currentAccessToken(c);
    const all = store.listWorkspaces().filter((workspace) =>
      token?.type !== "task" || workspace.id === token.workspaceId
    );
    // Master token / open mode (no identity) is admin and sees everything;
    // a logged-in user sees only the workspaces they are a member of.
    if (!userId) return c.json(all);
    return c.json(all.filter((ws) => store.getUserRoleInWorkspace(userId, ws.id) !== null));
  });
  app.post("/api/workspaces", async (c) => {
    const body = sanitizeWorkspaceSettingsInput(await readJson<any>(c));
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
  app.get("/api/workspaces/:id/runtime-provisions", (c) => {
    const workspaceId = c.req.param("id");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    return c.json({ provisions: store.listWorkspaceRuntimeProvisions(workspaceId).map(runtimeProvisionResponse) });
  });
  app.post("/api/workspaces/:id/runtime-provisions", async (c) => {
    const workspaceId = c.req.param("id");
    const denied = requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<CreateWorkspaceRuntimeProvisionInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const provision = store.createWorkspaceRuntimeProvision(workspaceId, {
        ...body,
        createdBy: authenticatedRequestUserId(c) ?? "local",
      });
      return c.json({ provision: runtimeProvisionResponse(provision) }, 201);
    } catch (error) {
      return runtimeProvisionError(c, error);
    }
  });
  app.get("/api/workspaces/:id/runtime-provisions/:provisionId", (c) => {
    const workspaceId = c.req.param("id");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const provision = store.getWorkspaceRuntimeProvision(c.req.param("provisionId"));
    if (!provision || provision.workspaceId !== workspaceId) return c.json({ error: "runtime provision not found" }, 404);
    return c.json({ provision: runtimeProvisionResponse(provision) });
  });
  app.patch("/api/workspaces/:id/runtime-provisions/:provisionId", async (c) => {
    const workspaceId = c.req.param("id");
    const denied = requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    const provision = store.getWorkspaceRuntimeProvision(c.req.param("provisionId"));
    if (!provision || provision.workspaceId !== workspaceId) return c.json({ error: "runtime provision not found" }, 404);
    const body = await readJsonStrict<UpdateWorkspaceRuntimeProvisionInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      return c.json({ provision: runtimeProvisionResponse(store.updateWorkspaceRuntimeProvision(provision.id, {
        ...body,
        createdBy: authenticatedRequestUserId(c) ?? "local",
      })) });
    } catch (error) {
      return runtimeProvisionError(c, error);
    }
  });
  app.delete("/api/workspaces/:id/runtime-provisions/:provisionId", (c) => {
    const workspaceId = c.req.param("id");
    const denied = requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    const provision = store.getWorkspaceRuntimeProvision(c.req.param("provisionId"));
    if (!provision || provision.workspaceId !== workspaceId) return c.json({ error: "runtime provision not found" }, 404);
    store.deleteWorkspaceRuntimeProvision(provision.id, authenticatedRequestUserId(c) ?? "local");
    return c.json({ deleted: true, id: provision.id });
  });
  app.get("/api/workspaces/:id/runtime-provisions/:provisionId/states", (c) => {
    const workspaceId = c.req.param("id");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const provision = store.getWorkspaceRuntimeProvision(c.req.param("provisionId"));
    if (!provision || provision.workspaceId !== workspaceId) return c.json({ error: "runtime provision not found" }, 404);
    return c.json({ states: store.listRuntimeProvisionStates(provision.id).map(runtimeProvisionStateResponse) });
  });
  app.get("/api/workspaces/:id/organizer", (c) => {
    const workspaceId = c.req.param("id");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) return c.json({ error: "workspace not found" }, 404);
    return c.json({ workspace_id: workspaceId, mode: readOrganizerMode(workspace) });
  });
  app.put("/api/workspaces/:id/organizer", async (c) => {
    const workspaceId = c.req.param("id");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId)
      ?? requireHumanWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) return c.json({ error: "workspace not found" }, 404);
    const body = await readJsonStrict<{ mode?: unknown }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const mode = parseOrganizerMode(body.mode);
    if (!mode) return c.json({ error: "mode must be report_only or act", code: "organizer_mode_invalid" }, 400);
    store.updateWorkspace(workspaceId, { settings: organizerSettings(workspace, mode) });
    return c.json({ workspace_id: workspaceId, mode });
  });
  app.get("/api/workspaces/:id/prompts", (c) => {
    const workspaceId = c.req.param("id");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) return c.json({ error: "workspace not found" }, 404);
    return c.json(readWorkspacePromptSettings(workspace));
  });
  app.get("/api/workspaces/:id/prompt-template", (c) => {
    const workspaceId = c.req.param("id");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) return c.json({ error: "workspace not found" }, 404);
    return c.json(buildPlatformPromptTemplatePreview());
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
    const denied = denyCurrentUserWorkspaceAccess(c, store, c.req.param("id"))
      ?? requireWorkspaceAdmin(c, store, c.req.param("id"));
    if (denied) return denied;
    const body = sanitizeWorkspaceSettingsInput(
      await readJson<Partial<CreateWorkspaceInput>>(c),
    );
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
    const denied = denyCurrentUserWorkspaceAccess(c, store, c.req.param("id"))
      ?? requireWorkspaceAdmin(c, store, c.req.param("id"));
    if (denied) return denied;
    const body = sanitizeWorkspaceSettingsInput(
      await readJson<Partial<CreateWorkspaceInput>>(c),
    );
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
        createScmAwareGitRemoteInspector(store, workspaceId, deps.inspectGitRemoteRepository),
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
      const buildRuns = new Map(
        store.listLatestRepositoryAutopilotRuns(workspaceId)
          .map((run) => [run.repositoryId!, run] as const),
      );
      return c.json({ repositories: repositories.map((repository) => {
        const repositoryDocs = docsByRepository.get(repository.id) ?? [];
        const latest = repositoryDocs.reduce<MultiremiRepositoryWikiDoc | null>(
          (value, doc) => !value || doc.updatedAt > value.updatedAt ? doc : value,
          null,
        );
        const build = repositoryWikiBuildState(store, buildRuns.get(repository.id) ?? null);
        // An active build overrides the doc-derived status ("building"), and a
        // failed last build surfaces as "failed" — the docs themselves are
        // untouched and keep being listed either way.
        const status = build.status === "queued" || build.status === "building"
          ? "building"
          : build.status === "failed"
            ? "failed"
            : latest?.status ?? "unbuilt";
        return {
          repository_id: repository.id,
          repository_name: repository.name,
          status,
          status_message: latest?.statusMessage ?? null,
          source_revision: latest?.sourceRevision ?? null,
          page_count: repositoryDocs.length,
          updated_at: latest?.updatedAt ?? null,
          build,
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
    const denied = requireHumanWorkspaceAdmin(c, store, workspaceId);
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

    const existingManagedAutopilot = store.listAutopilots(workspaceId).find((autopilot) =>
      autopilot.managedKind === ATLAS_REPOSITORY_WIKI_AUTOPILOT_KIND
      || autopilot.managedKind === ATLAS_PROJECT_AUTOPILOT_KIND
    );
    const managedAssignee = existingManagedAutopilot?.assigneeType === "agent"
      ? store.getAgent(existingManagedAutopilot.assigneeId)
      : null;
    let agent = managedAssignee?.workspaceId === workspaceId ? managedAssignee : null;
    agent ??= store.listAgents().find((candidate) =>
      candidate.workspaceId === workspaceId
      && agentRoleAtLeast(candidate.role, "maintainer")
      && store.listAgentPluginBindings(candidate.id).some((binding) =>
        binding.pluginId === plugin.id && binding.enabled
      )
    ) ?? null;
    if (!agent) {
      const created = await createAgentFromTemplate(store, {
        templateSlug: "atlas-llm-wiki",
        name: availableAtlasAgentName(store, workspaceId),
        workspaceId,
        ownerId: authenticatedRequestUserId(c) ?? "local",
        visibility: "workspace",
        role: "maintainer",
        issueCreationRequiresProposal: currentTaskIssueCreationRestricted(c, store),
      });
      agent = created.agent;
    } else {
      if (agent.role === "normal") agent = store.setAgentRole(agent.id, "maintainer");
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
      managedKind: ATLAS_PROJECT_AUTOPILOT_KIND,
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
      title: ATLAS_REPOSITORY_WIKI_AUTOPILOT_TITLE,
      managedKind: ATLAS_REPOSITORY_WIKI_AUTOPILOT_KIND,
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
      repositoryId,
      dedupeKey: repositoryWikiBuildDedupeKey(repositoryId, "bootstrap_repository", null),
      sourceTaskId: currentTaskParentId(c),
    });
    if (run.deduplicated) {
      return c.json({
        error: "A repository Wiki build is already in progress for this repository",
        code: "repository_wiki_build_in_progress",
        run_id: run.id,
        task_id: run.taskId,
      }, 409);
    }
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
        createScmAwareGitRemoteInspector(store, workspaceId, deps.inspectGitRemoteRepository),
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
        createScmAwareGitRemoteInspector(store, workspaceId, deps.inspectGitRemoteRepository),
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
        createScmAwareGitRemoteInspector(store, workspaceId, deps.inspectGitRemoteRepository),
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
    if (actorToken?.type === "task") {
      return c.json({
        error: "forbidden for task token",
        code: "task_token_hard_denied",
      }, 403);
    }
    if (actorToken?.type === "daemon") {
      return c.json({
        error: "forbidden for daemon token",
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

function availableAtlasAgentName(store: RouterDeps["store"], workspaceId: string): string {
  if (!store.getAgentByWorkspaceAndName(workspaceId, ATLAS_AGENT_NAME)) return ATLAS_AGENT_NAME;
  for (let suffix = 2; suffix < 10_000; suffix++) {
    const candidate = `${ATLAS_AGENT_NAME} ${suffix}`;
    if (!store.getAgentByWorkspaceAndName(workspaceId, candidate)) return candidate;
  }
  throw new Error("unable to allocate an Atlas display name");
}

function atlasSetupStatus(store: RouterDeps["store"], workspaceId: string): Record<string, unknown> {
  const allAutopilots = store.listAutopilots(workspaceId);
  const projectAutopilot = allAutopilots.find((autopilot) =>
    autopilot.managedKind === ATLAS_PROJECT_AUTOPILOT_KIND
  ) ?? null;
  const repositoryAutopilot = resolveAtlasRepositoryWikiAutopilot(
    workspaceId,
    store.listAgents(),
    allAutopilots,
  );
  const managedAutopilot = repositoryAutopilot ?? projectAutopilot;
  const agent = managedAutopilot?.assigneeType === "agent"
    ? store.getAgent(managedAutopilot.assigneeId)
    : null;
  const plugin = store.listAgentPlugins(workspaceId, { provider: "claude" })
    .find((candidate) => candidate.name === "code-to-wiki") ?? null;
  const pluginBinding = agent && plugin
    ? store.listAgentPluginBindings(agent.id).find((binding) => binding.pluginId === plugin.id && binding.enabled) ?? null
    : null;
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
    managedKind: NonNullable<MultiremiAutopilot["managedKind"]>;
    createdById: string;
  },
): MultiremiAutopilot {
  const existing = store.listAutopilots(input.workspaceId).find((autopilot) =>
    autopilot.managedKind === input.managedKind
  );
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
  const created = store.createAutopilot({
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
  return store.setAutopilotManagedKind(created.id, input.managedKind);
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

function sanitizeWorkspaceSettingsInput<T extends Partial<CreateWorkspaceInput>>(body: T): T {
  const settings = body.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return body;
  return {
    ...body,
    settings: sanitizeIssueAutoTitleSettings(sanitizeWorkspaceProgressSummarySettings(settings)),
  };
}

function requireWorkspaceRepository(store: RouterDeps["store"], workspaceId: string, repositoryId: string): boolean {
  return !listWorkspaceRepositories(store, workspaceId).some((repository) => repository.id === repositoryId);
}

interface RepositoryWikiBuildState {
  status: "idle" | "queued" | "building" | "failed";
  run_id: string | null;
  task_id: string | null;
  failure_reason: string | null;
  started_at: string | null;
  updated_at: string | null;
  source_revision: string | null;
  published: boolean | null;
}

/**
 * Server-derived build state for a repository Wiki, from the latest
 * repository-scoped autopilot run and its task: queued until the daemon
 * starts the task, building while it executes, failed when the run failed,
 * idle otherwise (no build yet, completed, or skipped).
 */
function repositoryWikiBuildState(
  store: RouterDeps["store"],
  run: MultiremiAutopilotRunRecord | null,
): RepositoryWikiBuildState {
  if (!run) {
    return {
      status: "idle",
      run_id: null,
      task_id: null,
      failure_reason: null,
      started_at: null,
      updated_at: null,
      source_revision: null,
      published: null,
    };
  }
  const task = run.taskId ? store.getTask(run.taskId) : null;
  const status: RepositoryWikiBuildState["status"] = run.status === "failed"
    ? "failed"
    : run.status === "running" || run.status === "issue_created"
      ? !task || task.status === "queued" || task.status === "dispatched" ? "queued" : "building"
      : "idle";
  return {
    status,
    run_id: run.id,
    task_id: run.taskId,
    failure_reason: run.status === "failed" ? run.failureReason : null,
    started_at: run.triggeredAt,
    updated_at: run.completedAt ?? task?.updatedAt ?? run.triggeredAt,
    source_revision: autopilotRunSourceRevision(run),
    published: run.status === "completed" ? store.isRepositoryWikiRunPublished(run.id) : null,
  };
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

function runtimeProvisionResponse(provision: import("@multiremi/contracts/types.js").MultiremiWorkspaceRuntimeProvision) {
  return {
    id: provision.id,
    workspace_id: provision.workspaceId,
    kind: provision.kind,
    enabled: provision.enabled,
    package: provision.package,
    version: provision.version,
    version_check: provision.versionCheck,
    bin: provision.bin,
    registry: provision.registry,
    command: provision.redactedCommand,
    args: provision.redactedArgs,
    trigger_kinds: provision.triggerKinds,
    cron_expression: provision.cronExpression,
    timezone: provision.timezone,
    next_run_at: provision.nextRunAt,
    last_fired_at: provision.lastFiredAt,
    timeout_ms: provision.timeoutMs,
    created_by: provision.createdBy,
    created_at: provision.createdAt,
    updated_at: provision.updatedAt,
  };
}

function runtimeProvisionStateResponse(state: import("@multiremi/contracts/types.js").MultiremiRuntimeProvisionState) {
  return {
    provision_id: state.provisionId,
    runtime_id: state.runtimeId,
    status: state.status,
    observed_version: state.observedVersion,
    last_command_request_id: state.lastCommandRequestId,
    last_checked_at: state.lastCheckedAt,
    last_error: state.lastError,
    created_at: state.createdAt,
    updated_at: state.updatedAt,
  };
}

function runtimeProvisionError(c: Context, error: unknown): Response {
  const message = error instanceof Error ? error.message : "runtime provision request failed";
  if (/not found/i.test(message)) return c.json({ error: message }, 404);
  return c.json({ error: message }, 400);
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
