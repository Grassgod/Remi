import { createResponsibleTestIssue } from './helpers.js';
import { runTurnExecutionMutation } from "@multiremi/store/turn-execution-records.js";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "bun:test";
import type { MultiremiStore } from "@multiremi/store.js";
import { snapshotStatsForFile, createSnapshotStore, db, resetMultiremiTestEnv } from "./helpers.js";

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
  const issue = createResponsibleTestIssue(store, { title: "Workspace lease", workspaceId: "local" });
  return { runtime, firstAgent, secondAgent, issue };
}

describe("Issue Session workspace leases", () => {
  it("claims tasks from two discussion Sessions concurrently", () => {
    const store = createSnapshotStore();
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
    const store = createSnapshotStore();
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

  it("allows two workspace-holding Sessions to run concurrently", () => {
    const store = createSnapshotStore();
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
    expect(store.getTaskQueueBlocker(second.id)).toBeNull();
    expect(store.claimTask(runtime.id)?.id).toBe(second.id);
  });

  it("coalesces unread requests before a dispatched turn starts", () => {
    const store = createSnapshotStore();
    const { runtime, firstAgent, issue } = seed(store);
    const session = store.createIssueSession(issue.id, { title: "One discussion", holdsWorkspace: false });
    const first = store.createTask({
      agentId: firstAgent.id,
      issueId: issue.id,
      issueSessionId: session.id,
      priority: 10,
      prompt: "First",
    });
    const second = store.createTask({
      agentId: firstAgent.id,
      issueId: issue.id,
      issueSessionId: session.id,
      prompt: "Second",
    });

    expect(store.claimTask(runtime.id)?.id).toBe(first.id);
    expect(second.id).toBe(first.id);
    expect(store.getTask(second.id)?.status).toBe("dispatched");
    expect(store.getTaskQueueBlocker(second.id)).toBeNull();
    expect(store.claimTask(runtime.id)).toBeNull();
    expect(store.listConversationLogEntries(session.id).filter(row => row.kind === "message")
      .map(row => row.body_md)).toEqual(["First", "Second"]);
  });

  it("keeps the same Agent context in one Session serialized", () => {
    const store = createSnapshotStore();
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
      agentId: firstAgent.id,
      issueId: issue.id,
      issueSessionId: session.id,
      prompt: "Second",
    });

    expect(store.claimTask(runtime.id)?.id).toBe(first.id);
    expect(store.claimTask(runtime.id)).toBeNull();
    expect(second.id).toBe(first.id);
    expect(store.getTask(second.id)?.status).toBe("dispatched");
    expect(store.getTaskQueueBlocker(second.id)).toBeNull();
  });

  it("binds issue requests without an explicit Session to one default conversation", () => {
    const store = createSnapshotStore();
    const { runtime, firstAgent, secondAgent, issue } = seed(store);
    const first = store.createTask({
      agentId: firstAgent.id,
      issueId: issue.id,
      priority: 10,
      prompt: "Legacy A",
    });
    const second = store.createTask({
      agentId: firstAgent.id,
      issueId: issue.id,
      prompt: "Legacy B",
    });
    expect(first.issueSessionId).toBe(store.getOrCreateDefaultIssueSession(issue.id).id);
    expect(second.issueSessionId).toBe(first.issueSessionId);
    expect(second.id).toBe(first.id);
    expect(store.claimTask(runtime.id)?.id).toBe(first.id);
    expect(store.claimTask(runtime.id)).toBeNull();
    expect(store.getTask(second.id)?.status).toBe("dispatched");
  });
});

// Register hooks in this file; shared modules only load once per test process.
let reportSnapshotStats: (() => void) | undefined;
beforeAll(() => { reportSnapshotStats = snapshotStatsForFile(import.meta.path); });
afterAll(() => { reportSnapshotStats?.(); });
