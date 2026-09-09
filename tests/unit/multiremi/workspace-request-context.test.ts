import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, resetMultiremiTestEnv, useUploadDir } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

async function fixture() {
  const store = createStore();
  store.ensureLocalWorkspace();
  const user = store.getOrCreateUser({ email: "context@example.test", name: "Context" });
  const workspace = store.createWorkspace({ name: "Selected", slug: "selected" }, user.id);
  const other = store.createWorkspace({ name: "Other", slug: "other-selected" }, user.id);
  const { token } = await store.createAccessToken({
    workspaceId: "local", userId: user.id, name: "Login", type: "pat", purpose: "session",
  });
  const app = createMultiremiApp({ store, authToken: "root-secret" });
  const headers = { Authorization: `Bearer ${token}`, "X-Workspace-Slug": workspace.slug };
  return { store, user, workspace, other, app, headers };
}

const reads = [
  "/api/issues", "/api/issues/grouped", "/api/issues/search?q=example", "/api/issues/child-progress",
  "/api/assignee-frequency", "/api/labels", "/api/autopilots", "/api/squads", "/api/pins",
  "/api/notification-preferences", "/api/tokens", "/api/agent-task-snapshot", "/api/agent-run-counts",
  "/api/agent-activity-30d",
];

describe("web workspace request context", () => {
  it("keeps task and daemon credentials scoped despite explicit cross-workspace headers", async () => {
    const { app, store, user, workspace, other } = await fixture();
    const agent = store.createAgent({ workspaceId: workspace.id, name: "Worker", provider: "claude" });
    const issue = store.createIssue({ workspaceId: workspace.id, title: "Task issue" });
    const task = store.createTask({ workspaceId: workspace.id, agentId: agent.id, issueId: issue.id, prompt: "Work" });
    const taskToken = await store.createTaskAccessToken(task, user.id);
    const daemonToken = await store.createAccessToken({ workspaceId: workspace.id, type: "daemon", daemonId: "dmn_context", userId: user.id, name: "Daemon" });
    const selectors: Record<string, string>[] = [{ "X-Workspace-Slug": other.slug }, { "X-Workspace-ID": other.id }, { "X-Workspace-Slug": "missing" }];
    for (const token of [taskToken.token, daemonToken.token]) {
      for (const endpoint of reads) {
        for (const selector of selectors) {
          const response = await app.request(endpoint, { headers: { Authorization: `Bearer ${token}`, ...selector } });
          expect([403, 404]).toContain(response.status);
        }
      }
    }
    for (const selector of selectors) {
      const response = await app.request("/api/labels", { method: "POST", headers: { Authorization: `Bearer ${taskToken.token}`, "Content-Type": "application/json", ...selector }, body: JSON.stringify({ name: "Wrong", color: "#112233" }) });
      expect(response.status).toBe(404);
    }
    expect(store.listLabels(other.id)).toHaveLength(0);
  });

  it("uses explicit IDs before headers and rejects stale write context without creating local data", async () => {
    const { app, store, headers, workspace, other } = await fixture();
    const create = (extraHeaders: Record<string, string>, body: Record<string, unknown>) => app.request("/api/labels", {
      method: "POST", headers: { ...headers, "Content-Type": "application/json", ...extraHeaders },
      body: JSON.stringify({ name: "Context", color: "#112233", ...body }),
    });
    const selected = await create({ "X-Workspace-ID": other.id, "X-Workspace-Slug": "missing" }, {});
    expect(selected.status).toBe(201);
    expect((await selected.json()).workspace_id).toBe(other.id);
    const explicit = await create({ "X-Workspace-ID": other.id, "X-Workspace-Slug": "missing" }, { workspace_id: workspace.id });
    expect(explicit.status).toBe(201);
    expect((await explicit.json()).workspace_id).toBe(workspace.id);
    expect((await create({ "X-Workspace-Slug": "missing" }, {})).status).toBe(404);
    expect(store.listLabels("local")).toHaveLength(0);
    expect((await app.request("/api/tokens", { method: "POST", headers: { ...headers, "X-Workspace-Slug": "missing", "Content-Type": "application/json" }, body: JSON.stringify({ name: "Stale" }) })).status).toBe(404);
  });

  for (const endpoint of reads) {
    it(`${endpoint} uses the selected workspace and rejects stale or inaccessible context`, async () => {
      const { app, headers, workspace } = await fixture();
      expect((await app.request(endpoint, { headers })).status).toBe(200);
      expect((await app.request(endpoint, { headers: { ...headers, "X-Workspace-Slug": "local" } })).status).toBe(404);
      expect((await app.request(endpoint, { headers: { ...headers, Authorization: "Bearer root-secret", "X-Workspace-Slug": "missing" } })).status).toBe(404);
      const explicit = `${endpoint}${endpoint.includes("?") ? "&" : "?"}workspace_id=${workspace.id}`;
      expect((await app.request(explicit, { headers: { ...headers, "X-Workspace-Slug": "missing" } })).status).toBe(200);
    });
  }

  it("creates resources in the selected workspace without writing into local", async () => {
    const { app, store, headers, workspace } = await fixture();
    const agent = store.createAgent({ workspaceId: workspace.id, name: "Agent", provider: "claude" });
    const requests = [
      ["/api/issues", { title: "Issue", status: "backlog" }],
      ["/api/issues/quick-create", { agent_id: agent.id, prompt: "Quick issue" }],
      ["/api/labels", { name: "Label", color: "#112233" }],
      ["/api/autopilots", { title: "Auto", assignee_id: agent.id, execution_mode: "run_only", prompt: "Audit", trigger_kind: "manual" }],
      ["/api/squads", { name: "Squad", leader_id: agent.id }],
    ] as const;
    for (const [endpoint, body] of requests) {
      const response = await app.request(endpoint, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      expect(response.status).toBeGreaterThanOrEqual(200);
      expect(response.status).toBeLessThan(300);
      const result = await response.json();
      expect((result.issue ?? result).workspace_id).toBe(workspace.id);
    }
    expect(store.listIssues({ workspaceId: "local" })).toHaveLength(0);
    expect(store.listLabels("local")).toHaveLength(0);
    expect(store.listAutopilots("local")).toHaveLength(0);
    expect(store.listSquads("local")).toHaveLength(0);
  });

  it("authorizes and persists the same label workspace for both aliases", async () => {
    const { app, store, workspace, other, headers } = await fixture();
    for (const fields of [{ workspaceId: other.id }, { workspace_id: other.id, workspaceId: "local" }]) {
      const response = await app.request("/api/labels", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ name: "workspace_id" in fields ? "SnakeLabel" : "CamelLabel", color: "#112233", ...fields }) });
      expect(response.status).toBe(201);
      const label = await response.json();
      expect(label.workspace_id).toBe(other.id);
      expect(store.getLabel(label.id)?.workspaceId).toBe(other.id);
    }
    expect(store.listLabels(workspace.id)).toHaveLength(0);
    expect(store.listLabels("local")).toHaveLength(0);
  });

  it("round-trips squad details and pin mutations under the selected workspace", async () => {
    const { app, store, headers, workspace } = await fixture();
    const agent = store.createAgent({ workspaceId: workspace.id, name: "Leader", provider: "claude" });
    const squad = store.createSquad({ workspaceId: workspace.id, name: "Team", leaderId: agent.id });
    for (const suffix of ["", "/members", "/members/status"]) {
      expect((await app.request(`/api/squads/${squad.id}${suffix}`, { headers })).status).toBe(200);
    }
    const project = store.createProject({ workspaceId: workspace.id, title: "Pinned" });
    const response = await app.request("/api/pins", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ item_type: "project", item_id: project.id }) });
    expect(response.status).toBe(201);
    expect((await app.request(`/api/pins/project/${project.id}`, { method: "DELETE", headers })).status).toBe(204);
    expect((await (await app.request("/api/pins", { headers })).json())).toEqual([]);
  });

  it("saves notification preferences and uploads without an existing resource", async () => {
    const { app, headers, workspace } = await fixture();
    const result = await app.request("/api/notification-preferences", { method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ preferences: {} }) });
    expect(result.status).toBe(200);
    useUploadDir();
    const form = new FormData();
    form.set("file", new File(["test"], "test.txt"));
    const upload = await app.request("/api/upload-file", { method: "POST", headers, body: form });
    expect(upload.status).toBe(200);
    expect((await upload.json()).attachment.workspaceId).toBe(workspace.id);
  });

  it("honors explicit knowledge workspace even when the login token was minted in local", async () => {
    const { app, headers, workspace, store, user } = await fixture();
    for (const endpoint of ["/api/knowledge/submissions", "/api/knowledge/runs"]) {
      expect((await app.request(`${endpoint}?workspace_id=${workspace.id}`, { headers })).status).toBe(200);
    }
    store.createWorkspaceMember({ workspaceId: "local", userId: user.id, name: "Context", role: "member" });
    const response = await app.request("/api/knowledge/submissions", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ workspace_id: workspace.id, scope: "memory", body: "Belongs to selected workspace" }) });
    expect(response.status).toBe(201);
    expect((await response.json()).submission.workspace_id).toBe(workspace.id);
  });
});
