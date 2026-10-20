import { afterAll, beforeAll } from "bun:test";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { createPostgresStoreTemplate } from "./postgres-store-template.js";
import { createSqliteStoreSnapshotFactory } from "./sqlite-store-snapshot.js";
import { TwoProcessResources } from "./two-process.js";

export interface IntegrationDatabase {
  db: SqlDatabase;
  url?: string;
  close(): Promise<void>;
}

// Opt-in per consuming file (useMigratedIntegrationDatabases). Without it every
// database below is empty and the caller's Store runs the cold migration.
const sqliteSnapshots = createSqliteStoreSnapshotFactory();
let migrated: { template?: ReturnType<typeof createPostgresStoreTemplate> } | undefined;
// Clones still open when the file ends are closed before their template is
// dropped, whichever afterAll (the consumer's or ours) runs first.
const liveClones = new Set<() => Promise<void>>();

/**
 * Call once at the top level of an integration file whose server Store only
 * needs a current schema. Its databases then start migrated (SQLite image /
 * file-owned PostgreSQL TEMPLATE); the caller's new Store still runs the
 * migration entrance, and each call is still its own database that other
 * Stores, processes and restarts open by URL. See the two factories for the
 * exclusions and the fresh fallback.
 */
export function useMigratedIntegrationDatabases(): void {
  beforeAll(async () => {
    const state: NonNullable<typeof migrated> = {};
    const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
    if (adminUrl) {
      const template = createPostgresStoreTemplate(adminUrl, { prefix: "mul463t", fixture: "integration-database" });
      try { await template.prepare(); await template.warm(); }
      catch (error) { await template.dispose(); throw error; }
      state.template = template;
    }
    migrated = state;
  }, 30_000);
  afterAll(async () => {
    const template = migrated?.template;
    migrated = undefined;
    if (!template) return;
    try {
      for (const close of [...liveClones]) await close();
      await template.dispose();
    }
    finally { console.info(`REMI_TEST_DB_FIXTURE_STATS ${JSON.stringify({ ...template.stats(), scope: "file" })}`); }
  });
}

/** Each PG fixture owns a fresh database on the explicitly configured local test server. */
export async function openIntegrationDatabase(): Promise<IntegrationDatabase> {
  const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
  if (!adminUrl) {
    // The image's own Store is discarded; the caller constructs its Store.
    const db = (migrated ? sqliteSnapshots.create().db : openSqliteDatabase(":memory:")) as unknown as SqlDatabase;
    return { db, async close() { db.close(); } };
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(adminUrl).hostname)) {
    throw new Error("Integration fixtures require a local dedicated PostgreSQL test server");
  }
  const template = migrated?.template;
  if (template) {
    const database = await template.createDatabase();
    let db: PostgresSyncDatabase;
    try { db = new PostgresSyncDatabase(database.url); }
    catch (error) { await template.dropDatabase(database.name); throw error; }
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      liveClones.delete(close);
      try { db.close(); }
      finally { await template.dropDatabase(database.name); }
    };
    liveClones.add(close);
    return { db, url: database.url, close };
  }
  const resources = new TwoProcessResources();
  try {
    const database = await resources.freshDatabase();
    const db = new PostgresSyncDatabase(database.url);
    return { db, url: database.url, async close() {
      try { db.close(); } finally { await resources.cleanup(); }
    } };
  } catch (error) {
    await resources.cleanup();
    throw error;
  }
}
