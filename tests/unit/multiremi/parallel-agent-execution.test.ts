import { afterEach, describe, expect, it } from "bun:test";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";
import { daemonTaskClaimResponse } from "@multiremi/api/wire/tasks.js";
import { runMigrations } from "@multiremi/store/migrations.js";

afterEach(resetMultiremiTestEnv);

function fixture() {
  const store = createStore();
  const runtime = store.registerRuntime({ id: "parallel", name: "parallel", provider: "claude", maxConcurrency: 6,
    metadata: { parallel_agent_execution: 1, cli_version: "0.2.66" } });
  const leader = store.createAgent({ name: "Leader", provider: "claude" });
  const worker = store.createAgent({ name: "Worker", provider: "claude" });
  const qa = store.createAgent({ name: "QA", provider: "claude" });
  const issue = store.createIssue({ title: "Concurrent delivery" });
  const main = store.createTask({ agentId: leader.id, issueId: issue.id, prompt: "coordinate" });
  expect(store.claimTask(runtime.id)?.id).toBe(main.id);
  store.buildTaskSessionProjection(main.id);
  store.startTask(main.id);
  const delegate = (agentId: string, delegationId: string) => store.createTask({
    agentId, issueId: issue.id, prompt: delegationId, delegationId, delegatedByAgentId: leader.id,
  });
  return { store, runtime, leader, worker, qa, issue, main, delegate };
}

describe("parallel agent execution", () => {
  it("migrates existing lane checkpoints once without losing canonical history", () => {
    const f = fixture();
    f.store.completeTask(f.main.id, { output: "historical answer", sessionId: "old_provider", workDir: "/tmp/old" });
    const session = f.main.issueSessionId!;
    const old = f.store.getSessionAgentLane(session, f.leader.id)!;
    const queued = f.store.createTask({ agentId: f.leader.id, issueId: f.issue.id, prompt: "continue" });
    expect(f.store.getTask(queued.id)?.sessionId).toBe("old_provider");
    const events = db!.query("SELECT * FROM multiremi_session_events WHERE session_id = ? ORDER BY seq").all(session);
    db!.exec(`CREATE TABLE legacy_lanes AS SELECT session_id, agent_id, provider_session_id,
      runtime_id, provider, work_dir, cursor_seq, generation, status, last_task_id,
      created_at, updated_at, execution_fingerprint FROM multiremi_session_agent_lanes;
      DROP TABLE multiremi_session_agent_lanes;
      ALTER TABLE legacy_lanes RENAME TO multiremi_session_agent_lanes;`);
    runMigrations(db!);
    expect(f.store.getSessionAgentLane(session, f.leader.id)).toMatchObject({
      generation: old.generation + 1, providerSessionId: null, workDir: null, cursorSeq: 0,
    });
    expect(db!.query("SELECT * FROM multiremi_session_events WHERE session_id = ? ORDER BY seq").all(session)).toEqual(events);
    expect(f.store.getTask(queued.id)).toMatchObject({ sessionId: null, workDir: null, projectionToSeq: null });
    const scoped = f.store.getOrCreateSessionAgentLane(session, f.leader.id, "dlg_parallel");
    runMigrations(db!);
    expect(f.store.getSessionAgentLane(session, f.leader.id)?.generation).toBe(old.generation + 1);
    expect(f.store.getSessionAgentLane(session, f.leader.id, "dlg_parallel")).toEqual(scoped);
  });

  it("keeps one task's comment from suppressing another task's final answer", () => {
    const f = fixture();
    const first = f.delegate(f.worker.id, "dlg_first");
    const second = f.delegate(f.worker.id, "dlg_second");
    f.store.claimTask(f.runtime.id);
    f.store.claimTask(f.runtime.id);
    f.store.startTask(first.id);
    f.store.startTask(second.id);
    f.store.createIssueComment(f.issue.id, { taskId: first.id, authorType: "agent", authorId: f.worker.id, body: "first answer" });
    f.store.completeTask(first.id, { output: "first narration" });
    f.store.completeTask(second.id, { output: "second answer" });
    const comments = f.store.listIssueComments(f.issue.id).map((comment) => comment.body);
    expect(comments).toContain("first answer");
    expect(comments).toContain("second answer");
    expect(comments).not.toContain("first narration");
  });

  it("runs Leader, worker and QA together but serializes the next Leader turn", () => {
    const f = fixture();
    const next = f.store.createTask({ agentId: f.leader.id, issueId: f.issue.id, prompt: "follow up" });
    const worker = f.delegate(f.worker.id, "dlg_work");
    const qa = f.delegate(f.qa.id, "dlg_qa");
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(worker.id);
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(qa.id);
    expect(f.store.claimTask(f.runtime.id)).toBeNull();
    expect(f.store.getTaskQueueBlocker(worker.id)).toBeNull();
    expect(f.store.getTaskQueueBlocker(next.id)?.taskId).toBe(f.main.id);
    f.store.completeTask(f.main.id, { output: "delegated" });
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(next.id);
  });

  it("isolates two delegations to the same agent, including continuation checkpoints", () => {
    const f = fixture();
    const first = f.delegate(f.worker.id, "dlg_one");
    const second = f.delegate(f.worker.id, "dlg_two");
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(first.id);
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(second.id);
    f.store.buildTaskSessionProjection(first.id);
    f.store.buildTaskSessionProjection(second.id);
    f.store.startTask(first.id);
    f.store.startTask(second.id);
    f.store.completeTask(first.id, { output: "one done", sessionId: "provider_one", workDir: "/tmp/one" });
    f.store.completeTask(second.id, { output: "two done", sessionId: "provider_two", workDir: "/tmp/two" });
    const session = f.main.issueSessionId!;
    expect(f.store.getSessionAgentLane(session, f.worker.id, "dlg_one")?.providerSessionId).toBe("provider_one");
    expect(f.store.getSessionAgentLane(session, f.worker.id, "dlg_two")?.providerSessionId).toBe("provider_two");
    expect(f.store.getSessionAgentLane(session, f.worker.id)?.providerSessionId).toBeNull();
    const continued = f.delegate(f.worker.id, "dlg_one");
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(continued.id);
    expect(f.store.getTask(continued.id)?.sessionId).toBe("provider_one");
    expect(f.store.buildTaskSessionProjection(continued.id)?.mode).toBe("delta");
    expect(daemonTaskClaimResponse(f.store, f.store.getTaskWithAgent(continued.id)!).execution_scope).toBe("dlg_one");
  });

  it("keeps an infrastructure retry in its delegation without resetting a sibling checkpoint", () => {
    const f = fixture();
    const first = f.delegate(f.worker.id, "dlg_retry");
    const second = f.delegate(f.worker.id, "dlg_stable");
    f.store.claimTask(f.runtime.id);
    f.store.claimTask(f.runtime.id);
    f.store.startTask(first.id);
    f.store.startTask(second.id);
    f.store.completeTask(second.id, { output: "stable", sessionId: "stable_provider", workDir: "/tmp/stable" });
    f.store.failTask(first.id, { error: "offline", failureReason: "runtime_offline" });
    const retry = f.store.listTasks().find((task) => task.parentTaskId === first.id && task.attempt === 2)!;
    expect(retry.delegationId).toBe("dlg_retry");
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(retry.id);
    expect(daemonTaskClaimResponse(f.store, f.store.getTaskWithAgent(retry.id)!).execution_scope).toBe("dlg_retry");
    expect(f.store.getSessionAgentLane(first.issueSessionId!, f.worker.id, "dlg_stable")?.providerSessionId).toBe("stable_provider");
  });

  it("wakes the serial Leader as soon as one result is ready while QA still runs", () => {
    const f = fixture();
    const worker = f.delegate(f.worker.id, "dlg_work");
    const qa = f.delegate(f.qa.id, "dlg_qa");
    f.store.claimTask(f.runtime.id);
    f.store.claimTask(f.runtime.id);
    f.store.startTask(worker.id);
    f.store.startTask(qa.id);
    f.store.completeTask(f.main.id, { output: "waiting for results" });
    f.store.completeTask(worker.id, { output: "worker result" });
    const returned = f.store.getTask(worker.id)!.delegationReturnTaskId!;
    expect(returned).toBeTruthy();
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(returned);
    expect(f.store.getTask(qa.id)?.status).toBe("running");
  });

  it("allows independent issue-free Wiki tasks while respecting capacity", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "wiki", name: "wiki", provider: "claude", maxConcurrency: 2 });
    const agent = store.createAgent({ name: "Wiki", provider: "claude", maxConcurrentTasks: 3 });
    const tasks = ["repo1", "repo2", "repo3"].map((prompt) => store.createTask({ agentId: agent.id, prompt }));
    expect(store.claimTask(runtime.id)?.id).toBe(tasks[0]!.id);
    expect(store.claimTask(runtime.id)?.id).toBe(tasks[1]!.id);
    expect(store.claimTask(runtime.id)).toBeNull();
  });

  it("does not give Issue tasks to an old daemon that cannot isolate execution state", () => {
    const f = fixture();
    const old = f.store.registerRuntime({ id: "old", name: "old", provider: "claude", metadata: { cli_version: "0.2.66" } });
    f.delegate(f.worker.id, "dlg_new");
    expect(f.store.claimTask(old.id)).toBeNull();
  });
});
