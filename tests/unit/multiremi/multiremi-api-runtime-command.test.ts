import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Multiremi API - runtime commands", () => {
  it("restricts execution to workspace managers and keeps its audit response redacted", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    store.createWorkspaceMember({ id: "command-admin", name: "Command Admin", role: "admin" });
    store.createWorkspaceMember({ id: "command-member", name: "Command Member", role: "member" });
    const ownerToken = await store.createAccessToken({ name: "Owner", type: "pat", workspaceId: "local", userId: "local" });
    const adminToken = await store.createAccessToken({ name: "Admin", type: "pat", workspaceId: "local", userId: "command-admin" });
    const memberToken = await store.createAccessToken({ name: "Member", type: "pat", workspaceId: "local", userId: "command-member" });
    const taskAgent = store.createAgent({ name: "Command task actor", provider: "codex", workspaceId: "local" });
    const taskIssue = store.createIssue({ title: "Command task auth", workspaceId: "local" });
    const task = store.createTask({
      agentId: taskAgent.id,
      issueId: taskIssue.id,
      workspaceId: "local",
      prompt: "Attempt a runtime command",
    });
    const taskToken = await store.createTaskAccessToken(task, "local");
    const daemonToken = await store.createAccessToken({
      name: "Command Daemon",
      type: "daemon",
      workspaceId: "local",
      daemonId: "command-daemon",
    });
    const runtime = store.registerRuntime({
      id: "rt_command_api",
      name: "Command runtime",
      provider: "codex",
      workspaceId: "local",
      daemonId: "command-daemon",
    });
    const app = createMultiremiApp({ store, authToken: "root-command-secret" });
    const jsonHeaders = (token: string) => ({
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    });
    const tokenLikeValue = ["ghp", "placeholdervalue1234"].join("_");
    const command = `printf ${tokenLikeValue}`;

    const denied = await app.request(`/api/runtimes/${runtime.id}/commands`, {
      method: "POST",
      headers: jsonHeaders(memberToken.token),
      body: JSON.stringify({ command }),
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "insufficient permissions" });

    const taskDenied = await app.request(`/api/runtimes/${runtime.id}/commands`, {
      method: "POST",
      headers: jsonHeaders(taskToken.token),
      body: JSON.stringify({ command }),
    });
    expect(taskDenied.status).toBe(403);

    const spoofedProvision = await app.request(`/api/runtimes/${runtime.id}/commands`, {
      method: "POST",
      headers: jsonHeaders(adminToken.token),
      body: JSON.stringify({ command: "printf bounded", timeout_ms: 15 * 60 * 1000, provisionKind: "npm-global" }),
    });
    expect(spoofedProvision.status).toBe(400);

    const created = await app.request(`/api/runtimes/${runtime.id}/commands`, {
      method: "POST",
      headers: jsonHeaders(adminToken.token),
      body: JSON.stringify({ command, args: ["token=placeholder-value"], timeout_ms: 2_000 }),
    });
    expect(created.status).toBe(202);
    const createdBody = await created.json();
    expect(createdBody).toMatchObject({
      runtime_id: runtime.id,
      command: "printf [REDACTED]",
      args: ["token=[REDACTED]"],
      created_by: "command-admin",
      status: "pending",
    });
    expect(JSON.stringify(createdBody)).not.toContain(tokenLikeValue);

    const heartbeat = await app.request("/api/daemon/heartbeat", {
      method: "POST",
      headers: jsonHeaders(daemonToken.token),
      body: JSON.stringify({ runtime_id: runtime.id }),
    });
    expect(heartbeat.status).toBe(200);
    const heartbeatBody = await heartbeat.json();
    expect(heartbeatBody.pending_command).toMatchObject({
      id: createdBody.id,
      command,
      args: ["token=placeholder-value"],
      timeout_ms: 2_000,
    });

    const reported = await app.request(`/api/daemon/runtimes/${runtime.id}/commands/${createdBody.id}/result`, {
      method: "POST",
      headers: jsonHeaders(daemonToken.token),
      body: JSON.stringify({
        status: "completed",
        exit_code: 9,
        stdout: `result ${tokenLikeValue}`,
        stderr: "",
        duration_ms: 14,
      }),
    });
    expect(reported.status).toBe(200);

    const result = await app.request(`/api/runtimes/${runtime.id}/commands/${createdBody.id}`, {
      headers: { Authorization: `Bearer ${ownerToken.token}` },
    });
    expect(result.status).toBe(200);
    const resultBody = await result.json();
    expect(resultBody).toMatchObject({ status: "completed", exit_code: 9, stdout: "result [REDACTED]", duration_ms: 14 });
    expect(JSON.stringify(resultBody)).not.toContain(tokenLikeValue);
  });

  it("restricts workspace Runtime provision CRUD to managers and denies task tokens", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    store.createWorkspaceMember({ id: "provision-admin", name: "Provision Admin", role: "admin" });
    store.createWorkspaceMember({ id: "provision-member", name: "Provision Member", role: "member" });
    const adminToken = await store.createAccessToken({ name: "Admin", type: "pat", workspaceId: "local", userId: "provision-admin" });
    const memberToken = await store.createAccessToken({ name: "Member", type: "pat", workspaceId: "local", userId: "provision-member" });
    const agent = store.createAgent({ name: "Provision task actor", provider: "codex", workspaceId: "local" });
    const issue = store.createIssue({ title: "Provision task auth", workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: "local", prompt: "Attempt a provision" });
    const taskToken = await store.createTaskAccessToken(task, "local");
    const app = createMultiremiApp({ store, authToken: "root-provision-secret" });
    const headers = (token: string) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
    const body = JSON.stringify({
      kind: "command",
      command: "printf token=placeholder-value",
      trigger_kinds: ["on_register"],
    });

    expect((await app.request("/api/workspaces/local/runtime-provisions", {
      method: "POST", headers: headers(memberToken.token), body,
    })).status).toBe(403);
    expect((await app.request("/api/workspaces/local/runtime-provisions", {
      method: "POST", headers: headers(taskToken.token), body,
    })).status).toBe(403);

    const created = await app.request("/api/workspaces/local/runtime-provisions", {
      method: "POST", headers: headers(adminToken.token), body,
    });
    expect(created.status).toBe(201);
    const response = await created.json();
    expect(response.provision).toMatchObject({
      workspace_id: "local",
      kind: "command",
      command: "printf token=[REDACTED]",
      created_by: "provision-admin",
    });
    expect(JSON.stringify(response)).not.toContain("placeholder-value");
    const audit = db!.query("SELECT action, snapshot, actor_id FROM multiremi_runtime_provision_audit WHERE provision_id = ?")
      .get(response.provision.id) as { action: string; snapshot: string; actor_id: string };
    expect(audit).toMatchObject({ action: "create", actor_id: "provision-admin" });
    expect(audit.snapshot).toContain("[REDACTED]");
    expect(audit.snapshot).not.toContain("placeholder-value");
  });
});
