import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { StoreContext } from "@multiremi/store/context.js";
import { IssueLockSetStaleError, type IssuesRepo } from "@multiremi/store/repos/issues-repo.js";
import { conversationLogPgAdminUrl, withConversationLogStore } from "./fixtures/conversation-log-store.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("MUL-482 transaction ownership and retry boundaries", () => {
  for (const backend of ["sqlite", "pg"] as const) {
    it.skipIf(backend === "pg" && !conversationLogPgAdminUrl)(`${backend}: caller-owned claim propagates a stale error without rolling back or retrying`, async () => {
      await withConversationLogStore(backend, (store, db) => {
        store.ensureLocalWorkspace();
        const ctx = (store as unknown as { ctx: StoreContext }).ctx;
        const runtime = store.registerRuntime({ name: "Claim owner", provider: "claude" });
        const agent = store.createAgent({ name: "Claim lane", provider: "claude", runtimeId: runtime.id });
        const issue = store.createIssue({ title: "Before claim" });
        const session = store.getOrCreateDefaultIssueSession(issue.id);
        const task = store.createSessionTask(session.id, { agentId: agent.id, prompt: "Claim round" });
        store.getOrCreateSessionAgentLane(session.id, agent.id);
        ctx.db.run(`UPDATE multiremi_session_lanes SET provider_session_id = 'expired',
          provider = 'claude', runtime_id = ?, cursor_seq = 1, execution_fingerprint = 'expired'
          WHERE session_id = ? AND reader_id = ?`, [runtime.id, session.id, agent.id]);
        const beforeTask = store.getTask(task.id);
        const beforeLane = store.getSessionAgentLane(session.id, agent.id);
        const beforeActivity = store.listIssueActivity(issue.id);
        const received: string[] = [];
        const unsubscribeWorkspace = store.onWorkspaceEvent(event => received.push(event.type));
        const unsubscribeTask = store.onTaskEvent(event => received.push(event.type));
        const stale = new IssueLockSetStaleError();
        const append = ctx.appendIssueActivity.bind(ctx);
        let attempts = 0;
        const appendSpy = spyOn(ctx, "appendIssueActivity").mockImplementation((...args) => {
          const result = append(...args);
          if (args[1].type === "session_agent_lane_reset") {
            attempts += 1;
            // Fail after real dispatch/lane/audit writes, so an accidental
            // inner rollback or a retry of partial state cannot pass unnoticed.
            throw stale;
          }
          return result;
        });
        const transactionSpy = spyOn(db, "transaction");
        try {
          let caught: unknown;
          try {
            ctx.db.transaction(() => {
              ctx.lockWorkspaceRuntimeLifecycle("local");
              ctx.db.run("UPDATE multiremi_issues SET title = ? WHERE id = ?", ["Owner marker", issue.id]);
              try { store.claimTask(runtime.id); } catch (error) { caught = error; }
              expect(caught).toBe(stale);
              expect(attempts).toBe(1);
              expect(transactionSpy).toHaveBeenCalledTimes(1);
              expect(ctx.db.inTransaction).toBe(true);
              expect(store.getTask(task.id)?.status).toBe("dispatched");
              expect(store.getIssue(issue.id)?.title).toBe("Owner marker");
              expect(received).toEqual([]);
              throw stale; // Only the caller rolls back its whole unit.
            })();
          } catch (error) { expect(error).toBe(stale); }
          expect(ctx.db.inTransaction).toBe(false);
          expect(store.getIssue(issue.id)?.title).toBe(issue.title);
          expect(store.getTask(task.id)).toEqual(beforeTask);
          expect(store.getSessionAgentLane(session.id, agent.id)).toEqual(beforeLane);
          expect(store.listIssueActivity(issue.id)).toEqual(beforeActivity);
          expect(received).toEqual([]);
        } finally {
          transactionSpy.mockRestore();
          appendSpy.mockRestore();
          unsubscribeWorkspace();
          unsubscribeTask();
        }
      });
    }, 30_000);

    for (const owner of ["caller", "standalone"] as const) {
      for (const staleAttempts of owner === "caller" ? [1] : [1, 2]) {
        it.skipIf(backend === "pg" && !conversationLogPgAdminUrl)(`${backend}: ${owner} Issue update with ${staleAttempts} stale lock sets`, async () => {
          await withConversationLogStore(backend, (store, db) => {
            store.ensureLocalWorkspace();
            const ctx = (store as unknown as { ctx: StoreContext }).ctx;
            const parent = store.createIssue({ title: "Parent", status: "in_review" });
            const nextParent = store.createIssue({ title: "New parent", status: "in_review" });
            const child = store.createIssue({ title: "Done child", status: "done", parentIssueId: parent.id });
            const beforeActivity = store.listIssueActivity(child.id);
            const beforeParentActivity = store.listIssueActivity(parent.id);
            const received: Array<{ type: string; inTransaction: boolean }> = [];
            const unsubscribe = store.onWorkspaceEvent(event => {
              // Listener errors are swallowed. Record first and assert outside
              // the callback so an early event cannot disappear from the test.
              received.push({ type: event.type, inTransaction: ctx.db.inTransaction === true });
            });
            const issues = (store as unknown as { issues: IssuesRepo }).issues;
            const hookSpy = spyOn(issues, "runIssueUpdatePostCommit");
            const run = db.run.bind(db);
            let attempts = 0;
            const runSpy = spyOn(db, "run").mockImplementation((sql, params) => {
              const result = run(sql, params);
              if (sql === "UPDATE multiremi_issues SET id = id WHERE id = ?" && Array.isArray(params) && params[0] === child.id) {
                attempts += 1;
                if (attempts <= staleAttempts) {
                  // Change the row after discovery and before the locked
                  // re-read. The real lock-set check must throw; do not mock
                  // updateIssue or its stale-error classifier.
                  run("UPDATE multiremi_issues SET parent_issue_id = ? WHERE id = ?", [nextParent.id, child.id]);
                }
              }
              return result;
            });
            const transactionSpy = spyOn(db, "transaction");
            try {
              const update = () => store.updateIssue(child.id, { status: "in_progress" });
              if (owner === "caller") {
                expect(() => ctx.db.transaction(() => {
                  ctx.lockWorkspaceRuntimeLifecycle("local");
                  ctx.db.run("UPDATE multiremi_issues SET title = ? WHERE id = ?", ["Owner marker", child.id]);
                  let caught: unknown;
                  try { update(); } catch (error) { caught = error; }
                  expect(caught).toBeInstanceOf(IssueLockSetStaleError);
                  expect(attempts).toBe(1);
                  expect(transactionSpy).toHaveBeenCalledTimes(1);
                  expect(ctx.db.inTransaction).toBe(true);
                  expect(store.getIssue(child.id)?.title).toBe("Owner marker");
                  expect(store.getIssue(child.id)?.parentIssueId).toBe(nextParent.id);
                  expect(hookSpy).not.toHaveBeenCalled();
                  expect(received).toEqual([]);
                  throw caught;
                })()).toThrow(IssueLockSetStaleError);
              } else if (staleAttempts === 2) {
                expect(update).toThrow(IssueLockSetStaleError);
                expect(transactionSpy).toHaveBeenCalledTimes(2);
              } else {
                expect(update().status).toBe("in_progress");
                expect(hookSpy).toHaveBeenCalledTimes(1);
                expect(received.length).toBeGreaterThan(0);
                expect(received.every(event => !event.inTransaction)).toBe(true);
                expect(store.getIssue(child.id)?.parentIssueId).toBe(parent.id);
                expect(store.listIssueActivity(child.id).filter(a => a.type === "issue_updated")).toHaveLength(
                  beforeActivity.filter(a => a.type === "issue_updated").length + 1);
              }
              expect(attempts).toBe(owner === "caller" ? 1 : 2);
              expect(ctx.db.inTransaction).toBe(false);
              if (owner === "caller" || staleAttempts === 2) {
                expect(store.getIssue(child.id)).toEqual(child);
                expect(store.listIssueActivity(child.id)).toEqual(beforeActivity);
                expect(store.listIssueActivity(parent.id)).toEqual(beforeParentActivity);
                expect(store.listTasksForIssue(child.id)).toEqual([]);
                expect(hookSpy).not.toHaveBeenCalled();
                expect(received).toEqual([]);
              }
            } finally {
              transactionSpy.mockRestore();
              runSpy.mockRestore();
              hookSpy.mockRestore();
              unsubscribe();
            }
          });
        }, 30_000);
      }
    }

    it.skipIf(backend === "pg" && !conversationLogPgAdminUrl)(`${backend}: a successful caller-owned Issue update drops events and hooks on outer rollback`, async () => {
      await withConversationLogStore(backend, (store, db) => {
        store.ensureLocalWorkspace();
        const ctx = (store as unknown as { ctx: StoreContext }).ctx;
        const issue = store.createIssue({ title: "Before update", status: "todo" });
        const beforeActivity = store.listIssueActivity(issue.id);
        const received: string[] = [];
        const unsubscribe = store.onWorkspaceEvent(event => received.push(event.type));
        const hookSpy = spyOn((store as unknown as { issues: IssuesRepo }).issues, "runIssueUpdatePostCommit");
        const transactionSpy = spyOn(db, "transaction");
        try {
          expect(() => ctx.db.transaction(() => {
            expect(store.updateIssue(issue.id, { status: "in_progress", title: "Pending update" }).status).toBe("in_progress");
            expect(transactionSpy).toHaveBeenCalledTimes(1);
            expect(hookSpy).not.toHaveBeenCalled();
            expect(received).toEqual([]);
            throw new Error("Owner rolls back");
          })()).toThrow("Owner rolls back");
          expect(store.getIssue(issue.id)).toEqual(issue);
          expect(store.listIssueActivity(issue.id)).toEqual(beforeActivity);
          expect(hookSpy).not.toHaveBeenCalled();
          expect(received).toEqual([]);
          expect(ctx.db.inTransaction).toBe(false);
        } finally { transactionSpy.mockRestore(); hookSpy.mockRestore(); unsubscribe(); }
      });
    }, 30_000);

    it.skipIf(backend === "pg" && !conversationLogPgAdminUrl)(`${backend}: standalone claim rolls back an unsupported candidate before trying the next agent`, async () => {
      await withConversationLogStore(backend, (store, db) => {
        store.ensureLocalWorkspace();
        const runtime = store.registerRuntime({ name: "Old consumer", provider: "claude" });
        const binaryAgent = store.createAgent({ name: "Binary agent", provider: "claude", skills: [{
          name: "Image", content: "# Image", files: [{ path: "image.png", content: "iVBORw0KGgo=", encoding: "base64" }],
        }] });
        const textAgent = store.createAgent({ name: "Text agent", provider: "claude" });
        const binaryTask = store.createTask({ agentId: binaryAgent.id, prompt: "Image", priority: 100 });
        const textTask = store.createTask({ agentId: textAgent.id, prompt: "Text" });
        const beforeBinary = store.getTask(binaryTask.id);
        const dispatches: Array<{ id: string; inTransaction: boolean }> = [];
        const unsubscribe = store.onTaskEvent(({ type, task }) => {
          if (type === "task:dispatch") dispatches.push({ id: task.id, inTransaction: db.inTransaction === true });
        });
        const transactionSpy = spyOn(db, "transaction");
        try {
          expect(store.claimTask(runtime.id)?.id).toBe(textTask.id);
          expect(transactionSpy).toHaveBeenCalledTimes(2);
          expect(store.getTask(binaryTask.id)).toEqual(beforeBinary);
          expect(dispatches).toEqual([{ id: textTask.id, inTransaction: false }]);
          expect(db.inTransaction).toBe(false);
        } finally { transactionSpy.mockRestore(); unsubscribe(); }
      });
    }, 30_000);
  }
});

describe("stale Issue lane claim events on SQLite", () => {
  function setup() {
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({ name: "Lane worker", provider: "claude" });
    const agent = store.createAgent({ name: "Lane agent", provider: "claude", runtimeId: runtime.id });
    const issue = store.createIssue({ title: "Stale lane" });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const task = store.createSessionTask(session.id, { agentId: agent.id, prompt: "Claim stale lane" });
    store.getOrCreateSessionAgentLane(session.id, agent.id);
    db!.run(
      `UPDATE multiremi_session_lanes SET provider_session_id = 'expired',
       provider = 'claude', runtime_id = ?, cursor_seq = 1,
       execution_fingerprint = 'expired' WHERE session_id = ? AND reader_id = ?`,
      [runtime.id, session.id, agent.id],
    );
    return { store, runtime, issue, task };
  }

  it("publishes the lane reset exactly once after claim commits", () => {
    const { store, runtime, issue, task } = setup();
    const events: boolean[] = [];
    const unsubscribe = store.onWorkspaceEvent((event) => {
      if (event.type === "activity:created" && (event.payload.entry as { action?: string })?.action === "session_agent_lane_reset") {
        events.push(db!.inTransaction);
      }
    });
    try {
      expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    } finally {
      unsubscribe();
    }
    expect(store.listIssueActivity(issue.id).filter((entry) => entry.type === "session_agent_lane_reset")).toHaveLength(1);
    expect(events).toEqual([false]);
  });

  it("drops the lane reset event and row when claim rolls back", () => {
    const { store, runtime, issue, task } = setup();
    const events: string[] = [];
    const unsubscribe = store.onWorkspaceEvent((event) => {
      if (event.type === "activity:created" && (event.payload.entry as { action?: string })?.action === "session_agent_lane_reset") {
        events.push(event.type);
      }
    });
    const original = StoreContext.prototype.appendIssueActivity;
    StoreContext.prototype.appendIssueActivity = function patched(this: StoreContext, issueId, input, queue) {
      original.call(this, issueId, input, queue);
      if (input.type === "session_agent_lane_reset") throw new Error("claim rollback injection");
    };
    try {
      expect(() => store.claimTask(runtime.id)).toThrow("claim rollback injection");
    } finally {
      StoreContext.prototype.appendIssueActivity = original;
      unsubscribe();
    }
    expect(store.listIssueActivity(issue.id).filter((entry) => entry.type === "session_agent_lane_reset")).toHaveLength(0);
    expect(store.getTask(task.id)?.status).toBe("queued");
    expect(events).toEqual([]);
  });
});

describe("optional activity callers in transaction owners on SQLite", () => {
  for (const path of ["held parent", "assign unassign", "update unassign"] as const) {
    function setup() {
      const store = createStore();
      store.ensureLocalWorkspace();
      const agent = store.createAgent({ name: `Owner ${path}`, provider: "claude" });
      const issue = store.createIssue({
        title: `Audit ${path}`,
        assigneeType: "agent",
        assigneeId: agent.id,
        status: "in_progress",
      });
      let taskId: string | null = null;
      if (path === "held parent") {
        store.createIssue({ title: "Open child", parentIssueId: issue.id, status: "in_progress" });
      } else {
        taskId = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Queued work" }).id;
      }
      const run = () => path === "held parent"
        ? store.updateIssue(issue.id, { status: "done" }, { holdParentStatus: true })
        : path === "assign unassign"
          ? store.assignIssue(issue.id, { assigneeType: null, assigneeId: null })
          : store.updateIssue(issue.id, { assigneeType: null, assigneeId: null });
      const action = path === "held parent" ? "parent_status_held" : "issue_unassigned";
      return { store, issue, taskId, run, action };
    }

    it(`${path}: publishes activity after commit`, () => {
      const { store, issue, run, action } = setup();
      const events: Array<{ action: string; inTransaction: boolean }> = [];
      const unsubscribe = store.onWorkspaceEvent((event) => {
        if (event.type === "activity:created") events.push({
          action: (event.payload.entry as { action: string }).action,
          inTransaction: db!.inTransaction,
        });
      });
      try {
        run();
      } finally {
        unsubscribe();
      }
      expect(store.listIssueActivity(issue.id).filter((entry) => entry.type === action)).toHaveLength(1);
      expect(events.filter((event) => event.action === action)).toEqual([{ action, inTransaction: false }]);
      expect(events.filter((event) => event.inTransaction)).toHaveLength(0);
    });

    it(`${path}: drops activity on rollback`, () => {
      const { store, issue, taskId, run, action } = setup();
      const events: string[] = [];
      const unsubscribe = store.onWorkspaceEvent((event) => {
        if (event.type === "activity:created") events.push((event.payload.entry as { action: string }).action);
      });
      const original = StoreContext.prototype.appendIssueActivity;
      StoreContext.prototype.appendIssueActivity = function patched(this: StoreContext, issueId, input, queue) {
        original.call(this, issueId, input, queue);
        if (input.type === action) throw new Error("activity rollback injection");
      };
      try {
        expect(run).toThrow("activity rollback injection");
      } finally {
        StoreContext.prototype.appendIssueActivity = original;
        unsubscribe();
      }
      expect(store.listIssueActivity(issue.id).filter((entry) => entry.type === action)).toHaveLength(0);
      if (taskId) expect(store.getTask(taskId)?.status).toBe("queued");
      expect(events).toEqual([]);
    });
  }
});
