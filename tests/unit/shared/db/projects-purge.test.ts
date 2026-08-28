import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb, setDbPath } from "@shared/db/index.js";

let root: string | null = null;

afterEach(() => {
  closeDb();
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

describe("legacy local project schema purge", () => {
  it("drops the projects table while preserving persistent sessions", () => {
    root = mkdtempSync(join(tmpdir(), "remi-projects-purge-"));
    const path = join(root, "remi.db");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT);
      INSERT INTO projects (id, name, cwd) VALUES ('legacy', 'Legacy', '/tmp/legacy');
      CREATE TABLE sessions (
        session_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        display_name TEXT NOT NULL UNIQUE,
        cwd TEXT,
        provider TEXT,
        mode TEXT,
        created_at INTEGER NOT NULL,
        last_active INTEGER NOT NULL,
        status TEXT NOT NULL
      );
      INSERT INTO sessions VALUES ('chat', 'session', 'Remi-test', '/tmp/kept', NULL, NULL, 1, 1, 'active');
    `);
    legacy.close();

    setDbPath(path);
    const db = getDb();

    expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get()).toBeNull();
    expect(db.query("SELECT cwd FROM sessions WHERE session_key = 'chat'").get()).toEqual({ cwd: "/tmp/kept" });
  });
});
