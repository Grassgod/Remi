import { createResponsibleTestIssue, acceptTestIssueDelivery } from './helpers.js';
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";
import { attemptMessagesPath } from "./unified-test-paths.js";
import { afterEach, describe, expect, it } from "bun:test";
import { MultiremiStore } from "@multiremi/store.js";
import type { MultiremiTask, CreateTaskHumanRequestInput } from "@multiremi/contracts/types.js";
import { createMultiremiApp } from "@multiremi/api.js";
import { createLocalStore as createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function createRunningTask(store: MultiremiStore): MultiremiTask {
  const agent = store.createAgent({ name: "HR Agent", provider: "claude" });
  const chat = store.createChatSession({ agentId: agent.id, creatorId: "local" });
  const task = store.createTask({ agentId: agent.id, chatSessionId: chat.id, prompt: "test" });
  store.registerRuntime({ id: "rt_test", daemonId: "human-request-test", name: "test-runtime", provider: "claude", workspaceId: "local", ownerId: "local" });
  const claimed = store.claimTask("rt_test");
  expect(claimed?.id).toBe(task.id);
  return store.startTask(task.id);
}


let requestSequence = 0;
function nativeHumanRequest(store: MultiremiStore, input: CreateTaskHumanRequestInput) {
  const task = store.getTask(input.taskId)!;
  const runtime = store.getRuntime(task.runtimeId!)!;
  const turn = store.getTurnForAttempt(task.id)!;
  const id = `human-request-fixture-${++requestSequence}`;
  const result = store.getDaemonTurnBridge().rpc('turn.decision', {
    turn_id: turn.id, attempt_id: task.id, wait_id: id, dedupe_key: id,
    body_md: String(input.payload?.title ?? 'Original native human request'), options: [],
    metadata: { ...input.payload, kind: input.kind },
  }, { runtimeId: runtime.id, daemonId: runtime.daemonId!, workspaceId: task.workspaceId });
  expect(result.ok).toBe(true);
  return store.getTaskHumanRequest(String(result.message_id))!;
}
function answerHumanRequest(store: MultiremiStore, id: string,
  input: { response: Record<string, unknown>; respondedBy?: string }) {
  const question = store.getQuestion(id)!;
  return store.respondTaskHumanRequest(id, { ...input,
    respondedBy: input.respondedBy ?? question.current_handler!.id,
    expectedRouteRevision: question.route_revision });
}

describe("task human requests (store)", () => {
  it("keeps an issue in sync through queue, work, review, resume, and acceptance", () => {
    const store = createStore();
    const runtime = store.registerRuntime({
      id: "rt_issue_flow", daemonId: "human-request-issue",
      name: "issue-flow-runtime",
      provider: "claude",
      workspaceId: "local",
      ownerId: "local",
    });
    const agent = store.createAgent({ name: "Issue Flow Agent", provider: "claude" });
    const issue = createResponsibleTestIssue(store, { title: "Verify task-driven issue states", assigneeType:"agent", assigneeId:agent.id, status: "in_review" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Implement it" });

    expect(store.getIssue(issue.id)?.status).toBe("todo");
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    expect(store.getIssue(issue.id)?.status).toBe("todo");

    store.startTask(task.id);
    expect(store.getIssue(issue.id)?.status).toBe("in_progress");

    const request = nativeHumanRequest(store, {
      taskId: task.id,
      kind: "permission",
      payload: { title: "Approve changes", options: [{ optionId: 'approve', name: 'Approve', kind: 'allow_once' }] },
    });
    expect(store.getIssue(issue.id)?.status).toBe("in_review");

    answerHumanRequest(store, request.id, {
      response: { option_id: "approve" },
      respondedBy: store.resolveIssueResponsibility(issue.id).rootHuman!.id,
    });
    expect(store.getIssue(issue.id)?.status).toBe("in_progress");

    store.buildTaskSessionProjection(task.id);
    store.completeTask(task.id, { output: "Ready for acceptance" });
    expect(store.getIssue(issue.id)?.status).toBe("in_review");

    acceptTestIssueDelivery(store, issue.id);
    expect(store.getIssue(issue.id)?.status).toBe("done");
  });

  it("create parks the task; respond resumes it first-write-wins", () => {
    const store = createStore();
    const task = createRunningTask(store);

    const request = nativeHumanRequest(store, { taskId: task.id, kind: "permission", payload: {
      options: [{ optionId: 'a', name: 'A', kind: 'allow_once' }, { optionId: 'b', name: 'B', kind: 'reject_once' }],
    } });
    expect(request.status).toBe("pending");
    expect(store.getTaskStatus(task.id)).toBe("awaiting_human");

    const responded = answerHumanRequest(store, request.id, { response: { option_id: "a" }, respondedBy: "mem_local_local" });
    expect(responded?.status).toBe("responded");
    expect(responded?.respondedBy).toBe("mem_local_local");
    expect(store.getTaskStatus(task.id)).toBe("running");

    // Losing side of the race gets null, stored response is untouched.
    expect(() => answerHumanRequest(store, request.id, { response: { option_id: "b" } })).toThrow("question_already_settled");
    expect(store.getTaskHumanRequest(request.id)?.response).toEqual({ option_id: "a" });
  });

  it("expire loses to an existing response and wins over pending", () => {
    const store = createStore();
    const task = createRunningTask(store);

    const first = nativeHumanRequest(store, { taskId: task.id, kind: "permission",
      payload: { options: [{ optionId: 'a', name: 'A', kind: 'allow_once' }] } });
    answerHumanRequest(store, first.id, { response: { option_id: "a" } });
    expect(store.expireTaskHumanRequest(first.id, "timeout")?.status).toBe("responded");
    expect(store.getQuestion(first.id)?.wait_status).toBe("waiting");
    expect(store.getTaskHumanRequest(first.id)?.status).toBe("responded");

    const second = nativeHumanRequest(store, { taskId: task.id, kind: "question", payload: {} });
    const expired = store.expireTaskHumanRequest(second.id, "timeout");
    expect(expired?.status).toBe("pending");
    expect(store.getQuestion(second.id)).toMatchObject({ status: "pending", wait_status: "detached", wait_reason: "timeout" });
    expect(store.getTaskStatus(task.id)).toBe("running");
  });

  it("keeps the task parked until every pending request settles", () => {
    const store = createStore();
    const task = createRunningTask(store);

    const a = nativeHumanRequest(store, { taskId: task.id, kind: "permission",
      payload: { options: [{ optionId: 'x', name: 'X', kind: 'allow_once' }] } });
    const b = nativeHumanRequest(store, { taskId: task.id, kind: "question", payload: { questions: [{ question: 'q' }] } });
    answerHumanRequest(store, a.id, { response: { option_id: "x" } });
    expect(store.getTaskStatus(task.id)).toBe("awaiting_human");
    answerHumanRequest(store, b.id, { response: { answers: { q: "y" } } });
    expect(store.getTaskStatus(task.id)).toBe("running");
  });

  it("an awaiting_human task can still be cancelled and completed", () => {
    const store = createStore();
    const task = createRunningTask(store);
    nativeHumanRequest(store, { taskId: task.id, kind: "permission", payload: {} });
    expect(store.getTaskStatus(task.id)).toBe("awaiting_human");
    // completeTask accepts in-flight statuses including awaiting_human — the
    // worker may finish after a timeout-expire raced with the final report.
    expect(store.completeTask(task.id, { output: "done" }).status).toBe("completed");

    const task2 = createRunningTask(store);
    nativeHumanRequest(store, { taskId: task2.id, kind: "question", payload: {} });
    expect(store.cancelTask(task2.id).status).toBe("cancelled");
  });

  it("retains the unresolved question for human review when its task fails", () => {
    const store = createStore();
    const runtime = store.registerRuntime({
      id: "rt_review_failure", daemonId: "human-request-failure",
      name: "review-failure-runtime",
      provider: "claude",
      workspaceId: "local",
      ownerId: "local",
    });
    const agent = store.createAgent({ name: "Review Failure Agent", provider: "claude" });
    const issue = createResponsibleTestIssue(store, { title: "Review failure", assigneeType:"agent", assigneeId:agent.id });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Try it" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    const request = nativeHumanRequest(store, { taskId: task.id, kind: "question", payload: {} });
    expect(store.getIssue(issue.id)?.status).toBe("in_review");

    store.failTask(task.id, { error: "approval channel closed", failureReason: "agent_error" });

    expect(store.getTaskStatus(task.id)).toBe('failed');
    expect(store.getQuestion(request.id)).toMatchObject({ status: 'pending', wait_status: 'detached' });
    expect(store.getIssue(issue.id)?.status).toBe("in_review");
  });

  it("merges pending owner inputs and cancels the shared turn", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Parallel Agent", provider: "claude" });
    const issue = createResponsibleTestIssue(store, { title: "Parallel work", assigneeType:"agent", assigneeId:agent.id });
    const first = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "First" });
    const second = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Second" });

    expect(second.id).toBe(first.id);
    store.cancelTask(first.id);
    expect(store.getTask(second.id)?.status).toBe("cancelled");
    expect(store.getIssue(issue.id)?.status).toBe("todo");

    expect(()=>store.cancelTask(second.id)).toThrow("terminal");
    expect(store.getIssue(issue.id)?.status).toBe("todo");
  });

  it("keeps issue cancellation explicit instead of inheriting task cancellation", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ name: "Cancel runtime", provider: "claude" });
    const agent = store.createAgent({ name: "Cancel Agent", provider: "claude" });
    const issue = createResponsibleTestIssue(store, { title: "Cancel execution only", assigneeType:"agent", assigneeId:agent.id });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Start" });

    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    expect(store.getIssue(issue.id)?.status).toBe("in_progress");

    store.cancelTask(task.id);
    expect(store.getIssue(issue.id)?.status).toBe("todo");

    store.updateIssue(issue.id, { status: "cancelled" });
    expect(store.getIssue(issue.id)?.status).toBe("cancelled");
  });

  it("does not reopen an explicitly terminal issue on a late task event", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ name: "Late runtime", provider: "claude" });
    const agent = store.createAgent({ name: "Late Agent", provider: "claude" });

    for (const terminalStatus of ["done", "cancelled"] as const) {
      const issue = createResponsibleTestIssue(store, { title: `Keep ${terminalStatus}`, assigneeType: "agent", assigneeId: agent.id });
      const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Run" });
      expect(store.claimTask(runtime.id)?.id).toBe(task.id);
      store.startTask(task.id);
      if (terminalStatus === "done") {
        const delivery = store.submitIssueDelivery(issue.id, { summary: 'Reviewed result from this running task' },
          { type: 'agent', id: agent.id, taskId: task.id });
        store.respondIssueDelivery(issue.id, delivery.id, { action: 'accept', revision: delivery.responsibilityRevision },
          { type: 'member', id: store.resolveIssueResponsibility(issue.id).rootHuman!.id });
      }
      else store.updateIssue(issue.id, { status: terminalStatus });
      store.completeTask(task.id, { output: "Late completion" });
      expect(store.getIssue(issue.id)?.status).toBe(terminalStatus);
    }
  });

  it("counts awaiting_human toward runtime in-flight concurrency", () => {
    const store = createStore();
    const task = createRunningTask(store);
    nativeHumanRequest(store, { taskId: task.id, kind: "permission", payload: {} });
    const runtime = store.getRuntime("rt_test")!;
    expect(runtime.activeTaskCount).toBeGreaterThanOrEqual(1);
  });

});

pendingTurnBackendTests("Human Request unified API", fixture => {
  it("guards Human Request read and response with task transcript visibility", async () => {
    const { store } = fixture();
    const aliceMember = store.createWorkspaceMember({ workspaceId: "local", userId: "alice", name: "Alice", role: "member" });
    store.createWorkspaceMember({ workspaceId: "local", userId: "bob", name: "Bob", role: "member" });
    const aliceToken = await store.createAccessToken({
      name: "Alice",
      type: "pat",
      workspaceId: "local",
      userId: "alice",
    });
    const bobToken = await store.createAccessToken({
      name: "Bob",
      type: "pat",
      workspaceId: "local",
      userId: "bob",
    });
    const runtime = store.registerRuntime({
      id: "rt_private_request", daemonId: "human-request-private",
      name: "Alice runtime",
      provider: "claude",
      workspaceId: "local",
      ownerId: "alice",
      visibility: "private",
    });
    const agent = store.createAgent({
      name: "Alice private agent",
      provider: "claude",
      ownerId: "alice",
      visibility: "private",
    });
    const chat = store.createChatSession({ agentId: agent.id, creatorId: "alice" });
    const task = store.sendChatMessage(chat.id, { content: "Ask Alice" }).task;
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    const request = nativeHumanRequest(store, {
      taskId: task.id,
      kind: "question",
      payload: { questions: [{ question: "Proceed?" }] },
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const aliceAuth = { Authorization: `Bearer ${aliceToken.token}` };
    const bobAuth = { Authorization: `Bearer ${bobToken.token}` };

    expect((await app.request(`/api/messages/${request.id}`, { headers: bobAuth })).status).toBe(403);
    expect((await app.request(attemptMessagesPath(store, task.id), {
      method: "POST",
      headers: { ...bobAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ response: { answers: { "Proceed?": "yes" } }, reply_to_id: request.id, message_kind: "reply",
        expected_route_revision: store.getQuestion(request.id)!.route_revision }),
    })).status).toBe(403);
    expect(store.getTaskHumanRequest(request.id)?.status).toBe("pending");

    const visible = await app.request(`/api/messages/${request.id}`, { headers: aliceAuth });
    expect(visible.status).toBe(200);
    expect((await visible.json()).message).toMatchObject({ id: request.id, metadata: { human_request: { status: "pending" } } });
    const responded = await app.request(attemptMessagesPath(store, task.id), {
      method: "POST",
      headers: { ...aliceAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ response: { answers: { "Proceed?": "yes" } }, reply_to_id: request.id, message_kind: "reply",
        expected_route_revision: store.getQuestion(request.id)!.route_revision }),
    });
    expect(responded.status).toBe(200);
    expect(store.getTaskHumanRequest(request.id)?.status).toBe("responded");
    expect(store.getTaskHumanRequest(request.id)?.respondedBy).toBe(aliceMember.id);
  });
});
