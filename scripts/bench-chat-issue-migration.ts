#!/usr/bin/env bun
/** MUL-304: disposable, local-only cold-start migration benchmark. */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, cpus, totalmem } from "node:os";
import { join } from "node:path";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { runMigrations } from "@multiremi/store/migrations.js";
import { CHAT_ISSUE_DECOUPLED_FINGERPRINT } from "@multiremi/store/helpers.js";

const migration = "20260916_chat_issue_decoupling";
class BenchmarkError extends Error {}
const statuses = ["queued", "dispatched", "running", "awaiting_human", "waiting_local_directory"];
const round = (ms: number) => Math.round(ms * 100) / 100;
const count = (db: SqlDatabase, sql: string, ...params: unknown[]) => Number(db.query(sql).get(...params).count);
function requireCount(actual: number, expected: number, label: string) {
  if (actual !== expected) throw new BenchmarkError(`${label}: expected ${expected}, got ${actual}`);
}

function seed(db: SqlDatabase, size: number, backend: string) {
  runMigrations(db);
  // Recreate the shipped SQLite table-level FK, which requires an atomic
  // table rebuild. PG exercises its native DROP COLUMN path.
  if (backend === "sqlite") {
    const schema = String(db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'multiremi_chat_sessions'").get().sql);
    const indexes = db.query("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'multiremi_chat_sessions' AND sql IS NOT NULL").all();
    db.exec("DROP TABLE multiremi_chat_sessions");
    db.exec(schema.replace("agent_id TEXT NOT NULL,", "agent_id TEXT NOT NULL, issue_id TEXT,")
      .replace(/\)\s*$/, ", FOREIGN KEY(issue_id) REFERENCES multiremi_issues(id) ON DELETE SET NULL)"));
    for (const index of indexes) db.exec(index.sql);
  } else {
    db.exec("ALTER TABLE multiremi_chat_sessions ADD COLUMN issue_id TEXT REFERENCES multiremi_issues(id)");
  }
  const at = "2026-09-01T00:00:00.000Z";
  db.transaction(() => {
    db.run(`INSERT INTO multiremi_agents (id, name, provider, created_at, updated_at)
      VALUES ('bench_agent', 'Synthetic benchmark', 'codex', ?, ?)`, [at, at]);
    db.run(`INSERT INTO multiremi_issues (id, title, status, created_at, updated_at)
      VALUES ('bench_issue', 'Synthetic benchmark', 'todo', ?, ?)`, [at, at]);
    const chats = db.prepare(`INSERT INTO multiremi_chat_sessions
      (id, agent_id, issue_id, title, session_id, session_provider, session_execution_fingerprint,
       work_dir, session_runtime_id, created_at, updated_at)
      VALUES (?, 'bench_agent', 'bench_issue', 'Synthetic Chat', 'old-provider', 'codex', 'old-fingerprint', ?, 'bench_runtime', ?, ?)`);
    const tasks = db.prepare(`INSERT INTO multiremi_tasks
      (id, workspace_id, agent_id, chat_session_id, issue_id, prompt, status, session_id, created_at, updated_at)
      VALUES (?, 'local', 'bench_agent', ?, 'bench_issue', 'Synthetic input', ?, 'old-provider', ?, ?)`);
    const messages = db.prepare(`INSERT INTO multiremi_chat_messages
      (id, chat_session_id, role, body, created_at)
      VALUES (?, ?, ?, 'Synthetic retained history', ?)`);
    for (let i = 0; i < size; i++) {
      const chat = `bench_chat_${i}`;
      chats.run(chat, i % 2 === 0 ? `/synthetic/${chat}` : null, at, at);
      tasks.run(`bench_task_${i}`, chat, statuses[i % statuses.length], at, at);
      messages.run(`${chat}_user`, chat, "user", at);
      messages.run(`${chat}_assistant`, chat, "assistant", at);
    }
    db.run("DELETE FROM multiremi_schema_migrations WHERE id = ?", [migration]);
  })();
  // Model an upgrade from the unindexed schema. Include index construction in
  // migrationMs, not setupMs (the initial runMigrations creates today's schema).
  db.exec("DROP INDEX IF EXISTS idx_multiremi_tasks_chat_session");
  if (backend === "sqlite") db.exec("PRAGMA foreign_keys = ON");
}

function measure(db: SqlDatabase, size: number, backend: string) {
  let start = performance.now();
  seed(db, size, backend);
  const setupMs = round(performance.now() - start);
  start = performance.now();
  runMigrations(db);
  const migrationMs = round(performance.now() - start);
  requireCount(count(db, "SELECT COUNT(*) AS count FROM multiremi_chat_sessions WHERE session_id IS NULL AND session_provider IS NULL AND session_execution_fingerprint IS NULL"), size, "cold-start Chats");
  requireCount(count(db, "SELECT COUNT(*) AS count FROM multiremi_tasks WHERE session_id IS NULL"), size, "cold-start tasks");
  requireCount(count(db, "SELECT COUNT(*) AS count FROM multiremi_chat_messages"), 2 * size, "retained messages");
  requireCount(count(db, "SELECT COUNT(*) AS count FROM multiremi_chat_sessions WHERE work_dir IS NOT NULL AND session_runtime_id = 'bench_runtime'"), Math.ceil(size / 2), "retained machine affinity");
  requireCount(count(db, "SELECT COUNT(*) AS count FROM multiremi_chat_sessions WHERE work_dir IS NULL AND session_runtime_id IS NULL"), Math.floor(size / 2), "cleared machine affinity");
  for (const [index, status] of statuses.entries()) {
    const expected = Math.floor(size / 5) + (index < size % 5 ? 1 : 0);
    requireCount(count(db, "SELECT COUNT(*) AS count FROM multiremi_tasks WHERE status = ?", status), expected, `retained ${status} tasks`);
    if (index < 2) requireCount(count(db, "SELECT COUNT(*) AS count FROM multiremi_tasks WHERE status = ? AND issue_id IS NULL", status), expected, "cleared task ownership");
    else requireCount(count(db, "SELECT COUNT(*) AS count FROM multiremi_tasks WHERE status = ? AND execution_fingerprint = ?", status, CHAT_ISSUE_DECOUPLED_FINGERPRINT), expected, "fenced provider lineage");
  }
  requireCount(count(db, "SELECT COUNT(*) AS count FROM multiremi_schema_migrations WHERE id = ?", migration), 1, "migration ledger");
  if (db.query("PRAGMA table_info(multiremi_chat_sessions)").all().some((c) => c.name === "issue_id")) throw new BenchmarkError("Legacy Chat Issue column remains");
  if (backend === "sqlite" && db.query("PRAGMA foreign_key_check").all().length) throw new BenchmarkError("SQLite foreign key check failed");
  db.run("UPDATE multiremi_chat_sessions SET session_id = 'fresh-after-migration' WHERE id = 'bench_chat_0'");
  start = performance.now();
  runMigrations(db);
  const restartMs = round(performance.now() - start);
  requireCount(count(db, "SELECT COUNT(*) AS count FROM multiremi_chat_sessions WHERE session_id = 'fresh-after-migration'"), 1, "one-time cold-start");
  return { setupMs, migrationMs, restartMs, verified: true };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("bun scripts/bench-chat-issue-migration.ts [--backend all|sqlite|postgres] [--sizes 5000,20000,50000] [--repeats 1]\nPostgres: MUL304_BENCH_POSTGRES_URL must target localhost/127.0.0.1/[::1]. Only new disposable databases are migrated. Emits NDJSON; exit 2 means a backend is unavailable.");
    return;
  }
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!["--backend", "--sizes", "--repeats"].includes(args[i]!) || !args[i + 1]) throw new BenchmarkError("Invalid benchmark arguments; use --help");
    options[args[i]!] = args[i + 1]!;
  }
  const backend = options["--backend"] ?? "all";
  const sizes = (options["--sizes"] ?? "5000,20000,50000").split(",").map(Number);
  const repeats = Number(options["--repeats"] ?? 1);
  if (!["all", "sqlite", "postgres"].includes(backend) || !sizes.length
    || sizes.some((n) => !Number.isSafeInteger(n) || n <= 0) || !Number.isSafeInteger(repeats) || repeats <= 0) throw new BenchmarkError("Invalid benchmark arguments; use --help");
  // Never read the platform's MULTIREMI_DATABASE_URL or accept a SQLite path.
  const pgUrl = new URL(process.env.MUL304_BENCH_POSTGRES_URL ?? "postgres://multimira:multimira@127.0.0.1:5432/postgres");
  if (backend !== "sqlite" && (!["postgres:", "postgresql:"].includes(pgUrl.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(pgUrl.hostname) || pgUrl.search || pgUrl.hash)) {
    throw new BenchmarkError("Postgres benchmark accepts only a local URL without query parameters");
  }
  console.log(JSON.stringify({ kind: "environment", at: new Date().toISOString(), bun: Bun.version,
    platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, cpuCount: cpus().length,
    memoryGiB: round(totalmem() / 2 ** 30), sizes, repeats,
    fixture: "ordinary Chats; one active task and two messages each; equal task status mix; half retain work_dir; no bindings or outbound queues",
    timing: "full runMigrations call including commit; setup and validation excluded; SQLite WAL/FULL with legacy table-level FK; PG synchronous adapter" }));
  for (const target of backend === "all" ? ["sqlite", "postgres"] : [backend]) {
    let admin: InstanceType<typeof Bun.SQL> | undefined;
    if (target === "postgres") {
      admin = new Bun.SQL(pgUrl.toString(), { max: 1, connectionTimeout: 5 });
      try { await admin`SELECT 1`; }
      catch {
        for (const size of sizes) console.log(JSON.stringify({ backend: target, chats: size, status: "unavailable", reason: "local PostgreSQL connection failed" }));
        await admin.end();
        process.exitCode = 2;
        continue;
      }
    }
    try {
      for (const size of sizes) for (let sample = 1; sample <= repeats; sample++) {
        const directory = target === "sqlite" ? mkdtempSync(join(tmpdir(), "mul304-bench-")) : null;
        const database = `mul304_bench_${process.pid}_${crypto.randomUUID().replaceAll("-", "")}`;
        let db: SqlDatabase | undefined;
        let created = false;
        try {
          console.error(`benchmark ${target}: ${size} Chats, sample ${sample}/${repeats}`);
          if (directory) {
            db = new Database(join(directory, "synthetic.sqlite"));
            db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
          } else {
            await admin!.unsafe(`CREATE DATABASE ${database}`);
            created = true;
            const url = new URL(pgUrl);
            url.pathname = `/${database}`;
            db = new PostgresSyncDatabase(url.toString());
          }
          const result = measure(db, size, target);
          console.log(JSON.stringify({ backend: target, chats: size, activeTasks: size, messages: size * 2, sample, status: "ok", ...result }));
        } finally {
          db?.close();
          if (directory) rmSync(directory, { recursive: true, force: true });
          if (created) await admin!.unsafe(`DROP DATABASE ${database} WITH (FORCE)`);
        }
      }
    } finally { await admin?.end(); }
  }
}

if (import.meta.main) main().catch((error) => {
  // Database exceptions can include connection URLs: never print raw errors.
  console.error(error instanceof BenchmarkError ? error.message
    : `Benchmark failed (${error instanceof Error ? error.name : "unknown"}); database error details omitted to protect connection credentials.`);
  process.exitCode = 1;
});
