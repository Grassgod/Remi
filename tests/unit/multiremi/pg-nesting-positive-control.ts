/**
 * Manual diagnostic fixture, deliberately not named *.test.ts.
 * MULTIREMI_TEST_POSTGRES_URL=… MUL406_NESTING_REPORT=/tmp/positive.jsonl \
 *   bun test --preload ./tests/unit/multiremi/pg-nesting-preload.ts \
 *     ./tests/unit/multiremi/pg-nesting-positive-control.ts
 * Run separately from the clean scan. Requires real PostgreSQL.
 */
import { expect, test } from "bun:test";
import { afterCommit, PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { StoreContext, type StoreContextHost } from "@multiremi/store/context.js";
import { installProbes, report, withPositiveControl, positiveControlPassed } from "./pg-nesting-preload.js";
import { withConversationLogStore } from "./fixtures/conversation-log-store.js";
const channels = [
  "workspaceEventListeners", "taskEventListeners", "taskEnqueuedListeners",
  "taskMessagesListeners", "humanRequestListeners",
] as const;
const snapshot = () => JSON.parse(report()).positiveControl;

test("PG scanner positive control: five channels, connection ownership and nesting classification", async () => {
  expect(process.env.MULTIREMI_TEST_POSTGRES_URL).toBeDefined();
  await withConversationLogStore("pg", (store, db) => {
    if (!(db instanceof PostgresSyncDatabase)) throw new Error("control requires a real PG handle");
    const ctx = new StoreContext(db, () => ({} as StoreContextHost));
    installProbes(ctx);
    store.ensureLocalWorkspace();
    const agent = store.createAgent({ name: "Classification control", provider: "claude" });
    const other = new PostgresSyncDatabase(process.env.MULTIREMI_TEST_POSTGRES_URL!);
    const otherCtx = new StoreContext(other, () => ({} as StoreContextHost));
    installProbes(otherCtx);
    try { withPositiveControl(() => {
      db.transaction(() => {
        for (const field of channels) {
          expect(ctx[field].size).toBe(1);
          // Deliberately broken emitter: no afterCommit, no business subscriber.
          for (const listener of ctx[field]) (listener as () => void)();
        }
        db.transaction(() => {})();
        // Other connection is not in a transaction: no false delivery/nesting.
        otherCtx.emitWorkspaceEvent({ type: "other", workspaceId: "probe", payload: {} });
        other.transaction(() => {})();
      })();
      expect(snapshot().event_in_transaction.total).toBe(5);
      expect(snapshot().nesting.testDirect.total).toBe(1);
      expect(snapshot().nesting.productPath.total).toBe(0);
      // Outer test frame around a product entry point must remain a product hit.
      db.transaction(() => store.updateAgent(agent.id, { name: "Product caller" }))();
      expect(snapshot().nesting.productPath.total).toBe(1);
      // A transparent counter in tests must not hide a packages caller.
      const transaction = db.transaction.bind(db);
      db.transaction = function<T>(fn: (...args: any[]) => T): (...args: any[]) => T {
        const run = transaction(fn);
        return (...args: any[]) => run(...args);
      };
      db.transaction(() => store.updateAgent(agent.id, { name: "Instrumented caller" }))();
      db.transaction = transaction;
      expect(snapshot().nesting.productPath.total).toBe(2);
      const observations: boolean[] = [];
      db.transaction(() => {
        afterCommit(db, () => {
          observations.push(db.inTransaction);
          db.transaction(() => observations.push(db.inTransaction))();
          ctx.emitWorkspaceEvent({ type: "probe", workspaceId: "probe", payload: {} });
        });
      })();
      expect(observations).toEqual([false, true]);
      expect(snapshot().event_in_transaction.total).toBe(5);
      expect(snapshot().nested_transaction.total).toBe(3);
      expect(snapshot().nesting.unclassified.total).toBe(0);
      positiveControlPassed();
    }); } finally { other.close(); }
  });
}, 30_000);

