import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import type { MultiremiIssue, MultiremiTask } from "@multiremi/contracts/types.js";

const pgAdminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
let sequence = 0;

/** MUL-383 shape: one leader dispatch round against N child issues. */
function fiveChildFixture(store: MultiremiStore) {
  const leaderRuntime = store.registerRuntime({ name: "Leader runtime", provider: "claude", workspaceId: "local" });
  const workerRuntimes = Array.from({ length: 5 }, (_, index) =>
    store.registerRuntime({ name: `Worker ${index}`, provider: "claude", workspaceId: "local" }));
  const leader = store.createAgent({ name: "Leader", provider: "claude", runtimeId: leaderRuntime.id });
  const workers = workerRuntimes.map((runtime, index) =>
    store.createAgent({ name: `Worker ${index}`, provider: "claude", runtimeId: runtime.id }));
  const squad = store.createSquad({ name: "Delivery", leaderId: leader.id, memberIds: workers.map((agent) => agent.id) });
  const parent = store.createIssue({ title: "Umbrella", status: "in_progress", assigneeType: "squad", assigneeId: squad.id });
  const children = workers.map((agent, index) => store.createIssue({ title: `Child ${index}`,
    parentIssueId: parent.id, status: "in_progress", assigneeType: "agent", assigneeId: agent.id }));
  const leaderSession = store.createIssueSession(parent.id, { title: "Dispatch five" });
  const leaderTask = store.createTask({ agentId: leader.id, issueId: parent.id,
    issueSessionId: leaderSession.id, prompt: "Dispatch the five children." });
  return { leaderRuntime, workerRuntimes, leader, workers, squad, parent, children, leaderSession, leaderTask };
}

async function withStore(backend: "sqlite" | "postgres", run: (store: MultiremiStore) => Promise<void>): Promise<void> {
  if (backend === "sqlite") {
    const db = openSqliteDatabase(":memory:");
    try {
      const store = new MultiremiStore(db);
      store.ensureLocalWorkspace();
      await run(store);
    } finally {
      db.close();
    }
    return;
  }
  const admin = new Bun.SQL(pgAdminUrl!, { max: 1 });
  const name = `mul456i_${process.pid}_${++sequence}`;
  const url = new URL(pgAdminUrl!);
  url.pathname = `/${name}`;
  let db: PostgresSyncDatabase | null = null;
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
    db = new PostgresSyncDatabase(url.toString());
    const store = new MultiremiStore(db);
    store.ensureLocalWorkspace();
    await run(store);
  } finally {
    db?.close();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
}

function fixture(store: MultiremiStore) {
  const leaderRuntime = store.registerRuntime({ name: "Leader runtime", provider: "claude", workspaceId: "local" });
  const workerRuntime = store.registerRuntime({ name: "Worker runtime", provider: "claude", workspaceId: "local" });
  const leader = store.createAgent({ name: "Leader", provider: "claude", runtimeId: leaderRuntime.id });
  const worker = store.createAgent({ name: "Worker", provider: "claude", runtimeId: workerRuntime.id });
  const outsider = store.createAgent({ name: "Outsider", provider: "claude" });
  const squad = store.createSquad({ name: "Core", leaderId: leader.id, memberIds: [worker.id] });
  const parent = store.createIssue({ title: "Parent", status: "in_progress", assigneeType: "squad", assigneeId: squad.id });
  const child = store.createIssue({ title: "Child", parentIssueId: parent.id, status: "in_progress", assigneeType: "agent", assigneeId: worker.id });
  const leaderSession = store.createIssueSession(parent.id, { title: "Dispatch round" });
  const leaderTask = store.createTask({ agentId: leader.id, issueId: parent.id,
    issueSessionId: leaderSession.id, prompt: "Coordinate." });
  return { leaderRuntime, workerRuntime, leader, worker, outsider, parent, child, leaderSession, leaderTask };
}

async function dispatch(store: MultiremiStore, source: MultiremiTask, issue: MultiremiIssue, agentId: string) {
  const app = createMultiremiApp({ store, authToken: "test-root" });
  const token = await store.createTaskAccessToken(source, "local");
  const response = await app.request("/api/multiremi/tasks", {
    method: "POST",
    headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ agentId, issueId: issue.id, prompt: "Execute delegated work." }),
  });
  expect(response.status).toBe(201);
  return store.getTask(((await response.json()) as { task: { id: string } }).task.id)!;
}

function activities(store: MultiremiStore, issueId: string, type: string) {
  return store.listIssueActivity(issueId).filter((activity) => activity.type === type);
}

function finishLeaderRound(store: MultiremiStore, f: ReturnType<typeof fixture>): void {
  expect(store.claimTask(f.leaderRuntime.id)?.id).toBe(f.leaderTask.id);
  store.buildTaskSessionProjection(f.leaderTask.id);
  store.startTask(f.leaderTask.id);
  store.completeTask(f.leaderTask.id, { output: "Task completed." });
}

for (const backend of ["sqlite", "postgres"] as const) {
  describe.skipIf(backend === "postgres" && !pgAdminUrl)(`MUL-456 cross-issue return (${backend})`, () => {
    it("recognizes the child and sibling subtrees and explains rejected dispatches", async () => withStore(backend, async (store) => {
      const f = fixture(store);
      const grandchild = store.createIssue({ title: "Grandchild", parentIssueId: f.child.id });
      const sibling = store.createIssue({ title: "Sibling", parentIssueId: f.parent.id });
      const siblingChild = store.createIssue({ title: "Sibling child", parentIssueId: sibling.id });
      for (const target of [f.child, grandchild, sibling, siblingChild]) {
        const decision = store.isSquadLeaderDelegation({ issue: target, sourceTask: f.leaderTask,
          authorAgentId: f.leader.id, targetAgentId: f.worker.id, issueSessionId: null });
        expect(decision).toEqual({ ok: true, delegatedFromIssueSessionId: f.leaderSession.id });
      }
      const unrelated = store.createIssue({ title: "Unrelated" });
      const cases = [
        [f.child, f.leaderTask, f.outsider.id, "target_not_squad_member"],
        [unrelated, f.leaderTask, f.worker.id, "cross_issue_no_lineage"],
        [f.child, f.leaderTask, f.leader.id, "self_dispatch"],
      ] as const;
      for (const [issue, sourceTask, targetAgentId, reason] of cases) {
        expect(store.isSquadLeaderDelegation({ issue, sourceTask, authorAgentId: f.leader.id,
          targetAgentId, issueSessionId: null })).toEqual({ ok: false, reason });
      }
      const chatSource = store.createTask({ agentId: f.leader.id, prompt: "Chat source" });
      expect(store.isSquadLeaderDelegation({ issue: f.child, sourceTask: chatSource,
        authorAgentId: f.leader.id, targetAgentId: f.worker.id, issueSessionId: null }))
        .toEqual({ ok: false, reason: "source_not_issue_task" });
      const side = store.createIssueSession(f.parent.id, { parentSessionId: f.leaderSession.id });
      const sideTask = store.createTask({ agentId: f.leader.id, issueId: f.parent.id,
        issueSessionId: side.id, prompt: "Side source" });
      expect(store.isSquadLeaderDelegation({ issue: f.child, sourceTask: sideTask,
        authorAgentId: f.leader.id, targetAgentId: f.worker.id, issueSessionId: null }))
        .toEqual({ ok: false, reason: "source_side_session" });
      const nonSquad = store.createIssue({ title: "Agent owner", parentIssueId: f.parent.id,
        assigneeType: "agent", assigneeId: f.leader.id });
      const nonSquadTask = store.createTask({ agentId: f.leader.id, issueId: nonSquad.id, prompt: "Lead" });
      expect(store.isSquadLeaderDelegation({ issue: f.child, sourceTask: nonSquadTask,
        authorAgentId: f.leader.id, targetAgentId: f.worker.id, issueSessionId: null }))
        .toEqual({ ok: false, reason: "source_not_squad_leader" });
    }));

    for (const terminal of ["completed", "failed", "cancelled"] as const) {
      it(`returns a ${terminal} child to the dispatch Session`, async () => withStore(backend, async (store) => {
        const f = fixture(store);
        const childTask = await dispatch(store, f.leaderTask, f.child, f.worker.id);
        expect(childTask).toMatchObject({ delegatedByAgentId: f.leader.id,
          delegatedFromIssueSessionId: f.leaderSession.id, parentTaskId: f.leaderTask.id });
        expect(childTask.issueSessionId).not.toBe(f.leaderSession.id);
        finishLeaderRound(store, f);
        expect(store.claimTask(f.workerRuntime.id)?.id).toBe(childTask.id);
        store.buildTaskSessionProjection(childTask.id);
        store.startTask(childTask.id);
        const comment = store.createIssueComment(f.child.id, { authorType: "agent", authorId: f.worker.id,
          taskId: childTask.id, issueSessionId: childTask.issueSessionId, body: "Result details" });
        if (terminal === "completed") store.completeTask(childTask.id, { output: "Result details" });
        else if (terminal === "failed") store.failTask(childTask.id, { error: "Failure details" });
        else store.cancelTask(childTask.id);
        const returns = store.listTasksForIssue(f.parent.id).filter((task) => task.agentId === f.leader.id
          && task.parentTaskId === childTask.id);
        expect(returns).toHaveLength(1);
        expect(returns[0]?.issueSessionId).toBe(f.leaderSession.id);
        expect(returns[0]?.prompt).toContain(f.child.key);
        expect(returns[0]?.prompt).toContain(comment.id);
        expect(returns[0]?.prompt).toContain(`Status: ${terminal}`);
        expect(activities(store, f.parent.id, "delegation_return_triggered")).toHaveLength(1);
        expect(store.listTasksForIssue(f.child.id).filter((task) => task.agentId === f.leader.id)).toHaveLength(0);
        const bridge = store.listSessionEvents(f.leaderSession.id).find((event) =>
          event.kind === "delegation_report" && event.taskId === childTask.id);
        expect(bridge?.metadata).toMatchObject({ source_issue_key: f.child.key,
          result_comment_id: comment.id, terminal_status: terminal });
        const projection = store.buildTaskSessionProjection(returns[0]!.id);
        expect(JSON.stringify(projection)).toContain("delegation_report");
      }));
    }

    it("audits rejected cross-issue dispatch on both issues, but not a human dispatch", async () => withStore(backend, async (store) => {
      const f = fixture(store);
      const rejected = await dispatch(store, f.leaderTask, f.child, f.outsider.id);
      expect(rejected.delegationSkipReason).toBe("target_not_squad_member");
      const human = store.createTask({ agentId: f.worker.id, issueId: f.child.id, prompt: "Human dispatch" });
      expect(human.delegationSkipReason).toBeNull();
      store.cancelTask(rejected.id);
      store.cancelTask(human.id);
      for (const issue of [f.parent, f.child]) {
        expect(activities(store, issue.id, "delegation_return_skipped")
          .filter((activity) => (activity.data as Record<string, unknown>).sourceTaskId === rejected.id))
          .toHaveLength(1);
      }
      expect(activities(store, f.child.id, "delegation_return_skipped")
        .filter((activity) => (activity.data as Record<string, unknown>).sourceTaskId === human.id))
        .toHaveLength(0);
    }));

    it("dedupes a manual wakeup by parent_task_id and returns after its cancellation", async () => withStore(backend, async (store) => {
      const f = fixture(store);
      const childTask = await dispatch(store, f.leaderTask, f.child, f.worker.id);
      const manual = store.createTask({ agentId: f.leader.id, issueId: f.parent.id,
        issueSessionId: f.leaderSession.id, parentTaskId: childTask.id, prompt: "Wake up" });
      store.cancelTask(childTask.id);
      expect(store.getTask(childTask.id)?.delegationReturnTaskId).toBe(manual.id);
      expect(activities(store, f.child.id, "delegation_return_skipped")
        .some((activity) => (activity.data as Record<string, unknown>).reason === "covered_by_delegate_wakeup"))
        .toBe(true);
      const next = await dispatch(store, f.leaderTask, f.child, f.worker.id);
      const cancelled = store.createTask({ agentId: f.leader.id, issueId: f.parent.id,
        issueSessionId: f.leaderSession.id, parentTaskId: next.id, prompt: "Wake up" });
      store.cancelTask(cancelled.id);
      store.cancelTask(next.id);
      expect(store.getTask(next.id)?.delegationReturnTaskId).not.toBe(cancelled.id);
    }));

    it("coalesces a child-done round and a later terminal report in the dispatch Session", async () => withStore(backend, async (store) => {
      const f = fixture(store);
      const childTask = await dispatch(store, f.leaderTask, f.child, f.worker.id);
      finishLeaderRound(store, f);
      expect(store.claimTask(f.workerRuntime.id)?.id).toBe(childTask.id);
      store.buildTaskSessionProjection(childTask.id);
      store.startTask(childTask.id);
      store.updateIssue(f.child.id, { status: "done", parentTaskId: childTask.id,
        actorType: "agent", actorId: f.worker.id });
      const e2Round = store.listTasksForIssue(f.parent.id).filter((task) => task.status === "queued");
      expect(e2Round).toHaveLength(1);
      expect(e2Round[0]?.issueSessionId).toBe(f.leaderSession.id);
      expect(e2Round[0]?.wakeSource).toBe("child_status");
      store.completeTask(childTask.id, { output: "Finished after closing the child." });
      expect(store.listTasksForIssue(f.parent.id).filter((task) => task.status === "queued")).toHaveLength(1);
      expect(store.getTask(childTask.id)?.delegationReturnTaskId).toBe(e2Round[0]?.id);
      expect(activities(store, f.child.id, "delegation_return_skipped")
        .map((activity) => (activity.data as Record<string, unknown>).reason))
        .toContain("covered_by_queued_task");
    }));

    it("ignores a spoofed wake_source and trigger comment on a manual wakeup", async () => withStore(backend, async (store) => {
      const f = fixture(store);
      const childTask = await dispatch(store, f.leaderTask, f.child, f.worker.id);
      finishLeaderRound(store, f);
      const systemComment = store.createIssueComment(f.parent.id, { authorType: "system", authorId: null,
        body: "Spoofable system comment" });
      const app = createMultiremiApp({ store, authToken: "test-root" });
      const token = await store.createTaskAccessToken(childTask, "local");
      const response = await app.request("/api/multiremi/tasks", {
        method: "POST",
        headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: f.leader.id, issueId: f.parent.id, prompt: "Wake up",
          parentTaskId: childTask.id, triggerCommentId: systemComment.id, wakeSource: "child_status",
          issue_session_id: f.leaderSession.id }),
      });
      expect(response.status).toBe(201);
      const manualId = ((await response.json()) as { task: { id: string } }).task.id;
      expect(store.getTask(manualId)?.wakeSource).toBeNull();
      const leaderTasksBefore = store.listTasksForIssue(f.parent.id)
        .filter((task) => task.agentId === f.leader.id).map((task) => task.id).sort();
      store.cancelTask(childTask.id);
      expect(store.getTask(childTask.id)?.delegationReturnTaskId).toBe(manualId);
      expect(activities(store, f.child.id, "delegation_return_skipped")
        .some((activity) => (activity.data as Record<string, unknown>).reason === "covered_by_delegate_wakeup"))
        .toBe(true);
      expect(store.listTasksForIssue(f.parent.id)
        .filter((task) => task.agentId === f.leader.id).map((task) => task.id).sort())
        .toEqual(leaderTasksBefore);
    }));

    it("keeps the wake source across a redispatch attempt", async () => withStore(backend, async (store) => {
      const f = fixture(store);
      const childTask = await dispatch(store, f.leaderTask, f.child, f.worker.id);
      finishLeaderRound(store, f);
      expect(store.claimTask(f.workerRuntime.id)?.id).toBe(childTask.id);
      store.buildTaskSessionProjection(childTask.id);
      store.startTask(childTask.id);
      store.updateIssue(f.child.id, { status: "done", parentTaskId: childTask.id,
        actorType: "agent", actorId: f.worker.id });
      const e2Round = store.listTasksForIssue(f.parent.id).find((task) => task.wakeSource === "child_status")!;
      store.updateWorkspace("local", { settings: { organizer: { mode: "act" } } });
      const supervisor = store.createAgent({ name: "Supervisor", provider: "claude", role: "supervisor" });
      const supervisorTask = store.createTask({ agentId: supervisor.id, issueId: f.parent.id, prompt: "Supervise" });
      const replacement = store.performOrganizerAction({
        supervisorTaskId: supervisorTask.id,
        supervisorAgentId: supervisor.id,
        targetTaskId: e2Round.id,
        action: "redispatch",
        reason: "wake source probe",
      }).replacementTask!;
      expect(replacement.wakeSource).toBe("child_status");
      store.cancelTask(childTask.id);
      expect(store.getTask(childTask.id)?.delegationReturnTaskId).toBe(replacement.id);
      expect(activities(store, f.child.id, "delegation_return_skipped")
        .map((activity) => (activity.data as Record<string, unknown>).reason))
        .toContain("covered_by_queued_task");
    }));

    it("merges a failure's blocked report into its queued return", async () => withStore(backend, async (store) => {
      const f = fixture(store);
      const childTask = await dispatch(store, f.leaderTask, f.child, f.worker.id);
      finishLeaderRound(store, f);
      expect(store.claimTask(f.workerRuntime.id)?.id).toBe(childTask.id);
      store.buildTaskSessionProjection(childTask.id);
      store.startTask(childTask.id);
      store.failTask(childTask.id, { error: "Cannot proceed" });
      expect(store.getIssue(f.child.id)?.status).toBe("blocked");
      const queued = store.listTasksForIssue(f.parent.id).filter((task) => task.status === "queued");
      expect(queued).toHaveLength(1);
      expect(queued[0]?.issueSessionId).toBe(f.leaderSession.id);
      expect(activities(store, f.parent.id, "child_status_parent_coalesced")).toHaveLength(1);
      expect(activities(store, f.parent.id, "delegation_return_triggered")).toHaveLength(1);
    }));

    it("bypasses the waiting-parent gate for a structural delegation return", async () => withStore(backend, async (store) => {
      const f = fixture(store);
      const childTask = await dispatch(store, f.leaderTask, f.child, f.worker.id);
      finishLeaderRound(store, f);
      const prerequisite = store.createIssue({ title: "Prerequisite", status: "todo" });
      store.createIssueDependency(f.parent.id, { dependsOnIssueId: prerequisite.id, type: "blocked_by" });
      store.updateIssue(f.parent.id, { status: "backlog" });
      expect(store.getIssue(f.parent.id)?.status).toBe("backlog");
      store.cancelTask(childTask.id);
      expect(store.listTasksForIssue(f.parent.id)
        .filter((task) => task.agentId === f.leader.id && task.parentTaskId === childTask.id)).toHaveLength(1);
    }));

    it("resolves the result comment once inside the terminal transaction", async () => withStore(backend, async (store) => {
      const f = fixture(store);
      const first = await dispatch(store, f.leaderTask, f.child, f.worker.id);
      finishLeaderRound(store, f);
      expect(store.claimTask(f.workerRuntime.id)?.id).toBe(first.id);
      store.buildTaskSessionProjection(first.id);
      store.startTask(first.id);
      // No comment yet: the terminal transaction records null and the prompt
      // carries the ruling's fixed fallback line.
      store.cancelTask(first.id);
      const withoutComment = store.listTasksForIssue(f.parent.id)
        .find((task) => task.agentId === f.leader.id && task.parentTaskId === first.id)!;
      expect(withoutComment.prompt).toContain("Result comment: none at completion");
      const bridgeWithout = store.listSessionEvents(f.leaderSession.id)
        .find((event) => event.kind === "delegation_report" && event.taskId === first.id)!;
      expect((bridgeWithout.metadata as Record<string, unknown>).result_comment_id).toBeNull();

      // Two comments: the newest by created_at/id wins. The terminal
      // transaction resolves it once and nothing rewrites the event later.
      // A terminal task revokes its own task token, so the second round runs
      // from a fresh leader turn. Consume the first return normally: cancelling
      // it would re-open the report and queue its own replacement ahead of the
      // new leader turn.
      expect(store.claimTask(f.leaderRuntime.id)?.id).toBe(withoutComment.id);
      store.buildTaskSessionProjection(withoutComment.id);
      store.startTask(withoutComment.id);
      store.completeTask(withoutComment.id, { output: "Reviewed the first report." });
      const secondLeaderTask = store.createTask({ agentId: f.leader.id, issueId: f.parent.id,
        issueSessionId: f.leaderSession.id, prompt: "Coordinate again." });
      expect(store.claimTask(f.leaderRuntime.id)?.id).toBe(secondLeaderTask.id);
      store.buildTaskSessionProjection(secondLeaderTask.id);
      store.startTask(secondLeaderTask.id);
      const second = await dispatch(store, secondLeaderTask, f.child, f.worker.id);
      store.completeTask(secondLeaderTask.id, { output: "Task completed." });
      expect(store.claimTask(f.workerRuntime.id)?.id).toBe(second.id);
      store.buildTaskSessionProjection(second.id);
      store.startTask(second.id);
      store.createIssueComment(f.child.id, { authorType: "agent", authorId: f.worker.id,
        taskId: second.id, issueSessionId: second.issueSessionId, body: "Older result" });
      const newest = store.createIssueComment(f.child.id, { authorType: "agent", authorId: f.worker.id,
        taskId: second.id, issueSessionId: second.issueSessionId, body: "Newest result" });
      store.failTask(second.id, { error: "Latest result text" });
      const withComment = store.listTasksForIssue(f.parent.id)
        .find((task) => task.agentId === f.leader.id && task.parentTaskId === second.id)!;
      expect(withComment.prompt).toContain(`Result comment: ${newest.id}`);
      expect(withComment.prompt).toContain("Latest result text");
      const bridgeWith = store.listSessionEvents(f.leaderSession.id)
        .find((event) => event.kind === "delegation_report" && event.taskId === second.id)!;
      expect((bridgeWith.metadata as Record<string, unknown>).result_comment_id).toBe(newest.id);
      // The automatic reply is posted after commit and must not rewrite the
      // bridge event or append another one for the same source task. Later
      // events from the E2 child-status round are unrelated to this report.
      const bridgeEvents = store.listSessionEvents(f.leaderSession.id)
        .filter((event) => event.kind === "delegation_report" && event.taskId === second.id);
      expect(bridgeEvents).toHaveLength(1);
      expect((bridgeEvents[0]!.metadata as Record<string, unknown>).result_comment_id).toBe(newest.id);
    }));

    it("still queues the return when the post-commit auto comment fails", async () => withStore(backend, async (store) => {
      const f = fixture(store);
      const childTask = await dispatch(store, f.leaderTask, f.child, f.worker.id);
      finishLeaderRound(store, f);
      expect(store.claimTask(f.workerRuntime.id)?.id).toBe(childTask.id);
      store.buildTaskSessionProjection(childTask.id);
      store.startTask(childTask.id);
      const original = store.createIssueComment.bind(store);
      store.createIssueComment = (() => {
        throw new Error("auto comment failed");
      }) as typeof store.createIssueComment;
      try {
        store.completeTask(childTask.id, { output: "Completed without an in-run comment" });
      } finally {
        store.createIssueComment = original as typeof store.createIssueComment;
      }
      const returnTask = store.listTasksForIssue(f.parent.id)
        .find((task) => task.agentId === f.leader.id && task.parentTaskId === childTask.id)!;
      expect(returnTask).toBeTruthy();
      expect(returnTask.prompt).toContain("Result comment: none at completion");
      expect(returnTask.prompt).toContain("Completed without an in-run comment");
      const bridge = store.listSessionEvents(f.leaderSession.id)
        .find((event) => event.kind === "delegation_report" && event.taskId === childTask.id)!;
      expect((bridge.metadata as Record<string, unknown>).result_comment_id).toBeNull();
    }));

    // Cold PG migrations plus five complete HTTP/task lifecycles take 4.94-5.26s
    // locally; retain every assertion while allowing this fixture to finish.
    it("drains five child reports into one round and marks the lane cursor covered", async () => withStore(backend, async (store) => {
      const f = fiveChildFixture(store);
      const app = createMultiremiApp({ store, authToken: "test-root" });
      const tokens = await Promise.all(f.children.map(() => store.createTaskAccessToken(f.leaderTask, "local")));
      const childTasks: MultiremiTask[] = [];
      for (let index = 0; index < f.children.length; index += 1) {
        const response = await app.request("/api/multiremi/tasks", { method: "POST",
          headers: { Authorization: `Bearer ${tokens[index]!.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ agentId: f.workers[index]!.id, issueId: f.children[index]!.id,
            prompt: `Investigate child ${index}` }) });
        expect(response.status).toBe(201);
        childTasks.push(store.getTask(((await response.json()) as { task: { id: string } }).task.id)!);
      }
      expect(new Set(childTasks.map((task) => task.delegatedFromIssueSessionId)))
        .toEqual(new Set([f.leaderSession.id]));
      expect(store.claimTask(f.leaderRuntime.id)?.id).toBe(f.leaderTask.id);
      store.buildTaskSessionProjection(f.leaderTask.id);
      store.startTask(f.leaderTask.id);
      store.completeTask(f.leaderTask.id, { output: "Task completed." });
      // Run and end every child; only the first return is created, the rest
      // coalesce into it because each terminal transaction drains the queue.
      for (let index = 0; index < childTasks.length; index += 1) {
        const task = childTasks[index]!;
        expect(store.claimTask(f.workerRuntimes[index]!.id)?.id).toBe(task.id);
        store.buildTaskSessionProjection(task.id);
        store.startTask(task.id);
        store.completeTask(task.id, { output: `Report ${index}` });
      }
      const queued = store.listTasksForIssue(f.parent.id)
        .filter((task) => task.status === "queued" && task.agentId === f.leader.id);
      expect(queued).toHaveLength(1);
      expect(queued[0]?.issueSessionId).toBe(f.leaderSession.id);
      for (let index = 1; index < childTasks.length; index += 1) {
        expect(queued[0]?.prompt).toContain(`Report ${index}`);
      }
      expect(store.listTasksForIssue(f.parent.id).filter((task) => task.status === "queued")).toHaveLength(1);
      expect(store.claimTask(f.leaderRuntime.id)?.id).toBe(queued[0]!.id);
      store.buildTaskSessionProjection(queued[0]!.id);
      store.startTask(queued[0]!.id);
      store.completeTask(queued[0]!.id, { output: "Reviewed all five." });
      // Every source is stamped by the same return, and a later drain finds
      // them covered instead of opening a second round.
      for (const childTask of childTasks) {
        expect(store.getTask(childTask.id)?.delegationReturnTaskId).toBe(queued[0]!.id);
      }
      const bridges = store.listSessionEvents(f.leaderSession.id)
        .filter((event) => event.kind === "delegation_report");
      expect(bridges).toHaveLength(5);
      expect(new Set(bridges.map((event) => event.taskId))).toEqual(new Set(childTasks.map((task) => task.id)));
    }), backend === "postgres" ? 15_000 : 5_000);

    it("reproduces the MUL-383 HTTP path step by step", async () => withStore(backend, async (store) => {
      const f = fiveChildFixture(store);
      const app = createMultiremiApp({ store, authToken: "test-root" });
      const snapshot = (label: string) => {
        const tasks = store.listTasksForIssue(f.parent.id)
          .filter((task) => task.issueId === f.parent.id)
          .map((task) => ({ id: task.id, agent: task.agentId, status: task.status,
            parentTaskId: task.parentTaskId, wakeSource: task.wakeSource }));
        const activity = store.listIssueActivity(f.parent.id)
          .map((entry) => ({ type: entry.type, data: entry.data }));
        console.log(`MUL383-STEP ${label} tasks=${JSON.stringify(tasks)} activity=${JSON.stringify(activity)}`);
      };
      snapshot("initial");
      const tokens = await Promise.all(f.children.map(() => store.createTaskAccessToken(f.leaderTask, "local")));
      const childTasks: MultiremiTask[] = [];
      for (let index = 0; index < f.children.length; index += 1) {
        const response = await app.request("/api/multiremi/tasks", { method: "POST",
          headers: { Authorization: `Bearer ${tokens[index]!.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ agentId: f.workers[index]!.id, issueId: f.children[index]!.id,
            prompt: `MUL-383 child ${index}` }) });
        expect(response.status).toBe(201);
        childTasks.push(store.getTask(((await response.json()) as { task: { id: string } }).task.id)!);
      }
      snapshot("dispatched-five");
      expect(store.claimTask(f.leaderRuntime.id)?.id).toBe(f.leaderTask.id);
      store.buildTaskSessionProjection(f.leaderTask.id);
      store.startTask(f.leaderTask.id);
      store.completeTask(f.leaderTask.id, { output: "Leader awaited the five children." });
      snapshot("leader-finished");
      for (let index = 0; index < childTasks.length; index += 1) {
        const task = childTasks[index]!;
        expect(store.claimTask(f.workerRuntimes[index]!.id)?.id).toBe(task.id);
        store.buildTaskSessionProjection(task.id);
        store.startTask(task.id);
        store.completeTask(task.id, { output: `MUL-383 result ${index}` });
        snapshot(`child-${index}-finished`);
      }
      const queued = store.listTasksForIssue(f.parent.id)
        .filter((task) => task.status === "queued" && task.agentId === f.leader.id);
      expect(queued).toHaveLength(1);
      expect(queued[0]?.prompt).toContain("MUL-383 result 4");
      expect(activities(store, f.parent.id, "delegation_return_triggered")).toHaveLength(1);
      expect(store.listSessionEvents(f.leaderSession.id)
        .filter((event) => event.kind === "delegation_report")).toHaveLength(5);
      // The leader never waited: every child report landed while the leader's
      // own round was already over, and the single queued return is claimable.
      expect(store.claimTask(f.leaderRuntime.id)?.id).toBe(queued[0]!.id);
    }));
  });
}
