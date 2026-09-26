import type { MultiremiTaskTrace, MultiremiTaskTraceLocation } from "@multiremi/contracts/session-archive.js";
import { nowIso } from "@multiremi/ids.js";
import type { StoreContext } from "@multiremi/store/context.js";

type Row = Record<string, unknown>;

/** One archive member that carries a task trace. */
export interface TaskTraceArchivePointer {
  taskId: string;
  archiveId: string;
  memberPath: string;
  dataOffset: number;
  compressedSize: number;
  uncompressedSize: number;
  sha256: string;
  eventCount: number | null;
  runtimeId: string;
}

function hydrate(row: Row): MultiremiTaskTrace {
  return {
    taskId: String(row.task_id),
    location: String(row.location) as MultiremiTaskTraceLocation,
    runtimeId: row.runtime_id == null ? null : String(row.runtime_id),
    archiveId: row.archive_id == null ? null : String(row.archive_id),
    memberPath: row.member_path == null ? null : String(row.member_path),
    dataOffset: row.data_offset == null ? null : Number(row.data_offset),
    compressedSize: row.compressed_size == null ? null : Number(row.compressed_size),
    uncompressedSize: row.uncompressed_size == null ? null : Number(row.uncompressed_size),
    sha256: row.sha256 == null ? null : String(row.sha256),
    eventCount: row.event_count == null ? null : Number(row.event_count),
    updatedAt: String(row.updated_at),
  };
}

/**
 * Where each task's trace can be read.
 *
 * An archive ingest writes `archive` pointers for every trace member in the
 * same transaction that marks the archive `ready`, so a reader never sees a
 * ready archive whose pointers are missing. A newer ready archive overwrites
 * older pointers, matching the "one owner at a time" rule.
 */
export class TaskTracesRepo {
  constructor(private readonly ctx: StoreContext) {}

  get(taskId: string): MultiremiTaskTrace | null {
    const row = this.ctx.db.query(
      "SELECT * FROM multiremi_task_traces WHERE task_id = ?",
    ).get(taskId) as Row | null;
    return row ? hydrate(row) : null;
  }

  listForArchive(archiveId: string): MultiremiTaskTrace[] {
    return (this.ctx.db.query(
      "SELECT * FROM multiremi_task_traces WHERE archive_id = ? ORDER BY task_id ASC",
    ).all(archiveId) as Row[]).map(hydrate);
  }

  /**
   * Upsert archive pointers for one ingest.
   *
   * Must be called inside the caller's transaction: the archive goes `ready`
   * only together with its pointers.
   */
  writeArchivePointers(pointers: readonly TaskTraceArchivePointer[]): number {
    const now = nowIso();
    let written = 0;
    for (const pointer of pointers) {
      this.ctx.db.run(
        `INSERT INTO multiremi_task_traces (
           task_id, location, runtime_id, archive_id, member_path,
           data_offset, compressed_size, uncompressed_size, sha256, event_count, updated_at
         ) VALUES (?, 'archive', ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           location = excluded.location,
           runtime_id = excluded.runtime_id,
           archive_id = excluded.archive_id,
           member_path = excluded.member_path,
           data_offset = excluded.data_offset,
           compressed_size = excluded.compressed_size,
           uncompressed_size = excluded.uncompressed_size,
           sha256 = excluded.sha256,
           event_count = excluded.event_count,
           updated_at = excluded.updated_at`,
        [
          pointer.taskId,
          pointer.runtimeId,
          pointer.archiveId,
          pointer.memberPath,
          pointer.dataOffset,
          pointer.compressedSize,
          pointer.uncompressedSize,
          pointer.sha256,
          pointer.eventCount,
          now,
        ],
      );
      written++;
    }
    return written;
  }

  /** Drop pointers bound to an archive that is no longer readable. */
  clearArchivePointers(archiveId: string): number {
    return this.ctx.db.run(
      "DELETE FROM multiremi_task_traces WHERE archive_id = ?",
      [archiveId],
    ).changes;
  }
}
