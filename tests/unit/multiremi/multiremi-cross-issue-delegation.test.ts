import { Database } from "bun:sqlite";
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
    const db = new Database(":memory:");
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
        // C1 proves the report landed in the dispatch Session; the single-round
        // coalescing assertions live with the E2 alignment in C2.
        const returnInDispatch = returns.filter((task) => task.issueSessionId === f.leaderSession.id);
        expect(returnInDispatch.length).toBeGreaterThan(0);
        expect(returnInDispatch[0]?.prompt).toContain(f.child.key);
        expect(returnInDispatch[0]?.prompt).toContain(comment.id);
        expect(returnInDispatch[0]?.prompt).toContain(`Status: ${terminal}`);
        expect(activities(store, f.parent.id, "delegation_return_triggered")).toHaveLength(1);
        expect(store.listTasksForIssue(f.child.id).filter((task) => task.agentId === f.leader.id)).toHaveLength(0);
        const bridge = store.listSessionEvents(f.leaderSession.id).find((event) =>
          event.kind === "delegation_report" && event.taskId === childTask.id);
        expect(bridge?.metadata).toMatchObject({ source_issue_key: f.child.key,
          result_comment_id: comment.id, terminal_status: terminal });
        const projection = store.buildTaskSessionProjection(returnInDispatch[0]!.id);
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
        .find((task) => task.agentId === f.leader.id && task.parentTaskId === second.id
          && task.issueSessionId === f.leaderSession.id
          && task.delegationId === second.delegationId)!;
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

  });
}
