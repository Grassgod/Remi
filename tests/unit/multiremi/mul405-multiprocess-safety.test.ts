/**
 * MUL-405 unit coverage for the three mechanisms that make multi-process
 * startup safe. The end-to-end two-process evidence lives in
 * `tests/manual/mul405-multiprocess-safety.ts` (it needs a PostgreSQL where the
 * role may CREATE DATABASE); these cases pin the pieces it depends on so a
 * regression fails here, fast and without a database.
 *
 * 1. `SqlDatabase.advisoryLock` is a real mutual exclusion on Postgres and a
 *    no-op on SQLite, so `runMigrations` needs exactly one call site.
 * 2. The `(workspace_id, issue_number)` index is defensive: it skips instead of
 *    failing when duplicates exist, because the 07:00 unattended release rolls
 *    back if the new container cannot migrate.
 * 3. `createIssue` takes the per-workspace number lock inside its transaction.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { advisoryLock, advisoryXactLock, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { numberAllocationLockKey } from "@multiremi/store/advisory-locks.js";
import { runMigrations } from "@multiremi/store/migrations.js";
import { MultiremiStore } from "@multiremi/store/store.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

let openDbs: Database[] = [];

afterEach(() => {
  for (const db of openDbs) db.close();
  openDbs = [];
  resetMultiremiTestEnv();
});

function freshDb(): Database {
  const db = new Database(":memory:");
  openDbs.push(db);
  return db;
}

/** Capture whatever the process writes to stdout for the duration of `fn`. */
function captureStdout<T>(fn: () => T): { value: T; lines: Array<Record<string, unknown>> } {
  const original = console.log;
  const captured: string[] = [];
  console.log = (...args: unknown[]) => {
    captured.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    const value = fn();
    return {
      value,
      lines: captured.flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      }),
    };
  } finally {
    console.log = original;
  }
}

describe("MUL-405 advisory locks", () => {
  it("is a no-op on SQLite and returns the callback's value", () => {
    const db = freshDb() as unknown as SqlDatabase;
    // `bun:sqlite`'s Database does not implement the optional methods, which is
    // what makes this the SQLite path.
    expect(db.advisoryLock).toBeUndefined();
    expect(advisoryLock(db, "any:key", () => 41 + 1)).toBe(42);
    expect(() => advisoryXactLock(db, "any:key")).not.toThrow();
  });

  it("runs the callback exactly once even when the body throws", () => {
    const db = freshDb() as unknown as SqlDatabase;
    let calls = 0;
    expect(() => advisoryLock(db, "key", () => {
      calls += 1;
      throw new Error("inner failure");
    })).toThrow("inner failure");
    expect(calls).toBe(1);
  });

  it("delegates to a database that implements the lock", () => {
    const db = freshDb() as unknown as SqlDatabase;
    const calls: string[] = [];
    (db as { advisoryLock?: unknown }).advisoryLock = <R>(key: string, fn: () => R): R => {
      calls.push(`lock:${key}`);
      try {
        return fn();
      } finally {
        calls.push(`unlock:${key}`);
      }
    };
    expect(advisoryLock(db, "k", () => "value")).toBe("value");
    expect(calls).toEqual(["lock:k", "unlock:k"]);
  });

  it("namespaces the migration and number locks so their hashes cannot collide by accident", () => {
    expect(numberAllocationLockKey("issue:local")).toBe("multiremi:number:issue:local");
    // The session and transaction forms of pg_advisory_lock share one lock
    // space; the prefixes are what keep unrelated subsystems from serializing
    // against each other.
    expect(numberAllocationLockKey("issue:local").startsWith("multiremi:migrations:")).toBe(false);
  });

  it("runs migrations on a handle that never went through openMultiremiDatabase", () => {
    // Tests and scripts pass their own `Database`; that path must not need a
    // manual attach just to be able to migrate.
    const db = freshDb();
    expect(() => runMigrations(db as unknown as SqlDatabase)).not.toThrow();
    expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'multiremi_issues'").get()).toBeTruthy();
  });
});

describe("MUL-405 issue number allocation lock", () => {
  it("takes the per-workspace number lock inside a transaction", () => {
    const db = freshDb();
    const database = db as unknown as SqlDatabase;
    const statements: string[] = [];
    const store = new MultiremiStore({
      query(sql: string) {
        statements.push(sql);
        return database.query(sql);
      },
      prepare: (sql) => database.prepare(sql),
      run: (sql, ...params) => database.run(sql, ...params),
      exec: (sql) => database.exec(sql),
      transaction: (fn) => database.transaction(fn),
      advisoryXactLock: (key) => {
        if (!database.inTransaction) {
          throw new Error(`advisoryXactLock without a transaction for ${key}`);
        }
        statements.push(`LOCK ${key}`);
      },
      close: () => database.close(),
    } as SqlDatabase);

    store.createIssue({ title: "Locked", workspaceId: "local" });

    // The lock is taken, and it happens before the read that produces the number.
    const lockIndex = statements.findIndex((sql) => sql.startsWith("LOCK "));
    const maxIndex = statements.findIndex((sql) => sql.includes("MAX(issue_number)"));
    expect(lockIndex).toBeGreaterThan(-1);
    expect(statements[lockIndex]).toBe("LOCK multiremi:number:issue:local");
    expect(maxIndex).toBeGreaterThan(lockIndex);
  });

  it("allocates one number per issue and keeps them increasing", () => {
    const store = createStore();
    const first = store.createIssue({ title: "One", workspaceId: "local" });
    const second = store.createIssue({ title: "Two", workspaceId: "local" });
    expect(second.number).toBe(first.number + 1);
    expect(second.key).not.toBe(first.key);
  });

  it("allocates per workspace, not globally", () => {
    const store = createStore();
    const workspace = store.createWorkspace({ name: "Other", slug: "other" });
    const local = store.createIssue({ title: "Local", workspaceId: "local" });
    const other = store.createIssue({ title: "Other", workspaceId: workspace.id });
    expect(local.workspaceId).toBe("local");
    expect(other.workspaceId).toBe(workspace.id);
    expect(other.number).toBe(1);
  });
});

describe("MUL-405 defensive unique index", () => {
  it("creates the unique index on a healthy database", () => {
    const db = freshDb();
    runMigrations(db as unknown as SqlDatabase);
    const indexes = db.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name)).toContain("idx_multiremi_issues_workspace_number");
    // It is enforced: a second issue with an explicit duplicate number is refused.
    const now = new Date().toISOString();
    const insert = (id: string, title: string) => db.run(
      `INSERT INTO multiremi_issues (id, issue_number, issue_key, title, workspace_id, created_at, updated_at)
       VALUES (?, 7, 'MUL-7', ?, 'local', ?, ?)`,
      [id, title, now, now],
    );
    insert("iss_first", "First");
    expect(() => insert("iss_second", "Second")).toThrow(/UNIQUE constraint failed/);
  });

  it("skips the index and warns instead of failing when duplicates already exist", () => {
    const db = freshDb();
    runMigrations(db as unknown as SqlDatabase);
    // Recreate the exact state a pre-MUL-405 duplicate race leaves behind: two
    // rows carrying the same allocated number and no index to stop them.
    db.exec("DROP INDEX idx_multiremi_issues_workspace_number");
    const now = new Date().toISOString();
    for (const id of ["iss_a", "iss_b"]) {
      db.run(
        `INSERT INTO multiremi_issues (id, issue_number, issue_key, title, workspace_id, created_at, updated_at)
         VALUES (?, 4, 'MUL-4', ?, 'local', ?, ?)`,
        [id, id, now, now],
      );
    }

    const { lines } = captureStdout(() => runMigrations(db as unknown as SqlDatabase));

    const indexes = db.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name)).not.toContain("idx_multiremi_issues_workspace_number");
    const warnings = lines.filter((line) => line.event === "api_startup_warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toBe("duplicate issue numbers found, unique index skipped");
    expect(warnings[0]!.workspace_id).toBe("local");
    expect(warnings[0]!.issue_number).toBe(4);
    // The migration as a whole still completed: the warning must not be a
    // substitute for a working schema.
    expect(db.query("SELECT COUNT(*) AS n FROM multiremi_tasks").get()).toEqual({ n: 0 });
  });

  it("does not enforce uniqueness over the unallocated placeholder", () => {
    const db = freshDb();
    runMigrations(db as unknown as SqlDatabase);
    const now = new Date().toISOString();
    // `issue_number = 0` means "no number allocated yet" and is the column
    // default, so an out-of-band writer leaves N rows there without touching the
    // allocator. Enforcing uniqueness over those rows would make the index
    // reject them, which is a behavior change no reader asked for; they get real
    // numbers from `backfillIssueKeys` on the next startup instead.
    const insertPlaceholder = (id: string) => db.run(
      `INSERT INTO multiremi_issues (id, issue_number, issue_key, title, workspace_id, created_at, updated_at)
       VALUES (?, 0, NULL, ?, 'local', ?, ?)`,
      [id, id, now, now],
    );
    insertPlaceholder("iss_x");
    insertPlaceholder("iss_y");
    const before = db.query("SELECT id FROM multiremi_issues ORDER BY id").all() as Array<{ id: string }>;
    expect(before.map((row) => row.id)).toEqual(["iss_x", "iss_y"]);

    runMigrations(db as unknown as SqlDatabase);

    const rows = db.query("SELECT id, issue_number FROM multiremi_issues ORDER BY id").all() as Array<{ id: string; issue_number: number }>;
    expect(rows.map((row) => row.issue_number)).toEqual([1, 2]);
  });

  it("retries on the next startup after skipping", () => {
    const db = freshDb();
    runMigrations(db as unknown as SqlDatabase);
    db.exec("DROP INDEX idx_multiremi_issues_workspace_number");
    const now = new Date().toISOString();
    for (const id of ["iss_a", "iss_b"]) {
      db.run(
        `INSERT INTO multiremi_issues (id, issue_number, issue_key, title, workspace_id, created_at, updated_at)
         VALUES (?, 4, 'MUL-4', ?, 'local', ?, ?)`,
        [id, id, now, now],
      );
    }
    captureStdout(() => runMigrations(db as unknown as SqlDatabase));
    // Once the data is healed, the same startup path creates it. That is why the
    // skip is not recorded in `multiremi_schema_migrations`.
    db.run("DELETE FROM multiremi_issues WHERE id = 'iss_b'");
    const { lines } = captureStdout(() => runMigrations(db as unknown as SqlDatabase));
    expect(lines.filter((line) => line.event === "api_startup_warning")).toHaveLength(0);
    const indexes = db.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name)).toContain("idx_multiremi_issues_workspace_number");
  });
});
