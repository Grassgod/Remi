// Regression coverage for MUL-253 symptom A: an Issue parked at `in_review`
// while one of its agent tasks is still live.
//
// The Issue's lifecycle status is derived from its task rows, but every
// writer used to pass the status IT knew about ("I just completed, so
// in_review") rather than re-reading the whole task set under the Issue row
// lock. Two tasks moving at once therefore raced, and whichever wrote last
// won — routinely leaving `in_review` on top of a running sibling.
//
// These tests pin the derivation itself: after every lifecycle transition,
// the Issue status must match what the surviving task rows imply.
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { MultiremiStore } from "@multiremi/store.js";

let db: Database | null = null;

function createStore(): MultiremiStore {
  db = new Database(":memory:");
  const store = new MultiremiStore(db);
  store.ensureLocalWorkspace();
  return store;
}

afterEach(() => {
  db?.close();
  db = null;
});

/** Agent + runtime + Issue, ready to hang tasks off. */
function scaffold(store: MultiremiStore, opts: { issueKind?: "intake" } = {}) {
  const runtime = store.registerRuntime({
    id: "rt_worker",
    name: "Worker box",
    provider: "claude",
    workspaceId: "local",
    // Default is 1; the sibling-task cases need two live claims at once.
    maxConcurrency: 4,
  });
  const agent = store.createAgent({
    name: "Worker",
    provider: "claude",
    workspaceId: "local",
    runtimeId: runtime.id,
  });
  const issue = store.createIssue({
    title: "Ship it",
    workspaceId: "local",
    ...(opts.issueKind ? { issueKind: opts.issueKind } : {}),
  });
  return { runtime, agent, issue };
}

function statusOf(store: MultiremiStore, issueId: string) {
  return store.getIssue(issueId)?.status;
}

/**
 * A task in its own non-workspace-holding Product Session.
 *
 * `claimNextTaskForRuntime` serializes claims per Issue unless the tasks sit
 * in different sessions and neither holds the workspace — which is exactly
 * the squad fan-out shape that produced the MUL-253 samples. Same-Issue
 * concurrency is unreachable any other way.
 */
function createSessionTask(
  store: MultiremiStore,
  agentId: string,
  issueId: string,
  prompt: string,
) {
  const session = store.createIssueSession(issueId, { title: prompt, holdsWorkspace: false });
  return store.createTask({ agentId, issueId, issueSessionId: session.id, prompt });
}

/** Claim + start one specific task, regardless of what else is queued. */
function runTask(store: MultiremiStore, runtimeId: string, taskId: string) {
  let claimed = store.claimTask(runtimeId);
  while (claimed && claimed.id !== taskId) claimed = store.claimTask(runtimeId);
  if (!claimed) throw new Error(`Could not claim task ${taskId}`);
  return store.startTask(taskId);
}

describe("Issue status derived from task terminal transitions", () => {
  it("parks the Issue in in_review when the only task completes", () => {
    const store = createStore();
    const { runtime, agent, issue } = scaffold(store);
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "do it" });

    runTask(store, runtime.id, task.id);
    expect(statusOf(store, issue.id)).toBe("in_progress");

    store.completeTask(task.id, { output: "done" });
    expect(statusOf(store, issue.id)).toBe("in_review");
  });

  it("keeps in_progress when a completing task still has a running sibling", () => {
    // This is symptom A's core shape: the terminal writer must not stamp
    // in_review over work that is still live.
    const store = createStore();
    const { runtime, agent, issue } = scaffold(store);
    const first = createSessionTask(store, agent.id, issue.id, "part 1");
    const second = createSessionTask(store, agent.id, issue.id, "part 2");

    runTask(store, runtime.id, first.id);
    runTask(store, runtime.id, second.id);

    store.completeTask(first.id, { output: "part 1 done" });
    expect(store.getTask(second.id)?.status).toBe("running");
    expect(statusOf(store, issue.id)).toBe("in_progress");

    store.completeTask(second.id, { output: "part 2 done" });
    expect(statusOf(store, issue.id)).toBe("in_review");
  });

  it("prefers in_review when a sibling is blocked on a human", () => {
    const store = createStore();
    const { runtime, agent, issue } = scaffold(store);
    const asking = createSessionTask(store, agent.id, issue.id, "ask");
    const working = createSessionTask(store, agent.id, issue.id, "work");

    runTask(store, runtime.id, asking.id);
    runTask(store, runtime.id, working.id);
    store.createTaskHumanRequest({ taskId: asking.id, kind: "question", payload: { text: "which?" } });

    // awaiting_human outranks the running sibling — the human is the blocker.
    expect(statusOf(store, issue.id)).toBe("in_review");

    store.completeTask(working.id, { output: "done" });
    expect(statusOf(store, issue.id)).toBe("in_review");
  });

  it("falls back to todo when the only survivor is still queued", () => {
    const store = createStore();
    const { runtime, agent, issue } = scaffold(store);
    const first = createSessionTask(store, agent.id, issue.id, "part 1");
    createSessionTask(store, agent.id, issue.id, "part 2");

    runTask(store, runtime.id, first.id);
    store.completeTask(first.id, { output: "done" });

    expect(statusOf(store, issue.id)).toBe("todo");
  });

  it("blocks the Issue when the last task fails", () => {
    const store = createStore();
    const { runtime, agent, issue } = scaffold(store);
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "do it" });

    runTask(store, runtime.id, task.id);
    store.failTask(task.id, { error: "boom" });

    expect(statusOf(store, issue.id)).toBe("blocked");
  });

  it("does not block the Issue when a failing task leaves a running sibling", () => {
    const store = createStore();
    const { runtime, agent, issue } = scaffold(store);
    const failing = createSessionTask(store, agent.id, issue.id, "fragile");
    const surviving = createSessionTask(store, agent.id, issue.id, "solid");

    runTask(store, runtime.id, failing.id);
    runTask(store, runtime.id, surviving.id);
    store.failTask(failing.id, { error: "boom" });

    expect(statusOf(store, issue.id)).toBe("in_progress");
  });

  it("returns the Issue to todo when the last task is cancelled", () => {
    const store = createStore();
    const { runtime, agent, issue } = scaffold(store);
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "do it" });

    runTask(store, runtime.id, task.id);
    store.cancelTask(task.id);

    expect(statusOf(store, issue.id)).toBe("todo");
  });

  it("blocks an intake Issue whose triage task fails", () => {
    const store = createStore();
    const { runtime, agent, issue } = scaffold(store, { issueKind: "intake" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "triage" });

    runTask(store, runtime.id, task.id);
    store.failTask(task.id, { error: "cannot parse" });

    expect(statusOf(store, issue.id)).toBe("blocked");
  });

  it("closes an intake Issue that produced generated issues", () => {
    const store = createStore();
    const { runtime, agent, issue } = scaffold(store, { issueKind: "intake" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "triage" });

    runTask(store, runtime.id, task.id);
    store.createIssue({ title: "Generated child", workspaceId: "local", sourceIssueId: issue.id });
    store.completeTask(task.id, { output: "split into 1" });

    expect(store.listGeneratedIssues(issue.id)).toHaveLength(1);
    expect(statusOf(store, issue.id)).toBe("done");
  });

  it("sends an intake Issue that produced nothing to in_review", () => {
    const store = createStore();
    const { runtime, agent, issue } = scaffold(store, { issueKind: "intake" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "triage" });

    runTask(store, runtime.id, task.id);
    store.completeTask(task.id, { output: "nothing actionable" });

    expect(store.listGeneratedIssues(issue.id)).toHaveLength(0);
    expect(statusOf(store, issue.id)).toBe("in_review");
  });

  it("leaves an accepted Issue alone — done is a human decision", () => {
    const store = createStore();
    const { runtime, agent, issue } = scaffold(store);
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "do it" });

    runTask(store, runtime.id, task.id);
    store.updateIssue(issue.id, { status: "done" });
    store.completeTask(task.id, { output: "late worker event" });

    expect(statusOf(store, issue.id)).toBe("done");
  });
});

// The Feishu issue-topic lane posts "here is what the agent did" reports.
// Those tasks carry an issueId AND a chatSessionId, and
// `syncIssueStatusFromTaskWithinTransaction` has always refused to derive
// Issue status from them. The predicates that decide WHETHER to sync did
// not share that exclusion, so one stuck report task froze the Issue at
// whatever the last real task left behind — the production shape behind
// MUL-240 and MUL-251, where a `queued` comment-triggered task sat under an
// Issue still displaying 审核中.
describe("chat-lane tasks are invisible to Issue status", () => {
  function chatTask(store: MultiremiStore, agentId: string, issueId: string) {
    const chat = store.createChatSession({
      agentId,
      issueId,
      workspaceId: "local",
      creatorId: "local",
      title: "Issue topic",
    });
    return store.createTask({
      agentId,
      issueId,
      chatSessionId: chat.id,
      prompt: "Report the result to the Feishu topic",
    });
  }

  it("does not let a live report task suppress the sync for a new real task", () => {
    const store = createStore();
    const { runtime, agent, issue } = scaffold(store);
    const work = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "round 1" });

    runTask(store, runtime.id, work.id);
    store.completeTask(work.id, { output: "round 1 done" });
    expect(statusOf(store, issue.id)).toBe("in_review");

    // The report task is claimed and sits in the chat lane.
    const report = chatTask(store, agent.id, issue.id);
    runTask(store, runtime.id, report.id);
    expect(store.getTask(report.id)?.status).toBe("running");
    expect(statusOf(store, issue.id)).toBe("in_review");

    // A human comments; a fresh issue-lane task is queued. The Issue must
    // leave 审核中 — the report task is not work in review.
    store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "round 2" });
    expect(statusOf(store, issue.id)).toBe("todo");
  });

  it("keeps a report task out of the terminal derivation", () => {
    const store = createStore();
    const { runtime, agent, issue } = scaffold(store);
    const work = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "round 1" });

    runTask(store, runtime.id, work.id);
    chatTask(store, agent.id, issue.id);
    store.completeTask(work.id, { output: "done" });

    // Counting the queued report task would derive `todo` and skip review.
    expect(statusOf(store, issue.id)).toBe("in_review");
  });

  it("still blocks the Issue on failure when only a report task remains", () => {
    const store = createStore();
    const { runtime, agent, issue } = scaffold(store);
    const work = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "round 1" });

    runTask(store, runtime.id, work.id);
    chatTask(store, agent.id, issue.id);
    store.failTask(work.id, { error: "boom" });

    expect(statusOf(store, issue.id)).toBe("blocked");
  });

  it("does not move the Issue when a report task itself completes", () => {
    const store = createStore();
    const { runtime, agent, issue } = scaffold(store);
    const work = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "round 1" });

    runTask(store, runtime.id, work.id);
    store.completeTask(work.id, { output: "done" });

    const report = chatTask(store, agent.id, issue.id);
    runTask(store, runtime.id, report.id);
    store.completeTask(report.id, { output: "posted" });

    expect(statusOf(store, issue.id)).toBe("in_review");
  });
});

describe("awaiting_human round trip", () => {
  it("moves to in_review on the question and back to in_progress on the answer", () => {
    const store = createStore();
    const { runtime, agent, issue } = scaffold(store);
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "do it" });

    runTask(store, runtime.id, task.id);
    expect(statusOf(store, issue.id)).toBe("in_progress");

    const request = store.createTaskHumanRequest({
      taskId: task.id,
      kind: "question",
      payload: { text: "which branch?" },
    });
    expect(store.getTask(task.id)?.status).toBe("awaiting_human");
    expect(statusOf(store, issue.id)).toBe("in_review");

    store.respondTaskHumanRequest(request.id, { response: { text: "main" } });
    expect(store.getTask(task.id)?.status).toBe("running");
    expect(statusOf(store, issue.id)).toBe("in_progress");
  });

  it("stays in_review while a second question is still pending on the same task", () => {
    const store = createStore();
    const { runtime, agent, issue } = scaffold(store);
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "do it" });

    runTask(store, runtime.id, task.id);
    const first = store.createTaskHumanRequest({ taskId: task.id, kind: "question", payload: {} });
    store.createTaskHumanRequest({ taskId: task.id, kind: "permission", payload: {} });

    store.respondTaskHumanRequest(first.id, { response: { text: "ok" } });

    expect(store.getTask(task.id)?.status).toBe("awaiting_human");
    expect(statusOf(store, issue.id)).toBe("in_review");
  });

  it("stays in_review when a sibling task is still blocked on a human", () => {
    // The resume path used to write in_progress unconditionally, hiding a
    // sibling that was still waiting on the human.
    const store = createStore();
    const { runtime, agent, issue } = scaffold(store);
    const answered = createSessionTask(store, agent.id, issue.id, "task A");
    const stillAsking = createSessionTask(store, agent.id, issue.id, "task B");

    runTask(store, runtime.id, answered.id);
    runTask(store, runtime.id, stillAsking.id);
    const requestA = store.createTaskHumanRequest({ taskId: answered.id, kind: "question", payload: {} });
    store.createTaskHumanRequest({ taskId: stillAsking.id, kind: "question", payload: {} });

    store.respondTaskHumanRequest(requestA.id, { response: { text: "go" } });

    expect(store.getTask(answered.id)?.status).toBe("running");
    expect(store.getTask(stillAsking.id)?.status).toBe("awaiting_human");
    expect(statusOf(store, issue.id)).toBe("in_review");
  });

  it("resumes the task and the Issue when the request times out", () => {
    const store = createStore();
    const { runtime, agent, issue } = scaffold(store);
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "do it" });

    runTask(store, runtime.id, task.id);
    const request = store.createTaskHumanRequest({ taskId: task.id, kind: "permission", payload: {} });
    expect(statusOf(store, issue.id)).toBe("in_review");

    store.expireTaskHumanRequest(request.id, "timeout");

    expect(store.getTask(task.id)?.status).toBe("running");
    expect(statusOf(store, issue.id)).toBe("in_progress");
  });

  it("answering a question does not resurrect an Issue the human already accepted", () => {
    const store = createStore();
    const { runtime, agent, issue } = scaffold(store);
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "do it" });

    runTask(store, runtime.id, task.id);
    const request = store.createTaskHumanRequest({ taskId: task.id, kind: "question", payload: {} });
    store.updateIssue(issue.id, { status: "done" });

    store.respondTaskHumanRequest(request.id, { response: { text: "main" } });

    expect(store.getTask(task.id)?.status).toBe("running");
    expect(statusOf(store, issue.id)).toBe("done");
  });
});
