import { createResponsibleTestIssue } from './helpers.js';
/**
 * MUL-400 E3 blocking 4 (MUL-409 fix round 2): the automatic-start chain must
 * stay a single transaction on the Postgres bridge.
 *
 * When this was written `PostgresSyncDatabase.transaction()` was a bare
 * BEGIN/COMMIT pair, so a nested BEGIN let the inner COMMIT end the outer unit
 * early and a later ROLLBACK could not undo it. Since MUL-405 a nested
 * `transaction()` is a SAVEPOINT inside the outer unit, and
 * `maxTransactionDepth` counts every frame, the SAVEPOINT included. The entry
 * points below still hold depth 1 exactly, with no nested frame — see
 * docs/adr/0011-transaction-ownership-and-side-effect-timing.md. The depth
 * counter is asserted for the
 * three scenarios the fix round names: auto-start after a prerequisite is done,
 * two prerequisites finishing, and the member forced start.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";
import { inboxFlowFixture, triggerInboxFlow } from "./fixtures/inbox-flow-fixture.js";

afterEach(resetMultiremiTestEnv);

describe("MUL-400 E3 — automatic start stays one transaction (SQLite)", () => {
  it("inserts the E3 notification turn inside the prerequisite transaction at depth 1", () => {
    const store = createStore();
    const flow = inboxFlowFixture(store, "e3");
    const database = db!;
    const transaction = database.transaction.bind(database);
    const run = database.run.bind(database);
    let depth = 0;
    let maxDepth = 0;
    const inserts: Array<{ depth: number; inTransaction: boolean }> = [];
    database.transaction = ((fn: (...args: unknown[]) => unknown) => {
      const runner = transaction(fn);
      return (...args: unknown[]) => {
        maxDepth = Math.max(maxDepth, ++depth);
        try { return runner(...args); }
        finally { depth--; }
      };
    }) as typeof database.transaction;
    database.run = (sql, params) => {
      if (/INSERT\s+INTO\s+multiremi_turn_attempts/i.test(sql)) inserts.push({ depth, inTransaction: database.inTransaction });
      return run(sql, params);
    };
    try { triggerInboxFlow(store, flow); }
    finally { database.transaction = transaction; database.run = run; }
    expect(maxDepth).toBe(1);
    expect(inserts).toEqual([{ depth: 1, inTransaction: true }]);
  });

  it("auto-starts after a prerequisite is done without nesting", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({ id: "rt_depth", name: "Worker", provider: "claude", maxConcurrency: 4 });
    const agent = store.createAgent({ name: "Owner", provider: "claude", runtimeId: runtime.id });
    const prereq = createResponsibleTestIssue(store, { title: "Prerequisite", status: "in_progress", assigneeType: "agent", assigneeId: agent.id });
    const dependent = createResponsibleTestIssue(store, { title: "Dependent", status: "backlog", blockedBy: [prereq.id], assigneeType: "agent", assigneeId: agent.id });
    const task = store.createTask({ agentId: agent.id, issueId: prereq.id, prompt: "finish" });
    let claimed = store.claimTask(runtime.id);
    while (claimed && claimed.id !== task.id) claimed = store.claimTask(runtime.id);
    store.startTask(task.id);
    store.completeTask(task.id, { output: "done" });

    store.updateIssue(prereq.id, { status: "done" });
    expect(store.getIssue(dependent.id)!.status).toBe("todo");
    expect(store.listTasksForIssue(dependent.id).filter((row) => row.status !== "cancelled")).toHaveLength(1);
  });

  it("dispatches once when two prerequisites finish", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({ id: "rt_depth2", name: "Worker", provider: "claude", maxConcurrency: 4 });
    const agent = store.createAgent({ name: "Owner", provider: "claude", runtimeId: runtime.id });
    const first = createResponsibleTestIssue(store, { title: "First", status: "in_progress" });
    const second = createResponsibleTestIssue(store, { title: "Second", status: "in_progress" });
    const dependent = createResponsibleTestIssue(store, {
      title: "Dependent",
      status: "backlog",
      blockedBy: [first.id, second.id],
      assigneeType: "agent",
      assigneeId: agent.id,
    });

    store.updateIssue(first.id, { status: "done" });
    expect(store.getIssue(dependent.id)!.status).toBe("backlog");
    store.updateIssue(second.id, { status: "done" });
    expect(store.getIssue(dependent.id)!.status).toBe("todo");
    expect(store.listTasksForIssue(dependent.id).filter((row) => row.status !== "cancelled")).toHaveLength(1);
  });

  it("force-starts without nesting", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({ id: "rt_depth3", name: "Worker", provider: "claude", maxConcurrency: 4 });
    const agent = store.createAgent({ name: "Owner", provider: "claude", runtimeId: runtime.id });
    const prereq = createResponsibleTestIssue(store, { title: "Prerequisite", status: "in_progress" });
    const dependent = createResponsibleTestIssue(store, {
      title: "Dependent",
      status: "backlog",
      blockedBy: [prereq.id],
      assigneeType: "agent",
      assigneeId: agent.id,
    });

    store.updateIssue(dependent.id, { status: "todo", force: true, actorType: "member", actorId: "local" });
    expect(store.getIssue(dependent.id)!.status).toBe("todo");
    expect(store.listTasksForIssue(dependent.id).filter((row) => row.status !== "cancelled")).toHaveLength(1);
  });
});
