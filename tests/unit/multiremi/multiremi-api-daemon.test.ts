// HTTP surface the daemon itself calls: install commands and token minting,
// claim/start/complete, task reports, orphan recovery, GC checks, task history.
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { daemonRuntimeId } from "@multiremi/store.js";
import { createStore, db, readyArchiveBinding, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Multiremi API — daemon endpoints", () => {
  it("checks Feishu external identities against the daemon token workspace", async () => {
    const store = createStore();
    const memberUser = store.getOrCreateUser({
      externalId: "ou_workspace_member",
      email: "workspace-member@example.test",
      name: "Workspace Member",
    });
    const nonMemberUser = store.getOrCreateUser({
      externalId: "ou_known_non_member",
      email: "known-non-member@example.test",
      name: "Known Non-member",
    });
    store.createWorkspaceMember({
      id: "mem_workspace_member",
      workspaceId: "local",
      userId: memberUser.id,
      name: "Workspace Member",
      role: "member",
    });
    store.createWorkspace({
      id: "ws_other",
      name: "Other Workspace",
      slug: "other-workspace",
      issuePrefix: "OTH",
    });
    const daemonToken = await store.createAccessToken({
      workspaceId: "local",
      name: "Membership gate daemon",
      type: "daemon",
      daemonId: "daemon-membership-gate",
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const request = (workspaceId: string, externalId: string) => app.request(
      `/api/daemon/workspaces/${workspaceId}/external-membership/check`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${daemonToken.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ external_id: externalId }),
      },
    );

    const member = await request("local", memberUser.externalId!);
    expect(member.status).toBe(200);
    expect(await member.json()).toEqual({ allowed: true });
    expect(member.headers.get("cache-control")).toBe("no-store");

    const nonMember = await request("local", nonMemberUser.externalId!);
    expect(nonMember.status).toBe(200);
    expect(await nonMember.json()).toEqual({ allowed: false });

    const unknown = await request("local", "ou_unknown_external_user");
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual({ allowed: false });
    expect(store.getUserByExternalId("ou_unknown_external_user")).toBeNull();

    const crossWorkspace = await request("ws_other", memberUser.externalId!);
    expect(crossWorkspace.status).toBe(403);
    expect(await crossWorkspace.json()).toEqual({ error: "forbidden for daemon token workspace" });

    const memberToken = await store.createAccessToken({
      workspaceId: "local",
      userId: memberUser.id,
      name: "Human member",
      type: "pat",
    });
    const humanRequest = await app.request(
      "/api/daemon/workspaces/local/external-membership/check",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${memberToken.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ external_id: memberUser.externalId }),
      },
    );
    expect(humanRequest.status).toBe(403);
    expect(await humanRequest.json()).toMatchObject({ code: "daemon_token_required" });
  });

  it("reports an Issue code workspace and exposes it to the Issue sidebar", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({
      id: "rt_workspace_api",
      name: "codex",
      provider: "codex",
      workspaceId: "local",
      daemonId: "daemon-workspace-api",
      runtimeMode: "local",
      deviceInfo: "devbox · Linux (x86_64)",
    });
    store.updateDaemonDisplayName("remote", "daemon-workspace-api", "Wrong workspace", "local");
    store.updateDaemonDisplayName("local", "daemon-workspace-api", "Build workstation", "local");
    const agent = store.createAgent({ name: "Workspace Codex", provider: "codex" });
    const issue = store.createIssue({ title: "Show workspace", workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "work" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    const app = createMultiremiApp({ store });

    const report = await app.request(`/api/daemon/tasks/${task.id}/workspace`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runtime_id: runtime.id,
        root_path: `/home/dev/.remi/multiremi/workspaces/${issue.key}`,
        branch_name: `agent/${issue.key}`,
        status: "in_use",
        repos: [{
          repo_url: "git@example.test:team/remi.git",
          repo_name: "remi",
          worktree_path: `/home/dev/.remi/multiremi/workspaces/${issue.key}/remi`,
          branch_name: `agent/${issue.key}`,
          base_ref: "refs/remotes/origin/main",
          status: "ready",
          dirty: false,
        }],
      }),
    });
    expect(report.status).toBe(200);

    const response = await app.request(`/api/issues/${issue.id}/workspace`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      workspace: {
        issue_id: issue.id,
        runtime_id: runtime.id,
        runtime_name: "codex",
        runtime_status: "online",
        runtime_provider: "codex",
        runtime_mode: "local",
        runtime_device_info: "devbox · Linux (x86_64)",
        runtime_daemon_id: "daemon-workspace-api",
        runtime_machine_name: "Build workstation",
        root_path: `/home/dev/.remi/multiremi/workspaces/${issue.key}`,
        branch_name: `agent/${issue.key}`,
        status: "in_use",
        repos: [{ repo_name: "remi", branch_name: `agent/${issue.key}`, dirty: false }],
      },
    });

    store.setRuntimeOffline(runtime.id);
    const offline = await app.request(`/api/issues/${issue.id}/workspace`);
    expect((await offline.json()).workspace.status).toBe("runtime_offline");

    store.startTask(task.id);
    store.completeTask(task.id, { output: "done" });
    store.markIssueWorkspaceCleaned({
      issueId: issue.id,
      runtimeId: runtime.id,
      ...readyArchiveBinding(store, issue.id, runtime.id),
    });
    const nextRuntime = store.registerRuntime({ id: "rt_workspace_next", name: "codex (next)", provider: "codex" });
    const nextTask = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "continue" });
    expect(store.claimTask(nextRuntime.id)?.id).toBe(nextTask.id);
    const nextReport = await app.request(`/api/daemon/tasks/${nextTask.id}/workspace`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runtime_id: nextRuntime.id,
        root_path: `/home/next/.remi/multiremi/workspaces/${issue.key}`,
        branch_name: `agent/${issue.key}`,
        status: "preparing",
      }),
    });
    expect(nextReport.status).toBe(200);

    const staleReport = await app.request(`/api/daemon/tasks/${task.id}/workspace`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runtime_id: runtime.id,
        root_path: `/home/dev/.remi/multiremi/workspaces/${issue.key}`,
        branch_name: `agent/${issue.key}`,
        status: "ready",
      }),
    });
    expect(staleReport.status).toBe(409);
    expect(store.getIssueWorkspace(issue.id)?.runtimeId).toBe(nextRuntime.id);
  });

  it("accepts a branchless read-only workspace for an intake issue", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_intake_workspace", name: "claude (devbox)", provider: "claude" });
    const agent = store.createAgent({ name: "Intake PM", provider: "claude" });
    const issue = store.createIssue({ title: "Triage request", workspaceId: "local", issueKind: "intake" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, taskKind: "quick_create", prompt: "triage" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    const app = createMultiremiApp({ store });

    const report = await app.request(`/api/daemon/tasks/${task.id}/workspace`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runtime_id: runtime.id,
        root_path: `/home/dev/.remi/multiremi/workspaces/${issue.key}`,
        branch_name: "",
        status: "ready",
        repos: [{
          repo_url: "git@example.test:team/remi.git",
          repo_name: "remi",
          worktree_path: `/home/dev/.remi/multiremi/workspaces/${issue.key}/projects/Remi/repos/remi`,
          branch_name: "",
          base_ref: "abc123",
          status: "ready",
          dirty: false,
        }],
      }),
    });

    expect(report.status).toBe(200);
    expect(store.getIssueWorkspace(issue.id)).toMatchObject({ branchName: "", status: "ready" });
  });

  it("serves Multiremi daemon install commands and mints daemon tokens", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });

    const preview = await app.request("/api/multiremi/install/daemon?server_url=https%3A%2F%2Fremi.example&workspace_id=ws_1&token=tok_123&provider=codex&version=v1.2.3");
    const previewBody = await preview.json();
    expect(preview.status).toBe(200);
    expect(previewBody.product).toBe("multiremi");
    expect(previewBody.installScriptUrl).toBe("https://github.com/Grassgod/remi/releases/download/v1.2.3/install-remi.sh");
    expect(previewBody.installCommand).toBe("curl -fsSL https://github.com/Grassgod/remi/releases/download/v1.2.3/install-remi.sh | bash");
    expect(previewBody.setupCommand).toBe("multiremi setup --server https://remi.example --workspace ws_1 --token tok_123 --provider codex");
    expect(previewBody.daemonCommand).toBe("multiremi daemon");
    expect(previewBody.installCommand).not.toContain("multimira");
    expect(previewBody.setupCommand).not.toContain("multica");
    expect(/\bremi setup\b/.test(previewBody.setupCommand)).toBe(false);

    const unsupportedProvider = await app.request("/api/multiremi/install/daemon?provider=gemini");
    expect(unsupportedProvider.status).toBe(400);
    expect(await unsupportedProvider.json()).toEqual({ error: "Unsupported Multiremi runtime provider: gemini" });

    const minted = await app.request("/api/multiremi/install/daemon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverUrl: "https://remi.example", workspaceId: "local", provider: "claude" }),
    });
    const mintedBody = await minted.json();

    expect(minted.status).toBe(201);
    expect(mintedBody.token).toStartWith("mdt_");
    expect(mintedBody.tokenId).toStartWith("dtk_");
    expect(mintedBody.setupCommand).toContain("--token mdt_");
    expect(mintedBody.setupCommand).toContain("--provider claude");
    expect(mintedBody.commands.map((command: any) => command.key)).toEqual(["install", "setup", "daemon"]);
    expect(store.listAccessTokens("local")[0]).toMatchObject({
      id: mintedBody.tokenId,
      type: "daemon",
      expiresAt: null,
    });
  });

  it("validates daemon install requests before minting credentials", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const invalidRequests = [
      {
        daemonId: "daemon-invalid-provider",
        body: { daemon_id: "daemon-invalid-provider", provider: "gemini" },
      },
      {
        daemonId: "daemon-invalid-expiry",
        body: { daemon_id: "daemon-invalid-expiry", expires_in_days: "90" },
      },
      {
        daemonId: "daemon-invalid-token-name",
        body: { daemon_id: "daemon-invalid-token-name", token_name: "  " },
      },
    ];

    for (const invalid of invalidRequests) {
      const response = await app.request("/api/multiremi/install/daemon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(invalid.body),
      });
      expect(response.status).toBe(400);
      expect(store.listAccessTokens("local")).toHaveLength(0);
      expect(store.getDaemonIdentityOwnerUserId("local", invalid.daemonId)).toBeNull();
      expect(
        store.listDaemonInventory("local").some((entry) => entry.daemonId === invalid.daemonId),
      ).toBe(false);
    }

    const malformed = await app.request("/api/multiremi/install/daemon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "invalid request body" });
    expect(store.listAccessTokens("local")).toHaveLength(0);
    expect(store.listDaemonInventory("local")).toHaveLength(0);

    const legacyExpiry = await app.request("/api/multiremi/install/daemon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        daemon_id: "daemon-compatible-expiry",
        expires_in_days: 90,
      }),
    });
    const legacyExpiryBody = await legacyExpiry.json();
    expect(legacyExpiry.status).toBe(201);
    expect(legacyExpiryBody.token).toStartWith("mdt_");
    expect(legacyExpiryBody.tokenId).toStartWith("dtk_");
    expect(store.getAccessToken(legacyExpiryBody.tokenId)).toMatchObject({
      id: legacyExpiryBody.tokenId,
      type: "daemon",
      tokenPrefix: expect.stringMatching(/^mdt_/),
      expiresAt: null,
    });
  });

  it("does not let a workspace member choose a daemon identity", async () => {
    const store = createStore();
    store.createWorkspaceMember({ id: "daemon-member", name: "Daemon Member", role: "member" });
    const memberToken = await store.createAccessToken({
      name: "Member session",
      type: "pat",
      workspaceId: "local",
      userId: "daemon-member",
    });
    const tokenIdsBefore = store.listAccessTokens("local").map((token) => token.id);
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const response = await app.request("/api/multiremi/install/daemon", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${memberToken.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "member-chosen-daemon",
        token_name: "Must not be created",
      }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "workspace_admin_required" });
    expect(store.listAccessTokens("local").map((token) => token.id)).toEqual(tokenIdsBefore);
    expect(store.getDaemonIdentityOwnerUserId("local", "member-chosen-daemon")).toBeNull();
    expect(
      store.listDaemonInventory("local").some((entry) => entry.daemonId === "member-chosen-daemon"),
    ).toBe(false);
  });

  it("lets a workspace member provision an owner-bound daemon that can register and read desired plugins", async () => {
    const store = createStore();
    store.createWorkspaceMember({ id: "daemon-admin", name: "Daemon Admin", role: "admin" });
    store.createWorkspaceMember({ id: "daemon-member", name: "Daemon Member", role: "member" });
    const memberToken = await store.createAccessToken({
      name: "Member session",
      type: "pat",
      workspaceId: "local",
      userId: "daemon-member",
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const provisioned = await app.request("/api/multiremi/install/daemon", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${memberToken.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ workspace_id: "local", token_name: "Member daemon" }),
    });
    expect(provisioned.status).toBe(201);
    const credential = await provisioned.json();
    expect(credential).toMatchObject({ workspaceId: "local" });
    expect(credential.daemonId).toStartWith("dmn_");
    expect(credential.token).toStartWith("mdt_");
    expect(credential.tokenId).toStartWith("dtk_");
    expect(credential.setupCommand).toContain(`--daemon-id ${credential.daemonId}`);
    expect(store.getAccessToken(credential.tokenId)).toMatchObject({
      type: "daemon",
      purpose: "daemon",
      workspaceId: "local",
      userId: "daemon-member",
      daemonId: credential.daemonId,
    });

    const registered = await app.request("/api/daemon/register", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: credential.daemonId,
        capabilities: { agent_plugins: 1 },
        runtimes: [{ type: "claude", version: "1.0.0" }],
      }),
    });
    expect(registered.status).toBe(200);
    const registeredBody = await registered.json();
    const runtimeId = registeredBody.runtimes[0].id;
    expect(store.getAccessToken(credential.tokenId)?.daemonId).toBe(credential.daemonId);

    const desired = await app.request(
      `/api/daemon/runtimes/${runtimeId}/agent-plugins/desired`,
      { headers: { Authorization: `Bearer ${credential.token}` } },
    );
    expect(desired.status).toBe(200);
    expect(await desired.json()).toMatchObject({ runtime_id: runtimeId, plugins: [] });

    const heartbeat = await app.request("/api/daemon/heartbeat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ runtime_id: runtimeId, agent_plugin_protocol: 1 }),
    });
    expect(heartbeat.status).toBe(200);

    const agent = store.createAgent({
      name: "Provisioned daemon agent",
      provider: "claude",
      workspaceId: "local",
      ownerId: "daemon-member",
      runtimeId,
    });
    const task = store.createTask({
      agentId: agent.id,
      runtimeId,
      prompt: "claim with provisioned daemon",
    });
    const claim = await app.request(`/api/daemon/runtimes/${runtimeId}/tasks/claim`, {
      method: "POST",
      headers: { Authorization: `Bearer ${credential.token}` },
    });
    expect(claim.status).toBe(200);
    expect((await claim.json()).task.id).toBe(task.id);
  });

  it("promotes workspace member CLI PATs during register or rolling heartbeat", async () => {
    const store = createStore();
    store.createWorkspaceMember({ id: "legacy-admin", name: "Legacy Admin", role: "admin" });
    store.createWorkspaceMember({ id: "legacy-member", name: "Legacy Member", role: "member" });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const legacyRegisterToken = await store.createAccessToken({
      name: "Old add-computer credential",
      type: "pat",
      purpose: "cli",
      workspaceId: "local",
      userId: "legacy-admin",
    });

    const registered = await app.request("/api/daemon/register", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${legacyRegisterToken.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "daemon-legacy-register",
        capabilities: { agent_plugins: 1 },
        runtimes: [{ type: "codex", version: "1.0.0" }],
      }),
    });
    expect(registered.status).toBe(200);
    const registerRuntimeId = (await registered.json()).runtimes[0].id;
    expect(store.getAccessToken(legacyRegisterToken.id)).toMatchObject({
      type: "daemon",
      purpose: "daemon",
      daemonId: "daemon-legacy-register",
    });
    expect((await app.request(
      `/api/daemon/runtimes/${registerRuntimeId}/agent-plugins/desired`,
      { headers: { Authorization: `Bearer ${legacyRegisterToken.token}` } },
    )).status).toBe(200);

    const rollingRuntime = store.registerRuntime({
      id: "rt_legacy_heartbeat",
      name: "Legacy heartbeat runtime",
      provider: "claude",
      workspaceId: "local",
      ownerId: "legacy-admin",
      daemonId: "daemon-legacy-heartbeat",
    });
    const legacyHeartbeatToken = await store.createAccessToken({
      name: "Already-running old daemon",
      type: "pat",
      purpose: "cli",
      workspaceId: "local",
      userId: "legacy-admin",
    });
    const heartbeat = await app.request("/api/daemon/heartbeat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${legacyHeartbeatToken.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ runtime_id: rollingRuntime.id, agent_plugin_protocol: 1 }),
    });
    expect(heartbeat.status).toBe(200);
    expect(store.getAccessToken(legacyHeartbeatToken.id)).toMatchObject({
      type: "daemon",
      purpose: "daemon",
      daemonId: "daemon-legacy-heartbeat",
    });
    expect((await app.request(
      `/api/daemon/runtimes/${rollingRuntime.id}/agent-plugins/desired`,
      { headers: { Authorization: `Bearer ${legacyHeartbeatToken.token}` } },
    )).status).toBe(200);

    const memberCliToken = await store.createAccessToken({
      name: "Member old daemon",
      type: "pat",
      purpose: "cli",
      workspaceId: "local",
      userId: "legacy-member",
    });
    const memberRegister = await app.request("/api/daemon/register", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${memberCliToken.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "daemon-member-upgrade",
        runtimes: [{ type: "claude" }],
      }),
    });
    expect(memberRegister.status).toBe(200);
    expect(store.getAccessToken(memberCliToken.id)).toMatchObject({
      type: "daemon",
      purpose: "daemon",
      daemonId: "daemon-member-upgrade",
    });

    const explicitRuntimeToken = await store.createAccessToken({
      name: "Explicit runtime old daemon",
      type: "pat",
      purpose: "cli",
      workspaceId: "local",
      userId: "legacy-member",
    });
    const explicitRuntimeRegister = await app.request("/api/multiremi/runtimes", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${explicitRuntimeToken.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "rt_legacy_explicit_runtime",
        workspace_id: "local",
        daemon_id: "daemon-legacy-explicit-runtime",
        provider: "claude",
        name: "Explicit legacy runtime",
      }),
    });
    expect(explicitRuntimeRegister.status).toBe(201);
    expect(store.getRuntime("rt_legacy_explicit_runtime")).toMatchObject({
      ownerId: "legacy-member",
      daemonId: "daemon-legacy-explicit-runtime",
    });
    expect(store.getAccessToken(explicitRuntimeToken.id)).toMatchObject({
      type: "daemon",
      purpose: "daemon",
      daemonId: "daemon-legacy-explicit-runtime",
    });
    expect((await app.request("/api/multiremi/runtimes/rt_legacy_explicit_runtime/heartbeat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${explicitRuntimeToken.token}`,
        "Content-Type": "application/json",
      },
    })).status).toBe(200);

    const personalToken = await store.createAccessToken({
      name: "Personal token",
      type: "pat",
      purpose: "personal",
      workspaceId: "local",
      userId: "legacy-admin",
    });
    const personalHeartbeat = await app.request("/api/daemon/heartbeat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${personalToken.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ runtime_id: rollingRuntime.id }),
    });
    expect(personalHeartbeat.status).toBe(403);
    expect(store.getAccessToken(personalToken.id)).toMatchObject({ type: "pat", purpose: "personal" });

    const wrongOwnerToken = await store.createAccessToken({
      name: "Wrong owner old daemon",
      type: "pat",
      purpose: "cli",
      workspaceId: "local",
      userId: "legacy-admin",
    });
    const memberOwnedRuntime = store.registerRuntime({
      id: "rt_member_owned_legacy",
      name: "Member-owned legacy runtime",
      provider: "codex",
      workspaceId: "local",
      ownerId: "legacy-member",
      daemonId: "daemon-member-owned",
    });
    const wrongOwnerHeartbeat = await app.request("/api/daemon/heartbeat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${wrongOwnerToken.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ runtime_id: memberOwnedRuntime.id }),
    });
    expect(wrongOwnerHeartbeat.status).toBe(403);
    expect(await wrongOwnerHeartbeat.json()).toMatchObject({ code: "daemon_credential_upgrade_failed" });
    expect(store.getAccessToken(wrongOwnerToken.id)).toMatchObject({ type: "pat", purpose: "cli" });
  });

  it("does not promote a time-limited legacy CLI PAT into a daemon credential", async () => {
    const store = createStore();
    store.createWorkspaceMember({
      id: "legacy-expiring-owner-member",
      userId: "legacy-expiring-owner",
      name: "Legacy Expiring Owner",
      role: "admin",
    });
    const legacy = await store.createAccessToken({
      name: "Expiring add-computer credential",
      type: "pat",
      purpose: "cli",
      workspaceId: "local",
      userId: "legacy-expiring-owner",
      expiresInDays: 30,
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const response = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { Authorization: `Bearer ${legacy.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "daemon-expiring-legacy",
        runtimes: [{ type: "codex" }],
      }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "daemon_credential_upgrade_failed" });
    expect(store.getAccessToken(legacy.id)).toMatchObject({
      type: "pat",
      purpose: "cli",
      daemonId: null,
      expiresAt: expect.any(String),
    });
    expect(store.listRuntimes().some((runtime) => runtime.daemonId === "daemon-expiring-legacy"))
      .toBeFalse();
  });

  it("does not let colliding daemon identities overwrite an existing Runtime", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const register = (daemonId: string, name: string) => app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: daemonId,
        device_name: name,
        runtimes: [{ type: "claude" }],
      }),
    });

    const first = await register("Daemon-A", "first machine");
    expect(first.status).toBe(200);
    const runtimeId = (await first.json()).runtimes[0].id;
    const before = store.getRuntime(runtimeId)!;

    const collision = await register("daemon-a", "second machine");
    expect(collision.status).toBe(409);
    expect(await collision.json()).toMatchObject({ code: "runtime_registration_identity_conflict" });
    expect(store.getRuntime(runtimeId)).toMatchObject({
      daemonId: before.daemonId,
      workspaceId: before.workspaceId,
      provider: before.provider,
      name: before.name,
    });
  });

  it("rolls back the whole daemon registration when one Runtime identity conflicts", async () => {
    const store = createStore();
    const daemonId = "daemon-batch-conflict";
    const conflictingRuntimeId = daemonRuntimeId(daemonId, "codex");
    store.registerRuntime({
      id: conflictingRuntimeId,
      name: "Existing machine",
      provider: "codex",
      workspaceId: "local",
      daemonId: "another-daemon",
    });
    const app = createMultiremiApp({ store });

    const response = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: daemonId,
        runtimes: [{ type: "claude" }, { type: "codex" }],
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "runtime_registration_identity_conflict",
    });
    expect(store.getRuntime(daemonRuntimeId(daemonId, "claude"))).toBeNull();
    expect(store.getRuntime(conflictingRuntimeId)).toMatchObject({
      daemonId: "another-daemon",
      name: "Existing machine",
    });
  });

  it("lets the original owner migrate a daemonless Runtime without allowing another member to squat it", async () => {
    const store = createStore();
    store.createWorkspaceMember({ id: "legacy-owner", name: "Legacy owner", role: "member" });
    store.createWorkspaceMember({ id: "legacy-attacker", name: "Legacy attacker", role: "member" });
    const daemonId = "daemon-legacy-runtime";
    const runtimeId = daemonRuntimeId(daemonId, "claude");
    store.registerRuntime({
      id: runtimeId,
      name: "Legacy daemonless Runtime",
      provider: "claude",
      workspaceId: "local",
      ownerId: "legacy-owner",
    });
    const attackerToken = await store.createAccessToken({
      name: "Attacker legacy CLI",
      type: "pat",
      purpose: "cli",
      workspaceId: "local",
      userId: "legacy-attacker",
    });
    const ownerToken = await store.createAccessToken({
      name: "Owner legacy CLI",
      type: "pat",
      purpose: "cli",
      workspaceId: "local",
      userId: "legacy-owner",
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const register = (token: string) => app.request("/api/daemon/register", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: daemonId,
        runtimes: [{ type: "claude" }],
      }),
    });

    const denied = await register(attackerToken.token);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "legacy_runtime_owner_conflict" });
    expect(store.getAccessToken(attackerToken.id)).toMatchObject({ type: "pat", purpose: "cli" });
    expect(store.getDaemonIdentityOwnerUserId("local", daemonId)).toBeNull();
    expect(store.getRuntime(runtimeId)).toMatchObject({ daemonId: null, ownerId: "legacy-owner" });

    const migrated = await register(ownerToken.token);
    expect(migrated.status).toBe(200);
    expect(store.getAccessToken(ownerToken.id)).toMatchObject({
      type: "daemon",
      daemonId,
    });
    expect(store.getRuntime(runtimeId)).toMatchObject({ daemonId, ownerId: "legacy-owner" });
  });

  it("requires admin recovery for ownerless daemons and rejects human Runtime spoofing", async () => {
    const store = createStore();
    store.createWorkspaceMember({ id: "runtime-attacker", name: "Runtime attacker", role: "member" });
    store.createWorkspaceMember({ id: "runtime-victim", name: "Runtime victim", role: "member" });
    const attackerToken = await store.createAccessToken({
      name: "Attacker PAT",
      type: "pat",
      purpose: "personal",
      workspaceId: "local",
      userId: "runtime-attacker",
    });
    const ownerless = store.registerRuntime({
      id: "rt_ownerless_recovery",
      name: "Ownerless recovery Runtime",
      provider: "claude",
      workspaceId: "local",
      daemonId: "daemon-ownerless-recovery",
    });
    const victim = store.registerRuntime({
      id: "rt_victim_owned",
      name: "Victim Runtime",
      provider: "codex",
      workspaceId: "local",
      daemonId: "daemon-victim-owned",
      ownerId: "runtime-victim",
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const headers = {
      Authorization: `Bearer ${attackerToken.token}`,
      "Content-Type": "application/json",
    };

    const ownerlessTakeover = await app.request("/api/daemon/register", {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "daemon-ownerless-recovery",
        runtimes: [{ type: "claude", name: "TAKEN OVER" }],
      }),
    });
    expect(ownerlessTakeover.status).toBe(403);
    expect(await ownerlessTakeover.json()).toMatchObject({ code: "daemon_owner_recovery_required" });
    expect(store.getDaemonIdentityOwnerUserId("local", "daemon-ownerless-recovery")).toBeNull();
    expect(store.getRuntime(ownerless.id)?.name).toBe("Ownerless recovery Runtime");

    const spoof = await app.request("/api/multiremi/runtimes", {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: victim.id,
        name: "SPOOFED",
        provider: "codex",
        workspace_id: "local",
        daemon_id: "daemon-victim-owned",
        owner_id: "runtime-victim",
      }),
    });
    expect(spoof.status).toBe(403);
    expect(store.getRuntime(victim.id)?.name).toBe("Victim Runtime");

    const humanHeartbeat = await app.request(`/api/multiremi/runtimes/${victim.id}/heartbeat`, {
      method: "POST",
      headers,
    });
    expect(humanHeartbeat.status).toBe(403);
    expect(await humanHeartbeat.json()).toMatchObject({ code: "daemon_token_required" });
  });

  it("requires daemon retirement before its owner leaves the workspace", async () => {
    const store = createStore();
    const member = store.createWorkspaceMember({ id: "removed-daemon-owner", name: "Removed owner", role: "member" });
    const memberToken = await store.createAccessToken({
      name: "Removed owner session",
      type: "pat",
      workspaceId: "local",
      userId: member.id,
    });
    const legacyToken = await store.createAccessToken({
      name: "Removed owner legacy CLI",
      type: "pat",
      purpose: "cli",
      workspaceId: "local",
      userId: member.id,
    });
    const unboundDaemonToken = await store.createAccessToken({
      name: "Removed owner unbound daemon",
      type: "daemon",
      workspaceId: "local",
      userId: member.id,
    });
    const personalToken = await store.createAccessToken({
      name: "Removed owner personal PAT",
      type: "pat",
      purpose: "personal",
      workspaceId: "local",
      userId: member.id,
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const provisioned = await app.request("/api/multiremi/install/daemon", {
      method: "POST",
      headers: { Authorization: `Bearer ${memberToken.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: "local", token_name: "Removed owner daemon" }),
    });
    const credential = await provisioned.json();
    const registered = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: credential.daemonId,
        runtimes: [{ type: "claude" }],
      }),
    });
    const runtimeId = (await registered.json()).runtimes[0].id;

    expect(() => store.archiveWorkspaceMember(member.id)).toThrow("retire them before removing the member");
    const retirementPlan = store.getDaemonRetirementPlan("local", credential.daemonId);
    expect(store.retireDaemon(
      "local",
      credential.daemonId,
      retirementPlan.snapshot,
      "local",
    )).toMatchObject({ status: "retired", alreadyRetired: false });
    store.archiveWorkspaceMember(member.id);

    const heartbeat = await app.request("/api/daemon/heartbeat", {
      method: "POST",
      headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ runtime_id: runtimeId }),
    });
    expect(heartbeat.status).toBe(401);

    const compatibilityRegister = await app.request("/api/multiremi/runtimes", {
      method: "POST",
      headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: runtimeId,
        workspace_id: "local",
        daemon_id: credential.daemonId,
        provider: "claude",
        name: "MUTATED",
      }),
    });
    expect(compatibilityRegister.status).toBe(401);
    expect(store.getRuntime(runtimeId)).toBeNull();

    const compatibilityHeartbeat = await app.request(
      `/api/multiremi/runtimes/${runtimeId}/heartbeat`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${credential.token}` },
      },
    );
    expect(compatibilityHeartbeat.status).toBe(401);

    const reregister = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: credential.daemonId,
        runtimes: [{ type: "claude" }],
      }),
    });
    expect(reregister.status).toBe(401);

    const rejectedUnboundDaemon = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { Authorization: `Bearer ${unboundDaemonToken.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "daemon-removed-unbound",
        runtimes: [{ type: "claude" }],
      }),
    });
    expect(rejectedUnboundDaemon.status).toBe(403);
    expect(store.getAccessToken(unboundDaemonToken.id)?.daemonId).toBeNull();
    expect(store.getDaemonIdentityOwnerUserId("local", "daemon-removed-unbound")).toBeNull();

    const rejectedPersonal = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { Authorization: `Bearer ${personalToken.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "daemon-removed-personal",
        runtimes: [{ type: "codex" }],
      }),
    });
    expect(rejectedPersonal.status).toBe(403);
    expect(store.listRuntimes().some((runtime) => runtime.daemonId === "daemon-removed-personal"))
      .toBe(false);
    expect(store.getDaemonIdentityOwnerUserId("local", "daemon-removed-personal")).toBeNull();

    const legacyRegister = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { Authorization: `Bearer ${legacyToken.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "daemon-removed-legacy",
        runtimes: [{ type: "codex" }],
      }),
    });
    expect(legacyRegister.status).toBe(404);
    expect(store.getAccessToken(legacyToken.id)).toMatchObject({ type: "pat", purpose: "cli" });
  });

  it("keeps one daemon id bound to one owner while allowing same-owner providers and tokens", async () => {
    const store = createStore();
    store.createWorkspaceMember({ id: "claim-owner-a", name: "Claim owner A", role: "member" });
    store.createWorkspaceMember({ id: "claim-owner-b", name: "Claim owner B", role: "member" });
    const ownerA = await store.createAccessToken({
      name: "Claim owner A PAT",
      type: "pat",
      workspaceId: "local",
      userId: "claim-owner-a",
    });
    const ownerB = await store.createAccessToken({
      name: "Claim owner B PAT",
      type: "pat",
      workspaceId: "local",
      userId: "claim-owner-b",
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const register = (token: string, provider: string) => app.request("/api/daemon/register", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "daemon-single-owner",
        runtimes: [{ type: provider }],
      }),
    });

    expect((await register(ownerA.token, "claude")).status).toBe(200);
    expect((await register(ownerA.token, "codex")).status).toBe(200);
    const rejected = await register(ownerB.token, "codex");
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({ code: "daemon_identity_owner_conflict" });
    expect(store.getDaemonIdentityOwnerUserId("local", "daemon-single-owner")).toBe("claim-owner-a");

    const sameOwnerTokens = await Promise.all([
      store.createAccessToken({ name: "Same owner daemon 1", type: "daemon", workspaceId: "local", userId: "claim-owner-a" }),
      store.createAccessToken({ name: "Same owner daemon 2", type: "daemon", workspaceId: "local", userId: "claim-owner-a" }),
    ]);
    expect(store.bindDaemonAccessToken(sameOwnerTokens[0]!.id, "daemon-single-owner")?.daemonId)
      .toBe("daemon-single-owner");
    expect(store.bindDaemonAccessToken(sameOwnerTokens[1]!.id, "daemon-single-owner")?.daemonId)
      .toBe("daemon-single-owner");

    const otherOwnerToken = await store.createAccessToken({
      name: "Other owner daemon",
      type: "daemon",
      workspaceId: "local",
      userId: "claim-owner-b",
    });
    expect(() => store.bindDaemonAccessToken(otherOwnerToken.id, "daemon-single-owner"))
      .toThrow("already owned by another user");
    expect(store.getAccessToken(otherOwnerToken.id)?.daemonId).toBeNull();

    const raced = await Promise.allSettled([
      store.createAccessToken({
        name: "Racing owner A",
        type: "daemon",
        workspaceId: "local",
        daemonId: "daemon-owner-race",
        userId: "claim-owner-a",
      }),
      store.createAccessToken({
        name: "Racing owner B",
        type: "daemon",
        workspaceId: "local",
        daemonId: "daemon-owner-race",
        userId: "claim-owner-b",
      }),
    ]);
    expect(raced.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(raced.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winningOwner = store.getDaemonIdentityOwnerUserId("local", "daemon-owner-race");
    expect(winningOwner).not.toBeNull();
    expect(["claim-owner-a", "claim-owner-b"]).toContain(winningOwner!);
    expect(store.listAccessTokens("local").filter((token) => token.daemonId === "daemon-owner-race"))
      .toHaveLength(1);
  });

  it("serves daemon claim/start/complete endpoints", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Claude", provider: "claude" });
    const issue = store.createIssue({ title: "Daemon issue", assigneeType: "agent", assigneeId: agent.id });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "hello" });
    const runtime = store.registerRuntime({ name: "local", provider: "claude" });
    const app = createMultiremiApp({ store });

    const claim = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" });
    expect(claim.status).toBe(200);
    expect((await claim.json()).task.id).toBe(task.id);

    const start = await app.request(`/api/daemon/tasks/${task.id}/start`, { method: "POST" });
    expect(start.status).toBe(200);
    const startBody = await start.json();
    expect(startBody.status).toBe("running");
    expect(startBody.agent_id).toBe(agent.id);
    expect(startBody.agentId).toBeUndefined();

    const complete = await app.request(`/api/daemon/tasks/${task.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        output: "ok",
        pr_url: "https://example.test/pull/1",
        session_id: "sess-complete",
        work_dir: "/tmp/work",
      }),
    });
    expect(complete.status).toBe(200);
    const completeBody = await complete.json();
    expect(completeBody.status).toBe("completed");
    expect(completeBody.agentId).toBeUndefined();
    expect(completeBody.result).toEqual({
      pr_url: "https://example.test/pull/1",
      output: "ok",
      session_id: "sess-complete",
      work_dir: "/tmp/work",
    });

    const status = await app.request(`/api/daemon/tasks/${task.id}/status`);
    expect((await status.json()).status).toBe("completed");

    const taskRuns = await app.request(`/api/issues/${issue.id}/task-runs`);
    expect(taskRuns.status).toBe(200);
    const taskRunsBody = await taskRuns.json();
    expect(taskRunsBody[0].result).toEqual(completeBody.result);

    const duplicateComplete = await app.request(`/api/daemon/tasks/${task.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ output: "late" }),
    });
    expect(duplicateComplete.status).toBe(200);
    const duplicateCompleteBody = await duplicateComplete.json();
    expect(duplicateCompleteBody.status).toBe("completed");
    expect(duplicateCompleteBody.result).toEqual(completeBody.result);

    const terminalFail = await app.request(`/api/daemon/tasks/${task.id}/fail`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "late failure" }),
    });
    expect(terminalFail.status).toBe(200);
    const terminalFailBody = await terminalFail.json();
    expect(terminalFailBody.status).toBe("completed");
    expect(terminalFailBody.result).toEqual(completeBody.result);

    const branchAliasTask = store.createTask({ agentId: agent.id, prompt: "branch alias should not work" });
    expect(store.claimTask(runtime.id)?.id).toBe(branchAliasTask.id);
    expect((await (await app.request(`/api/daemon/tasks/${branchAliasTask.id}/start`, { method: "POST" })).json()).status).toBe("running");
    const branchAliasComplete = await app.request(`/api/daemon/tasks/${branchAliasTask.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ output: "branch alias", branch_name: "https://example.test/pull/branch-alias" }),
    });
    expect(branchAliasComplete.status).toBe(200);
    const branchAliasBody = await branchAliasComplete.json();
    expect(branchAliasBody.result.pr_url).toBe("");
    expect(store.getTask(branchAliasTask.id)?.branchName).not.toBe("https://example.test/pull/branch-alias");

    const failingTask = store.createTask({ agentId: agent.id, prompt: "fail me" });
    expect(store.claimTask(runtime.id)?.id).toBe(failingTask.id);
    const fail = await app.request(`/api/daemon/tasks/${failingTask.id}/fail`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "boom",
        failure_reason: "codex_semantic_inactivity",
        session_id: "sess-fail",
        work_dir: "/tmp/fail-work",
      }),
    });
    expect(fail.status).toBe(200);
    const failBody = await fail.json();
    expect(failBody.status).toBe("failed");
    expect(failBody.completed_at).toBeString();
    expect(failBody.result).toBeNull();
    expect(failBody.error).toBe("boom");
    expect(failBody.work_dir).toBe("/tmp/fail-work");
    expect(failBody.session_id).toBeUndefined();
    expect(failBody.failed_at).toBeUndefined();
    expect(failBody.failureReason).toBeUndefined();
    expect(failBody.failure_reason).toBe("codex_semantic_inactivity");
    const failedTask = store.getTask(failingTask.id);
    expect(failedTask?.completedAt).toBe(failedTask?.failedAt);

    const camelReasonTask = store.createTask({ agentId: agent.id, prompt: "camel reason should not work" });
    expect(store.claimTask(runtime.id)?.id).toBe(camelReasonTask.id);
    const camelReasonFail = await app.request(`/api/daemon/tasks/${camelReasonTask.id}/fail`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "camel boom", failureReason: "codex_semantic_inactivity" }),
    });
    expect(camelReasonFail.status).toBe(200);
    const camelReasonBody = await camelReasonFail.json();
    expect(camelReasonBody.failure_reason).toBe("agent_error");
    expect(store.getTask(camelReasonTask.id)?.failureReason).toBe("agent_error");

    const queuedTask = store.createTask({ agentId: agent.id, prompt: "not claimed yet" });
    const startQueued = await app.request(`/api/daemon/tasks/${queuedTask.id}/start`, { method: "POST" });
    expect(startQueued.status).toBe(400);
    expect(await startQueued.json()).toEqual({ error: "start task: no rows in result set" });

    const completeQueued = await app.request(`/api/daemon/tasks/${queuedTask.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ output: "too early" }),
    });
    expect(completeQueued.status).toBe(200);
    expect((await completeQueued.json()).status).toBe("queued");

    const waitQueued = await app.request(`/api/daemon/tasks/${queuedTask.id}/wait-local-directory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "/tmp/not-claimed" }),
    });
    expect(waitQueued.status).toBe(400);
    expect(await waitQueued.json()).toEqual({ error: "mark task waiting_local_directory: no rows in result set" });

    const invalidComplete = await app.request(`/api/daemon/tasks/${queuedTask.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidComplete.status).toBe(400);
    expect(await invalidComplete.json()).toEqual({ error: "invalid request body" });

    const missingStart = await app.request("/api/daemon/tasks/missing/start", { method: "POST" });
    expect(missingStart.status).toBe(404);
    const missingStatus = await app.request("/api/daemon/tasks/missing/status");
    expect(missingStatus.status).toBe(404);
  });

  it("does not duplicate task dispatch across concurrent daemon claims", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Concurrent Claude", provider: "claude" });
    const runtime = store.registerRuntime({ name: "concurrent-local", provider: "claude", maxConcurrency: 1 });
    const task = store.createTask({ agentId: agent.id, prompt: "claim once" });
    const app = createMultiremiApp({ store });

    const claims = await Promise.all(Array.from({ length: 8 }, () =>
      app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" })
    ));
    expect(claims.every((response) => response.status === 200)).toBe(true);
    const bodies = await Promise.all(claims.map((response) => response.json()));
    const claimedIds = bodies.map((body: any) => body.task?.id).filter(Boolean);
    expect(claimedIds).toEqual([task.id]);
    expect(bodies.filter((body: any) => body.task === null)).toHaveLength(7);
    expect(store.getTask(task.id)).toMatchObject({
      status: "dispatched",
      runtimeId: runtime.id,
    });

    const emptyClaim = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" });
    expect(emptyClaim.status).toBe(200);
    expect(await emptyClaim.json()).toEqual({ task: null });
  });

  it("serves Go-compatible daemon recover-orphans response", async () => {
    const store = createStore();
    const runningAgent = store.createAgent({ name: "Running Claude", provider: "claude", maxConcurrentTasks: 3 });
    const waitingAgent = store.createAgent({ name: "Waiting Claude", provider: "claude", maxConcurrentTasks: 3 });
    const runtime = store.registerRuntime({ name: "local", provider: "claude", maxConcurrency: 3 });
    const runningIssue = store.createIssue({ title: "Retry running", assigneeType: "agent", assigneeId: runningAgent.id });
    const waitingIssue = store.createIssue({ title: "Retry waiting", assigneeType: "agent", assigneeId: waitingAgent.id });
    const running = store.createTask({ agentId: runningAgent.id, issueId: runningIssue.id, prompt: "running" });
    const waiting = store.createTask({ agentId: waitingAgent.id, issueId: waitingIssue.id, prompt: "waiting" });
    const app = createMultiremiApp({ store });

    expect(store.claimTask(runtime.id)?.id).toBe(running.id);
    store.pinTaskSession(running.id, "sess-running", "/tmp/running");
    store.startTask(running.id);
    expect(store.claimTask(runtime.id)?.id).toBe(waiting.id);
    store.markTaskWaitingLocalDirectory(waiting.id, "/tmp/project");

    const recovered = await app.request(`/api/daemon/runtimes/${runtime.id}/recover-orphans`, { method: "POST" });
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual({ orphaned: 2, retried: 2 });
    expect(store.getTask(running.id)?.failureReason).toBe("runtime_recovery");
    expect(store.getTask(running.id)?.completedAt).toBe(store.getTask(running.id)?.failedAt);
    expect(store.getTask(waiting.id)?.waitReason).toBeNull();
    expect(store.getTask(waiting.id)?.completedAt).toBe(store.getTask(waiting.id)?.failedAt);
    const retryRunning = store.listTasks().find((task) => task.parentTaskId === running.id);
    expect(retryRunning).toMatchObject({
      status: "queued",
      attempt: 2,
      maxAttempts: 3,
      runtimeId: runtime.id,
      issueId: runningIssue.id,
      sessionId: "sess-running",
      workDir: "/tmp/running",
    });

    const missing = await app.request("/api/daemon/runtimes/rt_missing/recover-orphans", { method: "POST" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "runtime not found" });
  });

  it("serves daemon task reports with message idempotency, session pinning, and usage upserts", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const runtime = store.registerRuntime({ name: "local-codex", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, prompt: "write a patch" });
    const waitingTask = store.createTask({ agentId: agent.id, prompt: "wait for checkout" });
    const app = createMultiremiApp({ store });

    expect((await (await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" })).json()).task.id).toBe(task.id);

    const session = await app.request(`/api/daemon/tasks/${task.id}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-live", work_dir: "/tmp/live" }),
    });
    expect(session.status).toBe(204);
    expect(store.getTask(task.id)?.sessionId).toBe("sess-live");
    expect(store.getTask(task.id)?.workDir).toBe("/tmp/live");

    const emptySession = await app.request(`/api/daemon/tasks/${task.id}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(emptySession.status).toBe(400);
    expect(await emptySession.json()).toEqual({ error: "session_id or work_dir required" });

    const camelCaseSession = await app.request(`/api/daemon/tasks/${task.id}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "sess-camel", workDir: "/tmp/camel" }),
    });
    expect(camelCaseSession.status).toBe(400);
    expect(await camelCaseSession.json()).toEqual({ error: "session_id or work_dir required" });
    expect(store.getTask(task.id)?.sessionId).toBe("sess-live");
    expect(store.getTask(task.id)?.workDir).toBe("/tmp/live");

    const progress = await app.request(`/api/daemon/tasks/${task.id}/progress`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary: "editing", step: 1, total: 3 }),
    });
    expect(progress.status).toBe(200);
    expect(await progress.json()).toEqual({ status: "ok" });
    expect(store.getTask(task.id)?.progressSummary).toBe("editing");

    const firstMessages = await app.request(`/api/daemon/tasks/${task.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { seq: 1, type: "assistant", content: "starting" },
          { seq: 2, type: "tool", tool: "edit", input: { path: "README.md" }, output: "ok" },
        ],
      }),
    });
    expect(firstMessages.status).toBe(200);
    expect(await firstMessages.json()).toEqual({ status: "ok" });
    const seqTwoId = store.listTaskMessages(task.id).find((message) => message.seq === 2)?.id;
    expect(seqTwoId).toBeString();

    const replayedMessages = await app.request(`/api/daemon/tasks/${task.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ seq: 2, type: "tool", tool: "edit", input: { path: "README.md" }, output: "updated" }] }),
    });
    expect(await replayedMessages.json()).toEqual({ status: "ok" });
    const replayedMessage = store.listTaskMessages(task.id).find((message) => message.seq === 2);
    expect(replayedMessage?.id).toBe(seqTwoId);
    expect(replayedMessage?.output).toBe("updated");
    const since = await app.request(`/api/daemon/tasks/${task.id}/messages?since_seq=1`);
    const sinceBody = await since.json();
    expect(sinceBody.map((message: any) => [message.seq, message.output])).toEqual([[2, "updated"]]);
    expect(sinceBody[0].task_id).toBe(task.id);
    expect(sinceBody[0].taskId).toBeUndefined();
    const invalidSince = await app.request(`/api/daemon/tasks/${task.id}/messages?since=bad`);
    expect(invalidSince.status).toBe(400);

    const invalidMessages = await app.request(`/api/daemon/tasks/${task.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidMessages.status).toBe(400);
    expect(await invalidMessages.json()).toEqual({ error: "invalid request body" });

    const usageFirst = await app.request(`/api/daemon/tasks/${task.id}/usage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usage: [{ provider: "codex", model: "gpt-5", inputTokens: 10, outputTokens: 5 }] }),
    });
    expect(await usageFirst.json()).toEqual({ status: "ok" });
    expect(store.getTask(task.id)!.usage).toEqual([{
      provider: "codex",
      model: "gpt-5",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    }]);
    const usageSecond = await app.request(`/api/daemon/tasks/${task.id}/usage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        usage: [
          { provider: "codex", model: "gpt-5", input_tokens: 12, output_tokens: 6, cache_read_tokens: 3 },
          { provider: "claude", model: "sonnet", input_tokens: 2, output_tokens: 1 },
        ],
      }),
    });
    expect(await usageSecond.json()).toEqual({ status: "ok" });
    const usage = store.getTask(task.id)!.usage;
    expect(usage).toHaveLength(2);
    expect(usage.find((entry) => entry.provider === "codex" && entry.model === "gpt-5")).toMatchObject({
      inputTokens: 12,
      outputTokens: 6,
      cacheReadTokens: 3,
    });

    store.completeTask(task.id, { output: "done" });
    const terminalProgress = await app.request(`/api/daemon/tasks/${task.id}/progress`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary: "too late" }),
    });
    expect(terminalProgress.status).toBe(200);
    expect(await terminalProgress.json()).toEqual({ status: "ok" });

    expect((await (await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" })).json()).task.id).toBe(waitingTask.id);
    store.markTaskWaitingLocalDirectory(waitingTask.id, "/tmp/repo");
    const skippedSession = await app.request(`/api/daemon/tasks/${waitingTask.id}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-should-not-stick", work_dir: "/tmp/waiting" }),
    });
    expect(skippedSession.status).toBe(204);
    expect(store.getTask(waitingTask.id)?.sessionId).toBeNull();
    expect(store.getTask(waitingTask.id)?.workDir).toBeNull();

    const missingMessages = await app.request("/api/daemon/tasks/missing/messages");
    expect(missingMessages.status).toBe(404);
  });

  it("serves Go-compatible daemon GC checks with workspace anti-enumeration", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "GC Codex", provider: "codex" });
    const runtime = store.registerRuntime({
      name: "local-gc-codex",
      provider: "codex",
      workspaceId: "local",
      daemonId: "daemon-local-gc",
    });
    const issue = store.createIssue({ title: "GC issue", workspaceId: "local" });
    const chat = store.createChatSession({ agentId: agent.id, workspaceId: "local", title: "GC chat" });
    const autopilot = store.createAutopilot({
      title: "GC autopilot",
      workspaceId: "local",
      assigneeId: agent.id,
      issueTitleTemplate: "GC run",
    });
    const run = store.runAutopilot(autopilot.id);
    expect(store.claimTask(runtime.id)?.id).toBe(run.taskId!);
    store.startTask(run.taskId!);
    store.completeTask(run.taskId!, { output: "done" });
    const completedRun = store.getAutopilotRun(run.id)!;
    const task = store.createTask({ agentId: agent.id, workspaceId: "local", prompt: "quick create gc" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    const completedTask = store.completeTask(task.id, { output: "done" });

    const remoteIssue = store.createIssue({ title: "Remote GC issue", workspaceId: "remote" });
    const remoteAgent = store.createAgent({ name: "Remote GC Codex", provider: "codex", workspaceId: "remote" });
    const remoteChat = store.createChatSession({ agentId: remoteAgent.id, workspaceId: "remote", title: "Remote GC chat" });
    const remoteAutopilot = store.createAutopilot({
      title: "Remote GC autopilot",
      workspaceId: "remote",
      assigneeId: remoteAgent.id,
      issueTitleTemplate: "Remote GC run",
    });
    const remoteRun = store.runAutopilot(remoteAutopilot.id);
    const remoteTask = store.createTask({ agentId: remoteAgent.id, workspaceId: "remote", prompt: "remote quick create gc" });
    const daemonToken = await store.createAccessToken({
      workspaceId: "local",
      name: "Local daemon",
      type: "daemon",
      daemonId: "daemon-local-gc",
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const daemonHeaders = { Authorization: `Bearer ${daemonToken.token}` };

    const completedIssueWithQueuedTask = store.createIssue({ title: "GC hold", workspaceId: "local" });
    const queuedIssueTask = store.createTask({
      agentId: agent.id,
      issueId: completedIssueWithQueuedTask.id,
      prompt: "Maintain Wiki before GC",
    });
    store.updateIssue(completedIssueWithQueuedTask.id, { status: "done" });
    const heldGc = await app.request(
      `/api/daemon/issues/${completedIssueWithQueuedTask.id}/gc-check`,
      { headers: daemonHeaders },
    );
    expect((await heldGc.json()).status).toBe("active");
    store.cancelTask(queuedIssueTask.id);
    const releasedGc = await app.request(
      `/api/daemon/issues/${completedIssueWithQueuedTask.id}/gc-check`,
      { headers: daemonHeaders },
    );
    expect((await releasedGc.json()).status).toBe("done");

    const issueGc = await app.request(`/api/daemon/issues/${issue.id}/gc-check`, { headers: daemonHeaders });
    expect(await issueGc.json()).toEqual({ status: "todo", updated_at: issue.updatedAt });
    const chatGc = await app.request(`/api/daemon/chat-sessions/${chat.id}/gc-check`, { headers: daemonHeaders });
    expect(await chatGc.json()).toEqual({ status: "active", updated_at: chat.updatedAt });
    const runGc = await app.request(`/api/daemon/autopilot-runs/${completedRun.id}/gc-check`, { headers: daemonHeaders });
    expect(await runGc.json()).toEqual({ status: "completed", completed_at: completedRun.completedAt });
    const taskGc = await app.request(`/api/daemon/tasks/${completedTask.id}/gc-check`, { headers: daemonHeaders });
    expect(await taskGc.json()).toEqual({ status: "completed", completed_at: completedTask.completedAt });

    for (const path of [
      `/api/daemon/issues/${remoteIssue.id}/gc-check`,
      `/api/daemon/chat-sessions/${remoteChat.id}/gc-check`,
      `/api/daemon/autopilot-runs/${remoteRun.id}/gc-check`,
      `/api/daemon/tasks/${remoteTask.id}/gc-check`,
    ]) {
      const crossWorkspace = await app.request(path, { headers: daemonHeaders });
      expect(crossWorkspace.status).toBe(404);
      expect(await crossWorkspace.json()).toEqual({ error: "not found" });
    }

    const remoteTaskStart = await app.request(`/api/daemon/tasks/${remoteTask.id}/start`, {
      method: "POST",
      headers: daemonHeaders,
    });
    expect(remoteTaskStart.status).toBe(403);
  });

  it("serves agent task history and workspace task snapshots", async () => {
    const store = createStore();
    const agentA = store.createAgent({ name: "Snapshot A", provider: "codex" });
    const agentB = store.createAgent({ name: "Snapshot B", provider: "claude" });
    const agentC = store.createAgent({ name: "Snapshot C", provider: "codex" });
    const runtime = store.registerRuntime({ name: "snapshot-runtime", provider: "any" });
    const app = createMultiremiApp({ store });

    const queued = store.createTask({ agentId: agentA.id, prompt: "A queued" });
    const running = store.createTask({ agentId: agentA.id, prompt: "A running" });
    db!.run("UPDATE multiremi_tasks SET status = 'running', runtime_id = ?, started_at = ?, updated_at = ? WHERE id = ?", [
      runtime.id,
      "2026-06-04T01:00:00.000Z",
      "2026-06-04T01:00:00.000Z",
      running.id,
    ]);
    const oldFailed = store.createTask({ agentId: agentA.id, prompt: "A old failed" });
    db!.run("UPDATE multiremi_tasks SET status = 'failed', failed_at = ?, updated_at = ? WHERE id = ?", [
      "2026-06-04T01:01:00.000Z",
      "2026-06-04T01:01:00.000Z",
      oldFailed.id,
    ]);
    const latestCompleted = store.createTask({ agentId: agentA.id, prompt: "A latest completed" });
    db!.run("UPDATE multiremi_tasks SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?", [
      "2026-06-04T01:02:00.000Z",
      "2026-06-04T01:02:00.000Z",
      latestCompleted.id,
    ]);
    const staleFailure = store.createTask({ agentId: agentB.id, prompt: "B stale failed" });
    db!.run("UPDATE multiremi_tasks SET status = 'failed', failed_at = ?, updated_at = ? WHERE id = ?", [
      "2026-06-04T00:50:00.000Z",
      "2026-06-04T00:50:00.000Z",
      staleFailure.id,
    ]);
    const failureBeforeCancel = store.createTask({ agentId: agentC.id, prompt: "C failure" });
    db!.run("UPDATE multiremi_tasks SET status = 'failed', failed_at = ?, updated_at = ? WHERE id = ?", [
      "2026-06-04T00:55:00.000Z",
      "2026-06-04T00:55:00.000Z",
      failureBeforeCancel.id,
    ]);
    const cancelled = store.createTask({ agentId: agentC.id, prompt: "C cancelled" });
    db!.run("UPDATE multiremi_tasks SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ?", [
      "2026-06-04T01:03:00.000Z",
      "2026-06-04T01:03:00.000Z",
      cancelled.id,
    ]);

    const snapshot = await app.request("/api/agent-task-snapshot?workspace_id=local");
    const snapshotBody = await snapshot.json();
    const ids = snapshotBody.map((task: any) => task.id).sort();
    expect(ids).toEqual([queued.id, running.id, latestCompleted.id, staleFailure.id, failureBeforeCancel.id].sort());
    expect(ids).not.toContain(oldFailed.id);
    expect(ids).not.toContain(cancelled.id);

    const multiremiSnapshot = await app.request("/api/multiremi/agent-task-snapshot?workspace_id=local");
    const multiremiSnapshotBody = await multiremiSnapshot.json();
    expect(multiremiSnapshotBody.total).toBe(5);
    expect(multiremiSnapshotBody.tasks.map((task: any) => task.id).sort()).toEqual(ids);

    const agentTasks = await app.request(`/api/agents/${agentA.id}/tasks`);
    const agentTaskBody = await agentTasks.json();
    expect(agentTaskBody.map((task: any) => task.id)).toContain(queued.id);

    const multiremiAgentTasks = await app.request(`/api/multiremi/agents/${agentA.id}/tasks`);
    const multiremiAgentTaskBody = await multiremiAgentTasks.json();
    expect(multiremiAgentTaskBody.total).toBe(4);
  });

  it("serves workspace agent run counts and 30 day activity buckets", async () => {
    const store = createStore();
    const agentA = store.createAgent({ name: "Activity A", provider: "codex" });
    const agentB = store.createAgent({ name: "Activity B", provider: "claude" });
    const app = createMultiremiApp({ store });

    const now = Date.now();
    const recentCreated = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
    const oldCreated = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString();
    const recentCompletedA = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const recentCompletedB = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString();

    const completed = store.createTask({ agentId: agentA.id, prompt: "completed" });
    db!.run("UPDATE multiremi_tasks SET status = 'completed', created_at = ?, completed_at = ?, updated_at = ? WHERE id = ?", [
      recentCreated,
      recentCompletedA,
      recentCompletedA,
      completed.id,
    ]);
    const failed = store.createTask({ agentId: agentA.id, prompt: "failed" });
    db!.run("UPDATE multiremi_tasks SET status = 'failed', created_at = ?, completed_at = ?, updated_at = ? WHERE id = ?", [
      recentCreated,
      recentCompletedA,
      recentCompletedA,
      failed.id,
    ]);
    const inFlight = store.createTask({ agentId: agentA.id, prompt: "in flight" });
    db!.run("UPDATE multiremi_tasks SET created_at = ?, updated_at = ? WHERE id = ?", [recentCreated, recentCreated, inFlight.id]);
    const old = store.createTask({ agentId: agentA.id, prompt: "old" });
    db!.run("UPDATE multiremi_tasks SET status = 'completed', created_at = ?, completed_at = ?, updated_at = ? WHERE id = ?", [
      oldCreated,
      oldCreated,
      oldCreated,
      old.id,
    ]);
    const otherAgent = store.createTask({ agentId: agentB.id, prompt: "other agent" });
    db!.run("UPDATE multiremi_tasks SET status = 'completed', created_at = ?, completed_at = ?, updated_at = ? WHERE id = ?", [
      recentCreated,
      recentCompletedB,
      recentCompletedB,
      otherAgent.id,
    ]);

    const runCounts = await app.request("/api/agent-run-counts?workspace_id=local");
    const runCountBody = await runCounts.json();
    expect(runCountBody.find((row: any) => row.agent_id === agentA.id)?.run_count).toBe(3);
    expect(runCountBody.find((row: any) => row.agent_id === agentB.id)?.run_count).toBe(1);

    const multiremiRunCounts = await app.request("/api/multiremi/agent-run-counts?workspace_id=local");
    const multiremiRunCountBody = await multiremiRunCounts.json();
    expect(multiremiRunCountBody.total).toBe(2);
    expect(multiremiRunCountBody.counts.find((row: any) => row.agentId === agentA.id)?.runCount).toBe(3);

    const activity = await app.request("/api/agent-activity-30d?workspace_id=local");
    const activityBody = await activity.json();
    const agentABucket = activityBody.find((row: any) => row.agent_id === agentA.id);
    expect(agentABucket.task_count).toBe(2);
    expect(agentABucket.failed_count).toBe(1);
    expect(agentABucket.bucket_at).toEndWith("T00:00:00.000Z");
    expect(activityBody.find((row: any) => row.agent_id === agentB.id)?.task_count).toBe(1);

    const multiremiActivity = await app.request("/api/multiremi/agent-activity-30d?workspace_id=local");
    const multiremiActivityBody = await multiremiActivity.json();
    expect(multiremiActivityBody.total).toBe(2);
    expect(multiremiActivityBody.activity.find((row: any) => row.agentId === agentA.id)?.failedCount).toBe(1);
  });
});
