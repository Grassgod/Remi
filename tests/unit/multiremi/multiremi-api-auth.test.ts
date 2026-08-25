// Bearer auth, daemon-token route scoping, and the cookie fallback for safe methods.
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, resetMultiremiTestEnv, signTestJwt } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Multiremi API — authentication and token scoping", () => {
  it("scopes task-token Repository Wiki CRUD to the task project repository", async () => {
    const store = createStore();
    const workspace = store.ensureLocalWorkspace();
    store.updateWorkspace(workspace.id, {
      repos: [
        { id: "repo_alpha", name: "alpha", url: "git@github.com:acme/alpha.git", source: "github" },
        { id: "repo_beta", name: "beta", url: "git@github.com:acme/beta.git", source: "github" },
      ],
    });
    const project = store.createProject({ title: "Alpha project", workspaceId: workspace.id });
    store.createProjectResource(project.id, {
      resourceType: "github_repo",
      resourceRef: { url: "git@github.com:acme/alpha.git" },
    });
    const agent = store.createAgent({ name: "Wiki agent", provider: "codex", workspaceId: workspace.id });
    const issue = store.createIssue({ title: "Update Alpha Wiki", workspaceId: workspace.id, projectId: project.id });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: workspace.id, prompt: "work" });
    const taskToken = await store.createTaskAccessToken(task, "local");
    const daemonToken = await store.createAccessToken({
      name: "Daemon",
      type: "daemon",
      purpose: "daemon",
      workspaceId: workspace.id,
      userId: "local",
      daemonId: "daemon_local",
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const auth = { Authorization: `Bearer ${taskToken.token}` };
    const jsonAuth = { ...auth, "Content-Type": "application/json" };
    const root = `/api/workspaces/${workspace.id}/repos/repo_alpha/wiki`;

    expect((await app.request(root, { headers: auth })).status).toBe(200);
    const createdResponse = await app.request(root, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ path: "overview.md", title: "Overview", body: "Alpha facts" }),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json() as any).doc;
    expect((await app.request(`${root}/${created.id}`, { headers: auth })).status).toBe(200);

    const updated = await app.request(`${root}/${created.id}`, {
      method: "PUT",
      headers: jsonAuth,
      body: JSON.stringify({ body: "Alpha facts v2", expected_version: 1 }),
    });
    expect(updated.status).toBe(200);
    expect((await updated.json() as any).doc.version).toBe(2);
    expect((await app.request(`${root}/${created.id}/revisions`, { headers: auth })).status).toBe(200);

    const foreignRoot = `/api/workspaces/${workspace.id}/repos/repo_beta/wiki`;
    for (const [method, path] of [
      ["GET", foreignRoot],
      ["POST", foreignRoot],
      ["GET", `${foreignRoot}/secret`],
      ["PUT", `${foreignRoot}/secret`],
      ["DELETE", `${foreignRoot}/secret`],
      ["GET", `${foreignRoot}/secret/revisions`],
    ] as const) {
      const foreign = await app.request(path, { method, headers: jsonAuth });
      expect(foreign.status).toBe(404);
      expect(await foreign.json()).toEqual({ error: "repository not found" });
    }

    const build = await app.request(`${root}/build`, { method: "POST", headers: auth });
    expect(build.status).toBe(403);
    expect(await build.json()).toEqual({ error: "forbidden for task token" });

    const daemon = await app.request(root, {
      headers: { Authorization: `Bearer ${daemonToken.token}` },
    });
    expect(daemon.status).toBe(403);
    expect(await daemon.json()).toEqual({ error: "forbidden for daemon token" });

    expect((await app.request(`${root}/${created.id}`, { method: "DELETE", headers: auth })).status).toBe(200);
  });

  // Native browser loads (<img src="/api/attachments/…/content">) cannot set
  // an Authorization header — they authenticate via the HttpOnly login cookie,
  // accepted for safe methods only so cookie auth can never mutate state.
  it("accepts the multimira_auth cookie for GET requests only", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const login = await store.createAccessToken({
      name: "Login",
      type: "pat",
      purpose: "session",
      workspaceId: "local",
      userId: "local",
    });
    const cookie = { Cookie: `multimira_auth=${login.token}` };

    expect((await app.request("/api/issues")).status).toBe(401);
    expect((await app.request("/api/issues", { headers: cookie })).status).toBe(200);

    // Unsafe methods must still require the Authorization header.
    const post = await app.request("/api/issues", {
      method: "POST",
      headers: { ...cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "cookie post" }),
    });
    expect(post.status).toBe(401);

    // A bad cookie value stays unauthorized.
    const badCookie = await app.request("/api/issues", { headers: { Cookie: "multimira_auth=nope" } });
    expect(badCookie.status).toBe(401);

    // A malformed/non-Bearer Authorization header must fail, not silently
    // fall back to the cookie — header presence wins.
    const basicHeader = await app.request("/api/issues", {
      headers: { ...cookie, Authorization: "Basic dXNlcjpwdw==" },
    });
    expect(basicHeader.status).toBe(401);

    // /api/me mirrors a verified bearer token into the cookie so sessions
    // that predate cookie auth pick it up without re-logging in.
    const me = await app.request("/api/me", { headers: { Authorization: `Bearer ${login.token}` } });
    expect(me.status).toBe(200);
    expect(me.headers.get("set-cookie") ?? "").toContain(`multimira_auth=${login.token}`);

    // …but never the master token: a non-expiring deployment-wide admin
    // secret must not become an ambient cookie.
    const meMaster = await app.request("/api/me", { headers: { Authorization: "Bearer root-secret" } });
    expect(meMaster.status).toBe(200);
    expect(meMaster.headers.get("set-cookie") ?? "").not.toContain("multimira_auth");

    // Logout clears the cookie.
    const logout = await app.request("/auth/logout", { method: "POST", headers: cookie });
    expect(logout.headers.get("set-cookie") ?? "").toContain("multimira_auth=;");
    expect(await store.verifyAccessToken(login.token)).toBeNull();
  });

  it("mints a task-scoped token for an ownerless legacy runtime claim", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({
      id: "rt_ownerless_legacy",
      name: "Legacy Codex",
      provider: "codex",
      ownerId: null,
    });
    const agent = store.createAgent({
      name: "Legacy task agent",
      provider: "codex",
      workspaceId: "local",
      runtimeId: runtime.id,
    });
    const issue = store.createIssue({
      title: "Legacy task token",
      workspaceId: "local",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "legacy claim" });
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const claim = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, {
      method: "POST",
      headers: { Authorization: "Bearer root-secret" },
    });
    expect(claim.status).toBe(200);
    const body = await claim.json();
    expect(body.task.auth_token).toStartWith("mat_");
    expect(await store.verifyAccessToken(body.task.auth_token)).toMatchObject({
      type: "task",
      purpose: "task",
      userId: "local",
      workspaceId: "local",
      taskId: task.id,
      agentId: agent.id,
    });

    const daemonControlPlane = await app.request("/api/daemon/heartbeat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${body.task.auth_token}`,
      },
      body: JSON.stringify({ runtime_id: runtime.id }),
    });
    expect(daemonControlPlane.status).toBe(403);
    expect(await daemonControlPlane.json()).toEqual({ error: "forbidden for task token" });
  });

  it("protects APIs with bearer auth and scopes daemon tokens to daemon routes", async () => {
    const store = createStore();
    store.createWorkspaceMember({
      id: "usr_runtime_owner",
      name: "Runtime owner",
      role: "member",
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const unauthorized = await app.request("/api/multiremi/agents");
    expect(unauthorized.status).toBe(401);

    const patCreated = await app.request("/api/multiremi/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer root-secret" },
      body: JSON.stringify({ name: "Console token", type: "pat", workspaceId: "local", expiresInDays: 3 }),
    });
    expect(patCreated.status).toBe(201);
    const patBody = await patCreated.json();
    expect(patBody.token.token).toStartWith("mul_");
    expect(patBody.token.tokenPrefix).toBe(patBody.token.token.slice(0, 12));

    const longPatCreated = await app.request("/api/multiremi/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer root-secret" },
      body: JSON.stringify({ name: "Long console token", type: "pat", workspaceId: "local", expiresInDays: 30 }),
    });
    expect(longPatCreated.status).toBe(201);
    const longPatBody = await longPatCreated.json();

    const daemonCreated = await app.request("/api/multiremi/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer root-secret" },
      body: JSON.stringify({
        name: "Local daemon",
        type: "daemon",
        workspaceId: "local",
        userId: "usr_runtime_owner",
      }),
    });
    expect(daemonCreated.status).toBe(201);
    const daemonBody = await daemonCreated.json();
    expect(daemonBody.token.token).toStartWith("mdt_");
    expect(daemonBody.token.tokenPrefix).toBe(daemonBody.token.token.slice(0, 12));

    const publicTaskTokenCreated = await app.request("/api/multiremi/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer root-secret" },
      body: JSON.stringify({ name: "Bad task token", type: "task", workspaceId: "local", taskId: "tsk_bad", agentId: "agt_bad" }),
    });
    expect(publicTaskTokenCreated.status).toBe(400);
    expect(await publicTaskTokenCreated.json()).toEqual({ error: "task tokens are minted by daemon task claim" });

    const ownerPatCreated = await app.request("/api/multiremi/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer root-secret" },
      body: JSON.stringify({
        name: "Runtime owner token",
        type: "pat",
        workspaceId: "local",
        userId: "usr_runtime_owner",
        expiresInDays: 30,
      }),
    });
    expect(ownerPatCreated.status).toBe(201);
    const ownerPatBody = await ownerPatCreated.json();
    expect(ownerPatBody.token.userId).toBe("usr_runtime_owner");

    const ownerRegistered = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerPatBody.token.token}` },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "daemon-owner",
        device_name: "Owner Laptop",
        runtimes: [{ type: "codex", version: "1.0.0" }],
      }),
    });
    expect(ownerRegistered.status).toBe(200);
    const ownerRegisteredBody = await ownerRegistered.json();
    const ownerRuntimeId = ownerRegisteredBody.runtimes[0].id;
    expect(ownerRegisteredBody.runtimes[0].owner_id).toBe("usr_runtime_owner");
    expect(store.getRuntime(ownerRuntimeId)?.ownerId).toBe("usr_runtime_owner");

    const crossWorkspacePatRegister = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerPatBody.token.token}` },
      body: JSON.stringify({ workspace_id: "remote", daemon_id: "daemon-owner-remote", runtimes: [{ type: "codex" }] }),
    });
    expect(crossWorkspacePatRegister.status).toBe(403);

    const ownerReregisteredByDaemon = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${daemonBody.token.token}` },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "daemon-owner",
        device_name: "Owner Laptop",
        runtimes: [{ type: "codex", version: "1.0.1" }],
      }),
    });
    expect(ownerReregisteredByDaemon.status).toBe(200);
    expect(store.getRuntime(ownerRuntimeId)?.ownerId).toBe("usr_runtime_owner");

    const taskTokenAgent = store.createAgent({
      name: "Task token agent",
      provider: "codex",
      workspaceId: "local",
      // Owner matches the private runtime's owner so the ownership guard lets
      // the claim through — this case exercises task tokens, not scheduling.
      ownerId: "usr_runtime_owner",
      runtimeId: ownerRuntimeId,
    });
    const taskTokenIssue = store.createIssue({
      title: "Task token issue",
      assigneeType: "agent",
      assigneeId: taskTokenAgent.id,
    });
    const taskTokenTask = store.createTask({
      agentId: taskTokenAgent.id,
      issueId: taskTokenIssue.id,
      workspaceId: "local",
      prompt: "use task token",
    });
    const taskTokenClaim = await app.request(`/api/daemon/runtimes/${ownerRuntimeId}/tasks/claim`, {
      method: "POST",
      headers: { Authorization: `Bearer ${daemonBody.token.token}` },
    });
    expect(taskTokenClaim.status).toBe(200);
    const taskTokenClaimBody = await taskTokenClaim.json();
    expect(taskTokenClaimBody.task.auth_token).toStartWith("mat_");
    const taskAccessToken = await store.verifyAccessToken(taskTokenClaimBody.task.auth_token);
    expect(taskAccessToken).toMatchObject({
      type: "task",
      workspaceId: "local",
      userId: "usr_runtime_owner",
      taskId: taskTokenTask.id,
      agentId: taskTokenAgent.id,
    });

    const taskTokenOnDaemonRoute = await app.request(`/api/daemon/tasks/${taskTokenTask.id}/status`, {
      headers: { Authorization: `Bearer ${taskTokenClaimBody.task.auth_token}` },
    });
    expect(taskTokenOnDaemonRoute.status).toBe(403);
    expect(await taskTokenOnDaemonRoute.json()).toEqual({ error: "forbidden for task token" });

    const taskTokenComment = await app.request(`/api/issues/${taskTokenIssue.id}/comments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${taskTokenClaimBody.task.auth_token}`,
      },
      body: JSON.stringify({
        content: "agent-authenticated comment",
        authorType: "member",
        authorId: "forged-member",
      }),
    });
    expect(taskTokenComment.status).toBe(201);
    const taskTokenCommentBody = await taskTokenComment.json();
    expect(taskTokenCommentBody).toMatchObject({
      author_type: "agent",
      author_id: taskTokenAgent.id,
      content: "agent-authenticated comment",
    });

    store.completeTask(taskTokenTask.id, { output: "done" });
    expect(await store.verifyAccessToken(taskTokenClaimBody.task.auth_token)).toBeNull();
    const taskTokenAfterTerminal = await app.request("/api/multiremi/agents", {
      headers: { Authorization: `Bearer ${taskTokenClaimBody.task.auth_token}` },
    });
    expect(taskTokenAfterTerminal.status).toBe(401);

    const jwtToken = signTestJwt({ sub: "local", exp: Math.floor(Date.now() / 1000) + 60 });
    const jwtRegistered = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwtToken}` },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "daemon-jwt-owner",
        device_name: "JWT Laptop",
        runtimes: [{ type: "codex", version: "1.0.0" }],
      }),
    });
    expect(jwtRegistered.status).toBe(200);
    const jwtRegisteredBody = await jwtRegistered.json();
    expect(jwtRegisteredBody.runtimes[0].owner_id).toBe("local");
    expect(store.getRuntime(jwtRegisteredBody.runtimes[0].id)?.ownerId).toBe("local");

    const jwtWithoutWorkspaceAccess = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${signTestJwt({ sub: "ghost-user" })}` },
      body: JSON.stringify({ workspace_id: "local", daemon_id: "daemon-jwt-ghost", runtimes: [{ type: "codex" }] }),
    });
    expect(jwtWithoutWorkspaceAccess.status).toBe(403);

    const expiredJwtRegister = await app.request("/api/daemon/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${signTestJwt({ sub: "local", exp: Math.floor(Date.now() / 1000) - 60 })}`,
      },
      body: JSON.stringify({ workspace_id: "local", daemon_id: "daemon-jwt-expired", runtimes: [{ type: "codex" }] }),
    });
    expect(expiredJwtRegister.status).toBe(401);

    const withPatToken = await app.request("/api/multiremi/agents", {
      headers: { Authorization: `Bearer ${patBody.token.token}` },
    });
    expect(withPatToken.status).toBe(200);

    const patRenewed = await app.request("/api/tokens/current/renew", {
      method: "POST",
      headers: { Authorization: `Bearer ${patBody.token.token}` },
    });
    expect(patRenewed.status).toBe(200);
    const patRenewedBody = await patRenewed.json();
    expect(patRenewedBody.renewed).toBe(true);
    expect(patRenewedBody.access_token).toStartWith("mul_");
    expect(patRenewedBody.access_token).not.toBe(patBody.token.token);
    expect(patRenewedBody.token_type).toBe("bearer");
    expect(patRenewedBody.expires_at).toBeString();
    expect(Date.parse(patRenewedBody.expires_at)).toBeGreaterThan(Date.now() + 80 * 24 * 60 * 60 * 1000);

    const oldPatAfterRenew = await app.request("/api/multiremi/agents", {
      headers: { Authorization: `Bearer ${patBody.token.token}` },
    });
    expect(oldPatAfterRenew.status).toBe(401);
    const rotatedPatWorksAfterRenew = await app.request("/api/multiremi/agents", {
      headers: { Authorization: `Bearer ${patRenewedBody.access_token}` },
    });
    expect(rotatedPatWorksAfterRenew.status).toBe(200);

    const patRenewedAgain = await app.request("/api/tokens/current/renew", {
      method: "POST",
      headers: { Authorization: `Bearer ${patRenewedBody.access_token}` },
    });
    expect(patRenewedAgain.status).toBe(200);
    const patRenewedAgainBody = await patRenewedAgain.json();
    expect(patRenewedAgainBody.renewed).toBe(false);
    expect(patRenewedAgainBody.access_token).toBeUndefined();
    expect(patRenewedAgainBody.expires_at).toBe(patRenewedBody.expires_at);

    const longPatRenewed = await app.request("/api/tokens/current/renew", {
      method: "POST",
      headers: { Authorization: `Bearer ${longPatBody.token.token}` },
    });
    expect(longPatRenewed.status).toBe(200);
    const longPatRenewedBody = await longPatRenewed.json();
    expect(longPatRenewedBody.renewed).toBe(false);
    expect(longPatRenewedBody.expires_at).toBe(longPatBody.token.expiresAt);

    const withDaemonOnConsole = await app.request("/api/multiremi/agents", {
      headers: { Authorization: `Bearer ${daemonBody.token.token}` },
    });
    expect(withDaemonOnConsole.status).toBe(403);

    const daemonRenew = await app.request("/api/tokens/current/renew", {
      method: "POST",
      headers: { Authorization: `Bearer ${daemonBody.token.token}` },
    });
    expect(daemonRenew.status).toBe(403);

    const registeredRuntime = await app.request("/api/multiremi/runtimes", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${daemonBody.token.token}` },
      body: JSON.stringify({
        id: "rt_auth_daemon",
        name: "Auth daemon",
        provider: "codex",
        workspaceId: "local",
        daemonId: "daemon-owner",
      }),
    });
    expect(registeredRuntime.status).toBe(201);

    const daemonClaim = await app.request("/api/daemon/runtimes/rt_auth_daemon/tasks/claim", {
      method: "POST",
      headers: { Authorization: `Bearer ${daemonBody.token.token}` },
    });
    expect(daemonClaim.status).toBe(200);

    const localHeartbeat = await app.request("/api/multiremi/runtimes/rt_auth_daemon/heartbeat", {
      method: "POST",
      headers: { Authorization: `Bearer ${daemonBody.token.token}` },
    });
    expect(localHeartbeat.status).toBe(200);

    const otherDaemonRuntime = store.registerRuntime({
      id: "rt_other_daemon_same_workspace",
      name: "Other daemon in local workspace",
      provider: "codex",
      workspaceId: "local",
      daemonId: "daemon-other",
    });
    const otherDaemonAgent = store.createAgent({
      name: "Other daemon agent",
      provider: "codex",
      workspaceId: "local",
      runtimeId: otherDaemonRuntime.id,
    });
    const otherDaemonTask = store.createTask({ agentId: otherDaemonAgent.id, prompt: "stay on the other machine" });
    const otherDaemonIssue = store.createIssue({
      title: "Other daemon issue",
      assigneeType: "agent",
      assigneeId: otherDaemonAgent.id,
      workspaceId: "local",
    });
    const otherDaemonIssueTask = store.createTask({
      agentId: otherDaemonAgent.id,
      issueId: otherDaemonIssue.id,
      prompt: "prepare the other machine workspace",
    });
    const forgedLegacyMigration = await app.request("/api/daemon/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${daemonBody.token.token}`,
      },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "daemon-owner",
        legacy_daemon_ids: ["daemon-other"],
        runtimes: [{ type: "codex", version: "1.0.2" }],
      }),
    });
    expect(forgedLegacyMigration.status).toBe(200);
    expect(store.getRuntime(otherDaemonRuntime.id)?.daemonId).toBe("daemon-other");
    expect(store.getTask(otherDaemonTask.id)?.runtimeId).toBe(otherDaemonRuntime.id);
    const humanLegacyMigration = await app.request("/api/daemon/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerPatBody.token.token}`,
      },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "daemon-human-legacy-hint",
        legacy_daemon_ids: ["daemon-other"],
        runtimes: [{ type: "codex", version: "1.0.2" }],
      }),
    });
    expect(humanLegacyMigration.status).toBe(200);
    expect(store.getRuntime(otherDaemonRuntime.id)?.daemonId).toBe("daemon-other");
    expect(store.getTask(otherDaemonTask.id)?.runtimeId).toBe(otherDaemonRuntime.id);
    const crossDaemonRuntimeRoutes = [
      { method: "POST", path: `/api/daemon/runtimes/${otherDaemonRuntime.id}/tasks/claim` },
      { method: "GET", path: `/api/daemon/runtimes/${otherDaemonRuntime.id}/tasks/pending` },
      { method: "POST", path: `/api/daemon/runtimes/${otherDaemonRuntime.id}/recover-orphans` },
      { method: "POST", path: `/api/multiremi/runtimes/${otherDaemonRuntime.id}/heartbeat` },
    ];
    for (const route of crossDaemonRuntimeRoutes) {
      const response = await app.request(route.path, {
        method: route.method,
        headers: { Authorization: `Bearer ${daemonBody.token.token}` },
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: "forbidden for daemon identity",
        code: "daemon_identity_forbidden",
      });
    }
    expect(store.getTask(otherDaemonTask.id)?.status).toBe("queued");
    expect(store.claimTask(otherDaemonRuntime.id)?.id).toBe(otherDaemonTask.id);
    const crossDaemonClaimedTaskRoutes: Array<{ method: string; path: string; body?: unknown }> = [
      { method: "POST", path: `/api/daemon/tasks/${otherDaemonTask.id}/start` },
      {
        method: "POST",
        path: `/api/daemon/tasks/${otherDaemonTask.id}/messages`,
        body: { messages: [{ seq: 1, type: "assistant", content: "hijacked" }] },
      },
      { method: "GET", path: `/api/daemon/tasks/${otherDaemonTask.id}/messages` },
      {
        method: "POST",
        path: `/api/daemon/tasks/${otherDaemonTask.id}/session`,
        body: { session_id: "sess-hijacked", work_dir: "/tmp/hijacked" },
      },
      {
        method: "POST",
        path: `/api/daemon/tasks/${otherDaemonTask.id}/complete`,
        body: { output: "hijacked" },
      },
      {
        method: "POST",
        path: `/api/daemon/tasks/${otherDaemonTask.id}/fail`,
        body: { error: "hijacked" },
      },
      {
        method: "POST",
        path: `/api/daemon/tasks/${otherDaemonTask.id}/usage`,
        body: { usage: [{ provider: "codex", model: "hijacked", input_tokens: 99 }] },
      },
      { method: "GET", path: `/api/daemon/tasks/${otherDaemonTask.id}/status` },
    ];
    for (const route of crossDaemonClaimedTaskRoutes) {
      const response = await app.request(route.path, {
        method: route.method,
        headers: {
          Authorization: `Bearer ${daemonBody.token.token}`,
          ...(route.body ? { "Content-Type": "application/json" } : {}),
        },
        body: route.body ? JSON.stringify(route.body) : undefined,
      });
      expect(response.status, route.path).toBe(403);
      expect(await response.json()).toEqual({
        error: "forbidden for daemon identity",
        code: "daemon_identity_forbidden",
      });
    }
    const hiddenCrossDaemonGc = await app.request(`/api/daemon/tasks/${otherDaemonTask.id}/gc-check`, {
      headers: { Authorization: `Bearer ${daemonBody.token.token}` },
    });
    expect(hiddenCrossDaemonGc.status).toBe(404);
    expect(await hiddenCrossDaemonGc.json()).toEqual({ error: "task not found" });
    expect(store.getTask(otherDaemonTask.id)).toMatchObject({
      status: "dispatched",
      sessionId: null,
      workDir: null,
    });
    expect(store.listTaskMessages(otherDaemonTask.id)).toEqual([]);
    expect(store.listRuntimeUsage(otherDaemonRuntime.id)).toEqual([]);

    const masterCanReadOtherDaemonTask = await app.request(`/api/daemon/tasks/${otherDaemonTask.id}/status`, {
      headers: { Authorization: "Bearer root-secret" },
    });
    expect(masterCanReadOtherDaemonTask.status).toBe(200);
    const openApp = createMultiremiApp({ store, authToken: "" });
    expect((await openApp.request(`/api/daemon/tasks/${otherDaemonTask.id}/status`)).status).toBe(200);
    expect((await app.request(`/api/multiremi/runtimes/${otherDaemonRuntime.id}/heartbeat`, {
      method: "POST",
      headers: { Authorization: "Bearer root-secret" },
    })).status).toBe(200);
    expect((await openApp.request(`/api/multiremi/runtimes/${otherDaemonRuntime.id}/heartbeat`, {
      method: "POST",
    })).status).toBe(200);

    const crossDaemonWorkspaceReport = await app.request(
      `/api/daemon/tasks/${otherDaemonIssueTask.id}/workspace`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${daemonBody.token.token}`,
        },
        body: JSON.stringify({
          runtime_id: otherDaemonRuntime.id,
          root_path: "/tmp/other-daemon",
          branch_name: "feat/other-daemon",
          status: "ready",
        }),
      },
    );
    expect(crossDaemonWorkspaceReport.status).toBe(403);
    expect(await crossDaemonWorkspaceReport.json()).toEqual({
      error: "forbidden for daemon identity",
      code: "daemon_identity_forbidden",
    });
    expect(store.getIssueWorkspace(otherDaemonIssue.id)).toBeNull();

    const crossDaemonWorkspaceCleanup = await app.request(
      `/api/daemon/issues/${otherDaemonIssue.id}/workspace/cleaned`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${daemonBody.token.token}`,
        },
        body: JSON.stringify({ runtime_id: otherDaemonRuntime.id }),
      },
    );
    expect(crossDaemonWorkspaceCleanup.status).toBe(403);
    expect(await crossDaemonWorkspaceCleanup.json()).toEqual({
      error: "forbidden for daemon identity",
      code: "daemon_identity_forbidden",
    });
    const masterCanInspectOtherDaemon = await app.request(
      `/api/daemon/runtimes/${otherDaemonRuntime.id}/tasks/pending`,
      { headers: { Authorization: "Bearer root-secret" } },
    );
    expect(masterCanInspectOtherDaemon.status).toBe(200);

    store.registerRuntime({ id: "rt_remote_auth", name: "Remote runtime", provider: "codex", workspaceId: "remote" });
    // The agent lives in the remote workspace, so its task does too — a task
    // always inherits its agent's workspace (see createTask).
    const remoteAgent = store.createAgent({ name: "Remote Codex", provider: "codex", workspaceId: "remote" });
    const remoteTask = store.createTask({ agentId: remoteAgent.id, prompt: "remote task" });

    const remoteRuntimeRegister = await app.request("/api/multiremi/runtimes", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${daemonBody.token.token}` },
      body: JSON.stringify({ id: "rt_bad_remote", name: "Bad remote", provider: "codex", workspaceId: "remote" }),
    });
    expect(remoteRuntimeRegister.status).toBe(403);

    for (const [label, token] of [
      ["PAT", ownerPatBody.token.token],
      ["JWT", jwtToken],
    ] as const) {
      const humanPending = await app.request("/api/daemon/runtimes/rt_remote_auth/tasks/pending", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(humanPending.status, `${label} pending`).toBe(403);
      expect(await humanPending.json()).toEqual({
        error: "daemon token required",
        code: "daemon_token_required",
      });
      const humanTaskWrite = await app.request(`/api/daemon/tasks/${remoteTask.id}/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(humanTaskWrite.status, `${label} task write`).toBe(403);
      expect(await humanTaskWrite.json()).toEqual({
        error: "daemon token required",
        code: "daemon_token_required",
      });
    }

    const remoteDaemonRegister = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${daemonBody.token.token}` },
      body: JSON.stringify({ workspace_id: "remote", daemon_id: "daemon-remote", runtimes: [{ type: "codex" }] }),
    });
    expect(remoteDaemonRegister.status).toBe(403);

    const remoteRepos = await app.request("/api/daemon/workspaces/remote/repos", {
      headers: { Authorization: `Bearer ${daemonBody.token.token}` },
    });
    expect(remoteRepos.status).toBe(403);

    const remoteClaim = await app.request("/api/daemon/runtimes/rt_remote_auth/tasks/claim", {
      method: "POST",
      headers: { Authorization: `Bearer ${daemonBody.token.token}` },
    });
    expect(remoteClaim.status).toBe(403);
    expect(await remoteClaim.json()).toEqual({ error: "forbidden for daemon token workspace" });

    const remotePending = await app.request("/api/daemon/runtimes/rt_remote_auth/tasks/pending", {
      headers: { Authorization: `Bearer ${daemonBody.token.token}` },
    });
    expect(remotePending.status).toBe(403);
    expect(await remotePending.json()).toEqual({ error: "forbidden for daemon token workspace" });

    const remoteRecover = await app.request("/api/daemon/runtimes/rt_remote_auth/recover-orphans", {
      method: "POST",
      headers: { Authorization: `Bearer ${daemonBody.token.token}` },
    });
    expect(remoteRecover.status).toBe(403);
    expect(await remoteRecover.json()).toEqual({ error: "forbidden for daemon token workspace" });

    const remoteTaskStart = await app.request(`/api/daemon/tasks/${remoteTask.id}/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${daemonBody.token.token}` },
    });
    expect(remoteTaskStart.status).toBe(403);
    expect(await remoteTaskStart.json()).toEqual({ error: "forbidden for daemon token workspace" });

    const remoteTaskReportRoutes: Array<{ method: string; path: string; body?: unknown }> = [
      { method: "POST", path: `/api/daemon/tasks/${remoteTask.id}/wait-local-directory`, body: { reason: "/tmp/remote" } },
      { method: "POST", path: `/api/daemon/tasks/${remoteTask.id}/progress`, body: { summary: "remote progress" } },
      { method: "POST", path: `/api/daemon/tasks/${remoteTask.id}/messages`, body: { messages: [{ seq: 1, type: "assistant", content: "remote" }] } },
      { method: "GET", path: `/api/daemon/tasks/${remoteTask.id}/messages` },
      { method: "POST", path: `/api/daemon/tasks/${remoteTask.id}/session`, body: { session_id: "sess-remote", work_dir: "/tmp/remote" } },
      { method: "POST", path: `/api/daemon/tasks/${remoteTask.id}/complete`, body: { output: "remote done" } },
      { method: "POST", path: `/api/daemon/tasks/${remoteTask.id}/fail`, body: { error: "remote failed" } },
      { method: "POST", path: `/api/daemon/tasks/${remoteTask.id}/usage`, body: { usage: [{ provider: "codex", model: "remote", input_tokens: 1 }] } },
      { method: "GET", path: `/api/daemon/tasks/${remoteTask.id}/status` },
    ];
    for (const route of remoteTaskReportRoutes) {
      const response = await app.request(route.path, {
        method: route.method,
        headers: {
          Authorization: `Bearer ${daemonBody.token.token}`,
          ...(route.body ? { "Content-Type": "application/json" } : {}),
        },
        body: route.body ? JSON.stringify(route.body) : undefined,
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden for daemon token workspace" });
    }
    expect(store.getTask(remoteTask.id)?.sessionId).toBeNull();
    expect(store.listTaskMessages(remoteTask.id)).toEqual([]);
    expect(store.listRuntimeUsage(null)).toEqual([]);

    const scopedDeregister = await app.request("/api/daemon/deregister", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${daemonBody.token.token}` },
      body: JSON.stringify({
        runtime_ids: ["rt_auth_daemon", otherDaemonRuntime.id, "rt_remote_auth", "rt_missing_auth"],
      }),
    });
    expect(scopedDeregister.status).toBe(200);
    expect((await scopedDeregister.json()).status).toBe("ok");
    expect(store.getRuntime("rt_auth_daemon")?.status).toBe("offline");
    expect(store.getRuntime(otherDaemonRuntime.id)?.status).toBe("online");
    expect(store.getRuntime("rt_remote_auth")?.status).toBe("online");

    const listed = await app.request("/api/tokens", {
      headers: { Authorization: "Bearer root-secret" },
    });
    const listedBody = await listed.json();
    expect(listedBody.find((token: any) => token.id === patBody.token.id)?.last_used_at).toBeString();
    expect(listedBody.find((token: any) => token.id === daemonBody.token.id)).toBeUndefined();

    const revoked = await app.request(`/api/tokens/${patBody.token.id}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer root-secret" },
    });
    expect(revoked.status).toBe(204);

    const afterRevoke = await app.request("/api/multiremi/agents", {
      headers: { Authorization: `Bearer ${patBody.token.token}` },
    });
    expect(afterRevoke.status).toBe(401);
  });

  it("allows the deployment master token to perform an explicit legacy daemon migration", async () => {
    const store = createStore();
    const legacyRuntime = store.registerRuntime({
      id: "rt_master_legacy_daemon",
      name: "Master legacy daemon",
      provider: "codex",
      workspaceId: "local",
      daemonId: "daemon-master-legacy",
    });
    const agent = store.createAgent({
      name: "Master migration agent",
      provider: "codex",
      workspaceId: "local",
      runtimeId: legacyRuntime.id,
    });
    const task = store.createTask({
      agentId: agent.id,
      runtimeId: legacyRuntime.id,
      prompt: "migrate with trusted credentials",
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const response = await app.request("/api/daemon/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer root-secret",
      },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "daemon-master-current",
        legacy_daemon_ids: ["daemon-master-legacy"],
        runtimes: [{ type: "codex", version: "2.0.0" }],
      }),
    });

    expect(response.status).toBe(200);
    const currentRuntimeId = (await response.json()).runtimes[0].id;
    expect(currentRuntimeId).not.toBe(legacyRuntime.id);
    expect(store.getRuntime(legacyRuntime.id)).toBeNull();
    expect(store.getAgent(agent.id)?.runtimeId).toBe(currentRuntimeId);
    expect(store.getTask(task.id)?.runtimeId).toBe(currentRuntimeId);
  });
});
