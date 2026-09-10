import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

async function fixture() {
  const store = createStore();
  store.ensureLocalWorkspace();
  const user = store.getOrCreateUser({ email: "native-context@example.test", name: "Native context" });
  const workspace = store.createWorkspace({ name: "Selected", slug: "native-selected" }, user.id);
  const other = store.createWorkspace({ name: "Other", slug: "native-other" }, user.id);
  const foreign = store.createWorkspace({ name: "Foreign", slug: "native-foreign" });
  const agent = store.createAgent({ workspaceId: workspace.id, ownerId: user.id, name: "Worker", provider: "claude" });
  const project = store.createProject({ workspaceId: workspace.id, title: "Pinned project" });
  const issue = store.createIssue({ workspaceId: workspace.id, title: "Task issue" });
  const { token } = await store.createAccessToken({ workspaceId: "local", userId: user.id, name: "Session", type: "pat", purpose: "session" });
  const app = createMultiremiApp({ store, authToken: "fixture-master", backgroundJobs: false });
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Workspace-Slug": workspace.slug };
  return { store, user, workspace, other, foreign, agent, project, issue, app, headers };
}

const reads = [
  "/api/multiremi/issues", "/api/multiremi/issues/grouped", "/api/multiremi/assignee-frequency",
  "/api/multiremi/issues/search?q=task", "/api/multiremi/issues/child-progress",
  "/api/multiremi/projects", "/api/multiremi/projects/search?q=project", "/api/multiremi/labels",
  "/api/multiremi/autopilots", "/api/multiremi/squads", "/api/multiremi/pins",
  "/api/multiremi/notification-preferences", "/api/multiremi/tokens", "/api/multiremi/members",
];

function writes(context: Awaited<ReturnType<typeof fixture>>) {
  const { agent, project } = context;
  return [
    { path: "/api/multiremi/issues", body: { title: "Created issue" }, entity: "issue", status: 201 },
    { path: "/api/multiremi/issues/quick-create", body: { agentId: agent.id, prompt: "Created quick issue" }, entity: "issue", status: 202 },
    { path: "/api/multiremi/projects", body: { title: "Created project" }, entity: "project", status: 201 },
    { path: "/api/multiremi/labels", body: { name: "Created label", color: "#112233" }, entity: "label", status: 201 },
    { path: "/api/multiremi/autopilots", body: { title: "Created auto", assigneeId: agent.id, executionMode: "run_only", prompt: "Audit", triggerKind: "manual" }, entity: "autopilot", status: 201 },
    { path: "/api/multiremi/squads", body: { name: "Created squad", leaderId: agent.id }, entity: "squad", status: 201 },
    { path: "/api/multiremi/pins", body: { itemType: "project", itemId: project.id }, entity: "pin", status: 201 },
    { path: "/api/multiremi/tokens", body: { name: "Created token" }, entity: "token", status: 201 },
    { path: "/api/multiremi/members", body: { name: "Created member" }, entity: "member", status: 201 },
    { path: "/api/multiremi/attachments", body: { filename: "note.txt", url: "https://example.test/note.txt" }, entity: "attachment", status: 201 },
  ];
}

describe("native workspace request context", () => {
  for (const native of [false, true]) {
    it(`requires administration of the destination when moving a member (${native ? "native" : "compatibility"})`, async () => {
      const { store, user, workspace, other, foreign, app, headers } = await fixture();
      const movedUser = store.getOrCreateUser({ email: "moved-membership@example.test", name: "Moved membership" });
      const member = store.createWorkspaceMember({ workspaceId: workspace.id, userId: movedUser.id, name: movedUser.name, role: "member" });
      const path = native ? `/api/multiremi/members/${member.id}` : `/api/workspaces/${workspace.id}/members/${member.id}`;
      const move = () => app.request(path, { method: "PATCH", headers, body: JSON.stringify({ workspaceId: foreign.id, role: "member" }) });
      expect((await move()).status).toBe(404);
      expect(store.getWorkspaceMember(member.id)?.workspaceId).toBe(workspace.id);
      store.createWorkspaceMember({ workspaceId: foreign.id, userId: user.id, name: user.name, role: "member" });
      expect((await move()).status).toBe(403);
      expect(store.getWorkspaceMember(member.id)?.workspaceId).toBe(workspace.id);
      const allowed = await app.request(path, { method: "PATCH", headers, body: JSON.stringify({ workspaceId: other.id, role: "member" }) });
      expect(allowed.status).toBe(200);
      expect(store.getWorkspaceMember(member.id)?.workspaceId).toBe(other.id);
    });
  }

  for (const endpoint of reads) {
    it(`${endpoint} honors selected headers, explicit IDs, and rejects stale or foreign context`, async () => {
      const { app, headers, workspace, foreign } = await fixture();
      expect((await app.request(endpoint, { headers })).status).toBe(200);
      expect((await app.request(endpoint, { headers: { ...headers, "X-Workspace-Slug": "missing" } })).status).toBe(404);
      expect((await app.request(endpoint, { headers: { ...headers, "X-Workspace-Slug": foreign.slug } })).status).toBe(404);
      expect((await app.request(endpoint, { headers: { ...headers, "X-Workspace-ID": workspace.id, "X-Workspace-Slug": "missing" } })).status).toBe(200);
      const explicit = `${endpoint}${endpoint.includes("?") ? "&" : "?"}workspaceId=${workspace.id}`;
      expect((await app.request(explicit, { headers: { ...headers, "X-Workspace-ID": foreign.id, "X-Workspace-Slug": "missing" } })).status).toBe(200);
    });
  }

  for (const selector of ["slug", "id", "token"] as const) {
    it(`persists all native creations in the workspace selected by ${selector}`, async () => {
      const context = await fixture();
      const { app, store, headers, workspace, user } = context;
      if (selector === "id") Object.assign(headers, { "X-Workspace-ID": workspace.id, "X-Workspace-Slug": "missing" });
      if (selector === "token") {
        const { token } = await store.createAccessToken({ workspaceId: workspace.id, userId: user.id, name: "Scoped session", type: "pat", purpose: "session" });
        Object.assign(headers, { Authorization: `Bearer ${token}`, "X-Workspace-Slug": "" });
      }
      for (const input of writes(context)) {
        const response = await app.request(input.path, { method: "POST", headers, body: JSON.stringify(input.body) });
        const result = await response.json();
        expect(response.status, `${input.path}: ${JSON.stringify(result)}`).toBe(input.status);
        const entity = result[input.entity];
        expect(entity.workspaceId, input.path).toBe(workspace.id);
      }
      expect(store.listIssues({ workspaceId: "local" })).toHaveLength(0);
      expect(store.listLabels("local")).toHaveLength(0);
      expect(store.listAutopilots("local")).toHaveLength(0);
      expect(store.listSquads("local")).toHaveLength(0);
    });
  }

  it("rejects stale selectors before native creations and preserves explicit body aliases", async () => {
    const context = await fixture();
    const { app, headers, workspace, foreign } = context;
    for (const input of writes(context)) {
      const stale = await app.request(input.path, { method: "POST", headers: { ...headers, "X-Workspace-Slug": "missing" }, body: JSON.stringify(input.body) });
      expect(stale.status, input.path).toBe(404);
      const explicit = await app.request(input.path, { method: "POST", headers: { ...headers, "X-Workspace-ID": foreign.id, "X-Workspace-Slug": "missing" }, body: JSON.stringify({ ...input.body, workspaceId: workspace.id, workspace_id: foreign.id }) });
      const result = await explicit.json();
      expect(explicit.status, `${input.path}: ${JSON.stringify(result)}`).toBe(input.status);
      expect(result[input.entity].workspaceId).toBe(workspace.id);
    }
  });

  it("uses selected context for preference and pin mutations", async () => {
    const { app, store, headers, workspace, project, user } = await fixture();
    const pin = store.createPinnedItem({ workspaceId: workspace.id, userId: user.id, itemType: "project", itemId: project.id });
    const selectors: Record<string, string>[] = [{ "X-Workspace-Slug": workspace.slug }, { "X-Workspace-ID": workspace.id, "X-Workspace-Slug": "missing" }];
    for (const selector of selectors) {
      expect((await app.request("/api/multiremi/notification-preferences", { method: "PUT", headers: { ...headers, ...selector }, body: JSON.stringify({ preferences: {} }) })).status).toBe(200);
      expect((await app.request("/api/multiremi/pins/reorder", { method: "PUT", headers: { ...headers, ...selector }, body: JSON.stringify({ items: [{ id: pin.id, position: 2 }] }) })).status).toBe(200);
    }
    expect((await app.request(`/api/multiremi/pins/project/${project.id}`, { method: "DELETE", headers })).status).toBe(200);
    expect(store.listPinnedItems(workspace.id, user.id)).toHaveLength(0);
  });

  it("keeps task, daemon and ownerless PAT credentials inside their bound workspace", async () => {
    const context = await fixture();
    const { store, app, user, workspace, other, agent, issue } = context;
    const task = store.createTask({ workspaceId: workspace.id, agentId: agent.id, issueId: issue.id, prompt: "Scope check" });
    const taskToken = await store.createTaskAccessToken(task, user.id);
    const daemonToken = await store.createAccessToken({ workspaceId: workspace.id, userId: user.id, type: "daemon", daemonId: "dmn_native_context", name: "Daemon" });
    const pat = await store.createAccessToken({ workspaceId: workspace.id, type: "pat", name: "Workspace" });
    const selectors: Record<string, string>[] = [{ "X-Workspace-ID": other.id }, { "X-Workspace-Slug": other.slug }];
    for (const { token } of [taskToken, daemonToken, pat]) {
      for (const selector of selectors) {
        const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...selector };
        for (const endpoint of reads) expect([403, 404], endpoint).toContain((await app.request(endpoint, { headers })).status);
        for (const input of writes(context)) {
          expect([403, 404], input.path).toContain((await app.request(input.path, { method: "POST", headers, body: JSON.stringify(input.body) })).status);
        }
      }
    }
    expect(store.listIssues({ workspaceId: other.id })).toHaveLength(0);
    expect(store.listLabels(other.id)).toHaveLength(0);
  });

  it("authorizes label reads and mutations against the label workspace", async () => {
    const { app, store, headers, workspace, foreign } = await fixture();
    const label = store.createLabel({ workspaceId: foreign.id, name: "Foreign label", color: "#112233" });
    for (const prefix of ["/api/labels", "/api/multiremi/labels"]) {
      for (const method of ["GET", "PUT", "DELETE", ...(prefix.includes("multiremi") ? ["PATCH"] : [])]) {
        const response = await app.request(`${prefix}/${label.id}`, { method, headers, ...(method === "PUT" || method === "PATCH" ? { body: JSON.stringify({ name: "Stolen label" }) } : {}) });
        expect(response.status, `${method} ${prefix}`).toBe(404);
      }
    }
    expect(store.getLabel(label.id)?.name).toBe("Foreign label");
    const own = store.createLabel({ workspaceId: workspace.id, name: "Own label", color: "#112233" });
    expect((await app.request(`/api/multiremi/labels/${own.id}`, { headers: { ...headers, "X-Workspace-Slug": "missing" } })).status).toBe(200);
  });

  it("resolves attachment resource ownership before incidental headers without relaxing reference checks", async () => {
    const { app, store, user, headers, workspace, other, issue, agent } = await fixture();
    const comment = store.createIssueComment(issue.id, { body: "Attached comment" });
    const chat = store.createChatSession({ workspaceId: workspace.id, agentId: agent.id, creatorId: user.id });
    const message = store.sendChatMessage(chat.id, { body: "Attached message" }).message;
    const foreignIssue = store.createIssue({ workspaceId: other.id, title: "Another workspace" });
    const file = { filename: "linked.txt", url: "https://example.test/linked.txt" };
    for (const reference of [{ issueId: issue.id }, { commentId: comment.id }, { chatSessionId: chat.id }, { chatMessageId: message.id }]) {
      const response = await app.request("/api/multiremi/attachments", {
        method: "POST", headers: { ...headers, "X-Workspace-ID": other.id, "X-Workspace-Slug": "missing" }, body: JSON.stringify({ ...file, ...reference }),
      });
      expect(response.status).toBe(201);
      expect((await response.json()).attachment.workspaceId).toBe(workspace.id);
    }
    const conflicting = await app.request("/api/multiremi/attachments", {
      method: "POST", headers, body: JSON.stringify({ ...file, workspaceId: workspace.id, issueId: foreignIssue.id }),
    });
    expect(conflicting.status).toBe(404);
  });
});
