/**
 * SQLite and Postgres stores for the MUL-432 trace backfill tests.
 *
 * Every case runs on both backends. Postgres cases are skipped (not failed)
 * when `MULTIREMI_TEST_POSTGRES_URL` is unreachable, matching the other
 * `*-postgres` suites. Each Postgres case gets its own database cloned from a
 * template migrated once per file, because the backfill scans the whole store
 * and cases must not see each other's subjects.
 */
import { Database } from "bun:sqlite";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";

export const PG_ADMIN_URL = process.env.MULTIREMI_TEST_POSTGRES_URL
  ?? "postgres://multimira:multimira@localhost:5432/postgres";

export async function probePostgres(): Promise<boolean> {
  try {
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin`SELECT 1`;
    await admin.end();
    return true;
  } catch {
    return false;
  }
}

function pgDatabaseUrl(database: string): string {
  const url = new URL(PG_ADMIN_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

async function adminExec(sql: string): Promise<void> {
  const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
  try {
    await admin.unsafe(sql);
  } finally {
    await admin.end();
  }
}

export interface OpenedStore {
  store: MultiremiStore;
  db: SqlDatabase;
  /** The Postgres URL of this case's database; `null` for the in-memory SQLite store. */
  url: string | null;
  close(): Promise<void>;
}

export interface StoreBackend {
  name: "sqlite" | "postgres";
  available: boolean;
  open(): Promise<OpenedStore>;
  /** Drop the per-file template, if one was created. */
  dispose(): Promise<void>;
}

function sqliteBackend(): StoreBackend {
  return {
    name: "sqlite",
    available: true,
    async open() {
      const raw = new Database(":memory:");
      const db = Object.assign(raw as unknown as SqlDatabase, { dialect: "sqlite" as const });
      const store = new MultiremiStore(db);
      store.ensureLocalWorkspace();
      return { store, db, url: null, close: async () => raw.close() };
    },
    async dispose() {},
  };
}

function postgresBackend(available: boolean, label: string): StoreBackend {
  const prefix = `m432_${label}_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
  const template = `${prefix}_tpl`;
  let templateReady: Promise<void> | null = null;
  let counter = 0;
  const ensureTemplate = () => templateReady ??= (async () => {
    await adminExec(`DROP DATABASE IF EXISTS ${template} WITH (FORCE)`);
    await adminExec(`CREATE DATABASE ${template}`);
    const db = new PostgresSyncDatabase(pgDatabaseUrl(template));
    try {
      new MultiremiStore(db).ensureLocalWorkspace();
    } finally {
      db.close();
    }
  })();
  return {
    name: "postgres",
    available,
    async open() {
      await ensureTemplate();
      const name = `${prefix}_${++counter}`;
      await adminExec(`CREATE DATABASE ${name} TEMPLATE ${template}`);
      const url = pgDatabaseUrl(name);
      const db = new PostgresSyncDatabase(url);
      const store = new MultiremiStore(db);
      return {
        store,
        db,
        url,
        close: async () => {
          db.close();
          await adminExec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        },
      };
    },
    async dispose() {
      if (!templateReady) return;
      await adminExec(`DROP DATABASE IF EXISTS ${template} WITH (FORCE)`);
    },
  };
}

/** Both backends; `label` keeps database names distinct per test file. */
export async function traceBackfillBackends(label: string): Promise<StoreBackend[]> {
  const pgAvailable = await probePostgres();
  if (!pgAvailable) {
    console.warn(`[${label}] Postgres not reachable at ${PG_ADMIN_URL} — skipping the Postgres cases.`);
  }
  return [sqliteBackend(), postgresBackend(pgAvailable, label)];
}
