/**
 * Session archive barrier for Chat and one-shot Task subjects.
 *
 * The Issue barrier (daemon.ts `ensureIssueSessionArchive`) archives every
 * `ises_*` root of one Issue. A Chat or a one-shot Task keeps all of its
 * provider history, traces and Plugin runtime under a single
 * `.runtime/<subject id>` root, so its archive is that root alone. Workspace GC
 * calls this right before deleting any directory of the subject, and the daemon
 * calls it once when a one-shot task reaches a terminal state.
 */

import { lstat, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { MultiremiIssueWorkspaceArchiveBinding } from "@multiremi/contracts/types.js";
import { MULTIREMI_SESSION_ARCHIVE_PREPARATION_FAILURE_REVISION } from "@multiremi/contracts/types.js";
import {
  prepareSessionArchive,
  removePreparedSessionArchive,
  type PreparedSessionArchive,
} from "@daemon/agent-runtime/workspace/session-archive.js";
import { subjectRuntimeStateRoot } from "@daemon/agent-runtime/workspace/session-home.js";
import { createLogger } from "@shared/logger.js";
import type { MultiremiDaemonClient, MultiremiDaemonSessionArchiveWire } from "./client.js";

const log = createLogger("multiremi-subject-session-archive");

export interface SubjectSessionArchiveSubject {
  kind: "chat" | "task";
  id: string;
}

export interface EnsureSubjectSessionArchiveOptions {
  client: Pick<
    MultiremiDaemonClient,
    | "getSessionArchiveStatus"
    | "initSessionArchive"
    | "uploadSessionArchive"
    | "completeSessionArchive"
    | "reportSessionArchiveFailure"
  >;
  runtimeId: string | null | undefined;
  workspacesRoot: string;
  maxSourceBytes?: number;
  /** Synchronous process-ownership fence, called before every local mutation. */
  assertRootOwner: () => void;
}

/**
 * Return a server-ready archive of the subject's `.runtime/<id>` root, or null
 * while none is available (deferred retry, upload not ready, directory gone).
 *
 * `workspaceDir` is the directory the caller is about to collect; the local
 * archive is staged under its excluded `.multiremi/` metadata. With
 * `forceFreshSnapshot` the server also re-verifies the stored bytes.
 */
export async function ensureSubjectSessionArchive(
  options: EnsureSubjectSessionArchiveOptions,
  subject: SubjectSessionArchiveSubject,
  workspaceDir: string,
  forceFreshSnapshot: boolean,
): Promise<MultiremiIssueWorkspaceArchiveBinding | null> {
  options.assertRootOwner();
  const runtimeId = options.runtimeId;
  if (!runtimeId) throw new Error("Session archive requires a registered Runtime");
  // Staging below a directory that is already gone would recreate it.
  if (!await isRealDirectory(workspaceDir)) return null;
  const label = `${subject.kind} ${subject.id}`;
  const sourceRoot = subjectRuntimeStateRoot(options.workspacesRoot, subject.id);
  const current = await options.client.getSessionArchiveStatus(runtimeId, subject);
  if (current.latest_ready && !await pathExists(sourceRoot)) {
    // The provider root was already reclaimed after an earlier archive. A new
    // snapshot would be empty and would displace the real history as the latest
    // archive, so the existing ready archive stays the barrier while the server
    // still holds its bytes.
    const ready = current.latest_ready;
    const verified = await options.client.getSessionArchiveStatus(
      runtimeId,
      subject,
      ready.source_revision,
      ready.sha256,
      forceFreshSnapshot,
    );
    if (!verified.gc_ready || !verified.requested_ready) return null;
    return { archiveId: verified.requested_ready.id, sourceRevision: ready.source_revision, sha256: ready.sha256 };
  }
  const deferral = retryDeferral(current.latest);
  if (deferral) {
    log.warn(
      deferral === "exhausted"
        ? `Session archive automatic retries exhausted for ${label}; preserving its directories for manual retry`
        : `Session archive retry deferred for ${label} until ${current.latest?.next_retry_at ?? "the server retry window"}`,
    );
    return null;
  }

  let prepared: PreparedSessionArchive;
  try {
    options.assertRootOwner();
    // Staging lives under the excluded `.multiremi/`. When the collected
    // directory is the archived root itself, creating that entry during the
    // scan would change the root and fail the snapshot, so create it first.
    await mkdir(join(workspaceDir, ".multiremi")).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    prepared = await prepareSessionArchive(workspaceDir, {
      subject,
      providerRoots: [{ sessionId: basename(sourceRoot), root: sourceRoot }],
      storageBoundary: options.workspacesRoot,
      maxSourceBytes: options.maxSourceBytes,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await options.client.reportSessionArchiveFailure(runtimeId, subject, { stage: "prepare", error: message });
    } catch (reportError) {
      log.warn(
        `Failed to report Session archive preparation failure for ${label}: ${reportError instanceof Error ? reportError.message : String(reportError)}`,
      );
    }
    throw error;
  }
  const binding = (archiveId: string): MultiremiIssueWorkspaceArchiveBinding => ({
    archiveId,
    sourceRevision: prepared.sourceRevision,
    sha256: prepared.sha256,
  });
  const initInput = {
    sourceRevision: prepared.sourceRevision,
    sha256: prepared.sha256,
    sizeBytes: prepared.sizeBytes,
    fileCount: prepared.fileCount,
    metadata: { format: prepared.metadata.format, source: ".runtime" },
  };
  try {
    const status = await options.client.getSessionArchiveStatus(
      runtimeId,
      subject,
      prepared.sourceRevision,
      prepared.sha256,
      forceFreshSnapshot,
    );
    if (status.gc_ready) {
      // Same content is already archived. A newer preparation-failure row
      // would still read as the subject's latest state, so supersede it.
      if (
        status.latest?.source_revision === MULTIREMI_SESSION_ARCHIVE_PREPARATION_FAILURE_REVISION
        && (status.latest.status === "failed" || status.latest.status === "pending")
      ) {
        await options.client.initSessionArchive(runtimeId, subject, initInput);
      }
      const archiveId = status.requested_ready?.id;
      return archiveId ? binding(archiveId) : null;
    }
    const initialized = await options.client.initSessionArchive(runtimeId, subject, initInput);
    if (initialized.archive.status === "ready") return binding(initialized.archive.id);
    options.assertRootOwner();
    await options.client.uploadSessionArchive(runtimeId, subject, initialized.archive.id, prepared.archivePath);
    const completed = await options.client.completeSessionArchive(runtimeId, subject, initialized.archive.id);
    return completed.status === "ready" ? binding(completed.id) : null;
  } finally {
    await removePreparedSessionArchive(prepared.archivePath);
  }
}

/** Same backoff/exhausted gate the Issue path applies before re-preparing. */
function retryDeferral(archive: MultiremiDaemonSessionArchiveWire | null): "backoff" | "exhausted" | null {
  if (!archive || (archive.status !== "pending" && archive.status !== "uploading" && archive.status !== "failed")) {
    return null;
  }
  const retryState = archive.retry_state
    ?? (archive.retry_exhausted_at
      ? "exhausted"
      : archive.next_retry_at && archive.next_retry_at > new Date().toISOString()
        ? "backoff"
        : "eligible");
  return retryState === "backoff" || retryState === "exhausted" ? retryState : null;
}

async function isRealDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
