import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let sandbox = "";

afterEach(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  sandbox = "";
});

test("bot menu migration can read the W4 v2 backup after the live table is gone", () => {
  sandbox = mkdtempSync(join(tmpdir(), "remi-menu-backup-"));
  const livePath = join(sandbox, "remi.db");
  const backupPath = `${livePath}.pre-remi-config-purge-v2.bak`;
  const backup = new Database(backupPath);
  backup.exec("CREATE TABLE remi_config (section TEXT, key TEXT, value TEXT)");
  backup.run(
    "INSERT INTO remi_config (section, key, value) VALUES ('botMenu', '', ?)",
    [JSON.stringify({ default: [{ text: "Status" }], users: [] })],
  );
  backup.close();

  const result = Bun.spawnSync([
    process.execPath,
    "run",
    resolve(import.meta.dir, "../../../scripts/migrations/migrate-remi-bot-menu.ts"),
    "--backup",
  ], {
    cwd: resolve(import.meta.dir, "../../.."),
    env: { ...process.env, REMI_DB_PATH: livePath },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("Legacy bot menu: 1 default items, 0 personalized menus.");
  expect(result.stdout.toString()).toContain("Dry run only");
});
