import { afterEach, expect, test } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);
async function setup() {
  const store = createStore();
  store.ensureLocalWorkspace();
  const user = store.getOrCreateUser({ email: "audit-user@example.test", name: "Audit user" });
  const workspace = store.createWorkspace({ name: "Audit team", slug: "audit-team" }, user.id);
  const { token } = await store.createAccessToken({ workspaceId: "local", userId: user.id, name: "Audit session", type: "pat", purpose: "session" });
  const app = createMultiremiApp({ store, authToken: "audit-master" });
  const headers = { Authorization: `Bearer ${token}`, "X-Workspace-Slug": workspace.slug };
  const runtime = store.registerRuntime({ id: "rt_audit", name: "Audit runtime", provider: "claude", workspaceId: workspace.id, ownerId: user.id, visibility: "public" });
  return { store, user, workspace, app, headers, runtime };
}

for (const path of ["/api/runtimes", "/api/multiremi/runtimes", "/api/models", "/api/multiremi/models"]) {
  for (const kind of ["web-slug", "cli-id"]) {
    test(`${path} should honor ${kind} without query ID`, async () => {
      const { workspace, app, headers } = await setup();
      const control = await app.request(`${path}?workspace_id=${workspace.id}`, { headers });
      expect(control.status).toBe(200);
      const actual = await app.request(path, { headers: kind === "web-slug" ? headers : { Authorization: headers.Authorization, "X-Workspace-ID": workspace.id } });
      expect(actual.status).toBe(200);
      expect(await actual.json()).toEqual(await control.json());
    });
  }
}

for (const [prefix, suffix, wrapper] of [
  ["/api/runtimes", "/usage", null],
  ["/api/runtimes", "/usage/by-agent", null],
  ["/api/runtimes", "/usage/by-hour", null],
  ["/api/runtimes", "/task-activity", null],
  ["/api/runtimes", "/activity", null],
  ["/api/multiremi/runtimes", "/usage/by-agent", "usage"],
  ["/api/multiremi/runtimes", "/usage/by-hour", "usage"],
  ["/api/multiremi/runtimes", "/task-activity", "activity"],
] as const) {
  test(`${prefix} ${suffix} should read the resource workspace`, async () => {
    const { store, user, workspace, app, headers, runtime } = await setup();
    const agent = store.createAgent({ name: "Audit agent", provider: "claude", workspaceId: workspace.id, ownerId: user.id });
    const task = store.createTask({ agentId: agent.id, workspaceId: workspace.id, prompt: "Audit usage" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.reportTaskUsage(task.id, [{ provider: "claude", model: "sonnet", inputTokens: 21, outputTokens: 8 }]);
    const path = `${prefix}/${runtime.id}${suffix}`;
    const control = await app.request(`${path}?workspace_id=${workspace.id}`, { headers });
    expect(control.status).toBe(200);
    const expected = await control.json();
    expect((wrapper ? expected[wrapper] : expected).length).toBeGreaterThan(0);
    // A stale page/query context must not replace the authorized resource scope.
    const actual = await app.request(`${path}?workspace_id=local`, { headers: { ...headers, "X-Workspace-Slug": "missing-team" } });
    expect(actual.status).toBe(200);
    const data = await actual.json();
    expect(data).toEqual(expected);
  });
}

for (const path of ["/api/dashboard/usage/daily", "/api/dashboard/usage/by-agent", "/api/dashboard/agent-runtime", "/api/dashboard/runtime/daily"]) {
  test(`${path} rejects an unknown slug even for a local member`, async () => {
    const { store, user, app, headers } = await setup();
    store.createWorkspaceMember({ id: user.id, userId: user.id, workspaceId: "local", name: "Audit user", role: "member" });
    const response = await app.request(path, { headers: { ...headers, "X-Workspace-Slug": "missing-team" } });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "workspace not found" });
  });
}

test("runtime and model selection preserves credential and membership boundaries", async () => {
  const { store, workspace, app, headers } = await setup();
  const scoped = await store.createAccessToken({ workspaceId: "local", name: "Scoped machine PAT", type: "pat" });
  for (const path of ["/api/runtimes", "/api/multiremi/runtimes", "/api/models", "/api/multiremi/models"]) {
    const forbidden = await app.request(path, { headers: { ...headers, "X-Workspace-Slug": "local" } });
    expect(forbidden.status).toBe(404);
    const wrongScope = await app.request(path, { headers: { Authorization: `Bearer ${scoped.token}`, "X-Workspace-ID": workspace.id } });
    expect(wrongScope.status).toBe(404);
    const unknown = await app.request(path, { headers: { ...headers, "X-Workspace-Slug": "missing-team" } });
    expect(unknown.status).toBe(404);
  }
});

test("model catalog uses the selected workspace even without runtimes", async () => {
  const { store, workspace, app, headers, runtime } = await setup();
  store.deleteRuntime(runtime.id);
  for (const [workspaceId, model] of [[workspace.id, "team-model"], ["local", "local-model"]]) {
    store.setRelayModelDiscovery(workspaceId, true);
    const revision = store.upsertRelayConfig(workspaceId, "claude", {
      fragment: JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://gateway.example.test" } }),
      tokenOp: "set",
      authToken: "fixture-token",
    });
    store.saveGatewayModels(workspaceId, "claude", { models: [{ id: model, label: model }], sourceRevision: revision });
  }
  for (const path of ["/api/models", "/api/multiremi/models"]) {
    const response = await app.request(path, { headers });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(JSON.stringify(body)).toContain("team-model");
    expect(JSON.stringify(body)).not.toContain("local-model");
  }
});
