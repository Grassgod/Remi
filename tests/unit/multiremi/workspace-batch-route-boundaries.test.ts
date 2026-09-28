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

    for (const refType of ["key", "id"] as const) {
      it(`lists children by parent ${refType} in the requested workspace`, async () => {
        const { app, own, workspaceB, headers } = await setup();
        const response = await app.request(`${prefix}/children?parent_ids=${own.parent[refType]}&workspace_id=${workspaceB.id}`, { headers });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.total).toBe(1);
        expect(body.issues.map((issue: { id: string }) => issue.id)).toEqual([own.child.id]);
      });
    }

    for (const selector of ["X-Workspace-ID", "X-Workspace-Slug"] as const) {
      it(`resolves a duplicate key using ${selector}`, async () => {
        const { app, own, workspaceB, headers } = await setup();
        const response = await app.request(`${prefix}/children?parent_ids=${own.parent.key.toLowerCase()}`, {
          headers: { ...headers, [selector]: selector === "X-Workspace-ID" ? workspaceB.id : workspaceB.slug },
        });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.total).toBe(1);
        expect(body.issues.map((issue: { id: string }) => issue.id)).toEqual([own.child.id]);
      });

      it(`still denies an inaccessible workspace selected by ${selector}`, async () => {
        const { store, app, foreign, workspaceA, headers } = await setup();
        const listChildren = spyOn(store, "listChildIssues");
        const response = await app.request(`${prefix}/children?parent_ids=${foreign.parent.key}`, {
          headers: { ...headers, [selector]: selector === "X-Workspace-ID" ? workspaceA.id : workspaceA.slug },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ issues: [], total: 0 });
        expect(listChildren).not.toHaveBeenCalled();
      });

      it(`prefers the workspace query over ${selector}`, async () => {
        const { app, foreign, own, workspaceA, workspaceB } = await setup();
        const response = await app.request(`${prefix}/children?parent_ids=${own.parent.key}&workspace_id=${workspaceB.id}`, {
          headers: {
            ...authHeaders(masterToken),
            [selector]: selector === "X-Workspace-ID" ? workspaceA.id : workspaceA.slug,
          },
        });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.total).toBe(1);
        expect(body.issues.map((issue: { id: string }) => issue.id)).toEqual([own.child.id]);
        expect(body.issues.map((issue: { id: string }) => issue.id)).not.toContain(foreign.child.id);
      });
    }

    it("prefers the ID header over the slug header", async () => {
      const { app, own, workspaceA, workspaceB } = await setup();
      const response = await app.request(`${prefix}/children?parent_ids=${own.parent.key}`, {
        headers: { ...authHeaders(masterToken), "X-Workspace-ID": workspaceB.id, "X-Workspace-Slug": workspaceA.slug },
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.total).toBe(1);
      expect(body.issues.map((issue: { id: string }) => issue.id)).toEqual([own.child.id]);
    });

    it("skips keys for an unknown explicit slug while still resolving full IDs", async () => {
      const { store, app, own, workspaceB, headers } = await setup();
      const keyedParent = store.createIssue({ workspaceId: workspaceB.id, title: "Unique keyed parent" });
      store.createIssue({ workspaceId: workspaceB.id, title: "Unique keyed child", parentIssueId: keyedParent.id });
      expect(store.getIssueByRef(keyedParent.key, null)?.id).toBe(keyedParent.id);
      const listChildren = spyOn(store, "listChildIssues");
      const response = await app.request(`${prefix}/children?parent_ids=${keyedParent.key},${own.parent.id}`, {
        headers: { ...headers, "X-Workspace-Slug": "missing-workspace" },
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.total).toBe(1);
      expect(body.issues.map((issue: { id: string }) => issue.id)).toEqual([own.child.id]);
      expect(listChildren.mock.calls).toEqual([[own.parent.id]]);
    });

    for (const selector of ["workspace_id", "X-Workspace-ID", "X-Workspace-Slug"] as const) {
      const request = (app: ReturnType<typeof createMultiremiApp>, ref: string, workspace: { id: string; slug: string }, headers: Record<string, string>) =>
        selector === "workspace_id"
          ? app.request(`${prefix}/children?parent_ids=${ref}&workspace_id=${workspace.id}`, { headers })
          : app.request(`${prefix}/children?parent_ids=${ref}`, {
            headers: { ...headers, [selector]: selector === "X-Workspace-ID" ? workspace.id : workspace.slug },
          });

      it(`resolves an accessible full ID outside the workspace selected by ${selector}`, async () => {
        const { store, app, own, headers } = await setup();
        const local = store.getWorkspace("local")!;
        const response = await request(app, own.parent.id, local, headers);
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.total).toBe(1);
        expect(body.issues.map((issue: { id: string }) => issue.id)).toEqual([own.child.id]);
      });

      it(`keeps exact IDs ahead of a scoped prefix candidate selected by ${selector}`, async () => {
        const { store, app, workspaceA, workspaceB } = await setup();
        const exactParent = store.createIssue({ id: "iss_mul415_exact111", workspaceId: workspaceB.id, title: "Exact parent" });
        const exactChild = store.createIssue({ workspaceId: workspaceB.id, title: "Exact child", parentIssueId: exactParent.id });
        const prefixParent = store.createIssue({ id: `${exactParent.id}extra`, workspaceId: workspaceA.id, title: "Prefix parent" });
        const prefixChild = store.createIssue({ workspaceId: workspaceA.id, title: "Prefix child", parentIssueId: prefixParent.id });
        expect(store.getIssueByRef(exactParent.id, workspaceA.id)?.id).toBe(prefixParent.id);

        const response = await request(app, exactParent.id, workspaceA, authHeaders(masterToken));
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.total).toBe(1);
        expect(body.issues.map((issue: { id: string }) => issue.id)).toEqual([exactChild.id]);
        expect(body.issues.map((issue: { id: string }) => issue.id)).not.toContain(prefixChild.id);
        expect(body.issues.map((issue: { title: string }) => issue.title)).toEqual(["Exact child"]);
      });

      it(`hides an inaccessible full ID outside the workspace selected by ${selector}`, async () => {
        const { store, app, foreign, workspaceB, headers } = await setup();
        const listChildren = spyOn(store, "listChildIssues");
        const response = await request(app, foreign.parent.id, workspaceB, headers);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ issues: [], total: 0 });
        expect(listChildren).not.toHaveBeenCalled();
      });
    }

    it("lists children of distinct parents supplied as a key and an id", async () => {
      const { store, app, own, workspaceB, headers } = await setup();
      const otherParent = store.createIssue({ workspaceId: workspaceB.id, title: "Other keyed parent" });
      const otherChild = store.createIssue({ workspaceId: workspaceB.id, title: "Other keyed child", parentIssueId: otherParent.id });
      const response = await app.request(`${prefix}/children?parent_ids=${own.parent.key},${otherParent.id}&workspace_id=${workspaceB.id}`, { headers });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.total).toBe(2);
      expect(body.issues.map((issue: { id: string }) => issue.id)).toEqual([own.child.id, otherChild.id]);
    });

    it("deduplicates a parent resolved from both its key and id", async () => {
      const { store, app, own, workspaceB, headers } = await setup();
      const listChildren = spyOn(store, "listChildIssues");
      const response = await app.request(`${prefix}/children?parent_ids=${own.parent.key},${own.parent.id},${own.parent.key}&workspace_id=${workspaceB.id}`, { headers });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.total).toBe(1);
      expect(body.issues.map((issue: { id: string }) => issue.id)).toEqual([own.child.id]);
      expect(listChildren.mock.calls).toEqual([[own.parent.id]]);
    });

    it("skips an unknown key and still lists other accessible parents", async () => {
      const { app, own, workspaceB, headers } = await setup();
      const unknown = await app.request(`${prefix}/children?parent_ids=MUL-999999&workspace_id=${workspaceB.id}`, { headers });
      expect(unknown.status).toBe(200);
      expect(await unknown.json()).toEqual({ issues: [], total: 0 });
      const mixed = await app.request(`${prefix}/children?parent_ids=MUL-999999,${own.parent.key}&workspace_id=${workspaceB.id}`, { headers });
      expect(mixed.status).toBe(200);
      const body = await mixed.json();
      expect(body.total).toBe(1);
      expect(body.issues.map((issue: { id: string }) => issue.id)).toEqual([own.child.id]);
    });

    it("hides a key resolved in an inaccessible workspace without traversing it", async () => {
      const { store, app, foreign, workspaceA, headers } = await setup();
      expect(store.getIssueByRef(foreign.parent.key, workspaceA.id)?.id).toBe(foreign.parent.id);
      const listChildren = spyOn(store, "listChildIssues");
      const response = await app.request(`${prefix}/children?parent_ids=${foreign.parent.key}&workspace_id=${workspaceA.id}`, { headers });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ issues: [], total: 0 });
      expect(listChildren).not.toHaveBeenCalled();
    });

    it("skips an ambiguous unscoped key when there is no unique local match", async () => {
      const { store, app, foreign, own, headers } = await setup();
      expect(foreign.parent.key).toBe(own.parent.key);
      expect(store.getIssueByRef(own.parent.key, null)).toBeNull();
      const listChildren = spyOn(store, "listChildIssues");
      const response = await app.request(`${prefix}/children?parent_ids=${own.parent.key}`, { headers });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ issues: [], total: 0 });
      expect(listChildren).not.toHaveBeenCalled();
    });

    for (const refType of ["key", "prefix"] as const) {
      it(`prefers a unique local row for an unscoped ambiguous ${refType} and honors explicit workspace scope`, async () => {
        const { store, app, own, workspaceB } = await setup();
        const localParent = store.createIssue({ id: "iss_mul415_shared_local", title: "Local parent" });
        const localChild = store.createIssue({ title: "Local child", parentIssueId: localParent.id });
        const otherParent = refType === "key" ? own.parent : store.createIssue({
          id: "iss_mul415_shared_other", workspaceId: workspaceB.id, title: "Other prefix parent",
        });
        const otherChild = refType === "key" ? own.child : store.createIssue({
          workspaceId: workspaceB.id, title: "Other prefix child", parentIssueId: otherParent.id,
        });
        const ref = refType === "key" ? localParent.key : "iss_mul415_shared";
        if (refType === "key") expect(otherParent.key).toBe(localParent.key);
        const headers = authHeaders(masterToken);
        for (const [query, expectedChild] of [["", localChild], [`&workspace_id=${workspaceB.id}`, otherChild]] as const) {
          const response = await app.request(`${prefix}/children?parent_ids=${ref}${query}`, { headers });
          expect(response.status).toBe(200);
          const body = await response.json();
          expect(body.total).toBe(1);
          expect(body.issues.map((issue: { id: string }) => issue.id)).toEqual([expectedChild.id]);
        }
      });
    }

    it("does not infer a workspace from the token or membership for an unscoped duplicate key", async () => {
      const { store, app, user, own, workspaceB } = await setup();
      const { token } = await store.createAccessToken({
        workspaceId: workspaceB.id, userId: user.id, name: "Workspace B token", type: "pat",
      });
      const response = await app.request(`${prefix}/children?parent_ids=${own.parent.key}`, { headers: authHeaders(token) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ issues: [], total: 0 });
    });

    it("resolves an unambiguous key when no workspace is supplied", async () => {
      const { store, app, workspaceB, headers } = await setup();
      const parent = store.createIssue({ workspaceId: workspaceB.id, title: "Unique unscoped parent" });
      const child = store.createIssue({ workspaceId: workspaceB.id, title: "Unique unscoped child", parentIssueId: parent.id });
      const response = await app.request(`${prefix}/children?parent_ids=${parent.key}`, { headers });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.total).toBe(1);
      expect(body.issues.map((issue: { id: string }) => issue.id)).toEqual([child.id]);
    });

    it("checks child workspace access after resolving a parent key", async () => {
      const { store, app, own, workspaceA, workspaceB, headers } = await setup();
      const foreignChild = store.createIssue({ workspaceId: workspaceA.id, title: "Foreign child under keyed parent" });
      db!.run("UPDATE multiremi_issues SET parent_issue_id = ? WHERE id = ?", [own.parent.id, foreignChild.id]);
      const response = await app.request(`${prefix}/children?parent_ids=${own.parent.key}&workspace_id=${workspaceB.id}`, { headers });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.total).toBe(1);
      expect(body.issues.map((issue: { id: string }) => issue.id)).toEqual([own.child.id]);
    });

    it("hides foreign keys from a task token even when its owner belongs to both workspaces", async () => {
      const { store, app, owner, foreign, own, workspaceA } = await setup();
      const { token } = await store.createTaskAccessToken(own.task, owner.id);
      const response = await app.request(`${prefix}/children?parent_ids=${foreign.parent.key}&workspace_id=${workspaceA.id}`, { headers: authHeaders(token) });
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
  it("keeps workspaceId native-only and gives it precedence over workspace_id", async () => {
    const { app, foreign, own, workspaceA, workspaceB } = await setup();
    expect(foreign.parent.key).toBe(own.parent.key);
    const headers = { ...authHeaders(masterToken), "X-Workspace-ID": workspaceA.id, "X-Workspace-Slug": workspaceA.slug };
    for (const [prefix, expectedChild] of [["/api/issues", foreign.child], ["/api/multiremi/issues", own.child]] as const) {
      const response = await app.request(`${prefix}/children?parent_ids=${own.parent.key}&workspaceId=${workspaceB.id}&workspace_id=${workspaceA.id}`, { headers });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.total).toBe(1);
      expect(body.issues.map((issue: { id: string }) => issue.id)).toEqual([expectedChild.id]);
    }
    const compat = await app.request(`/api/issues/children?parent_ids=${own.parent.key}&workspaceId=${workspaceB.id}`, {
      headers: authHeaders(masterToken),
    });
    expect(compat.status).toBe(200);
    expect(await compat.json()).toEqual({ issues: [], total: 0 });
  });

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

  it("lists bound-workspace tasks when the task-token owner has no member row", async () => {
    const { store, app, workspaceA, workspaceB, foreign, own } = await setup();
    const tokenOwner = store.getOrCreateUser({ email: "boundary-token-owner@example.test", name: "Token owner" });
    expect(store.listWorkspaceMembers().filter((member) => member.userId === tokenOwner.id)).toEqual([]);
    expect(store.getUserRoleInWorkspace(tokenOwner.id, workspaceA.id)).toBeNull();
    expect(store.getUserRoleInWorkspace(tokenOwner.id, workspaceB.id)).toBeNull();
    const { token } = await store.createTaskAccessToken(own.task, tokenOwner.id);
    const response = await app.request("/api/multiremi/tasks", { headers: authHeaders(token) });
    expect(response.status).toBe(200);
    const taskIds = (await response.json()).tasks.map((task: { id: string }) => task.id);
    expect(taskIds).not.toContain(foreign.task.id);
    expect(taskIds).toEqual([own.task.id]);
  });

  it("keeps bound-workspace tasks visible after the task-token owner's member row is archived", async () => {
    const { store, app, user, workspaceB, foreign, own } = await setup();
    const member = store.listWorkspaceMembers(workspaceB.id).find((candidate) => candidate.userId === user.id);
    expect(member).toBeDefined();
    const { token } = await store.createTaskAccessToken(own.task, user.id);
    const headers = authHeaders(token);
    const before = await app.request("/api/multiremi/tasks", { headers });
    expect(before.status).toBe(200);
    expect((await before.json()).tasks.map((task: { id: string }) => task.id)).toEqual([own.task.id]);

    expect(store.archiveWorkspaceMember(member!.id).archivedAt).toBeTruthy();
    expect(store.getUserRoleInWorkspace(user.id, workspaceB.id)).toBeNull();
    const after = await app.request("/api/multiremi/tasks", { headers });
    expect(after.status).toBe(200);
    const taskIds = (await after.json()).tasks.map((task: { id: string }) => task.id);
    expect(taskIds).not.toContain(foreign.task.id);
    expect(taskIds).toEqual([own.task.id]);
  });

  for (const workspaceId of [null, undefined]) {
    it(`preserves unbound task-token visibility with a verified workspaceId of ${workspaceId}`, async () => {
      const { store, app, foreign, own } = await setup();
      const tokenOwner = store.getOrCreateUser({ email: "boundary-unbound-owner@example.test", name: "Unbound owner" });
      expect(store.listWorkspaceMembers().filter((member) => member.userId === tokenOwner.id)).toEqual([]);
      const { token } = await store.createTaskAccessToken(own.task, tokenOwner.id);
      const accessToken = await store.verifyAccessToken(token);
      expect(accessToken).not.toBeNull();
      Object.defineProperty(accessToken!, "workspaceId", { value: workspaceId });
      spyOn(store, "verifyAccessToken").mockResolvedValue(accessToken);
      const response = await app.request("/api/multiremi/tasks", { headers: authHeaders(token) });
      expect(response.status).toBe(200);
      expect((await response.json()).tasks.map((task: { id: string }) => task.id).sort())
        .toEqual([foreign.task.id, own.task.id].sort());
    });
  }

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
