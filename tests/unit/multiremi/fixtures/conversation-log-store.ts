import { afterAll, beforeAll } from "bun:test";
import { bootstrapPreUnifiedSchema } from "@multiremi/store/migrations.js";
import { historicalWriters } from "../unified-model-test-backends.js";
import type { Database } from "bun:sqlite";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { createPostgresStoreTemplate } from "../../../helpers/postgres-store-template.js";
import { createSqliteStoreSnapshotFactory } from "../../../helpers/sqlite-store-snapshot.js";

export const conversationLogPgAdminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;

// Opt-in per consuming file (see useMigratedConversationLogStores). Without it
// every current store below is a fresh database, as before.
const sqliteSnapshots = createSqliteStoreSnapshotFactory();
let migrated: { template?: ReturnType<typeof createPostgresStoreTemplate> } | undefined;

/**
 * Call once at the top level of an ordinary business file: its current (not
 * historical) stores then clone the migrated SQLite image and a file-owned
 * PostgreSQL TEMPLATE instead of migrating an empty database per case. Each
 * case still gets a new database, connection and Store; see the two factories
 * for the exclusions and the fresh fallback.
 */
export function useMigratedConversationLogStores(): void {
  beforeAll(async () => {
    const state: NonNullable<typeof migrated> = {};
    if (conversationLogPgAdminUrl) {
      const template = createPostgresStoreTemplate(conversationLogPgAdminUrl, { prefix: "mul427t", fixture: "conversation-log-store" });
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
    try { await template.dispose(); }
    finally { console.info(`REMI_TEST_DB_FIXTURE_STATS ${JSON.stringify({ ...template.stats(), scope: "file" })}`); }
  });
}

export async function withConversationLogStore(
  backend: "sqlite" | "pg",
  run: (store: MultiremiStore, db: SqlDatabase, target: string) => void | Promise<void>,
  historical = false,
): Promise<void> {
  if (backend === "sqlite") {
    if (migrated && !historical) {
      const { db, store } = sqliteSnapshots.create();
      try {
        store.ensureLocalWorkspace();
        await run(store, db as unknown as SqlDatabase, ":memory:");
      } finally { db.close(); }
      return;
    }
    const db = openSqliteDatabase(":memory:");
    try {
      const store = historical ? historicalConversationStore(db) : currentConversationStore(db);
      await run(store, db, ":memory:");
    } finally { db.close(); }
    return;
  }
  const template = historical ? undefined : migrated?.template;
  if (template) {
    const database = await template.createDatabase();
    let db: PostgresSyncDatabase | undefined;
    try {
      db = new PostgresSyncDatabase(database.url);
      await run(currentConversationStore(db), db, database.url);
    } finally {
      try { db?.close(); }
      finally { await template.dropDatabase(database.name); }
    }
    return;
  }
  const name = `mul427_log_${process.pid}_${Math.floor(Math.random() * 1e8)}`;
  const admin = new Bun.SQL(conversationLogPgAdminUrl!, { max: 1 });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(conversationLogPgAdminUrl!);
  url.pathname = `/${name}`;
  const db = new PostgresSyncDatabase(url.toString());
  try {
    const store = historical ? historicalConversationStore(db) : currentConversationStore(db);
    await run(store, db, url.toString());
  } finally {
    db.close();
    await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
}

function currentConversationStore(db: SqlDatabase): MultiremiStore {
  const store = new MultiremiStore(db);
  store.ensureLocalWorkspace();
  return store;
}

/** Old migration inputs must be seeded before the one-way unified cutover. */
function historicalConversationStore(db: SqlDatabase): MultiremiStore {
  bootstrapPreUnifiedSchema(db);
  return historicalWriters(db) as unknown as MultiremiStore;
}
export async function withHistoricalConversationStore(
  backend: "sqlite" | "pg",
  run: (store: MultiremiStore, db: SqlDatabase, target: string) => void | Promise<void>,
): Promise<void> {
  return withConversationLogStore(backend, run, true);
}
