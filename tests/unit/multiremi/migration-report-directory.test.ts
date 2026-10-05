import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, chownSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveMigrationReportDirectory } from "@multiremi/store/migration-report-directory.js";
import { UNIFIED_MODEL_MIGRATION } from "@multiremi/store/unified-model-schema.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("resolves the HOME data directory and keeps an explicit report override", () => {
  expect(resolveMigrationReportDirectory("")).toBe(join(homedir(), "reports", "migrations"));
  expect(resolveMigrationReportDirectory(" /writable/custom ")).toBe("/writable/custom");
});

// chmod alone does not produce EACCES as root. Exercise the same unprivileged
// startup as api-entrypoint, with a writable home mount and read-only /app.
test.skipIf(process.platform === "win32")("starts and restarts with default reports outside the read-only image directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "mul493-report-home-"));
  dirs.push(dir);
  chmodSync(dir, 0o755);
  const imageDir = join(dir, "app"), dataDir = join(dir, "api-home");
  mkdirSync(imageDir, { mode: 0o555 });
  mkdirSync(dataDir, { mode: 0o700 });
  const root = process.getuid?.() === 0;
  // A user namespace can map only UID 0, so switching to nobody is invalid.
  // Dropping DAC bypass capabilities enforces chmod for that root as well.
  const dropDac = root && process.platform === "linux";
  if (root && !dropDac) chownSync(dataDir, 65534, 65534);
  const repo = resolve(import.meta.dir, "../../..");
  const script = `
    import { writeFileSync } from 'node:fs';
    import { openSqliteDatabase } from ${JSON.stringify(join(repo, "packages/server/src/store/db/sqlite.ts"))};
    import { runMigrations } from ${JSON.stringify(join(repo, "packages/server/src/store/migrations.ts"))};
    try { writeFileSync('must-not-write', ''); throw new Error('fixture is writable'); }
    catch (error) { if (error.code !== 'EACCES') throw error; }
    const db = openSqliteDatabase(':memory:');
    runMigrations(db);
    runMigrations(db);
    db.close();
    const blocked = openSqliteDatabase(':memory:');
    process.env.MULTIREMI_MIGRATION_REPORT_DIR = process.cwd();
    try { runMigrations(blocked); throw new Error('expected report-directory refusal'); }
    catch (error) { if (!error.message.includes('Migration report directory is not writable')) throw error; }
    if (blocked.query("SELECT name FROM sqlite_master WHERE type='table'").all().length) throw new Error('schema mutated before report check');
    blocked.close();
    console.log('default first start + restart; invalid override refused before schema mutation');
  `;
  const command = dropDac ? "setpriv" : process.execPath;
  const args = dropDac ? ["--bounding-set=-dac_override,-dac_read_search", process.execPath, "-e", script] : ["-e", script];
  const child = spawnSync(command, args, {
    cwd: imageDir,
    env: { PATH: process.env.PATH, HOME: dataDir, NODE_ENV: "test", MULTIREMI_STATE_DIR: join(dataDir, "state"), REMI_HOME: join(dataDir, "remi") },
    ...(root && !dropDac ? { uid: 65534, gid: 65534 } : {}),
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout).toContain("default first start + restart");
  for (const phase of ["before", "after"]) {
    const report = JSON.parse(readFileSync(join(dataDir, "reports/migrations", `${UNIFIED_MODEL_MIGRATION}-${phase}.json`), "utf8"));
    expect(report.phase).toBe(phase);
    expect(report.mismatches).toEqual([]);
  }
});
