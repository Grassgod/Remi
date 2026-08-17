// Workspace-level env (MUL-49): admin-only GET/PUT /api/workspaces/:id/env,
// "****" preserve semantics shared with agent env, and the claim payload
// carrying workspace_env so a saved value reaches the next dispatched task
// without a daemon restart.
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const MASTER = { Authorization: "Bearer MASTER", "content-type": "application/json" };

describe("workspace env API", () => {
  it("round-trips env through PUT/GET and keeps stored values for masked entries", async () => {
    const store = createLocalStore();
    const app = createMultiremiApp({ store, authToken: "MASTER" });

    const put = await app.request("/api/workspaces/local/env", {
      method: "PUT",
      headers: MASTER,
      body: JSON.stringify({ env: { GH_TOKEN: "ghp_secret", HTTP_PROXY: "http://proxy:8080" } }),
    });
    expect(put.status).toBe(200);
    expect((await put.json()).env).toEqual({ GH_TOKEN: "ghp_secret", HTTP_PROXY: "http://proxy:8080" });

    // "****" keeps the stored value; omitted keys are removed (replace semantics).
    const second = await app.request("/api/workspaces/local/env", {
      method: "PUT",
      headers: MASTER,
      body: JSON.stringify({ env: { GH_TOKEN: "****" } }),
    });
    expect((await second.json()).env).toEqual({ GH_TOKEN: "ghp_secret" });

    const get = await app.request("/api/workspaces/local/env", { headers: MASTER });
    expect(get.status).toBe(200);
    expect((await get.json()).env).toEqual({ GH_TOKEN: "ghp_secret" });
    expect(store.getWorkspaceEnv("local")).toEqual({ GH_TOKEN: "ghp_secret" });
  });

  it("rejects non-admin members and task tokens", async () => {
    const store = createLocalStore();
    store.createWorkspaceMember({ id: "mem_local_bob", workspaceId: "local", userId: "bob", name: "Bob", email: "bob@example.com", role: "member" });
    const member = await store.createAccessToken({ workspaceId: "local", type: "pat", name: "bob", userId: "bob" });
    const app = createMultiremiApp({ store, authToken: "MASTER" });

    const asMember = await app.request("/api/workspaces/local/env", {
      headers: { Authorization: `Bearer ${member.token}` },
    });
    expect(asMember.status).toBe(403);

    const agent = store.createAgent({ name: "Env Gate", provider: "claude" });
    const task = store.createTask({ agentId: agent.id, workspaceId: "local", prompt: "gate" });
    const taskToken = await store.createTaskAccessToken(task, "local");
    const asTask = await app.request("/api/workspaces/local/env", {
      headers: { Authorization: `Bearer ${taskToken.token}` },
    });
    expect(asTask.status).toBe(403);
  });

  it("does not leak env through the workspace object or repos endpoints", async () => {
    const store = createLocalStore();
    store.setWorkspaceEnv("local", { GH_TOKEN: "ghp_leakcheck" });
    const app = createMultiremiApp({ store, authToken: "MASTER" });

    for (const path of ["/api/workspaces/local", "/api/workspaces", "/api/daemon/workspaces/local/repos"]) {
      const res = await app.request(path, { headers: MASTER });
      expect(res.status).toBe(200);
      expect(JSON.stringify(await res.json())).not.toContain("ghp_leakcheck");
    }
  });

  it("puts workspace_env on the claim payload alongside the agent custom_env", async () => {
    const store = createLocalStore();
    store.setWorkspaceEnv("local", { GH_TOKEN: "ghp_ws", SHARED: "from-workspace" });
    const runtime = store.registerRuntime({ id: "rt_env_claude", name: "env", provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({ name: "Env Claim", provider: "claude", runtimeId: runtime.id, customEnv: { SHARED: "from-agent" } });
    store.createTask({ agentId: agent.id, workspaceId: "local", prompt: "env claim" });
    const app = createMultiremiApp({ store });

    const claim = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" });
    expect(claim.status).toBe(200);
    const task = (await claim.json()).task;
    expect(task.workspace_env).toEqual({ GH_TOKEN: "ghp_ws", SHARED: "from-workspace" });
    // Precedence is resolved daemon-side; the claim ships both layers untouched.
    expect(task.agent.custom_env).toEqual({ SHARED: "from-agent" });
  });

  it("omits workspace_env from the claim when the workspace has none", async () => {
    const store = createLocalStore();
    const runtime = store.registerRuntime({ id: "rt_noenv_claude", name: "noenv", provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({ name: "No Env Claim", provider: "claude", runtimeId: runtime.id });
    store.createTask({ agentId: agent.id, workspaceId: "local", prompt: "no env" });
    const app = createMultiremiApp({ store });

    const claim = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" });
    const task = (await claim.json()).task;
    expect(task.workspace_env).toBeUndefined();
  });
});
