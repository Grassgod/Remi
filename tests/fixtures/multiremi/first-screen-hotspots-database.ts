import { afterAll, beforeAll } from "bun:test";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { createPostgresStoreTemplate } from "../../helpers/postgres-store-template.js";
import { createSqliteStoreSnapshotFactory } from "../../helpers/sqlite-store-snapshot.js";

// Opt-in per consuming file (useMigratedHotspotDatabases). Without it every
// database below is empty and the caller's Store runs the cold migration.
const sqliteSnapshots = createSqliteStoreSnapshotFactory();
let migrated: { template?: ReturnType<typeof createPostgresStoreTemplate> } | undefined;
// Clones still open when the file ends: closed before their template is dropped,
// whichever afterAll (the consumer's or ours) runs first.
const liveClones = new Set<() => Promise<void>>();

/**
 * Call once at the top level of a file whose Store is built on these databases
 * only to seed and measure business data. Its databases then start migrated
 * (SQLite image / file-owned PostgreSQL TEMPLATE); the caller's new Store still
 * runs the migration entrance before any probe is reset, and fixture scale,
 * goldens and statement/byte budgets are unchanged. Each call is still its own
 * database; see the two factories for the exclusions and the fresh fallback.
 */
export function useMigratedHotspotDatabases(): void {
  beforeAll(async () => {
    const state: NonNullable<typeof migrated> = {};
    const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
    if (adminUrl) {
      const template = createPostgresStoreTemplate(adminUrl, { prefix: "mul473t", fixture: "first-screen-hotspots-database" });
      try { await template.prepare(); }
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
      for (const dispose of [...liveClones]) await dispose();
      await template.dispose();
    }
    finally { console.info(`REMI_TEST_DB_FIXTURE_STATS ${JSON.stringify({ ...template.stats(), scope: "file" })}`); }
  });
}

// An explicitly configured PG is required to work; never silently fall back.
export async function openHotspotDatabase(): Promise<{ db: SqlDatabase; dispose(): Promise<void> }> {
  const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
  if (!adminUrl) {
    // The image's own Store is discarded; the caller constructs the measured one.
    const db = (migrated ? sqliteSnapshots.create().db : openSqliteDatabase(":memory:")) as unknown as SqlDatabase;
    return { db, dispose: async () => { db.close(); } };
  }
  const template = migrated?.template;
  if (template) {
    const database = await template.createDatabase();
    let db: PostgresSyncDatabase;
    try { db = new PostgresSyncDatabase(database.url); }
    catch (error) { await template.dropDatabase(database.name); throw error; }
    let disposed = false;
    const dispose = async () => {
      if (disposed) return;
      disposed = true;
      liveClones.delete(dispose);
      try { db.close(); }
      finally { await template.dropDatabase(database.name); }
    };
    liveClones.add(dispose);
    return { db, dispose };
  }
  const name = `mul473_${process.pid}_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Bun.SQL(adminUrl, { max: 1 });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const db = new PostgresSyncDatabase(url.toString());
  return {
    db,
    async dispose() {
      db.close();
      const cleanup = new Bun.SQL(adminUrl, { max: 1 });
      try { await cleanup.unsafe(`DROP DATABASE ${name} WITH (FORCE)`); }
      finally { await cleanup.end(); }
    },
  };
}
