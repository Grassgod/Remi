import { expect, it } from "bun:test";
import { organizerSettings } from "@multiremi/organizer/settings.js";
import type { StoreContext } from "@multiremi/store/context.js";
import { inboxWakeSeq } from "./fixtures/inbox-flow-fixture.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";

pendingTurnBackendTests("MUL-483 organizer mention atomicity", fixture => {
  function setup() {
    const { db, store } = fixture();
    const organizer = store.createAgent({ name: "Organizer", provider: "codex" });
    store.setAgentSupervisor(organizer.id, true);
    const leader = store.createAgent({ name: "Squad leader", provider: "codex" });
    const squad = store.createSquad({ name: "Organizer squad", leaderId: leader.id,
      memberIds: [organizer.id] });
    const patrol = store.createIssue({ title: "Organizer patrol", assigneeType: "squad", assigneeId: squad.id });
    const auditSession = store.getOrCreateDefaultIssueSession(patrol.id);
    const returnSession = store.createIssueSession(patrol.id, { title: "Leader return", inheritMode: "none" });
    const supervisorTask = store.createTask({ agentId: organizer.id, issueId: patrol.id,
      issueSessionId: auditSession.id, prompt: "Inspect delegated tasks", delegationId: "dlg_organizer_atomicity",
      delegatedByAgentId: leader.id, delegatedFromIssueSessionId: returnSession.id });
    const worker = store.createAgent({ name: "Worker", provider: "codex" });
    const target = store.createIssue({ title: "Organizer target" });
    const targetTask = store.createTask({ agentId: worker.id, issueId: target.id, prompt: "Review target" });
    const workspace = store.getWorkspace("local")!;
    store.updateWorkspace("local", { settings: organizerSettings(workspace, "act") });
    const run = () => store.performOrganizerAction({ supervisorTaskId: supervisorTask.id,
      supervisorAgentId: organizer.id, targetTaskId: targetTask.id, action: "force_answer",
      reason: `Review [@Squad leader](mention://agent/${leader.id})`, content: "Please wrap up" });
    const envelopes = () => store.listConversationLogEntries(returnSession.id).filter(entry =>
      entry.metadata.envelope?.source.taskId === supervisorTask.id);
    const queued = () => store.listTasksForIssue(patrol.id).filter(task =>
      task.agentId === leader.id && task.status === "queued");
    return { db, store, patrol, targetTask, supervisorTask, run, envelopes, queued };
  }

  it("rolls back audit comment, envelope and pending turn when the outer transaction fails", () => {
    const f = setup();
    const issues = (f.store as unknown as { issues: { notifyOrganizerAction: (...args: unknown[]) => void } }).issues;
    const notify = issues.notifyOrganizerAction.bind(issues);
    issues.notifyOrganizerAction = (...args: unknown[]) => {
      notify(...args);
      expect(f.db.inTransaction).toBe(true);
      expect(f.store.listIssueComments(f.patrol.id)).toHaveLength(2);
      expect(f.envelopes()).toHaveLength(1);
      expect(f.queued()).toHaveLength(1);
      throw new Error("audit comment write fault");
    };
    try { expect(f.run).toThrow("audit comment write fault"); }
    finally { issues.notifyOrganizerAction = notify; }
    expect(f.store.listIssueComments(f.patrol.id)).toHaveLength(0);
    expect(f.envelopes()).toHaveLength(0);
    expect(f.queued()).toHaveLength(0);
    expect(f.store.getTask(f.targetTask.id)?.status).toBe("queued");
  });

  it("persists audit, envelope and one turn before post-commit publication", () => {
    const f = setup();
    const context = (f.store as unknown as { ctx: StoreContext }).ctx;
    const publish = context.emitCommitEvents.bind(context);
    const enqueueTransactionStates: boolean[] = [];
    const unsubscribe = f.store.onTaskEnqueued(task => {
      if (task.agentId === f.queued()[0]?.agentId) enqueueTransactionStates.push(Boolean(f.db.inTransaction));
    });
    let depth = 0;
    let maxDepth = 0;
    let taskWrites = 0;
    const transaction = f.db.transaction.bind(f.db);
    const run = f.db.run.bind(f.db);
    f.db.transaction = ((fn: (...args: unknown[]) => unknown) => {
      const runner = transaction(fn);
      return (...args: unknown[]) => {
        depth++;
        maxDepth = Math.max(maxDepth, depth);
        try { return runner(...args); }
        finally { depth--; }
      };
    }) as typeof f.db.transaction;
    f.db.run = (sql, params) => {
      if (/INSERT\s+INTO\s+multiremi_tasks/i.test(sql)) {
        expect(f.db.inTransaction).toBe(true);
        expect(depth).toBe(1);
        taskWrites++;
      }
      return run(sql, params);
    };
    context.emitCommitEvents = queue => {
      expect(f.db.inTransaction).toBe(false);
      publish(queue);
      throw new Error("post-commit publication fault");
    };
    try { expect(f.run).toThrow("post-commit publication fault"); }
    finally {
      context.emitCommitEvents = publish;
      f.db.transaction = transaction;
      f.db.run = run;
      unsubscribe();
    }
    expect(maxDepth).toBe(1);
    expect(taskWrites).toBe(1);
    expect(enqueueTransactionStates).toEqual([false]);
    const comments = f.store.listIssueComments(f.patrol.id);
    expect(comments).toHaveLength(2);
    const entries = f.envelopes();
    expect(entries).toHaveLength(1);
    const tasks = f.queued();
    expect(tasks).toHaveLength(1);
    expect(inboxWakeSeq(f.db, tasks[0]!.id)).toBe(entries[0]!.seq);
  });
});
