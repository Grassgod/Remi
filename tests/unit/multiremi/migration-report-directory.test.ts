import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { chmodSync, chownSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { resolveMigrationReportDirectory } from "@multiremi/store/migration-report-directory.js";
import { UNIFIED_MODEL_MIGRATION } from "@multiremi/store/unified-model-schema.js";
import { runMigrations } from "@multiremi/store/migrations.js";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { unifiedModelBackendTests } from "./unified-model-test-backends.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("resolves the HOME data directory and keeps an explicit report override", () => {
  expect(resolveMigrationReportDirectory("")).toBe(join(homedir(), "reports", "migrations"));
  expect(resolveMigrationReportDirectory(" /writable/custom ")).toBe("/writable/custom");
});

function databaseSnapshot(db: SqlDatabase) {
  const tables = db.query(db.dialect === "postgres"
    ? "SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename"
    : "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
  const schema = db.dialect === "postgres" ? {
    columns: db.query(`SELECT table_name,column_name,ordinal_position,udt_name,is_nullable,column_default,
      character_maximum_length,numeric_precision,numeric_scale FROM information_schema.columns
      WHERE table_schema=current_schema() ORDER BY table_name,ordinal_position`).all(),
    indexes: db.query("SELECT * FROM pg_indexes WHERE schemaname=current_schema() ORDER BY tablename,indexname").all(),
    constraints: db.query(`SELECT c.conname, t.relname, pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
      WHERE t.relnamespace=current_schema()::regnamespace ORDER BY t.relname,c.conname`).all(),
  } : db.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
  return { schema, data: tables.map(({ name }) => ({ name,
    rows: db.query(`SELECT * FROM "${name}"`).all().map(row => JSON.stringify(row)).sort(),
  })) };
}

unifiedModelBackendTests("MUL-493 nonempty report write preflight", fixture => {
  for (const state of ["empty", "historical"] as const) {
    for (const code of ["ENOSPC", "EFBIG"]) {
      test(`${code} on nonempty writes preserves ${state} schema and all data`, () => {
        const { db: historicalDb, store } = fixture();
        const db = state === "empty" && historicalDb.dialect === "sqlite"
          ? openSqliteDatabase(":memory:") as unknown as SqlDatabase : historicalDb;
        if (state === "empty" && db.dialect === "postgres") {
          db.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
        } else if (state === "historical") {
          const agent = store.createAgent({ name: "write failure history", provider: "codex" });
          const issue = store.createIssue({ title: "preserve report failure data" });
          const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "historical input" });
          db.run("UPDATE multiremi_tasks SET status='completed' WHERE id=?", [task.id]);
        }
        const dir = mkdtempSync(join(tmpdir(), "mul493-nonempty-write-"));
        dirs.push(dir);
        const before = databaseSnapshot(db);
        const originalWrite = fs.writeFileSync;
        const prior = process.env.MULTIREMI_MIGRATION_REPORT_DIR;
        let rejectedWrites = 0;
        const write = spyOn(fs, "writeFileSync").mockImplementation((...args: Parameters<typeof originalWrite>) => {
          const [path, data] = args;
          const length = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
          if (String(path).startsWith(`${dir}${sep}`) && length > 0) {
            rejectedWrites++;
            throw Object.assign(new Error(`injected nonempty write ${code}`), { code });
          }
          return originalWrite(...args);
        });
        try {
          process.env.MULTIREMI_MIGRATION_REPORT_DIR = dir;
          expect(() => runMigrations(db)).toThrow("Migration report directory is not writable");
          expect(rejectedWrites).toBe(1);
          expect(databaseSnapshot(db)).toEqual(before);
          expect(fs.readdirSync(dir)).toEqual([]);
        } finally {
          write.mockRestore();
          if (prior === undefined) delete process.env.MULTIREMI_MIGRATION_REPORT_DIR;
          else process.env.MULTIREMI_MIGRATION_REPORT_DIR = prior;
          if (db !== historicalDb) db.close();
        }
      });
    }
  }
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
