import { afterEach, describe, expect, it } from "bun:test";
import type { MultiremiStore } from "@multiremi/store.js";
import type { MultiremiAgent, MultiremiIssue, MultiremiRuntime, MultiremiTask } from "@multiremi/contracts/types.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

interface DelegationFixture {
  store: MultiremiStore;
  leaderRuntime: MultiremiRuntime;
  qaRuntime: MultiremiRuntime;
  leader: MultiremiAgent;
  qa: MultiremiAgent;
  issue: MultiremiIssue;
  leaderTask: MultiremiTask;
  childTask: MultiremiTask;
}

function createDelegationFixture(): DelegationFixture {
  const store = createStore();
  const leaderRuntime = store.registerRuntime({
    id: "rt_delegation_leader",
    name: "Leader runtime",
    provider: "claude",
    workspaceId: "local",
  });
  const qaRuntime = store.registerRuntime({
    id: "rt_delegation_qa",
    name: "QA runtime",
    provider: "claude",
    workspaceId: "local",
  });
  const leader = store.createAgent({
    name: "Leader",
    provider: "claude",
    runtimeId: leaderRuntime.id,
  });
  const qa = store.createAgent({
    name: "QA",
    provider: "claude",
    runtimeId: qaRuntime.id,
  });
  const squad = store.createSquad({
    name: "Delivery Squad",
    leaderId: leader.id,
    memberIds: [qa.id],
  });
  const issue = store.createIssue({
    title: "Delegated verification",
    assigneeType: "squad",
    assigneeId: squad.id,
  });
  const leaderTask = store.createTask({
    agentId: leader.id,
    issueId: issue.id,
    prompt: "Lead the implementation.",
  });
  expect(store.claimTask(leaderRuntime.id)?.id).toBe(leaderTask.id);
  store.buildTaskSessionProjection(leaderTask.id);
  store.startTask(leaderTask.id);

  store.createIssueComment(issue.id, {
    authorType: "agent",
    authorId: leader.id,
    taskId: leaderTask.id,
    body: `Please verify the change [@QA](mention://agent/${qa.id})`,
  });
  const childTask = store.listTasksForIssue(issue.id).find((task) => task.agentId === qa.id)!;
  expect(childTask).toMatchObject({
    delegatedByAgentId: leader.id,
    status: "queued",
  });
  expect(childTask.delegationId).toBeTruthy();

  store.completeTask(leaderTask.id, {
    output: "Task completed.",
    sessionId: "leader_session_1",
    workDir: "/tmp/delegation-leader",
  });
  expect(store.claimTask(qaRuntime.id)?.id).toBe(childTask.id);
  store.buildTaskSessionProjection(childTask.id);
  store.startTask(childTask.id);

  return { store, leaderRuntime, qaRuntime, leader, qa, issue, leaderTask, childTask };
}

function delegationTasks(fixture: DelegationFixture): MultiremiTask[] {
  return fixture.store.listTasksForIssue(fixture.issue.id)
    .filter((task) => task.delegationId === fixture.childTask.delegationId);
}

describe("task-level agent delegation return", () => {
  it("allows human rich mentions but rejects unlinked agent delegation", () => {
    const store = createStore();
    const leader = store.createAgent({ name: "Leader", provider: "claude" });
    const qa = store.createAgent({ name: "QA", provider: "claude" });
    const issue = store.createIssue({ title: "Mention semantics" });

    store.createIssueComment(issue.id, {
      authorType: "member",
      body: `Human request [@QA](mention://agent/${qa.id})`,
    });
    store.createIssueComment(issue.id, {
      authorType: "agent",
      authorId: leader.id,
      body: `Unlinked agent request [@QA](mention://agent/${qa.id})`,
    });

    const tasks = store.listTasksForIssue(issue.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      agentId: qa.id,
      delegationId: null,
      delegatedByAgentId: null,
    });
  });

  it("lets only the assigned squad leader richly mention a squad teammate", () => {
    const store = createStore();
    const leader = store.createAgent({ name: "Leader", provider: "claude" });
    const qa = store.createAgent({ name: "QA", provider: "claude" });
    const outsider = store.createAgent({ name: "Outsider", provider: "claude" });
    const squad = store.createSquad({ name: "Core", leaderId: leader.id, memberIds: [qa.id] });
    const issue = store.createIssue({ title: "Leader delegation", assigneeType: "squad", assigneeId: squad.id });
    const leaderTask = store.createTask({ agentId: leader.id, issueId: issue.id, prompt: "Lead." });

    store.createIssueComment(issue.id, {
      authorType: "agent",
      authorId: leader.id,
      taskId: leaderTask.id,
      body: "I already asked @QA to verify this.",
    });
    store.createIssueComment(issue.id, {
      authorType: "agent",
      authorId: leader.id,
      taskId: leaderTask.id,
      body: `Please help [@Outsider](mention://agent/${outsider.id})`,
    });
    expect(store.listTasksForIssue(issue.id)).toHaveLength(1);

    store.createIssueComment(issue.id, {
      authorType: "agent",
      authorId: leader.id,
      taskId: leaderTask.id,
      body: `Please verify [@QA](mention://agent/${qa.id})`,
    });

    const tasks = store.listTasksForIssue(issue.id);
    expect(tasks).toHaveLength(2);
    const delegated = tasks.find((task) => task.agentId === qa.id)!;
    expect(delegated).toMatchObject({ agentId: qa.id, delegatedByAgentId: leader.id });
    expect(delegated.delegationId).toBeTruthy();
  });

  it("returns a completed child exactly once and does not bounce after the leader finishes", () => {
    const fixture = createDelegationFixture();

    fixture.store.completeTask(fixture.childTask.id, {
      output: "QA passed; verified the permission boundary.",
      sessionId: "qa_session_1",
      workDir: "/tmp/delegation-qa",
    });

    const returned = delegationTasks(fixture);
    expect(returned).toHaveLength(2);
    const leaderReturn = returned.find((task) => task.agentId === fixture.leader.id)!;
    expect(leaderReturn).toMatchObject({
      status: "queued",
      delegatedByAgentId: fixture.leader.id,
    });
    expect(leaderReturn.prompt).toContain("QA completed a task you delegated");
    expect(leaderReturn.prompt).toContain("QA passed; verified the permission boundary.");
    expect(leaderReturn.prompt).toContain("other delegated tasks that are still queued or running");
    expect(leaderReturn.prompt).toContain("one round delivery summary");
    expect(leaderReturn.prompt).not.toContain("communicate the final outcome to the user");
    expect(fixture.store.getIssue(fixture.issue.id)?.status).toBe("todo");

    expect(fixture.store.claimTask(fixture.leaderRuntime.id)?.id).toBe(leaderReturn.id);
    const projection = fixture.store.buildTaskSessionProjection(leaderReturn.id)!;
    expect(projection.jsonl).toContain(`\"task_id\":\"${fixture.childTask.id}\"`);
    fixture.store.startTask(leaderReturn.id);
    fixture.store.completeTask(leaderReturn.id, {
      output: "Reviewed QA's report and closed the task.",
      sessionId: "leader_session_2",
      workDir: "/tmp/delegation-leader",
    });

    expect(delegationTasks(fixture)).toHaveLength(2);
    expect(fixture.store.listIssueActivity(fixture.issue.id)
      .filter((activity) => activity.type === "delegation_return_triggered")).toHaveLength(1);
  });

  it("ignores a child rich mention and returns only when the child becomes terminal", () => {
    const fixture = createDelegationFixture();
    const report = fixture.store.createIssueComment(fixture.issue.id, {
      authorType: "agent",
      authorId: fixture.qa.id,
      taskId: fixture.childTask.id,
      body: `[@Leader](mention://agent/${fixture.leader.id}) QA found no blocker.`,
    });

    let returned = delegationTasks(fixture);
    expect(returned).toHaveLength(1);

    fixture.store.completeTask(fixture.childTask.id, {
      output: "QA finished successfully.",
      sessionId: "qa_session_explicit",
      workDir: "/tmp/delegation-qa",
    });

    returned = delegationTasks(fixture);
    expect(returned).toHaveLength(2);
    const leaderReturn = returned.find((task) => task.agentId === fixture.leader.id)!;
    expect(leaderReturn.prompt).toContain("QA finished successfully.");
    expect(leaderReturn.triggerCommentId).toBeNull();
    fixture.store.updateIssueComment(report.id, { body: "QA found no blocker." });
    expect(fixture.store.getTask(leaderReturn.id)?.status).toBe("queued");
    expect(fixture.store.listIssueActivity(fixture.issue.id)
      .filter((activity) => activity.type === "delegation_return_triggered")).toHaveLength(1);
  });

  it("creates a second delta return when the first leader task was dispatched before child completion", () => {
    const fixture = createDelegationFixture();
    const wakeup = fixture.store.ensureDelegationWakeup({
      sourceTaskId: fixture.childTask.id,
      requiredEventSeq: 1_000_000,
    });
    const firstReturn = wakeup.task!;
    // Issue serialization normally keeps this queued while the child runs.
    // Model an already handed-off task defensively: once a daemon can hold the
    // old prompt, a terminal report must be delivered in a second Delta.
    db!.run(
      "UPDATE multiremi_tasks SET status = 'dispatched', dispatched_at = CURRENT_TIMESTAMP WHERE id = ?",
      [firstReturn.id],
    );
    expect(fixture.store.getTask(firstReturn.id)).toMatchObject({
      status: "dispatched",
      projectionToSeq: null,
    });

    fixture.store.completeTask(fixture.childTask.id, {
      output: "Final QA report arrived after the leader prompt froze.",
      sessionId: "qa_session_late",
      workDir: "/tmp/delegation-qa",
    });

    const leaderReturns = delegationTasks(fixture).filter((task) => task.agentId === fixture.leader.id);
    expect(leaderReturns).toHaveLength(2);
    const terminalReturn = leaderReturns.find((task) => task.id !== firstReturn.id)!;
    expect(terminalReturn).toMatchObject({ status: "queued", projectionToSeq: null });
    expect(terminalReturn.prompt).toContain("Final QA report arrived after the leader prompt froze.");
  });

  it("waits for the final infrastructure retry before returning failure to the leader", () => {
    const fixture = createDelegationFixture();
    let attempt = fixture.childTask;

    for (let expectedAttempt = 1; expectedAttempt <= 3; expectedAttempt += 1) {
      fixture.store.failTask(attempt.id, {
        error: `runtime failed on attempt ${expectedAttempt}`,
        failureReason: "runtime_offline",
      });
      const returns = delegationTasks(fixture).filter((task) => task.agentId === fixture.leader.id);
      expect(returns).toHaveLength(expectedAttempt === 3 ? 1 : 0);
      if (expectedAttempt === 3) {
        expect(returns[0]?.prompt).toContain("runtime failed on attempt 3");
        break;
      }

      attempt = delegationTasks(fixture).find((task) => task.parentTaskId === attempt.id)!;
      expect(attempt).toMatchObject({
        attempt: expectedAttempt + 1,
        delegationId: fixture.childTask.delegationId,
        delegatedByAgentId: fixture.leader.id,
      });
      expect(fixture.store.claimTask(fixture.qaRuntime.id)?.id).toBe(attempt.id);
      fixture.store.buildTaskSessionProjection(attempt.id);
      fixture.store.startTask(attempt.id);
    }
  });

  it("returns cancellation but never rolls back the child terminal transition", () => {
    const fixture = createDelegationFixture();

    expect(fixture.store.cancelTask(fixture.childTask.id).status).toBe("cancelled");
    const leaderReturn = delegationTasks(fixture).find((task) => task.agentId === fixture.leader.id)!;
    expect(leaderReturn).toMatchObject({ status: "queued" });
    expect(leaderReturn.prompt).toContain("A task you delegated to QA was cancelled");
  });

  it("keeps child completion committed when the delegating agent was archived", () => {
    const fixture = createDelegationFixture();
    fixture.store.archiveAgent(fixture.leader.id);

    expect(fixture.store.completeTask(fixture.childTask.id, {
      output: "QA finished after the leader was archived.",
      sessionId: "qa_session_archived_leader",
      workDir: "/tmp/delegation-qa",
    }).status).toBe("completed");
    expect(delegationTasks(fixture).filter((task) => task.agentId === fixture.leader.id)).toHaveLength(0);
  });
});
