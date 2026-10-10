import { describe, expect, it } from "bun:test";
import { afterCommit } from "@multiremi/store/db/postgres.js";
import { createReusableStoreDatabase } from "../../helpers/reusable-store-database.js";

for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !process.env.MULTIREMI_TEST_POSTGRES_URL)(`pending-turn committed baseline (${dialect})`, () => {
    const create = () => createReusableStoreDatabase(dialect, process.env.MULTIREMI_TEST_POSTGRES_URL, {
      fixture: "pending-turn-reset-contract", label: "Pending-turn committed baseline", strictStoreState: true,
    });
    it("keeps real commits and rollback callbacks while restoring rows, analytics and settled caches", () => {
      const fixture = create();
      try {
        const store = fixture.store;
        const internals = store as unknown as {
          ctx: { analyticsEvents: unknown[]; metricCounters: Map<string, unknown> };
          agentPlugins: { versionCache: Map<string, unknown> };
        };
        const analytics = structuredClone(internals.ctx.analyticsEvents);
        const metrics = structuredClone(internals.ctx.metricCounters);
        const transactionDb = fixture.transactionDatabase;
        let committed = 0;
        transactionDb.transaction(() => {
          afterCommit(transactionDb, () => committed++);
          expect(committed).toBe(0);
        })();
        expect(committed).toBe(1);
        expect(() => transactionDb.transaction(() => {
          afterCommit(transactionDb, () => committed++);
          expect(committed).toBe(1);
          store.createAgent({ name: "Rolled back", provider: "codex" });
          throw new Error("rollback");
        })()).toThrow("rollback");
        expect(committed).toBe(1);
        const agent = store.createAgent({ name: "Committed", provider: "codex" });
        expect(store.getAgent(agent.id)).not.toBeNull();
        internals.agentPlugins.versionCache.set("settled-cached-version", {});
        expect(fixture.reset()).toBe(store);
        expect(store.getAgent(agent.id)).toBeNull();
        expect(internals.ctx.analyticsEvents).toEqual(analytics);
        expect(internals.ctx.metricCounters).toEqual(metrics);
        expect(internals.agentPlugins.versionCache.size).toBe(0);
        expect(fixture.stats.storeInitializations).toBe(1);
      } finally { fixture.close(); }
    });
    it("waits for the original sender after dispatcher timeout, then closes only once", async () => {
      let releaseSender!: () => void;
      const released = new Promise<void>(resolve => { releaseSender = resolve; });
      let announceStarted!: () => void;
      const started = new Promise<void>(resolve => { announceStarted = resolve; });
      let aliveWhileSettling: unknown;
      let expectedThis: unknown;
      const sender = { async send() {
        expectedThis = this;
        announceStarted();
        await released;
        aliveWhileSettling = fixture.db.query("SELECT 1 AS alive").get().alive;
      } };
      const fixture = createReusableStoreDatabase(dialect, process.env.MULTIREMI_TEST_POSTGRES_URL, {
        fixture: "pending-turn-reset-contract", label: "Pending-turn committed baseline", strictStoreState: true,
        notificationSenders: { feishu_group: sender }, notificationSendTimeoutMs: 1,
      });
      const state = fixture.store as unknown as {
        ctx: { createInboxItem(input: Record<string, unknown>): unknown };
        notificationDispatcher: { inFlight: Set<string>; retryTimers: Map<string, unknown>; senders: unknown };
      };
      // Use the real dispatcher timeout race, not a manually erased inFlight.
      const nativeClose = fixture.db.close.bind(fixture.db);
      let closes = 0;
      fixture.db.close = () => { closes++; nativeClose(); };
      let disposal: Promise<unknown> | undefined;
      try {
        fixture.store.createNotificationChannel({ workspaceId: "local", kind: "feishu_group", name: "Timeout regression",
          target: { chatId: "oc_no_network" }, eventTypes: ["*"], minSeverity: "info", createdBy: "local" });
        const member = fixture.store.listWorkspaceMembers("local")[0]!;
        state.ctx.createInboxItem({ workspaceId: "local", memberId: member.id,
          type: "issue_assigned", title: "Sender timeout", body: "body", actorType: "system", actorId: null });
        const delivery = fixture.store.listNotificationDeliveries({ workspaceId: "local" })[0]!;
        const dispatch = fixture.store.dispatchNotificationDelivery(delivery.id);
        await started;
        await dispatch;
        expect(expectedThis).toBe(sender);
        expect(state.notificationDispatcher.inFlight.size).toBe(0);
        expect(() => fixture.assertIdle()).toThrow("background work");
        expect(() => { state.notificationDispatcher.senders = {}; }).toThrow();
        expect(() => { sender.send = async () => {}; }).toThrow();
        // Attach rejection handling immediately; dispose must retain the DB
        // after the timeout until the original deferred send really completes.
        disposal = fixture.dispose().then(() => undefined, error => error);
        await Promise.resolve();
        expect(closes).toBe(0);
        releaseSender();
        const disposalError = await disposal;
        expect(disposalError).toBeInstanceOf(Error);
        expect((disposalError as Error).message).toContain("background work");
        expect(aliveWhileSettling).toBe(1);
        expect(closes).toBe(1);
        expect(state.notificationDispatcher.retryTimers.size).toBe(0);
        await fixture.dispose();
        expect(closes).toBe(1);
      } finally {
        releaseSender();
        await disposal;
        await fixture.dispose().catch(() => {});
      }
    });

    it("fails closed for unfinished scopes and rejects schema changes before erasing case evidence", () => {
      const fixture = create();
      const state = fixture.store as unknown as {
        tasks: { acceptedOfferLeases: Set<string>; taskRequestIssueLocks: Set<string> };
        agentPlugins: { uncommittedVersionIds: Set<string> };
        feishuBot: { replayingOutboundOperation: boolean };
        notificationDispatcher: { inFlight: Set<string> };
      };
      try {
        for (const set of [state.tasks.acceptedOfferLeases, state.tasks.taskRequestIssueLocks, state.agentPlugins.uncommittedVersionIds]) {
          set.add("unfinished");
          try {
            expect(() => fixture.reset()).toThrow("unfinished Store work");
            expect(set.has("unfinished")).toBe(true);
          } finally { set.delete("unfinished"); }
        }
        state.feishuBot.replayingOutboundOperation = true;
        try { expect(() => fixture.reset()).toThrow("unfinished Store work"); }
        finally { state.feishuBot.replayingOutboundOperation = false; }
        state.notificationDispatcher.inFlight.add("worker");
        try {
          expect(() => fixture.reset()).toThrow("background work");
          expect(() => fixture.close()).toThrow("background work");
        } finally { state.notificationDispatcher.inFlight.delete("worker"); }
        if (dialect === "postgres") {
          // Each independent DDL change is rejected before any baseline erase;
          // undo it and prove the original schema is accepted on the same DB.
          for (const [change, undo] of [
            ["ALTER TABLE multiremi_workspaces ADD COLUMN fixture_extra TEXT", "ALTER TABLE multiremi_workspaces DROP COLUMN fixture_extra"],
            ["CREATE INDEX fixture_workspace_name ON multiremi_workspaces(name)", "DROP INDEX fixture_workspace_name"],
            ["ALTER TABLE multiremi_workspaces ADD CONSTRAINT fixture_workspace_name_check CHECK (name IS NOT NULL)", "ALTER TABLE multiremi_workspaces DROP CONSTRAINT fixture_workspace_name_check"],
          ]) {
            fixture.db.exec(change!);
            expect(() => fixture.assertClean()).toThrow("Schema-changing");
            expect(() => fixture.reset()).toThrow("Schema-changing");
            fixture.db.exec(undo!);
            expect(() => fixture.assertClean()).not.toThrow();
          }
        }
        fixture.db.exec("CREATE TABLE pending_reset_schema_change (id TEXT)");
        fixture.db.run("INSERT INTO pending_reset_schema_change (id) VALUES (?)", ["evidence"]);
        expect(() => fixture.assertClean()).toThrow("Schema-changing");
        expect(() => fixture.reset()).toThrow("Schema-changing");
        expect(fixture.db.query("SELECT id FROM pending_reset_schema_change").get().id).toBe("evidence");
        expect(fixture.stats.resets).toBe(0);
      } finally { fixture.close(); }
    });
  });
}
