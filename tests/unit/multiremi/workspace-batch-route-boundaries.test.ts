import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(() => {
  mock.restore();
  resetMultiremiTestEnv();
});

const masterToken = "workspace-boundary-test-master";
const issueRoutes = [
  { prefix: "/api/issues", issueIdsKey: "issue_ids" },
  { prefix: "/api/multiremi/issues", issueIdsKey: "issueIds" },
] as const;

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function setup() {
  const store = createStore();
  store.ensureLocalWorkspace();
  const owner = store.getOrCreateUser({ email: "boundary-owner@example.test", name: "Owner" });
  const user = store.getOrCreateUser({ email: "boundary-member@example.test", name: "Member B" });
  const workspaceA = store.createWorkspace({ name: "Workspace A", slug: "boundary-a" }, owner.id);
  const workspaceB = store.createWorkspace({ name: "Workspace B", slug: "boundary-b" }, owner.id);
  store.createWorkspaceMember({ workspaceId: workspaceB.id, userId: user.id, name: user.name, role: "member" });
  expect(store.getUserRoleInWorkspace(user.id, workspaceA.id)).toBeNull();
  expect(store.getUserRoleInWorkspace(user.id, workspaceB.id)).toBe("member");

  const createRecords = (workspaceId: string, label: string) => {
    const parent = store.createIssue({ workspaceId, title: `${label} parent`, priority: "low", status: "todo" });
    const child = store.createIssue({ workspaceId, title: `${label} child`, parentIssueId: parent.id });
    const agent = store.createAgent({ workspaceId, name: `${label} agent`, provider: "codex" });
    const task = store.createTask({ agentId: agent.id, prompt: `${label} ordinary task` });
    expect(task.chatSessionId).toBeNull();
    return { parent, child, agent, task };
  };
  const foreign = createRecords(workspaceA.id, "Foreign");
  const own = createRecords(workspaceB.id, "Own");
  const { token } = await store.createAccessToken({
    workspaceId: "local", userId: user.id, name: "Member B session", type: "pat", purpose: "session",
  });
  const app = createMultiremiApp({ store, authToken: masterToken });
  return { store, app, owner, user, workspaceA, workspaceB, foreign, own, headers: authHeaders(token) };
}

for (const { prefix, issueIdsKey } of issueRoutes) {
  describe(`workspace batch boundaries: ${prefix}`, () => {
    it("hides an inaccessible parent with a successful empty children list", async () => {
      const { app, foreign, headers } = await setup();
      const response = await app.request(`${prefix}/children?parent_ids=${foreign.parent.id}`, { headers });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ issues: [], total: 0 });
    });

    it("filters mixed-workspace parents while preserving the response wire shape", async () => {
      const { app, foreign, own, headers } = await setup();
      const response = await app.request(`${prefix}/children?parent_ids=${foreign.parent.id},${own.parent.id}`, { headers });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.total).toBe(1);
      expect(body.issues.map((issue: { id: string }) => issue.id)).toEqual([own.child.id]);
      if (prefix === "/api/issues") {
        expect(body.issues[0]).toMatchObject({
          workspace_id: own.child.workspaceId, parent_issue_id: own.parent.id, identifier: own.child.key,
        });
        expect(body.issues[0].workspaceId).toBeUndefined();
      } else {
        expect(body.issues[0]).toMatchObject({
          workspaceId: own.child.workspaceId, parentIssueId: own.parent.id, key: own.child.key,
        });
        expect(body.issues[0].workspace_id).toBeUndefined();
      }
    });

    it("skips missing parents without losing accessible children", async () => {
      const { app, own, headers } = await setup();
      const response = await app.request(`${prefix}/children?parent_ids=missing-parent,${own.parent.id}`, { headers });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.total).toBe(1);
      expect(body.issues.map((issue: { id: string }) => issue.id)).toEqual([own.child.id]);
    });

    it("checks child workspace independently and never traverses an inaccessible parent", async () => {
      const { store, app, workspaceA, workspaceB, foreign, own, headers } = await setup();
      const foreignChild = store.createIssue({ workspaceId: workspaceA.id, title: "Foreign child under own parent" });
      const ownChild = store.createIssue({ workspaceId: workspaceB.id, title: "Own child under foreign parent" });
      db!.run("UPDATE multiremi_issues SET parent_issue_id = ? WHERE id = ?", [own.parent.id, foreignChild.id]);
      db!.run("UPDATE multiremi_issues SET parent_issue_id = ? WHERE id = ?", [foreign.parent.id, ownChild.id]);
      const response = await app.request(`${prefix}/children?parent_ids=${own.parent.id},${foreign.parent.id}`, { headers });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.total).toBe(1);
      expect(body.issues.map((issue: { id: string }) => issue.id)).toEqual([own.child.id]);
    });

    it("memoizes both allowed and denied workspace checks within each request", async () => {
      const { store, app, workspaceA, workspaceB, foreign, own, headers } = await setup();
      const otherForeignParent = store.createIssue({ workspaceId: workspaceA.id, title: "Other foreign parent" });
      const otherOwnParent = store.createIssue({ workspaceId: workspaceB.id, title: "Other own parent" });
      store.createIssue({ workspaceId: workspaceB.id, title: "Other own child", parentIssueId: otherOwnParent.id });
      const membership = spyOn(store, "getUserRoleInWorkspace");
      const parentIds = [foreign.parent.id, own.parent.id, otherForeignParent.id, otherOwnParent.id];
      const response = await app.request(`${prefix}/children?parent_ids=${parentIds.join(",")}`, { headers });
      expect(response.status).toBe(200);
      expect((await response.json()).total).toBe(2);
      expect(membership.mock.calls.filter((call) => call[1] === workspaceA.id)).toHaveLength(1);
      expect(membership.mock.calls.filter((call) => call[1] === workspaceB.id)).toHaveLength(1);
    });

    it("rejects a foreign issue without persisting priority or status changes", async () => {
      const { store, app, foreign, headers } = await setup();
      const response = await app.request(`${prefix}/batch-update`, {
        method: "POST", headers,
        body: JSON.stringify({ [issueIdsKey]: [foreign.parent.id], updates: { priority: "urgent", status: "done" } }),
      });
      expect(store.getIssue(foreign.parent.id)).toMatchObject({ priority: "low", status: "todo" });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "workspace not found" });
    });

    for (const order of ["own-first", "foreign-first"]) {
      it(`rejects the entire mixed batch without persisting either issue (${order})`, async () => {
        const { store, app, foreign, own, headers } = await setup();
        const issueIds = order === "own-first" ? [own.parent.id, foreign.parent.id] : [foreign.parent.id, own.parent.id];
        const response = await app.request(`${prefix}/batch-update`, {
          method: "POST", headers,
          body: JSON.stringify({ [issueIdsKey]: issueIds, updates: { priority: "urgent", status: "done" } }),
        });
        expect(store.getIssue(foreign.parent.id)).toMatchObject({ priority: "low", status: "todo" });
        expect(store.getIssue(own.parent.id)).toMatchObject({ priority: "low", status: "todo" });
        expect(response.status).toBe(404);
      });
    }

    it("allows an ordinary member to update their own workspace", async () => {
      const { store, app, own, headers } = await setup();
      const response = await app.request(`${prefix}/batch-update`, {
        method: "POST", headers,
        body: JSON.stringify({ [issueIdsKey]: [own.parent.id], updates: { priority: "high", status: "in_progress" } }),
      });
      expect(response.status).toBe(200);
      expect(store.getIssue(own.parent.id)).toMatchObject({ priority: "high", status: "in_progress" });
      const body = await response.json();
      if (prefix === "/api/issues") {
        expect(body).toEqual({ updated: 1 });
      } else {
        expect(body.updated).toBe(1);
        expect(body.issues).toEqual([expect.objectContaining({ id: own.parent.id, priority: "high", status: "in_progress" })]);
      }
    });

    it("preserves missing-ID skipping and duplicate-ID update counts", async () => {
      const { store, app, own, headers } = await setup();
      const response = await app.request(`${prefix}/batch-update`, {
        method: "POST", headers,
        body: JSON.stringify({ [issueIdsKey]: ["missing-issue", own.parent.id, own.parent.id], updates: { priority: "high" } }),
      });
      expect(response.status).toBe(200);
      expect((await response.json()).updated).toBe(2);
      expect(store.getIssue(own.parent.id)?.priority).toBe("high");
    });

    for (const mode of ["master", "open"]) {
      it(`preserves cross-workspace children, updates and ordinary tasks in ${mode} mode`, async () => {
        const { store, app: authenticatedApp, foreign, own } = await setup();
        const app = mode === "master" ? authenticatedApp : createMultiremiApp({ store, authToken: "" });
        const headers = mode === "master" ? authHeaders(masterToken) : { "Content-Type": "application/json" };
        const children = await app.request(`${prefix}/children?parent_ids=${foreign.parent.id},${own.parent.id}`, { headers });
        expect(children.status).toBe(200);
        const childrenBody = await children.json();
        expect(childrenBody.total).toBe(2);
        expect(childrenBody.issues.map((issue: { id: string }) => issue.id).sort()).toEqual([foreign.child.id, own.child.id].sort());
        const updated = await app.request(`${prefix}/batch-update`, {
          method: "POST", headers,
          body: JSON.stringify({ [issueIdsKey]: [foreign.parent.id, own.parent.id], updates: { priority: "high", status: "in_progress" } }),
        });
        expect(updated.status).toBe(200);
        expect((await updated.json()).updated).toBe(2);
        for (const issue of [foreign.parent, own.parent]) {
          expect(store.getIssue(issue.id)).toMatchObject({ priority: "high", status: "in_progress" });
        }
        const tasks = await app.request("/api/multiremi/tasks", { headers });
        expect(tasks.status).toBe(200);
        expect((await tasks.json()).tasks.map((task: { id: string }) => task.id).sort()).toEqual([foreign.task.id, own.task.id].sort());
      });
    }
  });
}

describe("batch issue parameter compatibility", () => {
  it("keeps parentIds native-only while filtering its results", async () => {
    const { app, foreign, own, headers } = await setup();
    const query = `parentIds=${foreign.parent.id},${own.parent.id}`;
    const native = await app.request(`/api/multiremi/issues/children?${query}`, { headers });
    expect(native.status).toBe(200);
    const body = await native.json();
    expect(body.total).toBe(1);
    expect(body.issues.map((issue: { id: string }) => issue.id)).toEqual([own.child.id]);
    const compatibility = await app.request(`/api/issues/children?${query}`, { headers });
    expect(compatibility.status).toBe(200);
    expect(await compatibility.json()).toEqual({ issues: [], total: 0 });
  });

  it("checks the native snake-case issue_ids alias before any update", async () => {
    const { store, app, foreign, own, headers } = await setup();
    const response = await app.request("/api/multiremi/issues/batch-update", {
      method: "POST", headers,
      body: JSON.stringify({ issue_ids: [own.parent.id, foreign.parent.id], updates: { priority: "urgent", status: "done" } }),
    });
    expect(store.getIssue(foreign.parent.id)).toMatchObject({ priority: "low", status: "todo" });
    expect(store.getIssue(own.parent.id)).toMatchObject({ priority: "low", status: "todo" });
    expect(response.status).toBe(404);
  });

  it("retains the compatibility route's 400 for missing or camel-case issue IDs", async () => {
    const { app, own, headers } = await setup();
    for (const input of [{}, { issue_ids: [] }, { issueIds: [own.parent.id] }]) {
      const response = await app.request("/api/issues/batch-update", {
        method: "POST", headers, body: JSON.stringify({ ...input, updates: { priority: "high" } }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "issue_ids is required" });
    }
  });
});

describe("ordinary task workspace boundaries", () => {
  it("hides foreign non-Chat tasks and retains the member's own tasks", async () => {
    const { app, foreign, own, headers } = await setup();
    const response = await app.request("/api/multiremi/tasks", { headers });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.tasks.map((task: { id: string }) => task.id)).toEqual([own.task.id]);
    expect(JSON.stringify(body)).not.toContain(foreign.task.prompt);
  });

  it("memoizes allowed and denied workspaces across ordinary tasks", async () => {
    const { store, app, workspaceA, workspaceB, foreign, own, headers } = await setup();
    store.createTask({ agentId: foreign.agent.id, prompt: "Second foreign task" });
    const secondOwn = store.createTask({ agentId: own.agent.id, prompt: "Second own task" });
    const membership = spyOn(store, "getUserRoleInWorkspace");
    const response = await app.request("/api/multiremi/tasks", { headers });
    expect(response.status).toBe(200);
    expect((await response.json()).tasks.map((task: { id: string }) => task.id).sort()).toEqual([own.task.id, secondOwn.id].sort());
    expect(membership.mock.calls.filter((call) => call[1] === workspaceA.id)).toHaveLength(1);
    expect(membership.mock.calls.filter((call) => call[1] === workspaceB.id)).toHaveLength(1);
  });

  it("keeps task-token workspace scoping even when its owner belongs to both workspaces", async () => {
    const { store, app, owner, workspaceA, workspaceB, own } = await setup();
    expect(store.getUserRoleInWorkspace(owner.id, workspaceA.id)).toBe("owner");
    expect(store.getUserRoleInWorkspace(owner.id, workspaceB.id)).toBe("owner");
    const { token } = await store.createTaskAccessToken(own.task, owner.id);
    const response = await app.request("/api/multiremi/tasks", { headers: authHeaders(token) });
    expect(response.status).toBe(200);
    expect((await response.json()).tasks.map((task: { id: string }) => task.id)).toEqual([own.task.id]);
  });

  for (const mode of ["authenticated", "open"]) {
    it(`rejects daemon tokens before listing tasks in ${mode} mode`, async () => {
      const { store, app: authenticatedApp, owner, workspaceB } = await setup();
      const app = mode === "authenticated" ? authenticatedApp : createMultiremiApp({ store, authToken: "" });
      const { token } = await store.createAccessToken({
        workspaceId: workspaceB.id, userId: owner.id, name: "Boundary daemon", type: "daemon",
      });
      const response = await app.request("/api/multiremi/tasks", { headers: authHeaders(token) });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden for daemon token" });
    });
  }
});
