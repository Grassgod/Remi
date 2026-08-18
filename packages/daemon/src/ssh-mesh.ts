import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  ftruncateSync,
  futimesSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { createConnection } from "node:net";
import { homedir, hostname as osHostname, networkInterfaces, userInfo } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type {
  MultiremiDaemonSshMeshConfig,
  MultiremiDaemonSshMeshHost,
  MultiremiDaemonSshMeshStatus,
  MultiremiSshMeshHeartbeatAck,
  MultiremiSshMeshPeerProbe,
  MultiremiSshMeshRuntimeStatus,
} from "@multiremi/contracts/types.js";
import { MULTIREMI_SSH_MESH_PROTOCOL_VERSION } from "@multiremi/contracts/types.js";

const LOCK_STALE_MS = 2 * 60_000;
const LOCK_HEARTBEAT_MS = 30_000;
const SHARED_FILES_LOCK_TIMEOUT_MS = 10_000;
const SHARED_FILES_LOCK_POLL_MS = 20;
const CONFIG_FETCH_TIMEOUT_MS = 30_000;
const PROBE_INTERVAL_MS = 5 * 60_000;
const RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 5 * 60_000];
const MAX_COMMAND_OUTPUT_BYTES = 8 * 1024;
const MAX_REPORTED_ERROR_CHARS = 300;
const SSH_CONFIG_INCLUDE_START = "# >>> multiremi ssh mesh >>>";
const SSH_CONFIG_INCLUDE_END = "# <<< multiremi ssh mesh <<<";

export interface SshMeshPaths {
  home: string;
  meshRoot: string;
  workspaceRoot: string;
  privateKey: string;
  publicKey: string;
  config: string;
  knownHosts: string;
  stateFile: string;
  lockDirectory: string;
  sharedFilesLockDirectory: string;
  configInclude: string;
  sshConfig: string;
  authorizedKeys: string;
}

export interface SshMeshCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export type SshMeshCommandRunner = (
  executable: string,
  args: string[],
  timeoutMs: number,
) => Promise<SshMeshCommandResult>;

export interface SshMeshLocalIdentity {
  sshUser: string;
  hostname: string;
  port: number;
  addresses: string[];
  hostKeys: string[];
  sshdListening: boolean;
}

interface PersistedSshMeshState {
  workspaceId: string;
  daemonId: string;
  status: MultiremiSshMeshRuntimeStatus;
  keyVersion: number | null;
  configRevision: string | null;
  probeRevision: number;
  publicKeyInstalled: boolean;
  configInstalled: boolean;
  fileDigests: ManagedFileDigests | null;
  peers: MultiremiSshMeshPeerProbe[];
  lastErrorCode: string | null;
  lastError: string | null;
  attempts: number;
  nextRetryAt: string | null;
  lastProbeAt: string | null;
  updatedAt: string;
}

interface ManagedFileDigests {
  privateKey: string;
  publicKey: string;
  config: string;
  knownHosts: string;
  configInclude: string;
  sshConfig: string;
  authorizedKeys: string;
}

export interface SshMeshManagerOptions {
  workspaceId: string;
  daemonId: string;
  getConfig: (signal?: AbortSignal) => Promise<MultiremiDaemonSshMeshConfig>;
  paths?: Partial<SshMeshPaths>;
  commandRunner?: SshMeshCommandRunner;
  discoverIdentity?: () => Promise<SshMeshLocalIdentity>;
  now?: () => number;
  retryDelaysMs?: number[];
  probeIntervalMs?: number;
  configFetchTimeoutMs?: number;
}

export interface SshMeshLockLease {
  release: () => void;
  assertOwner: () => void;
}

interface SshMeshLockOwner {
  version: 1;
  nonce: string;
  pid: number;
  acquiredAt: string;
  released: boolean;
}

interface PreparedHost {
  daemonId: string;
  alias: string;
  hostName: string;
  sshUser: string;
  port: number;
  addresses: string[];
  hostname: string | null;
  hostKeys: string[];
}

class SshMeshError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: "setup_required" | "blocked" | "error" = "blocked",
  ) {
    super(message);
    this.name = "SshMeshError";
  }
}

function isSshMeshLockLost(error: unknown): error is SshMeshError {
  return error instanceof SshMeshError && error.code === "ssh_mesh_lock_lost";
}

export function defaultSshMeshPaths(workspaceId: string, home = homedir()): SshMeshPaths {
  const canonicalHome = existsSync(home) ? realpathSync(home) : resolve(home);
  const workspaceComponent = `workspace-${createHash("sha256").update(workspaceId).digest("hex").slice(0, 16)}`;
  const meshRoot = join(canonicalHome, ".multiremi", "ssh");
  const workspaceRoot = join(meshRoot, "workspaces", workspaceComponent);
  return {
    home: canonicalHome,
    meshRoot,
    workspaceRoot,
    privateKey: join(workspaceRoot, "id_ed25519"),
    publicKey: join(workspaceRoot, "id_ed25519.pub"),
    config: join(workspaceRoot, "config"),
    knownHosts: join(workspaceRoot, "known_hosts"),
    stateFile: join(workspaceRoot, "state.json"),
    lockDirectory: join(workspaceRoot, ".reconcile.lock"),
    sharedFilesLockDirectory: join(meshRoot, ".shared-files.lock"),
    configInclude: join(meshRoot, "config.d", `${workspaceComponent}.conf`),
    sshConfig: join(canonicalHome, ".ssh", "config"),
    authorizedKeys: join(canonicalHome, ".ssh", "authorized_keys"),
  };
}

export class SshMeshManager {
  private readonly workspaceId: string;
  private readonly daemonId: string;
  private readonly getConfigWire: (signal?: AbortSignal) => Promise<MultiremiDaemonSshMeshConfig>;
  private readonly paths: SshMeshPaths;
  private readonly commandRunner: SshMeshCommandRunner;
  private readonly discoverIdentity: () => Promise<SshMeshLocalIdentity>;
  private readonly now: () => number;
  private readonly retryDelaysMs: number[];
  private readonly probeIntervalMs: number;
  private readonly configFetchTimeoutMs: number;
  private state: PersistedSshMeshState;
  private identity: SshMeshLocalIdentity;

  constructor(options: SshMeshManagerOptions) {
    this.workspaceId = options.workspaceId;
    this.daemonId = options.daemonId;
    this.getConfigWire = options.getConfig;
    this.paths = { ...defaultSshMeshPaths(options.workspaceId), ...options.paths };
    this.commandRunner = options.commandRunner ?? runSshMeshCommand;
    this.now = options.now ?? Date.now;
    this.retryDelaysMs = options.retryDelaysMs?.length ? [...options.retryDelaysMs] : [...RETRY_DELAYS_MS];
    this.probeIntervalMs = options.probeIntervalMs ?? PROBE_INTERVAL_MS;
    this.configFetchTimeoutMs = Math.max(1, Math.min(
      options.configFetchTimeoutMs ?? CONFIG_FETCH_TIMEOUT_MS,
      LOCK_STALE_MS - LOCK_HEARTBEAT_MS,
    ));
    this.identity = restrictLocalIdentity(discoverLocalSshIdentitySync());
    this.discoverIdentity = options.discoverIdentity
      ?? (() => discoverLocalSshIdentity(this.identity.port));
    this.state = this.readSharedState() ?? emptyState(this.workspaceId, this.daemonId, this.now());
  }

  getHeartbeatStatus(): MultiremiDaemonSshMeshStatus {
    this.refreshSharedState();
    return {
      status: this.state.status,
      key_version: this.state.keyVersion,
      config_revision: this.state.configRevision,
      probe_revision: this.state.probeRevision,
      ssh_user: this.identity.sshUser,
      hostname: this.identity.hostname,
      port: this.identity.port,
      addresses: [...this.identity.addresses],
      host_keys: [...this.identity.hostKeys],
      public_key_installed: this.state.publicKeyInstalled,
      config_installed: this.state.configInstalled,
      peers: this.state.peers.map((peer) => ({ ...peer })),
      last_error_code: this.state.lastErrorCode,
      last_error: this.state.lastError,
    };
  }

  async reconcile(desired: MultiremiSshMeshHeartbeatAck): Promise<void> {
    this.refreshSharedState();
    const now = this.now();
    if (!this.shouldReconcile(desired, now)) return;

    const lease = tryAcquireReconcileLock(this.paths.lockDirectory, now);
    if (!lease) {
      this.refreshSharedState();
      return;
    }

    try {
      this.refreshSharedState();
      if (!this.shouldReconcile(desired, this.now())) return;
      const filesHealthy = !desired.enabled || this.managedFilesHealthy();
      const needsApply = desired.needs_sync
        || this.state.keyVersion !== desired.key_version
        || this.state.configRevision !== desired.config_revision
        || !this.state.publicKeyInstalled
        || !this.state.configInstalled
        || !filesHealthy;
      lease.assertOwner();
      this.state = {
        ...this.state,
        status: "syncing",
        lastErrorCode: null,
        lastError: null,
        updatedAt: new Date(this.now()).toISOString(),
      };
      this.persistState(lease.assertOwner);

      const config = await fetchSshMeshConfigWithTimeout(
        this.getConfigWire,
        this.configFetchTimeoutMs,
        "ssh_mesh_config_timeout",
        "timed out fetching SSH Mesh configuration",
      );
      lease.assertOwner();
      validateConfigEnvelope(config, desired);
      this.identity = restrictLocalIdentity(await this.discoverIdentity());
      lease.assertOwner();

      if (!config.enabled) {
        await this.applyDisabled(lease.assertOwner);
        lease.assertOwner();
        this.state = {
          ...this.state,
          status: "disabled",
          keyVersion: config.key_version,
          configRevision: config.config_revision,
          probeRevision: config.probe_revision,
          publicKeyInstalled: false,
          configInstalled: false,
          fileDigests: null,
          peers: [],
          lastErrorCode: null,
          lastError: null,
          attempts: 0,
          nextRetryAt: null,
          lastProbeAt: null,
          updatedAt: new Date(this.now()).toISOString(),
        };
        this.persistState(lease.assertOwner);
        return;
      }

      if (!this.identity.addresses.length) {
        throw new SshMeshError(
          "ssh_mesh_private_address_missing",
          "no RFC1918 or CGNAT IPv4 address is available for SSH Mesh",
          "setup_required",
        );
      }

      const prepared = prepareHosts(config.hosts);
      let fileDigests = this.state.fileDigests;
      if (needsApply) {
        fileDigests = await this.applyEnabled(config, prepared.hosts, lease.assertOwner);
        lease.assertOwner();
        this.state = {
          ...this.state,
          keyVersion: config.key_version,
          configRevision: config.config_revision,
          publicKeyInstalled: true,
          configInstalled: true,
          fileDigests,
          updatedAt: new Date(this.now()).toISOString(),
        };
        this.persistState(lease.assertOwner);
      }
      if (!this.identity.sshdListening) {
        throw new SshMeshError(
          "ssh_mesh_sshd_not_listening",
          `sshd is not listening on loopback port ${this.identity.port}`,
          "setup_required",
        );
      }
      if (!this.identity.hostKeys.length) {
        throw new SshMeshError(
          "ssh_mesh_host_key_missing",
          "no local OpenSSH host public key was found",
          "setup_required",
        );
      }

      const targets = new Set(config.probe_target_daemon_ids ?? []);
      const probeAll = desired.needs_sync || targets.size === 0 || this.state.peers.length === 0;
      const selected = prepared.hosts.filter((host) =>
        host.daemonId !== this.daemonId && (probeAll || targets.has(host.daemonId))
      );
      const probed = await Promise.all(selected.map((host) => this.probePeer(host)));
      lease.assertOwner();
      const peers = mergePeerProbes(
        probeAll ? [] : this.state.peers,
        [...prepared.invalidPeers, ...probed],
      );
      const completedAt = new Date(this.now()).toISOString();
      this.state = {
        ...this.state,
        status: "ready",
        keyVersion: config.key_version,
        configRevision: config.config_revision,
        probeRevision: config.probe_revision,
        publicKeyInstalled: true,
        configInstalled: true,
        fileDigests,
        peers,
        lastErrorCode: null,
        lastError: null,
        attempts: 0,
        nextRetryAt: null,
        lastProbeAt: completedAt,
        updatedAt: completedAt,
      };
      this.persistState(lease.assertOwner);
    } catch (error) {
      if (isSshMeshLockLost(error)) {
        this.reloadSharedState();
      } else {
        try {
          lease.assertOwner();
          this.recordFailure(error, lease.assertOwner);
        } catch (fenceError) {
          if (!isSshMeshLockLost(fenceError)) throw fenceError;
          this.reloadSharedState();
        }
      }
    } finally {
      lease.release();
    }
  }

  private shouldReconcile(desired: MultiremiSshMeshHeartbeatAck, now: number): boolean {
    if (desired.enabled && this.state.status === "ready" && !this.managedFilesHealthy()) return true;
    if (this.state.nextRetryAt && now < Date.parse(this.state.nextRetryAt)) return false;
    if (desired.needs_sync || desired.needs_probe) return true;
    if (this.state.configRevision !== desired.config_revision) return true;
    if (this.state.keyVersion !== desired.key_version) return true;
    if (this.state.probeRevision < desired.probe_revision) return true;
    if (desired.enabled && this.state.status !== "ready") return true;
    if (!desired.enabled && this.state.status !== "disabled") return true;
    if (desired.enabled && this.state.lastProbeAt) {
      return now - Date.parse(this.state.lastProbeAt) >= this.probeIntervalMs;
    }
    return desired.enabled && !this.state.lastProbeAt;
  }

  private managedFilesHealthy(): boolean {
    if (!this.state.fileDigests) return false;
    try {
      return managedFileDigestsEqual(this.state.fileDigests, collectManagedFileDigests(this.paths));
    } catch {
      return false;
    }
  }

  async cleanupForRetirement(): Promise<void> {
    ensureManagedDirectories(this.paths);
    const workspaceLease = await acquireDirectoryLock(
      this.paths.lockDirectory,
      "ssh_mesh_cleanup_lock_timeout",
      "timed out waiting to clean up SSH Mesh files",
    );
    try {
      this.refreshSharedState();
      await this.applyDisabled(workspaceLease.assertOwner);
      workspaceLease.assertOwner();
      const cleanedAt = new Date(this.now()).toISOString();
      this.state = {
        ...this.state,
        status: "disabled",
        keyVersion: null,
        configRevision: null,
        publicKeyInstalled: false,
        configInstalled: false,
        fileDigests: null,
        peers: [],
        lastErrorCode: null,
        lastError: null,
        attempts: 0,
        nextRetryAt: null,
        lastProbeAt: null,
        updatedAt: cleanedAt,
      };
      this.persistState(workspaceLease.assertOwner);
    } finally {
      workspaceLease.release();
    }
  }

  private async applyEnabled(
    config: MultiremiDaemonSshMeshConfig,
    hosts: PreparedHost[],
    workspaceFence: () => void,
  ): Promise<ManagedFileDigests> {
    workspaceFence();
    ensureManagedDirectories(this.paths);
    const publicKey = requirePublicKey(config.public_key, "ssh_mesh_public_key_invalid");
    const authorizedKeys = uniquePublicKeys(config.authorized_public_keys);
    if (!authorizedKeys.some((key) => publicKeyIdentity(key) === publicKeyIdentity(publicKey))) {
      throw new SshMeshError(
        "ssh_mesh_public_key_not_authorized",
        "the active SSH Mesh public key is absent from authorized_public_keys",
      );
    }
    await stageAndInstallPrivateKey(
      this.paths.privateKey,
      config.private_key,
      publicKey,
      this.commandRunner,
      workspaceFence,
    );
    workspaceFence();
    atomicWriteFile(this.paths.publicKey, `${publicKey}\n`, 0o600, workspaceFence);
    atomicWriteFile(this.paths.knownHosts, renderKnownHosts(hosts), 0o600, workspaceFence);
    atomicWriteFile(this.paths.config, renderSshConfig(hosts, this.paths), 0o600, workspaceFence);
    atomicWriteFile(
      this.paths.configInclude,
      `# Generated by Multiremi. Do not edit.\nInclude ${quoteSshConfigValue(this.paths.config)}\n`,
      0o600,
      workspaceFence,
    );

    // Lock ordering is always workspace reconciliation first, then the
    // user-global shared-files lock. Both shared files use one critical section.
    const sharedFilesLease = await acquireSharedFilesLock(this.paths.sharedFilesLockDirectory);
    try {
      const sharedFence = () => {
        workspaceFence();
        sharedFilesLease.assertOwner();
      };
      sharedFence();
      const marker = workspaceMarker(this.workspaceId);
      const existingAuthorized = readRegularFile(this.paths.authorizedKeys);
      const managedAuthorized = authorizedKeys.map((key) =>
        `no-agent-forwarding,no-port-forwarding,no-X11-forwarding ${stripPublicKeyComment(key)} multiremi:${marker}`
      ).join("\n");
      atomicWriteFile(
        this.paths.authorizedKeys,
        replaceManagedBlock(existingAuthorized, authorizedBlockStart(marker), authorizedBlockEnd(marker), managedAuthorized),
        0o600,
        sharedFence,
      );

      sharedFence();
      const existingSshConfig = readRegularFile(this.paths.sshConfig);
      atomicWriteFile(
        this.paths.sshConfig,
        placeManagedBlockFirst(
          existingSshConfig,
          SSH_CONFIG_INCLUDE_START,
          SSH_CONFIG_INCLUDE_END,
          `Include ${quoteSshConfigValue(join(this.paths.meshRoot, "config.d", "*.conf"))}`,
        ),
        0o600,
        sharedFence,
      );
      sharedFence();
      return collectManagedFileDigests(this.paths);
    } finally {
      sharedFilesLease.release();
    }
  }

  private async applyDisabled(workspaceFence: () => void): Promise<void> {
    workspaceFence();
    ensureManagedDirectories(this.paths);
    const sharedFilesLease = await acquireSharedFilesLock(this.paths.sharedFilesLockDirectory);
    try {
      const sharedFence = () => {
        workspaceFence();
        sharedFilesLease.assertOwner();
      };
      sharedFence();
      const marker = workspaceMarker(this.workspaceId);
      const existingAuthorized = readRegularFile(this.paths.authorizedKeys);
      const withoutManagedKey = replaceManagedBlock(
        existingAuthorized,
        authorizedBlockStart(marker),
        authorizedBlockEnd(marker),
        null,
      );
      if (withoutManagedKey !== existingAuthorized) {
        atomicWriteFile(this.paths.authorizedKeys, withoutManagedKey, 0o600, sharedFence);
      }
    } finally {
      sharedFilesLease.release();
    }
    for (const path of [this.paths.privateKey, this.paths.publicKey, this.paths.config, this.paths.knownHosts, this.paths.configInclude]) {
      removeManagedRegularFile(path, workspaceFence);
    }
  }

  private async probePeer(host: PreparedHost): Promise<MultiremiSshMeshPeerProbe> {
    const startedAt = this.now();
    const result = await this.commandRunner(
      "ssh",
      [
        "-F", this.paths.config,
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=5",
        "-o", "ConnectionAttempts=1",
        host.alias,
        "true",
      ],
      8_000,
    );
    const checkedAt = new Date(this.now()).toISOString();
    if (result.exitCode === 0) {
      return {
        daemon_id: host.daemonId,
        status: "ready",
        latency_ms: Math.max(0, this.now() - startedAt),
        error_code: null,
        error: null,
        checked_at: checkedAt,
      };
    }
    return {
      daemon_id: host.daemonId,
      ...classifySshProbeFailure(result),
      latency_ms: Math.max(0, this.now() - startedAt),
      checked_at: checkedAt,
    };
  }

  private recordFailure(error: unknown, fence: () => void): void {
    const classified = error instanceof SshMeshError
      ? error
      : new SshMeshError("ssh_mesh_sync_failed", "SSH Mesh synchronization failed", "error");
    const attempts = this.state.attempts + 1;
    const delay = this.retryDelaysMs[Math.min(attempts - 1, this.retryDelaysMs.length - 1)] ?? 60_000;
    const failedAt = this.now();
    this.state = {
      ...this.state,
      status: classified.status,
      lastErrorCode: classified.code,
      lastError: sanitizeReportedError(classified.message),
      attempts,
      nextRetryAt: new Date(failedAt + Math.max(1, delay)).toISOString(),
      updatedAt: new Date(failedAt).toISOString(),
    };
    try {
      this.persistState(fence);
    } catch (persistError) {
      if (isSshMeshLockLost(persistError)) throw persistError;
      // The heartbeat still carries the in-memory error. Never append the source
      // error here because a transport failure may contain a response body.
    }
  }

  private refreshSharedState(): void {
    const shared = this.readSharedState();
    if (shared && Date.parse(shared.updatedAt) >= Date.parse(this.state.updatedAt)) this.state = shared;
  }

  private reloadSharedState(): void {
    const shared = this.readSharedState();
    if (shared) this.state = shared;
  }

  private readSharedState(): PersistedSshMeshState | null {
    try {
      if (!existsSync(this.paths.stateFile)) return null;
      const stat = assertSafeRegularFile(this.paths.stateFile);
      if (stat.size > 1024 * 1024) throw new Error("state file is too large");
      const parsed = JSON.parse(readFileSync(this.paths.stateFile, "utf8")) as Partial<PersistedSshMeshState>;
      if (parsed.workspaceId !== this.workspaceId || parsed.daemonId !== this.daemonId) return null;
      if (!isRuntimeStatus(parsed.status)) return null;
      return {
        workspaceId: this.workspaceId,
        daemonId: this.daemonId,
        status: parsed.status,
        keyVersion: integerOrNull(parsed.keyVersion),
        configRevision: stringOrNull(parsed.configRevision),
        probeRevision: integerOrZero(parsed.probeRevision),
        publicKeyInstalled: parsed.publicKeyInstalled === true,
        configInstalled: parsed.configInstalled === true,
        fileDigests: parseManagedFileDigests(parsed.fileDigests),
        peers: Array.isArray(parsed.peers) ? parsed.peers.filter(isPeerProbe).map((peer) => ({ ...peer })) : [],
        lastErrorCode: stringOrNull(parsed.lastErrorCode),
        lastError: stringOrNull(parsed.lastError),
        attempts: integerOrZero(parsed.attempts),
        nextRetryAt: stringOrNull(parsed.nextRetryAt),
        lastProbeAt: stringOrNull(parsed.lastProbeAt),
        updatedAt: stringOrNull(parsed.updatedAt) ?? new Date(0).toISOString(),
      };
    } catch {
      return null;
    }
  }

  private persistState(fence?: () => void): void {
    fence?.();
    ensureManagedDirectories(this.paths);
    atomicWriteFile(this.paths.stateFile, `${JSON.stringify(this.state, null, 2)}\n`, 0o600, fence);
  }
}

export function renderSshConfig(hosts: PreparedHost[], paths: Pick<SshMeshPaths, "privateKey" | "knownHosts">): string {
  const blocks = hosts.map((host) => [
    `Host ${host.alias}`,
    `  HostName ${host.hostName}`,
    `  User ${host.sshUser}`,
    `  Port ${host.port}`,
    `  IdentityFile ${quoteSshConfigValue(paths.privateKey)}`,
    "  IdentitiesOnly yes",
    "  BatchMode yes",
    "  StrictHostKeyChecking yes",
    `  UserKnownHostsFile ${quoteSshConfigValue(paths.knownHosts)}`,
    "  ConnectTimeout 5",
    "  ConnectionAttempts 1",
  ].join("\n"));
  return `# Generated by Multiremi. Do not edit.\n${blocks.join("\n\n")}${blocks.length ? "\n" : ""}`;
}

export function renderKnownHosts(hosts: PreparedHost[]): string {
  const lines: string[] = ["# Generated by Multiremi. Do not edit."];
  for (const host of hosts) {
    const names = uniqueStrings([
      knownHostName(host.alias, host.port),
      knownHostName(host.hostName, host.port),
      ...host.addresses.map((address) => knownHostName(address, host.port)),
      ...(host.hostname ? [knownHostName(host.hostname, host.port)] : []),
    ]);
    for (const key of host.hostKeys) lines.push(`${names.join(",")} ${key}`);
  }
  return `${lines.join("\n")}\n`;
}

export function replaceManagedBlock(
  original: string,
  startMarker: string,
  endMarker: string,
  body: string | null,
): string {
  validateMarker(startMarker);
  validateMarker(endMarker);
  const start = findLineMarker(original, startMarker);
  const duplicateStart = start >= 0 ? findLineMarker(original, startMarker, start + startMarker.length) : -1;
  if (duplicateStart >= 0) throw new SshMeshError("ssh_mesh_managed_block_duplicate", "managed SSH block appears more than once");
  const end = findLineMarker(original, endMarker);
  if ((start >= 0) !== (end >= 0) || (start >= 0 && end < start)) {
    throw new SshMeshError("ssh_mesh_managed_block_malformed", "managed SSH block is malformed");
  }
  if (end >= 0 && findLineMarker(original, endMarker, end + endMarker.length) >= 0) {
    throw new SshMeshError("ssh_mesh_managed_block_duplicate", "managed SSH block appears more than once");
  }

  let without = original;
  if (start >= 0) {
    let blockEnd = end + endMarker.length;
    if (original[blockEnd] === "\r") blockEnd++;
    if (original[blockEnd] === "\n") blockEnd++;
    if (body !== null) {
      const block = `${startMarker}\n${body.replace(/\s+$/, "")}\n${endMarker}\n`;
      return original.slice(0, start) + block + original.slice(blockEnd);
    }
    const removeStart = start >= 2 && original.slice(start - 2, start) === "\n\n"
      ? start - 1
      : start;
    without = original.slice(0, removeStart) + original.slice(blockEnd);
  }
  if (body === null) return without;

  const block = `${startMarker}\n${body.replace(/\s+$/, "")}\n${endMarker}\n`;
  if (!without) return block;
  const separator = without.endsWith("\n\n") ? "" : without.endsWith("\n") ? "\n" : "\n\n";
  return `${without}${separator}${block}`;
}

export function placeManagedBlockFirst(
  original: string,
  startMarker: string,
  endMarker: string,
  body: string,
): string {
  const hadManagedBlock = findLineMarker(original, startMarker) >= 0;
  let remainder = replaceManagedBlock(original, startMarker, endMarker, null);
  if (hadManagedBlock && remainder.startsWith("\n")) remainder = remainder.slice(1);
  const block = `${startMarker}\n${body.replace(/\s+$/, "")}\n${endMarker}\n`;
  return remainder ? `${block}\n${remainder}` : block;
}

export function classifySshProbeFailure(
  result: SshMeshCommandResult,
): Pick<MultiremiSshMeshPeerProbe, "status" | "error_code" | "error"> {
  const detail = sanitizeReportedError([result.stderr, result.stdout].filter(Boolean).join(" "));
  const lower = detail.toLowerCase();
  if (result.timedOut || /timed out|no route to host|network is unreachable|connection refused|could not resolve/.test(lower)) {
    return { status: "unreachable", error_code: "ssh_peer_unreachable", error: detail || "SSH peer is unreachable" };
  }
  if (/host key verification failed|remote host identification has changed|offending .* key/.test(lower)) {
    return { status: "host_key_mismatch", error_code: "ssh_host_key_mismatch", error: detail || "SSH host key verification failed" };
  }
  if (/permission denied|authentication failed|no supported authentication methods/.test(lower)) {
    return { status: "auth_failed", error_code: "ssh_auth_failed", error: detail || "SSH public-key authentication failed" };
  }
  return { status: "error", error_code: "ssh_probe_failed", error: detail || `SSH exited with code ${result.exitCode}` };
}

export function discoverLocalSshIdentitySync(port = sshPortFromEnvironment()): SshMeshLocalIdentity {
  let sshUser = process.env.USER?.trim() || "";
  try { sshUser = userInfo().username || sshUser; } catch { /* environment fallback */ }
  return {
    sshUser,
    hostname: osHostname(),
    port,
    addresses: discoverPrivateAddresses(),
    hostKeys: discoverHostPublicKeys(),
    sshdListening: false,
  };
}

export async function discoverLocalSshIdentity(port = sshPortFromEnvironment()): Promise<SshMeshLocalIdentity> {
  const identity = discoverLocalSshIdentitySync(port);
  return { ...identity, sshdListening: await probeTcpLoopback(port, 2_000) };
}

async function stageAndInstallPrivateKey(
  target: string,
  privateKey: string | undefined,
  expectedPublicKey: string,
  runner: SshMeshCommandRunner,
  fence: () => void,
): Promise<void> {
  if (typeof privateKey !== "string" || !privateKey.trim()) {
    if (!existsSync(target)) {
      throw new SshMeshError("ssh_mesh_private_key_missing", "SSH Mesh private key was not supplied", "error");
    }
    assertSafeRegularFile(target);
    fence();
    chmodSync(target, 0o600);
    await validatePrivateKeyFile(target, expectedPublicKey, runner);
    fence();
    return;
  }
  if (
    privateKey.length > 64 * 1024
    || privateKey.includes("\0")
    || !/^-----BEGIN OPENSSH PRIVATE KEY-----\r?\n/.test(privateKey)
    || !/\r?\n-----END OPENSSH PRIVATE KEY-----\s*$/.test(privateKey)
  ) {
    throw new SshMeshError("ssh_mesh_private_key_invalid", "SSH Mesh private key is not a valid OpenSSH private-key envelope");
  }
  const normalizedPrivateKey = `${privateKey.trim()}\n`;
  ensureSecureDirectory(dirname(target));
  assertSafeTarget(target);
  if (existsSync(target) && readFileSync(target, "utf8") === normalizedPrivateKey) {
    fence();
    chmodSync(target, 0o600);
    await validatePrivateKeyFile(target, expectedPublicKey, runner);
    fence();
    return;
  }
  const temp = `${target}.multiremi.${randomBytes(8).toString("hex")}.tmp`;
  fence();
  writeExclusiveFile(temp, normalizedPrivateKey, 0o600);
  try {
    await validatePrivateKeyFile(temp, expectedPublicKey, runner);
    fence();
    assertSafeTarget(target);
    fence();
    renameSync(temp, target);
    fence();
    chmodSync(target, 0o600);
  } finally {
    try { rmSync(temp, { force: true }); } catch { /* best effort */ }
  }
}

async function validatePrivateKeyFile(
  path: string,
  expectedPublicKey: string,
  runner: SshMeshCommandRunner,
): Promise<void> {
  const result = await runner("ssh-keygen", ["-y", "-f", path], 5_000);
  if (result.exitCode === 127) {
    throw new SshMeshError("ssh_mesh_ssh_keygen_missing", "ssh-keygen is required for SSH Mesh", "setup_required");
  }
  if (result.exitCode !== 0) {
    throw new SshMeshError("ssh_mesh_private_key_invalid", "ssh-keygen rejected the SSH Mesh private key");
  }
  const derived = requirePublicKey(result.stdout.trim(), "ssh_mesh_private_key_invalid");
  if (publicKeyIdentity(derived) !== publicKeyIdentity(expectedPublicKey)) {
    throw new SshMeshError("ssh_mesh_key_pair_mismatch", "SSH Mesh public and private keys do not match");
  }
}

function validateConfigEnvelope(config: MultiremiDaemonSshMeshConfig, desired: MultiremiSshMeshHeartbeatAck): void {
  if (config.protocol_version !== MULTIREMI_SSH_MESH_PROTOCOL_VERSION) {
    throw new SshMeshError("ssh_mesh_protocol_mismatch", "server returned an unsupported SSH Mesh protocol", "setup_required");
  }
  if (config.enabled !== desired.enabled) {
    throw new SshMeshError("ssh_mesh_stale_config", "server returned stale SSH Mesh enabled state", "error");
  }
  if (config.key_version !== desired.key_version || config.config_revision !== desired.config_revision) {
    throw new SshMeshError("ssh_mesh_stale_config", "server returned a stale SSH Mesh revision", "error");
  }
  if (!Number.isSafeInteger(config.key_version) || config.key_version < 0) {
    throw new SshMeshError("ssh_mesh_key_version_invalid", "server returned an invalid SSH Mesh key version");
  }
  if (!Number.isSafeInteger(config.probe_revision) || config.probe_revision < 0) {
    throw new SshMeshError("ssh_mesh_probe_revision_invalid", "server returned an invalid SSH Mesh probe revision");
  }
}

function prepareHosts(hosts: MultiremiDaemonSshMeshHost[]): { hosts: PreparedHost[]; invalidPeers: MultiremiSshMeshPeerProbe[] } {
  const prepared: PreparedHost[] = [];
  const invalidPeers: MultiremiSshMeshPeerProbe[] = [];
  const daemonIds = new Set<string>();
  const aliases = new Set<string>();
  for (const host of hosts) {
    const daemonId = safeIdentifier(host.daemon_id, "daemon id");
    if (daemonIds.has(daemonId)) throw new SshMeshError("ssh_mesh_duplicate_peer", "server returned a duplicate SSH Mesh daemon");
    daemonIds.add(daemonId);
    const alias = validateAlias(host.alias);
    if (aliases.has(alias)) throw new SshMeshError("ssh_mesh_duplicate_alias", "server returned a duplicate SSH alias");
    aliases.add(alias);
    const sshUser = validateSshUser(host.ssh_user);
    const port = validatePort(host.port);
    const addresses = uniqueStrings((host.addresses ?? [])
      .map(validateHostToken)
      .filter(isPrivateIpv4));
    const hostLabel = host.hostname ? validateHostToken(host.hostname) : null;
    const hostName = addresses[0];
    const hostKeys = uniqueStrings((host.host_keys ?? []).map((key) => stripPublicKeyComment(requireHostKey(key))));
    if (!sshUser || !hostName || !hostKeys.length) {
      invalidPeers.push({
        daemon_id: daemonId,
        status: "error",
        latency_ms: null,
        error_code: "ssh_peer_config_incomplete",
        error: "SSH peer has not reported a usable user, address and host key",
        checked_at: new Date().toISOString(),
      });
      continue;
    }
    prepared.push({ daemonId, alias, hostName, sshUser, port, addresses, hostname: hostLabel, hostKeys });
  }
  return { hosts: prepared, invalidPeers };
}

function ensureManagedDirectories(paths: SshMeshPaths): void {
  for (const target of [dirname(paths.meshRoot), paths.meshRoot, dirname(paths.workspaceRoot), paths.workspaceRoot, dirname(paths.configInclude), dirname(paths.sshConfig)]) {
    assertPathWithinHome(paths.home, target);
    ensureSecureDirectory(target);
  }
  for (const target of [paths.privateKey, paths.publicKey, paths.config, paths.knownHosts, paths.stateFile, paths.configInclude, paths.sshConfig, paths.authorizedKeys]) {
    assertPathWithinHome(paths.home, target);
    if (existsSync(target)) assertSafeRegularFile(target);
  }
  for (const lockPath of [paths.lockDirectory, paths.sharedFilesLockDirectory]) {
    assertPathWithinHome(paths.home, lockPath);
  }
}

function ensureSecureDirectory(path: string): void {
  const absolute = resolve(path);
  if (existsSync(absolute)) {
    assertExistingDirectoryChainSafe(absolute);
    const stat = lstatSync(absolute);
    assertOwnedByCurrentUser(stat.uid, basename(absolute));
    chmodSync(absolute, 0o700);
    return;
  }
  const missing: string[] = [];
  let cursor = absolute;
  while (!existsSync(cursor)) {
    missing.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  assertExistingDirectoryChainSafe(cursor);
  for (const directory of missing.reverse()) {
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (!existsSync(directory)) throw error;
    }
    const created = lstatSync(directory);
    if (created.isSymbolicLink() || !created.isDirectory()) {
      throw new SshMeshError("ssh_mesh_unsafe_path", `refusing unsafe directory: ${basename(directory)}`);
    }
    assertOwnedByCurrentUser(created.uid, basename(directory));
    chmodSync(directory, 0o700);
  }
}

function assertExistingDirectoryChainSafe(path: string): void {
  let cursor = resolve(path);
  while (true) {
    if (existsSync(cursor)) {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new SshMeshError("ssh_mesh_unsafe_path", `refusing unsafe directory: ${basename(cursor) || cursor}`);
      }
    }
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

function assertPathWithinHome(home: string, target: string): void {
  const canonicalHome = resolve(home);
  const absolute = resolve(target);
  if (absolute !== canonicalHome && !absolute.startsWith(`${canonicalHome}${sep}`)) {
    throw new SshMeshError("ssh_mesh_path_escape", "SSH Mesh path escapes the configured home directory");
  }
}

function assertOwnedByCurrentUser(uid: number, label: string): void {
  const current = typeof process.getuid === "function" ? process.getuid() : null;
  if (current !== null && uid !== current) {
    throw new SshMeshError("ssh_mesh_wrong_owner", `refusing ${label} because it is owned by another user`);
  }
}

function assertSafeRegularFile(path: string): Stats {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new SshMeshError("ssh_mesh_unsafe_path", `refusing unsafe SSH file: ${basename(path)}`);
  }
  assertOwnedByCurrentUser(stat.uid, basename(path));
  return stat;
}

function assertSafeTarget(path: string): void {
  if (existsSync(path)) assertSafeRegularFile(path);
}

function readRegularFile(path: string): string {
  if (!existsSync(path)) return "";
  const stat = assertSafeRegularFile(path);
  if (stat.size > 8 * 1024 * 1024) throw new SshMeshError("ssh_mesh_file_too_large", `${basename(path)} is too large to manage`);
  return readFileSync(path, "utf8");
}

function collectManagedFileDigests(paths: SshMeshPaths): ManagedFileDigests {
  return {
    privateKey: digestManagedFile(paths.privateKey),
    publicKey: digestManagedFile(paths.publicKey),
    config: digestManagedFile(paths.config),
    knownHosts: digestManagedFile(paths.knownHosts),
    configInclude: digestManagedFile(paths.configInclude),
    sshConfig: digestManagedFile(paths.sshConfig),
    authorizedKeys: digestManagedFile(paths.authorizedKeys),
  };
}

function digestManagedFile(path: string): string {
  const stat = assertSafeRegularFile(path);
  if ((stat.mode & 0o777) !== 0o600) {
    throw new SshMeshError("ssh_mesh_file_permissions", `${basename(path)} must use mode 0600`);
  }
  if (stat.size > 8 * 1024 * 1024) {
    throw new SshMeshError("ssh_mesh_file_too_large", `${basename(path)} is too large to manage`);
  }
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function managedFileDigestsEqual(left: ManagedFileDigests, right: ManagedFileDigests): boolean {
  return left.privateKey === right.privateKey
    && left.publicKey === right.publicKey
    && left.config === right.config
    && left.knownHosts === right.knownHosts
    && left.configInclude === right.configInclude
    && left.sshConfig === right.sshConfig
    && left.authorizedKeys === right.authorizedKeys;
}

function atomicWriteFile(path: string, content: string, mode: number, fence?: () => void): void {
  ensureSecureDirectory(dirname(path));
  const before = existsSync(path) ? assertSafeRegularFile(path) : null;
  if (before && readFileSync(path, "utf8") === content) {
    fence?.();
    chmodSync(path, mode);
    return;
  }
  const temp = `${path}.multiremi.${randomBytes(8).toString("hex")}.tmp`;
  fence?.();
  writeExclusiveFile(temp, content, mode);
  try {
    fence?.();
    if (before) {
      const current = assertSafeRegularFile(path);
      if (current.mtimeMs !== before.mtimeMs || current.size !== before.size || current.ino !== before.ino) {
        throw new SshMeshError("ssh_mesh_file_changed", `${basename(path)} changed while SSH Mesh was updating it`, "error");
      }
    } else if (existsSync(path)) {
      throw new SshMeshError("ssh_mesh_file_changed", `${basename(path)} appeared while SSH Mesh was updating it`, "error");
    }
    fence?.();
    renameSync(temp, path);
    fence?.();
    chmodSync(path, mode);
  } finally {
    try { rmSync(temp, { force: true }); } catch { /* best effort */ }
  }
}

function writeExclusiveFile(path: string, content: string, mode: number): void {
  const fd = openSync(path, "wx", mode);
  try {
    fchmodSync(fd, mode);
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function removeManagedRegularFile(path: string, fence?: () => void): void {
  if (!existsSync(path)) return;
  assertSafeRegularFile(path);
  fence?.();
  unlinkSync(path);
}

export function tryAcquireReconcileLock(lockPath: string, now = Date.now()): SshMeshLockLease | null {
  ensureSecureDirectory(dirname(lockPath));
  if (!tryCreateLockDirectory(lockPath)) {
    if (!existsSync(lockPath)) return null;
    const observed = inspectSshMeshLock(lockPath);
    if (!lockCanBeTakenOver(observed, now)) return null;
    const quarantine = `${lockPath}.stale-${randomBytes(12).toString("hex")}`;
    try {
      renameSync(lockPath, quarantine);
    } catch {
      return null;
    }
    let moved: ObservedSshMeshLock;
    try {
      moved = inspectSshMeshLock(quarantine);
    } catch (error) {
      tryRestoreMovedLock(quarantine, lockPath);
      throw error;
    }
    if (!sameFileIdentity(observed.directory, moved.directory)
      || (observed.owner?.nonce ?? null) !== (moved.owner?.nonce ?? null)
      || !lockCanBeTakenOver(moved, now)) {
      tryRestoreMovedLock(quarantine, lockPath);
      return null;
    }
    cleanupQuarantinedLock(quarantine);
    if (!tryCreateLockDirectory(lockPath)) return null;
  }
  return initializeSshMeshLockLease(lockPath);
}

async function acquireSharedFilesLock(lockPath: string): Promise<SshMeshLockLease> {
  return acquireDirectoryLock(
    lockPath,
    "ssh_mesh_shared_files_lock_timeout",
    "timed out waiting to update shared SSH files",
  );
}

async function acquireDirectoryLock(
  lockPath: string,
  timeoutCode: string,
  timeoutMessage: string,
): Promise<SshMeshLockLease> {
  const deadline = Date.now() + SHARED_FILES_LOCK_TIMEOUT_MS;
  while (true) {
    const lease = tryAcquireReconcileLock(lockPath, Date.now());
    if (lease) return lease;
    if (Date.now() >= deadline) {
      throw new SshMeshError(timeoutCode, timeoutMessage, "error");
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, SHARED_FILES_LOCK_POLL_MS));
  }
}

function tryCreateLockDirectory(lockPath: string): boolean {
  try {
    mkdirSync(lockPath, { mode: 0o700 });
    return true;
  } catch {
    return false;
  }
}

function initializeSshMeshLockLease(lockPath: string): SshMeshLockLease {
  const directory = inspectLockDirectory(lockPath);
  const ownerPath = join(lockPath, "owner.json");
  const owner: SshMeshLockOwner = {
    version: 1,
    nonce: randomBytes(24).toString("hex"),
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    released: false,
  };
  let ownerFd: number | null = null;
  try {
    ownerFd = openSync(ownerPath, "wx", 0o600);
    fchmodSync(ownerFd, 0o600);
    writeLockOwner(ownerFd, owner);
  } catch (error) {
    if (ownerFd !== null) try { closeSync(ownerFd); } catch { /* best effort */ }
    try { rmdirSync(lockPath); } catch { /* another process will treat it as legacy */ }
    throw error;
  }

  const heartbeat = setInterval(() => {
    if (ownerFd === null || owner.released) return;
    try {
      const heartbeatAt = new Date();
      futimesSync(ownerFd, heartbeatAt, heartbeatAt);
    } catch {
      // assertOwner() fences this execution before it can resume file writes.
    }
  }, LOCK_HEARTBEAT_MS);
  heartbeat.unref?.();

  const assertOwner = () => {
    const current = inspectSshMeshLock(lockPath);
    if (!sameFileIdentity(directory, current.directory)
      || current.owner?.nonce !== owner.nonce
      || current.owner.released) {
      throw new SshMeshError("ssh_mesh_lock_lost", "SSH Mesh reconciliation lease was lost", "error");
    }
  };

  let released = false;
  return {
    assertOwner,
    release: () => {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      owner.released = true;
      if (ownerFd !== null) {
        try { writeLockOwner(ownerFd, owner); } catch { /* lease may already be quarantined */ }
        try { closeSync(ownerFd); } catch { /* best effort */ }
        ownerFd = null;
      }
    },
  };
}

interface ObservedSshMeshLock {
  directory: Stats;
  owner: SshMeshLockOwner | null;
  heartbeatMs: number;
}

function inspectSshMeshLock(lockPath: string): ObservedSshMeshLock {
  const directory = inspectLockDirectory(lockPath);
  const ownerPath = join(lockPath, "owner.json");
  if (!existsSync(ownerPath)) return { directory, owner: null, heartbeatMs: directory.mtimeMs };
  const ownerStat = assertSafeRegularFile(ownerPath);
  if (ownerStat.size > 4096) throw new SshMeshError("ssh_mesh_unsafe_lock", "SSH Mesh lock owner file is too large");
  let parsed: Partial<SshMeshLockOwner>;
  try {
    parsed = JSON.parse(readFileSync(ownerPath, "utf8")) as Partial<SshMeshLockOwner>;
  } catch {
    throw new SshMeshError("ssh_mesh_unsafe_lock", "SSH Mesh lock owner file is invalid");
  }
  if (parsed.version !== 1
    || typeof parsed.nonce !== "string"
    || !/^[a-f0-9]{48}$/.test(parsed.nonce)
    || !Number.isSafeInteger(parsed.pid)
    || typeof parsed.acquiredAt !== "string"
    || typeof parsed.released !== "boolean") {
    throw new SshMeshError("ssh_mesh_unsafe_lock", "SSH Mesh lock owner file is invalid");
  }
  return { directory, owner: parsed as SshMeshLockOwner, heartbeatMs: ownerStat.mtimeMs };
}

function inspectLockDirectory(lockPath: string): Stats {
  const stat = lstatSync(lockPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new SshMeshError("ssh_mesh_unsafe_lock", "SSH Mesh reconciliation lock is unsafe");
  }
  assertOwnedByCurrentUser(stat.uid, basename(lockPath));
  return stat;
}

function lockCanBeTakenOver(lock: ObservedSshMeshLock, now: number): boolean {
  return lock.owner?.released === true || now - lock.heartbeatMs > LOCK_STALE_MS;
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function tryRestoreMovedLock(quarantine: string, lockPath: string): void {
  if (existsSync(lockPath)) return;
  try { renameSync(quarantine, lockPath); } catch { /* another owner won the path */ }
}

function cleanupQuarantinedLock(quarantine: string): void {
  try {
    const entries = readdirSync(quarantine);
    if (entries.length === 1 && entries[0] === "owner.json") {
      const ownerPath = join(quarantine, "owner.json");
      assertSafeRegularFile(ownerPath);
      unlinkSync(ownerPath);
      rmdirSync(quarantine);
    } else if (entries.length === 0) {
      rmdirSync(quarantine);
    }
  } catch {
    // A quarantined generation is inert; leave it for an operator if unsafe.
  }
}

function writeLockOwner(fd: number, owner: SshMeshLockOwner): void {
  const payload = Buffer.from(`${JSON.stringify(owner)}\n`, "utf8");
  ftruncateSync(fd, 0);
  let offset = 0;
  while (offset < payload.length) {
    offset += writeSync(fd, payload, offset, payload.length - offset, offset);
  }
  fsyncSync(fd);
}

async function fetchSshMeshConfigWithTimeout<T>(
  load: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  code: string,
  message: string,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      load(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new SshMeshError(code, message, "error"));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    if (error instanceof SshMeshError && error.code === code) controller.abort(error);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runSshMeshCommand(executable: string, args: string[], timeoutMs: number): Promise<SshMeshCommandResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([executable, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
  } catch {
    return { exitCode: 127, stdout: "", stderr: `${executable} is not available` };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill(); } catch { /* already exited */ }
  }, timeoutMs);
  timer.unref?.();
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readCommandStream(proc.stdout as ReadableStream<Uint8Array>),
      readCommandStream(proc.stderr as ReadableStream<Uint8Array>),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

async function readCommandStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let output = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total >= MAX_COMMAND_OUTPUT_BYTES) continue;
      const remaining = MAX_COMMAND_OUTPUT_BYTES - total;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      output += decoder.decode(chunk, { stream: true });
      total += chunk.byteLength;
    }
    output += decoder.decode();
    return output;
  } finally {
    reader.releaseLock();
  }
}

function discoverPrivateAddresses(): string[] {
  const privateAddresses: Array<{ address: string; priority: number }> = [];
  for (const [interfaceName, entries] of Object.entries(networkInterfaces())) {
    if (isIgnoredNetworkInterface(interfaceName)) continue;
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4") continue;
      const interfacePriority = /^(?:e(?:th|n|ns|np|no|nx)|bond)\d/i.test(interfaceName) ? 0 : 10;
      if (isPrivateIpv4(entry.address)) {
        privateAddresses.push({
          address: entry.address,
          priority: interfacePriority + privateAddressPriority(entry.address),
        });
      }
    }
  }
  privateAddresses.sort((left, right) => left.priority - right.priority || left.address.localeCompare(right.address));
  return uniqueStrings(privateAddresses.map((entry) => entry.address));
}

function restrictLocalIdentity(identity: SshMeshLocalIdentity): SshMeshLocalIdentity {
  return {
    ...identity,
    addresses: uniqueStrings((identity.addresses ?? []).filter(isPrivateIpv4)),
  };
}

function isIgnoredNetworkInterface(name: string): boolean {
  return /^(?:lo|docker\d*|br(?:-|\d|$)|veth|virbr|podman|cni|flannel|kube|mihomo|clash|utun|tun\d*|tap\d*)/i.test(name);
}

function privateAddressPriority(address: string): number {
  if (address.startsWith("10.")) return 0;
  if (address.startsWith("172.")) return 1;
  if (address.startsWith("192.168.")) return 2;
  return 5;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
}

function discoverHostPublicKeys(root = "/etc/ssh"): string[] {
  try {
    return uniqueStrings(readdirSync(root)
      .filter((name) => /^ssh_host_[a-z0-9_]+_key\.pub$/.test(name))
      .flatMap((name) => {
        const path = join(root, name);
        try {
          const stat = lstatSync(path);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return [];
          return [stripPublicKeyComment(requireHostKey(readFileSync(path, "utf8")))];
        } catch {
          return [];
        }
      }));
  } catch {
    return [];
  }
}

async function probeTcpLoopback(port: number, timeoutMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolveProbe) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveProbe(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function requirePublicKey(value: string | undefined, code: string): string {
  if (typeof value !== "string" || value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    throw new SshMeshError(code, "SSH Mesh public key is invalid");
  }
  const parts = value.trim().split(/\s+/);
  if (parts.length < 2 || parts[0] !== "ssh-ed25519" || !validBase64(parts[1]!)) {
    throw new SshMeshError(code, "SSH Mesh public key must be an Ed25519 OpenSSH public key");
  }
  return parts.slice(0, 3).join(" ");
}

function requireHostKey(value: string): string {
  if (typeof value !== "string" || value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    throw new SshMeshError("ssh_mesh_host_key_invalid", "SSH host key is invalid");
  }
  const parts = value.trim().split(/\s+/);
  if (
    parts.length < 2
    || !/^(?:ssh-(?:ed25519|rsa)|ecdsa-sha2-nistp(?:256|384|521))$/.test(parts[0]!)
    || !validBase64(parts[1]!)
  ) {
    throw new SshMeshError("ssh_mesh_host_key_invalid", "SSH host key uses an invalid OpenSSH format");
  }
  return parts.slice(0, 2).join(" ");
}

function uniquePublicKeys(keys: string[]): string[] {
  const byIdentity = new Map<string, string>();
  for (const key of keys) {
    const parsed = requirePublicKey(key, "ssh_mesh_authorized_key_invalid");
    byIdentity.set(publicKeyIdentity(parsed), parsed);
  }
  return [...byIdentity.values()];
}

function stripPublicKeyComment(key: string): string {
  return key.trim().split(/\s+/).slice(0, 2).join(" ");
}

function publicKeyIdentity(key: string): string {
  return stripPublicKeyComment(key);
}

function validBase64(value: string): boolean {
  return value.length >= 16 && value.length <= 16 * 1024 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function validateAlias(value: string): string {
  if (!/^remi-[A-Za-z0-9][A-Za-z0-9._-]{0,126}$/.test(value)) {
    throw new SshMeshError("ssh_mesh_alias_invalid", "server returned an invalid SSH Mesh alias");
  }
  return value;
}

function validateSshUser(value: string | null): string | null {
  if (value === null || value === "") return null;
  if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}\$?$/.test(value)) {
    throw new SshMeshError("ssh_mesh_user_invalid", "server returned an invalid SSH user");
  }
  return value;
}

function validateHostToken(value: string): string {
  if (!value || value.length > 255 || /[\s#"'`,=*?![\]\\]/.test(value) || value.startsWith("-")) {
    throw new SshMeshError("ssh_mesh_host_invalid", "server returned an invalid SSH host name or address");
  }
  return value;
}

function validatePort(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new SshMeshError("ssh_mesh_port_invalid", "server returned an invalid SSH port");
  }
  return value;
}

function safeIdentifier(value: string, label: string): string {
  if (!value || value.length > 255 || /[\r\n\0]/.test(value)) {
    throw new SshMeshError("ssh_mesh_identifier_invalid", `server returned an invalid ${label}`);
  }
  return value;
}

function quoteSshConfigValue(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new SshMeshError("ssh_mesh_path_invalid", "SSH config path is invalid");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function knownHostName(value: string, port: number): string {
  return port === 22 ? value : `[${value}]:${port}`;
}

function workspaceMarker(workspaceId: string): string {
  return createHash("sha256").update(workspaceId).digest("hex").slice(0, 16);
}

function authorizedBlockStart(marker: string): string {
  return `# >>> multiremi ssh mesh ${marker} >>>`;
}

function authorizedBlockEnd(marker: string): string {
  return `# <<< multiremi ssh mesh ${marker} <<<`;
}

function validateMarker(marker: string): void {
  if (!marker || /[\r\n]/.test(marker)) throw new SshMeshError("ssh_mesh_marker_invalid", "managed SSH marker is invalid");
}

function findLineMarker(content: string, marker: string, from = 0): number {
  let index = content.indexOf(marker, from);
  while (index >= 0) {
    const before = index === 0 || content[index - 1] === "\n";
    const afterIndex = index + marker.length;
    const after = afterIndex === content.length || content[afterIndex] === "\n" || (content[afterIndex] === "\r" && content[afterIndex + 1] === "\n");
    if (before && after) return index;
    index = content.indexOf(marker, index + marker.length);
  }
  return -1;
}

function mergePeerProbes(existing: MultiremiSshMeshPeerProbe[], updates: MultiremiSshMeshPeerProbe[]): MultiremiSshMeshPeerProbe[] {
  const merged = new Map(existing.map((peer) => [peer.daemon_id, { ...peer }]));
  for (const peer of updates) merged.set(peer.daemon_id, { ...peer });
  return [...merged.values()].sort((left, right) => left.daemon_id.localeCompare(right.daemon_id));
}

function sanitizeReportedError(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_REPORTED_ERROR_CHARS);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function sshPortFromEnvironment(): number {
  const parsed = Number(process.env.MULTIREMI_SSH_PORT ?? "22");
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : 22;
}

function emptyState(workspaceId: string, daemonId: string, now: number): PersistedSshMeshState {
  return {
    workspaceId,
    daemonId,
    status: "syncing",
    keyVersion: null,
    configRevision: null,
    probeRevision: 0,
    publicKeyInstalled: false,
    configInstalled: false,
    fileDigests: null,
    peers: [],
    lastErrorCode: null,
    lastError: null,
    attempts: 0,
    nextRetryAt: null,
    lastProbeAt: null,
    updatedAt: new Date(now).toISOString(),
  };
}

function isRuntimeStatus(value: unknown): value is MultiremiSshMeshRuntimeStatus {
  return value === "disabled" || value === "syncing" || value === "ready"
    || value === "setup_required" || value === "blocked" || value === "error";
}

function isPeerProbe(value: unknown): value is MultiremiSshMeshPeerProbe {
  if (!value || typeof value !== "object") return false;
  const peer = value as Partial<MultiremiSshMeshPeerProbe>;
  return typeof peer.daemon_id === "string"
    && (peer.status === "ready" || peer.status === "unreachable" || peer.status === "host_key_mismatch" || peer.status === "auth_failed" || peer.status === "error");
}

function integerOrNull(value: unknown): number | null {
  return Number.isSafeInteger(value) ? value as number : null;
}

function integerOrZero(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function parseManagedFileDigests(value: unknown): ManagedFileDigests | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const privateKey = sha256DigestOrNull(candidate.privateKey);
  const publicKey = sha256DigestOrNull(candidate.publicKey);
  const config = sha256DigestOrNull(candidate.config);
  const knownHosts = sha256DigestOrNull(candidate.knownHosts);
  const configInclude = sha256DigestOrNull(candidate.configInclude);
  const sshConfig = sha256DigestOrNull(candidate.sshConfig);
  const authorizedKeys = sha256DigestOrNull(candidate.authorizedKeys);
  if (!privateKey || !publicKey || !config || !knownHosts || !configInclude || !sshConfig || !authorizedKeys) {
    return null;
  }
  return { privateKey, publicKey, config, knownHosts, configInclude, sshConfig, authorizedKeys };
}

function sha256DigestOrNull(value: unknown): string | null {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null;
}
