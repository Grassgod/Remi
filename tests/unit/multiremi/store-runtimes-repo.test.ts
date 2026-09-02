// Sibling test for packages/server/src/store/repos/runtimes-repo.ts.
// Drives the carved-out repo directly over its StoreContext (not through the
// MultiremiStore facade) so a broken delegation cannot mask a broken move.
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { MultiremiStore } from "@multiremi/store.js";
import { StoreContext } from "@multiremi/store/context.js";
import { AnalyticsRepo } from "@multiremi/store/repos/analytics-repo.js";
import { RUNTIME_HEARTBEAT_STALE_MS as CONTRACT_RUNTIME_HEARTBEAT_STALE_MS } from "@multiremi/contracts/runtime-health";
import {
  isRuntimeEffectivelyOnline,
  RUNTIME_HEARTBEAT_STALE_MS as REPO_RUNTIME_HEARTBEAT_STALE_MS,
  RuntimesRepo,
} from "@multiremi/store/repos/runtimes-repo.js";

let db: Database | null = null;
let store: MultiremiStore | null = null;

function createRepo(): RuntimesRepo {
  db = new Database(":memory:");
  // The store owns migrations and is the lazy cross-domain host the context resolves.
  store = new MultiremiStore(db);
  const ctx = new StoreContext(db, () => store!);
  // The analytics recorders are not on the public facade, so they are registered on the context.
  ctx.registerAnalytics(new AnalyticsRepo(ctx));
  return new RuntimesRepo(ctx);
}

afterEach(() => {
  db?.close();
  db = null;
  store = null;
});

describe("RuntimesRepo", () => {
  it("uses the shared heartbeat threshold for effective liveness", () => {
    const now = new Date("2026-08-28T04:00:00Z").getTime();

    expect(REPO_RUNTIME_HEARTBEAT_STALE_MS).toBe(
      CONTRACT_RUNTIME_HEARTBEAT_STALE_MS,
    );
    expect(
      isRuntimeEffectivelyOnline(
        {
          status: "online",
          lastHeartbeatAt: new Date(
            now - CONTRACT_RUNTIME_HEARTBEAT_STALE_MS,
          ).toISOString(),
        },
        now,
      ),
    ).toBe(true);
    expect(
      isRuntimeEffectivelyOnline(
        {
          status: "online",
          lastHeartbeatAt: new Date(
            now - CONTRACT_RUNTIME_HEARTBEAT_STALE_MS - 1,
          ).toISOString(),
        },
        now,
      ),
    ).toBe(false);
  });

  it("registers a runtime with models and reads it back", () => {
    const repo = createRepo();

    const runtime = repo.registerRuntime({
      id: "rt_alpha",
      name: "Alpha",
      provider: "claude",
      workspaceId: "local",
      models: [{ id: "sonnet", label: "Sonnet", provider: "claude", default: true }],
    });

    expect(runtime.id).toBe("rt_alpha");
    expect(runtime.status).toBe("online");
    expect(repo.getRuntime("rt_alpha")?.name).toBe("Alpha");
    expect(repo.listRuntimes().map((entry) => entry.id)).toEqual(["rt_alpha"]);
    expect(repo.listRuntimeModels("rt_alpha").map((model) => model.id)).toEqual(["sonnet"]);
    expect(() => repo.listRuntimeModels("rt_missing")).toThrow("Runtime not found: rt_missing");
  });

  it("runs a model-list request through create → claim → report", () => {
    const repo = createRepo();
    repo.registerRuntime({ id: "rt_beta", name: "Beta", provider: "claude", workspaceId: "local" });

    const request = repo.createRuntimeModelListRequest("rt_beta");
    expect(request.status).toBe("pending");

    const claimed = repo.claimRuntimeModelListRequest("rt_beta");
    expect(claimed?.id).toBe(request.id);
    expect(claimed?.status).toBe("running");

    const reported = repo.reportRuntimeModelListResult("rt_beta", request.id, {
      status: "completed",
      models: [{ id: "opus", label: "Opus", provider: "claude", default: true }],
    });
    expect(reported.status).toBe("completed");
    expect(repo.listRuntimeModels("rt_beta").map((model) => model.id)).toEqual(["opus"]);
    // Terminal requests are immutable — a late failure report must not overwrite the result.
    expect(repo.reportRuntimeModelListResult("rt_beta", request.id, { status: "failed" }).status).toBe("completed");
  });

  it("hands pending work back on heartbeat and gates the claim predicate on ownership", () => {
    const repo = createRepo();
    const runtime = repo.registerRuntime({
      id: "rt_gamma",
      name: "Gamma",
      provider: "claude",
      workspaceId: "local",
      ownerId: "usr_owner",
      visibility: "private",
    });
    const update = repo.createRuntimeUpdateRequest("rt_gamma", { targetVersion: "9.9.9" });

    const ack = repo.heartbeatRuntime("rt_gamma");
    expect(ack.status).toBe("ok");
    expect(ack.pending_update?.id).toBe(update.id);
    expect(repo.heartbeatRuntime("rt_nope").runtime_gone).toBe(true);

    // Agents live in another repo, reached through ctx.agents().
    const mine = store!.createAgent({ name: "Mine", provider: "claude", workspaceId: "local", ownerId: "usr_owner" });
    const theirs = store!.createAgent({ name: "Theirs", provider: "claude", workspaceId: "local", ownerId: "usr_other" });
    expect(repo.runtimeCanRunAgent(runtime, mine)).toBe(true);
    expect(repo.runtimeCanRunAgent(runtime, theirs)).toBe(false);

    expect(repo.getRuntimeByDaemonAndProvider("rt_gamma", "claude")?.id).toBe("rt_gamma");
    expect(repo.deleteRuntime("rt_gamma")).toBe(true);
    expect(repo.getRuntime("rt_gamma")).toBeNull();
  });

  it("deletes every Runtime auxiliary row through the shared transaction cleanup", () => {
    const repo = createRepo();
    const runtime = repo.registerRuntime({
      id: "rt_cleanup",
      name: "Cleanup",
      provider: "claude",
      workspaceId: "local",
      models: [{ id: "cleanup-model", label: "Cleanup model", provider: "claude", default: true }],
    });
    const agent = store!.createAgent({
      name: "Cleanup agent",
      provider: "claude",
      runtimeId: runtime.id,
    });
    const issue = store!.createIssue({ title: "Cleanup issue" });
    store!.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: runtime.id,
      rootPath: "/tmp/cleanup",
      branchName: `agent/${issue.key}`,
      status: "ready",
    });
    const chat = store!.createChatSession({ agentId: agent.id, title: "Cleanup chat" });
    db!.run(
      `UPDATE multiremi_chat_sessions
       SET session_id = ?, session_runtime_id = ?, session_provider = ?, work_dir = ?
       WHERE id = ?`,
      ["sess-cleanup", runtime.id, "claude", "/tmp/cleanup", chat.id],
    );
    const issueSession = store!.getOrCreateDefaultIssueSession(issue.id);
    store!.getOrCreateSessionAgentLane(issueSession.id, agent.id);
    db!.run(
      `UPDATE multiremi_session_agent_lanes
       SET provider_session_id = ?, runtime_id = ?, provider = ?, work_dir = ?
       WHERE session_id = ? AND agent_id = ?`,
      ["sess-cleanup", runtime.id, "claude", "/tmp/cleanup", issueSession.id, agent.id],
    );
    repo.createRuntimeModelListRequest(runtime.id);
    repo.createRuntimeLocalSkillListRequest(runtime.id);
    repo.createRuntimeLocalSkillImportRequest(runtime.id, { skillKey: "cleanup-skill" });
    repo.createRuntimeDirectoryScanRequest(runtime.id, { root: "/tmp" });
    const now = new Date().toISOString();
    db!.run(
      `INSERT INTO multiremi_agent_plugin_runtime_states (
        id, workspace_id, runtime_id, plugin_id, plugin_version_id,
        desired, desired_reason, status, created_at, updated_at
      ) VALUES (?, 'local', ?, ?, ?, 1, 'active_binding', 'pending', ?, ?)`,
      ["aprs_cleanup", runtime.id, "apl_cleanup", "apv_cleanup", now, now],
    );

    const runningTask = store!.createTask({
      agentId: agent.id,
      runtimeId: runtime.id,
      prompt: "keep the runtime alive while work is in flight",
    });
    expect(store!.claimTask(runtime.id)?.id).toBe(runningTask.id);
    store!.startTask(runningTask.id);
    repo.createRuntimeUpdateRequest(runtime.id, { targetVersion: "2.0.0" });
    expect(repo.deleteRuntime(runtime.id)).toBeFalse();
    expect(repo.getRuntime(runtime.id)).not.toBeNull();
    expect(store!.getAgent(agent.id)?.runtimeId).toBe(runtime.id);
    expect(store!.getIssueWorkspace(issue.id)?.runtimeId).toBe(runtime.id);
    expect(Number((db!.query(
      "SELECT COUNT(*) AS count FROM multiremi_agent_plugin_runtime_states WHERE runtime_id = ?",
    ).get(runtime.id) as any).count)).toBe(1);

    store!.cancelTask(runningTask.id);
    expect(repo.deleteRuntime(runtime.id)).toBeTrue();
    expect(store!.getAgent(agent.id)?.runtimeId).toBeNull();
    expect(store!.getIssueWorkspace(issue.id)).toMatchObject({
      runtimeId: null,
      status: "runtime_offline",
    });
    expect(store!.getChatSession(chat.id)).toMatchObject({
      sessionId: null,
      sessionRuntimeId: null,
      workDir: null,
    });
    expect(store!.getSessionAgentLane(issueSession.id, agent.id)).toMatchObject({
      providerSessionId: null,
      runtimeId: null,
      workDir: null,
    });
    for (const table of [
      "multiremi_agent_plugin_runtime_states",
      "multiremi_runtime_models",
      "multiremi_runtime_model_list_requests",
      "multiremi_runtime_update_requests",
      "multiremi_runtime_local_skill_list_requests",
      "multiremi_runtime_local_skill_import_requests",
      "multiremi_runtime_directory_scan_requests",
    ]) {
      expect(Number((db!.query(`SELECT COUNT(*) AS count FROM ${table} WHERE runtime_id = ?`).get(runtime.id) as any).count))
        .toBe(0);
    }
  });

  it("archives and detaches Agents while preserving their historical references", () => {
    const repo = createRepo();
    const runtime = repo.registerRuntime({
      id: "rt_agent_reference_cleanup",
      name: "Agent reference cleanup",
      provider: "claude",
      workspaceId: "local",
    });
    const agent = store!.createAgent({
      name: "Reference cleanup agent",
      provider: "claude",
      runtimeId: runtime.id,
    });
    const plugin = store!.importAgentPlugin({
      provider: "claude",
      manifest: { name: "reference-cleanup", version: "1.0.0" },
      files: [{ path: "skills/reference-cleanup/SKILL.md", content: "# Reference cleanup\n" }],
    });
    store!.createAgentPluginBinding(agent.id, { pluginId: plugin.id });
    const project = store!.createProject({
      title: "Reference cleanup project",
      defaultAssigneeType: "agent",
      defaultAssigneeId: agent.id,
    });
    const issue = store!.createIssue({
      title: "Reference cleanup issue",
      assigneeType: "agent",
      assigneeId: agent.id,
    });

    expect(repo.archiveAgentsAndDeleteRuntime(runtime.id, [agent.id])).toMatchObject({ status: "ok" });
    expect(store!.getAgent(agent.id)).toMatchObject({ runtimeId: null });
    expect(store!.getAgent(agent.id)?.archivedAt).not.toBeNull();
    expect(Number((db!.query(
      "SELECT COUNT(*) AS count FROM multiremi_agent_plugin_bindings WHERE agent_id = ?",
    ).get(agent.id) as any).count)).toBe(1);
    expect(store!.getProject(project.id)).toMatchObject({
      defaultAssigneeType: null,
      defaultAssigneeId: null,
    });
    expect(store!.getIssue(issue.id)).toMatchObject({
      assigneeType: "agent",
      assigneeId: agent.id,
    });
  });

  it("keeps an archived Agent and its Runtime while the Agent still has queued work", () => {
    const repo = createRepo();
    const runtime = repo.registerRuntime({
      id: "rt_archived_agent_queued_task",
      name: "Archived Agent queued task",
      provider: "claude",
      workspaceId: "local",
    });
    const agent = store!.createAgent({
      name: "Archived Agent with queued work",
      provider: "claude",
      runtimeId: runtime.id,
    });
    const task = store!.createTask({
      agentId: agent.id,
      runtimeId: runtime.id,
      prompt: "do not orphan me",
    });
    store!.archiveAgent(agent.id);

    expect(repo.deleteRuntimeWithArchivedAgentCleanup(runtime.id)).toEqual({ status: "active_tasks" });
    expect(repo.getRuntime(runtime.id)).not.toBeNull();
    expect(store!.getAgent(agent.id)).not.toBeNull();
    expect(store!.getTask(task.id)?.status).toBe("queued");

    store!.cancelTask(task.id);
    expect(repo.deleteRuntimeWithArchivedAgentCleanup(runtime.id)).toEqual({ status: "deleted" });
    expect(repo.getRuntime(runtime.id)).toBeNull();
    expect(store!.getAgent(agent.id)).toMatchObject({ runtimeId: null });
    expect(store!.getAgent(agent.id)?.archivedAt).not.toBeNull();
  });
});
