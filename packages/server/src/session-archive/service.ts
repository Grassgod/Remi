import { createHash, randomUUID } from "node:crypto";
import {
  constants,
} from "node:fs";
import {
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
} from "@multiremi/contracts/types.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import { createId } from "@multiremi/ids.js";
import { createLogger } from "@shared/logger.js";

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MIN_FREE_BYTES = 10 * 1024 * 1024 * 1024;
const UPLOAD_PROGRESS_HEARTBEAT_MS = 30_000;
const DEFAULT_ROOT = join(homedir(), ".remi", "multiremi", "session-archives");
const ISSUE_PURGE_OUTBOX = ".issue-purge-outbox";
const DEFAULT_PURGE_RECOVERY_INTERVAL_MS = 30_000;
const log = createLogger("session-archive");

interface IssueArchivePurgeReceipt {
  version: 1;
  issue_id: string;
  relative_paths: string[];
  created_at: string;
}

export interface SessionArchiveStorageConfig {
  root: string;
  maxBytes: number;
  minFreeBytes: number;
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

export function sessionArchiveStorageConfigFromEnv(): SessionArchiveStorageConfig {
  return {
    root: resolve(process.env.MULTIREMI_SESSION_ARCHIVE_ROOT?.trim() || DEFAULT_ROOT),
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
  "workspaceId" | "issueId"
> & { archiveId: string }): string {
  return join(
    "workspaces",
    encodedSegment(input.workspaceId),
    "issues",
    encodedSegment(input.issueId),
    input.archiveId,
    "sessions.tar.gz",
  );
}

function assertArchiveScope(
  archive: MultiremiSessionArchive | null,
  runtimeId: string,
  issueId: string,
): MultiremiSessionArchive {
  if (!archive || archive.runtimeId !== runtimeId || archive.issueId !== issueId) {
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

export class SessionArchiveService {
  readonly config: SessionArchiveStorageConfig;
  private completionAttempts = new Map<string, Promise<MultiremiSessionArchive>>();
  private purgeReceiptAttempts = new Map<string, Promise<number>>();
  private purgeRecoveryInFlight: Promise<number> | null = null;
  private purgeRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private purgeRecoveryStarted = false;
  private purgeRecoveryIntervalMs = DEFAULT_PURGE_RECOVERY_INTERVAL_MS;

  constructor(
    private readonly store: MultiremiStore,
    config: Partial<SessionArchiveStorageConfig> = {},
  ) {
    this.config = { ...sessionArchiveStorageConfigFromEnv(), ...config };
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
    const archiveId = createId("sar");
    try {
      return this.store.initSessionArchive(
        { ...input, sha256: input.sha256.toLowerCase(), metadata },
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
    issueId: string,
    archiveId: string,
  ): Promise<{ archive: MultiremiSessionArchive; uploadAttempt: number | null }> {
    let archive = assertArchiveScope(this.store.getSessionArchive(archiveId), runtimeId, issueId);
    archive = this.requireWritableArchive(archive, runtimeId);
    if (archive.status === "ready") return { archive, uploadAttempt: null };
    if (archive.status === "superseded") {
      throw new SessionArchiveError("session archive has been superseded", 409, "archive_superseded");
    }
    const claimed = this.store.claimSessionArchiveUploadAttempt(archive.id, runtimeId);
    if (!claimed) {
      archive = assertArchiveScope(this.store.getSessionArchive(archiveId), runtimeId, issueId);
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
    issueId: string,
    archiveId: string,
    attemptCount: number,
    body: ReadableStream<Uint8Array> | null,
  ): Promise<MultiremiSessionArchive> {
    let archive = assertArchiveScope(this.store.getSessionArchive(archiveId), runtimeId, issueId);
    archive = this.requireWritableArchive(archive, runtimeId);
    this.assertCurrentAttempt(archive, attemptCount);
    if (archive.status === "ready") return archive;
    if (archive.status === "superseded") {
      throw new SessionArchiveError("session archive has been superseded", 409, "archive_superseded");
    }
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
    issueId: string,
    archiveId: string,
    attemptCount: number,
  ): void {
    let archive = assertArchiveScope(this.store.getSessionArchive(archiveId), runtimeId, issueId);
    archive = this.requireWritableArchive(archive, runtimeId);
    this.assertCurrentAttempt(archive, attemptCount);
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
    issueId: string,
    archiveId: string,
    attemptCount: number,
    error: string,
  ): MultiremiSessionArchive {
    let archive = assertArchiveScope(this.store.getSessionArchive(archiveId), runtimeId, issueId);
    archive = this.requireWritableArchive(archive, runtimeId);
    this.assertCurrentAttempt(archive, attemptCount);
    if (archive.status === "failed") return archive;
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
    issueId: string,
    archiveId: string,
    attemptCount: number,
  ): Promise<MultiremiSessionArchive> {
    const key = JSON.stringify([runtimeId, issueId, archiveId, attemptCount]);
    const existing = this.completionAttempts.get(key);
    if (existing) return await existing;
    const completion = this.completeAttempt(runtimeId, issueId, archiveId, attemptCount);
    this.completionAttempts.set(key, completion);
    try {
      return await completion;
    } finally {
      if (this.completionAttempts.get(key) === completion) this.completionAttempts.delete(key);
    }
  }

  private async completeAttempt(
    runtimeId: string,
    issueId: string,
    archiveId: string,
    attemptCount: number,
  ): Promise<MultiremiSessionArchive> {
    let archive = assertArchiveScope(this.store.getSessionArchive(archiveId), runtimeId, issueId);
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
    const finalPath = await this.resolveArchivePath(archive.relativePath, false);
    const partialPath = this.partialPath(finalPath, attemptCount);
    try {
      const actual = await this.promoteVerifiedPartial(partialPath, finalPath, archive);
      await this.writeManifest(finalPath, archive, actual.sizeBytes);
      await this.syncDirectory(dirname(finalPath));
      const ready = this.store.markSessionArchiveReadyAttempt(
        archive.id,
        runtimeId,
        attemptCount,
        actual.sizeBytes,
      );
      if (!ready) {
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
      return ready;
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
      await this.cleanupExhaustedPartials(failed);
      throw error;
    }
  }

  private async promoteVerifiedPartial(
    partialPath: string,
    finalPath: string,
    archive: MultiremiSessionArchive,
  ): Promise<{ sha256: string; sizeBytes: number }> {
    let partialHash: { sha256: string; sizeBytes: number } | null = null;
    try {
      const partialStat = await lstat(partialPath);
      if (!partialStat.isFile() || partialStat.isSymbolicLink()) {
        throw new SessionArchiveError("partial archive is not a regular file", 409, "unsafe_archive_path");
      }
      partialHash = await hashFile(partialPath, archive.sizeBytes);
      this.assertArchiveHash(partialHash, archive);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const finalHash = await this.verifiedFinalHash(finalPath, archive);
      if (!finalHash) throw new Error("verified archive unexpectedly missing");
      return finalHash;
    }

    let finalHash: { sha256: string; sizeBytes: number } | null = null;
    try {
      finalHash = await this.verifiedFinalHash(finalPath, archive, false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (finalHash) {
      await unlink(partialPath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
      return finalHash;
    }

    try {
      // The control-plane attempt fence makes replacement safe. This also
      // repairs a corrupt object after verify -> retry.
      await rename(partialPath, finalPath);
      return partialHash;
    } catch (error) {
      // Another Server process may have promoted this exact attempt between
      // our hash and rename. Treat its matching immutable object as success.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const concurrentHash = await this.verifiedFinalHash(finalPath, archive);
      if (!concurrentHash) throw new Error("verified archive unexpectedly missing");
      return concurrentHash;
    }
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

  private requireWritableArchive(
    archive: MultiremiSessionArchive,
    runtimeId: string,
  ): MultiremiSessionArchive {
    const writable = this.store.touchWritableSessionArchive(archive.id, runtimeId);
    if (!writable) throw this.issueLifecycleClosed();
    return writable;
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
  ): Promise<void> {
    const manifestPath = join(dirname(archivePath), "manifest.json");
    const partialPath = `${manifestPath}.${archive.attemptCount}.${randomUUID()}.partial`;
    const payload = `${JSON.stringify({
      schema_version: 1,
      archive_id: archive.id,
      workspace_id: archive.workspaceId,
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
    await rename(partialPath, manifestPath);
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
