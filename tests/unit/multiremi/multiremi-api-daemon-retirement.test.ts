import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, db, readyArchiveBinding, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Multiremi API — daemon retirement", () => {
  it("funnels bound credential revocation and member removal through daemon retirement", async () => {
    const store = createStore();
    const member = store.createWorkspaceMember({
      id: "machine-member-record",
      userId: "machine-member",
      name: "Machine Member",
      role: "member",
    });
    const first = await store.createAccessToken({
      name: "Machine credential one",
      type: "daemon",
      workspaceId: "local",
      daemonId: "daemon-trust-revocation",
      userId: "machine-member",
    });
    const second = await store.createAccessToken({
      name: "Machine credential two",
      type: "daemon",
      workspaceId: "local",
      daemonId: "daemon-trust-revocation",
      userId: "machine-member",
    });
    const unbound = await store.createAccessToken({
      name: "Unused daemon credential",
      type: "daemon",
      workspaceId: "local",
      userId: "machine-member",
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const headers = { Authorization: "Bearer root-secret", "Content-Type": "application/json" };

    const revokeBound = await app.request(`/api/multiremi/tokens/${first.id}`, {
      method: "DELETE",
      headers,
    });
    expect(revokeBound.status).toBe(409);
    expect(await revokeBound.json()).toMatchObject({
      code: "daemon_retirement_required",
      daemon_id: "daemon-trust-revocation",
    });
    expect(store.getAccessToken(first.id)?.revokedAt).toBeNull();

    const revokeUnbound = await app.request(`/api/multiremi/tokens/${unbound.id}`, {
      method: "DELETE",
      headers,
    });
    expect(revokeUnbound.status).toBe(200);
    expect(store.getAccessToken(unbound.id)?.revokedAt).not.toBeNull();

    const removeOwner = await app.request(`/api/workspaces/local/members/${member.id}`, {
      method: "DELETE",
      headers,
    });
    expect(removeOwner.status).toBe(409);
    expect(await removeOwner.json()).toMatchObject({
      error: expect.stringContaining("retire them before removing the member"),
    });

    const plan = store.getDaemonRetirementPlan("local", "daemon-trust-revocation");
    const retired = await app.request("/api/multiremi/daemons/daemon-trust-revocation/retire", {
      method: "POST",
      headers,
      body: JSON.stringify({ workspace_id: "local", expected_snapshot: plan.snapshot }),
    });
    expect(retired.status).toBe(200);
    expect(await retired.json()).toMatchObject({
      ssh_mesh_key_rotation: { status: "not_required" },
    });
    expect(store.getAccessToken(first.id)?.revokedAt).not.toBeNull();
    expect(store.getAccessToken(second.id)?.revokedAt).not.toBeNull();

    const removed = await app.request(`/api/workspaces/local/members/${member.id}`, {
      method: "DELETE",
      headers,
    });
    expect(removed.status).toBe(204);
  });

  it("rejects expiring daemon credentials at the storage and admin API boundaries", async () => {
    const store = createStore();
    await expect(store.createAccessToken({
      name: "Expiring daemon",
      type: "daemon",
      workspaceId: "local",
      daemonId: "daemon-expiring",
      expiresInDays: 30,
    })).rejects.toThrow("Daemon tokens cannot expire");

    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const response = await app.request("/api/multiremi/tokens", {
      method: "POST",
      headers: { Authorization: "Bearer root-secret", "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Expiring daemon API",
        type: "daemon",
        workspace_id: "local",
        daemon_id: "daemon-expiring-api",
        expires_in_days: 30,
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "daemon_token_expiry_not_allowed" });

    const compatibilityRenew = await app.request("/api/tokens/current/renew", {
      method: "POST",
      headers: { Authorization: "Bearer root-secret", "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Expiring daemon renew compatibility",
        type: "daemon",
        expires_in_days: 30,
      }),
    });
    expect(compatibilityRenew.status).toBe(400);
    expect(await compatibilityRenew.json()).toMatchObject({ code: "daemon_token_expiry_not_allowed" });
  });

  it("lists every daemon for managers and only owner-claimed daemons for members", async () => {
    const store = createStore();
    store.createWorkspaceMember({ id: "inventory-admin", name: "Inventory Admin", role: "admin" });
    store.createWorkspaceMember({ id: "inventory-member", name: "Inventory Member", role: "member" });
    const adminToken = await store.createAccessToken({
      name: "Inventory admin",
      type: "pat",
      workspaceId: "local",
      userId: "inventory-admin",
    });
    const memberToken = await store.createAccessToken({
      name: "Inventory member",
      type: "pat",
      workspaceId: "local",
      userId: "inventory-member",
    });
    store.registerRuntime({
      id: "rt_inventory_combined",
      name: "Combined daemon Runtime",
      provider: "codex",
      workspaceId: "local",
      daemonId: "daemon-inventory-combined",
    });
    await store.createAccessToken({
      name: "Combined daemon token",
      type: "daemon",
      workspaceId: "local",
      daemonId: "daemon-inventory-combined",
    });
    await store.createAccessToken({
      name: "Token-only daemon",
      type: "daemon",
      workspaceId: "local",
      daemonId: "daemon-inventory-token-only",
    });
    await store.createAccessToken({
      name: "Member token-only daemon",
      type: "daemon",
      workspaceId: "local",
      daemonId: "daemon-inventory-member",
      userId: "inventory-member",
    });
    store.registerRuntime({
      id: "rt_inventory_runtime_only",
      name: "Runtime-only daemon",
      provider: "claude",
      workspaceId: "local",
      daemonId: "daemon-inventory-runtime-only",
    });
    await store.createAccessToken({
      name: "Retired inventory daemon",
      type: "daemon",
      workspaceId: "local",
      daemonId: "daemon-inventory-retired",
    });
    const retiredPlan = store.getDaemonRetirementPlan("local", "daemon-inventory-retired");
    expect(store.retireDaemon("local", "daemon-inventory-retired", retiredPlan.snapshot, "inventory-admin").status)
      .toBe("retired");

    const inventory = store.listDaemonInventory("local");
    expect(inventory.map((entry) => entry.daemonId).sort()).toEqual([
      "daemon-inventory-combined",
      "daemon-inventory-member",
      "daemon-inventory-runtime-only",
      "daemon-inventory-token-only",
    ]);
    expect(inventory.find((entry) => entry.daemonId === "daemon-inventory-combined")).toMatchObject({
      runtimeCount: 1,
      tokenCount: 1,
      name: "Combined daemon Runtime",
    });
    expect(inventory.find((entry) => entry.daemonId === "daemon-inventory-token-only")).toMatchObject({
      runtimeCount: 0,
      tokenCount: 1,
      name: "Token-only daemon",
    });

    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const memberInventory = await app.request("/api/multiremi/daemons?workspace_id=local", {
      headers: { Authorization: `Bearer ${memberToken.token}` },
    });
    expect(memberInventory.status).toBe(200);
    expect((await memberInventory.json()).daemons).toEqual([
      expect.objectContaining({
        daemon_id: "daemon-inventory-member",
        owner_user_id: "inventory-member",
        runtime_count: 0,
        token_count: 1,
      }),
    ]);

    const response = await app.request("/api/multiremi/daemons?workspace_id=local", {
      headers: { Authorization: `Bearer ${adminToken.token}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.workspace_id).toBe("local");
    expect(body.daemons.find((daemon: any) => daemon.daemon_id === "daemon-inventory-token-only")).toMatchObject({
      runtime_count: 0,
      token_count: 1,
      name: "Token-only daemon",
    });
    expect(body.daemons.some((daemon: any) => daemon.daemon_id === "daemon-inventory-retired")).toBeFalse();
  });

  it("lets a member retire their own last-runtime daemon but rejects another member", async () => {
    const store = createStore();
    store.createWorkspaceMember({ id: "machine-owner", name: "Machine owner", role: "member" });
    store.createWorkspaceMember({ id: "other-member", name: "Other member", role: "member" });
    const ownerToken = await store.createAccessToken({
      name: "Machine owner session",
      type: "pat",
      workspaceId: "local",
      userId: "machine-owner",
    });
    const otherToken = await store.createAccessToken({
      name: "Other member session",
      type: "pat",
      workspaceId: "local",
      userId: "other-member",
    });
    await store.createAccessToken({
      name: "Member-owned daemon token",
      type: "daemon",
      workspaceId: "local",
      daemonId: "daemon-member-owned-retire",
      userId: "machine-owner",
    });
    const runtime = store.registerRuntime({
      id: "rt_member_owned_retire",
      name: "Member-owned Runtime",
      provider: "claude",
      workspaceId: "local",
      daemonId: "daemon-member-owned-retire",
      ownerId: "machine-owner",
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const lastRuntime = await app.request(`/api/runtimes/${runtime.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ownerToken.token}` },
    });
    expect(lastRuntime.status).toBe(409);
    expect(await lastRuntime.json()).toMatchObject({
      code: "daemon_last_runtime",
      daemon_id: "daemon-member-owned-retire",
    });

    const planPath = "/api/multiremi/daemons/daemon-member-owned-retire/retirement-plan?workspace_id=local";
    const crossOwner = await app.request(planPath, {
      headers: { Authorization: `Bearer ${otherToken.token}` },
    });
    expect(crossOwner.status).toBe(403);
    expect(await crossOwner.json()).toMatchObject({ code: "daemon_owner_required" });
    const directPlan = store.getDaemonRetirementPlan("local", "daemon-member-owned-retire");
    expect(store.retireDaemon(
      "local",
      "daemon-member-owned-retire",
      directPlan.snapshot,
      "other-member",
      "other-member",
    )).toEqual({ status: "forbidden" });
    expect(store.getRuntime(runtime.id)).not.toBeNull();

    const planResponse = await app.request(planPath, {
      headers: { Authorization: `Bearer ${ownerToken.token}` },
    });
    expect(planResponse.status).toBe(200);
    const plan = (await planResponse.json()).plan;
    expect(plan.owner_user_id).toBe("machine-owner");
    const retired = await app.request("/api/multiremi/daemons/daemon-member-owned-retire/retire", {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: "local", expected_snapshot: plan.snapshot }),
    });
    expect(retired.status).toBe(200);
    expect(store.getRuntime(runtime.id)).toBeNull();
  });

  it("preflights the whole machine and blocks destructive retirement while dependencies are active", async () => {
    const store = createStore();
    store.createWorkspaceMember({ id: "admin", name: "Admin", role: "admin" });
    store.createWorkspaceMember({ id: "member", name: "Member", role: "member" });
    const adminToken = await store.createAccessToken({ name: "Admin", type: "pat", workspaceId: "local", userId: "admin" });
    const memberToken = await store.createAccessToken({ name: "Member", type: "pat", workspaceId: "local", userId: "member" });
    const daemonToken = await store.createAccessToken({
      name: "Daemon",
      type: "daemon",
      workspaceId: "local",
      daemonId: "daemon-blocked",
    });
    const claude = store.registerRuntime({
      id: "rt_blocked_claude",
      name: "claude (blocked)",
      provider: "claude",
      workspaceId: "local",
      daemonId: "daemon-blocked",
    });
    store.registerRuntime({
      id: "rt_blocked_codex",
      name: "codex (blocked)",
      provider: "codex",
      workspaceId: "local",
      daemonId: "daemon-blocked",
    });
    const agent = store.createAgent({
      name: "Blocked Claude",
      provider: "claude",
      workspaceId: "local",
      runtimeId: claude.id,
    });
    const project = store.createProject({
      title: "Local project",
      workspaceId: "local",
      resources: [{
        resourceType: "local_directory",
        resourceRef: { local_path: "/work/project", daemon_id: "daemon-blocked" },
      }],
    });
    const issue = store.createIssue({ title: "Running work", workspaceId: "local", projectId: project.id });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "keep running" });
    expect(store.claimTask(claude.id)?.id).toBe(task.id);
    store.startTask(task.id);
    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: claude.id,
      rootPath: "/work/issue",
      branchName: `agent/${issue.key}`,
      status: "in_use",
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const path = "/api/multiremi/daemons/daemon-blocked/retirement-plan?workspace_id=local";

    const taskToken = await store.createAccessToken({
      name: "Running agent task",
      type: "task",
      workspaceId: "local",
      userId: "admin",
      taskId: task.id,
      agentId: agent.id,
    });
    const taskPlan = await app.request(path, {
      headers: { Authorization: `Bearer ${taskToken.token}` },
    });
    expect(taskPlan.status).toBe(200);
    expect((await taskPlan.json()).plan.can_retire).toBeFalse();

    const taskRetireDenied = await app.request("/api/multiremi/daemons/daemon-blocked/retire", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${taskToken.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ workspace_id: "local", expected_snapshot: "untrusted" }),
    });
    expect(taskRetireDenied.status).toBe(403);
    expect(await taskRetireDenied.json()).toMatchObject({ code: "task_token_hard_denied" });

    const memberDenied = await app.request(path, {
      headers: { Authorization: `Bearer ${memberToken.token}` },
    });
    expect(memberDenied.status).toBe(403);
    expect(await memberDenied.json()).toMatchObject({ code: "daemon_owner_required" });

    const planResponse = await app.request(path, {
      headers: { Authorization: `Bearer ${adminToken.token}` },
    });
    expect(planResponse.status).toBe(200);
    const plan = (await planResponse.json()).plan;
    expect(plan.can_retire).toBeFalse();
    expect(plan.blocking_reasons).toEqual([
      "active_tasks",
      "local_directory_resources",
      "active_issue_workspaces",
    ]);
    expect(plan.runtimes.map((runtime: any) => runtime.provider)).toEqual(["claude", "codex"]);
    expect(plan.active_tasks).toHaveLength(1);
    expect(plan.local_directory_resources[0]).toMatchObject({
      project_id: project.id,
      local_path: "/work/project",
    });
    expect(plan.issue_workspaces[0]).toMatchObject({ issue_id: issue.id, status: "in_use" });

    const blocked = await app.request("/api/multiremi/daemons/daemon-blocked/retire", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ workspace_id: "local", expected_snapshot: plan.snapshot }),
    });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ code: "daemon_retirement_blocked" });
    expect(store.getRuntime(claude.id)).not.toBeNull();
    expect(store.getAccessToken(daemonToken.id)?.revokedAt).toBeNull();
  });

  it("requires explicit abandonment for stale issue workspaces on an offline daemon", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({
      id: "rt_abandon_issue_workspace",
      name: "Offline issue workspace Runtime",
      provider: "claude",
      workspaceId: "local",
      daemonId: "daemon-abandon-issue-workspace",
    });
    const issue = store.createIssue({ title: "Workspace left on dead machine", workspaceId: "local" });
    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: runtime.id,
      rootPath: "/work/unreachable",
      branchName: `agent/${issue.key}`,
      status: "in_use",
    });
    const app = createMultiremiApp({ store });
    const planPath = "/api/multiremi/daemons/daemon-abandon-issue-workspace/retirement-plan?workspace_id=local";
    const onlinePlan = (await (await app.request(planPath)).json()).plan;
    expect(onlinePlan).toMatchObject({
      can_retire: false,
      can_abandon_issue_workspaces: false,
      blocking_reasons: ["active_issue_workspaces"],
    });

    const unsafeRetirement = await app.request(
      "/api/multiremi/daemons/daemon-abandon-issue-workspace/retire",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: "local",
          expected_snapshot: onlinePlan.snapshot,
          abandon_issue_workspaces: true,
        }),
      },
    );
    expect(unsafeRetirement.status).toBe(409);
    expect(await unsafeRetirement.json()).toMatchObject({
      code: "daemon_retirement_blocked",
    });

    store.setRuntimeOffline(runtime.id);
    const plan = (await (await app.request(planPath)).json()).plan;
    expect(plan).toMatchObject({
      can_retire: false,
      can_abandon_issue_workspaces: true,
      blocking_reasons: ["active_issue_workspaces"],
    });
    expect(plan.snapshot).not.toBe(onlinePlan.snapshot);

    const ordinary = await app.request(
      "/api/multiremi/daemons/daemon-abandon-issue-workspace/retire",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: "local", expected_snapshot: plan.snapshot }),
      },
    );
    expect(ordinary.status).toBe(409);
    expect(store.getRuntime(runtime.id)).not.toBeNull();

    const retired = await app.request(
      "/api/multiremi/daemons/daemon-abandon-issue-workspace/retire",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: "local",
          expected_snapshot: plan.snapshot,
          abandon_issue_workspaces: true,
        }),
      },
    );
    expect(retired.status).toBe(200);
    expect(await retired.json()).toMatchObject({
      impact: { issue_workspaces_abandoned: 1 },
    });
    expect(store.getRuntime(runtime.id)).toBeNull();
    expect(store.getIssueWorkspace(issue.id)).toMatchObject({
      status: "cleaned",
      runtimeId: null,
    });
  });

  it("detects plan changes, migrates safe state atomically, tombstones the daemon, and is idempotent", async () => {
    const store = createStore();
    const retirementEvents: any[] = [];
    store.onWorkspaceEvent((event) => {
      if (event.type === "daemon:retired") retirementEvents.push(event);
    });
    const daemonToken = await store.createAccessToken({
      name: "Retiring daemon",
      type: "daemon",
      workspaceId: "local",
      daemonId: "daemon-retire",
    });
    const claude = store.registerRuntime({
      id: "rt_retire_claude",
      name: "claude (retire)",
      provider: "claude",
      workspaceId: "local",
      daemonId: "daemon-retire",
      models: [{ id: "claude-model", label: "Claude", provider: "anthropic", default: true }],
    });
    const agent = store.createAgent({
      name: "Retired machine agent",
      provider: "claude",
      workspaceId: "local",
      runtimeId: claude.id,
    });
    const queued = store.createTask({ agentId: agent.id, prompt: "run later" });
    expect(queued.runtimeId).toBe(claude.id);
    const issue = store.createIssue({ title: "Clean workspace", workspaceId: "local" });
    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: claude.id,
      rootPath: "/work/cleaned",
      branchName: `agent/${issue.key}`,
      status: "ready",
    });
    store.markIssueWorkspaceCleaned({
      issueId: issue.id,
      runtimeId: claude.id,
      ...readyArchiveBinding(store, issue.id, claude.id),
    });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    store.getOrCreateSessionAgentLane(session.id, agent.id);
    db!.run(
      `UPDATE multiremi_session_agent_lanes
       SET provider_session_id = 'provider-session', runtime_id = ?, provider = 'claude', work_dir = '/work/lane'
       WHERE session_id = ? AND agent_id = ?`,
      [claude.id, session.id, agent.id],
    );
    const chat = store.createChatSession({ agentId: agent.id, title: "Retirement chat", workspaceId: "local" });
    db!.run(
      `UPDATE multiremi_chat_sessions
       SET session_id = 'chat-provider-session', work_dir = '/work/chat', session_runtime_id = ?, session_provider = 'claude'
       WHERE id = ?`,
      [claude.id, chat.id],
    );
    const survivingProject = store.createProject({ title: "Other machine directory", workspaceId: "local" });
    const survivingLocalDirectory = store.createProjectResource(survivingProject.id, {
      resourceType: "local_directory",
      resourceRef: { localPath: "/work/other-machine", daemonId: "daemon-other" },
    });
    store.createRuntimeModelListRequest(claude.id);
    const localSkillImport = store.createRuntimeLocalSkillImportRequest(claude.id, { skillKey: "retired-local-skill" });
    const skillCountBeforeRetirement = store.listSkills("local").length;
    const app = createMultiremiApp({ store });
    const planPath = "/api/multiremi/daemons/daemon-retire/retirement-plan?workspace_id=local";

    const initialPlan = (await (await app.request(planPath)).json()).plan;
    const codex = store.registerRuntime({
      id: "rt_retire_codex",
      name: "codex (retire)",
      provider: "codex",
      workspaceId: "local",
      daemonId: "daemon-retire",
    });
    const stale = await app.request("/api/multiremi/daemons/daemon-retire/retire", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: "local", expected_snapshot: initialPlan.snapshot }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "daemon_retirement_plan_changed" });

    const currentPlan = (await (await app.request(planPath)).json()).plan;
    expect(currentPlan.can_retire).toBeTrue();
    expect(currentPlan.impact).toMatchObject({
      runtimes_removed: 2,
      agents_detached: 1,
      queued_tasks_requeued: 1,
      session_lanes_reset: 1,
      chat_sessions_reset: 1,
      tokens_revoked: 1,
    });
    const retired = await app.request("/api/multiremi/daemons/daemon-retire/retire", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: "local", expected_snapshot: currentPlan.snapshot }),
    });
    expect(retired.status).toBe(200);
    const retiredBody = await retired.json();
    expect(retiredBody).toMatchObject({
      status: "retired",
      daemon_id: "daemon-retire",
      already_retired: false,
      impact: currentPlan.impact,
    });
    expect(store.getRuntime(claude.id)).toBeNull();
    expect(store.getRuntime(codex.id)).toBeNull();
    expect(store.getAgent(agent.id)?.runtimeId).toBeNull();
    expect(store.getTask(queued.id)?.runtimeId).toBeNull();
    expect(store.getAccessToken(daemonToken.id)?.revokedAt).not.toBeNull();
    const authenticatedApp = createMultiremiApp({ store, authToken: "retirement-master-token" });
    const revokedHeartbeat = await authenticatedApp.request("/api/daemon/heartbeat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${daemonToken.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ runtime_id: claude.id }),
    });
    expect(revokedHeartbeat.status).toBe(401);
    expect(store.getIssueWorkspace(issue.id)?.runtimeId).toBeNull();
    expect(db!.query("SELECT runtime_id, provider_session_id FROM multiremi_session_agent_lanes WHERE session_id = ?").get(session.id)).toMatchObject({
      runtime_id: null,
      provider_session_id: null,
    });
    expect(db!.query("SELECT session_runtime_id, session_id FROM multiremi_chat_sessions WHERE id = ?").get(chat.id)).toMatchObject({
      session_runtime_id: null,
      session_id: null,
    });
    expect(Number((db!.query("SELECT COUNT(*) AS count FROM multiremi_runtime_models WHERE runtime_id = ?").get(claude.id) as any).count)).toBe(0);
    expect(Number((db!.query("SELECT COUNT(*) AS count FROM multiremi_runtime_model_list_requests WHERE runtime_id = ?").get(claude.id) as any).count)).toBe(0);
    expect(retirementEvents).toHaveLength(1);
    expect(retirementEvents[0]?.payload).toMatchObject({
      daemon_id: "daemon-retire",
      runtime_ids: [claude.id, codex.id],
    });

    const postRetirementTask = store.createTask({ agentId: agent.id, prompt: "run after retirement" });
    expect(postRetirementTask.runtimeId).toBeNull();

    const freshUnboundToken = await store.createAccessToken({
      name: "Fresh legacy daemon token",
      type: "daemon",
      workspaceId: "local",
    });
    const officialReconnect = await app.request("/api/daemon/register", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${freshUnboundToken.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "daemon-retire",
        runtimes: [{ type: "claude" }],
      }),
    });
    expect(officialReconnect.status).toBe(410);
    expect(await officialReconnect.json()).toEqual({ error: "daemon has been retired", code: "daemon_retired" });
    expect(store.getAccessToken(freshUnboundToken.id)?.daemonId).toBeNull();
    expect(() => store.bindDaemonAccessToken(freshUnboundToken.id, "daemon-retire")).toThrow("has been retired");
    expect(store.getAccessToken(freshUnboundToken.id)?.daemonId).toBeNull();

    const tokenCountBeforeRejectedMint = store.listAccessTokens("local").length;
    const rejectedMint = await app.request("/api/multiremi/install/daemon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "daemon-retire",
        token_name: "Rejected retired daemon token",
      }),
    });
    expect(rejectedMint.status).toBe(410);
    expect(await rejectedMint.json()).toMatchObject({ code: "daemon_retired" });
    expect(store.listAccessTokens("local")).toHaveLength(tokenCountBeforeRejectedMint);
    await expect(store.createAccessToken({
      name: "Rejected direct daemon token",
      type: "daemon",
      workspaceId: " local ",
      daemonId: " daemon-retire ",
    })).rejects.toThrow("has been retired");
    expect(store.listAccessTokens("local")).toHaveLength(tokenCountBeforeRejectedMint);

    const reconnect = await app.request("/api/multiremi/runtimes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: claude.id,
        name: "claude (resurrected)",
        provider: "claude",
        workspace_id: "local",
        daemon_id: "daemon-retire",
      }),
    });
    expect(reconnect.status).toBe(410);
    expect(await reconnect.json()).toEqual({ error: "daemon has been retired", code: "daemon_retired" });
    expect(() => store.registerRuntime({
      id: "rt_direct_resurrection",
      name: "direct resurrection",
      provider: "claude",
      workspaceId: "local",
      daemonId: "daemon-retire",
    })).toThrow("has been retired");
    expect(() => store.createProjectResource(survivingProject.id, {
      resourceType: "local_directory",
      resourceRef: { localPath: "/work/retired-machine", daemonId: "daemon-retire" },
    })).toThrow("has been retired");
    expect(() => store.updateProjectResource(survivingProject.id, survivingLocalDirectory.id, {
      resourceRef: { localPath: "/work/retired-machine", daemonId: "daemon-retire" },
    })).toThrow("has been retired");
    expect(() => store.createProject({
      id: "prj_retired_daemon_inline",
      title: "Rejected inline directory",
      workspaceId: "local",
      resources: [{
        resourceType: "local_directory",
        resourceRef: { localPath: "/work/retired-inline", daemonId: "daemon-retire" },
      }],
    })).toThrow("has been retired");
    expect(store.getProject("prj_retired_daemon_inline")).toBeNull();
    expect(() => store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: claude.id,
      rootPath: "/work/resurrected",
      branchName: `agent/${issue.key}`,
      status: "ready",
    })).toThrow(`Runtime not found: ${claude.id}`);
    expect(() => store.markIssueWorkspaceCleaned({
      issueId: issue.id,
      runtimeId: claude.id,
      archiveId: "sar_retired",
      sourceRevision: "retired",
      sha256: "0".repeat(64),
    })).toThrow("runtime does not own issue workspace");
    expect(() => store.updateRuntimeModels(claude.id, [{ id: "late-model", label: "Late", provider: "anthropic", default: false }]))
      .toThrow(`Runtime not found: ${claude.id}`);
    expect(() => store.createRuntimeModelListRequest(claude.id)).toThrow(`Runtime not found: ${claude.id}`);
    expect(() => store.createRuntimeDirectoryScanRequest(claude.id)).toThrow(`Runtime not found: ${claude.id}`);
    expect(() => store.createRuntimeUpdateRequest(claude.id, { targetVersion: "9.9.9" }))
      .toThrow(`Runtime not found: ${claude.id}`);
    expect(() => store.createRuntimeLocalSkillListRequest(claude.id)).toThrow(`Runtime not found: ${claude.id}`);
    expect(() => store.createRuntimeLocalSkillImportRequest(claude.id, { skillKey: "late-local-skill" }))
      .toThrow(`Runtime not found: ${claude.id}`);
    expect(() => store.reportRuntimeLocalSkillImportResult(claude.id, localSkillImport.id, {
      status: "completed",
      skill: { name: "Dangling skill", content: "Never persisted" },
    })).toThrow("request not found");
    expect(store.listSkills("local")).toHaveLength(skillCountBeforeRetirement);

    const repeated = await app.request("/api/multiremi/daemons/daemon-retire/retire", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: "local", expected_snapshot: currentPlan.snapshot }),
    });
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ status: "retired", already_retired: true });
  });

  it("deletes an Issue workspace explicitly instead of relying on database cascades", () => {
    const store = createStore();
    const runtime = store.registerRuntime({
      id: "rt_issue_delete_cleanup",
      name: "Issue delete cleanup",
      provider: "claude",
      workspaceId: "local",
      daemonId: "daemon-issue-delete",
    });
    const issue = store.createIssue({ title: "Delete checkout", workspaceId: "local" });
    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: runtime.id,
      rootPath: "/work/delete-me",
      branchName: `agent/${issue.key}`,
      status: "in_use",
    });

    expect(store.getDaemonRetirementPlan("local", "daemon-issue-delete").canRetire).toBeFalse();
    expect(store.deleteIssue(issue.id)).toBeFalse();
    store.markIssueWorkspaceCleaned({
      issueId: issue.id,
      runtimeId: runtime.id,
      ...readyArchiveBinding(store, issue.id, runtime.id),
    });
    expect(store.deleteIssue(issue.id)).toBeTrue();
    expect(store.getIssueWorkspace(issue.id)).toBeNull();
    expect(Number((db!.query(
      "SELECT COUNT(*) AS count FROM multiremi_issue_workspaces WHERE issue_id = ?",
    ).get(issue.id) as any).count)).toBe(0);
    expect(store.getDaemonRetirementPlan("local", "daemon-issue-delete").canRetire).toBeTrue();
  });

  it("changes the retirement snapshot for every cleanup-only Runtime state family", () => {
    const store = createStore();
    const runtime = store.registerRuntime({
      id: "rt_snapshot_cleanup",
      name: "Snapshot cleanup runtime",
      provider: "claude",
      workspaceId: "local",
      daemonId: "daemon-snapshot",
    });
    const agent = store.createAgent({ name: "Snapshot agent", provider: "claude", workspaceId: "local" });
    const issue = store.createIssue({ title: "Snapshot issue", workspaceId: "local" });
    const session = store.getOrCreateDefaultIssueSession(issue.id);

    let plan = store.getDaemonRetirementPlan("local", "daemon-snapshot");
    const initialSnapshot = plan.snapshot;

    store.getOrCreateSessionAgentLane(session.id, agent.id);
    db!.run(
      "UPDATE multiremi_session_agent_lanes SET runtime_id = ? WHERE session_id = ? AND agent_id = ?",
      [runtime.id, session.id, agent.id],
    );
    plan = store.getDaemonRetirementPlan("local", "daemon-snapshot");
    expect(plan.snapshot).not.toBe(initialSnapshot);
    expect(plan.impact.sessionLanesReset).toBe(1);
    const laneSnapshot = plan.snapshot;

    const chat = store.createChatSession({ agentId: agent.id, title: "Snapshot chat", workspaceId: "local" });
    db!.run(
      "UPDATE multiremi_chat_sessions SET session_runtime_id = ? WHERE id = ?",
      [runtime.id, chat.id],
    );
    plan = store.getDaemonRetirementPlan("local", "daemon-snapshot");
    expect(plan.snapshot).not.toBe(laneSnapshot);
    expect(plan.impact.chatSessionsReset).toBe(1);
    const chatSnapshot = plan.snapshot;

    store.createRuntimeModelListRequest(runtime.id);
    plan = store.getDaemonRetirementPlan("local", "daemon-snapshot");
    expect(plan.snapshot).not.toBe(chatSnapshot);
    const auxiliarySnapshot = plan.snapshot;

    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: runtime.id,
      rootPath: "/work/snapshot",
      branchName: `agent/${issue.key}`,
      status: "ready",
    });
    store.markIssueWorkspaceCleaned({
      issueId: issue.id,
      runtimeId: runtime.id,
      ...readyArchiveBinding(store, issue.id, runtime.id),
    });
    plan = store.getDaemonRetirementPlan("local", "daemon-snapshot");
    expect(plan.snapshot).not.toBe(auxiliarySnapshot);
    expect(plan.canRetire).toBeTrue();
  });
});
