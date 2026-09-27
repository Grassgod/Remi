import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function setup() {
  const store = createStore();
  store.ensureLocalWorkspace();
  const owner = store.createAgent({ name: "Parent owner", provider: "codex" });
  const other = store.createAgent({ name: "Other agent", provider: "codex" });
  const parent = store.createIssue({ title: "Parent", status: "in_progress", assigneeType: "agent", assigneeId: owner.id });
  const child = store.createIssue({ title: "Child", status: "in_progress", parentIssueId: parent.id });
  return { store, owner, other, parent, child, app: createMultiremiApp({ store }) };
}

async function tokens(store: ReturnType<typeof createStore>, ownerId: string) {
  const task = store.createTask({ agentId: ownerId, prompt: "Summarize parent" });
  const taskToken = await store.createTaskAccessToken(task, "local");
  const memberToken = await store.createAccessToken({ name: "Granting member", type: "pat", workspaceId: "local", userId: "local" });
  return { taskToken: taskToken.token, memberToken: memberToken.token };
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function activities(store: ReturnType<typeof createStore>, issueId: string, type: string) {
  return store.listIssueActivity(issueId).filter((entry) => entry.type === type);
}

describe("MUL-457 parent done grant", () => {
  it("requires a member to grant, preserves idempotence, and exposes the fixed detail shape", async () => {
    const { store, owner, parent, app } = setup();
    const { taskToken, memberToken } = await tokens(store, owner.id);
    expect(store.issueParentDoneGrantView(store.getIssue(parent.id)!)).toBeNull();
    expect(store.getIssue(parent.id)).toMatchObject({ parentDoneGrantAt: null, parentDoneGrantBy: null, parentDoneGrantAgentId: null });
    for (const base of ["/api/issues", "/api/multiremi/issues"]) {
      const denied = await app.request(`${base}/${parent.id}/parent-done-grant`, {
        method: "POST", headers: auth(taskToken), body: JSON.stringify({ actor_type: "member" }),
      });
      expect(denied.status).toBe(403);
      expect((await denied.json()).code).toBe("parent_done_grant_requires_member");
    }
    const missing = await app.request(`/api/issues/${parent.id}`, {
      method: "PATCH", headers: auth(taskToken), body: JSON.stringify({ status: "done" }),
    });
    expect(missing.status).toBe(403);
    expect(await missing.json()).toMatchObject({ code: "parent_done_requires_member", reason: "grant_missing" });

    for (const base of ["/api/issues", "/api/multiremi/issues"]) {
      const added = await app.request(`${base}/${parent.id}/parent-done-grant`, { method: "POST", headers: auth(memberToken) });
      expect(added.status).toBe(200);
    }
    expect(activities(store, parent.id, "parent_done_grant_created")).toHaveLength(1);
    for (const base of ["/api/issues", "/api/multiremi/issues"]) {
      const detail = await app.request(`${base}/${parent.id}`, { headers: auth(memberToken) });
      const body = await detail.json();
      const issue = base === "/api/issues" ? body : body.issue;
      expect(issue.parent_done_grant).toMatchObject({ agent_id: owner.id, effective: true, ineffective_reason: null });
      expect(issue.parent_done_grant.granted_at).toBeTruthy();
      expect(issue.parent_done_grant.granted_by).toBeTruthy();
    }
    const removed = await app.request(`/api/issues/${parent.id}/parent-done-grant`, { method: "DELETE", headers: auth(memberToken) });
    expect(removed.status).toBe(200);
    expect((await removed.json()).parent_done_grant).toBeNull();
    await app.request(`/api/multiremi/issues/${parent.id}/parent-done-grant`, { method: "DELETE", headers: auth(memberToken) });
    expect(activities(store, parent.id, "parent_done_grant_revoked")).toHaveLength(1);
    const revoked = await app.request(`/api/issues/${parent.id}`, {
      method: "PATCH", headers: auth(taskToken), body: JSON.stringify({ status: "done" }),
    });
    expect(revoked.status).toBe(403);
    expect((await revoked.json()).reason).toBe("grant_missing");
  });

  it("accepts only an authorized agent's non-empty comment after the final child closed", async () => {
    const { store, owner, other, parent, child, app } = setup();
    const { taskToken, memberToken } = await tokens(store, owner.id);
    store.grantParentDone(parent.id, "local");
    store.createIssueComment(parent.id, { body: "Earlier summary", authorType: "agent", authorId: owner.id });
    db!.run("UPDATE multiremi_issue_comments SET created_at = '2020-01-01T00:00:00.000Z' WHERE issue_id = ?", [parent.id]);
    store.updateIssue(child.id, { status: "done" });
    store.createIssueComment(parent.id, { body: "Other agent summary", authorType: "agent", authorId: other.id });
    store.createIssueComment(parent.id, { body: "Member summary", authorType: "member", authorId: "local" });
    const done = () => app.request(`/api/issues/${parent.id}`, {
      method: "PATCH", headers: auth(taskToken), body: JSON.stringify({ status: "done" }),
    });
    const held = await done();
    expect(held.status).toBe(409);
    expect(await held.json()).toMatchObject({ code: "final_summary_missing", reason: "final_summary_missing", last_child_closed_at: expect.any(String) });
    const comment = await app.request(`/api/issues/${parent.id}/comments`, {
      method: "POST", headers: auth(taskToken), body: JSON.stringify({ body: "All child work is complete." }),
    });
    expect(comment.status).toBe(201);
    const accepted = await done();
    expect(accepted.status).toBe(200);
    expect(activities(store, parent.id, "issue_updated").length).toBeGreaterThan(0);
    expect(activities(store, parent.id, "parent_done_grant_used")[0]?.data).toMatchObject({ source: "api" });
    expect(store.getIssue(parent.id)?.status).toBe("done");
    expect(memberToken).toBeTruthy();
  });

  it("keeps member A1 unchanged and invalidates a grant after reassignment", async () => {
    const { store, owner, other, parent, child, app } = setup();
    const { taskToken, memberToken } = await tokens(store, owner.id);
    store.grantParentDone(parent.id, "local");
    store.updateIssue(child.id, { status: "cancelled" });
    store.createIssueComment(parent.id, { body: "Owner summary", authorType: "agent", authorId: owner.id });
    const memberDone = await app.request(`/api/issues/${parent.id}`, {
      method: "PATCH", headers: auth(memberToken), body: JSON.stringify({ status: "done" }),
    });
    expect(memberDone.status).toBe(409);
    expect((await memberDone.json()).code).toBe("final_summary_missing");
    store.updateIssue(parent.id, { assigneeType: "agent", assigneeId: other.id });
    expect(store.issueParentDoneGrantView(store.getIssue(parent.id)!)).toMatchObject({
      effective: false, ineffective_reason: "assignee_changed", agent_id: owner.id,
    });
    const oldAgent = await app.request(`/api/issues/${parent.id}`, {
      method: "PATCH", headers: auth(taskToken), body: JSON.stringify({ status: "done" }),
    });
    expect(oldAgent.status).toBe(403);
    expect((await oldAgent.json()).reason).toBe("assignee_changed");
    store.grantParentDone(parent.id, "local");
    expect(store.issueParentDoneGrantView(store.getIssue(parent.id)!)).toMatchObject({ effective: true, agent_id: other.id });
    expect(activities(store, parent.id, "parent_done_grant_created")).toHaveLength(2);
  });

  it("holds unfinished children after authorization and rejects non-agent owners", async () => {
    const { store, owner, other, parent, app } = setup();
    const { taskToken, memberToken } = await tokens(store, owner.id);
    store.grantParentDone(parent.id, "local");
    const held = await app.request(`/api/multiremi/issues/${parent.id}`, {
      method: "PATCH", headers: auth(taskToken), body: JSON.stringify({ status: "done" }),
    });
    expect(await held.json()).toMatchObject({ code: "issue_status_held", reason: "children_open", open_children: 1 });
    const forced = await app.request(`/api/issues/${parent.id}`, {
      method: "PATCH", headers: auth(taskToken), body: JSON.stringify({ status: "done", force: true }),
    });
    expect(forced.status).toBe(403);
    expect((await forced.json()).code).toBe("issue_force_requires_member");
    expect(() => store.updateIssue(parent.id, {
      status: "done", force: true, actorType: "agent", actorId: owner.id,
    })).toThrow("Only a member can force");
    const otherToken = (await tokens(store, other.id)).taskToken;
    const denied = await app.request(`/api/issues/${parent.id}`, {
      method: "PATCH", headers: auth(otherToken), body: JSON.stringify({ status: "done" }),
    });
    expect((await denied.json()).reason).toBe("not_owner_agent");
    store.updateIssue(parent.id, { assigneeType: null, assigneeId: null });
    const invalid = await app.request(`/api/issues/${parent.id}/parent-done-grant`, { method: "POST", headers: auth(memberToken) });
    expect(invalid.status).toBe(409);
    expect((await invalid.json()).code).toBe("parent_done_grant_owner_not_agent");
    const human = store.createWorkspaceMember({ name: "Human owner" });
    store.updateIssue(parent.id, { assigneeType: "member", assigneeId: human.id });
    const memberOwner = await app.request(`/api/issues/${parent.id}/parent-done-grant`, { method: "POST", headers: auth(memberToken) });
    expect(memberOwner.status).toBe(409);
    expect((await memberOwner.json()).code).toBe("parent_done_grant_owner_not_agent");
  });

  it("authorizes a squad's leader but not another squad member", async () => {
    const { store, owner, other, parent, child, app } = setup();
    const squad = store.createSquad({ name: "Parent squad", leaderId: owner.id, memberIds: [other.id] });
    store.updateIssue(parent.id, { assigneeType: "squad", assigneeId: squad.id });
    const { taskToken, memberToken } = await tokens(store, owner.id);
    const granted = await app.request(`/api/issues/${parent.id}/parent-done-grant`, { method: "POST", headers: auth(memberToken) });
    expect(granted.status).toBe(200);
    expect((await granted.json()).parent_done_grant).toMatchObject({ agent_id: owner.id, effective: true });
    store.updateIssue(child.id, { status: "done" });
    store.createIssueComment(parent.id, { body: "Squad summary", authorType: "agent", authorId: owner.id });
    const teammateToken = (await tokens(store, other.id)).taskToken;
    const teammate = await app.request(`/api/issues/${parent.id}`, {
      method: "PATCH", headers: auth(teammateToken), body: JSON.stringify({ status: "done" }),
    });
    expect(teammate.status).toBe(403);
    const leader = await app.request(`/api/issues/${parent.id}`, {
      method: "PATCH", headers: auth(taskToken), body: JSON.stringify({ status: "done" }),
    });
    expect(leader.status).toBe(200);
  });

  it("accepts a completed result-bearing owner round and applies authorized batch updates atomically", async () => {
    const { store, owner, other, parent, child, app } = setup();
    const { taskToken } = await tokens(store, owner.id);
    store.grantParentDone(parent.id, "local");
    store.updateIssue(child.id, { status: "done" });
    const finished = store.createTask({ agentId: owner.id, issueId: parent.id, prompt: "Final report" });
    db!.run(
      "UPDATE multiremi_tasks SET status = 'completed', result = ?, completed_at = ? WHERE id = ?",
      [JSON.stringify({ output: "All children delivered" }), new Date(Date.now() + 1_000).toISOString(), finished.id],
    );
    const otherParent = store.createIssue({ title: "Other parent", status: "in_progress", assigneeType: "agent", assigneeId: other.id });
    const otherChild = store.createIssue({ title: "Other child", status: "in_progress", parentIssueId: otherParent.id });
    store.updateIssue(otherChild.id, { status: "cancelled" });
    const beforeBatch = store.getIssue(parent.id)!.status;
    for (const route of ["/api/issues/batch-update", "/api/multiremi/issues/batch-update"]) {
      const refused = await app.request(route, {
        method: "POST", headers: auth(taskToken),
        body: JSON.stringify({ issue_ids: [parent.id, otherParent.id], updates: { status: "done" } }),
      });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ rejected_issue_ids: [otherParent.id] });
      expect(store.getIssue(parent.id)?.status).toBe(beforeBatch);
    }
    const accepted = await app.request("/api/issues/batch-update", {
      method: "POST", headers: auth(taskToken),
      body: JSON.stringify({ issue_ids: [parent.id], updates: { status: "done" } }),
    });
    expect(accepted.status).toBe(200);
    expect(store.getIssue(parent.id)?.status).toBe("done");
    expect(activities(store, parent.id, "parent_done_grant_used")).toHaveLength(1);
  });
});
