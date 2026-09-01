// Runtimes domain (runtime registration/lifecycle, models, and the five daemon async-request
// families: model list, directory scan, update, local-skill list, local-skill import), extracted
// verbatim from MultiremiStore (the facade delegates every public method here).
//
// The six async-request families share one lifecycle, described once by `RuntimeRequestQueue`
// (./runtime-request-queue.ts) and configured by the specs below. Each family keeps its
// own `create` (distinct INSERT columns) and `report` (distinct completed-branch payload); `get`,
// `claim` and the timeout sweep are the shared template.
import { createId, nowIso } from "@multiremi/ids.js";
import {
  isRuntimeHeartbeatFresh,
  RUNTIME_HEARTBEAT_STALE_MS,
} from "@multiremi/contracts/runtime-health";
export { RUNTIME_HEARTBEAT_STALE_MS } from "@multiremi/contracts/runtime-health";
import {
  cleanOptionalString,
  daemonRuntimeId,
  hasAnyField,
  isActiveTaskStatus,
  isInFlightTaskStatus,
  isRecord,
  normalizeRuntimeConcurrency,
  nullableString,
  parseJson,
  parseTaskUsageEntries,
  resolveOptionalStringField,
  toJson,
} from "@multiremi/store/helpers.js";
import { type StoreContext } from "@multiremi/store/context.js";
import { canonicalizeDaemonRoutingWithinTransaction } from "@multiremi/store/daemon-routing.js";
import { RuntimeRequestQueue, type RuntimeRequestSpec } from "@multiremi/store/repos/runtime-request-queue.js";
import {
  redactRuntimeCommandArgs,
  redactRuntimeCommandText,
  truncateRuntimeCommandOutput,
} from "@multiremi/runtime-command-safety.js";
import {
  DEFAULT_RUNTIME_COMMAND_TIMEOUT_MS,
  MAX_NPM_GLOBAL_PROVISION_TIMEOUT_MS,
  MAX_RUNTIME_COMMAND_TIMEOUT_MS,
  normalizeRuntimeCommandTimeout,
  RUNTIME_COMMAND_PENDING_TIMEOUT_MS,
  RUNTIME_COMMAND_RUNNING_TIMEOUT_MS,
} from "@multiremi/runtime-command-policy.js";
import {
  RUNTIME_AUXILIARY_TABLES,
  RUNTIME_REQUEST_TABLES,
} from "@multiremi/store/runtime-lifecycle-tables.js";
import type {
  CreateRuntimeLocalSkillImportInput,
  CreateBotMenuPublishRequestInput,
  CreateRuntimeCommandInput,
  CreateRuntimeUpdateInput,
  MultiremiAgent,
  MultiremiAgentPluginRuntimeState,
  MultiremiDaemonHeartbeatAck,
  MultiremiRuntime,
  MultiremiRuntimeDirectoryCandidate,
  MultiremiRuntimeDirectoryScanParams,
  MultiremiRuntimeDirectoryScanRequest,
  MultiremiRuntimeDirectoryScanRequestStatus,
  MultiremiRuntimeCommandRequest,
  MultiremiRuntimeCommandRequestStatus,
  MultiremiRuntimeLocalSkillImportRequest,
  MultiremiRuntimeLocalSkillListRequest,
  MultiremiRuntimeLocalSkillRequestStatus,
  MultiremiRuntimeLocalSkillSummary,
  MultiremiRuntimeModel,
  MultiremiRuntimeModelListRequest,
  MultiremiRuntimeModelListRequestStatus,
  MultiremiRuntimeUpdateRequest,
  MultiremiRuntimeUpdateRequestStatus,
  MultiremiBotMenuPublishRequest,
  MultiremiRuntimeVisibility,
  MultiremiTaskStatus,
  RegisterRuntimeInput,
  ReportRuntimeDirectoryScanInput,
  ReportRuntimeCommandInput,
  ReportRuntimeLocalSkillImportInput,
  ReportRuntimeLocalSkillListInput,
  ReportRuntimeModelListInput,
  ReportRuntimeUpdateInput,
  ReportBotMenuPublishInput,
  UpdateRuntimeInput,
} from "@multiremi/contracts/types.js";
import {
  FEISHU_CONCIERGE_CONFIG_CAPABILITY,
  MULTIREMI_AGENT_PLUGIN_PROTOCOL_VERSION,
} from "@multiremi/contracts/types.js";

type Row = Record<string, unknown>;

export class RuntimeRegistrationIdentityConflictError extends Error {
  readonly code = "runtime_registration_identity_conflict";

  constructor(readonly runtimeId: string) {
    super(`Runtime ${runtimeId} is already registered to another daemon identity`);
    this.name = "RuntimeRegistrationIdentityConflictError";
  }
}

export type StrictRuntimeDeleteResult =
  | { status: "deleted" }
  | { status: "not_found" }
  | { status: "active_agents"; activeAgents: MultiremiAgent[] }
  | { status: "active_tasks" }
  | { status: "daemon_last_runtime"; daemonId: string };

export type ArchiveAgentsAndDeleteRuntimeResult =
  | { status: "ok"; agentsArchived: number; tasksCancelled: number }
  | { status: "plan_changed"; activeAgents: MultiremiAgent[] }
  | { status: "daemon_last_runtime"; daemonId: string };

const RUNTIME_MODEL_LIST_PENDING_TIMEOUT_MS = 30 * 1000;
const RUNTIME_MODEL_LIST_RUNNING_TIMEOUT_MS = 60 * 1000;
const RUNTIME_UPDATE_PENDING_TIMEOUT_MS = 120 * 1000;
const RUNTIME_UPDATE_RUNNING_TIMEOUT_MS = 150 * 1000;
const RUNTIME_LOCAL_SKILL_PENDING_TIMEOUT_MS = 3 * 60 * 1000;
const RUNTIME_LOCAL_SKILL_RUNNING_TIMEOUT_MS = 60 * 1000;
const RUNTIME_DIRECTORY_SCAN_PENDING_TIMEOUT_MS = 3 * 60 * 1000;
const RUNTIME_DIRECTORY_SCAN_RUNNING_TIMEOUT_MS = 60 * 1000;

// ── async-request family specs ────────────────────────────────────────────────
// The five knobs the shared queue template needs. Row mappers are hoisted function declarations
// defined at the bottom of this file.
const MODEL_LIST_REQUESTS: RuntimeRequestSpec<MultiremiRuntimeModelListRequest> = {
  table: "multiremi_runtime_model_list_requests",
  idPrefix: "rml",
  pendingTimeoutMs: RUNTIME_MODEL_LIST_PENDING_TIMEOUT_MS,
  runningTimeoutMs: RUNTIME_MODEL_LIST_RUNNING_TIMEOUT_MS,
  pendingTimeoutError: "daemon did not respond within 30 seconds",
  runningTimeoutError: "daemon did not finish within 60 seconds",
  hydrate: toRuntimeModelListRequest,
};

const DIRECTORY_SCAN_REQUESTS: RuntimeRequestSpec<MultiremiRuntimeDirectoryScanRequest> = {
  table: "multiremi_runtime_directory_scan_requests",
  idPrefix: "rds",
  pendingTimeoutMs: RUNTIME_DIRECTORY_SCAN_PENDING_TIMEOUT_MS,
  runningTimeoutMs: RUNTIME_DIRECTORY_SCAN_RUNNING_TIMEOUT_MS,
  pendingTimeoutError: "daemon did not respond within 3 minutes; the runtime daemon may need updating",
  runningTimeoutError: "daemon did not finish within 60 seconds",
  hydrate: toRuntimeDirectoryScanRequest,
};

const UPDATE_REQUESTS: RuntimeRequestSpec<MultiremiRuntimeUpdateRequest> = {
  table: "multiremi_runtime_update_requests",
  idPrefix: "rup",
  pendingTimeoutMs: RUNTIME_UPDATE_PENDING_TIMEOUT_MS,
  runningTimeoutMs: RUNTIME_UPDATE_RUNNING_TIMEOUT_MS,
  pendingTimeoutError: "daemon did not respond within 120 seconds",
  runningTimeoutError: "update did not complete within 150 seconds",
  hydrate: toRuntimeUpdateRequest,
};

const LOCAL_SKILL_LIST_REQUESTS: RuntimeRequestSpec<MultiremiRuntimeLocalSkillListRequest> = {
  table: "multiremi_runtime_local_skill_list_requests",
  idPrefix: "rls",
  pendingTimeoutMs: RUNTIME_LOCAL_SKILL_PENDING_TIMEOUT_MS,
  runningTimeoutMs: RUNTIME_LOCAL_SKILL_RUNNING_TIMEOUT_MS,
  pendingTimeoutError: "daemon did not respond within 3 minutes",
  runningTimeoutError: "daemon did not finish within 60 seconds",
  hydrate: toRuntimeLocalSkillListRequest,
};

const LOCAL_SKILL_IMPORT_REQUESTS: RuntimeRequestSpec<MultiremiRuntimeLocalSkillImportRequest> = {
  table: "multiremi_runtime_local_skill_import_requests",
  idPrefix: "rli",
  pendingTimeoutMs: RUNTIME_LOCAL_SKILL_PENDING_TIMEOUT_MS,
  runningTimeoutMs: RUNTIME_LOCAL_SKILL_RUNNING_TIMEOUT_MS,
  pendingTimeoutError: "daemon did not respond within 3 minutes",
  runningTimeoutError: "daemon did not finish within 60 seconds",
  hydrate: toRuntimeLocalSkillImportRequest,
};

const COMMAND_REQUESTS: RuntimeRequestSpec<MultiremiRuntimeCommandRequest> = {
  table: "multiremi_runtime_command_requests",
  idPrefix: "rcmd",
  pendingTimeoutMs: RUNTIME_COMMAND_PENDING_TIMEOUT_MS,
  runningTimeoutMs: RUNTIME_COMMAND_RUNNING_TIMEOUT_MS,
  pendingTimeoutError: "daemon did not respond within 3 minutes",
  runningTimeoutError: "daemon did not finish the command within 20 minutes",
  hydrate: toRuntimeCommandRequest,
};

const BOT_MENU_PUBLISH_REQUESTS: RuntimeRequestSpec<MultiremiBotMenuPublishRequest> = {
  table: "multiremi_bot_menu_publish_requests",
  idPrefix: "bmp",
  pendingTimeoutMs: 3 * 60 * 1000,
  runningTimeoutMs: 60 * 1000,
  pendingTimeoutError: "bot menu publisher did not respond within 3 minutes",
  runningTimeoutError: "bot menu publish did not finish within 60 seconds",
  hydrate: toBotMenuPublishRequest,
};

export class RuntimesRepo {
  private readonly modelListQueue: RuntimeRequestQueue<MultiremiRuntimeModelListRequest>;
  private readonly directoryScanQueue: RuntimeRequestQueue<MultiremiRuntimeDirectoryScanRequest>;
  private readonly updateQueue: RuntimeRequestQueue<MultiremiRuntimeUpdateRequest>;
  private readonly localSkillListQueue: RuntimeRequestQueue<MultiremiRuntimeLocalSkillListRequest>;
  private readonly localSkillImportQueue: RuntimeRequestQueue<MultiremiRuntimeLocalSkillImportRequest>;
  private readonly commandQueue: RuntimeRequestQueue<MultiremiRuntimeCommandRequest>;
  private readonly botMenuPublishQueue: RuntimeRequestQueue<MultiremiBotMenuPublishRequest>;

  constructor(private ctx: StoreContext) {
    this.modelListQueue = new RuntimeRequestQueue(ctx.db, MODEL_LIST_REQUESTS);
    this.directoryScanQueue = new RuntimeRequestQueue(ctx.db, DIRECTORY_SCAN_REQUESTS);
    this.updateQueue = new RuntimeRequestQueue(ctx.db, UPDATE_REQUESTS);
    this.localSkillListQueue = new RuntimeRequestQueue(ctx.db, LOCAL_SKILL_LIST_REQUESTS);
    this.localSkillImportQueue = new RuntimeRequestQueue(ctx.db, LOCAL_SKILL_IMPORT_REQUESTS);
    this.commandQueue = new RuntimeRequestQueue(ctx.db, COMMAND_REQUESTS);
    this.botMenuPublishQueue = new RuntimeRequestQueue(ctx.db, BOT_MENU_PUBLISH_REQUESTS);
  }

  registerRuntime(input: RegisterRuntimeInput): MultiremiRuntime {
    return this.ctx.db.transaction(() => this.registerRuntimeWithinTransaction(input))();
  }

  /** Caller already owns the transaction and any daemon/workspace locks. */
  registerRuntimeWithinTransaction(input: RegisterRuntimeInput): MultiremiRuntime {
    const id = input.id ?? createId("rt");
    const now = nowIso();
    const currentRow = this.ctx.db.query("SELECT * FROM multiremi_runtimes WHERE id = ?").get(id) as Row | null;
    const current = currentRow ? toRuntime(currentRow) : null;
    const inputOwnerId = hasAnyField(input, "ownerId", "owner_id")
      ? resolveOptionalStringField(input, "ownerId", "owner_id", current?.ownerId ?? null)
      : current?.ownerId ?? null;
    const ownerId = current && inputOwnerId == null ? current.ownerId : inputOwnerId;
    const visibility = hasAnyField(input, "visibility")
      ? normalizeRuntimeVisibility(input.visibility)
      : current?.visibility ?? "private";
    const daemonId = hasAnyField(input, "daemonId", "daemon_id")
      ? resolveOptionalStringField(input, "daemonId", "daemon_id", current?.daemonId ?? null)
      : current?.daemonId ?? null;
    const legacyDaemonId = hasAnyField(input, "legacyDaemonId", "legacy_daemon_id")
      ? resolveOptionalStringField(input, "legacyDaemonId", "legacy_daemon_id", current?.legacyDaemonId ?? null)
      : current?.legacyDaemonId ?? null;
    const runtimeMode = hasAnyField(input, "runtimeMode", "runtime_mode")
      ? cleanOptionalString(input.runtimeMode ?? input.runtime_mode) ?? "local"
      : current?.runtimeMode ?? "local";
    const deviceInfo = hasAnyField(input, "deviceInfo", "device_info")
      ? cleanOptionalString(input.deviceInfo ?? input.device_info) ?? ""
      : current?.deviceInfo ?? "";
    const metadata = hasAnyField(input, "metadata")
      ? preserveRuntimeMergeAudit(current?.metadata ?? {}, normalizeRuntimeMetadata(input.metadata ?? {}))
      : current?.metadata ?? {};
    const maxConcurrency = normalizeRuntimeConcurrency(input.maxConcurrency ?? input.max_concurrency ?? current?.maxConcurrency ?? 1);
    const status = input.status === "offline" ? "offline" : "online";
    const result = this.ctx.db.run(
      `INSERT INTO multiremi_runtimes (
        id, name, provider, daemon_id, legacy_daemon_id, runtime_mode, device_info, metadata,
        workspace_id, owner_id, visibility, status, max_concurrency,
        last_heartbeat_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = CASE WHEN multiremi_runtimes.name_customized = 1 THEN multiremi_runtimes.name ELSE excluded.name END,
        provider = excluded.provider,
        daemon_id = excluded.daemon_id,
        legacy_daemon_id = excluded.legacy_daemon_id,
        runtime_mode = excluded.runtime_mode,
        device_info = excluded.device_info,
        metadata = excluded.metadata,
        workspace_id = excluded.workspace_id,
        owner_id = excluded.owner_id,
        visibility = excluded.visibility,
        status = excluded.status,
        max_concurrency = excluded.max_concurrency,
        last_heartbeat_at = excluded.last_heartbeat_at,
        updated_at = excluded.updated_at
      WHERE COALESCE(multiremi_runtimes.workspace_id, 'local') = COALESCE(excluded.workspace_id, 'local')
        AND (
          COALESCE(multiremi_runtimes.daemon_id, '') = COALESCE(excluded.daemon_id, '')
          OR (
            multiremi_runtimes.daemon_id IS NULL
            AND excluded.daemon_id IS NOT NULL
            AND multiremi_runtimes.provider = excluded.provider
            AND (
              COALESCE(multiremi_runtimes.owner_id, '') = COALESCE(excluded.owner_id, '')
              OR (multiremi_runtimes.owner_id IS NULL AND excluded.owner_id = 'local')
            )
          )
        )`,
      [
        id,
        input.name,
        input.provider,
        daemonId,
        legacyDaemonId,
        runtimeMode,
        deviceInfo,
        toJson(metadata),
        input.workspaceId ?? input.workspace_id ?? null,
        ownerId,
        visibility,
        status,
        maxConcurrency,
        now,
        now,
        now,
      ],
    );
    // Runtime ids are global primary keys. Daemon ids used to be mapped through
    // a short hash that can collide, and the hash did not include workspace.
    // The conditional UPSERT above is the concurrency-safe invariant: a daemon
    // registration may only refresh the exact machine identity that already
    // owns this row. The narrow second branch upgrades pre-daemon legacy rows:
    // provider and owner must still match (an ownerless row is recoverable only
    // by the local administrator/open single-user deployment). Provider changes
    // remain valid after a daemon identity is established and cause pinned work
    // to be re-pooled below. A rejected conflict reports zero changed rows.
    if (result.changes === 0) throw new RuntimeRegistrationIdentityConflictError(id);
    if (input.models !== undefined) {
      this.replaceRuntimeModelsWithinTransaction(id, input.models, input.provider, now);
    }
    const runtime = this.getRuntime(id)!;
    if (!current) {
      this.ctx.analytics().recordRuntimeRegisteredAnalytics(runtime);
      if (runtime.status === "online") this.ctx.analytics().recordRuntimeReadyAnalytics(runtime, 0);
    } else if (
      // A re-registration under the same id that changes a scheduling-relevant
      // field (provider / workspace / owner / visibility) can strand queued
      // tasks pinned here that this runtime may no longer claim. Re-pool the
      // ineligible ones. (setRuntimeOffline is intentionally NOT treated this
      // way — offline is a recoverable transient state; the task waits.)
      current.provider !== runtime.provider ||
      (current.workspaceId ?? "local") !== (runtime.workspaceId ?? "local") ||
      current.visibility !== runtime.visibility ||
      (current.ownerId ?? "local") !== (runtime.ownerId ?? "local")
    ) {
      this.repoolQueuedTasksForRuntime(id, (agent) => this.runtimeCanRunAgent(runtime, agent));
    }
    return runtime;
  }

  getRuntime(id: string): MultiremiRuntime | null {
    const row = this.ctx.db.query(
      `SELECT runtime.*, profile.display_name AS daemon_display_name
       FROM multiremi_runtimes runtime
       LEFT JOIN multiremi_daemon_profiles profile
         ON profile.workspace_id = COALESCE(runtime.workspace_id, 'local')
        AND profile.daemon_id = runtime.daemon_id
       WHERE runtime.id = ?`,
    ).get(id) as Row | null;
    return row ? withRuntimeLiveness(this.hydrateRuntime(toRuntime(row))) : null;
  }

  listRuntimes(): MultiremiRuntime[] {
    const rows = this.ctx.db.query(
      `SELECT runtime.*, profile.display_name AS daemon_display_name
       FROM multiremi_runtimes runtime
       LEFT JOIN multiremi_daemon_profiles profile
         ON profile.workspace_id = COALESCE(runtime.workspace_id, 'local')
        AND profile.daemon_id = runtime.daemon_id
       ORDER BY runtime.updated_at DESC`,
    ).all() as Row[];
    return rows.map((row) => withRuntimeLiveness(this.hydrateRuntime(toRuntime(row))));
  }

  updateRuntime(id: string, input: UpdateRuntimeInput): MultiremiRuntime {
    return this.withRuntimeLifecycleLock(id, (current) => {
      const ownerId = resolveOptionalStringField(input, "ownerId", "owner_id", current.ownerId);
      const visibility = hasAnyField(input, "visibility")
        ? normalizeRuntimeVisibility(input.visibility)
        : current.visibility;
      const maxConcurrency = hasAnyField(input, "maxConcurrency", "max_concurrency")
        ? normalizeRuntimeConcurrency(input.maxConcurrency ?? input.max_concurrency)
        : current.maxConcurrency;
      const runtimeMode = hasAnyField(input, "runtimeMode", "runtime_mode")
        ? cleanOptionalString(input.runtimeMode ?? input.runtime_mode) ?? "local"
        : current.runtimeMode;
      const deviceInfo = hasAnyField(input, "deviceInfo", "device_info")
        ? cleanOptionalString(input.deviceInfo ?? input.device_info) ?? ""
        : current.deviceInfo;
      const metadata = hasAnyField(input, "metadata")
        ? normalizeRuntimeMetadata(input.metadata ?? {})
        : current.metadata;
      const now = nowIso();
      this.ctx.db.run(
        `UPDATE multiremi_runtimes SET
          name = ?,
          name_customized = CASE WHEN ? = 1 THEN 1 ELSE name_customized END,
          runtime_mode = ?,
          device_info = ?,
          metadata = ?,
          owner_id = ?,
          visibility = ?,
          max_concurrency = ?,
          updated_at = ?
         WHERE id = ?`,
        [
          input.name ?? current.name,
          hasAnyField(input, "name") ? 1 : 0,
          runtimeMode,
          deviceInfo,
          toJson(metadata),
          ownerId,
          visibility,
          maxConcurrency,
          now,
          id,
        ],
      );
      if (input.models !== undefined) this.replaceRuntimeModelsWithinTransaction(id, input.models, current.provider, now);
      const updated = this.getRuntime(id)!;
      // Ownership/visibility just changed → re-pool any queued task pinned here
      // that the runtime may no longer run, so it isn't stranded on a machine the
      // claim predicate now rejects.
      if (current.visibility !== updated.visibility || (current.ownerId ?? "local") !== (updated.ownerId ?? "local")) {
        this.repoolQueuedTasksForRuntime(id, (agent) => this.runtimeCanRunAgent(updated, agent));
      }
      return updated;
    });
  }

  setRuntimeOffline(id: string): MultiremiRuntime | null {
    const current = this.getRuntime(id);
    if (!current) return null;
    const now = nowIso();
    this.ctx.db.run(
      "UPDATE multiremi_runtimes SET status = 'offline', updated_at = ? WHERE id = ?",
      [now, id],
    );
    const runtime = this.getRuntime(id);
    if (runtime && current.status !== "offline") this.ctx.analytics().recordRuntimeOfflineAnalytics(runtime);
    return runtime;
  }

  deleteRuntime(id: string): boolean {
    const initial = this.getRuntime(id);
    if (!initial) return false;
    return this.ctx.db.transaction(() => {
      const workspaceId = initial.workspaceId ?? "local";
      this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
      this.ctx.agentPlugins().lockAgentPluginWorkspace(workspaceId);
      const current = this.getRuntime(id);
      if (!current || (current.workspaceId ?? "local") !== workspaceId) return false;
      if (this.isLastManagedDaemonRuntime(current)) return false;
      return this.deleteRuntimeWithinTransaction(id);
    })();
  }

  /** Caller owns the Runtime workspace lifecycle and Plugin locks. */
  private deleteRuntimeWithinTransaction(
    id: string,
    options: { repoolQueuedTasks?: boolean } = {},
  ): boolean {
    if (!this.getRuntime(id)) return false;
    // Task claim takes the same workspace lifecycle lock as Runtime deletion,
    // so this check cannot race a queued task becoming dispatched. Queued work
    // is safely re-pooled below; work already owned by a daemon must be handled
    // explicitly by the confirmed cascade path instead of being orphaned.
    if (this.hasInFlightTasksForRuntime(id) || this.hasUnrepoolableQueuedTasksForRuntime(id)) return false;
    const now = nowIso();
    if (options.repoolQueuedTasks !== false) this.repoolQueuedTasksForRuntime(id);
    // A concierge whose host machine is going away must not stay enabled: an
    // admin has to pick a new Runtime deliberately rather than have the bot
    // silently reappear somewhere else.
    this.ctx.feishuBot().disableFeishuBotConfigsReferencingRuntime(id);

    // PostgreSQL intentionally has no FK cascades, and SQLite tests may have
    // FK enforcement disabled. Keep every runtime reference explicit here so
    // all delete paths have identical behavior.
    this.ctx.db.run(
      "UPDATE multiremi_agents SET runtime_id = NULL, updated_at = ? WHERE runtime_id = ?",
      [now, id],
    );
    this.ctx.db.run(
      `UPDATE multiremi_issue_workspaces
       SET runtime_id = NULL,
           status = CASE WHEN status = 'cleaned' THEN status ELSE 'runtime_offline' END,
           updated_at = ?
       WHERE runtime_id = ?`,
      [now, id],
    );
    this.ctx.db.run(
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
       WHERE runtime_id = ?`,
      [now, id],
    );
    this.ctx.db.run(
      `UPDATE multiremi_chat_sessions
       SET session_id = NULL,
           work_dir = NULL,
           session_runtime_id = NULL,
           session_provider = NULL,
           session_execution_fingerprint = NULL,
           updated_at = ?
       WHERE session_runtime_id = ?`,
      [now, id],
    );
    for (const table of RUNTIME_AUXILIARY_TABLES) {
      this.ctx.db.run(`DELETE FROM ${table} WHERE runtime_id = ?`, [id]);
    }
    return this.ctx.db.run("DELETE FROM multiremi_runtimes WHERE id = ?", [id]).changes > 0;
  }

  /**
   * Unpin queued tasks stamped to a runtime that can no longer run them (the
   * runtime is being deleted, or `stillEligible` reports it turned private /
   * changed owner / changed provider). Clears runtime_id + the promoted
   * session_id / work_dir so the task re-enters the pool cleanly. In-flight
   * tasks are left to orphan recovery.
   *
   * local_directory-affine tasks are NEVER unpinned: their directory lives on
   * that specific machine, so re-pooling would let a provider-matching machine
   * WITHOUT the directory claim them and run in a scratch checkout of the wrong
   * repo. They stay pinned and park until the correct machine is available
   * again — the safe failure.
   */
  private repoolQueuedTasksForRuntime(
    runtimeId: string,
    stillEligible?: (agent: MultiremiAgent) => boolean,
  ): void {
    const rows = this.ctx.db
      .query("SELECT * FROM multiremi_tasks WHERE runtime_id = ? AND status = 'queued'")
      .all(runtimeId) as Row[];
    const now = nowIso();
    for (const row of rows) {
      const agent = this.ctx.agents().getAgent(String(row.agent_id));
      if (stillEligible && agent && stillEligible(agent)) continue;
      const daemonId = this.ctx.localDirectoryDaemonForTask(row);
      if (daemonId) {
        // A local_directory task is never re-pooled (its directory only exists
        // on that daemon). But if THIS runtime is being retired/changed and the
        // directory's daemon now has a different-id runtime for the agent's
        // engine (e.g. a re-registration changed the provider → a new
        // deterministic id), re-pin to it so the task isn't stranded on the old
        // id. Otherwise leave it pinned to wait for the right machine.
        if (agent) {
          const rt = this.getRuntimeByDaemonAndProvider(daemonId, agent.provider);
          const targetId = rt ? rt.id : daemonRuntimeId(daemonId, agent.provider);
          if (targetId !== runtimeId) {
            this.ctx.db.run(
              "UPDATE multiremi_tasks SET runtime_id = ?, session_id = NULL, updated_at = ? WHERE id = ?",
              [targetId, now, String(row.id)],
            );
          }
        }
        continue;
      }
      this.ctx.db.run(
        "UPDATE multiremi_tasks SET runtime_id = NULL, session_id = NULL, work_dir = NULL, updated_at = ? WHERE id = ?",
        [now, String(row.id)],
      );
    }
  }

  /** The daemon id a task is bound to by a local_directory resource, or null. */
  deleteRuntimeWithArchivedAgentCleanup(id: string): StrictRuntimeDeleteResult {
    const initial = this.getRuntime(id);
    if (!initial) return { status: "not_found" };
    let clearedProjects: Array<{ id: string; workspaceId: string; updatedAt: string }> = [];
    const result = this.ctx.db.transaction(() => {
      const workspaceId = initial.workspaceId ?? "local";
      this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
      this.ctx.agentPlugins().lockAgentPluginWorkspace(workspaceId);
      const current = this.getRuntime(id);
      if (!current || (current.workspaceId ?? "local") !== workspaceId) return { status: "not_found" as const };
      const activeAgents = this.ctx.agents().listActiveAgentsByRuntime(id);
      if (activeAgents.length) return { status: "active_agents" as const, activeAgents };
      const archivedAgentIds = this.listArchivedAgentIdsByRuntime(id);
      // Check before pausing autopilots or deleting archived Agents: a refused
      // delete must leave the entire Runtime graph unchanged.
      if (
        this.hasInFlightTasksForRuntime(id)
        || this.hasUnrepoolableQueuedTasksForRuntime(id)
        || this.hasActiveTasksForAgents(archivedAgentIds)
      ) return { status: "active_tasks" as const };
      if (this.isLastManagedDaemonRuntime(current)) {
        return { status: "daemon_last_runtime" as const, daemonId: current.daemonId! };
      }
      this.pauseAutopilotsByAgentIds(archivedAgentIds);
      clearedProjects = this.detachArchivedAgentsFromRuntime(id).clearedProjects;
      const deleted = this.deleteRuntimeWithinTransaction(id);
      if (!deleted) throw new Error(`Runtime changed during deletion: ${id}`);
      return { status: "deleted" as const };
    })();
    this.publishClearedProjectDefaults(clearedProjects);
    return result;
  }

  archiveAgentsAndDeleteRuntime(
    id: string,
    expectedActiveAgentIds: string[],
  ): ArchiveAgentsAndDeleteRuntimeResult {
    const initial = this.getRuntime(id);
    if (!initial) throw new Error(`Runtime not found: ${id}`);
    const expected = new Set(expectedActiveAgentIds);
    let clearedProjects: Array<{ id: string; workspaceId: string; updatedAt: string }> = [];
    const result = this.ctx.db.transaction(() => {
      const workspaceId = initial.workspaceId ?? "local";
      this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
      this.ctx.agentPlugins().lockAgentPluginWorkspace(workspaceId);
      const current = this.getRuntime(id);
      if (!current || (current.workspaceId ?? "local") !== workspaceId) throw new Error(`Runtime not found: ${id}`);
      const activeAgents = this.ctx.agents().listActiveAgentsByRuntime(id);
      if (!activeAgentSetMatches(activeAgents, expected)) {
        return { status: "plan_changed" as const, activeAgents };
      }
      if (this.isLastManagedDaemonRuntime(current)) {
        return { status: "daemon_last_runtime" as const, daemonId: current.daemonId! };
      }

      const activeAgentIds = activeAgents.map((agent) => agent.id);
      const now = nowIso();
      if (activeAgentIds.length) {
        this.ctx.db.run(
          `UPDATE multiremi_agents
           SET archived_at = ?, updated_at = ?
           WHERE id IN (${activeAgentIds.map(() => "?").join(",")}) AND archived_at IS NULL`,
          [now, now, ...activeAgentIds],
        );
      }

      const tasksCancelled = this.cancelActiveTasksByRuntimeOrAgentIds(id, activeAgentIds);
      this.pauseAutopilotsByAgentIds([...activeAgentIds, ...this.listArchivedAgentIdsByRuntime(id)]);
      const agentsArchived = activeAgentIds.length;
      clearedProjects = this.detachArchivedAgentsFromRuntime(id).clearedProjects;
      const deleted = this.deleteRuntimeWithinTransaction(id);
      if (!deleted) throw new Error(`Runtime not found: ${id}`);
      return { status: "ok" as const, agentsArchived, tasksCancelled };
    })();
    this.publishClearedProjectDefaults(clearedProjects);
    return result;
  }

  private listArchivedAgentIdsByRuntime(runtimeId: string): string[] {
    const rows = this.ctx.db.query(
      "SELECT id FROM multiremi_agents WHERE runtime_id = ? AND archived_at IS NOT NULL ORDER BY id ASC",
    ).all(runtimeId) as Array<{ id: string }>;
    return rows.map((row) => String(row.id));
  }

  private pauseAutopilotsByAgentIds(agentIds: string[]): number {
    const ids = [...new Set(agentIds)].filter(Boolean);
    if (!ids.length) return 0;
    const now = nowIso();
    const result = this.ctx.db.run(
      `UPDATE multiremi_autopilots
       SET status = 'paused', updated_at = ?
       WHERE assignee_type = 'agent'
         AND assignee_id IN (${ids.map(() => "?").join(",")})
         AND status != 'archived'`,
      [now, ...ids],
    );
    return result.changes;
  }

  private cancelActiveTasksByRuntimeOrAgentIds(runtimeId: string, agentIds: string[]): number {
    const agentSet = new Set(agentIds);
    const taskIds = [...new Set(
      this.ctx.tasks().listTasks()
        .filter((task) => isActiveTaskStatus(task.status) && (task.runtimeId === runtimeId || agentSet.has(task.agentId)))
        .map((task) => task.id),
    )];
    let cancelled = 0;
    for (const taskId of taskIds) {
      try {
        this.ctx.tasks().cancelTask(taskId);
        cancelled += 1;
      } catch {
        // Task may have reached a terminal state between the snapshot and cancel.
      }
    }
    return cancelled;
  }

  private hasInFlightTasksForRuntime(runtimeId: string): boolean {
    return this.ctx.tasks().listTasks()
      .some((task) => task.runtimeId === runtimeId && isInFlightTaskStatus(task.status));
  }

  private hasActiveTasksForAgents(agentIds: string[]): boolean {
    if (!agentIds.length) return false;
    const agents = new Set(agentIds);
    return this.ctx.tasks().listTasks()
      .some((task) => agents.has(task.agentId) && isActiveTaskStatus(task.status));
  }

  private hasUnrepoolableQueuedTasksForRuntime(runtimeId: string): boolean {
    const rows = this.ctx.db.query(
      "SELECT * FROM multiremi_tasks WHERE runtime_id = ? AND status = 'queued'",
    ).all(runtimeId) as Row[];
    for (const row of rows) {
      const daemonId = this.ctx.localDirectoryDaemonForTask(row);
      if (!daemonId) continue;
      const agent = this.ctx.agents().getAgent(String(row.agent_id));
      if (!agent) return true;
      const target = this.getRuntimeByDaemonAndProvider(daemonId, agent.provider);
      if (!target || target.id === runtimeId) return true;
    }
    return false;
  }

  private isLastManagedDaemonRuntime(runtime: MultiremiRuntime): boolean {
    const daemonId = cleanOptionalString(runtime.daemonId);
    if (!daemonId || runtime.runtimeMode !== "local") return false;
    const row = this.ctx.db.query(
      `SELECT COUNT(*) AS count
       FROM multiremi_runtimes
       WHERE COALESCE(workspace_id, 'local') = ? AND daemon_id = ? AND id != ?`,
    ).get(runtime.workspaceId ?? "local", daemonId, runtime.id) as { count: number } | null;
    return Number(row?.count ?? 0) === 0;
  }

  private detachArchivedAgentsFromRuntime(runtimeId: string): {
    detached: number;
    clearedProjects: Array<{ id: string; workspaceId: string; updatedAt: string }>;
  } {
    const ids = this.listArchivedAgentIdsByRuntime(runtimeId);
    if (!ids.length) return { detached: 0, clearedProjects: [] };
    const placeholders = ids.map(() => "?").join(",");
    const now = nowIso();
    const clearedProjects = (this.ctx.db.query(
      `SELECT id, workspace_id
       FROM multiremi_projects
       WHERE default_assignee_type = 'agent' AND default_assignee_id IN (${placeholders})
       ORDER BY id ASC`,
    ).all(...ids) as Array<{ id: string; workspace_id: string }>).map((project) => ({
      id: String(project.id),
      workspaceId: String(project.workspace_id),
      updatedAt: now,
    }));
    this.ctx.db.run(
      `UPDATE multiremi_projects
       SET default_assignee_type = NULL, default_assignee_id = NULL, updated_at = ?
       WHERE default_assignee_type = 'agent' AND default_assignee_id IN (${placeholders})`,
      [now, ...ids],
    );
    // Archived agents remain first-class history: tasks, chats, issue events and
    // configuration still reference them. Removing the machine only detaches
    // their unavailable runtime; it must not hard-delete the Agent row.
    const detached = this.ctx.db.run(
      `UPDATE multiremi_agents
       SET runtime_id = NULL, updated_at = ?
       WHERE id IN (${placeholders}) AND archived_at IS NOT NULL`,
      [now, ...ids],
    ).changes;
    const runtime = this.getRuntime(runtimeId);
    if (runtime) this.ctx.agentPlugins().reconcileAgentPluginDesiredStateWithinLock(runtime.workspaceId ?? "local");
    return { detached, clearedProjects };
  }

  private publishClearedProjectDefaults(
    projects: Array<{ id: string; workspaceId: string; updatedAt: string }>,
  ): void {
    for (const project of projects) {
      this.ctx.emitWorkspaceEvent({
        type: "project:updated",
        workspaceId: project.workspaceId,
        actorType: "system",
        actorId: null,
        payload: {
          project: {
            id: project.id,
            default_assignee_type: null,
            default_assignee_id: null,
            updated_at: project.updatedAt,
          },
        },
      });
    }
  }

  mergeRuntimeInto(
    oldRuntimeId: string,
    newRuntimeId: string,
    options: { legacyDaemonIds?: string[] } = {},
  ): { agentsReassigned: number; tasksReassigned: number; deleted: boolean } {
    if (oldRuntimeId === newRuntimeId) return { agentsReassigned: 0, tasksReassigned: 0, deleted: false };
    const oldRuntime = this.getRuntime(oldRuntimeId);
    const newRuntime = this.getRuntime(newRuntimeId);
    if (!oldRuntime || !newRuntime) return { agentsReassigned: 0, tasksReassigned: 0, deleted: false };
    if (oldRuntime.workspaceId !== newRuntime.workspaceId || oldRuntime.provider !== newRuntime.provider) {
      return { agentsReassigned: 0, tasksReassigned: 0, deleted: false };
    }

    const now = nowIso();
    const tx = this.ctx.db.transaction(() => {
      this.ctx.lockWorkspaceRuntimeLifecycle(oldRuntime.workspaceId ?? "local");
      this.ctx.agentPlugins().lockAgentPluginWorkspace(oldRuntime.workspaceId ?? "local");
      const lockedOldRuntime = this.getRuntime(oldRuntimeId);
      const lockedNewRuntime = this.getRuntime(newRuntimeId);
      if (!lockedOldRuntime || !lockedNewRuntime) {
        return { agentsReassigned: 0, tasksReassigned: 0, deleted: false };
      }
      if (lockedOldRuntime.workspaceId !== lockedNewRuntime.workspaceId || lockedOldRuntime.provider !== lockedNewRuntime.provider) {
        return { agentsReassigned: 0, tasksReassigned: 0, deleted: false };
      }
      const workspaceId = lockedNewRuntime.workspaceId ?? "local";
      const canonicalDaemonId = cleanOptionalString(lockedNewRuntime.daemonId);
      if (canonicalDaemonId) {
        const legacyDaemonIds = new Set([
          cleanOptionalString(lockedOldRuntime.daemonId),
          ...(options.legacyDaemonIds ?? []).map(cleanOptionalString),
        ].filter((value): value is string => !!value));
        for (const legacyDaemonId of legacyDaemonIds) {
          canonicalizeDaemonRoutingWithinTransaction(
            this.ctx.db,
            workspaceId,
            legacyDaemonId,
            canonicalDaemonId,
            now,
          );
        }
      }
      const agents = this.ctx.db.run(
        "UPDATE multiremi_agents SET runtime_id = ?, updated_at = ? WHERE runtime_id = ?",
        [newRuntimeId, now, oldRuntimeId],
      ).changes;
      const tasks = this.ctx.db.run(
        "UPDATE multiremi_tasks SET runtime_id = ?, updated_at = ? WHERE runtime_id = ?",
        [newRuntimeId, now, oldRuntimeId],
      ).changes;
      // Move the chat-session affinity metadata too, or the follow-up would
      // think the session's machine vanished once the old runtime is deleted
      // and needlessly abandon a still-resumable session.
      this.ctx.db.run(
        "UPDATE multiremi_chat_sessions SET session_runtime_id = ?, updated_at = ? WHERE session_runtime_id = ?",
        [newRuntimeId, now, oldRuntimeId],
      );
      this.ctx.db.run(
        "UPDATE multiremi_session_agent_lanes SET runtime_id = ?, updated_at = ? WHERE runtime_id = ?",
        [newRuntimeId, now, oldRuntimeId],
      );
      this.ctx.db.run(
        "UPDATE multiremi_issue_workspaces SET runtime_id = ?, updated_at = ? WHERE runtime_id = ?",
        [newRuntimeId, now, oldRuntimeId],
      );

      // The newly registered Runtime is authoritative for duplicate model ids;
      // preserve every non-conflicting model learned under the legacy id.
      this.ctx.db.run(
        `DELETE FROM multiremi_runtime_models
         WHERE runtime_id = ?
           AND model_id IN (
             SELECT model_id FROM multiremi_runtime_models WHERE runtime_id = ?
           )`,
        [oldRuntimeId, newRuntimeId],
      );
      this.ctx.db.run(
        `UPDATE multiremi_runtime_models
         SET is_default = 0, updated_at = ?
         WHERE runtime_id = ?
           AND EXISTS (
             SELECT 1 FROM multiremi_runtime_models WHERE runtime_id = ? AND is_default = 1
           )`,
        [now, oldRuntimeId, newRuntimeId],
      );
      this.ctx.db.run(
        "UPDATE multiremi_runtime_models SET runtime_id = ?, updated_at = ? WHERE runtime_id = ?",
        [newRuntimeId, now, oldRuntimeId],
      );
      for (const table of RUNTIME_REQUEST_TABLES) {
        this.ctx.db.run(
          `UPDATE ${table} SET runtime_id = ?, updated_at = ? WHERE runtime_id = ?`,
          [newRuntimeId, now, oldRuntimeId],
        );
      }

      const deleted = this.deleteRuntimeWithinTransaction(oldRuntimeId, { repoolQueuedTasks: false });
      return { agentsReassigned: agents, tasksReassigned: tasks, deleted };
    });
    return tx();
  }

  canonicalizeLegacyDaemonRouting(
    workspaceId: string,
    legacyDaemonIds: string[],
    canonicalDaemonId: string,
  ): void {
    const canonical = canonicalDaemonId.trim();
    if (!canonical) return;
    const aliases = [...new Set(legacyDaemonIds.map((value) => value.trim()).filter(Boolean))];
    if (!aliases.length) return;
    this.ctx.db.transaction(() => {
      this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
      const now = nowIso();
      for (const legacyDaemonId of aliases) {
        canonicalizeDaemonRoutingWithinTransaction(
          this.ctx.db,
          workspaceId,
          legacyDaemonId,
          canonical,
          now,
        );
      }
    })();
  }

  recordRuntimeLegacyDaemonId(
    runtimeId: string,
    legacyDaemonId: string,
    audit?: {
      oldRuntimeId: string;
      newRuntimeId: string;
      provider: string;
      agentsReassigned: number;
      tasksReassigned: number;
    },
  ): MultiremiRuntime | null {
    const runtime = this.getRuntime(runtimeId);
    const normalized = legacyDaemonId.trim();
    if (!runtime || !normalized) return runtime;
    const now = nowIso();
    const metadata = audit
      ? withLegacyRuntimeMergeAudit(runtime.metadata, {
          legacyDaemonId: normalized,
          oldRuntimeId: audit.oldRuntimeId,
          newRuntimeId: audit.newRuntimeId,
          provider: audit.provider,
          agentsReassigned: audit.agentsReassigned,
          tasksReassigned: audit.tasksReassigned,
          mergedAt: now,
        })
      : runtime.metadata;
    this.ctx.db.run(
      `UPDATE multiremi_runtimes
       SET legacy_daemon_id = COALESCE(legacy_daemon_id, ?), metadata = ?, updated_at = ?
       WHERE id = ?`,
      [normalized, toJson(metadata), now, runtimeId],
    );
    return this.getRuntime(runtimeId);
  }

  listRuntimeModels(runtimeId: string): MultiremiRuntimeModel[] {
    if (!this.ctx.db.query("SELECT id FROM multiremi_runtimes WHERE id = ?").get(runtimeId)) {
      throw new Error(`Runtime not found: ${runtimeId}`);
    }
    return this.listRuntimeModelsForExistingRuntime(runtimeId);
  }

  updateRuntimeModels(runtimeId: string, models: MultiremiRuntimeModel[]): MultiremiRuntimeModel[] {
    return this.withRuntimeLifecycleLock(runtimeId, (runtime) => {
      this.replaceRuntimeModelsWithinTransaction(runtimeId, models, runtime.provider, nowIso());
      return this.listRuntimeModelsForExistingRuntime(runtimeId);
    });
  }

  createRuntimeModelListRequest(runtimeId: string): MultiremiRuntimeModelListRequest {
    return this.withRuntimeLifecycleLock(runtimeId, (runtime) => {
      this.assertRuntimeOnline(runtime);
      const id = this.modelListQueue.nextId();
      const now = nowIso();
      this.ctx.db.run(
        `INSERT INTO multiremi_runtime_model_list_requests (
          id, runtime_id, status, models, supported, created_at, updated_at
        ) VALUES (?, ?, 'pending', '[]', 1, ?, ?)`,
        [id, runtimeId, now, now],
      );
      return this.getRuntimeModelListRequest(runtimeId, id)!;
    });
  }

  getRuntimeModelListRequest(runtimeId: string, requestId: string): MultiremiRuntimeModelListRequest | null {
    return this.modelListQueue.get(runtimeId, requestId);
  }

  claimRuntimeModelListRequest(runtimeId: string): MultiremiRuntimeModelListRequest | null {
    return this.modelListQueue.claim(runtimeId);
  }

  reportRuntimeModelListResult(runtimeId: string, requestId: string, input: ReportRuntimeModelListInput): MultiremiRuntimeModelListRequest {
    const current = this.getRuntimeModelListRequest(runtimeId, requestId);
    if (!current) throw new Error("request not found");
    if (isTerminalRuntimeRequestStatus(current.status)) return current;
    const status = normalizeRuntimeModelListStatus(input.status);
    const now = nowIso();
    if (status === "completed") {
      this.withRuntimeLifecycleLock(runtimeId, (runtime) => {
        const models = normalizeRuntimeModels(input.models ?? [], runtime.provider);
        this.replaceRuntimeModelsWithinTransaction(runtimeId, models, runtime.provider, now);
        this.ctx.db.run(
          `UPDATE multiremi_runtime_model_list_requests
           SET status = 'completed', models = ?, supported = ?, error = NULL, updated_at = ?
           WHERE id = ?`,
          [toJson(models), input.supported === false ? 0 : 1, now, requestId],
        );
      });
    } else {
      this.ctx.db.run(
        `UPDATE multiremi_runtime_model_list_requests
         SET status = 'failed', error = ?, updated_at = ?
         WHERE id = ?`,
        [input.error ?? "runtime model list failed", now, requestId],
      );
    }
    return this.getRuntimeModelListRequest(runtimeId, requestId)!;
  }

  createRuntimeDirectoryScanRequest(runtimeId: string, params: { root?: string; maxDepth?: number; mode?: "scan" | "browse" } = {}): MultiremiRuntimeDirectoryScanRequest {
    return this.withRuntimeLifecycleLock(runtimeId, (runtime) => {
      this.assertRuntimeOnline(runtime);
      const normalizedParams = normalizeRuntimeDirectoryScanParams(params);
      const id = this.directoryScanQueue.nextId();
      const now = nowIso();
      this.ctx.db.run(
        `INSERT INTO multiremi_runtime_directory_scan_requests (
          id, runtime_id, status, params, candidates, supported, created_at, updated_at
        ) VALUES (?, ?, 'pending', ?, '[]', 1, ?, ?)`,
        [id, runtimeId, toJson(normalizedParams), now, now],
      );
      return this.getRuntimeDirectoryScanRequest(runtimeId, id)!;
    });
  }

  getRuntimeDirectoryScanRequest(runtimeId: string, requestId: string): MultiremiRuntimeDirectoryScanRequest | null {
    return this.directoryScanQueue.get(runtimeId, requestId);
  }

  claimRuntimeDirectoryScanRequest(runtimeId: string): MultiremiRuntimeDirectoryScanRequest | null {
    return this.directoryScanQueue.claim(runtimeId);
  }

  reportRuntimeDirectoryScanResult(runtimeId: string, requestId: string, input: ReportRuntimeDirectoryScanInput): MultiremiRuntimeDirectoryScanRequest {
    const current = this.getRuntimeDirectoryScanRequest(runtimeId, requestId);
    if (!current) throw new Error("request not found");
    if (isTerminalRuntimeRequestStatus(current.status)) return current;
    const status = normalizeRuntimeDirectoryScanStatus(input.status);
    const now = nowIso();
    if (status === "completed") {
      // Browse mode echoes the expanded absolute root back; merge it into the
      // request params so the folder-picker can render/ascend on empty listings.
      const resolvedRoot = typeof input.resolvedRoot === "string" && input.resolvedRoot.trim() ? input.resolvedRoot.trim() : null;
      const params = resolvedRoot ? { ...current.params, resolvedRoot } : current.params;
      this.ctx.db.run(
        `UPDATE multiremi_runtime_directory_scan_requests
         SET status = 'completed', params = ?, candidates = ?, supported = ?, error = NULL, updated_at = ?
         WHERE id = ?`,
        [toJson(params), toJson(normalizeRuntimeDirectoryCandidates(input.candidates ?? [])), input.supported === false ? 0 : 1, now, requestId],
      );
    } else {
      this.ctx.db.run(
        `UPDATE multiremi_runtime_directory_scan_requests
         SET status = 'failed', error = ?, updated_at = ?
         WHERE id = ?`,
        [input.error ?? "runtime directory scan failed", now, requestId],
      );
    }
    return this.getRuntimeDirectoryScanRequest(runtimeId, requestId)!;
  }

  createRuntimeUpdateRequest(runtimeId: string, input: CreateRuntimeUpdateInput): MultiremiRuntimeUpdateRequest {
    return this.withRuntimeLifecycleLock(runtimeId, (runtime) => {
      this.assertRuntimeOnline(runtime);
      const scope = input.scope === "acp" || input.scope === "agent" ? input.scope : "cli";
      // ACP/agent updates always pull @latest, so no target version is required.
      const targetVersion = String(input.targetVersion ?? input.target_version ?? "").trim() || (scope !== "cli" ? "latest" : "");
      if (!targetVersion) throw new Error("target_version is required");
      const active = this.ctx.db.query(
        `SELECT id FROM multiremi_runtime_update_requests
         WHERE runtime_id = ? AND status IN ('pending', 'running')
         LIMIT 1`,
      ).get(runtimeId) as Row | null;
      if (active) throw new Error("an update is already in progress for this runtime");
      const id = this.updateQueue.nextId();
      const now = nowIso();
      this.ctx.db.run(
        `INSERT INTO multiremi_runtime_update_requests (
          id, runtime_id, status, scope, target_version, created_at, updated_at
        ) VALUES (?, ?, 'pending', ?, ?, ?, ?)`,
        [id, runtimeId, scope, targetVersion, now, now],
      );
      return this.getRuntimeUpdateRequest(runtimeId, id)!;
    });
  }

  getRuntimeUpdateRequest(runtimeId: string, requestId: string): MultiremiRuntimeUpdateRequest | null {
    return this.updateQueue.get(runtimeId, requestId);
  }

  claimRuntimeUpdateRequest(runtimeId: string): MultiremiRuntimeUpdateRequest | null {
    return this.updateQueue.claim(runtimeId);
  }

  reportRuntimeUpdateResult(runtimeId: string, requestId: string, input: ReportRuntimeUpdateInput): MultiremiRuntimeUpdateRequest {
    const current = this.getRuntimeUpdateRequest(runtimeId, requestId);
    if (!current) throw new Error("update not found");
    const status = normalizeRuntimeUpdateStatus(input.status);
    const now = nowIso();
    if (isTerminalRuntimeRequestStatus(current.status)) return current;
    if (status === "completed") {
      this.ctx.db.run(
        "UPDATE multiremi_runtime_update_requests SET status = 'completed', output = ?, error = NULL, updated_at = ? WHERE id = ?",
        [input.output ?? "", now, requestId],
      );
    } else if (status === "running") {
      this.ctx.db.run(
        "UPDATE multiremi_runtime_update_requests SET status = 'running', updated_at = ? WHERE id = ?",
        [now, requestId],
      );
    } else {
      this.ctx.db.run(
        "UPDATE multiremi_runtime_update_requests SET status = 'failed', error = ?, updated_at = ? WHERE id = ?",
        [input.error ?? "runtime update failed", now, requestId],
      );
    }
    return this.getRuntimeUpdateRequest(runtimeId, requestId)!;
  }

  createRuntimeLocalSkillListRequest(runtimeId: string): MultiremiRuntimeLocalSkillListRequest {
    return this.withRuntimeLifecycleLock(runtimeId, (runtime) => {
      this.assertRuntimeOnline(runtime);
      const id = this.localSkillListQueue.nextId();
      const now = nowIso();
      this.ctx.db.run(
        `INSERT INTO multiremi_runtime_local_skill_list_requests (
          id, runtime_id, status, skills, supported, created_at, updated_at
        ) VALUES (?, ?, 'pending', '[]', 1, ?, ?)`,
        [id, runtimeId, now, now],
      );
      return this.getRuntimeLocalSkillListRequest(runtimeId, id)!;
    });
  }

  getRuntimeLocalSkillListRequest(runtimeId: string, requestId: string): MultiremiRuntimeLocalSkillListRequest | null {
    return this.localSkillListQueue.get(runtimeId, requestId);
  }

  claimRuntimeLocalSkillListRequest(runtimeId: string): MultiremiRuntimeLocalSkillListRequest | null {
    return this.localSkillListQueue.claim(runtimeId);
  }

  reportRuntimeLocalSkillListResult(runtimeId: string, requestId: string, input: ReportRuntimeLocalSkillListInput): MultiremiRuntimeLocalSkillListRequest {
    const current = this.getRuntimeLocalSkillListRequest(runtimeId, requestId);
    if (!current) throw new Error("request not found");
    if (isTerminalRuntimeRequestStatus(current.status)) return current;
    const status = normalizeRuntimeLocalSkillStatus(input.status);
    const now = nowIso();
    if (status === "completed") {
      this.ctx.db.run(
        `UPDATE multiremi_runtime_local_skill_list_requests
         SET status = 'completed', skills = ?, supported = ?, error = NULL, updated_at = ?
         WHERE id = ?`,
        [toJson(normalizeRuntimeLocalSkillSummaries(input.skills ?? [])), input.supported === false ? 0 : 1, now, requestId],
      );
    } else {
      this.ctx.db.run(
        `UPDATE multiremi_runtime_local_skill_list_requests
         SET status = 'failed', error = ?, updated_at = ?
         WHERE id = ?`,
        [input.error ?? "runtime local skill list failed", now, requestId],
      );
    }
    return this.getRuntimeLocalSkillListRequest(runtimeId, requestId)!;
  }

  createRuntimeLocalSkillImportRequest(runtimeId: string, input: CreateRuntimeLocalSkillImportInput): MultiremiRuntimeLocalSkillImportRequest {
    return this.withRuntimeLifecycleLock(runtimeId, (runtime) => {
      this.assertRuntimeOnline(runtime);
      const skillKey = String(input.skillKey ?? input.skill_key ?? "").trim();
      if (!skillKey) throw new Error("skill_key is required");
      const id = this.localSkillImportQueue.nextId();
      const now = nowIso();
      this.ctx.db.run(
        `INSERT INTO multiremi_runtime_local_skill_import_requests (
          id, runtime_id, skill_key, name, description, status, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        [
          id,
          runtimeId,
          skillKey,
          cleanOptionalLocalSkillString(input.name),
          cleanOptionalLocalSkillString(input.description),
          input.createdBy ?? input.created_by ?? null,
          now,
          now,
        ],
      );
      return this.getRuntimeLocalSkillImportRequest(runtimeId, id)!;
    });
  }

  getRuntimeLocalSkillImportRequest(runtimeId: string, requestId: string): MultiremiRuntimeLocalSkillImportRequest | null {
    // The only family with a second hydration pass — the imported skill is stored in another table.
    const request = this.localSkillImportQueue.get(runtimeId, requestId);
    return request ? this.hydrateRuntimeLocalSkillImportRequest(request) : null;
  }

  claimRuntimeLocalSkillImportRequests(runtimeId: string, limit = 10): MultiremiRuntimeLocalSkillImportRequest[] {
    const ids = this.localSkillImportQueue.claimBatchIds(runtimeId, limit);
    return ids.map((id) => this.getRuntimeLocalSkillImportRequest(runtimeId, id)!).filter(Boolean);
  }

  reportRuntimeLocalSkillImportResult(runtimeId: string, requestId: string, input: ReportRuntimeLocalSkillImportInput): MultiremiRuntimeLocalSkillImportRequest {
    const current = this.getRuntimeLocalSkillImportRequest(runtimeId, requestId);
    if (!current) throw new Error("request not found");
    if (isTerminalRuntimeRequestStatus(current.status)) return current;
    const status = normalizeRuntimeLocalSkillStatus(input.status);
    const now = nowIso();
    if (status !== "completed") {
      this.ctx.db.run(
        "UPDATE multiremi_runtime_local_skill_import_requests SET status = 'failed', error = ?, updated_at = ? WHERE id = ?",
        [input.error ?? "runtime local skill import failed", now, requestId],
      );
      return this.getRuntimeLocalSkillImportRequest(runtimeId, requestId)!;
    }
    if (!input.skill) {
      this.ctx.db.run(
        "UPDATE multiremi_runtime_local_skill_import_requests SET status = 'failed', error = ?, updated_at = ? WHERE id = ?",
        ["daemon returned an empty skill bundle", now, requestId],
      );
      return this.getRuntimeLocalSkillImportRequest(runtimeId, requestId)!;
    }
    return this.withRuntimeLifecycleLock(runtimeId, (runtime) => {
      const lockedRequest = this.getRuntimeLocalSkillImportRequest(runtimeId, requestId);
      if (!lockedRequest) throw new Error("request not found");
      if (isTerminalRuntimeRequestStatus(lockedRequest.status)) return lockedRequest;
      const skillName = cleanOptionalLocalSkillString(lockedRequest.name)
        ?? String(input.skill!.name ?? lockedRequest.skillKey).trim();
      const description = cleanOptionalLocalSkillString(lockedRequest.description) ?? String(input.skill!.description ?? "");
      const skill = this.ctx.agents().createSkillWithinTransaction({
        workspaceId: runtime.workspaceId ?? "local",
        name: skillName,
        description,
        content: input.skill!.content ?? "",
        createdBy: lockedRequest.createdBy,
        files: input.skill!.files ?? [],
        config: {
          origin: {
            type: "runtime_local",
            runtime_id: runtimeId,
            provider: input.skill!.provider ?? runtime.provider,
            source_path: input.skill!.sourcePath ?? input.skill!.source_path ?? "",
          },
        },
      });
      const skillId = skill.id ?? "";
      this.ctx.db.run(
        `UPDATE multiremi_runtime_local_skill_import_requests
         SET status = 'completed', skill_id = ?, skill = ?, error = NULL, updated_at = ?
         WHERE id = ? AND runtime_id = ?`,
        [skillId, toJson(skill), now, requestId, runtimeId],
      );
      return this.getRuntimeLocalSkillImportRequest(runtimeId, requestId)!;
    });
  }

  createRuntimeCommandRequest(runtimeId: string, input: CreateRuntimeCommandInput): MultiremiRuntimeCommandRequest {
    return this.withRuntimeLifecycleLock(runtimeId, (runtime) => {
      this.assertRuntimeOnline(runtime);
      const command = String(input.command ?? "").trim();
      if (!command) throw new Error("command is required");
      if (Buffer.byteLength(command, "utf8") > 16 * 1024) throw new Error("command must not exceed 16384 bytes");
      if (!Array.isArray(input.args) || input.args.some((arg) => typeof arg !== "string")) {
        if (input.args !== undefined) throw new Error("args must be an array of strings");
      }
      const args = input.args ?? [];
      if (args.length > 100) throw new Error("args must not contain more than 100 entries");
      if (args.some((arg) => Buffer.byteLength(arg, "utf8") > 8 * 1024)) {
        throw new Error("each command arg must not exceed 8192 bytes");
      }
      const timeoutMaximum = input.provisionKind === "npm-global"
        ? MAX_NPM_GLOBAL_PROVISION_TIMEOUT_MS
        : MAX_RUNTIME_COMMAND_TIMEOUT_MS;
      const timeoutMs = normalizeRuntimeCommandTimeout(input.timeoutMs ?? input.timeout_ms, timeoutMaximum);
      const provisionId = cleanOptionalString(input.provisionId ?? input.provision_id);
      const id = this.commandQueue.nextId();
      const now = nowIso();
      // Raw values are retained only for daemon dispatch; API and audit views use the redacted pair.
      this.ctx.db.run(
        `INSERT INTO multiremi_runtime_command_requests (
          id, runtime_id, command, args, redacted_command, redacted_args, provision_id, timeout_ms,
          created_by, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        [
          id,
          runtimeId,
          command,
          toJson(args),
          redactRuntimeCommandText(command),
          toJson(redactRuntimeCommandArgs(args)),
          provisionId,
          timeoutMs,
          input.createdBy ?? input.created_by ?? null,
          now,
          now,
        ],
      );
      return this.getRuntimeCommandRequest(runtimeId, id)!;
    });
  }

  getRuntimeCommandRequest(runtimeId: string, requestId: string): MultiremiRuntimeCommandRequest | null {
    const request = this.commandQueue.get(runtimeId, requestId);
    if (!request || !isTerminalRuntimeRequestStatus(request.status)) return request;
    if (request.command || request.args.length) {
      this.ctx.db.run(
        "UPDATE multiremi_runtime_command_requests SET command = '', args = '[]' WHERE id = ? AND runtime_id = ?",
        [requestId, runtimeId],
      );
      return { ...request, command: "", args: [] };
    }
    return request;
  }

  claimRuntimeCommandRequest(runtimeId: string): MultiremiRuntimeCommandRequest | null {
    const request = this.commandQueue.claim(runtimeId);
    this.ctx.db.run(
      `UPDATE multiremi_runtime_command_requests
       SET command = '', args = '[]'
       WHERE runtime_id = ? AND status IN ('completed', 'failed', 'timeout') AND (command <> '' OR args <> '[]')`,
      [runtimeId],
    );
    return request;
  }

  reportRuntimeCommandResult(
    runtimeId: string,
    requestId: string,
    input: ReportRuntimeCommandInput,
  ): MultiremiRuntimeCommandRequest {
    const current = this.getRuntimeCommandRequest(runtimeId, requestId);
    if (!current) throw new Error("request not found");
    if (isTerminalRuntimeRequestStatus(current.status)) return current;
    const status = normalizeRuntimeCommandReportStatus(input.status);
    const now = nowIso();
    const stdout = normalizeRuntimeCommandOutput(input.stdout);
    const stderr = normalizeRuntimeCommandOutput(input.stderr);
    const error = input.error == null
      ? null
      : truncateRuntimeCommandOutput(redactRuntimeCommandText(String(input.error)), 16 * 1024);
    const exitCodeInput = input.exitCode ?? input.exit_code;
    const exitCode = Number.isSafeInteger(exitCodeInput) ? Number(exitCodeInput) : null;
    const durationInput = input.durationMs ?? input.duration_ms;
    const durationMs = Number.isSafeInteger(durationInput) && Number(durationInput) >= 0
      ? Number(durationInput)
      : null;
    this.ctx.db.run(
      `UPDATE multiremi_runtime_command_requests
       SET status = ?, exit_code = ?, stdout = ?, stderr = ?, duration_ms = ?, error = ?,
           command = '', args = '[]', updated_at = ?
       WHERE id = ? AND runtime_id = ?`,
      [
        status,
        status === "completed" ? exitCode : null,
        stdout,
        stderr,
        durationMs,
        status === "completed" ? null : error ?? (status === "timeout" ? "command timed out" : "command failed to start"),
        now,
        requestId,
        runtimeId,
      ],
    );
    return this.getRuntimeCommandRequest(runtimeId, requestId)!;
  }

  createBotMenuPublishRequest(
    runtimeId: string,
    input: CreateBotMenuPublishRequestInput,
  ): MultiremiBotMenuPublishRequest {
    return this.withRuntimeLifecycleLock(runtimeId, (runtime) => {
      this.assertRuntimeOnline(runtime);
      if ((runtime.workspaceId ?? "local") !== input.workspaceId) {
        throw new Error("runtime does not belong to the bot menu workspace");
      }
      if (runtime.metadata.feishu_bot_menu !== true) {
        throw new Error("runtime does not host the Feishu bot menu publisher");
      }
      const id = this.botMenuPublishQueue.nextId();
      const now = nowIso();
      this.ctx.db.run(
        `INSERT INTO multiremi_bot_menu_publish_requests (
          id, runtime_id, workspace_id, config, dry_run, status, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        [id, runtimeId, input.workspaceId, toJson(input.config), input.dryRun ? 1 : 0, input.createdBy ?? null, now, now],
      );
      return this.getBotMenuPublishRequest(runtimeId, id)!;
    });
  }

  getBotMenuPublishRequest(runtimeId: string, requestId: string): MultiremiBotMenuPublishRequest | null {
    const request = this.botMenuPublishQueue.get(runtimeId, requestId);
    if (!request || !isTerminalRuntimeRequestStatus(request.status) || !Object.keys(request.config).length) return request;
    this.ctx.db.run(
      "UPDATE multiremi_bot_menu_publish_requests SET config = '{}' WHERE id = ? AND runtime_id = ?",
      [requestId, runtimeId],
    );
    return { ...request, config: {} };
  }

  findBotMenuPublishRequest(workspaceId: string, requestId: string): MultiremiBotMenuPublishRequest | null {
    const row = this.ctx.db.query(
      "SELECT runtime_id FROM multiremi_bot_menu_publish_requests WHERE id = ? AND workspace_id = ?",
    ).get(requestId, workspaceId) as { runtime_id: string } | null;
    return row ? this.getBotMenuPublishRequest(row.runtime_id, requestId) : null;
  }

  claimBotMenuPublishRequest(runtimeId: string): MultiremiBotMenuPublishRequest | null {
    return this.botMenuPublishQueue.claim(runtimeId);
  }

  reportBotMenuPublishResult(
    runtimeId: string,
    requestId: string,
    input: ReportBotMenuPublishInput,
  ): MultiremiBotMenuPublishRequest {
    const current = this.getBotMenuPublishRequest(runtimeId, requestId);
    if (!current) throw new Error("request not found");
    if (isTerminalRuntimeRequestStatus(current.status)) return current;
    const now = nowIso();
    const status = input.status === "completed" ? "completed" : "failed";
    this.ctx.db.run(
      `UPDATE multiremi_bot_menu_publish_requests
       SET status = ?, result = ?, error = ?, config = '{}', updated_at = ?
       WHERE id = ? AND runtime_id = ?`,
      [
        status,
        status === "completed" ? toJson(input.result ?? null) : null,
        status === "completed" ? null : cleanOptionalString(input.error) ?? "bot menu publish failed",
        now,
        requestId,
        runtimeId,
      ],
    );
    return this.getBotMenuPublishRequest(runtimeId, requestId)!;
  }

  heartbeatRuntime(runtimeId: string, options: {
    claimPending?: boolean;
    supportsBatchImport?: boolean;
    supportsDirectoryScan?: boolean;
    agentPluginProtocol?: number;
    supportsBotMenu?: boolean;
    supportsFeishuBotConfig?: boolean;
  } = {}): MultiremiDaemonHeartbeatAck {
    const initialRuntime = this.getRuntime(runtimeId);
    if (!initialRuntime) {
      return { runtime_id: runtimeId, status: "runtime_gone", runtime_gone: true };
    }
    let runtime = initialRuntime;
    // Capability flags a daemon re-advertises on every heartbeat. Collected once
    // so the three metadata-writing branches below stay in step.
    const metadataPatch: Record<string, unknown> = {};
    if (options.supportsBotMenu !== undefined) metadataPatch.feishu_bot_menu = options.supportsBotMenu;
    if (options.supportsFeishuBotConfig !== undefined) {
      metadataPatch[FEISHU_CONCIERGE_CONFIG_CAPABILITY] = options.supportsFeishuBotConfig;
    }
    const hasMetadataPatch = Object.keys(metadataPatch).length > 0;
    let previousAgentPluginProtocol = readAgentPluginProtocol(runtime.metadata);
    let agentPluginProtocol = previousAgentPluginProtocol;
    let pluginStateChanges: MultiremiAgentPluginRuntimeState[] = [];
    if (options.agentPluginProtocol !== undefined) {
      const workspaceId = runtime.workspaceId ?? "local";
      const result = this.ctx.db.transaction(() => {
        this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
        this.ctx.agentPlugins().lockAgentPluginWorkspace(workspaceId);
        const lockedRuntime = this.getRuntime(runtimeId);
        if (!lockedRuntime || (lockedRuntime.workspaceId ?? "local") !== workspaceId) return null;
        const previous = readAgentPluginProtocol(lockedRuntime.metadata);
        const protocol = normalizeAgentPluginProtocol(options.agentPluginProtocol);
        const now = nowIso();
        this.ctx.db.run(
          "UPDATE multiremi_runtimes SET status = 'online', metadata = ?, last_heartbeat_at = ?, updated_at = ? WHERE id = ?",
          [toJson({ ...lockedRuntime.metadata, agent_plugin_protocol: protocol, ...metadataPatch }), now, now, runtimeId],
        );
        const updatedRuntime = this.getRuntime(runtimeId)!;
        const changes = this.ctx.agentPlugins().recordAgentPluginRuntimeHeartbeatWithinLock(runtimeId);
        return { runtime: updatedRuntime, previous, protocol, changes };
      })();
      if (!result) return { runtime_id: runtimeId, status: "runtime_gone", runtime_gone: true };
      runtime = result.runtime;
      previousAgentPluginProtocol = result.previous;
      agentPluginProtocol = result.protocol;
      pluginStateChanges = result.changes;
      for (const state of pluginStateChanges) {
        this.ctx.emitWorkspaceEvent({
          type: "agent_plugin:runtime_state",
          workspaceId: state.workspaceId,
          actorType: "daemon",
          actorId: runtime.daemonId ?? runtime.id,
          payload: {
            state: {
              id: state.id,
              runtime_id: state.runtimeId,
              plugin_id: state.pluginId,
              version_id: state.pluginVersionId,
              desired: state.desired,
              desired_reason: state.desiredReason,
              status: state.status,
              last_error_code: state.lastErrorCode,
              last_error: state.lastError,
              updated_at: state.updatedAt,
            },
          },
        });
      }
      if (previousAgentPluginProtocol !== agentPluginProtocol) {
        this.ctx.emitWorkspaceEvent({
          type: "agent_plugin:runtime_capability",
          workspaceId: runtime.workspaceId ?? "local",
          actorType: "daemon",
          actorId: runtime.daemonId ?? runtime.id,
          payload: {
            runtime_id: runtime.id,
            daemon_id: runtime.daemonId,
            previous_agent_plugin_protocol: previousAgentPluginProtocol,
            agent_plugin_protocol: agentPluginProtocol,
            supported: (agentPluginProtocol ?? 0) >= MULTIREMI_AGENT_PLUGIN_PROTOCOL_VERSION,
          },
        });
      }
    } else if (hasMetadataPatch) {
      const now = nowIso();
      this.ctx.db.run(
        "UPDATE multiremi_runtimes SET status = 'online', metadata = ?, last_heartbeat_at = ?, updated_at = ? WHERE id = ?",
        [toJson({ ...runtime.metadata, ...metadataPatch }), now, now, runtimeId],
      );
      runtime = this.getRuntime(runtimeId)!;
    } else {
      const now = nowIso();
      this.ctx.db.run(
        "UPDATE multiremi_runtimes SET status = 'online', last_heartbeat_at = ?, updated_at = ? WHERE id = ?",
        [now, now, runtimeId],
      );
    }
    const ack: MultiremiDaemonHeartbeatAck = { runtime_id: runtimeId, status: "ok" };
    if (options.claimPending === false) return ack;

    const pendingUpdate = this.claimRuntimeUpdateRequest(runtimeId);
    if (pendingUpdate) {
      ack.pending_update = {
        id: pendingUpdate.id,
        target_version: pendingUpdate.targetVersion,
        scope: pendingUpdate.scope,
      };
    }
    const pendingModelList = this.claimRuntimeModelListRequest(runtimeId);
    if (pendingModelList) {
      ack.pending_model_list = { id: pendingModelList.id };
    }
    const pendingCommand = this.claimRuntimeCommandRequest(runtimeId);
    if (pendingCommand) {
      ack.pending_command = {
        id: pendingCommand.id,
        command: pendingCommand.command,
        args: pendingCommand.args,
        timeout_ms: pendingCommand.timeoutMs,
      };
    }
    if (options.supportsBotMenu) {
      const pendingBotMenu = this.claimBotMenuPublishRequest(runtimeId);
      if (pendingBotMenu) {
        ack.pending_bot_menu = {
          id: pendingBotMenu.id,
          config: pendingBotMenu.config,
          dry_run: pendingBotMenu.dryRun,
        };
      }
    }
    const pendingLocalSkills = this.claimRuntimeLocalSkillListRequest(runtimeId);
    if (pendingLocalSkills) {
      ack.pending_local_skills = { id: pendingLocalSkills.id };
    }
    if (options.supportsDirectoryScan) {
      const pendingDirectoryScan = this.claimRuntimeDirectoryScanRequest(runtimeId);
      if (pendingDirectoryScan) {
        ack.pending_directory_scan = {
          id: pendingDirectoryScan.id,
          root: pendingDirectoryScan.params.root,
          max_depth: pendingDirectoryScan.params.maxDepth,
          mode: pendingDirectoryScan.params.mode,
        };
      }
    }
    const importLimit = options.supportsBatchImport ? 10 : 1;
    const pendingImports = this.claimRuntimeLocalSkillImportRequests(runtimeId, importLimit);
    if (pendingImports.length > 0) {
      ack.pending_local_skill_import = {
        id: pendingImports[0].id,
        skill_key: pendingImports[0].skillKey,
      };
      if (options.supportsBatchImport) {
        ack.pending_local_skill_imports = pendingImports.map((request) => ({
          id: request.id,
          skill_key: request.skillKey,
        }));
      }
    }
    return ack;
  }

  /**
   * May this runtime execute this agent? A claim hands the runtime the agent's
   * custom_env / mcp_config, so a private runtime is restricted to its owner's
   * agents. Mirrors the claim SQL's ownership predicate (COALESCE(...,'local')
   * so single-machine NULL owners still pair). The provider must also match.
   */
  runtimeCanRunAgent(runtime: MultiremiRuntime, agent: MultiremiAgent): boolean {
    if (runtime.provider !== "any" && runtime.provider !== agent.provider) return false;
    // A task runs in its agent's workspace and the claim SQL requires the
    // runtime's workspace to match, so a runtime in a different workspace can
    // never run this agent (COALESCE(...,'local') for NULL-workspace runtimes).
    if ((runtime.workspaceId ?? "local") !== (agent.workspaceId ?? "local")) return false;
    if (runtime.visibility === "public") return true;
    return (runtime.ownerId ?? "local") === (agent.ownerId ?? "local");
  }

  getRuntimeByDaemonAndProvider(daemonId: string, provider: string): MultiremiRuntime | null {
    const rows = this.ctx.db
      .query(
        `SELECT runtime.*, profile.display_name AS daemon_display_name
         FROM multiremi_runtimes runtime
         LEFT JOIN multiremi_daemon_profiles profile
           ON profile.workspace_id = COALESCE(runtime.workspace_id, 'local')
          AND profile.daemon_id = runtime.daemon_id
         WHERE (runtime.daemon_id = ? OR runtime.legacy_daemon_id = ? OR runtime.id = ?)
           AND (runtime.provider = ? OR runtime.provider = 'any')`,
      )
      .all(daemonId, daemonId, daemonId, provider) as Row[];
    const runtimes = rows.map((row) => withRuntimeLiveness(this.hydrateRuntime(toRuntime(row))));
    return runtimes.find((runtime) => runtime.status === "online") ?? runtimes[0] ?? null;
  }

  private hydrateRuntime(runtime: MultiremiRuntime): MultiremiRuntime {
    const stats = this.runtimeUsageSummary(runtime.id);
    return {
      ...runtime,
      ...stats,
      models: this.listRuntimeModelsForExistingRuntime(runtime.id),
    };
  }

  private assertRuntimeOnline(runtime: MultiremiRuntime): void {
    if (runtime.status !== "online") throw new Error("runtime is offline");
  }

  /**
   * Serialize every new Runtime-owned row with daemon retirement. The initial
   * read only finds the workspace row to lock; the Runtime is authoritative
   * only after that lock has been acquired and must still belong to it.
   */
  private withRuntimeLifecycleLock<T>(runtimeId: string, callback: (runtime: MultiremiRuntime) => T): T {
    const initial = this.getRuntime(runtimeId);
    if (!initial) throw new Error(`Runtime not found: ${runtimeId}`);
    const workspaceId = initial.workspaceId ?? "local";
    return this.ctx.db.transaction(() => {
      this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
      const runtime = this.getRuntime(runtimeId);
      if (!runtime || (runtime.workspaceId ?? "local") !== workspaceId) {
        throw new Error(`Runtime not found: ${runtimeId}`);
      }
      return callback(runtime);
    })();
  }

  private hydrateRuntimeLocalSkillImportRequest(request: MultiremiRuntimeLocalSkillImportRequest): MultiremiRuntimeLocalSkillImportRequest {
    return {
      ...request,
      skill: request.skill ?? (request.skillId ? this.ctx.agents().getSkill(request.skillId) : null),
    };
  }

  private listRuntimeModelsForExistingRuntime(runtimeId: string): MultiremiRuntimeModel[] {
    const rows = this.ctx.db.query("SELECT * FROM multiremi_runtime_models WHERE runtime_id = ? ORDER BY is_default DESC, label ASC").all(runtimeId) as Row[];
    return rows.map(toRuntimeModel);
  }

  /** Caller already owns the transaction that protects this Runtime mutation. */
  private replaceRuntimeModelsWithinTransaction(
    runtimeId: string,
    models: MultiremiRuntimeModel[],
    provider: string,
    now = nowIso(),
  ): void {
    const normalized = normalizeRuntimeModels(models, provider);
    this.ctx.db.run("DELETE FROM multiremi_runtime_models WHERE runtime_id = ?", [runtimeId]);
    for (const model of normalized) {
      this.ctx.db.run(
        `INSERT INTO multiremi_runtime_models (
          runtime_id, model_id, label, provider, is_default, thinking, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          runtimeId,
          model.id,
          model.label,
          model.provider,
          model.default ? 1 : 0,
          model.thinking ? toJson(model.thinking) : null,
          now,
          now,
        ],
      );
    }
  }

  private runtimeUsageSummary(runtimeId: string): Pick<MultiremiRuntime,
    "taskCount" |
    "activeTaskCount" |
    "completedTaskCount" |
    "failedTaskCount" |
    "inputTokens" |
    "outputTokens" |
    "cacheReadTokens" |
    "cacheWriteTokens"
  > {
    const rows = this.ctx.db.query(
      "SELECT id, status, usage FROM multiremi_tasks WHERE runtime_id = ?",
    ).all(runtimeId) as Row[];
    const stats = {
      taskCount: rows.length,
      activeTaskCount: 0,
      completedTaskCount: 0,
      failedTaskCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    for (const row of rows) {
      const status = String(row.status ?? "") as MultiremiTaskStatus;
      if (isInFlightTaskStatus(status)) stats.activeTaskCount += 1;
      if (status === "completed") stats.completedTaskCount += 1;
      if (status === "failed") stats.failedTaskCount += 1;
      for (const entry of parseTaskUsageEntries(row.usage)) {
        stats.inputTokens += entry.inputTokens;
        stats.outputTokens += entry.outputTokens;
        stats.cacheReadTokens += entry.cacheReadTokens;
        stats.cacheWriteTokens += entry.cacheWriteTokens;
      }
    }
    return stats;
  }
}

function normalizeAgentPluginProtocol(value: unknown): number {
  const protocol = Number(value);
  return Number.isSafeInteger(protocol) && protocol >= 0 ? protocol : 0;
}

function readAgentPluginProtocol(metadata: Record<string, unknown>): number | null {
  if (!("agent_plugin_protocol" in metadata || "agentPluginProtocol" in metadata)) return null;
  return normalizeAgentPluginProtocol(metadata.agent_plugin_protocol ?? metadata.agentPluginProtocol);
}

function normalizeRuntimeVisibility(value: string | undefined): MultiremiRuntimeVisibility {
  const visibility = String(value ?? "private").trim().toLowerCase();
  if (visibility === "private" || visibility === "public") return visibility;
  throw new Error("visibility must be private or public");
}

function normalizeRuntimeMetadata(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (!isRecord(value)) throw new Error("metadata must be an object");
  const normalized = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  if (!isRecord(normalized)) throw new Error("metadata must be an object");
  if (Buffer.byteLength(toJson(normalized), "utf8") > 8 * 1024) {
    throw new Error("metadata exceeds the 8KB size limit");
  }
  return normalized;
}

function preserveRuntimeMergeAudit(
  current: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  if ("legacy_runtime_merges" in next) return next;
  const existing = current.legacy_runtime_merges;
  return Array.isArray(existing) ? { ...next, legacy_runtime_merges: existing } : next;
}

function withLegacyRuntimeMergeAudit(
  metadata: Record<string, unknown>,
  entry: {
    legacyDaemonId: string;
    oldRuntimeId: string;
    newRuntimeId: string;
    provider: string;
    agentsReassigned: number;
    tasksReassigned: number;
    mergedAt: string;
  },
): Record<string, unknown> {
  const existing = Array.isArray(metadata.legacy_runtime_merges)
    ? metadata.legacy_runtime_merges.filter(isRecord)
    : [];
  const nextEntry = {
    legacy_daemon_id: entry.legacyDaemonId,
    old_runtime_id: entry.oldRuntimeId,
    new_runtime_id: entry.newRuntimeId,
    provider: entry.provider,
    agents_reassigned: entry.agentsReassigned,
    tasks_reassigned: entry.tasksReassigned,
    merged_at: entry.mergedAt,
  };
  const audit = [...existing, nextEntry].slice(-25);
  let next = { ...metadata, legacy_runtime_merges: audit };
  while (Buffer.byteLength(toJson(next), "utf8") > 8 * 1024 && audit.length > 1) {
    audit.shift();
    next = { ...metadata, legacy_runtime_merges: audit };
  }
  return normalizeRuntimeMetadata(next);
}

function normalizeRuntimeModels(models: MultiremiRuntimeModel[], provider: string): MultiremiRuntimeModel[] {
  const seen = new Set<string>();
  return (models ?? []).map((model) => {
    const id = String(model.id ?? "").trim();
    if (!id) throw new Error("model id is required");
    if (seen.has(id)) throw new Error(`Duplicate runtime model: ${id}`);
    seen.add(id);
    return {
      id,
      label: String(model.label ?? id).trim() || id,
      provider: String(model.provider ?? provider ?? "").trim() || provider,
      default: Boolean(model.default),
      thinking: normalizeRuntimeModelThinking(model.thinking),
    };
  });
}

function normalizeRuntimeModelThinking(value: MultiremiRuntimeModel["thinking"]): MultiremiRuntimeModel["thinking"] | undefined {
  if (!value) return undefined;
  const supportedLevels = (value.supportedLevels ?? value.supported_levels ?? []).map((level) => ({
    value: String(level.value ?? "").trim(),
    label: String(level.label ?? level.value ?? "").trim(),
    ...(level.description ? { description: String(level.description) } : {}),
  })).filter((level) => level.value);
  if (!supportedLevels.length) return undefined;
  return {
    supportedLevels,
    ...(value.defaultLevel || value.default_level ? { defaultLevel: String(value.defaultLevel ?? value.default_level) } : {}),
  };
}

function toRuntime(row: Row): MultiremiRuntime {
  return {
    id: String(row.id),
    name: String(row.name),
    provider: String(row.provider),
    daemonId: nullableString(row.daemon_id),
    legacyDaemonId: nullableString(row.legacy_daemon_id),
    daemonDisplayName: nullableString(row.daemon_display_name),
    runtimeMode: String(row.runtime_mode ?? "local"),
    deviceInfo: String(row.device_info ?? ""),
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    workspaceId: nullableString(row.workspace_id),
    ownerId: nullableString(row.owner_id),
    visibility: normalizeRuntimeVisibility(String(row.visibility ?? "private")),
    status: String(row.status) as MultiremiRuntime["status"],
    maxConcurrency: Number(row.max_concurrency ?? 1),
    taskCount: 0,
    activeTaskCount: 0,
    completedTaskCount: 0,
    failedTaskCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    models: [],
    lastHeartbeatAt: nullableString(row.last_heartbeat_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toRuntimeLocalSkillListRequest(row: Row): MultiremiRuntimeLocalSkillListRequest {
  return {
    id: String(row.id),
    runtimeId: String(row.runtime_id),
    status: normalizeRuntimeLocalSkillStatus(row.status),
    skills: normalizeRuntimeLocalSkillSummaries(parseJson(row.skills, [])),
    supported: Number(row.supported ?? 1) !== 0,
    error: nullableString(row.error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    runStartedAt: nullableString(row.run_started_at),
  };
}

function toRuntimeLocalSkillImportRequest(row: Row): MultiremiRuntimeLocalSkillImportRequest {
  return {
    id: String(row.id),
    runtimeId: String(row.runtime_id),
    skillKey: String(row.skill_key),
    name: nullableString(row.name),
    description: nullableString(row.description),
    status: normalizeRuntimeLocalSkillStatus(row.status),
    skill: row.skill == null ? null : parseJson(row.skill, null),
    skillId: nullableString(row.skill_id),
    error: nullableString(row.error),
    createdBy: nullableString(row.created_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    runStartedAt: nullableString(row.run_started_at),
  };
}

function toRuntimeModelListRequest(row: Row): MultiremiRuntimeModelListRequest {
  return {
    id: String(row.id),
    runtimeId: String(row.runtime_id),
    status: normalizeRuntimeModelListStatus(row.status),
    models: parseJson(row.models, []),
    supported: Number(row.supported ?? 1) !== 0,
    error: nullableString(row.error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    runStartedAt: nullableString(row.run_started_at),
  };
}

function normalizeRuntimeModelListStatus(value: unknown): MultiremiRuntimeModelListRequestStatus {
  const status = String(value ?? "failed").trim();
  if (status === "pending" || status === "running" || status === "completed" || status === "failed" || status === "timeout") return status;
  return "failed";
}

function toRuntimeDirectoryScanRequest(row: Row): MultiremiRuntimeDirectoryScanRequest {
  return {
    id: String(row.id),
    runtimeId: String(row.runtime_id),
    status: normalizeRuntimeDirectoryScanStatus(row.status),
    params: normalizeRuntimeDirectoryScanParams(parseJson(row.params, {})),
    candidates: normalizeRuntimeDirectoryCandidates(parseJson(row.candidates, [])),
    supported: Number(row.supported ?? 1) !== 0,
    error: nullableString(row.error),
    runStartedAt: nullableString(row.run_started_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function normalizeRuntimeDirectoryScanStatus(value: unknown): MultiremiRuntimeDirectoryScanRequestStatus {
  const status = String(value ?? "failed").trim();
  if (status === "pending" || status === "running" || status === "completed" || status === "failed" || status === "timeout") return status;
  return "failed";
}

function normalizeRuntimeDirectoryScanParams(raw: unknown): MultiremiRuntimeDirectoryScanParams {
  if (!isRecord(raw)) return {};
  const params: MultiremiRuntimeDirectoryScanParams = {};
  const root = typeof raw.root === "string" ? raw.root.trim() : "";
  if (root) params.root = root;
  const maxDepth = Number(raw.maxDepth ?? raw.max_depth);
  if (Number.isFinite(maxDepth) && maxDepth > 0) params.maxDepth = Math.floor(maxDepth);
  const mode = normalizeRuntimeDirectoryScanMode(raw.mode);
  if (mode) params.mode = mode;
  const resolvedRoot = firstNonEmptyString(raw.resolvedRoot, raw.resolved_root);
  if (resolvedRoot) params.resolvedRoot = resolvedRoot;
  return params;
}

function normalizeRuntimeDirectoryScanMode(value: unknown): "scan" | "browse" | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "scan" || value === "browse") return value;
  throw new Error('directory scan mode must be "scan" or "browse"');
}

function normalizeRuntimeDirectoryCandidates(value: unknown): MultiremiRuntimeDirectoryCandidate[] {
  if (!Array.isArray(value)) return [];
  const candidates: MultiremiRuntimeDirectoryCandidate[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const path = typeof item.path === "string" ? item.path.trim() : "";
    if (!path) continue;
    const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : path;
    const remoteUrl = firstNonEmptyString(item.remoteUrl, item.remote_url);
    const currentBranch = firstNonEmptyString(item.currentBranch, item.current_branch);
    const isDirty = typeof item.isDirty === "boolean"
      ? item.isDirty
      : typeof item.is_dirty === "boolean" ? item.is_dirty : null;
    const candidate: MultiremiRuntimeDirectoryCandidate = { path, name, remoteUrl, currentBranch, isDirty };
    const isGitRepo = typeof item.isGitRepo === "boolean"
      ? item.isGitRepo
      : typeof item.is_git_repo === "boolean" ? item.is_git_repo : undefined;
    if (isGitRepo !== undefined) candidate.isGitRepo = isGitRepo;
    candidates.push(candidate);
  }
  return candidates;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function toRuntimeUpdateRequest(row: Row): MultiremiRuntimeUpdateRequest {
  const targetVersion = String(row.target_version ?? "");
  return {
    id: String(row.id),
    runtimeId: String(row.runtime_id),
    status: normalizeRuntimeUpdateStatus(row.status),
    scope: row.scope === "acp" || row.scope === "agent" ? row.scope : "cli",
    targetVersion,
    target_version: targetVersion,
    output: nullableString(row.output),
    error: nullableString(row.error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    runStartedAt: nullableString(row.run_started_at),
  };
}

function normalizeRuntimeUpdateStatus(value: unknown): MultiremiRuntimeUpdateRequestStatus {
  const status = String(value ?? "failed").trim();
  if (status === "pending" || status === "running" || status === "completed" || status === "failed" || status === "timeout") return status;
  return "failed";
}

function toRuntimeCommandRequest(row: Row): MultiremiRuntimeCommandRequest {
  return {
    id: String(row.id),
    runtimeId: String(row.runtime_id),
    command: String(row.command ?? ""),
    args: normalizeRuntimeCommandArgs(parseJson(row.args, [])),
    redactedCommand: String(row.redacted_command ?? ""),
    redactedArgs: normalizeRuntimeCommandArgs(parseJson(row.redacted_args, [])),
    provisionId: nullableString(row.provision_id),
    timeoutMs: Number(row.timeout_ms ?? DEFAULT_RUNTIME_COMMAND_TIMEOUT_MS),
    createdBy: nullableString(row.created_by),
    status: normalizeRuntimeCommandStatus(row.status),
    exitCode: row.exit_code == null ? null : Number(row.exit_code),
    stdout: nullableString(row.stdout),
    stderr: nullableString(row.stderr),
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    error: nullableString(row.error),
    runStartedAt: nullableString(row.run_started_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toBotMenuPublishRequest(row: Row): MultiremiBotMenuPublishRequest {
  return {
    id: String(row.id),
    runtimeId: String(row.runtime_id),
    workspaceId: String(row.workspace_id),
    config: parseJson(row.config, {}),
    dryRun: Number(row.dry_run ?? 1) !== 0,
    status: normalizeBotMenuPublishStatus(row.status),
    result: row.result == null ? null : parseJson(row.result, null),
    error: nullableString(row.error),
    createdBy: nullableString(row.created_by),
    runStartedAt: nullableString(row.run_started_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function normalizeBotMenuPublishStatus(value: unknown): MultiremiBotMenuPublishRequest["status"] {
  const status = String(value ?? "failed").trim();
  if (status === "pending" || status === "running" || status === "completed" || status === "failed" || status === "timeout") return status;
  return "failed";
}

function normalizeRuntimeCommandStatus(value: unknown): MultiremiRuntimeCommandRequestStatus {
  const status = String(value ?? "failed").trim();
  if (status === "pending" || status === "running" || status === "completed" || status === "failed" || status === "timeout") return status;
  return "failed";
}

function normalizeRuntimeCommandReportStatus(value: unknown): "completed" | "failed" | "timeout" {
  if (value === "completed" || value === "failed" || value === "timeout") return value;
  throw new Error(`invalid runtime command status: ${String(value ?? "")}`);
}

function normalizeRuntimeCommandArgs(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((arg): arg is string => typeof arg === "string") : [];
}

function normalizeRuntimeCommandOutput(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  return truncateRuntimeCommandOutput(redactRuntimeCommandText(String(value)));
}

function normalizeRuntimeLocalSkillStatus(value: unknown): MultiremiRuntimeLocalSkillRequestStatus {
  const status = String(value ?? "failed").trim();
  if (status === "pending" || status === "running" || status === "completed" || status === "failed" || status === "timeout") return status;
  return "failed";
}

function isTerminalRuntimeRequestStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "timeout";
}

function normalizeRuntimeLocalSkillSummaries(value: unknown): MultiremiRuntimeLocalSkillSummary[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = isRecord(item) ? item : {};
    const sourcePath = String(record.sourcePath ?? record.source_path ?? "");
    const fileCount = Number(record.fileCount ?? record.file_count ?? 0);
    return {
      key: String(record.key ?? record.name ?? "").trim(),
      name: String(record.name ?? record.key ?? "").trim(),
      description: String(record.description ?? ""),
      sourcePath,
      source_path: sourcePath,
      provider: String(record.provider ?? "unknown"),
      fileCount,
      file_count: fileCount,
    };
  }).filter((skill) => skill.key && skill.name);
}

function cleanOptionalLocalSkillString(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
}

export function isRuntimeEffectivelyOnline(
  runtime: Pick<MultiremiRuntime, "status" | "lastHeartbeatAt">,
  nowMs = Date.now(),
): boolean {
  return (
    runtime.status !== "offline" &&
    isRuntimeHeartbeatFresh(runtime.lastHeartbeatAt, nowMs)
  );
}

export function withRuntimeLiveness(runtime: MultiremiRuntime): MultiremiRuntime {
  return isRuntimeEffectivelyOnline(runtime) ? runtime : { ...runtime, status: "offline" };
}

function toRuntimeModel(row: Row): MultiremiRuntimeModel {
  return {
    id: String(row.model_id),
    label: String(row.label ?? row.model_id),
    provider: String(row.provider ?? ""),
    default: Boolean(Number(row.is_default ?? 0)),
    thinking: row.thinking == null ? undefined : parseJson(row.thinking, undefined),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function activeAgentSetMatches(current: MultiremiAgent[], expected: Set<string>): boolean {
  if (current.length !== expected.size) return false;
  return current.every((agent) => expected.has(agent.id));
}
