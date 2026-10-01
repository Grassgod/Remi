import { expect, it } from "bun:test";
import { createCommitEventQueue } from "@multiremi/store/context.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";

pendingTurnBackendTests("MUL-492 recovered nested delegation lineage", fixture => {
  for (const mode of ["periodic", "periodic_no_last", "edit", "delete", "turn_end", "edit_fallback"] as const) {
    it(`08: ${mode} completes with one return to the original upstream agent and scope`, () => {
      const f = fixture();
      const agent = f.store.createAgent({ name: "Recipient", provider: "codex" });
      const upstream = f.store.createAgent({ name: "Upstream", provider: "codex" });
      const root = f.store.createAgent({ name: "Root", provider: "codex" });
      const worker = f.store.createAgent({ name: "Worker", provider: "codex" });
      const issue = f.store.createIssue({ title: "Nested recovery", status: "in_progress", assigneeType: "agent", assigneeId: agent.id });
      const session = f.store.getOrCreateDefaultIssueSession(issue.id);
      const trigger = f.store.createIssueComment(issue.id, { authorType: "system", body: "Original trigger" });
      const upstreamTask = f.store.createTask({ agentId: upstream.id, issueId: issue.id, issueSessionId: session.id,
        prompt: "Upstream work", delegationId: "dlg_upstream_scope", delegatedByAgentId: root.id,
        delegatedFromIssueSessionId: session.id });
      const original = f.store.createTask({ agentId: agent.id, issueId: issue.id, issueSessionId: session.id,
        parentTaskId: upstreamTask.id, prompt: "Delegated work", delegationId: "dlg_recipient_scope",
        delegatedByAgentId: upstream.id, delegatedFromIssueSessionId: session.id, triggerCommentId: trigger.id });
      const workerTask = f.store.createTask({ agentId: worker.id, issueId: issue.id, issueSessionId: session.id,
        parentTaskId: original.id, prompt: "Downstream work", delegationId: "dlg_worker_scope",
        delegatedByAgentId: agent.id, delegatedFromIssueSessionId: session.id });
      // A terminal upstream parent must remain terminal after recovery. No
      // hooks run here: this isolates the original source's recovery contract.
      f.db.run("UPDATE multiremi_tasks SET status = 'completed' WHERE id = ?", [upstreamTask.id]);
      f.db.run("UPDATE multiremi_tasks SET status = 'cancelled' WHERE id = ?", [workerTask.id]);
      const periodic = mode.startsWith("periodic");
      if (periodic) f.db.run("UPDATE multiremi_tasks SET status = 'cancelled' WHERE id = ?", [original.id]);
      const runtime = f.store.registerRuntime({ name: "Recovery runtime", provider: "codex" });
      if (mode === "turn_end") {
        expect(f.store.claimTask(runtime.id)!.id).toBe(original.id);
        f.store.startTask(original.id);
      }
      const delivery = f.transaction(() => f.store.sendEnvelopeWithinTransaction({
        to: { role: "delegator", delegationId: "dlg_worker_scope" }, kind: "report",
        wake: mode === "edit_fallback" ? "inbox_only" : "now", body: "Surviving report", source: { taskId: workerTask.id },
      }, [], createCommitEventQueue()))[0]!;
      if (periodic) {
        f.db.run("UPDATE multiremi_tasks SET status = 'cancelled' WHERE id = ?", [delivery.task!.id]);
        f.db.run(`UPDATE multiremi_session_agent_lanes SET last_task_id = ?
          WHERE session_id = ? AND agent_id = ? AND execution_scope = ?`,
          [mode === "periodic_no_last" ? null : original.id, session.id, agent.id, "dlg_recipient_scope"]);
        if (mode === "periodic_no_last") f.db.run("UPDATE multiremi_tasks SET created_at = '2000-01-01' WHERE id = ?", [delivery.task!.id]);
        expect(f.store.sweepIdleIssueLanes(Date.now() + 61_000).rang).toBe(1);
      } else if (mode === "delete") {
        f.store.deleteIssueComment(trigger.id);
      } else if (mode === "turn_end") {
        // Lose the queued wake while the original round is still running,
        // so its terminal hook must create the recovery instead of coalescing.
        f.db.run("UPDATE multiremi_tasks SET status = 'cancelled' WHERE id = ?", [delivery.task!.id]);
        f.store.completeTask(original.id, { output: "Task completed." });
      } else {
        // Model a merged non-now inbox item. Terminal re-ring ignores it;
        // comment cancellation's wake_seq fallback must carry the lineage.
        if (mode === "edit_fallback") f.db.run("UPDATE multiremi_tasks SET wake_seq = ? WHERE id = ?", [delivery.entry.seq, original.id]);
        f.store.updateIssueComment(trigger.id, { body: "Changed trigger" });
      }
      const recovered = f.store.listTasksForIssue(issue.id).find(t => t.status === "queued" && t.agentId === agent.id)!;
      expect(recovered).toMatchObject({ execution_scope: "dlg_recipient_scope", delegatedByAgentId: upstream.id,
        delegationId: "dlg_recipient_scope", parentTaskId: upstreamTask.id, wakeSource: "re_ring", chatSessionId: null });
      // Edit/delete and original completion may have returned the old source.
      // Keep those rows for the no-extra-mutation assertion while freeing claim.
      f.db.run("UPDATE multiremi_tasks SET status = 'cancelled' WHERE issue_id = ? AND agent_id <> ? AND status = 'queued'", [issue.id, agent.id]);
      expect(f.store.claimTask(runtime.id)!.id).toBe(recovered.id);
      f.store.startTask(recovered.id);
      const before = f.store.listTasksForIssue(issue.id);
      const beforeIds = new Set(before.map(t => t.id));
      const audits = f.store.listIssueActivity(issue.id).filter(a => a.type === "delegation_return_triggered").length;
      f.store.completeTask(recovered.id, { output: "Task completed." });
      const completed = f.store.getTask(recovered.id)!;
      expect(completed.delegationReturnTaskId).not.toBeNull();
      const returned = f.store.getTask(completed.delegationReturnTaskId!)!;
      expect(returned).toMatchObject({ agentId: upstream.id, execution_scope: "dlg_upstream_scope", parentTaskId: recovered.id });
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
    f.db.run("UPDATE multiremi_tasks SET status = 'cancelled' WHERE id = ?", [delivery.task!.id]);
    expect(f.store.sweepIdleIssueLanes(Date.now() + 61_000).rang).toBe(1);
    expect(f.store.listTasksForIssue(issue.id).find(t => t.status === "queued"))
      .toMatchObject({ execution_scope: "", parentTaskId: null, delegationId: null, delegatedByAgentId: null });
  });
});
