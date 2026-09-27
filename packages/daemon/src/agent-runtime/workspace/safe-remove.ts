/**
 * Anchored removal of daemon-owned directories.
 *
 * Linux addresses everything below the owned root through `/proc/self/fd/<fd>`,
 * where the kernel resolves each step from a held descriptor and no pathname
 * component can be swapped underneath the sweep. macOS has no equivalent and
 * Bun ships no `openat`/`renameat` binding, so darwin uses a second strategy
 * described below. Both strategies share the same state machine: the directory
 * is opened and verified, renamed into a daemon-private quarantine under a
 * `.pending` name, re-verified against the descriptor opened before the rename,
 * promoted to `.deleting` only after that proof, and only then removed.
 *
 * Path-anchored removal (darwin). Every step below the owned root is addressed
 * by absolute path and re-verified by dev/ino against a held descriptor. Three
 * windows remain, each only a few syscalls wide:
 * 1. *Ancestor swap*: between the pre-rename re-check and `rename(2)`, an
 *    ancestor of the target may be replaced by a symlink. The post-rename
 *    identity check guarantees the inode that landed in quarantine is the
 *    directory verified below the owned root; a mismatch aborts without
 *    deleting and restores the entry. The worst case is deleting the intended
 *    inode through a linked ancestor.
 * 2. *Quarantine parent swap*: `<root>/.multiremi-delete-quarantine` may be
 *    replaced between its validation and the rename or the recursive rm. The
 *    post-rename check on the quarantine's identity closes the rename half; the
 *    rm half requires the attacker to pre-create our random UUID name under the
 *    replacement.
 * 3. *Recursive rm traversal*: `rmSync` walks by path below the anchor on both
 *    platforms; it never follows symlinks, so only a bind mount (root-only)
 *    could redirect it.
 *
 * Every residual requires a process running as the same uid with write access
 * to the workspace root, racing inside those windows. Such a process already
 * has everything the daemon has (it can `rm -rf` the root or replace the daemon
 * binary), so anchoring would not deny it any capability. The fences this
 * module exists for are preserved unchanged: the supervisor lease plus dev/ino
 * identity checks against the daemon's own concurrent instances and stale
 * paths, and the 0700 quarantine against other uids.
 *
 * The quarantine name carries the verification bit across crashes. An entry
 * enters as `<name>.<pid>.<uuid>.pending` and becomes
 * `<name>.<pid>.<uuid>.deleting` only after the directory in the quarantine was
 * proven identical to the inode opened below the owned root. Recovery deletes
 * `.deleting` entries only; `.pending` bytes and unrecognized names are
 * reported and left for an operator, never deleted blindly and never allowed to
 * stall the rest of the sweep.
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const OWNED_DIRECTORY_QUARANTINE = ".multiremi-delete-quarantine";

/**
 * How a platform addresses the directories it is about to delete: through held
 * directory descriptors (Linux `/proc/self/fd`) or by re-verified path.
 */
type RemovalStrategy = "descriptor" | "path";

type QuarantineStage = "pending" | "deleting";

interface QuarantineGeneration {
  /** Entry name as it appears inside the quarantine directory. */
  entryName: string;
  /** Original directory basename with the generation suffix removed. */
  originalName: string;
  stage: QuarantineStage;
}

interface OpenedAnchor {
  /** Path used to address the verified directory. */
  path: string;
  fd: number;
  info: Stats;
}

export interface RemoveOwnedDirectoryOptions {
  /** Process-level ownership fence for the canonical workspace root. */
  assertRootOwner?: () => void;
  /**
   * Addressing strategy override; defaults to `process.platform`. Injecting
   * `"darwin"` lets the Linux test runner exercise the path-anchored branch.
   */
  platform?: NodeJS.Platform;
  /** Reports one quarantine entry a recovery sweep could not reclaim. */
  onError?: (path: string, error: unknown) => void;
}

export interface OwnedDirectoryRemovalSupport {
  capability: "available" | "blocked";
  supported: boolean;
  error: string | null;
}

export interface OwnedDirectoryQuarantineRecovery {
  /** Quarantined directories whose recursive removal completed. */
  recovered: number;
  /** Original basenames still occupying the quarantine, for outbox gating. */
  retained: string[];
}

/** Report whether this runtime can perform anchored workspace cleanup. */
export function ownedDirectoryRemovalSupport(
  platform: NodeJS.Platform = process.platform,
): OwnedDirectoryRemovalSupport {
  const strategy = removalStrategy(platform);
  if (!strategy) {
    return {
      capability: "blocked",
      supported: false,
      error: `safe workspace cleanup is unsupported on ${platform}`,
    };
  }
  if (strategy === "path") return { capability: "available", supported: true, error: null };
  try {
    const procFd = statSync("/proc/self/fd");
    if (!procFd.isDirectory()) throw new Error("/proc/self/fd is not a directory");
    return { capability: "available", supported: true, error: null };
  } catch (error) {
    return {
      capability: "blocked",
      supported: false,
      error: `descriptor-safe workspace cleanup requires /proc/self/fd: ${errorMessage(error)}`,
    };
  }
}

/**
 * Remove one daemon-owned directory without ever recursively deleting its
 * original pathname. The directory is renamed into a 0700 quarantine below the
 * owned root, proven identical to the inode opened before the rename, and only
 * then removed. A platform without an addressing strategy fails closed before
 * any rename or recursive removal.
 */
export function removeOwnedDirectorySync(
  root: string,
  target: string,
  options: RemoveOwnedDirectoryOptions = {},
): boolean {
  const platform = options.platform ?? process.platform;
  const strategy = removalStrategy(platform);
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
    if (!strategy) {
      throw new Error(
        `safe owned directory removal is unsupported on ${platform}; refusing to remove ${targetPath}`,
      );
    }
    const prepared = prepareRemoval(rootPath, rootFd, rootInfo, rel, strategy, platform);
    if (prepared === null) return false;
    try {
      return quarantineAndRemove(prepared, options);
    } finally {
      prepared.close();
    }
  } finally {
    closeSync(rootFd);
  }
}

/**
 * Complete deletions that crashed after the quarantine rename.
 *
 * Only `.deleting` entries were proven identical to a directory the daemon had
 * verified below the owned root, so only those are reclaimed. `.pending` bytes,
 * unrelated names, and entries whose removal failed are reported and left in
 * place: they must not break the rest of the sweep, and they must never be
 * deleted without proof.
 */
export function recoverOwnedDirectoryQuarantineSync(
  root: string,
  options: RemoveOwnedDirectoryOptions = {},
): OwnedDirectoryQuarantineRecovery {
  const platform = options.platform ?? process.platform;
  const strategy = removalStrategy(platform);
  const rootPath = resolve(root);
  options.assertRootOwner?.();
  const rootFd = openRealDirectory(rootPath, "owned root");
  try {
    const rootInfo = fstatSync(rootFd);
    const quarantinePath = join(rootPath, OWNED_DIRECTORY_QUARANTINE);
    if (!strategy) {
      if (pathExists(quarantinePath)) {
        throw new Error(`safe quarantine recovery is unsupported on ${platform}: ${rootPath}`);
      }
      return { recovered: 0, retained: [] };
    }
    const quarantine = openRecoveryQuarantine(
      rootPath,
      rootFd,
      rootInfo,
      quarantinePath,
      strategy,
      platform,
    );
    if (quarantine === null) return { recovered: 0, retained: [] };
    try {
      return recoverQuarantineEntries(quarantine, options);
    } finally {
      quarantine.close();
    }
  } finally {
    closeSync(rootFd);
  }
}

interface PreparedRemoval {
  strategy: RemovalStrategy;
  /** Path addressing the verified directory below its owned parent. */
  sourcePath: string;
  targetFd: number;
  targetInfo: Stats;
  /** Path addressing the verified quarantine (and its held descriptor). */
  quarantinePath: string;
  quarantineInfo: Stats;
  /**
   * Re-checks every held anchor including the source path; called immediately
   * before the quarantine rename.
   */
  verifyAnchors: () => void;
  /**
   * Re-checks the containers and the quarantined inode after the rename, when
   * the original source pathname is expected to be gone.
   */
  verifyQuarantine: () => void;
  close: () => void;
}

interface OpenedQuarantine extends OpenedAnchor {
  verifyAnchors: () => void;
  close: () => void;
  /** Path used to address entries inside the quarantine. */
  reference: string;
}

function prepareRemoval(
  rootPath: string,
  rootFd: number,
  rootInfo: Stats,
  relativeTarget: string,
  strategy: RemovalStrategy,
  platform: NodeJS.Platform,
): PreparedRemoval | null {
  const segments = relativeTarget.split(sep).filter(Boolean);
  const targetName = segments.pop();
  if (!targetName) throw new Error("owned directory target has no basename");
  const opened: OpenedAnchor[] = [];
  const close = () => {
    for (const anchor of [...opened].reverse()) {
      try { closeSync(anchor.fd); } catch {}
    }
  };
  // A missing target or ancestor is an ordinary outcome, not a failure, so the
  // descriptors opened on the way there must be released on every exit path.
  let handedOff = false;
  try {
    const ancestorNames = segments;
    const ancestors: OpenedAnchor[] = [];
    let parentReference = rootPath;
    if (strategy === "descriptor") {
      const rootAlias = descriptorDirectoryPath(rootFd, rootInfo, platform);
      if (!rootAlias) {
        throw new Error(
          `descriptor-safe owned directory removal requires /proc/self/fd on ${platform}; refusing to remove ${relativeTarget}`,
        );
      }
      parentReference = rootAlias;
    }
    for (const segment of ancestorNames) {
      const candidatePath = join(parentReference, segment);
      const anchor = strategy === "descriptor"
        // `/proc/self/fd/<fd>/child` keeps the lookup anchored to the held fd.
        ? openDescriptorChild(candidatePath, `owned parent ${segment}`, platform)
        : openAnchoredDirectory(candidatePath, `owned parent ${segment}`);
      if (anchor === null) return null;
      opened.push(anchor);
      ancestors.push(anchor);
      parentReference = anchor.path;
    }

    const sourcePath = join(parentReference, targetName);
    const target = strategy === "descriptor"
      ? openDescriptorChild(sourcePath, "owned deletion target", platform)
      : openAnchoredDirectory(sourcePath, "owned deletion target");
    if (target === null) return null;
    opened.push(target);

    const quarantine = strategy === "descriptor"
      ? openDescriptorQuarantine(rootPath, rootFd, rootInfo, platform)
      : openPathQuarantine(rootPath);
    opened.push({ path: quarantine.path, fd: quarantine.fd, info: quarantine.info });

    const verifyDescriptorContainers = () => {
      assertSameFile(rootInfo, fstatSync(rootFd), "owned root changed during removal");
      for (const anchor of ancestors) {
        assertSameFile(anchor.info, fstatSync(anchor.fd), "owned parent descriptor changed");
        assertSameFile(anchor.info, statSync(anchor.path), "owned parent was replaced");
      }
      assertSameFile(target.info, fstatSync(target.fd), "opened deletion target identity changed");
      assertSameFile(quarantine.info, fstatSync(quarantine.fd), "owned deletion quarantine changed");
      assertSameFile(quarantine.info, statSync(quarantine.path), "owned deletion quarantine was replaced");
    };
    const verifyPathContainers = () => {
      assertRealDirectoryPath(rootPath, rootInfo, "owned root");
      for (const anchor of ancestors) {
        assertRealDirectoryPath(anchor.path, anchor.info, "owned parent");
        assertSameFile(anchor.info, fstatSync(anchor.fd), "owned parent descriptor changed");
      }
      assertSameFile(target.info, fstatSync(target.fd), "opened deletion target identity changed");
      assertRealDirectoryPath(quarantine.path, quarantine.info, "owned deletion quarantine");
    };
    handedOff = true;
    return {
      strategy,
      sourcePath: join(parentReference, targetName),
      targetFd: target.fd,
      targetInfo: target.info,
      quarantinePath: quarantine.path,
      quarantineInfo: quarantine.info,
      verifyAnchors: strategy === "descriptor"
        ? () => {
          verifyDescriptorContainers();
          assertSameFile(target.info, statSync(target.path), "owned deletion target was replaced");
        }
        : () => {
          verifyPathContainers();
          assertRealDirectoryPath(sourcePath, target.info, "owned deletion target");
        },
      verifyQuarantine: strategy === "descriptor"
        ? verifyDescriptorContainers
        : verifyPathContainers,
      close,
    };
  } finally {
    if (!handedOff) close();
  }
}

/**
 * The shared state machine: rename into `.pending`, prove the inode that landed
 * in the quarantine, promote to `.deleting`, and only then remove it.
 */
function quarantineAndRemove(
  prepared: PreparedRemoval,
  options: RemoveOwnedDirectoryOptions,
): boolean {
  const { strategy, sourcePath, targetFd, targetInfo, quarantinePath, quarantineInfo } = prepared;
  // `/proc/self/fd/N` is a procfs magic link, so a descriptor anchor is
  // re-checked with `stat` while a path anchor is re-checked with `lstat`.
  const anchorStat = strategy === "descriptor" ? statSync : lstatSync;
  const names = quarantineGenerationNames(baseName(sourcePath));
  const pendingPath = join(quarantinePath, names.pending);
  const deletingPath = join(quarantinePath, names.deleting);

  options.assertRootOwner?.();
  prepared.verifyAnchors();
  // A cross-parent directory rename updates '..' and needs owner write access
  // on BSD kernels. Change only the verified target until it is quarantined.
  fchmodSync(targetFd, targetInfo.mode | 0o700);
  try {
    renameSync(sourcePath, pendingPath);
  } catch (error) {
    try {
      fchmodSync(targetFd, targetInfo.mode);
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], "quarantine rename and target mode restoration failed");
    }
    throw error;
  }

  let promoted = false;
  try {
    assertSameFile(quarantineInfo, anchorStat(quarantinePath), "owned deletion quarantine was replaced");
    assertSameFile(targetInfo, lstatSync(pendingPath), "quarantined directory identity changed");
    assertSameFile(targetInfo, fstatSync(targetFd), "opened deletion target identity changed");
    // Only a directory proven identical to the inode opened below the owned
    // root may carry the `.deleting` name that recovery is allowed to delete.
    renameSync(pendingPath, deletingPath);
    promoted = true;
    assertSameFile(targetInfo, lstatSync(deletingPath), "quarantined directory was replaced");
  } catch (error) {
    if (promoted) throw error;
    failQuarantineIdentity(sourcePath, pendingPath, errorMessage(error));
  }

  // Ownership loss must abort the whole sweep, so it is checked after the entry
  // is named `.deleting` and before any bytes are removed.
  options.assertRootOwner?.();
  assertSameFile(targetInfo, fstatSync(targetFd), "opened deletion target identity changed");
  makeQuarantinedTreeWritable(deletingPath);
  prepared.verifyQuarantine();
  assertSameFile(targetInfo, lstatSync(deletingPath), "quarantined directory was replaced during cleanup");
  rmSync(deletingPath, { recursive: true, force: true });
  return true;
}

/**
 * A verification failure must leave recoverable bytes. Put the entry back at
 * its original pathname when that name is still free; otherwise retain it in
 * the quarantine for an operator, and say which of the two happened.
 */
function failQuarantineIdentity(sourcePath: string, pendingPath: string, reason: string): never {
  if (!pathExists(sourcePath)) {
    let restored = false;
    try {
      renameSync(pendingPath, sourcePath);
      restored = true;
    } catch {
      restored = false;
    }
    if (restored) throw new Error(`${reason}; restored to ${sourcePath}`);
  }
  throw new Error(`${reason}; retained as ${pendingPath} for manual review`);
}

function recoverQuarantineEntries(
  quarantine: OpenedQuarantine,
  options: RemoveOwnedDirectoryOptions,
): OwnedDirectoryQuarantineRecovery {
  const recovery: OwnedDirectoryQuarantineRecovery = { recovered: 0, retained: [] };
  for (const entry of readdirSync(quarantine.reference, { withFileTypes: true })) {
    const generation = parseQuarantineGeneration(entry.name);
    const entryPath = join(quarantine.reference, entry.name);
    if (!generation || generation.stage !== "deleting") {
      // `.pending` bytes were never proven to be the directory the daemon
      // opened, and an unknown name may belong to an operator. Report both and
      // let the rest of the sweep continue.
      recovery.retained.push(generation?.originalName ?? entry.name);
      options.onError?.(
        entryPath,
        new Error(
          generation
            ? `quarantined deletion was not verified before the crash: ${entry.name}`
            : `unexpected entry in owned deletion quarantine: ${entry.name}`,
        ),
      );
      continue;
    }
    try {
      const fd = openOptionalRealDirectory(entryPath, "quarantined deletion generation");
      if (fd === null) continue;
      try {
        assertSameFile(fstatSync(fd), lstatSync(entryPath), "quarantined generation is not a real directory");
        options.assertRootOwner?.();
        quarantine.verifyAnchors();
        assertSameFile(fstatSync(fd), lstatSync(entryPath), "quarantined generation was replaced");
        makeQuarantinedTreeWritable(entryPath);
        quarantine.verifyAnchors();
        assertSameFile(fstatSync(fd), lstatSync(entryPath), "quarantined generation changed during recovery");
        rmSync(entryPath, { recursive: true, force: true });
        recovery.recovered++;
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      try {
        // Distinguish ownership loss (abort the sweep) from one unremovable
        // entry (retain it and continue).
        options.assertRootOwner?.();
      } catch {
        throw error;
      }
      recovery.retained.push(generation.originalName);
      options.onError?.(entryPath, error);
    }
  }
  return recovery;
}

function openRecoveryQuarantine(
  rootPath: string,
  rootFd: number,
  rootInfo: Stats,
  quarantinePath: string,
  strategy: RemovalStrategy,
  platform: NodeJS.Platform,
): OpenedQuarantine | null {
  if (strategy === "descriptor") {
    const rootAlias = descriptorDirectoryPath(rootFd, rootInfo, platform);
    if (!rootAlias) {
      if (pathExists(quarantinePath)) {
        throw new Error(
          `descriptor-safe quarantine recovery requires /proc/self/fd on ${platform}: ${rootPath}`,
        );
      }
      return null;
    }
    const fd = openOptionalRealDirectory(join(rootAlias, OWNED_DIRECTORY_QUARANTINE), "owned deletion quarantine");
    if (fd === null) return null;
    let info: Stats;
    let alias: string | null;
    try {
      info = fstatSync(fd);
      // Report the caller-facing path, not the procfs alias.
      assertPrivateQuarantine(info, quarantinePath);
      alias = descriptorDirectoryPath(fd, info, platform);
      if (!alias) throw new Error("directory descriptor path unavailable for owned deletion quarantine");
    } catch (error) {
      // GC skips a non-private quarantine every round instead of aborting, so
      // this descriptor must not outlive the refusal.
      closeSync(fd);
      throw error;
    }
    return {
      path: alias,
      reference: alias,
      fd,
      info,
      verifyAnchors: () => {
        assertSameFile(rootInfo, fstatSync(rootFd), "owned root changed during quarantine recovery");
        assertSameFile(info, fstatSync(fd), "owned deletion quarantine changed");
      },
      close: () => closeSync(fd),
    };
  }

  const anchor = openAnchoredDirectory(quarantinePath, "owned deletion quarantine");
  if (anchor === null) return null;
  const info = anchor.info;
  try {
    assertPrivateQuarantine(info, quarantinePath);
  } catch (error) {
    closeSync(anchor.fd);
    throw error;
  }
  return {
    path: quarantinePath,
    reference: quarantinePath,
    fd: anchor.fd,
    info,
    verifyAnchors: () => {
      assertRealDirectoryPath(rootPath, rootInfo, "owned root");
      assertRealDirectoryPath(quarantinePath, info, "owned deletion quarantine");
      assertSameFile(info, fstatSync(anchor.fd), "owned deletion quarantine changed");
    },
    close: () => closeSync(anchor.fd),
  };
}

function openPathQuarantine(rootPath: string): OpenedAnchor & { reference: string } {
  const quarantinePath = ensureQuarantine(rootPath);
  const anchor = openAnchoredDirectory(quarantinePath, "owned deletion quarantine");
  if (anchor === null) throw new Error(`owned deletion quarantine is missing: ${quarantinePath}`);
  return { ...anchor, reference: quarantinePath };
}

function openDescriptorQuarantine(
  rootPath: string,
  rootFd: number,
  rootInfo: Stats,
  platform: NodeJS.Platform,
): OpenedAnchor & { reference: string } {
  const rootAlias = descriptorDirectoryPath(rootFd, rootInfo, platform);
  if (!rootAlias) {
    throw new Error(
      `descriptor-safe owned directory removal requires /proc/self/fd on ${platform}; refusing to remove ${rootPath}`,
    );
  }
  const quarantinePath = ensureQuarantine(rootAlias);
  const fd = openRealDirectory(quarantinePath, "owned deletion quarantine");
  const info = fstatSync(fd);
  const alias = descriptorDirectoryPath(fd, info, platform);
  if (!alias) {
    closeSync(fd);
    throw new Error("directory descriptor path unavailable for owned deletion quarantine");
  }
  return { path: alias, reference: alias, fd, info };
}

/**
 * Open one directory by absolute path, refusing symlinks and requiring the
 * `lstat` view to match the descriptor that was actually opened. Returns null
 * when the path does not exist, and throws when it exists as something else.
 */
function openAnchoredDirectory(path: string, label: string): OpenedAnchor | null {
  const linkInfo = lstatIfExists(path);
  if (linkInfo === null) return null;
  if (!linkInfo.isDirectory() || linkInfo.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${path}`);
  }
  return openVerifiedCandidate(path, label, linkInfo);
}

function openDescriptorChild(path: string, label: string, platform: NodeJS.Platform): OpenedAnchor | null {
  const fd = openOptionalRealDirectory(path, label);
  if (fd === null) return null;
  const info = fstatSync(fd);
  const alias = descriptorDirectoryPath(fd, info, platform);
  if (!alias) {
    closeSync(fd);
    throw new Error(`directory descriptor path unavailable for ${path}`);
  }
  return { path: alias, fd, info };
}

function openVerifiedCandidate(path: string, label: string, expected: Stats): OpenedAnchor {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`${label} must be a real directory: ${path}`, { cause: error });
  }
  const info = fstatSync(fd);
  if (!sameFile(expected, info)) {
    closeSync(fd);
    throw new Error(`${label} identity changed while opening it: ${path}`);
  }
  return { path, fd, info };
}

function assertRealDirectoryPath(path: string, expected: Stats, label: string): void {
  const info = lstatIfExists(path);
  if (!info || !info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${path}`);
  }
  assertSameFile(expected, info, `${label} was replaced: ${path}`);
}

function ensureQuarantine(rootReference: string): string {
  const path = join(rootReference, OWNED_DIRECTORY_QUARANTINE);
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = assertRealDirectory(path, "owned deletion quarantine");
  // Report the caller-facing path even when `path` is a `/proc/self/fd` alias,
  // so the message names a directory an operator can act on.
  assertPrivateQuarantine(info, quarantineReportPath(rootReference));
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

function removalStrategy(platform: NodeJS.Platform): RemovalStrategy | null {
  // Linux procfs permits child lookup below an open directory descriptor.
  // macOS /dev/fd exposes the descriptor itself but not openat-style child
  // traversal, so it re-verifies each path component by dev/ino instead.
  if (platform === "linux") return "descriptor";
  if (platform === "darwin") return "path";
  return null;
}

function descriptorDirectoryPath(fd: number, expected: Stats, platform: NodeJS.Platform): string | null {
  const candidates = platform === "linux" ? [`/proc/self/fd/${fd}`] : [];
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

function quarantineGenerationNames(targetName: string): { pending: string; deleting: string } {
  const generation = `${targetName}.${process.pid}.${randomUUID()}`;
  return { pending: `${generation}.pending`, deleting: `${generation}.deleting` };
}

function parseQuarantineGeneration(entryName: string): QuarantineGeneration | null {
  const match = /^(.+)\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(pending|deleting)$/
    .exec(entryName);
  if (!match) return null;
  return {
    entryName,
    originalName: match[1]!,
    stage: match[2] as QuarantineStage,
  };
}

function baseName(path: string): string {
  const parts = path.split(sep).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Human-facing quarantine path for diagnostics. `rootReference` is a
 * `/proc/self/fd` alias on Linux, which is meaningless in a log line, so the
 * alias's target is used when it can be resolved.
 */
function quarantineReportPath(rootReference: string): string {
  if (!rootReference.startsWith("/proc/self/fd/")) return join(rootReference, OWNED_DIRECTORY_QUARANTINE);
  try {
    return join(realpathSync(rootReference), OWNED_DIRECTORY_QUARANTINE);
  } catch {
    return join(rootReference, OWNED_DIRECTORY_QUARANTINE);
  }
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
  return lstatIfExists(path) !== null;
}

function lstatIfExists(path: string): Stats | null {
  try {
    return lstatSync(path, { throwIfNoEntry: false }) ?? null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
