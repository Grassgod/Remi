import { createResponsibleTestIssue } from './helpers.js';
import { requestMessageBody, taskRequestPath, sentTask } from "./unified-test-paths.js";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { IssuesRepo } from "@multiremi/store/repos/issues-repo.js";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import type { MultiremiIssue, MultiremiTask } from "@multiremi/contracts/types.js";
import { inboxReportBody } from "./inbox-test-assertions.js";

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
  const parent = createResponsibleTestIssue(store, { title: "Umbrella", status: "in_progress", assigneeType: "squad", assigneeId: squad.id });
  const children = workers.map((agent, index) => createResponsibleTestIssue(store, { title: `Child ${index}`,
    parentIssueId: parent.id, status: "in_progress", assigneeType: "agent", assigneeId: agent.id }));
  const leaderSession = store.createIssueSession(parent.id, { title: "Dispatch five" });
  const leaderTask = store.createTask({ agentId: leader.id, issueId: parent.id,
    issueSessionId: leaderSession.id, prompt: "Dispatch the five children." });
  return { leaderRuntime, workerRuntimes, leader, workers, squad, parent, children, leaderSession, leaderTask };
}

async function openStore(backend: "sqlite" | "postgres") {
  if (backend === "sqlite") {
    const db = openSqliteDatabase(":memory:");
    try {
      const store = new MultiremiStore(db);
      store.ensureLocalWorkspace();
      return { store, db, close: async () => db.close() };
    } catch (error) {
      db.close();
      throw error;
    }
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
    return { store, db, close: async () => {
      db?.close();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    } };
  } catch (error) {
    db?.close();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
    throw error;
  }
}

function fixture(store: MultiremiStore, db?: SqlDatabase) {
  const registerMembers = () => {
    const leaderRuntime = store.registerRuntime({ name: "Leader runtime", provider: "claude", workspaceId: "local" });
    const workerRuntime = store.registerRuntime({ name: "Worker runtime", provider: "claude", workspaceId: "local" });
    const leader = store.createAgent({ name: "Leader", provider: "claude", runtimeId: leaderRuntime.id });
    const worker = store.createAgent({ name: "Worker", provider: "claude", runtimeId: workerRuntime.id });
    const outsider = store.createAgent({ name: "Outsider", provider: "claude" });
    const squad = store.createSquad({ name: "Core", leaderId: leader.id, memberIds: [worker.id] });
    return { leaderRuntime, workerRuntime, leader, worker, outsider, squad };
  };
  // Batch independent fixture writes; Issue creation owns its transaction and callbacks.
  const { leaderRuntime, workerRuntime, leader, worker, outsider, squad } =
    db ? db.transaction(registerMembers)() : registerMembers();
  const parent = createResponsibleTestIssue(store, { title: "Parent", status: "in_progress", assigneeType: "squad", assigneeId: squad.id });
  const child = createResponsibleTestIssue(store, { title: "Child", parentIssueId: parent.id, status: "in_progress", assigneeType: "agent", assigneeId: worker.id });
  const leaderSession = store.createIssueSession(parent.id, { title: "Dispatch round" });
  const leaderTask = store.createTask({ agentId: leader.id, issueId: parent.id,
    issueSessionId: leaderSession.id, prompt: "Coordinate." });
  return { leaderRuntime, workerRuntime, leader, worker, outsider, parent, child, leaderSession, leaderTask };
}

async function dispatch(store: MultiremiStore, source: MultiremiTask, issue: MultiremiIssue, agentId: string) {
  const app = createMultiremiApp({ store, authToken: "test-root" });
  const token = await store.createTaskAccessToken(source, "local");
  const response = await app.request(taskRequestPath(store, { issueId: issue.id }), {
    method: "POST",
    headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(requestMessageBody(store, { agentId, issueId: issue.id, prompt: "Execute delegated work." })),
  });
  expect(response.status).toBe(200);
  return store.getTask(sentTask(store, await response.json()).id)!;
}

function activities(store: MultiremiStore, issueId: string, type: string) {
  return store.listIssueActivity(issueId).filter((activity) => activity.type === type);
}

function claimReturn(store:MultiremiStore,runtimeId:string,attemptId:string){
  for(let i=0;i<3;i++){const task=store.claimTask(runtimeId);if(!task||task.id===attemptId)return task;
    store.startTask(task.id);store.completeTask(task.id,{output:"Reviewed owner status"});}
  throw new Error("Return attempt was not offered");
}
function finishLeaderRound(store: MultiremiStore, f: ReturnType<typeof fixture>): void {
  expect(store.claimTask(f.leaderRuntime.id)?.id).toBe(f.leaderTask.id);
  store.buildTaskSessionProjection(f.leaderTask.id);
  store.startTask(f.leaderTask.id);
  store.completeTask(f.leaderTask.id, { output: "Task completed." });
}

for (const backend of ["sqlite", "postgres"] as const) {
  // These PG scenarios do several writes; CI runner jitter is outside the behavior asserted below.
  const pgScenarioTimeout = backend === "postgres" ? 15000 : 5000;
  describe.skipIf(backend === "postgres" && !pgAdminUrl)(`MUL-456 cross-issue return (${backend})`, () => {
    let opened: Awaited<ReturnType<typeof openStore>>;
    // Keep cold database/bootstrap and teardown outside each behavior's existing
    // timeout; the transactional scenarios retain their original budgets.
    beforeEach(async () => { opened = await openStore(backend); });
    afterEach(async () => { await opened?.close(); });
    const withStore = async (_backend: typeof backend, run: (store: MultiremiStore, db: SqlDatabase) => Promise<void>) => {
      await run(opened.store, opened.db);
    };
    it("delegates inside and outside the subtree and retains audited exceptions", async () => withStore(backend, async (store) => {
      const f = fixture(store);
      const grandchild = createResponsibleTestIssue(store, { title: "Grandchild", parentIssueId: f.child.id });
      const sibling = createResponsibleTestIssue(store, { title: "Sibling", parentIssueId: f.parent.id });
      const siblingChild = createResponsibleTestIssue(store, { title: "Sibling child", parentIssueId: sibling.id });
      for (const target of [f.child, grandchild, sibling, siblingChild]) {
        const decision = store.resolveAgentDelegation({ targetIssue: target, sourceTask: f.leaderTask,
          authorAgentId: f.leader.id, targetAgentId: f.worker.id });
        expect(decision).toEqual({ ok: true, delegatedFromIssueSessionId: f.leaderSession.id });
      }
      const unrelated = createResponsibleTestIssue(store, { title: "Unrelated" });
      for (const [targetIssue, targetAgentId] of [[f.child, f.outsider.id], [unrelated, f.worker.id]] as const) {
        expect(store.resolveAgentDelegation({ targetIssue, sourceTask: f.leaderTask,
          authorAgentId: f.leader.id, targetAgentId }))
          .toEqual({ ok: true, delegatedFromIssueSessionId: f.leaderSession.id });
      }
      expect(store.resolveAgentDelegation({ targetIssue: f.child, sourceTask: f.leaderTask,
        authorAgentId: f.leader.id, targetAgentId: f.leader.id })).toEqual({ ok: false, reason: "self_dispatch" });
      const chatSource = store.createTask({ agentId: f.leader.id, prompt: "Chat source" });
      expect(store.resolveAgentDelegation({ targetIssue: f.child, sourceTask: chatSource,
        authorAgentId: f.leader.id, targetAgentId: f.worker.id }))
        .toEqual({ ok: false, reason: "source_not_issue_task" });
      const side = store.createIssueSession(f.parent.id, { parentSessionId: f.leaderSession.id });
      const sideTask = store.createTask({ agentId: f.leader.id, issueId: f.parent.id,
        issueSessionId: side.id, prompt: "Side source" });
      expect(store.resolveAgentDelegation({ targetIssue: f.child, sourceTask: sideTask,
        authorAgentId: f.leader.id, targetAgentId: f.worker.id }))
        .toEqual({ ok: false, reason: "source_side_session" });
      const nonSquad = createResponsibleTestIssue(store, { title: "Agent owner", parentIssueId: f.parent.id,
        assigneeType: "agent", assigneeId: f.leader.id });
      const nonSquadTask = store.createTask({ agentId: f.leader.id, issueId: nonSquad.id, prompt: "Lead" });
      expect(store.resolveAgentDelegation({ targetIssue: f.child, sourceTask: nonSquadTask,
        authorAgentId: f.leader.id, targetAgentId: f.worker.id }))
        .toEqual({ ok: true, delegatedFromIssueSessionId: nonSquadTask.issueSessionId! });
    }));

    for (const terminal of ["completed", "failed", "cancelled"] as const) {
      it(`returns a ${terminal} child to the dispatch Session`, async () => withStore(backend, async (store) => {
        const f = fixture(store);
        const childTask = await dispatch(store, f.leaderTask, f.child, f.worker.id);
        expect(childTask).toMatchObject({ delegatedByAgentId: f.leader.id,
          delegatedFromIssueSessionId: f.leaderSession.id, parentTaskId: null });
        expect(store.getMessage(store.getTurn(childTask.id)!.trigger_message_id!)!.task_id).toBe(f.leaderTask.id);
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
          && store.getTurnForAttempt(task.id)?.id === store.getTask(childTask.id)?.delegationReturnTaskId);
        expect(returns).toHaveLength(1);
        expect(returns[0]?.issueSessionId).toBe(f.leaderSession.id);
        const body = inboxReportBody(store, returns[0]!);
        expect(body).toContain(f.child.key);
        expect(body.split("\n")).toContain(`来源：${f.child.key}`);
        expect(body).toContain(comment.id);
        expect(body).toContain(`Status: ${terminal}`);
        expect(activities(store, f.parent.id, "delegation_return_triggered")).toHaveLength(1);
        expect(store.listTasksForIssue(f.child.id).filter((task) => task.agentId === f.leader.id)).toHaveLength(0);
        const bridge = store.listSessionEvents(f.leaderSession.id).find((event) =>
          event.kind === "message" && (event.metadata.message_source as {taskId?:string}|undefined)?.taskId === childTask.id);
        expect(bridge?.metadata.message_source).toMatchObject({ issueId: f.child.id, taskId: childTask.id, commentId: comment.id });
        expect(store.getMessage(bridge!.id)).toMatchObject({ message_kind: "report", wake_applied: "now", to_agent_id: f.leader.id });
        const projection = store.buildTaskSessionProjection(returns[0]!.id);
        expect(JSON.stringify(projection)).toContain(bridge!.id);
      }));
    }

    it("self requests keep an inbox-only message and human work has no delegation",async()=>withStore(backend,async store=>{
      const f=fixture(store),app=createMultiremiApp({store,authToken:"test-root"});
      const token=await store.createTaskAccessToken(f.leaderTask,"local");
      const before=store.listTasksForIssue(f.child.id).length;
      const response=await app.request(taskRequestPath(store,{issueId:f.child.id}),{method:"POST",headers:{Authorization:`Bearer ${token.token}`,"Content-Type":"application/json"},body:JSON.stringify(requestMessageBody(store,{agentId:f.leader.id,prompt:"Self request"}))});
      expect(response.status).toBe(200);
      const result=await response.json();
      expect(result).toMatchObject({wake_applied:"inbox_only",wake_reason:"self",message:{task_id:f.leaderTask.id}});
      expect(result.turn_id).toBeUndefined();expect(store.listTasksForIssue(f.child.id)).toHaveLength(before);
      const human=store.createTask({agentId:f.worker.id,issueId:f.child.id,prompt:"Human dispatch"});
      expect(human.delegationId).toBeNull();expect(human.delegationSkipReason).toBeNull();
      store.cancelTask(human.id);
      expect(activities(store,f.child.id,"delegation_return_skipped").filter(row=>(row.data as any).sourceTaskId===human.id)).toHaveLength(0);
    }));

    it("coalesces into the earliest queued leader round rather than selecting a manual wakeup by parent_task_id", async () => withStore(backend, async (store) => {
      const f = fixture(store);
      const childTask = await dispatch(store, f.leaderTask, f.child, f.worker.id);
      const manual = store.createTask({ agentId: f.leader.id, issueId: f.parent.id,
        issueSessionId: f.leaderSession.id, parentTaskId: childTask.id, prompt: "Wake up" });
      store.cancelTask(childTask.id);
      expect(store.getTask(childTask.id)?.delegationReturnTaskId).toBe(f.leaderTask.id);
      expect(store.getTask(manual.id)!.prompt).toBe("Wake up");
      expect(activities(store, f.parent.id, "turn_merged")
        .some((activity) => (activity.data as Record<string, unknown>).task_id === f.leaderTask.id))
        .toBe(true);
      const next = await dispatch(store, f.leaderTask, f.child, f.worker.id);
      const cancelled = store.createTask({ agentId: f.leader.id, issueId: f.parent.id,
        issueSessionId: f.leaderSession.id, parentTaskId: next.id, prompt: "Wake up" });
      store.cancelTask(cancelled.id);
      store.cancelTask(next.id);
      expect(store.getTask(next.id)?.delegationReturnTaskId).not.toBe(cancelled.id);
    }));

    it("keeps child status in the default owner lane and terminal reports in the dispatch lane",async()=>withStore(backend,async store=>{
      const f=fixture(store),child=await dispatch(store,f.leaderTask,f.child,f.worker.id);
      finishLeaderRound(store,f);expect(store.claimTask(f.workerRuntime.id)?.id).toBe(child.id);
      store.buildTaskSessionProjection(child.id);store.startTask(child.id);
      const delivery = store.submitIssueDelivery(f.child.id, { summary: "Child implementation complete" },
        { type: "agent", id: f.worker.id, taskId: child.id });
      const owner=store.getOrCreateDefaultIssueSession(f.parent.id);
      const statusTurn=store.listTasksForIssue(f.parent.id).find(task=>task.status==="queued"&&task.issueSessionId===owner.id)!;
      expect(statusTurn).toBeDefined();expect(owner.id).not.toBe(f.leaderSession.id);
      store.respondIssueDelivery(f.child.id, delivery.id,
        { action: "accept", revision: delivery.responsibilityRevision },
        { type: "agent", id: f.leader.id, taskId: statusTurn.id });
      expect(store.getIssue(f.child.id)?.status).toBe("done");
      store.completeTask(child.id,{output:"Finished after closing the child."});
      const returned=store.getTurn(store.getTask(child.id)!.delegationReturnTaskId!)!;
      expect(returned).toMatchObject({session_id:f.leaderSession.id,status:"pending"});
      expect(returned.id).not.toBe(store.getTurnForAttempt(statusTurn.id)!.id);
      expect(store.listTasksForIssue(f.parent.id).filter(task=>task.status==="queued")).toHaveLength(2);
      expect(inboxReportBody(store,store.getTask(returned.current_attempt_id!)!,child.id)).toContain("Finished after closing the child.");
    }));

    it("ignores a spoofed wake_source and trigger comment on a manual wakeup", async () => withStore(backend, async (store) => {
      const f = fixture(store);
      const childTask = await dispatch(store, f.leaderTask, f.child, f.worker.id);
      finishLeaderRound(store, f);
      const systemComment = store.createIssueComment(f.parent.id, { authorType: "system", authorId: null,
        body: "Spoofable system comment" });
      const app = createMultiremiApp({ store, authToken: "test-root" });
      const token = await store.createTaskAccessToken(childTask, "local");
      const response = await app.request(taskRequestPath(store, { issueId: f.parent.id, issue_session_id: f.leaderSession.id }), {
        method: "POST",
        headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(requestMessageBody(store, { agentId: f.leader.id, issueId: f.parent.id, prompt: "Wake up",
          parentTaskId: childTask.id, triggerCommentId: systemComment.id, wakeSource: "child_status",
          issue_session_id: f.leaderSession.id })),
      });
      expect(response.status).toBe(200);
      const manualId = sentTask(store, await response.json()).id;
      expect(store.getTask(manualId)?.wakeSource).toBe("agent_dispatch");
      expect(store.getTask(manualId)?.triggerCommentId).not.toBe(systemComment.id);
      expect(store.getTask(manualId)?.delegatedByAgentId).toBe(f.worker.id);
      const leaderTasksBefore = store.listTasksForIssue(f.parent.id)
        .filter((task) => task.agentId === f.leader.id).map((task) => task.id).sort();
      store.cancelTask(childTask.id);
      // Reverse task create is now independent delegated work in its own scope.
      const returned = store.getTask(store.getTask(childTask.id)!.delegationReturnTaskId!)!;
      expect(returned.id).not.toBe(manualId);
      expect(returned).toMatchObject({ agentId: f.leader.id,
        issueSessionId: f.leaderSession.id, wakeSource: "platform_to_owner" });
      expect(inboxReportBody(store, returned, childTask.id)).toContain("Status: cancelled");
      expect(store.listTasksForIssue(f.parent.id)
        .filter((task) => task.agentId === f.leader.id).map((task) => task.id).sort())
        .toEqual([...leaderTasksBefore, returned.id].sort());
    }));

    it("keeps the wake source across a redispatch attempt", async () => withStore(backend, async (store) => {
      const f = fixture(store);
      const childTask = await dispatch(store, f.leaderTask, f.child, f.worker.id);
      finishLeaderRound(store, f);
      expect(store.claimTask(f.workerRuntime.id)?.id).toBe(childTask.id);
      store.buildTaskSessionProjection(childTask.id);
      store.startTask(childTask.id);
      const delivery = store.submitIssueDelivery(f.child.id, { summary: "Child implementation complete" },
        { type: "agent", id: f.worker.id, taskId: childTask.id });
      const e2Round = store.listTasksForIssue(f.parent.id).find((task) => task.status === "queued" && task.issueSessionId === store.getOrCreateDefaultIssueSession(f.parent.id).id)!;
      store.respondIssueDelivery(f.child.id, delivery.id,
        { action: "accept", revision: delivery.responsibilityRevision },
        { type: "agent", id: f.leader.id, taskId: e2Round.id });
      expect(store.getIssue(f.child.id)?.status).toBe("done");
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
      expect(replacement.wakeSource).toBe("platform_to_owner");
      expect(store.listTasksForIssue(f.parent.id)
        .filter((task) => task.agentId === f.leader.id && task.status === "queued")
        .map((task) => task.id)).toEqual([replacement.id]);
      store.cancelTask(childTask.id);
      expect(store.getTask(childTask.id)?.delegationReturnTaskId).not.toBe(store.getTurnForAttempt(replacement.id)!.id);
      expect(store.getTurn(store.getTask(childTask.id)!.delegationReturnTaskId!)?.session_id).toBe(f.leaderSession.id);
    }));

    it("merges a failure's blocked report into its queued return", async () => withStore(backend, async (store, db) => {
      const f = fixture(store, db);
      const childTask = await dispatch(store, f.leaderTask, f.child, f.worker.id);
      finishLeaderRound(store, f);
      expect(store.claimTask(f.workerRuntime.id)?.id).toBe(childTask.id);
      store.buildTaskSessionProjection(childTask.id);
      store.startTask(childTask.id);
      store.failTask(childTask.id, { error: "Cannot proceed" });
      expect(store.getIssue(f.child.id)?.status).toBe("blocked");
      const queued = store.listTasksForIssue(f.parent.id).filter((task) => task.status === "queued" && task.issueSessionId === f.leaderSession.id);
      expect(queued).toHaveLength(1);
      expect(queued[0]?.issueSessionId).toBe(f.leaderSession.id);
      expect(store.listTasksForIssue(f.parent.id).filter(task=>task.status==="queued")).toHaveLength(2);
      expect(activities(store, f.parent.id, "delegation_return_triggered")).toHaveLength(1);
    }));

    it("bypasses the waiting-parent gate for a structural delegation return", async () => withStore(backend, async (store) => {
      const f = fixture(store);
      const childTask = await dispatch(store, f.leaderTask, f.child, f.worker.id);
      finishLeaderRound(store, f);
      const prerequisite = createResponsibleTestIssue(store, { title: "Prerequisite", status: "todo" });
      store.createIssueDependency(f.parent.id, { dependsOnIssueId: prerequisite.id, type: "blocked_by" });
      store.updateIssue(f.parent.id, { status: "backlog" });
      expect(store.getIssue(f.parent.id)?.status).toBe("backlog");
      store.cancelTask(childTask.id);
      expect(store.listTasksForIssue(f.parent.id)
        .filter((task) => task.agentId === f.leader.id && store.getTurnForAttempt(task.id)?.id === store.getTask(childTask.id)?.delegationReturnTaskId)).toHaveLength(1);
    }));

    // Cold PG setup dominates this case: 3.65-4.61s locally, 5.22s in CI.
    // Both baseline heads use 161/221 terminal queries with no lock wait.
    it("resolves the result comment once inside the terminal transaction", async () => withStore(backend, async (store) => {
      const f = fixture(store);
      const first = await dispatch(store, f.leaderTask, f.child, f.worker.id);
      finishLeaderRound(store, f);
      expect(store.claimTask(f.workerRuntime.id)?.id).toBe(first.id);
      store.buildTaskSessionProjection(first.id);
      store.startTask(first.id);
      // Cancellation has no automatic reply; the bell points to the source task.
      store.cancelTask(first.id);
      const withoutComment = store.listTasksForIssue(f.parent.id)
        .find((task) => task.agentId === f.leader.id && store.getTurnForAttempt(task.id)?.id === store.getTask(first.id)?.delegationReturnTaskId)!;
      expect(inboxReportBody(store, withoutComment)).toContain(`结论评论：无；结果见 remi turn get ${first.id}`);
      const bridgeWithout = store.listSessionEvents(f.leaderSession.id)
        .find((event) => event.kind === "message" && (event.metadata.message_source as any)?.taskId === first.id)!;
      expect((bridgeWithout.metadata.message_source as any).commentId).toBeUndefined();

      // Two comments: the newest by created_at/id wins. The terminal
      // transaction resolves it once and nothing rewrites the event later.
      // A terminal task revokes its own task token, so the second round runs
      // from a fresh leader turn. Consume the first return normally: cancelling
      // it would re-open the report and queue its own replacement ahead of the
      // new leader turn.
      expect(claimReturn(store,f.leaderRuntime.id,withoutComment.id)?.id).toBe(withoutComment.id);
      store.buildTaskSessionProjection(withoutComment.id);
      store.startTask(withoutComment.id);
      store.completeTask(withoutComment.id, { output: "Reviewed the first report.", sessionId: "reviewed_first_report" });
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
        .find((task) => task.agentId === f.leader.id && store.getTurnForAttempt(task.id)?.id === store.getTask(second.id)?.delegationReturnTaskId)!;
      expect(inboxReportBody(store, withComment)).toContain(`结论评论：${newest.id}`);
      expect(inboxReportBody(store, withComment)).toContain("Latest result text");
      const bridgeWith = store.listSessionEvents(f.leaderSession.id)
        .find((event) => event.kind === "message" && (event.metadata.message_source as any)?.taskId === second.id)!;
      expect((bridgeWith.metadata.message_source as any).commentId).toBe(newest.id);
      // The terminal snapshot must not rewrite the bridge event or append
      // another one for the same source task. Later
      // events from the E2 child-status round are unrelated to this report.
      const bridgeEvents = store.listSessionEvents(f.leaderSession.id)
        .filter((event) => event.kind === "message" && (event.metadata.message_source as any)?.taskId === second.id);
      expect(bridgeEvents).toHaveLength(1);
      expect((bridgeEvents[0]!.metadata.message_source as any).commentId).toBe(newest.id);
    }), backend === "postgres" ? 15_000 : 5_000);

    it("still completes and queues a result-pointer return when the transactional auto comment fails", async () => withStore(backend, async (store) => {
      const f = fixture(store);
      const childTask = await dispatch(store, f.leaderTask, f.child, f.worker.id);
      finishLeaderRound(store, f);
      expect(store.claimTask(f.workerRuntime.id)?.id).toBe(childTask.id);
      store.buildTaskSessionProjection(childTask.id);
      store.startTask(childTask.id);
      const write = spyOn(IssuesRepo.prototype, "createIssueCommentWithinTransaction").mockImplementation(() => {
        throw new Error("auto comment failed");
      });
      try {
        store.completeTask(childTask.id, { output: "Completed without an in-run comment" });
        expect(write).toHaveBeenCalledTimes(1);
      } finally {
        write.mockRestore();
      }
      expect(store.getTask(childTask.id)).toMatchObject({ status: "completed", result: null });
      expect(store.listIssueComments(f.child.id).filter(comment => comment.taskId === childTask.id)).toEqual([]);
      const returnTask = store.listTasksForIssue(f.parent.id)
        .find((task) => task.agentId === f.leader.id && store.getTurnForAttempt(task.id)?.id === store.getTask(childTask.id)?.delegationReturnTaskId)!;
      expect(returnTask).toBeTruthy();
      expect(inboxReportBody(store, returnTask)).toContain(`结论评论：无；结果见 remi turn get ${childTask.id}`);
      expect(inboxReportBody(store, returnTask)).toContain("Completed without an in-run comment");
      const bridge = store.listSessionEvents(f.leaderSession.id)
        .find((event) => event.kind === "message" && (event.metadata.message_source as {taskId?:string}|undefined)?.taskId === childTask.id)!;
      expect((bridge.metadata.message_source as any).commentId).toBeUndefined();
    }), pgScenarioTimeout);

    // Cold PG migrations plus five complete HTTP/task lifecycles take 4.94-5.26s
    // locally; retain every assertion while allowing this fixture to finish.
    it("drains five child reports into one round and marks the lane cursor covered", async () => withStore(backend, async (store) => {
      const f = fiveChildFixture(store);
      const app = createMultiremiApp({ store, authToken: "test-root" });
      const tokens = await Promise.all(f.children.map(() => store.createTaskAccessToken(f.leaderTask, "local")));
      const childTasks: MultiremiTask[] = [];
      for (let index = 0; index < f.children.length; index += 1) {
        const response = await app.request(taskRequestPath(store, { issueId: f.children[index]!.id }), { method: "POST",
          headers: { Authorization: `Bearer ${tokens[index]!.token}`, "Content-Type": "application/json" },
          body: JSON.stringify(requestMessageBody(store, { agentId: f.workers[index]!.id, issueId: f.children[index]!.id,
            prompt: `Investigate child ${index}` })) });
        expect(response.status).toBe(200);
        childTasks.push(store.getTask(sentTask(store, await response.json()).id)!);
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
        .filter((task) => task.status === "queued" && task.agentId === f.leader.id && task.issueSessionId === f.leaderSession.id);
      expect(queued).toHaveLength(1);
      expect(queued[0]?.issueSessionId).toBe(f.leaderSession.id);
      for (let index = 1; index < childTasks.length; index += 1) {
        expect(inboxReportBody(store, queued[0]!)).toContain(`Report ${index}`);
      }
      expect(store.listTasksForIssue(f.parent.id).filter((task) => task.status === "queued" && task.issueSessionId === f.leaderSession.id)).toHaveLength(1);
      expect(claimReturn(store,f.leaderRuntime.id,queued[0]!.id)?.id).toBe(queued[0]!.id);
      store.buildTaskSessionProjection(queued[0]!.id);
      store.startTask(queued[0]!.id);
      store.completeTask(queued[0]!.id, { output: "Reviewed all five." });
      // Every source is stamped by the same return, and a later drain finds
      // them covered instead of opening a second round.
      for (const childTask of childTasks) {
        expect(store.getTask(childTask.id)?.delegationReturnTaskId).toBe(queued[0]!.id);
      }
      const bridges = store.listSessionEvents(f.leaderSession.id)
        .filter((event) => event.kind === "message" && event.metadata.message_source && (event.metadata.message_source as any).taskId && store.getMessage(event.id)?.message_kind === "report");
      expect(bridges).toHaveLength(5);
      expect(new Set(bridges.map((event) => (event.metadata.message_source as any).taskId))).toEqual(new Set(childTasks.map((task) => task.id)));
    }), pgScenarioTimeout);

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
        const response = await app.request(taskRequestPath(store, { issueId: f.children[index]!.id }), { method: "POST",
          headers: { Authorization: `Bearer ${tokens[index]!.token}`, "Content-Type": "application/json" },
          body: JSON.stringify(requestMessageBody(store, { agentId: f.workers[index]!.id, issueId: f.children[index]!.id,
            prompt: `MUL-383 child ${index}` })) });
        expect(response.status).toBe(200);
        childTasks.push(store.getTask(sentTask(store, await response.json()).id)!);
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
        .filter((task) => task.status === "queued" && task.agentId === f.leader.id && task.issueSessionId === f.leaderSession.id);
      expect(queued).toHaveLength(1);
      expect(inboxReportBody(store, queued[0]!)).toContain("MUL-383 result 4");
      expect(activities(store, f.parent.id, "delegation_return_triggered")).toHaveLength(1);
      expect(store.listSessionEvents(f.leaderSession.id)
        .filter((event) => event.kind === "message" && event.metadata.message_source && (event.metadata.message_source as any).taskId && store.getMessage(event.id)?.message_kind === "report")).toHaveLength(5);
      // The leader never waited: every child report landed while the leader's
      // own round was already over, and the single queued return is claimable.
      expect(claimReturn(store,f.leaderRuntime.id,queued[0]!.id)?.id).toBe(queued[0]!.id);
    }), pgScenarioTimeout);
  });
}
