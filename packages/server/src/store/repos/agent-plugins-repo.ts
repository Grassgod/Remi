import { createHash } from "node:crypto";
import { createId, nowIso } from "@multiremi/ids.js";
import { parseJson, toJson } from "@multiremi/store/helpers.js";
import type { StoreContext } from "@multiremi/store/context.js";
import {
  AgentPluginValidationError,
  buildAgentPluginArtifact,
  canonicalJson,
  normalizeAgentPluginProvider,
} from "@multiremi/agent-plugins/import.js";
import type {
  CreateAgentPluginBindingInput,
  CreateAgentPluginVersionInput,
  ImportAgentPluginInput,
  MultiremiAgentPlugin,
  MultiremiAgentPluginArtifactFile,
  MultiremiAgentPluginBinding,
  MultiremiAgentPluginDesiredReason,
  MultiremiAgentPluginProvider,
  MultiremiAgentPluginRuntimeDesiredSnapshot,
  MultiremiAgentPluginRuntimeState,
  MultiremiAgentPluginRuntimeStatus,
  MultiremiAgentPluginVersion,
  MultiremiTaskPluginSnapshotEntry,
  ReportAgentPluginRuntimeStateInput,
  UpdateAgentPluginBindingInput,
  UpdateAgentPluginInput,
} from "@multiremi/contracts/types.js";

type Row = Record<string, unknown>;

const RUNTIME_STATUSES = new Set<MultiremiAgentPluginRuntimeStatus>([
  "pending",
  "downloading",
  "verifying",
  "installing",
  "preflight",
  "ready",
  "retry_scheduled",
  "setup_required",
  "blocked",
]);

const REASON_PRIORITY: Record<MultiremiAgentPluginDesiredReason, number> = {
  active_binding: 1,
  candidate: 2,
  pinned_binding: 3,
  task_snapshot: 4,
};

export class AgentPluginStoreError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
    this.name = "AgentPluginStoreError";
  }
}

export class AgentPluginsRepo {
  constructor(private readonly ctx: StoreContext) {}

  /** Must be called inside a database transaction. */
  lockAgentPluginWorkspace(workspaceId: string): void {
    const now = nowIso();
    this.ctx.db.run(
      `INSERT INTO multiremi_agent_plugin_workspace_locks (workspace_id, updated_at)
       VALUES (?, ?) ON CONFLICT(workspace_id) DO NOTHING`,
      [workspaceId, now],
    );
    this.ctx.db.run(
      "UPDATE multiremi_agent_plugin_workspace_locks SET updated_at = ? WHERE workspace_id = ?",
      [now, workspaceId],
    );
  }

  listAgentPlugins(
    workspaceId = "local",
    options: { provider?: string | null; includeArchived?: boolean } = {},
  ): MultiremiAgentPlugin[] {
    const provider = options.provider ? normalizeAgentPluginProvider(options.provider) : null;
    const rows = provider
      ? this.ctx.db.query(
        `SELECT * FROM multiremi_agent_plugins
         WHERE workspace_id = ? AND provider = ? ${options.includeArchived ? "" : "AND archived_at IS NULL"}
         ORDER BY updated_at DESC, name ASC`,
      ).all(workspaceId, provider) as Row[]
      : this.ctx.db.query(
        `SELECT * FROM multiremi_agent_plugins
         WHERE workspace_id = ? ${options.includeArchived ? "" : "AND archived_at IS NULL"}
         ORDER BY provider ASC, updated_at DESC, name ASC`,
      ).all(workspaceId) as Row[];
    return rows.map((row) => this.toPlugin(row));
  }

  getAgentPlugin(id: string, options: { includeArchived?: boolean } = {}): MultiremiAgentPlugin | null {
    const row = this.ctx.db.query(
      `SELECT * FROM multiremi_agent_plugins WHERE id = ? ${options.includeArchived ? "" : "AND archived_at IS NULL"}`,
    ).get(id) as Row | null;
    return row ? this.toPlugin(row) : null;
  }

  importAgentPlugin(input: ImportAgentPluginInput): MultiremiAgentPlugin {
    try {
      const artifact = buildAgentPluginArtifact(input);
      const workspaceId = cleanString(input.workspaceId ?? input.workspace_id) ?? "local";
      let result: MultiremiAgentPlugin | null = null;
      const transaction = this.ctx.db.transaction(() => {
        this.lockAgentPluginWorkspace(workspaceId);
        const requestedId = cleanString(input.id);
        let pluginRow = this.ctx.db.query(
          "SELECT * FROM multiremi_agent_plugins WHERE workspace_id = ? AND provider = ? AND name = ?",
        ).get(workspaceId, artifact.provider, artifact.name) as Row | null;
        if (requestedId && pluginRow && String(pluginRow.id) !== requestedId) {
          throw conflict("a plugin with this provider and name already exists", "plugin_name_conflict");
        }
        const now = nowIso();
        if (!pluginRow) {
          const pluginId = requestedId ?? createId("apl");
          this.ctx.db.run(
            `INSERT INTO multiremi_agent_plugins (
               id, workspace_id, provider, name, description, source_type, source_url, source_ref, source_subdir,
               active_version_id, candidate_version_id, created_by, archived_at, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?)`,
            [
              pluginId,
              workspaceId,
              artifact.provider,
              artifact.name,
              artifact.description,
              artifact.sourceType,
              cleanString(input.sourceUrl ?? input.source_url),
              cleanString(input.sourceRef ?? input.source_ref),
              cleanString(input.sourceSubdir ?? input.source_subdir),
              cleanString(input.createdBy ?? input.created_by),
              now,
              now,
            ],
          );
          pluginRow = this.rawPlugin(pluginId)!;
        } else {
          this.ctx.db.run(
            `UPDATE multiremi_agent_plugins
             SET description = ?, source_type = ?, source_url = ?, source_ref = ?, source_subdir = ?, archived_at = NULL, updated_at = ?
             WHERE id = ?`,
            [
              artifact.description,
              artifact.sourceType,
              cleanString(input.sourceUrl ?? input.source_url),
              cleanString(input.sourceRef ?? input.source_ref),
              cleanString(input.sourceSubdir ?? input.source_subdir),
              now,
              String(pluginRow.id),
            ],
          );
          pluginRow = this.rawPlugin(String(pluginRow.id))!;
        }

        const version = this.insertVersion(String(pluginRow.id), artifact, {
          sourceRevision: cleanString(input.sourceRevision ?? input.source_revision),
          requirements: input.requirements ?? {},
          metadata: input.metadata ?? {},
          createdBy: cleanString(input.createdBy ?? input.created_by),
        });
        const activeVersionId = cleanString(pluginRow.active_version_id);
        if (!activeVersionId) {
          this.ctx.db.run(
            "UPDATE multiremi_agent_plugins SET active_version_id = ?, candidate_version_id = NULL, updated_at = ? WHERE id = ?",
            [version.id, nowIso(), String(pluginRow.id)],
          );
        } else if (activeVersionId !== version.id) {
          this.ctx.db.run(
            "UPDATE multiremi_agent_plugins SET candidate_version_id = ?, updated_at = ? WHERE id = ?",
            [version.id, nowIso(), String(pluginRow.id)],
          );
        }
        this.reconcileAgentPluginDesiredStateLocked(workspaceId);
        result = this.getAgentPlugin(String(pluginRow.id));
      });
      transaction();
      return result!;
    } catch (error) {
      throw normalizeStoreError(error);
    }
  }

  createAgentPluginVersion(pluginId: string, input: CreateAgentPluginVersionInput): MultiremiAgentPluginVersion {
    const initialPlugin = this.requirePlugin(pluginId);
    let result: MultiremiAgentPluginVersion | null = null;
    const transaction = this.ctx.db.transaction(() => {
      this.lockAgentPluginWorkspace(initialPlugin.workspaceId);
      const plugin = this.requirePlugin(pluginId);
      const artifact = buildAgentPluginArtifact({
        ...input,
        provider: plugin.provider,
        name: plugin.name,
        description: plugin.description,
        sourceType: plugin.sourceType,
      });
      result = this.insertVersion(plugin.id, artifact, {
        sourceRevision: cleanString(input.sourceRevision ?? input.source_revision),
        requirements: input.requirements ?? {},
        metadata: input.metadata ?? {},
        createdBy: cleanString(input.createdBy ?? input.created_by),
      });
      if (!plugin.activeVersionId) {
        this.ctx.db.run(
          "UPDATE multiremi_agent_plugins SET active_version_id = ?, candidate_version_id = NULL, updated_at = ? WHERE id = ?",
          [result.id, nowIso(), plugin.id],
        );
      } else if (plugin.activeVersionId !== result.id) {
        this.ctx.db.run(
          "UPDATE multiremi_agent_plugins SET candidate_version_id = ?, updated_at = ? WHERE id = ?",
          [result.id, nowIso(), plugin.id],
        );
      }
      this.reconcileAgentPluginDesiredStateLocked(plugin.workspaceId);
    });
    try {
      transaction();
      return result!;
    } catch (error) {
      throw normalizeStoreError(error);
    }
  }

  updateAgentPlugin(id: string, input: UpdateAgentPluginInput): MultiremiAgentPlugin {
    const plugin = this.requirePlugin(id);
    const name = Object.prototype.hasOwnProperty.call(input, "name")
      ? cleanString(input.name)
      : plugin.name;
    if (!name) throw badRequest("plugin name is required", "missing_name");
    const description = Object.prototype.hasOwnProperty.call(input, "description")
      ? String(input.description ?? "").trim()
      : plugin.description;
    const sourceUrl = hasEither(input, "sourceUrl", "source_url")
      ? cleanString(input.sourceUrl ?? input.source_url)
      : plugin.sourceUrl;
    const sourceRef = hasEither(input, "sourceRef", "source_ref")
      ? cleanString(input.sourceRef ?? input.source_ref)
      : plugin.sourceRef;
    const sourceSubdir = hasEither(input, "sourceSubdir", "source_subdir")
      ? cleanString(input.sourceSubdir ?? input.source_subdir)
      : plugin.sourceSubdir;
    try {
      this.ctx.db.run(
        `UPDATE multiremi_agent_plugins
         SET name = ?, description = ?, source_url = ?, source_ref = ?, source_subdir = ?, updated_at = ? WHERE id = ?`,
        [name, description, sourceUrl, sourceRef, sourceSubdir, nowIso(), id],
      );
    } catch (error) {
      if (isUniqueError(error)) throw conflict("a plugin with this provider and name already exists", "plugin_name_conflict");
      throw error;
    }
    return this.requirePlugin(id);
  }

  archiveAgentPlugin(id: string): MultiremiAgentPlugin {
    const initialPlugin = this.requirePlugin(id);
    const now = nowIso();
    const transaction = this.ctx.db.transaction(() => {
      this.lockAgentPluginWorkspace(initialPlugin.workspaceId);
      const plugin = this.requirePlugin(id);
      this.ctx.db.run("UPDATE multiremi_agent_plugins SET archived_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
      this.ctx.db.run("UPDATE multiremi_agent_plugin_bindings SET enabled = 0, updated_at = ? WHERE plugin_id = ?", [now, id]);
      this.reconcileAgentPluginDesiredStateLocked(plugin.workspaceId);
    });
    transaction();
    return this.getAgentPlugin(id, { includeArchived: true })!;
  }

  restoreAgentPlugin(id: string): MultiremiAgentPlugin {
    const plugin = this.getAgentPlugin(id, { includeArchived: true });
    if (!plugin) throw notFound("plugin not found", "plugin_not_found");
    this.ctx.db.run("UPDATE multiremi_agent_plugins SET archived_at = NULL, updated_at = ? WHERE id = ?", [nowIso(), id]);
    return this.requirePlugin(id);
  }

  listAgentPluginVersions(pluginId: string): MultiremiAgentPluginVersion[] {
    this.requirePlugin(pluginId, true);
    const rows = this.ctx.db.query(
      "SELECT * FROM multiremi_agent_plugin_versions WHERE plugin_id = ? ORDER BY created_at DESC",
    ).all(pluginId) as Row[];
    return rows.map((row) => this.toVersion(row));
  }

  getAgentPluginVersion(id: string): MultiremiAgentPluginVersion | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_agent_plugin_versions WHERE id = ?").get(id) as Row | null;
    return row ? this.toVersion(row) : null;
  }

  activateAgentPluginVersion(pluginId: string, versionId: string): MultiremiAgentPlugin {
    const initialPlugin = this.requirePlugin(pluginId);
    const transaction = this.ctx.db.transaction(() => {
      this.lockAgentPluginWorkspace(initialPlugin.workspaceId);
      const plugin = this.requirePlugin(pluginId);
      const version = this.requireVersion(versionId);
      if (version.pluginId !== plugin.id) throw badRequest("version does not belong to plugin", "version_plugin_mismatch");
      this.reconcileAgentPluginDesiredStateLocked(plugin.workspaceId);
      this.assertVersionReadyForActivation(plugin, version);
      this.ctx.db.run(
        "UPDATE multiremi_agent_plugins SET active_version_id = ?, candidate_version_id = NULL, updated_at = ? WHERE id = ?",
        [version.id, nowIso(), plugin.id],
      );
      this.reconcileAgentPluginDesiredStateLocked(plugin.workspaceId);
      return this.requirePlugin(plugin.id);
    });
    return transaction();
  }

  rollbackAgentPluginVersion(pluginId: string, versionId?: string | null): MultiremiAgentPlugin {
    const initialPlugin = this.requirePlugin(pluginId);
    const transaction = this.ctx.db.transaction(() => {
      this.lockAgentPluginWorkspace(initialPlugin.workspaceId);
      const plugin = this.requirePlugin(pluginId);
      const target = versionId
        ? this.requireVersion(versionId)
        : this.previousPluginVersion(plugin);
      if (!target || target.pluginId !== plugin.id) {
        throw badRequest("rollback version is not available", "rollback_version_unavailable");
      }
      if (target.id === plugin.activeVersionId) return plugin;
      this.reconcileAgentPluginDesiredStateLocked(plugin.workspaceId, { additionalVersionId: target.id, pluginId: plugin.id });
      this.assertVersionReadyForActivation(plugin, target);
      const previousActive = plugin.activeVersionId;
      this.ctx.db.run(
        "UPDATE multiremi_agent_plugins SET active_version_id = ?, candidate_version_id = ?, updated_at = ? WHERE id = ?",
        [target.id, previousActive, nowIso(), plugin.id],
      );
      this.reconcileAgentPluginDesiredStateLocked(plugin.workspaceId);
      return this.requirePlugin(plugin.id);
    });
    return transaction();
  }

  listAgentPluginBindings(agentId: string): MultiremiAgentPluginBinding[] {
    this.requireAgent(agentId);
    const rows = this.ctx.db.query(
      "SELECT * FROM multiremi_agent_plugin_bindings WHERE agent_id = ? ORDER BY created_at ASC",
    ).all(agentId) as Row[];
    return rows.map((row) => this.toBinding(row));
  }

  assertAgentPluginWorkspaceMoveAllowed(agentId: string, targetWorkspaceId: string): void {
    const agent = this.requireAgent(agentId);
    if (agent.workspaceId === targetWorkspaceId) return;
    const binding = this.ctx.db.query(
      "SELECT 1 AS found FROM multiremi_agent_plugin_bindings WHERE agent_id = ? LIMIT 1",
    ).get(agentId) as Row | null;
    if (binding) {
      throw conflict(
        "remove all plugin bindings before moving this agent to another workspace",
        "agent_plugin_workspace_move_blocked",
      );
    }
  }

  createAgentPluginBinding(agentId: string, input: CreateAgentPluginBindingInput): MultiremiAgentPluginBinding {
    const pluginId = cleanString(input.pluginId ?? input.plugin_id);
    if (!pluginId) throw badRequest("plugin_id is required", "missing_plugin_id");
    const initialPlugin = this.requirePlugin(pluginId);
    const transaction = this.ctx.db.transaction(() => {
      this.lockAgentPluginWorkspace(initialPlugin.workspaceId);
      const agent = this.requireAgent(agentId);
      const plugin = this.requirePlugin(pluginId);
      this.assertAgentPluginCompatible(agent, plugin);
      const values = this.normalizeBindingVersion(plugin, input);
      const now = nowIso();
      const id = createId("apb");
      try {
        this.ctx.db.run(
          `INSERT INTO multiremi_agent_plugin_bindings (
             id, agent_id, plugin_id, version_policy, version_id, connection_id, config, enabled, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            agent.id,
            plugin.id,
            values.versionPolicy,
            values.versionId,
            cleanString(input.connectionId ?? input.connection_id),
            toJson(normalizeObject(input.config)),
            input.enabled === false ? 0 : 1,
            now,
            now,
          ],
        );
      } catch (error) {
        if (isUniqueError(error)) throw conflict("plugin is already bound to this agent", "binding_conflict");
        throw error;
      }
      this.reconcileAgentPluginDesiredStateLocked(plugin.workspaceId);
      return this.requireBinding(id);
    });
    return transaction();
  }

  updateAgentPluginBinding(
    agentId: string,
    bindingId: string,
    input: UpdateAgentPluginBindingInput,
  ): MultiremiAgentPluginBinding {
    const initial = this.requireBinding(bindingId);
    const transaction = this.ctx.db.transaction(() => {
      this.lockAgentPluginWorkspace(initial.plugin.workspaceId);
      const current = this.requireBinding(bindingId);
      if (current.agentId !== agentId) throw notFound("plugin binding not found", "binding_not_found");
      const agent = this.requireAgent(agentId);
      this.assertAgentPluginCompatible(agent, current.plugin);
      const values = this.normalizeBindingVersion(current.plugin, {
        versionPolicy: input.versionPolicy ?? input.version_policy ?? current.versionPolicy,
        versionId: hasEither(input, "versionId", "version_id")
          ? input.versionId ?? input.version_id
          : current.versionId,
      });
      const connectionId = hasEither(input, "connectionId", "connection_id")
        ? cleanString(input.connectionId ?? input.connection_id)
        : current.connectionId;
      const config = Object.prototype.hasOwnProperty.call(input, "config")
        ? normalizeObject(input.config)
        : current.config;
      const enabled = Object.prototype.hasOwnProperty.call(input, "enabled") ? input.enabled !== false : current.enabled;
      this.ctx.db.run(
        `UPDATE multiremi_agent_plugin_bindings
         SET version_policy = ?, version_id = ?, connection_id = ?, config = ?, enabled = ?, updated_at = ? WHERE id = ?`,
        [values.versionPolicy, values.versionId, connectionId, toJson(config), enabled ? 1 : 0, nowIso(), current.id],
      );
      this.reconcileAgentPluginDesiredStateLocked(current.plugin.workspaceId);
      return this.requireBinding(current.id);
    });
    return transaction();
  }

  deleteAgentPluginBinding(agentId: string, bindingId: string): boolean {
    const initial = this.requireBindingRef(bindingId);
    if (initial.agentId !== agentId) throw notFound("plugin binding not found", "binding_not_found");
    const transaction = this.ctx.db.transaction(() => {
      for (const workspaceId of [...new Set([initial.agentWorkspaceId, initial.pluginWorkspaceId])].sort()) {
        this.lockAgentPluginWorkspace(workspaceId);
      }
      const binding = this.requireBindingRef(bindingId);
      if (binding.agentId !== agentId) throw notFound("plugin binding not found", "binding_not_found");
      const result = this.ctx.db.run("DELETE FROM multiremi_agent_plugin_bindings WHERE id = ?", [bindingId]);
      this.reconcileAgentPluginDesiredStateLocked(binding.pluginWorkspaceId);
      if (binding.agentWorkspaceId !== binding.pluginWorkspaceId) {
        this.reconcileAgentPluginDesiredStateLocked(binding.agentWorkspaceId);
      }
      return result.changes > 0;
    });
    return transaction();
  }

  resolveAgentPluginSnapshot(agentId: string): MultiremiTaskPluginSnapshotEntry[] {
    const agent = this.requireAgent(agentId);
    return this.listAgentPluginBindings(agent.id)
      .filter((binding) => binding.enabled)
      .map((binding) => {
        const version = binding.resolvedVersion;
        if (!version) {
          throw conflict(`plugin ${binding.plugin.name} has no resolved version`, "plugin_version_unavailable");
        }
        return {
          bindingId: binding.id,
          pluginId: binding.pluginId,
          versionId: version.id,
          name: binding.plugin.name,
          provider: binding.plugin.provider,
          version: version.version,
          digest: version.artifactDigest,
          artifactUrl: version.artifactUrl,
          sourceRevision: version.sourceRevision,
          config: binding.config,
          connectionId: binding.connectionId,
        };
      })
      .sort((left, right) => left.pluginId.localeCompare(right.pluginId));
  }

  getAgentPluginCapabilityRevision(agentId: string): string {
    const entries = this.resolveAgentPluginSnapshot(agentId);
    return createHash("sha256").update(canonicalJson(entries)).digest("hex");
  }

  runtimeHasReadyAgentPlugins(runtimeId: string, agentId: string): boolean {
    const runtime = this.requireRuntime(runtimeId);
    const agent = this.requireAgent(agentId);
    if ((runtime.workspaceId ?? "local") !== agent.workspaceId) return false;
    for (const entry of this.resolveAgentPluginSnapshot(agent.id)) {
      const row = this.ctx.db.query(
        `SELECT s.status, s.observed_digest, s.desired, v.artifact_digest
         FROM multiremi_agent_plugin_runtime_states s
         JOIN multiremi_agent_plugin_versions v ON v.id = s.plugin_version_id
         WHERE s.runtime_id = ? AND s.plugin_version_id = ?`,
      ).get(runtime.id, entry.versionId) as Row | null;
      if (!row || Number(row.desired) !== 1 || row.status !== "ready" || row.observed_digest !== row.artifact_digest) {
        return false;
      }
    }
    return true;
  }

  assertAgentPluginProviderCompatible(agentId: string, provider: string): void {
    this.requireAgent(agentId);
    const incompatible = this.ctx.db.query(
      `SELECT p.name, p.provider
       FROM multiremi_agent_plugin_bindings b
       JOIN multiremi_agent_plugins p ON p.id = b.plugin_id
       WHERE b.agent_id = ? AND b.enabled = 1 AND p.archived_at IS NULL AND p.provider <> ?
       ORDER BY p.name ASC LIMIT 1`,
    ).get(agentId, provider) as Row | null;
    if (incompatible) {
      throw conflict(
        `unbind ${String(incompatible.provider)} plugin ${String(incompatible.name)} before switching agent provider to ${provider}`,
        "provider_mismatch",
      );
    }
  }

  listAgentPluginRuntimeStates(
    options: { workspaceId?: string; pluginId?: string; runtimeId?: string; includeHistorical?: boolean } = {},
  ): MultiremiAgentPluginRuntimeState[] {
    const workspaceId = options.workspaceId
      ?? (options.pluginId ? this.requirePlugin(options.pluginId, true).workspaceId : null)
      ?? (options.runtimeId ? this.requireRuntime(options.runtimeId).workspaceId ?? "local" : "local");
    this.reconcileAgentPluginDesiredState(workspaceId);
    const where = ["s.workspace_id = ?"];
    const params: unknown[] = [workspaceId];
    if (options.pluginId) {
      where.push("s.plugin_id = ?");
      params.push(options.pluginId);
    }
    if (options.runtimeId) {
      where.push("s.runtime_id = ?");
      params.push(options.runtimeId);
    }
    if (!options.includeHistorical) where.push("s.desired = 1");
    const rows = this.ctx.db.query(
      `SELECT s.* FROM multiremi_agent_plugin_runtime_states s
       WHERE ${where.join(" AND ")} ORDER BY s.runtime_id ASC, s.created_at ASC`,
    ).all(...params) as Row[];
    return rows.map((row) => this.toRuntimeState(row));
  }

  getRuntimeAgentPluginDesiredSnapshot(runtimeId: string): MultiremiAgentPluginRuntimeDesiredSnapshot {
    const runtime = this.requireRuntime(runtimeId);
    const workspaceId = runtime.workspaceId ?? "local";
    this.reconcileAgentPluginDesiredState(workspaceId);
    const rows = this.ctx.db.query(
      `SELECT s.*, p.name, p.provider, v.version, v.artifact_digest, v.source_revision, v.requirements
       FROM multiremi_agent_plugin_runtime_states s
       JOIN multiremi_agent_plugins p ON p.id = s.plugin_id
       JOIN multiremi_agent_plugin_versions v ON v.id = s.plugin_version_id
       WHERE s.runtime_id = ? AND s.desired = 1
       ORDER BY p.provider ASC, p.name ASC, v.version ASC`,
    ).all(runtime.id) as Row[];
    const plugins = rows.map((row) => ({
      stateId: String(row.id),
      pluginId: String(row.plugin_id),
      versionId: String(row.plugin_version_id),
      name: String(row.name),
      provider: normalizeAgentPluginProvider(row.provider),
      version: String(row.version),
      digest: String(row.artifact_digest),
      artifactUrl: artifactUrl(String(row.artifact_digest)),
      sourceRevision: cleanString(row.source_revision),
      requirements: parseJson<Record<string, unknown>>(row.requirements, {}),
      desiredReason: normalizeDesiredReason(row.desired_reason),
      status: normalizeRuntimeStatus(row.status),
      observedDigest: cleanString(row.observed_digest),
      retryCount: Number(row.retry_count ?? 0),
      retryGeneration: Number(row.retry_generation ?? 0),
      nextRetryAt: cleanString(row.next_retry_at),
      lastErrorCode: cleanString(row.last_error_code),
      lastError: cleanString(row.last_error),
      updatedAt: String(row.updated_at),
    }));
    const revision = createHash("sha256").update(canonicalJson(plugins)).digest("hex");
    return { runtimeId: runtime.id, revision, plugins };
  }

  reportAgentPluginRuntimeState(
    runtimeId: string,
    versionId: string,
    input: ReportAgentPluginRuntimeStateInput,
  ): MultiremiAgentPluginRuntimeState {
    this.requireRuntime(runtimeId);
    const version = this.requireVersion(versionId);
    const row = this.ctx.db.query(
      "SELECT * FROM multiremi_agent_plugin_runtime_states WHERE runtime_id = ? AND plugin_version_id = ? AND desired = 1",
    ).get(runtimeId, version.id) as Row | null;
    if (!row) throw notFound("desired plugin version not found for runtime", "runtime_plugin_not_desired");
    const reportedGenerationValue = input.retryGeneration ?? input.retry_generation;
    const reportedGeneration = Number.isSafeInteger(reportedGenerationValue) && Number(reportedGenerationValue) >= 0
      ? Number(reportedGenerationValue)
      : null;
    const expectedGeneration = Number(row.retry_generation ?? 0);
    if (reportedGeneration !== null && reportedGeneration !== expectedGeneration) {
      return this.requireRuntimeState(String(row.id));
    }
    const status = normalizeRuntimeStatus(input.status);
    const observedDigest = cleanString(input.observedDigest ?? input.observed_digest);
    if (status === "ready" && observedDigest !== version.artifactDigest) {
      throw conflict("observed plugin digest does not match desired digest", "artifact_digest_mismatch");
    }
    const isFailure = status === "retry_scheduled" || status === "setup_required" || status === "blocked";
    const lastError = isFailure ? cleanString(input.lastError ?? input.last_error) : null;
    const lastErrorCode = isFailure ? cleanString(input.lastErrorCode ?? input.last_error_code) : null;
    const nextRetryAt = status === "retry_scheduled" || status === "setup_required"
      ? cleanString(input.nextRetryAt ?? input.next_retry_at)
      : null;
    const reportedAttempts = Number.isSafeInteger(input.attempts) && Number(input.attempts) >= 0
      ? Number(input.attempts)
      : null;
    const currentAttempts = Number(row.retry_count ?? 0);
    const unchanged = normalizeRuntimeStatus(row.status) === status
      && cleanString(row.observed_digest) === observedDigest
      && (reportedAttempts === null || currentAttempts >= reportedAttempts)
      && cleanString(row.next_retry_at) === nextRetryAt
      && cleanString(row.last_error_code) === lastErrorCode
      && cleanString(row.last_error) === lastError;
    if (unchanged) return this.requireRuntimeState(String(row.id));
    const now = nowIso();
    const update = this.ctx.db.run(
      `UPDATE multiremi_agent_plugin_runtime_states
       SET status = ?, observed_digest = ?,
           retry_count = CASE
             WHEN ? = 1 THEN CASE WHEN retry_count < ? THEN ? ELSE retry_count END
             WHEN ? = 1 THEN retry_count + 1
             ELSE retry_count
           END,
           next_retry_at = ?,
           last_error_code = ?, last_error = ?, last_attempt_at = ?,
           last_ready_at = CASE WHEN ? = 'ready' THEN ? ELSE last_ready_at END, updated_at = ?
       WHERE id = ? AND retry_generation = ?`,
      [
        status,
        observedDigest,
        reportedAttempts === null ? 0 : 1,
        reportedAttempts,
        reportedAttempts,
        isFailure ? 1 : 0,
        nextRetryAt,
        lastErrorCode,
        lastError,
        now,
        status,
        now,
        now,
        String(row.id),
        expectedGeneration,
      ],
    );
    if (update.changes === 0) return this.requireRuntimeState(String(row.id));
    return this.requireRuntimeState(String(row.id));
  }

  retryAgentPluginRuntime(pluginId: string, runtimeId?: string | null, versionId?: string | null): MultiremiAgentPluginRuntimeState[] {
    const plugin = this.requirePlugin(pluginId);
    const transaction = this.ctx.db.transaction(() => {
      this.lockAgentPluginWorkspace(plugin.workspaceId);
      this.reconcileAgentPluginDesiredStateLocked(plugin.workspaceId);
      const where = ["plugin_id = ?", "workspace_id = ?", "desired = 1"];
      const params: unknown[] = [plugin.id, plugin.workspaceId];
      if (runtimeId) {
        const runtime = this.requireRuntime(runtimeId);
        if ((runtime.workspaceId ?? "local") !== plugin.workspaceId) throw notFound("runtime not found", "runtime_not_found");
        where.push("runtime_id = ?");
        params.push(runtime.id);
      }
      if (versionId) {
        const version = this.requireVersion(versionId);
        if (version.pluginId !== plugin.id) throw badRequest("version does not belong to plugin", "version_plugin_mismatch");
        where.push("plugin_version_id = ?");
        params.push(version.id);
      }
      const rows = this.ctx.db.query(
        `SELECT id FROM multiremi_agent_plugin_runtime_states WHERE ${where.join(" AND ")}`,
      ).all(...params) as Row[];
      const now = nowIso();
      for (const row of rows) {
        this.ctx.db.run(
          `UPDATE multiremi_agent_plugin_runtime_states
           SET status = 'pending', observed_digest = NULL, retry_count = 0,
               retry_generation = retry_generation + 1, next_retry_at = NULL,
               last_error_code = NULL, last_error = NULL, updated_at = ? WHERE id = ?`,
          [now, String(row.id)],
        );
      }
      return rows.map((row) => this.requireRuntimeState(String(row.id)));
    });
    return transaction();
  }

  getAgentPluginArtifactByDigest(digest: string, workspaceId?: string | null): {
    plugin: MultiremiAgentPlugin;
    version: MultiremiAgentPluginVersion;
    artifactJson: string;
    artifact: Record<string, unknown>;
  } | null {
    const row = workspaceId
      ? this.ctx.db.query(
        `SELECT v.* FROM multiremi_agent_plugin_versions v
         JOIN multiremi_agent_plugins p ON p.id = v.plugin_id
         WHERE v.artifact_digest = ? AND p.workspace_id = ?
         ORDER BY v.created_at DESC LIMIT 1`,
      ).get(digest, workspaceId) as Row | null
      : this.ctx.db.query(
        `SELECT v.* FROM multiremi_agent_plugin_versions v
         JOIN multiremi_agent_plugins p ON p.id = v.plugin_id
         WHERE v.artifact_digest = ?
         ORDER BY v.created_at DESC LIMIT 1`,
      ).get(digest) as Row | null;
    if (!row) return null;
    const version = this.toVersion(row);
    return {
      plugin: this.requirePlugin(version.pluginId, true),
      version,
      artifactJson: String(row.artifact_json),
      artifact: parseJson<Record<string, unknown>>(row.artifact_json, {}),
    };
  }

  reconcileAgentPluginDesiredState(
    workspaceId: string,
    options: { additionalVersionId?: string; pluginId?: string } = {},
  ): void {
    const transaction = this.ctx.db.transaction(() => {
      this.lockAgentPluginWorkspace(workspaceId);
      this.reconcileAgentPluginDesiredStateLocked(workspaceId, options);
    });
    transaction();
  }

  /** Caller must already hold this workspace's Plugin lock inside a transaction. */
  reconcileAgentPluginDesiredStateWithinLock(workspaceId: string): void {
    this.reconcileAgentPluginDesiredStateLocked(workspaceId);
  }

  private reconcileAgentPluginDesiredStateLocked(
    workspaceId: string,
    options: { additionalVersionId?: string; pluginId?: string } = {},
  ): void {
    const desired = new Map<string, {
      pluginId: string;
      provider: MultiremiAgentPluginProvider;
      reason: MultiremiAgentPluginDesiredReason;
    }>();
    const bindings = this.ctx.db.query(
      `SELECT p.id AS plugin_id, p.active_version_id, p.candidate_version_id,
              p.provider, b.version_policy, b.version_id
       FROM multiremi_agent_plugin_bindings b
       JOIN multiremi_agents a ON a.id = b.agent_id
       JOIN multiremi_agent_plugins p ON p.id = b.plugin_id
       WHERE a.workspace_id = ? AND p.workspace_id = a.workspace_id
         AND a.archived_at IS NULL AND p.archived_at IS NULL AND b.enabled = 1`,
    ).all(workspaceId) as Row[];
    for (const row of bindings) {
      const pluginId = String(row.plugin_id);
      const provider = normalizeAgentPluginProvider(row.provider);
      const resolvedVersionId = row.version_policy === "pinned"
        ? cleanString(row.version_id)
        : cleanString(row.active_version_id);
      if (resolvedVersionId) {
        this.addDesired(
          desired,
          resolvedVersionId,
          pluginId,
          provider,
          row.version_policy === "pinned" ? "pinned_binding" : "active_binding",
        );
      }
      const candidateVersionId = cleanString(row.candidate_version_id);
      if (candidateVersionId) this.addDesired(desired, candidateVersionId, pluginId, provider, "candidate");
    }
    // Running and infrastructure-retry tasks own immutable execution
    // snapshots. Keep those exact versions staged even after an Agent binding
    // advances, otherwise a resume-unsafe retry could be dispatched to a
    // Runtime that only has the new active version.
    const taskSnapshots = this.ctx.db.query(
      `SELECT DISTINCT snapshot.plugin_id, snapshot.version_id, snapshot.provider
       FROM multiremi_task_plugin_snapshots snapshot
       JOIN multiremi_tasks task ON task.id = snapshot.task_id
       WHERE task.workspace_id = ?
         AND task.status IN ('queued', 'dispatched', 'running', 'waiting_local_directory', 'awaiting_human')`,
    ).all(workspaceId) as Row[];
    for (const row of taskSnapshots) {
      this.addDesired(
        desired,
        String(row.version_id),
        String(row.plugin_id),
        normalizeAgentPluginProvider(row.provider),
        "task_snapshot",
      );
    }
    if (options.additionalVersionId && options.pluginId) {
      const plugin = this.requirePlugin(options.pluginId, true);
      this.addDesired(desired, options.additionalVersionId, options.pluginId, plugin.provider, "candidate");
    }

    const runtimes = this.ctx.db.query(
      "SELECT id, provider FROM multiremi_runtimes WHERE COALESCE(workspace_id, 'local') = ?",
    ).all(workspaceId) as Row[];
    const now = nowIso();
    this.ctx.db.run(
      "UPDATE multiremi_agent_plugin_runtime_states SET desired = 0, updated_at = ? WHERE workspace_id = ? AND desired = 1",
      [now, workspaceId],
    );
    for (const runtime of runtimes) {
      for (const [versionId, item] of desired) {
        if (String(runtime.provider) !== "any" && String(runtime.provider) !== item.provider) continue;
        this.ctx.db.run(
          `INSERT INTO multiremi_agent_plugin_runtime_states (
             id, workspace_id, runtime_id, plugin_id, plugin_version_id, desired, desired_reason,
             status, retry_count, retry_generation, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 1, ?, 'pending', 0, 0, ?, ?)
           ON CONFLICT(runtime_id, plugin_version_id) DO UPDATE SET
             desired = 1, desired_reason = excluded.desired_reason, updated_at = excluded.updated_at`,
          [createId("aps"), workspaceId, String(runtime.id), item.pluginId, versionId, item.reason, now, now],
        );
      }
    }
  }

  private insertVersion(
    pluginId: string,
    artifact: ReturnType<typeof buildAgentPluginArtifact>,
    input: {
      sourceRevision: string | null;
      requirements: Record<string, unknown>;
      metadata: Record<string, unknown>;
      createdBy: string | null;
    },
  ): MultiremiAgentPluginVersion {
    const existing = this.ctx.db.query(
      "SELECT * FROM multiremi_agent_plugin_versions WHERE plugin_id = ? AND version = ?",
    ).get(pluginId, artifact.version) as Row | null;
    if (existing) {
      if (String(existing.artifact_digest) !== artifact.artifactDigest) {
        throw conflict(
          `plugin version ${artifact.version} already exists with a different artifact`,
          "plugin_version_conflict",
        );
      }
      return this.toVersion(existing);
    }
    const id = createId("apv");
    this.ctx.db.run(
      `INSERT INTO multiremi_agent_plugin_versions (
         id, plugin_id, version, manifest_path, manifest, artifact_files, artifact_json,
         artifact_digest, artifact_size, source_revision, requirements, metadata, created_by, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        pluginId,
        artifact.version,
        artifact.manifestPath,
        toJson(artifact.manifest),
        toJson(artifact.files),
        artifact.artifactJson,
        artifact.artifactDigest,
        artifact.artifactSize,
        input.sourceRevision,
        toJson(normalizeObject(input.requirements)),
        toJson(normalizeObject(input.metadata)),
        input.createdBy,
        nowIso(),
      ],
    );
    return this.requireVersion(id);
  }

  private normalizeBindingVersion(
    plugin: MultiremiAgentPlugin,
    input: Pick<CreateAgentPluginBindingInput, "versionPolicy" | "version_policy" | "versionId" | "version_id">,
  ): { versionPolicy: "follow_active" | "pinned"; versionId: string | null } {
    const policy = String(input.versionPolicy ?? input.version_policy ?? "follow_active").trim();
    if (policy !== "follow_active" && policy !== "pinned") {
      throw badRequest('version_policy must be "follow_active" or "pinned"', "invalid_version_policy");
    }
    const requestedVersionId = cleanString(input.versionId ?? input.version_id);
    if (policy === "follow_active") return { versionPolicy: policy, versionId: null };
    if (!requestedVersionId) throw badRequest("version_id is required for pinned bindings", "missing_version_id");
    const version = this.requireVersion(requestedVersionId);
    if (version.pluginId !== plugin.id) throw badRequest("version does not belong to plugin", "version_plugin_mismatch");
    return { versionPolicy: policy, versionId: version.id };
  }

  private assertAgentPluginCompatible(agent: { workspaceId: string; provider: string }, plugin: MultiremiAgentPlugin): void {
    if (agent.workspaceId !== plugin.workspaceId) {
      throw badRequest("agent and plugin must belong to the same workspace", "workspace_mismatch");
    }
    if (agent.provider !== plugin.provider) {
      throw badRequest(
        `${plugin.provider} plugin cannot be bound to ${agent.provider} agent`,
        "provider_mismatch",
      );
    }
  }

  private assertVersionReadyForActivation(plugin: MultiremiAgentPlugin, version: MultiremiAgentPluginVersion): void {
    const binding = this.ctx.db.query(
      `SELECT 1 AS found
       FROM multiremi_agent_plugin_bindings b
       JOIN multiremi_agents a ON a.id = b.agent_id
       WHERE b.plugin_id = ? AND b.enabled = 1 AND a.archived_at IS NULL
         AND a.workspace_id = ?
       LIMIT 1`,
    ).get(plugin.id, plugin.workspaceId) as Row | null;
    if (!binding) return;
    const notReady = this.ctx.db.query(
      `SELECT r.id
       FROM multiremi_runtimes r
       LEFT JOIN multiremi_agent_plugin_runtime_states s
         ON s.runtime_id = r.id AND s.plugin_version_id = ? AND s.desired = 1
       WHERE COALESCE(r.workspace_id, 'local') = ? AND r.status = 'online'
         AND (r.provider = ? OR r.provider = 'any')
         AND (s.id IS NULL OR s.status <> 'ready' OR s.observed_digest IS NULL OR s.observed_digest <> ?)` ,
    ).all(version.id, plugin.workspaceId, plugin.provider, version.artifactDigest) as Row[];
    if (notReady.length > 0) {
      throw conflict(
        `plugin version is not ready on ${notReady.length} online runtime(s)`,
        "plugin_version_not_ready",
      );
    }
  }

  private previousPluginVersion(plugin: MultiremiAgentPlugin): MultiremiAgentPluginVersion | null {
    const row = this.ctx.db.query(
      `SELECT * FROM multiremi_agent_plugin_versions
       WHERE plugin_id = ? AND id <> ? ORDER BY created_at DESC LIMIT 1`,
    ).get(plugin.id, plugin.activeVersionId ?? "") as Row | null;
    return row ? this.toVersion(row) : null;
  }

  private addDesired(
    desired: Map<string, {
      pluginId: string;
      provider: MultiremiAgentPluginProvider;
      reason: MultiremiAgentPluginDesiredReason;
    }>,
    versionId: string,
    pluginId: string,
    provider: MultiremiAgentPluginProvider,
    reason: MultiremiAgentPluginDesiredReason,
  ): void {
    const existing = desired.get(versionId);
    if (!existing || REASON_PRIORITY[reason] > REASON_PRIORITY[existing.reason]) {
      desired.set(versionId, { pluginId, provider, reason });
    }
  }

  private requirePlugin(id: string, includeArchived = false): MultiremiAgentPlugin {
    const plugin = this.getAgentPlugin(id, { includeArchived });
    if (!plugin) throw notFound("plugin not found", "plugin_not_found");
    return plugin;
  }

  private requireVersion(id: string): MultiremiAgentPluginVersion {
    const version = this.getAgentPluginVersion(id);
    if (!version) throw notFound("plugin version not found", "plugin_version_not_found");
    return version;
  }

  private requireBinding(id: string): MultiremiAgentPluginBinding {
    const row = this.ctx.db.query("SELECT * FROM multiremi_agent_plugin_bindings WHERE id = ?").get(id) as Row | null;
    if (!row) throw notFound("plugin binding not found", "binding_not_found");
    return this.toBinding(row);
  }

  private requireBindingRef(id: string): {
    agentId: string;
    agentWorkspaceId: string;
    pluginWorkspaceId: string;
  } {
    const row = this.ctx.db.query(
      `SELECT b.agent_id, a.workspace_id AS agent_workspace_id, p.workspace_id AS plugin_workspace_id
       FROM multiremi_agent_plugin_bindings b
       JOIN multiremi_agents a ON a.id = b.agent_id
       JOIN multiremi_agent_plugins p ON p.id = b.plugin_id
       WHERE b.id = ?`,
    ).get(id) as Row | null;
    if (!row) throw notFound("plugin binding not found", "binding_not_found");
    return {
      agentId: String(row.agent_id),
      agentWorkspaceId: String(row.agent_workspace_id ?? "local"),
      pluginWorkspaceId: String(row.plugin_workspace_id ?? "local"),
    };
  }

  private requireRuntimeState(id: string): MultiremiAgentPluginRuntimeState {
    const row = this.ctx.db.query("SELECT * FROM multiremi_agent_plugin_runtime_states WHERE id = ?").get(id) as Row | null;
    if (!row) throw notFound("runtime plugin state not found", "runtime_plugin_state_not_found");
    return this.toRuntimeState(row);
  }

  private requireAgent(id: string) {
    const agent = this.ctx.db.query("SELECT * FROM multiremi_agents WHERE id = ? AND archived_at IS NULL").get(id) as Row | null;
    if (!agent) throw notFound("agent not found", "agent_not_found");
    return {
      id: String(agent.id),
      workspaceId: String(agent.workspace_id ?? "local"),
      provider: String(agent.provider),
    };
  }

  private requireRuntime(id: string) {
    const runtime = this.ctx.db.query("SELECT * FROM multiremi_runtimes WHERE id = ?").get(id) as Row | null;
    if (!runtime) throw notFound("runtime not found", "runtime_not_found");
    return toRuntimeRef(runtime);
  }

  private rawPlugin(id: string): Row | null {
    return this.ctx.db.query("SELECT * FROM multiremi_agent_plugins WHERE id = ?").get(id) as Row | null;
  }

  private toPlugin(row: Row): MultiremiAgentPlugin {
    const id = String(row.id);
    const activeVersionId = cleanString(row.active_version_id);
    const candidateVersionId = cleanString(row.candidate_version_id);
    // The list-level readiness badge describes the version currently converging: a candidate while
    // one exists, otherwise the active version. Counting both versions would turn ten runtimes into
    // a misleading denominator of twenty during an update.
    const summaryVersionId = candidateVersionId ?? activeVersionId;
    const states = summaryVersionId
      ? this.ctx.db.query(
        `SELECT s.runtime_id, s.status, r.status AS runtime_status
         FROM multiremi_agent_plugin_runtime_states s
         JOIN multiremi_runtimes r ON r.id = s.runtime_id
         WHERE s.plugin_id = ? AND s.plugin_version_id = ? AND s.desired = 1`,
      ).all(id, summaryVersionId) as Row[]
      : [];
    const onlineStates = states.filter((state) => state.runtime_status === "online");
    const summary = {
      desired: states.length,
      ready: onlineStates.filter((state) => state.status === "ready").length,
      pending: onlineStates.filter((state) => ["pending", "downloading", "verifying", "installing", "preflight"].includes(String(state.status))).length,
      retrying: onlineStates.filter((state) => state.status === "retry_scheduled").length,
      setupRequired: onlineStates.filter((state) => state.status === "setup_required").length,
      blocked: onlineStates.filter((state) => state.status === "blocked").length,
      offline: states.filter((state) => state.runtime_status === "offline").length,
    };
    return {
      id,
      workspaceId: String(row.workspace_id ?? "local"),
      provider: normalizeAgentPluginProvider(row.provider),
      name: String(row.name),
      description: String(row.description ?? ""),
      sourceType: normalizeSourceTypeFromRow(row.source_type),
      sourceUrl: cleanString(row.source_url),
      sourceRef: cleanString(row.source_ref),
      sourceSubdir: cleanString(row.source_subdir),
      activeVersionId,
      candidateVersionId,
      activeVersion: activeVersionId ? this.getAgentPluginVersion(activeVersionId) : null,
      candidateVersion: candidateVersionId ? this.getAgentPluginVersion(candidateVersionId) : null,
      bindingCount: Number((this.ctx.db.query(
        "SELECT COUNT(*) AS count FROM multiremi_agent_plugin_bindings WHERE plugin_id = ? AND enabled = 1",
      ).get(id) as Row | null)?.count ?? 0),
      runtimeSummary: summary,
      createdBy: cleanString(row.created_by),
      archivedAt: cleanString(row.archived_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private toVersion(row: Row): MultiremiAgentPluginVersion {
    const digest = String(row.artifact_digest);
    return {
      id: String(row.id),
      pluginId: String(row.plugin_id),
      version: String(row.version),
      manifestPath: String(row.manifest_path),
      manifest: parseJson<Record<string, unknown>>(row.manifest, {}),
      files: parseJson<MultiremiAgentPluginArtifactFile[]>(row.artifact_files, []).map(({ content: _content, ...file }) => file),
      artifactDigest: digest,
      artifactUrl: artifactUrl(digest),
      artifactSize: Number(row.artifact_size ?? 0),
      sourceRevision: cleanString(row.source_revision),
      requirements: parseJson<Record<string, unknown>>(row.requirements, {}),
      metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
      createdBy: cleanString(row.created_by),
      createdAt: String(row.created_at),
    };
  }

  private toBinding(row: Row): MultiremiAgentPluginBinding {
    const plugin = this.requirePlugin(String(row.plugin_id), true);
    const agent = this.requireAgent(String(row.agent_id));
    this.assertAgentPluginCompatible(agent, plugin);
    const versionPolicy = row.version_policy === "pinned" ? "pinned" : "follow_active";
    const versionId = cleanString(row.version_id);
    const resolvedVersionId = versionPolicy === "pinned" ? versionId : plugin.activeVersionId;
    return {
      id: String(row.id),
      agentId: String(row.agent_id),
      pluginId: plugin.id,
      versionPolicy,
      versionId,
      resolvedVersionId,
      connectionId: cleanString(row.connection_id),
      config: parseJson<Record<string, unknown>>(row.config, {}),
      enabled: Number(row.enabled ?? 1) !== 0,
      plugin,
      resolvedVersion: resolvedVersionId ? this.getAgentPluginVersion(resolvedVersionId) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private toRuntimeState(row: Row): MultiremiAgentPluginRuntimeState {
    const plugin = this.requirePlugin(String(row.plugin_id), true);
    const version = this.requireVersion(String(row.plugin_version_id));
    const runtimeRow = this.ctx.db.query("SELECT * FROM multiremi_runtimes WHERE id = ?").get(String(row.runtime_id)) as Row;
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id ?? "local"),
      runtimeId: String(row.runtime_id),
      pluginId: plugin.id,
      pluginVersionId: version.id,
      desired: Number(row.desired ?? 1) !== 0,
      desiredReason: normalizeDesiredReason(row.desired_reason),
      status: normalizeRuntimeStatus(row.status),
      observedDigest: cleanString(row.observed_digest),
      retryCount: Number(row.retry_count ?? 0),
      retryGeneration: Number(row.retry_generation ?? 0),
      nextRetryAt: cleanString(row.next_retry_at),
      lastErrorCode: cleanString(row.last_error_code),
      lastError: cleanString(row.last_error),
      lastAttemptAt: cleanString(row.last_attempt_at),
      lastReadyAt: cleanString(row.last_ready_at),
      plugin,
      version,
      runtime: toRuntimeRef(runtimeRow) as MultiremiAgentPluginRuntimeState["runtime"],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
}

function artifactUrl(digest: string): string {
  return `/api/daemon/agent-plugin-artifacts/${digest}`;
}

function normalizeRuntimeStatus(value: unknown): MultiremiAgentPluginRuntimeStatus {
  const status = String(value ?? "pending") as MultiremiAgentPluginRuntimeStatus;
  if (!RUNTIME_STATUSES.has(status)) throw badRequest("invalid runtime plugin status", "invalid_runtime_plugin_status");
  return status;
}

function normalizeDesiredReason(value: unknown): MultiremiAgentPluginDesiredReason {
  if (value === "pinned_binding" || value === "candidate" || value === "task_snapshot") return value;
  return "active_binding";
}

function normalizeSourceTypeFromRow(value: unknown): MultiremiAgentPlugin["sourceType"] {
  if (value === "git" || value === "marketplace" || value === "zip" || value === "runtime") return value;
  return "manifest";
}

function normalizeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function toRuntimeRef(row: Row) {
  const now = String(row.updated_at ?? row.created_at ?? nowIso());
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    provider: String(row.provider ?? "any"),
    daemonId: cleanString(row.daemon_id),
    legacyDaemonId: cleanString(row.legacy_daemon_id),
    runtimeMode: String(row.runtime_mode ?? "local"),
    deviceInfo: String(row.device_info ?? ""),
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    workspaceId: cleanString(row.workspace_id),
    ownerId: cleanString(row.owner_id),
    visibility: row.visibility === "public" ? "public" as const : "private" as const,
    status: row.status === "offline" ? "offline" as const : "online" as const,
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
    lastHeartbeatAt: cleanString(row.last_heartbeat_at),
    createdAt: String(row.created_at ?? now),
    updatedAt: now,
  };
}

function cleanString(value: unknown): string | null {
  const string = typeof value === "string" ? value.trim() : "";
  return string || null;
}

function hasEither(value: object, camel: string, snake: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, camel) || Object.prototype.hasOwnProperty.call(value, snake);
}

function badRequest(message: string, code: string): AgentPluginStoreError {
  return new AgentPluginStoreError(message, code, 400);
}

function notFound(message: string, code: string): AgentPluginStoreError {
  return new AgentPluginStoreError(message, code, 404);
}

function conflict(message: string, code: string): AgentPluginStoreError {
  return new AgentPluginStoreError(message, code, 409);
}

function normalizeStoreError(error: unknown): Error {
  if (error instanceof AgentPluginStoreError) return error;
  if (error instanceof AgentPluginValidationError) return badRequest(error.message, error.code);
  if (isUniqueError(error)) return conflict("agent plugin already exists", "plugin_conflict");
  return error instanceof Error ? error : new Error(String(error));
}

function isUniqueError(error: unknown): boolean {
  const message = String((error as Error)?.message ?? error).toLowerCase();
  return message.includes("unique constraint") || message.includes("duplicate key") || message.includes("already exists");
}
