import type { Context, Hono } from "hono";
import {
  denyCurrentUserWorkspaceAccess,
  isJsonApiError,
  readJsonStrict,
} from "../helpers.js";
import {
  currentAccessToken,
  currentRequestUserId,
  currentWorkspaceRoleStrict,
} from "../wire/index.js";
import type {
  DaemonRetirementImpact,
  DaemonRetirementPlan,
} from "@multiremi/store/repos/daemon-retirement-repo.js";
import { generateSshMeshKeyMaterial, SshMeshKeyError } from "@multiremi/ssh-mesh/keys.js";
import type { RouterDeps } from "./deps.js";

export function registerDaemonRetirementRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;

  app.get("/api/daemons/:daemonId", (c) => {
    const workspaceId = requestedWorkspaceId(c);
    const daemonId = String(c.req.param("daemonId") ?? "").trim();
    if (!daemonId) return c.json({ error: "daemon_id is required", code: "daemon_id_required" }, 400);
    const access = loadHumanWorkspaceAccess(c, deps, workspaceId);
    if (access instanceof Response) return access;
    const plan = store.getDaemonRetirementPlan(workspaceId, daemonId);
    if (!plan.exists) return c.json({ error: "daemon not found", code: "daemon_not_found" }, 404);
    const profile = store.getDaemonProfile(workspaceId, daemonId);
    const runtime = store.listRuntimes().find((candidate) => (
      (candidate.workspaceId ?? "local") === workspaceId && candidate.daemonId === daemonId
    ));
    return c.json({
      workspace_id: workspaceId,
      daemon_id: daemonId,
      display_name: profile?.displayName ?? runtime?.daemonDisplayName ?? daemonId,
      display_name_customized: profile?.displayNameCustomized ?? false,
      dedicated: profile?.dedicated ?? false,
      updated_by: profile?.updatedBy ?? null,
      updated_at: profile?.updatedAt ?? null,
      projects: store.listProjectsForDaemon(workspaceId, daemonId).map((project) => ({
        id: project.id,
        workspace_id: project.workspaceId,
        title: project.title,
        icon: project.icon,
        status: project.status,
        archived_at: project.archivedAt,
      })),
    });
  });

  app.patch("/api/daemons/:daemonId", async (c) => {
    const body = await readJsonStrict<{
      workspaceId?: string | null;
      workspace_id?: string | null;
      display_name?: unknown;
      dedicated?: unknown;
    }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const workspaceId = requestedWorkspaceId(c, body);
    const daemonId = String(c.req.param("daemonId") ?? "").trim();
    if (!daemonId) return c.json({ error: "daemon_id is required", code: "daemon_id_required" }, 400);
    const access = authorizeDaemonRetirement(c, deps, workspaceId, daemonId);
    if (access instanceof Response) return access;
    const plan = store.getDaemonRetirementPlan(workspaceId, daemonId);
    if (!plan.exists) return c.json({ error: "daemon not found", code: "daemon_not_found" }, 404);
    const writesDisplayName = Object.prototype.hasOwnProperty.call(body, "display_name");
    const writesDedicated = Object.prototype.hasOwnProperty.call(body, "dedicated");
    if (!writesDisplayName && !writesDedicated) {
      return c.json({ error: "display_name or dedicated is required" }, 400);
    }
    let profile = store.getDaemonProfile(workspaceId, daemonId);
    if (writesDisplayName) {
      const displayName = typeof body.display_name === "string" ? body.display_name.trim() : "";
      if (!displayName) return c.json({ error: "display_name must be a non-empty string" }, 400);
      if (displayName.length > 100) {
        return c.json({ error: "display_name must be at most 100 characters" }, 400);
      }
      profile = store.updateDaemonDisplayName(
        workspaceId,
        daemonId,
        displayName,
        currentRequestUserId(c),
      );
    }
    if (writesDedicated) {
      if (typeof body.dedicated !== "boolean") return c.json({ error: "dedicated must be a boolean" }, 400);
      profile = store.updateDaemonDedicated(
        workspaceId,
        daemonId,
        body.dedicated,
        currentRequestUserId(c),
      );
    }
    return c.json(daemonProfileResponse(profile!));
  });

  app.get("/api/multiremi/daemons", (c) => {
    const workspaceId = requestedWorkspaceId(c);
    const access = loadHumanWorkspaceAccess(c, deps, workspaceId);
    if (access instanceof Response) return access;
    const actorId = currentRequestUserId(c);
    const daemons = store.listDaemonInventory(workspaceId).filter((daemon) => (
      access.isManager || daemon.ownerUserId === actorId
    ));
    return c.json({
      workspace_id: workspaceId,
      daemons: daemons.map((daemon) => ({
        daemon_id: daemon.daemonId,
        owner_user_id: daemon.ownerUserId,
        runtime_count: daemon.runtimeCount,
        token_count: daemon.tokenCount,
        last_seen: daemon.lastSeen,
        name: daemon.name,
      })),
    });
  });

  app.get("/api/multiremi/daemons/:daemonId/retirement-plan", (c) => {
    const workspaceId = requestedWorkspaceId(c);
    const daemonId = String(c.req.param("daemonId") ?? "").trim();
    if (!daemonId) return c.json({ error: "daemon_id is required", code: "daemon_id_required" }, 400);
    const access = authorizeDaemonRetirement(c, deps, workspaceId, daemonId);
    if (access instanceof Response) return access;
    const plan = store.getDaemonRetirementPlan(workspaceId, daemonId);
    if (!plan.exists) return c.json({ error: "daemon not found", code: "daemon_not_found" }, 404);
    return c.json({ plan: retirementPlanResponse(plan) });
  });

  app.post("/api/multiremi/daemons/:daemonId/retire", async (c) => {
    const body = await readJsonStrict<{
      workspaceId?: string | null;
      workspace_id?: string | null;
      expectedSnapshot?: string | null;
      expected_snapshot?: string | null;
      abandonIssueWorkspaces?: boolean | null;
      abandon_issue_workspaces?: boolean | null;
    }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const workspaceId = requestedWorkspaceId(c, body);
    const daemonId = String(c.req.param("daemonId") ?? "").trim();
    if (!daemonId) return c.json({ error: "daemon_id is required", code: "daemon_id_required" }, 400);
    const access = authorizeDaemonRetirement(c, deps, workspaceId, daemonId);
    if (access instanceof Response) return access;
    const expectedSnapshot = String(body.expectedSnapshot ?? body.expected_snapshot ?? "").trim();
    if (!expectedSnapshot) {
      return c.json({ error: "expected_snapshot is required", code: "expected_snapshot_required" }, 400);
    }
    const currentPlan = store.getDaemonRetirementPlan(workspaceId, daemonId);
    if (!currentPlan.exists) return c.json({ error: "daemon not found", code: "daemon_not_found" }, 404);

    const result = store.retireDaemon(
      workspaceId,
      daemonId,
      expectedSnapshot,
      currentRequestUserId(c),
      access.requiredOwnerUserId,
      {
        abandonIssueWorkspaces:
          body.abandonIssueWorkspaces === true || body.abandon_issue_workspaces === true,
      },
    );
    if (result.status === "forbidden") {
      return c.json({ error: "daemon is owned by another user", code: "daemon_owner_required" }, 403);
    }
    if (result.status === "plan_changed") {
      return c.json({
        error: "daemon retirement plan changed; review and confirm again",
        code: "daemon_retirement_plan_changed",
        plan: retirementPlanResponse(result.plan),
      }, 409);
    }
    if (result.status === "blocked") {
      return c.json({
        error: "daemon retirement is blocked by active dependencies",
        code: "daemon_retirement_blocked",
        plan: retirementPlanResponse(result.plan),
      }, 409);
    }
    if (!result.alreadyRetired) {
      store.emitWorkspaceEvent({
        type: "daemon:retired",
        workspaceId,
        payload: {
          daemon_id: daemonId,
          runtime_ids: currentPlan.runtimes.map((runtime) => runtime.id),
          impact: retirementImpactResponse(result.impact),
          retired_at: result.retiredAt,
        },
        actorType: "member",
        actorId: currentRequestUserId(c),
      });
    }
    const sshMeshRotation = await reconcileRetirementSshMeshKey(
      store,
      workspaceId,
      daemonId,
    );
    return c.json({
      status: "retired",
      workspace_id: workspaceId,
      daemon_id: daemonId,
      retired_at: result.retiredAt,
      already_retired: result.alreadyRetired,
      impact: retirementImpactResponse(result.impact),
      ssh_mesh_key_rotation: sshMeshRotation,
    });
  });
}

function daemonProfileResponse(
  profile: NonNullable<ReturnType<RouterDeps["store"]["getDaemonProfile"]>>,
): Record<string, unknown> {
  return {
    workspace_id: profile.workspaceId,
    daemon_id: profile.daemonId,
    display_name: profile.displayName,
    display_name_customized: profile.displayNameCustomized,
    dedicated: profile.dedicated,
    updated_by: profile.updatedBy,
    updated_at: profile.updatedAt,
  };
}

async function reconcileRetirementSshMeshKey(
  store: RouterDeps["store"],
  workspaceId: string,
  daemonId: string,
): Promise<Record<string, unknown>> {
  const rekey = store.getDaemonRetirementSshMeshRekey(workspaceId, daemonId);
  if (!rekey || rekey.status === "not_required") return { status: "not_required" };

  try {
    const nextKey = rekey.status === "pending"
      ? await generateSshMeshKeyMaterial(workspaceId)
      : null;
    const reconciled = store.reconcileDaemonRetirementSshMeshRekey(
      workspaceId,
      daemonId,
      nextKey,
    );
    return retirementRekeyResponse(
      reconciled.status,
      reconciled.keyVersion,
      reconciled.rotationState,
    );
  } catch (error) {
    // Re-read under the workspace lifecycle lock. If another request committed
    // this retirement's exact operation, preserve it; otherwise fail closed.
    const failed = store.reconcileDaemonRetirementSshMeshRekey(workspaceId, daemonId, null);
    if (failed.status !== "rekey_required") {
      return retirementRekeyResponse(
        failed.status,
        failed.keyVersion,
        failed.rotationState,
      );
    }
    return {
      ...retirementRekeyResponse("rekey_required", failed.keyVersion, failed.rotationState),
      status: "failed_rekey_required",
      code: error instanceof SshMeshKeyError ? error.code : "rotation_failed",
    };
  }
}

function retirementRekeyResponse(
  status: "not_required" | "pending" | "rolling_out" | "completed" | "rekey_required",
  keyVersion: number | null,
  rotationState: string,
): Record<string, unknown> {
  return {
    status,
    ...(keyVersion === null ? {} : { key_version: keyVersion }),
    rotation_state: rotationState,
  };
}

function requestedWorkspaceId(
  c: Context,
  input: { workspaceId?: string | null; workspace_id?: string | null } = {},
): string {
  return String(
    input.workspaceId
      ?? input.workspace_id
      ?? c.req.query("workspace_id")
      ?? c.req.query("workspaceId")
      ?? "local",
  ).trim() || "local";
}

function loadHumanWorkspaceAccess(
  c: Context,
  deps: RouterDeps,
  workspaceId: string,
): { isManager: boolean } | Response {
  const accessToken = currentAccessToken(c);
  if (accessToken?.type === "daemon") {
    return c.json({ error: "forbidden for daemon token", code: "human_admin_required" }, 403);
  }
  const denied = denyCurrentUserWorkspaceAccess(c, deps.store, workspaceId);
  if (denied) return denied;
  const role = currentWorkspaceRoleStrict(c, deps.store, workspaceId);
  if (!role) return c.json({ error: "workspace not found" }, 404);
  return { isManager: role === "owner" || role === "admin" };
}

function authorizeDaemonRetirement(
  c: Context,
  deps: RouterDeps,
  workspaceId: string,
  daemonId: string,
): { requiredOwnerUserId: string | null } | Response {
  const access = loadHumanWorkspaceAccess(c, deps, workspaceId);
  if (access instanceof Response) return access;
  if (access.isManager) return { requiredOwnerUserId: null };
  const actorId = currentRequestUserId(c);
  if (deps.store.getDaemonIdentityOwnerUserId(workspaceId, daemonId) === actorId) {
    return { requiredOwnerUserId: actorId };
  }
  return c.json({ error: "daemon is owned by another user", code: "daemon_owner_required" }, 403);
}

function retirementPlanResponse(plan: DaemonRetirementPlan) {
  return {
    workspace_id: plan.workspaceId,
    daemon_id: plan.daemonId,
    owner_user_id: plan.ownerUserId,
    snapshot: plan.snapshot,
    already_retired: plan.alreadyRetired,
    can_retire: plan.canRetire,
    can_abandon_issue_workspaces: plan.canAbandonIssueWorkspaces,
    blocking_reasons: plan.blockingReasons,
    runtimes: plan.runtimes,
    agents: plan.agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      provider: agent.provider,
      runtime_id: agent.runtimeId,
      archived: agent.archived,
    })),
    active_tasks: plan.activeTasks.map((task) => ({
      id: task.id,
      status: task.status,
      agent_id: task.agentId,
      runtime_id: task.runtimeId,
      issue_id: task.issueId,
    })),
    queued_tasks: plan.queuedTasks.map((task) => ({
      id: task.id,
      status: task.status,
      agent_id: task.agentId,
      runtime_id: task.runtimeId,
      issue_id: task.issueId,
    })),
    local_directory_resources: plan.localDirectoryResources.map((resource) => ({
      id: resource.id,
      project_id: resource.projectId,
      project_title: resource.projectTitle,
      label: resource.label,
      local_path: resource.localPath,
    })),
    issue_workspaces: plan.issueWorkspaces.map((workspace) => ({
      issue_id: workspace.issueId,
      status: workspace.status,
      runtime_id: workspace.runtimeId,
      root_path: workspace.rootPath,
    })),
    impact: retirementImpactResponse(plan.impact),
  };
}

function retirementImpactResponse(impact: DaemonRetirementImpact) {
  return {
    runtimes_removed: impact.runtimesRemoved,
    agents_detached: impact.agentsDetached,
    queued_tasks_requeued: impact.queuedTasksRequeued,
    session_lanes_reset: impact.sessionLanesReset,
    chat_sessions_reset: impact.chatSessionsReset,
    issue_workspaces_abandoned: impact.issueWorkspacesAbandoned,
    tokens_revoked: impact.tokensRevoked,
  };
}
