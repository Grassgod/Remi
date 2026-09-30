import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "@multiremi/store/migrations.js";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";

const table = "multiremi_feishu_bot_outbound_deliveries";
const stamp = "20260930010101";
const archive = `fbo_c5_archive_${stamp}`;
const sqlFiles = {
  sqlite: new URL("../../../docs/feishu-outbound-restore-sqlite.sql", import.meta.url),
  postgres: new URL("../../../docs/feishu-outbound-restore-postgres.sql", import.meta.url),
};

async function renderedSql(dialect: "sqlite" | "postgres"): Promise<string> {
  return (await Bun.file(sqlFiles[dialect]).text()).replaceAll("__C5_STAMP__", stamp);
}

function seed(db: SqlDatabase): void {
  runMigrations(db, { dialect: db.dialect });
  // This branch predates main's decision columns; the release schema includes them.
  db.exec(`ALTER TABLE ${table} ADD COLUMN decision_id TEXT;
    ALTER TABLE ${table} ADD COLUMN decision_issue_id TEXT;`);
  db.run(`INSERT INTO multiremi_agents (id, name, provider, created_at, updated_at)
    VALUES ('agent', 'Restore drill', 'codex', '2026-09-30', '2026-09-30')`);
  db.run(`INSERT INTO multiremi_chat_sessions (id, agent_id, title, created_at, updated_at)
    VALUES ('chat-session', 'agent', 'Restore drill', '2026-09-30', '2026-09-30')`);
  db.run(`INSERT INTO multiremi_feishu_bot_chat_bindings
    (id, workspace_id, app_id, agent_id, external_session_key, chat_session_id, created_at, updated_at)
    VALUES ('binding', 'local', 'app', 'agent', 'thread', 'chat-session', '2026-09-30', '2026-09-30')`);
  for (const taskId of ["legacy-task", "sent-task", "failed-task"]) {
    db.run(`INSERT INTO multiremi_tasks (id, agent_id, prompt, created_at, updated_at)
      VALUES (?, 'agent', 'Restore drill', '2026-09-30', '2026-09-30')`, taskId);
  }
  const values = [
    ["legacy", "legacy-task", null, "", "legacy", "sent", "om_legacy", null],
    ["sent-cot", "sent-task", "cot", "", "split", "sent", "om_cot", null],
    ["sent-interaction", "sent-task", "interaction_card", "", "split", "sent", "om_interaction", null],
    ["sent-result", "sent-task", "result_card", "", "split", "sent", "om_final", null],
    ["sent-receipt", "sent-task", "receipt", "om_final:completed", "split", "sent", "om_receipt", null],
    ["failed-cot", "failed-task", "cot", "", "split", "sent", "om_cot_failed", null],
    ["failed-interaction", "failed-task", "interaction_card", "", "split", "failed", null, null],
    ["failed-result", "failed-task", "result_card", "", "split", "failed", null, null],
    ["failed-receipt", "failed-task", "receipt", "failed:completed", "split", "failed", null, null],
    ["decision", null, "decision_card", "", null, "sent", "om_decision", "decision-1"],
    ["decision-patch", null, "decision_card_patch", "", null, "sent", null, "decision-1"],
  ] as const;
  for (const [id, taskId, kind, unitKey, mode, status, messageId, decisionId] of values) {
    db.run(`INSERT INTO ${table} (id, workspace_id, binding_id, task_id, chat_id, body,
      status, available_at, created_at, updated_at, kind, unit_key, delivery_mode,
      external_message_id, decision_id, decision_issue_id)
      VALUES (?, 'local', 'binding', ?, 'chat', ?, ?, '2026-09-30', '2026-09-30',
        '2026-09-30', ?, ?, ?, ?, ?, ?)`, id, taskId, `body-${id}`, status, kind,
      unitKey, mode, messageId, decisionId, decisionId ? "issue-1" : null);
  }
  db.run(`INSERT INTO multiremi_feishu_bot_outbound_operations
    (id, workspace_id, kind, unit_key, operation, status, available_at, created_at, updated_at)
    VALUES ('done-op', 'local', 'attachments', 'done', '{}', 'done', '2026-09-30',
      '2026-09-30', '2026-09-30')`);
}

function rows(db: SqlDatabase, name = table): unknown[] {
  return db.query(`SELECT * FROM ${name} ORDER BY id`).all();
}

function verifyRestored(db: SqlDatabase, before: unknown[]): void {
  expect(rows(db, archive)).toEqual(before);
  expect(rows(db)).toHaveLength(5);
  const sourceById = new Map((before as Array<Record<string, unknown>>).map(row => [row.id, row]));
  for (const live of rows(db) as Array<Record<string, unknown>>) {
    const source = sourceById.get(live.id);
    expect(source).toBeDefined();
    const expected = Object.fromEntries(Object.keys(live).map(key => [key, source?.[key]]));
    if (source?.delivery_mode === "split") {
      const result = (before as Array<Record<string, unknown>>).find(row =>
        row.task_id === source.task_id && row.kind === "result_card");
      expected.status = result?.status;
      expected.external_message_id = result?.external_message_id;
      expected.kind = null;
    }
    expect(live).toEqual(expected);
  }
  expect(db.query(`SELECT id, status, external_message_id, kind FROM ${table}
    WHERE task_id IS NOT NULL ORDER BY id`).all()).toEqual([
    { id: "failed-cot", status: "failed", external_message_id: null, kind: null },
    { id: "legacy", status: "sent", external_message_id: "om_legacy", kind: null },
    { id: "sent-cot", status: "sent", external_message_id: "om_final", kind: null },
  ]);
  expect(db.query(`SELECT id, decision_id FROM ${table} WHERE task_id IS NULL ORDER BY id`).all())
    .toEqual([{ id: "decision", decision_id: "decision-1" },
      { id: "decision-patch", decision_id: "decision-1" }]);
  expect(() => db.run(`INSERT INTO ${table} (id, workspace_id, binding_id, task_id, chat_id,
    body, available_at, created_at, updated_at) VALUES
    ('duplicate', 'local', 'binding', 'sent-task', 'chat', 'x', 'now', 'now', 'now')`)).toThrow();
  db.run(`INSERT INTO multiremi_tasks (id, agent_id, prompt, created_at, updated_at)
    VALUES ('new-task', 'agent', 'Restore drill', '2026-09-30', '2026-09-30')`);
  for (const taskId of ["new-task", "sent-task"]) {
    db.run(`INSERT INTO ${table} (id, workspace_id, binding_id, task_id, chat_id,
      body, available_at, created_at, updated_at) VALUES
      (?, 'local', 'binding', ?, 'chat', 'updated', 'now', 'now', 'now')
      ON CONFLICT(task_id) DO UPDATE SET body = excluded.body`, `write-${taskId}`, taskId);
    expect(db.query(`SELECT body FROM ${table} WHERE task_id = ?`).get(taskId)).toEqual({ body: "updated" });
  }
  expect(Number((db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE task_id = 'sent-task'`).get() as { n: number | string }).n)).toBe(1);
}

function sqlitePrechecks(sql: string, db: Database): unknown[][] {
  const precheck = sql.slice(0, sql.indexOf("-- TRANSACTION"));
  return precheck.split(";").filter(part => part.includes("SELECT "))
    .map(statement => db.query(statement).all());
}

function runSqlite(sql: string, db: Database): void {
  try {
    for (const statement of sql.slice(sql.indexOf("-- TRANSACTION")).split(";")) {
      if (statement.trim()) db.exec(`${statement};`);
    }
  }
  catch (error) { if (db.inTransaction) db.exec("ROLLBACK"); throw error; }
}

describe("C5 physical restore on SQLite", () => {
  let sql: string;
  beforeAll(async () => { sql = await renderedSql("sqlite"); });

  it("restores the old live key, projects split carriers, and retains the full archive", () => {
    const db = new Database(":memory:");
    try {
      seed(db);
      const before = rows(db);
      expect(sqlitePrechecks(sql, db)).toEqual([[], [], []]);
      runSqlite(sql, db);
      verifyRestored(db, before);
      expect(rows(db, `${table}_c5_backup`)).toEqual([]);
      const indexes = db.query(`SELECT name FROM sqlite_master WHERE type = 'index'
        AND tbl_name = ? ORDER BY name`).all(table) as Array<{ name: string }>;
      for (const name of ["idx_multiremi_feishu_bot_outbound_pending",
        "idx_multiremi_feishu_bot_outbound_previous", "idx_multiremi_feishu_bot_outbound_kind",
        "idx_multiremi_feishu_bot_outbound_decision"]) {
        expect(indexes.map(index => index.name)).toContain(name);
      }
    } finally { db.close(); }
  });

  it("reports each undrained condition without changing the live table", () => {
    for (const violation of ["missing-result", "nonterminal", "deferred"] as const) {
      const db = new Database(":memory:");
      try {
        seed(db);
        if (violation === "missing-result") db.run(`DELETE FROM ${table} WHERE id = 'sent-result'`);
        if (violation === "nonterminal") db.run(`UPDATE ${table} SET status = 'pending' WHERE id = 'sent-receipt'`);
        if (violation === "deferred") db.run(`UPDATE multiremi_feishu_bot_outbound_operations
          SET status = 'pending' WHERE id = 'done-op'`);
        const before = rows(db);
        const indexes = db.query("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' ORDER BY name").all();
        expect(sqlitePrechecks(sql, db).some(result => result.length > 0)).toBe(true);
        expect(() => runSqlite(sql, db)).toThrow();
        expect(rows(db)).toEqual(before);
        expect(db.query("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' ORDER BY name").all()).toEqual(indexes);
        expect(db.query(`SELECT name FROM sqlite_master WHERE name = ?`).get(archive)).toBeNull();
      } finally { db.close(); }
    }
  });

  it("rejects an occupied archive and a second restore without changing existing tables", () => {
    const db = new Database(":memory:");
    try {
      seed(db);
      db.exec(`CREATE TABLE ${archive} (id TEXT)`);
      const before = rows(db);
      const beforeIndexes = db.query("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' ORDER BY name").all();
      expect(() => runSqlite(sql, db)).toThrow();
      expect(rows(db)).toEqual(before);
      expect(rows(db, archive)).toEqual([]);
      expect(db.query("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' ORDER BY name").all()).toEqual(beforeIndexes);
      db.exec(`DROP TABLE ${archive}`);
      runSqlite(sql, db);
      const restored = rows(db), archived = rows(db, archive);
      const indexes = db.query("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' ORDER BY name").all();
      expect(() => runSqlite(sql, db)).toThrow();
      expect(rows(db)).toEqual(restored);
      expect(rows(db, archive)).toEqual(archived);
      expect(db.query("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' ORDER BY name").all()).toEqual(indexes);
    } finally { db.close(); }
  });
});

const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
describe.skipIf(!adminUrl)("C5 physical restore on real PostgreSQL", () => {
  const database = `c5_restore_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
  let db: PostgresSyncDatabase, url: string, sql: string;
  beforeAll(async () => {
    sql = await renderedSql("postgres");
    const admin = new Bun.SQL(adminUrl!, { max: 1 });
    try { await admin.unsafe(`CREATE DATABASE ${database}`); } finally { await admin.end(); }
    const parsed = new URL(adminUrl!); parsed.pathname = `/${database}`; url = parsed.toString();
    db = new PostgresSyncDatabase(url);
    seed(db);
  });
  afterAll(async () => {
    db?.close();
    const admin = new Bun.SQL(adminUrl!, { max: 1 });
    try { await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); }
    finally { await admin.end(); }
  });
  async function execute(): Promise<void> {
    const client = new Bun.SQL(url, { max: 1 });
    try { await client.unsafe(sql).simple(); } finally { await client.end(); }
  }
  it("blocks an undrained split Task and rolls back", async () => {
    for (const violation of ["missing-result", "nonterminal", "deferred"] as const) {
      if (violation === "missing-result") db.run(`DELETE FROM ${table} WHERE id = 'sent-result'`);
      if (violation === "nonterminal") db.run(`UPDATE ${table} SET status = 'pending' WHERE id = 'sent-receipt'`);
      if (violation === "deferred") db.run(`UPDATE multiremi_feishu_bot_outbound_operations
        SET status = 'pending' WHERE id = 'done-op'`);
      const before = rows(db);
      const indexes = db.query("SELECT indexname, tablename FROM pg_indexes WHERE schemaname = current_schema() ORDER BY indexname").all();
      await expect(execute()).rejects.toThrow();
      expect(rows(db)).toEqual(before);
      expect(db.query("SELECT indexname, tablename FROM pg_indexes WHERE schemaname = current_schema() ORDER BY indexname").all()).toEqual(indexes);
      expect(db.query("SELECT to_regclass(?) AS archive").get(archive)).toEqual({ archive: null });
      if (violation === "missing-result") db.run(`INSERT INTO ${table} (id, workspace_id, binding_id,
        task_id, chat_id, body, status, available_at, created_at, updated_at, kind,
        unit_key, delivery_mode, external_message_id) VALUES
        ('sent-result', 'local', 'binding', 'sent-task', 'chat', 'body-sent-result', 'sent',
          '2026-09-30', '2026-09-30', '2026-09-30', 'result_card', '', 'split', 'om_final')`);
      if (violation === "nonterminal") db.run(`UPDATE ${table} SET status = 'sent' WHERE id = 'sent-receipt'`);
      if (violation === "deferred") db.run(`UPDATE multiremi_feishu_bot_outbound_operations
        SET status = 'done' WHERE id = 'done-op'`);
    }
  });
  it("rejects an occupied archive name and leaves the live table and indexes unchanged", async () => {
    db.exec(`CREATE TABLE ${archive} (id TEXT)`);
    const before = rows(db);
    const indexes = db.query("SELECT indexname, tablename FROM pg_indexes WHERE schemaname = current_schema() ORDER BY indexname").all();
    await expect(execute()).rejects.toThrow();
    expect(rows(db)).toEqual(before);
    expect(db.query("SELECT indexname, tablename FROM pg_indexes WHERE schemaname = current_schema() ORDER BY indexname").all()).toEqual(indexes);
    db.exec(`DROP TABLE ${archive}`);
  });
  it("restores the old live key and rejects a repeated run without changing either table", async () => {
    const before = rows(db);
    await execute();
    verifyRestored(db, before);
    const live = rows(db), saved = rows(db, archive);
    const indexes = db.query("SELECT indexname, tablename FROM pg_indexes WHERE schemaname = current_schema() ORDER BY indexname").all();
    await expect(execute()).rejects.toThrow();
    expect(rows(db)).toEqual(live);
    expect(rows(db, archive)).toEqual(saved);
    expect(db.query("SELECT indexname, tablename FROM pg_indexes WHERE schemaname = current_schema() ORDER BY indexname").all()).toEqual(indexes);
  });
});
