#!/usr/bin/env bun
/**
 * MUL-405: real multi-process evidence for the two races this change fixes.
 *
 * The store reaches PostgreSQL through `PostgresSyncDatabase`, which blocks the
 * main thread on `Atomics.wait` for every statement. Two stores in ONE process
 * therefore cannot overlap — they serialize on the event loop — and an
 * in-process "concurrency" test reproduces neither race. Both scenarios here
 * spawn real child processes instead.
 *
 * `migrations` — N rounds of two processes constructing a `MultiremiStore`
 * against the same brand-new database at the same instant. Before the migration
 * lock, both runs execute the CREATE TABLE / CREATE INDEX batch concurrently and
 * collide on catalog objects (`type "multiremi_schema_migrations" already
 * exists`, `pg_type_typname_nsp_index`). After it, the second waits and replays
 * the idempotent statements against a migrated schema.
 *
 * `issues` — two processes calling `createIssue` in one workspace. The number
 * comes from `MAX(issue_number) + 1`; without the transaction lock both read the
 * same maximum and insert it, so the run reports duplicate numbers. With it, the
 * numbers partition and every call succeeds. The child asserts the invariant
 * itself (numbers unique inside each process, and the two processes disjoint).
 *
 * Usage:
 *   MULTIREMI_TEST_POSTGRES_URL=postgres://… \
 *     bun run tests/manual/mul405-multiprocess-safety.ts --part all \
 *       --out reports/performance/MUL-405-multiprocess.json
 *
 * `lock` — three processes holding one lock (and, as the control, the identical
 * critical section with no lock at all), reporting whether their intervals
 * overlapped. This isolates the mechanism the other two scenarios depend on.
 *
 * Options: --part migrations|issues|lock|all (default all), --rounds N
 * (default 20), --per-process N (default 200), --hold-ms N (default 400),
 * --out <path>, --label <name>.
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const ADMIN_URL = process.env.MULTIREMI_TEST_POSTGRES_URL
  ?? "postgres://multimira:multimira@localhost:5432/postgres";
const WORK_DIR = `/tmp/mul405-worker-${process.pid}`;

// ────────────────────────────── arguments ──────────────────────────────

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

const PART = argValue("--part") ?? "all";
const ROUNDS = Number(argValue("--rounds") ?? 20);
const PER_PROCESS = Number(argValue("--per-process") ?? 200);
const LABEL = argValue("--label") ?? null;
/** How long each of the three lock-probe processes holds the critical section. */
const HOLD_MS = Number(argValue("--hold-ms") ?? 400);
const OUT = argValue("--out")
  ? resolve(argValue("--out")!)
  : join(REPO_ROOT, "reports", "performance", "MUL-405-multiprocess.json");

// ────────────────────────────── child entry point ──────────────────────────────

if (process.env.MUL405_ROLE) {
  await runChild();
  process.exit(0);
}

async function runChild(): Promise<void> {
  const role = process.env.MUL405_ROLE!;
  const url = process.env.MUL405_DATABASE_URL!;
  try {
    if (role === "migrate") {
      const { PostgresSyncDatabase } = await import("../../packages/server/src/store/db/postgres.js");
      // Imported lazily so the parent process never pays for the store graph.
      const { MultiremiStore } = await import("../../packages/server/src/store/store.js");
      const started = performance.now();
      const db = new PostgresSyncDatabase(process.env.MULTIREMI_DATABASE_URL!);
      const store = new MultiremiStore(db);
      // Touching the schema proves the migration really ran here rather than the
      // child reporting success after failing to open the database.
      store.listIssues({ workspaceId: "local" });
      store.ensureLocalWorkspace();
      db.close();
      await Bun.write(process.env.MUL405_RESULT!, JSON.stringify({
        ok: true,
        ms: performance.now() - started,
      }));
      return;
    }
    if (role === "lock") {
      const { PostgresSyncDatabase } = await import("../../packages/server/src/store/db/postgres.js");
      // `MUL405_NO_LOCK=1` runs the identical critical section without the lock,
      // which is the pre-MUL-405 shape and the control for this measurement.
      const noLock = process.env.MUL405_NO_LOCK === "1";
      const roleName = process.env.MUL405_LOCK_ROLE ?? "?";
      const log = process.env.MUL405_LOCK_LOG!;
      const db = new PostgresSyncDatabase(url);
      const critical = () => {
        appendFileSync(log, `${JSON.stringify({ role: roleName, kind: "enter", ts: Date.now() })}\n`);
        const until = Date.now() + HOLD_MS;
        while (Date.now() < until) {
          // Busy-wait: this models a process holding a critical section, and it
          // must not yield to anything else in this child.
        }
        appendFileSync(log, `${JSON.stringify({ role: roleName, kind: "exit", ts: Date.now() })}\n`);
      };
      if (noLock) critical();
      else db.advisoryLock("multiremi:number:probe", critical);
      db.close();
      await Bun.write(process.env.MUL405_RESULT!, JSON.stringify({ ok: true }));
      return;
    }
    if (role === "issues") {
      const { PostgresSyncDatabase } = await import("../../packages/server/src/store/db/postgres.js");
      const { MultiremiStore } = await import("../../packages/server/src/store/store.js");
      const db = new PostgresSyncDatabase(url);
      const store = new MultiremiStore(db);
      const workerIndex = Number(process.env.MUL405_WORKER_INDEX ?? 0);
      const numbers: number[] = [];
      const failures: string[] = [];
      const started = performance.now();
      for (let i = 0; i < PER_PROCESS; i += 1) {
        try {
          const issue = store.createIssue({
            title: `MUL-405 worker ${workerIndex} issue ${i}`,
            workspaceId: "local",
          });
          numbers.push(issue.number);
        } catch (err) {
          failures.push((err as Error).message);
        }
      }
      const unique = new Set(numbers);
      const inProcessDuplicates = numbers.length - unique.size;
      db.close();
      await Bun.write(process.env.MUL405_RESULT!, JSON.stringify({
        ok: failures.length === 0 && inProcessDuplicates === 0,
        workerIndex,
        created: numbers.length,
        failures: failures.length,
        firstFailure: failures[0] ?? null,
        inProcessDuplicates,
        numbers: [...numbers].sort((a, b) => a - b),
        ms: performance.now() - started,
      }));
      return;
    }
    throw new Error(`unknown MUL405_ROLE: ${role}`);
  } catch (err) {
    await Bun.write(process.env.MUL405_RESULT!, JSON.stringify({
      ok: false,
      crash: (err as Error).message,
      stack: (err as Error).stack ?? null,
    }));
  }
}

// ────────────────────────────── parent helpers ──────────────────────────────

interface ChildResult {
  ok?: boolean;
  crash?: string;
  ms?: number;
  created?: number;
  failures?: number;
  inProcessDuplicates?: number;
  firstFailure?: string | null;
  numbers?: number[];
}

async function admin<T>(fn: (sql: InstanceType<typeof Bun.SQL>) => Promise<T>): Promise<T> {
  const sql = new Bun.SQL(ADMIN_URL, { max: 1 });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

/** One database per round, so "cold" really means the schema does not exist yet. */
async function freshDatabase(name: string): Promise<string> {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  await admin(async (sql) => {
    await sql.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await sql.unsafe(`CREATE DATABASE ${name}`);
  });
  return url.toString();
}

async function dropDatabase(name: string): Promise<void> {
  await admin(async (sql) => {
    await sql.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  });
}

/**
 * Start both children and wait for both. The interesting case is a child that
 * exits non-zero or writes `ok: false`, so both are collected rather than
 * short-circuiting on the first failure.
 */
async function spawnPair(
  databaseUrl: string,
  label: string,
  extras: Array<Record<string, string>>,
): Promise<Array<ChildResult | { spawnError: string; exitCode: number; stderr: string }>> {
  const resultFiles = extras.map((_, index) => join(WORK_DIR, `${label}-${index}.json`));
  const children = extras.map((extra, index) => Bun.spawn(
    [process.execPath, import.meta.path],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        MUL405_ROLE: extra.MUL405_ROLE,
        MUL405_DATABASE_URL: databaseUrl,
        MUL405_RESULT: resultFiles[index]!,
        // `MULTIREMI_DATABASE_URL` is what `openMultiremiDatabase` reads; the
        // children that construct a store directly take it from the environment.
        MULTIREMI_DATABASE_URL: databaseUrl,
        ...extra,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  ));
  const exits = await Promise.all(children.map((child) => child.exited));
  const stderrs = await Promise.all(children.map((child) => new Response(child.stderr).text()));
  const results: Array<ChildResult | { spawnError: string; exitCode: number; stderr: string }> = [];
  for (let index = 0; index < children.length; index += 1) {
    const exitCode = exits[index]!;
    const stderr = stderrs[index]!;
    const file = Bun.file(resultFiles[index]!);
    if (exitCode !== 0 || !(await file.exists())) {
      results.push({ spawnError: `exit ${exitCode}`, exitCode, stderr: stderr.slice(-2000) });
      continue;
    }
    results.push(JSON.parse(await file.text()) as ChildResult);
  }
  return results;
}

// ────────────────────────────── scenarios ──────────────────────────────

interface ScenarioResult {
  name: string;
  rounds: number;
  failedRounds: number;
  failureRate: number;
  firstErrors: string[];
  roundMsP50: number;
  roundMsP95: number;
  roundsDetail: Array<Record<string, unknown>>;
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]!;
}

async function runMigrationRounds(rounds: number): Promise<ScenarioResult> {
  const roundMs: number[] = [];
  const roundsDetail: Array<Record<string, unknown>> = [];
  const firstErrors: string[] = [];
  let failedRounds = 0;
  for (let round = 0; round < rounds; round += 1) {
    const name = `mul405_migrate_${process.pid}_${round}`;
    const url = await freshDatabase(name);
    const started = performance.now();
    const results = await spawnPair(url, `migrate-${round}`, [
      { MUL405_ROLE: "migrate" },
      { MUL405_ROLE: "migrate" },
    ]);
    const elapsed = performance.now() - started;
    roundMs.push(elapsed);
    const errors = results
      .map((entry) => ("spawnError" in entry
        ? `${entry.spawnError}: ${entry.stderr}`
        : entry.crash ?? (entry.ok ? null : "ok=false")))
      .filter((entry): entry is string => Boolean(entry));
    if (errors.length) {
      failedRounds += 1;
      if (firstErrors.length < 5) firstErrors.push(errors[0]!);
    }
    roundsDetail.push({
      round,
      ms: Math.round(elapsed),
      failed: errors.length > 0,
      errors,
      childMs: results.map((entry) => ("ms" in entry ? Math.round(entry.ms ?? 0) : null)),
    });
    await dropDatabase(name);
  }
  return {
    name: "concurrent cold-start migrations (2 processes x N fresh databases)",
    rounds,
    failedRounds,
    failureRate: rounds ? failedRounds / rounds : 0,
    firstErrors,
    roundMsP50: Math.round(percentile(roundMs, 0.5)),
    roundMsP95: Math.round(percentile(roundMs, 0.95)),
    roundsDetail,
  };
}

async function runIssueAllocation(): Promise<ScenarioResult> {
  const name = `mul405_issues_${process.pid}`;
  const url = await freshDatabase(name);
  // Both processes must see a database whose workspace already exists, which is
  // what a running platform looks like; the migration run above is what creates
  // it, and the parent deliberately does it once outside the timed section.
  const { PostgresSyncDatabase } = await import("../../packages/server/src/store/db/postgres.js");
  const { MultiremiStore } = await import("../../packages/server/src/store/store.js");
  const seedDb = new PostgresSyncDatabase(url);
  const seed = new MultiremiStore(seedDb);
  seed.ensureLocalWorkspace();
  seedDb.close();

  const started = performance.now();
  const results = await spawnPair(url, "issues", [
    { MUL405_ROLE: "issues", MUL405_WORKER_INDEX: "0" },
    { MUL405_ROLE: "issues", MUL405_WORKER_INDEX: "1" },
  ]);
  const elapsed = performance.now() - started;
  const errorMessages = results
    .map((entry) => ("spawnError" in entry
      ? `${entry.spawnError}: ${entry.stderr}`
      : entry.crash ?? entry.firstFailure ?? null))
    .filter((entry): entry is string => Boolean(entry));
  const numbers = results.flatMap((entry) => ("numbers" in entry ? entry.numbers ?? [] : []));
  const unique = new Set(numbers);
  const duplicatesAcrossProcesses = numbers.length - unique.size;
  const created = results.reduce((total, entry) => total + ("created" in entry ? entry.created ?? 0 : 0), 0);
  const failures = results.reduce((total, entry) => total + ("failures" in entry ? entry.failures ?? 0 : 0), 0);
  const firstErrors = [...errorMessages];
  if (duplicatesAcrossProcesses > 0) {
    firstErrors.unshift(`${duplicatesAcrossProcesses} duplicate issue numbers across processes`);
  }
  await dropDatabase(name);
  return {
    name: "concurrent createIssue (2 processes x N issues, one workspace)",
    rounds: 1,
    failedRounds: firstErrors.length ? 1 : 0,
    failureRate: firstErrors.length ? 1 : 0,
    firstErrors,
    roundMsP50: Math.round(elapsed),
    roundMsP95: Math.round(elapsed),
    roundsDetail: [{
      created,
      failures,
      duplicatesAcrossProcesses,
      minNumber: numbers.length ? Math.min(...numbers) : null,
      maxNumber: numbers.length ? Math.max(...numbers) : null,
      expected: PER_PROCESS * 2,
      childOk: results.map((entry) => ("ok" in entry ? entry.ok ?? false : false)),
    }],
  };
}

/**
 * Direct measurement of the lock itself, with the pre-MUL-405 shape as control.
 *
 * Three processes hold the same critical section (400 ms of busy-wait) at the
 * same instant. With the lock their intervals must not overlap at all; without
 * it they all overlap, which is what makes the migration and numbering races
 * possible in the first place.
 */
async function runLockProbe(): Promise<Record<string, unknown>> {
  const measure = async (noLock: boolean): Promise<{ pairs: number; intervals: Array<{ role: string; start: number; end: number }> }> => {
    const log = join(WORK_DIR, `lock-${noLock ? "none" : "held"}.log`);
    writeFileSync(log, "");
    const roles = ["A", "B", "C"];
    const results = await Promise.all(roles.map((role) => (
      (async () => {
        const child = Bun.spawn([process.execPath, import.meta.path], {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            MUL405_ROLE: "lock",
            MUL405_DATABASE_URL: ADMIN_URL,
            MUL405_RESULT: join(WORK_DIR, `lock-${noLock ? "none" : "held"}-${role}.json`),
            MULTIREMI_DATABASE_URL: ADMIN_URL,
            MUL405_LOCK_ROLE: role,
            MUL405_LOCK_LOG: log,
            ...(noLock ? { MUL405_NO_LOCK: "1" } : {}),
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        return child.exited;
      })()
    )));
    if (results.some((code) => code !== 0)) throw new Error("lock probe child failed");
    const events = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => (
      JSON.parse(line) as { role: string; kind: "enter" | "exit"; ts: number }
    ));
    // `role: "lock"` writes `ok:false` and still exits 0 when the database has no
    // `advisoryLock` (pre-MUL-405 code). Reporting "0 overlapping pairs" from an
    // empty log would look like the lock working, so the absence of events is an
    // error, not a pass.
    const entered = new Set(events.filter((event) => event.kind === "enter").map((event) => event.role));
    if (entered.size !== roles.length) {
      throw new Error(
        `lock probe did not run in every child (entered: ${[...entered].join(",") || "none"} of ${roles.join(",")}); ` +
          "the target tree may not implement SqlDatabase.advisoryLock",
      );
    }
    const open = new Map<string, number>();
    const intervals: Array<{ role: string; start: number; end: number }> = [];
    for (const event of events) {
      if (event.kind === "enter") open.set(event.role, event.ts);
      else intervals.push({ role: event.role, start: open.get(event.role)!, end: event.ts });
    }
    intervals.sort((left, right) => left.start - right.start);
    let pairs = 0;
    for (let index = 1; index < intervals.length; index += 1) {
      if (intervals[index]!.start < intervals[index - 1]!.end) pairs += 1;
    }
    return { pairs, intervals };
  };

  const held = await measure(false);
  const none = await measure(true);
  return {
    name: "3 processes holding one advisory lock (and the same section without it)",
    holdMs: HOLD_MS,
    withLockOverlappingPairs: held.pairs,
    withoutLockOverlappingPairs: none.pairs,
    withLockIntervals: held.intervals,
    withoutLockIntervals: none.intervals,
  };
}

// ────────────────────────────── main ──────────────────────────────

mkdirSync(WORK_DIR, { recursive: true });
mkdirSync(dirname(OUT), { recursive: true });

const report: Record<string, unknown> = {
  issue: "MUL-405",
  label: LABEL,
  generatedAt: new Date().toISOString(),
  command: [
    "MULTIREMI_TEST_POSTGRES_URL=postgres://… bun run tests/manual/mul405-multiprocess-safety.ts",
    `--part ${PART}`,
    `--rounds ${ROUNDS}`,
    `--per-process ${PER_PROCESS}`,
  ].join(" "),
  postgresVersion: null as string | null,
  bun: Bun.version,
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  cpuCount: navigator.hardwareConcurrency ?? null,
  gitHead: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: REPO_ROOT }).stdout.toString().trim(),
};

try {
  report.postgresVersion = await admin(async (sql) => {
    const rows = await sql`SELECT version() AS v`;
    return String((rows[0] as { v?: string } | undefined)?.v ?? "");
  });
} catch (err) {
  report.postgresVersion = `unavailable: ${(err as Error).message}`;
}

if (PART === "migrations" || PART === "all") {
  report.migrations = await runMigrationRounds(ROUNDS);
}
if (PART === "issues" || PART === "all") {
  report.issueAllocation = await runIssueAllocation();
}
if (PART === "lock" || PART === "all") {
  report.lockProbe = await runLockProbe();
}

rmSync(WORK_DIR, { recursive: true, force: true });
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);

const summarize = (entry: ScenarioResult | undefined): string => entry
  ? `${entry.failedRounds}/${entry.rounds} failed`
  : "not run";
console.log(JSON.stringify({
  event: "mul405_multiprocess_report",
  out: OUT,
  migrations: summarize(report.migrations as ScenarioResult | undefined),
  issueAllocation: summarize(report.issueAllocation as ScenarioResult | undefined),
  lockProbe: report.lockProbe
    ? `${(report.lockProbe as { withLockOverlappingPairs: number }).withLockOverlappingPairs} overlapping pairs with lock, ` +
      `${(report.lockProbe as { withoutLockOverlappingPairs: number }).withoutLockOverlappingPairs} without`
    : "not run",
}, null, 2));
