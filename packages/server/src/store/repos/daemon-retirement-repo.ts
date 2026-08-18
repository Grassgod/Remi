import { createHash } from "node:crypto";
import { createId, nowIso } from "@multiremi/ids.js";
import { parseJson, toJson } from "@multiremi/store/helpers.js";
import type { StoreContext } from "@multiremi/store/context.js";
import { RUNTIME_AUXILIARY_TABLES } from "@multiremi/store/runtime-lifecycle-tables.js";
import { isRuntimeEffectivelyOnline } from "@multiremi/store/repos/runtimes-repo.js";

type Row = Record<string, unknown>;

const BLOCKING_TASK_STATUSES = ["dispatched", "running", "waiting_local_directory", "awaiting_human"] as const;
export type DaemonRetirementBlockingReason =
  | "active_tasks"
  | "local_directory_resources"
  | "active_issue_workspaces";

export interface DaemonRetirementImpact {
  runtimesRemoved: number;
  agentsDetached: number;
  queuedTasksRequeued: number;
  sessionLanesReset: number;
  chatSessionsReset: number;
  issueWorkspacesAbandoned: number;
  tokensRevoked: number;
}

export interface DaemonInventoryEntry {
  workspaceId: string;
  daemonId: string;
  ownerUserId: string | null;
  runtimeCount: number;
  tokenCount: number;
  lastSeen: string | null;
  name: string | null;
}

export interface DaemonRetirementPlan {
  workspaceId: string;
  daemonId: string;
  ownerUserId: string | null;
  snapshot: string;
  exists: boolean;
  alreadyRetired: boolean;
  canRetire: boolean;
  canAbandonIssueWorkspaces: boolean;
  blockingReasons: DaemonRetirementBlockingReason[];
  runtimes: Array<{
    id: string;
    name: string;
    provider: string;
    status: string;
  }>;
  agents: Array<{
    id: string;
    name: string;
    provider: string;
    runtimeId: string;
    archived: boolean;
  }>;
  activeTasks: Array<{
    id: string;
    status: string;
    agentId: string;
    runtimeId: string;
    issueId: string | null;
  }>;
  queuedTasks: Array<{
    id: string;
    status: string;
    agentId: string;
    runtimeId: string;
    issueId: string | null;
  }>;
  localDirectoryResources: Array<{
    id: string;
    projectId: string;
    projectTitle: string;
    label: string | null;
    localPath: string;
  }>;
  issueWorkspaces: Array<{
    issueId: string;
    status: string;
    runtimeId: string;
    rootPath: string;
  }>;
  impact: DaemonRetirementImpact;
}

export type RetireDaemonResult =
  | { status: "retired"; retiredAt: string; impact: DaemonRetirementImpact; alreadyRetired: boolean }
  | { status: "plan_changed"; plan: DaemonRetirementPlan }
  | { status: "blocked"; plan: DaemonRetirementPlan }
  | { status: "forbidden" };

export type DaemonRetirementSshMeshRekeyStatus =
  | "not_required"
  | "pending"
  | "rolling_out"
  | "completed"
  | "rekey_required";

export interface DaemonRetirementSshMeshRekey {
  status: DaemonRetirementSshMeshRekeyStatus;
  compromisedKeyVersion: number | null;
  replacementKeyVersion: number | null;
  operationId: string | null;
  updatedAt: string | null;
}

export class DaemonRetiredError extends Error {
  readonly code = "daemon_retired";

  constructor(
    readonly workspaceId: string,
    readonly daemonId: string,
  ) {
    super(`Daemon ${daemonId} has been retired from workspace ${workspaceId}`);
    this.name = "DaemonRetiredError";
  }
}

export class DaemonIdentityOwnerConflictError extends Error {
  readonly code = "daemon_identity_owner_conflict";

  constructor(
    readonly workspaceId: string,
    readonly daemonId: string,
  ) {
    super(`Daemon ${daemonId} is already owned by another user in workspace ${workspaceId}`);
    this.name = "DaemonIdentityOwnerConflictError";
  }
}

export class DaemonRetirementRepo {
  constructor(private readonly ctx: StoreContext) {}

  isRetired(workspaceId: string, daemonId: string): boolean {
    return Boolean(this.ctx.db.query(
      "SELECT 1 FROM multiremi_daemon_retirements WHERE workspace_id = ? AND daemon_id = ?",
    ).get(workspaceId, daemonId));
  }

  getSshMeshRekey(workspaceId: string, daemonId: string): DaemonRetirementSshMeshRekey | null {
    const row = this.ctx.db.query(
      `SELECT ssh_mesh_rekey_status, ssh_mesh_compromised_key_version,
              ssh_mesh_replacement_key_version, ssh_mesh_rekey_operation_id,
              ssh_mesh_rekey_updated_at
       FROM multiremi_daemon_retirements
       WHERE workspace_id = ? AND daemon_id = ?`,
    ).get(workspaceId, daemonId) as Row | null;
    return row ? hydrateSshMeshRekey(row) : null;
  }

  setSshMeshRekey(
    workspaceId: string,
    daemonId: string,
    status: DaemonRetirementSshMeshRekeyStatus,
    replacementKeyVersion: number | null,
  ): DaemonRetirementSshMeshRekey {
    const updatedAt = nowIso();
    const updated = this.ctx.db.run(
      `UPDATE multiremi_daemon_retirements
       SET ssh_mesh_rekey_status = ?, ssh_mesh_replacement_key_version = ?,
           ssh_mesh_rekey_updated_at = ?
       WHERE workspace_id = ? AND daemon_id = ?`,
      [status, replacementKeyVersion, updatedAt, workspaceId, daemonId],
    );
    if (updated.changes !== 1) throw new Error("daemon retirement not found");
    return this.getSshMeshRekey(workspaceId, daemonId)!;
  }

  ensureSshMeshRekeyOperationId(workspaceId: string, daemonId: string): DaemonRetirementSshMeshRekey {
    const current = this.getSshMeshRekey(workspaceId, daemonId);
    if (!current) throw new Error("daemon retirement not found");
    if (current.operationId || current.status === "not_required" || current.status === "completed") return current;
    const operationId = createId("sshrekey");
    this.ctx.db.run(
      `UPDATE multiremi_daemon_retirements
       SET ssh_mesh_rekey_operation_id = ?, ssh_mesh_rekey_updated_at = ?
       WHERE workspace_id = ? AND daemon_id = ?
         AND ssh_mesh_rekey_operation_id IS NULL
         AND ssh_mesh_rekey_status IN ('pending', 'rolling_out', 'rekey_required')`,
      [operationId, nowIso(), workspaceId, daemonId],
    );
    return this.getSshMeshRekey(workspaceId, daemonId)!;
  }

  hasSshMeshRekeyInProgress(workspaceId: string): boolean {
    return Boolean(this.ctx.db.query(
      `SELECT 1 FROM multiremi_daemon_retirements
       WHERE workspace_id = ? AND ssh_mesh_rekey_status IN ('pending', 'rolling_out')
       LIMIT 1`,
    ).get(workspaceId));
  }

  markSshMeshRekeysRequiredAfterInvalidation(workspaceId: string): void {
    this.ctx.db.run(
      `UPDATE multiremi_daemon_retirements
       SET ssh_mesh_rekey_status = 'rekey_required',
           ssh_mesh_replacement_key_version = NULL,
           ssh_mesh_rekey_updated_at = ?
       WHERE workspace_id = ?
         AND ssh_mesh_rekey_status IN ('pending', 'rolling_out')`,
      [nowIso(), workspaceId],
    );
  }

  completeSshMeshRekeyForOperation(
    workspaceId: string,
    operationId: string | null,
    replacementKeyVersion: number,
  ): void {
    if (!operationId) return;
    this.ctx.db.run(
      `UPDATE multiremi_daemon_retirements
       SET ssh_mesh_rekey_status = 'completed', ssh_mesh_rekey_updated_at = ?
       WHERE workspace_id = ?
         AND ssh_mesh_rekey_status = 'rolling_out'
         AND ssh_mesh_rekey_operation_id = ?
         AND ssh_mesh_replacement_key_version = ?`,
      [nowIso(), workspaceId, operationId, replacementKeyVersion],
    );
  }

  listInventory(workspaceId: string): DaemonInventoryEntry[] {
    const retiredIds = new Set(
      (this.ctx.db.query(
        "SELECT daemon_id FROM multiremi_daemon_retirements WHERE workspace_id = ?",
      ).all(workspaceId) as Row[]).map((row) => String(row.daemon_id)),
    );
    const inventory = new Map<string, DaemonInventoryEntry>();
    const ensure = (daemonId: string): DaemonInventoryEntry => {
      let entry = inventory.get(daemonId);
      if (!entry) {
        entry = {
          workspaceId,
          daemonId,
          ownerUserId: this.getIdentityOwnerUserId(workspaceId, daemonId),
          runtimeCount: 0,
          tokenCount: 0,
          lastSeen: null,
          name: null,
        };
        inventory.set(daemonId, entry);
      }
      return entry;
    };
    const observe = (entry: DaemonInventoryEntry, at: unknown): void => {
      if (at == null) return;
      const timestamp = String(at);
      if (!entry.lastSeen || timestamp > entry.lastSeen) entry.lastSeen = timestamp;
    };

    const runtimes = this.ctx.db.query(
      `SELECT daemon_id, name, last_heartbeat_at, updated_at
       FROM multiremi_runtimes
       WHERE COALESCE(workspace_id, 'local') = ? AND daemon_id IS NOT NULL AND daemon_id != ''
       ORDER BY updated_at DESC, id ASC`,
    ).all(workspaceId) as Row[];
    for (const row of runtimes) {
      const daemonId = String(row.daemon_id);
      if (retiredIds.has(daemonId)) continue;
      const entry = ensure(daemonId);
      entry.runtimeCount += 1;
      if (!entry.name) entry.name = String(row.name);
      observe(entry, row.last_heartbeat_at ?? row.updated_at);
    }

    const now = nowIso();
    const tokens = this.ctx.db.query(
      `SELECT daemon_id, name, last_used_at, created_at
       FROM multiremi_access_tokens
       WHERE workspace_id = ?
         AND type = 'daemon'
         AND daemon_id IS NOT NULL
         AND daemon_id != ''
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at DESC, id ASC`,
    ).all(workspaceId, now) as Row[];
    for (const row of tokens) {
      const daemonId = String(row.daemon_id);
      if (retiredIds.has(daemonId)) continue;
      const entry = ensure(daemonId);
      entry.tokenCount += 1;
      if (!entry.name) entry.name = String(row.name);
      observe(entry, row.last_used_at ?? row.created_at);
    }

    return [...inventory.values()].sort((a, b) =>
      (b.lastSeen ?? "").localeCompare(a.lastSeen ?? "") || a.daemonId.localeCompare(b.daemonId)
    );
  }

  /** Must be called inside a database transaction. Updating the row is the cross-database lock. */
  lockLifecycle(workspaceId: string, daemonId: string): void {
    const now = nowIso();
    this.ctx.db.run(
      `INSERT INTO multiremi_daemon_lifecycle_locks (workspace_id, daemon_id, updated_at)
       VALUES (?, ?, ?) ON CONFLICT(workspace_id, daemon_id) DO NOTHING`,
      [workspaceId, daemonId, now],
    );
    this.ctx.db.run(
      `UPDATE multiremi_daemon_lifecycle_locks
       SET updated_at = ?
       WHERE workspace_id = ? AND daemon_id = ?`,
      [now, workspaceId, daemonId],
    );
  }

  getIdentityOwnerUserId(workspaceId: string, daemonId: string): string | null {
    const row = this.ctx.db.query(
      `SELECT owner_user_id
       FROM multiremi_daemon_lifecycle_locks
       WHERE workspace_id = ? AND daemon_id = ?`,
    ).get(workspaceId, daemonId) as Row | null;
    const ownerUserId = String(row?.owner_user_id ?? "").trim();
    return ownerUserId || null;
  }

  /** Caller must hold the daemon lifecycle lock in the current transaction. */
  claimIdentityOwnerWithinLock(
    workspaceId: string,
    daemonId: string,
    requestedOwnerUserId: string | null,
  ): string | null {
    const now = nowIso();
    const requestedOwner = String(requestedOwnerUserId ?? "").trim() || null;
    const claim = this.getIdentityOwnerUserId(workspaceId, daemonId);
    const identityRows = this.ctx.db.query(
      `SELECT owner_user_id
       FROM (
         SELECT owner_id AS owner_user_id
         FROM multiremi_runtimes
         WHERE COALESCE(workspace_id, 'local') = ?
           AND daemon_id = ?
           AND owner_id IS NOT NULL AND owner_id != ''
         UNION ALL
         SELECT user_id AS owner_user_id
         FROM multiremi_access_tokens
         WHERE workspace_id = ?
           AND daemon_id = ?
           AND type = 'daemon'
           AND user_id IS NOT NULL AND user_id != ''
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)
       ) daemon_identities`,
    ).all(workspaceId, daemonId, workspaceId, daemonId, nowIso()) as Row[];
    const observedOwners = new Set(
      identityRows.map((row) => String(row.owner_user_id ?? "").trim()).filter(Boolean),
    );
    if (claim) observedOwners.add(claim);
    if (observedOwners.size > 1) {
      throw new DaemonIdentityOwnerConflictError(workspaceId, daemonId);
    }
    const observedOwner = [...observedOwners][0] ?? null;
    if (observedOwner && requestedOwner && observedOwner !== requestedOwner) {
      throw new DaemonIdentityOwnerConflictError(workspaceId, daemonId);
    }
    const ownerUserId = observedOwner ?? requestedOwner;
    if (ownerUserId && !claim) {
      const updated = this.ctx.db.run(
        `UPDATE multiremi_daemon_lifecycle_locks
         SET owner_user_id = ?, updated_at = ?
         WHERE workspace_id = ? AND daemon_id = ?
           AND (owner_user_id IS NULL OR owner_user_id = '')`,
        [ownerUserId, now, workspaceId, daemonId],
      );
      if (updated.changes !== 1 && this.getIdentityOwnerUserId(workspaceId, daemonId) !== ownerUserId) {
        throw new DaemonIdentityOwnerConflictError(workspaceId, daemonId);
      }
    }
    return ownerUserId;
  }

  assertCanRegister(workspaceId: string, daemonId: string): void {
    if (this.isRetired(workspaceId, daemonId)) {
      throw new DaemonRetiredError(workspaceId, daemonId);
    }
  }

  getPlan(workspaceId: string, daemonId: string): DaemonRetirementPlan {
    const ownerUserId = this.getIdentityOwnerUserId(workspaceId, daemonId);
    const runtimes = this.ctx.db.query(
      `SELECT id, name, provider, status
       FROM multiremi_runtimes
       WHERE COALESCE(workspace_id, 'local') = ? AND daemon_id = ?
       ORDER BY provider ASC, id ASC`,
    ).all(workspaceId, daemonId) as Row[];
    const runtimeIds = runtimes.map((row) => String(row.id));
    const agents = this.rowsForRuntimeIds(
      `SELECT id, name, provider, runtime_id, archived_at
       FROM multiremi_agents
       WHERE runtime_id IN (__RUNTIME_IDS__)
       ORDER BY id ASC`,
      runtimeIds,
    );
    const activeTasks = this.rowsForRuntimeIds(
      `SELECT id, status, agent_id, runtime_id, issue_id
       FROM multiremi_tasks
       WHERE runtime_id IN (__RUNTIME_IDS__)
         AND status IN (${BLOCKING_TASK_STATUSES.map(() => "?").join(",")})
       ORDER BY id ASC`,
      runtimeIds,
      [...BLOCKING_TASK_STATUSES],
    );
    const queuedTasks = this.rowsForRuntimeIds(
      `SELECT id, status, agent_id, runtime_id, issue_id
       FROM multiremi_tasks
       WHERE runtime_id IN (__RUNTIME_IDS__) AND status = 'queued'
       ORDER BY id ASC`,
      runtimeIds,
    );
    const issueWorkspaces = this.rowsForRuntimeIds(
      `SELECT issue_id, status, runtime_id, root_path
       FROM multiremi_issue_workspaces
       WHERE runtime_id IN (__RUNTIME_IDS__) AND status != 'cleaned'
       ORDER BY issue_id ASC`,
      runtimeIds,
    );
    const cleanedIssueWorkspaceRows = this.rowsForRuntimeIds(
      `SELECT issue_id, runtime_id
       FROM multiremi_issue_workspaces
       WHERE runtime_id IN (__RUNTIME_IDS__) AND status = 'cleaned'
       ORDER BY issue_id ASC`,
      runtimeIds,
    );
    const sessionLaneRows = this.rowsForRuntimeIds(
      `SELECT session_id, agent_id, runtime_id
       FROM multiremi_session_agent_lanes
       WHERE runtime_id IN (__RUNTIME_IDS__)
       ORDER BY session_id ASC, agent_id ASC`,
      runtimeIds,
    );
    const chatSessionRows = this.rowsForRuntimeIds(
      `SELECT id, session_runtime_id
       FROM multiremi_chat_sessions
       WHERE session_runtime_id IN (__RUNTIME_IDS__)
       ORDER BY id ASC`,
      runtimeIds,
    );
    const runtimeAuxiliaryState = Object.fromEntries(
      RUNTIME_AUXILIARY_TABLES.map((table) => [
        table,
        this.runtimeAuxiliarySnapshotRows(table, runtimeIds),
      ]),
    );
    const localDirectoryResources = this.listLocalDirectoryResources(workspaceId, daemonId);
    const tokenRows = this.ctx.db.query(
      `SELECT id, revoked_at
       FROM multiremi_access_tokens
       WHERE workspace_id = ? AND type = 'daemon' AND daemon_id = ?
       ORDER BY id ASC`,
    ).all(workspaceId, daemonId) as Row[];
    const retirement = this.ctx.db.query(
      "SELECT retired_at, impact FROM multiremi_daemon_retirements WHERE workspace_id = ? AND daemon_id = ?",
    ).get(workspaceId, daemonId) as Row | null;

    const mappedRuntimes = runtimes.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      provider: String(row.provider),
      status: String(row.status),
    }));
    const mappedAgents = agents.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      provider: String(row.provider),
      runtimeId: String(row.runtime_id),
      archived: row.archived_at != null,
    }));
    const mapTask = (row: Row) => ({
      id: String(row.id),
      status: String(row.status),
      agentId: String(row.agent_id),
      runtimeId: String(row.runtime_id),
      issueId: row.issue_id == null ? null : String(row.issue_id),
    });
    const mappedActiveTasks = activeTasks.map(mapTask);
    const mappedQueuedTasks = queuedTasks.map(mapTask);
    const mappedIssueWorkspaces = issueWorkspaces.map((row) => ({
      issueId: String(row.issue_id),
      status: String(row.status),
      runtimeId: String(row.runtime_id),
      rootPath: String(row.root_path),
    }));
    const cleanedIssueWorkspaces = cleanedIssueWorkspaceRows.map((row) => ({
      issueId: String(row.issue_id),
      runtimeId: String(row.runtime_id),
    }));
    const sessionLanes = sessionLaneRows.map((row) => ({
      sessionId: String(row.session_id),
      agentId: String(row.agent_id),
      runtimeId: String(row.runtime_id),
    }));
    const chatSessions = chatSessionRows.map((row) => ({
      id: String(row.id),
      runtimeId: String(row.session_runtime_id),
    }));
    const blockingReasons: DaemonRetirementBlockingReason[] = [];
    if (mappedActiveTasks.length) blockingReasons.push("active_tasks");
    if (localDirectoryResources.length) blockingReasons.push("local_directory_resources");
    if (mappedIssueWorkspaces.length) blockingReasons.push("active_issue_workspaces");
    const hasOnlineRuntime = mappedRuntimes.some((runtime) => {
      const current = this.ctx.runtimes().getRuntime(runtime.id);
      return current ? isRuntimeEffectivelyOnline(current) : false;
    });
    const canAbandonIssueWorkspaces = mappedIssueWorkspaces.length > 0
      && mappedActiveTasks.length === 0
      && localDirectoryResources.length === 0
      && !hasOnlineRuntime;
    const storedImpact = retirement
      ? normalizeImpact(parseJson<Record<string, unknown>>(retirement.impact, {}))
      : null;
    const impact = storedImpact ?? {
      runtimesRemoved: mappedRuntimes.length,
      agentsDetached: mappedAgents.length,
      queuedTasksRequeued: mappedQueuedTasks.length,
      sessionLanesReset: sessionLanes.length,
      chatSessionsReset: chatSessions.length,
      issueWorkspacesAbandoned: 0,
      tokensRevoked: tokenRows.filter((row) => row.revoked_at == null).length,
    };
    const snapshot = hashRetirementSnapshot({
      ownerUserId,
      runtimes: mappedRuntimes.map(({ id, provider, status }) => ({ id, provider, status })),
      canAbandonIssueWorkspaces,
      agents: mappedAgents.map(({ id, runtimeId, archived }) => ({ id, runtimeId, archived })),
      activeTasks: mappedActiveTasks,
      queuedTasks: mappedQueuedTasks,
      localDirectoryResources,
      issueWorkspaces: mappedIssueWorkspaces,
      cleanedIssueWorkspaces,
      sessionLanes,
      chatSessions,
      runtimeAuxiliaryState,
      tokens: tokenRows.map((row) => ({ id: String(row.id), revoked: row.revoked_at != null })),
      retiredAt: retirement?.retired_at == null ? null : String(retirement.retired_at),
    });

    return {
      workspaceId,
      daemonId,
      ownerUserId,
      snapshot,
      exists: Boolean(retirement || mappedRuntimes.length || tokenRows.length || localDirectoryResources.length || mappedIssueWorkspaces.length),
      alreadyRetired: Boolean(retirement),
      canRetire: blockingReasons.length === 0,
      canAbandonIssueWorkspaces,
      blockingReasons,
      runtimes: mappedRuntimes,
      agents: mappedAgents,
      activeTasks: mappedActiveTasks,
      queuedTasks: mappedQueuedTasks,
      localDirectoryResources,
      issueWorkspaces: mappedIssueWorkspaces,
      impact,
    };
  }

  retire(
    workspaceId: string,
    daemonId: string,
    expectedSnapshot: string,
    retiredBy: string | null,
    requiredOwnerUserId: string | null = null,
    options: { abandonIssueWorkspaces?: boolean } = {},
  ): RetireDaemonResult {
    const tx = this.ctx.db.transaction((): RetireDaemonResult => {
      this.lockLifecycle(workspaceId, daemonId);
      if (
        requiredOwnerUserId
        && this.getIdentityOwnerUserId(workspaceId, daemonId) !== requiredOwnerUserId
      ) {
        return { status: "forbidden" };
      }
      // Task claims already serialize on the workspace row, and task creation
      // uses the same lock. Holding it through the final plan read and cleanup
      // closes the Postgres multi-process race where work could be dispatched or
      // pinned to a Runtime after preflight but before that Runtime was deleted.
      this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
      // Desired Plugin state is reconciled under its own workspace lock. Take it
      // after the lifecycle lock (the same order as task claim) so a reconcile
      // either commits before this final plan/delete or observes no retired
      // Runtime afterwards; it cannot recreate auxiliary rows mid-retirement.
      this.ctx.agentPlugins().lockAgentPluginWorkspace(workspaceId);
      const existingRetirement = this.ctx.db.query(
        "SELECT retired_at, impact FROM multiremi_daemon_retirements WHERE workspace_id = ? AND daemon_id = ?",
      ).get(workspaceId, daemonId) as Row | null;
      if (existingRetirement) {
        this.cleanSshMeshState(workspaceId, daemonId, nowIso());
        return {
          status: "retired",
          retiredAt: String(existingRetirement.retired_at),
          impact: normalizeImpact(parseJson<Record<string, unknown>>(existingRetirement.impact, {})),
          alreadyRetired: true,
        };
      }

      const plan = this.getPlan(workspaceId, daemonId);
      if (plan.snapshot !== expectedSnapshot) return { status: "plan_changed", plan };
      const remainingBlockers = plan.blockingReasons.filter((reason) => (
        reason !== "active_issue_workspaces"
        || !options.abandonIssueWorkspaces
        || !plan.canAbandonIssueWorkspaces
      ));
      if (remainingBlockers.length > 0) return { status: "blocked", plan };

      const runtimeIds = plan.runtimes.map((runtime) => runtime.id);
      const now = nowIso();
      let agentsDetached = 0;
      let queuedTasksRequeued = 0;
      let sessionLanesReset = 0;
      let chatSessionsReset = 0;
      let issueWorkspacesAbandoned = 0;
      if (runtimeIds.length) {
        const placeholders = runtimeIds.map(() => "?").join(",");
        agentsDetached = this.ctx.db.run(
          `UPDATE multiremi_agents
           SET runtime_id = NULL, updated_at = ?
           WHERE runtime_id IN (${placeholders})`,
          [now, ...runtimeIds],
        ).changes;
        queuedTasksRequeued = this.ctx.db.run(
          `UPDATE multiremi_tasks
           SET runtime_id = NULL, session_id = NULL, work_dir = NULL, updated_at = ?
           WHERE runtime_id IN (${placeholders}) AND status = 'queued'`,
          [now, ...runtimeIds],
        ).changes;
        sessionLanesReset = this.ctx.db.run(
          `UPDATE multiremi_session_agent_lanes
           SET provider_session_id = NULL,
               runtime_id = NULL,
               provider = NULL,
               execution_fingerprint = NULL,
               work_dir = NULL,
               cursor_seq = 0,
               generation = generation + 1,
               last_task_id = NULL,
               updated_at = ?
           WHERE runtime_id IN (${placeholders})`,
          [now, ...runtimeIds],
        ).changes;
        chatSessionsReset = this.ctx.db.run(
          `UPDATE multiremi_chat_sessions
           SET session_id = NULL,
               work_dir = NULL,
               session_runtime_id = NULL,
               session_provider = NULL,
               session_execution_fingerprint = NULL,
               updated_at = ?
           WHERE session_runtime_id IN (${placeholders})`,
          [now, ...runtimeIds],
        ).changes;
        if (options.abandonIssueWorkspaces) {
          issueWorkspacesAbandoned = this.ctx.db.run(
            `UPDATE multiremi_issue_workspaces
             SET status = 'cleaned', runtime_id = NULL, cleaned_at = ?, updated_at = ?
             WHERE runtime_id IN (${placeholders}) AND status != 'cleaned'`,
            [now, now, ...runtimeIds],
          ).changes;
        }
        this.ctx.db.run(
          `UPDATE multiremi_issue_workspaces
           SET runtime_id = NULL, updated_at = ?
           WHERE runtime_id IN (${placeholders}) AND status = 'cleaned'`,
          [now, ...runtimeIds],
        );
        for (const table of RUNTIME_AUXILIARY_TABLES) {
          this.ctx.db.run(`DELETE FROM ${table} WHERE runtime_id IN (${placeholders})`, runtimeIds);
        }
        this.ctx.db.run(`DELETE FROM multiremi_runtimes WHERE id IN (${placeholders})`, runtimeIds);
      }
      const tokensRevoked = this.ctx.db.run(
        `UPDATE multiremi_access_tokens
         SET revoked_at = COALESCE(revoked_at, ?)
         WHERE workspace_id = ? AND type = 'daemon' AND daemon_id = ? AND revoked_at IS NULL`,
        [now, workspaceId, daemonId],
      ).changes;
      this.cleanSshMeshState(workspaceId, daemonId, now);
      const impact: DaemonRetirementImpact = {
        runtimesRemoved: runtimeIds.length,
        agentsDetached,
        queuedTasksRequeued,
        sessionLanesReset,
        chatSessionsReset,
        issueWorkspacesAbandoned,
        tokensRevoked,
      };
      const sshMesh = this.ctx.db.query(
        `SELECT active_key_version, active_private_key_encrypted, active_public_key,
                previous_private_key_encrypted, previous_public_key
         FROM multiremi_workspace_ssh_mesh
         WHERE workspace_id = ?`,
      ).get(workspaceId) as Row | null;
      const sshMeshKeyMayRemainUsable = Boolean(
        sshMesh?.active_private_key_encrypted
        || sshMesh?.active_public_key
        || sshMesh?.previous_private_key_encrypted
        || sshMesh?.previous_public_key,
      );
      const sshMeshCompromisedKeyVersion = sshMeshKeyMayRemainUsable
        ? Number(sshMesh?.active_key_version ?? 0)
        : null;
      const sshMeshRekeyStatus: DaemonRetirementSshMeshRekeyStatus = sshMeshKeyMayRemainUsable
        ? "pending"
        : "not_required";
      this.ctx.db.run(
        `INSERT INTO multiremi_daemon_retirements (
           workspace_id, daemon_id, retired_by, retired_at, runtime_ids, impact,
           ssh_mesh_rekey_status, ssh_mesh_compromised_key_version,
           ssh_mesh_replacement_key_version, ssh_mesh_rekey_operation_id,
           ssh_mesh_rekey_updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        [
          workspaceId,
          daemonId,
          retiredBy,
          now,
          toJson(runtimeIds),
          toJson(impact),
          sshMeshRekeyStatus,
          sshMeshCompromisedKeyVersion,
          sshMeshKeyMayRemainUsable ? createId("sshrekey") : null,
          now,
        ],
      );
      return { status: "retired", retiredAt: now, impact, alreadyRetired: false };
    });
    return tx();
  }

  private cleanSshMeshState(workspaceId: string, daemonId: string, updatedAt: string): void {
    this.ctx.db.run(
      `UPDATE multiremi_daemon_ssh_mesh_states
       SET runtime_id = NULL,
           protocol_version = 0,
           status = 'cleaned',
           key_version = NULL,
           config_revision = NULL,
           ssh_user = NULL,
           hostname = NULL,
           ssh_port = 22,
           addresses = '[]',
           host_keys = '[]',
           public_key_installed = 0,
           config_installed = 0,
           peer_tests = '[]',
           probe_revision = 0,
           desired_probe_revision = 0,
           probe_target_daemon_ids = '[]',
           last_error_code = NULL,
           last_error = NULL,
           updated_at = ?
       WHERE workspace_id = ? AND daemon_id = ?`,
      [updatedAt, workspaceId, daemonId],
    );
  }

  private rowsForRuntimeIds(sql: string, runtimeIds: string[], trailingParams: unknown[] = []): Row[] {
    if (!runtimeIds.length) return [];
    const placeholders = runtimeIds.map(() => "?").join(",");
    return this.ctx.db.query(sql.replace("__RUNTIME_IDS__", placeholders)).all(...runtimeIds, ...trailingParams) as Row[];
  }

  private runtimeAuxiliarySnapshotRows(
    table: (typeof RUNTIME_AUXILIARY_TABLES)[number],
    runtimeIds: string[],
  ): Array<Record<string, string>> {
    const identityColumns = table === "multiremi_runtime_models"
      ? ["runtime_id", "model_id"]
      : ["runtime_id", "id"];
    const rows = this.rowsForRuntimeIds(
      `SELECT ${identityColumns.join(", ")}
       FROM ${table}
       WHERE runtime_id IN (__RUNTIME_IDS__)
       ORDER BY ${identityColumns.join(", ")}`,
      runtimeIds,
    );
    return rows.map((row) => Object.fromEntries(
      identityColumns.map((column) => [column, String(row[column])]),
    ));
  }

  private listLocalDirectoryResources(workspaceId: string, daemonId: string): DaemonRetirementPlan["localDirectoryResources"] {
    const rows = this.ctx.db.query(
      `SELECT resource.id, resource.project_id, resource.resource_ref, resource.label, project.title AS project_title
       FROM multiremi_project_resources resource
       JOIN multiremi_projects project ON project.id = resource.project_id
       WHERE resource.workspace_id = ? AND resource.resource_type = 'local_directory'
       ORDER BY resource.id ASC`,
    ).all(workspaceId) as Row[];
    return rows.flatMap((row) => {
      const ref = parseJson<Record<string, unknown>>(row.resource_ref, {});
      const resourceDaemonId = String(ref.daemonId ?? ref.daemon_id ?? "").trim();
      if (resourceDaemonId !== daemonId) return [];
      return [{
        id: String(row.id),
        projectId: String(row.project_id),
        projectTitle: String(row.project_title ?? ""),
        label: row.label == null ? null : String(row.label),
        localPath: String(ref.localPath ?? ref.local_path ?? ""),
      }];
    });
  }
}

function hashRetirementSnapshot(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizeImpact(value: Record<string, unknown>): DaemonRetirementImpact {
  return {
    runtimesRemoved: Number(value.runtimesRemoved ?? value.runtimes_removed ?? 0),
    agentsDetached: Number(value.agentsDetached ?? value.agents_detached ?? 0),
    queuedTasksRequeued: Number(value.queuedTasksRequeued ?? value.queued_tasks_requeued ?? 0),
    sessionLanesReset: Number(value.sessionLanesReset ?? value.session_lanes_reset ?? 0),
    chatSessionsReset: Number(value.chatSessionsReset ?? value.chat_sessions_reset ?? 0),
    issueWorkspacesAbandoned: Number(
      value.issueWorkspacesAbandoned ?? value.issue_workspaces_abandoned ?? 0,
    ),
    tokensRevoked: Number(value.tokensRevoked ?? value.tokens_revoked ?? 0),
  };
}

function hydrateSshMeshRekey(row: Row): DaemonRetirementSshMeshRekey {
  const rawStatus = String(row.ssh_mesh_rekey_status ?? "not_required");
  const status: DaemonRetirementSshMeshRekeyStatus = rawStatus === "pending"
    || rawStatus === "rolling_out"
    || rawStatus === "completed"
    || rawStatus === "rekey_required"
    ? rawStatus
    : "not_required";
  return {
    status,
    compromisedKeyVersion: row.ssh_mesh_compromised_key_version == null
      ? null
      : Number(row.ssh_mesh_compromised_key_version),
    replacementKeyVersion: row.ssh_mesh_replacement_key_version == null
      ? null
      : Number(row.ssh_mesh_replacement_key_version),
    operationId: row.ssh_mesh_rekey_operation_id == null
      ? null
      : String(row.ssh_mesh_rekey_operation_id),
    updatedAt: row.ssh_mesh_rekey_updated_at == null ? null : String(row.ssh_mesh_rekey_updated_at),
  };
}
