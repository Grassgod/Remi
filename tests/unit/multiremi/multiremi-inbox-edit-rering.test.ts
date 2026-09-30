import { expect, it } from "bun:test";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";
import { createCommitEventQueue, type StoreContext } from "@multiremi/store/context.js";
import { inboxWakeSeq } from "./fixtures/inbox-flow-fixture.js";

pendingTurnBackendTests("D1 T6 comment edit recovery", fixture => {
  function setup() {
    const { db, store } = fixture();
    const agent = store.createAgent({ name: "Edit owner", provider: "codex" });
    const member = store.findWorkspaceMemberForUser("local", "local")!;
    const issue = store.createIssue({ title: "Edit recovery", status: "in_progress", assigneeType: "agent", assigneeId: agent.id });
    const comment = store.createIssueComment(issue.id, { authorType: "member", authorId: member.id,
      body: `Original [@${agent.name}](mention://agent/${agent.id})` });
    const task = store.listTasksForIssue(issue.id).find(task => task.triggerCommentId === comment.id)!;
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const send = () => {
      const events = createCommitEventQueue();
      const result = db.transaction(() => store.sendEnvelopeWithinTransaction({
        to: { role: "issue_owner", issueId: issue.id }, kind: "report", outcome: "done", wake: "now",
        dedupeKey: "later-report", body: "A teammate report committed after the human comment", source: {},
      }, [], events)[0]!)();
      (store as unknown as { ctx: StoreContext }).ctx.emitCommitEvents(events);
      return result;
    };
    return { db, store, agent, member, issue, comment, task, session, send };
  }

  it("T6: editing the triggering comment re-rings a later merged report in the cancellation transaction", () => {
    const f = setup();
    const delivery = f.send();
    expect(delivery.action).toBe("coalesced");
    expect(delivery.task!.id).toBe(f.task.id);
    const triggerSeq = f.store.getConversationLogEntryById(f.comment.id)!.seq;
    expect(inboxWakeSeq(f.db, delivery.task!.id)).toBeGreaterThan(triggerSeq);
    f.store.updateIssueComment(f.comment.id, { body: "Edited without mention" });
    expect(f.store.getTask(f.task.id)!.status).toBe("cancelled");
    const queued = f.store.listTasksForIssue(f.issue.id).filter(task => task.status === "queued");
    expect(queued).toHaveLength(1);
    expect(queued[0]!.wakeSource).toBe("re_ring");
    expect(queued[0]!.triggerCommentId).toBeNull();
    expect(inboxWakeSeq(f.db, queued[0]!.id)).toBe(delivery.entry.seq);
    expect(queued[0]!.prompt).toContain(f.session.id);
    expect(queued[0]!.prompt).not.toContain(delivery.entry.body_md);
    expect(f.store.getConversationLogEntryById(delivery.entry.id)!.body_md).toBe(delivery.entry.body_md);
  });

  it("T6: deleting the triggering comment re-rings a later merged report", () => {
    const f = setup();
    const delivery = f.send();
    expect(delivery.action).toBe("coalesced");
    expect(delivery.task!.id).toBe(f.task.id);
    f.store.deleteIssueComment(f.comment.id);
    expect(f.store.getIssueComment(f.comment.id)).toBeNull();
    expect(f.store.getTask(f.task.id)!.status).toBe("cancelled");
    const queued = f.store.listTasksForIssue(f.issue.id).filter(task => task.status === "queued");
    expect(queued).toHaveLength(1);
    expect(queued[0]!.wakeSource).toBe("re_ring");
    expect(queued[0]!.triggerCommentId).toBeNull();
    expect(inboxWakeSeq(f.db, queued[0]!.id)).toBe(delivery.entry.seq);
    expect(queued[0]!.prompt).not.toContain(delivery.entry.body_md);
    expect(f.store.getConversationLogEntryById(delivery.entry.id)!.body_md).toBe(delivery.entry.body_md);
  });

  it("T6: editing only a coalesced comment cancels neither the original turn nor its report", () => {
    const f = setup();
    const later = f.store.createIssueComment(f.issue.id, { authorType: "member", authorId: f.member.id,
      body: `Later [@${f.agent.name}](mention://agent/${f.agent.id})` });
    expect(f.store.listTasksForIssue(f.issue.id).filter(task => task.status === "queued")).toHaveLength(1);
    const wakeSeq = inboxWakeSeq(f.db, f.task.id);
    expect(wakeSeq).toBe(f.store.getConversationLogEntryById(later.id)!.seq);
    f.store.updateIssueComment(later.id, { body: "Edited later comment" });
    expect(f.store.getTask(f.task.id)!.status).toBe("queued");
    expect(inboxWakeSeq(f.db, f.task.id)).toBe(wakeSeq);
    expect(f.store.listTasksForIssue(f.issue.id).map(task => task.id)).toEqual([f.task.id]);
  });

  it("T6: without merged work, editing only cancels and does not create a system turn", () => {
    const f = setup();
    expect(inboxWakeSeq(f.db, f.task.id)).toBe(f.store.getConversationLogEntryById(f.comment.id)!.seq);
    f.store.updateIssueComment(f.comment.id, { body: "Edited without later work" });
    expect(f.store.listTasksForIssue(f.issue.id).map(task => ({ id: task.id, status: task.status })))
      .toEqual([{ id: f.task.id, status: "cancelled" }]);
  });

  it("T6: a failed re-ring insert rolls back cancellation and preserves the later report", () => {
    const f = setup();
    const delivery = f.send();
    const run = f.db.run.bind(f.db);
    f.db.run = (sql, params) => {
      if (/INSERT\s+INTO\s+multiremi_tasks/i.test(sql)) throw new Error("re-ring write fault");
      return run(sql, params);
    };
    try {
      expect(() => f.store.cancelTasksByTriggerComments("local", [f.comment.id])).toThrow("re-ring write fault");
    } finally { f.db.run = run; }
    expect(f.store.getTask(f.task.id)!.status).toBe("queued");
    expect(inboxWakeSeq(f.db, f.task.id)).toBe(delivery.entry.seq);
    expect(f.store.listTasksForIssue(f.issue.id)).toHaveLength(1);
    expect(f.store.getConversationLogEntryById(delivery.entry.id)).not.toBeNull();
  });
});
