import { bootstrapPreUnifiedSchema } from "@multiremi/store/migrations.js";
import { historicalWriters } from "../unified-model-test-backends.js";
import type { Database } from "bun:sqlite";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";

export const conversationLogPgAdminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;

export async function withConversationLogStore(
  backend: "sqlite" | "pg",
  run: (store: MultiremiStore, db: SqlDatabase, target: string) => void | Promise<void>,
  historical = false,
): Promise<void> {
  if (backend === "sqlite") {
    const db = openSqliteDatabase(":memory:");
    try {
      const store = historical ? historicalConversationStore(db) : currentConversationStore(db);
      await run(store, db, ":memory:");
    } finally { db.close(); }
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
