import { describe, expect, it } from "bun:test";
import { createCommitEventQueue, type StoreContext } from "@multiremi/store/context.js";
import type { IssuesRepo } from "@multiremi/store/repos/issues-repo.js";
import { conversationLogPgAdminUrl as pgAdminUrl, withConversationLogStore as withStore } from "./fixtures/conversation-log-store.js";

describe("MUL-427 merge rulings", () => {
  for (const backend of ["sqlite", "pg"] as const) {
    for (const operation of ["create", "update", "delete", "resolve", "unresolve"] as const) {
      it.skipIf(backend === "pg" && !pgAdminUrl)(`${backend}: ${operation} comment emits every workspace event after its own COMMIT`, async () => {
        await withStore(backend, (store, db) => {
          const agent = store.createAgent({ name: "Comment recipient", provider: "codex", workspaceId: "local" });
          const issue = store.createIssue({ title: "Commit queue", workspaceId: "local" });
          store.assignIssue(issue.id, { assigneeType: "agent", assigneeId: agent.id });
          const comment = store.createIssueComment(issue.id, { body: "Before" });
          if (operation === "unresolve") store.resolveIssueComment(comment.id);
          const triggered = store.listTasksForIssue(issue.id).filter((task) => task.triggerCommentId === comment.id);
          const events: Array<{ type: string; inTransaction: boolean | undefined }> = [];
          const enqueued: Array<boolean | undefined> = [];
          const unsubscribers = [
            store.onWorkspaceEvent((event) => events.push({ type: event.type, inTransaction: db.inTransaction })),
            store.onTaskEnqueued(() => enqueued.push(db.inTransaction)),
            store.onTaskEvent((event) => events.push({ type: event.type, inTransaction: db.inTransaction })),
          ];
          try {
            expect(db.inTransaction).toBe(false);
            if (operation === "create") {
              store.createIssueComment(issue.id, { body: `[@Recipient](mention://agent/${agent.id}) After` });
            } else if (operation === "update") store.updateIssueComment(comment.id, { body: "After" });
            else if (operation === "delete") store.deleteIssueComment(comment.id);
            else if (operation === "resolve") store.resolveIssueComment(comment.id);
            else store.unresolveIssueComment(comment.id);
            expect(events.length).toBeGreaterThan(0);
            expect(events.map((event) => event.type)).toContain("activity:created");
            expect(events.map((event) => event.inTransaction)).toEqual(events.map(() => false));
            expect(enqueued).toEqual(operation === "create" ? [false] : []);
            if (operation === "create") expect(events.map((event) => event.type)).toContain("comment:created");
            if (operation === "update" || operation === "delete") {
              expect(triggered.length).toBeGreaterThan(0);
              expect(triggered.map((task) => store.getTask(task.id)?.status)).toEqual(triggered.map(() => "cancelled"));
            }
          } finally { for (const unsubscribe of unsubscribers) unsubscribe(); }
        });
      }, 30_000);
    }

    for (const dispatch of ["assignee", "delegation return"] as const) {
      it.skipIf(backend === "pg" && !pgAdminUrl)(`${backend}: ${dispatch} task notification belongs to the comment COMMIT`, async () => {
        await withStore(backend, (store, db) => {
          const leader = store.createAgent({ name: "Leader", provider: "codex", workspaceId: "local" });
          const worker = store.createAgent({ name: "Worker", provider: "codex", workspaceId: "local" });
          const issue = store.createIssue({ title: "Dispatch queue", workspaceId: "local" });
          store.assignIssue(issue.id, { assigneeType: "agent", assigneeId: leader.id });
          const source = dispatch === "delegation return" ? store.createTask({
            agentId: worker.id, issueId: issue.id, workspaceId: "local", prompt: "Delegated work",
            delegationId: "dlg_comment_commit", delegatedByAgentId: leader.id,
          }) : null;
          const emitted: Array<boolean | undefined> = [];
          const enqueued: Array<boolean | undefined> = [];
          const unsubscribers = [
            store.onWorkspaceEvent(() => emitted.push(db.inTransaction)),
            store.onTaskEvent(() => emitted.push(db.inTransaction)),
            store.onTaskEnqueued(() => enqueued.push(db.inTransaction)),
          ];
          try {
            const comment = source ? store.createIssueComment(issue.id, {
              authorType: "agent", authorId: worker.id, taskId: source.id,
              body: `[@Leader](mention://agent/${leader.id}) Review the result`,
            }) : store.createIssueComment(issue.id, { body: "Please respond" });
            const task = store.listTasksForIssue(issue.id).find((candidate) => candidate.triggerCommentId === comment.id)!;
            expect(task.agentId).toBe(leader.id);
            if (source) expect(task.parentTaskId).toBe(source.id);
            expect(emitted.length).toBeGreaterThan(0);
            expect(emitted).toEqual(emitted.map(() => false));
            expect(enqueued).toEqual([false]);
          } finally { for (const unsubscribe of unsubscribers) unsubscribe(); }
        });
      }, 30_000);
    }

    it.skipIf(backend === "pg" && !pgAdminUrl)(`${backend}: failed comment deletion leaves trigger tasks queued and emits nothing`, async () => {
      await withStore(backend, (store, db) => {
        const agent = store.createAgent({ name: "Assignee", provider: "codex", workspaceId: "local" });
        const issue = store.createIssue({ title: "Delete rollback", workspaceId: "local" });
        store.assignIssue(issue.id, { assigneeType: "agent", assigneeId: agent.id });
        const comment = store.createIssueComment(issue.id, { body: "Keep on failure" });
        const task = store.listTasksForIssue(issue.id).find((candidate) => candidate.triggerCommentId === comment.id)!;
        if (backend === "pg") {
          db.run("CREATE FUNCTION reject_comment_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'delete rejected'; END; $$ LANGUAGE plpgsql");
          db.run("CREATE TRIGGER reject_comment_delete BEFORE DELETE ON multiremi_issue_comments FOR EACH ROW EXECUTE FUNCTION reject_comment_delete()");
        } else {
          db.exec("CREATE TRIGGER reject_comment_delete BEFORE DELETE ON multiremi_issue_comments BEGIN SELECT RAISE(ABORT, 'delete rejected'); END");
        }
        const emitted: string[] = [];
        const unsubscribers = [
          store.onWorkspaceEvent((event) => emitted.push(event.type)),
          store.onTaskEvent((event) => emitted.push(event.type)),
          store.onTaskEnqueued(() => emitted.push("enqueued")),
        ];
        try {
          expect(() => store.deleteIssueComment(comment.id)).toThrow("delete rejected");
          expect(store.getIssueComment(comment.id)?.body).toBe(comment.body);
          expect(store.getTask(task.id)?.status).toBe("queued");
          expect(emitted).toEqual([]);
        } finally { for (const unsubscribe of unsubscribers) unsubscribe(); }
      });
    }, 30_000);

    // fix A (cmt_bpp6kbt1eccz; ruling cmt_ffadwzab6cnb): the mention dispatch
    // runs after the comment's COMMIT, so its failure reaches the caller but
    // cannot take the member's comment with it — main's "a failed forced start
    // (MUL-458) must not roll back the member's comment", ADR 0011 §3.
    it.skipIf(backend === "pg" && !pgAdminUrl)(`${backend}: late mention SQL failure after COMMIT throws, keeps the comment and emits only outside the transaction`, async () => {
      await withStore(backend, (store, db) => {
        const agent = store.createAgent({ name: "Rejected recipient", provider: "codex", workspaceId: "local" });
        const issue = store.createIssue({ title: "Late rollback", workspaceId: "local" });
        const session = store.getOrCreateDefaultIssueSession(issue.id);
        if (backend === "pg") {
          db.run("CREATE FUNCTION reject_late_mention() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'late mention rejected'; END; $$ LANGUAGE plpgsql");
          db.run("CREATE TRIGGER reject_late_mention BEFORE INSERT ON multiremi_tasks FOR EACH ROW EXECUTE FUNCTION reject_late_mention()");
        } else {
          db.exec("CREATE TRIGGER reject_late_mention BEFORE INSERT ON multiremi_tasks BEGIN SELECT RAISE(ABORT, 'late mention rejected'); END");
        }
        const body = `[@Recipient](mention://agent/${agent.id}) Reject after queuing the comment push`;
        const emitted: Array<{ type: string; inTransaction: boolean | undefined }> = [];
        const unsubscribers = [
          store.onWorkspaceEvent((event) => emitted.push({ type: event.type, inTransaction: db.inTransaction })),
          store.onTaskEnqueued(() => emitted.push({ type: "enqueued", inTransaction: db.inTransaction })),
          store.onTaskEvent((event) => emitted.push({ type: event.type, inTransaction: db.inTransaction })),
        ];
        try {
          expect(() => store.createIssueComment(issue.id, { body })).toThrow("late mention rejected");
          const comments = store.listIssueComments(issue.id);
          expect(comments.map((comment) => comment.body)).toEqual([body]);
          expect(store.getConversationLogEntryById(comments[0]!.id)).toMatchObject({
            session_id: session.id, kind: "message", body_md: body,
          });
          expect(db.query("SELECT data FROM multiremi_issue_activity WHERE issue_id = ? AND type = 'comment_created'").all(issue.id)
            .map((row) => JSON.parse((row as { data: string }).data).commentId)).toEqual([comments[0]!.id]);
          expect(emitted).toEqual([
            { type: "activity:created", inTransaction: false },
            { type: "comment:created", inTransaction: false },
          ]);
          expect(db.query("SELECT id FROM multiremi_tasks").all()).toEqual([]);
        } finally { for (const unsubscribe of unsubscribers) unsubscribe(); }
      });
    }, 30_000);

    it.skipIf(backend === "pg" && !pgAdminUrl)(`${backend}: an existing caller queue retains ownership of comment events`, async () => {
      await withStore(backend, (store, db) => {
        const issue = store.createIssue({ title: "Caller owns COMMIT", workspaceId: "local" });
        store.getOrCreateDefaultIssueSession(issue.id);
        const queue = createCommitEventQueue();
        const emitted: Array<boolean | undefined> = [];
        const unsubscribe = store.onWorkspaceEvent(() => emitted.push(db.inTransaction));
        try {
          db.transaction(() => {
            (store as unknown as { issues: IssuesRepo }).issues.createIssueComment(issue.id, { authorType: "agent", body: "Deferred" }, {
              withinTransaction: true, deferAgentMentionDispatch: true, deferredEvents: queue,
            });
            expect(emitted).toEqual([]);
          })();
          expect(emitted).toEqual([]);
          expect(queue.workspace.map((event) => event.type)).toEqual(["activity:created", "comment:created"]);
          (store as unknown as { ctx: StoreContext }).ctx.emitCommitEvents(queue);
          expect(emitted).toEqual([false, false]);
        } finally { unsubscribe(); }
      });
    }, 30_000);

    it.skipIf(backend === "pg" && !pgAdminUrl)(`${backend}: all three main-produced kinds preserve the dense seq axis and marker targets`, async () => {
      await withStore(backend, (store) => {
        const issue = store.createIssue({ title: "Ruling ③", workspaceId: "local" });
        const session = store.getOrCreateDefaultIssueSession(issue.id);
        const first = store.createIssueComment(issue.id, { body: "First target" });
        const second = store.createIssueComment(issue.id, { body: "Second target" });
        store.resolveIssueComment(second.id, { actorType: "agent", actorId: "agt_resolver" });
        expect(store.getConversationLogEntryById(second.id)).toMatchObject({
          revision: 2, resolved_by_type: "agent", resolved_by_id: "agt_resolver",
        });
        store.unresolveIssueComment(second.id);
        expect(store.getConversationLogEntryById(second.id)).toMatchObject({
          revision: 3, resolved_at: null, resolved_by_type: null, resolved_by_id: null,
        });
        store.resolveIssueComment(first.id);
        const frozen = store.appendSessionEvent(session.id, {
          authorType: "system", kind: "follow_frozen", body: "Follow cost limit reached.",
          metadata: { follow_frozen_seq: 19 },
        });
        const events = store.listSessionEvents(session.id);
        const log = [store.getConversationLogEntry(session.id, 0)!, ...store.listConversationLogEntries(session.id)];
        expect(log).toHaveLength(events.length + 1);
        expect(log.map((entry) => entry.seq)).toEqual(Array.from({ length: log.length }, (_, i) => i));
        expect(log.map((entry) => entry.kind)).toEqual([
          "head", "message", "message", "thread_resolved", "thread_unresolved", "thread_resolved", "follow_frozen",
        ]);
        for (const event of events.filter((event) => event.kind.startsWith("thread_"))) {
          const entry = store.getConversationLogEntry(session.id, event.seq)!;
          expect(entry).toMatchObject({
            id: event.id, seq: event.seq, kind: event.kind, visibility: "hidden",
            author_type: event.authorType, author_id: event.authorId, body_md: event.body,
          });
          const commentId = event.metadata.comment_id as string;
          expect(entry.metadata.target_seq).toBe(store.getConversationLogEntryById(commentId)!.seq);
        }
        expect(store.getConversationLogEntry(session.id, frozen.seq)).toMatchObject({
          id: frozen.id, seq: frozen.seq, kind: "follow_frozen", visibility: "shown",
          author_type: "system", body_md: frozen.body, metadata: frozen.metadata,
        });
        expect(store.getConversationLogHead(session.id)?.headSeq).toBe(events.length);
      });
    }, 30_000);
  }
});
