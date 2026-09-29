import { afterAll, afterEach, beforeAll, beforeEach, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";
import { collapsePendingTurnsWithinTransaction, createPendingTurnIndexesWithinTransaction } from "@multiremi/store/pending-turns.js";

export interface PendingTurnTestFixture {
  db: SqlDatabase;
  store: MultiremiStore;
  databaseUrl?: string;
  reopen(): void;
  transaction<T>(fn: () => T): T;
}

export function installPendingTurnTestConstraints(fixture: PendingTurnTestFixture): void {
  fixture.transaction(() => {
    collapsePendingTurnsWithinTransaction(fixture.db);
    createPendingTurnIndexesWithinTransaction(fixture.db);
  });
}

export function pendingTurnBackendTests(
  name: string,
  tests: (fixture: () => PendingTurnTestFixture, backend: "SQLite" | "PostgreSQL") => void,
): void {
  for (const backend of ["SQLite", "PostgreSQL"] as const) {
    const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
    describe.skipIf(backend === "PostgreSQL" && !adminUrl)(`${name} (${backend})`, () => {
      let admin: Bun.SQL | undefined;
      let databaseName: string | undefined;
      let current: PendingTurnTestFixture;
      beforeAll(async () => {
        if (backend !== "PostgreSQL") return;
        if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(adminUrl!).hostname)) {
          throw new Error("MUL-483 PostgreSQL tests require a local dedicated test server");
        }
        admin = new Bun.SQL(adminUrl!, { max: 1 });
        try { await admin`SELECT 1`; }
        catch { throw new Error("Configured MUL-483 test PostgreSQL is unavailable"); }
      });
      beforeEach(async () => {
        let db: SqlDatabase;
        let databaseUrl: string | undefined;
        if (backend === "PostgreSQL") {
          databaseName = `mul483_${process.pid}_${crypto.randomUUID().replaceAll("-", "")}`;
          await admin!.unsafe(`CREATE DATABASE ${databaseName}`);
          const url = new URL(adminUrl!);
          url.pathname = `/${databaseName}`;
          databaseUrl = url.toString();
          db = new PostgresSyncDatabase(databaseUrl);
        } else {
          db = new Database(":memory:") as unknown as SqlDatabase;
        }
        current = {
          db, store: new MultiremiStore(db), databaseUrl,
          transaction<T>(fn: () => T): T {
            return (current.store as unknown as { db: SqlDatabase }).db.transaction(fn)();
          },
          reopen() {
            if (!databaseUrl) return;
            current.db.close();
            current.db = new PostgresSyncDatabase(databaseUrl);
            current.store = new MultiremiStore(current.db);
          },
        };
        current.store.ensureLocalWorkspace();
      }, 30_000);
      afterEach(async () => {
        current?.db.close();
        if (databaseName) {
          await admin!.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
          databaseName = undefined;
        }
      });
      afterAll(async () => { await admin?.end(); });
      tests(() => current, backend);
    });
  }
}
