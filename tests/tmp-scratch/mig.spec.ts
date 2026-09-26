import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "@multiremi/store/migrations.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";

function migrate(d: Database) { runMigrations(d as unknown as SqlDatabase); }

test("session archive subject migration is idempotent and preserves rows", () => {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE multiremi_session_archives (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      issue_id TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      daemon_id TEXT NOT NULL,
      source_revision TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      size_bytes BIGINT NOT NULL,
      uploaded_size_bytes BIGINT NOT NULL DEFAULT 0,
      file_count INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      relative_path TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE(issue_id, source_revision, sha256)
    );
    INSERT INTO multiremi_session_archives (
      id, issue_id, runtime_id, daemon_id, source_revision, sha256, size_bytes,
      status, relative_path, attempt_count, created_at, updated_at
    ) VALUES
      ('sar_a', 'iss_a', 'rt_1', 'dmn_1', 'rev-a', '${"a".repeat(64)}', 5, 'ready', 'a/sessions.tar.gz', 1, 'x', 'x'),
      ('sar_b', 'iss_b', 'rt_1', 'dmn_1', 'rev-b', '${"b".repeat(64)}', 5, 'failed', 'b/sessions.tar.gz', 2, 'x', 'x');
  `);
  migrate(d);
  const cols = (d.query("PRAGMA table_info(multiremi_session_archives)").all() as Array<{name:string; notnull:number}>);
  const issueId = cols.find((c) => c.name === "issue_id")!;
  expect(Number(issueId.notnull)).toBe(0);
  expect(cols.map((c) => c.name)).toEqual(expect.arrayContaining(["subject_kind", "subject_id", "format"]));
  const rows = d.query("SELECT id, issue_id, subject_kind, subject_id, format, status FROM multiremi_session_archives ORDER BY id").all() as any[];
  expect(rows).toEqual([
    { id: "sar_a", issue_id: "iss_a", subject_kind: "issue", subject_id: "iss_a", format: "multiremi.issue-sessions.v1", status: "ready" },
    { id: "sar_b", issue_id: "iss_b", subject_kind: "issue", subject_id: "iss_b", format: "multiremi.issue-sessions.v1", status: "failed" },
  ]);
  // idempotent: run twice more
  migrate(d);
  migrate(d);
  expect((d.query("SELECT COUNT(*) AS c FROM multiremi_session_archives").get() as any).c).toBe(2);
  expect((d.query("SELECT COUNT(*) AS c FROM multiremi_task_traces").get() as any).c).toBe(0);
  const traceCols = (d.query("PRAGMA table_info(multiremi_task_traces)").all() as Array<{name:string}>).map((c) => c.name);
  expect(traceCols).toEqual([
    "task_id","location","runtime_id","archive_id","member_path","data_offset",
    "compressed_size","uncompressed_size","sha256","event_count","updated_at",
  ]);
  d.close();
});

test("a fresh database accepts chat and task subjects with NULL issue_id", () => {
  const d = new Database(":memory:");
  migrate(d);
  d.exec(`
    INSERT INTO multiremi_session_archives (
      id, workspace_id, issue_id, subject_kind, subject_id, format,
      runtime_id, daemon_id, source_revision, sha256, size_bytes,
      status, relative_path, created_at, updated_at
    ) VALUES
      ('sar_c', 'local', NULL, 'chat', 'chat_1', 'multiremi.session-archive.v2',
       'rt_1', 'dmn_1', 'rev-c', '${"c".repeat(64)}', 5, 'pending', 'c.x', 'x', 'x'),
      ('sar_t', 'local', NULL, 'task', 'tsk_1', 'multiremi.session-archive.v2',
       'rt_1', 'dmn_1', 'rev-t', '${"d".repeat(64)}', 5, 'pending', 't.x', 'x', 'x');
  `);
  expect((d.query("SELECT COUNT(*) AS c FROM multiremi_session_archives").get() as any).c).toBe(2);
  // The subject uniqueness key replaces UNIQUE(issue_id, ...), so two chat rows
  // with the same revision collide while distinct subjects coexist.
  expect(() => d.exec(`
    INSERT INTO multiremi_session_archives (
      id, workspace_id, issue_id, subject_kind, subject_id, format,
      runtime_id, daemon_id, source_revision, sha256, size_bytes,
      status, relative_path, created_at, updated_at
    ) VALUES ('sar_c2', 'local', NULL, 'chat', 'chat_1', 'multiremi.session-archive.v2',
       'rt_1', 'dmn_1', 'rev-c', '${"c".repeat(64)}', 5, 'pending', 'c2.x', 'x', 'x');
  `)).toThrow();
  d.close();
});
