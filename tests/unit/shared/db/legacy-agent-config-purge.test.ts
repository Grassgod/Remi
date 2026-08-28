import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb, setDbPath } from "@shared/db/index.js";

const roots: string[] = [];
const backupSuffix = ".pre-legacy-agent-config-purge-v1.bak";
const configBackupSuffix = ".pre-remi-config-purge-v2.bak";

function createLegacyDb(path: string): void {
  const legacy = new Database(path);
  legacy.exec(`
    CREATE TABLE group_configs (chat_id TEXT PRIMARY KEY, project_id TEXT);
    INSERT INTO group_configs VALUES ('chat-1', 'project-1');
    CREATE TABLE embeddings (id TEXT PRIMARY KEY, content_hash TEXT);
    INSERT INTO embeddings VALUES ('embedding-1', 'hash-1');
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT);
    INSERT INTO projects VALUES ('project-1', 'Legacy project');
    CREATE TABLE vec_items (embedding BLOB);
    INSERT INTO vec_items VALUES (X'01');
    CREATE TABLE remi_config (
      section TEXT NOT NULL,
      key TEXT NOT NULL DEFAULT '',
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (section, key)
    );
    INSERT INTO remi_config (section, value) VALUES
      ('provider', '{}'),
      ('mcp', '[]'),
      ('feishu', '{}');
  `);
  legacy.close();
}

afterEach(() => {
  closeDb();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("opening a fresh Remi DB does not create a migration backup", () => {
  const root = mkdtempSync(join(tmpdir(), "remi-fresh-schema-"));
  roots.push(root);
  const path = join(root, "remi.db");

  setDbPath(path);
  getDb();

  expect(existsSync(`${path}${backupSuffix}`)).toBe(false);
  expect(readdirSync(root).filter((name) => name.includes(".pre-"))).toEqual([]);
});

test("opening an existing Remi DB backs it up and removes all legacy state", () => {
  const root = mkdtempSync(join(tmpdir(), "remi-legacy-schema-"));
  roots.push(root);
  const path = join(root, "remi.db");
  createLegacyDb(path);

  setDbPath(path);
  const tables = getDb().query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('group_configs', 'embeddings', 'projects', 'vec_items', 'remi_config')",
  ).all();

  expect(tables).toEqual([]);

  const backupPath = `${path}${backupSuffix}`;
  expect(existsSync(backupPath)).toBe(true);
  const backup = new Database(backupPath, { readonly: true });
  expect(backup.query("SELECT chat_id FROM group_configs").get()).toEqual({ chat_id: "chat-1" });
  expect(backup.query("SELECT id FROM embeddings").get()).toEqual({ id: "embedding-1" });
  expect(backup.query("SELECT id, name FROM projects").get()).toEqual({
    id: "project-1",
    name: "Legacy project",
  });
  expect(backup.query("SELECT section FROM remi_config ORDER BY section").all()).toEqual([
    { section: "feishu" },
    { section: "mcp" },
    { section: "provider" },
  ]);
  backup.close();

  const configBackup = new Database(`${path}${configBackupSuffix}`, { readonly: true });
  expect(configBackup.query("SELECT section FROM remi_config ORDER BY section").all()).toEqual([
    { section: "feishu" },
  ]);
  configBackup.close();
});

test("a real mid-migration SQL failure rolls back every destructive change", () => {
  const root = mkdtempSync(join(tmpdir(), "remi-failed-schema-"));
  roots.push(root);
  const path = join(root, "remi.db");
  createLegacyDb(path);
  const legacy = new Database(path);
  legacy.exec(`
    CREATE TRIGGER inject_legacy_purge_failure
    BEFORE DELETE ON remi_config
    WHEN OLD.section = 'provider'
    BEGIN
      SELECT RAISE(ABORT, 'injected migration failure');
    END;
  `);
  legacy.close();

  setDbPath(path);
  expect(() => getDb()).toThrow(`${path}${backupSuffix}`);
  expect(existsSync(`${path}${backupSuffix}`)).toBe(true);

  const rolledBack = new Database(path, { readonly: true });
  expect(rolledBack.query("SELECT chat_id, project_id FROM group_configs").all()).toEqual([
    { chat_id: "chat-1", project_id: "project-1" },
  ]);
  expect(rolledBack.query("SELECT id, content_hash FROM embeddings").all()).toEqual([
    { id: "embedding-1", content_hash: "hash-1" },
  ]);
  expect(rolledBack.query("SELECT id, name FROM projects").all()).toEqual([
    { id: "project-1", name: "Legacy project" },
  ]);
  expect(rolledBack.query("SELECT embedding FROM vec_items").all()).toHaveLength(1);
  expect(rolledBack.query("SELECT section FROM remi_config ORDER BY section").all()).toEqual([
    { section: "feishu" },
    { section: "mcp" },
    { section: "provider" },
  ]);
  rolledBack.close();
});

test("reopening a migrated DB does not create or attempt a second backup", () => {
  const root = mkdtempSync(join(tmpdir(), "remi-idempotent-schema-"));
  roots.push(root);
  const path = join(root, "remi.db");
  createLegacyDb(path);

  setDbPath(path);
  getDb();
  closeDb();
  setDbPath(path);
  getDb();

  expect(readdirSync(root).filter((name) => name.includes(".pre-")).sort()).toEqual([
    `remi.db${backupSuffix}`,
    `remi.db${configBackupSuffix}`,
  ].sort());
});
