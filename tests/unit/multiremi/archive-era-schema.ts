/**
 * The server schema as the Session Archive era left it, for the ADR 0018
 * migration tests. `bootstrapPreUnifiedSchema` no longer creates the archive
 * tables, so this fixture adds them (and the archive columns) on top of it, the
 * same way on SQLite and Postgres, and `expectArchiveEraMigrated` checks what
 * `runMigrations` must have made of them.
 */
import { expect } from "bun:test";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";

const AT = "2026-10-01T00:00:00.000Z";

export function installArchiveEraSchema(db: SqlDatabase): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_multiremi_task_traces_location;
    DROP TABLE multiremi_task_traces;
    CREATE TABLE multiremi_task_traces (
      task_id TEXT PRIMARY KEY,
      location TEXT NOT NULL,
      runtime_id TEXT,
      archive_id TEXT,
      member_path TEXT,
      data_offset INTEGER,
      compressed_size INTEGER,
      uncompressed_size INTEGER,
      sha256 TEXT,
      event_count INTEGER,
      head_seq INTEGER,
      closed INTEGER,
      updated_at TEXT NOT NULL,
      source TEXT
    );
    CREATE INDEX idx_multiremi_task_traces_location ON multiremi_task_traces(location, updated_at);
    CREATE INDEX idx_multiremi_task_traces_archive ON multiremi_task_traces(archive_id);

    ALTER TABLE multiremi_issue_workspaces ADD COLUMN cleaned_archive_id TEXT;
    ALTER TABLE multiremi_issue_workspaces ADD COLUMN cleaned_archive_source_revision TEXT;
    ALTER TABLE multiremi_issue_workspaces ADD COLUMN cleaned_archive_sha256 TEXT;

    CREATE TABLE multiremi_session_archives (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      issue_id TEXT,
      runtime_id TEXT NOT NULL,
      daemon_id TEXT NOT NULL,
      source_revision TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      size_bytes BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      relative_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_multiremi_session_archives_issue ON multiremi_session_archives(issue_id, created_at);
    CREATE TABLE multiremi_session_archive_requests (
      id TEXT PRIMARY KEY,
      runtime_id TEXT NOT NULL,
      subject_kind TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE multiremi_trace_backfill_progress (
      subject_kind TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      status TEXT NOT NULL,
      task_count INTEGER NOT NULL DEFAULT 0,
      row_count BIGINT NOT NULL DEFAULT 0,
      digest TEXT,
      archive_id TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(subject_kind, subject_id)
    );
  `);
  db.run("DELETE FROM multiremi_workspaces WHERE id = 'local'");
  db.run(
    "INSERT INTO multiremi_workspaces (id, name, slug, settings, created_at, updated_at) VALUES ('local', 'Local', 'local', ?, ?, ?)",
    [JSON.stringify({ session_archive: { workspace_ttl_ms: 3_600_000, gc_interval_ms: 60_000 }, issue_archive: { ttl_ms: 7_200_000 } }), AT, AT],
  );
  db.run("INSERT INTO multiremi_runtimes (id, name, provider, created_at, updated_at) VALUES ('rt_1', 'Runtime', 'claude', ?, ?)", [AT, AT]);
  for (const issueId of ["iss_1", "iss_2"]) {
    db.run(
      "INSERT INTO multiremi_issues (id, title, issue_number, issue_key, created_at, updated_at) VALUES (?, 'Issue', ?, ?, ?, ?)",
      [issueId, Number(issueId.slice(-1)), `MUL-${issueId.slice(-1)}`, AT, AT],
    );
  }
  db.run(
    `INSERT INTO multiremi_session_archives (id, issue_id, runtime_id, daemon_id, source_revision, sha256, size_bytes, status, relative_path, created_at, updated_at)
     VALUES ('sar_1', 'iss_1', 'rt_1', 'dmn_1', 'rev-1', ?, 10, 'ready', 'a/sessions.zip', ?, ?)`,
    ["1".repeat(64), AT, AT],
  );
  db.run("INSERT INTO multiremi_session_archive_requests (id, runtime_id, subject_kind, subject_id, status, created_by, created_at, updated_at) VALUES ('sarq_1', 'rt_1', 'issue', 'iss_1', 'sent', 'local', ?, ?)", [AT, AT]);
  db.run("INSERT INTO multiremi_trace_backfill_progress (subject_kind, subject_id, status, updated_at) VALUES ('issue', 'iss_1', 'done', ?)", [AT]);
  for (const [taskId, location, runtimeId, archiveId] of [
    ["tsk_daemon", "daemon", "rt_1", null],
    ["tsk_archive", "archive", "rt_1", "sar_1"],
    ["tsk_none", "none", null, null],
    ["tsk_lost", "lost", null, null],
    ["tsk_backfilling", "backfilling", null, null],
  ] as const) {
    db.run(
      `INSERT INTO multiremi_task_traces (task_id, location, runtime_id, archive_id, member_path, data_offset, compressed_size, uncompressed_size, sha256, event_count, head_seq, closed, updated_at, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 3, 3, 1, ?, ?)`,
      [taskId, location, runtimeId, archiveId, archiveId ? `traces/${taskId}.jsonl` : null, archiveId ? 64 : null,
        archiveId ? 30 : null, archiveId ? 90 : null, archiveId ? "2".repeat(64) : null, AT, archiveId ? "daemon" : null],
    );
  }
  for (const [issueId, status, archiveId] of [["iss_1", "ready", null], ["iss_2", "cleaned", "sar_1"]] as const) {
    db.run(
      `INSERT INTO multiremi_issue_workspaces (issue_id, workspace_id, issue_key, runtime_id, root_path, branch_name, status, repos, cleaned_at,
         cleaned_archive_id, cleaned_archive_source_revision, cleaned_archive_sha256, created_at, updated_at)
       VALUES (?, 'local', ?, 'rt_1', '/work/x', 'agent/x', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [issueId, `MUL-${issueId.slice(-1)}`, status, archiveId ? "[]" : '[{"repoUrl":"u"}]', archiveId ? AT : null, archiveId, archiveId ? "rev-1" : null, archiveId ? "1".repeat(64) : null, AT, AT],
    );
  }
}

type Row = Record<string, unknown>;

function columns(db: SqlDatabase, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as Row[]).map((row) => String(row.name));
}

/** What `runMigrations` must have made of the data `installArchiveEraSchema` wrote. */
export function expectArchiveEraMigrated(db: SqlDatabase): void {
  const tables = (db.query("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'index')").all() as Row[])
    .filter((row) => row.type === "table").map((row) => String(row.name));
  expect(tables).toContain("multiremi_legacy_session_archives");
  expect(tables).toContain("multiremi_legacy_trace_pointers");
  for (const gone of ["multiremi_session_archives", "multiremi_session_archive_requests", "multiremi_trace_backfill_progress"]) {
    expect(tables).not.toContain(gone);
  }
  expect(db.query("SELECT id, status FROM multiremi_legacy_session_archives").all()).toEqual([{ id: "sar_1", status: "ready" }]);
  expect(db.query(
    "SELECT task_id, archive_id, member_path, data_offset, compressed_size, uncompressed_size, sha256, head_seq, event_count FROM multiremi_legacy_trace_pointers",
  ).all()).toEqual([{
    task_id: "tsk_archive", archive_id: "sar_1", member_path: "traces/tsk_archive.jsonl", data_offset: 64,
    compressed_size: 30, uncompressed_size: 90, sha256: "2".repeat(64), head_seq: 3, event_count: 3,
  }]);

  expect(columns(db, "multiremi_task_traces").sort()).toEqual(
    ["task_id", "location", "runtime_id", "event_count", "head_seq", "closed", "updated_at"].sort());
  expect(db.query("SELECT task_id, location, runtime_id FROM multiremi_task_traces ORDER BY task_id").all()).toEqual([
    { task_id: "tsk_archive", location: "lost", runtime_id: "rt_1" },
    { task_id: "tsk_backfilling", location: "lost", runtime_id: null },
    { task_id: "tsk_daemon", location: "lost", runtime_id: "rt_1" },
    { task_id: "tsk_lost", location: "lost", runtime_id: null },
    { task_id: "tsk_none", location: "none", runtime_id: null },
  ]);

  const workspaceColumns = columns(db, "multiremi_issue_workspaces");
  for (const column of ["snapshot_json", "snapshot_at", "unsaved_work"]) expect(workspaceColumns).toContain(column);
  for (const column of ["cleaned_archive_id", "cleaned_archive_source_revision", "cleaned_archive_sha256"]) {
    expect(workspaceColumns).not.toContain(column);
  }
  expect(db.query("SELECT issue_id, status, repos, unsaved_work, snapshot_json FROM multiremi_issue_workspaces ORDER BY issue_id").all())
    .toEqual([
      { issue_id: "iss_1", status: "cleaned", repos: "[]", unsaved_work: 0, snapshot_json: null },
      { issue_id: "iss_2", status: "cleaned", repos: "[]", unsaved_work: 0, snapshot_json: null },
    ]);

  for (const table of ["multiremi_daemon_storage_reports", "multiremi_runtime_gc_run_requests"]) expect(tables).toContain(table);
  expect(columns(db, "multiremi_chat_sessions")).toEqual(expect.arrayContaining(["origin_autopilot_id", "origin_run_id"]));
  expect(columns(db, "multiremi_autopilot_runs")).toEqual(expect.arrayContaining(["chat_session_id", "quiet"]));
  expect(columns(db, "multiremi_autopilot_run_records")).toEqual(expect.arrayContaining(["chat_session_id", "quiet", "task_id", "status"]));

  const workspace = db.query("SELECT settings FROM multiremi_workspaces WHERE id = 'local'").get() as Row;
  expect(JSON.parse(String(workspace.settings))).toEqual({ issue_archive: { ttl_ms: 7_200_000 } });
}
