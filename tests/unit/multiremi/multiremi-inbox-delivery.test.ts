import { describe, expect, it, spyOn } from "bun:test";
import { createCommitEventQueue } from "@multiremi/store/context.js";
import { daemonTaskClaimResponse } from "@multiremi/api/wire/tasks.js";
import { conversationLogPgAdminUrl as pgAdminUrl, withConversationLogStore as withStore } from "./fixtures/conversation-log-store.js";

describe("MUL-484 inbox delivery and pending turns", () => {
  for (const backend of ["sqlite", "pg"] as const) {
    const test = it.skipIf(backend === "pg" && !pgAdminUrl);

    test(`${backend}: claim writes a turn receipt after projection; receipt failure leaves the claim usable`, async () => {
      await withStore(backend, (store) => {
        store.ensureLocalWorkspace();
        const runtime = store.registerRuntime({ name: "Inbox runtime", provider: "codex" });
        const agent = store.createAgent({ name: "Inbox owner", provider: "codex", runtimeId: runtime.id });
        const issue = store.createIssue({ title: "Receipt", status: "in_progress", assigneeType: "agent", assigneeId: agent.id });
        const session = store.getOrCreateDefaultIssueSession(issue.id);
        const task = store.createSessionTask(session.id, { agentId: agent.id, prompt: "Read the request" });
        expect(store.claimTask(runtime.id)?.id).toBe(task.id);
        const wire = daemonTaskClaimResponse(store, store.getTaskWithAgent(task.id)!);
        const projection = wire.session_projection as { from_seq: number; to_seq: number };
        expect(store.findTurnEntry(task.id)?.metadata.inbox).toMatchObject({
          delivered_from_seq: projection.from_seq,
          delivered_to_seq: projection.to_seq,
          task_id: task.id,
        });
        expect(typeof store.findTurnEntry(task.id)?.metadata.inbox?.delivered_at).toBe("string");

        const patch = spyOn(store, "recordTaskInboxDelivery").mockImplementation(() => { throw new Error("receipt unavailable"); });
        try {
          expect(daemonTaskClaimResponse(store, store.getTaskWithAgent(task.id)!).session_projection).toBeDefined();
        } finally { patch.mockRestore(); }
        expect(store.getTask(task.id)?.status).toBe("dispatched");
      });
    }, 30_000);

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
            store.appendConversationLog({ sessionId: session.id, kind: "system", authorType: "agent", authorId: agent.id,
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
          if (wake === "now") expect(JSON.parse(rings[0]!.data)).toMatchObject({ action: "coalesced", wake_source: "re_ring" });
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
          const entry = store.appendConversationLog({ sessionId: session.id, kind: "system", authorType: "system",
            bodyMd: "Arrived while running", metadata: { envelope: {
              to: { role: "agent", issueSessionId: session.id, agentId: agent.id },
              kind: "report", wake: "now", source: {}, priority: 3,
            } } });
          if (terminal === "completed") store.completeTask(task.id, { output: "Done", sessionId: "provider_ring" });
          else store.cancelTask(task.id);
          const queued = store.listTasksForIssue(issue.id).filter(row => row.status === "queued");
          expect(queued).toHaveLength(1);
          expect(queued[0]).toMatchObject({ wakeSource: "re_ring", triggerCommentId: null });
          expect(queued[0]!.prompt).toContain(`Session ${session.id}`);
          expect(queued[0]!.prompt).toContain("读收件箱");
          const wakeSeq = Number(db.query("SELECT wake_seq FROM multiremi_tasks WHERE id = ?").get(queued[0]!.id).wake_seq);
          expect(wakeSeq).toBe(entry.seq);
          const cursor = store.getSessionAgentLane(session.id, agent.id)?.cursorSeq ?? 0;
          expect(cursor).toBe(terminal === "completed" ? projection.to_seq : 0);
          const ring = db.query("SELECT data FROM multiremi_issue_activity WHERE issue_id = ? AND type = 're_ring'").get(issue.id) as { data: string };
          expect(JSON.parse(ring.data)).toMatchObject({ action: "created", wake_source: "re_ring", task_id: queued[0]!.id });
        });
      }, 30_000);
    }

    test(`${backend}: covered system turns cancel once, NULL turns still claim, unread now keeps a system turn`, async () => {
      await withStore(backend, (store, db) => {
        store.ensureLocalWorkspace();
        const runtime = store.registerRuntime({ name: "Inbox runtime", provider: "codex" });
        const agent = store.createAgent({ name: "Inbox owner", provider: "codex", runtimeId: runtime.id });
        const issue = store.createIssue({ title: "Covered", status: "in_progress", assigneeType: "agent", assigneeId: agent.id });
        const session = store.getOrCreateDefaultIssueSession(issue.id);
        const covered = store.createTask({ agentId: agent.id, issueId: issue.id, issueSessionId: session.id,
          prompt: "Covered wake", wakeSource: "child_status" });
        const human = store.createTask({ agentId: agent.id, issueId: issue.id, issueSessionId: session.id,
          prompt: "Human round" });
        const head = store.getConversationLogHead(session.id)!.headSeq;
        store.getOrCreateSessionAgentLane(session.id, agent.id);
        db.run("UPDATE multiremi_session_agent_lanes SET cursor_seq = ? WHERE session_id = ? AND agent_id = ?", [head, session.id, agent.id]);
        db.run("UPDATE multiremi_tasks SET wake_seq = ? WHERE id = ?", [head, covered.id]);
        expect(store.claimTask(runtime.id)?.id).toBe(human.id);
        expect(store.getTask(covered.id)?.status).toBe("cancelled");
        const skipped = () => db.query("SELECT data FROM multiremi_issue_activity WHERE issue_id = ? AND type = 'pending_turn_skipped'").all(issue.id) as Array<{ data: string }>;
        expect(skipped()).toHaveLength(1);
        expect(JSON.parse(skipped()[0]!.data)).toMatchObject({ reason: "already_covered", task_id: covered.id });
        expect(store.claimTask(runtime.id)).toBeNull();
        expect(skipped()).toHaveLength(1);

        store.completeTask(human.id, { output: "Done" });
        const unread = store.createTask({ agentId: agent.id, issueId: issue.id, issueSessionId: session.id,
          prompt: "Unread wake", wakeSource: "decision" });
        const cursor = store.getConversationLogHead(session.id)!.headSeq;
        db.run("UPDATE multiremi_session_agent_lanes SET cursor_seq = ? WHERE session_id = ? AND agent_id = ?", [cursor, session.id, agent.id]);
        db.run("UPDATE multiremi_tasks SET wake_seq = ? WHERE id = ?", [cursor, unread.id]);
        store.appendConversationLog({ sessionId: session.id, kind: "system", authorType: "system", bodyMd: "Unread now",
          metadata: { envelope: { to: { role: "agent", issueSessionId: session.id, agentId: agent.id },
            kind: "report", wake: "now", source: {}, priority: 3 } } });
        expect(store.claimTask(runtime.id)?.id).toBe(unread.id);
        expect(skipped()).toHaveLength(1);
      });
    }, 30_000);

    test(`${backend}: an unmerged system wake with wake_seq zero remains claimable`, async () => {
      await withStore(backend, (store, db) => {
        store.ensureLocalWorkspace();
        const runtime = store.registerRuntime({ name: "Legacy runtime", provider: "codex" });
        const agent = store.createAgent({ name: "Legacy owner", provider: "codex", runtimeId: runtime.id });
        const issue = store.createIssue({ title: "Legacy wake", status: "in_progress", assigneeType: "agent", assigneeId: agent.id });
        const session = store.getOrCreateDefaultIssueSession(issue.id);
        const task = store.createTask({ agentId: agent.id, issueId: issue.id, issueSessionId: session.id,
          prompt: "Legacy system round", wakeSource: "child_status" });
        expect(Number(db.query("SELECT wake_seq FROM multiremi_tasks WHERE id = ?").get(task.id).wake_seq)).toBe(0);
        expect(store.claimTask(runtime.id)?.id).toBe(task.id);
        const skipped = db.query("SELECT id FROM multiremi_issue_activity WHERE issue_id = ? AND type = 'pending_turn_skipped'").all(issue.id);
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
        const later = store.appendConversationLog({ sessionId: session.id, kind: "system", authorType: "system", bodyMd: "Later update" });
        expect(later.seq).toBeGreaterThan(first.to_seq);
        db.run("UPDATE multiremi_agents SET runtime_id = ? WHERE id = ?", [nextRuntime.id, agent.id]);
        const stale = new Date(Date.now() - 120_000).toISOString();
        db.run("UPDATE multiremi_tasks SET dispatched_at = ? WHERE id = ?", [stale, task.id]);
        expect(store.claimTask(firstRuntime.id)).toBeNull();
        expect(store.getTask(task.id)).toMatchObject({ status: "queued", projectionToSeq: null });
        db.run("UPDATE multiremi_agents SET runtime_id = ? WHERE id = ?", [firstRuntime.id, agent.id]);
        expect(store.claimTask(firstRuntime.id)?.id).toBe(task.id);
        const second = daemonTaskClaimResponse(store, store.getTaskWithAgent(task.id)!).session_projection as { to_seq: number };
        expect(second.to_seq).toBeGreaterThanOrEqual(later.seq);
      });
    }, 30_000);

    test(`${backend}: legacy delegation coverage and claim coverage cancel a queued turn only once`, async () => {
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
        expect(oldSkips.some(row => JSON.parse(row.data).reason === "covered_by_queued_task")).toBe(true);
        expect(store.getTask(queued.id)?.status).toBe("queued");
        const cursor = store.getConversationLogHead(session.id)!.headSeq;
        store.getOrCreateSessionAgentLane(session.id, leader.id);
        db.run("UPDATE multiremi_session_agent_lanes SET cursor_seq = ? WHERE session_id = ? AND agent_id = ?", [cursor, session.id, leader.id]);
        db.run("UPDATE multiremi_tasks SET wake_seq = ? WHERE id = ?", [cursor, queued.id]);
        expect(store.claimTask(runtime.id)).toBeNull();
        expect(store.getTask(queued.id)?.status).toBe("cancelled");
        expect(Number(db.query("SELECT COUNT(*) AS n FROM multiremi_issue_activity WHERE issue_id = ? AND type = 'pending_turn_skipped'").get(issue.id).n)).toBe(1);
        expect(store.claimTask(runtime.id)).toBeNull();
        expect(Number(db.query("SELECT COUNT(*) AS n FROM multiremi_issue_activity WHERE issue_id = ? AND type = 'pending_turn_skipped'").get(issue.id).n)).toBe(1);
      });
    }, 30_000);
  }
});
