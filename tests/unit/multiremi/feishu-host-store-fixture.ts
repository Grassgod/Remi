import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { createLocalStore as createSqliteStore, db as sqliteDb, resetMultiremiTestEnv as resetSqliteEnv } from "./helpers.js";
export { useUploadDir } from "./helpers.js";

// These host suites also run unchanged against a disposable real PostgreSQL database.
// Opt in explicitly; never probe a default port or fall back to SQLite on PG failure.
export let db: SqlDatabase | null = null;
let admin: PostgresSyncDatabase | null = null;
let databaseName: string | null = null;
let serial = 0;
export function createLocalStore(): MultiremiStore {
  if (process.env.MULTIREMI_TEST_FEISHU_BACKEND !== "postgres") {
    const store = createSqliteStore();
    db = sqliteDb;
    return store;
  }
  const raw = process.env.MULTIREMI_TEST_POSTGRES_URL;
  if (!raw) throw new Error("PostgreSQL host tests require MULTIREMI_TEST_POSTGRES_URL");
  const url = new URL(raw);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("Host test PostgreSQL must be local and disposable");
  admin = new PostgresSyncDatabase(raw);
  databaseName = `mul509_host_${process.pid}_${++serial}`;
  admin.exec(`CREATE DATABASE ${databaseName}`);
  url.pathname = `/${databaseName}`;
  db = new PostgresSyncDatabase(url.toString());
  const store = new MultiremiStore(db);
  store.ensureLocalWorkspace();
  return store;
}
export function resetMultiremiTestEnv(): void {
  if (admin && databaseName) {
    db?.close();
    admin.exec(`DROP DATABASE ${databaseName} WITH (FORCE)`);
    admin.close();
  }
  admin = null;
  databaseName = null;
  db = null;
  resetSqliteEnv();
}
