// The compatibility surface the upstream (Go) clients still call: register/deregister,
// local user + workspace, invitations, config/cli token, health, cloud runtime,
// billing/lark/chat batches, and the linked-resource console workflows.
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, db, metricValue, resetMultiremiTestEnv, workspaceRepoVersion } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Multiremi API — Go server compatibility endpoints", () => {
  it("serves original daemon register and deregister endpoints", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });

    const invalidRegisterJson = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidRegisterJson.status).toBe(400);
    expect(await invalidRegisterJson.json()).toEqual({ error: "invalid request body" });

    const missing = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ daemon_id: "daemon-missing", runtimes: [{ type: "codex" }] }),
    });
    expect(missing.status).toBe(200);
    expect(await missing.json()).toMatchObject({
      runtimes: [{
        workspace_id: "local",
        daemon_id: "daemon-missing",
        provider: "codex",
      }],
    });

    const camelRegister = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "local", daemonId: "daemon-camel", runtimes: [{ type: "codex" }] }),
    });
    expect(camelRegister.status).toBe(400);
    expect(await camelRegister.json()).toEqual({ error: "daemon_id is required" });

    const invalidDeregister = await app.request("/api/daemon/deregister", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtime_ids: "rt_not_array" }),
    });
    expect(invalidDeregister.status).toBe(400);

    const invalidDeregisterJson = await app.request("/api/daemon/deregister", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidDeregisterJson.status).toBe(400);
    expect(await invalidDeregisterJson.json()).toEqual({ error: "invalid request body" });

    const camelDeregister = await app.request("/api/daemon/deregister", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtimeIds: ["rt_camel_alias"] }),
    });
    expect(camelDeregister.status).toBe(400);
    expect(await camelDeregister.json()).toEqual({ error: "runtime_ids is required" });

    const missingWorkspaceRepos = await app.request("/api/daemon/workspaces/missing/repos");
    expect(missingWorkspaceRepos.status).toBe(404);

    const missingWorkspaceRegister = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: "missing",
        daemon_id: "daemon-missing-workspace",
        runtimes: [{ type: "codex" }],
      }),
    });
    expect(missingWorkspaceRegister.status).toBe(404);

    store.ensureLocalWorkspace();
    store.updateWorkspace("local", {
      settings: { coauthor_enabled: true },
      repos: [
        { url: "git@example.com:team/api.git", description: "API" },
        { url: "  git@example.com:team/web.git  ", description: " Web " },
        { url: "git@example.com:team/api.git", description: "duplicate ignored" },
        { url: " " },
        "not-a-repo",
      ],
    });
    const expectedRepos = [
      { url: "git@example.com:team/api.git", description: "API" },
      { url: "git@example.com:team/web.git", description: " Web " },
    ];
    const expectedReposVersion = workspaceRepoVersion(expectedRepos.map((repo) => repo.url));

    const unsupportedProvider = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: "local", daemon_id: "daemon-provider", runtimes: [{ type: "gemini" }] }),
    });
    expect(unsupportedProvider.status).toBe(400);
    expect(await unsupportedProvider.json()).toEqual({ error: "Unsupported Multiremi runtime provider: gemini" });
    expect(store.listRuntimes().some((runtime) => runtime.provider === "gemini")).toBe(false);

    const camelProviderAlias = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: "local", daemon_id: "daemon-provider-alias", runtimes: [{ provider: "codex" }] }),
    });
    expect(camelProviderAlias.status).toBe(400);
    expect(await camelProviderAlias.json()).toEqual({ error: "Unsupported Multiremi runtime provider: unknown" });
    expect(store.listRuntimes().some((runtime) => runtime.daemonId === "daemon-provider-alias")).toBe(false);

    const camelMetadataRegister = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "daemon-camel-metadata",
        deviceName: "Ignored Laptop",
        cliVersion: "ignored-cli",
        launchedBy: "ignored-launcher",
        runtimes: [{ type: "codex", version: "0.1.0" }],
      }),
    });
    expect(camelMetadataRegister.status).toBe(200);
    const camelMetadataRuntime = (await camelMetadataRegister.json()).runtimes[0];
    expect(camelMetadataRuntime.device_info).toBe("0.1.0");
    expect(camelMetadataRuntime.metadata).toMatchObject({
      version: "0.1.0",
      cli_version: "",
      launched_by: "",
    });

    const registered = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "daemon-1",
        device_name: "Laptop",
        cli_version: "0.2.0",
        launched_by: "desktop",
        runtimes: [
          { name: "Codex local", type: "codex", version: "1.0.0", status: "online" },
          { type: "claude", version: "2.0.0", status: "offline" },
        ],
      }),
    });
    const registeredBody = await registered.json();

    expect(registered.status).toBe(200);
    expect(registeredBody.repos).toEqual(expectedRepos);
    expect(registeredBody.repos_version).toBe(expectedReposVersion);
    expect(registeredBody.settings).toEqual({ coauthor_enabled: true });
    expect(registeredBody.runtimes).toHaveLength(2);
    expect(registeredBody.runtimes[0]).toMatchObject({
      workspace_id: "local",
      daemon_id: "daemon-1",
      runtime_mode: "local",
      provider: "codex",
      launch_header: "Codex",
      device_info: "Laptop · 1.0.0",
      metadata: {
        version: "1.0.0",
        cli_version: "0.2.0",
        launched_by: "desktop",
      },
      visibility: "private",
    });
    expect(store.getRuntime(registeredBody.runtimes[0].id)?.status).toBe("online");
    expect(store.getRuntime(registeredBody.runtimes[0].id)?.daemonId).toBe("daemon-1");
    expect(store.getRuntime(registeredBody.runtimes[0].id)?.runtimeMode).toBe("local");
    expect(store.getRuntime(registeredBody.runtimes[0].id)?.deviceInfo).toBe("Laptop · 1.0.0");
    expect(store.getRuntime(registeredBody.runtimes[0].id)?.metadata).toMatchObject({
      version: "1.0.0",
      cli_version: "0.2.0",
      launched_by: "desktop",
    });
    expect(store.getRuntime(registeredBody.runtimes[1].id)?.status).toBe("offline");
    expect(store.getRuntime(registeredBody.runtimes[1].id)?.daemonId).toBe("daemon-1");

    const camelDeregisterRegistered = await app.request("/api/daemon/deregister", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtimeIds: [registeredBody.runtimes[0].id] }),
    });
    expect(camelDeregisterRegistered.status).toBe(400);
    expect(store.getRuntime(registeredBody.runtimes[0].id)?.status).toBe("online");

    const reconnected = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "daemon-1",
        runtimes: [{ type: "codex", version: "1.0.1" }],
      }),
    });
    const reconnectedBody = await reconnected.json();
    expect(reconnectedBody.runtimes[0].id).toBe(registeredBody.runtimes[0].id);
    expect(reconnectedBody.runtimes[0].metadata.version).toBe("1.0.1");
    expect(store.getRuntime(registeredBody.runtimes[0].id)?.deviceInfo).toBe("1.0.1");
    expect(store.getRuntime(registeredBody.runtimes[0].id)?.metadata).toMatchObject({
      version: "1.0.1",
      cli_version: "",
      launched_by: "",
    });

    const legacyRegistered = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "LegacyHost.local",
        runtimes: [{ type: "codex", version: "0.9.0" }],
      }),
    });
    expect(legacyRegistered.status).toBe(200);
    const legacyRegisteredBody = await legacyRegistered.json();
    const legacyRuntimeId = legacyRegisteredBody.runtimes[0].id;
    const legacyAgent = store.createAgent({ name: "Legacy Codex", provider: "codex", runtimeId: legacyRuntimeId });
    const legacyTask = store.createTask({ agentId: legacyAgent.id, prompt: "legacy runtime task" });
    const legacyClaim = await app.request(`/api/daemon/runtimes/${legacyRuntimeId}/tasks/claim`, { method: "POST" });
    expect(legacyClaim.status).toBe(200);
    expect((await legacyClaim.json()).task.id).toBe(legacyTask.id);
    expect(store.getTask(legacyTask.id)?.runtimeId).toBe(legacyRuntimeId);
    expect(store.getAgent(legacyAgent.id)?.runtimeId).toBe(legacyRuntimeId);

    const duplicateLegacyRuntime = store.registerRuntime({
      id: "rt_legacy_case_duplicate",
      name: "Legacy duplicate",
      provider: "codex",
      workspaceId: "local",
      daemonId: "legacyhost.local",
    });
    const duplicateLegacyAgent = store.createAgent({
      name: "Legacy Duplicate Codex",
      provider: "codex",
      runtimeId: duplicateLegacyRuntime.id,
    });
    const duplicateLegacyTask = store.createTask({ agentId: duplicateLegacyAgent.id, prompt: "duplicate legacy runtime task" });
    expect(duplicateLegacyTask.runtimeId).toBe(duplicateLegacyRuntime.id);

    const camelLegacyIgnored = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "stable-camel-legacy",
        legacyDaemonIds: ["LegacyHost.local", "legacyhost.local"],
        runtimes: [{ type: "codex", version: "1.0.5" }],
      }),
    });
    expect(camelLegacyIgnored.status).toBe(200);
    const camelLegacyRuntimeId = (await camelLegacyIgnored.json()).runtimes[0].id;
    expect(store.getRuntime(camelLegacyRuntimeId)?.legacyDaemonId).toBeNull();
    expect(store.getRuntime(camelLegacyRuntimeId)?.metadata.legacy_runtime_merges).toBeUndefined();
    expect(store.getTask(legacyTask.id)?.runtimeId).toBe(legacyRuntimeId);
    expect(store.getAgent(legacyAgent.id)?.runtimeId).toBe(legacyRuntimeId);
    expect(store.getTask(duplicateLegacyTask.id)?.runtimeId).toBe(duplicateLegacyRuntime.id);
    expect(store.getAgent(duplicateLegacyAgent.id)?.runtimeId).toBe(duplicateLegacyRuntime.id);

    const migrated = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "stable-daemon",
        legacy_daemon_ids: ["LegacyHost.local", "legacyhost.local", " "],
        runtimes: [{ type: "codex", version: "1.1.0" }],
      }),
    });
    expect(migrated.status).toBe(200);
    const migratedBody = await migrated.json();
    const migratedRuntimeId = migratedBody.runtimes[0].id;
    expect(migratedRuntimeId).not.toBe(legacyRuntimeId);
    expect(store.getTask(legacyTask.id)?.runtimeId).toBe(migratedRuntimeId);
    expect(store.getAgent(legacyAgent.id)?.runtimeId).toBe(migratedRuntimeId);
    expect(store.getTask(duplicateLegacyTask.id)?.runtimeId).toBe(migratedRuntimeId);
    expect(store.getAgent(duplicateLegacyAgent.id)?.runtimeId).toBe(migratedRuntimeId);
    expect(store.getRuntime(migratedRuntimeId)?.daemonId).toBe("stable-daemon");
    expect(store.getRuntime(migratedRuntimeId)?.legacyDaemonId).toBe("LegacyHost.local");
    expect(store.getRuntime(legacyRuntimeId)).toBeNull();
    expect(store.getRuntime(duplicateLegacyRuntime.id)).toBeNull();
    const mergeAudit = store.getRuntime(migratedRuntimeId)?.metadata.legacy_runtime_merges as Array<Record<string, unknown>>;
    expect(mergeAudit).toHaveLength(2);
    expect(mergeAudit.map((entry) => entry.old_runtime_id).sort()).toEqual([duplicateLegacyRuntime.id, legacyRuntimeId].sort());
    expect(mergeAudit.every((entry) => entry.agents_reassigned === 1 && entry.tasks_reassigned === 1)).toBe(true);

    const migratedReconnect = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "stable-daemon",
        runtimes: [{ type: "codex", version: "1.1.1" }],
      }),
    });
    expect(migratedReconnect.status).toBe(200);
    expect((store.getRuntime(migratedRuntimeId)?.metadata.legacy_runtime_merges as Array<unknown>)).toHaveLength(2);

    const deregistered = await app.request("/api/daemon/deregister", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtime_ids: [registeredBody.runtimes[0].id] }),
    });
    expect(deregistered.status).toBe(200);
    expect((await deregistered.json()).status).toBe("ok");
    expect(store.getRuntime(registeredBody.runtimes[0].id)?.status).toBe("offline");

    const repos = await app.request("/api/daemon/workspaces/local/repos");
    const reposBody = await repos.json();
    expect(repos.status).toBe(200);
    expect(reposBody).toEqual({
      workspace_id: "local",
      repos: expectedRepos,
      repos_version: expectedReposVersion,
      settings: { coauthor_enabled: true },
      relay: {
        claude: null,
        codex: null,
        model_discovery: false,
      },
    });

    store.updateWorkspace("local", {
      repos: [
        { url: "git@example.com:team/web.git", description: "frontend" },
        { url: "git@example.com:team/api.git", description: "backend" },
      ],
    });
    const reorderedRepos = await app.request("/api/daemon/workspaces/local/repos");
    const reorderedReposBody = await reorderedRepos.json();
    expect(reorderedRepos.status).toBe(200);
    expect(reorderedReposBody.repos_version).toBe(expectedReposVersion);

    store.updateWorkspace("local", {
      repos: [
        { url: "git@example.com:team/api.git", description: "backend" },
        { url: "git@example.com:team/mobile.git", description: "mobile" },
      ],
    });
    const changedRepos = await app.request("/api/daemon/workspaces/local/repos");
    const changedReposBody = await changedRepos.json();
    expect(changedRepos.status).toBe(200);
    expect(changedReposBody.repos_version).toBe(workspaceRepoVersion([
      "git@example.com:team/api.git",
      "git@example.com:team/mobile.git",
    ]));
    expect(changedReposBody.repos_version).not.toBe(expectedReposVersion);
  });

  it("serves local user and workspace compatibility endpoints", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });

    const me = await app.request("/api/me");
    const meBody = await me.json();
    expect(me.status).toBe(200);
    expect(meBody).toMatchObject({
      id: "local",
      email: "local@multiremi.local",
      onboarding_questionnaire: {},
      profile_description: "",
    });

    const invalidLanguage = await app.request("/api/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: "<script>" }),
    });
    expect(invalidLanguage.status).toBe(400);

    const updated = await app.request("/api/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Local Operator",
        language: "zh-Hans",
        timezone: "Asia/Shanghai",
        profile_description: "Works locally",
      }),
    });
    const updatedBody = await updated.json();
    expect(updated.status).toBe(200);
    expect(updatedBody.name).toBe("Local Operator");
    expect(updatedBody.language).toBe("zh-Hans");
    expect(updatedBody.timezone).toBe("Asia/Shanghai");
    expect(updatedBody.profile_description).toBe("Works locally");

    const onboarding = await app.request("/api/me/onboarding", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questionnaire: { source: "codex", role: "builder" } }),
    });
    expect((await onboarding.json()).onboarding_questionnaire).toEqual({ source: "codex", role: "builder" });

    const completed = await app.request("/api/me/onboarding/complete", { method: "POST" });
    expect((await completed.json()).onboarded_at).toBeString();

    const initialWorkspaces = await app.request("/api/workspaces");
    const initialWorkspacesBody = await initialWorkspaces.json();
    expect(initialWorkspaces.status).toBe(200);
    expect(initialWorkspacesBody[0]).toMatchObject({
      id: "local",
      slug: "local",
      issue_prefix: "MUL",
    });

    const created = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Product Team", slug: "product-team", description: "Builds product" }),
    });
    const createdBody = await created.json();
    expect(created.status).toBe(201);
    expect(createdBody.slug).toBe("product-team");
    expect(createdBody.issue_prefix).toBe("PRO");

    const duplicate = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Product Team", slug: "product-team" }),
    });
    expect(duplicate.status).toBe(409);

    const detail = await app.request(`/api/workspaces/${encodeURIComponent(createdBody.id)}`);
    expect((await detail.json()).name).toBe("Product Team");

    const members = await app.request(`/api/workspaces/${encodeURIComponent(createdBody.id)}/members`);
    const membersBody = await members.json();
    expect(membersBody[0]).toMatchObject({
      workspace_id: createdBody.id,
      user_id: "local",
      role: "owner",
      created_at: expect.any(String),
    });
    expect(membersBody[0].workspaceId).toBeUndefined();
    expect(membersBody[0].createdAt).toBeUndefined();
    expect(membersBody[0].email).toBeUndefined();

    const lastOwnerDemote = await app.request(`/api/workspaces/${encodeURIComponent(createdBody.id)}/members/${encodeURIComponent(membersBody[0].id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "admin" }),
    });
    expect(lastOwnerDemote.status).toBe(400);
    expect(await lastOwnerDemote.json()).toEqual({ error: "workspace must have at least one owner" });

    const backupOwner = store.createWorkspaceMember({
      workspaceId: createdBody.id,
      name: "Product Owner Backup",
      email: "backup-owner@example.com",
      role: "owner",
    });
    const missingRoleUpdate = await app.request(`/api/workspaces/${encodeURIComponent(createdBody.id)}/members/${encodeURIComponent(membersBody[0].id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Ignored by Go role contract" }),
    });
    expect(missingRoleUpdate.status).toBe(400);
    expect(await missingRoleUpdate.json()).toEqual({ error: "role is required" });

    const invalidRoleUpdate = await app.request(`/api/workspaces/${encodeURIComponent(createdBody.id)}/members/${encodeURIComponent(membersBody[0].id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "reviewer" }),
    });
    expect(invalidRoleUpdate.status).toBe(400);
    expect(await invalidRoleUpdate.json()).toEqual({ error: "invalid member role" });

    const updatedMember = await app.request(`/api/workspaces/${encodeURIComponent(createdBody.id)}/members/${encodeURIComponent(membersBody[0].id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "admin" }),
    });
    expect(updatedMember.status).toBe(200);
    const updatedMemberBody = await updatedMember.json();
    expect(updatedMemberBody).toMatchObject({
      id: membersBody[0].id,
      workspace_id: createdBody.id,
      user_id: "local",
      role: "admin",
      name: expect.any(String),
      email: "local@multiremi.local",
      avatar_url: null,
    });
    expect(updatedMemberBody.workspaceId).toBeUndefined();
    expect(updatedMemberBody.createdAt).toBeUndefined();

    const deleteOnlyOwner = await app.request(`/api/workspaces/${encodeURIComponent(createdBody.id)}/members/${encodeURIComponent(backupOwner.id)}`, {
      method: "DELETE",
    });
    expect(deleteOnlyOwner.status).toBe(403);
    expect(await deleteOnlyOwner.json()).toEqual({ error: "insufficient permissions" });

    const githubConnect = await app.request(`/api/workspaces/${encodeURIComponent(createdBody.id)}/github/connect`);
    expect(await githubConnect.json()).toEqual({ configured: false });
    const githubInstallations = await app.request(`/api/workspaces/${encodeURIComponent(createdBody.id)}/github/installations`);
    expect(await githubInstallations.json()).toEqual({
      installations: [],
      configured: false,
      can_manage: true,
    });

    const deletedMember = await app.request(`/api/workspaces/${encodeURIComponent(createdBody.id)}/members/${encodeURIComponent(membersBody[0].id)}`, {
      method: "DELETE",
    });
    expect(deletedMember.status).toBe(204);

    const invitations = await app.request("/api/invitations");
    expect(await invitations.json()).toEqual([]);
  });

  it("serves workspace, runtime, auth, webhook, and setup compatibility fallbacks", async () => {
    process.env.MULTIREMI_ALLOW_EMAIL_CODE_LOGIN = "1";
    const store = createStore();
    const workspace = store.createWorkspace({ name: "Fallback Team", slug: "fallback-team" });
    const runtime = store.registerRuntime({ name: "Fallback Runtime", provider: "codex", workspaceId: workspace.id });
    const app = createMultiremiApp({ store });

    const updated = await app.request(`/api/workspaces/${workspace.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Fallback Renamed", issue_prefix: "FB" }),
    });
    expect((await updated.json()).issue_prefix).toBe("FB");

    const leave = await app.request(`/api/workspaces/${workspace.id}/leave`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member_id: `mem_${workspace.id}_local` }),
    });
    expect(leave.status).toBe(400);
    expect(await leave.json()).toEqual({ error: "workspace must have at least one owner" });
    store.createWorkspaceMember({ workspaceId: workspace.id, name: "Leave Backup Owner", email: "leave-owner@example.com", role: "owner" });
    const leaveWithBackup = await app.request(`/api/workspaces/${workspace.id}/leave`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member_id: `mem_${workspace.id}_local` }),
    });
    expect(leaveWithBackup.status).toBe(204);

    const sentCode = await app.request("/auth/send-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "Compat@Example.com", name: "Compat User" }),
    });
    const sentCodeBody = await sentCode.json();
    expect(sentCode.status).toBe(200);
    expect(sentCodeBody.email).toBe("compat@example.com");
    expect(sentCodeBody.code).toMatch(/^\d{6}$/);
    const verifiedCode = await app.request("/auth/verify-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "compat@example.com", code: sentCodeBody.code }),
    });
    const verifiedCodeBody = await verifiedCode.json();
    expect(verifiedCode.status).toBe(200);
    expect(verifiedCodeBody.access_token).toStartWith("mul_");
    expect(verifiedCodeBody.user.email).toBe("compat@example.com");
    const googleLogin = await app.request("/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "google@example.com", name: "Google User" }),
    });
    const googleLoginBody = await googleLogin.json();
    expect(googleLogin.status).toBe(200);
    expect(googleLoginBody.user.name).toBe("Google User");
    const realtimeHealth = await app.request("/health/realtime");
    expect(await realtimeHealth.json()).toMatchObject({ enabled: true, connections: 0, transport: "websocket" });
    expect((await (await app.request("/api/github/setup")).json()).configured).toBe(false);
    expect((await app.request("/api/webhooks/github", { method: "POST" })).status).toBe(202);
    expect((await app.request("/api/webhooks/autopilots/missing", { method: "POST" })).status).toBe(404);
    const wsFallback = await app.request("/api/daemon/ws");
    expect(wsFallback.status).toBe(426);
    expect((await wsFallback.json()).upgrade_required).toBe(true);

    expect((await app.request(`/api/runtimes/${runtime.id}/activity`)).status).toBe(200);
    const deletedRuntime = await app.request(`/api/runtimes/${runtime.id}`, { method: "DELETE" });
    expect(deletedRuntime.status).toBe(200);
    expect(await deletedRuntime.json()).toEqual({ status: "ok" });

    const removable = store.createWorkspace({ name: "Removable Team", slug: "removable-team" });
    expect((await app.request(`/api/workspaces/${removable.id}`, { method: "DELETE" })).status).toBe(204);
    delete process.env.MULTIREMI_ALLOW_EMAIL_CODE_LOGIN;
  });

  it("serves local workspace invitation compatibility endpoints", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const workspace = store.createWorkspace({ name: "Invite Team", slug: "invite-team" });

    const invalid = await app.request(`/api/workspaces/${workspace.id}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "member" }),
    });
    expect(invalid.status).toBe(400);

    const created = await app.request(`/api/workspaces/${workspace.id}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "teammate@example.com", role: "admin" }),
    });
    const createdBody = await created.json();
    expect(created.status).toBe(201);
    expect(createdBody).toMatchObject({
      workspace_id: workspace.id,
      inviter_id: "local",
      invitee_email: "teammate@example.com",
      role: "admin",
      status: "pending",
      workspace_name: "Invite Team",
      inviter_email: "local@multiremi.local",
    });

    const duplicate = await app.request(`/api/workspaces/${workspace.id}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "teammate@example.com", role: "member" }),
    });
    expect(duplicate.status).toBe(409);

    const workspaceInvitations = await app.request(`/api/workspaces/${workspace.id}/invitations`);
    const workspaceInvitationsBody = await workspaceInvitations.json();
    expect(workspaceInvitationsBody[0].id).toBe(createdBody.id);

    const fetched = await app.request(`/api/invitations/${createdBody.id}`);
    expect((await fetched.json()).invitee_email).toBe("teammate@example.com");

    const revoked = await app.request(`/api/workspaces/${workspace.id}/invitations/${createdBody.id}`, { method: "DELETE" });
    expect(revoked.status).toBe(204);

    db!.run(
      `INSERT INTO multiremi_workspace_invitations (
        id, workspace_id, inviter_id, invitee_email, invitee_user_id, role, status, expires_at, created_at, updated_at
      ) VALUES (?, ?, 'local', 'expired@example.com', NULL, 'member', 'pending', ?, ?, ?)`,
      ["inv_stale_pending", workspace.id, "2026-06-04T00:00:00.000Z", "2026-05-28T00:00:00.000Z", "2026-05-28T00:00:00.000Z"],
    );
    const pendingWithoutExpired = await app.request(`/api/workspaces/${workspace.id}/invitations`);
    expect((await pendingWithoutExpired.json()).map((invitation: any) => invitation.id)).not.toContain("inv_stale_pending");
    const reinvitedAfterExpiry = await app.request(`/api/workspaces/${workspace.id}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "expired@example.com", role: "member" }),
    });
    expect(reinvitedAfterExpiry.status).toBe(201);
    expect(store.getInvitation("inv_stale_pending")?.status).toBe("expired");
    expect((await reinvitedAfterExpiry.json()).status).toBe("pending");

    db!.run(
      `INSERT INTO multiremi_workspaces (
        id, name, slug, settings, repos, issue_prefix, created_at, updated_at
      ) VALUES ('ws_external_invite', 'External Invite', 'external-invite', '{}', '[]', 'EXT', '2026-06-04T00:00:00.000Z', '2026-06-04T00:00:00.000Z')`,
    );
    store.createWorkspaceMember({
      id: "external-admin",
      workspaceId: "ws_external_invite",
      name: "External Admin",
      email: "external-admin@example.com",
      role: "admin",
    });
    const externalAdminToken = await store.createAccessToken({
      name: "External Admin",
      type: "pat",
      workspaceId: "ws_external_invite",
      userId: "external-admin",
    });
    const localInviteeToken = await store.createAccessToken({
      name: "Local Invitee",
      type: "pat",
      workspaceId: "ws_external_invite",
      userId: "local",
    });
    const authedApp = createMultiremiApp({ store, authToken: "root-secret" });
    const authedJsonHeaders = (token: string) => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` });
    const authedHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

    db!.run(
      `INSERT INTO multiremi_workspace_invitations (
        id, workspace_id, inviter_id, invitee_email, invitee_user_id, role, status, expires_at, created_at, updated_at
      ) VALUES ('inv_expired_accept', 'ws_external_invite', 'local', 'local@multiremi.local', 'local', 'member', 'pending', '2026-06-04T00:00:00.000Z', '2026-05-28T00:00:00.000Z', '2026-05-28T00:00:00.000Z')`,
    );
    const expiredAccept = await app.request("/api/invitations/inv_expired_accept/accept", { method: "POST" });
    expect(expiredAccept.status).toBe(410);
    expect(await expiredAccept.json()).toEqual({ error: "invitation has expired" });

    const acceptInvite = await authedApp.request("/api/workspaces/ws_external_invite/members", {
      method: "POST",
      headers: authedJsonHeaders(externalAdminToken.token),
      body: JSON.stringify({ email: "local@multiremi.local", role: "member" }),
    });
    const acceptInviteBody = await acceptInvite.json();
    const myInvites = await authedApp.request("/api/invitations", { headers: authedHeaders(localInviteeToken.token) });
    expect((await myInvites.json())[0].id).toBe(acceptInviteBody.id);

    const accepted = await authedApp.request(`/api/invitations/${acceptInviteBody.id}/accept`, {
      method: "POST",
      headers: authedHeaders(localInviteeToken.token),
    });
    expect(accepted.status).toBe(200);
    const acceptedBody = await accepted.json();
    expect(acceptedBody).toMatchObject({
      workspace_id: "ws_external_invite",
      user_id: "local",
      role: "member",
      name: "Local User",
      email: "local@multiremi.local",
      avatar_url: null,
    });
    expect(typeof acceptedBody.created_at).toBe("string");
    expect(acceptedBody.status).toBeUndefined();
    expect(acceptedBody.workspaceId).toBeUndefined();
    expect(store.listWorkspaceMembers("ws_external_invite").some((member) => member.email === "local@multiremi.local")).toBe(true);

    db!.run(
      `INSERT INTO multiremi_workspace_invitations (
        id, workspace_id, inviter_id, invitee_email, invitee_user_id, role, status, expires_at, created_at, updated_at
      ) VALUES ('inv_already_member_accept', 'ws_external_invite', 'local', 'local@multiremi.local', 'local', 'member', 'pending', '2030-06-04T00:00:00.000Z', '2026-06-04T00:00:00.000Z', '2026-06-04T00:00:00.000Z')`,
    );
    const alreadyMemberAccept = await app.request("/api/invitations/inv_already_member_accept/accept", { method: "POST" });
    expect(alreadyMemberAccept.status).toBe(409);
    expect(await alreadyMemberAccept.json()).toEqual({ error: "you are already a member of this workspace" });
    expect(store.getInvitation("inv_already_member_accept")?.status).toBe("pending");

    const existingMemberInvite = await authedApp.request("/api/workspaces/ws_external_invite/members", {
      method: "POST",
      headers: authedJsonHeaders(externalAdminToken.token),
      body: JSON.stringify({ email: "local@multiremi.local", role: "admin" }),
    });
    expect(existingMemberInvite.status).toBe(409);
  });

  it("gates Go-compatible workspace member and invitation mutations by actor role", async () => {
    const store = createStore();
    const workspace = store.createWorkspace({ name: "Guard Team", slug: "guard-team" });
    const owner = store.getWorkspaceMember(`mem_${workspace.id}_local`)!;
    store.createWorkspaceMember({
      id: "guard-admin",
      workspaceId: workspace.id,
      name: "Guard Admin",
      email: "guard-admin@example.com",
      role: "admin",
    });
    const plain = store.createWorkspaceMember({
      id: "guard-member",
      workspaceId: workspace.id,
      name: "Guard Member",
      email: "guard-member@example.com",
      role: "member",
    });
    const target = store.createWorkspaceMember({
      id: "guard-target",
      workspaceId: workspace.id,
      name: "Guard Target",
      email: "guard-target@example.com",
      role: "member",
    });
    const ownerToken = await store.createAccessToken({ name: "Guard Owner", type: "pat", workspaceId: workspace.id, userId: "local" });
    const adminToken = await store.createAccessToken({ name: "Guard Admin", type: "pat", workspaceId: workspace.id, userId: "guard-admin" });
    const memberToken = await store.createAccessToken({ name: "Guard Member", type: "pat", workspaceId: workspace.id, userId: plain.id });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const jsonHeaders = (token: string) => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` });
    const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

    const memberList = await app.request(`/api/workspaces/${workspace.id}/members`, { headers: authHeaders(memberToken.token) });
    expect(memberList.status).toBe(200);

    const memberInvite = await app.request(`/api/workspaces/${workspace.id}/members`, {
      method: "POST",
      headers: jsonHeaders(memberToken.token),
      body: JSON.stringify({ email: "member-invite@example.com", role: "member" }),
    });
    expect(memberInvite.status).toBe(403);
    expect(await memberInvite.json()).toEqual({ error: "insufficient permissions" });

    const adminInvite = await app.request(`/api/workspaces/${workspace.id}/members`, {
      method: "POST",
      headers: jsonHeaders(adminToken.token),
      body: JSON.stringify({ email: "admin-invite@example.com", role: "member" }),
    });
    expect(adminInvite.status).toBe(201);
    const adminInviteBody = await adminInvite.json();

    const memberRevoke = await app.request(`/api/workspaces/${workspace.id}/invitations/${adminInviteBody.id}`, {
      method: "DELETE",
      headers: authHeaders(memberToken.token),
    });
    expect(memberRevoke.status).toBe(403);
    expect(await memberRevoke.json()).toEqual({ error: "insufficient permissions" });

    const memberUpdate = await app.request(`/api/workspaces/${workspace.id}/members/${target.id}`, {
      method: "PATCH",
      headers: jsonHeaders(memberToken.token),
      body: JSON.stringify({ role: "admin" }),
    });
    expect(memberUpdate.status).toBe(403);

    const adminPromoteOwner = await app.request(`/api/workspaces/${workspace.id}/members/${target.id}`, {
      method: "PATCH",
      headers: jsonHeaders(adminToken.token),
      body: JSON.stringify({ role: "owner" }),
    });
    expect(adminPromoteOwner.status).toBe(403);
    expect(await adminPromoteOwner.json()).toEqual({ error: "insufficient permissions" });

    const ownerDeleteOnlyOwner = await app.request(`/api/workspaces/${workspace.id}/members/${owner.id}`, {
      method: "DELETE",
      headers: authHeaders(ownerToken.token),
    });
    expect(ownerDeleteOnlyOwner.status).toBe(400);
    expect(await ownerDeleteOnlyOwner.json()).toEqual({ error: "workspace must have at least one owner" });

    const adminDeleteOwner = await app.request(`/api/workspaces/${workspace.id}/members/${owner.id}`, {
      method: "DELETE",
      headers: authHeaders(adminToken.token),
    });
    expect(adminDeleteOwner.status).toBe(403);
    expect(await adminDeleteOwner.json()).toEqual({ error: "insufficient permissions" });

    const adminUpdateMember = await app.request(`/api/workspaces/${workspace.id}/members/${target.id}`, {
      method: "PATCH",
      headers: jsonHeaders(adminToken.token),
      body: JSON.stringify({ role: "admin" }),
    });
    expect(adminUpdateMember.status).toBe(200);

    const ownerRevoke = await app.request(`/api/workspaces/${workspace.id}/invitations/${adminInviteBody.id}`, {
      method: "DELETE",
      headers: authHeaders(ownerToken.token),
    });
    expect(ownerRevoke.status).toBe(204);

    const forgedLeave = await app.request(`/api/workspaces/${workspace.id}/leave`, {
      method: "POST",
      headers: jsonHeaders(memberToken.token),
      body: JSON.stringify({ member_id: owner.id }),
    });
    expect(forgedLeave.status).toBe(204);
    expect(store.getWorkspaceMember(owner.id)?.archivedAt).toBeNull();
    expect(store.getWorkspaceMember(plain.id)?.archivedAt).toBeString();
  });

  it("serves config, cli token, logout, and onboarding bootstrap compatibility endpoints", async () => {
    const store = createStore();
    const workspace = store.createWorkspace({ name: "Onboarding Team", slug: "onboarding-team" });
    const runtime = store.registerRuntime({ name: "Codex Runtime", provider: "codex", workspaceId: workspace.id });
    const app = createMultiremiApp({ store });

    const config = await app.request("/api/config");
    const configBody = await config.json();
    expect(config.status).toBe(200);
    expect(configBody.allow_signup).toBe(true);
    expect(configBody.cdn_domain).toBe("");

    const cliToken = await app.request("/api/cli-token", { method: "POST" });
    const cliTokenBody = await cliToken.json();
    expect(cliToken.status).toBe(200);
    expect(cliTokenBody.token).toStartWith("mul_");

    const logout = await app.request("/auth/logout", { method: "POST" });
    expect(await logout.json()).toEqual({ message: "logged out" });

    const badWaitlist = await app.request("/api/me/onboarding/cloud-waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-email" }),
    });
    expect(badWaitlist.status).toBe(400);

    const waitlist = await app.request("/api/me/onboarding/cloud-waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "local@example.com", reason: "cloud please" }),
    });
    expect((await waitlist.json()).onboarding_questionnaire.cloud_waitlist_email).toBe("local@example.com");

    const runtimeBootstrap = await app.request("/api/me/onboarding/runtime-bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: workspace.id, runtime_id: runtime.id }),
    });
    const runtimeBootstrapBody = await runtimeBootstrap.json();
    expect(runtimeBootstrap.status).toBe(200);
    expect(runtimeBootstrapBody.workspace_id).toBe(workspace.id);
    expect(runtimeBootstrapBody.agent_id).toBe(`agt_default_${workspace.id}_codex_local`);
    expect(store.getAgent(runtimeBootstrapBody.agent_id)).toMatchObject({
      provider: "codex",
      runtimeId: null,
      workspaceId: workspace.id,
    });
    const onboardingAgentCreated = store.listAnalyticsEvents({ name: "agent_created" })[0]!;
    expect(onboardingAgentCreated.distinctId).toBe(store.getCurrentUser().id);
    expect(onboardingAgentCreated.workspaceId).toBe(workspace.id);
    expect(onboardingAgentCreated.properties).toMatchObject({
      agent_id: runtimeBootstrapBody.agent_id,
      provider: "codex",
      runtime_mode: "local",
      template: "multiremi_helper",
      is_first_agent_in_workspace: true,
      source: "manual",
    });
    expect(metricValue(store, "multiremi_agent_created_total", { runtime_mode: "local", source: "manual" })).toBe(1);
    expect(store.getIssue(runtimeBootstrapBody.issue_id)?.title).toBe("Connect your local runtime");
    expect(store.listTasks().some((task) => task.issueId === runtimeBootstrapBody.issue_id)).toBe(true);

    const noRuntimeBootstrap = await app.request("/api/me/onboarding/no-runtime-bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: workspace.id }),
    });
    const noRuntimeBootstrapBody = await noRuntimeBootstrap.json();
    expect(noRuntimeBootstrap.status).toBe(200);
    expect(store.getIssue(noRuntimeBootstrapBody.issue_id)?.title).toBe("Install a local runtime");
    expect(store.getCurrentUser().onboardedAt).toBeString();
  });

  it("serves original health, cloud runtime, issue task, subscription, and daemon polling compatibility endpoints", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const member = store.createWorkspaceMember({ id: "mem_compat", name: "Compat Member" });
    const issue = store.createIssue({
      title: "Compatibility task surface",
      workspaceId: "local",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: "local", prompt: "Run compatibility" });
    store.reportTaskUsage(task.id, [{
      provider: "codex",
      model: "gpt-5",
      inputTokens: 12,
      outputTokens: 8,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
    }]);
    const runtime = store.registerRuntime({ name: "Codex Runtime", provider: "codex", workspaceId: "local" });
    const app = createMultiremiApp({ store });

    expect((await app.request("/readyz")).status).toBe(200);
    expect((await app.request("/healthz")).status).toBe(200);
    const cloudHealth = await app.request("/api/cloud-runtime/healthz");
    expect(await cloudHealth.json()).toMatchObject({ ok: true, configured: true, mode: "local" });

    const createdCloudNode = await app.request("/api/cloud-runtime/nodes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instance_type: "g5.xlarge", name: "Local GPU", tags: { env: "test" } }),
    });
    expect(createdCloudNode.status).toBe(201);
    const createdCloudNodeBody = await createdCloudNode.json();
    expect(createdCloudNodeBody.instance_type).toBe("g5.xlarge");
    expect(createdCloudNodeBody.name).toBe("Local GPU");
    expect(createdCloudNodeBody.status).toBe("launching");
    expect(createdCloudNodeBody.tags.env).toBe("test");

    const cloudRuntime = await app.request("/api/cloud-runtime/nodes?limit=10&offset=0");
    const cloudRuntimeBody = await cloudRuntime.json();
    expect(cloudRuntime.status).toBe(200);
    expect(cloudRuntimeBody[0].id).toBe(createdCloudNodeBody.id);

    const startedCloudNode = await app.request("/api/cloud-runtime/nodes/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: createdCloudNodeBody.id }),
    });
    expect((await startedCloudNode.json()).status).toBe("running");

    const execCloudNode = await app.request("/api/cloud-runtime/nodes/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: createdCloudNodeBody.id, command: "echo ok" }),
    });
    expect((await execCloudNode.json()).stdout).toContain("echo ok");

    const deletedCloudNode = await app.request("/api/cloud-runtime/nodes", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: createdCloudNodeBody.id }),
    });
    expect(deletedCloudNode.status).toBe(204);

    const active = await app.request(`/api/issues/${issue.id}/active-task`);
    const activeBody = await active.json();
    expect(activeBody.tasks[0].id).toBe(task.id);
    expect(activeBody.tasks[0].issue_id).toBe(issue.id);

    const keyDetail = await app.request(`/api/issues/${issue.key.toLowerCase()}`);
    expect((await keyDetail.json()).id).toBe(issue.id);
    const keyActive = await app.request(`/api/issues/${issue.key}/active-task`);
    expect((await keyActive.json()).tasks[0].id).toBe(task.id);

    const runs = await app.request(`/api/issues/${issue.key}/task-runs`);
    const runsBody = await runs.json();
    expect(runsBody[0].agent_id).toBe(agent.id);

    const usage = await app.request(`/api/issues/${issue.key}/usage`);
    expect(await usage.json()).toMatchObject({
      total_input_tokens: 12,
      total_output_tokens: 8,
      total_cache_read_tokens: 3,
      total_cache_write_tokens: 2,
      task_count: 1,
    });

    const rerun = await app.request(`/api/issues/${issue.id}/rerun`, { method: "POST" });
    expect(rerun.status).toBe(202);
    expect((await rerun.json()).issue_id).toBe(issue.id);

    const subscribe = await app.request(`/api/issues/${issue.id}/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member_id: member.id }),
    });
    expect(await subscribe.json()).toEqual({ subscribed: true });
    const subscribers = await app.request(`/api/issues/${issue.id}/subscribers`);
    const subscribersBody = await subscribers.json();
    expect(subscribersBody.some((item: any) => item.user_id === member.id && item.user_type === "member")).toBe(true);
    expect(subscribersBody[0].memberId).toBeUndefined();
    const unsubscribe = await app.request(`/api/issues/${issue.id}/unsubscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member_id: member.id }),
    });
    expect(await unsubscribe.json()).toEqual({ subscribed: false });

    const pendingBeforeClaim = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/pending`);
    expect((await pendingBeforeClaim.json()).some((item: any) => item.id === task.id)).toBe(false);

    const claimed = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" });
    const claimedBody = await claimed.json();
    expect(claimedBody.task.id).toBe(task.id);
    const pendingAfterClaim = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/pending`);
    expect((await pendingAfterClaim.json()).some((item: any) =>
      item.id === task.id && item.workspace_id === "local" && item.status === "dispatched"
    )).toBe(true);
    const waiting = await app.request(`/api/daemon/tasks/${task.id}/wait-local-directory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "/tmp/compat" }),
    });
    const waitingBody = await waiting.json();
    expect(waitingBody.status).toBe("waiting_local_directory");
    expect(waitingBody.wait_reason).toBe("/tmp/compat");
    const started = await app.request(`/api/daemon/tasks/${task.id}/start`, { method: "POST" });
    const startedBody = await started.json();
    expect(startedBody.status).toBe("running");
    expect(startedBody.wait_reason ?? null).toBeNull();
    expect(startedBody.waitReason).toBeUndefined();
    await app.request(`/api/daemon/tasks/${task.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ type: "assistant", content: "compat done" }] }),
    });
    const taskPrefix = task.id.slice(0, 8);
    expect((await (await app.request(`/api/tasks/${taskPrefix}/messages`)).json())[0].content).toBe("compat done");

    const gc = await app.request(`/api/daemon/issues/${issue.key}/gc-check`);
    expect((await gc.json()).updated_at).toBeString();

    const scopedTask = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: "local", prompt: "Cancel scoped" });
    const issueScopedCancel = await app.request(`/api/issues/${issue.key}/tasks/${scopedTask.id.slice(0, 8)}/cancel`, { method: "POST" });
    const issueScopedCancelBody = await issueScopedCancel.json();
    expect(issueScopedCancelBody.status).toBe("cancelled");
    expect(issueScopedCancelBody.completed_at).toBeString();
    expect(issueScopedCancelBody.result).toBeNull();

    const cancelledByTaskId = await app.request(`/api/tasks/${task.id}/cancel`, { method: "POST" });
    expect(cancelledByTaskId.status).toBe(200);
    const cancelledByTaskIdBody = await cancelledByTaskId.json();
    expect(cancelledByTaskIdBody.status).toBe("cancelled");
    expect(cancelledByTaskIdBody.completed_at).toBeString();
    expect(cancelledByTaskIdBody.result).toBeNull();
  });

  it("serves upstream client compatibility endpoints for env, billing, lark, chat, and batched children", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const agent = store.createAgent({
      name: "Compat Codex",
      provider: "codex",
      customEnv: { SECRET_TOKEN: "real-value", KEEP_ME: "yes" },
    });
    const skill = store.createSkill({ name: "Deploy Helper", description: "Deployment skill", content: "ship it" });
    const parent = store.createIssue({ title: "Parent issue", workspaceId: "local" });
    const child = store.createIssue({ title: "Child issue", workspaceId: "local", parentIssueId: parent.id });
    const runtime = store.registerRuntime({ name: "Compat runtime", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, prompt: "wait locally" });
    const chat = store.createChatSession({ agentId: agent.id, title: "Compat chat" });
    const squad = store.createSquad({ name: "Compat squad", leaderId: agent.id });
    const squadIssue = store.createIssue({
      title: "Squad evaluation",
      workspaceId: "local",
      assigneeType: "squad",
      assigneeId: squad.id,
    });
    const squadTask = store.createTask({ agentId: agent.id, issueId: squadIssue.id, prompt: "evaluate squad" });

    const env = await app.request(`/api/agents/${agent.id}/env`);
    expect(await env.json()).toMatchObject({ agent_id: agent.id, custom_env: { SECRET_TOKEN: "real-value" } });

    const updatedEnv = await app.request(`/api/agents/${agent.id}/env`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ custom_env: { SECRET_TOKEN: "****", ADDED: "new" } }),
    });
    expect((await updatedEnv.json()).custom_env).toEqual({ SECRET_TOKEN: "real-value", ADDED: "new" });

    const addedSkills = await app.request(`/api/agents/${agent.id}/skills/add`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skill_ids: [skill.id, skill.id] }),
    });
    expect((await addedSkills.json()).map((item: any) => item.id)).toEqual([skill.id]);

    const skillSearchWithoutQuery = await app.request("/api/skills/search");
    expect(skillSearchWithoutQuery.status).toBe(400);
    expect(await skillSearchWithoutQuery.json()).toEqual({ error: "query is required" });

    const skillSearch = await app.request("/api/skills/search?q=deploy");
    const skillSearchBody = await skillSearch.json();
    expect(Array.isArray(skillSearchBody)).toBe(true);
    expect(skillSearchBody[0].name).toBe("Deploy Helper");
    expect(skillSearchBody[0]).toMatchObject({
      description: "Deployment skill",
      source: "local",
      repo: null,
      github_stars: null,
      install_count: null,
    });
    expect(skillSearchBody[0].id).toBeUndefined();
    expect(skillSearchBody[0].workspaceId).toBeUndefined();

    const batchedChildren = await app.request(`/api/issues/children?parent_ids=${encodeURIComponent(parent.id)}`);
    expect((await batchedChildren.json()).issues[0].id).toBe(child.id);

    const squadEvaluated = await app.request(`/api/issues/${squadIssue.id}/squad-evaluated`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent-ID": agent.id,
        "X-Task-ID": squadTask.id,
      },
      body: JSON.stringify({ outcome: "no_action", reason: "nothing to delegate" }),
    });
    const squadEvaluatedBody = await squadEvaluated.json();
    expect(squadEvaluated.status).toBe(201);
    expect(squadEvaluatedBody.type).toBe("squad_leader_evaluated");
    expect(squadEvaluatedBody.data).toMatchObject({ outcome: "no_action", squad_id: squad.id, task_id: squadTask.id });

    await app.request(`/api/chat/sessions/${chat.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "hello page" }),
    });
    const chatPage = await app.request(`/api/chat/sessions/${chat.id}/messages/page?limit=1`);
    const chatPageBody = await chatPage.json();
    expect(chatPageBody.messages[0].chat_session_id).toBe(chat.id);
    expect(chatPageBody.limit).toBe(1);
    expect(chatPageBody.has_more).toBe(false);

    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    const waitLocalDirectory = await app.request(`/api/daemon/tasks/${task.id}/wait-local-directory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "/tmp/repo" }),
    });
    const waitLocalDirectoryBody = await waitLocalDirectory.json();
    expect(waitLocalDirectoryBody.status).toBe("waiting_local_directory");
    expect(waitLocalDirectoryBody.wait_reason).toBe("/tmp/repo");
    expect(waitLocalDirectoryBody.progress_summary).toContain("/tmp/repo");

    const renew = await app.request("/api/tokens/current/renew", { method: "POST" });
    const renewBody = await renew.json();
    expect(renew.status).toBe(201);
    expect(renewBody.access_token).toStartWith("mul_");

    expect(await (await app.request("/api/cloud-billing/balance")).json()).toMatchObject({
      owner_id: "local",
      balance_micro: 0,
      balance_credit: 0,
      configured: false,
    });
    expect((await (await app.request("/api/cloud-billing/transactions?page=2&page_size=5")).json()).page).toBe(2);
    expect((await (await app.request("/api/cloud-billing/price-tiers")).json())[0].configured).toBe(false);
    expect((await (await app.request("/api/cloud-billing/checkout-sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier_id: "local-disabled" }),
    })).json()).session_id).toBe("local-disabled");
    expect((await (await app.request("/api/cloud-billing/portal-sessions", { method: "POST" })).json()).configured).toBe(false);

    const larkList = await app.request("/api/workspaces/local/lark/installations");
    expect(await larkList.json()).toMatchObject({ configured: false, install_supported: false, installations: [] });
    expect((await (await app.request("/api/workspaces/local/lark/install/begin?agent_id=agt", { method: "POST" })).json()).error_reason).toBe("not_configured");
    expect((await (await app.request("/api/workspaces/local/lark/install/session-1/status")).json()).status).toBe("error");
    expect((await app.request("/api/workspaces/local/lark/installations/lin_1", { method: "DELETE" })).status).toBe(204);
    expect((await app.request("/api/lark/binding/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "lark-token" }),
    })).status).toBe(409);

    expect((await app.request("/api/webhooks/stripe", { method: "POST" })).status).toBe(202);
    expect((await app.request("/api/contact-sales", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "buyer@example.com" }),
    })).status).toBe(201);

    store.updateAgent(agent.id, { runtimeId: runtime.id });
    const cascade = await app.request(`/api/runtimes/${runtime.id}/archive-agents-and-delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expected_active_agent_ids: [agent.id] }),
    });
    const cascadeBody = await cascade.json();
    expect(cascadeBody).toEqual({ status: "ok", agents_archived: 1, tasks_cancelled: 3 });
    expect(store.getRuntime(runtime.id)).toBeNull();
    expect(store.getAgent(agent.id)).toMatchObject({ runtimeId: null });
    expect(store.getAgent(agent.id)?.archivedAt).not.toBeNull();
  });

  it("serves selected console workflows across linked workspace resources", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const runtime = store.registerRuntime({
      id: "rt_console_contract",
      name: "Console Claude",
      provider: "claude",
      workspaceId: "local",
      metadata: { cli_version: "0.2.26-test" },
    });
    const agent = store.createAgent({
      id: "agt_console_contract",
      name: "Console Agent",
      provider: "claude",
      runtimeId: runtime.id,
      workspaceId: "local",
    });
    const skill = store.createSkill({
      id: "skl_console_contract",
      name: "Console Skill",
      description: "Skill detail used by the console contract",
      content: "Use the selected console workflow.",
      workspaceId: "local",
      files: [{ path: "notes/console.md", content: "Use the selected console workflow." }],
    });
    const project = store.createProject({ id: "prj_console_contract", title: "Console Project", workspaceId: "local" });
    const issue = store.createIssue({
      id: "iss_console_contract",
      title: "Console Issue",
      workspaceId: "local",
      projectId: project.id,
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    const autopilot = store.createAutopilot({
      id: "aut_console_contract",
      title: "Console Autopilot",
      workspaceId: "local",
      projectId: project.id,
      assigneeType: "agent",
      assigneeId: agent.id,
      triggerKind: "manual",
    });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "console usage" });

    const config = await app.request("/api/config");
    expect(await config.json()).toMatchObject({ allow_signup: true, analytics_environment: expect.any(String) });

    const me = await app.request("/api/me");
    expect(await me.json()).toMatchObject({ id: "local", email: "local@multiremi.local" });

    const workspaces = await app.request("/api/workspaces");
    expect((await workspaces.json()).map((workspace: any) => workspace.id)).toContain("local");

    const assignedSkills = await app.request(`/api/agents/${agent.id}/skills`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skill_ids: [skill.id] }),
    });
    expect((await assignedSkills.json()).map((item: any) => item.id)).toEqual([skill.id]);

    const runtimeList = await app.request("/api/runtimes?workspace_id=local");
    const runtimeListBody = await runtimeList.json();
    expect(runtimeListBody.find((item: any) => item.id === runtime.id)).toMatchObject({
      id: runtime.id,
      workspace_id: "local",
      provider: "claude",
    });

    const runtimePatch = await app.request(`/api/runtimes/${runtime.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: "public" }),
    });
    expect(await runtimePatch.json()).toMatchObject({ id: runtime.id, visibility: "public", workspace_id: "local" });

    const runtimeDetail = await app.request(`/api/runtimes/${runtime.id}`);
    const runtimeDetailBody = await runtimeDetail.json();
    expect(runtimeDetailBody.runtime.id).toBe(runtime.id);
    expect(runtimeDetailBody.usage).toEqual([]);

    const agents = await app.request("/api/agents?workspace_id=local");
    expect((await agents.json()).find((item: any) => item.id === agent.id)).toMatchObject({
      id: agent.id,
      runtime_id: runtime.id,
    });
    expect((await (await app.request(`/api/agents/${agent.id}`)).json()).name).toBe("Console Agent");
    expect((await (await app.request(`/api/agents/${agent.id}/skills`)).json()).map((item: any) => item.id)).toEqual([skill.id]);

    const skills = await app.request("/api/skills?workspace_id=local");
    expect((await skills.json()).find((item: any) => item.id === skill.id)).toMatchObject({ id: skill.id, name: "Console Skill" });
    const skillDetail = await app.request(`/api/skills/${skill.id}`);
    expect((await skillDetail.json()).files[0]).toMatchObject({ path: "notes/console.md" });

    const projects = await app.request("/api/projects?workspace_id=local");
    const projectsBody = await projects.json();
    expect(projectsBody.projects.find((item: any) => item.id === project.id)).toMatchObject({
      id: project.id,
      title: "Console Project",
      workspace_id: "local",
    });
    expect(projectsBody.total).toBeGreaterThanOrEqual(1);
    expect((await (await app.request(`/api/projects/${project.id}`)).json()).workspace_id).toBe("local");

    const issuePatch = await app.request(`/api/issues/${issue.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "in_progress" }),
    });
    expect(await issuePatch.json()).toMatchObject({ id: issue.id, status: "in_progress", project_id: project.id });

    const issueList = await app.request("/api/issues?workspace_id=local&status=in_progress");
    const issueListBody = await issueList.json();
    const listedIssue = issueListBody.issues.find((item: any) => item.id === issue.id);
    expect(listedIssue).toMatchObject({
      id: issue.id,
      assignee_id: agent.id,
      project_id: project.id,
    });
    expect(listedIssue.latestTaskStatus).toBeUndefined();
    const issueDetail = await app.request(`/api/issues/${issue.key.toLowerCase()}`);
    const issueDetailBody = await issueDetail.json();
    expect(issueDetailBody).toMatchObject({
      id: issue.id,
      workspace_id: "local",
      identifier: issue.key,
      project_id: project.id,
    });
    expect(issueDetailBody.tasks).toBeUndefined();
    const taskRuns = await app.request(`/api/issues/${issue.key}/task-runs`);
    expect((await taskRuns.json())[0].id).toBe(task.id);
    const timeline = await app.request(`/api/issues/${issue.id}/timeline`);
    const timelineBody = await timeline.json();
    expect(timelineBody.map((entry: any) => entry.type)).toContain("activity");
    expect(timelineBody[0].actorType).toBeUndefined();
    expect(timelineBody[0].actor_type).toBeDefined();

    const autopilotPatch = await app.request(`/api/autopilots/${autopilot.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "paused" }),
    });
    const autopilotPatchBody = await autopilotPatch.json();
    expect(autopilotPatchBody).toMatchObject({ id: autopilot.id, status: "paused", project_id: project.id });
    expect(autopilotPatchBody.projectId).toBeUndefined();
    const autopilots = await app.request("/api/autopilots?workspace_id=local");
    const autopilotsBody = await autopilots.json();
    expect(autopilotsBody.autopilots.find((item: any) => item.id === autopilot.id)).toMatchObject({ id: autopilot.id });
    expect(autopilotsBody.total).toBeGreaterThanOrEqual(1);
    const autopilotDetailBody = await (await app.request(`/api/autopilots/${autopilot.id}`)).json();
    expect(autopilotDetailBody.autopilot.id).toBe(autopilot.id);
    expect(autopilotDetailBody.autopilot.projectId).toBeUndefined();

    const claim = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" });
    expect((await claim.json()).task.id).toBe(task.id);
    await app.request(`/api/daemon/tasks/${task.id}/usage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usage: [{ provider: "claude", model: "sonnet", input_tokens: 21, output_tokens: 8 }] }),
    });

    const dailyUsage = await app.request("/api/dashboard/usage/daily?workspace_id=local");
    expect((await dailyUsage.json())[0]).toMatchObject({
      runtimeId: runtime.id,
      provider: "claude",
      model: "sonnet",
      inputTokens: 21,
      taskCount: 1,
    });
    const usageByAgent = await app.request("/api/dashboard/usage/by-agent?workspace_id=local");
    expect((await usageByAgent.json())[0]).toMatchObject({ agentId: agent.id, model: "sonnet", outputTokens: 8, taskCount: 1 });
    const runtimeDaily = await app.request("/api/dashboard/runtime/daily?workspace_id=local");
    expect((await runtimeDaily.json())[0]).toMatchObject({ taskCount: 1, failedCount: 0 });
  });
});
