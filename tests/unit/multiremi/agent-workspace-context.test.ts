import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

async function setup() {
  const store = createStore();
  store.ensureLocalWorkspace();
  const user = store.getOrCreateUser({ email: "agent-owner@example.com", name: "Agent owner" });
  const workspace = store.createWorkspace({ name: "Agent team", slug: "agent-team" }, user.id);
  const { token } = await store.createAccessToken({
    workspaceId: "local",
    userId: user.id,
    name: "Login session",
    type: "pat",
    purpose: "session",
  });
  const app = createMultiremiApp({ store, authToken: "root-secret" });
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  return { store, user, workspace, app, headers };
}

const creationPaths = [
  "/api/agents",
  "/api/multiremi/agents",
  "/api/agents/from-template",
  "/api/multiremi/agents/from-template",
  "/api/multiremi/agents/default",
];

describe("agent workspace request context", () => {
  for (const endpoint of ["agent-task-snapshot", "agent-run-counts", "agent-activity-30d"]) {
    for (const header of ["X-Workspace-ID", "X-Workspace-Slug"]) {
      it(`scopes native ${endpoint} using ${header}`, async () => {
        const { store, user, workspace, app, headers } = await setup();
        const agent = store.createAgent({ name: "Active team agent", provider: "claude", workspaceId: workspace.id, ownerId: user.id });
        store.createTask({ agentId: agent.id, workspaceId: workspace.id, prompt: "Team task" });
        const path = `/api/multiremi/${endpoint}`;
        const control = await app.request(`${path}?workspaceId=${workspace.id}`, { headers });
        expect(control.status).toBe(200);
        const actual = await app.request(path, { headers: {
          ...headers, [header]: header === "X-Workspace-ID" ? workspace.id : workspace.slug,
        } });
        expect(actual.status).toBe(200);
        expect(await actual.json()).toEqual(await control.json());
        const foreign = await app.request(path, { headers: { ...headers, [header]: "local" } });
        expect(foreign.status).toBe(404);
        const unknown = await app.request(path, { headers: { ...headers, "X-Workspace-Slug": "missing-team" } });
        expect(unknown.status).toBe(404);
      });
    }
  }

  for (const path of creationPaths) {
    it(`creates in the selected workspace using only the web slug header: ${path}`, async () => {
      const { store, user, workspace, app, headers } = await setup();
      // A normal login token names local, but the user only belongs to their team.
      expect(store.getUserRoleInWorkspace(user.id, "local")).toBeNull();
      const response = await app.request(path, {
        method: "POST",
        headers: { ...headers, "X-Workspace-Slug": workspace.slug },
        body: JSON.stringify({ name: "New agent", provider: "claude", template_slug: "summarizer" }),
      });
      expect(response.status).toBe(201);
      const body = await response.json();
      const agent = store.getAgent((body.agent ?? body).id);
      expect(agent?.workspaceId).toBe(workspace.id);
      expect(agent?.ownerId).toBe(user.id);
      expect(store.listAgents().filter((item) => item.workspaceId === "local")).toHaveLength(0);
    });

    it(`rejects an unknown slug without creating in the local fallback: ${path}`, async () => {
      const { store, app, headers } = await setup();
      const response = await app.request(path, {
        method: "POST",
        headers: { ...headers, Authorization: "Bearer root-secret", "X-Workspace-Slug": "missing-team" },
        body: JSON.stringify({ name: "Wrong workspace", provider: "claude", template_slug: "summarizer" }),
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "workspace not found" });
      expect(store.listAgents()).toHaveLength(0);
    });
  }

  for (const path of ["/api/agents", "/api/multiremi/agents"]) {
    it(`lists only agents in the workspace selected by the web header: ${path}`, async () => {
      const { store, user, workspace, app, headers } = await setup();
      const agent = store.createAgent({ name: "Team agent", provider: "claude", workspaceId: workspace.id, ownerId: user.id });
      store.createAgent({ name: "Local agent", provider: "claude", workspaceId: "local" });
      const response = await app.request(path, { headers: { ...headers, "X-Workspace-Slug": workspace.slug } });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect((body.agents ?? body).map((item: { id: string }) => item.id)).toEqual([agent.id]);
    });
  }

  for (const field of ["workspaceId", "workspace_id"]) {
    for (const source of ["body", "query"]) {
      it(`preserves explicit ${source} ${field} ahead of workspace headers`, async () => {
        const { store, workspace, app, headers } = await setup();
        const body = { name: "Explicit team", ...(source === "body" ? { [field]: workspace.id } : {}) };
        const path = `/api/agents${source === "query" ? `?${field}=${workspace.id}` : ""}`;
        const response = await app.request(path, {
          method: "POST",
          headers: { ...headers, "X-Workspace-ID": "local", "X-Workspace-Slug": "missing-team" },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(201);
        expect(store.getAgent((await response.json()).id)?.workspaceId).toBe(workspace.id);
      });
    }
  }

  it("accepts the CLI workspace ID header ahead of the slug and login-token fallback", async () => {
    const { store, workspace, app, headers } = await setup();
    const response = await app.request("/api/agents", {
      method: "POST",
      headers: { ...headers, "X-Workspace-ID": workspace.id, "X-Workspace-Slug": "missing-team" },
      body: JSON.stringify({ name: "CLI team" }),
    });
    expect(response.status).toBe(201);
    expect(store.getAgent((await response.json()).id)?.workspaceId).toBe(workspace.id);
  });

  it("does not grant membership when a user selects a foreign workspace", async () => {
    const { store, app, headers } = await setup();
    const response = await app.request("/api/agents", {
      method: "POST",
      headers: { ...headers, "X-Workspace-Slug": "local" },
      body: JSON.stringify({ name: "Unauthorized" }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "workspace not found" });
    expect(store.listAgents()).toHaveLength(0);
  });

  it("keeps a user-less credential bound to its workspace despite a selected header", async () => {
    const { store, workspace, app, headers } = await setup();
    const { token } = await store.createAccessToken({ workspaceId: "local", name: "Scoped PAT", type: "pat" });
    const response = await app.request("/api/agents", {
      method: "POST",
      headers: { ...headers, Authorization: `Bearer ${token}`, "X-Workspace-Slug": workspace.slug },
      body: JSON.stringify({ name: "Unauthorized" }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "workspace not found" });
    expect(store.listAgents()).toHaveLength(0);
  });
});
