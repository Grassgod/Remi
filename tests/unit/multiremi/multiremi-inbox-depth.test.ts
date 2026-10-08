import { expect, it } from "bun:test";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";
import { inboxFlowFixture, triggerInboxFlow, inboxWakeSeq, type InboxFlowScenario } from "./fixtures/inbox-flow-fixture.js";

pendingTurnBackendTests("D1 inbox transaction depth", fixture => {
  for (const scenario of ["e2", "e3", "e4"] as InboxFlowScenario[]) {
    it(`${scenario}: commits the status, envelope and wake in one transaction without nesting`, () => {
      const { db, store } = fixture();
      const flow = inboxFlowFixture(store, scenario);
      const transaction = db.transaction.bind(db);
      const run = db.run.bind(db);
      let depth = 0;
      let maxDepth = 0;
      let writes = 0;
      db.transaction = ((fn: (...args: unknown[]) => unknown) => {
        const runner = transaction(fn);
        return (...args: unknown[]) => {
          depth++;
          maxDepth = Math.max(maxDepth, depth);
          try { return runner(...args); }
          finally { depth--; }
        };
      }) as typeof db.transaction;
      db.run = (sql, params) => {
        if (/INSERT\s+INTO\s+multiremi_turn_attempts/i.test(sql)) {
          expect(db.inTransaction).toBe(true);
          expect(depth).toBe(1);
          writes++;
        }
        return run(sql, params);
      };
      try { triggerInboxFlow(store, flow); }
      finally { db.transaction = transaction; db.run = run; }
      expect(maxDepth).toBe(1);
      expect(writes).toBe(1);
      const tasks = store.listTasksForIssue(flow.targetIssueId).filter(task => task.status === "queued");
      expect(tasks).toHaveLength(1);
      const comments = store.listIssueComments(flow.targetIssueId).filter(comment => comment.authorType === "system");
      expect(comments).toHaveLength(1);
      const entry = store.getConversationLogEntryById(comments[0]!.id)!;
      expect(store.getMessage(entry.id)).toMatchObject({sender_type:'platform',to_agent_id:flow.agentId,wake_applied:'now'});
      expect(inboxWakeSeq(db, tasks[0]!.id)).toBe(entry.seq);
    });
  }
});
