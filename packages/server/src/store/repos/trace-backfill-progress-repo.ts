import type { MultiremiSessionArchiveSubjectKind } from "@multiremi/contracts/types.js";
import { nowIso } from "@multiremi/ids.js";
import type { StoreContext } from "@multiremi/store/context.js";

type Row = Record<string, unknown>;

export type TraceBackfillProgressStatus = "running" | "done";

/** Progress of the task_messages trace backfill for one subject (MUL-432). */
export interface TraceBackfillProgress {
  subjectKind: MultiremiSessionArchiveSubjectKind;
  subjectId: string;
  status: TraceBackfillProgressStatus;
  taskCount: number;
  rowCount: number;
  /** Digest of the subject's source rows when the archive was planned. */
  digest: string | null;
  /** The `trace_backfill` archive of the last completed run. */
  archiveId: string | null;
  updatedAt: string;
}

export interface TraceBackfillProgressInput {
  subjectKind: MultiremiSessionArchiveSubjectKind;
  subjectId: string;
  taskCount: number;
  rowCount: number;
  digest: string;
}

/** Per-task digest of the last completed run of a subject. */
export interface TraceBackfillTaskDigest {
  taskId: string;
  rowCount: number;
  headSeq: number;
  digest: string;
}

export interface TraceBackfillTaskRecord extends TraceBackfillTaskDigest {
  subjectKind: MultiremiSessionArchiveSubjectKind;
  subjectId: string;
  archiveId: string;
  updatedAt: string;
}

function hydrateTask(row: Row): TraceBackfillTaskRecord {
  return {
    taskId: String(row.task_id),
    subjectKind: String(row.subject_kind) as MultiremiSessionArchiveSubjectKind,
    subjectId: String(row.subject_id),
    archiveId: String(row.archive_id),
    rowCount: Number(row.row_count ?? 0),
    headSeq: Number(row.head_seq ?? 0),
    digest: String(row.digest),
    updatedAt: String(row.updated_at),
  };
}

function hydrate(row: Row): TraceBackfillProgress {
  return {
    subjectKind: String(row.subject_kind) as MultiremiSessionArchiveSubjectKind,
    subjectId: String(row.subject_id),
    status: String(row.status) as TraceBackfillProgressStatus,
    taskCount: Number(row.task_count ?? 0),
    rowCount: Number(row.row_count ?? 0),
    digest: row.digest == null ? null : String(row.digest),
    archiveId: row.archive_id == null ? null : String(row.archive_id),
    updatedAt: String(row.updated_at),
  };
}

/**
 * Per-subject progress of `scripts/backfill-task-traces.ts`.
 *
 * A subject is `running` from the moment its staging files are written until
 * the transaction that makes its archive `ready`, which also marks it `done`.
 * A restart therefore finds either a finished subject (skipped while its
 * digest still matches) or an interrupted one (cleaned and redone); there is no
 * state in which the archive is ready but the progress row says otherwise.
 */
export class TraceBackfillProgressRepo {
  constructor(private readonly ctx: StoreContext) {}

  get(subjectKind: MultiremiSessionArchiveSubjectKind, subjectId: string): TraceBackfillProgress | null {
    const row = this.ctx.db.query(
      `SELECT * FROM multiremi_trace_backfill_progress
       WHERE subject_kind = ? AND subject_id = ?`,
    ).get(subjectKind, subjectId) as Row | null;
    return row ? hydrate(row) : null;
  }

  list(): TraceBackfillProgress[] {
    return (this.ctx.db.query(
      `SELECT * FROM multiremi_trace_backfill_progress
       ORDER BY subject_kind ASC, subject_id ASC`,
    ).all() as Row[]).map(hydrate);
  }

  /**
   * Claim a subject before its staging files exist.
   *
   * The previous `archive_id` is kept: until the new archive is ready, the
   * pointers still name the old one.
   */
  markRunning(input: TraceBackfillProgressInput): void {
    this.ctx.db.run(
      `INSERT INTO multiremi_trace_backfill_progress (
         subject_kind, subject_id, status, task_count, row_count, digest, archive_id, updated_at
       ) VALUES (?, ?, 'running', ?, ?, ?, NULL, ?)
       ON CONFLICT(subject_kind, subject_id) DO UPDATE SET
         status = 'running',
         task_count = excluded.task_count,
         row_count = excluded.row_count,
         digest = excluded.digest,
         updated_at = excluded.updated_at`,
      [input.subjectKind, input.subjectId, input.taskCount, input.rowCount, input.digest, nowIso()],
    );
  }

  listTasks(subjectKind: MultiremiSessionArchiveSubjectKind, subjectId: string): TraceBackfillTaskRecord[] {
    return (this.ctx.db.query(
      `SELECT * FROM multiremi_trace_backfill_tasks
       WHERE subject_kind = ? AND subject_id = ?
       ORDER BY task_id ASC`,
    ).all(subjectKind, subjectId) as Row[]).map(hydrateTask);
  }

  /**
   * Replace a subject's per-task digests. Like {@link markDone}, this belongs
   * to the transaction that makes `archiveId` ready.
   */
  replaceTasks(
    subjectKind: MultiremiSessionArchiveSubjectKind,
    subjectId: string,
    archiveId: string,
    tasks: readonly TraceBackfillTaskDigest[],
  ): void {
    const now = nowIso();
    this.ctx.db.run(
      "DELETE FROM multiremi_trace_backfill_tasks WHERE subject_kind = ? AND subject_id = ?",
      [subjectKind, subjectId],
    );
    // A task whose Chat Session was deleted since an earlier run now groups as
    // a one-shot Task, so its row can still belong to another subject.
    for (const task of tasks) {
      this.ctx.db.run(
        `INSERT INTO multiremi_trace_backfill_tasks (
           task_id, subject_kind, subject_id, archive_id, row_count, head_seq, digest, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           subject_kind = excluded.subject_kind,
           subject_id = excluded.subject_id,
           archive_id = excluded.archive_id,
           row_count = excluded.row_count,
           head_seq = excluded.head_seq,
           digest = excluded.digest,
           updated_at = excluded.updated_at`,
        [task.taskId, subjectKind, subjectId, archiveId, task.rowCount, task.headSeq, task.digest, now],
      );
    }
  }

  /** Must be called inside the transaction that makes `archiveId` ready. */
  markDone(input: TraceBackfillProgressInput & { archiveId: string | null }): void {
    this.ctx.db.run(
      `INSERT INTO multiremi_trace_backfill_progress (
         subject_kind, subject_id, status, task_count, row_count, digest, archive_id, updated_at
       ) VALUES (?, ?, 'done', ?, ?, ?, ?, ?)
       ON CONFLICT(subject_kind, subject_id) DO UPDATE SET
         status = 'done',
         task_count = excluded.task_count,
         row_count = excluded.row_count,
         digest = excluded.digest,
         archive_id = excluded.archive_id,
         updated_at = excluded.updated_at`,
      [
        input.subjectKind,
        input.subjectId,
        input.taskCount,
        input.rowCount,
        input.digest,
        input.archiveId,
        nowIso(),
      ],
    );
  }
}
