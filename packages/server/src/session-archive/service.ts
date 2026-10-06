import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  lstatSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  statfs,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { assertNotHomeDefaultInTest } from "@shared/home-paths.js";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type {
  InitSessionArchiveInput,
  MultiremiIssueWorkspaceArchiveBinding,
  MultiremiSessionArchive,
  MultiremiSessionArchiveSubjectKind,
} from "@multiremi/contracts/types.js";
import {
  SESSION_ARCHIVE_FORMAT_V2,
  SESSION_ARCHIVE_FORMAT_V1,
} from "@multiremi/contracts/session-archive.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import { createId } from "@multiremi/ids.js";
import { createLogger } from "@shared/logger.js";
import {
  SessionArchiveIngestError,
  verifyArchiveIngest,
  type ArchiveIngestVerification,
} from "@multiremi/session-archive/ingest.js";
import type { TaskTraceArchivePointer } from "@multiremi/store/repos/task-traces-repo.js";
import {
  SessionArchivePointerInvariantError,
  SessionArchiveTraceOwnershipError,
  TraceBackfillSubjectError,
  type TraceBackfillCommitResult,
  type NativeTraceRecoveryCommitResult,
} from "@multiremi/store/repos/session-archives-repo.js";
import type {
  TraceBackfillProgressInput,
  TraceBackfillTaskDigest,
  TraceBackfillTurnCardCounts,
  TraceBackfillTurnSummary,
} from "@multiremi/store/repos/trace-backfill-progress-repo.js";
import type { SessionArchiveMemberIndexEntry } from "@multiremi/contracts/session-archive.js";
import { checkTraceFileLines, type TraceFileHeader, type TraceFileTrailer } from "@multiremi/contracts/trace-file.js";
import { readZipMemberBody } from "@shared/zip/reader.js";
import {
  NativeTraceRecoveryError,
  nativeRecoveryEndedAt,
  nativeRecoveryMetadata,
  nativeRecoverySessionId,
  nativeRecoveryStartedAt,
  type NativeTraceRecoveryTask,
} from "@multiremi/session-archive/native-recovery.js";

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MIN_FREE_BYTES = 10 * 1024 * 1024 * 1024;
const UPLOAD_PROGRESS_HEARTBEAT_MS = 30_000;
const DEFAULT_ROOT = join(homedir(), ".remi", "multiremi", "session-archives");
const ISSUE_PURGE_OUTBOX = ".issue-purge-outbox";
const DEFAULT_PURGE_RECOVERY_INTERVAL_MS = 30_000;
const DEFAULT_ORPHAN_SWEEP_INTERVAL_MS = 10 * 60_000;
/** Synchronous filesystem work held under the shared-path lock longer than this is logged. */
const DEFAULT_LOCKED_FS_WARN_MS = 100;
/** Present in a backfill archive directory until its row is committed. */
const TRACE_BACKFILL_PENDING_MARKER = ".trace-backfill-pending";
const log = createLogger("session-archive");

interface IssueArchivePurgeReceipt {
  version: 1;
  issue_id: string;
  relative_paths: string[];
  created_at: string;
}

interface FileIdentity { dev: number; ino: number }

function sameFileIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

export interface SessionArchiveStorageConfig {
  root: string;
  maxBytes: number;
  minFreeBytes: number;
}

/** One subject of `scripts/backfill-task-traces.ts`, staged and verified. */
export interface TraceBackfillIngestInput {
  workspaceId: string;
  subject: SessionArchiveSubjectScope;
  /** Recorded on the row and the pointers; the backfill has no uploading Runtime. */
  runtimeId: string;
  daemonId: string;
  /** The staged zip from `prepareSessionArchive`. It is moved, not copied, into place. */
  archivePath: string;
  sourceRevision: string;
  sha256: string;
  sizeBytes: number;
  fileCount: number;
  /** Must carry `kind: "trace_backfill"`. */
  metadata: Record<string, unknown>;
  noneTaskIds: readonly string[];
  progress: TraceBackfillProgressInput;
  taskDigests: readonly TraceBackfillTaskDigest[];
  /** One per rendered and `none` task; written onto the tasks' `turn` cards. */
  turnSummaries: readonly TraceBackfillTurnSummary[];
}

type OperatorTraceArchiveInput = Pick<TraceBackfillIngestInput,
  "workspaceId" | "subject" | "runtimeId" | "daemonId" | "archivePath" | "sourceRevision" | "sha256" | "sizeBytes" | "fileCount" | "metadata">;

/** Local operator-only entry point; does not add a public HTTP/CLI capability. */
export interface NativeTraceRecoveryIngestInput extends Omit<OperatorTraceArchiveInput, "metadata"> {
  algorithmVersion: string;
  tasks: readonly NativeTraceRecoveryTask[];
}

export interface SessionArchiveVerifyResult {
  archive: MultiremiSessionArchive;
  valid: boolean;
  actualSha256: string | null;
  actualSizeBytes: number | null;
  error: string | null;
}

export class SessionArchiveError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "session_archive_error",
  ) {
    super(message);
    this.name = "SessionArchiveError";
  }
}

function parseByteLimit(value: string | undefined, fallback: number): number {
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function sessionArchiveStorageConfigFromEnv(explicitRoot?: string): SessionArchiveStorageConfig {
  const configuredRoot = explicitRoot ?? (process.env.MULTIREMI_SESSION_ARCHIVE_ROOT?.trim() || undefined);
  if (configuredRoot == null) {
    assertNotHomeDefaultInTest("MULTIREMI_SESSION_ARCHIVE_ROOT", "pass the archive root");
  }
  return {
    root: resolve(configuredRoot ?? DEFAULT_ROOT),
    maxBytes: parseByteLimit(process.env.MULTIREMI_SESSION_ARCHIVE_MAX_BYTES, DEFAULT_MAX_BYTES),
    minFreeBytes: parseByteLimit(
      process.env.MULTIREMI_SESSION_ARCHIVE_MIN_FREE_BYTES,
      DEFAULT_MIN_FREE_BYTES,
    ),
  };
}

function encodedSegment(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function archiveRelativePath(input: Pick<
  InitSessionArchiveInput,
  "workspaceId" | "subjectKind" | "subjectId"
> & { archiveId: string }): string {
  return join(
    "workspaces",
    encodedSegment(input.workspaceId),
    input.subjectKind === "issue" ? "issues" : "subjects",
    encodedSegment(input.subjectId),
    input.archiveId,
    "sessions.zip",
  );
}

/**
 * New uploads must be v2.
 *
 * This is checked before any attempt is claimed: during an upgrade window a v1
 * daemon would otherwise burn the whole retry budget re-uploading a container
 * this server no longer indexes. Existing v1 rows stay readable and stay
 * `ready` — the hard-delete barrier binds to them — so a request that names one
 * of those is served as before instead of being rejected.
 */
function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function isV2Format(format: string | undefined | null): boolean {
  return format === SESSION_ARCHIVE_FORMAT_V2;
}

/**
 * Which subject one upload request is about.
 *
 * A bare string is accepted as an Issue id so the long-standing Issue callers
 * (the daemon GC path and its tests) stay readable; every other subject passes
 * its kind explicitly.
 */
export type SessionArchiveScope = SessionArchiveSubjectScope | string;

export interface SessionArchiveSubjectScope {
  kind: MultiremiSessionArchiveSubjectKind;
  id: string;
}

/** Normalize the two accepted scope spellings into a subject. */
export function resolveSessionArchiveScope(scope: SessionArchiveScope): SessionArchiveSubjectScope {
  return typeof scope === "string" ? { kind: "issue", id: scope } : scope;
}

/**
 * Resolve an archive by subject and refuse a Runtime that does not own it.
 *
 * The subject check is what keeps a Chat or Task archive from being driven
 * through another subject's route: the id alone is not enough, since the same
 * text could name different things in different subject kinds.
 */
function assertArchiveScope(
  archive: MultiremiSessionArchive | null,
  runtimeId: string,
  scope: SessionArchiveScope,
): MultiremiSessionArchive {
  const subject = resolveSessionArchiveScope(scope);
  if (
    !archive
    || archive.runtimeId !== runtimeId
    || archive.subjectKind !== subject.kind
    || archive.subjectId !== subject.id
  ) {
    throw new SessionArchiveError("session archive not found", 404, "session_archive_not_found");
  }
  return archive;
}

async function hashFile(path: string, expectedSizeBytes: number): Promise<{ sha256: string; sizeBytes: number }> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new SessionArchiveError("archive is not a regular file", 409, "unsafe_archive_path");
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(128 * 1024);
    let sizeBytes = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      if (sizeBytes + bytesRead > expectedSizeBytes) {
        throw new SessionArchiveError(
          "archive is larger than its declared size",
          422,
          "session_archive_integrity_mismatch",
        );
      }
      digest.update(buffer.subarray(0, bytesRead));
      sizeBytes += bytesRead;
    }
    const after = await handle.stat();
    const pathAfter = await lstat(path);
    if (
      !after.isFile()
      || pathAfter.isSymbolicLink()
      || !pathAfter.isFile()
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || after.dev !== pathAfter.dev
      || after.ino !== pathAfter.ino
      || sizeBytes !== after.size
      || sizeBytes !== expectedSizeBytes
    ) {
      throw new SessionArchiveError("archive changed while it was being verified", 409, "unsafe_archive_path");
    }
    return { sha256: digest.digest("hex"), sizeBytes };
  } finally {
    await handle.close();
  }
}

/**
 * Turn verified trace members into pointer rows.
 *
 * `head`, `event_count` and `closed` come from the archive's own index, which
 * the writer derived while hashing each member. `head` is what the swap rule
 * compares, so it must be the largest seq rather than the event count.
 */
function buildTracePointers(
  archive: MultiremiSessionArchive,
  traces: readonly SessionArchiveMemberIndexEntry[],
): TaskTraceArchivePointer[] {
  return traces.map((member) => ({
    taskId: member.task_id ?? "",
    archiveId: archive.id,
    memberPath: member.path,
    dataOffset: member.data_offset,
    compressedSize: member.compressed_size,
    uncompressedSize: member.uncompressed_size,
    sha256: member.sha256,
    eventCount: member.event_count ?? null,
    headSeq: member.head ?? 0,
    closed: member.closed ?? false,
    runtimeId: archive.runtimeId,
  })).filter((pointer) => pointer.taskId.length > 0);
}

export class SessionArchiveService {
  readonly config: SessionArchiveStorageConfig;
  private completionAttempts = new Map<string, Promise<MultiremiSessionArchive>>();
  private purgeReceiptAttempts = new Map<string, Promise<number>>();
  private purgeRecoveryInFlight: Promise<number> | null = null;
  private purgeRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private purgeRecoveryStarted = false;
  private purgeRecoveryIntervalMs = DEFAULT_PURGE_RECOVERY_INTERVAL_MS;
  private orphanSweepInFlight: Promise<string[]> | null = null;
  private orphanSweepTimer: ReturnType<typeof setTimeout> | null = null;
  private orphanSweepStarted = false;
  private orphanSweepIntervalMs = DEFAULT_ORPHAN_SWEEP_INTERVAL_MS;
  private lockedFsWarnMs = DEFAULT_LOCKED_FS_WARN_MS;

  constructor(
    private readonly store: MultiremiStore,
    config: Partial<SessionArchiveStorageConfig> = {},
  ) {
    this.config = { ...sessionArchiveStorageConfigFromEnv(config.root), ...config };
  }

  rootHint(): string {
    return this.config.root === resolve(DEFAULT_ROOT)
      ? "~/.remi/multiremi/session-archives"
      : join("...", basename(this.config.root));
  }

  initialize(input: InitSessionArchiveInput): {
    archive: MultiremiSessionArchive;
    created: boolean;
  } {
    if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(input.subjectId)) {
      throw new SessionArchiveError("subject_id must be a plain identifier", 400, "session_archive_invalid_subject");
    }
    if (input.subjectKind === "issue" && !nonEmptyString(input.issueId ?? input.subjectId)) {
      throw new SessionArchiveError("Issue archives require an Issue id", 400, "session_archive_invalid_subject");
    }
    if (!input.sourceRevision.trim() || input.sourceRevision.length > 512) {
      throw new SessionArchiveError("source_revision must be between 1 and 512 characters");
    }
    if (!/^[a-f0-9]{64}$/i.test(input.sha256)) {
      throw new SessionArchiveError("sha256 must be a 64-character hexadecimal digest");
    }
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) {
      throw new SessionArchiveError("size_bytes must be a non-negative safe integer");
    }
    if (input.sizeBytes > this.config.maxBytes) {
      throw new SessionArchiveError(
        `archive exceeds configured maximum of ${this.config.maxBytes} bytes`,
        413,
        "session_archive_too_large",
      );
    }
    if (input.fileCount != null && (!Number.isSafeInteger(input.fileCount) || input.fileCount < 0)) {
      throw new SessionArchiveError("file_count must be a non-negative safe integer");
    }
    const metadata = input.metadata ?? {};
    if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > 64 * 1024) {
      throw new SessionArchiveError("metadata exceeds 65536 bytes", 413, "metadata_too_large");
    }
    // A request that names no format is a new upload and therefore v2. A
    // request that names one is held to it: `init` is the first call a daemon
    // makes, so refusing v1 here (rather than at complete) is what keeps an old
    // daemon from consuming the retry budget.
    const format = input.format ?? SESSION_ARCHIVE_FORMAT_V2;
    if (!isV2Format(format)) throw this.unsupportedFormat(format);
    const archiveId = createId("sar");
    try {
      return this.store.initSessionArchive(
        { ...input, format, sha256: input.sha256.toLowerCase(), metadata },
        archiveId,
        archiveRelativePath({ ...input, archiveId }),
      );
    } catch (error) {
      if (
        error instanceof Error
        && "code" in error
        && error.code === "issue_archive_lifecycle_closed"
      ) throw this.issueLifecycleClosed();
      throw error;
    }
  }

  /**
   * Fence any earlier PUT/complete before returning an upload URL.
   *
   * Claiming happens at init (rather than at PUT) so the attempt number can be
   * carried by both requests. A daemon restart therefore invalidates an
   * in-flight request before its replacement touches the filesystem.
   */
  async claimUploadAttempt(
    runtimeId: string,
    scope: SessionArchiveScope,
    archiveId: string,
  ): Promise<{ archive: MultiremiSessionArchive; uploadAttempt: number | null }> {
    let archive = assertArchiveScope(this.store.getSessionArchive(archiveId), runtimeId, scope);
    archive = this.requireWritableArchive(archive, runtimeId);
    if (archive.status === "ready") return { archive, uploadAttempt: null };
    // Refuse before touching the retry budget: an old daemon retrying a v1
    // container must not exhaust the attempts a v2 upload will need.
    if (!isV2Format(archive.format)) throw this.unsupportedFormat(archive.format);
    if (archive.status === "superseded") {
      throw new SessionArchiveError("session archive has been superseded", 409, "archive_superseded");
    }
    const claimed = this.store.claimSessionArchiveUploadAttempt(archive.id, runtimeId);
    if (!claimed) {
      archive = assertArchiveScope(this.store.getSessionArchive(archiveId), runtimeId, scope);
      if (archive.status === "ready") return { archive, uploadAttempt: null };
      if (archive.retryExhaustedAt) {
        await this.cleanupExhaustedPartials(archive);
        throw new SessionArchiveError(
          "session archive automatic retry budget is exhausted",
          409,
          "session_archive_retry_exhausted",
        );
      }
      if (archive.nextRetryAt && archive.nextRetryAt > new Date().toISOString()) {
        throw new SessionArchiveError(
          `session archive retry is deferred until ${archive.nextRetryAt}`,
          429,
          "session_archive_retry_backoff",
        );
      }
      throw new SessionArchiveError(
        "session archive upload attempt could not be claimed",
        409,
        "session_archive_attempt_conflict",
      );
    }
    archive = claimed;
    try {
      const finalPath = await this.resolveArchivePath(archive.relativePath, true);
      await this.cleanupPriorAttemptPartials(finalPath, archive.attemptCount);
    } catch (error) {
      const failed = this.store.markSessionArchiveFailedAttempt(
        archive.id,
        runtimeId,
        archive.attemptCount,
        error instanceof Error ? error.message : String(error),
      );
      await this.cleanupExhaustedPartials(failed);
      throw error;
    }
    return { archive, uploadAttempt: archive.attemptCount };
  }

  async upload(
    runtimeId: string,
    scope: SessionArchiveScope,
    archiveId: string,
    attemptCount: number,
    body: ReadableStream<Uint8Array> | null,
  ): Promise<MultiremiSessionArchive> {
    let archive = assertArchiveScope(this.store.getSessionArchive(archiveId), runtimeId, scope);
    archive = this.requireWritableArchive(archive, runtimeId);
    this.assertCurrentAttempt(archive, attemptCount);
    if (archive.status === "ready") return archive;
    if (archive.status === "superseded") {
      throw new SessionArchiveError("session archive has been superseded", 409, "archive_superseded");
    }
    if (!isV2Format(archive.format)) throw this.unsupportedFormat(archive.format);
    if (!body) throw new SessionArchiveError("archive body is required");

    const finalPath = await this.resolveArchivePath(archive.relativePath, true);
    await this.ensureCapacity(archive.sizeBytes);
    const started = this.store.beginSessionArchiveUploadAttempt(archive.id, runtimeId, attemptCount);
    if (!started) {
      throw new SessionArchiveError(
        "session archive upload is already in progress or no longer owned by this Runtime",
        409,
        "session_archive_attempt_conflict",
      );
    }
    archive = started;
    const partialPath = this.partialPath(finalPath, attemptCount);

    let handle: Awaited<ReturnType<typeof open>> | null = null;
    let uploaded = 0;
    let lastProgressAt = Date.now();
    try {
      const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0);
      handle = await open(partialPath, flags, 0o600);
      const reader = body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        uploaded += value.byteLength;
        if (uploaded > archive.sizeBytes || uploaded > this.config.maxBytes) {
          await reader.cancel("archive size exceeded");
          throw new SessionArchiveError(
            "uploaded archive is larger than declared size",
            413,
            "session_archive_too_large",
          );
        }
        let offset = 0;
        while (offset < value.byteLength) {
          const result = await handle.write(value, offset, value.byteLength - offset, null);
          offset += result.bytesWritten;
        }
        const progressAt = Date.now();
        if (progressAt - lastProgressAt >= UPLOAD_PROGRESS_HEARTBEAT_MS) {
          const heartbeat = this.store.markSessionArchiveUploadedAttempt(
            archive.id,
            runtimeId,
            attemptCount,
            uploaded,
          );
          if (!heartbeat) {
            await reader.cancel("archive upload attempt was superseded");
            throw new SessionArchiveError(
              "session archive upload attempt was superseded",
              409,
              "session_archive_attempt_conflict",
            );
          }
          archive = heartbeat;
          lastProgressAt = progressAt;
        }
      }
      await handle.sync();
      await handle.close();
      handle = null;
      if (uploaded !== archive.sizeBytes) {
        throw new SessionArchiveError(
          `uploaded archive size ${uploaded} does not match declared size ${archive.sizeBytes}`,
          422,
          "session_archive_size_mismatch",
        );
      }
      const uploadedArchive = this.store.markSessionArchiveUploadedAttempt(
        archive.id,
        runtimeId,
        attemptCount,
        uploaded,
      );
      if (!uploadedArchive) {
        throw new SessionArchiveError(
          "session archive upload attempt was superseded",
          409,
          "session_archive_attempt_conflict",
        );
      }
      return uploadedArchive;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(partialPath).catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      const failed = this.store.markSessionArchiveFailedAttempt(
        archive.id,
        runtimeId,
        attemptCount,
        message,
      );
      await this.cleanupExhaustedPartials(failed);
      throw error;
    }
  }

  preflightUpload(
    runtimeId: string,
    scope: SessionArchiveScope,
    archiveId: string,
    attemptCount: number,
  ): void {
    let archive = assertArchiveScope(this.store.getSessionArchive(archiveId), runtimeId, scope);
    archive = this.requireWritableArchive(archive, runtimeId);
    this.assertCurrentAttempt(archive, attemptCount);
    if (!isV2Format(archive.format) && archive.status !== "ready") {
      throw this.unsupportedFormat(archive.format);
    }
    if (archive.status !== "pending" && archive.status !== "uploading") {
      throw new SessionArchiveError(
        `cannot upload archive in ${archive.status} state`,
        409,
        "session_archive_invalid_state",
      );
    }
  }

  failUpload(
    runtimeId: string,
    scope: SessionArchiveScope,
    archiveId: string,
    attemptCount: number,
    error: string,
  ): MultiremiSessionArchive {
    let archive = assertArchiveScope(this.store.getSessionArchive(archiveId), runtimeId, scope);
    archive = this.requireWritableArchive(archive, runtimeId);
    this.assertCurrentAttempt(archive, attemptCount);
    if (archive.status === "failed") return archive;
    if (!isV2Format(archive.format)) throw this.unsupportedFormat(archive.format);
    if (archive.status !== "pending" && archive.status !== "uploading") {
      throw new SessionArchiveError(
        `cannot fail archive upload in ${archive.status} state`,
        409,
        "session_archive_invalid_state",
      );
    }
    const failed = this.store.markSessionArchiveFailedAttempt(
      archive.id,
      runtimeId,
      attemptCount,
      error,
    );
    if (!failed) {
      throw new SessionArchiveError(
        "session archive upload attempt was superseded",
        409,
        "session_archive_attempt_conflict",
      );
    }
    return failed;
  }

  async complete(
    runtimeId: string,
    scope: SessionArchiveScope,
    archiveId: string,
    attemptCount: number,
  ): Promise<MultiremiSessionArchive> {
    const subject = resolveSessionArchiveScope(scope);
    const key = JSON.stringify([runtimeId, subject.kind, subject.id, archiveId, attemptCount]);
    const existing = this.completionAttempts.get(key);
    if (existing) return await existing;
    const completion = this.completeAttempt(runtimeId, scope, archiveId, attemptCount);
    this.completionAttempts.set(key, completion);
    try {
      return await completion;
    } finally {
      if (this.completionAttempts.get(key) === completion) this.completionAttempts.delete(key);
    }
  }

  private async completeAttempt(
    runtimeId: string,
    scope: SessionArchiveScope,
    archiveId: string,
    attemptCount: number,
  ): Promise<MultiremiSessionArchive> {
    let archive = assertArchiveScope(this.store.getSessionArchive(archiveId), runtimeId, scope);
    archive = this.requireWritableArchive(archive, runtimeId);
    this.assertCurrentAttempt(archive, attemptCount);
    if (archive.status === "ready") return archive;
    if (archive.status !== "uploading") {
      throw new SessionArchiveError(
        `cannot complete archive in ${archive.status} state`,
        409,
        "session_archive_invalid_state",
      );
    }
    if (!isV2Format(archive.format)) throw this.unsupportedFormat(archive.format);
    const finalPath = await this.resolveArchivePath(archive.relativePath, false);
    const partialPath = this.partialPath(finalPath, attemptCount);
    let promotedFile: FileIdentity | null = null;
    let manifestTempPath: string | null = null;
    try {
      // Validate the attempt-owned partial before publishing it at the shared
      // final path. A rejected member must never leave a final archive behind.
      const ingestPath = await lstat(partialPath).then(() => partialPath, (error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return finalPath;
        throw error;
      });
      this.assertArchiveHash(await hashFile(ingestPath, archive.sizeBytes), archive);
      const ingest = await this.validateArchiveIngest(ingestPath, archive);
      for (const trace of ingest.traces) {
        const taskId = trace.task_id;
        if (!taskId) throw new SessionArchiveTraceOwnershipError(trace.path);
        const task = this.store.getTask(taskId);
        const belongs = archive.subjectKind === "issue"
          ? task?.issueId === archive.subjectId
          : archive.subjectKind === "chat"
            ? task?.chatSessionId === archive.subjectId
            : taskId === archive.subjectId
              && task?.issueId == null && task?.chatSessionId == null;
        const taskRuntime = task?.runtimeId ? this.store.getRuntime(task.runtimeId) : null;
        const archiveRuntime = this.store.getRuntime(archive.runtimeId);
        const sameDaemon = Boolean(nonEmptyString(taskRuntime?.daemonId) && nonEmptyString(archiveRuntime?.daemonId)
          && taskRuntime.daemonId === archiveRuntime.daemonId);
        if (!task || !belongs || task.workspaceId !== archive.workspaceId
          || !taskRuntime || !archiveRuntime
          || (task.runtimeId !== archive.runtimeId && !sameDaemon)) {
          throw new SessionArchiveTraceOwnershipError(taskId);
        }
      }
      const stillOwned = this.store.getSessionArchive(archive.id);
      if (stillOwned?.attemptCount !== attemptCount || stillOwned.status !== "uploading"
        || stillOwned.runtimeId !== runtimeId) {
        throw new SessionArchiveError(
          "session archive completion attempt was superseded", 409, "session_archive_attempt_conflict",
        );
      }
      // Publish only after the blob, every member and every trace owner pass.
      const promotion = await this.preparePromotion(partialPath, finalPath, archive);
      // 2. Derive pointers and durably write the manifest temp file outside the lock.
      const pointers = buildTracePointers(archive, ingest.traces);
      manifestTempPath = await this.writeManifest(finalPath, archive, promotion.sizeBytes);
      const published = this.withTimedSharedPaths(
        archive.id, runtimeId, attemptCount, "promote", () => {
          const partial = this.fileIdentitySync(partialPath);
          const existing = this.fileIdentitySync(finalPath);
          const reuse = existing && promotion.verifiedFinal
            && sameFileIdentity(existing, promotion.verifiedFinal);
          if (reuse) {
            if (partial && promotion.partial && sameFileIdentity(partial, promotion.partial)) unlinkSync(partialPath);
          } else if (partial && promotion.partial && sameFileIdentity(partial, promotion.partial)) {
            renameSync(partialPath, finalPath);
            promotedFile = partial;
          } else {
            throw new SessionArchiveError("archive upload attempt changed", 409, "session_archive_attempt_conflict");
          }
          renameSync(manifestTempPath!, join(dirname(finalPath), "manifest.json"));
          manifestTempPath = null;
          return true;
        },
      );
      if (!published) throw new SessionArchiveError(
        "session archive completion attempt was superseded", 409, "session_archive_attempt_conflict",
      );
      await this.syncDirectory(dirname(finalPath));
      // 3. `ready` and the pointers land together; a reader can never see one
      //    without the other.
      const completed = this.store.completeSessionArchiveWithTracePointers(
        archive.id,
        runtimeId,
        attemptCount,
        promotion.sizeBytes,
        pointers,
      );
      if (!completed) {
        const current = this.store.getSessionArchive(archive.id);
        if (
          current?.status === "ready"
          && current.runtimeId === runtimeId
          && current.attemptCount === attemptCount
          && current.sha256 === archive.sha256
          && current.sizeBytes === archive.sizeBytes
        ) return current;
        throw new SessionArchiveError(
          "session archive completion attempt was superseded",
          409,
          "session_archive_attempt_conflict",
        );
      }
      if (completed.rejectedPointers.length > 0) {
        // The archive is ready; these members keep the pointer they already had
        // (a longer archive of the same source, or `lost`).
        log.warn(`Session archive ${archive.id} is ready; ${completed.rejectedPointers.length} trace pointer(s) kept`, {
          archiveId: archive.id,
          rejectedPointers: completed.rejectedPointers.map((rejection) => ({
            taskId: rejection.taskId,
            reason: rejection.reason,
            incomingHeadSeq: rejection.incomingHeadSeq,
            currentLocation: rejection.currentLocation,
            currentSource: rejection.currentSource,
            currentArchiveId: rejection.currentArchiveId,
            currentHeadSeq: rejection.currentHeadSeq,
          })),
        });
      }
      return completed.archive;
    } catch (error) {
      const current = this.store.getSessionArchive(archive.id);
      if (
        current?.status === "ready"
        && current.runtimeId === runtimeId
        && current.attemptCount === attemptCount
        && current.sha256 === archive.sha256
        && current.sizeBytes === archive.sizeBytes
      ) return current;
      const message = error instanceof Error ? error.message : String(error);
      const failed = this.store.markSessionArchiveFailedAttempt(
        archive.id,
        runtimeId,
        attemptCount,
        message,
      );
      try {
        await this.cleanupFailedPromotion(finalPath, archive, attemptCount, promotedFile);
      } catch (cleanupError) {
        log.warn(`Failed to clean Session archive shared paths for ${archive.id}: ${String(cleanupError)}`);
      }
      if (manifestTempPath) await unlink(manifestTempPath).catch((cleanupError) => {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT")
          log.warn(`Failed to clean Session archive manifest temp for ${archive.id}: ${String(cleanupError)}`);
      });
      if (failed) await unlink(partialPath).catch((cleanupError) => {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT")
          log.warn(`Failed to clean Session archive partial for ${archive.id}: ${String(cleanupError)}`);
      });
      await this.cleanupExhaustedPartials(failed).catch((cleanupError) => {
        log.warn(`Failed to clean exhausted Session archive partials for ${archive.id}: ${String(cleanupError)}`);
      });
      if (error instanceof SessionArchiveTraceOwnershipError) {
        throw new SessionArchiveError(error.message, 422, "session_archive_trace_ownership_mismatch");
      }
      if (error instanceof SessionArchivePointerInvariantError) {
        log.error(`Session archive ${archive.id} rolled back: ${error.message}`, {
          archiveId: archive.id,
          rejectedPointers: error.rejections,
        });
      }
      throw error;
    }
  }

  /**
   * Parse the central directory and cross-check `index.json` member by member.
   *
   * Every offset, size and digest in the index must match the container, and
   * trace members are hashed from their bytes. Failure is terminal for the
   * attempt: it throws, and the caller marks the row `failed` with the reason.
   */
  private async validateArchiveIngest(
    finalPath: string,
    archive: MultiremiSessionArchive,
  ): Promise<ArchiveIngestVerification> {
    const handle = await open(finalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile()) {
        throw new SessionArchiveError("archive is not a regular file", 409, "unsafe_archive_path");
      }
      const verification = await verifyArchiveIngest(handle);
      if (
        verification.index.subject.kind !== archive.subjectKind
        || verification.index.subject.id !== archive.subjectId
      ) {
        throw new SessionArchiveIngestError(
          `archive subject mismatch: index ${verification.index.subject.kind}:${verification.index.subject.id}, `
          + `expected ${archive.subjectKind}:${archive.subjectId}`,
        );
      }
      // The row was created with a declared revision before any bytes existed.
      // Recompute it from the manifest the daemon actually wrote: a mismatch
      // means the uploaded content is not the snapshot the control plane
      // agreed to, and the GC barrier must never accept it.
      if (verification.sourceRevision !== archive.sourceRevision) {
        throw new SessionArchiveIngestError(
          `archive content revision mismatch: manifest digest ${verification.sourceRevision}, `
          + `declared ${archive.sourceRevision}`,
        );
      }
      return verification;
    } catch (error) {
      if (error instanceof SessionArchiveIngestError) {
        throw new SessionArchiveError(error.message, 422, error.code);
      }
      throw error;
    } finally {
      await handle.close().catch(() => {});
    }
  }

  private async preparePromotion(
    partialPath: string,
    finalPath: string,
    archive: MultiremiSessionArchive,
  ): Promise<{ sizeBytes: number; partial: FileIdentity | null; verifiedFinal: FileIdentity | null }> {
    let partialIdentity: FileIdentity | null = null;
    try {
      const partialStat = await lstat(partialPath);
      if (!partialStat.isFile() || partialStat.isSymbolicLink()) {
        throw new SessionArchiveError("partial archive is not a regular file", 409, "unsafe_archive_path");
      }
      partialIdentity = { dev: partialStat.dev, ino: partialStat.ino };
      this.assertArchiveHash(await hashFile(partialPath, archive.sizeBytes), archive);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let verifiedFinal: FileIdentity | null = null;
    try {
      const stats = await lstat(finalPath);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new SessionArchiveError("archive destination is unsafe", 409, "unsafe_archive_path");
      }
      if (await this.verifiedFinalHash(finalPath, archive, false)) {
        verifiedFinal = { dev: stats.dev, ino: stats.ino };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!partialIdentity && !verifiedFinal) throw new SessionArchiveError(
      "verified archive is missing", 409, "session_archive_attempt_conflict",
    );
    return { sizeBytes: archive.sizeBytes, partial: partialIdentity, verifiedFinal };
  }

  private fileIdentitySync(path: string): FileIdentity | null {
    try {
      const stats = lstatSync(path);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new SessionArchiveError("archive path is unsafe", 409, "unsafe_archive_path");
      }
      return { dev: stats.dev, ino: stats.ino };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private onCleanupLocked?: () => void;

  private async cleanupFailedPromotion(
    finalPath: string,
    archive: MultiremiSessionArchive,
    attemptCount: number,
    promotedFile: FileIdentity | null,
  ): Promise<void> {
    const manifestPath = join(dirname(finalPath), "manifest.json");
    this.withTimedSharedPaths(
      archive.id, archive.runtimeId, attemptCount, "cleanup", () => {
        let ownedManifest = false;
        try {
          const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
          ownedManifest = manifest.archive_id === archive.id && manifest.attempt_count === attemptCount;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
        }
        const manifestIdentity = ownedManifest ? this.fileIdentitySync(manifestPath) : null;
        const finalIdentity = promotedFile ? this.fileIdentitySync(finalPath) : null;
        this.onCleanupLocked?.();
        if (manifestIdentity && sameFileIdentity(this.fileIdentitySync(manifestPath) ?? { dev: -1, ino: -1 }, manifestIdentity)) {
          unlinkSync(manifestPath);
        }
        if (promotedFile && finalIdentity && sameFileIdentity(finalIdentity, promotedFile)
          && sameFileIdentity(this.fileIdentitySync(finalPath) ?? { dev: -1, ino: -1 }, promotedFile)) {
          unlinkSync(finalPath);
        }
      },
    );
  }

  /**
   * Run a shared-path mutation under the repo lock and time its synchronous
   * filesystem work: every other archive write of the workspace waits on it.
   */
  private withTimedSharedPaths<T>(
    archiveId: string,
    runtimeId: string,
    attemptCount: number,
    mode: "promote" | "cleanup" | "orphan",
    action: (archive: MultiremiSessionArchive) => T,
  ): T | null {
    return this.store.withLockedSessionArchiveSharedPaths(archiveId, runtimeId, attemptCount, mode, (archive) => {
      const started = performance.now();
      try {
        return action(archive);
      } finally {
        const elapsedMs = performance.now() - started;
        if (elapsedMs > this.lockedFsWarnMs) {
          log.warn(
            `Session archive ${mode} held the shared-path lock for ${Math.round(elapsedMs)}ms of filesystem work `
            + `(archive ${archiveId}, attempt ${attemptCount}, threshold ${this.lockedFsWarnMs}ms)`,
          );
        }
      }
    });
  }

  startOrphanedArchiveFileSweep(intervalMs = DEFAULT_ORPHAN_SWEEP_INTERVAL_MS): void {
    this.orphanSweepStarted = true;
    this.orphanSweepIntervalMs = Math.max(10, Math.floor(intervalMs));
    this.scheduleOrphanedArchiveFileSweep();
  }

  stopOrphanedArchiveFileSweep(): void {
    this.orphanSweepStarted = false;
    if (this.orphanSweepTimer) clearTimeout(this.orphanSweepTimer);
    this.orphanSweepTimer = null;
  }

  private scheduleOrphanedArchiveFileSweep(): void {
    if (!this.orphanSweepStarted || this.orphanSweepTimer) return;
    this.orphanSweepTimer = setTimeout(() => {
      this.orphanSweepTimer = null;
      void this.sweepOrphanedArchiveFiles()
        .catch((error) => {
          log.warn(`Session archive orphan sweep failed: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => this.scheduleOrphanedArchiveFileSweep());
    }, this.orphanSweepIntervalMs);
    this.orphanSweepTimer.unref?.();
  }

  /**
   * Remove final ZIPs and manifests that no live attempt owns.
   *
   * Two kinds are left behind otherwise: a process that crashed after
   * promotion and before `ready`, and an older attempt's pair that B4 skips
   * because a manual retry already moved the row back to pending/uploading.
   * An uploading row is left alone: its attempt either promotes over the pair
   * or ends failed, and the next sweep takes it then. Rows are read here only
   * to find candidates; each deletion is decided again under the shared-path
   * lock from the row as it stands then. Returns the removed paths.
   */
  async sweepOrphanedArchiveFiles(): Promise<string[]> {
    if (this.orphanSweepInFlight) return await this.orphanSweepInFlight;
    const run = this.sweepOrphanedArchiveFilesOnce();
    this.orphanSweepInFlight = run;
    try {
      return await run;
    } finally {
      if (this.orphanSweepInFlight === run) this.orphanSweepInFlight = null;
    }
  }

  private async sweepOrphanedArchiveFilesOnce(): Promise<string[]> {
    const removed: string[] = [];
    for (const observed of this.store.listOrphanCandidateSessionArchives()) {
      try {
        let finalPath: string;
        try {
          finalPath = await this.resolveArchivePath(observed.relativePath, false);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        const manifestPath = join(dirname(finalPath), "manifest.json");
        const present = async (path: string) => await lstat(path).then(() => true, (error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        });
        if (!await present(finalPath) && !await present(manifestPath)) continue;
        const unlinked = this.withTimedSharedPaths(
          observed.id, observed.runtimeId, observed.attemptCount, "orphan",
          (archive) => this.removeOrphanedFinalFiles(archive, finalPath, manifestPath),
        );
        if (unlinked?.length) {
          log.info(`Removed orphaned Session archive files of ${observed.id} (${observed.status}): ${unlinked.map((path) => basename(path)).join(", ")}`);
          removed.push(...unlinked);
        }
      } catch (error) {
        log.warn(`Failed to sweep orphaned Session archive files of ${observed.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return removed;
  }

  /**
   * Remove the final pair of a locked row that no attempt can publish.
   *
   * The lock admits only pending, failed and superseded rows: none of them is
   * served, and a claim bumps the raw attempt before anything can promote
   * again, so the pair at the row's own path is dead. A manifest naming another
   * archive, or one that cannot be read, keeps both files for a human to look at.
   */
  private removeOrphanedFinalFiles(
    archive: MultiremiSessionArchive,
    finalPath: string,
    manifestPath: string,
  ): string[] {
    let ownedManifest = false;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
      if (!manifest || typeof manifest !== "object" || (manifest as Record<string, unknown>).archive_id !== archive.id) {
        log.warn(`Session archive ${archive.id} has a manifest of another archive; leaving its shared files`);
        return [];
      }
      ownedManifest = true;
    } catch (error) {
      if (error instanceof SyntaxError) {
        log.warn(`Session archive ${archive.id} has an unreadable manifest; leaving its shared files`);
        return [];
      }
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const removed: string[] = [];
    // ZIP first: if the process dies in between, the surviving manifest still
    // lets the next pass check whose pair this is.
    for (const path of ownedManifest ? [finalPath, manifestPath] : [finalPath]) {
      // Only a regular file goes; anything else throws as unsafe and stays.
      if (!this.fileIdentitySync(path)) continue;
      try {
        unlinkSync(path);
        removed.push(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return removed;
  }

  private assertArchiveHash(
    actual: { sha256: string; sizeBytes: number },
    archive: MultiremiSessionArchive,
  ): void {
    if (actual.sizeBytes !== archive.sizeBytes || actual.sha256 !== archive.sha256) {
      throw new SessionArchiveError(
        "archive sha256 or size does not match the declared snapshot",
        422,
        "session_archive_integrity_mismatch",
      );
    }
  }

  private async verifiedFinalHash(
    finalPath: string,
    archive: MultiremiSessionArchive,
    rejectMismatch = true,
  ): Promise<{ sha256: string; sizeBytes: number } | null> {
    const existing = await lstat(finalPath);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new SessionArchiveError("archive destination is unsafe", 409, "unsafe_archive_path");
    }
    const actual = await hashFile(finalPath, archive.sizeBytes);
    const matches = actual.sha256 === archive.sha256 && actual.sizeBytes === archive.sizeBytes;
    if (matches) return actual;
    if (!rejectMismatch) return null;
    this.assertArchiveHash(actual, archive);
    return actual;
  }

  async verify(archiveId: string): Promise<SessionArchiveVerifyResult> {
    let archive = this.store.getSessionArchive(archiveId);
    if (!archive) throw new SessionArchiveError("session archive not found", 404, "session_archive_not_found");
    if (archive.status !== "ready") {
      throw new SessionArchiveError(
        `cannot verify archive in ${archive.status} state`,
        409,
        "session_archive_invalid_state",
      );
    }
    let actualSha256: string | null = null;
    let actualSizeBytes: number | null = null;
    let errorMessage: string | null = null;
    const verifiedAttempt = archive.attemptCount;
    try {
      const path = await this.resolveArchivePath(archive.relativePath, false);
      const stats = await lstat(path);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error("archive is not a regular file");
      }
      const actual = await hashFile(path, archive.sizeBytes);
      actualSha256 = actual.sha256;
      actualSizeBytes = actual.sizeBytes;
      if (actual.sha256 !== archive.sha256 || actual.sizeBytes !== archive.sizeBytes) {
        throw new Error("archive sha256 or size mismatch");
      }
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      archive = this.store.markSessionArchiveVerificationFailedAttempt(
        archive.id,
        verifiedAttempt,
        errorMessage,
      ) ?? this.store.getSessionArchive(archive.id) ?? archive;
      await this.cleanupExhaustedPartials(archive);
    }
    return {
      archive,
      valid: errorMessage === null,
      actualSha256,
      actualSizeBytes,
      error: errorMessage,
    };
  }

  async verifyIssueDeletionArchive(
    issueId: string,
    binding: MultiremiIssueWorkspaceArchiveBinding,
  ): Promise<MultiremiSessionArchive> {
    const archive = this.store.getSessionArchive(binding.archiveId);
    if (
      !archive
      || archive.issueId !== issueId
      || archive.sourceRevision !== binding.sourceRevision
      || archive.sha256 !== binding.sha256.toLowerCase()
      || archive.status !== "ready"
    ) {
      throw new SessionArchiveError(
        "cleaned Issue workspace is not bound to an exact ready session archive",
        409,
        "issue_workspace_archive_invalid",
      );
    }
    const verified = await this.verify(archive.id);
    const current = this.store.getSessionArchive(archive.id);
    if (
      !verified.valid
      || !current
      || current.status !== "ready"
      || current.attemptCount !== archive.attemptCount
      || current.sourceRevision !== binding.sourceRevision
      || current.sha256 !== binding.sha256.toLowerCase()
    ) {
      throw new SessionArchiveError(
        "cleaned Issue workspace archive is missing or corrupt",
        409,
        "issue_workspace_archive_invalid",
      );
    }
    return current;
  }

  async retry(archiveId: string): Promise<MultiremiSessionArchive> {
    const archive = this.store.getSessionArchive(archiveId);
    if (!archive) throw new SessionArchiveError("session archive not found", 404, "session_archive_not_found");
    if (archive.status !== "failed" && !archive.retryExhaustedAt) {
      throw new SessionArchiveError(
        `cannot retry archive in ${archive.status} state`,
        409,
        "session_archive_invalid_state",
      );
    }
    await this.cleanupArchivePartials(archive, false);
    const retried = this.store.retrySessionArchive(archiveId);
    if (!retried) throw this.issueLifecycleClosed();
    return retried;
  }

  /**
   * Publish one subject of the task_messages trace backfill (MUL-432).
   *
   * The archive goes where an upload of the same subject would, under the same
   * path rules and with the same `manifest.json`, and its pointers go through
   * the same swap rule. What differs is that there is no upload attempt: the
   * row is created `ready` in the transaction that writes the pointers and
   * marks the subject done. Until then the directory carries a marker, so an
   * interrupted run can tell its own leftovers from a live archive.
   */
  async ingestTraceBackfill(
    input: TraceBackfillIngestInput,
  ): Promise<TraceBackfillCommitResult & { turnCards: TraceBackfillTurnCardCounts }> {
    return this.ingestOperatorTraceArchive(input, (archive, ingest) => this.store.commitTraceBackfill({
      workspaceId: input.workspaceId,
      subjectKind: input.subject.kind,
      subjectId: input.subject.id,
      archive: { ...archive, fileCount: archive.fileCount ?? input.fileCount },
      pointers: buildTracePointers(archive, ingest.traces),
      noneTaskIds: input.noneTaskIds,
      progress: input.progress,
      taskDigests: input.taskDigests,
      turnSummaries: input.turnSummaries,
    }));
  }

  /** Publish verified native recovery without changing any task, card or old backfill record. */
  async ingestNativeTraceRecovery(input: NativeTraceRecoveryIngestInput): Promise<NativeTraceRecoveryCommitResult> {
    const metadata = nativeRecoveryMetadata(input.algorithmVersion, input.tasks);
    return this.ingestOperatorTraceArchive({ ...input, metadata }, (archive, ingest) => this.store.commitNativeTraceRecovery({
      workspaceId: input.workspaceId,
      subjectKind: input.subject.kind,
      subjectId: input.subject.id,
      archive: { ...archive, fileCount: archive.fileCount ?? input.fileCount },
      pointers: buildTracePointers(archive, ingest.traces),
      algorithmVersion: input.algorithmVersion,
      tasks: input.tasks,
    }), (ingest) => this.validateNativeTraceRecovery(input, ingest));
  }

  /** Read-only validation for the operator's already hash/index-verified staged archive. */
  async validateNativeTraceRecovery(input: NativeTraceRecoveryIngestInput, ingest: ArchiveIngestVerification): Promise<void> {
    const tasks = new Map(input.tasks.map((task) => [task.task.taskId, task]));
    if (ingest.traces.length !== tasks.size || ingest.index.members.length !== tasks.size + 1
      || ingest.index.members.some((member) => member.kind !== "trace" && member.path !== "manifest.json")) {
      throw new NativeTraceRecoveryError("native recovery archive must contain exactly the planned trace members");
    }
    const handle = await open(input.archivePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      for (const member of ingest.traces) {
        const candidate = member.task_id ? tasks.get(member.task_id) : undefined;
        if (!candidate) throw new NativeTraceRecoveryError("native recovery archive contains an unplanned task");
        const { bytes } = await readZipMemberBody(handle, {
          dataOffset: member.data_offset, compressedSize: member.compressed_size,
          uncompressedSize: member.uncompressed_size, sha256: member.sha256,
        });
        const lines = bytes.toString("utf8").split("\n");
        if (lines.at(-1) === "") lines.pop();
        const { task, evidence } = candidate;
        const checked = checkTraceFileLines(lines, {
          taskId: task.taskId, sessionId: nativeRecoverySessionId(task), incompleteTail: bytes.at(-1) !== 10,
        });
        if (!checked.ok || !checked.value.closed || checked.value.event_count === 0
          || checked.value.head !== checked.value.event_count || member.head !== checked.value.head
          || member.event_count !== checked.value.event_count || member.closed !== true) {
          throw new NativeTraceRecoveryError(`native recovery trace framing/counts invalid: ${task.taskId}`);
        }
        const header = JSON.parse(lines[0]!) as TraceFileHeader;
        const trailer = JSON.parse(lines.at(-1)!) as TraceFileTrailer;
        if (header.agent_id !== task.agentId || header.runtime_id !== task.runtimeId || header.provider !== task.provider
          || header.started_at !== nativeRecoveryStartedAt(candidate) || trailer.end.status !== task.status
          || trailer.end.ended_at !== nativeRecoveryEndedAt(task)) {
          throw new NativeTraceRecoveryError(`native recovery trace identity differs from task: ${task.taskId}`);
        }
        const kinds = [...new Set(lines.slice(1, -1).map((line) => String(JSON.parse(line).type)))].sort();
        const binding = evidence.nativeExecutionBinding;
        if (binding && lines.slice(1, -1).some((line) => {
          const at = Date.parse(String(JSON.parse(line).ts));
          return at < Date.parse(binding.nativeStartedAt) || at > Date.parse(binding.nativeCompletedAt);
        })) throw new NativeTraceRecoveryError(`recovered event lies outside the proven native execution: ${task.taskId}`);
        if (JSON.stringify(kinds) !== JSON.stringify([...new Set(evidence.recoveredEventKinds)].sort())) {
          throw new NativeTraceRecoveryError(`native recovery event kinds differ from proof: ${task.taskId}`);
        }
      }
    } finally {
      await handle.close();
    }
  }

  /** Shared immutable publication; caller owns its narrow atomic database commit. */
  private async ingestOperatorTraceArchive<Result>(
    input: OperatorTraceArchiveInput,
    commit: (archive: MultiremiSessionArchive, ingest: ArchiveIngestVerification) => Result,
    verify?: (ingest: ArchiveIngestVerification) => Promise<void>,
  ): Promise<Result> {
    const { subject } = input;
    if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(subject.id)) {
      throw new SessionArchiveError("subject_id must be a plain identifier", 400, "session_archive_invalid_subject");
    }
    if (input.metadata.kind !== "trace_backfill") {
      throw new SessionArchiveError("trace backfill metadata must carry kind trace_backfill");
    }
    if (Buffer.byteLength(JSON.stringify(input.metadata), "utf8") > 64 * 1024) {
      throw new SessionArchiveError("metadata exceeds 65536 bytes", 413, "metadata_too_large");
    }
    if (!/^[a-f0-9]{64}$/.test(input.sha256)) {
      throw new SessionArchiveError("sha256 must be a 64-character lowercase hexadecimal digest");
    }
    if (input.sizeBytes > this.config.maxBytes) {
      throw new SessionArchiveError(
        `archive exceeds configured maximum of ${this.config.maxBytes} bytes`,
        413,
        "session_archive_too_large",
      );
    }
    const declared = {
      workspaceId: input.workspaceId,
      subjectKind: subject.kind,
      subjectId: subject.id,
      issueId: subject.kind === "issue" ? subject.id : null,
      format: SESSION_ARCHIVE_FORMAT_V2,
      runtimeId: input.runtimeId,
      daemonId: input.daemonId,
      sourceRevision: input.sourceRevision,
      sha256: input.sha256,
      sizeBytes: input.sizeBytes,
      fileCount: input.fileCount,
      metadata: input.metadata,
    };
    const staged: MultiremiSessionArchive = {
      ...declared,
      id: "",
      uploadedSizeBytes: input.sizeBytes,
      status: "ready",
      relativePath: "",
      attemptCount: 1,
      retryBudgetBaseAttempt: 0,
      lastError: null,
      nextRetryAt: null,
      retryExhaustedAt: null,
      createdAt: "",
      updatedAt: "",
      completedAt: null,
    };
    this.assertArchiveHash(await hashFile(input.archivePath, input.sizeBytes), staged);
    const ingest = await this.validateArchiveIngest(input.archivePath, staged);
    await verify?.(ingest);

    const existing = this.store.listSessionArchivesForSubject(subject.kind, subject.id)
      .find((archive) => archive.sourceRevision === input.sourceRevision && archive.sha256 === input.sha256);
    if (existing) {
      // Byte-identical content an earlier run already published: reuse it.
      if (existing.status !== "ready" || existing.metadata.kind !== "trace_backfill") {
        throw new SessionArchiveError(
          `archive ${existing.id} already holds this content`, 409, "session_archive_attempt_conflict",
        );
      }
      await this.verifiedFinalHash(await this.resolveArchivePath(existing.relativePath, false), existing);
      const result = this.translateTraceBackfillError(() => commit(existing, ingest));
      await unlink(input.archivePath).catch(() => {});
      return result;
    }

    const id = createId("sar");
    const relativePath = archiveRelativePath({
      workspaceId: input.workspaceId, subjectKind: subject.kind, subjectId: subject.id, archiveId: id,
    });
    const finalPath = await this.resolveArchivePath(relativePath, true);
    const directory = dirname(finalPath);
    const marker = join(directory, TRACE_BACKFILL_PENDING_MARKER);
    const archive: MultiremiSessionArchive = { ...staged, id, relativePath };
    let committed = false;
    try {
      await writeFile(marker, `${JSON.stringify({ archive_id: id, subject })}\n`, { flag: "wx", mode: 0o600 });
      await this.ensureCapacity(input.sizeBytes);
      try {
        await rename(input.archivePath, finalPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
        const partial = `${finalPath}.backfill.partial`;
        await copyFile(input.archivePath, partial, constants.COPYFILE_EXCL);
        const handle = await open(partial, constants.O_RDONLY);
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(partial, finalPath);
        await unlink(input.archivePath);
      }
      this.assertArchiveHash(await hashFile(finalPath, input.sizeBytes), archive);
      const manifestTemp = await this.writeManifest(finalPath, archive, input.sizeBytes);
      await rename(manifestTemp, join(directory, "manifest.json"));
      await this.syncDirectory(directory);
      const result = this.translateTraceBackfillError(() => commit(archive, ingest));
      committed = true;
      await unlink(marker).catch((error) => {
        log.warn(`Failed to clear trace backfill marker for ${id}: ${String(error)}`);
      });
      return result;
    } finally {
      if (!committed) await rm(directory, { recursive: true, force: true }).catch((error) => {
        log.warn(`Failed to clean trace backfill archive directory for ${id}: ${String(error)}`);
      });
    }
  }

  /**
   * Remove what an interrupted backfill run left in a subject's directory:
   * archive directories that still carry the pending marker and have no row.
   * A committed archive whose marker survived a crash only loses the marker.
   */
  async cleanupTraceBackfillOrphans(workspaceId: string, subject: SessionArchiveSubjectScope): Promise<string[]> {
    // <subject>/<archive id>/sessions.zip, so the subject directory is two up.
    const relativeSubject = dirname(dirname(archiveRelativePath({
      workspaceId, subjectKind: subject.kind, subjectId: subject.id, archiveId: "probe",
    })));
    let subjectDirectory: string;
    try {
      subjectDirectory = dirname(await this.resolveArchivePath(join(relativeSubject, "probe"), false));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const removed: string[] = [];
    for (const entry of await readdir(subjectDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("sar_")) continue;
      const directory = join(subjectDirectory, entry.name);
      const marker = join(directory, TRACE_BACKFILL_PENDING_MARKER);
      const hasMarker = await lstat(marker).then((info) => info.isFile(), () => false);
      if (!hasMarker) continue;
      if (this.store.getSessionArchive(entry.name)) {
        await unlink(marker).catch(() => {});
        continue;
      }
      await rm(directory, { recursive: true, force: true });
      removed.push(entry.name);
    }
    return removed;
  }

  private translateTraceBackfillError<T>(run: () => T): T {
    try {
      return run();
    } catch (error) {
      if (error instanceof SessionArchiveTraceOwnershipError) {
        throw new SessionArchiveError(error.message, 422, "session_archive_trace_ownership_mismatch");
      }
      if (error instanceof TraceBackfillSubjectError) {
        throw new SessionArchiveError(error.message, 409, "trace_backfill_subject_invalid");
      }
      throw error;
    }
  }

  private requireWritableArchive(
    archive: MultiremiSessionArchive,
    runtimeId: string,
  ): MultiremiSessionArchive {
    const writable = this.store.touchWritableSessionArchive(archive.id, runtimeId);
    if (!writable) throw this.subjectNotWritable(archive.subjectKind);
    return writable;
  }

  private subjectNotWritable(subjectKind: MultiremiSessionArchiveSubjectKind): SessionArchiveError {
    if (subjectKind === "issue") return this.issueLifecycleClosed();
    return new SessionArchiveError(
      `${subjectKind} session archive is not writable: the Runtime no longer owns this subject`,
      409,
      "session_archive_subject_not_writable",
    );
  }

  private unsupportedFormat(format: string): SessionArchiveError {
    return new SessionArchiveError(
      `session archive format ${format} is no longer accepted for new uploads; `
      + `upgrade the daemon to upload ${SESSION_ARCHIVE_FORMAT_V2}`,
      409,
      "session_archive_format_unsupported",
    );
  }

  private issueLifecycleClosed(): SessionArchiveError {
    return new SessionArchiveError(
      "Issue is deleting or its workspace has already been cleaned",
      409,
      "issue_archive_lifecycle_closed",
    );
  }

  /**
   * Persist the physical cleanup intent before SQL metadata is removed. The
   * receipt deliberately survives a process crash between the DB commit and
   * filesystem cleanup; a later hard delete or explicit recovery can replay it.
   */
  async prepareIssueArchivePurge(issueId: string): Promise<string> {
    const relativePaths = [...new Set(
      this.store.listSessionArchives(issueId).map((archive) => archive.relativePath),
    )];
    for (const relativePath of relativePaths) {
      await this.resolveArchivePath(relativePath, false).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
    const outbox = await this.ensurePurgeOutbox();
    const receiptId = randomUUID();
    const target = join(outbox, `${receiptId}.json`);
    const temporary = join(outbox, `${receiptId}.${process.pid}.${randomUUID()}.partial`);
    const receipt: IssueArchivePurgeReceipt = {
      version: 1,
      issue_id: issueId,
      relative_paths: relativePaths,
      created_at: new Date().toISOString(),
    };
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      await handle.writeFile(`${JSON.stringify(receipt)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, target);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    await this.syncDirectory(outbox);
    this.schedulePurgeRecovery(0);
    return receiptId;
  }

  async abortIssueArchivePurge(receiptId: string): Promise<void> {
    const path = await this.resolvePurgeReceipt(receiptId);
    await unlink(path).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }

  async completeIssueArchivePurge(receiptId: string): Promise<number> {
    try {
      return await this.consumePurgeReceipt(receiptId, true);
    } catch (error) {
      this.schedulePurgeRecovery(this.purgeRecoveryIntervalMs);
      throw error;
    }
  }

  startIssueArchivePurgeRecovery(intervalMs = DEFAULT_PURGE_RECOVERY_INTERVAL_MS): void {
    this.purgeRecoveryStarted = true;
    this.purgeRecoveryIntervalMs = Math.max(10, Math.floor(intervalMs));
    this.schedulePurgeRecovery(0);
  }

  /**
   * Cancels future scheduling only. A pass that already started keeps running to
   * completion so a receipt is never left half-consumed (archive directory gone
   * but receipt still on disk). Await {@link whenIssueArchivePurgeRecoveryIdle}
   * when the caller needs the outbox to be quiescent.
   */
  stopIssueArchivePurgeRecovery(): void {
    this.purgeRecoveryStarted = false;
    if (this.purgeRecoveryTimer) clearTimeout(this.purgeRecoveryTimer);
    this.purgeRecoveryTimer = null;
  }

  /**
   * Resolves once no recovery pass and no receipt consumption is in flight.
   * Call after {@link stopIssueArchivePurgeRecovery} to observe a settled
   * outbox; on its own it only reflects a momentary lull, since a running
   * recovery loop can schedule another pass immediately afterwards.
   */
  async whenIssueArchivePurgeRecoveryIdle(): Promise<void> {
    while (this.purgeRecoveryInFlight || this.purgeReceiptAttempts.size > 0) {
      await this.purgeRecoveryInFlight?.catch(() => undefined);
      await Promise.all(
        [...this.purgeReceiptAttempts.values()].map((attempt) => attempt.catch(() => undefined)),
      );
      // Yield a macrotask so the settled pass runs its own `finally` and clears
      // the in-flight handles before the next check.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  async recoverIssueArchivePurges(_minAgeMs = 0): Promise<number> {
    if (this.purgeRecoveryInFlight) return await this.purgeRecoveryInFlight;
    const run = this.recoverIssueArchivePurgesOnce();
    this.purgeRecoveryInFlight = run;
    try {
      return await run;
    } finally {
      if (this.purgeRecoveryInFlight === run) this.purgeRecoveryInFlight = null;
      // Keep polling even after an empty pass. Another Server process can
      // durably publish a receipt and crash before notifying this instance.
      if (this.purgeRecoveryStarted) {
        this.schedulePurgeRecovery(this.purgeRecoveryIntervalMs);
      }
    }
  }

  private async recoverIssueArchivePurgesOnce(): Promise<number> {
    let outbox: string;
    try {
      outbox = await this.ensurePurgeOutbox();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    let recovered = 0;
    let entries: Array<{ name: string; isFile(): boolean }>;
    try {
      entries = await readdir(outbox, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/^[0-9a-f-]+\.json$/i.test(entry.name)) continue;
      const receiptId = entry.name.slice(0, -".json".length);
      try {
        recovered += await this.consumePurgeReceipt(receiptId, false);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        log.warn(
          `Failed to recover Issue archive purge ${receiptId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return recovered;
  }

  private async consumePurgeReceipt(receiptId: string, requireCommitted: boolean): Promise<number> {
    const existing = this.purgeReceiptAttempts.get(receiptId);
    if (existing) return await existing;
    const run = this.consumePurgeReceiptOnce(receiptId, requireCommitted);
    this.purgeReceiptAttempts.set(receiptId, run);
    try {
      return await run;
    } finally {
      if (this.purgeReceiptAttempts.get(receiptId) === run) {
        this.purgeReceiptAttempts.delete(receiptId);
      }
    }
  }

  private async consumePurgeReceiptOnce(receiptId: string, requireCommitted: boolean): Promise<number> {
    const path = await this.resolvePurgeReceipt(receiptId);
    const receipt = await this.readPurgeReceipt(path);
    const lifecycle = this.store.getIssueDeletionLifecycleState(receipt.issue_id);
    if (lifecycle !== null) {
      if (requireCommitted) {
        throw new SessionArchiveError(
          "cannot purge archives before the Issue database delete commits",
          409,
          "session_archive_purge_not_committed",
        );
      }
      // A deleting Issue owns a durable receipt that must survive until its DB
      // transaction commits. An active Issue means deletion was aborted.
      if (lifecycle !== "deleting") {
        await unlink(path).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
      }
      return 0;
    }
    const deleted = await this.purgeArchivePaths(receipt.relative_paths);
    await unlink(path).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    return deleted;
  }

  private schedulePurgeRecovery(delayMs: number): void {
    if (!this.purgeRecoveryStarted || this.purgeRecoveryTimer) return;
    this.purgeRecoveryTimer = setTimeout(() => {
      this.purgeRecoveryTimer = null;
      void this.recoverIssueArchivePurges().catch((error) => {
        log.warn(`Issue archive purge recovery failed: ${error instanceof Error ? error.message : String(error)}`);
        this.schedulePurgeRecovery(this.purgeRecoveryIntervalMs);
      });
    }, Math.max(0, delayMs));
    this.purgeRecoveryTimer.unref?.();
  }

  private async purgeArchivePaths(relativePaths: string[]): Promise<number> {
    let deleted = 0;
    for (const relativePath of relativePaths) {
      let finalPath: string;
      try {
        finalPath = await this.resolveArchivePath(relativePath, false);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const archiveDirectory = dirname(finalPath);
      let directoryInfo: Awaited<ReturnType<typeof lstat>>;
      try {
        directoryInfo = await lstat(archiveDirectory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
        throw new SessionArchiveError(
          "archive directory is unsafe",
          409,
          "unsafe_archive_path",
        );
      }
      await rm(archiveDirectory, { recursive: true, force: false }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
      deleted++;
    }
    return deleted;
  }

  private async ensurePurgeOutbox(): Promise<string> {
    const root = await this.ensureRoot();
    const outbox = join(root, ISSUE_PURGE_OUTBOX);
    try {
      await mkdir(outbox, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = await lstat(outbox);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new SessionArchiveError("archive purge outbox is unsafe", 409, "unsafe_archive_path");
    }
    return outbox;
  }

  private async resolvePurgeReceipt(receiptId: string): Promise<string> {
    if (!/^[0-9a-f-]{36}$/i.test(receiptId)) {
      throw new SessionArchiveError("invalid archive purge receipt", 400, "invalid_archive_purge_receipt");
    }
    return join(await this.ensurePurgeOutbox(), `${receiptId}.json`);
  }

  private async readPurgeReceipt(path: string): Promise<IssueArchivePurgeReceipt> {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new SessionArchiveError("archive purge receipt is unsafe", 409, "unsafe_archive_path");
    }
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<IssueArchivePurgeReceipt>;
    if (
      value.version !== 1
      || typeof value.issue_id !== "string"
      || !Array.isArray(value.relative_paths)
      || value.relative_paths.some((entry) => typeof entry !== "string")
      || typeof value.created_at !== "string"
    ) {
      throw new SessionArchiveError("archive purge receipt is invalid", 409, "invalid_archive_purge_receipt");
    }
    return value as IssueArchivePurgeReceipt;
  }

  private async syncDirectory(path: string): Promise<void> {
    // Windows cannot flush directory handles. Data files are still flushed
    // before atomic promotion; do not report successful writes as failed.
    if (process.platform === "win32") return;
    const directory = await open(path, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  private async ensureCapacity(sizeBytes: number): Promise<void> {
    const root = await this.ensureRoot();
    const stats = await statfs(root);
    const available = Number(stats.bavail) * Number(stats.bsize);
    if (!Number.isFinite(available) || available - sizeBytes < this.config.minFreeBytes) {
      throw new SessionArchiveError(
        "insufficient free space for session archive",
        507,
        "session_archive_insufficient_storage",
      );
    }
  }

  private partialPath(finalPath: string, attemptCount: number): string {
    if (!Number.isSafeInteger(attemptCount) || attemptCount < 1) {
      throw new SessionArchiveError("invalid session archive attempt", 409, "session_archive_attempt_conflict");
    }
    return `${finalPath}.${attemptCount}.partial`;
  }

  private assertCurrentAttempt(archive: MultiremiSessionArchive, attemptCount: number): void {
    if (!Number.isSafeInteger(attemptCount) || attemptCount < 1 || archive.attemptCount !== attemptCount) {
      throw new SessionArchiveError(
        "session archive upload attempt was superseded",
        409,
        "session_archive_attempt_conflict",
      );
    }
  }

  private async cleanupPriorAttemptPartials(finalPath: string, activeAttempt: number): Promise<void> {
    const directory = dirname(finalPath);
    const finalName = basename(finalPath);
    const attemptPattern = new RegExp(`^${escapeRegExp(finalName)}\\.(\\d+)\\.partial$`);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const match = attemptPattern.exec(entry.name);
      const legacyPartial = entry.name === `${finalName}.partial`;
      if (!legacyPartial && !match) continue;
      const attempt = match ? Number(match[1]) : 0;
      if (!legacyPartial && (!Number.isSafeInteger(attempt) || attempt >= activeAttempt)) continue;
      await unlink(join(directory, entry.name));
    }
  }

  async cleanupExhaustedPartials(archive: MultiremiSessionArchive | null): Promise<void> {
    if (!archive?.retryExhaustedAt) return;
    const current = this.store.getSessionArchive(archive.id);
    if (!this.isSameRetryExhaustion(current, archive)) return;
    await this.cleanupArchivePartials(current, true, archive);
  }

  private async cleanupArchivePartials(
    archive: MultiremiSessionArchive,
    bestEffort: boolean,
    exhaustedGeneration?: MultiremiSessionArchive,
  ): Promise<void> {
    try {
      const finalPath = await this.resolveArchivePath(archive.relativePath, false);
      const directory = dirname(finalPath);
      const finalName = basename(finalPath);
      const attemptPattern = new RegExp(`^${escapeRegExp(finalName)}\\.\\d+\\.partial$`);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name !== `${finalName}.partial` && !attemptPattern.test(entry.name)) continue;
        if (
          exhaustedGeneration
          && !this.isSameRetryExhaustion(
            this.store.getSessionArchive(archive.id),
            exhaustedGeneration,
          )
        ) return;
        await unlink(join(directory, entry.name));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      if (!bestEffort) throw error;
      log.warn(
        `Failed to clean Session archive partials for ${archive.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private isSameRetryExhaustion(
    current: MultiremiSessionArchive | null,
    expected: MultiremiSessionArchive,
  ): current is MultiremiSessionArchive {
    return Boolean(
      current?.retryExhaustedAt
      && current.retryExhaustedAt === expected.retryExhaustedAt
      && current.attemptCount === expected.attemptCount,
    );
  }

  private async writeManifest(
    archivePath: string,
    archive: MultiremiSessionArchive,
    sizeBytes: number,
  ): Promise<string> {
    const manifestPath = join(dirname(archivePath), "manifest.json");
    const partialPath = `${manifestPath}.${archive.attemptCount}.${randomUUID()}.partial`;
    const payload = `${JSON.stringify({
      schema_version: 1,
      archive_id: archive.id,
      attempt_count: archive.attemptCount,
      workspace_id: archive.workspaceId,
      subject_kind: archive.subjectKind,
      subject_id: archive.subjectId,
      format: archive.format,
      issue_id: archive.issueId,
      runtime_id: archive.runtimeId,
      daemon_id: archive.daemonId,
      source_revision: archive.sourceRevision,
      sha256: archive.sha256,
      size_bytes: sizeBytes,
      file_count: archive.fileCount,
      metadata: archive.metadata,
      archived_at: new Date().toISOString(),
    }, null, 2)}\n`;
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC
      | (constants.O_NOFOLLOW ?? 0);
    const handle = await open(partialPath, flags, 0o600);
    try {
      await handle.writeFile(payload, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return partialPath;
  }

  private async ensureRoot(): Promise<string> {
    await mkdir(this.config.root, { recursive: true, mode: 0o700 });
    return realpath(this.config.root);
  }

  private async resolveArchivePath(relativePath: string, createParent: boolean): Promise<string> {
    if (!relativePath || isAbsolute(relativePath)) {
      throw new SessionArchiveError("unsafe archive path", 409, "unsafe_archive_path");
    }
    const root = await this.ensureRoot();
    const path = resolve(root, relativePath);
    const fromRoot = relative(root, path);
    if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new SessionArchiveError("unsafe archive path", 409, "unsafe_archive_path");
    }
    const parent = dirname(path);

    // Create and inspect one directory at a time. A recursive mkdir would
    // follow an attacker-planted intermediate symlink before we could reject
    // it. The final file is additionally opened with O_NOFOLLOW.
    let current = root;
    const parentRelative = relative(root, parent);
    for (const segment of parentRelative.split(sep).filter(Boolean)) {
      if (segment === "." || segment === "..") {
        throw new SessionArchiveError("unsafe archive path", 409, "unsafe_archive_path");
      }
      current = join(current, segment);
      let stats: Awaited<ReturnType<typeof lstat>>;
      try {
        stats = await lstat(current);
      } catch (error) {
        if (!createParent || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        try {
          await mkdir(current, { mode: 0o700 });
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
        }
        stats = await lstat(current);
      }
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new SessionArchiveError("archive path contains a symlink", 409, "unsafe_archive_path");
      }
    }
    return path;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
