import { describe, expect, it } from "bun:test";
import { createRoutingMatrixDatabase } from "../../helpers/routing-matrix-database.js";
import { afterCommit } from "@multiremi/store/db/postgres.js";
import { withRequestReadCache } from "@multiremi/store/request-read-cache.js";

for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !process.env.MULTIREMI_TEST_POSTGRES_URL)(`routing matrix fixture (${dialect})`, () => {
    it("restores native seed values and removes committed cells without restarting the Store", () => {
      const fixture = createRoutingMatrixDatabase(dialect, process.env.MULTIREMI_TEST_POSTGRES_URL);
      try {
        const baseline = fixture.db.query("SELECT * FROM multiremi_workspaces ORDER BY id").all();
        const store = fixture.reset();
        const runtime = store.registerRuntime({ id: "fixture_runtime", name: "cell", provider: "codex" });
        const agent = store.createAgent({ name: "cell", provider: "codex" });
        const task = store.createTask({ agentId: agent.id, prompt: "committed claim" });
        let observed: string | undefined;
        const unsubscribe = store.onTaskEvent(event => { observed = event.task.id; });
        expect(store.claimTask(runtime.id)?.id).toBe(task.id);
        store.startTask(task.id);
        unsubscribe();
        // This event is delivered by the real Store commit, before reset.
        expect(observed).toBe(task.id);
        fixture.db.run("UPDATE multiremi_workspaces SET name = ? WHERE id = ?", ["mutated", "local"]);
        expect(fixture.reset()).toBe(store);
        expect(fixture.db.query("SELECT * FROM multiremi_workspaces ORDER BY id").all()).toEqual(baseline);
        expect(store.getTask(task.id)).toBeNull();
        expect(store.getRuntime(runtime.id)).toBeNull();
        expect(fixture.stats).toMatchObject({ storeInitializations: 1, migrationRuns: 1, resets: 2 });
      } finally {
        fixture.close();
      }
    });

    it("closes its connection when a cell fails", () => {
      const fixture = createRoutingMatrixDatabase(dialect, process.env.MULTIREMI_TEST_POSTGRES_URL);
      const closeDatabase = fixture.db.close.bind(fixture.db);
      let closes = 0;
      fixture.db.close = () => { closes++; closeDatabase(); };
      expect(() => {
        try {
          fixture.reset();
          throw new Error("cell failed");
        } finally {
          fixture.close();
        }
      }).toThrow("cell failed");
      expect(closes).toBe(1);
      fixture.close();
      expect(closes).toBe(1);
    });

    it("refuses request caches, live subscriptions, open transactions and schema changes", () => {
      const fixture = createRoutingMatrixDatabase(dialect, process.env.MULTIREMI_TEST_POSTGRES_URL);
      try {
        expect(() => withRequestReadCache(() => fixture.reset())).toThrow("request read caches");
        const unsubscribe = fixture.store.subscribeConversationLog(() => {});
        expect(() => fixture.reset()).toThrow("subscriptions");
        unsubscribe();
        fixture.db.transaction(() => {
          expect(() => fixture.reset()).toThrow("open transaction");
        })();
        fixture.db.exec("CREATE TABLE routing_schema_mutation (id TEXT)");
        fixture.db.run("INSERT INTO routing_schema_mutation (id) VALUES (?)", ["sentinel"]);
        expect(() => fixture.reset()).toThrow("Schema-changing");
        expect(fixture.db.query("SELECT id FROM routing_schema_mutation").get().id).toBe("sentinel");
      } finally {
        fixture.close();
      }
    });

    if (dialect === "postgres") {
      it("does not retain afterCommit callbacks from a rolled-back probe", () => {
        const fixture = createRoutingMatrixDatabase(dialect, process.env.MULTIREMI_TEST_POSTGRES_URL);
        try {
          let delivered = 0;
          expect(() => fixture.db.transaction(() => {
            afterCommit(fixture.db, () => delivered++);
            throw new Error("rollback probe");
          })()).toThrow("rollback probe");
          fixture.reset();
          fixture.db.transaction(() => afterCommit(fixture.db, () => delivered++))();
          expect(delivered).toBe(1);
        } finally {
          fixture.close();
        }
      });
    }
  });
}

it("rejects a remote PostgreSQL URL before creating any connection", () => {
  expect(() => createRoutingMatrixDatabase("postgres", "postgresql://test:test@example.com/remi_test")).toThrow("localhost PostgreSQL test URL");
});
