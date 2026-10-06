import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  db.run(`INSERT INTO multiremi_agents (id, name, provider, created_at, updated_at)
    VALUES ('agent', 'Restore drill', 'codex', '2026-09-30', '2026-09-30')`);
  db.run(`INSERT INTO multiremi_chat_sessions (id, agent_id, title, created_at, updated_at)
    VALUES ('chat-session', 'agent', 'Restore drill', '2026-09-30', '2026-09-30')`);
  db.run(`INSERT INTO multiremi_feishu_bot_chat_bindings
    (id, workspace_id, app_id, agent_id, external_session_key, chat_session_id, created_at, updated_at)
    VALUES ('binding', 'local', 'app', 'agent', 'thread', 'chat-session', '2026-09-30', '2026-09-30')`);
  for (const taskId of ["legacy-task", "sent-task", "failed-task"]) {
    db.run(`INSERT INTO multiremi_turns (id, session_id, seq, agent_id, status, workspace_id, created_at)
      VALUES (?, 'chat-session', ?, 'agent', 'completed', 'local', '2026-09-30')`, `turn-${taskId}`, ["legacy-task", "sent-task", "failed-task"].indexOf(taskId)+1);
    db.run(`INSERT INTO multiremi_turn_attempts (id, turn_id, attempt_no, provider, status, created_at, updated_at) VALUES (?, ?, 1, 'codex', 'completed', '2026-09-30', '2026-09-30')`, taskId, `turn-${taskId}`);
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
  db.run(`INSERT INTO multiremi_turns (id, session_id, seq, agent_id, status, workspace_id, created_at) VALUES ('new-turn', 'chat-session', 4, 'agent', 'completed', 'local', '2026-09-30')`);
  db.run(`INSERT INTO multiremi_turn_attempts (id, turn_id, attempt_no, provider, status, created_at, updated_at) VALUES ('new-task', 'new-turn', 1, 'codex', 'completed', '2026-09-30', '2026-09-30')`);
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
    const transaction = sql.slice(sql.indexOf("-- TRANSACTION")).replace(/^\.[^\n]*$/gm, "");
    for (const statement of transaction.split(";")) {
      if (statement.trim()) db.exec(`${statement};`);
    }
  }
  catch (error) { if (db.inTransaction) db.exec("ROLLBACK"); throw error; }
}

describe("C5 physical restore on SQLite", () => {
  let sql: string;
  beforeAll(async () => { sql = await renderedSql("sqlite"); });

  it("restores the old live key, projects split carriers, and retains the full archive", () => {
    const db = openSqliteDatabase(":memory:");
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
      const db = openSqliteDatabase(":memory:");
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

  it.skipIf(!Bun.which("sqlite3"))("stops the default sqlite3 CLI on a failed guard", () => {
    const directory = mkdtempSync(join(tmpdir(), "m447-c5-sqlite-"));
    const path = join(directory, "restore.sqlite");
    try {
      // Bootstrap in memory, then give the real CLI the exact serialized DB.
      // Hundreds of migration fsyncs are unrelated to the restore guard.
      const db = openSqliteDatabase(":memory:");
      seed(db);
      db.run(`UPDATE ${table} SET status = 'pending' WHERE id = 'sent-receipt'`);
      const before = rows(db);
      const indexes = db.query("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' ORDER BY name").all();
      writeFileSync(path, db.serialize());
      db.close();

      const result = spawnSync("sqlite3", [path], { input: sql, encoding: "utf8" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("c5_restore_requires_drained_rows");

      const after = openSqliteDatabase(path);
      try {
        expect(rows(after)).toEqual(before);
        expect(after.query("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' ORDER BY name").all())
          .toEqual(indexes);
        expect(after.query("SELECT name FROM sqlite_master WHERE name = ?").get(archive)).toBeNull();
      } finally { after.close(); }

      const drained = openSqliteDatabase(path);
      drained.run(`UPDATE ${table} SET status = 'sent' WHERE id = 'sent-receipt'`);
      drained.close();
      const success = spawnSync("sqlite3", [path], { input: sql, encoding: "utf8" });
      expect(success.status).toBe(0);
      const restored = openSqliteDatabase(path);
      try {
        expect(rows(restored)).toHaveLength(5);
        expect(rows(restored, archive)).toHaveLength(11);
      } finally { restored.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("rejects an occupied archive and a second restore without changing existing tables", () => {
    const db = openSqliteDatabase(":memory:");
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
// Catalog captured from fresh origin/main a2ef6f6e7 PostgreSQL migrations.
const mainPgColumns = [
  "id", "workspace_id", "binding_id", "task_id", "chat_id", "thread_id",
  "reply_to_message_id", "body", "status", "claim_token", "leased_until",
  "available_at", "attempt_count", "external_message_id", "last_error",
  "sent_at", "created_at", "updated_at", "mention_snapshot",
  "presentation_checkpoint", "interaction_open_id", "attachments",
  "previous_delivery_id", "kind", "human_request_id", "human_request_task_id",
  "expires_at", "target_message_id", "degraded", "decision_id", "decision_issue_id",
];
const mainPgRequiredColumns = new Set([
  "id", "workspace_id", "binding_id", "chat_id", "body", "status",
  "available_at", "attempt_count", "created_at", "updated_at",
]);
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

  it("matches the columns, constraints, and indexes from fresh main migrations", () => {
    const columns = db.query(`SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns WHERE table_schema = current_schema()
        AND table_name = ? ORDER BY ordinal_position`).all(table);
    expect(columns).toEqual(mainPgColumns.map(column_name => ({
      column_name,
      data_type: column_name === "attempt_count" ? "integer" : "text",
      is_nullable: mainPgRequiredColumns.has(column_name) ? "NO" : "YES",
      column_default: column_name === "status" ? "'pending'::text"
        : column_name === "attempt_count" ? "0" : null,
    })));
    expect(db.query(`SELECT c.conname, c.contype, pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = ? ORDER BY c.conname`).all(table)).toEqual([
      { conname: `${table}_pkey`, contype: "p", definition: "PRIMARY KEY (id)" },
      { conname: `${table}_task_id_key`, contype: "u", definition: "UNIQUE (task_id)" },
    ]);
    const expectedIndexes = [
      ["idx_multiremi_feishu_bot_outbound_decision", "decision_id, status, available_at", false],
      ["idx_multiremi_feishu_bot_outbound_kind", "kind, status, available_at", false],
      ["idx_multiremi_feishu_bot_outbound_pending", "status, available_at, leased_until, created_at", false],
      ["idx_multiremi_feishu_bot_outbound_previous", "previous_delivery_id", false],
      [`${table}_pkey`, "id", true],
      [`${table}_task_id_key`, "task_id", true],
    ] as const;
    expect(db.query(`SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = ? ORDER BY indexname`).all(table))
      .toEqual(expectedIndexes.map(([indexname, keys, unique]) => ({
        indexname,
        indexdef: `CREATE ${unique ? "UNIQUE " : ""}INDEX ${indexname} ON public.${table} USING btree (${keys})`,
      })));
  });
});
