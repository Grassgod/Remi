// Agents + skills domain, extracted verbatim from MultiremiStore (facade delegates here).
// `listActiveAgentsByRuntime` lives here (rather than in RuntimesRepo) because it hydrates agent
// rows through this repo's private skill loader; RuntimesRepo reaches it via `ctx.agents()`.
import { createId, nowIso } from "@multiremi/ids.js";
import {
  cleanOptionalString,
  daemonRuntimeId,
  hasAnyField,
  isActiveTaskStatus,
  normalizeRuntimeConcurrency,
  nullableString,
  parseJson,
  toJson,
  uniqueRefMatch,
} from "@multiremi/store/helpers.js";
import { type StoreContext } from "@multiremi/store/context.js";
import type {
  CreateAgentInput,
  CreateSkillInput,
  MultiremiAgent,
  MultiremiSkill,
  MultiremiSkillFile,
  SetAgentSkillsInput,
  UpdateAgentInput,
  UpdateSkillInput,
} from "@multiremi/contracts/types.js";

type Row = Record<string, unknown>;

export class AgentsSkillsRepo {
  constructor(private ctx: StoreContext) {}

  createAgent(input: CreateAgentInput): MultiremiAgent {
    const id = input.id ?? createId("agt");
    const now = nowIso();
    const workspaceId = cleanOptionalString(input.workspaceId ?? input.workspace_id) ?? "local";
    const ownerId = cleanOptionalString(input.ownerId ?? input.owner_id) ?? "local";
    const visibility = normalizeAgentVisibility(input.visibility);
    const runtimeId = cleanOptionalString(input.runtimeId ?? input.runtime_id);
    return this.ctx.db.transaction(() => {
      this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
      if (runtimeId) this.assertRuntimeBinding(runtimeId, workspaceId);
      this.ctx.db.run(
        `INSERT INTO multiremi_agents (
          id, workspace_id, name, description, avatar_url, provider, owner_id, visibility, runtime_id, instructions, skills, cwd, executable, model,
          max_concurrent_tasks, allowed_tools, custom_env, custom_args, mcp_config, thinking_level,
          issue_creation_requires_proposal, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          workspaceId,
          input.name,
          input.description ?? "",
          input.avatarUrl ?? input.avatar_url ?? null,
          input.provider,
          ownerId,
          visibility,
          runtimeId,
          input.instructions ?? "",
          toJson(input.skills ?? []),
          input.cwd ?? null,
          input.executable ?? null,
          input.model ?? null,
          normalizeRuntimeConcurrency(input.maxConcurrentTasks ?? input.max_concurrent_tasks ?? 6),
          toJson(input.allowedTools ?? input.allowed_tools ?? []),
          toJson(input.customEnv ?? input.custom_env ?? {}),
          toJson(input.customArgs ?? input.custom_args ?? []),
          (input.mcpConfig ?? input.mcp_config) == null ? null : toJson(input.mcpConfig ?? input.mcp_config),
          input.thinkingLevel ?? input.thinking_level ?? null,
          Boolean(input.issueCreationRequiresProposal ?? input.issue_creation_requires_proposal) ? 1 : 0,
          now,
          now,
        ],
      );
      return this.getAgent(id)!;
    })();
  }

  updateAgent(id: string, input: UpdateAgentInput): MultiremiAgent {
    const initial = this.getAgent(id);
    if (!initial) throw new Error(`Agent not found: ${id}`);
    const requestedWorkspaceId = hasAnyField(input, "workspaceId", "workspace_id")
      ? cleanOptionalString(input.workspaceId ?? input.workspace_id) ?? "local"
      : initial.workspaceId;
    const workspaceIds = [...new Set([initial.workspaceId, requestedWorkspaceId])].sort();
    const transaction = this.ctx.db.transaction(() => {
      for (const workspaceId of workspaceIds) this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
      for (const workspaceId of workspaceIds) this.ctx.agentPlugins().lockAgentPluginWorkspace(workspaceId);
      this.lockAgentRow(id);
      const current = this.getAgent(id);
      if (!current) throw new Error(`Agent not found: ${id}`);
      const lockedRequestedWorkspaceId = hasAnyField(input, "workspaceId", "workspace_id")
        ? cleanOptionalString(input.workspaceId ?? input.workspace_id) ?? "local"
        : current.workspaceId;
      if (!workspaceIds.includes(current.workspaceId) || !workspaceIds.includes(lockedRequestedWorkspaceId)) {
        throw new Error("Agent workspace changed concurrently; retry the update");
      }
      return this.updateAgentWithinPluginLock(id, input);
    });
    return transaction();
  }

  private updateAgentWithinPluginLock(id: string, input: UpdateAgentInput): MultiremiAgent {
    const current = this.getAgent(id);
    if (!current) throw new Error(`Agent not found: ${id}`);
    const now = nowIso();
    const workspaceId = hasAnyField(input, "workspaceId", "workspace_id")
      ? cleanOptionalString(input.workspaceId ?? input.workspace_id) ?? "local"
      : current.workspaceId;
    if (workspaceId !== current.workspaceId) {
      this.ctx.agentPlugins().assertAgentPluginWorkspaceMoveAllowed(id, workspaceId);
    }
    const ownerId = hasAnyField(input, "ownerId", "owner_id")
      ? cleanOptionalString(input.ownerId ?? input.owner_id) ?? "local"
      : current.ownerId;
    const visibility = hasAnyField(input, "visibility")
      ? normalizeAgentVisibility(input.visibility)
      : current.visibility;
    const runtimeId = hasAnyField(input, "runtimeId", "runtime_id")
      ? cleanOptionalString(input.runtimeId ?? input.runtime_id)
      : current.runtimeId;
    if (runtimeId) this.assertRuntimeBinding(runtimeId, workspaceId);
    if (input.provider !== undefined && input.provider !== current.provider) {
      this.ctx.agentPlugins().assertAgentPluginProviderCompatible(id, input.provider);
    }
    this.ctx.db.run(
      `UPDATE multiremi_agents SET
        workspace_id = ?,
        name = ?,
        description = ?,
        avatar_url = ?,
        provider = ?,
        owner_id = ?,
        visibility = ?,
        runtime_id = ?,
        instructions = ?,
        skills = ?,
        cwd = ?,
        executable = ?,
        model = ?,
        max_concurrent_tasks = ?,
        allowed_tools = ?,
        custom_env = ?,
        custom_args = ?,
        mcp_config = ?,
        thinking_level = ?,
        issue_creation_requires_proposal = ?,
        updated_at = ?
       WHERE id = ?`,
      [
        workspaceId,
        input.name ?? current.name,
        hasAnyField(input, "description") ? input.description ?? "" : current.description,
        hasAnyField(input, "avatarUrl", "avatar_url")
          ? stringFieldOrCurrent(input.avatarUrl ?? input.avatar_url, current.avatarUrl)
          : current.avatarUrl,
        input.provider ?? current.provider,
        ownerId,
        visibility,
        runtimeId,
        input.instructions ?? current.instructions,
        input.skills === undefined ? toJson(current.skills) : toJson(input.skills),
        input.cwd === undefined ? current.cwd : input.cwd,
        input.executable === undefined ? current.executable : input.executable,
        input.model === undefined ? current.model : input.model,
        hasAnyField(input, "maxConcurrentTasks", "max_concurrent_tasks")
          ? normalizeRuntimeConcurrency(input.maxConcurrentTasks ?? input.max_concurrent_tasks)
          : current.maxConcurrentTasks,
        hasAnyField(input, "allowedTools", "allowed_tools")
          ? toJson(input.allowedTools ?? input.allowed_tools ?? [])
          : toJson(current.allowedTools),
        hasAnyField(input, "customEnv", "custom_env")
          ? toJson(input.customEnv ?? input.custom_env ?? {})
          : toJson(current.customEnv),
        hasAnyField(input, "customArgs", "custom_args")
          ? toJson(input.customArgs ?? input.custom_args ?? [])
          : toJson(current.customArgs),
        hasAnyField(input, "mcpConfig", "mcp_config")
          ? (input.mcpConfig ?? input.mcp_config) == null ? null : toJson(input.mcpConfig ?? input.mcp_config)
          : current.mcpConfig == null ? null : toJson(current.mcpConfig),
        hasAnyField(input, "thinkingLevel", "thinking_level")
          ? input.thinkingLevel ?? input.thinking_level ?? null
          : current.thinkingLevel,
        hasAnyField(input, "issueCreationRequiresProposal", "issue_creation_requires_proposal")
          ? Boolean(input.issueCreationRequiresProposal ?? input.issue_creation_requires_proposal) ? 1 : 0
          : current.issueCreationRequiresProposal ? 1 : 0,
        now,
        id,
      ],
    );
    const updated = this.getAgent(id)!;
    // Changing a scheduling-relevant field (engine, owner, or workspace)
    // strands the agent's already-queued tasks: a task pinned to a runtime
    // that no longer matches the agent (provider/owner) can't be claimed, and
    // a workspace change leaves the task's workspace stale versus the claim
    // predicate. Re-home them.
    const providerChanged = input.provider !== undefined && input.provider !== current.provider;
    const ownerChanged = (updated.ownerId ?? "local") !== (current.ownerId ?? "local");
    const workspaceChanged = updated.workspaceId !== current.workspaceId;
    if (providerChanged || ownerChanged || workspaceChanged) {
      this.rescheduleAgentQueuedTasks(updated, { workspaceChanged, providerChanged });
    }
    return updated;
  }

  private rescheduleAgentQueuedTasks(
    agent: MultiremiAgent,
    opts: { workspaceChanged: boolean; providerChanged: boolean },
  ): void {
    const now = nowIso();
    // A workspace move makes the agent's in-flight/queued tasks orphans: they
    // serve the OLD workspace's issues/chats/autopilots. Migrating their
    // workspace column would leave a task in wsB linked to a wsA issue/project
    // — a cross-tenant execution context. Cancel them via cancelTask so the
    // full terminal handling runs (cancelled_at, afterTaskTerminal, the
    // task:cancelled event, issue/autopilot-run wrap-up). Include dispatched
    // tasks: an agent workspace move must not leave one stuck in the old
    // workspace where nothing can reclaim it. The agent picks up fresh work in
    // its new workspace.
    if (opts.workspaceChanged) {
      const active = this.ctx.db
        .query("SELECT id FROM multiremi_tasks WHERE agent_id = ? AND status IN ('queued', 'dispatched', 'waiting_local_directory')")
        .all(agent.id) as Row[];
      for (const row of active) this.ctx.tasks().cancelTask(String(row.id));
      return;
    }
    if (opts.providerChanged) {
      // A frozen retry belongs to the provider and Plugin snapshot captured by
      // its parent execution. It cannot be safely re-homed to a different
      // provider using the Agent's now-mutated executable/config. Cancel work
      // that has not started; an explicit rerun will resolve current settings.
      const frozen = this.ctx.db.query(
        `SELECT id FROM multiremi_tasks
         WHERE agent_id = ?
           AND execution_fingerprint IS NOT NULL
           AND status IN ('queued', 'dispatched', 'waiting_local_directory')`,
      ).all(agent.id) as Row[];
      for (const row of frozen) this.ctx.tasks().cancelTask(String(row.id));
    }
    // Include tasks with only a session/work_dir (no runtime pin) — a chat
    // send can queue a task carrying the promoted provider session without a
    // runtime stamp, and that session is also void after an engine/owner change.
    const rows = this.ctx.db
      .query(
        "SELECT * FROM multiremi_tasks WHERE agent_id = ? AND status = 'queued' AND (runtime_id IS NOT NULL OR session_id IS NOT NULL)",
      )
      .all(agent.id) as Row[];
    for (const row of rows) {
      const daemonId = this.ctx.localDirectoryDaemonForTask(row);
      if (daemonId) {
        // local_directory task: keep it on the machine that holds the
        // directory, under the runtime id for the agent's current provider.
        // Drop the provider session — an engine/owner change invalidates it —
        // while keeping work_dir (the directory itself is unchanged).
        const rt = this.ctx.runtimes().getRuntimeByDaemonAndProvider(daemonId, agent.provider);
        const newRuntimeId = rt ? rt.id : daemonRuntimeId(daemonId, agent.provider);
        this.ctx.db.run(
          "UPDATE multiremi_tasks SET runtime_id = ?, session_id = NULL, updated_at = ? WHERE id = ?",
          [newRuntimeId, now, String(row.id)],
        );
      } else {
        // Session/other pin: the old session is void — re-pool it.
        this.ctx.db.run(
          "UPDATE multiremi_tasks SET runtime_id = NULL, session_id = NULL, work_dir = NULL, updated_at = ? WHERE id = ?",
          [now, String(row.id)],
        );
      }
    }
  }

  archiveAgent(id: string): MultiremiAgent {
    const now = nowIso();
    const affectedProjects: Array<{ id: string; workspace_id: string }> = [];
    const initial = this.getAgent(id);
    if (!initial) throw new Error(`Agent not found: ${id}`);
    const tx = this.ctx.db.transaction(() => {
      this.ctx.lockWorkspaceRuntimeLifecycle(initial.workspaceId);
      this.ctx.agentPlugins().lockAgentPluginWorkspace(initial.workspaceId);
      this.lockAgentRow(id);
      const agent = this.getAgent(id);
      if (!agent) throw new Error(`Agent not found: ${id}`);
      if (agent.workspaceId !== initial.workspaceId) {
        throw new Error("Agent workspace changed concurrently; retry the archive");
      }
      affectedProjects.push(...this.ctx.db.query(
        `SELECT id, workspace_id FROM multiremi_projects
         WHERE default_assignee_type = 'agent' AND default_assignee_id = ?`,
      ).all(id) as Array<{ id: string; workspace_id: string }>);
      this.ctx.db.run("UPDATE multiremi_agents SET archived_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
      this.ctx.db.run(
        `UPDATE multiremi_projects
         SET default_assignee_type = NULL, default_assignee_id = NULL, updated_at = ?
         WHERE default_assignee_type = 'agent' AND default_assignee_id = ?`,
        [now, id],
      );
      this.ctx.agentPlugins().reconcileAgentPluginDesiredStateWithinLock(agent.workspaceId);
    });
    tx();
    this.publishClearedProjectDefaults(affectedProjects, now);
    return this.getAgent(id)!;
  }

  private assertRuntimeBinding(runtimeId: string, workspaceId: string): void {
    const runtime = this.ctx.runtimes().getRuntime(runtimeId);
    if (!runtime || (runtime.workspaceId ?? "local") !== workspaceId) {
      throw new Error(`Runtime not found: ${runtimeId}`);
    }
  }

  private publishClearedProjectDefaults(
    projects: Array<{ id: string; workspace_id: string }>,
    updatedAt: string,
  ): void {
    for (const project of projects) {
      this.ctx.emitWorkspaceEvent({
        type: "project:updated",
        workspaceId: project.workspace_id,
        actorType: "system",
        actorId: null,
        payload: {
          project: {
            id: project.id,
            default_assignee_type: null,
            default_assignee_id: null,
            updated_at: updatedAt,
          },
        },
      });
    }
  }

  restoreAgent(id: string): MultiremiAgent {
    const now = nowIso();
    const initial = this.getAgent(id);
    if (!initial) throw new Error(`Agent not found: ${id}`);
    this.ctx.db.transaction(() => {
      this.ctx.lockWorkspaceRuntimeLifecycle(initial.workspaceId);
      this.ctx.agentPlugins().lockAgentPluginWorkspace(initial.workspaceId);
      this.lockAgentRow(id);
      const row = this.ctx.db.query("SELECT id, workspace_id FROM multiremi_agents WHERE id = ?").get(id) as Row | null;
      if (!row) throw new Error(`Agent not found: ${id}`);
      const workspaceId = String(row.workspace_id ?? "local");
      if (workspaceId !== initial.workspaceId) {
        throw new Error("Agent workspace changed concurrently; retry the restore");
      }
      this.ctx.db.run("UPDATE multiremi_agents SET archived_at = NULL, updated_at = ? WHERE id = ?", [now, id]);
      this.ctx.agentPlugins().reconcileAgentPluginDesiredStateWithinLock(workspaceId);
    })();
    return this.getAgent(id)!;
  }

  private lockAgentRow(id: string): void {
    // PostgreSQL takes a row lock for this no-op UPDATE; SQLite serializes the
    // containing write transaction. Read workspace_id only after this point.
    this.ctx.db.run("UPDATE multiremi_agents SET updated_at = updated_at WHERE id = ?", [id]);
  }

  cancelAgentTasks(agentId: string): number {
    if (!this.ctx.db.query("SELECT id FROM multiremi_agents WHERE id = ?").get(agentId)) throw new Error(`Agent not found: ${agentId}`);
    let cancelled = 0;
    for (const task of this.ctx.tasks().listAgentTasks(agentId)) {
      if (isActiveTaskStatus(task.status)) {
        this.ctx.tasks().cancelTask(task.id);
        cancelled += 1;
      }
    }
    return cancelled;
  }

  createSkill(input: CreateSkillInput): MultiremiSkill {
    return this.ctx.db.transaction(() => this.createSkillWithinTransaction(input))();
  }

  /** Caller already owns the transaction that protects the importing Runtime. */
  createSkillWithinTransaction(input: CreateSkillInput): MultiremiSkill {
    const name = input.name?.trim();
    if (!name) throw new Error("Skill name is required");
    const id = input.id ?? createId("skl");
    const workspaceId = input.workspaceId ?? input.workspace_id ?? "local";
    const now = nowIso();
    const files = normalizeSkillFiles(input.files ?? []);
    this.ctx.db.run(
      `INSERT INTO multiremi_skills (
        id, workspace_id, name, description, content, config, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        workspaceId,
        name,
        input.description ?? "",
        input.content ?? "",
        toJson(input.config ?? {}),
        input.createdBy ?? input.created_by ?? null,
        now,
        now,
      ],
    );
    this.replaceSkillFiles(id, files, now);
    return this.getSkill(id)!;
  }

  updateSkill(id: string, input: UpdateSkillInput): MultiremiSkill {
    const current = this.getSkill(id);
    if (!current) throw new Error(`Skill not found: ${id}`);
    const now = nowIso();
    const nextName = input.name === undefined ? current.name : input.name.trim();
    if (!nextName) throw new Error("Skill name is required");
    this.ctx.db.transaction(() => {
      this.ctx.db.run(
        `UPDATE multiremi_skills SET
          workspace_id = ?,
          name = ?,
          description = ?,
          content = ?,
          config = ?,
          created_by = ?,
          updated_at = ?
         WHERE id = ?`,
        [
          input.workspaceId ?? input.workspace_id ?? current.workspaceId ?? "local",
          nextName,
          input.description ?? current.description ?? "",
          input.content ?? current.content ?? "",
          input.config === undefined ? toJson(current.config ?? {}) : toJson(input.config ?? {}),
          input.createdBy ?? input.created_by ?? current.createdBy ?? null,
          now,
          id,
        ],
      );
      if (input.files !== undefined) this.replaceSkillFiles(id, normalizeSkillFiles(input.files), now);
    })();
    return this.getSkill(id)!;
  }

  upsertSkill(input: CreateSkillInput & { id: string }): MultiremiSkill {
    const existing = this.getSkill(input.id, { includeArchived: true });
    if (!existing) return this.createSkill(input);

    const nextName = input.name?.trim();
    if (!nextName) throw new Error("Skill name is required");
    const now = nowIso();
    this.ctx.db.transaction(() => {
      this.ctx.db.run(
        `UPDATE multiremi_skills SET
          workspace_id = ?,
          name = ?,
          description = ?,
          content = ?,
          config = ?,
          created_by = ?,
          archived_at = NULL,
          updated_at = ?
         WHERE id = ?`,
        [
          input.workspaceId ?? input.workspace_id ?? existing.workspaceId ?? "local",
          nextName,
          input.description ?? existing.description ?? "",
          input.content ?? existing.content ?? "",
          input.config === undefined ? toJson(existing.config ?? {}) : toJson(input.config ?? {}),
          input.createdBy ?? input.created_by ?? existing.createdBy ?? null,
          now,
          input.id,
        ],
      );
      if (input.files !== undefined) this.replaceSkillFiles(input.id, normalizeSkillFiles(input.files), now);
    })();
    return this.getSkill(input.id)!;
  }

  archiveSkill(id: string): MultiremiSkill {
    const current = this.getSkill(id);
    if (!current) throw new Error(`Skill not found: ${id}`);
    const now = nowIso();
    this.ctx.db.run("UPDATE multiremi_skills SET archived_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
    return this.getSkill(id, { includeArchived: true })!;
  }

  listSkills(workspaceId?: string | null, options: { includeArchived?: boolean; includeFiles?: boolean } = {}): MultiremiSkill[] {
    const archivedFilter = options.includeArchived ? "" : " AND archived_at IS NULL";
    const rows = workspaceId
      ? this.ctx.db.query(`SELECT * FROM multiremi_skills WHERE workspace_id = ?${archivedFilter} ORDER BY created_at DESC`).all(workspaceId) as Row[]
      : this.ctx.db.query(`SELECT * FROM multiremi_skills WHERE 1 = 1${archivedFilter} ORDER BY created_at DESC`).all() as Row[];
    return rows.map((row) => toSkill(row, options.includeFiles ? this.listSkillFiles(String(row.id)) : []));
  }

  getSkill(id: string, options: { includeArchived?: boolean; includeFiles?: boolean } = { includeFiles: true }): MultiremiSkill | null {
    const row = this.ctx.db.query(
      `SELECT * FROM multiremi_skills WHERE id = ?${options.includeArchived ? "" : " AND archived_at IS NULL"}`,
    ).get(id) as Row | null;
    return row ? toSkill(row, options.includeFiles === false ? [] : this.listSkillFiles(id, { includeArchived: options.includeArchived })) : null;
  }

  listSkillFiles(skillId: string, options: { includeArchived?: boolean } = {}): MultiremiSkillFile[] {
    const archivedFilter = options.includeArchived ? "" : " AND archived_at IS NULL";
    if (!this.ctx.db.query(`SELECT id FROM multiremi_skills WHERE id = ?${archivedFilter}`).get(skillId)) {
      throw new Error(`Skill not found: ${skillId}`);
    }
    const rows = this.ctx.db.query("SELECT * FROM multiremi_skill_files WHERE skill_id = ? ORDER BY path ASC").all(skillId) as Row[];
    return rows.map(toSkillFile);
  }

  upsertSkillFile(skillId: string, file: MultiremiSkillFile): MultiremiSkillFile {
    if (!this.ctx.db.query("SELECT id FROM multiremi_skills WHERE id = ? AND archived_at IS NULL").get(skillId)) {
      throw new Error(`Skill not found: ${skillId}`);
    }
    const normalized = normalizeSkillFiles([file])[0]!;
    const existing = this.ctx.db.query(
      "SELECT * FROM multiremi_skill_files WHERE skill_id = ? AND path = ?",
    ).get(skillId, normalized.path) as Row | null;
    const id = existing ? String(existing.id) : file.id ?? createId("skf");
    const createdAt = existing ? String(existing.created_at) : nowIso();
    const updatedAt = nowIso();
    this.ctx.db.run(
      `INSERT INTO multiremi_skill_files (id, skill_id, path, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(skill_id, path) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
      [id, skillId, normalized.path, normalized.content, createdAt, updatedAt],
    );
    const row = this.ctx.db.query("SELECT * FROM multiremi_skill_files WHERE skill_id = ? AND path = ?")
      .get(skillId, normalized.path) as Row | null;
    return toSkillFile(row!);
  }

  deleteSkillFile(skillId: string, fileId: string): boolean {
    if (!this.ctx.db.query("SELECT id FROM multiremi_skills WHERE id = ? AND archived_at IS NULL").get(skillId)) {
      throw new Error(`Skill not found: ${skillId}`);
    }
    const result = this.ctx.db.run("DELETE FROM multiremi_skill_files WHERE skill_id = ? AND id = ?", [skillId, fileId]);
    return result.changes > 0;
  }

  listAgentSkills(agentId: string, options: { includeFiles?: boolean } = { includeFiles: true }): MultiremiSkill[] {
    const row = this.ctx.db.query("SELECT * FROM multiremi_agents WHERE id = ?").get(agentId) as Row | null;
    if (!row) throw new Error(`Agent not found: ${agentId}`);
    const agent = toAgent(row);
    const rows = this.ctx.db.query(
      `SELECT s.*
       FROM multiremi_skills s
       JOIN multiremi_agent_skills aks ON aks.skill_id = s.id
       WHERE aks.agent_id = ? AND s.archived_at IS NULL
       ORDER BY aks.created_at ASC, s.name ASC`,
    ).all(agentId) as Row[];
    const structured = rows.map((row) => toSkill(row, options.includeFiles === false ? [] : this.listSkillFiles(String(row.id))));
    return mergeAgentSkills(agent.skills, structured);
  }

  setAgentSkills(agentId: string, input: SetAgentSkillsInput | string[]): MultiremiSkill[] {
    if (!this.ctx.db.query("SELECT id FROM multiremi_agents WHERE id = ?").get(agentId)) throw new Error(`Agent not found: ${agentId}`);
    const skillIds = Array.isArray(input) ? input : input.skillIds ?? input.skill_ids ?? [];
    const now = nowIso();
    this.ctx.db.transaction(() => {
      this.ctx.db.run("DELETE FROM multiremi_agent_skills WHERE agent_id = ?", [agentId]);
      for (const skillId of skillIds) {
        const skill = this.getSkill(skillId);
        if (!skill) throw new Error(`Skill not found: ${skillId}`);
        this.ctx.db.run(
          "INSERT OR IGNORE INTO multiremi_agent_skills (agent_id, skill_id, created_at) VALUES (?, ?, ?)",
          [agentId, skillId, now],
        );
      }
    })();
    return this.listAgentSkills(agentId);
  }

  ensureDefaultAgent(
    provider = "claude",
    options: {
      workspaceId?: string | null;
      ownerId?: string | null;
      issueCreationRequiresProposal?: boolean;
    } = {},
  ): MultiremiAgent {
    const workspaceId = cleanOptionalString(options.workspaceId) ?? "local";
    const ownerId = cleanOptionalString(options.ownerId) ?? "local";
    const existing = this.getDefaultAgent(workspaceId, provider, ownerId);
    if (existing) {
      if (existing.archivedAt) {
        this.ctx.db.run("UPDATE multiremi_agents SET archived_at = NULL, updated_at = ? WHERE id = ?", [nowIso(), existing.id]);
        return this.getAgent(existing.id)!;
      }
      return existing;
    }
    // Per-owner default agent: each member gets their own, owned by them. This
    // is what lets a member's PRIVATE runtime run their default/onboarding task
    // (the claim ownership predicate requires runtime owner == agent owner) —
    // a single workspace-shared default owned by whoever created it first would
    // be rejected by every other member's private machine. It also means the
    // /agents/default endpoint can never hand one member another member's
    // default agent (with its custom_env / mcp_config). Walk past any taken id
    // (legacy/imported rows) so createAgent can't hit a UNIQUE violation.
    const base = `agt_default_${safeIdSegment(workspaceId)}_${provider}_${safeIdSegment(ownerId)}`;
    let id = base;
    for (let n = 2; this.getAgent(id); n += 1) id = `${base}_${n}`;
    return this.createAgent({
      id,
      name: provider === "codex" ? "Codex" : "Claude",
      description: provider === "codex" ? "Default Codex agent" : "Default Claude agent",
      provider,
      workspaceId,
      ownerId,
      issueCreationRequiresProposal: options.issueCreationRequiresProposal ?? false,
      instructions: "You are an autonomous coding agent. Complete the task and report the result clearly.",
    });
  }

  /**
   * Find a member's default agent for a provider. Matches legacy ids too
   * (`agt_default_<provider>`, `agt_default_<ws>_<provider>`) so pre-pool
   * deployments reuse their default agent instead of growing a twin. Scoped to
   * `ownerId` (exact match) — default agents are per-owner, so this never
   * returns another member's default agent (with its custom_env / mcp_config).
   */
  getDefaultAgent(workspaceId: string, provider: string, ownerId: string): MultiremiAgent | null {
    const row = this.ctx.db.query(
      `SELECT * FROM multiremi_agents
       WHERE id LIKE 'agt_default_%' AND workspace_id = ? AND provider = ? AND owner_id = ?
       ORDER BY archived_at IS NOT NULL, created_at ASC LIMIT 1`,
    ).get(workspaceId, provider, ownerId) as Row | null;
    return row ? this.hydrateAgent(toAgent(row)) : null;
  }

  getAgent(id: string): MultiremiAgent | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_agents WHERE id = ?").get(id) as Row | null;
    return row ? this.hydrateAgent(toAgent(row)) : null;
  }

  getAgentByWorkspaceAndName(workspaceId: string, name: string): MultiremiAgent | null {
    const row = this.ctx.db
      .query("SELECT * FROM multiremi_agents WHERE workspace_id = ? AND name = ? ORDER BY created_at ASC LIMIT 1")
      .get(workspaceId, name) as Row | null;
    return row ? this.hydrateAgent(toAgent(row)) : null;
  }

  getAgentByRef(ref: string, workspaceId?: string | null): MultiremiAgent | null {
    const value = ref.trim();
    if (!value) return null;
    const exact = this.getAgent(value);
    if (exact && !exact.archivedAt && (!workspaceId || exact.workspaceId === workspaceId)) return exact;
    return uniqueRefMatch(
      this.listAgents().filter((agent) => !workspaceId || agent.workspaceId === workspaceId),
      value,
      (agent) => agent.id,
      (agent) => [agent.name],
    );
  }

  listAgents(options: { includeArchived?: boolean } = {}): MultiremiAgent[] {
    const rows = this.ctx.db.query(options.includeArchived
      ? "SELECT * FROM multiremi_agents ORDER BY created_at ASC"
      : "SELECT * FROM multiremi_agents WHERE archived_at IS NULL ORDER BY created_at ASC").all() as Row[];
    return rows.map((row) => this.hydrateAgent(toAgent(row)));
  }

  listActiveAgentsByRuntime(runtimeId: string): MultiremiAgent[] {
    if (!this.ctx.runtimes().getRuntime(runtimeId)) throw new Error(`Runtime not found: ${runtimeId}`);
    const rows = this.ctx.db.query(
      `SELECT * FROM multiremi_agents
       WHERE runtime_id = ? AND archived_at IS NULL
       ORDER BY lower(name) ASC, name ASC`,
    ).all(runtimeId) as Row[];
    return rows.map((row) => this.hydrateAgent(toAgent(row)));
  }

  hydrateAgent(agent: MultiremiAgent): MultiremiAgent {
    return {
      ...agent,
      skills: this.listAgentSkillsForExistingAgent(agent),
    };
  }

  private listAgentSkillsForExistingAgent(agent: MultiremiAgent): MultiremiSkill[] {
    const rows = this.ctx.db.query(
      `SELECT s.*
       FROM multiremi_skills s
       JOIN multiremi_agent_skills aks ON aks.skill_id = s.id
       WHERE aks.agent_id = ? AND s.archived_at IS NULL
       ORDER BY aks.created_at ASC, s.name ASC`,
    ).all(agent.id) as Row[];
    const structured = rows.map((row) => toSkill(row, this.listSkillFiles(String(row.id))));
    return mergeAgentSkills(agent.skills, structured);
  }

  private replaceSkillFiles(skillId: string, files: MultiremiSkillFile[], now = nowIso()): void {
    this.ctx.db.run("DELETE FROM multiremi_skill_files WHERE skill_id = ?", [skillId]);
    for (const file of files) {
      this.ctx.db.run(
        `INSERT INTO multiremi_skill_files (
          id, skill_id, path, content, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(skill_id, path) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
        [file.id ?? createId("skf"), skillId, file.path, file.content, now, now],
      );
    }
  }
}

function normalizeSkillFiles(files: MultiremiSkillFile[]): MultiremiSkillFile[] {
  return files.map((file) => {
    const path = normalizeSkillFilePath(file.path);
    return { path, content: String(file.content ?? "") };
  });
}

function normalizeSkillFilePath(path: string): string {
  const rawPath = String(path ?? "").replace(/\\/g, "/");
  const normalized = cleanRelativePath(rawPath);
  if (!normalized || rawPath.startsWith("/") || normalized === "." || normalized.startsWith("..")) {
    throw new Error(`Invalid skill file path: ${path}`);
  }
  if (normalized.toLowerCase() === "skill.md") throw new Error("Skill files should not include SKILL.md");
  return normalized;
}

function cleanRelativePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") {
        parts.pop();
      } else {
        parts.push("..");
      }
      continue;
    }
    parts.push(part);
  }
  return parts.length ? parts.join("/") : ".";
}

function mergeAgentSkills(inlineSkills: MultiremiSkill[], structuredSkills: MultiremiSkill[]): MultiremiSkill[] {
  const seen = new Set<string>();
  const merged: MultiremiSkill[] = [];
  for (const skill of [...structuredSkills, ...inlineSkills]) {
    const key = skill.id ?? skill.name;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(skill);
  }
  return merged;
}

function stringFieldOrCurrent(value: unknown, current: string | null): string | null {
  return typeof value === "string" ? value : current;
}

function normalizeAgentVisibility(value: unknown): MultiremiAgent["visibility"] {
  const visibility = String(value ?? "private").trim().toLowerCase();
  if (visibility === "private" || visibility === "workspace") return visibility;
  throw new Error("visibility must be private or workspace");
}

function safeIdSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "local";
}

export function toAgent(row: Row): MultiremiAgent {
  const workspaceId = String(row.workspace_id ?? "local");
  const ownerId = String(row.owner_id ?? "local");
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description ?? ""),
    avatarUrl: nullableString(row.avatar_url),
    avatar_url: nullableString(row.avatar_url),
    provider: String(row.provider),
    workspaceId,
    workspace_id: workspaceId,
    ownerId,
    owner_id: ownerId,
    visibility: normalizeAgentVisibility(row.visibility),
    runtimeId: nullableString(row.runtime_id),
    runtime_id: nullableString(row.runtime_id),
    instructions: String(row.instructions ?? ""),
    skills: parseJson(row.skills, []),
    maxConcurrentTasks: Number(row.max_concurrent_tasks ?? 6),
    max_concurrent_tasks: Number(row.max_concurrent_tasks ?? 6),
    cwd: nullableString(row.cwd),
    executable: nullableString(row.executable),
    model: nullableString(row.model),
    allowedTools: parseJson(row.allowed_tools, []),
    customEnv: parseJson(row.custom_env, {}),
    customArgs: parseJson(row.custom_args, []),
    mcpConfig: row.mcp_config == null ? null : parseJson(row.mcp_config, null),
    thinkingLevel: nullableString(row.thinking_level),
    issueCreationRequiresProposal: Boolean(Number(row.issue_creation_requires_proposal ?? 0)),
    issue_creation_requires_proposal: Boolean(Number(row.issue_creation_requires_proposal ?? 0)),
    archivedAt: nullableString(row.archived_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toSkill(row: Row, files: MultiremiSkillFile[] = []): MultiremiSkill {
  const config = parseJson<Record<string, unknown>>(row.config, {});
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    name: String(row.name ?? ""),
    description: String(row.description ?? ""),
    content: String(row.content ?? ""),
    config,
    files,
    createdBy: nullableString(row.created_by),
    archivedAt: nullableString(row.archived_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toSkillFile(row: Row): MultiremiSkillFile {
  return {
    id: String(row.id),
    skillId: String(row.skill_id),
    path: String(row.path ?? ""),
    content: String(row.content ?? ""),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
