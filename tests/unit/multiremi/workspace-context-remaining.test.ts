import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

async function setup() {
  const store = createStore();
  store.ensureLocalWorkspace();
  const user = store.getOrCreateUser({ email: "remaining@example.test", name: "Remaining" });
  const first = store.createWorkspace({ name: "First", slug: "remaining-first" }, user.id);
  const workspace = store.createWorkspace({ name: "Selected", slug: "remaining-selected" }, user.id);
  const other = store.getOrCreateUser({ email: "other@example.test", name: "Other" });
  const foreign = store.createWorkspace({ name: "Foreign", slug: "remaining-foreign" }, other.id);
  const { token } = await store.createAccessToken({ workspaceId: "local", userId: user.id, name: "Session", type: "pat", purpose: "session" });
  const app = createMultiremiApp({ store, authToken: "root-secret" });
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  return { store, user, first, workspace, foreign, other, app, headers };
}

function seedInbox(store: ReturnType<typeof createStore>, workspaceId: string, userId: string) {
  const member = store.listWorkspaceMembers(workspaceId).find((candidate) => candidate.userId === userId)!;
  const author = store.createWorkspaceMember({ workspaceId, userId: `author-${workspaceId}`, name: "Author" });
  const issue = store.createIssue({ workspaceId, title: "Private notification", createdBy: member.id });
  store.createIssueComment(issue.id, { authorType: "member", authorId: author.id, body: "Private comment" });
  return { member, item: store.listInboxItems(member.id).find((item) => item.issueId === issue.id)! };
}

async function setupMovedInboxMember() {
  const fixture = await setup();
  const { store, first, workspace, app, headers } = fixture;
  const user = store.getOrCreateUser({ email: "moved-inbox@example.test", name: "Moved member" });
  const member = store.createWorkspaceMember({ workspaceId: first.id, userId: user.id, name: user.name, role: "member" });
  const old = seedInbox(store, first.id, user.id).item;
  const moved = await app.request(`/api/workspaces/${first.id}/members/${member.id}`, {
    method: "PATCH", headers, body: JSON.stringify({ workspaceId: workspace.id, role: "member" }),
  });
  expect(moved.status).toBe(200);
  expect(store.getUserRoleInWorkspace(user.id, first.id)).toBeNull();
  const selected = [seedInbox(store, workspace.id, user.id).item];
  const issue = store.createIssue({ workspaceId: workspace.id, title: "Second selected notification", createdBy: member.id });
  const author = store.listWorkspaceMembers(workspace.id).find((candidate) => candidate.userId !== user.id)!;
  store.createIssueComment(issue.id, { authorType: "member", authorId: author.id, body: "Selected comment" });
  selected.push(store.listInboxItems(member.id).find((item) => item.issueId === issue.id)!);
  const { token } = await store.createAccessToken({ workspaceId: "local", userId: user.id, name: "Moved session", type: "pat", purpose: "session" });
  return { ...fixture, old, selected, headers: { Authorization: `Bearer ${token}`, "X-Workspace-Slug": workspace.slug } };
}

const pluginInput = { provider: "claude", name: "remaining-plugin", manifest: { name: "remaining-plugin", version: "1.0.0" }, files: [{ path: "skills/test/SKILL.md", content: "# Test\n" }] };

for (const header of ["X-Workspace-Slug", "X-Workspace-ID"]) {
  describe(`remaining workspace selection through ${header}`, () => {
    for (const path of ["/api/feedback", "/api/multiremi/feedback"]) {
      it(`creates feedback in the selected workspace: ${path}`, async () => {
        const { store, workspace, app, headers } = await setup();
        const response = await app.request(path, { method: "POST", headers: { ...headers, [header]: header.endsWith("Slug") ? workspace.slug : workspace.id }, body: JSON.stringify({ message: "Team feedback" }) });
        expect(response.status).toBe(201);
        expect(store.listFeedback(workspace.id)).toHaveLength(1);
        expect(store.listFeedback("local")).toHaveLength(0);
      });
    }

    it("lists feedback from the selected workspace", async () => {
      const { store, workspace, app, headers } = await setup();
      store.createFeedback({ workspaceId: workspace.id, message: "Team feedback" });
      const response = await app.request("/api/multiremi/feedback", { headers: { ...headers, [header]: header.endsWith("Slug") ? workspace.slug : workspace.id } });
      expect(response.status).toBe(200);
      expect((await response.json()).feedback).toHaveLength(1);
    });

    it("imports and lists plugins in the selected workspace", async () => {
      const { store, workspace, app, headers } = await setup();
      const selectedHeaders = { ...headers, [header]: header.endsWith("Slug") ? workspace.slug : workspace.id };
      const imported = await app.request("/api/multiremi/agent-plugins/import", { method: "POST", headers: selectedHeaders, body: JSON.stringify(pluginInput) });
      expect(imported.status).toBe(201);
      expect(store.listAgentPlugins(workspace.id)).toHaveLength(1);
      const listed = await app.request("/api/multiremi/agent-plugins", { headers: selectedHeaders });
      expect(listed.status).toBe(200);
      expect((await listed.json()).total).toBe(1);
    });

    it("reads and renames a daemon in the selected workspace", async () => {
      const { store, workspace, user, app, headers } = await setup();
      await store.createAccessToken({ workspaceId: workspace.id, userId: user.id, name: "Daemon", type: "daemon", daemonId: "remaining-daemon" });
      const selectedHeaders = { ...headers, [header]: header.endsWith("Slug") ? workspace.slug : workspace.id };
      for (const path of ["/api/multiremi/daemons", "/api/daemons/remaining-daemon", "/api/multiremi/daemons/remaining-daemon/retirement-plan"]) {
        const response = await app.request(path, { headers: selectedHeaders });
        expect(response.status).toBe(200);
      }
      const renamed = await app.request("/api/daemons/remaining-daemon", { method: "PATCH", headers: selectedHeaders, body: JSON.stringify({ display_name: "Renamed" }) });
      expect(renamed.status).toBe(200);
      expect(store.getDaemonProfile(workspace.id, "remaining-daemon")?.displayName).toBe("Renamed");
      const plan = store.getDaemonRetirementPlan(workspace.id, "remaining-daemon");
      const retired = await app.request("/api/multiremi/daemons/remaining-daemon/retire", { method: "POST", headers: selectedHeaders, body: JSON.stringify({ expected_snapshot: plan.snapshot }) });
      expect(retired.status).toBe(200);
      expect(store.isDaemonRetired(workspace.id, "remaining-daemon")).toBe(true);
    });

    for (const withRuntime of [false, true]) {
      it(`bootstraps onboarding in the selected workspace (runtime=${withRuntime})`, async () => {
        const { store, workspace, app, headers } = await setup();
        const runtime = store.registerRuntime({ workspaceId: workspace.id, name: "Runtime", provider: "claude" });
        const response = await app.request(`/api/me/onboarding/${withRuntime ? "runtime" : "no-runtime"}-bootstrap`, { method: "POST", headers: { ...headers, [header]: header.endsWith("Slug") ? workspace.slug : workspace.id }, body: JSON.stringify(withRuntime ? { runtime_id: runtime.id } : {}) });
        expect(response.status).toBe(200);
        expect((await response.json()).workspace_id).toBe(workspace.id);
        expect(store.listIssues({ workspaceId: "local" })).toHaveLength(0);
      });
    }

    it("isolates inbox lists and bulk writes to the selected workspace", async () => {
      const { store, user, first, workspace, app, headers } = await setup();
      const firstInbox = seedInbox(store, first.id, user.id);
      const selected = seedInbox(store, workspace.id, user.id);
      const selectedHeaders = { ...headers, [header]: header.endsWith("Slug") ? first.slug : first.id };
      for (const path of ["/api/inbox", "/api/multiremi/inbox"]) {
        const response = await app.request(path, { headers: selectedHeaders });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect((body.items ?? body).map((item: { id: string }) => item.id)).toEqual([firstInbox.item.id]);
      }
      const written = await app.request("/api/inbox/mark-all-read", { method: "POST", headers: selectedHeaders });
      expect(written.status).toBe(200);
      expect(store.countUnreadInboxItems(firstInbox.member.id)).toBe(0);
      expect(store.countUnreadInboxItems(selected.member.id)).toBe(1);
    });
  });
}

describe("remaining workspace authorization", () => {
  it("excludes old workspace rows from inbox lists, pagination and counts after a member moves", async () => {
    const { app, headers, old, selected } = await setupMovedInboxMember();
    const expectedIds = selected.map((item) => item.id).sort();
    for (const path of ["/api/inbox", "/api/multiremi/inbox"]) {
      const response = await app.request(path, { headers });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect((body.items ?? body).map((item: { id: string }) => item.id).sort()).toEqual(expectedIds);
    }
    const firstPage = await app.request("/api/inbox/page?limit=1", { headers });
    expect(firstPage.status).toBe(200);
    const first = await firstPage.json();
    expect(first.items).toHaveLength(1);
    expect(first.has_more).toBe(true);
    const secondPage = await app.request(`/api/inbox/page?limit=1&cursor=${encodeURIComponent(first.next_cursor)}`, { headers });
    expect(secondPage.status).toBe(200);
    const second = await secondPage.json();
    expect(second.items).toHaveLength(1);
    expect(second.has_more).toBe(false);
    expect([...first.items, ...second.items].map((item: { id: string }) => item.id).sort()).toEqual(expectedIds);
    const summary = await app.request("/api/inbox/summary", { headers });
    expect(summary.status).toBe(200);
    expect(await summary.json()).toEqual({ unread: 2, attention: 0 });
    const count = await app.request("/api/inbox/unread-count", { headers });
    expect(count.status).toBe(200);
    expect(await count.json()).toEqual({ count: 2 });
    const denied = await app.request(`/api/inbox/${old.id}/read`, { method: "POST", headers });
    expect(denied.status).toBe(404);
  });

  for (const action of ["mark-all-read", "archive-all", "archive-all-read", "archive-completed"]) {
    it(`keeps old workspace notifications unchanged during ${action} after a member moves`, async () => {
      const { app, store, headers, old, selected } = await setupMovedInboxMember();
      const all = [old, ...selected];
      if (action === "archive-all-read") {
        for (const item of all) store.markInboxItemRead(item.id);
      }
      if (action === "archive-completed") {
        for (const item of all) store.updateIssue(item.issueId!, { status: "done" });
      }
      const previous = store.getInboxItem(old.id);
      const response = await app.request(`/api/inbox/${action}`, { method: "POST", headers });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ count: 2 });
      expect(store.getInboxItem(old.id)).toEqual(previous);
      for (const item of selected) {
        expect(store.getInboxItem(item.id)).toMatchObject({ read: true, archived: action !== "mark-all-read" });
      }
      const count = await app.request("/api/inbox/unread-count", { headers });
      expect(count.status).toBe(200);
      expect(await count.json()).toEqual({ count: 0 });
    });
  }

  it("resolves a legacy local user's membership inside the selected team", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    if (!store.getWorkspaceMember("local")) store.createWorkspaceMember({ id: "local", userId: "local", workspaceId: "local", name: "Legacy owner" });
    const workspace = store.createWorkspace({ name: "Legacy team", slug: "legacy-team" }, "local");
    const inbox = seedInbox(store, workspace.id, "local");
    const { token } = await store.createAccessToken({ workspaceId: "local", userId: "local", name: "Legacy session", type: "pat", purpose: "session" });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const headers = { Authorization: `Bearer ${token}`, "X-Workspace-Slug": workspace.slug };
    for (const path of ["/api/inbox", "/api/multiremi/inbox", "/api/inbox?member_id=local"]) {
      const response = await app.request(path, { headers });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect((body.items ?? body).map((item: { id: string }) => item.id)).toEqual([inbox.item.id]);
    }
  });

  it("resolves plugin inspection before invoking the external source resolver", async () => {
    const { store, workspace, headers } = await setup();
    const inspectedWorkspaces: Array<string | undefined> = [];
    const app = createMultiremiApp({
      store,
      authToken: "root-secret",
      resolveAgentPluginGitSource: async (input) => {
        inspectedWorkspaces.push(input.workspaceId);
        return { sourceUrl: input.sourceUrl, sourceRef: "main", defaultBranch: "main", branches: ["main"], sourceRevision: "a".repeat(40), candidates: [] };
      },
    });
    for (const header of ["X-Workspace-ID", "X-Workspace-Slug"]) {
      const response = await app.request("/api/multiremi/agent-plugins/inspect", { method: "POST", headers: { ...headers, [header]: header.endsWith("Slug") ? workspace.slug : workspace.id }, body: JSON.stringify({ source_url: "https://example.test/plugins.git" }) });
      expect(response.status).toBe(200);
    }
    const denied = await app.request("/api/multiremi/agent-plugins/inspect", { method: "POST", headers: { ...headers, "X-Workspace-Slug": "unknown-workspace" }, body: JSON.stringify({ source_url: "https://example.test/plugins.git" }) });
    expect(denied.status).toBe(404);
    expect(inspectedWorkspaces).toEqual([workspace.id, workspace.id]);
  });

  it("keeps a plugin's workspace on re-import without a selector and rejects mismatches", async () => {
    const { store, first, workspace, app, headers } = await setup();
    const plugin = store.importAgentPlugin({ ...pluginInput, provider: "claude", workspaceId: workspace.id });
    const input = { ...pluginInput, id: plugin.id, manifest: { ...pluginInput.manifest, version: "1.1.0" } };
    const reimported = await app.request("/api/multiremi/agent-plugins/import", { method: "POST", headers, body: JSON.stringify(input) });
    expect(reimported.status).toBe(201);
    expect((await reimported.json()).plugin.workspaceId).toBe(workspace.id);
    const mismatched = await app.request("/api/multiremi/agent-plugins/import", { method: "POST", headers: { ...headers, "X-Workspace-ID": first.id }, body: JSON.stringify(input) });
    expect(mismatched.status).toBe(400);
    expect((await mismatched.json()).code).toBe("workspace_mismatch");
    expect(store.listAgentPlugins(first.id)).toHaveLength(0);
  });

  it("rejects unknown slugs without falling back for reads or writes", async () => {
    const { store, user, workspace, app, headers } = await setup();
    const inbox = seedInbox(store, workspace.id, user.id);
    const selectedHeaders = { ...headers, "X-Workspace-Slug": "unknown-workspace" };
    for (const path of ["/api/inbox", "/api/inbox/page", "/api/inbox/summary", "/api/inbox/unread-count", "/api/multiremi/inbox", "/api/multiremi/feedback", "/api/multiremi/agent-plugins", "/api/multiremi/daemons"]) {
      expect((await app.request(path, { headers: selectedHeaders })).status).toBe(404);
    }
    for (const path of ["/api/inbox/mark-all-read", "/api/inbox/archive-all", "/api/inbox/archive-all-read", "/api/inbox/archive-completed"]) {
      expect((await app.request(path, { method: "POST", headers: selectedHeaders })).status).toBe(404);
    }
    expect(store.countUnreadInboxItems(inbox.member.id)).toBe(1);
    expect(store.listInboxItems(inbox.member.id)).toHaveLength(1);
    expect((await app.request(`/api/inbox/${inbox.item.id}/read`, { method: "POST", headers: selectedHeaders })).status).toBe(404);
    for (const path of ["/api/feedback", "/api/multiremi/feedback", "/api/multiremi/agent-plugins/import", "/api/me/onboarding/no-runtime-bootstrap"]) {
      expect((await app.request(path, { method: "POST", headers: { ...selectedHeaders, Authorization: "Bearer root-secret" }, body: JSON.stringify({ message: "Must not write", ...pluginInput }) })).status).toBe(404);
    }
    expect(store.listFeedback()).toHaveLength(0);
    expect(store.listAgentPlugins("local")).toHaveLength(0);
  });

  it("never reads or modifies another user's inbox across workspaces", async () => {
    const { store, workspace, foreign, other, app, headers } = await setup();
    const victim = seedInbox(store, foreign.id, other.id);
    const selectedHeaders = { ...headers, "X-Workspace-ID": workspace.id };
    for (const path of [`/api/multiremi/inbox?memberId=${victim.member.id}`, `/api/inbox?member_id=${victim.member.id}`]) {
      expect((await app.request(path, { headers: selectedHeaders })).status).toBe(404);
    }
    for (const prefix of ["/api/inbox", "/api/multiremi/inbox"]) {
      for (const action of ["read", "archive"]) {
        expect((await app.request(`${prefix}/${victim.item.id}/${action}`, { method: "POST", headers: selectedHeaders })).status).toBe(404);
      }
    }
    expect(store.countUnreadInboxItems(victim.member.id)).toBe(1);
    expect(store.listInboxItems(victim.member.id)).toHaveLength(1);
  });

  it("rejects selecting another workspace's own notification and preserves repeated archive", async () => {
    const { store, user, first, workspace, app, headers } = await setup();
    const inbox = seedInbox(store, first.id, user.id);
    expect((await app.request(`/api/inbox/${inbox.item.id}/read`, { method: "POST", headers: { ...headers, "X-Workspace-ID": workspace.id } })).status).toBe(404);
    for (const path of [`/api/inbox/${inbox.item.id}/archive`, `/api/multiremi/inbox/${inbox.item.id}/archive`]) {
      expect((await app.request(path, { method: "POST", headers: { ...headers, "X-Workspace-ID": first.id } })).status).toBe(200);
    }
  });

  it("keeps explicit workspace fields ahead of headers and scoped credentials bound", async () => {
    const { store, workspace, app, headers } = await setup();
    const explicit = await app.request("/api/feedback", { method: "POST", headers: { ...headers, "X-Workspace-ID": "local", "X-Workspace-Slug": "unknown-workspace" }, body: JSON.stringify({ workspace_id: workspace.id, message: "Explicit" }) });
    expect(explicit.status).toBe(201);
    const { token } = await store.createAccessToken({ workspaceId: "local", name: "Scoped PAT", type: "pat" });
    for (const path of ["/api/inbox", "/api/multiremi/inbox", "/api/multiremi/feedback", "/api/multiremi/agent-plugins", "/api/multiremi/daemons"]) {
      expect((await app.request(path, { headers: { ...headers, Authorization: `Bearer ${token}`, "X-Workspace-ID": workspace.id } })).status).toBe(404);
    }
  });

  it("lets task credentials use their owner's inbox only in the bound workspace", async () => {
    const { store, user, first, workspace, app, headers } = await setup();
    const inbox = seedInbox(store, workspace.id, user.id);
    const otherInbox = seedInbox(store, first.id, user.id);
    const agent = store.createAgent({ workspaceId: workspace.id, name: "Task agent", provider: "claude", ownerId: user.id });
    const task = store.createTask({ workspaceId: workspace.id, agentId: agent.id, prompt: "Fixture" });
    const { token } = await store.createAccessToken({ workspaceId: workspace.id, userId: user.id, name: "Task", type: "task", purpose: "task", taskId: task.id, agentId: agent.id, expiresInDays: 1 });
    const taskHeaders = { ...headers, Authorization: `Bearer ${token}`, "X-Workspace-ID": workspace.id };
    const listed = await app.request("/api/inbox", { headers: taskHeaders });
    expect(listed.status).toBe(200);
    expect((await listed.json()).map((item: { id: string }) => item.id)).toEqual([inbox.item.id]);
    expect((await app.request(`/api/inbox/${inbox.item.id}/read`, { method: "POST", headers: taskHeaders })).status).toBe(200);
    const escapedHeaders = { ...taskHeaders, "X-Workspace-ID": first.id };
    expect((await app.request("/api/inbox", { headers: escapedHeaders })).status).toBe(404);
    expect((await app.request(`/api/inbox/${otherInbox.item.id}/read`, { method: "POST", headers: escapedHeaders })).status).toBe(404);
    expect(store.countUnreadInboxItems(otherInbox.member.id)).toBe(1);
  });

  it("protects other recipients in the same workspace while preserving master access", async () => {
    const { store, workspace, other, app, headers } = await setup();
    store.createWorkspaceMember({ workspaceId: workspace.id, userId: other.id, name: "Other member" });
    const victim = seedInbox(store, workspace.id, other.id);
    for (const prefix of ["/api/inbox", "/api/multiremi/inbox"]) {
      const response = await app.request(`${prefix}/${victim.item.id}/read`, { method: "POST", headers: { ...headers, "X-Workspace-ID": workspace.id } });
      expect(response.status).toBe(404);
    }
    expect(store.countUnreadInboxItems(victim.member.id)).toBe(1);
    const master = await app.request(`/api/inbox/${victim.item.id}/read`, { method: "POST", headers: { Authorization: "Bearer root-secret" } });
    expect(master.status).toBe(200);
    expect(store.countUnreadInboxItems(victim.member.id)).toBe(0);
  });
});
