import type {
  InitSessionArchiveInput,
  MultiremiSessionArchive,
  MultiremiSessionArchiveStatus,
  MultiremiSessionArchiveSubjectKind,
  ReportSessionArchiveFailureInput,
} from "@multiremi/contracts/types.js";
import { MULTIREMI_SESSION_ARCHIVE_PREPARATION_FAILURE_REVISION } from "@multiremi/contracts/types.js";
import { SESSION_ARCHIVE_FORMAT_V2 } from "@multiremi/contracts/session-archive.js";
import { nowIso } from "@multiremi/ids.js";
import {
  isSessionArchiveRetryExhausted,
  nextSessionArchiveRetryAt,
  resolveSessionArchiveRetryPolicy,
  resolveSessionArchiveUploadStallMs,
  type SessionArchiveRetryPolicy,
} from "@multiremi/session-archive/retry-policy.js";
import type { StoreContext } from "@multiremi/store/context.js";
import type {
  TaskTraceArchivePointer,
  TaskTracePointerRejection,
} from "@multiremi/store/repos/task-traces-repo.js";

type Row = Record<string, unknown>;

const PREPARATION_FAILURE_SHA256 = "0".repeat(64);

export class SessionArchiveTraceOwnershipError extends Error {
  constructor(taskId: string) {
    super(`trace task ${taskId} does not belong to this archive subject and Runtime`);
    this.name = "SessionArchiveTraceOwnershipError";
  }
}

/**
 * A daemon member was refused by something other than a longer daemon archive
 * or a `lost` pointer. The per-source swap rule lets a daemon member replace a
 * `trace_backfill` archive unconditionally, so this means the rule itself was
 * bypassed; the completion is rolled back instead of leaving the backfill's
 * prefix in front of the daemon's trace.
 */
export class SessionArchivePointerInvariantError extends Error {
  constructor(readonly rejections: readonly TaskTracePointerRejection[]) {
    super(`daemon trace pointers refused by the swap rule: ${rejections
      .map((rejection) => `${rejection.taskId} (${rejection.reason}, current ${rejection.currentLocation}`
        + `${rejection.currentSource ? `/${rejection.currentSource}` : ""})`)
      .join(", ")}`);
    this.name = "SessionArchivePointerInvariantError";
  }
}

/** The subject of a trace backfill can no longer take an archive. */
export class TraceBackfillSubjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TraceBackfillSubjectError";
  }
}

/** A `trace_backfill` archive row, published `ready` by the MUL-432 backfill. */
export interface TraceBackfillArchiveInput {
  id: string;
  runtimeId: string;
  daemonId: string;
  sourceRevision: string;
  sha256: string;
  sizeBytes: number;
  fileCount: number;
  relativePath: string;
  metadata: Record<string, unknown>;
}

export interface TraceBackfillCommitInput {
  workspaceId: string;
  subjectKind: MultiremiSessionArchiveSubjectKind;
  subjectId: string;
  /** Null when every task of the subject only receives a `none` pointer. */
  archive: TraceBackfillArchiveInput | null;
  pointers: readonly TaskTraceArchivePointer[];
  noneTaskIds: readonly string[];
}

export interface TraceBackfillCommitResult {
  archive: MultiremiSessionArchive | null;
  /** Pointers the swap rule accepted; a daemon archive keeps its own. */
  pointerCount: number;
  /** Every member the swap rule refused, with the pointer it kept. */
  rejectedPointers: TaskTracePointerRejection[];
}

/** A daemon upload that went `ready`; refused members stay on their pointer. */
export interface TracePointerCompletionResult {
  archive: MultiremiSessionArchive;
  pointerCount: number;
  rejectedPointers: TaskTracePointerRejection[];
}

function parseMetadata(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function hydrate(row: Row): MultiremiSessionArchive {
  const issueId = row.issue_id == null ? null : String(row.issue_id);
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    // Rows migrated from v1 have no subject columns until the backfill runs;
    // an Issue archive is the only thing they could have been.
    subjectKind: (row.subject_kind == null
      ? "issue"
      : String(row.subject_kind)) as MultiremiSessionArchiveSubjectKind,
    subjectId: row.subject_id == null ? String(issueId ?? "") : String(row.subject_id),
    format: row.format == null ? SESSION_ARCHIVE_FORMAT_V2 : String(row.format),
    issueId,
    runtimeId: String(row.runtime_id),
    daemonId: String(row.daemon_id),
    sourceRevision: String(row.source_revision),
    sha256: String(row.sha256),
    sizeBytes: Number(row.size_bytes),
    uploadedSizeBytes: Number(row.uploaded_size_bytes ?? 0),
    fileCount: row.file_count == null ? null : Number(row.file_count),
    status: String(row.status) as MultiremiSessionArchiveStatus,
    relativePath: String(row.relative_path),
    metadata: parseMetadata(row.metadata),
    attemptCount: Number(row.attempt_count ?? 0),
    retryBudgetBaseAttempt: Number(row.retry_budget_base_attempt ?? 0),
    lastError: row.last_error == null ? null : String(row.last_error),
    nextRetryAt: row.next_retry_at == null ? null : String(row.next_retry_at),
    retryExhaustedAt: row.retry_exhausted_at == null ? null : String(row.retry_exhausted_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at),
  };
}

export interface SessionArchiveStatusSnapshot {
  latest: MultiremiSessionArchive | null;
  latestReady: MultiremiSessionArchive | null;
  requestedReady: MultiremiSessionArchive | null;
  gcReady: boolean;
}

export interface SessionArchiveWorkspaceUsage {
  totalArchives: number;
  readyArchives: number;
  failedArchives: number;
  pendingArchives: number;
  exhaustedArchives: number;
  totalBytes: number;
  lastFailure: {
    archiveId: string;
    issueId: string;
    error: string;
    updatedAt: string;
  } | null;
}

export class SessionArchivesRepo {
  constructor(private readonly ctx: StoreContext) {}

  get(id: string): MultiremiSessionArchive | null {
    const row = this.ctx.db.query(
      "SELECT * FROM multiremi_session_archives WHERE id = ?",
    ).get(id) as Row | null;
    return row ? hydrate(row) : null;
  }

  list(issueId: string): MultiremiSessionArchive[] {
    return this.listSubject("issue", issueId);
  }

  listSubject(kind: MultiremiSessionArchiveSubjectKind, subjectId: string): MultiremiSessionArchive[] {
    return (this.ctx.db.query(
      `SELECT * FROM multiremi_session_archives
       WHERE subject_kind = ? AND subject_id = ?
       ORDER BY updated_at DESC, id DESC`,
    ).all(kind, subjectId) as Row[]).map(hydrate);
  }

  reportFailure(
    input: ReportSessionArchiveFailureInput,
    id: string,
    relativePath: string,
  ): { archive: MultiremiSessionArchive; created: boolean } | null {
    return this.withWritableSubjectArchive(input, () => {
      const now = nowIso();
      const policy = resolveSessionArchiveRetryPolicy();
      const issueId = input.subjectKind === "issue" ? input.subjectId : null;
      const metadata = JSON.stringify({
        kind: "preparation_failure",
        stage: input.stage,
        source: input.subjectKind === "issue" ? ".runtime" : ".runtime",
      });
      this.ctx.db.run(
        `INSERT INTO multiremi_session_archives (
           id, workspace_id, issue_id, subject_kind, subject_id, format,
           runtime_id, daemon_id, source_revision, sha256, size_bytes,
           uploaded_size_bytes, file_count, status, relative_path, metadata,
           attempt_count, last_error, next_retry_at, retry_exhausted_at,
           created_at, updated_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, 'failed', ?, ?, 1, ?, NULL, NULL, ?, ?, NULL)
         ON CONFLICT(subject_kind, subject_id, source_revision, sha256) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           runtime_id = excluded.runtime_id,
           daemon_id = excluded.daemon_id,
           status = 'failed',
           uploaded_size_bytes = 0,
           file_count = NULL,
           metadata = excluded.metadata,
           attempt_count = multiremi_session_archives.attempt_count + 1,
           last_error = excluded.last_error,
           updated_at = excluded.updated_at,
           completed_at = NULL
         WHERE multiremi_session_archives.retry_exhausted_at IS NULL`,
        [
          id,
          input.workspaceId,
          issueId,
          input.subjectKind,
          input.subjectId,
          SESSION_ARCHIVE_FORMAT_V2,
          input.runtimeId,
          input.daemonId,
          MULTIREMI_SESSION_ARCHIVE_PREPARATION_FAILURE_REVISION,
          PREPARATION_FAILURE_SHA256,
          relativePath,
          metadata,
          input.error.slice(0, 2_000),
          now,
          now,
        ],
      );
      const row = this.ctx.db.query(
        `SELECT * FROM multiremi_session_archives
         WHERE subject_kind = ? AND subject_id = ? AND source_revision = ? AND sha256 = ?`,
      ).get(
        input.subjectKind,
        input.subjectId,
        MULTIREMI_SESSION_ARCHIVE_PREPARATION_FAILURE_REVISION,
        PREPARATION_FAILURE_SHA256,
      ) as Row | null;
      if (!row) throw new Error("session archive failure report was not persisted");
      let archive = hydrate(row);
      if (!archive.retryExhaustedAt) {
        const exhausted = isSessionArchiveRetryExhausted(archive.attemptCount, policy, archive.retryBudgetBaseAttempt);
        this.ctx.db.run(
          `UPDATE multiremi_session_archives
           SET next_retry_at = ?, retry_exhausted_at = ?
           WHERE id = ?`,
          [
            nextSessionArchiveRetryAt(archive.id, archive.attemptCount, policy, new Date(now), archive.retryBudgetBaseAttempt),
            exhausted ? now : null,
            archive.id,
          ],
        );
        archive = this.get(archive.id)!;
      }
      return { archive, created: archive.id === id };
    });
  }

  workspaceUsage(workspaceId: string): SessionArchiveWorkspaceUsage {
    // Deliberately converge stalled uploads on this low-frequency Settings read.
    this.normalizeStalledUploads(workspaceId);
    const totals = this.ctx.db.query(
      `SELECT
         COUNT(*) AS total_archives,
         SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready_archives,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_archives,
         SUM(CASE WHEN status IN ('pending', 'uploading') THEN 1 ELSE 0 END) AS pending_archives,
         SUM(CASE WHEN retry_exhausted_at IS NOT NULL THEN 1 ELSE 0 END) AS exhausted_archives,
         SUM(CASE WHEN status = 'ready' THEN uploaded_size_bytes ELSE 0 END) AS total_bytes
       FROM multiremi_session_archives
       WHERE workspace_id = ? AND status <> 'superseded'`,
    ).get(workspaceId) as Row | null;
    const failure = this.ctx.db.query(
      `SELECT id, issue_id, last_error, updated_at
       FROM multiremi_session_archives
       WHERE workspace_id = ? AND status = 'failed'
       ORDER BY updated_at DESC, id DESC
       LIMIT 1`,
    ).get(workspaceId) as Row | null;
    return {
      totalArchives: Number(totals?.total_archives ?? 0),
      readyArchives: Number(totals?.ready_archives ?? 0),
      failedArchives: Number(totals?.failed_archives ?? 0),
      pendingArchives: Number(totals?.pending_archives ?? 0),
      exhaustedArchives: Number(totals?.exhausted_archives ?? 0),
      totalBytes: Number(totals?.total_bytes ?? 0),
      lastFailure: failure
        ? {
          archiveId: String(failure.id),
          issueId: String(failure.issue_id),
          error: String(failure.last_error ?? "archive failed"),
          updatedAt: String(failure.updated_at),
        }
        : null,
    };
  }

  status(
    issueId: string,
    sourceRevision?: string | null,
    sha256?: string | null,
  ): SessionArchiveStatusSnapshot {
    return this.subjectStatus("issue", issueId, sourceRevision, sha256);
  }

  subjectStatus(
    kind: MultiremiSessionArchiveSubjectKind,
    subjectId: string,
    sourceRevision?: string | null,
    sha256?: string | null,
  ): SessionArchiveStatusSnapshot {
    const archives = this.listSubject(kind, subjectId);
    const latest = archives[0] ?? null;
    const latestReady = archives.find((item) => item.status === "ready") ?? null;
    const requestedReady = sourceRevision && sha256
      ? archives.find((item) =>
        item.sourceRevision === sourceRevision
        && item.sha256 === sha256
        && item.status === "ready"
      ) ?? null
      : null;
    return {
      latest,
      latestReady,
      requestedReady,
      // GC callers must identify the exact local snapshot. Merely having an
      // older ready archive is not sufficient to destroy the workspace.
      gcReady: Boolean(sourceRevision && sha256 && requestedReady),
    };
  }

  init(input: InitSessionArchiveInput, id: string, relativePath: string): {
    archive: MultiremiSessionArchive;
    created: boolean;
  } | null {
    return this.withWritableSubjectArchive(input, () => {
      const issueId = input.subjectKind === "issue" ? input.subjectId : null;
      const format = input.format ?? SESSION_ARCHIVE_FORMAT_V2;
      const existing = this.ctx.db.query(
        `SELECT * FROM multiremi_session_archives
         WHERE subject_kind = ? AND subject_id = ? AND source_revision = ? AND sha256 = ?`,
      ).get(input.subjectKind, input.subjectId, input.sourceRevision, input.sha256) as Row | null;
      if (existing) {
        const archive = hydrate(existing);
        this.deletePreparationFailure(input.subjectKind, input.subjectId);
        // A ready immutable object is global to the subject and can satisfy GC
        // on any later Runtime. An incomplete upload, however, must be
        // adoptable when the subject moves to another Runtime after a machine
        // failure.
        if (
          archive.status !== "ready"
          && archive.status !== "superseded"
          && (archive.runtimeId !== input.runtimeId || archive.daemonId !== input.daemonId)
        ) {
          this.ctx.db.run(
            `UPDATE multiremi_session_archives
             SET runtime_id = ?, daemon_id = ?, status = 'pending',
                 uploaded_size_bytes = 0, last_error = NULL,
                 updated_at = ?, completed_at = NULL
             WHERE id = ? AND status IN ('pending', 'uploading', 'failed')`,
            [input.runtimeId, input.daemonId, nowIso(), archive.id],
          );
          return { archive: this.get(archive.id)!, created: false };
        }
        return { archive, created: false };
      }

      const now = nowIso();
      this.deletePreparationFailure(input.subjectKind, input.subjectId);
      // Only one incomplete snapshot is actionable for a subject. A user may
      // click Retry and the source can change before the next daemon sweep;
      // supersede that stale request when the current digest is initialized
      // instead of leaving it pending forever.
      this.ctx.db.run(
        `UPDATE multiremi_session_archives
         SET status = 'superseded', next_retry_at = NULL,
             retry_exhausted_at = NULL, updated_at = ?
         WHERE subject_kind = ? AND subject_id = ?
           AND status IN ('pending', 'uploading', 'failed')`,
        [now, input.subjectKind, input.subjectId],
      );
      // A digest that is no longer current still stays `ready`: it is a
      // complete snapshot and can satisfy the GC barrier for the exact content
      // it captured. Future snapshots simply add another ready row.
      this.ctx.db.run(
        `INSERT INTO multiremi_session_archives (
           id, workspace_id, issue_id, subject_kind, subject_id, format,
           runtime_id, daemon_id, source_revision, sha256, size_bytes,
           uploaded_size_bytes, file_count, status, relative_path, metadata,
           attempt_count, last_error, created_at, updated_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'pending', ?, ?, 0, NULL, ?, ?, NULL)
         ON CONFLICT(subject_kind, subject_id, source_revision, sha256) DO NOTHING`,
        [
          id,
          input.workspaceId,
          issueId,
          input.subjectKind,
          input.subjectId,
          format,
          input.runtimeId,
          input.daemonId,
          input.sourceRevision,
          input.sha256,
          input.sizeBytes,
          input.fileCount ?? null,
          relativePath,
          JSON.stringify(input.metadata ?? {}),
          now,
          now,
        ],
      );
      const archive = this.ctx.db.query(
        `SELECT * FROM multiremi_session_archives
         WHERE subject_kind = ? AND subject_id = ? AND source_revision = ? AND sha256 = ?`,
      ).get(input.subjectKind, input.subjectId, input.sourceRevision, input.sha256) as Row | null;
      if (!archive) throw new Error("session archive initialization failed");
      return { archive: hydrate(archive), created: String(archive.id) === id };
    });
  }

  /** Remove the placeholder row that records a failed preparation attempt. */
  private deletePreparationFailure(subjectKind: MultiremiSessionArchiveSubjectKind, subjectId: string): void {
    this.ctx.db.run(
      `DELETE FROM multiremi_session_archives
       WHERE subject_kind = ? AND subject_id = ? AND source_revision = ? AND sha256 = ?`,
      [subjectKind, subjectId, MULTIREMI_SESSION_ARCHIVE_PREPARATION_FAILURE_REVISION, PREPARATION_FAILURE_SHA256],
    );
  }

  claimUploadAttempt(id: string, runtimeId: string): MultiremiSessionArchive | null {
    return this.withWritableArchive(id, runtimeId, () => {
      const nowDate = new Date();
      const now = nowDate.toISOString();
      const policy = resolveSessionArchiveRetryPolicy();
      const stallMs = resolveSessionArchiveUploadStallMs();
      let current = this.get(id);
      if (!current || current.retryExhaustedAt) return null;
      if (
        current.status !== "pending"
        && current.status !== "uploading"
        && current.status !== "failed"
      ) return null;
      if (
        current.status === "uploading"
        && Date.parse(current.updatedAt) <= nowDate.getTime() - stallMs
      ) {
        current = this.markStalledUpload(current, nowDate, stallMs, policy);
      }
      if (!current || current.retryExhaustedAt) return null;
      if (isSessionArchiveRetryExhausted(current.attemptCount, policy, current.retryBudgetBaseAttempt)) {
        this.ctx.db.run(
          `UPDATE multiremi_session_archives
           SET status = 'failed', last_error = COALESCE(last_error, 'retry budget exhausted'),
               retry_exhausted_at = ?, updated_at = ?, completed_at = NULL
           WHERE id = ? AND runtime_id = ? AND retry_exhausted_at IS NULL
             AND status IN ('pending', 'uploading', 'failed')`,
          [now, now, id, runtimeId],
        );
        return null;
      }
      if (current.nextRetryAt && current.nextRetryAt > now) return null;
      const nextAttemptCount = current.attemptCount + 1;
      const nextRetryAt = nextSessionArchiveRetryAt(id, nextAttemptCount, policy, nowDate, current.retryBudgetBaseAttempt);
      const result = this.ctx.db.run(
        `UPDATE multiremi_session_archives
         SET status = 'pending', uploaded_size_bytes = 0,
             attempt_count = attempt_count + 1, last_error = NULL,
             next_retry_at = ?, retry_exhausted_at = NULL,
             updated_at = ?, completed_at = NULL
         WHERE id = ? AND runtime_id = ? AND attempt_count = ?
           AND status IN ('pending', 'failed')
           AND retry_exhausted_at IS NULL
           AND (next_retry_at IS NULL OR next_retry_at <= ?)`,
        [nextRetryAt, now, id, runtimeId, current.attemptCount, now],
      );
      if (result.changes !== 1) return null;
      const archive = this.get(id);
      return archive?.runtimeId === runtimeId && archive.status === "pending" ? archive : null;
    });
  }

  beginUploadAttempt(id: string, runtimeId: string, attemptCount: number): MultiremiSessionArchive | null {
    return this.withWritableArchive(id, runtimeId, () => {
      const result = this.ctx.db.run(
        `UPDATE multiremi_session_archives
         SET status = 'uploading', uploaded_size_bytes = 0, last_error = NULL,
             updated_at = ?, completed_at = NULL
         WHERE id = ? AND runtime_id = ? AND attempt_count = ? AND status = 'pending'`,
        [nowIso(), id, runtimeId, attemptCount],
      );
      if (result.changes !== 1) return null;
      const archive = this.get(id);
      return archive?.runtimeId === runtimeId
        && archive.attemptCount === attemptCount
        && archive.status === "uploading"
        ? archive
        : null;
    });
  }

  markUploadedAttempt(
    id: string,
    runtimeId: string,
    attemptCount: number,
    uploadedSizeBytes: number,
  ): MultiremiSessionArchive | null {
    return this.withWritableArchive(id, runtimeId, () => {
      const result = this.ctx.db.run(
        `UPDATE multiremi_session_archives
         SET uploaded_size_bytes = ?, updated_at = ?
         WHERE id = ? AND runtime_id = ? AND attempt_count = ? AND status = 'uploading'`,
        [uploadedSizeBytes, nowIso(), id, runtimeId, attemptCount],
      );
      if (result.changes !== 1) return null;
      const archive = this.get(id);
      return archive?.runtimeId === runtimeId
        && archive.attemptCount === attemptCount
        && archive.status === "uploading"
        ? archive
        : null;
    });
  }

  markReadyAttempt(
    id: string,
    runtimeId: string,
    attemptCount: number,
    uploadedSizeBytes: number,
  ): MultiremiSessionArchive | null {
    return this.withWritableArchive(id, runtimeId, () => {
      const now = nowIso();
      const result = this.ctx.db.run(
        `UPDATE multiremi_session_archives
         SET status = 'ready', uploaded_size_bytes = ?, last_error = NULL,
             next_retry_at = NULL, retry_exhausted_at = NULL,
             updated_at = ?, completed_at = ?
         WHERE id = ? AND runtime_id = ? AND attempt_count = ? AND status = 'uploading'`,
        [uploadedSizeBytes, now, now, id, runtimeId, attemptCount],
      );
      if (result.changes !== 1) return null;
      const archive = this.get(id);
      return archive?.runtimeId === runtimeId
        && archive.attemptCount === attemptCount
        && archive.status === "ready"
        ? archive
        : null;
    });
  }

  /**
   * Mark the archive `ready` and write its task trace pointers atomically.
   *
   * Both statements share one transaction on purpose: a reader must never find
   * a `ready` archive whose pointer table is missing, and a pointer must never
   * outlive the archive that backs it. The archive row is the transaction's
   * guard, so a superseded attempt writes neither half.
   *
   * A member refused by a longer daemon archive or a `lost` pointer leaves the
   * archive `ready` and comes back in `rejectedPointers`. A refusal by a
   * `trace_backfill` archive (or any other state) cannot happen under the swap
   * rule, so it throws {@link SessionArchivePointerInvariantError} and rolls the
   * whole completion back.
   */
  completeWithTracePointers(
    id: string,
    runtimeId: string,
    attemptCount: number,
    uploadedSizeBytes: number,
    pointers: readonly TaskTraceArchivePointer[],
  ): TracePointerCompletionResult | null {
    return this.withWritableArchive(id, runtimeId, () => {
      const now = nowIso();
      const result = this.ctx.db.run(
        `UPDATE multiremi_session_archives
         SET status = 'ready', uploaded_size_bytes = ?, last_error = NULL,
             next_retry_at = NULL, retry_exhausted_at = NULL,
             updated_at = ?, completed_at = ?
         WHERE id = ? AND runtime_id = ? AND attempt_count = ? AND status = 'uploading'`,
        [uploadedSizeBytes, now, now, id, runtimeId, attemptCount],
      );
      if (result.changes !== 1) return null;
      const archive = this.get(id);
      if (
        !archive
        || archive.runtimeId !== runtimeId
        || archive.attemptCount !== attemptCount
        || archive.status !== "ready"
      ) return null;
      for (const pointer of pointers) {
        const task = this.ctx.db.query(
          `SELECT task.workspace_id, task.runtime_id, task.issue_id, task.chat_session_id,
                  task_runtime.daemon_id AS task_daemon_id,
                  archive_runtime.daemon_id AS archive_daemon_id,
                  task_runtime.id AS task_runtime_exists,
                  archive_runtime.id AS archive_runtime_exists
           FROM multiremi_tasks task
           LEFT JOIN multiremi_runtimes task_runtime ON task_runtime.id = task.runtime_id
           LEFT JOIN multiremi_runtimes archive_runtime ON archive_runtime.id = ?
           WHERE task.id = ?`,
        ).get(archive.runtimeId, pointer.taskId) as Row | null;
        const belongs = archive.subjectKind === "issue"
          ? task?.issue_id === archive.subjectId
          : archive.subjectKind === "chat"
            ? task?.chat_session_id === archive.subjectId
            : pointer.taskId === archive.subjectId
              && task?.issue_id == null && task?.chat_session_id == null;
        const sameDaemon = Boolean(String(task?.task_daemon_id ?? "").trim()
          && String(task?.archive_daemon_id ?? "").trim()
          && task?.task_daemon_id === task?.archive_daemon_id);
        if (!task || !belongs || task.workspace_id !== archive.workspaceId
          || !task.task_runtime_exists || !task.archive_runtime_exists
          || (task.runtime_id !== archive.runtimeId && !sameDaemon)) {
          throw new SessionArchiveTraceOwnershipError(pointer.taskId);
        }
      }
      const written = this.ctx.taskTraces().writeTaskTraceArchivePointers(pointers, "daemon");
      const violations = written.rejected.filter((rejection) =>
        rejection.reason !== "newer_head_same_source" && rejection.reason !== "lost");
      if (violations.length > 0) throw new SessionArchivePointerInvariantError(violations);
      return { archive, pointerCount: written.written, rejectedPointers: written.rejected };
    });
  }

  /**
   * Publish one subject's `trace_backfill` archive and its task pointers.
   *
   * The backfill is not an upload: no Runtime owns the attempt, so the row is
   * inserted `ready` directly instead of walking pending → uploading. What stays
   * the same as {@link completeWithTracePointers} is the pairing — the row, the
   * pointers (through the one swap-rule implementation) and the `none`
   * pointers land in the caller's transaction or not at all. Every task must
   * still belong to the subject and its workspace; an Issue must be active.
   */
  commitTraceBackfill(input: TraceBackfillCommitInput): TraceBackfillCommitResult {
    return this.ctx.db.transaction(() => {
      this.ctx.lockWorkspaceRuntimeLifecycle(input.workspaceId);
      this.assertTraceBackfillSubject(input);
      const taskIds = [...input.pointers.map((pointer) => pointer.taskId), ...input.noneTaskIds];
      for (const taskId of taskIds) this.assertTraceBackfillTask(input, taskId);
      let archive: MultiremiSessionArchive | null = null;
      if (input.archive) {
        for (const pointer of input.pointers) {
          if (pointer.archiveId !== input.archive.id || pointer.runtimeId !== input.archive.runtimeId) {
            throw new SessionArchiveTraceOwnershipError(pointer.taskId);
          }
        }
        archive = this.insertTraceBackfillArchive(input, input.archive);
      } else if (input.pointers.length > 0) {
        throw new TraceBackfillSubjectError("trace pointers need an archive");
      }
      const written = this.ctx.taskTraces().writeTaskTraceArchivePointers(input.pointers, "trace_backfill");
      for (const taskId of input.noneTaskIds) this.ctx.taskTraces().markTaskTraceNone(taskId);
      return { archive, pointerCount: written.written, rejectedPointers: written.rejected };
    })();
  }

  private assertTraceBackfillSubject(input: TraceBackfillCommitInput): void {
    if (input.subjectKind === "issue") {
      this.ctx.lockIssueArchiveLifecycle(input.subjectId);
      const issue = this.ctx.db.query(
        "SELECT workspace_id, lifecycle_state FROM multiremi_issues WHERE id = ?",
      ).get(input.subjectId) as Row | null;
      if (
        !issue
        || String(issue.workspace_id ?? "local") !== input.workspaceId
        || String(issue.lifecycle_state ?? "active") !== "active"
      ) throw new TraceBackfillSubjectError(`Issue ${input.subjectId} is not an active Issue of this workspace`);
      return;
    }
    const table = input.subjectKind === "chat" ? "multiremi_chat_sessions" : "multiremi_tasks";
    const row = this.ctx.db.query(`SELECT workspace_id FROM ${table} WHERE id = ?`)
      .get(input.subjectId) as Row | null;
    if (!row || String(row.workspace_id ?? "local") !== input.workspaceId) {
      throw new TraceBackfillSubjectError(`${input.subjectKind} ${input.subjectId} is not in this workspace`);
    }
  }

  /**
   * The grouping the backfill uses: an Issue owns all of its tasks, a Chat
   * Session the tasks that name it, and any other task is its own subject —
   * including a task whose Chat Session no longer exists.
   */
  private assertTraceBackfillTask(input: TraceBackfillCommitInput, taskId: string): void {
    const task = this.ctx.db.query(
      `SELECT task.workspace_id, task.issue_id, task.chat_session_id, chat.id AS chat_exists
       FROM multiremi_tasks task
       LEFT JOIN multiremi_chat_sessions chat ON chat.id = task.chat_session_id
       WHERE task.id = ?`,
    ).get(taskId) as Row | null;
    const belongs = input.subjectKind === "issue"
      ? task?.issue_id === input.subjectId
      : input.subjectKind === "chat"
        ? task?.issue_id == null && task?.chat_session_id === input.subjectId
        : taskId === input.subjectId && task?.issue_id == null
          && (task?.chat_session_id == null || task?.chat_exists == null);
    if (!task || !belongs || String(task.workspace_id ?? "local") !== input.workspaceId) {
      throw new SessionArchiveTraceOwnershipError(taskId);
    }
  }

  private insertTraceBackfillArchive(
    input: TraceBackfillCommitInput,
    archive: TraceBackfillArchiveInput,
  ): MultiremiSessionArchive {
    const existing = this.ctx.db.query(
      `SELECT * FROM multiremi_session_archives
       WHERE subject_kind = ? AND subject_id = ? AND source_revision = ? AND sha256 = ?`,
    ).get(input.subjectKind, input.subjectId, archive.sourceRevision, archive.sha256) as Row | null;
    if (existing) {
      // Identical bytes from an earlier run: only that run's own ready row may
      // be reused. A daemon upload with the same key is left alone.
      const current = hydrate(existing);
      if (current.id !== archive.id || current.status !== "ready" || current.metadata.kind !== "trace_backfill") {
        throw new TraceBackfillSubjectError(`archive ${current.id} already holds this content`);
      }
      return current;
    }
    const now = nowIso();
    this.ctx.db.run(
      `INSERT INTO multiremi_session_archives (
         id, workspace_id, issue_id, subject_kind, subject_id, format,
         runtime_id, daemon_id, source_revision, sha256, size_bytes,
         uploaded_size_bytes, file_count, status, relative_path, metadata,
         attempt_count, last_error, created_at, updated_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, 1, NULL, ?, ?, ?)`,
      [
        archive.id,
        input.workspaceId,
        input.subjectKind === "issue" ? input.subjectId : null,
        input.subjectKind,
        input.subjectId,
        SESSION_ARCHIVE_FORMAT_V2,
        archive.runtimeId,
        archive.daemonId,
        archive.sourceRevision,
        archive.sha256,
        archive.sizeBytes,
        archive.sizeBytes,
        archive.fileCount,
        archive.relativePath,
        JSON.stringify(archive.metadata),
        now,
        now,
        now,
      ],
    );
    const inserted = this.get(archive.id);
    if (!inserted) throw new Error("trace backfill archive was not persisted");
    return inserted;
  }

  markFailedAttempt(
    id: string,
    runtimeId: string,
    attemptCount: number,
    error: string,
  ): MultiremiSessionArchive | null {
    return this.withWritableArchive(id, runtimeId, () => {
      const nowDate = new Date();
      const now = nowDate.toISOString();
      const policy = resolveSessionArchiveRetryPolicy();
      const current = this.get(id);
      const base = current?.retryBudgetBaseAttempt ?? 0;
      const exhausted = isSessionArchiveRetryExhausted(attemptCount, policy, base);
      const result = this.ctx.db.run(
        `UPDATE multiremi_session_archives
         SET status = 'failed', last_error = ?, next_retry_at = ?,
             retry_exhausted_at = ?, updated_at = ?, completed_at = NULL
         WHERE id = ? AND runtime_id = ? AND attempt_count = ? AND status IN ('pending', 'uploading')`,
        [
          error.slice(0, 2_000),
          nextSessionArchiveRetryAt(id, attemptCount, policy, nowDate, base),
          exhausted ? now : null,
          now,
          id,
          runtimeId,
          attemptCount,
        ],
      );
      return result.changes === 1 ? this.get(id) : null;
    });
  }

  markFailed(id: string, error: string): MultiremiSessionArchive | null {
    const current = this.get(id);
    if (!current) return null;
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const policy = resolveSessionArchiveRetryPolicy();
    const exhausted = isSessionArchiveRetryExhausted(current.attemptCount, policy, current.retryBudgetBaseAttempt);
    this.ctx.db.run(
      `UPDATE multiremi_session_archives
       SET status = 'failed', last_error = ?, next_retry_at = ?,
           retry_exhausted_at = ?, updated_at = ?, completed_at = NULL
       WHERE id = ? AND status <> 'superseded'`,
      [
        error.slice(0, 2_000),
        nextSessionArchiveRetryAt(id, current.attemptCount, policy, nowDate, current.retryBudgetBaseAttempt),
        exhausted ? now : null,
        now,
        id,
      ],
    );
    return this.get(id);
  }

  markVerificationFailedAttempt(
    id: string,
    attemptCount: number,
    error: string,
  ): MultiremiSessionArchive | null {
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const policy = resolveSessionArchiveRetryPolicy();
    const current = this.get(id);
    const base = current?.retryBudgetBaseAttempt ?? 0;
    const exhausted = isSessionArchiveRetryExhausted(attemptCount, policy, base);
    const result = this.ctx.db.run(
      `UPDATE multiremi_session_archives
       SET status = 'failed', last_error = ?, next_retry_at = ?,
           retry_exhausted_at = ?, updated_at = ?, completed_at = NULL
       WHERE id = ? AND attempt_count = ? AND status = 'ready'`,
      [
        error.slice(0, 2_000),
        nextSessionArchiveRetryAt(id, attemptCount, policy, nowDate, base),
        exhausted ? now : null,
        now,
        id,
        attemptCount,
      ],
    );
    return result.changes === 1 ? this.get(id) : null;
  }

  retry(id: string): MultiremiSessionArchive | null {
    const current = this.get(id);
    if (!current || (current.status !== "failed" && !current.retryExhaustedAt)) return null;
    return this.withWritableArchive(id, current.runtimeId, () => {
      this.ctx.db.run(
        `UPDATE multiremi_session_archives
         SET status = 'pending', uploaded_size_bytes = 0,
             retry_budget_base_attempt = attempt_count,
             last_error = NULL, next_retry_at = NULL, retry_exhausted_at = NULL,
             updated_at = ?, completed_at = NULL
         WHERE id = ? AND (status = 'failed' OR retry_exhausted_at IS NOT NULL)`,
        [nowIso(), id],
      );
      return this.get(id);
    });
  }

  touchWritableArchive(id: string, runtimeId: string): MultiremiSessionArchive | null {
    return this.withWritableArchive(id, runtimeId, (archive) => archive);
  }

  /** Serialize shared ZIP/manifest mutations with claim and retry, even after workspace ownership changes. */
  withLockedSharedPaths<T>(
    id: string,
    runtimeId: string,
    attemptCount: number,
    mode: "promote" | "cleanup",
    action: (archive: MultiremiSessionArchive) => T,
  ): T | null {
    const initial = this.get(id);
    if (!initial) return null;
    return this.ctx.db.transaction(() => {
      this.ctx.lockWorkspaceRuntimeLifecycle(initial.workspaceId);
      if (initial.subjectKind === "issue") this.ctx.lockIssueArchiveLifecycle(initial.issueId ?? initial.subjectId);
      this.ctx.db.run("UPDATE multiremi_session_archives SET updated_at = updated_at WHERE id = ?", [id]);
      const current = this.get(id);
      if (!current || current.attemptCount !== attemptCount || current.runtimeId !== runtimeId
        || (mode === "promote" ? current.status !== "uploading" : current.status !== "failed")) return null;
      return action(current);
    })();
  }

  private normalizeStalledUploads(workspaceId: string): void {
    const nowDate = new Date();
    const stallMs = resolveSessionArchiveUploadStallMs();
    const stallBefore = new Date(nowDate.getTime() - stallMs).toISOString();
    const rows = this.ctx.db.query(
      `SELECT * FROM multiremi_session_archives
       WHERE workspace_id = ? AND status = 'uploading' AND updated_at <= ?`,
    ).all(workspaceId, stallBefore) as Row[];
    const policy = resolveSessionArchiveRetryPolicy();
    for (const row of rows) this.markStalledUpload(hydrate(row), nowDate, stallMs, policy);
  }

  private markStalledUpload(
    archive: MultiremiSessionArchive,
    nowDate: Date,
    stallMs: number,
    policy: SessionArchiveRetryPolicy,
  ): MultiremiSessionArchive | null {
    const now = nowDate.toISOString();
    const exhausted = isSessionArchiveRetryExhausted(archive.attemptCount, policy, archive.retryBudgetBaseAttempt);
    const result = this.ctx.db.run(
      `UPDATE multiremi_session_archives
       SET status = 'failed', last_error = ?, next_retry_at = ?,
           retry_exhausted_at = ?, updated_at = ?, completed_at = NULL
       WHERE id = ? AND runtime_id = ? AND attempt_count = ?
         AND status = 'uploading' AND updated_at = ?`,
      [
        `upload stalled after ${stallMs}ms`,
        nextSessionArchiveRetryAt(archive.id, archive.attemptCount, policy, nowDate, archive.retryBudgetBaseAttempt),
        exhausted ? now : null,
        now,
        archive.id,
        archive.runtimeId,
        archive.attemptCount,
        archive.updatedAt,
      ],
    );
    return this.get(archive.id);
  }

  private withWritableArchive<T>(
    id: string,
    runtimeId: string,
    action: (archive: MultiremiSessionArchive) => T,
  ): T | null {
    const initial = this.get(id);
    if (!initial || initial.runtimeId !== runtimeId) return null;
    return this.withWritableSubjectArchive(
      {
        workspaceId: initial.workspaceId,
        subjectKind: initial.subjectKind,
        subjectId: initial.subjectId,
        issueId: initial.issueId,
        runtimeId,
      },
      () => {
        const current = this.get(id);
        return current?.runtimeId === runtimeId ? action(current) : null;
      },
    );
  }

  /**
   * Serialize one write against the subject's lifecycle fence.
   *
   * Issue subjects keep the historical fenced path: the Runtime must still own
   * the Issue workspace and the workspace must not be cleaned. Chat and
   * one-shot Task subjects have no Issue to fence on, so the Runtime that
   * currently owns the subject's provider session must match instead.
   */
  private withWritableSubjectArchive<T>(
    input: {
      workspaceId: string;
      subjectKind: MultiremiSessionArchiveSubjectKind;
      subjectId: string;
      issueId?: string | null;
      runtimeId: string;
    },
    action: () => T,
  ): T | null {
    return this.ctx.db.transaction(() => {
      this.ctx.lockWorkspaceRuntimeLifecycle(input.workspaceId);
      if (input.subjectKind === "issue") {
        const issueId = input.issueId ?? input.subjectId;
        this.ctx.lockIssueArchiveLifecycle(issueId);
        const row = this.ctx.db.query(
          `SELECT i.workspace_id, i.lifecycle_state,
                  iw.status AS workspace_status, iw.runtime_id AS workspace_runtime_id
           FROM multiremi_issues i
           LEFT JOIN multiremi_issue_workspaces iw ON iw.issue_id = i.id
           WHERE i.id = ?`,
        ).get(issueId) as Row | null;
        if (
          !row
          || String(row.workspace_id ?? "local") !== input.workspaceId
          || String(row.lifecycle_state ?? "active") !== "active"
          || String(row.workspace_runtime_id ?? "") !== input.runtimeId
          || String(row.workspace_status ?? "") === "cleaned"
        ) return null;
        return action();
      }
      return this.ownsSubjectRuntime(input) ? action() : null;
    })();
  }

  /** True when `runtimeId` currently owns the Chat Session or Task. */
  private ownsSubjectRuntime(input: {
    workspaceId: string;
    subjectKind: MultiremiSessionArchiveSubjectKind;
    subjectId: string;
    runtimeId: string;
  }): boolean {
    if (input.subjectKind === "chat") {
      const session = this.ctx.db.query(
        "SELECT workspace_id, session_runtime_id FROM multiremi_chat_sessions WHERE id = ?",
      ).get(input.subjectId) as Row | null;
      if (!session) return false;
      return String(session.workspace_id ?? "local") === input.workspaceId
        && String(session.session_runtime_id ?? "") === input.runtimeId;
    }
    const task = this.ctx.db.query(
      "SELECT workspace_id, runtime_id FROM multiremi_tasks WHERE id = ?",
    ).get(input.subjectId) as Row | null;
    if (!task) return false;
    return String(task.workspace_id ?? "local") === input.workspaceId
      && String(task.runtime_id ?? "") === input.runtimeId;
  }
}
