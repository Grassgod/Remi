import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const OWNER_LOCK_DIR = "owner.lock";
const OWNER_FILE = "owner.json";
const MAX_OWNER_BYTES = 4 * 1024;
const ACQUIRE_ATTEMPTS = 4;

interface WorkspaceSupervisorOwner {
  version: 1;
  nonce: string;
  pid: number;
  process_start_id: string | null;
  acquired_at: string;
  released: boolean;
  workspace_root: string;
  root_dev: string;
  root_ino: string;
  base_port: number | null;
}

interface ObservedOwner {
  directory: Stats;
  ownerFile: Stats;
  owner: WorkspaceSupervisorOwner;
}

export interface WorkspaceSupervisorProcessProbe {
  pid: number;
  isAlive(pid: number): boolean;
  startId(pid: number): string | null;
  now(): Date;
}

export interface WorkspaceSupervisorLease {
  workspaceRoot: string;
  lockPath: string;
  assertOwner(): void;
  release(): void;
}

export class WorkspaceSupervisorOwnedError extends Error {
  readonly code = "multiremi_workspace_supervisor_owned";

  constructor(
    readonly workspaceRoot: string,
    readonly ownerPid: number,
    readonly basePort: number | null,
  ) {
    const port = basePort === null ? "" : ` on daemon port ${basePort}`;
    super(`Another Multiremi daemon process (pid ${ownerPid}) already owns workspace root ${workspaceRoot}${port}`);
    this.name = "WorkspaceSupervisorOwnedError";
  }
}

export function configuredMultiremiWorkspacesRoot(explicit?: string | null): string {
  return explicit
    ?? process.env.MULTIREMI_WORKSPACES_ROOT
    ?? join(homedir(), ".remi", "multiremi", "workspaces");
}

/**
 * Owns one canonical workspace root for the lifetime of a daemon supervisor.
 * PID liveness is authoritative: a live owner is never evicted because a
 * timer or machine suspension made a heartbeat look stale.
 */
export function acquireWorkspaceSupervisorLease(
  workspacesRoot = configuredMultiremiWorkspacesRoot(),
  options: {
    basePort?: number | null;
    processProbe?: WorkspaceSupervisorProcessProbe;
    stateRoot?: string;
    beforeReleaseCommit?: () => void;
  } = {},
): WorkspaceSupervisorLease {
  const { workspaceRoot, identity: rootIdentity } = prepareWorkspaceRoot(workspacesRoot);
  const supervisorRoot = prepareSupervisorStateRoot(options.stateRoot);
  const stateDir = join(
    supervisorRoot,
    createHash("sha256").update(workspaceRoot).digest("hex"),
  );
  ensurePrivateDirectory(stateDir);
  const lockPath = join(stateDir, OWNER_LOCK_DIR);
  const probe = options.processProbe ?? defaultProcessProbe();
  const owner: WorkspaceSupervisorOwner = {
    version: 1,
    nonce: randomBytes(24).toString("hex"),
    pid: probe.pid,
    process_start_id: probe.startId(probe.pid),
    acquired_at: probe.now().toISOString(),
    released: false,
    workspace_root: workspaceRoot,
    root_dev: String(rootIdentity.dev),
    root_ino: String(rootIdentity.ino),
    base_port: options.basePort ?? null,
  };
  let candidate: string | null = prepareCandidate(stateDir, owner);

  try {
    for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt++) {
      try {
        if (!candidate) throw new Error("Workspace supervisor candidate was already promoted");
        renameSync(candidate, lockPath);
        candidate = null;
        const observed = inspectOwner(lockPath, workspaceRoot);
        if (observed.owner.nonce !== owner.nonce) {
          throw new Error(`Workspace supervisor owner changed during acquisition: ${lockPath}`);
        }
        return createLease(
          lockPath,
          workspaceRoot,
          rootIdentity,
          observed,
          options.beforeReleaseCommit,
        );
      } catch (error) {
        if (!isExistingDestination(error, lockPath)) throw error;
      }

      let observed: ObservedOwner;
      try {
        observed = inspectOwner(lockPath, workspaceRoot);
      } catch (error) {
        if (isMissingPath(error)) continue;
        throw error;
      }
      if (ownerIsActive(observed.owner, probe)) {
        throw new WorkspaceSupervisorOwnedError(
          workspaceRoot,
          observed.owner.pid,
          observed.owner.base_port,
        );
      }
      retireInactiveOwner(stateDir, lockPath, workspaceRoot, observed, probe);
    }
    throw new Error(`Workspace supervisor ownership changed repeatedly: ${workspaceRoot}`);
  } finally {
    if (candidate) cleanupOwnerDirectory(candidate, owner.nonce);
  }
}

function createLease(
  lockPath: string,
  workspaceRoot: string,
  rootIdentity: Stats,
  acquired: ObservedOwner,
  beforeReleaseCommit?: () => void,
): WorkspaceSupervisorLease {
  let released = false;
  const assertLockOwner = (): ObservedOwner => {
    if (released) throw new Error(`Workspace supervisor lease was already released: ${workspaceRoot}`);
    const current = inspectOwner(lockPath, workspaceRoot);
    if (!sameIdentity(acquired.directory, current.directory)
      || current.owner.nonce !== acquired.owner.nonce
      || current.owner.released) {
      throw new Error(`Workspace supervisor lease was lost: ${workspaceRoot}`);
    }
    return current;
  };
  const assertOwner = (): void => {
    assertLockOwner();
    let currentRoot: Stats;
    try {
      currentRoot = lstatSync(workspaceRoot);
    } catch {
      throw new Error(`Workspace root identity changed while the daemon was running: ${workspaceRoot}`);
    }
    if (currentRoot.isSymbolicLink()
      || !currentRoot.isDirectory()
      || !sameIdentity(rootIdentity, currentRoot)) {
      throw new Error(`Workspace root identity changed while the daemon was running: ${workspaceRoot}`);
    }
  };

  return {
    workspaceRoot,
    lockPath,
    assertOwner,
    release: () => {
      if (released) return;
      // Root replacement is precisely why the daemon may be stopping. Release
      // only requires ownership of the stable external lock generation.
      const current = assertLockOwner();
      const next = { ...current.owner, released: true };
      rewriteOwnerAtomically(lockPath, current, next, beforeReleaseCommit);
      released = true;
      // Leave the released generation in place. The next owner quarantines it
      // atomically, which avoids an unlink/rmdir gap during a foreground update.
    },
  };
}

function retireInactiveOwner(
  stateDir: string,
  lockPath: string,
  workspaceRoot: string,
  observed: ObservedOwner,
  probe: WorkspaceSupervisorProcessProbe,
): void {
  const quarantine = join(stateDir, `${OWNER_LOCK_DIR}.stale-${randomBytes(12).toString("hex")}`);
  try {
    renameSync(lockPath, quarantine);
  } catch (error) {
    if (isMissingPath(error) || isExistingDestination(error)) return;
    throw error;
  }

  let moved: ObservedOwner;
  try {
    moved = inspectOwner(quarantine, workspaceRoot);
    if (!sameIdentity(observed.directory, moved.directory)
      || observed.owner.nonce !== moved.owner.nonce
      || ownerIsActive(moved.owner, probe)) {
      restoreOwner(quarantine, lockPath);
      return;
    }
  } catch (error) {
    restoreOwner(quarantine, lockPath);
    throw error;
  }
  cleanupOwnerDirectory(quarantine, moved.owner.nonce);
}

function prepareWorkspaceRoot(input: string): { workspaceRoot: string; identity: Stats } {
  const requested = resolve(input);
  mkdirSync(requested, { recursive: true, mode: 0o700 });
  const root = realpathSync(requested);
  const stat = lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Workspace root must resolve to a real directory: ${requested}`);
  }
  assertOwnedByCurrentUser(stat, basename(root));
  return { workspaceRoot: root, identity: stat };
}

function prepareSupervisorStateRoot(input?: string): string {
  const requested = resolve(
    input ?? join(userInfo().homedir, ".multiremi", "workspace-supervisors"),
  );
  mkdirSync(requested, { recursive: true, mode: 0o700 });
  const root = realpathSync(requested);
  const stat = lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Workspace supervisor state root must be a real directory: ${requested}`);
  }
  assertOwnedByCurrentUser(stat, basename(root));
  chmodSync(root, 0o700);
  return root;
}

function ensurePrivateDirectory(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (!isExistingDestination(error)) throw error;
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Workspace supervisor state must be a real directory: ${path}`);
  }
  assertOwnedByCurrentUser(stat, basename(path));
  chmodSync(path, 0o700);
}

function prepareCandidate(stateDir: string, owner: WorkspaceSupervisorOwner): string {
  const path = join(stateDir, `${OWNER_LOCK_DIR}.candidate-${owner.nonce}`);
  mkdirSync(path, { mode: 0o700 });
  try {
    writeNewOwner(join(path, OWNER_FILE), owner);
    return path;
  } catch (error) {
    try { rmdirSync(path); } catch { /* leave an inert candidate for inspection */ }
    throw error;
  }
}

function inspectOwner(path: string, workspaceRoot?: string): ObservedOwner {
  const directory = lstatSync(path);
  if (directory.isSymbolicLink() || !directory.isDirectory()) {
    throw new Error(`Unsafe workspace supervisor lock directory: ${path}`);
  }
  assertOwnedByCurrentUser(directory, basename(path));
  const ownerPath = join(path, OWNER_FILE);
  const ownerFile = lstatSync(ownerPath);
  if (ownerFile.isSymbolicLink() || !ownerFile.isFile() || ownerFile.nlink !== 1) {
    throw new Error(`Unsafe workspace supervisor owner file: ${ownerPath}`);
  }
  assertOwnedByCurrentUser(ownerFile, OWNER_FILE);
  if (ownerFile.size <= 0 || ownerFile.size > MAX_OWNER_BYTES) {
    throw new Error(`Invalid workspace supervisor owner file size: ${ownerPath}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(ownerPath, "utf8"));
  } catch {
    throw new Error(`Invalid workspace supervisor owner file: ${ownerPath}`);
  }
  const owner = parseOwner(raw);
  if (workspaceRoot !== undefined && owner.workspace_root !== workspaceRoot) {
    throw new Error(`Workspace supervisor owner root mismatch: ${ownerPath}`);
  }
  return { directory, ownerFile, owner };
}

function parseOwner(raw: unknown): WorkspaceSupervisorOwner {
  const owner = raw as Partial<WorkspaceSupervisorOwner> | null;
  if (!owner
    || owner.version !== 1
    || typeof owner.nonce !== "string"
    || !/^[a-f0-9]{48}$/.test(owner.nonce)
    || !Number.isSafeInteger(owner.pid)
    || Number(owner.pid) <= 0
    || (owner.process_start_id !== null && typeof owner.process_start_id !== "string")
    || typeof owner.acquired_at !== "string"
    || !Number.isFinite(Date.parse(owner.acquired_at))
    || typeof owner.released !== "boolean"
    || typeof owner.workspace_root !== "string"
    || typeof owner.root_dev !== "string"
    || !/^\d+$/.test(owner.root_dev)
    || typeof owner.root_ino !== "string"
    || !/^\d+$/.test(owner.root_ino)
    || (owner.base_port !== null && (!Number.isSafeInteger(owner.base_port) || Number(owner.base_port) < 0))) {
    throw new Error("Invalid workspace supervisor owner payload");
  }
  return owner as WorkspaceSupervisorOwner;
}

function ownerIsActive(owner: WorkspaceSupervisorOwner, probe: WorkspaceSupervisorProcessProbe): boolean {
  if (owner.released || !probe.isAlive(owner.pid)) return false;
  const currentStartId = probe.startId(owner.pid);
  if (owner.process_start_id && currentStartId && owner.process_start_id !== currentStartId) {
    return false;
  }
  // If either start id is unavailable, PID liveness fails closed. This can
  // delay recovery after rare PID reuse, but never evicts a live daemon.
  return true;
}

function defaultProcessProbe(): WorkspaceSupervisorProcessProbe {
  return {
    pid: process.pid,
    isAlive: isProcessAlive,
    startId: readProcessStartId,
    now: () => new Date(),
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function readProcessStartId(pid: number): string | null {
  if (process.platform !== "linux") {
    // macOS `ps lstart` is timezone-dependent and only has second precision.
    // A live PID must fail closed rather than be evicted on an ambiguous ID.
    return null;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8").trim();
    // comm (field 2) is parenthesized and may contain spaces or `)`, so split
    // after its final closing delimiter. field 22 is index 19 from field 3.
    const commEnd = stat.lastIndexOf(")");
    if (commEnd < 0) return null;
    const fields = stat.slice(commEnd + 1).trim().split(/\s+/);
    const startTicks = fields[19];
    if (!startTicks || !/^\d+$/.test(startTicks)) return null;
    let bootId = "unknown-boot";
    try {
      const value = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      if (value) bootId = value;
    } catch {
      // start ticks remain timezone-independent; missing boot id only makes
      // post-reboot PID reuse fail closed when the two IDs happen to match.
    }
    return `linux:${bootId}:${startTicks}`;
  } catch {
    return null;
  }
}

function writeNewOwner(path: string, owner: WorkspaceSupervisorOwner): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeOwner(fd, owner);
  } finally {
    closeSync(fd);
  }
}

function rewriteOwnerAtomically(
  lockPath: string,
  expected: ObservedOwner,
  owner: WorkspaceSupervisorOwner,
  beforeCommit?: () => void,
): void {
  const ownerPath = join(lockPath, OWNER_FILE);
  const temp = join(
    dirname(lockPath),
    `.owner-release-${owner.nonce}-${randomBytes(8).toString("hex")}.tmp`,
  );
  writeNewOwner(temp, owner);
  try {
    assertExpectedOwner(lockPath, expected);
    beforeCommit?.();
    assertExpectedOwner(lockPath, expected);
    renameSync(temp, ownerPath);
    fsyncDirectory(lockPath);
  } finally {
    try { unlinkSync(temp); } catch (error) {
      if (!isMissingPath(error)) throw error;
    }
  }
}

function assertExpectedOwner(lockPath: string, expected: ObservedOwner): void {
  const current = inspectOwner(lockPath, expected.owner.workspace_root);
  if (!sameIdentity(expected.directory, current.directory)
    || !sameIdentity(expected.ownerFile, current.ownerFile)
    || current.owner.nonce !== expected.owner.nonce
    || current.owner.released) {
    throw new Error(`Workspace supervisor owner changed before release: ${lockPath}`);
  }
}

function fsyncDirectory(path: string): void {
  // Windows does not support fsync on a directory handle (Bun returns EPERM).
  // Owner-file fsync and atomic rename still run before the lease is released.
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeOwner(fd: number, owner: WorkspaceSupervisorOwner): void {
  const payload = Buffer.from(`${JSON.stringify(owner)}\n`, "utf8");
  let offset = 0;
  while (offset < payload.length) {
    offset += writeSync(fd, payload, offset, payload.length - offset, offset);
  }
  fsyncSync(fd);
}

function cleanupOwnerDirectory(path: string, expectedNonce: string): void {
  if (!existsSync(path)) return;
  const entries = readdirSync(path);
  if (entries.length !== 1 || entries[0] !== OWNER_FILE) {
    throw new Error(`Refusing to remove unsafe workspace supervisor generation: ${path}`);
  }
  const observed = inspectOwner(path);
  if (observed.owner.nonce !== expectedNonce) {
    throw new Error(`Workspace supervisor generation changed before cleanup: ${path}`);
  }
  unlinkSync(join(path, OWNER_FILE));
  rmdirSync(path);
}

function restoreOwner(quarantine: string, lockPath: string): void {
  if (existsSync(lockPath)) return;
  try { renameSync(quarantine, lockPath); } catch { /* another contender won */ }
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertOwnedByCurrentUser(stat: Stats, label: string): void {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid !== null && stat.uid !== uid) {
    throw new Error(`Refusing ${label} because it is owned by another user`);
  }
}

function isExistingDestination(error: unknown, destination?: string): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EEXIST" || code === "ENOTEMPTY"
    // Windows reports a rename over an existing non-empty directory as EPERM.
    // Verify the destination before inspecting its owner; other permission
    // errors remain fatal.
    || (process.platform === "win32" && (code === "EPERM" || code === "EACCES")
      && Boolean(destination && existsSync(destination)));
}

function isMissingPath(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
