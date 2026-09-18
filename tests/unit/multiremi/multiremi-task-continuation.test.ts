import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function fixture() {
  const store = createStore();
  store.ensureLocalWorkspace();
  store.createWorkspaceMember({ id: "leader_user", userId: "leader_user", name: "Leader owner", role: "member" });
  store.createWorkspaceMember({ id: "other_user", userId: "other_user", name: "Other owner", role: "member" });
  const leader = store.createAgent({ name: "Leader", provider: "claude", ownerId: "leader_user" });
  const otherLeader = store.createAgent({ name: "Other leader", provider: "claude", ownerId: "other_user" });
  const worker = store.createAgent({ name: "Worker", provider: "claude", visibility: "workspace" });
  const otherWorker = store.createAgent({ name: "Other worker", provider: "claude", visibility: "workspace" });
  const privateWorker = store.createAgent({
    name: "Private worker",
    provider: "claude",
    ownerId: "other_user",
    visibility: "private",
  });
  const squad = store.createSquad({ name: "Delivery", leaderId: leader.id, memberIds: [worker.id, otherWorker.id] });
  const issue = store.createIssue({ title: "Continue delegated work", assigneeType: "squad", assigneeId: squad.id });
  const session = store.getOrCreateDefaultIssueSession(issue.id);
  const leaderTask = store.createTask({
    agentId: leader.id,
    issueId: issue.id,
    issueSessionId: session.id,
    prompt: "Coordinate.",
  });
  const delegated = store.createTask({
    agentId: worker.id,
    issueId: issue.id,
    issueSessionId: session.id,
    prompt: "Implement.",
    delegationId: "dlg_continue",
    delegatedByAgentId: leader.id,
    parentTaskId: leaderTask.id,
  });
  const app = createMultiremiApp({ store, authToken: "root-secret" });
  return { store, app, leader, otherLeader, worker, otherWorker, privateWorker, squad, issue, session, leaderTask, delegated };
}

async function taskHeaders(f: ReturnType<typeof fixture>, task = f.leaderTask, owner = "leader_user") {
  const credential = await f.store.createTaskAccessToken(task, owner);
  return { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" };
}

function completeInitialDelegation(f: ReturnType<typeof fixture>) {
  const runtime = f.store.registerRuntime({
    id: "rt_task_continuation",
    name: "Task continuation",
    provider: "claude",
    maxConcurrency: 6,
    metadata: { parallel_agent_execution: 1, cli_version: "0.2.66" },
  });
  const now = new Date().toISOString();
  db!.run(
    "UPDATE multiremi_tasks SET status = 'running', runtime_id = ?, dispatched_at = ?, started_at = ? WHERE id = ?",
    [runtime.id, now, now, f.leaderTask.id],
  );
  db!.run(
    "UPDATE multiremi_tasks SET status = 'dispatched', runtime_id = ?, dispatched_at = ? WHERE id = ?",
    [runtime.id, now, f.delegated.id],
  );
  f.store.buildTaskSessionProjection(f.delegated.id);
  f.store.startTask(f.delegated.id);
  f.store.completeTask(f.delegated.id, {
    output: "Initial delegated round complete.",
    sessionId: "provider_continuation",
    workDir: "/tmp/task-continuation",
  });
  return runtime;
}

async function createContinuation(f: ReturnType<typeof fixture>, prompt: string) {
  const response = await f.app.request("/api/multiremi/tasks", {
    method: "POST",
    headers: await taskHeaders(f),
    body: JSON.stringify({
      agentId: f.worker.id,
      prompt,
      continueTaskId: f.delegated.id,
    }),
  });
  expect(response.status).toBe(201);
  const body = await response.json() as { task: { id: string; continuedFromTaskId: string; continued_from_task_id: string } };
  return { response: body, task: f.store.getTask(body.task.id)! };
}

describe("delegated task continuation API", () => {
  it("creates a distinct task while deriving the existing delegation lineage", async () => {
    const f = fixture();
    const response = await f.app.request("/api/multiremi/tasks", {
      method: "POST",
      headers: await taskHeaders(f),
      body: JSON.stringify({
        agentId: f.worker.id,
        prompt: "Address the review feedback.",
        continue_task_id: f.delegated.id,
        continuedFromTaskId: "tsk_forged",
        delegationId: "dlg_forged",
        delegatedByAgentId: f.otherLeader.id,
        parentTaskId: f.delegated.id,
      }),
    });

    expect(response.status).toBe(201);
    const responseTask = ((await response.json()) as {
      task: { id: string; continuedFromTaskId: string; continued_from_task_id: string };
    }).task;
    const createdId = responseTask.id;
    expect(createdId).not.toBe(f.delegated.id);
    expect(responseTask.continuedFromTaskId).toBe(f.delegated.id);
    expect(responseTask.continued_from_task_id).toBe(f.delegated.id);
    expect(f.store.getTask(createdId)).toMatchObject({
      agentId: f.worker.id,
      issueId: f.issue.id,
      issueSessionId: f.session.id,
      parentTaskId: f.leaderTask.id,
      continuedFromTaskId: f.delegated.id,
      delegationId: f.delegated.delegationId,
      delegatedByAgentId: f.leader.id,
      prompt: "Address the review feedback.",
    });
  });

  it("keeps an independent rich mention out of a queued continuation lane", async () => {
    const f = fixture();
    completeInitialDelegation(f);
    const continued = await createContinuation(f, "Fix the review feedback.");

    const comment = f.store.createIssueComment(f.issue.id, {
      issueSessionId: f.session.id,
      authorType: "agent",
      authorId: f.leader.id,
      taskId: f.leaderTask.id,
      body: `Independently investigate this [@Worker](mention://agent/${f.worker.id}).`,
    });

    const workerTasks = f.store.listTasksForIssue(f.issue.id).filter((task) => task.agentId === f.worker.id);
    expect(workerTasks).toHaveLength(3);
    const mentioned = workerTasks.find((task) => task.triggerCommentId === comment.id)!;
    expect(mentioned).toMatchObject({ continuedFromTaskId: null, status: "queued", sessionId: null });
    expect(mentioned.delegationId).toBeTruthy();
    expect(mentioned.delegationId).not.toBe(f.delegated.delegationId);
    expect(continued.task).toMatchObject({
      continuedFromTaskId: f.delegated.id,
      delegationId: f.delegated.delegationId,
    });
    expect(f.store.getSessionAgentLane(f.session.id, f.worker.id, mentioned.delegationId!)).not.toBeNull();
    expect(f.store.getSessionAgentLane(f.session.id, f.worker.id, f.delegated.delegationId!)).not.toBeNull();
    expect(f.store.listIssueActivity(f.issue.id).filter((activity) =>
      activity.type === "comment_mention_coalesced"
      && (activity.data as { commentId?: string } | null)?.commentId === comment.id)).toHaveLength(0);
  });

  it("keeps a queued independent mention alongside a later continuation", async () => {
    const f = fixture();
    completeInitialDelegation(f);
    const comment = f.store.createIssueComment(f.issue.id, {
      issueSessionId: f.session.id,
      authorType: "agent",
      authorId: f.leader.id,
      taskId: f.leaderTask.id,
      body: `Independently inspect this [@Worker](mention://agent/${f.worker.id}).`,
    });
    const mentioned = f.store.listTasksForIssue(f.issue.id)
      .find((task) => task.agentId === f.worker.id && task.triggerCommentId === comment.id)!;

    const continued = await createContinuation(f, "Continue the original implementation.");

    const queued = f.store.listTasksForIssue(f.issue.id)
      .filter((task) => task.agentId === f.worker.id && task.status === "queued");
    expect(queued.map((task) => task.id).sort()).toEqual([mentioned.id, continued.task.id].sort());
    expect(mentioned).toMatchObject({ continuedFromTaskId: null, sessionId: null });
    expect(continued.task).toMatchObject({
      continuedFromTaskId: f.delegated.id,
    });
    expect(mentioned.delegationId).not.toBe(continued.task.delegationId);
    expect(f.store.getSessionAgentLane(f.session.id, f.worker.id, mentioned.delegationId!)).not.toBeNull();
    expect(f.store.getSessionAgentLane(f.session.id, f.worker.id, continued.task.delegationId!)).not.toBeNull();
  });

  it("preserves continuation lineage on an infrastructure retry", async () => {
    const f = fixture();
    const runtime = completeInitialDelegation(f);
    const continued = await createContinuation(f, "Continue and retry if the runtime drops.");
    expect(f.store.claimTask(runtime.id)?.id).toBe(continued.task.id);
    f.store.startTask(continued.task.id);
    f.store.failTask(continued.task.id, { error: "offline", failureReason: "runtime_offline" });

    const retry = f.store.listTasks().find((task) => task.parentTaskId === continued.task.id && task.attempt === 2)!;
    expect(retry).toMatchObject({
      continuedFromTaskId: f.delegated.id,
      delegationId: f.delegated.delegationId,
      delegatedByAgentId: f.leader.id,
    });
  });

  // The API-level cases above stop at lineage derivation, and the store-level
  // lane tests start from a delegation ID they set themselves. Neither alone
  // protects the wiring in between, so cover the whole chain once: a real claim
  // freezes the execution fingerprint and runtime snapshot, and skipping it (by
  // forcing `dispatched` in SQL, as the other fixtures do) makes the lane look
  // resume-unsafe and cold-boots back to bootstrap for reasons unrelated to the
  // continuation entry point.
  it("resumes the original provider session when an API continuation is claimed", async () => {
    const f = fixture();
    const runtime = f.store.registerRuntime({
      id: "rt_continuation_e2e",
      name: "Continuation end to end",
      provider: "claude",
      maxConcurrency: 6,
      metadata: { parallel_agent_execution: 1, cli_version: "0.2.66" },
    });
    // The Leader turn and its delegation are both queued here; the scheduler may
    // hand back either one first. Only the delegated task's lane matters, so
    // drain both rather than pinning an order this test does not own.
    // The Leader turn and its delegation are both queued here, and a child is
    // only claimable once its parent is running, so claim and start one at a
    // time instead of pinning an order this test does not own.
    const claimed: string[] = [];
    for (let turn = 0; turn < 2; turn += 1) {
      const task = f.store.claimTask(runtime.id);
      if (!task) break;
      claimed.push(task.id);
      const projection = f.store.buildTaskSessionProjection(task.id);
      if (task.id === f.delegated.id) expect(projection?.mode).toBe("bootstrap");
      f.store.startTask(task.id);
    }
    expect(claimed).toContain(f.delegated.id);
    f.store.completeTask(f.delegated.id, {
      output: "First round done.",
      sessionId: "provider_continuation_e2e",
      workDir: "/tmp/continuation-e2e",
    });

    const continued = await createContinuation(f, "Continue the same work.");
    expect(f.store.claimTask(runtime.id)?.id).toBe(continued.task.id);
    expect(f.store.getTask(continued.task.id)).toMatchObject({
      sessionId: "provider_continuation_e2e",
      workDir: "/tmp/continuation-e2e",
      delegationId: f.delegated.delegationId,
      continuedFromTaskId: f.delegated.id,
    });
    expect(f.store.buildTaskSessionProjection(continued.task.id)?.mode).toBe("delta");
    expect(f.store.getSessionAgentLane(f.session.id, f.worker.id, f.delegated.delegationId!)?.providerSessionId)
      .toBe("provider_continuation_e2e");
  });

  it("rejects missing, cross-context, mismatched and unauthorized continuation targets", async () => {
    const f = fixture();
    const headers = await taskHeaders(f);
    const request = (body: Record<string, unknown>, overrideHeaders = headers) => f.app.request("/api/multiremi/tasks", {
      method: "POST",
      headers: overrideHeaders,
      body: JSON.stringify({ agentId: f.worker.id, prompt: "Continue.", ...body }),
    });
    const expectError = async (response: Response, status: number, message: string) => {
      expect(response.status).toBe(status);
      expect(((await response.json()) as { error: string }).error).toContain(message);
    };

    await expectError(await request({ continueTaskId: "tsk_missing" }), 404, "continued task not found");
    await expectError(await request({ continueTaskId: f.delegated.id, agentId: f.otherWorker.id }), 400, "target agent");

    const direct = f.store.createTask({
      agentId: f.worker.id,
      issueId: f.issue.id,
      issueSessionId: f.session.id,
      prompt: "Direct.",
    });
    await expectError(await request({ continueTaskId: direct.id }), 400, "not a delegated task");

    const wrongDelegator = f.store.createTask({
      agentId: f.worker.id,
      issueId: f.issue.id,
      issueSessionId: f.session.id,
      prompt: "Other lineage.",
      delegationId: "dlg_other_leader",
      delegatedByAgentId: f.otherLeader.id,
    });
    await expectError(await request({ continueTaskId: wrongDelegator.id }), 403, "another agent");

    const sibling = f.store.createIssueSession(f.issue.id, { title: "Sibling main Session" });
    const siblingLeaderTask = f.store.createTask({
      agentId: f.leader.id,
      issueId: f.issue.id,
      issueSessionId: sibling.id,
      prompt: "Coordinate sibling.",
    });
    const siblingHeaders = await taskHeaders(f, siblingLeaderTask);
    await expectError(await request({ continueTaskId: f.delegated.id }, siblingHeaders), 400, "another Issue Session");
    await expectError(await request({ continueTaskId: f.delegated.id, issueSessionId: sibling.id }), 400, "requested Issue Session");

    const privateDelegation = f.store.createTask({
      agentId: f.privateWorker.id,
      issueId: f.issue.id,
      issueSessionId: f.session.id,
      prompt: "Private.",
      delegationId: "dlg_private",
      delegatedByAgentId: f.leader.id,
    });
    await expectError(await request({
      continueTaskId: privateDelegation.id,
      agentId: f.privateWorker.id,
    }), 403, "do not have access");

    const remoteWorkspace = f.store.createWorkspace({ id: "ws_remote", name: "Remote", slug: "remote" });
    const remoteLeader = f.store.createAgent({
      name: "Remote leader",
      provider: "claude",
      workspaceId: remoteWorkspace.id,
    });
    const remoteWorker = f.store.createAgent({
      name: "Remote worker",
      provider: "claude",
      workspaceId: remoteWorkspace.id,
    });
    const remoteIssue = f.store.createIssue({ title: "Remote issue", workspaceId: remoteWorkspace.id });
    const remoteDelegation = f.store.createTask({
      agentId: remoteWorker.id,
      issueId: remoteIssue.id,
      prompt: "Remote delegated work.",
      delegationId: "dlg_remote",
      delegatedByAgentId: remoteLeader.id,
    });
    await expectError(await request({
      continueTaskId: remoteDelegation.id,
      agentId: remoteWorker.id,
    }), 403, "another workspace");

    await expectError(await request(
      { continueTaskId: f.delegated.id },
      { Authorization: "Bearer root-secret", "Content-Type": "application/json" },
    ), 403, "requires a task credential");
  });
});
