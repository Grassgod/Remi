import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb, setDbPath } from "@shared/db/index.js";

const roots: string[] = [];

afterEach(() => {
  closeDb();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("opening an existing Remi DB removes legacy agent config and memory schema", () => {
  const root = mkdtempSync(join(tmpdir(), "remi-legacy-schema-"));
  roots.push(root);
  const path = join(root, "remi.db");
  const legacy = new Database(path);
  legacy.exec(`
    CREATE TABLE group_configs (chat_id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE embeddings (id TEXT PRIMARY KEY, content_hash TEXT);
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

  setDbPath(path);
  const tables = getDb().query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('group_configs', 'embeddings')",
  ).all();

  expect(tables).toEqual([]);
  const sections = getDb()
    .query("SELECT section FROM remi_config ORDER BY section")
    .all() as Array<{ section: string }>;
  expect(sections).toEqual([{ section: "feishu" }]);
});
