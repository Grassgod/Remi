// Sibling test for packages/server/src/store/migrations.ts — the extracted schema
// module that SPLIT-PLAN §1.2 calls for (`MultiremiStore.migrate()` is a one-line
// call into it). Covers a fresh database, idempotency across restarts, and the
// three legacy migrations that MUST run on every startup (8f20d1c8: losing them
// breaks old-database upgrades).
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "@multiremi/store/migrations.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";

let db: Database | null = null;

function freshDb(): Database {
  db = new Database(":memory:");
  return db;
}

function migrate(database: Database): void {
  runMigrations(database as unknown as SqlDatabase);
}

function tableNames(database: Database): string[] {
  return (database.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
    .map((row) => row.name);
}

function columnNames(database: Database, table: string): string[] {
  return (database.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

afterEach(() => {
  db?.close();
  db = null;
});

describe("store migrations", () => {
  it("creates the schema on a fresh database", () => {
    const database = freshDb();
    migrate(database);

    const tables = tableNames(database);
    for (const table of [
      "multiremi_agents",
      "multiremi_issues",
      "multiremi_issue_activity",
      "multiremi_issue_subscribers",
      "multiremi_inbox_items",
      "multiremi_tasks",
      "multiremi_task_messages",
      "multiremi_workspaces",
      "multiremi_workspace_members",
      "multiremi_runtimes",
      "multiremi_autopilots",
      "multiremi_projects",
      "multiremi_chat_sessions",
      "multiremi_feedback",
    ]) {
      expect(tables).toContain(table);
    }
    expect(tables.some((name) => name.startsWith("multica_"))).toBe(false);
  });

  it("is idempotent across restarts and preserves rows", () => {
    const database = freshDb();
    migrate(database);
    const first = tableNames(database);
    database.run(
      "INSERT INTO multiremi_agents (id, name, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ["agt_keep", "Keep me", "claude", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
    );

    migrate(database);
    migrate(database);

    expect(tableNames(database)).toEqual(first);
    const row = database.query("SELECT name FROM multiremi_agents WHERE id = ?").get("agt_keep") as { name?: string } | null;
    expect(row?.name).toBe("Keep me");
  });

  it("renames legacy multica_* objects on every startup", () => {
    const database = freshDb();
    database.exec("CREATE TABLE multica_legacy_notes (id TEXT PRIMARY KEY, body TEXT)");
    database.exec("CREATE INDEX idx_multica_legacy_notes_body ON multica_legacy_notes(body)");
    database.run("INSERT INTO multica_legacy_notes (id, body) VALUES (?, ?)", ["n1", "carried over"]);

    migrate(database);

    const tables = tableNames(database);
    expect(tables).toContain("multiremi_legacy_notes");
    expect(tables).not.toContain("multica_legacy_notes");
    const row = database.query("SELECT body FROM multiremi_legacy_notes WHERE id = ?").get("n1") as { body?: string } | null;
    expect(row?.body).toBe("carried over");
    const indexes = (database.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>)
      .map((r) => r.name);
    expect(indexes).not.toContain("idx_multica_legacy_notes_body");
  });

  it("upgrades a pre-typed issue subscribers table", () => {
    const database = freshDb();
    database.exec(`
      CREATE TABLE multiremi_issue_subscribers (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL,
        UNIQUE(issue_id, member_id)
      )
    `);
    database.run(
      "INSERT INTO multiremi_issue_subscribers (id, issue_id, member_id, reason, created_at) VALUES (?, ?, ?, ?, ?)",
      ["sub_1", "iss_1", "mem_1", "assigned", "2026-01-01T00:00:00.000Z"],
    );

    migrate(database);

    const columns = columnNames(database, "multiremi_issue_subscribers");
    expect(columns).toContain("user_type");
    expect(columns).toContain("user_id");
    const row = database.query("SELECT user_type, user_id FROM multiremi_issue_subscribers WHERE id = ?").get("sub_1") as
      { user_type?: string; user_id?: string } | null;
    expect(row?.user_type).toBe("member");
    expect(row?.user_id).toBe("mem_1");
  });

  it("relaxes a legacy issue-bound inbox table", () => {
    const database = freshDb();
    database.exec(`
      CREATE TABLE multiremi_inbox_items (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'local',
        issue_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        actor_type TEXT NOT NULL DEFAULT 'system',
        actor_id TEXT,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT,
        read INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `);
    database.run(
      `INSERT INTO multiremi_inbox_items (id, workspace_id, issue_id, member_id, type, title, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["inb_1", "local", "iss_1", "mem_1", "issue_assigned", "Old item", "2026-01-01T00:00:00.000Z"],
    );

    migrate(database);

    const issueColumn = (database.query("PRAGMA table_info(multiremi_inbox_items)").all() as Array<{ name: string; notnull: number }>)
      .find((column) => column.name === "issue_id");
    expect(Number(issueColumn?.notnull ?? 1)).toBe(0);
    const row = database.query("SELECT recipient_type, recipient_id, severity FROM multiremi_inbox_items WHERE id = ?").get("inb_1") as
      { recipient_type?: string; recipient_id?: string; severity?: string } | null;
    expect(row?.recipient_type).toBe("member");
    expect(row?.recipient_id).toBe("mem_1");
    expect(row?.severity).toBe("info");
    expect(tableNames(database)).not.toContain("multiremi_inbox_items_legacy");
  });
});
