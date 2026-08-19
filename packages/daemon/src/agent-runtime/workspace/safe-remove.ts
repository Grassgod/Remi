import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const OWNED_DIRECTORY_QUARANTINE = ".multiremi-delete-quarantine";

export interface RemoveOwnedDirectoryOptions {
  /** Process-level ownership fence for the canonical workspace root. */
  assertRootOwner?: () => void;
}

export interface OwnedDirectoryRemovalSupport {
  capability: "available" | "blocked";
  supported: boolean;
  error: string | null;
}

/** Report whether this runtime can perform descriptor-anchored cleanup. */
export function ownedDirectoryRemovalSupport(): OwnedDirectoryRemovalSupport {
  if (process.platform !== "linux") {
    return {
      capability: "blocked",
      supported: false,
      error: `descriptor-safe workspace cleanup is unsupported on ${process.platform}`,
    };
  }
  try {
    const procFd = statSync("/proc/self/fd");
    if (!procFd.isDirectory()) throw new Error("/proc/self/fd is not a directory");
    return { capability: "available", supported: true, error: null };
  } catch (error) {
    return {
      capability: "blocked",
      supported: false,
      error: `descriptor-safe workspace cleanup requires /proc/self/fd: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Remove one daemon-owned directory without ever recursively deleting its
 * original pathname. On Linux the source and quarantine are addressed through
 * held directory descriptors. Platforms without an equivalent descriptor
 * path fail closed before any rename or recursive removal.
 */
export function removeOwnedDirectorySync(
  root: string,
  target: string,
  options: RemoveOwnedDirectoryOptions = {},
): boolean {
  const rootPath = resolve(root);
  const targetPath = resolve(target);
  const rel = relative(rootPath, targetPath);
  if (!rel || rel === "." || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`refusing to remove path outside owned root: ${target}`);
  }
  if (rel.split(sep).includes(OWNED_DIRECTORY_QUARANTINE)) {
    throw new Error(`refusing to remove the owned-directory quarantine: ${target}`);
  }

  options.assertRootOwner?.();
  const rootFd = openRealDirectory(rootPath, "owned root");
  try {
    const rootInfo = fstatSync(rootFd);
    const rootAlias = descriptorDirectoryPath(rootFd, rootInfo);
    if (!rootAlias) {
      throw new Error(
        `descriptor-safe owned directory removal is unavailable on ${process.platform}; refusing to remove ${targetPath}`,
      );
    }
    return removeWithDirectoryDescriptors(rootPath, rootFd, rootAlias, rootInfo, rel, options);
  } finally {
    closeSync(rootFd);
  }
}

/** Complete deletions that crashed after the atomic quarantine rename. */
export function recoverOwnedDirectoryQuarantineSync(
  root: string,
  options: RemoveOwnedDirectoryOptions = {},
): number {
  const rootPath = resolve(root);
  options.assertRootOwner?.();
  const rootFd = openRealDirectory(rootPath, "owned root");
  try {
    const rootInfo = fstatSync(rootFd);
    const rootAlias = descriptorDirectoryPath(rootFd, rootInfo);
    if (!rootAlias) {
      if (pathExists(join(rootPath, OWNED_DIRECTORY_QUARANTINE))) {
        throw new Error(
          `descriptor-safe quarantine recovery is unavailable on ${process.platform}: ${rootPath}`,
        );
      }
      return 0;
    }
    const quarantinePath = join(rootAlias, OWNED_DIRECTORY_QUARANTINE);
    const quarantineFd = openOptionalRealDirectory(quarantinePath, "owned deletion quarantine");
    if (quarantineFd === null) return 0;
    try {
      const quarantineInfo = fstatSync(quarantineFd);
      assertPrivateQuarantine(quarantineInfo, quarantinePath);
      const quarantineAlias = descriptorDirectoryPath(quarantineFd, quarantineInfo);
      if (!quarantineAlias) throw new Error("directory descriptor path unavailable for owned deletion quarantine");
      let recovered = 0;
      for (const entry of readdirSync(quarantineAlias, { withFileTypes: true })) {
        if (!isQuarantineGenerationName(entry.name)) {
          throw new Error(`unexpected entry in owned deletion quarantine: ${entry.name}`);
        }
        const generationPath = join(quarantineAlias, entry.name);
        const generationFd = openRealDirectory(generationPath, "quarantined deletion generation");
        try {
          const generationInfo = fstatSync(generationFd);
          options.assertRootOwner?.();
          assertSameFile(rootInfo, fstatSync(rootFd), "owned root changed during quarantine recovery");
          assertSameFile(quarantineInfo, fstatSync(quarantineFd), "owned deletion quarantine changed");
          assertSameFile(generationInfo, lstatSync(generationPath), "quarantined generation was replaced");
          makeQuarantinedTreeWritable(generationPath);
          assertSameFile(generationInfo, lstatSync(generationPath), "quarantined generation changed during recovery");
          rmSync(generationPath, { recursive: true, force: true });
          recovered++;
        } finally {
          closeSync(generationFd);
        }
      }
      return recovered;
    } finally {
      closeSync(quarantineFd);
    }
  } finally {
    closeSync(rootFd);
  }
}

function removeWithDirectoryDescriptors(
  rootPath: string,
  rootFd: number,
  rootAlias: string,
  rootInfo: Stats,
  relativeTarget: string,
  options: RemoveOwnedDirectoryOptions,
): boolean {
  const segments = relativeTarget.split(sep).filter(Boolean);
  const targetName = segments.pop();
  if (!targetName) throw new Error("owned directory target has no basename");
  const opened: number[] = [];
  let parentAlias = rootAlias;
  try {
    for (const segment of segments) {
      const childFd = openOptionalRealDirectory(join(parentAlias, segment), `owned parent ${segment}`);
      if (childFd === null) return false;
      opened.push(childFd);
      const childInfo = fstatSync(childFd);
      const childAlias = descriptorDirectoryPath(childFd, childInfo);
      if (!childAlias) {
        throw new Error(`directory descriptor path unavailable for ${join(rootPath, ...segments)}`);
      }
      parentAlias = childAlias;
    }

    const sourcePath = join(parentAlias, targetName);
    const targetFd = openOptionalRealDirectory(sourcePath, "owned deletion target");
    if (targetFd === null) return false;
    opened.push(targetFd);
    const targetInfo = fstatSync(targetFd);

    const quarantinePath = ensureQuarantine(rootAlias);
    const quarantineFd = openRealDirectory(quarantinePath, "owned deletion quarantine");
    opened.push(quarantineFd);
    const quarantineInfo = fstatSync(quarantineFd);
    const quarantineAlias = descriptorDirectoryPath(quarantineFd, quarantineInfo);
    if (!quarantineAlias) throw new Error("directory descriptor path unavailable for owned deletion quarantine");
    const quarantinedPath = join(quarantineAlias, quarantineName(targetName));

    options.assertRootOwner?.();
    assertSameFile(rootInfo, fstatSync(rootFd), "owned root changed before quarantine");
    renameSync(sourcePath, quarantinedPath);
    assertSameFile(targetInfo, lstatSync(quarantinedPath), "quarantined directory identity changed");
    assertSameFile(targetInfo, fstatSync(targetFd), "opened deletion target identity changed");
    assertSameFile(rootInfo, fstatSync(rootFd), "owned root changed after quarantine");
    options.assertRootOwner?.();
    assertSameFile(targetInfo, lstatSync(quarantinedPath), "quarantined directory was replaced");
    makeQuarantinedTreeWritable(quarantinedPath);
    assertSameFile(targetInfo, lstatSync(quarantinedPath), "quarantined directory was replaced during cleanup");
    rmSync(quarantinedPath, { recursive: true, force: true });
    return true;
  } finally {
    for (const fd of opened.reverse()) {
      try { closeSync(fd); } catch {}
    }
  }
}

function ensureQuarantine(rootReference: string): string {
  const path = join(rootReference, OWNED_DIRECTORY_QUARANTINE);
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = assertRealDirectory(path, "owned deletion quarantine");
  assertPrivateQuarantine(info, path);
  // The quarantine is daemon-private so no untrusted process can replace a
  // verified entry between identity validation and recursive removal.
  return path;
}

function assertRealDirectory(path: string, label: string): Stats {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${path}`);
  }
  return info;
}

function openRealDirectory(path: string, label: string): number {
  try {
    return openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`${label} must be a real directory: ${path}`, { cause: error });
  }
}

function openOptionalRealDirectory(path: string, label: string): number | null {
  try {
    return openRealDirectory(path, label);
  } catch (error) {
    if (isNotFound((error as Error).cause)) return null;
    throw error;
  }
}

function descriptorDirectoryPath(fd: number, expected: Stats): string | null {
  // Linux procfs permits child lookup below an open directory descriptor.
  // macOS /dev/fd exposes the descriptor itself but not portable openat-style
  // child traversal, so it deliberately uses the quarantine+inode fallback.
  const candidates = process.platform === "linux" ? [`/proc/self/fd/${fd}`] : [];
  for (const candidate of candidates) {
    try {
      const info = statSync(candidate);
      if (info.isDirectory() && sameFile(expected, info)) return candidate;
    } catch {}
  }
  return null;
}

function assertSameFile(expected: Stats, actual: Stats, message: string): void {
  if (!sameFile(expected, actual)) throw new Error(message);
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function quarantineName(targetName: string): string {
  return `${targetName}.${process.pid}.${randomUUID()}.deleting`;
}

function isQuarantineGenerationName(name: string): boolean {
  return /^.+\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.deleting$/.test(name);
}

function assertPrivateQuarantine(info: Stats, path: string): void {
  if ((info.mode & 0o077) !== 0) {
    throw new Error(`owned deletion quarantine must not be accessible by group or other users: ${path}`);
  }
}

function makeQuarantinedTreeWritable(path: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) return;
  if (!info.isDirectory()) {
    chmodSync(path, info.mode | 0o600);
    return;
  }
  chmodSync(path, info.mode | 0o700);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    makeQuarantinedTreeWritable(join(path, entry.name));
  }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}
