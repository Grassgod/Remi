import { describe, expect, it, spyOn } from "bun:test";
import { StoreContext, type WorkspaceEvent } from "@multiremi/store/context.js";
import { IssueLockSetStaleError } from "@multiremi/store/repos/issues-repo.js";
import { conversationLogPgAdminUrl, withConversationLogStore } from "./fixtures/conversation-log-store.js";

describe("agent assignment rederives reopened child parents", () => {
  for (const backend of ["sqlite", "pg"] as const) {
    it.skipIf(backend === "pg" && !conversationLogPgAdminUrl)(`${backend}: a legacy cross-workspace direct parent is ignored on assignment`, async () => {
      await withConversationLogStore(backend, (store, db) => {
        store.ensureLocalWorkspace();
        const agent = store.createAgent({ name: "Workspace-bound worker", provider: "claude" });
        const foreignWorkspace = store.createWorkspace({ name: "Foreign parent", slug: `foreign-${backend}` });
        const foreign = store.createIssue({ title: "Foreign parent", status: "in_review", workspaceId: foreignWorkspace.id });
        const child = store.createIssue({ title: "Settled child", status: "done" });
        // Only raw writes can construct this legacy relation.
        db.run("UPDATE multiremi_issues SET parent_issue_id = ? WHERE id = ?", [foreign.id, child.id]);
        const before = store.listIssueActivity(foreign.id);
        const received: WorkspaceEvent[] = [];
        const unsubscribe = store.onWorkspaceEvent(event => received.push(event));
        try { store.assignIssue(child.id, { assigneeType: "agent", assigneeId: agent.id }); }
        finally { unsubscribe(); }
        expect(store.getIssue(child.id)).toMatchObject({ status: "todo", assigneeType: "agent", assigneeId: agent.id });
        expect(store.listTasksForIssue(child.id)).toHaveLength(1);
        expect(store.getIssue(foreign.id)?.status).toBe("in_review");
        expect(store.listIssueActivity(foreign.id)).toEqual(before);
        expect(received.length).toBeGreaterThan(0);
        expect(received.filter(event => event.workspaceId === foreignWorkspace.id)).toEqual([]);
        expect(received.filter(event => event.payload.issue_id === foreign.id ||
          (event.payload.issue as { id?: string } | undefined)?.id === foreign.id)).toEqual([]);
        expect(db.inTransaction).toBe(false);
      });
    }, 30_000);

    for (const ancestor of ["foreign", "deleted"] as const) {
      it.skipIf(backend === "pg" && !conversationLogPgAdminUrl)(`${backend}: ${ancestor} grandparent stops derivation equally for assignment and PATCH reopen`, async () => {
        await withConversationLogStore(backend, (store, db) => {
          store.ensureLocalWorkspace();
          const agent = store.createAgent({ name: "Local parent worker", provider: "claude" });
          const foreignWorkspace = store.createWorkspace({ name: "Foreign ancestor", slug: `ancestor-${backend}-${ancestor}` });
          const grandparent = store.createIssue({ title: "Grandparent", status: "in_review",
            workspaceId: ancestor === "foreign" ? foreignWorkspace.id : "local" });
          const parent = store.createIssue({ title: "Local parent", status: "in_review" });
          const child = store.createIssue({ title: "Settled child", parentIssueId: parent.id, status: "done" });
          db.run("UPDATE multiremi_issues SET parent_issue_id = ? WHERE id = ?", [grandparent.id, parent.id]);
          if (ancestor === "deleted") db.run("DELETE FROM multiremi_issues WHERE id = ?", [grandparent.id]);
          expect(store.getIssue(parent.id)?.parentIssueId).toBe(grandparent.id);
          const beforeGrandparentActivity = store.listIssueActivity(grandparent.id);
          const derived = () => store.listIssueActivity(parent.id).filter(a => a.type === "parent_status_derived");
          const received: WorkspaceEvent[] = [];
          const unsubscribe = store.onWorkspaceEvent(event => received.push(event));
          try {
            const assigned = store.assignIssue(child.id, { assigneeType: "agent", assigneeId: agent.id });
            expect(store.getIssue(child.id)?.status).toBe("todo");
            expect(store.listTasksForIssue(child.id)).toHaveLength(1);
            expect(store.getIssue(parent.id)?.status).toBe("in_progress");
            expect(derived()).toHaveLength(1);
            const assignmentAudit = derived()[0]!.data;
            expect(assignmentAudit).toMatchObject({ childIssueId: child.id, childStatus: "todo",
              previousStatus: "in_review", status: "in_progress", openChildren: 1 });
            expect(store.getIssue(grandparent.id)?.status ?? null).toBe(ancestor === "foreign" ? "in_review" : null);
            expect(store.listIssueActivity(grandparent.id)).toEqual(beforeGrandparentActivity);
            expect(received.filter(event => event.workspaceId === foreignWorkspace.id ||
              event.payload.issue_id === grandparent.id || (event.payload.issue as { id?: string } | undefined)?.id === grandparent.id)).toEqual([]);

            // Replay PATCH on the same persisted relation and reset statuses,
            // after settling the assignment's task, to compare like for like.
            store.cancelTask(assigned.task!.id);
            db.run("UPDATE multiremi_issues SET status = 'done', assignee_type = NULL, assignee_id = NULL WHERE id = ?", [child.id]);
            db.run("UPDATE multiremi_issues SET status = 'in_review' WHERE id = ?", [parent.id]);
            const beforePatch = derived().length;
            received.length = 0;
            expect(store.updateIssue(child.id, { status: "todo" }).status).toBe("todo");
            expect(store.getIssue(parent.id)?.status).toBe("in_progress");
            expect(derived()).toHaveLength(beforePatch + 1);
            expect(derived().at(-1)!.data).toEqual(assignmentAudit);
            expect(store.getIssue(grandparent.id)?.status ?? null).toBe(ancestor === "foreign" ? "in_review" : null);
            expect(store.listIssueActivity(grandparent.id)).toEqual(beforeGrandparentActivity);
            expect(received.filter(event => event.workspaceId === foreignWorkspace.id ||
              event.payload.issue_id === grandparent.id || (event.payload.issue as { id?: string } | undefined)?.id === grandparent.id)).toEqual([]);
          } finally { unsubscribe(); }
          expect(db.inTransaction).toBe(false);
        });
      }, 30_000);
    }

    it.skipIf(backend === "pg" && !conversationLogPgAdminUrl)(`${backend}: a deleted direct parent rejects assignment and rolls back`, async () => {
      await withConversationLogStore(backend, (store, db) => {
        store.ensureLocalWorkspace();
        const agent = store.createAgent({ name: "Missing parent worker", provider: "claude" });
        const parent = store.createIssue({ title: "Parent", status: "in_review" });
        const child = store.createIssue({ title: "Settled child", parentIssueId: parent.id, status: "done" });
        db.run("DELETE FROM multiremi_issues WHERE id = ?", [parent.id]);
        expect(store.getIssue(child.id)?.parentIssueId).toBe(parent.id);
        const beforeActivity = store.listIssueActivity(child.id);
        const received: WorkspaceEvent[] = [];
        const unsubscribe = store.onWorkspaceEvent(event => received.push(event));
        try {
          expect(() => store.assignIssue(child.id, { assigneeType: "agent", assigneeId: agent.id }))
            .toThrow(`Parent issue not found: ${parent.id}`);
        } finally { unsubscribe(); }
        expect(store.getIssue(child.id)).toEqual(child);
        expect(store.listIssueActivity(child.id)).toEqual(beforeActivity);
        expect(store.listTasksForIssue(child.id)).toEqual([]);
        expect(received).toEqual([]);
        expect(db.inTransaction).toBe(false);
      });
    }, 30_000);

    for (const owner of ["caller", "standalone"] as const) {
      it.skipIf(backend === "pg" && !conversationLogPgAdminUrl)(`${backend}: ${owner} assignment detects an ancestor moved back after discovery`, async () => {
        await withConversationLogStore(backend, (store, db) => {
          store.ensureLocalWorkspace();
          const ctx = (store as unknown as { ctx: StoreContext }).ctx;
          const agent = store.createAgent({ name: "Race worker", provider: "claude" });
          const foreignWorkspace = store.createWorkspace({ name: "Moving parent", slug: `moving-${backend}-${owner}` });
          const grandparent = store.createIssue({ title: "Local grandparent", status: "in_review" });
          const parent = store.createIssue({ title: "Initially foreign parent", status: "in_review", workspaceId: foreignWorkspace.id });
          const child = store.createIssue({ title: "Settled child", status: "done" });
          db.run("UPDATE multiremi_issues SET parent_issue_id = ? WHERE id = ?", [grandparent.id, parent.id]);
          db.run("UPDATE multiremi_issues SET parent_issue_id = ? WHERE id = ?", [parent.id, child.id]);
          const beforeActivity = store.listIssueActivity(child.id);
          const beforeParentActivity = store.listIssueActivity(parent.id);
          const beforeGrandparentActivity = store.listIssueActivity(grandparent.id);
          const received: Array<{ event: WorkspaceEvent; inTransaction: boolean }> = [];
          const unsubscribe = store.onWorkspaceEvent(event => received.push({ event, inTransaction: db.inTransaction === true }));
          const run = db.run.bind(db);
          const transaction = db.transaction.bind(db);
          const lockBatches: string[][] = [];
          let moved = false;
          let attempts = 0;
          // Same deterministic post-discovery fault injection as the Issue
          // retry tests. The actual locked re-read must detect the missing id.
          const moveParent = () => {
            run("UPDATE multiremi_issues SET workspace_id = 'local', issue_number = 10000 WHERE id = ?", [parent.id]);
            run("UPDATE multiremi_issue_sessions SET workspace_id='local' WHERE issue_id=?",[parent.id]);
            run("UPDATE multiremi_conversation_heads SET workspace_id='local' WHERE session_id IN (SELECT id FROM multiremi_issue_sessions WHERE issue_id=?)",[parent.id]);
          };
          const runSpy = spyOn(db, "run").mockImplementation((sql, params) => {
            if (sql === "UPDATE multiremi_issues SET id = id WHERE id = ?") {
              if (!moved) {
                moved = true;
                moveParent();
              }
              lockBatches[attempts - 1]!.push(String(Array.isArray(params) ? params[0] : undefined));
            }
            return run(sql, params);
          });
          const transactionSpy = spyOn(db, "transaction").mockImplementation(fn => {
            const execute = transaction(fn);
            return (...args) => {
              attempts += 1;
              lockBatches.push([]);
              try { return execute(...args); }
              catch (error) {
                // The injected write rolls back with attempt one. Persist the
                // competing writer's move between attempts, outside that unit,
                // so the second discovery sees the newly committed full chain.
                if (owner === "standalone" && error instanceof IssueLockSetStaleError) {
                  expect(db.inTransaction).toBe(false);
                  expect(received).toEqual([]);
                  moveParent();
                }
                throw error;
              }
            };
          });
          const createTask = store.createTask.bind(store);
          store.createTask = input => {
            // Assignment must finish its second complete, sorted lock batch
            // before task creation can add its own unrelated transaction.
            expect(attempts).toBe(2);
            expect(lockBatches).toEqual([[child.id, parent.id].sort(), [child.id, parent.id, grandparent.id].sort()]);
            transactionSpy.mockRestore();
            runSpy.mockRestore();
            return createTask(input);
          };
          try {
            const assign = () => store.assignIssue(child.id, { assigneeType: "agent", assigneeId: agent.id });
            if (owner === "caller") {
              expect(() => ctx.db.transaction(() => {
                let caught: unknown;
                try { assign(); } catch (error) { caught = error; }
                expect(caught).toBeInstanceOf(IssueLockSetStaleError);
                expect(attempts).toBe(1);
                expect(transactionSpy).toHaveBeenCalledTimes(1);
                expect(lockBatches).toEqual([[child.id, parent.id].sort()]);
                expect(db.inTransaction).toBe(true);
                expect(store.getIssue(parent.id)?.workspaceId).toBe("local");
                expect(received).toEqual([]);
                throw caught;
              })()).toThrow(IssueLockSetStaleError);
              expect(store.getIssue(child.id)).toMatchObject({ status: "done", assigneeId: null, parentIssueId: parent.id });
              expect(store.getIssue(parent.id)).toMatchObject({ status: "in_review", workspaceId: foreignWorkspace.id });
              expect(store.getIssue(grandparent.id)?.status).toBe("in_review");
              expect(store.listIssueActivity(child.id)).toEqual(beforeActivity);
              expect(store.listIssueActivity(parent.id)).toEqual(beforeParentActivity);
              expect(store.listIssueActivity(grandparent.id)).toEqual(beforeGrandparentActivity);
              expect(store.listTasksForIssue(child.id)).toEqual([]);
              expect(received).toEqual([]);
            } else {
              expect(assign().issue).toMatchObject({ status: "todo", assigneeId: agent.id });
              expect(store.listTasksForIssue(child.id)).toHaveLength(1);
              for (const ancestor of [parent, grandparent]) {
                expect(store.getIssue(ancestor.id)?.status).toBe("in_progress");
                expect(store.listIssueActivity(ancestor.id).filter(a => a.type === "parent_status_derived")).toHaveLength(1);
              }
              expect(received.length).toBeGreaterThan(0);
              expect(received.every(event => !event.inTransaction)).toBe(true);
            }
            expect(attempts).toBe(owner === "caller" ? 1 : 2);
            expect(db.inTransaction).toBe(false);
          } finally {
            store.createTask = createTask;
            transactionSpy.mockRestore();
            runSpy.mockRestore();
            unsubscribe();
          }
        });
      }, 30_000);
    }

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
