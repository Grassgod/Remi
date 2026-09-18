import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { StoreContext } from "@multiremi/store/context.js";
import { IssuesRepo } from "@multiremi/store/repos/issues-repo.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function sideSessionFixture(inheritMode: "snapshot" | "follow" = "snapshot") {
  const store = createStore();
  const leader = store.createAgent({ name: "Leader", provider: "claude" });
  const teammate = store.createAgent({ name: "Teammate", provider: "claude" });
  const squad = store.createSquad({ name: "Delivery", leaderId: leader.id, memberIds: [teammate.id] });
  const issue = store.createIssue({ title: "Side conversation", assigneeType: "squad", assigneeId: squad.id });
  const main = store.getOrCreateDefaultIssueSession(issue.id);
  const side = store.createIssueSession(issue.id, { title: "Side", parentSessionId: main.id, inheritMode });
  const sideTask = store.createTask({
    agentId: leader.id,
    issueId: issue.id,
    issueSessionId: side.id,
    prompt: "Discuss the approach.",
  });
  return { store, leader, teammate, squad, issue, main, side, sideTask };
}

describe("Side session delegation boundary", () => {
  it.each(["snapshot", "follow"] as const)("records blocked agent rich mentions in %s without dispatching a task", (inheritMode) => {
    const { store, leader, teammate, issue, side, sideTask } = sideSessionFixture(inheritMode);
    const comment = store.createIssueComment(issue.id, {
      authorType: "agent",
      authorId: leader.id,
      taskId: sideTask.id,
      issueSessionId: side.id,
      body: `Please implement [@Teammate](mention://agent/${teammate.id})`,
    });

    expect(store.listTasksForIssue(issue.id).map((task) => task.id)).toEqual([sideTask.id]);
    expect(store.listIssueActivity(issue.id).find((activity) => activity.type === "comment_mention_skipped")?.data)
      .toMatchObject({
        reason: "side_session_delegation_blocked",
        commentId: comment.id,
        sourceTaskId: sideTask.id,
        agentId: teammate.id,
      });
  });

  it("also blocks deferred squad mentions from a side task posted into the main session", () => {
    const { store, leader, squad, issue, main, sideTask } = sideSessionFixture();
    const repo = new IssuesRepo(new StoreContext(db!, () => store));
    const comment = repo.createIssueComment(issue.id, {
      authorType: "agent",
      authorId: leader.id,
      taskId: sideTask.id,
      issueSessionId: main.id,
      body: `Please dispatch [@Delivery](mention://squad/${squad.id})`,
    }, { deferAgentMentionDispatch: true });

    expect(repo.dispatchDeferredAgentCommentMentions(comment.id)).toEqual([]);
    expect(store.listTasksForIssue(issue.id)).toHaveLength(1);
    expect(store.listIssueActivity(issue.id).find((activity) => activity.type === "comment_mention_skipped")?.data)
      .toMatchObject({ reason: "side_session_delegation_blocked", commentId: comment.id });
  });

  it.each(["snapshot", "follow"] as const)("still dispatches human rich mentions in a %s side session", (inheritMode) => {
    const { store, teammate, issue, side } = sideSessionFixture(inheritMode);
    const comment = store.createIssueComment(issue.id, {
      authorType: "member",
      issueSessionId: side.id,
      body: `Please explain [@Teammate](mention://agent/${teammate.id})`,
    });

    const created = store.listTasksForIssue(issue.id).filter((task) => task.triggerCommentId === comment.id);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      agentId: teammate.id,
      issueSessionId: side.id,
      delegationId: null,
      delegatedByAgentId: null,
    });
    expect(store.listIssueActivity(issue.id).some((activity) => activity.type === "comment_mention_skipped")).toBe(false);
  });

  it("rejects explicit delegation into side sessions, including snake-case fields", () => {
    const { store, leader, teammate, issue, side } = sideSessionFixture();
    for (const fields of [
      { issueSessionId: side.id, delegationId: "dlg_blocked", delegatedByAgentId: leader.id },
      { issue_session_id: side.id, delegation_id: "dlg_blocked", delegated_by_agent_id: leader.id },
    ]) {
      expect(() => store.createTask({
        agentId: teammate.id,
        issueId: issue.id,
        prompt: "Implement it.",
        ...fields,
      })).toThrow("Agent delegation is not allowed in side sessions");
    }
    expect(store.listTasksForIssue(issue.id)).toHaveLength(1);
  });

  it("rejects a side parent task dispatching another agent into a normal session", () => {
    const { store, teammate, issue, main, sideTask } = sideSessionFixture();
    expect(() => store.createTask({
      agentId: teammate.id,
      issueId: issue.id,
      issueSessionId: main.id,
      parentTaskId: sideTask.id,
      prompt: "Bypass delegation metadata.",
    })).toThrow("Agent delegation is not allowed from side sessions");
    expect(store.listTasksForIssue(issue.id)).toHaveLength(1);
  });

  it.each(["snapshot", "follow"] as const)("rejects task-token dispatch from %s regardless of selected target session", async (inheritMode) => {
    const { store, leader, teammate, issue, main, side, sideTask } = sideSessionFixture(inheritMode);
    const token = await store.createTaskAccessToken(sideTask, "local");
    const app = createMultiremiApp({ store, authToken: "test-root-token" });
    for (const targetSessionId of [side.id, main.id, undefined]) {
      for (const targetAgentId of [teammate.id, leader.id]) {
        const response = await app.request("/api/multiremi/tasks", {
          method: "POST",
          headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId: targetAgentId,
            issueId: issue.id,
            issueSessionId: targetSessionId,
            prompt: "Dispatch another task.",
          }),
        });
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: "Agent delegation is not allowed from side sessions" });
      }
    }
    expect(store.listTasksForIssue(issue.id)).toHaveLength(1);
  });

  it("keeps main and side tasks in independent execution lanes", () => {
    const { store, leader, issue, main, sideTask } = sideSessionFixture();
    const runtime = store.registerRuntime({
      id: "rt_side_parallel",
      name: "Side runtime",
      provider: "claude",
      workspaceId: "local",
      maxConcurrency: 4,
    });
    const mainTask = store.createTask({
      agentId: leader.id,
      issueId: issue.id,
      issueSessionId: main.id,
      priority: 10,
      prompt: "Continue the main task.",
    });
    expect(store.claimTask(runtime.id)?.id).toBe(mainTask.id);
    store.startTask(mainTask.id);
    expect(store.claimTask(runtime.id)?.id).toBe(sideTask.id);
  });

  it("rejects same-agent child tasks through the session-task API", async () => {
    const { store, leader, issue, main, side, sideTask } = sideSessionFixture();
    const token = await store.createTaskAccessToken(sideTask, "local");
    const app = createMultiremiApp({ store, authToken: "test-root-token" });
    for (const targetSession of [side, main]) {
      const response = await app.request(`/api/issues/${issue.id}/sessions/${targetSession.id}/tasks`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: leader.id, prompt: "Start another copy of me." }),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Agent delegation is not allowed from side sessions" });
    }
    expect(store.listTasksForIssue(issue.id)).toHaveLength(1);
  });

  it("rejects native and compatibility Issue creation with dispatch before creating records", async () => {
    const { store, teammate, issue, sideTask } = sideSessionFixture();
    const token = await store.createTaskAccessToken(sideTask, "local");
    const app = createMultiremiApp({ store, authToken: "test-root-token" });
    const issueIds = store.listIssues({ workspaceId: "local" }).map((item) => item.id);
    const requests = [
      { path: "/api/multiremi/issues", body: { title: "Native dispatch", assigneeType: "agent", assigneeId: teammate.id } },
      { path: "/api/multiremi/issues", body: { title: "Native agent alias", agentId: teammate.id } },
      { path: "/api/issues", body: { title: "Compatibility dispatch", assignee_type: "agent", assignee_id: teammate.id } },
      { path: "/api/multiremi/issues/quick-create", body: { prompt: "Native quick dispatch", agentId: teammate.id } },
      { path: "/api/issues/quick-create", body: { prompt: "Compatibility quick dispatch", agent_id: teammate.id } },
    ];
    for (const request of requests) {
      const response = await app.request(request.path, {
        method: "POST",
        headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(request.body),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Agent delegation is not allowed from side sessions" });
      expect(store.listIssues({ workspaceId: "local" }).map((item) => item.id)).toEqual(issueIds);
      expect(store.listTasksForIssue(issue.id).map((task) => task.id)).toEqual([sideTask.id]);
      expect(store.listTasks()).toHaveLength(1);
    }
  });

  it("rejects assign, rerun and assignment updates before mutating or cancelling work", async () => {
    const { store, leader, teammate, issue, sideTask } = sideSessionFixture();
    const runtime = store.registerRuntime({
      id: "rt_side_assignment",
      name: "Assignment runtime",
      provider: "claude",
      workspaceId: "local",
    });
    expect(store.claimTask(runtime.id)?.id).toBe(sideTask.id);
    store.startTask(sideTask.id);
    const token = await store.createTaskAccessToken(sideTask, "local");
    const app = createMultiremiApp({ store, authToken: "test-root-token" });
    const before = store.getIssue(issue.id)!;
    const requests = [
      { method: "POST", path: `/api/multiremi/issues/${issue.id}/assign`, body: { assigneeType: "agent", assigneeId: teammate.id } },
      { method: "POST", path: `/api/multiremi/issues/${issue.id}/assign`, body: { assigneeType: "agent", assigneeId: leader.id } },
      { method: "POST", path: `/api/issues/${issue.id}/rerun`, body: { agent_id: teammate.id } },
      { method: "POST", path: `/api/issues/${issue.id}/rerun`, body: { agent_id: leader.id } },
      { method: "PATCH", path: `/api/multiremi/issues/${issue.id}`, body: { assigneeType: "agent", assigneeId: teammate.id } },
      { method: "PATCH", path: `/api/issues/${issue.id}`, body: { assignee_type: "agent", assignee_id: teammate.id } },
      { method: "PUT", path: `/api/issues/${issue.id}`, body: { assignee_type: "agent", assignee_id: teammate.id } },
    ];
    for (const request of requests) {
      const response = await app.request(request.path, {
        method: request.method,
        headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(request.body),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Agent delegation is not allowed from side sessions" });
      expect(store.getIssue(issue.id)).toEqual(before);
      expect(store.getTask(sideTask.id)?.status).toBe("running");
      expect(store.listTasksForIssue(issue.id).map((task) => task.id)).toEqual([sideTask.id]);
    }
  });

  it("rejects implicit project-default dispatch before creating an Issue", async () => {
    const { store, teammate, issue, sideTask } = sideSessionFixture();
    const project = store.createProject({
      title: "Default dispatch",
      defaultAssigneeType: "agent",
      defaultAssigneeId: teammate.id,
    });
    store.updateIssue(issue.id, { projectId: project.id });
    const token = await store.createTaskAccessToken(sideTask, "local");
    const app = createMultiremiApp({ store, authToken: "test-root-token" });
    const response = await app.request("/api/issues", {
      method: "POST",
      headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Inherits project and executor" }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Agent delegation is not allowed from side sessions" });
    expect(store.listIssues({ workspaceId: "local" }).map((item) => item.id)).toEqual([issue.id]);
    expect(store.listTasks()).toHaveLength(1);
  });

  it("rejects status-only dispatch when moving assigned work out of backlog", async () => {
    const { store, issue, sideTask } = sideSessionFixture();
    store.updateIssue(issue.id, { status: "backlog" });
    const before = store.getIssue(issue.id)!;
    const token = await store.createTaskAccessToken(sideTask, "local");
    const app = createMultiremiApp({ store, authToken: "test-root-token" });
    const requests = [
      { method: "PATCH", path: `/api/multiremi/issues/${issue.id}`, body: { status: "todo" } },
      { method: "PATCH", path: `/api/issues/${issue.id}`, body: { status: "todo" } },
      { method: "PUT", path: `/api/issues/${issue.id}`, body: { status: "todo" } },
    ];
    for (const request of requests) {
      const response = await app.request(request.path, {
        method: request.method,
        headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(request.body),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Agent delegation is not allowed from side sessions" });
      expect(store.getIssue(issue.id)).toEqual(before);
      expect(store.listTasks()).toHaveLength(1);
    }
  });

  it("preserves batch updates that do not dispatch tasks", async () => {
    const { store, teammate, issue, sideTask } = sideSessionFixture();
    const token = await store.createTaskAccessToken(sideTask, "local");
    const app = createMultiremiApp({ store, authToken: "test-root-token" });
    for (const path of ["/api/multiremi/issues/batch-update", "/api/issues/batch-update"]) {
      const response = await app.request(path, {
        method: "POST",
        headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          issue_ids: [issue.id],
          updates: { assignee_type: "agent", assignee_id: teammate.id, status: "todo" },
        }),
      });
      expect(response.status).toBe(200);
      expect(store.getIssue(issue.id)).toMatchObject({ assigneeType: "agent", assigneeId: teammate.id, status: "todo" });
      expect(store.listTasks()).toHaveLength(1);
      expect(store.getTask(sideTask.id)?.status).toBe("queued");
    }
  });

  it("prevents supervisor redispatch from a side session before cancelling the target", async () => {
    const { store, leader, teammate, issue, main, sideTask } = sideSessionFixture();
    store.ensureLocalWorkspace();
    store.setAgentSupervisor(leader.id, true);
    store.updateWorkspace("local", { settings: { organizer: { mode: "act" } } });
    const target = store.createTask({
      agentId: teammate.id,
      issueId: issue.id,
      issueSessionId: main.id,
      prompt: "Keep working.",
    });
    const token = await store.createTaskAccessToken(sideTask, "local");
    const app = createMultiremiApp({ store, authToken: "test-root-token" });
    for (const prefix of ["/api/multiremi/tasks", "/api/tasks"]) {
      const response = await app.request(`${prefix}/${target.id}/redispatch`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Try to start a replacement." }),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Agent delegation is not allowed from side sessions" });
      expect(store.getTask(target.id)?.status).toBe("queued");
      expect(store.listTasksForIssue(issue.id)).toHaveLength(2);
      expect(store.listOrganizerActionsForTask(target.id)).toEqual([]);
    }
  });

  it.each(["snapshot", "follow"] as const)("allows %s discussion and human Agent requests through the API", async (inheritMode) => {
    const { store, teammate, issue, side, sideTask } = sideSessionFixture(inheritMode);
    const token = await store.createTaskAccessToken(sideTask, "local");
    const app = createMultiremiApp({ store, authToken: "test-root-token" });
    const discussion = await app.request(`/api/issues/${issue.id}/sessions/${side.id}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ body: "The tradeoff is worth discussing." }),
    });
    expect(discussion.status).toBe(201);
    expect(store.listTasksForIssue(issue.id)).toHaveLength(1);

    const humanRequest = await app.request(`/api/issues/${issue.id}/sessions/${side.id}/messages`, {
      method: "POST",
      headers: { Authorization: "Bearer test-root-token", "Content-Type": "application/json" },
      body: JSON.stringify({ body: `Please explain [@Teammate](mention://agent/${teammate.id})` }),
    });
    expect(humanRequest.status).toBe(201);
    expect(store.listTasksForIssue(issue.id)).toHaveLength(2);
    expect(store.listTasksForIssue(issue.id).find((task) => task.agentId === teammate.id))
      .toMatchObject({ issueSessionId: side.id, delegationId: null, delegatedByAgentId: null });

    const clarification = await app.request(`/api/issues/${issue.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Discussed approach" }),
    });
    expect(clarification.status).toBe(200);
    expect(store.getIssue(issue.id)?.title).toBe("Discussed approach");
    expect(store.listTasksForIssue(issue.id)).toHaveLength(2);
  });

  it("preserves same-agent retries in a side session", () => {
    const { store, issue, side, sideTask } = sideSessionFixture();
    const runtime = store.registerRuntime({
      id: "rt_side_retry",
      name: "Retry runtime",
      provider: "claude",
      workspaceId: "local",
    });
    expect(store.claimTask(runtime.id)?.id).toBe(sideTask.id);
    store.startTask(sideTask.id);
    store.failTask(sideTask.id, { error: "Runtime disconnected", failureReason: "runtime_recovery" });
    const retried = store.listTasksForIssue(issue.id).find((task) => task.parentTaskId === sideTask.id);
    expect(retried).toMatchObject({
      parentTaskId: sideTask.id,
      agentId: sideTask.agentId,
      issueSessionId: side.id,
      delegatedByAgentId: null,
    });
  });
});
