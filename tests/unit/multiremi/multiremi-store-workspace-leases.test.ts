import { afterEach, describe, expect, it } from "bun:test";
import type { MultiremiStore } from "@multiremi/store.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function seed(store: MultiremiStore) {
  const runtime = store.registerRuntime({
    id: "rt_workspace_leases",
    name: "Workspace lease runtime",
    provider: "claude",
    workspaceId: "local",
    maxConcurrency: 10,
  });
  const firstAgent = store.createAgent({
    name: "First",
    provider: "claude",
    maxConcurrentTasks: 10,
  });
  const secondAgent = store.createAgent({
    name: "Second",
    provider: "claude",
    maxConcurrentTasks: 10,
  });
  const issue = store.createIssue({ title: "Workspace lease", workspaceId: "local" });
  return { runtime, firstAgent, secondAgent, issue };
}

describe("Issue Session workspace leases", () => {
  it("claims tasks from two discussion Sessions concurrently", () => {
    const store = createStore();
    const { runtime, firstAgent, secondAgent, issue } = seed(store);
    const firstSession = store.createIssueSession(issue.id, { title: "Discussion A", holdsWorkspace: false });
    const secondSession = store.createIssueSession(issue.id, { title: "Discussion B", holdsWorkspace: false });
    const first = store.createTask({
      agentId: firstAgent.id,
      issueId: issue.id,
      issueSessionId: firstSession.id,
      priority: 10,
      prompt: "Discuss A",
    });
    const second = store.createTask({
      agentId: secondAgent.id,
      issueId: issue.id,
      issueSessionId: secondSession.id,
      prompt: "Discuss B",
    });

    expect(first.holdsWorkspace).toBe(false);
    expect(second.holdsWorkspace).toBe(false);
    expect(store.claimTask(runtime.id)?.id).toBe(first.id);
    expect(store.claimTask(runtime.id)?.id).toBe(second.id);
  });

  it("claims a workspace Task and a discussion Task concurrently", () => {
    const store = createStore();
    const { runtime, firstAgent, secondAgent, issue } = seed(store);
    const workSession = store.createIssueSession(issue.id, { title: "Work" });
    const discussionSession = store.createIssueSession(issue.id, { title: "Discussion", holds_workspace: false });
    const work = store.createTask({
      agentId: firstAgent.id,
      issueId: issue.id,
      issueSessionId: workSession.id,
      priority: 10,
      prompt: "Implement",
    });
    const discussion = store.createTask({
      agentId: secondAgent.id,
      issueId: issue.id,
      issueSessionId: discussionSession.id,
      prompt: "Discuss",
    });

    expect(work.holdsWorkspace).toBe(true);
    expect(discussion.holdsWorkspace).toBe(false);
    expect(store.claimTask(runtime.id)?.id).toBe(work.id);
    expect(store.claimTask(runtime.id)?.id).toBe(discussion.id);
  });

  it("keeps two workspace-holding Sessions serialized", () => {
    const store = createStore();
    const { runtime, firstAgent, secondAgent, issue } = seed(store);
    const firstSession = store.createIssueSession(issue.id, { title: "Work A" });
    const secondSession = store.createIssueSession(issue.id, { title: "Work B" });
    const first = store.createTask({
      agentId: firstAgent.id,
      issueId: issue.id,
      issueSessionId: firstSession.id,
      priority: 10,
      prompt: "Implement A",
    });
    const second = store.createTask({
      agentId: secondAgent.id,
      issueId: issue.id,
      issueSessionId: secondSession.id,
      prompt: "Implement B",
    });

    expect(store.claimTask(runtime.id)?.id).toBe(first.id);
    expect(store.claimTask(runtime.id)).toBeNull();
    expect(store.getTask(second.id)?.status).toBe("queued");
    expect(store.getTaskQueueBlocker(second.id)).toMatchObject({
      taskId: first.id,
      agentId: firstAgent.id,
      agentName: "First",
      issueSessionId: firstSession.id,
      issueSessionTitle: "Work A",
      reason: "issue_workspace",
    });
  });

  it("keeps every Task in the same Session serialized", () => {
    const store = createStore();
    const { runtime, firstAgent, secondAgent, issue } = seed(store);
    const session = store.createIssueSession(issue.id, { title: "One discussion", holdsWorkspace: false });
    const first = store.createTask({
      agentId: firstAgent.id,
      issueId: issue.id,
      issueSessionId: session.id,
      priority: 10,
      prompt: "First",
    });
    const second = store.createTask({
      agentId: secondAgent.id,
      issueId: issue.id,
      issueSessionId: session.id,
      prompt: "Second",
    });

    expect(store.claimTask(runtime.id)?.id).toBe(first.id);
    expect(store.claimTask(runtime.id)).toBeNull();
    expect(store.getTask(second.id)?.status).toBe("queued");
    expect(store.getTaskQueueBlocker(second.id)).toMatchObject({
      taskId: first.id,
      issueSessionId: session.id,
      issueSessionTitle: "One discussion",
      reason: "session",
    });
  });

  it("keeps historical Issue Tasks without a Session serialized by Issue", () => {
    const store = createStore();
    const { runtime, firstAgent, secondAgent, issue } = seed(store);
    const first = store.createTask({
      agentId: firstAgent.id,
      issueId: issue.id,
      priority: 10,
      prompt: "Legacy A",
    });
    const second = store.createTask({
      agentId: secondAgent.id,
      issueId: issue.id,
      prompt: "Legacy B",
    });
    db!.run("UPDATE multiremi_tasks SET issue_session_id = NULL WHERE id IN (?, ?)", [first.id, second.id]);

    expect(store.claimTask(runtime.id)?.id).toBe(first.id);
    expect(store.claimTask(runtime.id)).toBeNull();
    expect(store.getTask(second.id)?.status).toBe("queued");
  });
});
