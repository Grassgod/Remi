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
  /** Largest event seq in the member, from the archive index. */
  headSeq: number;
  /** Whether the trace was sealed with a trailer. */
  closed: boolean;
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
    headSeq: row.head_seq == null ? null : Number(row.head_seq),
    closed: row.closed == null ? null : Number(row.closed) !== 0,
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
   * Upsert archive pointers for one ingest, under the ruling's swap rule.
   *
   * A pointer is replaced only when it is not already backed by an archive, or
   * when the incoming member is at least as complete as the one it replaces
   * (`head >= old head_seq`). A stale or partial archive therefore never
   * downgrades a pointer, even though its own row still goes `ready`.
   *
   * Must be called inside the caller's transaction: the archive goes `ready`
   * only together with its pointers.
   */
  writeArchivePointers(pointers: readonly TaskTraceArchivePointer[]): number {
    const now = nowIso();
    let written = 0;
    for (const pointer of pointers) {
      const current = this.ctx.db.query(
        "SELECT location, head_seq FROM multiremi_task_traces WHERE task_id = ?",
      ).get(pointer.taskId) as { location?: unknown; head_seq?: unknown } | null;
      if (current && !this.shouldReplacePointer(String(current.location ?? ""), current.head_seq, pointer)) {
        continue;
      }
      this.ctx.db.run(
        `INSERT INTO multiremi_task_traces (
           task_id, location, runtime_id, archive_id, member_path,
           data_offset, compressed_size, uncompressed_size, sha256,
           event_count, head_seq, closed, updated_at
         ) VALUES (?, 'archive', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
           head_seq = excluded.head_seq,
           closed = excluded.closed,
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
          pointer.headSeq,
          pointer.closed ? 1 : 0,
          now,
        ],
      );
      written++;
    }
    return written;
  }

  /**
   * Whether an incoming archive member may take over an existing pointer.
   *
   * A hot or backfilling trace has no archive bytes yet, so any archive wins. An
   * existing archive pointer is only replaced by a member that reaches at least
   * as far: archives can be partial (a daemon that hot-started mid-life, or a
   * backfill that had not caught up), and a read that silently jumped backwards
   * would lose events.
   */
  private shouldReplacePointer(
    location: string,
    currentHeadSeq: unknown,
    incoming: TaskTraceArchivePointer,
  ): boolean {
    if (location !== "archive") return true;
    const currentHead = currentHeadSeq == null ? null : Number(currentHeadSeq);
    if (currentHead == null || !Number.isSafeInteger(currentHead)) return true;
    return incoming.headSeq >= currentHead;
  }

  /** Drop pointers bound to an archive that is no longer readable. */
  clearArchivePointers(archiveId: string): number {
    return this.ctx.db.run(
      "DELETE FROM multiremi_task_traces WHERE archive_id = ?",
      [archiveId],
    ).changes;
  }
}
