import type { Context, Hono } from "hono";
import {
  backfillWorkspaceRepositoryDefaultBranches,
  createScmAwareGitRemoteInspector,
  currentTaskParentId,
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
  MultiremiBotMenuPublishRequest,
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
import { sanitizeWorkspaceProgressSummarySettings } from "@daemon/agent-runtime/workspace/progress-summary-policy.js";
import { sanitizeIssueAutoTitleSettings } from "@multiremi/issue-title/settings.js";
import {
  BotMenuConfigError,
  parseBotMenuConfig,
  readWorkspaceBotMenu,
  resolveBotMenuConfig,
} from "../../bot-menu/config.js";
import {
  autopilotRunSourceRevision,
  repositoryWikiBuildDedupeKey,
  type MultiremiAutopilotRunRecord,
} from "@multiremi/store/repos/autopilots-repo.js";
import { resolveRepositoryWikiAutomation } from "@multiremi/repository-wiki/automation.js";

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
  app.get("/api/workspaces/:id/bot-menu", (c) => {
    const workspaceId = c.req.param("id");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) return c.json({ error: "workspace not found" }, 404);
    try {
      return c.json({ workspace_id: workspaceId, bot_menu: readWorkspaceBotMenu(workspace.settings) });
    } catch (error) {
      return botMenuError(c, error);
    }
  });
  app.put("/api/workspaces/:id/bot-menu", async (c) => {
    const workspaceId = c.req.param("id");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId)
      ?? requireHumanWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) return c.json({ error: "workspace not found" }, 404);
    const body = await readJsonStrict<{ bot_menu?: unknown }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const botMenu = parseBotMenuConfig(body.bot_menu);
      const updated = store.updateWorkspace(workspaceId, {
        settings: { ...workspace.settings, botMenu },
      });
      publishWorkspaceEvent(c, store, "workspace:updated", workspaceId, { workspace: updated });
      return c.json({ workspace_id: workspaceId, bot_menu: botMenu });
    } catch (error) {
      return botMenuError(c, error);
    }
  });
  app.post("/api/workspaces/:id/bot-menu/publish", async (c) => {
    const workspaceId = c.req.param("id");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId)
      ?? requireHumanWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) return c.json({ error: "workspace not found" }, 404);
    const body = await readJsonStrict<{ dry_run?: unknown }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    if (typeof body.dry_run !== "boolean") {
      return c.json({ error: "dry_run must be explicitly true or false" }, 400);
    }
    try {
      const botMenu = readWorkspaceBotMenu(workspace.settings);
      const resolved = resolveBotMenuConfig(
        botMenu,
        workspaceId,
        store.listWorkspaceMembers(workspaceId),
        (userId) => store.getUser(userId),
      );
      const publishers = store.listRuntimes()
        .filter((entry) =>
          entry.workspaceId === workspaceId
          && entry.status === "online"
          && entry.metadata.feishu_bot_menu === true
        )
        .sort((a, b) => String(b.lastHeartbeatAt ?? "").localeCompare(String(a.lastHeartbeatAt ?? "")));
      // Publish to the Runtime that actually hosts the concierge (MUL-206).
      // Any Runtime with the capability can talk to Feishu, but only the
      // hosting one holds this workspace's app credentials — publishing from
      // another would push this workspace's menu onto whatever bot that
      // machine happens to run. So once a concierge is configured its Runtime
      // is the only valid target; a workspace still on the legacy env-driven
      // bot has no config row and keeps the "newest capable Runtime" pick.
      const conciergeRuntimeId = store.getFeishuBotConfig(workspaceId)?.runtimeId ?? null;
      const runtime = conciergeRuntimeId
        ? publishers.find((entry) => entry.id === conciergeRuntimeId)
        : publishers[0];
      if (!runtime) {
        return c.json({
          error: conciergeRuntimeId
            ? "the Runtime hosting the Feishu concierge is not online"
            : "no online Feishu bot menu publisher is available",
        }, 503);
      }
      const request = store.createBotMenuPublishRequest(runtime.id, {
        workspaceId,
        config: resolved,
        dryRun: body.dry_run,
        createdBy: currentRequestUserId(c),
      });
      return c.json(botMenuPublishResponse(request), 202);
    } catch (error) {
      return botMenuError(c, error);
    }
  });
  app.get("/api/workspaces/:id/bot-menu/publish/:requestId", (c) => {
    const workspaceId = c.req.param("id");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId)
      ?? requireHumanWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    const request = store.findBotMenuPublishRequest(workspaceId, c.req.param("requestId"));
    if (!request) return c.json({ error: "bot menu publish request not found" }, 404);
    return c.json(botMenuPublishResponse(request));
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
    const automation = resolveRepositoryWikiAutomation(store, workspaceId);
    if (!automation) {
      return c.json({
        error: "An active SCM automation assigned to a maintainer with the code-to-wiki plugin is required",
        code: "repository_wiki_automation_required",
      }, 409);
    }
    const run = store.runAutopilot(automation.id, {
      source: "api",
      prompt: "Bootstrap or refresh the target repository LLM Wiki from its checked-out default branch. Use the code-to-wiki plugin for analysis, preserve durable repository facts, resolve the checked-out HEAD revision, publish changes with remi wiki push --source-revision <sha>, then run remi wiki lint --output json and resolve supported findings.",
      payload: { repository_wiki_repository_id: repositoryId, repository_wiki_mode: "bootstrap_repository" },
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

function botMenuPublishResponse(request: MultiremiBotMenuPublishRequest): Record<string, unknown> {
  return {
    id: request.id,
    workspace_id: request.workspaceId,
    dry_run: request.dryRun,
    status: request.status,
    result: request.result,
    error: request.error,
    created_at: request.createdAt,
    updated_at: request.updatedAt,
  };
}

function botMenuError(c: Context, error: unknown): Response {
  if (error instanceof BotMenuConfigError) {
    return c.json({ error: error.message, code: error.code }, 400);
  }
  const message = error instanceof Error ? error.message : "bot menu operation failed";
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
