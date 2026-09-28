/**
 * Read-only reconciliation of the task_messages trace backfill (MUL-432 item 9).
 *
 * Compares what `scripts/backfill-task-traces.ts` wrote with the
 * `multiremi_task_messages` rows it came from: the same seq set, the same
 * content per line (strings exactly; `input`/`meta` through
 * `parseStoredTraceJson` on both sides, a `null` source reading back as
 * `null`, otherwise canonical sorted-key JSON), a trailer whose `event_count`
 * is the row count (head is never compared with the count), and an index
 * entry and pointer that agree. `none` pointers are checked when the stop
 * moment is given.
 *
 * Default is a seeded random sample of 200 tasks spread over all four
 * groups; `--mode=full` checks every task and every subject digest. The seed
 * is recorded in the report so a sample can be replayed.
 *
 * Nothing is written: SQLite is opened on an existing file with
 * `query_only`, Postgres with `default_transaction_read_only`, and every
 * statement except a single SELECT is refused before it reaches either.
 *
 *   bun scripts/reconcile-task-traces.ts [--mode=sample|full] [--sample-size=200] [--seed=<text>]
 *     [--groups=chat,task,issue_without_archive,issue_with_archive] [--old-table-stopped-at=<ISO>]
 *     [--archive-root=<dir>] [--sqlite-path=<file>] [--out=<report.json>]
 *
 * Exit status: 0 no mismatch, 3 mismatches, 1 error.
 */
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  isPostgresConfigured,
  PostgresSyncDatabase,
  type SqlDatabase,
  type SqlStatement,
} from "../packages/server/src/store/db/postgres.js";
import { sessionArchiveStorageConfigFromEnv } from "../packages/server/src/session-archive/service.js";
import {
  assignTraceBackfillSubjects,
  TRACE_BACKFILL_GROUPS,
  type TraceBackfillGroup,
} from "./lib/task-trace-backfill.js";
import {
  reconcileTraceBackfill,
  selectTraceReconcileSample,
  type TraceReconcileReport,
  type TraceReconcileSample,
} from "./lib/task-trace-reconcile.js";

export const TRACE_RECONCILE_DEFAULT_SAMPLE_SIZE = 200;

/** One SELECT, optionally followed by a single trailing semicolon. */
const SINGLE_SELECT = /^\s*SELECT\b[^;]*;?\s*$/i;

/** Refuse everything but a single SELECT, whatever the backend would allow. */
export function readOnlySqlDatabase(db: SqlDatabase): SqlDatabase {
  const refuse = (what: string): never => {
    throw new Error(`reconcile is read-only; refused ${what}`);
  };
  const checked = (sql: string): string => (SINGLE_SELECT.test(sql) ? sql : refuse(`statement: ${sql.trim().slice(0, 60)}`));
  return {
    dialect: db.dialect,
    query: (sql: string): SqlStatement => db.query(checked(sql)),
    prepare: (sql: string): SqlStatement => db.prepare(checked(sql)),
    run: (sql: string) => refuse(`run: ${sql.trim().slice(0, 60)}`),
    exec: (sql: string) => refuse(`exec: ${sql.trim().slice(0, 60)}`),
    transaction: () => refuse("transaction"),
    close: () => db.close(),
  };
}

/**
 * The configured Multiremi database, opened so it cannot be written:
 * Postgres when `MULTIREMI_DATABASE_URL` is set, else the SQLite file the
 * server uses (`~/.remi/remi.db`), which must already exist.
 */
export function openReadOnlyTraceDatabase(options: { databaseUrl?: string | null; sqlitePath?: string | null } = {}): SqlDatabase {
  const url = options.databaseUrl ?? (isPostgresConfigured() ? process.env.MULTIREMI_DATABASE_URL!.trim() : null);
  if (url) {
    const pg = new PostgresSyncDatabase(url);
    pg.exec("SET default_transaction_read_only = on");
    return readOnlySqlDatabase(pg);
  }
  const path = resolve(options.sqlitePath ?? join(homedir(), ".remi", "remi.db"));
  const raw = new Database(path, { readwrite: true, create: false });
  raw.exec("PRAGMA query_only = ON");
  return readOnlySqlDatabase(Object.assign(raw as unknown as SqlDatabase, { dialect: "sqlite" as const }));
}

export interface TraceReconcileRunOptions {
  db: SqlDatabase;
  archiveRoot: string;
  mode: "sample" | "full";
  sampleSize?: number;
  seed?: string;
  groups?: readonly TraceBackfillGroup[] | null;
  oldTableStoppedAt?: string | null;
  now?: () => Date;
}

export interface TraceReconcileRunReport {
  generated_at: string;
  dialect: string;
  archive_root: string;
  old_table_stopped_at: string | null;
  sample: (Omit<TraceReconcileSample, "taskIds"> & { tasks: number }) | null;
  result: TraceReconcileReport;
}

export async function runTraceReconcile(options: TraceReconcileRunOptions): Promise<TraceReconcileRunReport> {
  const cutoff = options.oldTableStoppedAt ?? null;
  const assignment = assignTraceBackfillSubjects(options.db, { oldTableStoppedAt: cutoff });
  const sample = options.mode === "sample"
    ? selectTraceReconcileSample(assignment, {
      size: options.sampleSize ?? TRACE_RECONCILE_DEFAULT_SAMPLE_SIZE,
      seed: options.seed ?? randomBytes(8).toString("hex"),
    })
    : null;
  const result = await reconcileTraceBackfill(options.db, {
    archiveRoot: options.archiveRoot,
    oldTableStoppedAt: cutoff,
    assignment,
    taskIds: sample?.taskIds ?? null,
    groups: options.groups ?? null,
  });
  return {
    generated_at: (options.now?.() ?? new Date()).toISOString(),
    dialect: options.db.dialect ?? "unknown",
    archive_root: options.archiveRoot,
    old_table_stopped_at: cutoff,
    sample: sample
      ? { seed: sample.seed, requested: sample.requested, tasks: sample.taskIds.size, by_group: sample.by_group }
      : null,
    result,
  };
}

// ───────────────────────────── CLI ─────────────────────────────

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function parseGroups(raw: string | undefined): TraceBackfillGroup[] | null {
  if (!raw) return null;
  const groups = raw.split(",").map((group) => group.trim()).filter(Boolean);
  for (const group of groups) {
    if (!(TRACE_BACKFILL_GROUPS as readonly string[]).includes(group)) {
      throw new Error(`--groups: unknown group ${group}; expected ${TRACE_BACKFILL_GROUPS.join(",")}`);
    }
  }
  return groups as TraceBackfillGroup[];
}

async function main(): Promise<void> {
  const mode = argValue("mode") ?? "sample";
  if (mode !== "sample" && mode !== "full") throw new Error("--mode must be sample or full");
  const rawSize = argValue("sample-size");
  const sampleSize = rawSize === undefined ? undefined : Number(rawSize);
  if (sampleSize !== undefined && (!Number.isSafeInteger(sampleSize) || sampleSize <= 0)) {
    throw new Error("--sample-size must be a positive integer");
  }
  const groups = parseGroups(argValue("groups"));
  const archiveRoot = resolve(argValue("archive-root") ?? sessionArchiveStorageConfigFromEnv().root);
  const out = argValue("out");
  const db = openReadOnlyTraceDatabase({ sqlitePath: argValue("sqlite-path") ?? null });
  try {
    const report = await runTraceReconcile({
      db,
      archiveRoot,
      mode,
      sampleSize,
      seed: argValue("seed"),
      groups,
      oldTableStoppedAt: argValue("old-table-stopped-at") ?? null,
    });
    if (out) await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    const { result } = report;
    process.stdout.write(`${JSON.stringify({
      dialect: report.dialect,
      old_table_stopped_at: report.old_table_stopped_at,
      mode: result.mode,
      sample: report.sample,
      checked_subjects: result.checked_subjects,
      checked_tasks: result.checked_tasks,
      checked_rows: result.checked_rows,
      checked_none: result.checked_none,
      checked_by_group: result.checked_by_group,
      mismatches: result.mismatches,
      mismatch_total: result.mismatch_total,
      informational: result.informational,
      mismatch_samples: result.samples.mismatch,
      ok: result.ok,
    }, null, 2)}\n`);
    if (!result.ok) process.exitCode = 3;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  await main();
}
