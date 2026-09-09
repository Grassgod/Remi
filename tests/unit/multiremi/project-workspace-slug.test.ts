import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

async function fixture() {
  const store = createStore();
  store.ensureLocalWorkspace();
  const user = store.getOrCreateUser({ email: "project-owner@example.test", name: "Project owner" });
  const workspace = store.createWorkspace({ name: "Projects", slug: "project-owner" }, user.id);
  const other = store.createWorkspace({ name: "Other", slug: "other-projects" }, user.id);
  const { token } = await store.createAccessToken({
    workspaceId: "local", userId: user.id, name: "Login", type: "pat", purpose: "session",
  });
  const app = createMultiremiApp({ store, authToken: "root-secret" });
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Workspace-Slug": workspace.slug,
  };
  return { store, app, workspace, other, headers };
}

describe("project workspace slug", () => {
  it("lists, creates and searches projects in the workspace selected by the web client", async () => {
    const { store, app, workspace, other, headers } = await fixture();
    const existing = store.createProject({ title: "Project existing", workspaceId: workspace.id });
    store.createProject({ title: "Project elsewhere", workspaceId: other.id });
    const list = await app.request("/api/projects?", { headers });
    expect(list.status).toBe(200);
    expect((await list.json()).projects.map((project: { id: string }) => project.id)).toEqual([existing.id]);

    const created = await app.request("/api/projects", {
      method: "POST", headers, body: JSON.stringify({ title: "Project created" }),
    });
    expect(created.status).toBe(201);
    const project = await created.json();
    expect(project.workspace_id).toBe(workspace.id);
    expect(store.getProject(project.id)?.workspaceId).toBe(workspace.id);
    const search = await app.request("/api/projects/search?q=created", { headers });
    expect(search.status).toBe(200);
    expect((await search.json()).projects.map((item: { id: string }) => item.id)).toEqual([project.id]);
    expect(store.listProjects("local")).toHaveLength(0);
  });

  it("keeps explicit snake_case workspace parameters ahead of the slug", async () => {
    const { store, app, workspace, other, headers } = await fixture();
    const project = store.createProject({ title: "Explicit project", workspaceId: other.id });
    for (const endpoint of ["/api/projects?", "/api/projects/search?q=Explicit&"]) {
      const response = await app.request(`${endpoint}workspace_id=${other.id}`, { headers });
      expect(response.status).toBe(200);
      expect((await response.json()).projects.map((item: { id: string }) => item.id)).toEqual([project.id]);
    }
    const created = await app.request(`/api/projects?workspace_id=${workspace.id}`, {
      method: "POST", headers,
      body: JSON.stringify({ title: "Explicit create", workspace_id: other.id }),
    });
    expect(created.status).toBe(201);
    expect((await created.json()).workspace_id).toBe(other.id);
    const queryCreate = await app.request(`/api/projects?workspace_id=${other.id}`, {
      method: "POST", headers, body: JSON.stringify({ title: "Query create" }),
    });
    expect(queryCreate.status).toBe(201);
    expect((await queryCreate.json()).workspace_id).toBe(other.id);
  });

  it("rejects inaccessible and unknown slugs without falling back or creating a project", async () => {
    const { store, app, headers } = await fixture();
    for (const slug of ["local", "missing-workspace"]) {
      const scopedHeaders = { ...headers, "X-Workspace-Slug": slug };
      for (const endpoint of ["/api/projects", "/api/projects/search?q=project"]) {
        const response = await app.request(endpoint, { headers: scopedHeaders });
        expect(response.status).toBe(404);
      }
      const response = await app.request("/api/projects", {
        method: "POST", headers: scopedHeaders, body: JSON.stringify({ title: "Denied" }),
      });
      expect(response.status).toBe(404);
    }
    // Even an administrator must not write into local when a selected slug is stale.
    const response = await app.request("/api/projects", {
      method: "POST",
      headers: { ...headers, Authorization: "Bearer root-secret", "X-Workspace-Slug": "missing-workspace" },
      body: JSON.stringify({ title: "Wrong workspace" }),
    });
    expect(response.status).toBe(404);
    expect(store.listProjects("local")).toHaveLength(0);
  });
});
