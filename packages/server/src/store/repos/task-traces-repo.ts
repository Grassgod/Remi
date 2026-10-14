import type { MultiremiTaskTrace, TraceRefLocation } from "@multiremi/contracts/trace-file.js";
import { nowIso } from "@multiremi/ids.js";
import type { StoreContext } from "@multiremi/store/context.js";

type Row = Record<string, unknown>;
export type TaskTraceQuery = (sql: string, params: readonly unknown[]) => Row | null;

function hydrate(row: Row): MultiremiTaskTrace {
  return {
    taskId: String(row.task_id),
    location: String(row.location) as TraceRefLocation,
    runtimeId: row.runtime_id == null ? null : String(row.runtime_id),
    eventCount: row.event_count == null ? null : Number(row.event_count),
    headSeq: row.head_seq == null ? null : Number(row.head_seq),
    closed: row.closed == null ? null : Number(row.closed) !== 0,
    updatedAt: String(row.updated_at),
  };
}

/**
 * Where each task's trace can be read.
 *
 * A trace lives on the daemon that ran the task. The row only says which
 * runtime holds the file (`daemon`), that the task produced no events (`none`),
 * or that the file is gone with its daemon (`lost`). A `lost` row keeps its
 * `runtime_id`: usage accounting joins it to attribute the task.
 */
export class TaskTracesRepo {
  constructor(
    private readonly ctx: StoreContext,
    private readonly query: TaskTraceQuery = (sql, params) =>
      this.ctx.db.query(sql).get(...params) as Row | null,
  ) {}

  get(taskId: string): MultiremiTaskTrace | null {
    const row = this.query("SELECT * FROM multiremi_task_traces WHERE task_id = ?", [taskId]);
    return row ? hydrate(row) : null;
  }

  /** A claim transfers a still-hot trace to the runtime that accepted the task. */
  markDaemon(taskId: string, runtimeId: string): void {
    this.ctx.db.run(
      `INSERT INTO multiremi_task_traces (task_id, location, runtime_id, updated_at)
       VALUES (?, 'daemon', ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET
         location = 'daemon', runtime_id = excluded.runtime_id,
         updated_at = excluded.updated_at
       WHERE multiremi_task_traces.location IN ('daemon', 'none')`,
      [taskId, runtimeId, nowIso()],
    );
  }

  /** Only an explicitly empty terminal trace may replace a daemon pointer. */
  markNone(taskId: string): void {
    this.ctx.db.run(
      `INSERT INTO multiremi_task_traces (task_id, location, updated_at)
       VALUES (?, 'none', ?)
       ON CONFLICT(task_id) DO UPDATE SET
         location = 'none', runtime_id = NULL, updated_at = excluded.updated_at
       WHERE multiremi_task_traces.location = 'daemon'`,
      [taskId, nowIso()],
    );
  }

  /** The trace file is unrecoverable; the pointer keeps its runtime for usage accounting. */
  markLost(taskId: string): void {
    this.ctx.db.run(
      `UPDATE multiremi_task_traces SET location = 'lost', updated_at = ?
       WHERE task_id = ? AND location = 'daemon'`,
      [nowIso(), taskId],
    );
  }

  /** A legacy Runtime merged into its successor: the same machine still holds the files. */
  moveToRuntime(fromRuntimeId: string, toRuntimeId: string): void {
    this.ctx.db.run(
      "UPDATE multiremi_task_traces SET runtime_id = ?, updated_at = ? WHERE runtime_id = ?",
      [toRuntimeId, nowIso(), fromRuntimeId],
    );
  }

  /** Daemon retirement and Runtime deletion: every trace the runtimes held is gone. */
  markLostForRuntimes(runtimeIds: readonly string[]): number {
    if (!runtimeIds.length) return 0;
    return this.ctx.db.run(
      `UPDATE multiremi_task_traces SET location = 'lost', updated_at = ?
       WHERE location = 'daemon' AND runtime_id IN (${runtimeIds.map(() => "?").join(",")})`,
      [nowIso(), ...runtimeIds],
    ).changes;
  }
}
