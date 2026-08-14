// Bearer auth, daemon-token route scoping, and the cookie fallback for safe methods.
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, resetMultiremiTestEnv, signTestJwt } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Multiremi API — authentication and token scoping", () => {
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

  it("protects APIs with bearer auth and scopes daemon tokens to daemon routes", async () => {
    const store = createStore();
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
      body: JSON.stringify({ name: "Local daemon", type: "daemon", workspaceId: "local" }),
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
      body: JSON.stringify({ id: "rt_auth_daemon", name: "Auth daemon", provider: "codex", workspaceId: "local" }),
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
      body: JSON.stringify({ runtime_ids: ["rt_auth_daemon", "rt_remote_auth", "rt_missing_auth"] }),
    });
    expect(scopedDeregister.status).toBe(200);
    expect((await scopedDeregister.json()).status).toBe("ok");
    expect(store.getRuntime("rt_auth_daemon")?.status).toBe("offline");
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
});
