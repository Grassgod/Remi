/**
 * Backfill `multiremi_task_messages` into per-subject trace archives (MUL-432).
 *
 * Default mode is read-only: it plans every subject, counts what would be
 * written and reports every reason the run would stop. Execution requires
 * `--execute --confirm=MUL-402 --old-table-stopped-at=<ISO>` and an operator
 * authorization; it runs where the API runs, with the same
 * `MULTIREMI_DATABASE_URL` and `MULTIREMI_SESSION_ARCHIVE_ROOT`, and publishes
 * through `SessionArchiveService` so archives land under the same path rules.
 *
 * Order: Chat subjects first as the canary, then one-shot Tasks, then Issues
 * without an archive, then Issues that already have one. Each group is
 * reconciled against the source rows before the next one starts.
 *
 * Per subject: render `traces/<task_id>.jsonl` from the stored rows (header,
 * events with their original seq, trailer), build the zip with the
 * session-archive writer, re-read and verify every member, then in one
 * transaction insert a `ready` row with `metadata.kind = "trace_backfill"`,
 * move the pointers through the archive swap rule, write the `none` pointers,
 * write each task's event count, tool call count, `(type, tool)` histogram and
 * model onto its `turn` card and mark the subject done. Existing archive rows
 * are never modified.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { openMultiremiDatabase, type SqlDatabase } from "../packages/server/src/store/db/postgres.js";
import { MultiremiStore } from "../packages/server/src/store/store.js";
import { SessionArchiveService } from "../packages/server/src/session-archive/service.js";
import { prepareSessionArchive } from "../packages/daemon/src/agent-runtime/workspace/session-archive.js";
import {
  SESSION_ARCHIVE_FORMAT_V2,
  SESSION_ARCHIVE_TRACE_SUFFIX,
  SESSION_ARCHIVE_TRACES_PREFIX,
} from "../packages/contracts/src/session-archive.js";
import { readZipMemberBody } from "../packages/shared/src/zip/reader.js";
import {
  assignTraceBackfillSubjects,
  buildTraceBackfillPlan,
  renderTraceTask,
  TRACE_BACKFILL_CONFIRMATION,
  TRACE_BACKFILL_DEFAULT_MAX_SOURCE_BYTES,
  TRACE_BACKFILL_GROUPS,
  TRACE_BACKFILL_METADATA_KIND,
  TraceBackfillStopError,
  type TraceBackfillGroup,
  type TraceBackfillPlan,
  type TraceBackfillPlannedSubject,
  type TraceBackfillPlanReport,
} from "./lib/task-trace-backfill.js";
import {
  inspectTraceMember,
  openTraceBackfillArchive,
  reconcileTraceBackfill,
  type TraceReconcileReport,
} from "./lib/task-trace-reconcile.js";
import { emptyTraceTurnSummary, TraceTurnSummaryBuilder } from "./lib/task-trace-turn-summary.js";
import type { TraceBackfillTurnSummary } from "../packages/server/src/store/repos/trace-backfill-progress-repo.js";

const WRITE_BUFFER_BYTES = 1024 * 1024;

export interface TraceBackfillRunOptions {
  db: SqlDatabase;
  execute: boolean;
  /** Moment A stopped writing the old table. Required to execute. */
  oldTableStoppedAt?: string | null;
  /** Execute only: reused when given, otherwise built on `db`. */
  store?: MultiremiStore;
  service?: SessionArchiveService;
  /** Where subjects are staged; defaults to `<archive root>/.trace-backfill-staging`. */
  stagingDir?: string;
  maxSourceBytes?: number;
  chunkBytes?: number;
  batchRows?: number;
  log?: (line: string) => void;
  hooks?: {
    /** Called with the staged, verified archive, before it is published. */
    afterStage?: (subject: TraceBackfillPlannedSubject, archivePath: string) => void | Promise<void>;
  };
}

export interface TraceBackfillGroupResult {
  subjects: number;
  written: number;
  skipped_done: number;
  redone_digest_changed: number;
  resumed_interrupted: number;
  none_only: number;
  archives_created: number;
  archives_reused: number;
  pointers: number;
  none_pointers: number;
  turn_cards_updated: number;
  turn_cards_unchanged: number;
  turn_cards_missing: number;
  orphan_archive_dirs_removed: number;
}

export interface TraceBackfillRunReport {
  mode: "dry-run" | "execute";
  plan: TraceBackfillPlanReport;
  execution: Record<TraceBackfillGroup, TraceBackfillGroupResult> | null;
  reconcile: Partial<Record<TraceBackfillGroup, TraceReconcileReport>>;
}

export class TraceBackfillReconcileError extends Error {
  constructor(readonly group: TraceBackfillGroup, readonly report: TraceReconcileReport) {
    super(`trace backfill reconciliation of ${group} found ${report.mismatch_total} mismatches`);
    this.name = "TraceBackfillReconcileError";
  }
}

export class TraceBackfillSourceChangedError extends Error {
  constructor(readonly taskId: string) {
    super(`task ${taskId} changed between planning and writing; rerun the backfill`);
    this.name = "TraceBackfillSourceChangedError";
  }
}

function emptyGroupResult(): TraceBackfillGroupResult {
  return {
    subjects: 0,
    written: 0,
    skipped_done: 0,
    redone_digest_changed: 0,
    resumed_interrupted: 0,
    none_only: 0,
    archives_created: 0,
    archives_reused: 0,
    pointers: 0,
    none_pointers: 0,
    turn_cards_updated: 0,
    turn_cards_unchanged: 0,
    turn_cards_missing: 0,
    orphan_archive_dirs_removed: 0,
  };
}

function stageName(subject: TraceBackfillPlannedSubject): string {
  return `${subject.kind}-${Buffer.from(subject.id, "utf8").toString("base64url")}`;
}

/**
 * Plan, and with `execute`, write every subject. Throws
 * {@link TraceBackfillStopError} before writing anything when the plan found a
 * reason to stop, and {@link TraceBackfillReconcileError} when a finished group
 * does not reconcile.
 */
export async function runTraceBackfill(options: TraceBackfillRunOptions): Promise<TraceBackfillRunReport> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  if (options.execute && !options.oldTableStoppedAt) {
    throw new Error("execution requires the moment the old table stopped being written (--old-table-stopped-at)");
  }
  const plan = buildTraceBackfillPlan(options.db, {
    oldTableStoppedAt: options.oldTableStoppedAt ?? null,
    maxSourceBytes: options.maxSourceBytes,
    chunkBytes: options.chunkBytes,
    batchRows: options.batchRows,
    log,
  });
  const report: TraceBackfillRunReport = {
    mode: options.execute ? "execute" : "dry-run",
    plan: plan.report,
    execution: null,
    reconcile: {},
  };
  if (!options.execute) return report;
  if (plan.stops.length) throw new TraceBackfillStopError(plan.stops);

  const store = options.store ?? new MultiremiStore(options.db);
  const service = options.service ?? new SessionArchiveService(store);
  const stagingRoot = options.stagingDir ?? join(service.config.root, ".trace-backfill-staging");
  const execution = Object.fromEntries(TRACE_BACKFILL_GROUPS.map((group) => [group, emptyGroupResult()])) as Record<
    TraceBackfillGroup,
    TraceBackfillGroupResult
  >;
  report.execution = execution;

  for (const group of TRACE_BACKFILL_GROUPS) {
    const subjects = plan.subjects.filter((subject) => subject.group === group);
    const result = execution[group];
    log(`execute: ${group}: ${subjects.length} subjects`);
    for (const subject of subjects) {
      result.subjects++;
      await backfillSubject({ options, plan, subject, store, service, stagingRoot, result, log });
    }
    const reconciled = await reconcileTraceBackfill(options.db, {
      archiveRoot: service.config.root,
      oldTableStoppedAt: options.oldTableStoppedAt,
      groups: [group],
      assignment: assignTraceBackfillSubjects(options.db, { oldTableStoppedAt: options.oldTableStoppedAt }),
      chunkBytes: options.chunkBytes,
      batchRows: options.batchRows,
    });
    report.reconcile[group] = reconciled;
    log(`reconcile: ${group}: ${reconciled.checked_tasks} tasks, ${reconciled.checked_rows} rows, ${reconciled.checked_none} none, ${reconciled.mismatch_total} mismatches`);
    if (!reconciled.ok) throw new TraceBackfillReconcileError(group, reconciled);
  }
  return report;
}

interface SubjectRun {
  options: TraceBackfillRunOptions;
  plan: TraceBackfillPlan;
  subject: TraceBackfillPlannedSubject;
  store: MultiremiStore;
  service: SessionArchiveService;
  stagingRoot: string;
  result: TraceBackfillGroupResult;
  log: (line: string) => void;
}

async function backfillSubject(run: SubjectRun): Promise<void> {
  const { subject, store, service, result } = run;
  const scope = { kind: subject.kind, id: subject.id };
  const progress = store.getTraceBackfillProgress(subject.kind, subject.id);
  if (progress?.status === "done" && progress.digest === subject.digest) {
    result.skipped_done++;
    return;
  }
  if (progress?.status === "done") result.redone_digest_changed++;
  else if (progress?.status === "running") result.resumed_interrupted++;

  const stage = join(run.stagingRoot, stageName(subject));
  await rm(stage, { recursive: true, force: true });
  result.orphan_archive_dirs_removed += (await service.cleanupTraceBackfillOrphans(subject.workspaceId, scope)).length;
  const progressInput = {
    subjectKind: subject.kind,
    subjectId: subject.id,
    taskCount: subject.tasks.length + subject.noneTaskIds.length,
    rowCount: subject.rowCount,
    digest: subject.digest,
  };
  store.markTraceBackfillRunning(progressInput);
  const noneSummaries = subject.noneTaskIds.map(emptyTraceTurnSummary);
  const countTurnCards = (counts: { updated: number; unchanged: number; missing: number }) => {
    result.turn_cards_updated += counts.updated;
    result.turn_cards_unchanged += counts.unchanged;
    result.turn_cards_missing += counts.missing;
  };

  if (subject.tasks.length === 0) {
    const committed = store.commitTraceBackfill({
      workspaceId: subject.workspaceId,
      subjectKind: subject.kind,
      subjectId: subject.id,
      archive: null,
      pointers: [],
      noneTaskIds: subject.noneTaskIds,
      progress: progressInput,
      taskDigests: [],
      turnSummaries: noneSummaries,
    });
    countTurnCards(committed.turnCards);
    result.none_only++;
    result.none_pointers += subject.noneTaskIds.length;
    result.written++;
    return;
  }

  try {
    const turnSummaries: TraceBackfillTurnSummary[] = [];
    const prepared = await stageSubject(run, stage, turnSummaries);
    await run.options.hooks?.afterStage?.(subject, prepared.archivePath);
    const existing = new Set(store.listSessionArchivesForSubject(subject.kind, subject.id).map((archive) => archive.id));
    const committed = await service.ingestTraceBackfill({
      workspaceId: subject.workspaceId,
      subject: scope,
      runtimeId: subject.runtimeId,
      daemonId: subject.daemonId,
      archivePath: prepared.archivePath,
      sourceRevision: prepared.sourceRevision,
      sha256: prepared.sha256,
      sizeBytes: prepared.sizeBytes,
      fileCount: prepared.fileCount,
      metadata: {
        kind: TRACE_BACKFILL_METADATA_KIND,
        format: SESSION_ARCHIVE_FORMAT_V2,
        subject: scope,
        task_count: subject.tasks.length,
        none_count: subject.noneTaskIds.length,
        row_count: subject.rowCount,
        digest: subject.digest,
      },
      noneTaskIds: subject.noneTaskIds,
      progress: progressInput,
      taskDigests: subject.tasks.map((task) => ({
        taskId: task.taskId, rowCount: task.rowCount, headSeq: task.headSeq, digest: task.digest,
      })),
      turnSummaries: [...turnSummaries, ...noneSummaries],
    });
    if (committed.archive && existing.has(committed.archive.id)) result.archives_reused++;
    else result.archives_created++;
    result.pointers += committed.pointerCount;
    countTurnCards(committed.turnCards);
    result.none_pointers += subject.noneTaskIds.length;
    result.written++;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/**
 * Write the subject's trace files, build its zip with the session-archive
 * writer and verify every member against the plan. Each task's turn summary is
 * derived from the same events and pushed onto `summaries`.
 */
async function stageSubject(
  run: SubjectRun,
  stage: string,
  summaries: TraceBackfillTurnSummary[],
): Promise<Awaited<ReturnType<typeof prepareSessionArchive>>> {
  const { subject, plan, options } = run;
  const runtimeRoot = join(stage, "runtime");
  const sessionRoot = join(runtimeRoot, "backfill");
  const tracesDir = join(sessionRoot, "traces");
  mkdirSync(tracesDir, { recursive: true, mode: 0o700 });
  for (const planned of subject.tasks) {
    const task = plan.tasks.get(planned.taskId)!;
    const fd = openSync(join(tracesDir, `${planned.taskId}${SESSION_ARCHIVE_TRACE_SUFFIX}`), "wx", 0o600);
    try {
      let pending: string[] = [];
      let pendingBytes = 0;
      const flush = () => {
        if (!pending.length) return;
        writeSync(fd, pending.join(""));
        pending = [];
        pendingBytes = 0;
      };
      const summary = new TraceTurnSummaryBuilder(planned.taskId);
      const rendered = renderTraceTask(options.db, task, {
        batchRows: options.batchRows,
        chunkBytes: options.chunkBytes,
        onLine: (line) => {
          pending.push(line);
          pendingBytes += line.length;
          if (pendingBytes >= WRITE_BUFFER_BYTES) flush();
        },
        onEvent: (event) => summary.add(event),
      });
      flush();
      fsyncSync(fd);
      if (rendered.task.digest !== planned.digest || rendered.task.rowCount !== planned.rowCount) {
        throw new TraceBackfillSourceChangedError(planned.taskId);
      }
      summaries.push(summary.finish());
    } finally {
      closeSync(fd);
    }
  }

  let prepared: Awaited<ReturnType<typeof prepareSessionArchive>>;
  try {
    prepared = await prepareSessionArchive(stage, {
      subject: { kind: subject.kind, id: subject.id },
      providerRoots: [{ sessionId: "backfill", root: sessionRoot }],
      storageBoundary: runtimeRoot,
      stagingRoot: join(stage, "spool"),
      maxSourceBytes: options.maxSourceBytes ?? TRACE_BACKFILL_DEFAULT_MAX_SOURCE_BYTES,
    });
  } catch (error) {
    throw new TraceBackfillStopError([{
      code: "archive_writer_rejected",
      count: 1,
      detail: `${subject.kind}:${subject.id}: ${error instanceof Error ? error.message : String(error)}`,
    }]);
  }
  await verifyStagedArchive(subject, prepared.archivePath);
  return prepared;
}

/**
 * Re-read the staged zip: exactly the planned members, each with its recorded
 * sha, one line per row plus header and trailer, the planned digest, and index
 * facts that match the rows.
 */
async function verifyStagedArchive(subject: TraceBackfillPlannedSubject, archivePath: string): Promise<void> {
  const failures: string[] = [];
  const opened = await openTraceBackfillArchive(dirname(archivePath), basename(archivePath));
  try {
    const traces = opened.index.members.filter((member) => member.kind === "trace");
    const expected = new Map(subject.tasks.map((task) => [
      `${SESSION_ARCHIVE_TRACES_PREFIX}${task.taskId}${SESSION_ARCHIVE_TRACE_SUFFIX}`, task,
    ]));
    if (traces.length !== expected.size || traces.some((member) => !expected.has(member.path))) {
      failures.push(`member set differs: ${traces.length} members for ${expected.size} tasks`);
    }
    for (const [path, task] of expected) {
      const entry = traces.find((member) => member.path === path);
      if (!entry) {
        failures.push(`${task.taskId}: member missing`);
        continue;
      }
      const { bytes } = await readZipMemberBody(opened.handle, {
        dataOffset: entry.data_offset,
        compressedSize: entry.compressed_size,
        uncompressedSize: entry.uncompressed_size,
        sha256: entry.sha256,
      });
      const facts = inspectTraceMember(bytes, { taskId: task.taskId, sessionId: task.header.session_id });
      if (!facts.check.ok) failures.push(`${task.taskId}: ${facts.check.reason}`);
      else if (!facts.check.value.closed) failures.push(`${task.taskId}: not closed`);
      if (!facts.header || !facts.trailer || facts.seqs.length !== task.rowCount) {
        failures.push(`${task.taskId}: ${facts.seqs.length} event lines for ${task.rowCount} rows`);
      }
      if (facts.badEventShapes) failures.push(`${task.taskId}: ${facts.badEventShapes} event lines with unexpected keys`);
      if (facts.digest !== task.digest) failures.push(`${task.taskId}: digest differs from the plan`);
      if (entry.head !== task.headSeq || entry.event_count !== task.rowCount || entry.closed !== true) {
        failures.push(`${task.taskId}: index head=${entry.head} event_count=${entry.event_count} closed=${entry.closed}`);
      }
    }
  } finally {
    await opened.handle.close();
  }
  if (failures.length) {
    throw new TraceBackfillStopError([{
      code: "staged_archive_rejected",
      count: failures.length,
      detail: `${subject.kind}:${subject.id}`,
      samples: failures.slice(0, 20),
    }]);
  }
}

// ───────────────────────────── CLI ─────────────────────────────

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function positiveInt(name: string): number | undefined {
  const raw = argValue(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`--${name} must be a positive integer`);
  return value;
}

/** What a human reads first: counts and stops, not every sample. */
export function summarizeTraceBackfillPlan(report: TraceBackfillPlanReport) {
  return {
    dialect: report.dialect,
    old_table_stopped_at: report.old_table_stopped_at,
    source: report.source,
    groups: report.groups,
    subjects: report.subjects,
    traced_tasks: report.traced_tasks,
    traced_rows: report.traced_rows,
    largest_subject_bytes: report.largest_subject_bytes,
    none: report.none,
    json: {
      json_unparseable_input: report.json.json_unparseable_input,
      json_unparseable_meta: report.json.json_unparseable_meta,
      json_unparseable_unexplained: report.json.json_unparseable_unexplained,
      json_nonroundtrip: report.json.json_nonroundtrip,
      json_nonroundtrip_by_category: report.json.json_nonroundtrip_by_category,
      sql_truncated_input: report.json.sql_truncated_input,
      sql_truncated_meta: report.json.sql_truncated_meta,
      meta_nul_escape_rows: report.json.meta.nul_escape_rows,
      input_nul_escape_rows: report.json.input.nul_escape_rows,
    },
    stops: report.stops.map(({ code, count }) => ({ code, count })),
  };
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const confirmation = argValue("confirm");
  const oldTableStoppedAt = argValue("old-table-stopped-at") ?? null;
  if (execute && confirmation !== TRACE_BACKFILL_CONFIRMATION) {
    throw new Error(`execution requires --execute --confirm=${TRACE_BACKFILL_CONFIRMATION}`);
  }
  if (execute && !oldTableStoppedAt) {
    throw new Error("execution requires --old-table-stopped-at=<ISO time A stopped writing multiremi_task_messages>");
  }
  const out = argValue("out");
  const db = openMultiremiDatabase();
  try {
    let report: TraceBackfillRunReport;
    try {
      report = await runTraceBackfill({
        db,
        execute,
        oldTableStoppedAt,
        stagingDir: argValue("staging-dir"),
        maxSourceBytes: positiveInt("max-source-bytes"),
        chunkBytes: positiveInt("chunk-bytes"),
      });
    } catch (error) {
      if (error instanceof TraceBackfillStopError) {
        process.stdout.write(`${JSON.stringify({ stopped: error.stops }, null, 2)}\n`);
        process.exitCode = 2;
        return;
      }
      if (error instanceof TraceBackfillReconcileError) {
        process.stdout.write(`${JSON.stringify({ reconcile_failed: error.group, report: error.report }, null, 2)}\n`);
        process.exitCode = 3;
        return;
      }
      throw error;
    }
    if (out) await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({
      mode: report.mode,
      plan: summarizeTraceBackfillPlan(report.plan),
      execution: report.execution,
      reconcile: Object.fromEntries(Object.entries(report.reconcile).map(([group, value]) => [group, {
        checked_tasks: value.checked_tasks,
        checked_rows: value.checked_rows,
        checked_none: value.checked_none,
        checked_turn_cards: value.checked_turn_cards,
        mismatch_total: value.mismatch_total,
        informational: value.informational,
      }])),
    }, null, 2)}\n`);
    if (!execute) {
      if (report.plan.stops.length) process.exitCode = 2;
      process.stdout.write(
        `Dry run only. Execution requires explicit authorization and --execute --confirm=${TRACE_BACKFILL_CONFIRMATION} --old-table-stopped-at=<ISO>.\n`,
      );
    }
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  await main();
}
