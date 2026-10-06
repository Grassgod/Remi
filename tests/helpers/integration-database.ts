import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { TwoProcessResources } from "./two-process.js";

export interface IntegrationDatabase {
  db: SqlDatabase;
  url?: string;
  close(): Promise<void>;
}

/** Each PG fixture owns a fresh database on the explicitly configured local test server. */
export async function openIntegrationDatabase(): Promise<IntegrationDatabase> {
  const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
  if (!adminUrl) {
    const db = openSqliteDatabase(":memory:") as unknown as SqlDatabase;
    return { db, async close() { db.close(); } };
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(adminUrl).hostname)) {
    throw new Error("Integration fixtures require a local dedicated PostgreSQL test server");
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
