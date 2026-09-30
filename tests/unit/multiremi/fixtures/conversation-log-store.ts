import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";

export const conversationLogPgAdminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;

export async function withConversationLogStore(
  backend: "sqlite" | "pg",
  run: (store: MultiremiStore, db: SqlDatabase, target: string) => void | Promise<void>,
): Promise<void> {
  if (backend === "sqlite") {
    const db = openSqliteDatabase(":memory:");
    try { await run(new MultiremiStore(db), db, ":memory:"); } finally { db.close(); }
    return;
  }
  const name = `mul427_log_${process.pid}_${Math.floor(Math.random() * 1e8)}`;
  const admin = new Bun.SQL(conversationLogPgAdminUrl!, { max: 1 });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(conversationLogPgAdminUrl!);
  url.pathname = `/${name}`;
  const db = new PostgresSyncDatabase(url.toString());
  try { await run(new MultiremiStore(db), db, url.toString()); } finally {
    db.close();
    await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
}
