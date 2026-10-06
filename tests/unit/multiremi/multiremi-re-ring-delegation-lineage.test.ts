import { runTurnExecutionMutation } from '@multiremi/store/turn-execution-records.js';
import type { SqlDatabase as UnifiedFixtureDatabase } from '@multiremi/store/db/postgres.js';
import { expect, it } from "bun:test";
import { createCommitEventQueue } from "@multiremi/store/context.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";

pendingTurnBackendTests("MUL-492 recovered nested delegation lineage", fixture => {
  for (const mode of ["periodic", "periodic_no_last", "edit", "delete", "turn_end"] as const) {
    it(`08: ${mode} completes with one return to the original upstream agent and scope`, () => {
      const f = fixture();
      const agent = f.store.createAgent({ name: "Recipient", provider: "codex" });
      const upstream = f.store.createAgent({ name: "Upstream", provider: "codex" });
      const root = f.store.createAgent({ name: "Root", provider: "codex" });
      const worker = f.store.createAgent({ name: "Worker", provider: "codex" });
      const issue = f.store.createIssue({ title: "Nested recovery", status: "in_progress", assigneeType: "agent", assigneeId: agent.id });
      const session = f.store.getOrCreateDefaultIssueSession(issue.id);
      const rootTask=f.store.createTask({agentId:root.id,issueId:issue.id,prompt:"Root work"});
      runTurnExecutionMutation(f.db,"UPDATE multiremi_turn_execution_records SET status='completed' WHERE id=?",[rootTask.id]);
      const upstreamTask = f.store.createTask({ agentId: upstream.id, issueId: issue.id, issueSessionId: session.id,
        prompt: "Upstream work", delegationId: "dlg_upstream_scope", delegatedByAgentId: root.id,
        delegatedFromIssueSessionId: session.id,parentTaskId:rootTask.id });
      const original = f.store.createTask({ agentId: agent.id, issueId: issue.id, issueSessionId: session.id,
        parentTaskId: upstreamTask.id, prompt: "Delegated work", delegationId: "dlg_recipient_scope",
        delegatedByAgentId: upstream.id, delegatedFromIssueSessionId: session.id });
      const trigger={id:original.triggerCommentId!};
      const workerTask = f.store.createTask({ agentId: worker.id, issueId: issue.id, issueSessionId: session.id,
        parentTaskId: original.id, prompt: "Downstream work", delegationId: "dlg_worker_scope",
        delegatedByAgentId: agent.id, delegatedFromIssueSessionId: session.id });
      // A terminal upstream parent must remain terminal after recovery. No
      // hooks run here: this isolates the original source's recovery contract.
      runTurnExecutionMutation(f.db as unknown as UnifiedFixtureDatabase, "UPDATE multiremi_turn_execution_records SET status = 'completed' WHERE id = ?", [upstreamTask.id]);
      runTurnExecutionMutation(f.db as unknown as UnifiedFixtureDatabase, "UPDATE multiremi_turn_execution_records SET status = 'cancelled' WHERE id = ?", [workerTask.id]);
      const periodic = mode.startsWith("periodic");
      if (periodic) runTurnExecutionMutation(f.db as unknown as UnifiedFixtureDatabase, "UPDATE multiremi_turn_execution_records SET status = 'cancelled' WHERE id = ?", [original.id]);
      // A real completed/cancelled ancestor consumes its initial request.
      for(const t of [rootTask,upstreamTask,workerTask]){
        const tr=f.store.getTurn(t.turn_id!)!;
        f.db.run("UPDATE multiremi_session_lanes SET swept_to_seq=? WHERE session_id=? AND reader_id=? AND execution_scope=?",[tr.wake_seq,tr.session_id,tr.agent_id,tr.execution_scope]);
      }
      const runtime = f.store.registerRuntime({ name: "Recovery runtime", provider: "codex" });
      if (mode === "turn_end") {
        expect(f.store.claimTask(runtime.id)!.id).toBe(original.id);
        f.store.startTask(original.id);
      }
      const delivery = f.transaction(() => f.store.sendEnvelopeWithinTransaction({
        to: { role: "delegator", delegationId: "dlg_worker_scope" }, kind: "report",
        wake: "now", body: "Surviving report", source: { taskId: workerTask.id },
      }, [], createCommitEventQueue()))[0]!;
      // These historical terminal sources have already reported. Without the
      // return stamps, the terminal drain correctly recovers their reports too,
      // which would no longer isolate this lane's recovered delegation.
      for (const [source, returned] of periodic ? [[upstreamTask, rootTask], [workerTask, delivery.task!],
        [original, upstreamTask]] : []) {
        runTurnExecutionMutation(f.db, "UPDATE multiremi_turn_execution_records SET delegation_return_task_id=? WHERE id=?",
          [returned!.turn_id!, source!.id]);
      }
      if (periodic) {
        runTurnExecutionMutation(f.db as unknown as UnifiedFixtureDatabase, "UPDATE multiremi_turn_execution_records SET status = 'cancelled' WHERE id = ?", [delivery.task!.id]);
        f.db.run("UPDATE multiremi_turns SET trigger_message_id=NULL WHERE current_attempt_id=?",[delivery.task!.id]);
        f.db.run(`UPDATE multiremi_session_lanes SET last_attempt_id = ?
          WHERE session_id = ? AND reader_id = ? AND execution_scope = ?`,
          [mode === "periodic_no_last" ? null : original.id, session.id, agent.id, "dlg_recipient_scope"]);
        if (mode === "periodic_no_last") runTurnExecutionMutation(f.db as unknown as UnifiedFixtureDatabase, "UPDATE multiremi_turn_execution_records SET created_at = '2000-01-01' WHERE id = ?", [delivery.task!.id]);
        expect(f.store.sweepIdleIssueLanes(Date.now() + 61_000).rang).toBe(1);
      } else if (mode === "delete") {
        f.store.deleteIssueComment(trigger.id);
      } else if (mode === "turn_end") {
        f.store.completeTask(original.id, { output: "Task completed." });
      } else {
        f.store.updateIssueComment(trigger.id, { body: "Changed trigger" });
      }
      const recovered = f.store.listTasksForIssue(issue.id).find(t => t.status === "queued" && t.agentId === agent.id)!;
      expect(f.store.getMessage(f.store.getTurn(recovered.turn_id!)!.trigger_message_id!)?.task_id).toBe(workerTask.turn_id);
      expect(recovered).toMatchObject({ execution_scope: "dlg_recipient_scope", delegatedByAgentId: upstream.id,
        delegationId: "dlg_recipient_scope", wakeSource: "platform_to_owner", chatSessionId: null });
      // Edit/delete and original completion may have returned the old source.
      // Keep those rows for the no-extra-mutation assertion while freeing claim.
      runTurnExecutionMutation(f.db as unknown as UnifiedFixtureDatabase, "UPDATE multiremi_turn_execution_records SET status = 'cancelled' WHERE issue_id = ? AND agent_id <> ? AND status = 'queued'", [issue.id, agent.id]);
      expect(f.store.claimTask(runtime.id)!.id).toBe(recovered.id);
      f.store.startTask(recovered.id);
      const before = f.store.listTasksForIssue(issue.id);
      const beforeIds = new Set(before.map(t => t.id));
      const audits = f.store.listIssueActivity(issue.id).filter(a => a.type === "delegation_return_triggered").length;
      f.store.completeTask(recovered.id, { output: "Task completed." });
      const completed = f.store.getTask(recovered.id)!;
      expect(completed.delegationReturnTaskId).not.toBeNull();
      const returned = f.store.getTask(completed.delegationReturnTaskId!)!;
      expect(f.store.getMessage(f.store.getTurn(returned.turn_id!)!.trigger_message_id!)?.task_id).toBe(recovered.turn_id);
      expect(returned).toMatchObject({ agentId: upstream.id, execution_scope: "dlg_upstream_scope" });
      const after = f.store.listTasksForIssue(issue.id);
      expect(after.filter(t => !beforeIds.has(t.id)).map(t => t.id)).toEqual([returned.id]);
      expect(after.filter(t => t.status === "queued").map(t => t.id)).toEqual([returned.id]);
      for (const old of before.filter(t => t.id !== recovered.id)) expect(f.store.getTask(old.id)!.status).toBe(old.status);
      expect(f.store.getTask(upstreamTask.id)!.status).toBe("completed");
      expect(f.store.listIssueActivity(issue.id).filter(a => a.type === "delegation_return_triggered")).toHaveLength(audits + 1);
    });
  }

  it("08: an unscoped recovery does not acquire a new parent or delegation", () => {
    const f = fixture();
    const agent = f.store.createAgent({ name: "Unscoped", provider: "codex" });
    const issue = f.store.createIssue({ title: "Unscoped recovery" });
    const session = f.store.getOrCreateDefaultIssueSession(issue.id);
    const delivery = f.transaction(() => f.store.sendEnvelopeWithinTransaction({
      to: { role: "agent", agentId: agent.id, issueSessionId: session.id }, kind: "report", wake: "now", body: "Wake", source: {},
    }, [], createCommitEventQueue()))[0]!;
    runTurnExecutionMutation(f.db as unknown as UnifiedFixtureDatabase, "UPDATE multiremi_turn_execution_records SET status = 'cancelled' WHERE id = ?", [delivery.task!.id]);
    f.db.run("UPDATE multiremi_turns SET trigger_message_id=NULL WHERE current_attempt_id=?",[delivery.task!.id]);
    expect(f.store.sweepIdleIssueLanes(Date.now() + 61_000).rang).toBe(1);
    expect(f.store.listTasksForIssue(issue.id).find(t => t.status === "queued"))
      .toMatchObject({ execution_scope: "", parentTaskId: null, delegationId: null, delegatedByAgentId: null });
  });
});
