import { afterAll, beforeAll } from "bun:test";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store/store.js";

import { createPostgresStoreTemplate } from "./postgres-store-template.js";
import { createSqliteStoreSnapshotFactory } from "./sqlite-store-snapshot.js";

export type MigratedStoreBackend = "sqlite" | "postgres";
export interface MigratedStore { store: MultiremiStore; db: SqlDatabase; close(): Promise<void> }

/**
 * Opt-in for ordinary business suites that open a new local-workspace Store per
 * case on both dialects. Each `open()` is still its own database, connection
 * and Store (SQLite image clone / PostgreSQL TEMPLATE clone, see the two
 * factories for the exclusions and the fresh fallback). Call `install()` inside
 * the backend's describe so the PostgreSQL template is owned by that suite.
 */
export function migratedStoreBackend(backend: MigratedStoreBackend, options: { prefix: string; fixture: string }) {
  const sqlite = backend === "sqlite" ? createSqliteStoreSnapshotFactory() : undefined;
  let template: ReturnType<typeof createPostgresStoreTemplate> | undefined;
  return {
    install(): void {
      if (backend !== "postgres") return;
      beforeAll(async () => {
        const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
        if (!adminUrl) throw new Error(`${options.fixture} requires MULTIREMI_TEST_POSTGRES_URL`);
        const owner = createPostgresStoreTemplate(adminUrl, options);
        try { await owner.prepare(); await owner.warm(); }
        catch (error) { await owner.dispose(); throw error; }
        template = owner;
      }, 30_000);
      afterAll(async () => {
        const owner = template;
        template = undefined;
        if (!owner) return;
        try { await owner.dispose(); }
        finally { console.info(`REMI_TEST_DB_FIXTURE_STATS ${JSON.stringify({ ...owner.stats(), scope: "suite" })}`); }
      });
    },
    async open(): Promise<MigratedStore> {
      if (sqlite) {
        const { db, store } = sqlite.create();
        try { store.ensureLocalWorkspace(); }
        catch (error) { db.close(); throw error; }
        return { store, db: db as unknown as SqlDatabase, close: async () => db.close() };
      }
      const owner = template;
      if (!owner) throw new Error(`${options.fixture}: call install() inside the PostgreSQL describe`);
      const database = await owner.createDatabase();
      let db: PostgresSyncDatabase | undefined;
      const close = async () => {
        try { db?.close(); }
        finally { await owner.dropDatabase(database.name); }
      };
      try {
        db = new PostgresSyncDatabase(database.url);
        const store = new MultiremiStore(db);
        store.ensureLocalWorkspace();
        return { store, db, close };
      } catch (error) {
        await close();
        throw error;
      }
    },
  };
}
