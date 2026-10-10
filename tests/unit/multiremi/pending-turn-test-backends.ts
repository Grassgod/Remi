import { afterAll, afterEach, beforeAll, beforeEach, describe } from "bun:test";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";
import { createReusableStoreDatabase } from "../../helpers/reusable-store-database.js";
import { createResponsibleTestIssue } from './helpers.js';
import type { CreateIssueInput, MultiremiIssue } from '@multiremi/contracts/types.js';

export interface PendingTurnTestFixture {
  db: SqlDatabase;
  store: MultiremiStore;
  databaseUrl?: string;
  reopen(): void;
  transaction<T>(fn: () => T): T;
  createIssue(input: CreateIssueInput): MultiremiIssue;
}

export function installPendingTurnTestConstraints(fixture: PendingTurnTestFixture): void {
  fixture.transaction(() => {
    // Runtime fixtures use normalized Turns. Historical collapse is tested on
    // bootstrapPreUnifiedSchema by multiremi-pending-turn-migration.test.ts.
    fixture.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_multiremi_turns_pending_lane
      ON multiremi_turns(session_id, agent_id, execution_scope) WHERE status = 'pending'`);
  });
}

/** Fresh remains the default, including reopen/migration/multi-connection cases.
 * Committed-baseline is only for audited serial, synchronous suites: no external
 * Context subscriptions left alive, worker startup, SQL schema changes or
 * environment/clock/UUID injection. Case transactions are never wrapped in a
 * rollback: afterCommit, savepoints, lock order and depth remain real.
 */
export function pendingTurnBackendTests(
  name: string,
  tests: (fixture: () => PendingTurnTestFixture, backend: "SQLite" | "PostgreSQL") => void,
  options: { isolation?: "fresh" | "committed-baseline" } = {},
): void {
  for (const backend of ["SQLite", "PostgreSQL"] as const) {
    const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
    describe.skipIf(backend === "PostgreSQL" && !adminUrl)(`${name} (${backend})`, () => {
      let admin: Bun.SQL | undefined;
      let databaseName: string | undefined;
      let ownsDatabase = false;
      let freshDatabase: SqlDatabase | undefined;
      async function closeFresh() {
        try { freshDatabase?.close(); }
        finally {
          freshDatabase = undefined;
          if (ownsDatabase) {
            await admin!.unsafe(`DROP DATABASE ${databaseName} WITH (FORCE)`);
            ownsDatabase = false;
          }
          databaseName = undefined;
        }
      }
      let current: PendingTurnTestFixture;
      let reusable: ReturnType<typeof createReusableStoreDatabase> | undefined;
      const reuse = options.isolation === "committed-baseline";
      beforeAll(async () => {
        if (reuse) {
          reusable = createReusableStoreDatabase(backend === "SQLite" ? "sqlite" : "postgres", adminUrl, {
            fixture: `pending-turn:${name}`, label: "Pending-turn committed baseline", strictStoreState: true,
          });
          current = {
            db: reusable.db, store: reusable.store, databaseUrl: reusable.databaseUrl,
            transaction<T>(fn: () => T): T { return reusable!.transactionDatabase.transaction(fn)(); },
            createIssue(input) { return createResponsibleTestIssue(current.store, input); },
            reopen() { throw new Error("Reopen tests require fresh pending-turn fixtures"); },
          };
          return;
        }
        if (backend !== "PostgreSQL") return;
        if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(adminUrl!).hostname)) {
          throw new Error("MUL-483 PostgreSQL tests require a local dedicated test server");
        }
        admin = new Bun.SQL(adminUrl!, { max: 1 });
        try { await admin`SELECT 1`; }
        catch (error) { await admin.end(); admin = undefined; throw new Error("Configured MUL-483 test PostgreSQL is unavailable", { cause: error }); }
      }, 30_000);
      beforeEach(async () => {
        if (reuse) { if (!reusable) throw new Error("Reusable pending-turn fixture did not initialize"); reusable.reset(); return; }
        let db: SqlDatabase;
        let databaseUrl: string | undefined;
        if (backend === "PostgreSQL") {
          databaseName = `mul483_${process.pid}_${crypto.randomUUID().replaceAll("-", "")}`;
          await admin!.unsafe(`CREATE DATABASE ${databaseName}`);
          ownsDatabase = true;
          const url = new URL(adminUrl!);
          url.pathname = `/${databaseName}`;
          databaseUrl = url.toString();
          db = new PostgresSyncDatabase(databaseUrl);
        } else {
          db = openSqliteDatabase(":memory:") as unknown as SqlDatabase;
        }
        freshDatabase = db;
        current = {
          db, store: new MultiremiStore(db), databaseUrl,
          transaction<T>(fn: () => T): T {
            return (current.store as unknown as { db: SqlDatabase }).db.transaction(fn)();
          },
          createIssue(input) { return createResponsibleTestIssue(current.store,input); },
          reopen() {
            if (!databaseUrl) return;
            current.db.close();
            current.db = new PostgresSyncDatabase(databaseUrl);
            freshDatabase = current.db;
            current.store = new MultiremiStore(current.db);
          },
        };
        current.store.ensureLocalWorkspace();
      }, 30_000);
      afterEach(async () => {
        if (reuse) {
          // Let already-enqueued notification microtasks reveal themselves before
          // checking idle. Never erase listeners or close an active worker.
          await Promise.resolve();
          reusable?.assertClean();
          return;
        }
        await closeFresh();
      });
      afterAll(async () => {
        if (reusable) {
          try { await reusable.dispose(); }
          finally { console.log("REMI_TEST_DB_FIXTURE_STATS " + JSON.stringify(reusable.stats)); }
        }
        try { await closeFresh(); }
        finally { await admin?.end(); }
      });
      tests(() => current, backend);
    });
  }
}
