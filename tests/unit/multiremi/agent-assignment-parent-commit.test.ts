import { describe, expect, it } from "bun:test";
import { StoreContext } from "@multiremi/store/context.js";
import { conversationLogPgAdminUrl, withConversationLogStore } from "./fixtures/conversation-log-store.js";

describe("agent assignment rederives reopened child parents", () => {
  for (const backend of ["sqlite", "pg"] as const) {
    it.skipIf(backend === "pg" && !conversationLogPgAdminUrl)(`${backend}: a cross-workspace parent or ancestor rejects assignment without reopening`, async () => {
      await withConversationLogStore(backend, (store, db) => {
        store.ensureLocalWorkspace();
        const agent = store.createAgent({ name: "Workspace-bound worker", provider: "claude" });
        for (const level of ["parent", "ancestor"] as const) {
          const foreignWorkspace = store.createWorkspace({ name: "Foreign ancestor", slug: `foreign-${backend}-${level}` });
          const foreign = store.createIssue({ title: "Foreign parent", status: "in_review", workspaceId: foreignWorkspace.id });
          const parent = store.createIssue({ title: "Local parent", status: "in_review" });
          const child = store.createIssue({ title: "Settled child", parentIssueId: parent.id, status: "done" });
          // API writes reject this relation. Simulate corrupt persisted data to
          // prove ancestor discovery cannot silently walk into another workspace.
          db.run("UPDATE multiremi_issues SET parent_issue_id = ? WHERE id = ?",
            [foreign.id, level === "parent" ? child.id : parent.id]);
          const received: string[] = [];
          const unsubscribe = store.onWorkspaceEvent(event => received.push(event.type));
          try {
            expect(() => store.assignIssue(child.id, { assigneeType: "agent", assigneeId: agent.id }))
              .toThrow("Parent issue not found in workspace");
          } finally { unsubscribe(); }
          expect(store.getIssue(child.id)?.status).toBe("done");
          expect(store.getIssue(child.id)?.assigneeId).toBeNull();
          expect(store.listTasksForIssue(child.id)).toHaveLength(0);
          for (const issue of [parent, foreign]) {
            expect(store.getIssue(issue.id)?.status).toBe("in_review");
            expect(store.listIssueActivity(issue.id).filter(a => a.type === "parent_status_derived")).toHaveLength(0);
          }
          expect(received).toHaveLength(0);
          expect(db.inTransaction).toBe(false);
        }
      });
    }, 30_000);

    it.skipIf(backend === "pg" && !conversationLogPgAdminUrl)(`${backend}: recursive derivation locks the complete ancestor set once in id order`, async () => {
      await withConversationLogStore(backend, (store) => {
        store.ensureLocalWorkspace();
        const ctx = (store as unknown as { ctx: StoreContext }).ctx;
        const agent = store.createAgent({ name: "Ancestor worker", provider: "claude" });
        const grandparent = store.createIssue({ title: "Grandparent" });
        const parent = store.createIssue({ title: "Parent", parentIssueId: grandparent.id });
        const child = store.createIssue({ title: "Child", parentIssueId: parent.id, status: "done" });
        ctx.db.run("UPDATE multiremi_issues SET status = 'in_review' WHERE id IN (?, ?)", [parent.id, grandparent.id]);
        const locks: string[] = [];
        const run = ctx.db.run.bind(ctx.db);
        ctx.db.run = (sql, params) => {
          if (sql === "UPDATE multiremi_issues SET id = id WHERE id = ?") locks.push(String(Array.isArray(params) ? params[0] : undefined));
          return run(sql, params);
        };
        const createTask = store.createTask.bind(store);
        store.createTask = input => {
          expect(locks).toEqual([child.id, parent.id, grandparent.id].sort());
          expect(store.getIssue(parent.id)?.status).toBe("in_progress");
          expect(store.getIssue(grandparent.id)?.status).toBe("in_progress");
          ctx.db.run = run;
          return createTask(input);
        };
        try { store.assignIssue(child.id, { assigneeType: "agent", assigneeId: agent.id }); }
        finally { ctx.db.run = run; store.createTask = createTask; }
        for (const issue of [parent, grandparent]) {
          expect(store.listIssueActivity(issue.id).filter(a => a.type === "parent_status_derived")).toHaveLength(1);
        }
      });
    }, 30_000);

    it.skipIf(backend === "pg" && !conversationLogPgAdminUrl)(`${backend}: done/cancelled child reopens and derives its parent before task creation`, async () => {
      await withConversationLogStore(backend, (store) => {
        store.ensureLocalWorkspace();
        const ctx = (store as unknown as { ctx: StoreContext }).ctx;
        const agent = store.createAgent({ name: "Reopen worker", provider: "claude" });
        for (const status of ["done", "cancelled"] as const) {
          const parent = store.createIssue({ title: "Parent", status: "in_review" });
          const child = store.createIssue({ title: "Child", parentIssueId: parent.id, status });
          const original = store.createTask.bind(store);
          store.createTask = (input) => {
            expect(ctx.db.inTransaction).toBe(false);
            expect(store.getIssue(child.id)?.status).toBe("todo");
            expect(store.getIssue(parent.id)?.status).toBe("in_progress");
            expect(store.listIssueActivity(parent.id).filter(a => a.type === "parent_status_derived")).toHaveLength(1);
            return original(input);
          };
          const events: string[] = [];
          const unsubscribe = store.onWorkspaceEvent(event => {
            expect(ctx.db.inTransaction).toBe(false);
            if (event.type === "issue:updated") events.push(event.type);
          });
          try { store.assignIssue(child.id, { assigneeType: "agent", assigneeId: agent.id }); }
          finally { store.createTask = original; unsubscribe(); }
          const audit = store.listIssueActivity(parent.id).find(a => a.type === "parent_status_derived")!;
          expect(audit.data).toMatchObject({ childIssueId: child.id, childStatus: "todo", previousStatus: "in_review", status: "in_progress", openChildren: 1 });
          expect(events.length).toBeGreaterThan(0);
          store.assignIssue(child.id, { assigneeType: "agent", assigneeId: agent.id });
          expect(store.listIssueActivity(parent.id).filter(a => a.type === "parent_status_derived")).toHaveLength(1);
        }
      });
    }, 30_000);

    it.skipIf(backend === "pg" && !conversationLogPgAdminUrl)(`${backend}: assignment failure rolls back child, parent, audit and broadcasts together`, async () => {
      await withConversationLogStore(backend, (store) => {
        store.ensureLocalWorkspace();
        const ctx = (store as unknown as { ctx: StoreContext }).ctx;
        const agent = store.createAgent({ name: "Atomic reopen", provider: "claude" });
        const parent = store.createIssue({ title: "Parent", status: "in_review" });
        const child = store.createIssue({ title: "Child", parentIssueId: parent.id, status: "done" });
        const received: string[] = [];
        store.onWorkspaceEvent(event => received.push(event.type));
        const append = ctx.appendIssueActivity.bind(ctx);
        ctx.appendIssueActivity = (...args: Parameters<StoreContext["appendIssueActivity"]>) => {
          append(...args);
          if (args[1].type === "parent_status_derived") throw new Error("rollback derivation");
        };
        try {
          expect(() => store.assignIssue(child.id, { assigneeType: "agent", assigneeId: agent.id })).toThrow("rollback derivation");
        } finally { ctx.appendIssueActivity = append; }
        expect(store.getIssue(child.id)?.status).toBe("done");
        expect(store.getIssue(child.id)?.assigneeId).toBeNull();
        expect(store.getIssue(parent.id)?.status).toBe("in_review");
        expect(store.listIssueActivity(parent.id).filter(a => a.type === "parent_status_derived")).toHaveLength(0);
        expect(store.listTasksForIssue(child.id)).toHaveLength(0);
        expect(received).toHaveLength(0);
      });
    }, 30_000);

    it.skipIf(backend === "pg" && !conversationLogPgAdminUrl)(`${backend}: terminal and unrelated parent statuses are preserved`, async () => {
      await withConversationLogStore(backend, (store) => {
        store.ensureLocalWorkspace();
        const agent = store.createAgent({ name: "Protected parent", provider: "claude" });
        for (const status of ["done", "cancelled", "todo", "in_progress"] as const) {
          const parent = store.createIssue({ title: "Parent", status });
          const child = store.createIssue({ title: "Child", status: "done", parentIssueId: parent.id });
          store.assignIssue(child.id, { assigneeType: "agent", assigneeId: agent.id });
          expect(store.getIssue(parent.id)?.status).toBe(status);
          expect(store.listIssueActivity(parent.id).filter(a => a.type === "parent_status_derived")).toHaveLength(0);
        }
      });
    }, 30_000);
  }
});
