import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";

const worker = new URL("./fixtures/conversation-log-process.ts", import.meta.url).pathname;
const migrationId = "20260927_conversation_log";
const pgAdminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;

async function runFour(backend: "sqlite" | "pg", target: string, operation: "migrate" | "append"): Promise<void> {
  const children = Array.from({ length: 4 }, () => Bun.spawn({
    cmd: [process.execPath, worker, backend, target, operation, "ises_concurrent", "25"],
    env: { ...process.env, MULTIREMI_DATABASE_URL: backend === "pg" ? target : "" },
    stdout: "pipe", stderr: "pipe",
  }));
  const results = await Promise.all(children.map(async (child) => ({
    code: await child.exited,
    stderr: await new Response(child.stderr).text(),
  })));
  for (const result of results) expect(result.code, result.stderr).toBe(0);
}

function resetMigration(db: SqlDatabase): void {
  db.exec("DROP TABLE multiremi_conversation_log; DROP TABLE multiremi_conversation_heads;");
  db.run("DELETE FROM multiremi_schema_migrations WHERE id = ?", [migrationId]);
}

function assertContiguous(db: SqlDatabase): void {
  const rows = db.query("SELECT seq FROM multiremi_conversation_log WHERE session_id = ? ORDER BY seq ASC")
    .all("ises_concurrent") as Array<{ seq: number }>;
  expect(rows.map((row) => Number(row.seq))).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
  const head = db.query("SELECT head_seq FROM multiremi_conversation_heads WHERE session_id = ?")
    .get("ises_concurrent") as { head_seq: number };
  expect(Number(head.head_seq)).toBe(100);
}

async function withSqlite(run: (db: Database, path: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "mul426-sqlite-"));
  const path = join(dir, "test.sqlite");
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 30000");
  new MultiremiStore(db);
  try { await run(db, path); } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}

async function withPostgres(run: (db: PostgresSyncDatabase, url: string) => Promise<void>): Promise<void> {
  const name = `mul426_${process.pid}_${Math.floor(Math.random() * 1e8)}`;
  const admin = new Bun.SQL(pgAdminUrl!, { max: 1 });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(pgAdminUrl!);
  url.pathname = `/${name}`;
  const db = new PostgresSyncDatabase(url.toString());
  try {
    new MultiremiStore(db);
    await run(db, url.toString());
  } finally {
    db.close();
    await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
}

describe("conversation log multi-process allocation (MUL-405)", () => {
  it("SQLite: four processes cold-start the migration", async () => {
    await withSqlite(async (db, path) => {
      resetMigration(db);
      await runFour("sqlite", path, "migrate");
      const row = db.query("SELECT COUNT(*) AS count FROM multiremi_schema_migrations WHERE id = ?")
        .get(migrationId) as { count: number | string };
      expect(Number(row.count)).toBe(1);
    });
  });
  it("SQLite: four processes append without duplicate or missing seq", async () => {
    await withSqlite(async (db, path) => {
      await runFour("sqlite", path, "append");
      assertContiguous(db);
    });
  });
  it.skipIf(!pgAdminUrl)("Postgres: four processes cold-start the migration", async () => {
    await withPostgres(async (db, url) => {
      resetMigration(db);
      await runFour("pg", url, "migrate");
      const row = db.query("SELECT COUNT(*) AS count FROM multiremi_schema_migrations WHERE id = ?")
        .get(migrationId) as { count: number | string };
      expect(Number(row.count)).toBe(1);
    });
  });
  it.skipIf(!pgAdminUrl)("Postgres: four processes append without duplicate or missing seq", async () => {
    await withPostgres(async (db, url) => {
      await runFour("pg", url, "append");
      assertContiguous(db);
    });
  });
  it.skipIf(!pgAdminUrl)("Postgres: rolls back a comment and its mirrored log row together", async () => {
    await withPostgres(async (db) => {
      const store = new MultiremiStore(db);
      const issue = store.createIssue({ title: "PG comment rollback", workspaceId: "local" });
      const session = store.getOrCreateDefaultIssueSession(issue.id);
      let commentId = "";
      expect(() => db.transaction(() => {
        commentId = store.createIssueComment(issue.id, { issueSessionId: session.id, body: "discard" }).id;
        throw new Error("rollback");
      })()).toThrow("rollback");
      expect(store.getIssueComment(commentId)).toBeNull();
      expect(store.getConversationLogEntryById(commentId)).toBeNull();
    });
  });
});
