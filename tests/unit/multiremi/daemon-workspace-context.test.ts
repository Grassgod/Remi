import { afterEach, expect, test } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

async function setup() {
  const store = createStore();
  store.ensureLocalWorkspace();
  const user = store.getOrCreateUser({ email: "daemon-owner@example.test", name: "Daemon owner" });
  const workspace = store.createWorkspace({ name: "Daemon team", slug: "daemon-team" }, user.id);
  const { token } = await store.createAccessToken({ workspaceId: "local", userId: user.id, name: "Login session", type: "pat", purpose: "session" });
  const app = createMultiremiApp({ store, authToken: "root-secret" });
  return { store, user, workspace, app, token };
}

for (const selector of ["X-Workspace-ID", "X-Workspace-Slug"]) {
  for (const method of ["GET", "POST"]) {
    test(`daemon install ${method} honors ${selector} and membership`, async () => {
      const { store, user, workspace, app, token } = await setup();
      const value = selector === "X-Workspace-ID" ? workspace.id : workspace.slug;
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", [selector]: value };
      const options = { method, headers, ...(method === "POST" ? { body: JSON.stringify({ create_token: false }) } : {}) };
      const response = await app.request("/api/multiremi/install/daemon", options);
      expect(response.status).toBe(200);
      expect((await response.json()).workspaceId).toBe(workspace.id);
      expect(store.getUserRoleInWorkspace(user.id, "local")).toBeNull();
      const foreign = await app.request("/api/multiremi/install/daemon", { ...options, headers: { ...headers, [selector]: "local" } });
      expect(foreign.status).toBe(404);
    });
  }

  test(`native runtime registration persists workspace selected by ${selector}`, async () => {
    const { workspace, app, token } = await setup();
    const response = await app.request("/api/multiremi/runtimes", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", [selector]: selector === "X-Workspace-ID" ? workspace.id : workspace.slug },
      body: JSON.stringify({ name: "Team runtime", provider: "claude" }),
    });
    expect(response.status).toBe(201);
    expect((await response.json()).runtime.workspaceId).toBe(workspace.id);
  });
}

for (const selector of ["X-Workspace-ID", "X-Workspace-Slug", "credential"]) {
  test(`daemon register uses ${selector} when body omits workspace`, async () => {
    const { store, user, workspace, app } = await setup();
    const credential = await store.createAccessToken({ workspaceId: workspace.id, userId: user.id, name: "Daemon", type: "daemon", daemonId: "dmn_context" });
    const headers = {
      Authorization: `Bearer ${credential.token}`,
      "Content-Type": "application/json",
      ...(selector === "credential" ? {} : { [selector]: selector === "X-Workspace-ID" ? workspace.id : workspace.slug }),
    };
    const body = JSON.stringify({ daemon_id: "dmn_context", runtimes: [{ name: "Context runtime", type: "claude" }] });
    const response = await app.request("/api/daemon/register", { method: "POST", headers, body });
    expect(response.status).toBe(200);
    expect(store.listRuntimes().map((runtime) => runtime.workspaceId)).toEqual([workspace.id]);
    const denied = await app.request("/api/daemon/register", { method: "POST", headers: { ...headers, "X-Workspace-ID": "local" }, body });
    expect(denied.status).toBe(403);
    expect(store.listRuntimes().map((runtime) => runtime.workspaceId)).toEqual([workspace.id]);
  });
}
