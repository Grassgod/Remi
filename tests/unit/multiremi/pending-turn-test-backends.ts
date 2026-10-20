import { afterAll, afterEach, beforeAll, beforeEach, describe } from "bun:test";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";
import { createReusableStoreDatabase } from "../../helpers/reusable-store-database.js";
import { createPostgresStoreTemplate } from "../../helpers/postgres-store-template.js";
import { createSqliteStoreSnapshotFactory } from "../../helpers/sqlite-store-snapshot.js";
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

// Lazy: the image is built on the first snapshot case of this process.
const sqliteSnapshots = createSqliteStoreSnapshotFactory();

/** Fresh remains the default, including reopen/migration/multi-connection cases.
 * Snapshot is for audited ordinary business suites: every case still gets its
 * own new database, connection and Store (SQLite image clone / PostgreSQL
 * TEMPLATE clone) and the migration entrance still runs its already-migrated
 * path, so reopen, multiple connections, subscriptions and background work stay
 * real. Migration, empty-schema, startup and env/clock/UUID-sensitive suites
 * stay fresh; an incompatible clock/env falls back to fresh per case.
 * Committed-baseline is only for audited serial, synchronous suites: no external
 * Context subscriptions left alive, worker startup, SQL schema changes or
 * environment/clock/UUID injection. Case transactions are never wrapped in a
 * rollback: afterCommit, savepoints, lock order and depth remain real.
 */
export function pendingTurnBackendTests(
  name: string,
  tests: (fixture: () => PendingTurnTestFixture, backend: "SQLite" | "PostgreSQL") => void,
  options: { isolation?: "fresh" | "snapshot" | "committed-baseline" } = {},
): void {
  for (const backend of ["SQLite", "PostgreSQL"] as const) {
    const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
    describe.skipIf(backend === "PostgreSQL" && !adminUrl)(`${name} (${backend})`, () => {
      let admin: Bun.SQL | undefined;
      let databaseName: string | undefined;
      let ownsDatabase = false;
      let freshDatabase: SqlDatabase | undefined;
      let template: ReturnType<typeof createPostgresStoreTemplate> | undefined;
      let snapshotStatsStart: ReturnType<typeof sqliteSnapshots.stats> | undefined;
      async function closeFresh() {
        try { freshDatabase?.close(); }
        finally {
          freshDatabase = undefined;
          if (ownsDatabase) {
            if (template) await template.dropDatabase(databaseName!);
            else await admin!.unsafe(`DROP DATABASE ${databaseName} WITH (FORCE)`);
            ownsDatabase = false;
          }
          databaseName = undefined;
        }
      }
      let current: PendingTurnTestFixture;
      let reusable: ReturnType<typeof createReusableStoreDatabase> | undefined;
      const reuse = options.isolation === "committed-baseline";
      const snapshot = options.isolation === "snapshot";
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
        if (backend !== "PostgreSQL") {
          if (snapshot) snapshotStatsStart = sqliteSnapshots.stats();
          return;
        }
        if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(adminUrl!).hostname)) {
          throw new Error("MUL-483 PostgreSQL tests require a local dedicated test server");
        }
        if (snapshot) {
          const owner = createPostgresStoreTemplate(adminUrl!, { prefix: "mul483t", fixture: `pending-turn-snapshot:${name}` });
          try { await owner.prepare(); await owner.warm(); }
          catch (error) { await owner.dispose(); throw error; }
          template = owner;
          return;
        }
        admin = new Bun.SQL(adminUrl!, { max: 1 });
        try { await admin`SELECT 1`; }
        catch (error) { await admin.end(); admin = undefined; throw new Error("Configured MUL-483 test PostgreSQL is unavailable", { cause: error }); }
      }, 30_000);
      beforeEach(async () => {
        if (reuse) { if (!reusable) throw new Error("Reusable pending-turn fixture did not initialize"); reusable.reset(); return; }
        let db: SqlDatabase;
        let store: MultiremiStore | undefined;
        let databaseUrl: string | undefined;
        if (backend === "PostgreSQL" && template) {
          const database = await template.createDatabase();
          databaseName = database.name;
          ownsDatabase = true;
          databaseUrl = database.url;
          db = new PostgresSyncDatabase(databaseUrl);
        } else if (backend === "PostgreSQL") {
          databaseName = `mul483_${process.pid}_${crypto.randomUUID().replaceAll("-", "")}`;
          await admin!.unsafe(`CREATE DATABASE ${databaseName}`);
          ownsDatabase = true;
          const url = new URL(adminUrl!);
          url.pathname = `/${databaseName}`;
          databaseUrl = url.toString();
          db = new PostgresSyncDatabase(databaseUrl);
        } else if (snapshot) {
          const image = sqliteSnapshots.create();
          db = image.db as unknown as SqlDatabase;
          store = image.store;
        } else {
          db = openSqliteDatabase(":memory:") as unknown as SqlDatabase;
        }
        freshDatabase = db;
        current = {
          db, store: store ?? new MultiremiStore(db), databaseUrl,
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
        finally {
          try { await admin?.end(); }
          finally {
            if (template) {
              try { await template.dispose(); }
              finally { console.log("REMI_TEST_DB_FIXTURE_STATS " + JSON.stringify({ ...template.stats(), scope: "suite" })); }
            }
            if (snapshotStatsStart) {
              const end = sqliteSnapshots.stats();
              console.log("REMI_TEST_DB_FIXTURE_STATS " + JSON.stringify({
                fixture: `pending-turn-snapshot:${name}`, dialect: "sqlite", scope: "suite",
                clones: end.clones - snapshotStatsStart.clones,
                freshFallbacks: end.freshFallbacks - snapshotStatsStart.freshFallbacks,
                coldBootstraps: end.coldBootstraps - snapshotStatsStart.coldBootstraps,
                initializationMs: end.initializationMs - snapshotStatsStart.initializationMs,
              }));
            }
          }
        }
      });
      tests(() => current, backend);
    });
  }
}
