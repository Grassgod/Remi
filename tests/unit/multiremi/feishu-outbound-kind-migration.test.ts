import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureFeishuOutboundKindsSchema, runMigrations } from "@multiremi/store/migrations.js";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";

const table = "multiremi_feishu_bot_outbound_deliveries";
function seed(db: SqlDatabase) {
  db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, task_id TEXT UNIQUE, kind TEXT,
    body TEXT, status TEXT, available_at TEXT, leased_until TEXT, created_at TEXT, extra TEXT);
    CREATE INDEX idx_c5_fixture_status ON ${table}(status);
    INSERT INTO ${table}(id, task_id, kind, body, extra) VALUES
      ('legacy', 'task', NULL, 'keep body', 'keep added column'),
      ('decision1', NULL, 'decision_card', 'card1', NULL),
      ('decision2', NULL, 'decision_card', 'card2', NULL);`);
}
function verify(db: SqlDatabase, dialect: "sqlite" | "postgres") {
  const before = db.query(`SELECT id, task_id, kind, body, extra FROM ${table} ORDER BY id`).all();
  ensureFeishuOutboundKindsSchema(db, dialect);
  ensureFeishuOutboundKindsSchema(db, dialect);
  expect(db.query(`SELECT id, task_id, kind, body, extra FROM ${table} ORDER BY id`).all()).toEqual(before);
  expect(() => db.run(`INSERT INTO ${table}(id, task_id) VALUES ('duplicate', 'task')`)).toThrow();
  expect(() => db.run(`INSERT INTO ${table}(id, task_id, kind) VALUES ('another_carrier', 'task', 'cot')`)).toThrow();
  db.run(`INSERT INTO ${table}(id, task_id, kind, unit_key) VALUES ('result', 'task', 'result_card', '')`);
  expect(() => db.run(`INSERT INTO ${table}(id, task_id, kind) VALUES ('duplicate_result', 'task', 'result_card')`)).toThrow();
  db.run(`INSERT INTO ${table}(id, task_id, kind, unit_key) VALUES ('receipt1', 'task', 'receipt', 'om1:completed')`);
  db.run(`INSERT INTO ${table}(id, task_id, kind, unit_key) VALUES ('receipt2', 'task', 'receipt', 'om2:completed')`);
  db.run(`INSERT INTO ${table}(id, task_id, kind) VALUES ('decision3', NULL, 'decision_card')`);
  ensureFeishuOutboundKindsSchema(db, dialect);
  expect(Number((db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number | string }).n)).toBe(7);
}

describe("C5 outbound schema on SQLite", () => {
  it("retains NULL lanes, E5 NULL task IDs, all columns and the original rows on repeated migration", () => {
    const db = new Database(":memory:");
    try {
      seed(db);
      verify(db, "sqlite");
      expect(db.query(`SELECT COUNT(*) AS n FROM ${table}_c5_backup`).get()).toEqual({ n: 3 });
      expect(db.query("SELECT tbl_name FROM sqlite_master WHERE name = 'idx_c5_fixture_status_c5'").get()).toEqual({ tbl_name: table });
    } finally { db.close(); }
  });

  it("runs the full startup migration twice without rebuilding or losing foreign keys", () => {
    const db = new Database(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON");
      runMigrations(db);
      runMigrations(db);
      expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.query(`SELECT COUNT(*) AS n FROM ${table}_c5_backup`).get()).toEqual({ n: 0 });
    } finally { db.close(); }
  });

  it("retains both backups and restores live unique indexes when a legacy table is recreated beside a C5 archive", () => {
    const db = new Database(":memory:");
    try {
      seed(db);
      verify(db, "sqlite");
      db.exec(`ALTER TABLE ${table} RENAME TO c5_archive;
        CREATE TABLE ${table} (id TEXT PRIMARY KEY, task_id TEXT UNIQUE, kind TEXT,
          status TEXT, available_at TEXT, leased_until TEXT, created_at TEXT);
        INSERT INTO ${table}(id, task_id) VALUES ('restored', 'restored_task');`);
      ensureFeishuOutboundKindsSchema(db, "sqlite");
      ensureFeishuOutboundKindsSchema(db, "sqlite");
      expect(db.query(`SELECT COUNT(*) AS n FROM ${table}_c5_backup`).get()).toEqual({ n: 3 });
      expect(db.query(`SELECT COUNT(*) AS n FROM ${table}_c5_backup_2`).get()).toEqual({ n: 1 });
      expect(db.query("SELECT COUNT(*) AS n FROM c5_archive").get()).toEqual({ n: 7 });
      expect(() => db.run(`INSERT INTO ${table}(id, task_id) VALUES ('duplicate_restored', 'restored_task')`)).toThrow();
      db.run(`INSERT INTO ${table}(id, task_id, kind) VALUES ('restored_result', 'restored_task', 'result_card')`);
      expect(() => db.run(`INSERT INTO ${table}(id, task_id, kind) VALUES ('duplicate_result', 'restored_task', 'result_card')`)).toThrow();
    } finally { db.close(); }
  });
});

const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
describe.skipIf(!adminUrl)("C5 outbound schema on real PostgreSQL", () => {
  const database = `c5_migration_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
  let db: PostgresSyncDatabase;
  beforeAll(async () => {
    const admin = new Bun.SQL(adminUrl!, { max: 1 });
    try { await admin.unsafe(`CREATE DATABASE ${database}`); } finally { await admin.end(); }
    const url = new URL(adminUrl!);
    url.pathname = `/${database}`;
    db = new PostgresSyncDatabase(url.toString());
  });
  afterAll(async () => {
    db?.close();
    const admin = new Bun.SQL(adminUrl!, { max: 1 });
    try { await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); } finally { await admin.end(); }
  });
  it("preserves existing data and enforces the same NULL and per-kind uniqueness as SQLite", () => {
    seed(db);
    verify(db, "postgres");
  });
});
