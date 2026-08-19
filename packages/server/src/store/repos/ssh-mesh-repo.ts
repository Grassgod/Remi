import { createHash } from "node:crypto";
import {
  MULTIREMI_SSH_MESH_PROTOCOL_VERSION,
  type MultiremiDaemonSshMeshConfig,
  type MultiremiDaemonSshMeshStatus,
  type MultiremiSshMeshHeartbeatAck,
  type MultiremiSshMeshNodeKind,
  type MultiremiSshMeshPeerProbe,
  type MultiremiSshMeshRuntimeStatus,
} from "@multiremi/contracts/types.js";
import { createId, nowIso } from "@multiremi/ids.js";
import {
  decryptSshMeshPrivateKey,
  encryptSshMeshPrivateKey,
  type SshMeshKeyMaterial,
} from "@multiremi/ssh-mesh/keys.js";
import { type StoreContext } from "@multiremi/store/context.js";
import { nullableString, parseJson, toJson } from "@multiremi/store/helpers.js";
import {
  isRuntimeEffectivelyOnline,
  RUNTIME_HEARTBEAT_STALE_MS,
} from "@multiremi/store/repos/runtimes-repo.js";

type Row = Record<string, unknown>;

export type SshMeshRotationState = "stable" | "rolling_out" | "rekey_required";

export interface SshMeshBrowserNode {
  node_id: string;
  node_type: MultiremiSshMeshNodeKind;
  /** Compatibility alias for protocol v1 and older browser clients. */
  daemon_id: string;
  runtime_ids: string[];
  name: string;
  ssh_alias: string;
  status: MultiremiSshMeshRuntimeStatus | "offline";
  protocol_version: number;
  key_version: number | null;
  config_revision: string | null;
  desired_config_revision: string;
  ssh_user: string | null;
  hostname: string | null;
  port: number;
  addresses: string[];
  host_keys: string[];
  public_key_installed: boolean;
  config_installed: boolean;
  probe_revision: number;
  desired_probe_revision: number;
  peer_tests: MultiremiSshMeshPeerProbe[];
  last_error_code: string | null;
  last_error: string | null;
  last_reported_at: string | null;
}

export interface SshMeshBrowserRuntime extends SshMeshBrowserNode {
  node_type: "runtime";
}

export interface SshMeshBrowserOverview {
  workspace_id: string;
  enabled: boolean;
  key_version: number;
  fingerprint: string | null;
  rotation_state: SshMeshRotationState;
  config_revision: string;
  rotation_ready_nodes: number;
  rotation_total_nodes: number;
  /** Compatibility counters. These continue to count runtime daemon nodes only. */
  rotation_ready_daemons: number;
  rotation_total_daemons: number;
  created_at: string | null;
  updated_at: string | null;
  nodes: SshMeshBrowserNode[];
  runtimes: SshMeshBrowserRuntime[];
}

export class SshMeshProbeConflictError extends Error {
  constructor(
    readonly code: string,
    readonly sourceDaemonId: string,
    message: string,
  ) {
    super(message);
    this.name = "SshMeshProbeConflictError";
  }

  get sourceNodeId(): string {
    return this.sourceDaemonId;
  }
}

export class SshMeshMutationConflictError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SshMeshMutationConflictError";
  }
}

interface SshMeshWorkspaceConfigRow {
  workspaceId: string;
  enabled: boolean;
  activeKeyVersion: number;
  activePrivateKeyEncrypted: string | null;
  activePublicKey: string | null;
  activeFingerprint: string | null;
  activeOperationId: string | null;
  previousKeyVersion: number | null;
  previousPrivateKeyEncrypted: string | null;
  previousPublicKey: string | null;
  previousFingerprint: string | null;
  rotationState: SshMeshRotationState;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DaemonInventoryEntry {
  daemonId: string;
  nodeKind: MultiremiSshMeshNodeKind;
  runtimeIds: string[];
  name: string;
  online: boolean;
}

interface DaemonStateRow {
  workspaceId: string;
  daemonId: string;
  nodeKind: MultiremiSshMeshNodeKind;
  name: string | null;
  runtimeId: string | null;
  protocolVersion: number;
  status: MultiremiSshMeshRuntimeStatus;
  keyVersion: number | null;
  configRevision: string | null;
  sshUser: string | null;
  hostname: string | null;
  port: number;
  addresses: string[];
  hostKeys: string[];
  publicKeyInstalled: boolean;
  configInstalled: boolean;
  peerTests: MultiremiSshMeshPeerProbe[];
  probeRevision: number;
  desiredProbeRevision: number;
  probeTargetDaemonIds: string[];
  lastErrorCode: string | null;
  lastError: string | null;
  lastReportedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export class SshMeshRepo {
  constructor(private readonly ctx: StoreContext) {}

  getOverview(workspaceId: string): SshMeshBrowserOverview {
    const config = this.getWorkspaceConfig(workspaceId);
    const stateList = this.listDaemonStates(workspaceId);
    const inventory = this.listDaemonInventory(workspaceId, stateList);
    const states = new Map(stateList.map((state) => [state.daemonId, state]));
    const revision = this.configRevision(workspaceId, config, stateList);
    const activeVersion = config?.activeKeyVersion ?? 0;
    const onlineInventory = inventory.filter((daemon) => daemon.online);
    const runtimeInventory = onlineInventory.filter((node) => node.nodeKind === "runtime");
    const isRotationReady = (daemon: DaemonInventoryEntry): boolean => {
      const state = states.get(daemon.daemonId);
      return state?.status === "ready"
        && isDaemonStateFresh(state)
        && state.keyVersion === activeVersion
        && state.configRevision === revision;
    };
    const rotationReady = onlineInventory.filter(isRotationReady).length;
    const runtimeRotationReady = runtimeInventory.filter(isRotationReady).length;
    const nodes: SshMeshBrowserNode[] = inventory.map((daemon) => {
      const state = states.get(daemon.daemonId);
      const observedStatus = !daemon.online
        ? "offline"
        : !config?.enabled
          ? state?.status ?? "disabled"
          : !state
            || !isDaemonStateFresh(state)
            || state.protocolVersion < MULTIREMI_SSH_MESH_PROTOCOL_VERSION
            ? "setup_required"
            : state.keyVersion !== activeVersion || state.configRevision !== revision
              ? "syncing"
              : state.status;
      return {
        node_id: daemon.daemonId,
        node_type: daemon.nodeKind,
        daemon_id: daemon.daemonId,
        runtime_ids: daemon.runtimeIds,
        name: daemon.name,
        ssh_alias: sshAlias(workspaceId, daemon.daemonId, state?.hostname ?? null),
        status: observedStatus,
        protocol_version: state?.protocolVersion ?? 0,
        key_version: state?.keyVersion ?? null,
        config_revision: state?.configRevision ?? null,
        desired_config_revision: revision,
        ssh_user: state?.sshUser ?? null,
        hostname: state?.hostname ?? null,
        port: state?.port ?? 22,
        addresses: state?.addresses ?? [],
        host_keys: state?.hostKeys ?? [],
        public_key_installed: state?.publicKeyInstalled ?? false,
        config_installed: state?.configInstalled ?? false,
        probe_revision: state?.probeRevision ?? 0,
        desired_probe_revision: state?.desiredProbeRevision ?? 0,
        peer_tests: (state?.peerTests ?? []).map(withCanonicalPeerNodeId),
        last_error_code: state?.lastErrorCode ?? null,
        last_error: state?.lastError ?? null,
        last_reported_at: state?.lastReportedAt ?? null,
      };
    });
    return {
      workspace_id: workspaceId,
      enabled: config?.enabled ?? false,
      key_version: activeVersion,
      fingerprint: config?.activeFingerprint ?? null,
      rotation_state: config?.rotationState ?? "stable",
      config_revision: revision,
      rotation_ready_nodes: rotationReady,
      rotation_total_nodes: onlineInventory.length,
      rotation_ready_daemons: runtimeRotationReady,
      rotation_total_daemons: runtimeInventory.length,
      created_at: config?.createdAt ?? null,
      updated_at: config?.updatedAt ?? null,
      nodes,
      runtimes: nodes.filter((node): node is SshMeshBrowserRuntime => node.node_type === "runtime"),
    };
  }

  getMutationState(workspaceId: string): {
    overview: SshMeshBrowserOverview;
    activeOperationId: string | null;
  } {
    return {
      overview: this.getOverview(workspaceId),
      activeOperationId: this.getWorkspaceConfig(workspaceId)?.activeOperationId ?? null,
    };
  }

  getRuntimeWorkspaceId(runtimeId: string): string | null {
    return this.runtimeIdentity(runtimeId)?.workspaceId ?? null;
  }

  setEnabled(
    workspaceId: string,
    enabled: boolean,
    keyMaterial: SshMeshKeyMaterial | null,
    createdBy: string | null,
    operationId: string | null = null,
  ): SshMeshBrowserOverview {
    this.assertWorkspaceExists(workspaceId);
    const current = this.getWorkspaceConfig(workspaceId);
    if (!current) {
      if (enabled && !keyMaterial) throw new Error("SSH Mesh key material is required when enabling for the first time");
      const now = nowIso();
      const version = keyMaterial ? 1 : 0;
      this.ctx.db.run(
        `INSERT INTO multiremi_workspace_ssh_mesh (
           workspace_id, enabled, active_key_version, active_private_key_encrypted,
           active_public_key, active_fingerprint, active_operation_id, rotation_state,
           created_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'stable', ?, ?, ?)`,
        [
          workspaceId,
          enabled ? 1 : 0,
          version,
          keyMaterial ? encryptSshMeshPrivateKey(keyMaterial.privateKey, workspaceId, version) : null,
          keyMaterial?.publicKey ?? null,
          keyMaterial?.fingerprint ?? null,
          keyMaterial ? operationId : null,
          createdBy,
          now,
          now,
        ],
      );
      return this.getOverview(workspaceId);
    }
    if (keyMaterial) {
      if (current.activePrivateKeyEncrypted || current.activePublicKey) {
        throw new Error("SSH Mesh already has a key; use the rotate endpoint to replace it");
      }
      if (!enabled) throw new Error("SSH Mesh cannot install key material while disabled");
      const version = current.activeKeyVersion + 1;
      const updated = this.ctx.db.run(
        `UPDATE multiremi_workspace_ssh_mesh
         SET enabled = 1, active_key_version = ?, active_private_key_encrypted = ?,
             active_public_key = ?, active_fingerprint = ?, active_operation_id = ?, previous_key_version = NULL,
             previous_private_key_encrypted = NULL, previous_public_key = NULL,
             previous_fingerprint = NULL, rotation_state = 'stable', updated_at = ?
         WHERE workspace_id = ? AND active_key_version = ?
           AND enabled = 0
           AND active_private_key_encrypted IS NULL AND active_public_key IS NULL
           AND (rotation_state = 'rekey_required' OR active_key_version = 0)`,
        [
          version,
          encryptSshMeshPrivateKey(keyMaterial.privateKey, workspaceId, version),
          keyMaterial.publicKey,
          keyMaterial.fingerprint,
          operationId,
          nowIso(),
          workspaceId,
          current.activeKeyVersion,
        ],
      );
      if (updated.changes !== 1) throw new Error("SSH Mesh key changed concurrently; retry enable");
      return this.getOverview(workspaceId);
    }
    if (!enabled && current.rotationState === "rolling_out") {
      throw new SshMeshMutationConflictError(
        "ssh_mesh_rotation_in_progress",
        "SSH Mesh key rotation is in progress; confirm key invalidation to disable",
      );
    }
    if (enabled && !current.activePrivateKeyEncrypted) {
      throw new Error("SSH Mesh key material is missing");
    }
    this.ctx.db.run(
      "UPDATE multiremi_workspace_ssh_mesh SET enabled = ?, updated_at = ? WHERE workspace_id = ?",
      [enabled ? 1 : 0, nowIso(), workspaceId],
    );
    return this.getOverview(workspaceId);
  }

  invalidate(
    workspaceId: string,
    operationId: string | null = createId("sshinvalidate"),
  ): SshMeshBrowserOverview {
    this.assertWorkspaceExists(workspaceId);
    const current = this.getWorkspaceConfig(workspaceId);
    if (!current) {
      const now = nowIso();
      this.ctx.db.run(
        `INSERT INTO multiremi_workspace_ssh_mesh (
           workspace_id, enabled, active_key_version, active_operation_id,
           rotation_state, created_at, updated_at
         ) VALUES (?, 0, 1, ?, 'rekey_required', ?, ?)`,
        [workspaceId, operationId, now, now],
      );
      return this.getOverview(workspaceId);
    }
    this.ctx.db.run(
      `UPDATE multiremi_workspace_ssh_mesh
       SET enabled = 0, active_key_version = active_key_version + 1,
           active_private_key_encrypted = NULL, active_public_key = NULL,
           active_fingerprint = NULL, active_operation_id = ?, previous_key_version = NULL,
           previous_private_key_encrypted = NULL, previous_public_key = NULL,
           previous_fingerprint = NULL, rotation_state = 'rekey_required', updated_at = ?
       WHERE workspace_id = ?
         AND (rotation_state != 'rekey_required'
           OR active_private_key_encrypted IS NOT NULL
           OR active_public_key IS NOT NULL
           OR previous_private_key_encrypted IS NOT NULL
           OR previous_public_key IS NOT NULL)`,
      [operationId, nowIso(), workspaceId],
    );
    return this.getOverview(workspaceId);
  }

  rotate(
    workspaceId: string,
    keyMaterial: SshMeshKeyMaterial,
    operationId: string | null = null,
  ): SshMeshBrowserOverview {
    const current = this.getWorkspaceConfig(workspaceId);
    if (!current?.enabled || !current.activePrivateKeyEncrypted || !current.activePublicKey) {
      throw new Error("SSH Mesh must be enabled before its key can be rotated");
    }
    if (current.rotationState === "rolling_out") {
      throw new Error("SSH Mesh key rotation is already in progress");
    }
    const version = current.activeKeyVersion + 1;
    const updated = this.ctx.db.run(
      `UPDATE multiremi_workspace_ssh_mesh
       SET active_key_version = ?, active_private_key_encrypted = ?, active_public_key = ?, active_fingerprint = ?,
           active_operation_id = ?,
           previous_key_version = ?, previous_private_key_encrypted = ?, previous_public_key = ?, previous_fingerprint = ?,
           rotation_state = 'rolling_out', updated_at = ?
       WHERE workspace_id = ?
         AND enabled = 1
         AND rotation_state = 'stable'
         AND active_key_version = ?
         AND active_private_key_encrypted = ?
         AND active_public_key = ?`,
      [
        version,
        encryptSshMeshPrivateKey(keyMaterial.privateKey, workspaceId, version),
        keyMaterial.publicKey,
        keyMaterial.fingerprint,
        operationId,
        current.activeKeyVersion,
        current.activePrivateKeyEncrypted,
        current.activePublicKey,
        current.activeFingerprint,
        nowIso(),
        workspaceId,
        current.activeKeyVersion,
        current.activePrivateKeyEncrypted,
        current.activePublicKey,
      ],
    );
    if (updated.changes !== 1) throw new Error("SSH Mesh key changed concurrently; retry rotation");
    this.maybeFinalizeRotation(workspaceId);
    return this.getOverview(workspaceId);
  }

  recordHeartbeat(
    runtimeId: string,
    protocolVersion: number,
    observed?: MultiremiDaemonSshMeshStatus,
  ): MultiremiSshMeshHeartbeatAck | null {
    const runtime = this.runtimeIdentity(runtimeId);
    if (!runtime?.daemonId) return null;
    return this.recordNodeHeartbeat(
      runtime.workspaceId,
      runtime.daemonId,
      "runtime",
      null,
      runtimeId,
      protocolVersion,
      observed,
    );
  }

  recordControlPlaneHeartbeat(
    workspaceId: string,
    nodeId: string,
    name: string,
    protocolVersion: number,
    observed?: MultiremiDaemonSshMeshStatus,
  ): MultiremiSshMeshHeartbeatAck {
    this.assertWorkspaceExists(workspaceId);
    const normalizedNodeId = normalizeRequiredNodeValue(nodeId, "control-plane node id", 255);
    const normalizedName = normalizeRequiredNodeValue(name, "control-plane node name", 255);
    return this.recordNodeHeartbeat(
      workspaceId,
      normalizedNodeId,
      "control_plane",
      normalizedName,
      null,
      protocolVersion,
      observed,
    );
  }

  private recordNodeHeartbeat(
    workspaceId: string,
    nodeId: string,
    nodeKind: MultiremiSshMeshNodeKind,
    name: string | null,
    runtimeId: string | null,
    protocolVersion: number,
    observed?: MultiremiDaemonSshMeshStatus,
  ): MultiremiSshMeshHeartbeatAck {
    this.assertNodeKindCompatible(workspaceId, nodeId, nodeKind);
    const currentState = this.getDaemonState(workspaceId, nodeId);
    const workspaceConfig = this.getWorkspaceConfig(workspaceId);
    const now = nowIso();
    const normalizedProtocolVersion = normalizeNonNegativeInt(protocolVersion, 0);
    const status = normalizedProtocolVersion < MULTIREMI_SSH_MESH_PROTOCOL_VERSION || observed === undefined
      ? workspaceConfig?.enabled ? "setup_required" : "disabled"
      : normalizeRuntimeStatus(observed.status);
    const peers = observed?.peers === undefined
      ? currentState?.peerTests ?? []
      : normalizePeerTests(observed.peers, now);
    const observedProbeRevision = normalizeNonNegativeInt(
      observed?.probe_revision,
      currentState?.probeRevision ?? 0,
    );
    this.ctx.db.run(
      `INSERT INTO multiremi_daemon_ssh_mesh_states (
         workspace_id, daemon_id, node_kind, name, runtime_id, protocol_version, status, key_version, config_revision,
         ssh_user, hostname, ssh_port, addresses, host_keys, public_key_installed, config_installed,
         peer_tests, probe_revision, desired_probe_revision, probe_target_daemon_ids,
         last_error_code, last_error, last_reported_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, daemon_id) DO UPDATE SET
         node_kind = excluded.node_kind,
         name = excluded.name,
         runtime_id = excluded.runtime_id,
         protocol_version = excluded.protocol_version,
         status = excluded.status,
         key_version = excluded.key_version,
         config_revision = excluded.config_revision,
         ssh_user = excluded.ssh_user,
         hostname = excluded.hostname,
         ssh_port = excluded.ssh_port,
         addresses = excluded.addresses,
         host_keys = excluded.host_keys,
         public_key_installed = excluded.public_key_installed,
         config_installed = excluded.config_installed,
         peer_tests = excluded.peer_tests,
         probe_revision = excluded.probe_revision,
         last_error_code = excluded.last_error_code,
         last_error = excluded.last_error,
         last_reported_at = excluded.last_reported_at,
         updated_at = excluded.updated_at`,
      [
        workspaceId,
        nodeId,
        nodeKind,
        name,
        runtimeId,
        normalizedProtocolVersion,
        status,
        normalizeNullablePositiveInt(observed?.key_version, currentState?.keyVersion ?? null),
        normalizeNullableString(observed?.config_revision, currentState?.configRevision ?? null, 128),
        normalizeNullableString(observed?.ssh_user, currentState?.sshUser ?? null, 128),
        normalizeNullableString(observed?.hostname, currentState?.hostname ?? null, 255),
        normalizePort(observed?.port, currentState?.port ?? 22),
        toJson(observed?.addresses === undefined ? currentState?.addresses ?? [] : normalizeStrings(observed.addresses, 32, 255)),
        toJson(observed?.host_keys === undefined ? currentState?.hostKeys ?? [] : normalizeHostKeys(observed.host_keys)),
        observed?.public_key_installed === undefined
          ? currentState?.publicKeyInstalled ? 1 : 0
          : observed.public_key_installed ? 1 : 0,
        observed?.config_installed === undefined
          ? currentState?.configInstalled ? 1 : 0
          : observed.config_installed ? 1 : 0,
        toJson(peers),
        observedProbeRevision,
        currentState?.desiredProbeRevision ?? 0,
        toJson(currentState?.probeTargetDaemonIds ?? []),
        normalizeNullableString(observed?.last_error_code, currentState?.lastErrorCode ?? null, 128),
        normalizeNullableString(observed?.last_error, currentState?.lastError ?? null, 2000),
        now,
        currentState?.createdAt ?? now,
        now,
      ],
    );
    const refreshedState = this.getDaemonState(workspaceId, nodeId);
    if (
      observed?.probe_revision !== undefined
      && refreshedState
      && observedProbeRevision >= refreshedState.desiredProbeRevision
      && refreshedState.probeTargetDaemonIds.length
    ) {
      this.ctx.db.run(
        `UPDATE multiremi_daemon_ssh_mesh_states
         SET probe_target_daemon_ids = '[]', updated_at = ?
         WHERE workspace_id = ? AND daemon_id = ? AND desired_probe_revision <= ?`,
        [now, workspaceId, nodeId, observedProbeRevision],
      );
    }
    this.maybeFinalizeRotation(workspaceId);
    const ack = this.heartbeatAck(workspaceId, nodeId);
    this.ctx.emitWorkspaceEvent({
      type: "daemon:heartbeat",
      workspaceId,
      actorType: nodeKind === "runtime" ? "daemon" : "system",
      actorId: nodeId,
      payload: {
        runtime_id: runtimeId,
        node_id: nodeId,
        node_type: nodeKind,
        daemon_id: nodeId,
        ssh_mesh: {
          status,
          ...ack,
        },
      },
    });
    return ack;
  }

  getDaemonConfig(runtimeId: string): MultiremiDaemonSshMeshConfig | null {
    const runtime = this.runtimeIdentity(runtimeId);
    if (!runtime?.daemonId) return null;
    return this.getNodeConfig(runtime.workspaceId, runtime.daemonId);
  }

  getNodeConfig(workspaceId: string, nodeId: string): MultiremiDaemonSshMeshConfig | null {
    const config = this.getWorkspaceConfig(workspaceId);
    const states = this.listDaemonStates(workspaceId);
    const ownState = states.find((state) => state.daemonId === nodeId);
    if (!ownState) {
      const runtime = this.ctx.db.query(
        `SELECT 1 FROM multiremi_runtimes runtime
         WHERE COALESCE(runtime.workspace_id, 'local') = ?
           AND runtime.daemon_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM multiremi_daemon_retirements retired
             WHERE retired.workspace_id = ? AND retired.daemon_id = runtime.daemon_id
           )
         LIMIT 1`,
      ).get(workspaceId, nodeId, workspaceId) as Row | null;
      if (!runtime) return null;
    }
    const enabled = config?.enabled ?? false;
    const keyVersion = config?.activeKeyVersion ?? 0;
    const response: MultiremiDaemonSshMeshConfig = {
      protocol_version: MULTIREMI_SSH_MESH_PROTOCOL_VERSION,
      enabled,
      key_version: keyVersion,
      config_revision: this.configRevision(workspaceId, config, states),
      rotation_state: config?.rotationState ?? "stable",
      probe_revision: ownState?.desiredProbeRevision ?? 0,
      probe_target_daemon_ids: ownState?.probeTargetDaemonIds ?? [],
      authorized_public_keys: enabled
        ? [config?.activePublicKey, config?.previousPublicKey].filter((value): value is string => Boolean(value))
        : [],
      hosts: states.map((state) => ({
        daemon_id: state.daemonId,
        alias: sshAlias(workspaceId, state.daemonId, state.hostname),
        hostname: state.hostname,
        ssh_user: state.sshUser,
        port: state.port,
        addresses: state.addresses,
        host_keys: state.hostKeys,
      })),
    };
    if (enabled && config?.activePrivateKeyEncrypted && config.activePublicKey) {
      response.private_key = decryptSshMeshPrivateKey(
        config.activePrivateKeyEncrypted,
        workspaceId,
        keyVersion,
      );
      response.public_key = config.activePublicKey;
    }
    return response;
  }

  requestProbe(
    workspaceId: string,
    sourceNodeId: string,
    targetNodeId?: string | null,
  ): { request_id: string; probe_revision: number; status: "pending" } {
    const config = this.getWorkspaceConfig(workspaceId);
    if (!config?.enabled) {
      throw new Error("SSH Mesh is not enabled");
    }
    const states = this.listDaemonStates(workspaceId);
    const inventory = this.listDaemonInventory(workspaceId, states);
    const source = inventory.find((entry) => entry.daemonId === sourceNodeId);
    if (!source) {
      throw new Error("source node not found");
    }
    if (targetNodeId && !inventory.some((entry) => entry.daemonId === targetNodeId)) {
      throw new Error("target node not found");
    }
    if (targetNodeId === sourceNodeId) throw new Error("source and target node must be different");
    if (config.rotationState !== "stable") {
      throw new SshMeshProbeConflictError(
        "ssh_mesh_rotation_in_progress",
        sourceNodeId,
        "SSH Mesh key rollout must finish before testing connectivity",
      );
    }
    if (!source.online) {
      throw new SshMeshProbeConflictError(
        "ssh_mesh_source_offline",
        sourceNodeId,
        "Source node is offline",
      );
    }
    const sourceState = states.find((entry) => entry.daemonId === sourceNodeId);
    if (sourceState && !isDaemonStateFresh(sourceState)) {
      throw new SshMeshProbeConflictError(
        "ssh_mesh_source_stale",
        sourceNodeId,
        "Source node SSH Mesh status is stale",
      );
    }
    const desiredConfigRevision = this.configRevision(workspaceId, config, states);
    if (
      !sourceState
      || sourceState.protocolVersion < MULTIREMI_SSH_MESH_PROTOCOL_VERSION
      || sourceState.status !== "ready"
      || sourceState.keyVersion !== config.activeKeyVersion
      || sourceState.configRevision !== desiredConfigRevision
    ) {
      throw new SshMeshProbeConflictError(
        "ssh_mesh_source_not_ready",
        sourceNodeId,
        "Source node must finish SSH Mesh setup before testing connectivity",
      );
    }
    const now = nowIso();
    const targets = targetNodeId ? [targetNodeId] : [];
    this.ctx.db.run(
      `INSERT INTO multiremi_daemon_ssh_mesh_states (
         workspace_id, daemon_id, protocol_version, status, addresses, host_keys, peer_tests,
         probe_revision, desired_probe_revision, probe_target_daemon_ids, created_at, updated_at
       ) VALUES (?, ?, 0, 'setup_required', '[]', '[]', '[]', 0, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, daemon_id) DO UPDATE SET
         desired_probe_revision = multiremi_daemon_ssh_mesh_states.desired_probe_revision + 1,
         probe_target_daemon_ids = excluded.probe_target_daemon_ids,
         updated_at = excluded.updated_at`,
      [workspaceId, sourceNodeId, 1, toJson(targets), now, now],
    );
    const probeRevision = this.getDaemonState(workspaceId, sourceNodeId)?.desiredProbeRevision ?? 1;
    return { request_id: createId("sshprobe"), probe_revision: probeRevision, status: "pending" };
  }

  private heartbeatAck(workspaceId: string, daemonId: string): MultiremiSshMeshHeartbeatAck {
    const config = this.getWorkspaceConfig(workspaceId);
    const states = this.listDaemonStates(workspaceId);
    const state = states.find((entry) => entry.daemonId === daemonId);
    const revision = this.configRevision(workspaceId, config, states);
    const enabled = config?.enabled ?? false;
    const keyVersion = config?.activeKeyVersion ?? 0;
    return {
      enabled,
      key_version: keyVersion,
      config_revision: revision,
      needs_sync: state?.configRevision !== revision
        || (enabled && state?.keyVersion !== keyVersion)
        || (!enabled && state?.status !== "disabled"),
      rotation_state: config?.rotationState ?? "stable",
      probe_revision: state?.desiredProbeRevision ?? 0,
      needs_probe: (state?.probeRevision ?? 0) < (state?.desiredProbeRevision ?? 0),
    };
  }

  private maybeFinalizeRotation(workspaceId: string): void {
    const config = this.getWorkspaceConfig(workspaceId);
    if (!config || config.rotationState !== "rolling_out") return;
    const statesList = this.listDaemonStates(workspaceId);
    const inventory = this.listDaemonInventory(workspaceId, statesList).filter((daemon) => daemon.online);
    const states = new Map(statesList.map((state) => [state.daemonId, state]));
    const rolloutRevision = this.configRevision(workspaceId, config, [...states.values()]);
    const ready = inventory.length === 0 || inventory.every((daemon) => {
      const state = states.get(daemon.daemonId);
      return state?.status === "ready"
        && isDaemonStateFresh(state)
        && state.keyVersion === config.activeKeyVersion
        && state.configRevision === rolloutRevision;
    });
    if (!ready) return;
    this.ctx.db.run(
      `UPDATE multiremi_workspace_ssh_mesh
       SET previous_key_version = NULL, previous_private_key_encrypted = NULL,
           previous_public_key = NULL, previous_fingerprint = NULL,
           rotation_state = 'stable', updated_at = ?
       WHERE workspace_id = ? AND rotation_state = 'rolling_out' AND active_key_version = ?`,
      [nowIso(), workspaceId, config.activeKeyVersion],
    );
  }

  private configRevision(
    workspaceId: string,
    config: SshMeshWorkspaceConfigRow | null,
    states: DaemonStateRow[],
  ): string {
    const payload = {
      enabled: config?.enabled ?? false,
      active_key_version: config?.activeKeyVersion ?? 0,
      active_public_key: config?.activePublicKey ?? null,
      previous_key_version: config?.previousKeyVersion ?? null,
      previous_public_key: config?.previousPublicKey ?? null,
      rotation_state: config?.rotationState ?? "stable",
      hosts: states
        .map((state) => ({
          daemon_id: state.daemonId,
          alias: sshAlias(workspaceId, state.daemonId, state.hostname),
          hostname: state.hostname,
          ssh_user: state.sshUser,
          port: state.port,
          addresses: [...state.addresses].sort(),
          host_keys: [...state.hostKeys].sort(),
        }))
        .sort((left, right) => left.daemon_id.localeCompare(right.daemon_id)),
    };
    return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  }

  private getWorkspaceConfig(workspaceId: string): SshMeshWorkspaceConfigRow | null {
    const row = this.ctx.db.query(
      "SELECT * FROM multiremi_workspace_ssh_mesh WHERE workspace_id = ?",
    ).get(workspaceId) as Row | null;
    return row ? hydrateWorkspaceConfig(row) : null;
  }

  private getDaemonState(workspaceId: string, daemonId: string): DaemonStateRow | null {
    const row = this.ctx.db.query(
      "SELECT * FROM multiremi_daemon_ssh_mesh_states WHERE workspace_id = ? AND daemon_id = ?",
    ).get(workspaceId, daemonId) as Row | null;
    return row ? hydrateDaemonState(row) : null;
  }

  private listDaemonStates(workspaceId: string): DaemonStateRow[] {
    return (this.ctx.db.query(
      `SELECT state.* FROM multiremi_daemon_ssh_mesh_states state
       WHERE state.workspace_id = ?
         AND (
           COALESCE(state.node_kind, 'runtime') = 'control_plane'
           OR (
             COALESCE(state.node_kind, 'runtime') = 'runtime'
             AND EXISTS (
               SELECT 1 FROM multiremi_runtimes runtime
               WHERE COALESCE(runtime.workspace_id, 'local') = state.workspace_id
                 AND runtime.daemon_id = state.daemon_id
             )
             AND NOT EXISTS (
               SELECT 1 FROM multiremi_daemon_retirements retired
               WHERE retired.workspace_id = state.workspace_id
                 AND retired.daemon_id = state.daemon_id
             )
           )
         )
       ORDER BY state.daemon_id ASC`,
    ).all(workspaceId) as Row[]).map(hydrateDaemonState);
  }

  private listDaemonInventory(
    workspaceId: string,
    states: DaemonStateRow[] = this.listDaemonStates(workspaceId),
  ): DaemonInventoryEntry[] {
    const rows = this.ctx.db.query(
      `SELECT id, name, daemon_id, status, last_heartbeat_at
       FROM multiremi_runtimes r
       WHERE COALESCE(workspace_id, 'local') = ?
         AND daemon_id IS NOT NULL AND daemon_id != ''
         AND NOT EXISTS (
           SELECT 1 FROM multiremi_daemon_retirements retired
           WHERE retired.workspace_id = ? AND retired.daemon_id = r.daemon_id
         )
       ORDER BY daemon_id ASC, created_at ASC`,
    ).all(workspaceId, workspaceId) as Row[];
    const grouped = new Map<string, DaemonInventoryEntry>();
    for (const row of rows) {
      const daemonId = String(row.daemon_id);
      const runtimeOnline = isRuntimeEffectivelyOnline({
        status: String(row.status) === "offline" ? "offline" : "online",
        lastHeartbeatAt: nullableString(row.last_heartbeat_at),
      });
      const existing = grouped.get(daemonId);
      if (existing) {
        existing.runtimeIds.push(String(row.id));
        existing.online ||= runtimeOnline;
      } else {
        grouped.set(daemonId, {
          daemonId,
          nodeKind: "runtime",
          runtimeIds: [String(row.id)],
          name: String(row.name ?? daemonId),
          online: runtimeOnline,
        });
      }
    }
    for (const state of states) {
      if (state.nodeKind !== "control_plane") continue;
      if (grouped.has(state.daemonId)) {
        throw new Error(`SSH Mesh node id is used by both a runtime and control plane: ${state.daemonId}`);
      }
      grouped.set(state.daemonId, {
        daemonId: state.daemonId,
        nodeKind: "control_plane",
        runtimeIds: [],
        name: state.name ?? state.hostname ?? state.daemonId,
        online: isDaemonStateFresh(state),
      });
    }
    return [...grouped.values()].sort((left, right) => left.daemonId.localeCompare(right.daemonId));
  }

  private runtimeIdentity(runtimeId: string): { workspaceId: string; daemonId: string | null } | null {
    const row = this.ctx.db.query(
      "SELECT COALESCE(workspace_id, 'local') AS workspace_id, daemon_id FROM multiremi_runtimes WHERE id = ?",
    ).get(runtimeId) as Row | null;
    return row ? {
      workspaceId: String(row.workspace_id ?? "local"),
      daemonId: nullableString(row.daemon_id),
    } : null;
  }

  private assertWorkspaceExists(workspaceId: string): void {
    const row = this.ctx.db.query("SELECT id FROM multiremi_workspaces WHERE id = ?").get(workspaceId) as Row | null;
    if (!row) throw new Error("workspace not found");
  }

  private assertNodeKindCompatible(
    workspaceId: string,
    nodeId: string,
    nodeKind: MultiremiSshMeshNodeKind,
  ): void {
    const current = this.getDaemonState(workspaceId, nodeId);
    if (current && current.nodeKind !== nodeKind) {
      throw new Error(`SSH Mesh node id ${nodeId} is already registered as ${current.nodeKind}`);
    }
    if (nodeKind === "control_plane") {
      const runtime = this.ctx.db.query(
        `SELECT 1 FROM multiremi_runtimes
         WHERE COALESCE(workspace_id, 'local') = ? AND daemon_id = ? LIMIT 1`,
      ).get(workspaceId, nodeId) as Row | null;
      if (runtime) throw new Error(`SSH Mesh node id ${nodeId} is already registered as runtime`);
    }
  }
}

function hydrateWorkspaceConfig(row: Row): SshMeshWorkspaceConfigRow {
  return {
    workspaceId: String(row.workspace_id),
    enabled: Boolean(row.enabled),
    activeKeyVersion: Number(row.active_key_version ?? 0),
    activePrivateKeyEncrypted: nullableString(row.active_private_key_encrypted),
    activePublicKey: nullableString(row.active_public_key),
    activeFingerprint: nullableString(row.active_fingerprint),
    activeOperationId: nullableString(row.active_operation_id),
    previousKeyVersion: row.previous_key_version == null ? null : Number(row.previous_key_version),
    previousPrivateKeyEncrypted: nullableString(row.previous_private_key_encrypted),
    previousPublicKey: nullableString(row.previous_public_key),
    previousFingerprint: nullableString(row.previous_fingerprint),
    rotationState: row.rotation_state === "rolling_out"
      ? "rolling_out"
      : row.rotation_state === "rekey_required"
        ? "rekey_required"
        : "stable",
    createdBy: nullableString(row.created_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function hydrateDaemonState(row: Row): DaemonStateRow {
  return {
    workspaceId: String(row.workspace_id),
    daemonId: String(row.daemon_id),
    nodeKind: normalizeNodeKind(row.node_kind),
    name: nullableString(row.name),
    runtimeId: nullableString(row.runtime_id),
    protocolVersion: Number(row.protocol_version ?? 0),
    status: normalizeRuntimeStatus(row.status),
    keyVersion: row.key_version == null ? null : Number(row.key_version),
    configRevision: nullableString(row.config_revision),
    sshUser: nullableString(row.ssh_user),
    hostname: nullableString(row.hostname),
    port: normalizePort(row.ssh_port, 22),
    addresses: normalizeStrings(parseJson(row.addresses, []), 32, 255),
    hostKeys: normalizeHostKeys(parseJson(row.host_keys, [])),
    publicKeyInstalled: Boolean(row.public_key_installed),
    configInstalled: Boolean(row.config_installed),
    peerTests: normalizePeerTests(parseJson(row.peer_tests, []), String(row.last_reported_at ?? row.updated_at)),
    probeRevision: normalizeNonNegativeInt(row.probe_revision, 0),
    desiredProbeRevision: normalizeNonNegativeInt(row.desired_probe_revision, 0),
    probeTargetDaemonIds: normalizeStrings(parseJson(row.probe_target_daemon_ids, []), 256, 255),
    lastErrorCode: nullableString(row.last_error_code),
    lastError: nullableString(row.last_error),
    lastReportedAt: nullableString(row.last_reported_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function normalizeNodeKind(value: unknown): MultiremiSshMeshNodeKind {
  return value === "control_plane" ? "control_plane" : "runtime";
}

function normalizeRuntimeStatus(value: unknown): MultiremiSshMeshRuntimeStatus {
  switch (value) {
    case "disabled":
    case "syncing":
    case "ready":
    case "setup_required":
    case "blocked":
    case "error":
      return value;
    default:
      return "error";
  }
}

function normalizePeerTests(value: unknown, checkedAt: string): MultiremiSshMeshPeerProbe[] {
  if (!Array.isArray(value)) return [];
  const result: MultiremiSshMeshPeerProbe[] = [];
  const seen = new Set<string>();
  for (const item of value.slice(0, 256)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const daemonId = String(row.node_id ?? row.daemon_id ?? "").trim().slice(0, 255);
    if (!daemonId || seen.has(daemonId)) continue;
    seen.add(daemonId);
    const status = normalizePeerStatus(row.status);
    const latency = Number(row.latency_ms);
    result.push({
      node_id: daemonId,
      daemon_id: daemonId,
      status,
      latency_ms: Number.isFinite(latency) && latency >= 0 ? Math.round(latency) : null,
      error_code: normalizeNullableString(row.error_code, null, 128),
      error: normalizeNullableString(row.error, null, 1000),
      checked_at: normalizeNullableString(row.checked_at, checkedAt, 64),
    });
  }
  return result;
}

function withCanonicalPeerNodeId(peer: MultiremiSshMeshPeerProbe): MultiremiSshMeshPeerProbe {
  return { ...peer, node_id: peer.node_id ?? peer.daemon_id };
}

function normalizePeerStatus(value: unknown): MultiremiSshMeshPeerProbe["status"] {
  switch (value) {
    case "ready":
    case "unreachable":
    case "host_key_mismatch":
    case "auth_failed":
    case "error":
      return value;
    default:
      return "error";
  }
}

function normalizeStrings(value: unknown, limit: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    const clean = String(item ?? "").trim().replace(/[\r\n]/g, "").slice(0, maxLength);
    if (!clean || result.includes(clean)) continue;
    result.push(clean);
    if (result.length >= limit) break;
  }
  return result;
}

function normalizeHostKeys(value: unknown): string[] {
  return normalizeStrings(value, 32, 2048).filter((entry) => {
    const [algorithm, encoded, ...rest] = entry.split(/\s+/);
    return Boolean(algorithm && encoded && rest.length === 0 && /^[A-Za-z0-9@._+-]+$/.test(algorithm) && /^[A-Za-z0-9+/=]+$/.test(encoded));
  });
}

function normalizeNullableString(value: unknown, fallback: string | null, maxLength: number): string | null {
  if (value === undefined) return fallback;
  if (value === null) return null;
  const clean = String(value).trim().slice(0, maxLength);
  return clean || null;
}

function normalizeRequiredNodeValue(value: unknown, label: string, maxLength: number): string {
  const raw = String(value ?? "");
  if (/[\r\n\0]/.test(raw)) throw new Error(`${label} contains invalid characters`);
  const normalized = raw.trim().slice(0, maxLength);
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function normalizeNullablePositiveInt(value: unknown, fallback: number | null): number | null {
  if (value === undefined) return fallback;
  if (value === null) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function normalizeNonNegativeInt(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function normalizePort(value: unknown, fallback: number): number {
  const port = Number(value);
  return Number.isSafeInteger(port) && port > 0 && port <= 65_535 ? port : fallback;
}

function sshAlias(workspaceId: string, daemonId: string, hostname: string | null): string {
  const readable = (hostname || daemonId)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36) || "runtime";
  const suffix = createHash("sha256").update(`${workspaceId}\0${daemonId}`).digest("hex").slice(0, 6);
  return `remi-${readable}-${suffix}`;
}

function isDaemonStateFresh(state: DaemonStateRow, nowMs = Date.now()): boolean {
  if (!state.lastReportedAt) return false;
  const reportedAt = Date.parse(state.lastReportedAt);
  return Number.isFinite(reportedAt) && nowMs - reportedAt <= RUNTIME_HEARTBEAT_STALE_MS;
}
