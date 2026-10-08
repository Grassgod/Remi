import { appendCanonicalInboxInput } from "./fixtures/canonical-inbox-input.js";
import { runTurnExecutionMutation } from '@multiremi/store/turn-execution-records.js';
import type { SqlDatabase as UnifiedFixtureDatabase } from '@multiremi/store/db/postgres.js';
import { describe, expect, it } from "bun:test";
import { createCommitEventQueue } from "@multiremi/store/context.js";
import { createMultiremiApp } from "@multiremi/api.js";
import { daemonTaskClaimResponse } from "@multiremi/api/wire/tasks.js";
import { conversationLogPgAdminUrl as pgAdminUrl, withConversationLogStore as withStore } from "./fixtures/conversation-log-store.js";
import type { MultiremiStore } from "@multiremi/store.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";

function sendIssueWake(store: MultiremiStore, db: SqlDatabase, sessionId: string, agentId: string,
  wake: "now" | "next_turn" | "inbox_only", body: string) {
  return db.transaction(() => store.sendEnvelopeWithinTransaction({
    to: { role: "agent", issueSessionId: sessionId, agentId },
    kind: "report", wake, body, source: {},
  }, [], createCommitEventQueue())[0]!)();
}

function wakeSeq(db: SqlDatabase, taskId: string): number {
  return Number(db.query("SELECT wake_seq FROM multiremi_turn_execution_records WHERE id = ?").get(taskId).wake_seq);
}

/** Simulate an already committed business consumer, independent of provider reads. */
function coverBusiness(db:SqlDatabase,store:MultiremiStore,taskId:string,toSeq:number){
  const task=store.getTask(taskId)!;
  const turn=store.getTurn(task.turn_id!)!;
  db.run(`INSERT INTO multiremi_turns(id,session_id,seq,agent_id,execution_scope,status,input_to_seq,workspace_id,created_at)
    VALUES(?,?,?,?,?,'completed',?,?,?)`,[crypto.randomUUID(),turn.session_id,turn.seq+100_000,turn.agent_id,turn.execution_scope,toSeq,turn.workspace_id,'2026-01-01']);
}

describe("MUL-484 inbox delivery and pending turns", () => {
  for (const backend of ["sqlite", "pg"] as const) {
    const test = it.skipIf(backend === "pg" && !pgAdminUrl);



    for (const wake of ["now", "next_turn", "inbox_only", "self_now"] as const) {
      test(`${backend}: ${wake} during a running round rerings only unread external now`, async () => {
        await withStore(backend, (store, db) => {
          store.ensureLocalWorkspace();
          const runtime = store.registerRuntime({ name: "Inbox runtime", provider: "codex" });
          const agent = store.createAgent({ name: "Inbox owner", provider: "codex", runtimeId: runtime.id });
          const issue = store.createIssue({ title: "Ring", status: "in_progress", assigneeType: "agent", assigneeId: agent.id });
          const session = store.getOrCreateDefaultIssueSession(issue.id);
          const task = store.createSessionTask(session.id, { agentId: agent.id, prompt: "First round" });
          expect(store.claimTask(runtime.id)?.id).toBe(task.id);
          daemonTaskClaimResponse(store, store.getTaskWithAgent(task.id)!);
          store.startTask(task.id);
          if (wake === "self_now") {
            appendCanonicalInboxInput(store, { sessionId: session.id, kind: "system", authorType: "agent", authorId: agent.id,
              bodyMd: "Own message", metadata: { envelope: {
                to: { role: "agent", issueSessionId: session.id, agentId: agent.id },
                kind: "report", wake: "now", source: {}, priority: 3,
              } } });
          } else {
            db.transaction(() => store.sendEnvelopeWithinTransaction({
              to: { role: "agent", issueSessionId: session.id, agentId: agent.id },
              kind: "report", wake, body: "External update", source: {},
            }, [], createCommitEventQueue()))();
          }
          store.completeTask(task.id, { output: "Done", sessionId: "provider_ring" });
          const queued = store.listTasksForIssue(issue.id).filter(row => row.status === "queued");
          expect(queued).toHaveLength(wake === "now" ? 1 : 0);
          const rings = db.query("SELECT data FROM multiremi_issue_activity WHERE issue_id = ? AND type = 're_ring'").all(issue.id) as Array<{ data: string }>;
          expect(rings).toHaveLength(wake === "now" ? 1 : 0);
          if (wake === "now") expect(JSON.parse(rings[0]!.data)).toMatchObject({ action: "created" });
        });
      }, 30_000);
    }

    for (const terminal of ["completed", "cancelled"] as const) {
      test(`${backend}: ${terminal} creates one re-ring turn for unread now without a queued task`, async () => {
        await withStore(backend, (store, db) => {
          store.ensureLocalWorkspace();
          const runtime = store.registerRuntime({ name: "Inbox runtime", provider: "codex" });
          const agent = store.createAgent({ name: "Inbox owner", provider: "codex", runtimeId: runtime.id });
          const issue = store.createIssue({ title: "Ring fallback", status: "in_progress", assigneeType: "agent", assigneeId: agent.id });
          const session = store.getOrCreateDefaultIssueSession(issue.id);
          const task = store.createSessionTask(session.id, { agentId: agent.id, prompt: "First round" });
          expect(store.claimTask(runtime.id)?.id).toBe(task.id);
          const projection = daemonTaskClaimResponse(store, store.getTaskWithAgent(task.id)!).session_projection as { to_seq: number };
          store.startTask(task.id);
          const entry = appendCanonicalInboxInput(store, { sessionId: session.id, kind: "system", authorType: "system",
            bodyMd: "Arrived while running", metadata: { envelope: {
              to: { role: "agent", issueSessionId: session.id, agentId: agent.id },
              kind: "report", wake: "now", source: {}, priority: 3,
            } } });
          if (terminal === "completed") store.completeTask(task.id, { output: "Done", sessionId: "provider_ring" });
          else store.cancelTask(task.id);
          const queued = store.listTasksForIssue(issue.id).filter(row => row.status === "queued");
          expect(queued).toHaveLength(1);
          expect(queued[0]).toMatchObject({ wakeSource: "platform_to_owner", triggerCommentId: entry.id });
          expect(queued[0]!.prompt).toBe(entry.body_md);
          const wakeSeq = Number(db.query("SELECT wake_seq FROM multiremi_turn_execution_records WHERE id = ?").get(queued[0]!.id).wake_seq);
          expect(wakeSeq).toBe(entry.seq);
          const cursor = store.getSessionAgentLane(session.id, agent.id)?.cursorSeq ?? 0;
          expect(cursor).toBe(0);
          const ring = db.query("SELECT data FROM multiremi_issue_activity WHERE issue_id = ? AND type = 're_ring'").get(issue.id) as { data: string };
          expect(JSON.parse(ring.data)).toMatchObject({ action: "created", task_id: queued[0]!.id });
        });
      }, 30_000);
    }

    test(`${backend}: business-covered pending turns cancel once and later requests remain claimable`,async()=>{
      await withStore(backend,(store,db)=>{
        const runtime=store.registerRuntime({name:"Coverage",provider:"codex"});
        const agent=store.createAgent({name:"Owner",provider:"codex",runtimeId:runtime.id});
        const issue=store.createIssue({title:"Coverage",assigneeType:"agent",assigneeId:agent.id});
        const session=store.getOrCreateDefaultIssueSession(issue.id);
        const covered=sendIssueWake(store,db,session.id,agent.id,"now","Covered work").task!;
        coverBusiness(db,store,covered.id,wakeSeq(db,covered.id));
        expect(store.claimTask(runtime.id)).toBeNull();
        expect(store.getTask(covered.id)?.status).toBe("cancelled");
        const skips=()=>store.listIssueActivity(issue.id).filter(row=>row.type==='wake_downgraded'&&(row.data as {reason?:string})?.reason==='already_covered');
        expect(skips()).toHaveLength(1);expect(store.claimTask(runtime.id)).toBeNull();expect(skips()).toHaveLength(1);
        const human=store.createSessionTask(session.id,{agentId:agent.id,prompt:"New human work"});
        expect(store.claimTask(runtime.id)?.id).toBe(human.id);
        store.completeTask(human.id,{output:"Done"});
        const unread=sendIssueWake(store,db,session.id,agent.id,"now","Unread now").task!;
        expect(store.claimTask(runtime.id)?.id).toBe(unread.id);expect(skips()).toHaveLength(1);
      });
    },60_000);

    test(`${backend}: an unmerged system wake with wake_seq zero remains claimable`, async () => {
      await withStore(backend, (store, db) => {
        store.ensureLocalWorkspace();
        const runtime = store.registerRuntime({ name: "Legacy runtime", provider: "codex" });
        const agent = store.createAgent({ name: "Legacy owner", provider: "codex", runtimeId: runtime.id });
        const issue = store.createIssue({ title: "Legacy wake", status: "in_progress", assigneeType: "agent", assigneeId: agent.id });
        const session = store.getOrCreateDefaultIssueSession(issue.id);
        const task = store.createTask({ agentId: agent.id, issueId: issue.id, issueSessionId: session.id,
          prompt: "Legacy system round", wakeSource: "child_status" });
        db.run("UPDATE multiremi_turns SET wake_seq=0 WHERE current_attempt_id=?",[task.id]);
        expect(Number(db.query("SELECT wake_seq FROM multiremi_turn_execution_records WHERE id = ?").get(task.id).wake_seq)).toBe(0);
        expect(store.claimTask(runtime.id)?.id).toBe(task.id);
        const skipped = db.query("SELECT id FROM multiremi_issue_activity WHERE issue_id = ? AND type = 'wake_downgraded' AND data LIKE '%already_covered%'").all(issue.id);
        expect(skipped).toHaveLength(0);
      });
    }, 30_000);

    test(`${backend}: requeue clears the frozen projection and includes later entries`, async () => {
      await withStore(backend, (store, db) => {
        store.ensureLocalWorkspace();
        const firstRuntime = store.registerRuntime({ name: "First runtime", provider: "codex" });
        const nextRuntime = store.registerRuntime({ name: "Next runtime", provider: "codex" });
        const agent = store.createAgent({ name: "Moved owner", provider: "codex", runtimeId: firstRuntime.id });
        const issue = store.createIssue({ title: "Requeue", status: "in_progress", assigneeType: "agent", assigneeId: agent.id });
        const session = store.createIssueSession(issue.id, { title: "Requeue lane", withCode: false, holdsWorkspace: false });
        const task = store.createSessionTask(session.id, { agentId: agent.id, prompt: "Initial" });
        expect(store.claimTask(firstRuntime.id)?.id).toBe(task.id);
        const first = daemonTaskClaimResponse(store, store.getTaskWithAgent(task.id)!).session_projection as { to_seq: number };
        expect(store.findTurnEntry(task.id)?.metadata.inbox?.delivered_to_seq).toBe(first.to_seq);
        const later = store.appendConversationLog({ sessionId: session.id, kind: "system", authorType: "system", bodyMd: "Later update" });
        expect(later.seq).toBeGreaterThan(first.to_seq);
        db.run("UPDATE multiremi_agents SET runtime_id = ? WHERE id = ?", [nextRuntime.id, agent.id]);
        const stale = new Date(Date.now() - 120_000).toISOString();
        runTurnExecutionMutation(db as unknown as UnifiedFixtureDatabase, "UPDATE multiremi_turn_execution_records SET dispatched_at = ? WHERE id = ?", [stale, task.id]);
        expect(store.claimTask(firstRuntime.id)).toBeNull();
        expect(store.getTask(task.id)).toMatchObject({ status: "queued", runtimeId: null,
          projectionFromSeq: null, projectionToSeq: null, projectionMode: null,
          inheritedProjectionToSeq: null });
        const repooled = db.query("SELECT inherited_projection_from_seq, inherited_projection_to_seq FROM multiremi_turn_execution_records WHERE id = ?")
          .get(task.id);
        expect(repooled).toEqual({ inherited_projection_from_seq: null, inherited_projection_to_seq: null });
        db.run("UPDATE multiremi_agents SET runtime_id = ? WHERE id = ?", [firstRuntime.id, agent.id]);
        expect(store.claimTask(firstRuntime.id)?.id).toBe(task.id);
        const second = daemonTaskClaimResponse(store, store.getTaskWithAgent(task.id)!).session_projection as { to_seq: number };
        expect(second.to_seq).toBeGreaterThanOrEqual(later.seq);
        expect(store.findTurnEntry(task.id)?.metadata.inbox?.delivered_to_seq).toBe(second.to_seq);
        expect(store.getTask(task.id)?.runtimeId).toBe(firstRuntime.id);
      });
    }, 30_000);

    test(`${backend}: a coalesced delegation return is skipped at claim only after its report is covered`, async () => {
      await withStore(backend, (store, db) => {
        store.ensureLocalWorkspace();
        const runtime = store.registerRuntime({ name: "Return runtime", provider: "codex" });
        const leader = store.createAgent({ name: "Leader", provider: "codex", runtimeId: runtime.id });
        const worker = store.createAgent({ name: "Worker", provider: "codex", runtimeId: runtime.id });
        const issue = store.createIssue({ title: "Return", status: "in_progress", assigneeType: "agent", assigneeId: leader.id });
        const session = store.getOrCreateDefaultIssueSession(issue.id);
        const source = store.createTask({ agentId: worker.id, issueId: issue.id, issueSessionId: session.id,
          prompt: "Delegated work", delegationId: "dlg_delivery", delegatedByAgentId: leader.id,
          delegatedFromIssueSessionId: session.id });
        expect(store.claimTask(runtime.id)?.id).toBe(source.id);
        daemonTaskClaimResponse(store, store.getTaskWithAgent(source.id)!);
        store.startTask(source.id);
        const queued = store.createTask({ agentId: leader.id, issueId: issue.id, issueSessionId: session.id,
          prompt: "Pending review", wakeSource: "child_status" });
        store.completeTask(source.id, { output: "Report", sessionId: "provider_delegate" });
        const oldSkips = db.query("SELECT data FROM multiremi_issue_activity WHERE issue_id = ? AND type = 'delegation_return_skipped'").all(issue.id) as Array<{ data: string }>;
        expect(oldSkips).toHaveLength(0);
        expect(store.getTask(queued.id)?.status).toBe("queued");
        expect(store.listTasksForIssue(issue.id).filter(task => task.status === "queued" && task.agentId === leader.id))
          .toHaveLength(1);
        const returnWakeSeq = Number(db.query("SELECT wake_seq FROM multiremi_turn_execution_records WHERE id = ?").get(queued.id).wake_seq);
        expect(returnWakeSeq).toBeGreaterThan(0);
        const cursor = store.getConversationLogHead(session.id)!.headSeq;
        expect(cursor).toBeGreaterThanOrEqual(returnWakeSeq);
        store.getOrCreateSessionAgentLane(session.id, leader.id);
        db.run("UPDATE multiremi_session_lanes SET cursor_seq = ? WHERE session_id = ? AND reader_id = ?", [cursor, session.id, leader.id]);
        runTurnExecutionMutation(db as unknown as UnifiedFixtureDatabase, "UPDATE multiremi_turn_execution_records SET wake_seq = ? WHERE id = ?", [cursor, queued.id]);
        coverBusiness(db,store,queued.id,cursor);
        expect(store.claimTask(runtime.id)).toBeNull();
        expect(store.getTask(queued.id)?.status).toBe("cancelled");
        expect(Number(db.query("SELECT COUNT(*) AS n FROM multiremi_issue_activity WHERE issue_id = ? AND type = 'wake_downgraded' AND data LIKE '%already_covered%'").get(issue.id).n)).toBe(1);
        expect(store.claimTask(runtime.id)).toBeNull();
        expect(Number(db.query("SELECT COUNT(*) AS n FROM multiremi_issue_activity WHERE issue_id = ? AND type = 'wake_downgraded' AND data LIKE '%already_covered%'").get(issue.id).n)).toBe(1);
      });
    }, 30_000);

    test(`${backend}: an unread delegation return remains claimable`, async () => {
      await withStore(backend, (store, db) => {
        store.ensureLocalWorkspace();
        const runtime = store.registerRuntime({ name: "Return runtime", provider: "codex" });
        const leader = store.createAgent({ name: "Leader", provider: "codex", runtimeId: runtime.id });
        const worker = store.createAgent({ name: "Worker", provider: "codex", runtimeId: runtime.id });
        const issue = store.createIssue({ title: "Unread return", status: "in_progress", assigneeType: "agent", assigneeId: leader.id });
        const session = store.getOrCreateDefaultIssueSession(issue.id);
        const source = store.createTask({ agentId: worker.id, issueId: issue.id, issueSessionId: session.id,
          prompt: "Delegated work", delegationId: "dlg_unread", delegatedByAgentId: leader.id,
          delegatedFromIssueSessionId: session.id });
        expect(store.claimTask(runtime.id)?.id).toBe(source.id);
        daemonTaskClaimResponse(store, store.getTaskWithAgent(source.id)!);
        store.startTask(source.id);
        store.completeTask(source.id, { output: "Report", sessionId: "provider_delegate" });
        const queued = store.listTasksForIssue(issue.id).filter(task => task.status === "queued" && task.agentId === leader.id);
        expect(queued).toHaveLength(1);
        expect(queued[0]!.wakeSource).toBe("platform_to_owner");
        expect(store.claimTask(runtime.id)?.id).toBe(queued[0]!.id);
        expect(db.query("SELECT id FROM multiremi_issue_activity WHERE issue_id = ? AND type = 'wake_downgraded' AND data LIKE '%already_covered%'").all(issue.id))
          .toHaveLength(0);
      });
    }, 30_000);

    test(`${backend}: cancelling an unfrozen queued leader turn re-drains its covered return once`, async () => {
      await withStore(backend, (store, db) => {
        store.ensureLocalWorkspace();
        const leaderRuntime = store.registerRuntime({ name: "Leader runtime", provider: "codex" });
        const workerRuntime = store.registerRuntime({ name: "Worker runtime", provider: "codex" });
        const leader = store.createAgent({ name: "Leader", provider: "codex", runtimeId: leaderRuntime.id });
        const worker = store.createAgent({ name: "Worker", provider: "codex", runtimeId: workerRuntime.id });
        const issue = store.createIssue({ title: "Return replacement", status: "in_progress", assigneeType: "agent", assigneeId: leader.id });
        const session = store.getOrCreateDefaultIssueSession(issue.id);
        const source = store.createTask({ agentId: worker.id, issueId: issue.id, issueSessionId: session.id,
          prompt: "Delegated work", delegationId: "dlg_redrain", delegatedByAgentId: leader.id,
          delegatedFromIssueSessionId: session.id });
        expect(store.claimTask(workerRuntime.id)?.id).toBe(source.id);
        daemonTaskClaimResponse(store, store.getTaskWithAgent(source.id)!);
        store.startTask(source.id);
        const unrelated = store.createTask({ agentId: leader.id, issueId: issue.id, issueSessionId: session.id,
          prompt: "Human request" });
        store.completeTask(source.id, { output: "Report to preserve", sessionId: "worker_provider" });
        expect(store.getTask(source.id)?.delegationReturnTaskId).toBe(unrelated.id);
        store.cancelTask(unrelated.id);
        const replacements = store.listTasksForIssue(issue.id).filter(row => row.status === "queued" && row.agentId === leader.id);
        expect(replacements).toHaveLength(1);
        expect(replacements[0]!.wakeSource).toBe("platform_to_owner");
        expect(store.getTask(source.id)?.delegationReturnTaskId).toBe(replacements[0]!.id);
        expect(store.listConversationLogShown(session.id).some(row => row.body_md.includes("Report to preserve"))).toBe(true);
        const reportCount = store.listSessionEvents(session.id).filter(row => row.kind === "delegation_report").length;
        const terminalSeq = store.listSessionEvents(session.id).find(row => row.kind === "task_completed" && row.taskId === source.id)!.seq;
        const replay = store.ensureDelegationWakeup({ sourceTaskId: source.id, requiredEventSeq: terminalSeq,
          terminalStatus: "completed", terminalBody: "Report to preserve" });
        expect(replay.created).toBe(false);
        expect(store.getTask(source.id)?.delegationReturnTaskId).toBe(replacements[0]!.id);
        expect(store.listSessionEvents(session.id).filter(row => row.kind === "delegation_report"))
          .toHaveLength(reportCount);
        expect(store.listTasksForIssue(issue.id).filter(row => row.status === "queued" && row.agentId === leader.id))
          .toHaveLength(1);
        const beforeClaim=store.listIssueActivity(issue.id).filter(row=>row.type==="wake_downgraded");
        expect(store.claimTask(leaderRuntime.id)?.id).toBe(replacements[0]!.id);
        expect(store.listIssueActivity(issue.id).filter(row=>row.type==="wake_downgraded")).toEqual(beforeClaim);
      });
    }, 30_000);

    test(`${backend}: same-issue completed, failed and cancelled delegates stamp one readable return`, async () => {
      await withStore(backend, (store) => {
        store.ensureLocalWorkspace();
        for (const terminal of ["completed", "failed", "cancelled"] as const) {
          const leaderRuntime = store.registerRuntime({ name: `Leader ${terminal}`, provider: "codex" });
          const workerRuntime = store.registerRuntime({ name: `Worker ${terminal}`, provider: "codex" });
          const leader = store.createAgent({ name: "Leader", provider: "codex", runtimeId: leaderRuntime.id });
          const worker = store.createAgent({ name: "Worker", provider: "codex", runtimeId: workerRuntime.id });
          const issue = store.createIssue({ title: `Return ${terminal}`, assigneeType: "agent", assigneeId: leader.id });
          const session = store.getOrCreateDefaultIssueSession(issue.id);
          const source = store.createTask({ agentId: worker.id, issueId: issue.id, issueSessionId: session.id,
            prompt: "Delegated work", delegationId: `dlg_${terminal}`, delegatedByAgentId: leader.id,
            delegatedFromIssueSessionId: session.id, maxAttempts: 1 });
          expect(store.claimTask(workerRuntime.id)?.id).toBe(source.id);
          daemonTaskClaimResponse(store, store.getTaskWithAgent(source.id)!);
          store.startTask(source.id);
          if (terminal === "completed") store.completeTask(source.id, { output: "Work complete" });
          else if (terminal === "failed") store.failTask(source.id, { error: "Work failed", failureReason: "agent_error" });
          else store.cancelTask(source.id);
          const returns = store.listTasksForIssue(issue.id).filter(row => row.status === "queued" && row.agentId === leader.id);
          expect(returns).toHaveLength(1);
          expect(returns[0]).toMatchObject({ issueSessionId: session.id, wakeSource: "platform_to_owner" });
          expect(store.getTask(source.id)?.delegationReturnTaskId).toBe(returns[0]!.id);
          expect(store.listConversationLogShown(session.id).filter(row => row.metadata.message_source && (row.metadata.message_source as {taskId?:string}).taskId === source.id))
            .toHaveLength(1);
          expect(store.claimTask(leaderRuntime.id)?.id).toBe(returns[0]!.id);
          const projection = daemonTaskClaimResponse(store, store.getTaskWithAgent(returns[0]!.id)!);
          expect(store.getTurnInput(returns[0]!.turn_id!)?.messages.some(message=>message.body_md.includes(`Status: ${terminal}`))).toBe(true);
        }
      });
    }, 30_000);

    test(`${backend}: re-ring ignores a sibling delegation scope and preserves its continuation claim`, async () => {
      await withStore(backend, (store,db) => {
        store.ensureLocalWorkspace();
        const runtime = store.registerRuntime({ name: "Parallel runtime", provider: "codex", maxConcurrency: 6,
          metadata: { parallel_agent_execution: 1, cli_version: "0.2.66" } });
        const leader = store.createAgent({ name: "Leader", provider: "codex" });
        const worker = store.createAgent({ name: "Worker", provider: "codex" });
        const issue = store.createIssue({ title: "Scope isolation" });
        const main = store.createTask({ agentId: leader.id, issueId: issue.id, prompt: "Coordinate" });
        expect(store.claimTask(runtime.id)?.id).toBe(main.id);
        daemonTaskClaimResponse(store, store.getTaskWithAgent(main.id)!);
        store.startTask(main.id);
        const delegate = (scope: string) => store.createTask({ agentId: worker.id, issueId: issue.id,
          prompt: scope, delegationId: scope, delegatedByAgentId: leader.id,parentTaskId:main.id });
        const first = delegate("dlg_first");
        db.run("UPDATE multiremi_turns SET execution_scope='dlg_first' WHERE current_attempt_id=?",[first.id]);
        const second=store.sendMessage({session_id:main.issueSessionId!,sender:{type:'platform',id:null},to:{type:'agent',ref:worker.id},message_kind:'request',wake_requested:'now',body_md:'Independent sibling',execution_scope:'dlg_second'});
        const secondTask=store.getTask(store.getTurn(second.turn_id!)!.current_attempt_id!)!;
        expect(store.claimTask(runtime.id)?.id).toBe(first.id);
        expect(store.claimTask(runtime.id)?.id).toBe(secondTask.id);
        daemonTaskClaimResponse(store, store.getTaskWithAgent(first.id)!);
        daemonTaskClaimResponse(store, store.getTaskWithAgent(secondTask.id)!);
        store.startTask(first.id);
        store.startTask(secondTask.id);
        store.completeTask(first.id, { output: "First result", sessionId: "provider_first" });
        store.completeTask(secondTask.id, { output: "Second result", sessionId: "provider_second" });
        expect(store.listTasksForIssue(issue.id).filter(row => row.status === "queued" && row.agentId === worker.id))
          .toHaveLength(0);
        const continued = delegate("dlg_first");
        expect(store.claimTask(runtime.id)?.id).toBe(continued.id);
        expect(store.getTask(continued.id)?.sessionId).toBe("provider_first");
      });
    }, 30_000);

    test(`${backend}: local-directory pin repools a stale claim and refreshes every projection cache`, async () => {
      await withStore(backend, (store, db) => {
        store.ensureLocalWorkspace();
        const directoryRuntime = store.registerRuntime({ name: "Directory runtime", provider: "codex", daemonId: "directory-host" });
        const oldRuntime = store.registerRuntime({ name: "Old runtime", provider: "codex", daemonId: "old-host" });
        const agent = store.createAgent({ name: "Pinned owner", provider: "codex" });
        const project = store.createProject({ title: "Local directory", resources: [{ resourceType: "local_directory",
          resourceRef: { local_path: "/abs/mul484", daemon_id: "directory-host" } }] });
        const issue = store.createIssue({ title: "Pin repool", projectId: project.id, status: "in_progress",
          assigneeType: "agent", assigneeId: agent.id });
        const session = store.getOrCreateDefaultIssueSession(issue.id);
        const task = store.createTask({ agentId: agent.id, issueId: issue.id, issueSessionId: session.id,
          prompt: "Pinned turn", runtimeId: directoryRuntime.id });
        expect(store.claimTask(directoryRuntime.id)?.id).toBe(task.id);
        const first = daemonTaskClaimResponse(store, store.getTaskWithAgent(task.id)!)
          .session_projection as { to_seq: number };
        expect(store.findTurnEntry(task.id)?.metadata.inbox?.delivered_to_seq).toBe(first.to_seq);
        const later = store.appendConversationLog({ sessionId: session.id, kind: "system", authorType: "system",
          bodyMd: "Arrived after first claim" });
        expect(later.seq).toBeGreaterThan(first.to_seq);
        db.run("UPDATE multiremi_agents SET runtime_id = ? WHERE id = ?", [directoryRuntime.id, agent.id]);
        runTurnExecutionMutation(db as unknown as UnifiedFixtureDatabase, "UPDATE multiremi_turn_execution_records SET runtime_id = ?, dispatched_at = ? WHERE id = ?", [oldRuntime.id, new Date(Date.now() - 120_000).toISOString(), task.id]);
        expect(store.claimTask(oldRuntime.id)).toBeNull();
        const repooled = db.query("SELECT * FROM multiremi_turn_execution_records WHERE id = ?").get(task.id) as Record<string, unknown>;
        expect(repooled.status).toBe("queued");
        expect(repooled.runtime_id).toBe(directoryRuntime.id);
        for (const field of ["projection_from_seq", "projection_to_seq", "projection_mode",
          "inherited_projection_from_seq", "inherited_projection_to_seq", "inherited_projection_recorded_at"]) {
          expect(repooled[field]).toBeNull();
        }
        expect(repooled.projection_truncated).toBeFalsy();
        expect(repooled.projection_omitted_events).toBe(0);
        expect(store.claimTask(directoryRuntime.id)?.id).toBe(task.id);
        const second = daemonTaskClaimResponse(store, store.getTaskWithAgent(task.id)!)
          .session_projection as { to_seq: number };
        expect(second.to_seq).toBeGreaterThanOrEqual(later.seq);
        expect(store.findTurnEntry(task.id)?.metadata.inbox?.delivered_to_seq).toBe(second.to_seq);
      });
    }, 30_000);

    test(`${backend}: real system wake sources obey cursor and unread-now claim boundaries`, async () => {
      await withStore(backend, (store, db) => {
        store.ensureLocalWorkspace();
        for (const source of ["re_ring", "child_status", "mention", "delegation_return", "decision", "dependency"] as const) {
          const boundaries = (["below", "equal", "above"] as const).flatMap(boundary =>
            [false, true].map(hasUnreadNow => ({ boundary, hasUnreadNow })));
          for (const { boundary, hasUnreadNow } of boundaries) {
            const runtime = store.registerRuntime({ name: `${source} ${boundary} ${hasUnreadNow}`, provider: "codex" });
            const agent = store.createAgent({ name: `${source} owner`, provider: "codex", runtimeId: runtime.id });
            const issue = store.createIssue({ title: `${source} ${boundary} ${hasUnreadNow}`, assigneeType: "agent", assigneeId: agent.id });
            const session = store.getOrCreateDefaultIssueSession(issue.id);
            let pendingId: string;
            if (source === "re_ring") {
              const initial = store.createSessionTask(session.id, { agentId: agent.id, prompt: "Initial turn" });
              expect(store.claimTask(runtime.id)?.id).toBe(initial.id);
              daemonTaskClaimResponse(store, store.getTaskWithAgent(initial.id)!);
              store.startTask(initial.id);
              appendCanonicalInboxInput(store, { sessionId: session.id, kind: "system", authorType: "system",
                bodyMd: "Unseen now", metadata: { envelope: {
                  to: { role: "agent", issueSessionId: session.id, agentId: agent.id },
                  kind: "report", wake: "now", source: {}, priority: 3,
                } } });
              store.completeTask(initial.id, { output: "Task completed.", sessionId: "ring_provider" });
              pendingId = store.listTasksForIssue(issue.id).find(row => row.status === "queued")!.id;
            } else if (source === "mention") {
              store.createIssueComment(issue.id, { authorType: "member", authorId: "mem_local_local",
                body: `Review this [@Owner](mention://agent/${agent.id})` });
              pendingId = store.listTasksForIssue(issue.id).find(row => row.status === "queued")!.id;
            } else if (source === "delegation_return") {
              const worker = store.createAgent({ name: "Worker", provider: "codex", runtimeId: runtime.id });
              const delegated = store.createTask({ agentId: worker.id, issueId: issue.id, issueSessionId: session.id,
                prompt: "Delegated", delegationId: `dlg_${source}_${boundary}`,
                delegatedByAgentId: agent.id, delegatedFromIssueSessionId: session.id });
              expect(store.claimTask(runtime.id)?.id).toBe(delegated.id);
              daemonTaskClaimResponse(store, store.getTaskWithAgent(delegated.id)!);
              store.startTask(delegated.id);
              store.completeTask(delegated.id, { output: "Worker report", sessionId: "worker_provider" });
              pendingId = store.listTasksForIssue(issue.id).find(row => row.status === "queued" && row.agentId === agent.id)!.id;
            } else {
              const child = source === "child_status" ? store.createIssue({ title: "Child", parentIssueId: issue.id }) : null;
              const delivered = db.transaction(() => store.sendEnvelopeWithinTransaction({
                to: { role: "agent", issueSessionId: session.id, agentId: agent.id },
                kind: source === "dependency" ? "lifecycle" : "report", wake: "now",
                body: `${source} update`, source: source === "child_status" ? { issueId: child!.id }
                  : source === "decision" ? { decisionId: `dcs_${boundary}` } : {},
              }, [], createCommitEventQueue()))();
              pendingId = delivered[0]!.task!.id;
            }
            const pending = store.getTask(pendingId)!;
            expect(pending.wakeSource).toBe(source==="mention"?"human_sender":"platform_to_owner");
            const seq = wakeSeq(db, pendingId);
            expect(seq).toBeGreaterThan(0);
            const later = store.appendConversationLog({ sessionId: session.id, kind: "system", authorType: "system",
              bodyMd: "Cursor marker" });
            store.getOrCreateSessionAgentLane(session.id, agent.id);
            const cursor = boundary === "below" ? seq - 1 : boundary === "equal" ? seq : later.seq;
            db.run("UPDATE multiremi_session_lanes SET cursor_seq = ? WHERE session_id = ? AND reader_id = ? AND execution_scope = ''",
              [cursor, session.id, agent.id]);
            coverBusiness(db,store,pendingId,cursor);
            if (hasUnreadNow) {
              appendCanonicalInboxInput(store, { sessionId: session.id, kind: "system", authorType: "system",
                bodyMd: "Still unread", metadata: { envelope: {
                  to: { role: "agent", issueSessionId: session.id, agentId: agent.id },
                  kind: "report", wake: "now", source: {}, priority: 3,
                } } });
            }
            const claimed = store.claimTask(runtime.id);
            const skip = boundary !== "below" && !hasUnreadNow;
            expect(claimed?.id ?? null).toBe(skip ? null : pendingId);
            expect(store.getTask(pendingId)?.status).toBe(skip ? "cancelled" : "dispatched");
            if (skip) expect(store.findTurnEntry(pendingId)?.metadata.status).toBe("cancelled");
            const audits = store.listIssueActivity(issue.id).filter(row => row.type === "wake_downgraded");
            expect(audits).toHaveLength(skip ? 1 : 0);
            if (skip) expect(audits[0]!.data).toMatchObject({ reason: "already_covered",
              wake_source: pending.wakeSource, wake_seq: seq, covered_input_to_seq: cursor });
          }
        }
      });
    }, 120_000);

    test(`${backend}: covered queue head skips once without blocking another issue or execution scope`, async () => {
      await withStore(backend, (store, db) => {
        store.ensureLocalWorkspace();
        const runtime = store.registerRuntime({ name: "Shared runtime", provider: "codex", maxConcurrency: 6,
          metadata: { parallel_agent_execution: 1, cli_version: "0.2.66" } });
        const owner = store.createAgent({ name: "Owner", provider: "codex", runtimeId: runtime.id });
        const other = store.createAgent({ name: "Other", provider: "codex", runtimeId: runtime.id });
        const firstIssue = store.createIssue({ title: "Covered head", assigneeType: "agent", assigneeId: owner.id });
        const secondIssue = store.createIssue({ title: "Other issue", assigneeType: "agent", assigneeId: other.id });
        const firstSession = store.getOrCreateDefaultIssueSession(firstIssue.id);
        const secondSession = store.getOrCreateDefaultIssueSession(secondIssue.id);
        const first = sendIssueWake(store, db, firstSession.id, owner.id, "now", "Covered wake").task!;
        const second = sendIssueWake(store, db, secondSession.id, other.id, "now", "Other wake").task!;
        const scoped = store.createTask({ agentId: owner.id, issueId: firstIssue.id,
          issueSessionId: firstSession.id, prompt: "Independent scope", delegationId: "dlg_independent",
          delegatedByAgentId: other.id,parentTaskId:second.id });
        store.getOrCreateSessionAgentLane(firstSession.id, owner.id);
        db.run("UPDATE multiremi_session_lanes SET cursor_seq = ? WHERE session_id = ? AND reader_id = ? AND execution_scope = ''",
          [wakeSeq(db, first.id), firstSession.id, owner.id]);
        coverBusiness(db,store,first.id,wakeSeq(db,first.id));
        expect(store.claimTask(runtime.id)?.id).toBe(second.id);
        expect(store.getTask(first.id)?.status).toBe("cancelled");
        expect(store.claimTask(runtime.id)?.id).toBe(scoped.id);
        expect(store.listIssueActivity(firstIssue.id).filter(row => row.type === "wake_downgraded"))
          .toHaveLength(1);
        expect(store.listIssueActivity(secondIssue.id).filter(row => row.type === "wake_downgraded"))
          .toHaveLength(0);
      });
    }, 30_000);

    test(`${backend}: human, Chat, continuation and manual requests remain claimable after a provider read`,async()=>{
      await withStore(backend,(store,db)=>{
        for(const kind of ['human','chat','continuation','manual'] as const){
          const runtime=store.registerRuntime({name:kind,provider:"codex"});
          const agent=store.createAgent({name:kind,provider:"codex",runtimeId:runtime.id});
          const issue=store.createIssue({title:kind,assigneeType:"agent",assigneeId:agent.id});
          const session=store.getOrCreateDefaultIssueSession(issue.id);
          let task;
          if(kind==='chat'){const chat=store.createChatSession({agentId:agent.id});task=store.sendChatMessage(chat.id,{content:'Chat work'}).task;}
          else if(kind==='continuation'){
            const prior=store.createSessionTask(session.id,{agentId:agent.id,prompt:'Prior work'});
            expect(store.claimTask(runtime.id)?.id).toBe(prior.id);store.startTask(prior.id);store.completeTask(prior.id,{output:'Done'});
            task=store.createTask({agentId:agent.id,issueId:issue.id,continuedFromTaskId:prior.id,prompt:'Explicit new work'});
            expect(task.turn_id).not.toBe(prior.turn_id);
          }else if(kind==='human'){
            const comment=store.createIssueComment(issue.id,{authorType:'member',authorId:'mem_local_local',body:'Human work'});
            task=store.listTasksForIssue(issue.id).find(t=>t.triggerCommentId===comment.id)!;
          }else task=store.createSessionTask(session.id,{agentId:agent.id,prompt:'CLI work'});
          const turn=store.getTurn(task.turn_id!)!;
          if(kind!=="chat")store.getOrCreateSessionAgentLane(turn.session_id,agent.id);
          db.run("UPDATE multiremi_session_lanes SET cursor_seq=? WHERE session_id=? AND reader_id=?",[store.getConversationLogHead(turn.session_id)!.headSeq,turn.session_id,agent.id]);
          expect(store.claimTask(runtime.id)?.id).toBe(task.id);
          expect(store.listIssueActivity(issue.id).filter(row=>row.type==='wake_downgraded'&&(row.data as {reason?:string})?.reason==='already_covered')).toHaveLength(0);
          store.completeTask(task.id,{output:'Done'});
        }
      });
    },60_000);

    test(`${backend}: parent summary wakes retain zero-seq and unread positive-seq rounds`, async () => {
      await withStore(backend, (store, db) => {
        store.ensureLocalWorkspace();
        for (const boundary of ["legacy_zero", "covered", "unread"] as const) {
          const runtime = store.registerRuntime({ name: `Parent ${boundary}`, provider: "codex" });
          const owner = store.createAgent({ name: `Parent owner ${boundary}`, provider: "codex", runtimeId: runtime.id });
          const parent = store.createIssue({ title: `Parent ${boundary}`, status: "in_progress",
            assigneeType: "agent", assigneeId: owner.id });
          const child = store.createIssue({ title: "Child", parentIssueId: parent.id, status: "in_progress" });
          const session = store.getOrCreateDefaultIssueSession(parent.id);
          store.updateIssue(child.id, { status: "done" });
          const summary = store.listTasksForIssue(parent.id).find(row => row.status === "queued")!;
          expect(summary).toMatchObject({ issueSessionId: session.id, wakeSource: "platform_to_owner" });
          const seq = wakeSeq(db, summary.id);
          expect(seq).toBeGreaterThan(0);
          const head = store.getConversationLogHead(session.id)!.headSeq;
          store.getOrCreateSessionAgentLane(session.id, owner.id);
          db.run("UPDATE multiremi_session_lanes SET cursor_seq = ? WHERE session_id = ? AND reader_id = ? AND execution_scope = ''",
            [head, session.id, owner.id]);
          coverBusiness(db,store,summary.id,head);
          if (boundary === "legacy_zero") runTurnExecutionMutation(db as unknown as UnifiedFixtureDatabase, "UPDATE multiremi_turn_execution_records SET wake_seq = 0 WHERE id = ?", [summary.id]);
          if (boundary === "unread") {
            appendCanonicalInboxInput(store, { sessionId: session.id, kind: "system", authorType: "system",
              bodyMd: "Further parent update", metadata: { envelope: {
                to: { role: "agent", issueSessionId: session.id, agentId: owner.id },
                kind: "report", wake: "now", source: {}, priority: 3,
              } } });
          }
          const claimed = store.claimTask(runtime.id);
          expect(claimed?.id ?? null).toBe(boundary === "covered" ? null : summary.id);
          expect(store.getTask(summary.id)?.status).toBe(boundary === "covered" ? "cancelled" : "dispatched");
          expect(store.listIssueActivity(parent.id).filter(row => row.type === "wake_downgraded"))
            .toHaveLength(boundary === "covered" ? 1 : 0);
          if (claimed) store.completeTask(claimed.id, { output: "Parent summary" });
        }
      });
    }, 30_000);

    for (const noLineageEndpoint of [false, true]) {
    test(`${backend}: reviewed delegation fanout prepares one Feishu push with no-lineage endpoint ${noLineageEndpoint}`, async () => {
      const previousKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
      process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
      try {
        await withStore(backend, (store, db) => {
          store.ensureLocalWorkspace();
          const leaderRuntime = store.registerRuntime({ name: "Leader runtime", provider: "codex", workspaceId: "local" });
          const workerRuntimes = [0, 1].map(index => store.registerRuntime({ name: `Worker ${index} runtime`,
            provider: "codex", workspaceId: "local" }));
          const leader = store.createAgent({ name: "Leader", provider: "codex", runtimeId: leaderRuntime.id });
          const workers = workerRuntimes.map((runtime, index) => store.createAgent({ name: `Worker ${index}`,
            provider: "codex", runtimeId: runtime.id }));
          const owner = store.getCurrentUser();
          store.getOrCreateUser({ externalId: "ou_mul484_owner", feishuUnionId: "on_mul484_owner",
            email: owner.email, name: "Issue owner" });
          store.heartbeatRuntime(leaderRuntime.id, { supportsFeishuBotConfig: true });
          const config = store.upsertFeishuBotConfig("local", { agentId: leader.id, runtimeId: leaderRuntime.id,
            appId: "cli_mul484_test", appSecretOp: "set", appSecret: "local-test-secret-only",
            domain: "feishu", enabled: true });
          store.reportFeishuBotRuntimeStatus("local", leaderRuntime.id,
            { appliedRevision: config.revision, state: "online" });
          store.updateWorkspace("local", { settings: { issueTopics: { enabled: true, chatId: "oc_mul484" } } });
          const squad = store.createSquad({ name: "Delivery", leaderId: leader.id,
            memberIds: workers.map(worker => worker.id) });
          const issue = store.createIssue({ title: "Feishu fanout", assigneeType: "squad", assigneeId: squad.id });
          expect(store.prepareFeishuIssueTopicWithinTransaction(issue)).toBe(true);
          const topic = store.claimFeishuBotOutbound("local", leaderRuntime.id)!;
          store.reportFeishuBotOutbound("local", leaderRuntime.id, topic.id,
            { claimToken: topic.claimToken, status: "sent", externalMessageId: "om_mul484_topic" });
          const session = store.getOrCreateDefaultIssueSession(issue.id);
          const leaderTask = store.createSessionTask(session.id, { agentId: leader.id, prompt: "Delegate work" });
          expect(store.claimTask(leaderRuntime.id)?.id).toBe(leaderTask.id);
          daemonTaskClaimResponse(store, store.getTaskWithAgent(leaderTask.id)!);
          store.startTask(leaderTask.id);
          for (const worker of workers) {
            store.createIssueComment(issue.id, { taskId: leaderTask.id, authorType: "agent", authorId: leader.id,
              body: `Implement [@${worker.name}](mention://agent/${worker.id})` });
          }
          const delegated = workers.map(worker => store.listTasksForIssue(issue.id).find(row => row.agentId === worker.id)!);
          store.completeTask(leaderTask.id, { output: "Task completed." });
          for (const [index, task] of delegated.entries()) {
            expect(store.claimTask(workerRuntimes[index]!.id)?.id).toBe(task.id);
            daemonTaskClaimResponse(store, store.getTaskWithAgent(task.id)!);
            store.startTask(task.id);
            if (index === 1 && noLineageEndpoint) {
              runTurnExecutionMutation(db as unknown as UnifiedFixtureDatabase, "UPDATE multiremi_turn_execution_records SET delegation_id = NULL, delegated_by_agent_id = NULL WHERE id = ?", [task.id]);
            }
            store.completeTask(task.id, { output: `Worker ${index} report` });
          }
          const returned = store.listTasksForIssue(issue.id).find(row => row.status === "queued" && row.agentId === leader.id)!;
          expect(store.claimTask(leaderRuntime.id)?.id).toBe(returned.id);
          daemonTaskClaimResponse(store, store.getTaskWithAgent(returned.id)!);
          store.startTask(returned.id);
          store.completeTask(returned.id, { output: "Reviewed the result" });
          expect(Number(db.query("SELECT COUNT(*) AS n FROM multiremi_feishu_bot_round_pushes WHERE issue_id = ?").get(issue.id).n))
            .toBe(1);
          expect(store.listTasksForIssue(issue.id).filter(row => row.status === "queued"
            && row.agentId === leader.id && !row.chatSessionId)).toHaveLength(0);
          expect(store.listTasksForIssue(issue.id).filter(row => row.status === "queued"
            && row.agentId === leader.id && row.chatSessionId)).toHaveLength(1);
        });
      } finally {
        if (previousKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
        else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousKey;
      }
    }, 30_000);
    }

    test(`${backend}: mixed Issue scopes and Chat terminal paths isolate the re-ring lane`, async () => {
      await withStore(backend, (store,db) => {
        store.ensureLocalWorkspace();
        const runtime = store.registerRuntime({ name: "Mixed runtime", provider: "codex", maxConcurrency: 6,
          metadata: { parallel_agent_execution: 1, cli_version: "0.2.66" } });
        const agent = store.createAgent({ name: "Mixed owner", provider: "codex", runtimeId: runtime.id });
        const delegatorRuntime = store.registerRuntime({ name: "Delegator runtime", provider: "codex" });
        const delegator = store.createAgent({ name: "Delegator", provider: "codex", runtimeId: delegatorRuntime.id });
        const issue = store.createIssue({ title: "Mixed lanes", assigneeType: "agent", assigneeId: agent.id });
        const session = store.getOrCreateDefaultIssueSession(issue.id);
        const main = store.createSessionTask(session.id, { agentId: agent.id, prompt: "Main scope" });
        const origin=store.createTask({agentId:delegator.id,issueId:issue.id,prompt:"Scoped source"});
        runTurnExecutionMutation(db,"UPDATE multiremi_turn_execution_records SET status='cancelled' WHERE id=?",[origin.id]);
        const sibling = store.createTask({ agentId: agent.id, issueId: issue.id, issueSessionId: session.id,
          prompt: "Sibling scope", delegationId: "dlg_sibling", delegatedByAgentId: delegator.id,parentTaskId:origin.id });
        const chat = store.createChatSession({ agentId: agent.id });
        const chatTask = store.sendChatMessage(chat.id, { content: "Chat request" }).task;
        for (const task of [main, sibling, chatTask]) {
          expect(store.claimTask(runtime.id)?.id).toBe(task.id);
          daemonTaskClaimResponse(store, store.getTaskWithAgent(task.id)!);
          store.startTask(task.id);
        }
        const unread = appendCanonicalInboxInput(store, { sessionId: session.id, kind: "system", authorType: "system",
          bodyMd: "Default scope only", metadata: { envelope: {
            to: { role: "agent", issueSessionId: session.id, agentId: agent.id },
            kind: "report", wake: "now", source: {}, priority: 3,
          } } });
        store.completeTask(sibling.id, { output: "Task completed.", sessionId: "sibling_provider" });
        store.completeTask(chatTask.id, { output: "Chat reply", sessionId: "chat_provider" });
        expect(store.listTasksForIssue(issue.id).filter(row => row.status === "queued" && row.agentId === agent.id))
          .toHaveLength(0);
        store.completeTask(main.id, { output: "Task completed.", sessionId: "main_provider" });
        const rings = store.listTasksForIssue(issue.id).filter(row => row.status === "queued" && row.agentId === agent.id);
        expect(rings).toHaveLength(1);
        expect(rings[0]).toMatchObject({ wakeSource: "platform_to_owner", execution_scope: "" });
        expect(store.listTasks().filter(row => row.chatSessionId === chat.id && row.status === "queued"))
          .toHaveLength(0);
        expect(store.getConversationLogEntryById(unread.id)?.body_md).toBe("Default scope only");
        expect(store.claimTask(runtime.id)?.id).toBe(rings[0]!.id);
      });
    }, 30_000);

    test(`${backend}: Issue receipt follows claim and Chat receipt follows its assistant reply`, async () => {
      await withStore(backend, (store, db) => {
        store.ensureLocalWorkspace();
        const runtime = store.registerRuntime({ name: "Receipt runtime", provider: "codex" });
        const agent = store.createAgent({ name: "Receipt owner", provider: "codex", runtimeId: runtime.id });
        const issue = store.createIssue({ title: "Receipt contract", status: "in_progress", assigneeType: "agent", assigneeId: agent.id });
        const session = store.getOrCreateDefaultIssueSession(issue.id);
        const issueTask = store.createSessionTask(session.id, { agentId: agent.id, prompt: "Read issue" });
        const issueEnvelope = sendIssueWake(store, db, session.id, agent.id, "inbox_only", "Issue payload").entry;
        const chat = store.createChatSession({ agentId: agent.id });
        const chatTask = store.sendChatMessage(chat.id, { content: "Chat payload" }).task;

        for (const task of [issueTask, chatTask]) {
          expect(store.claimTask(runtime.id)?.id).toBe(task.id);
          const projection = daemonTaskClaimResponse(store, store.getTaskWithAgent(task.id)!)
            .session_projection as { from_seq: number; to_seq: number };
          expect(store.getTask(task.id)).toMatchObject({ projectionFromSeq: projection.from_seq,
            projectionToSeq: projection.to_seq });
          if (task.id === chatTask.id) expect(store.listConversationLogShown(chat.id).filter(row=>row.kind==="turn")).toHaveLength(0);
          else expect(store.findTurnEntry(task.id)?.metadata.inbox).toBeDefined();
          store.completeTask(task.id, { output: "Task completed." });
          const receipt = store.findTurnEntry(task.id)?.metadata.inbox;
          expect(receipt).toMatchObject({ delivered_from_seq: projection.from_seq,
            delivered_to_seq: projection.to_seq });
          expect(store.getTurn(task.turn_id!)?.input_to_seq).toBe(projection.to_seq);
          const sessionId = task.id === issueTask.id ? session.id : chat.id;
          expect(store.listConversationLogShown(sessionId).filter(entry => entry.task_id === task.id && entry.kind === "turn"))
            .toHaveLength(1);
        }
        expect(store.getConversationLogEntryById(issueEnvelope.id)?.metadata.inbox).toBeUndefined();
      });
    }, 30_000);





    test(`${backend}: Chat attempts without a reply keep their projection but have no turn receipt`, async () => {
      await withStore(backend, (store) => {
        store.ensureLocalWorkspace();
        const runtime = store.registerRuntime({ name: "No reply runtime", provider: "codex" });
        const agent = store.createAgent({ name: "No reply owner", provider: "codex", runtimeId: runtime.id });
        for (const terminal of ["cancelled", "retrying"] as const) {
          const chat = store.createChatSession({ agentId: agent.id });
          const task = store.sendChatMessage(chat.id, { content: `No reply ${terminal}` }).task;
          expect(store.claimTask(runtime.id)?.id).toBe(task.id);
          const projection = daemonTaskClaimResponse(store, store.getTaskWithAgent(task.id)!)
            .session_projection as { to_seq: number };
          expect(store.getTask(task.id)?.projectionToSeq).toBe(projection.to_seq);
          store.startTask(task.id);
          if (terminal === "cancelled") store.cancelTask(task.id);
          else store.failTask(task.id, { error: "Context overflow", failureReason: "agent_error.context_overflow" });
          expect(store.findTurnEntry(task.id)).not.toBeNull();
          expect(store.listChatMessages(chat.id).filter(message => message.role === "assistant")).toHaveLength(0);
        }
      });
    }, 30_000);

    test(`${backend}: reassignment keeps an issue_owner pending turn and delivered readback with the original recipient`, async () => {
      await withStore(backend, async (store, db) => {
        store.ensureLocalWorkspace();
        const originalRuntime = store.registerRuntime({ name: "Original owner runtime", provider: "codex" });
        const nextRuntime = store.registerRuntime({ name: "Next owner runtime", provider: "codex" });
        const original = store.createAgent({ name: "Original owner", provider: "codex", runtimeId: originalRuntime.id });
        const next = store.createAgent({ name: "Next owner", provider: "codex", runtimeId: nextRuntime.id });
        const issue = store.createIssue({ title: "Frozen recipient", status: "in_progress",
          assigneeType: "agent", assigneeId: original.id });
        const session = store.getOrCreateDefaultIssueSession(issue.id);
        const first = store.createSessionTask(session.id, { agentId: original.id, prompt: "First round" });
        expect(store.claimTask(originalRuntime.id)?.id).toBe(first.id);
        daemonTaskClaimResponse(store, store.getTaskWithAgent(first.id)!);
        store.startTask(first.id);
        const [delivery] = db.transaction(() => store.sendEnvelopeWithinTransaction({
          to: { role: "issue_owner", issueId: issue.id }, kind: "report", wake: "now",
          body: "For the original owner", source: {},
        }, [], createCommitEventQueue()))();
        expect(store.getMessage(delivery.entry.id)?.to_agent_id).toBe(original.id);
        const app = createMultiremiApp({ store });
        const readDelivered = async () => {
          const response = await app.request(`/api/sessions/${session.id}/log/entry?seq=${delivery.entry.seq}`);
          expect(response.status).toBe(200);
          return (await response.json()).delivered as boolean;
        };
        expect(await readDelivered()).toBe(false);
        store.updateIssue(issue.id, { assigneeType: "agent", assigneeId: next.id });
        expect(await readDelivered()).toBe(false);
        store.completeTask(first.id, { output: "Done" });
        const queued = store.listTasksForIssue(issue.id).filter(task => task.status === "queued" && task.agentId === original.id);
        expect(queued).toHaveLength(1);
        expect(queued[0]!.agentId).toBe(original.id);
        expect(store.listIssueActivity(issue.id).filter(row => row.type === "re_ring").map(row => row.data))
          .toEqual([expect.objectContaining({ action: "created", task_id: queued[0]!.id })]);
        expect(store.claimTask(originalRuntime.id)?.id).toBe(queued[0]!.id);
        const projection = daemonTaskClaimResponse(store, store.getTaskWithAgent(queued[0]!.id)!)
          .session_projection as { to_seq: number };
        expect(projection.to_seq).toBeGreaterThanOrEqual(delivery.entry.seq);
        expect(store.findTurnEntry(queued[0]!.id)?.metadata.inbox?.delivered_to_seq)
          .toBeGreaterThanOrEqual(delivery.entry.seq);
        expect(await readDelivered()).toBe(true);
        expect(store.findTurnEntry(queued[0]!.id)?.task_id).toBe(queued[0]!.id);
      });
    }, 30_000);

    test(`${backend}: resume-safe failure retains its turn and actual cursor for the next attempt`, async () => {
      await withStore(backend, (store, db) => {
        store.ensureLocalWorkspace();
        const runtime = store.registerRuntime({ name: "Failure runtime", provider: "codex" });
        const agent = store.createAgent({ name: "Failure owner", provider: "codex", runtimeId: runtime.id });
        const issue = store.createIssue({ title: "Recoverable failure", status: "in_progress", assigneeType: "agent", assigneeId: agent.id });
        const session = store.getOrCreateDefaultIssueSession(issue.id);
        const task = store.createSessionTask(session.id, { agentId: agent.id, prompt: "Before failure" });
        expect(store.claimTask(runtime.id)?.id).toBe(task.id);
        const projection = daemonTaskClaimResponse(store, store.getTaskWithAgent(task.id)!)
          .session_projection as { to_seq: number };
        store.startTask(task.id);
        const unread = appendCanonicalInboxInput(store, { sessionId: session.id, kind: "system", authorType: "system",
          bodyMd: "Unseen report", metadata: { envelope: {
            to: { role: "agent", issueSessionId: session.id, agentId: agent.id },
            kind: "report", wake: "now", source: {}, priority: 3,
          } } });
        expect(unread.seq).toBeGreaterThan(projection.to_seq);
        store.failTask(task.id, { error: "Disconnected", failureReason: "runtime_offline", sessionId: "provider_safe" });
        const queued = store.listTasksForIssue(issue.id).filter(row => row.status === "queued");
        expect(queued).toHaveLength(1);
        expect(queued[0]).toMatchObject({turn_id:task.turn_id,wakeSource:task.wakeSource,attempt:2});
        expect(wakeSeq(db, queued[0]!.id)).toBe(wakeSeq(db,task.id));
        expect(queued[0]!.prompt).not.toContain(unread.body_md);
        expect(store.getSessionAgentLane(session.id, agent.id)?.cursorSeq).toBe(0);
        expect(store.getConversationLogEntryById(unread.id)?.body_md).toBe(unread.body_md);
        expect(store.listIssueActivity(issue.id).filter(row=>row.type==="re_ring")).toEqual([]);
        expect(store.buildTaskSessionProjection(queued[0]!.id)?.toSeq).toBeGreaterThanOrEqual(unread.seq);
      });
    }, 30_000);

    test(`${backend}: resume-safe failure without retry creates one re-ring for an unread now envelope`, async () => {
      await withStore(backend, (store, db) => {
        store.ensureLocalWorkspace();
        const runtime = store.registerRuntime({ name: "Terminal failure runtime", provider: "codex" });
        const agent = store.createAgent({ name: "Terminal failure owner", provider: "codex", runtimeId: runtime.id });
        const issue = store.createIssue({ title: "Recoverable session after exhausted retry", status: "in_progress",
          assigneeType: "agent", assigneeId: agent.id });
        const session = store.getOrCreateDefaultIssueSession(issue.id);
        const task = store.createTask({ agentId: agent.id, issueId: issue.id, issueSessionId: session.id,
          prompt: "Before failure", maxAttempts: 1 });
        expect(store.claimTask(runtime.id)?.id).toBe(task.id);
        const projection = daemonTaskClaimResponse(store, store.getTaskWithAgent(task.id)!)
          .session_projection as { to_seq: number };
        store.startTask(task.id);
        const unread = appendCanonicalInboxInput(store, { sessionId: session.id, kind: "system", authorType: "system",
          bodyMd: "Unseen report", metadata: { envelope: {
            to: { role: "agent", issueSessionId: session.id, agentId: agent.id },
            kind: "report", wake: "now", source: {}, priority: 3,
          } } });
        expect(unread.seq).toBeGreaterThan(projection.to_seq);
        store.failTask(task.id, { error: "Disconnected", failureReason: "runtime_offline", sessionId: "provider_safe" });
        const queued = store.listTasksForIssue(issue.id).filter(row => row.status === "queued");
        expect(queued).toHaveLength(1);
        expect(queued[0]).toMatchObject({ wakeSource: "platform_to_owner", triggerCommentId: unread.id });
        expect(wakeSeq(db, queued[0]!.id)).toBe(unread.seq);
        expect(store.getSessionAgentLane(session.id, agent.id)?.cursorSeq).toBe(0);
        expect(store.getConversationLogEntryById(unread.id)?.body_md).toBe(unread.body_md);
        expect(store.listIssueActivity(issue.id).filter(row => row.type === "re_ring").map(row => row.data))
          .toEqual([expect.objectContaining({ action: "created", task_id: queued[0]!.id })]);
      });
    }, 30_000);

    for (const wake of ["now", "next_turn", "inbox_only", "self_now"] as const) {
      test(`${backend}: Chat ${wake} during a turn rerings unread now in Chat only`, async () => {
        await withStore(backend, (store, db) => {
          store.ensureLocalWorkspace();
          const runtime = store.registerRuntime({ name: "Chat runtime", provider: "codex" });
          const agent = store.createAgent({ name: "Chat owner", provider: "codex", runtimeId: runtime.id });
          const chat = store.createChatSession({ agentId: agent.id });
          const task = store.sendChatMessage(chat.id, { content: "Initial message" }).task;
          expect(store.claimTask(runtime.id)?.id).toBe(task.id);
          daemonTaskClaimResponse(store, store.getTaskWithAgent(task.id)!);
          store.startTask(task.id);
          if (wake === "self_now") {
            store.sendMessage({session_id:chat.id,sender:{type:"agent",id:agent.id},source_turn_id:task.turn_id,
              to:{type:"agent",ref:agent.id},message_kind:"report",wake_requested:"now",body_md:"Own report"});
          } else {
            db.transaction(() => store.sendEnvelopeWithinTransaction({
              to: { role: "chat", chatSessionId: chat.id, agentId: agent.id },
              kind: "report", wake, body: "Chat report", source: {},
            }, [], createCommitEventQueue()))();
          }
          const steers = store.listTaskSteerMessages(task.id);
          if (steers.length) store.consumeTaskSteerMessages(task.id, steers.map(row => row.id));
          store.completeTask(task.id, { output: "Task completed.", sessionId: "chat_provider" });
          expect(store.listTasks().filter(row => row.chatSessionId === chat.id && row.wakeSource === "re_ring"))
            .toHaveLength(0);
          const pending = store.listTasks().filter(row => row.chatSessionId === chat.id && row.status === "queued");
          expect(pending).toHaveLength(wake === "now" ? 1 : 0);
          if (wake === "now") {
            expect(pending[0]!.issueId).toBeNull();
            expect(store.getTurnForAttempt(pending[0]!.id)?.session_id).toBe(chat.id);
            expect(pending[0]!.prompt).toBe("Chat report");
          }
        });
      }, 30_000);
    }

    for (const order of ["queued_first", "envelope_first"] as const) {
      test(`${backend}: ${order} keeps one queued id and monotone wake_seq through repeated re-ring`, async () => {
        await withStore(backend, (store, db) => {
          store.ensureLocalWorkspace();
          const runtime = store.registerRuntime({ name: "Ordered runtime", provider: "codex" });
          const agent = store.createAgent({ name: "Ordered owner", provider: "codex", runtimeId: runtime.id });
          const issue = store.createIssue({ title: "Ordered wake", status: "in_progress", assigneeType: "agent", assigneeId: agent.id });
          const session = store.getOrCreateDefaultIssueSession(issue.id);
          const running = store.createSessionTask(session.id, { agentId: agent.id, prompt: "Running" });
          expect(store.claimTask(runtime.id)?.id).toBe(running.id);
          daemonTaskClaimResponse(store, store.getTaskWithAgent(running.id)!);
          store.startTask(running.id);
          const append = (body: string) => appendCanonicalInboxInput(store, { sessionId: session.id, kind: "system",
            authorType: "system", bodyMd: body, metadata: { envelope: {
              to: { role: "agent", issueSessionId: session.id, agentId: agent.id },
              kind: "report", wake: "now", source: {}, priority: 3,
            } } });
          const first = order === "envelope_first" ? append("Early report") : null;
          const delivery = sendIssueWake(store, db, session.id, agent.id, "now", "Queued report");
          expect(delivery.task!.id).toBe(running.id);
          const second = order === "queued_first" ? append("Late report") : null;
          const highestSeq = Math.max(first?.seq ?? 0, second?.seq ?? 0, delivery.entry.seq);
          store.completeTask(running.id, { output: "Task completed.", sessionId: "ordered_provider" });
          const queued=store.listTasksForIssue(issue.id).filter(row=>row.status==="queued");
          expect(queued).toHaveLength(1);
          const queuedId=queued[0]!.id;
          expect(queuedId).not.toBe(running.id);
          expect(wakeSeq(db, queuedId)).toBe(highestSeq);
          expect(store.getTask(queuedId)!.prompt).toBe(store.getConversationLogEntry(session.id,highestSeq)!.body_md);
          const ring = store.listIssueActivity(issue.id).filter(row => row.type === "re_ring");
          expect(ring).toHaveLength(1);
          expect(ring[0]!.data).toMatchObject({ action: "created", task_id: queuedId });
          expect(store.listIssueActivity(issue.id).filter(row=>row.type==='message_delivered_running')).toHaveLength(2);
          expect(store.getConversationLogEntryById(delivery.entry.id)?.body_md).toBe("Queued report");
        });
      }, 30_000);
    }
  }
});
