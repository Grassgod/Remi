import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { SQLITE_ONLY_SUITES, backendsInScope, postgresScopeKey } from "../helpers/postgres-scope.js";

/**
 * tests/helpers/postgres-scope.ts is the single list of dual-dialect suites that
 * skip their PostgreSQL run (rule: TESTING.md "PostgreSQL 覆盖范围"). Suites
 * keep both dialects by default; this ratchet keeps the list honest: every
 * entry exists, has a one-line reason, is wired through the helper, and shows
 * none of the signals that make a PostgreSQL run worth its time. A suite that
 * trips a signal goes back to both dialects instead of widening the patterns.
 */

const ROOT = join(import.meta.dir, "../..");
const listed = Object.entries(SQLITE_ONLY_SUITES);

// Names of suites that exist for PostgreSQL behaviour: dialect, locks, races,
// migrations, crash recovery, transactions, the sync bridge, pools, matrices.
const PROTECTED_NAME = /postgres|(^|[-_.])pg([-_.]|$)|lock|race|concurren|migration|query-count|golden|crash|depth|transaction|rollback|parity|backfill|isolation|advisory|reply|bridge|pool|two-process|multiprocess|matrix|reusable|routing/i;

const PROTECTED_CONTENT: ReadonlyArray<readonly [string, RegExp]> = [
  ["locks, savepoints or rollback", /FOR UPDATE|advisory|deadlock|SAVEPOINT|savepoint|maxTransactionDepth|lockOrder|rollback|instrumentDb/i],
  ["fault injection on the database or a repository", /spyOn\(\s*[\w.]*\bdb\s*,|Repo\.prototype/],
  ["concurrency or extra processes", /new Worker\(|Bun\.spawn|spawnSync|Promise\.all\(/],
  ["migrations or historical schemas", /bootstrapPreUnifiedSchema|runMigrations\(|schema_migrations|historicalWriters|withHistoricalConversationStore|unifiedModelBackendTests/],
  ["catalog, EXPLAIN, PRAGMA or triggers", /information_schema|pg_catalog|pg_class|pg_indexes|pg_locks|sqlite_master|PRAGMA |EXPLAIN|CREATE TRIGGER|CREATE FUNCTION/],
  ["clock control or stale/expiry/lease/reminder timestamps", /setSystemTime|useFakeTimers|Date\.now\(\)\s*-|expires_at|expiresAt|leased_until|last_heartbeat_at|reminder|idle_days/i],
  ["read pool, reply limits, statement counts or reopen", /createReadPool|readPool|MULTIREMI_PG_REPLY|PostgresReplyTooLarge|readProcessDbCounters|countingDatabase|\.reopen\(\)/],
];

const WIRING = [`backendsInScope(import.meta.path`, `file: import.meta.path`];
const BACKEND_LIST = /\[\s*['"](sqlite|SQLite)['"]\s*,\s*['"](postgres|pg|PostgreSQL)['"]\s*\]/;

describe("PostgreSQL scope list", () => {
  test("lists existing test files, each with a one-line reason", () => {
    expect(listed.length).toBeGreaterThan(0);
    for (const [file, reason] of listed) {
      expect(file, `${file}: list repository-relative .test.ts paths`).toMatch(/^tests\/.+\.test\.ts$/);
      expect(existsSync(join(ROOT, file)), `${file} no longer exists; remove its entry`).toBe(true);
      expect(reason.trim().length, `${file}: give a reason`).toBeGreaterThanOrEqual(20);
      expect(reason, `${file}: keep the reason on one line`).not.toContain("\n");
    }
  });

  test("every listed suite goes through the helper, and only listed suites do", async () => {
    for (const [file] of listed) {
      const source = readFileSync(join(ROOT, file), "utf8");
      expect(WIRING.some(call => source.includes(call)),
        `${file} is listed but never passes import.meta.path to backendsInScope or pendingTurnBackendTests`).toBe(true);
      const lines = source.split("\n");
      const unscoped = lines.findIndex(line => BACKEND_LIST.test(line) && !line.includes("backendsInScope("));
      expect(unscoped === -1 ? null : `${file}:${unscoped + 1} ${lines[unscoped]!.trim()}`,
        `${file} still loops over both dialects outside backendsInScope`).toBeNull();
      const calls = source.match(/pendingTurnBackendTests\(/g)?.length ?? 0;
      const scopedCalls = source.match(/file: import\.meta\.path/g)?.length ?? 0;
      expect(scopedCalls, `${file}: pass file: import.meta.path to every pendingTurnBackendTests call`).toBe(calls);
    }
    const self = postgresScopeKey(import.meta.path);
    for await (const file of new Bun.Glob("tests/**/*.test.ts").scan({ cwd: ROOT })) {
      const key = file.split("\\").join("/");
      if (key === self) continue;
      const source = readFileSync(join(ROOT, key), "utf8");
      if (WIRING.some(call => source.includes(call))) {
        expect(Object.hasOwn(SQLITE_ONLY_SUITES, key), `${key} uses the PostgreSQL scope helper but is not listed`).toBe(true);
      }
    }
  });

  test("no listed suite exercises PostgreSQL-specific behaviour", () => {
    for (const [file] of listed) {
      expect(basename(file), `${file}: the name marks a database-specific suite; keep PostgreSQL`).not.toMatch(PROTECTED_NAME);
      const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
      for (const [signal, pattern] of PROTECTED_CONTENT) {
        const hit = lines.findIndex(line => pattern.test(line));
        expect(hit === -1 ? null : `${file}:${hit + 1} ${lines[hit]!.trim()}`,
          `${file} shows ${signal}; keep its PostgreSQL run`).toBeNull();
      }
    }
  });

  test("a listed suite keeps SQLite and drops only PostgreSQL; others keep both", () => {
    const [file] = listed[0]!;
    const path = join(ROOT, file);
    expect(backendsInScope(path, ["sqlite", "postgres"] as const)).toEqual(["sqlite"]);
    expect(backendsInScope(path, ["SQLite", "PostgreSQL"] as const)).toEqual(["SQLite"]);
    expect(backendsInScope(path, [{ name: "sqlite" }, { name: "pg" }])).toEqual([{ name: "sqlite" }]);
    expect(backendsInScope(import.meta.path, ["sqlite", "pg"] as const)).toEqual(["sqlite", "pg"]);
  });
});
