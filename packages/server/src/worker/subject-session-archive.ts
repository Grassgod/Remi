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
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
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
  signal?: AbortSignal;
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
  const assertActive = () => { options.signal?.throwIfAborted(); options.assertRootOwner(); };
  const active = async <T>(operation: Promise<T>): Promise<T> => { const result = await operation; assertActive(); return result; };
  assertActive();
  const runtimeId = options.runtimeId;
  if (!runtimeId) throw new Error("Session archive requires a registered Runtime");
  // Staging below a directory that is already gone would recreate it.
  if (!await isRealDirectory(workspaceDir)) return null;
  const label = `${subject.kind} ${subject.id}`;
  const sourceRoot = subjectRuntimeStateRoot(options.workspacesRoot, subject.id);
  assertActive();
  const current = await active(options.client.getSessionArchiveStatus(runtimeId, subject));
  if (current.latest_ready && !await pathExists(sourceRoot)) {
    // The provider root was already reclaimed after an earlier archive. A new
    // snapshot would be empty and would displace the real history as the latest
    // archive, so the existing ready archive stays the barrier while the server
    // still holds its bytes.
    const ready = current.latest_ready;
    assertActive();
    const verified = await active(options.client.getSessionArchiveStatus(
      runtimeId,
      subject,
      ready.source_revision,
      ready.sha256,
      forceFreshSnapshot,
    ));
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
    assertActive();
    // Staging lives under the excluded `.multiremi/`. When the collected
    // directory is the archived root itself, creating that entry during the
    // scan would change the root and fail the snapshot, so create it first.
    await mkdir(join(workspaceDir, ".multiremi")).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    assertActive();
    prepared = await prepareSessionArchive(workspaceDir, {
      subject,
      providerRoots: [{ sessionId: basename(sourceRoot), root: sourceRoot }],
      storageBoundary: options.workspacesRoot,
      maxSourceBytes: options.maxSourceBytes,
      assertWritable: assertActive,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
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
    assertActive();
    const status = await active(options.client.getSessionArchiveStatus(
      runtimeId,
      subject,
      prepared.sourceRevision,
      prepared.sha256,
      forceFreshSnapshot,
    ));
    if (status.gc_ready) {
      // Same content is already archived. A newer preparation-failure row
      // would still read as the subject's latest state, so supersede it.
      if (
        status.latest?.source_revision === MULTIREMI_SESSION_ARCHIVE_PREPARATION_FAILURE_REVISION
        && (status.latest.status === "failed" || status.latest.status === "pending")
      ) {
        await active(options.client.initSessionArchive(runtimeId, subject, initInput));
      }
      const archiveId = status.requested_ready?.id;
      return archiveId ? binding(archiveId) : null;
    }
    const initialized = await active(options.client.initSessionArchive(runtimeId, subject, initInput));
    if (initialized.archive.status === "ready") return binding(initialized.archive.id);
    assertActive();
    await active(options.client.uploadSessionArchive(runtimeId, subject, initialized.archive.id, prepared.archivePath, options.signal));
    const completed = await active(options.client.completeSessionArchive(runtimeId, subject, initialized.archive.id));
    return completed.status === "ready" ? binding(completed.id) : null;
  } finally {
    // Cancellation leaves only excluded staging files. The replacement owns
    // the root; this old invocation must not unlink anything after handoff.
    if (!options.signal?.aborted) { assertActive(); await removePreparedSessionArchive(prepared.archivePath); }
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

/** Local retry intent survives restart; uploads never run on task completion's stack. */
export class SubjectSessionArchiveQueue {
  private readonly pending = new Map<string, SubjectSessionArchiveSubject>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private readonly abort = new AbortController();
  constructor(private readonly root: string, private readonly runtimeId: string,
    private readonly assertOwner: () => void,
    private readonly archive: (subject: SubjectSessionArchiveSubject, signal: AbortSignal) => Promise<unknown>,
    private readonly retryMs = 30_000) {
    const runtime = join(root, ".runtime");
    if (!existsSync(runtime)) return;
    this.assertDirectory(root);
    this.assertDirectory(runtime);
    for (const entry of readdirSync(runtime, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]+$/.test(entry.name)) continue;
      const marker = this.marker(entry.name);
      try {
        if (!existsSync(marker)) continue;
        this.assertMarkerParents(entry.name);
        const fd = openSync(marker, constants.O_RDONLY | constants.O_NOFOLLOW);
        let value: { runtimeId?: string; kind?: string; id?: string };
        try { value = JSON.parse(readFileSync(fd, "utf8")); } finally { closeSync(fd); }
        if (value.runtimeId === runtimeId && value.id === entry.name && (value.kind === "task" || value.kind === "chat")) {
          this.pending.set(value.id, { kind: value.kind, id: value.id });
        }
      } catch (error) { log.warn(`Session archive retry marker skipped: ${marker}: ${String(error)}`); }
    }
    this.wake(0);
  }

  private marker(id: string): string { return join(this.root, ".runtime", id, ".multiremi", "archive-pending.json"); }
  private assertDirectory(path: string): void {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe archive retry directory: ${path}`);
  }
  private assertMarkerParents(id: string): void {
    for (const path of [this.root, join(this.root, ".runtime"), join(this.root, ".runtime", id), join(this.root, ".runtime", id, ".multiremi")]) this.assertDirectory(path);
  }

  enqueue(subject: SubjectSessionArchiveSubject): void {
    if (!/^[a-zA-Z0-9_-]+$/.test(subject.id)) throw new Error("invalid archive retry subject");
    this.assertOwner();
    this.assertDirectory(this.root);
    this.assertDirectory(join(this.root, ".runtime"));
    this.assertDirectory(join(this.root, ".runtime", subject.id));
    const metadata = join(this.root, ".runtime", subject.id, ".multiremi");
    if (!existsSync(metadata)) mkdirSync(metadata, { mode: 0o700 });
    this.assertMarkerParents(subject.id);
    const marker = this.marker(subject.id);
    if (!existsSync(marker)) {
      const fd = openSync(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, JSON.stringify({ ...subject, runtimeId: this.runtimeId })); fsyncSync(fd); } finally { closeSync(fd); }
    } else {
      if (!lstatSync(marker).isFile() || lstatSync(marker).isSymbolicLink()) throw new Error("unsafe archive retry marker");
      const fd = openSync(marker, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const value = JSON.parse(readFileSync(fd, "utf8"));
        if (value.runtimeId !== this.runtimeId || value.id !== subject.id || value.kind !== subject.kind) throw new Error("archive retry ownership changed");
      } finally { closeSync(fd); }
    }
    // Re-enqueue during upload retains the durable intent for a new snapshot.
    this.pending.set(subject.id, { ...subject });
    this.wake(0);
  }

  private wake(delay: number): void {
    if (this.stopped || this.running || this.timer || !this.pending.size) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.running = this.pump().finally(() => { this.running = null; this.wake(this.retryMs); });
    }, delay);
    this.timer.unref?.();
  }

  private async pump(): Promise<void> {
    for (const [id, subject] of this.pending) {
      if (this.stopped) break;
      try {
        this.assertOwner();
        if (!existsSync(join(this.root, ".runtime", id))) { this.pending.delete(id); continue; }
        const ready = await this.archive(subject, this.abort.signal);
        if (!this.stopped && ready && this.pending.get(id) === subject) {
          this.assertOwner();
          this.assertMarkerParents(id);
          const marker = this.marker(id);
          const stat = lstatSync(marker);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe archive retry marker");
          unlinkSync(marker);
          this.pending.delete(id);
        }
      } catch (error) { log.warn(`Background Session archive failed for ${subject.kind} ${id}: ${String(error)}`); }
    }
  }

  stop(): void { this.stopped = true; this.abort.abort(); if (this.timer) clearTimeout(this.timer); this.timer = null; }
  async drain(timeoutMs = 5_000): Promise<void> {
    if (!this.running) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([this.running, new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
}
