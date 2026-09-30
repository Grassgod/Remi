import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";

// An explicitly configured PG is required to work; never silently fall back.
export async function openHotspotDatabase(): Promise<{ db: SqlDatabase; dispose(): Promise<void> }> {
  const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
  if (!adminUrl) {
    const db = openSqliteDatabase(":memory:") as unknown as SqlDatabase;
    return { db, dispose: async () => { db.close(); } };
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
