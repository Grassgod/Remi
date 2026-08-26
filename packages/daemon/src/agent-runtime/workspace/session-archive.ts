import { createHash, randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { createLogger } from "@shared/logger.js";

const log = createLogger("multiremi-session-archive");

const TAR_BLOCK_SIZE = 512;
const DEFAULT_MAX_SOURCE_BYTES = 512 * 1024 * 1024;
const ARCHIVE_FORMAT = "multiremi.issue-sessions.v1";
export const ISSUE_SESSION_ARCHIVE_RECEIPT_FILE = "session-archive-receipt.json";

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
  "cache",
  "node_modules",
  "plugins",
  "skills",
  "tmp",
]);

export interface IssueSessionArchiveEntry {
  path: string;
  size: number;
  sha256: string;
  mtimeMs: number;
  dev: number;
  ino: number;
}

interface IssueSessionArchiveDirectorySnapshot {
  path: string;
  dev: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface IssueSessionArchiveSnapshot {
  files: IssueSessionArchiveEntry[];
  directories: IssueSessionArchiveDirectorySnapshot[];
}

export interface PreparedIssueSessionArchive {
  archivePath: string;
  sourceRevision: string;
  sha256: string;
  sizeBytes: number;
  fileCount: number;
  metadata: {
    format: typeof ARCHIVE_FORMAT;
    files: Array<Pick<IssueSessionArchiveEntry, "path" | "size" | "sha256">>;
  };
}

export interface PrepareIssueSessionArchiveOptions {
  stagingRoot?: string;
  maxSourceBytes?: number;
}

export interface IssueSessionArchiveReceipt {
  version: 1;
  issueId: string;
  sourceRevision: string;
  sha256: string;
  archiveId: string | null;
  archivedAt: string;
}

/** Build a deterministic, credential-free archive of provider-native Issue history. */
export async function prepareIssueSessionArchive(
  workspaceDir: string,
  options: PrepareIssueSessionArchiveOptions = {},
): Promise<PreparedIssueSessionArchive> {
  const workspaceRoot = resolve(workspaceDir);
  log.debug(`Issue Session archive started: ${workspaceRoot}`);
  const sessionsRoot = join(workspaceRoot, ".multiremi", "sessions");
  const maxSourceBytes = positiveLimit(options.maxSourceBytes, DEFAULT_MAX_SOURCE_BYTES);
  const sessionsExist = await assertOptionalRealDirectoryTree(
    workspaceRoot,
    sessionsRoot,
    "Issue session history root",
  );
  log.debug(`Issue Session archive root checked: ${workspaceRoot} exists=${sessionsExist}`);
  assertSessionArchiveTraversalSupported();
  const sourceSnapshot = await scanArchiveEntries(workspaceRoot, maxSourceBytes, !sessionsExist);
  log.debug(`Issue Session archive source scanned: ${workspaceRoot} files=${sourceSnapshot.files.length}`);
  const entries = sourceSnapshot.files;
  const metadata = {
    format: ARCHIVE_FORMAT,
    files: entries.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
  } as const;
  const manifest = `${JSON.stringify(metadata, null, 2)}\n`;
  const sourceRevision = createHash("sha256").update(JSON.stringify(metadata)).digest("hex");
  const stagingRoot = resolve(options.stagingRoot ?? join(workspaceRoot, ".multiremi", "archive-spool"));
  assertContained(workspaceRoot, stagingRoot, "archive staging root");
  await ensureRealDirectoryTree(workspaceRoot, stagingRoot, "archive staging root");
  log.debug(`Issue Session archive staging ready: ${workspaceRoot}`);
  const archivePath = join(stagingRoot, `${sourceRevision}.tar.gz`);
  const partialPath = `${archivePath}.${process.pid}.${randomUUID()}.partial`;

  await rm(partialPath, { force: true });
  try {
    log.debug(`Issue Session archive compression started: ${workspaceRoot}`);
    await pipeline(
      Readable.from(tarStream(workspaceRoot, entries, manifest)),
      createGzip({ level: 6 }),
      createWriteStream(partialPath, { flags: "wx", mode: 0o600 }),
    );
    log.debug(`Issue Session archive compression finished: ${workspaceRoot}`);
    const verifiedSnapshot = await scanArchiveEntries(workspaceRoot, maxSourceBytes, !sessionsExist);
    log.debug(`Issue Session archive verification scan finished: ${workspaceRoot}`);
    assertSameArchiveSnapshot(sourceSnapshot, verifiedSnapshot);
    await rename(partialPath, archivePath).catch(async (error) => {
      if (!isAlreadyExists(error)) throw error;
      await rm(partialPath, { force: true });
    });
    log.debug(`Issue Session archive published locally: ${workspaceRoot}`);
    const archived = await inspectRegularFile(archivePath);
    log.debug(`Issue Session archive digest verified: ${workspaceRoot}`);
    return {
      archivePath,
      sourceRevision,
      sha256: archived.sha256,
      sizeBytes: archived.stats.size,
      fileCount: entries.length,
      metadata,
    };
  } catch (error) {
    await rm(partialPath, { force: true }).catch(() => {});
    throw error;
  }
}

/** Read the last server-verified archive digest without touching provider history. */
export async function readIssueSessionArchiveReceipt(workspaceDir: string): Promise<IssueSessionArchiveReceipt | null> {
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
      archiveId: value.archive_id,
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
  if (!nonEmptyString(receipt.issueId)) throw new Error("Issue session archive receipt requires an Issue id");
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

export async function removePreparedIssueSessionArchive(archivePath: string): Promise<void> {
  await rm(archivePath, { force: true });
  try {
    const parent = dirname(archivePath);
    if ((await readdir(parent)).length === 0) await rm(parent, { recursive: false });
  } catch {
    // A later GC sweep can reuse or remove the spool directory.
  }
}

async function scanArchiveEntries(
  workspaceRoot: string,
  maxBytes: number,
  optionalRoot: boolean,
): Promise<IssueSessionArchiveSnapshot> {
  const root = await openWorkspaceDirectory(workspaceRoot, [".multiremi", "sessions"], optionalRoot);
  if (!root) return { files: [], directories: [] };

  const files: IssueSessionArchiveEntry[] = [];
  const directories: IssueSessionArchiveDirectorySnapshot[] = [];
  let totalBytes = 0;
  const visit = async (directory: FileHandle, archiveDirectory: string): Promise<void> => {
    const before = await directory.stat();
    if (!before.isDirectory()) throw new Error("Issue session history contains a non-directory parent");
    const children = (await readdir(fileHandlePath(directory), { withFileTypes: true }))
      .sort((left, right) => stableTextCompare(left.name, right.name));
    for (const child of children) {
      if (child.name === "." || child.name === "..") throw new Error("Invalid archive entry name");
      const archivePath = archiveDirectory ? `${archiveDirectory}/${child.name}` : child.name;
      assertArchiveRelativePath(archivePath);
      // Session homes intentionally link provider credentials from the user's
      // base Home. Exclude known secret/config names without opening or
      // following them; unexpected symlinks still fail closed below.
      if (EXCLUDED_FILE_NAMES.has(child.name)) continue;
      let handle: FileHandle | null = null;
      try {
        handle = await openFileHandleChild(directory, child.name);
        const info = await handle.stat();
        if (info.isDirectory()) {
          if (!EXCLUDED_DIRECTORY_NAMES.has(child.name)) await visit(handle, archivePath);
          continue;
        }
        if (!info.isFile()) throw new Error(`Refusing to archive non-regular file: ${archivePath}`);
        log.debug(`Issue Session archive scanning file: ${archivePath} bytes=${info.size}`);
        const inspected = await inspectOpenRegularFile(handle, archivePath, info);
        log.debug(`Issue Session archive scanned file: ${archivePath}`);
        totalBytes += inspected.stats.size;
        if (totalBytes > maxBytes) throw new Error(`Issue session history exceeds ${maxBytes} bytes`);
        files.push({
          path: archivePath,
          size: inspected.stats.size,
          sha256: inspected.sha256,
          mtimeMs: inspected.stats.mtimeMs,
          dev: inspected.stats.dev,
          ino: inspected.stats.ino,
        });
      } catch (error) {
        if (isSymlinkOpenError(error)) throw new Error(`Refusing to archive symlink: ${archivePath}`);
        throw error;
      } finally {
        await handle?.close().catch(() => {});
      }
    }
    const after = await directory.stat();
    if (!sameDirectorySnapshot(before, after)) {
      throw new Error(`Issue session directory changed while preparing archive: ${archiveDirectory || "."}`);
    }
    directories.push({
      path: archiveDirectory || ".",
      dev: before.dev,
      ino: before.ino,
      mtimeMs: before.mtimeMs,
      ctimeMs: before.ctimeMs,
    });
  };
  try {
    await visit(root, "");
  } finally {
    await root.close().catch(() => {});
  }
  return {
    files: files.sort((left, right) => stableTextCompare(left.path, right.path)),
    directories: directories.sort((left, right) => stableTextCompare(left.path, right.path)),
  };
}

async function* tarStream(
  workspaceRoot: string,
  entries: IssueSessionArchiveEntry[],
  manifest: string,
): AsyncGenerator<Buffer> {
  const manifestBytes = Buffer.from(manifest, "utf8");
  yield* tarEntryHeader("manifest.json", manifestBytes.length, 0o600);
  yield manifestBytes;
  yield padding(manifestBytes.length);

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    const tarPath = `sessions/${entry.path}`;
    yield* tarEntryHeader(tarPath, entry.size, 0o600, index);
    let handle: FileHandle | null = null;
    try {
      handle = await openWorkspaceFile(
        workspaceRoot,
        [".multiremi", "sessions", ...entry.path.split("/")],
      );
      const before = await handle.stat();
      if (!matchesArchiveEntry(before, entry)) throw archiveEntryChanged(entry.path);
      const hash = createHash("sha256");
      let bytesRead = 0;
      if (entry.size > 0) {
        const stream = handle.createReadStream({
          autoClose: false,
          start: 0,
          end: entry.size - 1,
        });
        for await (const chunk of stream) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytesRead += bytes.length;
          if (bytesRead > entry.size) throw archiveEntryChanged(entry.path);
          hash.update(bytes);
          yield bytes;
        }
      }
      if (bytesRead !== entry.size || hash.digest("hex") !== entry.sha256) {
        throw archiveEntryChanged(entry.path);
      }
      const after = await handle.stat();
      if (!sameFileSnapshot(before, after)) throw archiveEntryChanged(entry.path);
    } catch (error) {
      if (isUnsafeParentOpenError(error)) {
        throw new Error(`Refusing to archive symlink or non-directory parent: ${entry.path}`);
      }
      throw error;
    } finally {
      await handle?.close().catch(() => {});
    }
    yield padding(entry.size);
  }
  yield Buffer.alloc(TAR_BLOCK_SIZE * 2);
}

function* tarEntryHeader(path: string, size: number, mode: number, index = 0): Generator<Buffer> {
  const pathBytes = Buffer.byteLength(path, "utf8");
  if (pathBytes > 100) {
    const pax = Buffer.from(paxRecord("path", path), "utf8");
    yield createTarHeader(`PaxHeaders/${index}`, pax.length, 0o600, "x");
    yield pax;
    yield padding(pax.length);
    yield createTarHeader(`entry-${index}`, size, mode, "0");
    return;
  }
  yield createTarHeader(path, size, mode, "0");
}

function createTarHeader(path: string, size: number, mode: number, type: "0" | "x"): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  writeTarText(header, 0, 100, path);
  writeTarOctal(header, 100, 8, mode);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write("multiremi", 265, 10, "ascii");
  header.write("multiremi", 297, 10, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const encoded = checksum.toString(8).padStart(6, "0");
  header.write(encoded, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function writeTarText(buffer: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw new Error(`Tar field is too long: ${value}`);
  bytes.copy(buffer, offset);
}

function writeTarOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid tar number: ${value}`);
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length >= length) throw new Error(`Tar number is too large: ${value}`);
  buffer.write(encoded, offset, length - 1, "ascii");
  buffer[offset + length - 1] = 0;
}

function paxRecord(key: string, value: string): string {
  const body = `${key}=${value}\n`;
  let length = Buffer.byteLength(body, "utf8") + 3;
  while (true) {
    const record = `${length} ${body}`;
    const actual = Buffer.byteLength(record, "utf8");
    if (actual === length) return record;
    length = actual;
  }
}

function padding(size: number): Buffer {
  const remainder = size % TAR_BLOCK_SIZE;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(TAR_BLOCK_SIZE - remainder);
}

function assertSameArchiveSnapshot(
  expected: IssueSessionArchiveSnapshot,
  actual: IssueSessionArchiveSnapshot,
): void {
  const sameFiles = expected.files.length === actual.files.length
    && expected.files.every((entry, index) => {
      const candidate = actual.files[index];
      return candidate
        && entry.path === candidate.path
        && entry.size === candidate.size
        && entry.sha256 === candidate.sha256
        && entry.mtimeMs === candidate.mtimeMs
        && entry.dev === candidate.dev
        && entry.ino === candidate.ino;
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
    throw new Error("Issue session history changed while archiving; retry with a fresh snapshot");
  }
}

async function openWorkspaceDirectory(
  workspaceRoot: string,
  segments: string[],
  optional = false,
): Promise<FileHandle | null> {
  let current = await openDirectoryNoFollow(resolve(workspaceRoot));
  try {
    for (const segment of segments) {
      let next: FileHandle;
      try {
        next = await openDirectoryChild(current, segment);
      } catch (error) {
        if (optional && isNotFound(error)) {
          await current.close();
          return null;
        }
        throw error;
      }
      await current.close();
      current = next;
    }
    return current;
  } catch (error) {
    await current.close().catch(() => {});
    throw error;
  }
}

async function openWorkspaceFile(workspaceRoot: string, segments: string[]): Promise<FileHandle> {
  if (segments.length === 0) throw new Error("Archive entry path is empty");
  const fileName = segments[segments.length - 1]!;
  const directory = await openWorkspaceDirectory(workspaceRoot, segments.slice(0, -1));
  if (!directory) throw new Error("Archive entry parent does not exist");
  try {
    const handle = await openFileHandleChild(directory, fileName);
    const info = await handle.stat();
    if (!info.isFile()) {
      await handle.close();
      throw new Error(`Refusing to archive non-regular file: ${segments.join("/")}`);
    }
    return handle;
  } finally {
    await directory.close().catch(() => {});
  }
}

async function openDirectoryNoFollow(path: string): Promise<FileHandle> {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  const info = await handle.stat();
  if (!info.isDirectory()) {
    await handle.close();
    throw new Error(`Expected a real directory: ${path}`);
  }
  return handle;
}

async function openDirectoryChild(parent: FileHandle, name: string): Promise<FileHandle> {
  const handle = await openFileHandleChild(parent, name, constants.O_DIRECTORY ?? 0);
  const info = await handle.stat();
  if (!info.isDirectory()) {
    await handle.close();
    throw new Error(`Issue session history parent is not a directory: ${name}`);
  }
  return handle;
}

async function openFileHandleChild(parent: FileHandle, name: string, extraFlags = 0): Promise<FileHandle> {
  assertPathSegment(name);
  return open(
    `${fileHandlePath(parent)}/${name}`,
    constants.O_RDONLY
      | (constants.O_NOFOLLOW ?? 0)
      | (constants.O_NONBLOCK ?? 0)
      | extraFlags,
  );
}

function fileHandlePath(handle: FileHandle): string {
  return resolveSessionArchiveFileDescriptorPath(handle.fd);
}

export function resolveSessionArchiveFileDescriptorPath(
  descriptor: number,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!Number.isSafeInteger(descriptor) || descriptor < 0) {
    throw new Error(`Invalid session archive file descriptor: ${descriptor}`);
  }
  if (platform === "linux") return `/proc/self/fd/${descriptor}`;
  throw new Error(`Secure Issue session archive traversal is unsupported on ${platform}`);
}

function assertSessionArchiveTraversalSupported(): void {
  resolveSessionArchiveFileDescriptorPath(0);
}

function assertPathSegment(value: string): void {
  if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\0")) {
    throw new Error(`Invalid archive path segment: ${JSON.stringify(value)}`);
  }
}

async function inspectOpenRegularFile(
  handle: FileHandle,
  path: string,
  expected?: Stats,
): Promise<{ stats: Stats; sha256: string }> {
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
}

async function inspectRegularFile(path: string, expected?: Stats): Promise<{ stats: Stats; sha256: string }> {
  let handle: FileHandle | null = null;
  try {
    handle = await openNoFollow(path);
    return await inspectOpenRegularFile(handle, path, expected);
  } catch (error) {
    if (isSymlinkOpenError(error)) throw new Error(`Refusing to archive symlink: ${path}`);
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function openNoFollow(path: string): Promise<FileHandle> {
  return open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
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

function matchesArchiveEntry(stats: Stats, entry: IssueSessionArchiveEntry): boolean {
  return stats.isFile()
    && stats.dev === entry.dev
    && stats.ino === entry.ino
    && stats.size === entry.size
    && stats.mtimeMs === entry.mtimeMs;
}

function archiveEntryChanged(path: string): Error {
  return new Error(`Issue session file changed while archiving: ${path}`);
}

function isSymlinkOpenError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ELOOP";
}

function isUnsafeParentOpenError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && ["ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
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
    throw new Error(`${label} is outside the Issue workspace`);
  }
}

async function ensureRealDirectoryTree(root: string, candidate: string, label: string): Promise<void> {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  assertContained(resolvedRoot, resolvedCandidate, label);
  const rootInfo = await lstat(resolvedRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`Issue workspace must be a real directory: ${resolvedRoot}`);
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

async function assertOptionalRealDirectoryTree(root: string, candidate: string, label: string): Promise<boolean> {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  assertContained(resolvedRoot, resolvedCandidate, label);
  const rootInfo = await lstat(resolvedRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`Issue workspace must be a real directory: ${resolvedRoot}`);
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

function slashPath(path: string): string {
  return path.split(sep).join("/");
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
