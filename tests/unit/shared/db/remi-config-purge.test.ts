import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb, setDbPath } from "@shared/db/index.js";

const roots: string[] = [];
const migrationId = "remi-config-purge-v2";
const backupSuffix = `.pre-${migrationId}.bak`;

function createConfigDb(path: string): void {
  const legacy = new Database(path);
  legacy.exec(`
    CREATE TABLE remi_config (
      section TEXT NOT NULL,
      key TEXT NOT NULL DEFAULT '',
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (section, key)
    );
    INSERT INTO remi_config (section, value) VALUES
      ('feishu', '{"appId":"legacy"}'),
      ('plugins', '{"enabled":[]}');
  `);
  legacy.close();
}

function makeDbPath(prefix: string): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return { root, path: join(root, "remi.db") };
}

afterEach(() => {
  closeDb();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("v2 does not back up a fresh database", () => {
  const { root, path } = makeDbPath("remi-config-v2-fresh-");

  setDbPath(path);
  getDb();

  expect(existsSync(`${path}${backupSuffix}`)).toBe(false);
  expect(readdirSync(root).filter((name) => name.includes(migrationId))).toEqual([]);
});

test("v2 backs up and removes an existing remi_config table", () => {
  const { path } = makeDbPath("remi-config-v2-legacy-");
  createConfigDb(path);

  setDbPath(path);
  const db = getDb();

  expect(db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'remi_config'").get()).toBeNull();
  expect(db.query("SELECT id FROM remi_migrations WHERE id = ?").get(migrationId)).toEqual({ id: migrationId });
  expect(existsSync(`${path}${backupSuffix}`)).toBe(true);
  const backup = new Database(`${path}${backupSuffix}`, { readonly: true });
  expect(backup.query("SELECT section, value FROM remi_config ORDER BY section").all()).toEqual([
    { section: "feishu", value: '{"appId":"legacy"}' },
    { section: "plugins", value: '{"enabled":[]}' },
  ]);
  backup.close();
});

test("v2 rolls the dropped table back when a real later SQL statement fails", () => {
  const { path } = makeDbPath("remi-config-v2-failure-");
  createConfigDb(path);
  const legacy = new Database(path);
  legacy.exec(`
    CREATE TABLE remi_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TRIGGER inject_remi_config_v2_failure
    BEFORE INSERT ON remi_migrations
    WHEN NEW.id = '${migrationId}'
    BEGIN
      SELECT RAISE(ABORT, 'injected v2 migration failure');
    END;
  `);
  legacy.close();

  setDbPath(path);
  expect(() => getDb()).toThrow(`${path}${backupSuffix}`);
  expect(existsSync(`${path}${backupSuffix}`)).toBe(true);

  const rolledBack = new Database(path, { readonly: true });
  expect(rolledBack.query("SELECT section, value FROM remi_config ORDER BY section").all()).toEqual([
    { section: "feishu", value: '{"appId":"legacy"}' },
    { section: "plugins", value: '{"enabled":[]}' },
  ]);
  expect(rolledBack.query("SELECT id FROM remi_migrations WHERE id = ?").get(migrationId)).toBeNull();
  rolledBack.close();
});

test("v2 is idempotent and does not create a second backup", () => {
  const { root, path } = makeDbPath("remi-config-v2-repeat-");
  createConfigDb(path);

  setDbPath(path);
  getDb();
  closeDb();
  setDbPath(path);
  getDb();

  expect(readdirSync(root).filter((name) => name.includes(migrationId))).toEqual([
    `remi.db${backupSuffix}`,
  ]);
});
