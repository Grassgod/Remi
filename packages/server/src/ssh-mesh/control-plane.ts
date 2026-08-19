import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import type {
  MultiremiDaemonSshMeshConfig,
  MultiremiDaemonSshMeshStatus,
  MultiremiSshMeshHeartbeatAck,
} from "@multiremi/contracts/types.js";
import {
  MULTIREMI_SSH_MESH_PROTOCOL_VERSION,
} from "@multiremi/contracts/types.js";
import {
  SshMeshManager,
  sshMeshPathsForRoot,
  tryAcquireReconcileLock,
  type SshMeshLockLease,
} from "@daemon/ssh-mesh.js";
import { createLogger } from "@shared/logger.js";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 5 * 60_000];
const OWNER_LOCK_RETRY_MAX_MS = 15_000;
const OWNER_LOCK_NAME = ".control-plane-owner.lock";

const log = createLogger("ssh-mesh-control-plane");

export interface ControlPlaneSshMeshStore {
  recordControlPlaneSshMeshHeartbeat(
    workspaceId: string,
    nodeId: string,
    displayName: string,
    protocolVersion: number,
    status: MultiremiDaemonSshMeshStatus,
  ): MultiremiSshMeshHeartbeatAck | null;
  getSshMeshConfigForNode(
    workspaceId: string,
    nodeId: string,
  ): MultiremiDaemonSshMeshConfig | null;
}

export interface ControlPlaneSshMeshLifecycle {
  start(): boolean | void;
  stop(): void;
}

export interface ControlPlaneSshMeshManagerContract {
  getHeartbeatStatus(): MultiremiDaemonSshMeshStatus;
  reconcile(desired: MultiremiSshMeshHeartbeatAck): Promise<void>;
}

export interface ControlPlaneSshMeshManagerFactoryInput {
  workspaceId: string;
  nodeId: string;
  root: string;
  home: string;
  getConfig: () => Promise<MultiremiDaemonSshMeshConfig>;
}

export type ControlPlaneSshMeshManagerFactory = (
  input: ControlPlaneSshMeshManagerFactoryInput,
) => ControlPlaneSshMeshManagerContract;

export interface ControlPlaneSshMeshOptions {
  store: ControlPlaneSshMeshStore;
  nodeId: string;
  displayName: string;
  workspaceIds: string[];
  root: string;
  home?: string;
  heartbeatIntervalMs?: number;
  retryDelaysMs?: number[];
  managerFactory?: ControlPlaneSshMeshManagerFactory;
  acquireOwnerLock?: (path: string) => SshMeshLockLease | null;
}

interface WorkspaceReconciler {
  workspaceId: string;
  manager: ControlPlaneSshMeshManagerContract;
}

/**
 * Makes the API host an SSH Mesh member without registering a Runtime or
 * starting any provider/task machinery.
 */
export class ControlPlaneSshMeshReconciler implements ControlPlaneSshMeshLifecycle {
  private readonly store: ControlPlaneSshMeshStore;
  private readonly nodeId: string;
  private readonly displayName: string;
  private readonly root: string;
  private readonly heartbeatIntervalMs: number;
  private readonly retryDelaysMs: number[];
  private readonly acquireOwnerLock: (path: string) => SshMeshLockLease | null;
  private readonly workspaces: WorkspaceReconciler[];
  private abortController: AbortController | null = null;
  private ownerLease: SshMeshLockLease | null = null;
  private loop: Promise<void> | null = null;

  constructor(options: ControlPlaneSshMeshOptions) {
    this.store = options.store;
    this.nodeId = validateIdentifier(options.nodeId, "control-plane node id");
    this.displayName = validateIdentifier(options.displayName, "control-plane display name");
    this.root = validateStableRoot(options.root, options.home ?? homedir());
    this.heartbeatIntervalMs = positiveInteger(
      options.heartbeatIntervalMs,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
      "heartbeat interval",
    );
    this.retryDelaysMs = normalizeRetryDelays(options.retryDelaysMs);
    this.acquireOwnerLock = options.acquireOwnerLock ?? ((path) => tryAcquireReconcileLock(path));

    const workspaceIds = uniqueWorkspaceIds(options.workspaceIds);
    const home = canonicalHome(options.home ?? homedir());
    const managerFactory = options.managerFactory ?? defaultManagerFactory;
    this.workspaces = workspaceIds.map((workspaceId) => ({
      workspaceId,
      manager: managerFactory({
        workspaceId,
        nodeId: this.nodeId,
        root: this.root,
        home,
        getConfig: async () => {
          const config = this.store.getSshMeshConfigForNode(workspaceId, this.nodeId);
          if (!config) {
            throw new Error(`SSH Mesh workspace is unavailable for control-plane node ${this.nodeId}`);
          }
          return config;
        },
      }),
    }));
  }

  start(): boolean {
    if (this.loop) return true;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    this.loop = this.acquireAndRun(signal).finally(() => {
      if (this.abortController?.signal === signal) this.abortController = null;
      this.loop = null;
    });
    return true;
  }

  stop(): void {
    this.abortController?.abort();
    // The per-workspace reconciliation lease still fences an in-flight write.
    // Releasing this outer process lease synchronously lets a normal systemd
    // restart take ownership without waiting for the crash-stale timeout.
    const ownerLease = this.ownerLease;
    if (ownerLease) {
      ownerLease.release();
      if (this.ownerLease === ownerLease) this.ownerLease = null;
    }
  }

  async whenStopped(): Promise<void> {
    await this.loop;
  }

  private async acquireAndRun(signal: AbortSignal): Promise<void> {
    let attempts = 0;
    while (!signal.aborted) {
      let ownerLease: SshMeshLockLease | null = null;
      try {
        ownerLease = this.acquireOwnerLock(join(this.root, OWNER_LOCK_NAME));
      } catch (error) {
        log.warn("failed to acquire the control-plane SSH Mesh owner lease", {
          error: diagnosticError(error),
        });
      }
      if (ownerLease) {
        this.ownerLease = ownerLease;
        try {
          await this.run(signal);
        } finally {
          ownerLease.release();
          if (this.ownerLease === ownerLease) this.ownerLease = null;
        }
        return;
      }

      attempts++;
      if (attempts === 1) {
        log.warn("control-plane SSH Mesh owner lease is busy; acquisition will be retried");
      }
      const delay = this.retryDelaysMs[
        Math.min(attempts - 1, this.retryDelaysMs.length - 1)
      ] ?? this.heartbeatIntervalMs;
      await abortableDelay(Math.min(delay, OWNER_LOCK_RETRY_MAX_MS), signal);
    }
  }

  private async run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      const succeeded = await this.reconcileOnce(signal);
      if (signal.aborted) return;
      failures = succeeded ? 0 : failures + 1;
      const retryDelay = this.retryDelaysMs[
        Math.min(Math.max(0, failures - 1), this.retryDelaysMs.length - 1)
      ];
      const delay = succeeded
        ? this.heartbeatIntervalMs
        : retryDelay ?? this.heartbeatIntervalMs;
      await abortableDelay(delay, signal);
    }
  }

  private async reconcileOnce(signal: AbortSignal): Promise<boolean> {
    let succeeded = true;
    for (const workspace of this.workspaces) {
      if (signal.aborted) return succeeded;
      try {
        await this.reconcileWorkspace(workspace);
      } catch (error) {
        succeeded = false;
        log.warn(
          `control-plane SSH Mesh reconciliation failed for workspace ${workspace.workspaceId}`,
          { error: diagnosticError(error) },
        );
      }
    }
    return succeeded;
  }

  private async reconcileWorkspace(workspace: WorkspaceReconciler): Promise<void> {
    let desired = this.report(workspace);
    if (!desired) {
      throw new Error(`workspace ${workspace.workspaceId} rejected the control-plane SSH Mesh heartbeat`);
    }

    // A heartbeat can finalize a key rollout and therefore create one more
    // desired revision. Bound convergence so a bad Store can never spin here.
    for (let pass = 0; pass < 2; pass++) {
      await workspace.manager.reconcile(desired);
      const next = this.report(workspace);
      if (!next) {
        throw new Error(`workspace ${workspace.workspaceId} rejected the control-plane SSH Mesh heartbeat`);
      }
      if (!next.needs_sync && !next.needs_probe) return;
      desired = next;
    }

    // Publish the result of the second bounded pass. Any concurrent revision is
    // picked up by the next heartbeat rather than overlapping this one.
    this.report(workspace);
  }

  private report(workspace: WorkspaceReconciler): MultiremiSshMeshHeartbeatAck | null {
    return this.store.recordControlPlaneSshMeshHeartbeat(
      workspace.workspaceId,
      this.nodeId,
      this.displayName,
      MULTIREMI_SSH_MESH_PROTOCOL_VERSION,
      workspace.manager.getHeartbeatStatus(),
    );
  }
}

export function createControlPlaneSshMeshFromEnv(
  store: ControlPlaneSshMeshStore,
  env: Record<string, string | undefined> = process.env,
): ControlPlaneSshMeshReconciler | null {
  if (env.MULTIREMI_SSH_MESH_CONTROL_PLANE !== "1") return null;
  const nodeId = requiredEnv(env, "MULTIREMI_SSH_MESH_CONTROL_PLANE_NODE_ID");
  const root = requiredEnv(env, "MULTIREMI_SSH_MESH_CONTROL_PLANE_ROOT");
  const workspaceIds = (env.MULTIREMI_SSH_MESH_CONTROL_PLANE_WORKSPACE_IDS ?? "local")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return new ControlPlaneSshMeshReconciler({
    store,
    nodeId,
    displayName: env.MULTIREMI_SSH_MESH_CONTROL_PLANE_DISPLAY_NAME?.trim() || nodeId,
    workspaceIds,
    root,
  });
}

function defaultManagerFactory(
  input: ControlPlaneSshMeshManagerFactoryInput,
): ControlPlaneSshMeshManagerContract {
  return new SshMeshManager({
    workspaceId: input.workspaceId,
    daemonId: input.nodeId,
    paths: sshMeshPathsForRoot(input.workspaceId, input.root, input.home),
    getConfig: input.getConfig,
  });
}

function canonicalHome(home: string): string {
  return existsSync(home) ? realpathSync(home) : resolve(home);
}

function validateStableRoot(root: string, home: string): string {
  if (!isAbsolute(root)) {
    throw new Error("MULTIREMI_SSH_MESH_CONTROL_PLANE_ROOT must be an absolute path");
  }
  const canonical = resolve(root);
  const canonicalUserHome = canonicalHome(home);
  if (canonical === canonicalUserHome || !canonical.startsWith(`${canonicalUserHome}${sep}`)) {
    throw new Error("MULTIREMI_SSH_MESH_CONTROL_PLANE_ROOT must be inside the service user's home");
  }
  return canonical;
}

function validateIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 255 || /[\r\n\0]/.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function uniqueWorkspaceIds(values: string[]): string[] {
  const result = [...new Set(values.map((value) => validateIdentifier(value, "workspace id")))];
  if (!result.length) throw new Error("at least one control-plane SSH Mesh workspace is required");
  return result;
}

function requiredEnv(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required when control-plane SSH Mesh is enabled`);
  return value;
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function normalizeRetryDelays(values: number[] | undefined): number[] {
  if (values === undefined) return [...DEFAULT_RETRY_DELAYS_MS];
  if (!values.length) throw new Error("retry delays must not be empty");
  return values.map((value) => positiveInteger(value, 1, "retry delay"));
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolveWait) => {
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal.addEventListener("abort", done, { once: true });

    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolveWait();
    }
  });
}

function diagnosticError(error: unknown): string {
  const fallback = error instanceof Error ? error.name : "unknown_error";
  const message = error instanceof Error ? error.message : String(error);
  if (!message || /private key|bearer\s+|api[_ -]?key|token|secret/i.test(message)) return fallback;
  return message.replace(/[\r\n\0]+/g, " ").slice(0, 300);
}
