import type {
  InitSessionArchiveInput,
  MultiremiSessionArchive,
  MultiremiSessionArchiveStatus,
  ReportSessionArchiveFailureInput,
} from "@multiremi/contracts/types.js";
import { MULTIREMI_SESSION_ARCHIVE_PREPARATION_FAILURE_REVISION } from "@multiremi/contracts/types.js";
import { nowIso } from "@multiremi/ids.js";
import {
  isSessionArchiveRetryExhausted,
  nextSessionArchiveRetryAt,
  resolveSessionArchiveRetryPolicy,
  resolveSessionArchiveUploadStallMs,
  type SessionArchiveRetryPolicy,
} from "@multiremi/session-archive/retry-policy.js";
import type { StoreContext } from "@multiremi/store/context.js";

type Row = Record<string, unknown>;

const PREPARATION_FAILURE_SHA256 = "0".repeat(64);

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
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    issueId: String(row.issue_id),
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
    return (this.ctx.db.query(
      `SELECT * FROM multiremi_session_archives
       WHERE issue_id = ?
       ORDER BY updated_at DESC, id DESC`,
    ).all(issueId) as Row[]).map(hydrate);
  }

  reportFailure(
    input: ReportSessionArchiveFailureInput,
    id: string,
    relativePath: string,
  ): { archive: MultiremiSessionArchive; created: boolean } | null {
    return this.withWritableIssueArchive(input.workspaceId, input.issueId, input.runtimeId, () => {
      const now = nowIso();
      const policy = resolveSessionArchiveRetryPolicy();
      const metadata = JSON.stringify({
        kind: "preparation_failure",
        stage: input.stage,
        source: ".multiremi/sessions",
      });
      this.ctx.db.run(
        `INSERT INTO multiremi_session_archives (
           id, workspace_id, issue_id, runtime_id, daemon_id,
           source_revision, sha256, size_bytes, uploaded_size_bytes,
           file_count, status, relative_path, metadata, attempt_count,
           last_error, next_retry_at, retry_exhausted_at,
           created_at, updated_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, 'failed', ?, ?, 1, ?, NULL, NULL, ?, ?, NULL)
         ON CONFLICT(issue_id, source_revision, sha256) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           runtime_id = excluded.runtime_id,
           daemon_id = excluded.daemon_id,
           status = 'failed',
           uploaded_size_bytes = 0,
           file_count = NULL,
           metadata = excluded.metadata,
           attempt_count = attempt_count + 1,
           last_error = excluded.last_error,
           updated_at = excluded.updated_at,
           completed_at = NULL
         WHERE retry_exhausted_at IS NULL`,
        [
          id,
          input.workspaceId,
          input.issueId,
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
         WHERE issue_id = ? AND source_revision = ? AND sha256 = ?`,
      ).get(
        input.issueId,
        MULTIREMI_SESSION_ARCHIVE_PREPARATION_FAILURE_REVISION,
        PREPARATION_FAILURE_SHA256,
      ) as Row | null;
      if (!row) throw new Error("session archive failure report was not persisted");
      let archive = hydrate(row);
      if (!archive.retryExhaustedAt) {
        const exhausted = isSessionArchiveRetryExhausted(archive.attemptCount, policy);
        this.ctx.db.run(
          `UPDATE multiremi_session_archives
           SET next_retry_at = ?, retry_exhausted_at = ?
           WHERE id = ?`,
          [
            nextSessionArchiveRetryAt(archive.id, archive.attemptCount, policy, new Date(now)),
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
    const archives = this.list(issueId);
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
    return this.withWritableIssueArchive(input.workspaceId, input.issueId, input.runtimeId, () => {
      const existing = this.ctx.db.query(
        `SELECT * FROM multiremi_session_archives
         WHERE issue_id = ? AND source_revision = ? AND sha256 = ?`,
      ).get(input.issueId, input.sourceRevision, input.sha256) as Row | null;
      if (existing) {
        const archive = hydrate(existing);
        this.ctx.db.run(
          `DELETE FROM multiremi_session_archives
           WHERE issue_id = ? AND source_revision = ? AND sha256 = ?`,
          [
            input.issueId,
            MULTIREMI_SESSION_ARCHIVE_PREPARATION_FAILURE_REVISION,
            PREPARATION_FAILURE_SHA256,
          ],
        );
        // A ready immutable object is global to the Issue and can satisfy GC on
        // any later Runtime. An incomplete upload, however, must be adoptable
        // when an Issue moves to another Runtime after a machine failure.
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
      this.ctx.db.run(
        `DELETE FROM multiremi_session_archives
         WHERE issue_id = ? AND source_revision = ? AND sha256 = ?`,
        [
          input.issueId,
          MULTIREMI_SESSION_ARCHIVE_PREPARATION_FAILURE_REVISION,
          PREPARATION_FAILURE_SHA256,
        ],
      );
      // Only one incomplete snapshot is actionable for an Issue. A user may
      // click Retry and the native session history can change before the next
      // daemon sweep; supersede that stale request when the current digest is
      // initialized instead of leaving it pending forever.
      this.ctx.db.run(
        `UPDATE multiremi_session_archives
         SET status = 'superseded', next_retry_at = NULL,
             retry_exhausted_at = NULL, updated_at = ?
         WHERE issue_id = ? AND (source_revision <> ? OR sha256 <> ?)
           AND status IN ('pending', 'uploading', 'failed')`,
        [now, input.issueId, input.sourceRevision, input.sha256],
      );
      // A changed digest for the same source revision represents a replacement,
      // not a second valid GC barrier.
      this.ctx.db.run(
        `UPDATE multiremi_session_archives
         SET status = 'superseded', next_retry_at = NULL,
             retry_exhausted_at = NULL, updated_at = ?
         WHERE issue_id = ? AND source_revision = ?
           AND sha256 <> ? AND status IN ('pending', 'uploading', 'ready', 'failed')`,
        [now, input.issueId, input.sourceRevision, input.sha256],
      );
      this.ctx.db.run(
        `INSERT INTO multiremi_session_archives (
           id, workspace_id, issue_id, runtime_id, daemon_id,
           source_revision, sha256, size_bytes, uploaded_size_bytes,
           file_count, status, relative_path, metadata, attempt_count,
           last_error, created_at, updated_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'pending', ?, ?, 0, NULL, ?, ?, NULL)
         ON CONFLICT(issue_id, source_revision, sha256) DO NOTHING`,
        [
          id,
          input.workspaceId,
          input.issueId,
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
         WHERE issue_id = ? AND source_revision = ? AND sha256 = ?`,
      ).get(input.issueId, input.sourceRevision, input.sha256) as Row | null;
      if (!archive) throw new Error("session archive initialization failed");
      return { archive: hydrate(archive), created: String(archive.id) === id };
    });
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
      if (isSessionArchiveRetryExhausted(current.attemptCount, policy)) {
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
      const nextRetryAt = nextSessionArchiveRetryAt(id, nextAttemptCount, policy, nowDate);
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
      const exhausted = isSessionArchiveRetryExhausted(attemptCount, policy);
      const result = this.ctx.db.run(
        `UPDATE multiremi_session_archives
         SET status = 'failed', last_error = ?, next_retry_at = ?,
             retry_exhausted_at = ?, updated_at = ?, completed_at = NULL
         WHERE id = ? AND runtime_id = ? AND attempt_count = ? AND status IN ('pending', 'uploading')`,
        [
          error.slice(0, 2_000),
          nextSessionArchiveRetryAt(id, attemptCount, policy, nowDate),
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
    const exhausted = isSessionArchiveRetryExhausted(current.attemptCount, policy);
    this.ctx.db.run(
      `UPDATE multiremi_session_archives
       SET status = 'failed', last_error = ?, next_retry_at = ?,
           retry_exhausted_at = ?, updated_at = ?, completed_at = NULL
       WHERE id = ? AND status <> 'superseded'`,
      [
        error.slice(0, 2_000),
        nextSessionArchiveRetryAt(id, current.attemptCount, policy, nowDate),
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
    const exhausted = isSessionArchiveRetryExhausted(attemptCount, policy);
    const result = this.ctx.db.run(
      `UPDATE multiremi_session_archives
       SET status = 'failed', last_error = ?, next_retry_at = ?,
           retry_exhausted_at = ?, updated_at = ?, completed_at = NULL
       WHERE id = ? AND attempt_count = ? AND status = 'ready'`,
      [
        error.slice(0, 2_000),
        nextSessionArchiveRetryAt(id, attemptCount, policy, nowDate),
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
         SET status = 'pending', uploaded_size_bytes = 0, attempt_count = 0,
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
    const exhausted = isSessionArchiveRetryExhausted(archive.attemptCount, policy);
    const result = this.ctx.db.run(
      `UPDATE multiremi_session_archives
       SET status = 'failed', last_error = ?, next_retry_at = ?,
           retry_exhausted_at = ?, updated_at = ?, completed_at = NULL
       WHERE id = ? AND runtime_id = ? AND attempt_count = ?
         AND status = 'uploading' AND updated_at = ?`,
      [
        `upload stalled after ${stallMs}ms`,
        nextSessionArchiveRetryAt(archive.id, archive.attemptCount, policy, nowDate),
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
    return this.withWritableIssueArchive(initial.workspaceId, initial.issueId, runtimeId, () => {
      const current = this.get(id);
      return current?.runtimeId === runtimeId ? action(current) : null;
    });
  }

  private withWritableIssueArchive<T>(
    workspaceId: string,
    issueId: string,
    runtimeId: string,
    action: () => T,
  ): T | null {
    return this.ctx.db.transaction(() => {
      this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
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
        || String(row.workspace_id ?? "local") !== workspaceId
        || String(row.lifecycle_state ?? "active") !== "active"
        || String(row.workspace_runtime_id ?? "") !== runtimeId
        || String(row.workspace_status ?? "") === "cleaned"
      ) return null;
      return action();
    })();
  }
}
