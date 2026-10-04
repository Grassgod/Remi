import { describe, expect, it } from "bun:test";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { createId } from "@multiremi/ids.js";
import { pairRoundTripLimit } from "@multiremi/store/repos/tasks-repo.js";
import { daemonTaskClaimResponse } from "@multiremi/api/wire/tasks.js";
import { useTaskSessionInput } from "@multiremi/api/daemon-protocol/offer-budget.js";
import { normalizeDaemonClaimTask } from "@multiremi/worker/client.js";
import { buildTaskPrompt } from "@daemon/agent-runtime/prompts/ephemeral.js";
import type { MultiremiIssue, MultiremiTask } from "@multiremi/contracts/types.js";
import { inboxReportBody, inboxReportEntry } from "./inbox-test-assertions.js";

const pgAdminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
let sequence = 0;
type Backend = "sqlite" | "postgres";
type Entry = "task" | "session" | "rerun";

async function withStore(backend: Backend, run: (store: MultiremiStore, db: SqlDatabase) => Promise<void>) {
  if (backend === "sqlite") {
    const db = openSqliteDatabase(":memory:");
    try {
      const store = new MultiremiStore(db);
      store.ensureLocalWorkspace();
      await run(store, db);
    } finally { db.close(); }
    return;
  }
  const admin = new Bun.SQL(pgAdminUrl!, { max: 1 });
  const name = `mul510_${process.pid}_${++sequence}`;
  const url = new URL(pgAdminUrl!);
  url.pathname = `/${name}`;
  let db: PostgresSyncDatabase | null = null;
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
    db = new PostgresSyncDatabase(url.toString());
    const store = new MultiremiStore(db);
    store.ensureLocalWorkspace();
    await run(store, db);
  } finally {
    db?.close();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
}

function fixture(store: MultiremiStore, humanAssigned = false) {
  const runtimes = ["QA", "Atlas", "Leader"].map(name =>
    store.registerRuntime({ name, provider: "claude", workspaceId: "local" }));
  const [qa, atlas, leader] = runtimes.map(runtime =>
    store.createAgent({ name: runtime.name, provider: "claude", runtimeId: runtime.id }));
  const parent = store.createIssue({ title: "Umbrella", status: "in_progress" });
  const a = store.createIssue({ title: "Unassigned source A", status: "in_progress", parentIssueId: parent.id,
    ...(humanAssigned ? { assigneeType: "agent", assigneeId: qa!.id } : {}) });
  const b = store.createIssue({ title: "Target B", status: "in_progress", parentIssueId: parent.id,
    assigneeType: "agent", assigneeId: atlas!.id });
  const s0 = store.createIssueSession(a.id, { title: "Original dispatcher S0" });
  const wrong = store.getOrCreateDefaultIssueSession(a.id);
  const s1 = store.createIssueSession(b.id, { title: "Target execution S1" });
  const source = store.createTask({ agentId: qa!.id, issueId: a.id, issueSessionId: s0.id, prompt: "Coordinate." });
  start(store, source);
  return { qa: qa!, atlas: atlas!, leader: leader!, a, b, s0, s1, wrong, source };
}

function start(store: MultiremiStore, task: MultiremiTask) {
  const runtimeId = store.getAgent(task.agentId)!.runtimeId!;
  expect(store.claimTask(runtimeId)?.id).toBe(task.id);
  store.buildTaskSessionProjection(task.id);
  store.startTask(task.id);
}

async function request(store: MultiremiStore, source: MultiremiTask | null, path: string, body: object) {
  const app = createMultiremiApp({ store, authToken: "test-root" });
  const credential = source ? (await store.createTaskAccessToken(source, "local")).token : "test-root";
  return app.request(path, { method: "POST",
    headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
    body: JSON.stringify(body) });
}

async function dispatchResponse(store: MultiremiStore, source: MultiremiTask | null, issue: MultiremiIssue,
  agentId: string, entry: Entry = "task", issueSessionId?: string) {
  const sessionId = issueSessionId ?? store.getOrCreateDefaultIssueSession(issue.id).id;
  const path = entry === "task" ? "/api/multiremi/tasks"
    : entry === "session" ? `/api/issues/${issue.id}/sessions/${sessionId}/tasks`
      : `/api/issues/${issue.id}/rerun`;
  return request(store, source, path, { agentId, issueId: issue.id, issueSessionId: sessionId,
    prompt: "Verify this work.", parentTaskId: "tsk_forged", parent_task_id: "tsk_forged",
    delegationId: "dlg_forged", delegated_by_agent_id: "agt_forged",
    delegatedFromIssueSessionId: sessionId, createdByType: "member", createdById: "forged" });
}

async function dispatch(store: MultiremiStore, source: MultiremiTask, issue: MultiremiIssue,
  agentId: string, entry: Entry = "task", sessionId?: string) {
  const response = await dispatchResponse(store, source, issue, agentId, entry, sessionId);
  expect(response.status).toBe(entry === "rerun" ? 202 : 201);
  const body = await response.json() as { id?: string; task?: { id: string } };
  return store.getTask(body.task?.id ?? body.id!)!;
}

async function mention(store: MultiremiStore, source: MultiremiTask, issue: MultiremiIssue,
  sessionId: string, agentId: string) {
  return request(store, source, `/api/multiremi/issues/${issue.id}/comments`, {
    issue_session_id: sessionId,
    body: `Concrete work [@Agent](mention://agent/${agentId}) [@Agent](mention://agent/${agentId})`,
    taskId: "tsk_forged", authorId: "agt_forged",
  });
}

function activity(store: MultiremiStore, issueId: string, type: string) {
  return store.listIssueActivity(issueId).filter(row => row.type === type);
}

async function withLimit<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env.MULTIREMI_AGENT_PAIR_ROUND_TRIP_LIMIT;
  if (value === undefined) delete process.env.MULTIREMI_AGENT_PAIR_ROUND_TRIP_LIMIT;
  else process.env.MULTIREMI_AGENT_PAIR_ROUND_TRIP_LIMIT = value;
  try { return await run(); }
  finally {
    if (previous === undefined) delete process.env.MULTIREMI_AGENT_PAIR_ROUND_TRIP_LIMIT;
    else process.env.MULTIREMI_AGENT_PAIR_ROUND_TRIP_LIMIT = previous;
  }
}

function sourceTaskId(store: MultiremiStore, task: MultiremiTask): string | null {
  const trigger = store.getTurn(task.id)?.trigger_message_id;
  return trigger ? store.getMessage(trigger)?.task_id ?? null : null;
}

async function chain(store: MultiremiStore, f: ReturnType<typeof fixture>, hops: number) {
  // Exercise durable request/report lineage; pending writes would merge in one lane.
  return withLimit("50", async () => {
    let source = f.source;
    if (hops % 2) {
      store.completeTask(source.id, { output: "Initial coordination finished." });
      source = store.createTask({ agentId: f.atlas.id, issueId: f.b.id,
        issueSessionId: f.s1.id, prompt: "Start the odd-hop chain." });
      start(store, source);
    }
    for (let count = 0; count < hops;) {
      const target = source.agentId === f.qa.id ? f.atlas : f.qa;
      const targetIssue = target.id === f.qa.id ? f.a : f.b;
      const targetSession = target.id === f.qa.id ? f.s0 : f.s1;
      const child = await dispatch(store, source, targetIssue, target.id, "task", targetSession.id);
      store.completeTask(source.id, { output: "Dispatched." });
      start(store, child);
      count++;
      source = child;
      if (count < hops) {
        store.completeTask(child.id, { output: "Result." });
        source = store.getTask(store.getTask(child.id)!.delegationReturnTaskId!)!;
        start(store, source);
        count++;
      }
    }
    return source;
  });
}

function expectDowngradedMessage(store: MultiremiStore, result: any, source: MultiremiTask, targetId: string) {
  expect(result).toMatchObject({ task: null, wake_applied: "next_turn", wake_reason: "pair_round_trip_limit" });
  const message = store.getMessage(result.message.id)!;
  expect(message).toMatchObject({ message_kind: "request", task_id: source.id, to_agent_id: targetId,
    wake_applied: "next_turn", wake_reason: "pair_round_trip_limit" });
  expect(message.body_md).toBe(result.message.body_md);
  expect(message.metadata.delivery_turn_id).toBeUndefined();
}

for (const backend of ["sqlite", "postgres"] as const) {
  const timeout = backend === "postgres" ? 180_000 : 15_000;
  describe.skipIf(backend === "postgres" && !pgAdminUrl)(`MUL-510 universal delegation (${backend})`, () => {
    for (const entry of ["task", "session", "rerun"] as const) {
      for (const terminal of ["completed", "failed", "cancelled"] as const) {
        it(`${entry}: returns ${terminal} from B/S1 to an unassigned A/S0 exactly once (C1/C1'/C2/C3)`,
          async () => withStore(backend, async store => {
            const f = fixture(store);
            const child = await dispatch(store, f.source, f.b, f.atlas.id, entry, f.s1.id);
            const targetSessionId = entry === "rerun" ? store.getOrCreateDefaultIssueSession(f.b.id).id : f.s1.id;
            expect(child).toMatchObject({ parentTaskId: null, delegatedByAgentId: f.qa.id,
              delegatedFromIssueSessionId: f.s0.id, issueSessionId: targetSessionId });
            expect(sourceTaskId(store, child)).toBe(f.source.id);
            expect(child.delegationId).toStartWith("dlg_");
            expect(child.delegationId).not.toBe("dlg_forged");
            store.completeTask(f.source.id, { output: "Dispatched." });
            start(store, child);
            const conclusion = store.createIssueComment(f.b.id, { issueSessionId: targetSessionId,
              authorType: "agent", authorId: f.atlas.id, taskId: child.id,
              body: "验收不通过：测试阻塞项" });
            const finish = () => terminal === "completed" ? store.completeTask(child.id, { output: "验收不通过：测试阻塞项" })
              : terminal === "failed" ? store.failTask(child.id, { error: "Verification failed" }) : store.cancelTask(child.id);
            finish();
            const returned = store.getTask(store.getTask(child.id)!.delegationReturnTaskId!)!;
            expect(returned).toMatchObject({ agentId: f.qa.id, issueId: f.a.id, issueSessionId: f.s0.id,
              parentTaskId: null, delegatedByAgentId: f.qa.id });
            expect(sourceTaskId(store, returned)).toBe(child.id);
            const body = inboxReportBody(store, returned, child.id);
            expect(body).toContain(`Status: ${terminal}\n来源：${f.b.key}\n`);
            expect(body).toContain(f.atlas.name);
            expect(body).toContain(`结论评论：${conclusion.id}`);
            if (terminal === "completed") expect(body).toContain("摘要：验收不通过");
            if (terminal === "failed") expect(body).toContain("摘要：Verification failed");
            if (terminal === "cancelled") expect(body).toContain("摘要：\n");
            expect(Buffer.byteLength(body)).toBeLessThan(2048);
            expect(store.listMessages(f.s0.id).filter(m => m.message_kind === "report" && (m.metadata.message_source as any)?.taskId === child.id))
              .toHaveLength(1);
            expect(store.listTasksForIssue(f.a.id).filter(t => t.issueSessionId === f.wrong.id)).toHaveLength(0);
            expect(store.listTasksForIssue(f.b.id).filter(t => t.agentId === f.qa.id)).toHaveLength(0);
            expect(finish).toThrow("Task not found or terminal");
            store.ensureDelegationWakeup({ sourceTaskId: child.id, requiredEventSeq: 1,
              terminalStatus: terminal, terminalBody: "Replay" });
            expect(activity(store, f.a.id, "delegation_return_triggered")).toHaveLength(1);
            expect(inboxReportEntry(store, returned, child.id).metadata.envelope?.wake).toBe("now");
            start(store, returned);
            const claimed = store.getTaskWithAgent(returned.id)!;
            const offer = daemonTaskClaimResponse(store, claimed, store.getTaskTriggerMetadata(claimed));
            useTaskSessionInput(store, claimed, offer);
            const daemonInput = buildTaskPrompt(normalizeDaemonClaimTask(offer)!);
            expect(daemonInput).toContain(f.b.key);
            expect(daemonInput).toContain(conclusion.id);
            const messages = (offer.session_projection as { jsonl: string }).jsonl.split("\n")
              .map(line => JSON.parse(line) as { type: string; body?: string });
            expect(messages.some(message => message.body?.includes(`Status: ${terminal}\n来源：${f.b.key}\n`)))
              .toBe(true);
            expect(inboxReportBody(store, returned, child.id)).toBe(body);
            store.completeTask(returned.id, { output: "Reviewed." });
            store.sweepIdleIssueLanes(Date.now() + 60_001);
            expect(store.listTasks("queued")).toHaveLength(0);
          }), timeout);
      }
    }

    for (const entry of ["task", "session"] as const) {
      it(`${entry}: reproduces a leader in unassigned A/S0 dispatching QA to B (C1/C1')`,
        async () => withStore(backend, async store => {
          const f = fixture(store);
          store.completeTask(f.source.id, { output: "QA first round ended." });
          const leaderSource = store.createTask({ agentId: f.leader.id, issueId: f.a.id,
            issueSessionId: f.s0.id, prompt: "Dispatch acceptance." });
          start(store, leaderSource);
          const child = await dispatch(store, leaderSource, f.b, f.qa.id, entry, f.s1.id);
          expect(child).toMatchObject({ delegatedByAgentId: f.leader.id, parentTaskId: null,
            delegatedFromIssueSessionId: f.s0.id, issueSessionId: f.s1.id });
          expect(sourceTaskId(store, child)).toBe(leaderSource.id);
          expect(store.getIssue(f.a.id)!.assigneeId).toBeNull();
          store.completeTask(leaderSource.id, { output: "Waiting for QA." });
          start(store, child);
          const conclusion = store.createIssueComment(f.b.id, { issueSessionId: f.s1.id,
            authorType: "agent", authorId: f.qa.id, taskId: child.id, body: "验收不通过：测试阻塞项" });
          store.completeTask(child.id, { output: "验收不通过：测试阻塞项" });
          const returned = store.getTask(store.getTask(child.id)!.delegationReturnTaskId!)!;
          expect(returned).toMatchObject({ agentId: f.leader.id, issueId: f.a.id, issueSessionId: f.s0.id });
          expect(inboxReportBody(store, returned, child.id)).toContain(`Status: completed\n来源：${f.b.key}\n`);
          expect(inboxReportBody(store, returned, child.id)).toContain(conclusion.id);
          expect(inboxReportBody(store, returned, child.id)).toContain("摘要：验收不通过");
          expect(store.listTasksForIssue(f.a.id).filter(t => t.issueSessionId === f.wrong.id)).toHaveLength(0);
          expect(store.listTasksForIssue(f.b.id).filter(t => t.agentId === f.leader.id)).toHaveLength(0);
        }), timeout);
    }

    for (const entry of ["task", "session", "mention"] as const) {
      it(`${entry}: a human-assigned QA delegates to Atlas in another ordinary Session on the same Issue`,
        async () => withStore(backend, async store => {
          const f = fixture(store, true);
          const targetSession = store.createIssueSession(f.a.id, { title: "Another ordinary session" });
          let child: MultiremiTask;
          if (entry === "mention") {
            expect((await mention(store, f.source, f.a, targetSession.id, f.atlas.id)).status).toBe(201);
            child = store.listTasksForIssue(f.a.id).find(t => t.agentId === f.atlas.id)!;
          } else child = await dispatch(store, f.source, f.a, f.atlas.id, entry, targetSession.id);
          // Same-Issue task credentials bind comments to the source Session.
          expect(child).toMatchObject({ issueSessionId: entry === "mention" ? f.s0.id : targetSession.id, delegatedByAgentId: f.qa.id,
            delegatedFromIssueSessionId: f.s0.id, parentTaskId: null });
          expect(sourceTaskId(store, child)).toBe(f.source.id);
          store.completeTask(f.source.id, { output: "Dispatched." });
          start(store, child);
          store.completeTask(child.id, { output: "Same Issue result." });
          const returned = store.getTask(store.getTask(child.id)!.delegationReturnTaskId!)!;
          expect(returned.issueSessionId).toBe(f.s0.id);
          expect(inboxReportBody(store, returned, child.id)).not.toContain("Issue:");
        }), timeout);
    }

    it("cross-Issue rich mentions coalesce only the same dispatcher and return Session; return @ stays a report",
      async () => withStore(backend, async store => {
        const f = fixture(store);
        expect((await mention(store, f.source, f.b, f.s1.id, f.atlas.id)).status).toBe(201);
        const child = store.listTasksForIssue(f.b.id)[0]!;
        expect(child).toMatchObject({ delegatedByAgentId: f.qa.id, delegatedFromIssueSessionId: f.s0.id,
          parentTaskId: null });
        expect(sourceTaskId(store, child)).toBe(f.source.id);
        expect((await mention(store, f.source, f.b, f.s1.id, f.atlas.id)).status).toBe(201);
        expect(store.listTasksForIssue(f.b.id)).toHaveLength(1);
        const otherSourceSession = store.createIssueSession(f.a.id, { title: "Other dispatcher Session" });
        const otherSource = store.createTask({ agentId: f.qa.id, issueId: f.a.id,
          issueSessionId: otherSourceSession.id, prompt: "Different work" });
        expect((await mention(store, otherSource, f.b, f.s1.id, f.atlas.id)).status).toBe(201);
        expect(store.listTasksForIssue(f.b.id)).toHaveLength(2);
        store.completeTask(f.source.id, { output: "Waiting." });
        start(store, child);
        const before = store.listTasks().length;
        expect((await mention(store, child, f.b, f.s1.id, f.qa.id)).status).toBe(201);
        const report = store.listTasksForIssue(f.a.id).find(t => sourceTaskId(store, t) === child.id)!;
        expect(report).toMatchObject({ agentId: f.qa.id, issueSessionId: f.s0.id,
          delegationId: child.delegationId, delegatedByAgentId: f.qa.id });
        expect(store.listTasks().length).toBe(before + 1);
      }), timeout);

    for (const leaderEntry of ["task", "mention"] as const) {
      it(`two dispatchers share B/S1 with leader ${leaderEntry} and QA ${leaderEntry === "task" ? "mention" : "task"}, then return independently (R10)`,
        async () => withStore(backend, async store => {
          const f = fixture(store);
          const leaderSession = store.createIssueSession(f.a.id, { title: "Leader S0" });
          const leaderSource = store.createTask({ agentId: f.leader.id, issueId: f.a.id,
            issueSessionId: leaderSession.id, prompt: "Independent leader dispatch." });
          start(store, leaderSource);
          const sources = [
            { task: leaderSource, entry: leaderEntry },
            { task: f.source, entry: leaderEntry === "task" ? "mention" : "task" },
          ] as const;
          for (const source of sources) {
            if (source.entry === "task") await dispatch(store, source.task, f.b, f.atlas.id, "task", f.s1.id);
            else expect((await mention(store, source.task, f.b, f.s1.id, f.atlas.id)).status).toBe(201);
          }
          const children = store.listTasksForIssue(f.b.id);
          expect(children).toHaveLength(2);
          expect(new Set(children.map(task => task.delegationId)).size).toBe(2);
          for (const { task: source } of sources) {
            const child = children.find(task => sourceTaskId(store, task) === source.id)!;
            expect(child.delegationId).toStartWith("dlg_");
            expect(child).toMatchObject({ agentId: f.atlas.id, issueSessionId: f.s1.id,
              delegatedByAgentId: source.agentId, delegatedFromIssueSessionId: source.issueSessionId });
            expect((await mention(store, source, f.b, f.s1.id, f.atlas.id)).status).toBe(201);
          }
          expect(store.listTasksForIssue(f.b.id)).toHaveLength(2);
          for (const { task: source } of sources) store.completeTask(source.id, { output: "Waiting for Atlas." });
          for (let i = 0; i < children.length; i++) {
            const child = store.claimTask(f.atlas.runtimeId!)!;
            expect(children.map(task => task.id)).toContain(child.id);
            store.buildTaskSessionProjection(child.id);
            store.startTask(child.id);
            store.completeTask(child.id, { output: `Result for ${child.delegatedByAgentId}.` });
          }
          const returnedIds = new Set<string>();
          for (const { task: source } of sources) {
            const child = children.find(task => sourceTaskId(store, task) === source.id)!;
            const returned = store.getTask(store.getTask(child.id)!.delegationReturnTaskId!)!;
            returnedIds.add(returned.id);
            expect(returned).toMatchObject({ agentId: source.agentId, issueId: f.a.id,
              issueSessionId: source.issueSessionId, parentTaskId: null,
              delegationId: child.delegationId, delegatedByAgentId: source.agentId });
            expect(sourceTaskId(store, returned)).toBe(child.id);
            expect(inboxReportBody(store, returned, child.id)).toContain(`Result for ${source.agentId}.`);
            expect(store.listMessages(source.issueSessionId!).filter(message => message.message_kind === "report")
              .map(message => (message.metadata.message_source as any)?.taskId)).toEqual([child.id]);
            start(store, returned);
            store.completeTask(returned.id, { output: "Reviewed independently." });
          }
          expect(returnedIds.size).toBe(2);
          expect(activity(store, f.a.id, "delegation_return_triggered")).toHaveLength(2);
          expect(store.listTasksForIssue(f.a.id).filter(task => task.issueSessionId === f.wrong.id)).toHaveLength(0);
          expect(store.listTasks("queued")).toHaveLength(0);
        }), timeout);
    }

    for (const assignment of ["explicit", "project_default", "reassign"] as const) {
      it(`agent ${assignment} assignment creates an undelegated first round with no return (E6)`,
        async () => withStore(backend, async store => {
          const f = fixture(store);
          const project = store.createProject({ title: "First-round project",
            defaultAssigneeType: "agent", defaultAssigneeId: f.atlas.id });
          store.updateIssue(f.a.id, { projectId: project.id });
          const targetAgentId = assignment === "explicit" ? f.leader.id : f.atlas.id;
          let issueId: string;
          if (assignment === "reassign") {
            const existing = store.createIssue({ title: "Previously assigned issue", projectId: project.id,
              assigneeType: "agent", assigneeId: f.leader.id, status: "in_progress" });
            expect(store.listTasksForIssue(existing.id)).toHaveLength(0);
            const response = await request(store, f.source, `/api/multiremi/issues/${existing.id}/assign`, {
              assigneeType: "agent", assigneeId: targetAgentId,
            });
            expect(response.status).toBe(200);
            issueId = existing.id;
          } else {
            const response = await request(store, f.source, "/api/issues", {
              title: `Agent-created ${assignment} issue`,
              ...(assignment === "explicit" ? { assignee_type: "agent", assignee_id: targetAgentId } : {}),
            });
            expect(response.status).toBe(201);
            const created = await response.json() as { id: string; task_id: string; dispatch_status: string };
            expect(created.dispatch_status).toBe("dispatched");
            expect(created.task_id).toBeTruthy();
            issueId = created.id;
          }
          expect(store.getIssue(issueId)).toMatchObject({ projectId: project.id,
            assigneeType: "agent", assigneeId: targetAgentId });
          const tasks = store.listTasksForIssue(issueId);
          expect(tasks).toHaveLength(1);
          const task = tasks[0]!;
          expect(task).toMatchObject({ agentId: targetAgentId, delegationId: null, delegatedByAgentId: null,
            delegatedFromIssueSessionId: null, delegationSkipReason: null, delegationReturnTaskId: null });
          const before = store.listTasks().length;
          start(store, task);
          store.completeTask(task.id, { output: "First round finished." });
          expect(store.getTask(task.id)).toMatchObject({ status: "completed", delegationReturnTaskId: null });
          expect(store.listTasks()).toHaveLength(before);
          for (const id of [f.a.id, issueId]) {
            expect(activity(store, id, "delegation_return_triggered")).toHaveLength(0);
            expect(activity(store, id, "delegation_return_skipped")).toHaveLength(0);
          }
          expect(store.listSessionEvents(f.s0.id).filter(event => event.kind === "delegation_report")).toHaveLength(0);
        }), timeout);
    }

    for (const executionMode of ["create_issue", "trigger_issue", "run_only"] as const) {
      it(`real ${executionMode} autopilot creates an undelegated task with no return (C4)`,
        async () => withStore(backend, async store => {
          const f = fixture(store);
          const autopilot = store.createAutopilot({ title: `Automatic ${executionMode} work`,
            assigneeId: f.atlas.id, executionMode, createdByType: "agent", createdById: f.qa.id });
          const run = store.runAutopilot(autopilot.id, { sourceTaskId: f.source.id,
            ...(executionMode === "trigger_issue" ? { triggerIssueId: f.b.id } : {}) });
          expect(run.status).toBe("running");
          expect(run.taskId).toBeTruthy();
          const task = store.getTask(run.taskId!)!;
          expect(task).toMatchObject({ status: "queued", agentId: f.atlas.id, autopilotRunId: run.id, parentTaskId: null,
            delegationId: null, delegatedByAgentId: null, delegatedFromIssueSessionId: null,
            delegationSkipReason: null, delegationReturnTaskId: null });
          expect(sourceTaskId(store, task)).toBe(f.source.id);
          if (executionMode === "run_only") expect(task.issueId).toBeNull();
          else expect(task.issueId).toBe(run.issueId);
          const before = store.listTasks().length;
          start(store, task);
          store.completeTask(task.id, { output: "Automatic work finished." });
          expect(store.getTask(task.id)).toMatchObject({ status: "completed", delegationReturnTaskId: null });
          expect(store.listAutopilotRuns(autopilot.id)[0]?.status).toBe("completed");
          expect(store.listTasks()).toHaveLength(before);
          for (const id of new Set([f.a.id, task.issueId].filter((id): id is string => id !== null))) {
            expect(activity(store, id, "delegation_return_triggered")).toHaveLength(0);
            expect(activity(store, id, "delegation_return_skipped")).toHaveLength(0);
          }
          expect(store.listSessionEvents(f.s0.id).filter(event => event.kind === "delegation_report")).toHaveLength(0);
        }), timeout);
    }

    for (const limit of [1, 2, 5]) {
      it(`real dispatch/terminal-return loop downgrades dispatch ${limit + 1} at L=${limit}`,
        async () => withLimit(limit === 5 ? undefined : String(limit), () => withStore(backend, async store => {
          const f = fixture(store);
          let source = f.source;
          for (let round = 0; round < limit; round++) {
            expect(store.countDelegationPairHops(source, f.atlas.id)).toBe(2 * round);
            const child = await dispatch(store, source, f.b, f.atlas.id, "task", f.s1.id);
            store.completeTask(source.id, { output: "Dispatched." });
            start(store, child);
            store.completeTask(child.id, { output: "Result." });
            source = store.getTask(store.getTask(child.id)!.delegationReturnTaskId!)!;
            start(store, source);
          }
          expect(store.countDelegationPairHops(source, f.atlas.id)).toBe(2 * limit);
          const before = store.listTasks().length;
          for (const entry of ["task", "session", "rerun"] as const) {
            const response = await dispatchResponse(store, source, f.b, f.atlas.id, entry, f.s1.id);
            expect(response.status).toBe(200);
            expectDowngradedMessage(store, await response.json(), source, f.atlas.id);
            expect(store.listTasks().length).toBe(before);
          }
          expect((await mention(store, source, f.b, f.s1.id, f.atlas.id)).status).toBe(201);
          expect(store.listTasks().length).toBe(before);
          const newSession = store.createIssueSession(f.b.id, { title: "No prior delegation lane" });
          expect((await mention(store, source, f.b, newSession.id, f.atlas.id)).status).toBe(201);
          expect(store.listTasks().length).toBe(before);
          const limitedMentions = store.listMessages(newSession.id).filter(m => m.to_agent_id === f.atlas.id);
          expect(limitedMentions).toHaveLength(1);
          expect(limitedMentions[0]).toMatchObject({ wake_applied: "next_turn", wake_reason: "pair_round_trip_limit" });
          const notices = store.listConversationLogEntries(f.s0.id).filter(e =>
            e.metadata.envelope?.dedupeKey === `pair_round_trip_limit:${source.id}:${f.atlas.id}`);
          expect(notices).toHaveLength(1);
          expect(notices[0]!.metadata.envelope?.wake).toBe("inbox_only");
          expect(notices[0]!.body_md).toContain(f.qa.name);
          expect(notices[0]!.body_md).toContain(f.atlas.name);
          expect(notices[0]!.body_md).toContain(`${limit} 次上限`);
          expect(activity(store, f.a.id, "delegation_round_trip_limited")).toHaveLength(1);
          expect(activity(store, f.b.id, "delegation_round_trip_limited")).toHaveLength(1);
          store.createIssueComment(f.a.id, { issueSessionId: f.wrong.id, authorType: "member", body: "Other Session" });
          store.createIssueComment(f.b.id, { issueSessionId: f.s1.id, authorType: "member", body: "Other Issue" });
          store.createIssueComment(f.a.id, { issueSessionId: f.s0.id, authorType: "system", body: "System message" });
          expect(store.countDelegationPairHops(source, f.atlas.id)).toBe(2 * limit);
          store.createIssueComment(f.a.id, { issueSessionId: f.s0.id, authorType: "member", body: "Human intervention" });
          expect(store.countDelegationPairHops(source, f.atlas.id)).toBe(0);
          expect((await dispatchResponse(store, source, f.b, f.atlas.id)).status).toBe(201);
        })), timeout);
    }

    it("checks 2L-1, 2L, 2L+1 boundaries and invalid environment fallback without schema changes",
      async () => withStore(backend, async store => {
        for (const value of [undefined, "0", "-1", "not-a-number", "1.5", "Infinity"]) {
          await withLimit(value, async () => expect(pairRoundTripLimit()).toBe(5));
        }
        for (const limit of [1, 2, 5]) await withLimit(String(limit), async () => {
          for (const hops of [2 * limit - 1, 2 * limit, 2 * limit + 1]) {
            await withStore(backend, async isolated => {
              const f = fixture(isolated);
              const source = await chain(isolated, f, hops);
              const before = isolated.listTasksForIssue(f.b.id).length;
              const response = await dispatchResponse(isolated, source, f.b, f.atlas.id);
              expect(response.status).toBe(hops < 2 * limit ? 201 : 200);
              const result = await response.json();
              if (hops >= 2 * limit) expectDowngradedMessage(isolated, result, source, f.atlas.id);
              else expect(sourceTaskId(isolated, isolated.getTask(result.task.id)!)).toBe(source.id);
              expect(isolated.listTasksForIssue(f.b.id).length).toBe(before + (hops < 2 * limit ? 1 : 0));
            });
          }
        });
      }), timeout);

    it("a third agent, missing delegation or repeated agent ends only the current pair segment",
      async () => withStore(backend, async (store, db) => {
        const f = fixture(store);
        const source = await chain(store, f, 4);
        expect(store.countDelegationPairHops(source, f.atlas.id)).toBe(4);
        expect(store.countDelegationPairHops(source, f.leader.id)).toBe(1);
        const third = await dispatch(store, source, f.a, f.leader.id, "task", f.s0.id);
        const afterThird = await dispatch(store, third, f.a, f.qa.id, "task", f.s0.id);
        expect(store.countDelegationPairHops(afterThird, f.atlas.id)).toBe(1);
        // Corrupt one edge of the real four-hop chain to probe the stop conditions.
        const trigger = store.getTurn(source.id)!.trigger_message_id!;
        const originalParent = store.getMessage(trigger)!.task_id!;
        db.run("UPDATE multiremi_conversation_log SET task_id=? WHERE id=?", [source.id, trigger]);
        expect(store.countDelegationPairHops(source, f.atlas.id)).toBe(1);
        db.run("UPDATE multiremi_conversation_log SET task_id=? WHERE id=?", [originalParent, trigger]);
        const parent = store.getTurn(originalParent)!;
        db.run("UPDATE multiremi_turns SET agent_id=? WHERE id=?", [source.agentId, parent.id]);
        expect(store.countDelegationPairHops(source, f.atlas.id)).toBe(1);
        db.run("UPDATE multiremi_turns SET agent_id=? WHERE id=?", [parent.agent_id, parent.id]);
        db.run("UPDATE multiremi_turns SET delegation_id=NULL WHERE id=?", [parent.id]);
        expect(store.countDelegationPairHops(source, f.atlas.id)).toBe(1);
        db.run("UPDATE multiremi_turns SET delegation_id=? WHERE id=?", [parent.delegation_id, parent.id]);
        expect(store.countDelegationPairHops(source, f.atlas.id)).toBe(4);
      }), timeout);

    it("human creation has no delegation or terminal audit; self/Chat/no-target dispatch has explicit skip reasons",
      async () => withStore(backend, async store => {
        const f = fixture(store);
        const humanResponse = await dispatchResponse(store, null, f.b, f.atlas.id);
        expect(humanResponse.status).toBe(201);
        const humanId = ((await humanResponse.json()) as { task: { id: string } }).task.id;
        const human = store.getTask(humanId)!;
        expect(human).toMatchObject({ parentTaskId: null, delegationId: null, delegationSkipReason: null });
        store.cancelTask(human.id);
        expect(activity(store, f.b.id, "wake_downgraded").filter(row =>
          (row.data as { sourceTaskId?: string }).sourceTaskId === human.id)).toHaveLength(0);
        for (const issue of [f.a, f.b]) {
          const before = store.listTasks().length;
          const response = await dispatchResponse(store, f.source, issue, f.qa.id);
          expect(response.status).toBe(200);
          const result = await response.json();
          expect(result).toMatchObject({ task: null, wake_applied: "inbox_only", wake_reason: "self" });
          expect(store.getMessage(result.message.id)).toMatchObject({ task_id: f.source.id, to_agent_id: f.qa.id, wake_reason: "self" });
          expect(store.listTasks()).toHaveLength(before);
        }
        expect((await mention(store, f.source, f.a, f.s0.id, f.qa.id)).status).toBe(201);
        expect(store.listMessages(f.s0.id).some(message => message.wake_reason === "self" && message.to_agent_id === f.qa.id)).toBeTrue();
        const detached = store.createTask({ agentId: f.qa.id, prompt: "No Issue source" });
        const chat = store.createChatSession({ agentId: f.qa.id, creatorId: "local" });
        const chatSource = store.createTask({ agentId: f.qa.id, chatSessionId: chat.id, prompt: "Chat source" });
        for (const source of [detached, chatSource]) {
          for (const entry of ["task", "session"] as const) {
            const before = store.listTasks().length;
            const response = await dispatchResponse(store, source, f.b, f.atlas.id, entry);
            expect(response.status).toBe(200);
            const result = await response.json();
            expect(result).toMatchObject({ task: null, wake_applied: "next_turn", wake_reason: "no_issue_target" });
            expect(store.getMessage(result.message.id)?.task_id).toBe(source.id);
            expect(store.listTasks()).toHaveLength(before);
          }
        }
        const before = store.listTasks().length;
        const response = await request(store, f.source, "/api/multiremi/tasks", { agentId: f.atlas.id, prompt: "No target Issue" });
        expect(response.status).toBe(200);
        const result = await response.json();
        expect(result).toMatchObject({ task: null, wake_applied: "next_turn", wake_reason: "no_issue_target" });
        expect(store.getMessage(result.message.id)?.task_id).toBe(f.source.id);
        expect(store.listTasks()).toHaveLength(before);
      }), timeout);

    it("continue inherits lineage but cannot evade the pair limit or cross-Session authorization",
      async () => withLimit("2", () => withStore(backend, async store => {
        const f = fixture(store);
        let source = f.source;
        let previous: MultiremiTask | null = null;
        for (let round = 0; round < 2; round++) {
          const child = await dispatch(store, source, f.a, f.atlas.id, "task", f.s0.id);
          previous ??= child;
          store.completeTask(source.id, { output: "Dispatched." });
          start(store, child);
          store.completeTask(child.id, { output: "Completed." });
          source = store.getTask(store.getTask(child.id)!.delegationReturnTaskId!)!;
          start(store, source);
        }
        expect(store.countDelegationPairHops(source, f.atlas.id)).toBe(4);
        const foreign = await withLimit("50", () => dispatch(store, source, f.b, f.atlas.id, "task", f.s1.id));
        const before = store.listTasks().length;
        const response = await request(store, source, "/api/multiremi/tasks", {
          agentId: f.atlas.id, continueTaskId: previous!.id, prompt: "Another round" });
        expect(response.status).toBe(200);
        expectDowngradedMessage(store, await response.json(), source, f.atlas.id);
        expect(store.listTasks().length).toBe(before);
        const cross = await request(store, source, "/api/multiremi/tasks", {
          agentId: f.atlas.id, continueTaskId: foreign.id, prompt: "Cross-Session continuation" });
        expect(cross.status).toBe(400);
        expect(store.listTasks().length).toBe(before);
      })), timeout);

    for (const recovery of ["retry_success", "retry_exhausted", "redispatch"] as const) {
      it(`${recovery}: universal delegation keeps the original dispatcher and reports only its final successor (C7)`,
        async () => withStore(backend, async store => {
          const f = fixture(store);
          const original = await dispatch(store, f.source, f.b, f.atlas.id);
          store.completeTask(f.source.id, { output: "Dispatched." });
          start(store, original);
          let final: MultiremiTask;
          if (recovery === "redispatch") {
            store.updateWorkspace("local", { settings: { organizer: { mode: "act" } } });
            const supervisor = store.createAgent({ name: "Supervisor", provider: "claude", role: "supervisor", runtimeId: f.leader.runtimeId });
            const supervisorTask = store.createTask({ agentId: supervisor.id, issueId: f.a.id, prompt: "Supervise." });
            final = store.performOrganizerAction({ supervisorTaskId: supervisorTask.id, supervisorAgentId: supervisor.id,
              targetTaskId: original.id, action: "redispatch", reason: "Change execution attempt" }).replacementTask!;
          } else {
            store.failTask(original.id, { error: "Infrastructure unavailable", failureReason: "runtime_offline" });
            final = store.listTasksForIssue(f.b.id).find(t => t.parentTaskId === original.id && t.agentId === f.atlas.id)!;
          }
          expect(final).toMatchObject({ delegationId: original.delegationId, delegatedByAgentId: f.qa.id,
            delegatedFromIssueSessionId: f.s0.id, parentTaskId: original.id });
          expect(store.getTask(original.id)!.delegationReturnTaskId).toBeNull();
          expect(activity(store, f.a.id, "delegation_return_triggered")).toHaveLength(0);
          start(store, final);
          if (recovery === "retry_exhausted") {
            store.failTask(final.id, { error: "Second failure", failureReason: "runtime_offline" });
            final = store.listTasksForIssue(f.b.id).find(t => t.parentTaskId === final.id && t.agentId === f.atlas.id)!;
            start(store, final);
            store.failTask(final.id, { error: "Final failure", failureReason: "runtime_offline" });
          } else store.completeTask(final.id, { output: "Final success" });
          const returned = store.getTask(store.getTask(final.id)!.delegationReturnTaskId!)!;
          expect(returned).toMatchObject({ agentId: f.qa.id, issueSessionId: f.s0.id });
          expect(activity(store, f.a.id, "delegation_return_triggered")).toHaveLength(1);
          expect(inboxReportBody(store, returned, final.id)).toContain(recovery === "retry_exhausted" ? "Status: failed" : "Status: completed");
          expect(() => store.completeTask(original.id, { output: "Late old attempt" })).toThrow("Task not found or terminal");
          store.ensureDelegationWakeup({ sourceTaskId: original.id, requiredEventSeq: 1,
            terminalStatus: "failed", terminalBody: "Late old attempt" });
          expect(activity(store, f.a.id, "delegation_return_triggered")).toHaveLength(1);
        }), timeout);
    }
  });
}
