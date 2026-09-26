/**
 * Session Archive writer (Issue, Chat and one-shot Task subjects).
 *
 * The container is a standard ZIP (`multiremi.session-archive.v2`) with one
 * member per archived file and a random-access index at the end:
 *
 *   manifest.json            content manifest; its digest is `source_revision`
 *   traces/<task_id>.jsonl   one member per task trace
 *   sessions/<sid>/...       provider-native history, minus the secret list
 *   index.json               offsets, sizes and digests for every member (last)
 *
 * Two hashes, deliberately separate:
 * - `sourceRevision` digests the *content manifest* (paths, sizes, digests), so
 *   it does not change when the container or the compression does. The GC
 *   barrier and the hard-delete barrier key on it and stay valid.
 * - `sha256` is the digest of the finished blob.
 *
 * Traversal is per-level `lstat`. The v1 writer anchored every step through
 * `/proc/self/fd`, which made archiving impossible on macOS; this writer refuses
 * symlinks outright and re-checks dev/ino/size/mtime before and after the scan,
 * with the final member opened `O_NOFOLLOW`. The residual race is the same one
 * safe-remove's path strategy documents: a same-uid process with write access to
 * the session root could swap an ancestor between the lstat and the open, and
 * such a process already has everything the daemon has.
 */

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  SESSION_ARCHIVE_INDEX_MEMBER,
  SESSION_ARCHIVE_MANIFEST_MEMBER,
  SESSION_ARCHIVE_SESSIONS_PREFIX,
  SESSION_ARCHIVE_TRACES_PREFIX,
  SESSION_ARCHIVE_TRACE_SUFFIX,
  SESSION_ARCHIVE_V2_FORMAT,
  type SessionArchiveIndex,
  type SessionArchiveMemberIndexEntry,
  type SessionArchiveSubject,
  type SessionArchiveSubjectKind,
} from "@multiremi/contracts/session-archive.js";
import { ZipStreamWriter, type ZipStreamMember } from "@shared/zip/writer.js";
import { sessionArchiveSourceRevision } from "@shared/session-archive/source-revision.js";
import { createLogger } from "@shared/logger.js";

const log = createLogger("multiremi-session-archive");

const DEFAULT_MAX_SOURCE_BYTES = 512 * 1024 * 1024;
export const ISSUE_SESSION_ARCHIVE_RECEIPT_FILE = "session-archive-receipt.json";
export const SESSION_ARCHIVE_FORMAT = SESSION_ARCHIVE_V2_FORMAT;
/** Directories whose contents never enter an archive. */
const EXCLUDED_FILE_NAMES = new Set([
  ".credentials.json",
  ".claude.json",
  "auth.json",
  "config.toml",
  "credentials.json",
  "settings.json",
]);

const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".agents",
  ".cache",
  ".multiremi",
  "cache",
  "node_modules",
  "plugins",
  "skills",
  "tmp",
]);

export interface SessionArchiveProviderRoot {
  /** Session id (`ises_*` / `chat_*`); becomes the member path segment. */
  sessionId: string;
  /** Absolute provider session root, normally `.runtime/<session_id>`. */
  root: string;
}

export interface PrepareSessionArchiveOptions {
  subject: SessionArchiveSubject;
  /**
   * Subject roots: `.runtime/<session_id>` for Issues and Chats,
   * `.runtime/<task_id>` for a one-shot Task. Each root's `traces/` directory
   * is hoisted to the archive-level `traces/<task_id>.jsonl` members.
   */
  providerRoots?: SessionArchiveProviderRoot[];
  /** Trusted storage boundary every provider root must stay inside. */
  storageBoundary?: string;
  stagingRoot?: string;
  maxSourceBytes?: number;
}

export interface PreparedSessionArchive {
  archivePath: string;
  sourceRevision: string;
  sha256: string;
  sizeBytes: number;
  fileCount: number;
  traceCount: number;
  subject: SessionArchiveSubject;
  metadata: {
    format: typeof SESSION_ARCHIVE_V2_FORMAT;
    subject: SessionArchiveSubject;
    files: Array<{ path: string; size: number; sha256: string }>;
  };
}

/** Legacy v1 receipt/session roots accepted by the Issue wrappers. */
export interface IssueSessionArchiveReceipt {
  version: 1;
  issueId: string;
  sourceRevision: string;
  sha256: string;
  archiveId: string | null;
  archivedAt: string;
}

export interface PrepareIssueSessionArchiveOptions {
  /** Issue id; the subject this archive is written for. */
  issueId: string;
  stagingRoot?: string;
  maxSourceBytes?: number;
  sessionRoots?: Array<{ sessionId: string; root: string }>;
  sessionRootBoundary?: string;
}

interface ScannedFile {
  archivePath: string;
  /** Absolute path of the file on disk. */
  sourcePath: string;
  size: number;
  sha256: string;
  mtimeMs: number;
  dev: number;
  ino: number;
  kind: SessionArchiveMemberIndexEntry["kind"];
  taskId?: string;
}

interface DirectoryIdentity {
  path: string;
  dev: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface ScanSnapshot {
  files: ScannedFile[];
  directories: DirectoryIdentity[];
}

interface ArchiveSource {
  /** Absolute directory to walk. */
  root: string;
  /** Member path prefix for files found below `root`. */
  prefix: string;
  /** `traces/` below this root becomes archive-level `traces/<task>.jsonl`. */
  hoistTraces: boolean;
}

/**
 * Build a deterministic, credential-free archive for one subject.
 *
 * The returned `sourceRevision` identifies the content, not the container: the
 * server compares it against the archive bound to a cleaned workspace, so it
 * must stay stable across compression changes.
 */
export async function prepareSessionArchive(
  workspaceDir: string,
  options: PrepareSessionArchiveOptions,
): Promise<PreparedSessionArchive> {
  const workspaceRoot = resolve(workspaceDir);
  assertSubject(options.subject);
  assertTraversalSupported(process.platform);
  const maxSourceBytes = positiveLimit(options.maxSourceBytes, DEFAULT_MAX_SOURCE_BYTES);
  const sources = resolveArchiveSources(workspaceRoot, options);
  log.debug(`Session archive scan started: subject=${options.subject.kind}:${options.subject.id}`);
  const sourceSnapshot = await scanArchiveEntries(sources, maxSourceBytes);
  const files = sourceSnapshot.files;
  const manifest = {
    format: SESSION_ARCHIVE_V2_FORMAT,
    subject: options.subject,
    files: files.map((file) => ({ path: file.archivePath, size: file.size, sha256: file.sha256 })),
  } as const;
  const sourceRevision = sessionArchiveSourceRevision(manifest);
  log.debug(
    `Session archive source scanned: subject=${options.subject.kind}:${options.subject.id} files=${files.length}`,
  );

  const stagingRoot = resolve(options.stagingRoot ?? join(workspaceRoot, ".multiremi", "archive-spool"));
  assertContained(workspaceRoot, stagingRoot, "archive staging root");
  await ensureRealDirectoryTree(workspaceRoot, stagingRoot, "archive staging root");
  const archivePath = join(stagingRoot, `${options.subject.kind}-${sourceRevision}.zip`);
  const partialPath = `${archivePath}.${process.pid}.${randomUUID()}.partial`;
  await rm(partialPath, { force: true });

  try {
    const written = await writeArchiveMembers({ partialPath, manifest, files });
    log.debug(`Session archive compression finished: subject=${options.subject.kind}:${options.subject.id}`);
    // A file that appeared, grew or was replaced during compression would not
    // match the manifest and the index written into the blob.
    const verifiedSnapshot = await scanArchiveEntries(sources, maxSourceBytes);
    assertSameArchiveSnapshot(sourceSnapshot, verifiedSnapshot);
    await rename(partialPath, archivePath).catch(async (error) => {
      if (!isAlreadyExists(error)) throw error;
      await rm(partialPath, { force: true });
    });
    const archived = await inspectRegularFile(archivePath);
    if (archived.sha256 !== written.sha256 || archived.stats.size !== written.sizeBytes) {
      throw new Error("Session archive changed while it was being written");
    }
    log.debug(`Session archive published locally: subject=${options.subject.kind}:${options.subject.id}`);
    return {
      archivePath,
      sourceRevision,
      sha256: written.sha256,
      sizeBytes: written.sizeBytes,
      fileCount: files.length,
      traceCount: files.filter((file) => file.kind === "trace").length,
      subject: options.subject,
      metadata: { format: SESSION_ARCHIVE_V2_FORMAT, subject: options.subject, files: [...manifest.files] },
    };
  } catch (error) {
    await rm(partialPath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Issue-subject wrapper for the daemon GC path.
 *
 * The Issue's provider roots are its `ises_*` runtime roots, which the daemon
 * enumerates before calling in. Chat and one-shot Task subjects arrive through
 * {@link prepareSessionArchive} once their GC wiring exists.
 */
export async function prepareIssueSessionArchive(
  workspaceDir: string,
  options: PrepareIssueSessionArchiveOptions,
): Promise<PreparedSessionArchive> {
  const workspaceRoot = resolve(workspaceDir);
  if (!nonEmptyString(options.issueId)) {
    throw new Error("Issue session archive requires an Issue id");
  }
  const providerRoots = options.sessionRoots
    ?? await legacyIssueSessionRoots(workspaceRoot);
  return await prepareSessionArchive(workspaceRoot, {
    subject: { kind: "issue", id: options.issueId },
    providerRoots,
    storageBoundary: options.sessionRoots ? options.sessionRootBoundary : workspaceRoot,
    stagingRoot: options.stagingRoot,
    maxSourceBytes: options.maxSourceBytes,
  });
}

/**
 * Pre-`.runtime` Issue workspace layout: `<workspace>/.multiremi/sessions/<id>`.
 * Only used when the daemon has no runtime storage root to enumerate from.
 */
async function legacyIssueSessionRoots(workspaceRoot: string): Promise<SessionArchiveProviderRoot[]> {
  const sessionsRoot = join(workspaceRoot, ".multiremi", "sessions");
  const exists = await assertOptionalRealDirectoryTree(
    workspaceRoot,
    sessionsRoot,
    "Issue session history root",
  );
  if (!exists) return [];
  const roots: SessionArchiveProviderRoot[] = [];
  for (const entry of await readdir(sessionsRoot, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const root = join(sessionsRoot, entry.name);
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Issue Session root must be a real directory: ${root}`);
    }
    roots.push({ sessionId: entry.name, root });
  }
  return roots;
}

function resolveArchiveSources(
  workspaceRoot: string,
  options: PrepareSessionArchiveOptions,
): ArchiveSource[] {
  const sources: ArchiveSource[] = [];
  const providerRoots = [...(options.providerRoots ?? [])].sort((left, right) =>
    stableTextCompare(left.sessionId, right.sessionId)
  );
  if (providerRoots.length) {
    const boundary = resolve(options.storageBoundary ?? "");
    if (!options.storageBoundary) {
      throw new Error("Session archive provider roots require a storage boundary");
    }
    const seen = new Set<string>();
    for (const source of providerRoots) {
      if (!isSafeSegment(source.sessionId)) throw new Error(`Invalid archive Session id: ${source.sessionId}`);
      if (seen.has(source.sessionId)) throw new Error(`Duplicate archive Session root: ${source.sessionId}`);
      seen.add(source.sessionId);
      const root = resolve(source.root);
      const rel = relative(boundary, root);
      if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error(`Archive Session root escapes runtime storage: ${source.root}`);
      }
      sources.push({
        root,
        prefix: `${SESSION_ARCHIVE_SESSIONS_PREFIX}${source.sessionId}`,
        hoistTraces: true,
      });
    }
  }
  return sources;
}

async function scanArchiveEntries(sources: ArchiveSource[], maxBytes: number): Promise<ScanSnapshot> {
  const files: ScannedFile[] = [];
  const directories: DirectoryIdentity[] = [];
  let totalBytes = 0;
  for (const source of sources) {
    let rootInfo: Stats;
    try {
      rootInfo = await lstat(source.root);
    } catch (error) {
      // A subject that has no provider history yet (or no trace file for a
      // task) is a valid, smaller archive. A *present* unsafe root is not.
      if (isNotFound(error)) continue;
      throw error;
    }
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new Error(`Archive source must be a real directory: ${source.root}`);
    }
    totalBytes = await walkArchiveDirectory(source, source.root, "", files, directories, maxBytes, totalBytes);
  }
  return {
    files: files.sort((left, right) => stableTextCompare(left.archivePath, right.archivePath)),
    directories: directories.sort((left, right) => stableTextCompare(left.path, right.path)),
  };
}

/** Scan a directory of `<task_id>.jsonl` files as hoisted trace members. */
async function scanTraceDirectory(
  directory: string,
  files: ScannedFile[],
  maxBytes: number,
  totalBytes: number,
): Promise<number> {
  let total = totalBytes;
  const children = (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => stableTextCompare(left.name, right.name));
  for (const child of children) {
    if (!child.isFile() || child.isSymbolicLink()) continue;
    if (!child.name.endsWith(SESSION_ARCHIVE_TRACE_SUFFIX)) continue;
    const taskId = child.name.slice(0, -SESSION_ARCHIVE_TRACE_SUFFIX.length);
    if (!isSafeSegment(taskId)) continue;
    const sourcePath = join(directory, child.name);
    const info = await lstat(sourcePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Refusing to archive non-regular file: ${sourcePath}`);
    }
    const inspected = await inspectOpenRegularFile(sourcePath, info);
    total += inspected.stats.size;
    if (total > maxBytes) throw new Error(`Archived sources exceed ${maxBytes} bytes`);
    files.push({
      archivePath: `${SESSION_ARCHIVE_TRACES_PREFIX}${taskId}${SESSION_ARCHIVE_TRACE_SUFFIX}`,
      sourcePath,
      size: inspected.stats.size,
      sha256: inspected.sha256,
      mtimeMs: inspected.stats.mtimeMs,
      dev: inspected.stats.dev,
      ino: inspected.stats.ino,
      kind: "trace",
      taskId,
    });
  }
  return total;
}

async function walkArchiveDirectory(
  source: ArchiveSource,
  directory: string,
  archiveDirectory: string,
  files: ScannedFile[],
  directories: DirectoryIdentity[],
  maxBytes: number,
  totalBytes: number,
): Promise<number> {
  let total = totalBytes;
  const before = await lstat(directory);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`Archive source is not a real directory: ${directory}`);
  }
  const children = (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => stableTextCompare(left.name, right.name));
  for (const child of children) {
    if (child.name === "." || child.name === "..") throw new Error("Invalid archive entry name");
    const childArchivePath = archiveDirectory ? `${archiveDirectory}/${child.name}` : child.name;
    assertArchiveRelativePath(childArchivePath);
    if (EXCLUDED_FILE_NAMES.has(child.name)) continue;
    const childPath = join(directory, child.name);
    const info = await lstat(childPath);
    if (info.isSymbolicLink()) {
      throw new Error(`Refusing to archive symlink: ${source.prefix}/${childArchivePath}`);
    }
    if (info.isDirectory()) {
      if (EXCLUDED_DIRECTORY_NAMES.has(child.name)) continue;
      // `<session_root>/traces/` members are hoisted to the archive-level
      // `traces/` prefix so one task maps to one member path.
      if (source.hoistTraces && !archiveDirectory && child.name === "traces") {
        total = await scanTraceDirectory(childPath, files, maxBytes, total);
        continue;
      }
      total = await walkArchiveDirectory(
        source,
        childPath,
        childArchivePath,
        files,
        directories,
        maxBytes,
        total,
      );
      continue;
    }
    if (!info.isFile()) {
      throw new Error(`Refusing to archive non-regular file: ${source.prefix}/${childArchivePath}`);
    }
    const inspected = await inspectOpenRegularFile(childPath, info);
    total += inspected.stats.size;
    if (total > maxBytes) throw new Error(`Archived sources exceed ${maxBytes} bytes`);
    files.push({
      archivePath: `${source.prefix}/${childArchivePath}`,
      sourcePath: childPath,
      size: inspected.stats.size,
      sha256: inspected.sha256,
      mtimeMs: inspected.stats.mtimeMs,
      dev: inspected.stats.dev,
      ino: inspected.stats.ino,
      kind: "provider",
    });
  }
  const after = await lstat(directory);
  if (!sameDirectorySnapshot(before, after)) {
    throw new Error(`Archive directory changed while scanning: ${directory}`);
  }
  directories.push({
    path: archiveDirectory ? `${source.prefix}/${archiveDirectory}` : source.prefix,
    dev: before.dev,
    ino: before.ino,
    mtimeMs: before.mtimeMs,
    ctimeMs: before.ctimeMs,
  });
  return total;
}

interface WriteArchiveInput {
  partialPath: string;
  manifest: {
    format: typeof SESSION_ARCHIVE_V2_FORMAT;
    subject: SessionArchiveSubject;
    files: Array<{ path: string; size: number; sha256: string }>;
  };
  files: ScannedFile[];
}

async function writeArchiveMembers(input: WriteArchiveInput): Promise<{ sha256: string; sizeBytes: number }> {
  const handle = await open(
    input.partialPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  const blobDigest = createHash("sha256");
  let writeFailure: unknown = null;
  const writer = new ZipStreamWriter({
    write: async (chunk) => {
      blobDigest.update(chunk);
      await handle.write(chunk);
    },
  });
  try {
    const manifestBytes = Buffer.from(`${JSON.stringify(input.manifest, null, 2)}\n`, "utf8");
    await writer.addBuffer(SESSION_ARCHIVE_MANIFEST_MEMBER, manifestBytes, digestHex(manifestBytes));
    for (const file of input.files) {
      log.debug(`Session archive member: ${file.archivePath} bytes=${file.size}`);
      await writer.addStream({
        path: file.archivePath,
        size: file.size,
        sha256: file.sha256,
        stream: readMemberBytes(file),
      });
    }
    const indexBytes = Buffer.from(
      `${JSON.stringify(buildArchiveIndex(input.manifest.subject, writer.index), null, 2)}\n`,
      "utf8",
    );
    await writer.addBuffer(SESSION_ARCHIVE_INDEX_MEMBER, indexBytes, digestHex(indexBytes));
    await writer.finish();
    await handle.sync();
    return { sha256: blobDigest.digest("hex"), sizeBytes: writer.bytesWritten };
  } catch (error) {
    writeFailure = error;
    throw error;
  } finally {
    await handle.close().catch((error) => {
      if (!writeFailure) throw error;
    });
  }
}

export function buildArchiveIndex(
  subject: SessionArchiveSubject,
  members: readonly ZipStreamMember[],
): SessionArchiveIndex {
  const entries = members.map((member): SessionArchiveMemberIndexEntry => {
    const kind = member.path === SESSION_ARCHIVE_INDEX_MEMBER
      || member.path === SESSION_ARCHIVE_MANIFEST_MEMBER
      ? "meta"
      : member.path.startsWith(SESSION_ARCHIVE_TRACES_PREFIX)
        ? "trace"
        : "provider";
    const taskId = kind === "trace"
      ? member.path.slice(SESSION_ARCHIVE_TRACES_PREFIX.length, -SESSION_ARCHIVE_TRACE_SUFFIX.length)
      : null;
    return {
      path: member.path,
      kind,
      ...(taskId ? { task_id: taskId } : {}),
      local_header_offset: member.localHeaderOffset,
      data_offset: member.dataOffset,
      compressed_size: member.compressedSize,
      uncompressed_size: member.uncompressedSize,
      sha256: member.sha256,
    };
  });
  return { format: SESSION_ARCHIVE_V2_FORMAT, subject, members: entries };
}

async function* readMemberBytes(file: ScannedFile): AsyncGenerator<Buffer> {
  const handle = await open(file.sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!matchesScannedFile(before, file)) throw archiveEntryChanged(file.archivePath);
    if (file.size > 0) {
      const stream = handle.createReadStream({ autoClose: false, start: 0, end: file.size - 1 });
      for await (const chunk of stream) {
        yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      }
    }
    const after = await handle.stat();
    if (!sameFileSnapshot(before, after)) throw archiveEntryChanged(file.archivePath);
  } finally {
    await handle.close().catch(() => {});
  }
}

async function inspectOpenRegularFile(
  path: string,
  expected?: Stats,
): Promise<{ stats: Stats; sha256: string }> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || (expected && !sameFileSnapshot(expected, before))) {
      throw new Error(`File changed while preparing session archive: ${path}`);
    }
    const hash = createHash("sha256");
    let bytesRead = 0;
    if (before.size > 0) {
      const stream = handle.createReadStream({ autoClose: false, start: 0, end: before.size - 1 });
      for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytesRead += bytes.length;
        if (bytesRead > before.size) throw new Error(`File changed while preparing session archive: ${path}`);
        hash.update(bytes);
      }
    }
    const after = await handle.stat();
    if (bytesRead !== before.size || !sameFileSnapshot(before, after)) {
      throw new Error(`File changed while preparing session archive: ${path}`);
    }
    return { stats: before, sha256: hash.digest("hex") };
  } finally {
    await handle.close().catch(() => {});
  }
}

async function inspectRegularFile(path: string): Promise<{ stats: Stats; sha256: string }> {
  return await inspectOpenRegularFile(path);
}

function assertSameArchiveSnapshot(expected: ScanSnapshot, actual: ScanSnapshot): void {
  const sameFiles = expected.files.length === actual.files.length
    && expected.files.every((file, index) => {
      const candidate = actual.files[index];
      return candidate
        && file.archivePath === candidate.archivePath
        && file.size === candidate.size
        && file.sha256 === candidate.sha256
        && file.mtimeMs === candidate.mtimeMs
        && file.dev === candidate.dev
        && file.ino === candidate.ino;
    });
  const sameDirectories = expected.directories.length === actual.directories.length
    && expected.directories.every((entry, index) => {
      const candidate = actual.directories[index];
      return candidate
        && entry.path === candidate.path
        && entry.dev === candidate.dev
        && entry.ino === candidate.ino
        && entry.mtimeMs === candidate.mtimeMs
        && entry.ctimeMs === candidate.ctimeMs;
    });
  if (!sameFiles || !sameDirectories) {
    throw new Error("Archived sources changed while archiving; retry with a fresh snapshot");
  }
}

/** Read the last server-verified archive digest without touching provider history. */
export async function readIssueSessionArchiveReceipt(
  workspaceDir: string,
): Promise<IssueSessionArchiveReceipt | null> {
  const workspaceRoot = resolve(workspaceDir);
  const receiptPath = join(workspaceRoot, ".multiremi", ISSUE_SESSION_ARCHIVE_RECEIPT_FILE);
  assertContained(workspaceRoot, receiptPath, "archive receipt");
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(receiptPath);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Issue session archive receipt must be a regular file: ${receiptPath}`);
  }
  await ensureRealDirectoryTree(workspaceRoot, dirname(receiptPath), "Issue metadata root");
  try {
    const value = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
    if (
      value.version !== 1
      || !nonEmptyString(value.issue_id)
      || !sha256String(value.source_revision)
      || !sha256String(value.sha256)
      || !(value.archive_id === null || nonEmptyString(value.archive_id))
      || !nonEmptyString(value.archived_at)
    ) return null;
    return {
      version: 1,
      issueId: value.issue_id,
      sourceRevision: value.source_revision,
      sha256: value.sha256,
      archiveId: value.archive_id as string | null,
      archivedAt: value.archived_at,
    };
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/** Atomically remember a digest only after the server reports it ready. */
export async function writeIssueSessionArchiveReceipt(
  workspaceDir: string,
  receipt: Omit<IssueSessionArchiveReceipt, "version" | "archivedAt"> & { archivedAt?: string },
): Promise<void> {
  if (!nonEmptyString(receipt.issueId)) {
    throw new Error("Issue session archive receipt requires an Issue id");
  }
  if (!sha256String(receipt.sourceRevision) || !sha256String(receipt.sha256)) {
    throw new Error("Issue session archive receipt requires SHA-256 digests");
  }
  const workspaceRoot = resolve(workspaceDir);
  const metadataRoot = join(workspaceRoot, ".multiremi");
  await ensureRealDirectoryTree(workspaceRoot, metadataRoot, "Issue metadata root");
  const receiptPath = join(metadataRoot, ISSUE_SESSION_ARCHIVE_RECEIPT_FILE);
  const partialPath = `${receiptPath}.${process.pid}.${randomUUID()}.partial`;
  const payload = {
    version: 1,
    issue_id: receipt.issueId,
    source_revision: receipt.sourceRevision,
    sha256: receipt.sha256,
    archive_id: receipt.archiveId,
    archived_at: receipt.archivedAt ?? new Date().toISOString(),
  };
  try {
    await writeFile(partialPath, `${JSON.stringify(payload, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(partialPath, receiptPath);
  } finally {
    await rm(partialPath, { force: true }).catch(() => {});
  }
}

export async function removePreparedSessionArchive(archivePath: string): Promise<void> {
  await rm(archivePath, { force: true });
  try {
    const parent = dirname(archivePath);
    if ((await readdir(parent)).length === 0) await rm(parent, { recursive: false });
  } catch {
    // A later GC sweep can reuse or remove the spool directory.
  }
}

/**
 * Platforms with a traversal strategy.
 *
 * Every platform uses the same `lstat` walk; Windows is rejected because a
 * junction is not reported as a symlink by `lstat`, so the "no link escapes the
 * session root" guarantee does not hold there.
 */
export function assertTraversalSupported(platform: NodeJS.Platform): void {
  if (platform === "win32") {
    throw new Error(`Secure Session archive traversal is unsupported on ${platform}`);
  }
}

function assertSubject(subject: SessionArchiveSubject): void {
  if (!isSubjectKind(subject.kind)) throw new Error(`Invalid Session archive subject kind: ${subject.kind}`);
  if (!isSafeSegment(subject.id)) throw new Error(`Invalid Session archive subject id: ${subject.id}`);
}

function isSubjectKind(value: unknown): value is SessionArchiveSubjectKind {
  return value === "issue" || value === "chat" || value === "task";
}

function isSafeSegment(value: string): boolean {
  return Boolean(value)
    && value !== "."
    && value !== ".."
    && !value.includes("/")
    && !value.includes("\\")
    && !value.includes("\0");
}

function matchesScannedFile(stats: Stats, file: ScannedFile): boolean {
  return stats.isFile()
    && stats.dev === file.dev
    && stats.ino === file.ino
    && stats.size === file.size
    && stats.mtimeMs === file.mtimeMs;
}

function archiveEntryChanged(path: string): Error {
  return new Error(`Archived file changed while archiving: ${path}`);
}

function sameFileSnapshot(left: Stats, right: Stats): boolean {
  return left.isFile()
    && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function sameDirectorySnapshot(left: Stats, right: Stats): boolean {
  return left.isDirectory()
    && right.isDirectory()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function assertArchiveRelativePath(path: string): void {
  if (!path || path === "." || path === ".." || path.startsWith("../") || isAbsolute(path)) {
    throw new Error(`Invalid archive path: ${JSON.stringify(path)}`);
  }
}

function assertContained(root: string, candidate: string, label: string): void {
  const relativePath = relative(resolve(root), resolve(candidate));
  if (!relativePath || relativePath === ".") return;
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`${label} is outside the session workspace`);
  }
}

async function ensureRealDirectoryTree(root: string, candidate: string, label: string): Promise<void> {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  assertContained(resolvedRoot, resolvedCandidate, label);
  const rootInfo = await lstat(resolvedRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`Session workspace must be a real directory: ${resolvedRoot}`);
  }
  const pathFromRoot = relative(resolvedRoot, resolvedCandidate);
  if (!pathFromRoot || pathFromRoot === ".") return;
  let current = resolvedRoot;
  for (const segment of pathFromRoot.split(sep)) {
    current = join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`${label} must not contain symlinks or non-directories: ${current}`);
    }
  }
}

async function assertOptionalRealDirectoryTree(
  root: string,
  candidate: string,
  label: string,
): Promise<boolean> {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  assertContained(resolvedRoot, resolvedCandidate, label);
  const rootInfo = await lstat(resolvedRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`Session workspace must be a real directory: ${resolvedRoot}`);
  }
  const pathFromRoot = relative(resolvedRoot, resolvedCandidate);
  if (!pathFromRoot || pathFromRoot === ".") return true;
  let current = resolvedRoot;
  for (const segment of pathFromRoot.split(sep)) {
    current = join(current, segment);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(current);
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`${label} must not contain symlinks or non-directories: ${current}`);
    }
  }
  return true;
}

function digestHex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableTextCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : fallback;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function sha256String(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST";
}
