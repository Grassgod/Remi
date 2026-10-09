import { createResponsibleTestIssue } from './helpers.js';
import { afterEach, describe, expect, it } from "bun:test";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";
import { daemonTaskClaimResponse } from "@multiremi/api/wire/tasks.js";
import { bootstrapPreUnifiedSchema, runMigrations } from "@multiremi/store/migrations.js";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { MultiremiStore } from "@multiremi/store.js";
import { historicalWriters } from "./unified-model-test-backends.js";
import { readOfferedTurnInput } from "../../fixtures/turn-report.js";

afterEach(resetMultiremiTestEnv);

function fixture() {
  const store = createStore();
  const runtime = store.registerRuntime({ id: "parallel", name: "parallel", provider: "claude", maxConcurrency: 6,
    metadata: { parallel_agent_execution: 1, cli_version: "0.2.66" } });
  const leader = store.createAgent({ name: "Leader", provider: "claude" });
  const worker = store.createAgent({ name: "Worker", provider: "claude" });
  const qa = store.createAgent({ name: "QA", provider: "claude" });
  const issue = createResponsibleTestIssue(store, { title: "Concurrent delivery" });
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
    const legacy = openSqliteDatabase(":memory:");
    try {
    bootstrapPreUnifiedSchema(legacy);
    const h = historicalWriters(legacy);
    const leader = h.createAgent({ name: "Historical leader", provider: "claude" });
    const issue = h.createIssue({ title: "Historical lane" });
    const main = h.createTask({ agentId: leader.id, issueId: issue.id, prompt: "coordinate" });
    legacy.run("UPDATE multiremi_tasks SET status='completed', session_id='old_provider', work_dir='/tmp/old' WHERE id=?", [main.id]);
    const session = h.getOrCreateDefaultIssueSession(issue.id).id;
    h.appendConversationLog({ sessionId: session, kind: "comment", authorType: "agent", authorId: leader.id, taskId: main.id, bodyMd: "historical answer" });
    legacy.run("UPDATE multiremi_session_agent_lanes SET provider_session_id='old_provider', work_dir='/tmp/old', cursor_seq=2 WHERE session_id=?", [session]);
    const queued = h.createTask({ agentId: leader.id, issueId: issue.id, prompt: "continue" });
    legacy.run("UPDATE multiremi_tasks SET session_id='old_provider', work_dir='/tmp/old' WHERE id=?", [queued.id]);
    const events = legacy.query("SELECT * FROM multiremi_session_events WHERE session_id = ? ORDER BY seq").all(session);
    const upgraded = new MultiremiStore(legacy);
    expect(upgraded.getSessionAgentLane(session, leader.id)).toMatchObject({
      generation: 1, providerSessionId: "old_provider", workDir: "/tmp/old", cursorSeq: 2,
    });
    expect(legacy.query("SELECT * FROM multiremi_session_events WHERE session_id = ? ORDER BY seq").all(session)).toEqual(events);
    expect(upgraded.listConversationLogEntries(session).map(row => row.body_md)).toContain("historical answer");
    expect(upgraded.getTask(queued.id)).toMatchObject({ sessionId: "old_provider", workDir: "/tmp/old", projectionToSeq: null });
    const scoped = upgraded.getOrCreateSessionAgentLane(session, leader.id, "dlg_parallel");
    runMigrations(legacy);
    expect(upgraded.getSessionAgentLane(session, leader.id)?.generation).toBe(1);
    expect(upgraded.getSessionAgentLane(session, leader.id, "dlg_parallel")).toEqual(scoped);
    } finally { legacy.close(); }
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
    expect(next.id).toBe(f.main.id);
    expect(f.store.getDaemonTurnBridge().offerInput(f.store.getTaskWithAgent(f.main.id)!).input_messages
      .filter(row => row.body_md.includes("coordinate") || row.body_md === "follow up")
      .map(row => f.store.getMessage(row.id)!.body_md)).toEqual(["coordinate", "follow up"]);
    f.store.recordSessionAgentRangeRead(f.main.issueSessionId!, f.leader.id, { seq: 1, offset: 0 },
      { seq: f.store.getConversationLogHead(f.main.issueSessionId!)!.headSeq + 1, offset: 0 }, f.main.id);
    readOfferedTurnInput(f.store, f.main.id);
    f.store.completeTask(f.main.id, { output: "delegated" });
    expect(f.store.claimTask(f.runtime.id)).toBeNull();
  });

  it("isolates two delegations to the same agent, including continuation checkpoints", () => {
    const f = fixture();
    const first = f.delegate(f.worker.id, "dlg_one");
    const second = f.delegate(f.worker.id, "dlg_two");
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(first.id);
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(second.id);
    expect(f.store.buildTaskSessionProjection(first.id)?.mode).toBe("bootstrap");
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

  it("serializes a continued task without blocking an independent lane", () => {
    const f = fixture();
    const first = f.delegate(f.worker.id, "dlg_serial");
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(first.id);
    f.store.buildTaskSessionProjection(first.id);
    f.store.startTask(first.id);

    const continued = f.delegate(f.worker.id, "dlg_serial");
    const independent = f.delegate(f.worker.id, "dlg_independent");
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(independent.id);
    f.store.buildTaskSessionProjection(independent.id);
    f.store.startTask(independent.id);
    expect(f.store.claimTask(f.runtime.id)).toBeNull();

    expect(continued.id).toBe(first.id);
    f.store.recordSessionAgentRangeRead(first.issueSessionId!, f.worker.id, { seq: 1, offset: 0 },
      { seq: f.store.getConversationLogHead(first.issueSessionId!)!.headSeq + 1, offset: 0 }, first.id);
    readOfferedTurnInput(f.store, first.id);
    f.store.completeTask(first.id, {
      output: "first round",
      sessionId: "provider_serial",
      workDir: "/tmp/serial",
    });
    expect(f.store.claimTask(f.runtime.id)).toBeNull();
    const next = f.delegate(f.worker.id, "dlg_serial");
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(next.id);
    expect(f.store.getTask(next.id)?.sessionId).toBe("provider_serial");
    expect(f.store.buildTaskSessionProjection(next.id)?.mode).toBe("delta");
    expect(f.store.getTask(independent.id)?.status).toBe("running");
    expect(f.store.getTask(f.main.id)?.status).toBe("running");
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

  it("cold-bootstraps only the incompatible continuation lane and records why", () => {
    const f = fixture();
    const changed = f.delegate(f.worker.id, "dlg_changed");
    const stable = f.delegate(f.worker.id, "dlg_still_stable");
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(changed.id);
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(stable.id);
    f.store.buildTaskSessionProjection(changed.id);
    f.store.buildTaskSessionProjection(stable.id);
    f.store.startTask(changed.id);
    f.store.startTask(stable.id);
    f.store.completeTask(changed.id, { output: "changed", sessionId: "provider_changed", workDir: "/tmp/changed" });
    f.store.completeTask(stable.id, { output: "stable", sessionId: "provider_stable", workDir: "/tmp/stable" });

    const sessionId = changed.issueSessionId!;
    const generation = f.store.getSessionAgentLane(sessionId, f.worker.id, "dlg_changed")!.generation;
    db!.run(
      "UPDATE multiremi_session_lanes SET provider = 'codex' WHERE session_id = ? AND reader_id = ? AND execution_scope = ?",
      [sessionId, f.worker.id, "dlg_changed"],
    );
    const continued = f.delegate(f.worker.id, "dlg_changed");
    expect(f.store.getTask(continued.id)).toMatchObject({ sessionId: null, workDir: null });
    expect(f.store.getSessionAgentLane(sessionId, f.worker.id, "dlg_changed")).toMatchObject({
      generation: generation + 1,
      providerSessionId: null,
      cursorSeq: 0,
    });
    expect(f.store.getSessionAgentLane(sessionId, f.worker.id, "dlg_still_stable")?.providerSessionId)
      .toBe("provider_stable");
    expect(f.store.listIssueActivity(f.issue.id).find((entry) => entry.type === "session_agent_lane_reset")?.data)
      .toMatchObject({
        reason: "provider_changed",
        issueSessionId: sessionId,
        agentId: f.worker.id,
        executionScope: "dlg_changed",
      });
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(continued.id);
    expect(f.store.buildTaskSessionProjection(continued.id)?.mode).toBe("bootstrap");
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
