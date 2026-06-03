import type { Database } from "bun:sqlite";
import { getDb } from "../db/index.js";
import { createId, nowIso } from "./ids.js";
import type {
  AddSquadMemberInput,
  AssignIssueInput,
  AssignIssueResult,
  CreateAgentInput,
  CreateAutopilotInput,
  CreateChatSessionInput,
  CreateAttachmentInput,
  CreateIssueDependencyInput,
  CreateIssueCommentInput,
  CreateIssueInput,
  CreateLabelInput,
  CreatePinnedItemInput,
  CreateProjectInput,
  CreateProjectResourceInput,
  CreateSquadInput,
  CreateTaskInput,
  CreateWorkspaceMemberInput,
  MulticaAutopilot,
  MulticaAutopilotRun,
  MulticaAgent,
  MulticaAssigneeType,
  MulticaAttachment,
  MulticaChatMessage,
  MulticaChatSession,
  MulticaCommentReaction,
  MulticaInboxItem,
  MulticaIssueActivity,
  MulticaIssueChildProgress,
  MulticaIssueComment,
  MulticaIssueDependency,
  MulticaIssueDependencyType,
  MulticaIssue,
  MulticaIssuePriority,
  MulticaIssueSearchResult,
  MulticaLabel,
  MulticaPinnedItem,
  MulticaPinnedItemType,
  MulticaIssueReaction,
  MulticaIssueSubscriber,
  MulticaIssueWithTasks,
  MulticaProject,
  MulticaProjectResource,
  MulticaProjectSearchResult,
  MulticaRuntime,
  MulticaRuntimeDaily,
  MulticaRuntimeVisibility,
  MulticaRuntimeUsage,
  MulticaSquad,
  MulticaSquadMember,
  MulticaTask,
  MulticaTaskActivityByHour,
  MulticaTaskMessage,
  MulticaTaskStatus,
  MulticaTaskWithAgent,
  MulticaSubscriptionReason,
  MulticaUsageByAgent,
  MulticaUsageByHour,
  MulticaUsageDaily,
  MulticaWorkspaceMember,
  RegisterRuntimeInput,
  ReorderPinnedItemInput,
  RemoveSquadMemberInput,
  RunAutopilotInput,
  SendChatMessageInput,
  SendChatMessageResult,
  TaskMessageInput,
  TaskUsageEntry,
  UpdateAgentInput,
  UpdateAutopilotInput,
  UpdateChatSessionInput,
  UpdateIssueInput,
  UpdateIssueCommentInput,
  UpdateLabelInput,
  UpdateProjectInput,
  UpdateRuntimeInput,
  UpdateSquadInput,
  UpdateWorkspaceMemberInput,
} from "./types.js";

const TERMINAL_STATUSES: MulticaTaskStatus[] = ["completed", "failed", "cancelled"];
const RUNTIME_HEARTBEAT_STALE_MS = 5 * 60 * 1000;
const MAX_ISSUE_METADATA_KEYS = 50;
const ISSUE_METADATA_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/;

export class MulticaStore {
  private db: Database;

  constructor(db?: Database) {
    this.db = db ?? getDb();
    this.migrate();
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS multica_agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        instructions TEXT NOT NULL DEFAULT '',
        skills TEXT NOT NULL DEFAULT '[]',
        cwd TEXT,
        executable TEXT,
        model TEXT,
        allowed_tools TEXT NOT NULL DEFAULT '[]',
        custom_env TEXT NOT NULL DEFAULT '{}',
        custom_args TEXT NOT NULL DEFAULT '[]',
        mcp_config TEXT,
        thinking_level TEXT,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS multica_runtimes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        workspace_id TEXT,
        owner_id TEXT,
        visibility TEXT NOT NULL DEFAULT 'private',
        status TEXT NOT NULL DEFAULT 'online',
        max_concurrency INTEGER NOT NULL DEFAULT 1,
        last_heartbeat_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS multica_workspace_members (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'local',
        name TEXT NOT NULL,
        email TEXT,
        role TEXT NOT NULL DEFAULT 'member',
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_multica_workspace_members_workspace ON multica_workspace_members(workspace_id);

      CREATE TABLE IF NOT EXISTS multica_issues (
        id TEXT PRIMARY KEY,
        issue_number INTEGER NOT NULL DEFAULT 0,
        issue_key TEXT,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        priority TEXT NOT NULL DEFAULT 'none',
        workspace_id TEXT NOT NULL DEFAULT 'local',
        project_id TEXT,
        parent_issue_id TEXT,
        assignee_type TEXT,
        assignee_id TEXT,
        position REAL NOT NULL DEFAULT 0,
        start_date TEXT,
        due_date TEXT,
        acceptance_criteria TEXT NOT NULL DEFAULT '[]',
        context_refs TEXT NOT NULL DEFAULT '[]',
        metadata TEXT NOT NULL DEFAULT '{}',
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(parent_issue_id) REFERENCES multica_issues(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS multica_issue_comments (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        author_type TEXT NOT NULL DEFAULT 'member',
        author_id TEXT,
        parent_id TEXT,
        body TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by_type TEXT,
        resolved_by_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(issue_id) REFERENCES multica_issues(id) ON DELETE CASCADE,
        FOREIGN KEY(parent_id) REFERENCES multica_issue_comments(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_multica_issue_comments_issue ON multica_issue_comments(issue_id, created_at);

      CREATE TABLE IF NOT EXISTS multica_issue_activity (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        actor_type TEXT NOT NULL DEFAULT 'system',
        actor_id TEXT,
        type TEXT NOT NULL,
        body TEXT,
        data TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(issue_id) REFERENCES multica_issues(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_multica_issue_activity_issue ON multica_issue_activity(issue_id, created_at);

      CREATE TABLE IF NOT EXISTS multica_issue_dependencies (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'local',
        issue_id TEXT NOT NULL,
        depends_on_issue_id TEXT NOT NULL,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(issue_id, depends_on_issue_id, type),
        FOREIGN KEY(issue_id) REFERENCES multica_issues(id) ON DELETE CASCADE,
        FOREIGN KEY(depends_on_issue_id) REFERENCES multica_issues(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_multica_issue_dependencies_issue ON multica_issue_dependencies(issue_id, type);
      CREATE INDEX IF NOT EXISTS idx_multica_issue_dependencies_depends_on ON multica_issue_dependencies(depends_on_issue_id, type);
      CREATE INDEX IF NOT EXISTS idx_multica_issue_dependencies_workspace ON multica_issue_dependencies(workspace_id);

      CREATE TABLE IF NOT EXISTS multica_issue_subscribers (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL,
        UNIQUE(issue_id, member_id),
        FOREIGN KEY(issue_id) REFERENCES multica_issues(id) ON DELETE CASCADE,
        FOREIGN KEY(member_id) REFERENCES multica_workspace_members(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_multica_issue_subscribers_issue ON multica_issue_subscribers(issue_id);
      CREATE INDEX IF NOT EXISTS idx_multica_issue_subscribers_member ON multica_issue_subscribers(member_id);

      CREATE TABLE IF NOT EXISTS multica_inbox_items (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'local',
        issue_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        actor_type TEXT NOT NULL DEFAULT 'system',
        actor_id TEXT,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT,
        read INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY(issue_id) REFERENCES multica_issues(id) ON DELETE CASCADE,
        FOREIGN KEY(member_id) REFERENCES multica_workspace_members(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_multica_inbox_member ON multica_inbox_items(member_id, archived, read, created_at);

      CREATE TABLE IF NOT EXISTS multica_issue_labels (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'local',
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_multica_issue_labels_workspace_name
        ON multica_issue_labels(workspace_id, lower(name));
      CREATE INDEX IF NOT EXISTS idx_multica_issue_labels_workspace
        ON multica_issue_labels(workspace_id, name);

      CREATE TABLE IF NOT EXISTS multica_issue_to_labels (
        issue_id TEXT NOT NULL,
        label_id TEXT NOT NULL,
        PRIMARY KEY(issue_id, label_id),
        FOREIGN KEY(issue_id) REFERENCES multica_issues(id) ON DELETE CASCADE,
        FOREIGN KEY(label_id) REFERENCES multica_issue_labels(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_multica_issue_to_labels_label ON multica_issue_to_labels(label_id);

      CREATE TABLE IF NOT EXISTS multica_issue_reactions (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL DEFAULT 'local',
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        emoji TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(issue_id, actor_type, actor_id, emoji),
        FOREIGN KEY(issue_id) REFERENCES multica_issues(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_multica_issue_reactions_issue ON multica_issue_reactions(issue_id);

      CREATE TABLE IF NOT EXISTS multica_comment_reactions (
        id TEXT PRIMARY KEY,
        comment_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL DEFAULT 'local',
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        emoji TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(comment_id, actor_type, actor_id, emoji),
        FOREIGN KEY(comment_id) REFERENCES multica_issue_comments(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_multica_comment_reactions_comment ON multica_comment_reactions(comment_id);

      CREATE TABLE IF NOT EXISTS multica_attachments (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'local',
        issue_id TEXT,
        comment_id TEXT,
        uploader_type TEXT NOT NULL DEFAULT 'member',
        uploader_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        url TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY(issue_id) REFERENCES multica_issues(id) ON DELETE CASCADE,
        FOREIGN KEY(comment_id) REFERENCES multica_issue_comments(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_multica_attachments_issue ON multica_attachments(issue_id);
      CREATE INDEX IF NOT EXISTS idx_multica_attachments_comment ON multica_attachments(comment_id);
      CREATE INDEX IF NOT EXISTS idx_multica_attachments_workspace ON multica_attachments(workspace_id);

      CREATE TABLE IF NOT EXISTS multica_projects (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        icon TEXT,
        status TEXT NOT NULL DEFAULT 'planned',
        priority TEXT NOT NULL DEFAULT 'none',
        workspace_id TEXT NOT NULL DEFAULT 'local',
        lead_type TEXT,
        lead_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_multica_projects_workspace ON multica_projects(workspace_id);

      CREATE TABLE IF NOT EXISTS multica_project_resources (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL DEFAULT 'local',
        resource_type TEXT NOT NULL,
        resource_ref TEXT NOT NULL DEFAULT '{}',
        label TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        created_by TEXT,
        UNIQUE(project_id, resource_type, resource_ref),
        FOREIGN KEY(project_id) REFERENCES multica_projects(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_multica_project_resources_project ON multica_project_resources(project_id, position);

      CREATE TABLE IF NOT EXISTS multica_pinned_items (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'local',
        user_id TEXT NOT NULL DEFAULT 'local',
        item_type TEXT NOT NULL,
        item_id TEXT NOT NULL,
        position REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        UNIQUE(workspace_id, user_id, item_type, item_id)
      );

      CREATE INDEX IF NOT EXISTS idx_multica_pinned_items_user_ws
        ON multica_pinned_items(workspace_id, user_id, position, created_at);

      CREATE TABLE IF NOT EXISTS multica_squads (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        instructions TEXT NOT NULL DEFAULT '',
        workspace_id TEXT NOT NULL DEFAULT 'local',
        leader_id TEXT,
        creator_id TEXT,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_multica_squads_workspace ON multica_squads(workspace_id);

      CREATE TABLE IF NOT EXISTS multica_squad_members (
        id TEXT PRIMARY KEY,
        squad_id TEXT NOT NULL,
        member_type TEXT NOT NULL,
        member_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        created_at TEXT NOT NULL,
        UNIQUE(squad_id, member_type, member_id),
        FOREIGN KEY(squad_id) REFERENCES multica_squads(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_multica_squad_members_squad ON multica_squad_members(squad_id);

      CREATE TABLE IF NOT EXISTS multica_autopilots (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        project_id TEXT,
        workspace_id TEXT NOT NULL DEFAULT 'local',
        assignee_type TEXT NOT NULL DEFAULT 'agent',
        assignee_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        execution_mode TEXT NOT NULL DEFAULT 'create_issue',
        issue_title_template TEXT,
        trigger_kind TEXT NOT NULL DEFAULT 'manual',
        trigger_label TEXT,
        cron_expression TEXT,
        last_run_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES multica_projects(id)
      );

      CREATE INDEX IF NOT EXISTS idx_multica_autopilots_workspace ON multica_autopilots(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_multica_autopilots_assignee ON multica_autopilots(assignee_type, assignee_id);

      CREATE TABLE IF NOT EXISTS multica_autopilot_runs (
        id TEXT PRIMARY KEY,
        autopilot_id TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        issue_id TEXT,
        task_id TEXT,
        triggered_at TEXT NOT NULL,
        completed_at TEXT,
        failure_reason TEXT,
        payload TEXT,
        result TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(autopilot_id) REFERENCES multica_autopilots(id) ON DELETE CASCADE,
        FOREIGN KEY(issue_id) REFERENCES multica_issues(id),
        FOREIGN KEY(task_id) REFERENCES multica_tasks(id)
      );

      CREATE INDEX IF NOT EXISTS idx_multica_autopilot_runs_autopilot ON multica_autopilot_runs(autopilot_id, created_at);

      CREATE TABLE IF NOT EXISTS multica_chat_sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'local',
        agent_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        session_id TEXT,
        work_dir TEXT,
        latest_task_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(agent_id) REFERENCES multica_agents(id)
      );

      CREATE INDEX IF NOT EXISTS idx_multica_chat_sessions_workspace ON multica_chat_sessions(workspace_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_multica_chat_sessions_agent ON multica_chat_sessions(agent_id);

      CREATE TABLE IF NOT EXISTS multica_chat_messages (
        id TEXT PRIMARY KEY,
        chat_session_id TEXT NOT NULL,
        task_id TEXT,
        role TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(chat_session_id) REFERENCES multica_chat_sessions(id) ON DELETE CASCADE,
        FOREIGN KEY(task_id) REFERENCES multica_tasks(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_multica_chat_messages_session ON multica_chat_messages(chat_session_id, created_at);

      CREATE TABLE IF NOT EXISTS multica_tasks (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        runtime_id TEXT,
        issue_id TEXT,
        chat_session_id TEXT,
        workspace_id TEXT NOT NULL DEFAULT 'local',
        status TEXT NOT NULL DEFAULT 'queued',
        priority INTEGER NOT NULL DEFAULT 0,
        prompt TEXT NOT NULL,
        result TEXT,
        error TEXT,
        branch_name TEXT,
        session_id TEXT,
        work_dir TEXT,
        progress_summary TEXT,
        progress_step INTEGER,
        progress_total INTEGER,
        usage TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        dispatched_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        failed_at TEXT,
        cancelled_at TEXT,
        FOREIGN KEY(agent_id) REFERENCES multica_agents(id),
        FOREIGN KEY(issue_id) REFERENCES multica_issues(id),
        FOREIGN KEY(chat_session_id) REFERENCES multica_chat_sessions(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_multica_tasks_status ON multica_tasks(status);
      CREATE INDEX IF NOT EXISTS idx_multica_tasks_runtime ON multica_tasks(runtime_id);
      CREATE INDEX IF NOT EXISTS idx_multica_tasks_issue ON multica_tasks(issue_id);
      CREATE INDEX IF NOT EXISTS idx_multica_tasks_workspace ON multica_tasks(workspace_id);

      CREATE TABLE IF NOT EXISTS multica_task_messages (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        tool TEXT,
        content TEXT,
        input TEXT,
        output TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(task_id, seq),
        FOREIGN KEY(task_id) REFERENCES multica_tasks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_multica_messages_task ON multica_task_messages(task_id, seq);
    `);
    this.addColumnIfMissing("multica_agents", "archived_at TEXT");
    this.addColumnIfMissing("multica_runtimes", "owner_id TEXT");
    this.addColumnIfMissing("multica_runtimes", "visibility TEXT NOT NULL DEFAULT 'private'");
    this.addColumnIfMissing("multica_issues", "assignee_type TEXT");
    this.addColumnIfMissing("multica_issues", "assignee_id TEXT");
    this.addColumnIfMissing("multica_issues", "metadata TEXT NOT NULL DEFAULT '{}'");
    this.addColumnIfMissing("multica_issues", "issue_number INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("multica_issues", "issue_key TEXT");
    this.addColumnIfMissing("multica_issues", "priority TEXT NOT NULL DEFAULT 'none'");
    this.addColumnIfMissing("multica_issues", "parent_issue_id TEXT");
    this.addColumnIfMissing("multica_issues", "position REAL NOT NULL DEFAULT 0");
    this.addColumnIfMissing("multica_issues", "start_date TEXT");
    this.addColumnIfMissing("multica_issues", "due_date TEXT");
    this.addColumnIfMissing("multica_issues", "acceptance_criteria TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing("multica_issues", "context_refs TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing("multica_issue_comments", "parent_id TEXT");
    this.addColumnIfMissing("multica_issue_comments", "resolved_at TEXT");
    this.addColumnIfMissing("multica_issue_comments", "resolved_by_type TEXT");
    this.addColumnIfMissing("multica_issue_comments", "resolved_by_id TEXT");
    this.addColumnIfMissing("multica_tasks", "chat_session_id TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_multica_issues_parent ON multica_issues(parent_issue_id, position, created_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_multica_issues_scheduled ON multica_issues(workspace_id, start_date, due_date)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_multica_issue_comments_parent ON multica_issue_comments(parent_id, created_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_multica_issue_comments_resolved ON multica_issue_comments(issue_id, resolved_at)");
    this.backfillIssueKeys();
  }

  createAgent(input: CreateAgentInput): MulticaAgent {
    const id = input.id ?? createId("agt");
    const now = nowIso();
    this.db.run(
      `INSERT INTO multica_agents (
        id, name, provider, instructions, skills, cwd, executable, model,
        allowed_tools, custom_env, custom_args, mcp_config, thinking_level,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.name,
        input.provider,
        input.instructions ?? "",
        toJson(input.skills ?? []),
        input.cwd ?? null,
        input.executable ?? null,
        input.model ?? null,
        toJson(input.allowedTools ?? []),
        toJson(input.customEnv ?? {}),
        toJson(input.customArgs ?? []),
        input.mcpConfig == null ? null : toJson(input.mcpConfig),
        input.thinkingLevel ?? null,
        now,
        now,
      ],
    );
    return this.getAgent(id)!;
  }

  updateAgent(id: string, input: UpdateAgentInput): MulticaAgent {
    const current = this.getAgent(id);
    if (!current) throw new Error(`Agent not found: ${id}`);
    const now = nowIso();
    this.db.run(
      `UPDATE multica_agents SET
        name = ?,
        provider = ?,
        instructions = ?,
        skills = ?,
        cwd = ?,
        executable = ?,
        model = ?,
        allowed_tools = ?,
        custom_env = ?,
        custom_args = ?,
        mcp_config = ?,
        thinking_level = ?,
        updated_at = ?
       WHERE id = ?`,
      [
        input.name ?? current.name,
        input.provider ?? current.provider,
        input.instructions ?? current.instructions,
        input.skills === undefined ? toJson(current.skills) : toJson(input.skills),
        input.cwd === undefined ? current.cwd : input.cwd,
        input.executable === undefined ? current.executable : input.executable,
        input.model === undefined ? current.model : input.model,
        input.allowedTools === undefined ? toJson(current.allowedTools) : toJson(input.allowedTools),
        input.customEnv === undefined ? toJson(current.customEnv) : toJson(input.customEnv),
        input.customArgs === undefined ? toJson(current.customArgs) : toJson(input.customArgs),
        input.mcpConfig === undefined ? current.mcpConfig == null ? null : toJson(current.mcpConfig) : input.mcpConfig == null ? null : toJson(input.mcpConfig),
        input.thinkingLevel === undefined ? current.thinkingLevel : input.thinkingLevel,
        now,
        id,
      ],
    );
    return this.getAgent(id)!;
  }

  archiveAgent(id: string): MulticaAgent {
    if (!this.getAgent(id)) throw new Error(`Agent not found: ${id}`);
    const now = nowIso();
    this.db.run("UPDATE multica_agents SET archived_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
    return this.getAgent(id)!;
  }

  ensureDefaultAgent(provider = "claude"): MulticaAgent {
    const id = `agt_default_${provider}`;
    const existing = this.getAgent(id);
    if (existing) {
      if (existing.archivedAt) {
        const now = nowIso();
        this.db.run("UPDATE multica_agents SET archived_at = NULL, updated_at = ? WHERE id = ?", [now, id]);
        return this.getAgent(id)!;
      }
      return existing;
    }
    return this.createAgent({
      id,
      name: provider === "codex" ? "Codex" : "Claude",
      provider,
      instructions: "You are an autonomous coding agent. Complete the task and report the result clearly.",
    });
  }

  getAgent(id: string): MulticaAgent | null {
    const row = this.db.query("SELECT * FROM multica_agents WHERE id = ?").get(id) as Row | null;
    return row ? toAgent(row) : null;
  }

  listAgents(): MulticaAgent[] {
    const rows = this.db.query("SELECT * FROM multica_agents WHERE archived_at IS NULL ORDER BY created_at ASC").all() as Row[];
    return rows.map(toAgent);
  }

  createWorkspaceMember(input: CreateWorkspaceMemberInput): MulticaWorkspaceMember {
    if (!input.name?.trim()) throw new Error("Member name is required");
    const id = input.id ?? createId("mem");
    const now = nowIso();
    this.db.run(
      `INSERT INTO multica_workspace_members (
        id, workspace_id, name, email, role, archived_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      [
        id,
        input.workspaceId ?? "local",
        input.name.trim(),
        input.email ?? null,
        input.role ?? "member",
        now,
        now,
      ],
    );
    return this.getWorkspaceMember(id)!;
  }

  getWorkspaceMember(id: string): MulticaWorkspaceMember | null {
    const row = this.db.query("SELECT * FROM multica_workspace_members WHERE id = ?").get(id) as Row | null;
    return row ? toWorkspaceMember(row) : null;
  }

  listWorkspaceMembers(workspaceId?: string | null): MulticaWorkspaceMember[] {
    const rows = workspaceId
      ? this.db.query("SELECT * FROM multica_workspace_members WHERE workspace_id = ? AND archived_at IS NULL ORDER BY name ASC").all(workspaceId) as Row[]
      : this.db.query("SELECT * FROM multica_workspace_members WHERE archived_at IS NULL ORDER BY workspace_id ASC, name ASC").all() as Row[];
    return rows.map(toWorkspaceMember);
  }

  updateWorkspaceMember(id: string, input: UpdateWorkspaceMemberInput): MulticaWorkspaceMember {
    const current = this.getWorkspaceMember(id);
    if (!current) throw new Error(`Member not found: ${id}`);
    const now = nowIso();
    this.db.run(
      `UPDATE multica_workspace_members SET
        workspace_id = ?,
        name = ?,
        email = ?,
        role = ?,
        updated_at = ?
       WHERE id = ?`,
      [
        input.workspaceId ?? current.workspaceId,
        input.name ?? current.name,
        input.email === undefined ? current.email : input.email,
        input.role ?? current.role,
        now,
        id,
      ],
    );
    return this.getWorkspaceMember(id)!;
  }

  archiveWorkspaceMember(id: string): MulticaWorkspaceMember {
    if (!this.getWorkspaceMember(id)) throw new Error(`Member not found: ${id}`);
    const now = nowIso();
    this.db.run("UPDATE multica_workspace_members SET archived_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
    return this.getWorkspaceMember(id)!;
  }

  registerRuntime(input: RegisterRuntimeInput): MulticaRuntime {
    const id = input.id ?? createId("rt");
    const now = nowIso();
    const currentRow = this.db.query("SELECT * FROM multica_runtimes WHERE id = ?").get(id) as Row | null;
    const current = currentRow ? toRuntime(currentRow) : null;
    const ownerId = hasAnyField(input, "ownerId", "owner_id")
      ? resolveOptionalStringField(input, "ownerId", "owner_id", current?.ownerId ?? null)
      : current?.ownerId ?? null;
    const visibility = hasAnyField(input, "visibility")
      ? normalizeRuntimeVisibility(input.visibility)
      : current?.visibility ?? "private";
    const maxConcurrency = normalizeRuntimeConcurrency(input.maxConcurrency ?? input.max_concurrency ?? current?.maxConcurrency ?? 1);
    this.db.run(
      `INSERT INTO multica_runtimes (
        id, name, provider, workspace_id, owner_id, visibility, status, max_concurrency,
        last_heartbeat_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'online', ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        provider = excluded.provider,
        workspace_id = excluded.workspace_id,
        owner_id = excluded.owner_id,
        visibility = excluded.visibility,
        status = 'online',
        max_concurrency = excluded.max_concurrency,
        last_heartbeat_at = excluded.last_heartbeat_at,
        updated_at = excluded.updated_at`,
      [
        id,
        input.name,
        input.provider,
        input.workspaceId ?? input.workspace_id ?? null,
        ownerId,
        visibility,
        maxConcurrency,
        now,
        now,
        now,
      ],
    );
    return this.getRuntime(id)!;
  }

  getRuntime(id: string): MulticaRuntime | null {
    const row = this.db.query("SELECT * FROM multica_runtimes WHERE id = ?").get(id) as Row | null;
    return row ? withRuntimeLiveness(this.hydrateRuntime(toRuntime(row))) : null;
  }

  listRuntimes(): MulticaRuntime[] {
    const rows = this.db.query("SELECT * FROM multica_runtimes ORDER BY updated_at DESC").all() as Row[];
    return rows.map((row) => withRuntimeLiveness(this.hydrateRuntime(toRuntime(row))));
  }

  updateRuntime(id: string, input: UpdateRuntimeInput): MulticaRuntime {
    const current = this.getRuntime(id);
    if (!current) throw new Error(`Runtime not found: ${id}`);
    const ownerId = resolveOptionalStringField(input, "ownerId", "owner_id", current.ownerId);
    const visibility = hasAnyField(input, "visibility")
      ? normalizeRuntimeVisibility(input.visibility)
      : current.visibility;
    const maxConcurrency = hasAnyField(input, "maxConcurrency", "max_concurrency")
      ? normalizeRuntimeConcurrency(input.maxConcurrency ?? input.max_concurrency)
      : current.maxConcurrency;
    const now = nowIso();
    this.db.run(
      `UPDATE multica_runtimes SET
        name = ?,
        owner_id = ?,
        visibility = ?,
        max_concurrency = ?,
        updated_at = ?
       WHERE id = ?`,
      [
        input.name ?? current.name,
        ownerId,
        visibility,
        maxConcurrency,
        now,
        id,
      ],
    );
    return this.getRuntime(id)!;
  }

  listRuntimeUsage(runtimeId?: string | null): MulticaRuntimeUsage[] {
    if (runtimeId !== undefined && runtimeId !== null && !this.getRuntime(runtimeId)) {
      throw new Error(`Runtime not found: ${runtimeId}`);
    }
    const rows = runtimeId === undefined
      ? this.db.query("SELECT id, runtime_id, usage FROM multica_tasks WHERE runtime_id IS NOT NULL").all() as Row[]
      : runtimeId === null
        ? this.db.query("SELECT id, runtime_id, usage FROM multica_tasks WHERE runtime_id IS NULL").all() as Row[]
        : this.db.query("SELECT id, runtime_id, usage FROM multica_tasks WHERE runtime_id = ?").all(runtimeId) as Row[];
    const usage = new Map<string, MulticaRuntimeUsage & { taskIds: Set<string> }>();
    for (const row of rows) {
      const rowRuntimeId = nullableString(row.runtime_id);
      for (const entry of parseTaskUsageEntries(row.usage)) {
        const key = [rowRuntimeId ?? "", entry.provider, entry.model].join("\u0000");
        const current = usage.get(key) ?? {
          runtimeId: rowRuntimeId,
          provider: entry.provider,
          model: entry.model,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          taskCount: 0,
          taskIds: new Set<string>(),
        };
        current.inputTokens += entry.inputTokens;
        current.outputTokens += entry.outputTokens;
        current.cacheReadTokens += entry.cacheReadTokens;
        current.cacheWriteTokens += entry.cacheWriteTokens;
        current.taskIds.add(String(row.id));
        usage.set(key, current);
      }
    }
    return [...usage.values()]
      .map(({ taskIds, ...entry }) => ({ ...entry, taskCount: taskIds.size }))
      .sort((left, right) =>
        (right.inputTokens + right.outputTokens + right.cacheReadTokens + right.cacheWriteTokens) -
        (left.inputTokens + left.outputTokens + left.cacheReadTokens + left.cacheWriteTokens) ||
        left.provider.localeCompare(right.provider) ||
        left.model.localeCompare(right.model),
      );
  }

  listUsageDaily(input: {
    workspaceId?: string | null;
    projectId?: string | null;
    runtimeId?: string | null;
    days?: number;
  } = {}): MulticaUsageDaily[] {
    const rows = this.filteredUsageTaskRows(input);
    const buckets = new Map<string, MulticaUsageDaily & { taskIds: Set<string> }>();
    for (const row of rows) {
      const date = usageDate(row);
      for (const entry of parseTaskUsageEntries(row.usage)) {
        const key = [date, nullableString(row.runtime_id) ?? "", entry.model].join("\u0000");
        const current = buckets.get(key) ?? {
          date,
          runtimeId: nullableString(row.runtime_id),
          model: entry.model,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          taskCount: 0,
          taskIds: new Set<string>(),
        };
        addUsageTotals(current, entry);
        current.taskIds.add(String(row.id));
        buckets.set(key, current);
      }
    }
    return [...buckets.values()]
      .map(({ taskIds, ...row }) => ({ ...row, taskCount: taskIds.size }))
      .sort((left, right) => left.date.localeCompare(right.date) || left.model.localeCompare(right.model));
  }

  listUsageByAgent(input: {
    workspaceId?: string | null;
    projectId?: string | null;
    runtimeId?: string | null;
    days?: number;
  } = {}): MulticaUsageByAgent[] {
    const rows = this.filteredUsageTaskRows(input);
    const buckets = new Map<string, MulticaUsageByAgent & { taskIds: Set<string> }>();
    for (const row of rows) {
      const agentId = String(row.agent_id);
      for (const entry of parseTaskUsageEntries(row.usage)) {
        const key = [agentId, entry.model].join("\u0000");
        const current = buckets.get(key) ?? {
          agentId,
          model: entry.model,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          taskCount: 0,
          taskIds: new Set<string>(),
        };
        addUsageTotals(current, entry);
        current.taskIds.add(String(row.id));
        buckets.set(key, current);
      }
    }
    return [...buckets.values()]
      .map(({ taskIds, ...row }) => ({ ...row, taskCount: taskIds.size }))
      .sort((left, right) =>
        (right.inputTokens + right.outputTokens + right.cacheReadTokens + right.cacheWriteTokens) -
        (left.inputTokens + left.outputTokens + left.cacheReadTokens + left.cacheWriteTokens) ||
        left.agentId.localeCompare(right.agentId) ||
        left.model.localeCompare(right.model),
      );
  }

  listUsageByHour(input: {
    workspaceId?: string | null;
    projectId?: string | null;
    runtimeId?: string | null;
    days?: number;
  } = {}): MulticaUsageByHour[] {
    const rows = this.filteredUsageTaskRows(input);
    const buckets = new Map<string, MulticaUsageByHour & { taskIds: Set<string> }>();
    for (const row of rows) {
      const hour = usageHour(row);
      for (const entry of parseTaskUsageEntries(row.usage)) {
        const key = [hour, entry.model].join("\u0000");
        const current = buckets.get(key) ?? {
          hour,
          model: entry.model,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          taskCount: 0,
          taskIds: new Set<string>(),
        };
        addUsageTotals(current, entry);
        current.taskIds.add(String(row.id));
        buckets.set(key, current);
      }
    }
    return [...buckets.values()]
      .map(({ taskIds, ...row }) => ({ ...row, taskCount: taskIds.size }))
      .sort((left, right) => left.hour - right.hour || left.model.localeCompare(right.model));
  }

  listTaskActivityByHour(input: {
    workspaceId?: string | null;
    projectId?: string | null;
    runtimeId?: string | null;
    days?: number;
  } = {}): MulticaTaskActivityByHour[] {
    const rows = this.filteredUsageTaskRows(input, { includeTasksWithoutUsage: true });
    const counts = new Map<number, number>();
    for (const row of rows) {
      const hour = usageHour(row);
      counts.set(hour, (counts.get(hour) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([hour, count]) => ({ hour, count }))
      .sort((left, right) => left.hour - right.hour);
  }

  listRuntimeDaily(input: {
    workspaceId?: string | null;
    projectId?: string | null;
    runtimeId?: string | null;
    days?: number;
  } = {}): MulticaRuntimeDaily[] {
    const rows = this.filteredUsageTaskRows(input, { includeTasksWithoutUsage: true });
    const buckets = new Map<string, MulticaRuntimeDaily>();
    for (const row of rows) {
      const date = usageDate(row);
      const current = buckets.get(date) ?? { date, totalSeconds: 0, taskCount: 0, failedCount: 0 };
      current.taskCount += 1;
      if (String(row.status ?? "") === "failed") current.failedCount += 1;
      current.totalSeconds += taskRunSeconds(row);
      buckets.set(date, current);
    }
    return [...buckets.values()].sort((left, right) => left.date.localeCompare(right.date));
  }

  heartbeatRuntime(runtimeId: string): void {
    const now = nowIso();
    this.db.run(
      "UPDATE multica_runtimes SET status = 'online', last_heartbeat_at = ?, updated_at = ? WHERE id = ?",
      [now, now, runtimeId],
    );
  }

  createIssue(input: CreateIssueInput): MulticaIssue {
    const parentIssueId = input.parentIssueId ?? input.parent_issue_id ?? null;
    const explicitWorkspaceId = input.workspaceId ?? input.workspace_id ?? null;
    const workspaceId = explicitWorkspaceId ?? "local";
    const parent = parentIssueId ? this.getIssue(parentIssueId) : null;
    if (parentIssueId && !parent) throw new Error(`Parent issue not found: ${parentIssueId}`);
    if (parent && parent.workspaceId !== workspaceId) throw new Error("Parent issue belongs to another workspace");

    const projectId = input.projectId ?? input.project_id ?? (parent ? parent.projectId : null);
    if (projectId) {
      const project = this.getProject(projectId);
      if (!project) throw new Error(`Project not found: ${projectId}`);
      if (project.workspaceId !== workspaceId) throw new Error("Project belongs to another workspace");
    }

    const assigneeType = input.assigneeType ?? input.assignee_type ?? null;
    const assigneeId = input.assigneeId ?? input.assignee_id ?? null;
    if (assigneeType || assigneeId) {
      this.validateIssueAssignee(assigneeType, assigneeId);
    }
    const id = input.id ?? createId("iss");
    const now = nowIso();
    const issueNumber = this.nextIssueNumber(workspaceId);
    const issueKey = formatIssueKey(issueNumber);
    const priority = normalizeIssuePriority(input.priority);
    const position = normalizeIssuePosition(input.position);
    const startDate = normalizeIssueDate(input.startDate ?? input.start_date ?? null, "start_date");
    const dueDate = normalizeIssueDate(input.dueDate ?? input.due_date ?? null, "due_date");
    const acceptanceCriteria = normalizeJsonArray(input.acceptanceCriteria ?? input.acceptance_criteria ?? []);
    const contextRefs = normalizeJsonArray(input.contextRefs ?? input.context_refs ?? []);
    this.db.run(
      `INSERT INTO multica_issues (
        id, issue_number, issue_key, title, description, status, priority, workspace_id, project_id,
        parent_issue_id, assignee_type, assignee_id, position, start_date, due_date,
        acceptance_criteria, context_refs, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        issueNumber,
        issueKey,
        input.title,
        input.description ?? null,
        input.status ?? "open",
        priority,
        workspaceId,
        projectId,
        parentIssueId,
        assigneeType,
        assigneeId,
        position,
        startDate,
        dueDate,
        toJson(acceptanceCriteria),
        toJson(contextRefs),
        input.createdBy ?? null,
        now,
        now,
      ],
    );
    if (projectId) {
      this.db.run("UPDATE multica_projects SET updated_at = ? WHERE id = ?", [now, projectId]);
    }
    this.appendIssueActivity(id, {
      actorType: "system",
      actorId: input.createdBy ?? null,
      type: "issue_created",
      body: input.title,
      data: { projectId, parentIssueId, priority, startDate, dueDate },
    });
    if (input.createdBy) {
      const creator = this.getWorkspaceMember(input.createdBy);
      if (creator && !creator.archivedAt) this.addIssueSubscriber(id, input.createdBy, "created");
    }
    return this.getIssue(id)!;
  }

  getIssue(id: string): MulticaIssue | null {
    const row = this.db.query("SELECT * FROM multica_issues WHERE id = ?").get(id) as Row | null;
    return row ? this.hydrateIssue(toIssue(row)) : null;
  }

  getIssueWithTasks(id: string): MulticaIssueWithTasks | null {
    const issue = this.getIssue(id);
    if (!issue) return null;
    return {
      ...issue,
      tasks: this.listTasksForIssue(id),
      reactions: this.listIssueReactions(id),
      attachments: this.listAttachmentsForIssue(id),
      children: this.listChildIssues(id),
      childProgress: this.getChildIssueProgress(id),
      dependencies: this.listIssueDependencies(id),
    };
  }

  listIssues(): MulticaIssue[] {
    const rows = this.db.query("SELECT * FROM multica_issues ORDER BY updated_at DESC").all() as Row[];
    return rows.map((row) => this.hydrateIssue(toIssue(row)));
  }

  searchIssues(input: { q: string; workspaceId?: string | null; includeClosed?: boolean; limit?: number; offset?: number }): { issues: MulticaIssueSearchResult[]; total: number } {
    const query = normalizeSearchQuery(input.q);
    if (!query) throw new Error("q parameter is required");
    const workspaceId = input.workspaceId ?? "local";
    const includeClosed = Boolean(input.includeClosed);
    const limit = clampSearchLimit(input.limit);
    const offset = Math.max(0, Number(input.offset ?? 0));
    const rows = this.listIssues().filter((issue) => {
      if (issue.workspaceId !== workspaceId) return false;
      if (!includeClosed && ["done", "failed", "cancelled"].includes(issue.status)) return false;
      return searchMatch(issue.key, query) || searchMatch(issue.title, query) || searchMatch(issue.description ?? "", query);
    }).map((issue) => {
      const matchSource = searchMatch(issue.key, query) ? "key" : searchMatch(issue.title, query) ? "title" : "description";
      const result: MulticaIssueSearchResult = {
        ...issue,
        matchSource,
      };
      if (matchSource === "description" && issue.description) result.matchedDescriptionSnippet = extractSearchSnippet(issue.description, query);
      return result;
    }).sort((left, right) => searchRank(left.matchSource) - searchRank(right.matchSource) || Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    return { issues: rows.slice(offset, offset + limit), total: rows.length };
  }

  listTasksForIssue(issueId: string): MulticaTask[] {
    const rows = this.db.query(
      "SELECT * FROM multica_tasks WHERE issue_id = ? ORDER BY created_at DESC",
    ).all(issueId) as Row[];
    return rows.map(toTask);
  }

  listChildIssues(parentIssueId: string): MulticaIssue[] {
    const parent = this.getIssue(parentIssueId);
    if (!parent) throw new Error(`Issue not found: ${parentIssueId}`);
    const rows = this.db.query(
      "SELECT * FROM multica_issues WHERE parent_issue_id = ? ORDER BY position ASC, created_at DESC",
    ).all(parentIssueId) as Row[];
    return rows.map((row) => this.hydrateIssue(toIssue(row)));
  }

  listChildIssueProgress(workspaceId = "local"): MulticaIssueChildProgress[] {
    const rows = this.db.query(
      `SELECT parent_issue_id, COUNT(*) AS total,
              SUM(CASE WHEN status IN ('done', 'completed', 'closed', 'cancelled') THEN 1 ELSE 0 END) AS done
       FROM multica_issues
       WHERE workspace_id = ? AND parent_issue_id IS NOT NULL
       GROUP BY parent_issue_id
       ORDER BY parent_issue_id ASC`,
    ).all(workspaceId) as Row[];
    return rows.map(toChildIssueProgress);
  }

  getChildIssueProgress(parentIssueId: string): MulticaIssueChildProgress {
    const row = this.db.query(
      `SELECT parent_issue_id, COUNT(*) AS total,
              SUM(CASE WHEN status IN ('done', 'completed', 'closed', 'cancelled') THEN 1 ELSE 0 END) AS done
       FROM multica_issues
       WHERE parent_issue_id = ?
       GROUP BY parent_issue_id`,
    ).get(parentIssueId) as Row | null;
    return row ? toChildIssueProgress(row) : { parentIssueId, total: 0, done: 0 };
  }

  listIssueDependencies(issueId: string): MulticaIssueDependency[] {
    if (!this.getIssue(issueId)) throw new Error(`Issue not found: ${issueId}`);
    const rows = this.db.query(
      `SELECT * FROM multica_issue_dependencies
       WHERE issue_id = ? OR depends_on_issue_id = ?
       ORDER BY created_at ASC`,
    ).all(issueId, issueId) as Row[];
    return rows.map((row) => this.hydrateIssueDependency(toIssueDependency(row)));
  }

  createIssueDependency(issueId: string, input: CreateIssueDependencyInput): MulticaIssueDependency {
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const dependsOnIssueId = input.dependsOnIssueId ?? input.depends_on_issue_id ?? "";
    const dependsOnIssue = this.getIssue(dependsOnIssueId);
    if (!dependsOnIssue) throw new Error(`Dependent issue not found: ${dependsOnIssueId}`);
    if (issue.id === dependsOnIssue.id) throw new Error("An issue cannot depend on itself");
    if (issue.workspaceId !== dependsOnIssue.workspaceId) throw new Error("Issue dependency must stay within a workspace");
    const type = normalizeIssueDependencyType(input.type);
    const id = input.id ?? createId("dep");
    const now = nowIso();
    const existing = this.db.query(
      `SELECT * FROM multica_issue_dependencies
       WHERE issue_id = ? AND depends_on_issue_id = ? AND type = ?`,
    ).get(issue.id, dependsOnIssue.id, type) as Row | null;
    if (existing) return this.hydrateIssueDependency(toIssueDependency(existing));
    this.db.run(
      `INSERT INTO multica_issue_dependencies (
        id, workspace_id, issue_id, depends_on_issue_id, type, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, issue.workspaceId, issue.id, dependsOnIssue.id, type, now],
    );
    this.appendIssueActivity(issue.id, {
      actorType: "system",
      actorId: null,
      type: "issue_dependency_added",
      body: `${type} ${dependsOnIssue.key}`,
      data: { dependencyId: id, dependsOnIssueId: dependsOnIssue.id, type },
    });
    return this.getIssueDependency(id)!;
  }

  getIssueDependency(id: string): MulticaIssueDependency | null {
    const row = this.db.query("SELECT * FROM multica_issue_dependencies WHERE id = ?").get(id) as Row | null;
    return row ? this.hydrateIssueDependency(toIssueDependency(row)) : null;
  }

  deleteIssueDependency(issueId: string, dependencyId: string): void {
    const dependency = this.getIssueDependency(dependencyId);
    if (!dependency) return;
    if (dependency.issueId !== issueId && dependency.dependsOnIssueId !== issueId) {
      throw new Error(`Dependency not found for issue: ${issueId}`);
    }
    this.db.run("DELETE FROM multica_issue_dependencies WHERE id = ?", [dependencyId]);
    this.appendIssueActivity(issueId, {
      actorType: "system",
      actorId: null,
      type: "issue_dependency_removed",
      body: dependency.type,
      data: { dependencyId, issueId: dependency.issueId, dependsOnIssueId: dependency.dependsOnIssueId, type: dependency.type },
    });
  }

  updateIssue(id: string, input: UpdateIssueInput): MulticaIssue {
    const current = this.getIssue(id);
    if (!current) throw new Error(`Issue not found: ${id}`);
    const nextWorkspaceId = resolveOptionalStringField(input, "workspaceId", "workspace_id", current.workspaceId) ?? "local";
    const nextProjectId = resolveOptionalStringField(input, "projectId", "project_id", current.projectId);
    const nextParentIssueId = resolveOptionalStringField(input, "parentIssueId", "parent_issue_id", current.parentIssueId);
    const nextAssigneeType = resolveOptionalStringField(input, "assigneeType", "assignee_type", current.assigneeType) as MulticaAssigneeType | null;
    const nextAssigneeId = resolveOptionalStringField(input, "assigneeId", "assignee_id", current.assigneeId);
    const nextStartDate = hasAnyField(input, "startDate", "start_date")
      ? normalizeIssueDate(input.startDate ?? input.start_date ?? null, "start_date")
      : current.startDate;
    const nextDueDate = hasAnyField(input, "dueDate", "due_date")
      ? normalizeIssueDate(input.dueDate ?? input.due_date ?? null, "due_date")
      : current.dueDate;
    const nextAcceptanceCriteria = hasAnyField(input, "acceptanceCriteria", "acceptance_criteria")
      ? normalizeJsonArray(input.acceptanceCriteria ?? input.acceptance_criteria ?? [])
      : current.acceptanceCriteria;
    const nextContextRefs = hasAnyField(input, "contextRefs", "context_refs")
      ? normalizeJsonArray(input.contextRefs ?? input.context_refs ?? [])
      : current.contextRefs;

    if (nextProjectId) {
      const project = this.getProject(nextProjectId);
      if (!project) throw new Error(`Project not found: ${nextProjectId}`);
      if (project.workspaceId !== nextWorkspaceId) throw new Error("Project belongs to another workspace");
    }
    if (nextParentIssueId) {
      const parent = this.getIssue(nextParentIssueId);
      if (!parent) throw new Error(`Parent issue not found: ${nextParentIssueId}`);
      if (parent.workspaceId !== nextWorkspaceId) throw new Error("Parent issue belongs to another workspace");
      this.validateIssueParent(id, nextParentIssueId);
    }
    if (hasAnyField(input, "assigneeType", "assignee_type", "assigneeId", "assignee_id")) {
      this.validateIssueAssignee(nextAssigneeType, nextAssigneeId);
    }

    const now = nowIso();
    this.db.run(
      `UPDATE multica_issues SET
        title = ?,
        description = ?,
        status = ?,
        priority = ?,
        workspace_id = ?,
        project_id = ?,
        parent_issue_id = ?,
        assignee_type = ?,
        assignee_id = ?,
        position = ?,
        start_date = ?,
        due_date = ?,
        acceptance_criteria = ?,
        context_refs = ?,
        updated_at = ?
       WHERE id = ?`,
      [
        input.title ?? current.title,
        input.description === undefined ? current.description : input.description,
        input.status ?? current.status,
        normalizeIssuePriority(input.priority ?? current.priority),
        nextWorkspaceId,
        nextProjectId,
        nextParentIssueId,
        nextAssigneeType,
        nextAssigneeId,
        input.position === undefined || input.position === null ? current.position : normalizeIssuePosition(input.position),
        nextStartDate,
        nextDueDate,
        toJson(nextAcceptanceCriteria),
        toJson(nextContextRefs),
        now,
        id,
      ],
    );
    this.appendIssueActivity(id, {
      actorType: "system",
      actorId: null,
      type: "issue_updated",
      body: null,
      data: input,
    });
    if (current.projectId) this.db.run("UPDATE multica_projects SET updated_at = ? WHERE id = ?", [now, current.projectId]);
    if (nextProjectId) this.db.run("UPDATE multica_projects SET updated_at = ? WHERE id = ?", [now, nextProjectId]);
    return this.getIssue(id)!;
  }

  assignIssue(id: string, input: AssignIssueInput): AssignIssueResult {
    const current = this.getIssue(id);
    if (!current) throw new Error(`Issue not found: ${id}`);
    const assigneeType = input.assigneeType ?? null;
    const assigneeId = input.assigneeId ?? null;
    const now = nowIso();

    if (Boolean(assigneeType) !== Boolean(assigneeId)) {
      throw new Error("Assignee type and id are required together");
    }
    if (!assigneeType || !assigneeId) {
      const cancelled = this.cancelActiveIssueTasks(id, "issue_unassigned");
      this.db.run(
        "UPDATE multica_issues SET assignee_type = NULL, assignee_id = NULL, updated_at = ? WHERE id = ?",
        [now, id],
      );
      this.appendIssueActivity(id, {
        actorType: "system",
        actorId: null,
        type: "issue_unassigned",
        body: null,
        data: { cancelled },
      });
      return { issue: this.getIssue(id)!, task: null };
    }

    this.validateIssueAssignee(assigneeType, assigneeId);
    const taskAgent = assigneeType === "member" ? null : this.resolveRunnableAgentForAssignee(assigneeType, assigneeId);
    if (assigneeType !== "member" && !taskAgent) {
      throw new Error(`No runnable agent for ${assigneeType}: ${assigneeId}`);
    }
    const cancelled = this.cancelActiveIssueTasks(id, "issue_reassigned");
    this.db.run(
      `UPDATE multica_issues
       SET assignee_type = ?, assignee_id = ?, status = ?, updated_at = ?
       WHERE id = ?`,
      [
        assigneeType,
        assigneeId,
        taskAgent ? "in_progress" : current.status,
        now,
        id,
      ],
    );

    let task: MulticaTask | null = null;
    if (taskAgent) {
      task = this.createTask({
        agentId: taskAgent.id,
        issueId: id,
        workspaceId: current.workspaceId,
        prompt: input.prompt?.trim() || current.title,
      });
    }
    if (assigneeType === "member") {
      this.addIssueSubscriber(id, assigneeId, "assigned");
      this.createInboxItem({
        issueId: id,
        memberId: assigneeId,
        type: "issue_assigned",
        title: `${current.key} assigned to you`,
        body: current.title,
        actorType: "system",
        actorId: null,
      });
    }

    this.appendIssueActivity(id, {
      actorType: "system",
      actorId: null,
      type: "issue_assigned",
      body: taskAgent ? `Queued ${taskAgent.name}` : null,
      data: { assigneeType, assigneeId, taskId: task?.id ?? null, cancelled },
    });
    if (current.projectId) this.db.run("UPDATE multica_projects SET updated_at = ? WHERE id = ?", [now, current.projectId]);
    return { issue: this.getIssue(id)!, task };
  }

  createIssueComment(issueId: string, input: CreateIssueCommentInput): MulticaIssueComment {
    if (!input.body?.trim()) throw new Error("Comment body is required");
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const parentId = input.parentId ?? input.parent_id ?? null;
    if (parentId) {
      const parent = this.getIssueComment(parentId);
      if (!parent || parent.issueId !== issueId) throw new Error(`Parent comment not found: ${parentId}`);
    }
    const id = createId("cmt");
    const now = nowIso();
    const body = input.body.trim();
    this.db.run(
      `INSERT INTO multica_issue_comments (id, issue_id, author_type, author_id, parent_id, body, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, issueId, input.authorType ?? "member", input.authorId ?? null, parentId, body, now, now],
    );
    const attachmentIds = input.attachmentIds ?? input.attachment_ids ?? [];
    if (attachmentIds.length) this.linkAttachmentsToComment(id, issueId, attachmentIds);
    this.db.run("UPDATE multica_issues SET updated_at = ? WHERE id = ?", [now, issueId]);
    if (parentId) this.unresolveThreadRoot(parentId);
    const authorType = input.authorType ?? "member";
    if (authorType === "member" && input.authorId) {
      this.addIssueSubscriber(issueId, input.authorId, "commented");
    }
    this.appendIssueActivity(issueId, {
      actorType: authorType,
      actorId: input.authorId ?? null,
      type: "comment_created",
      body,
      data: { commentId: id },
    });
    const comment = this.getIssueComment(id)!;
    const mentionedMemberIds = this.triggerMemberMentions(issue, comment);
    this.notifySubscribedMembers(issue, "comment_created", "New comment", body, authorType, input.authorId ?? null, mentionedMemberIds);
    this.triggerCommentMentions(issue, comment);
    return comment;
  }

  updateIssueComment(id: string, input: UpdateIssueCommentInput): MulticaIssueComment {
    const current = this.getRawIssueComment(id);
    if (!current) throw new Error(`Comment not found: ${id}`);
    const body = (input.body ?? input.content ?? "").trim();
    if (!body) throw new Error("Comment body is required");
    const now = nowIso();
    this.db.run(
      "UPDATE multica_issue_comments SET body = ?, updated_at = ? WHERE id = ?",
      [body, now, id],
    );
    const attachmentIds = input.attachmentIds ?? input.attachment_ids ?? [];
    if (attachmentIds.length) this.linkAttachmentsToComment(id, current.issueId, attachmentIds);
    this.db.run("UPDATE multica_issues SET updated_at = ? WHERE id = ?", [now, current.issueId]);
    this.appendIssueActivity(current.issueId, {
      actorType: "system",
      actorId: null,
      type: "comment_updated",
      body,
      data: { commentId: id },
    });
    return this.getIssueComment(id)!;
  }

  deleteIssueComment(id: string): void {
    const current = this.getRawIssueComment(id);
    if (!current) throw new Error(`Comment not found: ${id}`);
    const ids = this.collectCommentTreeIds(id);
    const now = nowIso();
    for (const commentId of ids) {
      this.db.run("DELETE FROM multica_comment_reactions WHERE comment_id = ?", [commentId]);
      this.db.run("DELETE FROM multica_attachments WHERE comment_id = ?", [commentId]);
    }
    for (const commentId of ids.slice().reverse()) {
      this.db.run("DELETE FROM multica_issue_comments WHERE id = ?", [commentId]);
    }
    this.db.run("UPDATE multica_issues SET updated_at = ? WHERE id = ?", [now, current.issueId]);
    this.appendIssueActivity(current.issueId, {
      actorType: "system",
      actorId: null,
      type: "comment_deleted",
      body: current.body,
      data: { commentId: id, deletedCommentIds: ids },
    });
  }

  resolveIssueComment(id: string, input: { actorType?: string; actorId?: string | null } = {}): MulticaIssueComment {
    const current = this.getRawIssueComment(id);
    if (!current) throw new Error(`Comment not found: ${id}`);
    if (current.parentId) throw new Error("Only root comments can be resolved");
    if (current.resolvedAt) return this.getIssueComment(id)!;
    const now = nowIso();
    this.db.run(
      `UPDATE multica_issue_comments
       SET resolved_at = ?, resolved_by_type = ?, resolved_by_id = ?, updated_at = ?
       WHERE id = ?`,
      [now, input.actorType ?? "member", input.actorId ?? "local", now, id],
    );
    this.db.run("UPDATE multica_issues SET updated_at = ? WHERE id = ?", [now, current.issueId]);
    this.appendIssueActivity(current.issueId, {
      actorType: input.actorType ?? "member",
      actorId: input.actorId ?? "local",
      type: "comment_resolved",
      body: current.body,
      data: { commentId: id },
    });
    return this.getIssueComment(id)!;
  }

  unresolveIssueComment(id: string): MulticaIssueComment {
    const current = this.getRawIssueComment(id);
    if (!current) throw new Error(`Comment not found: ${id}`);
    if (current.parentId) throw new Error("Only root comments can be resolved");
    if (!current.resolvedAt) return this.getIssueComment(id)!;
    const now = nowIso();
    this.db.run(
      "UPDATE multica_issue_comments SET resolved_at = NULL, resolved_by_type = NULL, resolved_by_id = NULL, updated_at = ? WHERE id = ?",
      [now, id],
    );
    this.db.run("UPDATE multica_issues SET updated_at = ? WHERE id = ?", [now, current.issueId]);
    this.appendIssueActivity(current.issueId, {
      actorType: "system",
      actorId: null,
      type: "comment_unresolved",
      body: current.body,
      data: { commentId: id },
    });
    return this.getIssueComment(id)!;
  }

  getIssueComment(id: string): MulticaIssueComment | null {
    const row = this.db.query("SELECT * FROM multica_issue_comments WHERE id = ?").get(id) as Row | null;
    return row ? this.hydrateIssueComment(toIssueComment(row)) : null;
  }

  listIssueComments(issueId: string): MulticaIssueComment[] {
    const rows = this.db.query(
      "SELECT * FROM multica_issue_comments WHERE issue_id = ? ORDER BY created_at ASC",
    ).all(issueId) as Row[];
    return rows.map((row) => this.hydrateIssueComment(toIssueComment(row)));
  }

  listIssueActivity(issueId: string): MulticaIssueActivity[] {
    const rows = this.db.query(
      "SELECT * FROM multica_issue_activity WHERE issue_id = ? ORDER BY created_at ASC",
    ).all(issueId) as Row[];
    return rows.map(toIssueActivity);
  }

  listIssueSubscribers(issueId: string): MulticaIssueSubscriber[] {
    if (!this.getIssue(issueId)) throw new Error(`Issue not found: ${issueId}`);
    const rows = this.db.query(
      "SELECT * FROM multica_issue_subscribers WHERE issue_id = ? ORDER BY created_at ASC",
    ).all(issueId) as Row[];
    return rows.map(toIssueSubscriber);
  }

  addIssueSubscriber(issueId: string, memberId: string, reason: MulticaSubscriptionReason = "manual"): MulticaIssueSubscriber {
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const member = this.getWorkspaceMember(memberId);
    if (!member) throw new Error(`Member not found: ${memberId}`);
    if (member.archivedAt) throw new Error(`Member is archived: ${memberId}`);
    const now = nowIso();
    const id = createId("sub");
    this.db.run(
      `INSERT INTO multica_issue_subscribers (id, issue_id, member_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(issue_id, member_id) DO UPDATE SET reason = excluded.reason`,
      [id, issueId, memberId, reason, now],
    );
    const row = this.db.query(
      "SELECT * FROM multica_issue_subscribers WHERE issue_id = ? AND member_id = ?",
    ).get(issueId, memberId) as Row | null;
    return toIssueSubscriber(row!);
  }

  removeIssueSubscriber(issueId: string, memberId: string): void {
    this.db.run("DELETE FROM multica_issue_subscribers WHERE issue_id = ? AND member_id = ?", [issueId, memberId]);
  }

  listLabels(workspaceId?: string | null): MulticaLabel[] {
    const rows = workspaceId
      ? this.db.query("SELECT * FROM multica_issue_labels WHERE workspace_id = ? ORDER BY lower(name) ASC").all(workspaceId) as Row[]
      : this.db.query("SELECT * FROM multica_issue_labels ORDER BY workspace_id ASC, lower(name) ASC").all() as Row[];
    return rows.map(toLabel);
  }

  getLabel(id: string): MulticaLabel | null {
    const row = this.db.query("SELECT * FROM multica_issue_labels WHERE id = ?").get(id) as Row | null;
    return row ? toLabel(row) : null;
  }

  createLabel(input: CreateLabelInput): MulticaLabel {
    const name = normalizeLabelName(input.name);
    const color = normalizeLabelColor(input.color);
    const workspaceId = input.workspaceId ?? input.workspace_id ?? "local";
    const existing = this.db.query(
      "SELECT id FROM multica_issue_labels WHERE workspace_id = ? AND lower(name) = lower(?)",
    ).get(workspaceId, name) as Row | null;
    if (existing) throw new Error(`Label already exists in workspace: ${name}`);
    const id = input.id ?? createId("lbl");
    const now = nowIso();
    this.db.run(
      `INSERT INTO multica_issue_labels (id, workspace_id, name, color, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, workspaceId, name, color, now, now],
    );
    return this.getLabel(id)!;
  }

  updateLabel(id: string, input: UpdateLabelInput): MulticaLabel {
    const current = this.getLabel(id);
    if (!current) throw new Error(`Label not found: ${id}`);
    const name = input.name === undefined ? current.name : normalizeLabelName(input.name);
    const color = input.color === undefined ? current.color : normalizeLabelColor(input.color);
    const duplicate = this.db.query(
      "SELECT id FROM multica_issue_labels WHERE workspace_id = ? AND lower(name) = lower(?) AND id != ?",
    ).get(current.workspaceId, name, id) as Row | null;
    if (duplicate) throw new Error(`Label already exists in workspace: ${name}`);
    const now = nowIso();
    this.db.run(
      "UPDATE multica_issue_labels SET name = ?, color = ?, updated_at = ? WHERE id = ?",
      [name, color, now, id],
    );
    return this.getLabel(id)!;
  }

  deleteLabel(id: string): MulticaLabel {
    const label = this.getLabel(id);
    if (!label) throw new Error(`Label not found: ${id}`);
    this.db.run("DELETE FROM multica_issue_labels WHERE id = ?", [id]);
    return label;
  }

  listLabelsForIssue(issueId: string): MulticaLabel[] {
    const issue = this.db.query("SELECT id FROM multica_issues WHERE id = ?").get(issueId) as Row | null;
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const rows = this.db.query(
      `SELECT l.*
       FROM multica_issue_labels l
       JOIN multica_issue_to_labels il ON il.label_id = l.id
       WHERE il.issue_id = ?
       ORDER BY lower(l.name) ASC`,
    ).all(issueId) as Row[];
    return rows.map(toLabel);
  }

  attachLabelToIssue(issueId: string, labelId: string): MulticaLabel[] {
    const issueRow = this.db.query("SELECT * FROM multica_issues WHERE id = ?").get(issueId) as Row | null;
    if (!issueRow) throw new Error(`Issue not found: ${issueId}`);
    const issue = toIssue(issueRow);
    const label = this.getLabel(labelId);
    if (!label) throw new Error(`Label not found: ${labelId}`);
    if (label.workspaceId !== issue.workspaceId) throw new Error("Label belongs to another workspace");
    const existing = this.db.query(
      "SELECT 1 FROM multica_issue_to_labels WHERE issue_id = ? AND label_id = ?",
    ).get(issueId, labelId) as Row | null;
    if (existing) return this.listLabelsForIssue(issueId);
    this.db.run(
      "INSERT OR IGNORE INTO multica_issue_to_labels (issue_id, label_id) VALUES (?, ?)",
      [issueId, labelId],
    );
    const now = nowIso();
    this.db.run("UPDATE multica_issues SET updated_at = ? WHERE id = ?", [now, issueId]);
    this.appendIssueActivity(issueId, {
      actorType: "system",
      actorId: null,
      type: "label_attached",
      body: label.name,
      data: { labelId, color: label.color },
    });
    return this.listLabelsForIssue(issueId);
  }

  detachLabelFromIssue(issueId: string, labelId: string): MulticaLabel[] {
    const issueRow = this.db.query("SELECT * FROM multica_issues WHERE id = ?").get(issueId) as Row | null;
    if (!issueRow) throw new Error(`Issue not found: ${issueId}`);
    const issue = toIssue(issueRow);
    const label = this.getLabel(labelId);
    if (!label) throw new Error(`Label not found: ${labelId}`);
    if (label.workspaceId !== issue.workspaceId) throw new Error("Label belongs to another workspace");
    const existing = this.db.query(
      "SELECT 1 FROM multica_issue_to_labels WHERE issue_id = ? AND label_id = ?",
    ).get(issueId, labelId) as Row | null;
    if (!existing) return this.listLabelsForIssue(issueId);
    this.db.run("DELETE FROM multica_issue_to_labels WHERE issue_id = ? AND label_id = ?", [issueId, labelId]);
    const now = nowIso();
    this.db.run("UPDATE multica_issues SET updated_at = ? WHERE id = ?", [now, issueId]);
    this.appendIssueActivity(issueId, {
      actorType: "system",
      actorId: null,
      type: "label_detached",
      body: label.name,
      data: { labelId, color: label.color },
    });
    return this.listLabelsForIssue(issueId);
  }

  listInboxItems(memberId?: string | null): MulticaInboxItem[] {
    const resolvedMemberId = memberId ?? this.listWorkspaceMembers()[0]?.id ?? null;
    if (!resolvedMemberId) return [];
    const rows = this.db.query(
      "SELECT * FROM multica_inbox_items WHERE member_id = ? AND archived = 0 ORDER BY created_at DESC",
    ).all(resolvedMemberId) as Row[];
    return rows.map((row) => toInboxItem(row, this.getIssue(String(row.issue_id))));
  }

  markInboxItemRead(id: string): MulticaInboxItem {
    const existing = this.db.query("SELECT issue_id FROM multica_inbox_items WHERE id = ?").get(id) as { issue_id: string } | null;
    if (!existing) throw new Error(`Inbox item not found: ${id}`);
    this.db.run("UPDATE multica_inbox_items SET read = 1 WHERE id = ?", [id]);
    const row = this.db.query("SELECT * FROM multica_inbox_items WHERE id = ?").get(id) as Row | null;
    return toInboxItem(row!, this.getIssue(String(row!.issue_id)));
  }

  archiveInboxItem(id: string): MulticaInboxItem {
    const rowBefore = this.db.query("SELECT issue_id FROM multica_inbox_items WHERE id = ?").get(id) as { issue_id: string } | null;
    if (!rowBefore) throw new Error(`Inbox item not found: ${id}`);
    this.db.run("UPDATE multica_inbox_items SET archived = 1, read = 1 WHERE id = ?", [id]);
    const row = this.db.query("SELECT * FROM multica_inbox_items WHERE id = ?").get(id) as Row | null;
    return toInboxItem(row!, this.getIssue(String(row!.issue_id)));
  }

  listIssueReactions(issueId: string): MulticaIssueReaction[] {
    if (!this.getIssue(issueId)) throw new Error(`Issue not found: ${issueId}`);
    const rows = this.db.query(
      "SELECT * FROM multica_issue_reactions WHERE issue_id = ? ORDER BY created_at ASC",
    ).all(issueId) as Row[];
    return rows.map(toIssueReaction);
  }

  addIssueReaction(issueId: string, input: { actorType?: string; actorId?: string | null; emoji: string }): MulticaIssueReaction {
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const actorType = input.actorType ?? "member";
    const actorId = input.actorId ?? "local";
    const emoji = input.emoji?.trim();
    if (!emoji) throw new Error("emoji is required");
    this.db.run(
      `INSERT INTO multica_issue_reactions (id, issue_id, workspace_id, actor_type, actor_id, emoji, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(issue_id, actor_type, actor_id, emoji) DO NOTHING`,
      [createId("rxn"), issueId, issue.workspaceId, actorType, actorId, emoji, nowIso()],
    );
    const row = this.db.query(
      "SELECT * FROM multica_issue_reactions WHERE issue_id = ? AND actor_type = ? AND actor_id = ? AND emoji = ?",
    ).get(issueId, actorType, actorId, emoji) as Row | null;
    return toIssueReaction(row!);
  }

  removeIssueReaction(issueId: string, input: { actorType?: string; actorId?: string | null; emoji: string }): void {
    const actorType = input.actorType ?? "member";
    const actorId = input.actorId ?? "local";
    const emoji = input.emoji?.trim();
    if (!emoji) throw new Error("emoji is required");
    this.db.run(
      "DELETE FROM multica_issue_reactions WHERE issue_id = ? AND actor_type = ? AND actor_id = ? AND emoji = ?",
      [issueId, actorType, actorId, emoji],
    );
  }

  listCommentReactions(commentId: string): MulticaCommentReaction[] {
    if (!this.getRawIssueComment(commentId)) throw new Error(`Comment not found: ${commentId}`);
    const rows = this.db.query(
      "SELECT * FROM multica_comment_reactions WHERE comment_id = ? ORDER BY created_at ASC",
    ).all(commentId) as Row[];
    return rows.map(toCommentReaction);
  }

  addCommentReaction(commentId: string, input: { actorType?: string; actorId?: string | null; emoji: string }): MulticaCommentReaction {
    const comment = this.getRawIssueComment(commentId);
    if (!comment) throw new Error(`Comment not found: ${commentId}`);
    const issue = this.getIssue(comment.issueId);
    const actorType = input.actorType ?? "member";
    const actorId = input.actorId ?? "local";
    const emoji = input.emoji?.trim();
    if (!emoji) throw new Error("emoji is required");
    this.db.run(
      `INSERT INTO multica_comment_reactions (id, comment_id, workspace_id, actor_type, actor_id, emoji, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(comment_id, actor_type, actor_id, emoji) DO NOTHING`,
      [createId("rxn"), commentId, issue?.workspaceId ?? "local", actorType, actorId, emoji, nowIso()],
    );
    const row = this.db.query(
      "SELECT * FROM multica_comment_reactions WHERE comment_id = ? AND actor_type = ? AND actor_id = ? AND emoji = ?",
    ).get(commentId, actorType, actorId, emoji) as Row | null;
    return toCommentReaction(row!);
  }

  removeCommentReaction(commentId: string, input: { actorType?: string; actorId?: string | null; emoji: string }): void {
    const actorType = input.actorType ?? "member";
    const actorId = input.actorId ?? "local";
    const emoji = input.emoji?.trim();
    if (!emoji) throw new Error("emoji is required");
    this.db.run(
      "DELETE FROM multica_comment_reactions WHERE comment_id = ? AND actor_type = ? AND actor_id = ? AND emoji = ?",
      [commentId, actorType, actorId, emoji],
    );
  }

  createAttachment(input: CreateAttachmentInput): MulticaAttachment {
    if (!input.filename?.trim()) throw new Error("filename is required");
    if (!input.url?.trim()) throw new Error("url is required");
    const issueId = input.issueId ?? input.issue_id ?? null;
    const commentId = input.commentId ?? input.comment_id ?? null;
    const issue = issueId ? this.getIssue(issueId) : null;
    const comment = commentId ? this.getRawIssueComment(commentId) : null;
    if (issueId && !issue) throw new Error(`Issue not found: ${issueId}`);
    if (commentId && !comment) throw new Error(`Comment not found: ${commentId}`);
    const workspaceId = input.workspaceId ?? input.workspace_id ?? issue?.workspaceId ?? (comment ? this.getIssue(comment.issueId)?.workspaceId : null) ?? "local";
    const id = input.id ?? createId("att");
    const uploaderType = input.uploaderType ?? input.uploader_type ?? "member";
    const uploaderId = input.uploaderId ?? input.uploader_id ?? "local";
    this.db.run(
      `INSERT INTO multica_attachments (
        id, workspace_id, issue_id, comment_id, uploader_type, uploader_id, filename, url, content_type, size_bytes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        workspaceId,
        issueId,
        commentId,
        uploaderType,
        uploaderId,
        input.filename.trim(),
        input.url.trim(),
        input.contentType ?? input.content_type ?? "application/octet-stream",
        Math.max(0, Number(input.sizeBytes ?? input.size_bytes ?? 0)),
        nowIso(),
      ],
    );
    return this.getAttachment(id)!;
  }

  getAttachment(id: string): MulticaAttachment | null {
    const row = this.db.query("SELECT * FROM multica_attachments WHERE id = ?").get(id) as Row | null;
    return row ? toAttachment(row) : null;
  }

  deleteAttachment(id: string): MulticaAttachment | null {
    const attachment = this.getAttachment(id);
    if (!attachment) return null;
    this.db.run("DELETE FROM multica_attachments WHERE id = ?", [id]);
    return attachment;
  }

  listAttachmentsForIssue(issueId: string): MulticaAttachment[] {
    if (!this.getIssue(issueId)) throw new Error(`Issue not found: ${issueId}`);
    const rows = this.db.query(
      "SELECT * FROM multica_attachments WHERE issue_id = ? AND comment_id IS NULL ORDER BY created_at ASC",
    ).all(issueId) as Row[];
    return rows.map(toAttachment);
  }

  listAttachmentsForComment(commentId: string): MulticaAttachment[] {
    if (!this.getRawIssueComment(commentId)) throw new Error(`Comment not found: ${commentId}`);
    const rows = this.db.query(
      "SELECT * FROM multica_attachments WHERE comment_id = ? ORDER BY created_at ASC",
    ).all(commentId) as Row[];
    return rows.map(toAttachment);
  }

  linkAttachmentsToIssue(issueId: string, attachmentIds: string[]): void {
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    for (const attachmentId of attachmentIds) {
      const attachment = this.getAttachment(attachmentId);
      if (!attachment) throw new Error(`Attachment not found: ${attachmentId}`);
      this.db.run(
        "UPDATE multica_attachments SET issue_id = ?, workspace_id = ? WHERE id = ? AND issue_id IS NULL",
        [issueId, issue.workspaceId, attachmentId],
      );
    }
  }

  listIssueMetadata(issueId: string): Record<string, string | number | boolean> {
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    return issue.metadata;
  }

  setIssueMetadataKey(issueId: string, key: string, value: unknown): Record<string, string | number | boolean> {
    validateIssueMetadataKey(key);
    const normalized = validateIssueMetadataValue(value);
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const metadata = { ...issue.metadata };
    if (!(key in metadata) && Object.keys(metadata).length >= MAX_ISSUE_METADATA_KEYS) {
      throw new Error(`metadata cannot exceed ${MAX_ISSUE_METADATA_KEYS} keys`);
    }
    metadata[key] = normalized;
    validateIssueMetadataSize(metadata);
    const now = nowIso();
    this.db.run(
      "UPDATE multica_issues SET metadata = ?, updated_at = ? WHERE id = ?",
      [toJson(metadata), now, issueId],
    );
    this.appendIssueActivity(issueId, {
      actorType: "system",
      actorId: null,
      type: "issue_metadata_set",
      body: `${key}=${String(normalized)}`,
      data: { key, value: normalized },
    });
    return this.listIssueMetadata(issueId);
  }

  deleteIssueMetadataKey(issueId: string, key: string): Record<string, string | number | boolean> {
    validateIssueMetadataKey(key);
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const metadata = { ...issue.metadata };
    delete metadata[key];
    const now = nowIso();
    this.db.run(
      "UPDATE multica_issues SET metadata = ?, updated_at = ? WHERE id = ?",
      [toJson(metadata), now, issueId],
    );
    this.appendIssueActivity(issueId, {
      actorType: "system",
      actorId: null,
      type: "issue_metadata_deleted",
      body: key,
      data: { key },
    });
    return this.listIssueMetadata(issueId);
  }

  private appendIssueActivity(issueId: string, input: {
    actorType: string;
    actorId?: string | null;
    type: string;
    body?: string | null;
    data?: unknown | null;
  }): void {
    this.db.run(
      `INSERT INTO multica_issue_activity (id, issue_id, actor_type, actor_id, type, body, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        createId("act"),
        issueId,
        input.actorType,
        input.actorId ?? null,
        input.type,
        input.body ?? null,
        input.data == null ? null : toJson(input.data),
        nowIso(),
      ],
    );
  }

  createProject(input: CreateProjectInput): MulticaProject {
    if (!input.title?.trim()) throw new Error("Project title is required");
    const id = input.id ?? createId("prj");
    const now = nowIso();
    const tx = this.db.transaction(() => {
      this.db.run(
        `INSERT INTO multica_projects (
          id, title, description, icon, status, priority, workspace_id,
          lead_type, lead_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.title.trim(),
          input.description ?? null,
          input.icon ?? null,
          input.status ?? "planned",
          input.priority ?? "none",
          input.workspaceId ?? "local",
          input.leadType ?? null,
          input.leadId ?? null,
          now,
          now,
        ],
      );
      for (const resource of input.resources ?? []) {
        this.createProjectResource(id, resource);
      }
      return this.getProject(id)!;
    });
    return tx();
  }

  getProject(id: string): MulticaProject | null {
    const row = this.db.query(projectSelect("WHERE p.id = ?")).get(id) as Row | null;
    return row ? toProject(row) : null;
  }

  listProjects(workspaceId?: string | null): MulticaProject[] {
    const rows = workspaceId
      ? this.db.query(projectSelect("WHERE p.workspace_id = ? ORDER BY p.updated_at DESC")).all(workspaceId) as Row[]
      : this.db.query(projectSelect("ORDER BY p.updated_at DESC")).all() as Row[];
    return rows.map(toProject);
  }

  searchProjects(input: { q: string; workspaceId?: string | null; includeClosed?: boolean; limit?: number; offset?: number }): { projects: MulticaProjectSearchResult[]; total: number } {
    const query = normalizeSearchQuery(input.q);
    if (!query) throw new Error("q parameter is required");
    const workspaceId = input.workspaceId ?? "local";
    const includeClosed = Boolean(input.includeClosed);
    const limit = clampSearchLimit(input.limit);
    const offset = Math.max(0, Number(input.offset ?? 0));
    const rows = this.listProjects(workspaceId).filter((project) => {
      if (!includeClosed && ["completed", "cancelled"].includes(project.status)) return false;
      return searchMatch(project.title, query) || searchMatch(project.description ?? "", query);
    }).map((project) => {
      const matchSource = searchMatch(project.title, query) ? "title" : "description";
      const result: MulticaProjectSearchResult = {
        ...project,
        matchSource,
      };
      if (matchSource === "description" && project.description) result.matchedSnippet = extractSearchSnippet(project.description, query);
      return result;
    }).sort((left, right) => searchRank(left.matchSource) - searchRank(right.matchSource) || Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    return { projects: rows.slice(offset, offset + limit), total: rows.length };
  }

  updateProject(id: string, input: UpdateProjectInput): MulticaProject {
    const current = this.getProject(id);
    if (!current) throw new Error(`Project not found: ${id}`);
    const now = nowIso();
    this.db.run(
      `UPDATE multica_projects SET
        title = ?,
        description = ?,
        icon = ?,
        status = ?,
        priority = ?,
        lead_type = ?,
        lead_id = ?,
        updated_at = ?
       WHERE id = ?`,
      [
        input.title ?? current.title,
        input.description === undefined ? current.description : input.description,
        input.icon === undefined ? current.icon : input.icon,
        input.status ?? current.status,
        input.priority ?? current.priority,
        input.leadType === undefined ? current.leadType : input.leadType,
        input.leadId === undefined ? current.leadId : input.leadId,
        now,
        id,
      ],
    );
    return this.getProject(id)!;
  }

  archiveProject(id: string): MulticaProject {
    return this.updateProject(id, { status: "cancelled" });
  }

  listPinnedItems(workspaceId?: string | null, userId?: string | null): MulticaPinnedItem[] {
    const resolvedWorkspaceId = workspaceId ?? "local";
    const resolvedUserId = userId ?? "local";
    const rows = this.db.query(
      `SELECT * FROM multica_pinned_items
       WHERE workspace_id = ? AND user_id = ?
       ORDER BY position ASC, created_at ASC`,
    ).all(resolvedWorkspaceId, resolvedUserId) as Row[];
    return rows.map(toPinnedItem);
  }

  createPinnedItem(input: CreatePinnedItemInput): MulticaPinnedItem {
    const itemType = normalizePinnedItemType(input.itemType ?? input.item_type);
    const itemId = String(input.itemId ?? input.item_id ?? "").trim();
    if (!itemId) throw new Error("item_id is required");
    const workspaceId = input.workspaceId ?? input.workspace_id ?? "local";
    const userId = input.userId ?? input.user_id ?? "local";
    this.validatePinnedItemTarget(workspaceId, itemType, itemId);
    const existing = this.db.query(
      "SELECT id FROM multica_pinned_items WHERE workspace_id = ? AND user_id = ? AND item_type = ? AND item_id = ?",
    ).get(workspaceId, userId, itemType, itemId) as Row | null;
    if (existing) throw new Error("Item already pinned");
    const maxRow = this.db.query(
      "SELECT COALESCE(MAX(position), 0) AS max_position FROM multica_pinned_items WHERE workspace_id = ? AND user_id = ?",
    ).get(workspaceId, userId) as Row | null;
    const id = input.id ?? createId("pin");
    const position = Number(maxRow?.max_position ?? 0) + 1;
    this.db.run(
      `INSERT INTO multica_pinned_items (id, workspace_id, user_id, item_type, item_id, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, workspaceId, userId, itemType, itemId, position, nowIso()],
    );
    return this.getPinnedItem(id)!;
  }

  getPinnedItem(id: string): MulticaPinnedItem | null {
    const row = this.db.query("SELECT * FROM multica_pinned_items WHERE id = ?").get(id) as Row | null;
    return row ? toPinnedItem(row) : null;
  }

  deletePinnedItem(workspaceId: string | null | undefined, userId: string | null | undefined, itemType: string, itemId: string): void {
    const normalizedType = normalizePinnedItemType(itemType);
    this.db.run(
      "DELETE FROM multica_pinned_items WHERE workspace_id = ? AND user_id = ? AND item_type = ? AND item_id = ?",
      [workspaceId ?? "local", userId ?? "local", normalizedType, itemId],
    );
  }

  reorderPinnedItems(workspaceId: string | null | undefined, userId: string | null | undefined, items: ReorderPinnedItemInput[]): MulticaPinnedItem[] {
    const resolvedWorkspaceId = workspaceId ?? "local";
    const resolvedUserId = userId ?? "local";
    const tx = this.db.transaction(() => {
      for (const item of items) {
        if (!item.id) throw new Error("items[].id is required");
        const position = Number(item.position);
        if (!Number.isFinite(position)) throw new Error("items[].position must be a finite number");
        this.db.run(
          "UPDATE multica_pinned_items SET position = ? WHERE id = ? AND workspace_id = ? AND user_id = ?",
          [position, item.id, resolvedWorkspaceId, resolvedUserId],
        );
      }
      return this.listPinnedItems(resolvedWorkspaceId, resolvedUserId);
    });
    return tx();
  }

  listProjectResources(projectId: string): MulticaProjectResource[] {
    if (!this.getProject(projectId)) throw new Error(`Project not found: ${projectId}`);
    const rows = this.db.query(
      "SELECT * FROM multica_project_resources WHERE project_id = ? ORDER BY position ASC, created_at ASC",
    ).all(projectId) as Row[];
    return rows.map(toProjectResource);
  }

  createProjectResource(projectId: string, input: CreateProjectResourceInput): MulticaProjectResource {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const resourceType = String(input.resourceType ?? input.resource_type ?? "").trim();
    const rawRef = input.resourceRef ?? input.resource_ref ?? {};
    const resourceRef = normalizeProjectResourceRef(resourceType, rawRef);
    const id = input.id ?? createId("res");
    const now = nowIso();
    const position = input.position ?? this.countProjectResources(projectId);
    this.db.run(
      `INSERT INTO multica_project_resources (
        id, project_id, workspace_id, resource_type, resource_ref, label, position, created_at, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        projectId,
        project.workspaceId,
        resourceType,
        toJson(resourceRef),
        input.label ?? null,
        position,
        now,
        input.createdBy ?? null,
      ],
    );
    this.db.run("UPDATE multica_projects SET updated_at = ? WHERE id = ?", [now, projectId]);
    return this.getProjectResource(id)!;
  }

  getProjectResource(id: string): MulticaProjectResource | null {
    const row = this.db.query("SELECT * FROM multica_project_resources WHERE id = ?").get(id) as Row | null;
    return row ? toProjectResource(row) : null;
  }

  deleteProjectResource(projectId: string, resourceId: string): void {
    if (!this.getProject(projectId)) throw new Error(`Project not found: ${projectId}`);
    const now = nowIso();
    const result = this.db.run(
      "DELETE FROM multica_project_resources WHERE project_id = ? AND id = ?",
      [projectId, resourceId],
    );
    if (result.changes === 0) throw new Error(`Project resource not found: ${resourceId}`);
    this.db.run("UPDATE multica_projects SET updated_at = ? WHERE id = ?", [now, projectId]);
  }

  createSquad(input: CreateSquadInput): MulticaSquad {
    if (!input.name?.trim()) throw new Error("Squad name is required");
    if (input.leaderId && !this.getAgent(input.leaderId)) throw new Error(`Agent not found: ${input.leaderId}`);
    const id = input.id ?? createId("sqd");
    const now = nowIso();
    this.db.run(
      `INSERT INTO multica_squads (
        id, name, description, instructions, workspace_id, leader_id,
        creator_id, archived_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      [
        id,
        input.name.trim(),
        input.description ?? "",
        input.instructions ?? "",
        input.workspaceId ?? "local",
        input.leaderId ?? null,
        input.creatorId ?? null,
        now,
        now,
      ],
    );
    if (input.leaderId) this.addSquadMember(id, { memberType: "agent", memberId: input.leaderId, role: "leader" });
    for (const memberId of input.memberIds ?? []) {
      if (memberId !== input.leaderId) this.addSquadMember(id, { memberType: "agent", memberId, role: "member" });
    }
    return this.getSquad(id)!;
  }

  getSquad(id: string): MulticaSquad | null {
    const row = this.db.query(squadSelect("WHERE s.id = ?")).get(id) as Row | null;
    return row ? toSquad(row) : null;
  }

  listSquads(workspaceId?: string | null): MulticaSquad[] {
    const rows = workspaceId
      ? this.db.query(squadSelect("WHERE s.workspace_id = ? AND s.archived_at IS NULL ORDER BY s.updated_at DESC")).all(workspaceId) as Row[]
      : this.db.query(squadSelect("WHERE s.archived_at IS NULL ORDER BY s.updated_at DESC")).all() as Row[];
    return rows.map(toSquad);
  }

  updateSquad(id: string, input: UpdateSquadInput): MulticaSquad {
    const current = this.getSquad(id);
    if (!current) throw new Error(`Squad not found: ${id}`);
    if (input.leaderId && !this.getAgent(input.leaderId)) throw new Error(`Agent not found: ${input.leaderId}`);
    const now = nowIso();
    this.db.run(
      `UPDATE multica_squads SET
        name = ?,
        description = ?,
        instructions = ?,
        leader_id = ?,
        updated_at = ?
       WHERE id = ?`,
      [
        input.name ?? current.name,
        input.description === undefined ? current.description : input.description ?? "",
        input.instructions === undefined ? current.instructions : input.instructions ?? "",
        input.leaderId === undefined ? current.leaderId : input.leaderId,
        now,
        id,
      ],
    );
    if (input.leaderId) this.addSquadMember(id, { memberType: "agent", memberId: input.leaderId, role: "leader" });
    return this.getSquad(id)!;
  }

  archiveSquad(id: string): MulticaSquad {
    if (!this.getSquad(id)) throw new Error(`Squad not found: ${id}`);
    const now = nowIso();
    this.db.run("UPDATE multica_squads SET archived_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
    return this.getSquad(id)!;
  }

  addSquadMember(squadId: string, input: AddSquadMemberInput): MulticaSquadMember {
    const squad = this.getSquad(squadId);
    if (!squad) throw new Error(`Squad not found: ${squadId}`);
    if (input.memberType === "agent") {
      const agent = this.getAgent(input.memberId);
      if (!agent) throw new Error(`Agent not found: ${input.memberId}`);
      if (agent.archivedAt) throw new Error(`Agent is archived: ${input.memberId}`);
    } else if (input.memberType === "member") {
      const member = this.getWorkspaceMember(input.memberId);
      if (!member) throw new Error(`Member not found: ${input.memberId}`);
      if (member.archivedAt) throw new Error(`Member is archived: ${input.memberId}`);
    }
    const now = nowIso();
    const existing = this.db.query(
      "SELECT * FROM multica_squad_members WHERE squad_id = ? AND member_type = ? AND member_id = ?",
    ).get(squadId, input.memberType, input.memberId) as Row | null;
    if (existing) {
      this.db.run(
        "UPDATE multica_squad_members SET role = ? WHERE id = ?",
        [input.role ?? "member", String(existing.id)],
      );
      return this.getSquadMember(String(existing.id))!;
    }
    const id = createId("sqm");
    this.db.run(
      `INSERT INTO multica_squad_members (id, squad_id, member_type, member_id, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, squadId, input.memberType, input.memberId, input.role ?? "member", now],
    );
    this.db.run("UPDATE multica_squads SET updated_at = ? WHERE id = ?", [now, squadId]);
    return this.getSquadMember(id)!;
  }

  removeSquadMember(squadId: string, input: RemoveSquadMemberInput): void {
    const now = nowIso();
    this.db.run(
      "DELETE FROM multica_squad_members WHERE squad_id = ? AND member_type = ? AND member_id = ?",
      [squadId, input.memberType, input.memberId],
    );
    const squad = this.getSquad(squadId);
    if (squad?.leaderId === input.memberId && input.memberType === "agent") {
      this.db.run("UPDATE multica_squads SET leader_id = NULL, updated_at = ? WHERE id = ?", [now, squadId]);
    } else {
      this.db.run("UPDATE multica_squads SET updated_at = ? WHERE id = ?", [now, squadId]);
    }
  }

  getSquadMember(id: string): MulticaSquadMember | null {
    const row = this.db.query("SELECT * FROM multica_squad_members WHERE id = ?").get(id) as Row | null;
    return row ? toSquadMember(row) : null;
  }

  listSquadMembers(squadId: string): MulticaSquadMember[] {
    const rows = this.db.query(
      "SELECT * FROM multica_squad_members WHERE squad_id = ? ORDER BY role = 'leader' DESC, created_at ASC",
    ).all(squadId) as Row[];
    return rows.map(toSquadMember);
  }

  createAutopilot(input: CreateAutopilotInput): MulticaAutopilot {
    if (!input.title?.trim()) throw new Error("Autopilot title is required");
    const assigneeType = input.assigneeType ?? "agent";
    if (assigneeType === "agent" && !this.getAgent(input.assigneeId)) throw new Error(`Agent not found: ${input.assigneeId}`);
    if (assigneeType === "squad" && !this.getSquad(input.assigneeId)) throw new Error(`Squad not found: ${input.assigneeId}`);
    if (input.projectId && !this.getProject(input.projectId)) throw new Error(`Project not found: ${input.projectId}`);
    const id = input.id ?? createId("aut");
    const now = nowIso();
    this.db.run(
      `INSERT INTO multica_autopilots (
        id, title, description, project_id, workspace_id, assignee_type,
        assignee_id, status, execution_mode, issue_title_template,
        trigger_kind, trigger_label, cron_expression, last_run_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      [
        id,
        input.title.trim(),
        input.description ?? null,
        input.projectId ?? null,
        input.workspaceId ?? "local",
        assigneeType,
        input.assigneeId,
        input.status ?? "active",
        input.executionMode ?? "create_issue",
        input.issueTitleTemplate ?? null,
        input.triggerKind ?? "manual",
        input.triggerLabel ?? null,
        input.cronExpression ?? null,
        now,
        now,
      ],
    );
    return this.getAutopilot(id)!;
  }

  getAutopilot(id: string): MulticaAutopilot | null {
    const row = this.db.query("SELECT * FROM multica_autopilots WHERE id = ?").get(id) as Row | null;
    return row ? toAutopilot(row) : null;
  }

  listAutopilots(workspaceId?: string | null): MulticaAutopilot[] {
    const rows = workspaceId
      ? this.db.query("SELECT * FROM multica_autopilots WHERE workspace_id = ? AND status != 'archived' ORDER BY updated_at DESC").all(workspaceId) as Row[]
      : this.db.query("SELECT * FROM multica_autopilots WHERE status != 'archived' ORDER BY updated_at DESC").all() as Row[];
    return rows.map(toAutopilot);
  }

  updateAutopilot(id: string, input: UpdateAutopilotInput): MulticaAutopilot {
    const current = this.getAutopilot(id);
    if (!current) throw new Error(`Autopilot not found: ${id}`);
    const nextAssigneeType = input.assigneeType ?? current.assigneeType;
    const nextAssigneeId = input.assigneeId ?? current.assigneeId;
    if (nextAssigneeType === "agent" && !this.getAgent(nextAssigneeId)) throw new Error(`Agent not found: ${nextAssigneeId}`);
    if (nextAssigneeType === "squad" && !this.getSquad(nextAssigneeId)) throw new Error(`Squad not found: ${nextAssigneeId}`);
    if (input.projectId && !this.getProject(input.projectId)) throw new Error(`Project not found: ${input.projectId}`);
    const now = nowIso();
    this.db.run(
      `UPDATE multica_autopilots SET
        title = ?,
        description = ?,
        project_id = ?,
        assignee_type = ?,
        assignee_id = ?,
        status = ?,
        execution_mode = ?,
        issue_title_template = ?,
        trigger_kind = ?,
        trigger_label = ?,
        cron_expression = ?,
        updated_at = ?
       WHERE id = ?`,
      [
        input.title ?? current.title,
        input.description === undefined ? current.description : input.description,
        input.projectId === undefined ? current.projectId : input.projectId,
        nextAssigneeType,
        nextAssigneeId,
        input.status ?? current.status,
        input.executionMode ?? current.executionMode,
        input.issueTitleTemplate === undefined ? current.issueTitleTemplate : input.issueTitleTemplate,
        input.triggerKind ?? current.triggerKind,
        input.triggerLabel === undefined ? current.triggerLabel : input.triggerLabel,
        input.cronExpression === undefined ? current.cronExpression : input.cronExpression,
        now,
        id,
      ],
    );
    return this.getAutopilot(id)!;
  }

  archiveAutopilot(id: string): MulticaAutopilot {
    return this.updateAutopilot(id, { status: "archived" });
  }

  listAutopilotRuns(autopilotId: string): MulticaAutopilotRun[] {
    const rows = this.db.query(
      "SELECT * FROM multica_autopilot_runs WHERE autopilot_id = ? ORDER BY created_at DESC LIMIT 20",
    ).all(autopilotId) as Row[];
    return rows.map(toAutopilotRun);
  }

  runAutopilot(autopilotId: string, input: RunAutopilotInput = {}): MulticaAutopilotRun {
    const autopilot = this.getAutopilot(autopilotId);
    if (!autopilot) throw new Error(`Autopilot not found: ${autopilotId}`);
    const now = nowIso();
    const runId = createId("run");
    const source = input.source ?? "manual";
    const prompt = (input.prompt || autopilot.issueTitleTemplate || autopilot.title).trim();
    const agent = this.resolveAutopilotAgent(autopilot);
    if (!agent || autopilot.status !== "active") {
      this.db.run(
        `INSERT INTO multica_autopilot_runs (
          id, autopilot_id, source, status, issue_id, task_id, triggered_at,
          completed_at, failure_reason, payload, result, created_at
        ) VALUES (?, ?, ?, 'skipped', NULL, NULL, ?, ?, ?, ?, NULL, ?)`,
        [
          runId,
          autopilotId,
          source,
          now,
          now,
          agent ? "Autopilot is not active" : "No runnable agent",
          input.payload == null ? null : toJson(input.payload),
          now,
        ],
      );
      this.db.run("UPDATE multica_autopilots SET last_run_at = ?, updated_at = ? WHERE id = ?", [now, now, autopilotId]);
      return this.getAutopilotRun(runId)!;
    }

    let issue: MulticaIssue | null = null;
    if (autopilot.executionMode === "create_issue") {
      issue = this.createIssue({
        title: prompt,
        description: autopilot.description,
        workspaceId: autopilot.workspaceId,
        projectId: autopilot.projectId,
        createdBy: autopilot.id,
      });
    }
    const task = this.createTask({
      agentId: agent.id,
      issueId: issue?.id ?? null,
      workspaceId: autopilot.workspaceId,
      prompt,
    });
    this.db.run(
      `INSERT INTO multica_autopilot_runs (
        id, autopilot_id, source, status, issue_id, task_id, triggered_at,
        completed_at, failure_reason, payload, result, created_at
      ) VALUES (?, ?, ?, 'running', ?, ?, ?, NULL, NULL, ?, ?, ?)`,
      [
        runId,
        autopilotId,
        source,
        issue?.id ?? null,
        task.id,
        now,
        input.payload == null ? null : toJson(input.payload),
        toJson({ taskId: task.id, issueId: issue?.id ?? null }),
        now,
      ],
    );
    this.db.run("UPDATE multica_autopilots SET last_run_at = ?, updated_at = ? WHERE id = ?", [now, now, autopilotId]);
    return this.getAutopilotRun(runId)!;
  }

  getAutopilotRun(id: string): MulticaAutopilotRun | null {
    const row = this.db.query("SELECT * FROM multica_autopilot_runs WHERE id = ?").get(id) as Row | null;
    return row ? toAutopilotRun(row) : null;
  }

  createChatSession(input: CreateChatSessionInput): MulticaChatSession {
    const agent = this.getAgent(input.agentId);
    if (!agent) throw new Error(`Agent not found: ${input.agentId}`);
    if (agent.archivedAt) throw new Error(`Agent is archived: ${input.agentId}`);
    const id = input.id ?? createId("chat");
    const now = nowIso();
    const title = input.title?.trim() || `Chat with ${agent.name}`;
    this.db.run(
      `INSERT INTO multica_chat_sessions (
        id, workspace_id, agent_id, title, status, session_id, work_dir, latest_task_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'active', NULL, NULL, NULL, ?, ?)`,
      [id, input.workspaceId ?? "local", input.agentId, title, now, now],
    );
    return this.getChatSession(id)!;
  }

  listChatSessions(workspaceId?: string | null): MulticaChatSession[] {
    const rows = workspaceId
      ? this.db.query("SELECT * FROM multica_chat_sessions WHERE workspace_id = ? AND status != 'archived' ORDER BY updated_at DESC").all(workspaceId) as Row[]
      : this.db.query("SELECT * FROM multica_chat_sessions WHERE status != 'archived' ORDER BY updated_at DESC").all() as Row[];
    return rows.map(toChatSession);
  }

  getChatSession(id: string): MulticaChatSession | null {
    const row = this.db.query("SELECT * FROM multica_chat_sessions WHERE id = ?").get(id) as Row | null;
    return row ? toChatSession(row) : null;
  }

  updateChatSession(id: string, input: UpdateChatSessionInput): MulticaChatSession {
    const current = this.getChatSession(id);
    if (!current) throw new Error(`Chat session not found: ${id}`);
    const now = nowIso();
    this.db.run(
      `UPDATE multica_chat_sessions
       SET title = ?, status = ?, updated_at = ?
       WHERE id = ?`,
      [input.title?.trim() || current.title, input.status ?? current.status, now, id],
    );
    return this.getChatSession(id)!;
  }

  listChatMessages(chatSessionId: string): MulticaChatMessage[] {
    if (!this.getChatSession(chatSessionId)) throw new Error(`Chat session not found: ${chatSessionId}`);
    const rows = this.db.query(
      "SELECT * FROM multica_chat_messages WHERE chat_session_id = ? ORDER BY created_at ASC",
    ).all(chatSessionId) as Row[];
    return rows.map(toChatMessage);
  }

  sendChatMessage(chatSessionId: string, input: SendChatMessageInput): SendChatMessageResult {
    const session = this.getChatSession(chatSessionId);
    if (!session) throw new Error(`Chat session not found: ${chatSessionId}`);
    if (session.status === "archived") throw new Error(`Chat session is archived: ${chatSessionId}`);
    const body = input.body?.trim();
    if (!body) throw new Error("Chat message body is required");
    const now = nowIso();
    const messageId = createId("msg");
    const task = this.createTask({
      agentId: session.agentId,
      chatSessionId: session.id,
      workspaceId: session.workspaceId,
      prompt: body,
      sessionId: session.sessionId,
      workDir: session.workDir,
    });
    this.db.run(
      `INSERT INTO multica_chat_messages (id, chat_session_id, task_id, role, body, created_at)
       VALUES (?, ?, ?, 'user', ?, ?)`,
      [messageId, session.id, task.id, body, now],
    );
    this.db.run(
      "UPDATE multica_chat_sessions SET latest_task_id = ?, updated_at = ? WHERE id = ?",
      [task.id, now, session.id],
    );
    return {
      session: this.getChatSession(session.id)!,
      message: this.getChatMessage(messageId)!,
      task,
    };
  }

  getChatMessage(id: string): MulticaChatMessage | null {
    const row = this.db.query("SELECT * FROM multica_chat_messages WHERE id = ?").get(id) as Row | null;
    return row ? toChatMessage(row) : null;
  }

  createTask(input: CreateTaskInput): MulticaTask {
    const agent = this.getAgent(input.agentId);
    if (!agent) throw new Error(`Agent not found: ${input.agentId}`);
    if (agent.archivedAt) throw new Error(`Agent is archived: ${input.agentId}`);
    const issue = input.issueId ? this.getIssue(input.issueId) : null;
    if (input.issueId && !issue) throw new Error(`Issue not found: ${input.issueId}`);
    const chatSession = input.chatSessionId ? this.getChatSession(input.chatSessionId) : null;
    if (input.chatSessionId && !chatSession) throw new Error(`Chat session not found: ${input.chatSessionId}`);
    if (chatSession && chatSession.agentId !== input.agentId) throw new Error("Chat session agent does not match task agent");

    const id = input.id ?? createId("tsk");
    const now = nowIso();
    this.db.run(
      `INSERT INTO multica_tasks (
        id, agent_id, issue_id, chat_session_id, workspace_id, status, priority, prompt,
        session_id, work_dir, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.agentId,
        input.issueId ?? null,
        input.chatSessionId ?? null,
        input.workspaceId ?? issue?.workspaceId ?? chatSession?.workspaceId ?? "local",
        input.priority ?? 0,
        input.prompt,
        input.sessionId ?? chatSession?.sessionId ?? null,
        input.workDir ?? chatSession?.workDir ?? agent.cwd ?? null,
        now,
        now,
      ],
    );
    return this.getTask(id)!;
  }

  getTask(id: string): MulticaTask | null {
    const row = this.db.query("SELECT * FROM multica_tasks WHERE id = ?").get(id) as Row | null;
    return row ? toTask(row) : null;
  }

  getTaskWithAgent(id: string): MulticaTaskWithAgent | null {
    const task = this.getTask(id);
    if (!task) return null;
    const issue = task.issueId ? this.getIssue(task.issueId) : null;
    const project = issue?.projectId ? this.getProject(issue.projectId) : null;
    return {
      ...task,
      agent: this.getAgent(task.agentId),
      issue,
      project,
      projectResources: project ? this.listProjectResources(project.id) : [],
    };
  }

  listTasks(status?: MulticaTaskStatus): MulticaTask[] {
    const rows = status
      ? this.db.query("SELECT * FROM multica_tasks WHERE status = ? ORDER BY created_at DESC").all(status) as Row[]
      : this.db.query("SELECT * FROM multica_tasks ORDER BY created_at DESC").all() as Row[];
    return rows.map(toTask);
  }

  claimTask(runtimeId: string): MulticaTaskWithAgent | null {
    const tx = this.db.transaction(() => {
      const runtime = this.getRuntime(runtimeId);
      if (!runtime) throw new Error(`Runtime not found: ${runtimeId}`);
      this.heartbeatRuntime(runtimeId);

      const active = this.db.query(
        "SELECT COUNT(*) AS count FROM multica_tasks WHERE runtime_id = ? AND status IN ('dispatched', 'running')",
      ).get(runtimeId) as { count: number } | null;
      if (Number(active?.count ?? 0) >= runtime.maxConcurrency) return null;

      const workspaceFilter = runtime.workspaceId ? "AND t.workspace_id = ?" : "";
      const params = runtime.workspaceId
        ? [runtime.workspaceId, runtime.provider, runtime.provider]
        : [runtime.provider, runtime.provider];
      const row = this.db.query(
        `SELECT t.*
         FROM multica_tasks t
         JOIN multica_agents a ON a.id = t.agent_id
         WHERE t.status = 'queued'
           AND a.archived_at IS NULL
           ${workspaceFilter}
           AND (? = 'any' OR a.provider = ?)
         ORDER BY t.priority DESC, t.created_at ASC
         LIMIT 1`,
      ).get(...params) as Row | null;

      if (!row) return null;

      const now = nowIso();
      const result = this.db.run(
        `UPDATE multica_tasks
         SET status = 'dispatched', runtime_id = ?, dispatched_at = ?, updated_at = ?
         WHERE id = ? AND status = 'queued'`,
        [runtimeId, now, now, String(row.id)],
      );
      if (result.changes === 0) return null;
      return this.getTaskWithAgent(String(row.id));
    });
    return tx();
  }

  startTask(taskId: string): MulticaTask {
    const now = nowIso();
    const result = this.db.run(
      `UPDATE multica_tasks
       SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
       WHERE id = ? AND status IN ('queued', 'dispatched', 'running')`,
      [now, now, taskId],
    );
    if (result.changes === 0) throw new Error(`Task not found or terminal: ${taskId}`);
    return this.getTask(taskId)!;
  }

  reportProgress(taskId: string, summary: string, step?: number | null, total?: number | null): void {
    this.db.run(
      `UPDATE multica_tasks
       SET progress_summary = ?, progress_step = ?, progress_total = ?, updated_at = ?
       WHERE id = ?`,
      [summary, step ?? null, total ?? null, nowIso(), taskId],
    );
  }

  pinTaskSession(taskId: string, sessionId?: string | null, workDir?: string | null): void {
    this.db.run(
      `UPDATE multica_tasks
       SET session_id = COALESCE(?, session_id), work_dir = COALESCE(?, work_dir), updated_at = ?
       WHERE id = ?`,
      [sessionId ?? null, workDir ?? null, nowIso(), taskId],
    );
  }

  appendTaskMessages(taskId: string, messages: TaskMessageInput[]): MulticaTaskMessage[] {
    if (messages.length === 0) return [];
    const current = this.db.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM multica_task_messages WHERE task_id = ?")
      .get(taskId) as { seq: number } | null;
    let nextSeq = Number(current?.seq ?? 0) + 1;
    const insertedSeqs: number[] = [];
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO multica_task_messages (
        id, task_id, seq, type, tool, content, input, output, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction(() => {
      for (const message of messages) {
        const seq = message.seq ?? nextSeq++;
        insertedSeqs.push(seq);
        const id = createId("msg");
        insert.run(
          id,
          taskId,
          seq,
          message.type,
          message.tool ?? null,
          message.content ?? null,
          message.input == null ? null : toJson(message.input),
          message.output ?? null,
          nowIso(),
        );
      }
      this.db.run("UPDATE multica_tasks SET updated_at = ? WHERE id = ?", [nowIso(), taskId]);
    });
    tx();
    const inserted: MulticaTaskMessage[] = [];
    for (const seq of insertedSeqs) {
      const row = this.db.query(
        "SELECT * FROM multica_task_messages WHERE task_id = ? AND seq = ?",
      ).get(taskId, seq) as Row | null;
      if (row) inserted.push(toTaskMessage(row));
    }
    return inserted;
  }

  listTaskMessages(taskId: string): MulticaTaskMessage[] {
    const rows = this.db.query(
      "SELECT * FROM multica_task_messages WHERE task_id = ? ORDER BY seq ASC",
    ).all(taskId) as Row[];
    return rows.map(toTaskMessage);
  }

  completeTask(taskId: string, input: {
    output: string;
    branchName?: string | null;
    sessionId?: string | null;
    workDir?: string | null;
  }): MulticaTask {
    const now = nowIso();
    const result = this.db.run(
      `UPDATE multica_tasks
       SET status = 'completed',
           result = ?,
           branch_name = ?,
           session_id = COALESCE(?, session_id),
           work_dir = COALESCE(?, work_dir),
           completed_at = ?,
           updated_at = ?
       WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled')`,
      [input.output, input.branchName ?? null, input.sessionId ?? null, input.workDir ?? null, now, now, taskId],
    );
    if (result.changes === 0) throw new Error(`Task not found or terminal: ${taskId}`);
    const task = this.getTask(taskId)!;
    this.afterTaskTerminal(task, "completed", input.output);
    return task;
  }

  failTask(taskId: string, input: {
    error: string;
    sessionId?: string | null;
    workDir?: string | null;
  }): MulticaTask {
    const now = nowIso();
    const result = this.db.run(
      `UPDATE multica_tasks
       SET status = 'failed',
           error = ?,
           session_id = COALESCE(?, session_id),
           work_dir = COALESCE(?, work_dir),
           failed_at = ?,
           updated_at = ?
       WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled')`,
      [input.error, input.sessionId ?? null, input.workDir ?? null, now, now, taskId],
    );
    if (result.changes === 0) throw new Error(`Task not found or terminal: ${taskId}`);
    const task = this.getTask(taskId)!;
    this.afterTaskTerminal(task, "failed", input.error);
    return task;
  }

  cancelTask(taskId: string): MulticaTask {
    const now = nowIso();
    const result = this.db.run(
      `UPDATE multica_tasks
       SET status = 'cancelled', cancelled_at = ?, updated_at = ?
       WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled')`,
      [now, now, taskId],
    );
    if (result.changes === 0) throw new Error(`Task not found or terminal: ${taskId}`);
    const task = this.getTask(taskId)!;
    this.afterTaskTerminal(task, "cancelled", null);
    return task;
  }

  getTaskStatus(taskId: string): MulticaTaskStatus {
    const row = this.db.query("SELECT status FROM multica_tasks WHERE id = ?").get(taskId) as { status: string } | null;
    if (!row) throw new Error(`Task not found: ${taskId}`);
    return row.status as MulticaTaskStatus;
  }

  reportTaskUsage(taskId: string, usage: TaskUsageEntry[]): void {
    this.db.run(
      "UPDATE multica_tasks SET usage = ?, updated_at = ? WHERE id = ?",
      [toJson(usage), nowIso(), taskId],
    );
  }

  recoverOrphans(runtimeId: string): number {
    const now = nowIso();
    const result = this.db.run(
      `UPDATE multica_tasks
       SET status = 'queued',
           runtime_id = NULL,
           error = NULL,
           dispatched_at = NULL,
           started_at = NULL,
           updated_at = ?
       WHERE runtime_id = ? AND status IN ('dispatched', 'running')`,
      [now, runtimeId],
    );
    return result.changes;
  }

  private resolveRunnableAgentForAssignee(assigneeType: MulticaAssigneeType, assigneeId: string): MulticaAgent | null {
    if (assigneeType === "agent") {
      const agent = this.getAgent(assigneeId);
      return agent?.archivedAt ? null : agent;
    }
    if (assigneeType !== "squad") return null;
    const squad = this.getSquad(assigneeId);
    if (!squad) return null;
    if (squad.archivedAt) return null;
    if (squad.leaderId) {
      const leader = this.getAgent(squad.leaderId);
      if (leader && !leader.archivedAt) return leader;
    }
    for (const member of this.listSquadMembers(squad.id).filter((m) => m.memberType === "agent")) {
      const agent = this.getAgent(member.memberId);
      if (agent && !agent.archivedAt) return agent;
    }
    return null;
  }

  private resolveAutopilotAgent(autopilot: MulticaAutopilot): MulticaAgent | null {
    return this.resolveRunnableAgentForAssignee(autopilot.assigneeType, autopilot.assigneeId);
  }

  private validateIssueAssignee(assigneeType: MulticaAssigneeType | null, assigneeId: string | null): void {
    if (!assigneeType && !assigneeId) return;
    if (!assigneeType || !assigneeId) throw new Error("Assignee type and id are required together");
    if (assigneeType === "agent") {
      const agent = this.getAgent(assigneeId);
      if (!agent) throw new Error(`Agent not found: ${assigneeId}`);
      if (agent.archivedAt) throw new Error(`Agent is archived: ${assigneeId}`);
    } else if (assigneeType === "member") {
      const member = this.getWorkspaceMember(assigneeId);
      if (!member) throw new Error(`Member not found: ${assigneeId}`);
      if (member.archivedAt) throw new Error(`Member is archived: ${assigneeId}`);
    } else if (assigneeType === "squad") {
      const squad = this.getSquad(assigneeId);
      if (!squad) throw new Error(`Squad not found: ${assigneeId}`);
      if (squad.archivedAt) throw new Error(`Squad is archived: ${assigneeId}`);
    } else {
      throw new Error(`Unsupported assignee type: ${assigneeType}`);
    }
  }

  private validateIssueParent(issueId: string, parentIssueId: string): void {
    if (issueId === parentIssueId) throw new Error("An issue cannot be its own parent");
    let cursor: string | null = parentIssueId;
    const seen = new Set<string>();
    for (let depth = 0; cursor && depth < 100; depth++) {
      if (cursor === issueId) throw new Error("Circular parent issue relationship detected");
      if (seen.has(cursor)) throw new Error("Circular parent issue relationship detected");
      seen.add(cursor);
      cursor = this.getIssue(cursor)?.parentIssueId ?? null;
    }
  }

  private cancelActiveIssueTasks(issueId: string, reason: string): number {
    const active = this.db.query(
      "SELECT * FROM multica_tasks WHERE issue_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')",
    ).all(issueId) as Row[];
    if (!active.length) return 0;
    const now = nowIso();
    this.db.run(
      `UPDATE multica_tasks
       SET status = 'cancelled', cancelled_at = ?, updated_at = ?
       WHERE issue_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')`,
      [now, now, issueId],
    );
    for (const row of active) {
      this.appendIssueActivity(issueId, {
        actorType: "system",
        actorId: null,
        type: "task_cancelled",
        body: reason,
        data: { taskId: String(row.id), agentId: nullableString(row.agent_id) },
      });
    }
    return active.length;
  }

  private createInboxItem(input: {
    issueId: string;
    memberId: string;
    type: string;
    title: string;
    body?: string | null;
    actorType?: string;
    actorId?: string | null;
  }): MulticaInboxItem | null {
    const issue = this.getIssue(input.issueId);
    if (!issue) throw new Error(`Issue not found: ${input.issueId}`);
    const member = this.getWorkspaceMember(input.memberId);
    if (!member || member.archivedAt) return null;
    const id = createId("inb");
    const now = nowIso();
    this.db.run(
      `INSERT INTO multica_inbox_items (
        id, workspace_id, issue_id, member_id, actor_type, actor_id, type, title, body, read, archived, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
      [
        id,
        issue.workspaceId,
        issue.id,
        input.memberId,
        input.actorType ?? "system",
        input.actorId ?? null,
        input.type,
        input.title,
        input.body ?? null,
        now,
      ],
    );
    const row = this.db.query("SELECT * FROM multica_inbox_items WHERE id = ?").get(id) as Row | null;
    return toInboxItem(row!, issue);
  }

  private getRawIssueComment(id: string): MulticaIssueComment | null {
    const row = this.db.query("SELECT * FROM multica_issue_comments WHERE id = ?").get(id) as Row | null;
    return row ? toIssueComment(row) : null;
  }

  private hydrateIssue(issue: MulticaIssue): MulticaIssue {
    return {
      ...issue,
      labels: this.listLabelsForIssue(issue.id),
    };
  }

  private hydrateRuntime(runtime: MulticaRuntime): MulticaRuntime {
    const stats = this.runtimeUsageSummary(runtime.id);
    return {
      ...runtime,
      ...stats,
    };
  }

  private hydrateIssueComment(comment: MulticaIssueComment): MulticaIssueComment {
    return {
      ...comment,
      reactions: this.listCommentReactions(comment.id),
      attachments: this.listAttachmentsForComment(comment.id),
    };
  }

  private hydrateIssueDependency(dependency: MulticaIssueDependency): MulticaIssueDependency {
    return {
      ...dependency,
      issue: this.getIssue(dependency.issueId),
      dependsOnIssue: this.getIssue(dependency.dependsOnIssueId),
    };
  }

  private collectCommentTreeIds(commentId: string): string[] {
    const ids: string[] = [];
    const visit = (id: string) => {
      ids.push(id);
      const rows = this.db.query("SELECT id FROM multica_issue_comments WHERE parent_id = ? ORDER BY created_at ASC").all(id) as Row[];
      for (const row of rows) visit(String(row.id));
    };
    visit(commentId);
    return ids;
  }

  private unresolveThreadRoot(commentId: string): void {
    let current = this.getRawIssueComment(commentId);
    while (current?.parentId) current = this.getRawIssueComment(current.parentId);
    if (!current?.resolvedAt) return;
    this.db.run(
      "UPDATE multica_issue_comments SET resolved_at = NULL, resolved_by_type = NULL, resolved_by_id = NULL, updated_at = ? WHERE id = ?",
      [nowIso(), current.id],
    );
  }

  private validatePinnedItemTarget(workspaceId: string, itemType: MulticaPinnedItemType, itemId: string): void {
    if (itemType === "issue") {
      const row = this.db.query("SELECT id FROM multica_issues WHERE id = ? AND workspace_id = ?").get(itemId, workspaceId) as Row | null;
      if (!row) throw new Error(`Issue not found: ${itemId}`);
      return;
    }
    const project = this.getProject(itemId);
    if (!project || project.workspaceId !== workspaceId) throw new Error(`Project not found: ${itemId}`);
  }

  private linkAttachmentsToComment(commentId: string, issueId: string, attachmentIds: string[]): void {
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    for (const attachmentId of attachmentIds) {
      const attachment = this.getAttachment(attachmentId);
      if (!attachment) throw new Error(`Attachment not found: ${attachmentId}`);
      if (attachment.issueId && attachment.issueId !== issueId) throw new Error(`Attachment belongs to another issue: ${attachmentId}`);
      this.db.run(
        `UPDATE multica_attachments
         SET issue_id = ?, comment_id = ?, workspace_id = ?
         WHERE id = ? AND comment_id IS NULL`,
        [issueId, commentId, issue.workspaceId, attachmentId],
      );
    }
  }

  private notifySubscribedMembers(
    issue: MulticaIssue,
    type: string,
    title: string,
    body: string | null,
    actorType: string,
    actorId: string | null,
    excludedMemberIds: string[] = [],
  ): void {
    const subscribers = this.listIssueSubscribers(issue.id);
    const excluded = new Set(excludedMemberIds);
    for (const subscriber of subscribers) {
      if (actorType === "member" && actorId === subscriber.memberId) continue;
      if (excluded.has(subscriber.memberId)) continue;
      this.createInboxItem({
        issueId: issue.id,
        memberId: subscriber.memberId,
        type,
        title: `${issue.key}: ${title}`,
        body,
        actorType,
        actorId,
      });
    }
  }

  private triggerMemberMentions(issue: MulticaIssue, comment: MulticaIssueComment): string[] {
    const targets = this.resolveCommentMemberMentionTargets(comment.body, issue.workspaceId);
    const notified: string[] = [];
    for (const memberId of targets) {
      if (comment.authorType === "member" && comment.authorId === memberId) continue;
      this.addIssueSubscriber(issue.id, memberId, "mentioned");
      this.createInboxItem({
        issueId: issue.id,
        memberId,
        type: "comment_mention",
        title: `${issue.key}: mentioned you`,
        body: comment.body,
        actorType: comment.authorType,
        actorId: comment.authorId,
      });
      notified.push(memberId);
    }
    return notified;
  }

  private triggerCommentMentions(issue: MulticaIssue, comment: MulticaIssueComment): MulticaTask[] {
    const targets = this.resolveCommentMentionTargets(comment.body);
    if (!targets.length) return [];

    const tasks: MulticaTask[] = [];
    const seenAgents = new Set<string>();
    for (const target of targets) {
      const agent = this.resolveRunnableAgentForAssignee(target.assigneeType, target.assigneeId);
      if (!agent || seenAgents.has(agent.id)) continue;
      if (comment.authorType === "agent" && comment.authorId === agent.id) continue;
      seenAgents.add(agent.id);
      const task = this.createTask({
        agentId: agent.id,
        issueId: issue.id,
        workspaceId: issue.workspaceId,
        prompt: commentMentionPrompt(comment),
      });
      tasks.push(task);
      this.appendIssueActivity(issue.id, {
        actorType: "system",
        actorId: null,
        type: "comment_mention_triggered",
        body: `Queued ${agent.name}`,
        data: {
          commentId: comment.id,
          assigneeType: target.assigneeType,
          assigneeId: target.assigneeId,
          agentId: agent.id,
          taskId: task.id,
        },
      });
    }
    return tasks;
  }

  private resolveCommentMentionTargets(body: string): Array<{ assigneeType: "agent" | "squad"; assigneeId: string }> {
    const targets: Array<{ assigneeType: "agent" | "squad"; assigneeId: string }> = [];
    const seen = new Set<string>();
    const addTarget = (assigneeType: "agent" | "squad", assigneeId: string) => {
      const key = `${assigneeType}:${assigneeId}`;
      if (seen.has(key)) return;
      seen.add(key);
      targets.push({ assigneeType, assigneeId });
    };

    const markdownMention = /mention:\/\/(agent|squad)\/([A-Za-z0-9_-]+)/g;
    for (const match of body.matchAll(markdownMention)) {
      addTarget(match[1] as "agent" | "squad", match[2]);
    }

    const withoutLinks = body.replace(/\[[^\]]+\]\(mention:\/\/[^)]+\)/g, " ");
    for (const agent of this.listAgents()) {
      if (hasPlainMention(withoutLinks, agent.name)) addTarget("agent", agent.id);
    }
    for (const squad of this.listSquads()) {
      if (hasPlainMention(withoutLinks, squad.name)) addTarget("squad", squad.id);
    }
    return targets;
  }

  private resolveCommentMemberMentionTargets(body: string, workspaceId: string): string[] {
    const targets: string[] = [];
    const seen = new Set<string>();
    const addTarget = (memberId: string) => {
      if (seen.has(memberId)) return;
      seen.add(memberId);
      targets.push(memberId);
    };

    const markdownMention = /mention:\/\/member\/([A-Za-z0-9_-]+)/g;
    for (const match of body.matchAll(markdownMention)) {
      const member = this.getWorkspaceMember(match[1]);
      if (member && !member.archivedAt) addTarget(member.id);
    }

    const withoutLinks = body.replace(/\[[^\]]+\]\(mention:\/\/[^)]+\)/g, " ");
    if (/(^|\s)@all(?=$|\s|[.,:;!?])/i.test(withoutLinks)) {
      for (const member of this.listWorkspaceMembers(workspaceId)) addTarget(member.id);
      return targets;
    }

    for (const member of this.listWorkspaceMembers(workspaceId)) {
      if (hasPlainMention(withoutLinks, member.name)) addTarget(member.id);
    }
    return targets;
  }

  private afterTaskTerminal(task: MulticaTask, status: "completed" | "failed" | "cancelled", body: string | null): void {
    const now = nowIso();
    if (task.chatSessionId) {
      const role = status === "completed" ? "assistant" : "system";
      const messageBody = status === "completed" ? (body || "Task completed.") : (body || `Task ${status}`);
      this.db.run(
        `INSERT INTO multica_chat_messages (id, chat_session_id, task_id, role, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [createId("msg"), task.chatSessionId, task.id, role, messageBody, now],
      );
      this.db.run(
        `UPDATE multica_chat_sessions
         SET session_id = COALESCE(?, session_id),
             work_dir = COALESCE(?, work_dir),
             latest_task_id = ?,
             updated_at = ?
         WHERE id = ?`,
        [task.sessionId ?? null, task.workDir ?? null, task.id, now, task.chatSessionId],
      );
    }

    if (task.issueId) {
      const issueStatus = status === "completed" ? "done" : status;
      this.db.run(
        "UPDATE multica_issues SET status = ?, updated_at = ? WHERE id = ?",
        [issueStatus, now, task.issueId],
      );
      this.appendIssueActivity(task.issueId, {
        actorType: "agent",
        actorId: task.agentId,
        type: `task_${status}`,
        body,
        data: { taskId: task.id, runtimeId: task.runtimeId },
      });
      const issue = this.getIssue(task.issueId);
      if (issue?.projectId) this.db.run("UPDATE multica_projects SET updated_at = ? WHERE id = ?", [now, issue.projectId]);
    }

    const runRow = this.db.query(
      "SELECT id FROM multica_autopilot_runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(task.id) as { id: string } | null;
    if (runRow) {
      const runStatus = status === "completed" ? "completed" : "failed";
      this.db.run(
        `UPDATE multica_autopilot_runs
         SET status = ?, completed_at = ?, failure_reason = ?, result = ?
         WHERE id = ?`,
        [
          runStatus,
          now,
          status === "failed" ? task.error : status === "cancelled" ? "Task cancelled" : null,
          toJson({ taskId: task.id, status, output: task.result, error: task.error }),
          runRow.id,
        ],
      );
    }
  }

  private addColumnIfMissing(table: string, definition: string): void {
    try {
      this.db.run(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    } catch (err) {
      if (!String((err as Error).message ?? err).toLowerCase().includes("duplicate column")) throw err;
    }
  }

  private countProjectResources(projectId: string): number {
    const row = this.db.query("SELECT COUNT(*) AS count FROM multica_project_resources WHERE project_id = ?")
      .get(projectId) as { count: number } | null;
    return Number(row?.count ?? 0);
  }

  private nextIssueNumber(workspaceId: string): number {
    const row = this.db.query(
      "SELECT COALESCE(MAX(issue_number), 0) + 1 AS next FROM multica_issues WHERE workspace_id = ?",
    ).get(workspaceId) as { next: number } | null;
    return Number(row?.next ?? 1);
  }

  private backfillIssueKeys(): void {
    const rows = this.db.query(
      "SELECT id, workspace_id FROM multica_issues WHERE issue_number = 0 OR issue_key IS NULL OR issue_key = '' ORDER BY created_at ASC",
    ).all() as Array<{ id: string; workspace_id?: string }>;
    for (const row of rows) {
      const workspaceId = String(row.workspace_id ?? "local");
      const number = this.nextIssueNumber(workspaceId);
      this.db.run(
        "UPDATE multica_issues SET issue_number = ?, issue_key = ? WHERE id = ?",
        [number, formatIssueKey(number), row.id],
      );
    }
  }

  private runtimeUsageSummary(runtimeId: string): Pick<MulticaRuntime,
    "taskCount" |
    "activeTaskCount" |
    "completedTaskCount" |
    "failedTaskCount" |
    "inputTokens" |
    "outputTokens" |
    "cacheReadTokens" |
    "cacheWriteTokens"
  > {
    const rows = this.db.query(
      "SELECT id, status, usage FROM multica_tasks WHERE runtime_id = ?",
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
      const status = String(row.status ?? "");
      if (status === "dispatched" || status === "running") stats.activeTaskCount += 1;
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

  private filteredUsageTaskRows(input: {
    workspaceId?: string | null;
    projectId?: string | null;
    runtimeId?: string | null;
    days?: number;
  }, options: { includeTasksWithoutUsage?: boolean } = {}): Row[] {
    const clauses = ["1 = 1"];
    const params: Array<string | number | null> = [];
    const workspaceId = input.workspaceId ?? "local";
    if (workspaceId) {
      clauses.push("t.workspace_id = ?");
      params.push(workspaceId);
    }
    if (input.projectId) {
      clauses.push("i.project_id = ?");
      params.push(input.projectId);
    }
    if (input.runtimeId !== undefined) {
      if (input.runtimeId === null) {
        clauses.push("t.runtime_id IS NULL");
      } else {
        if (!this.getRuntime(input.runtimeId)) throw new Error(`Runtime not found: ${input.runtimeId}`);
        clauses.push("t.runtime_id = ?");
        params.push(input.runtimeId);
      }
    }
    const since = usageSince(input.days);
    if (since) {
      clauses.push("COALESCE(t.completed_at, t.failed_at, t.cancelled_at, t.started_at, t.dispatched_at, t.updated_at, t.created_at) >= ?");
      params.push(since);
    }
    if (!options.includeTasksWithoutUsage) {
      clauses.push("t.usage IS NOT NULL AND t.usage != '[]' AND t.usage != ''");
    }
    return this.db.query(
      `SELECT t.*
       FROM multica_tasks t
       LEFT JOIN multica_issues i ON i.id = t.issue_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY COALESCE(t.completed_at, t.failed_at, t.cancelled_at, t.started_at, t.dispatched_at, t.updated_at, t.created_at) ASC`,
    ).all(...params) as Row[];
  }
}

type Row = Record<string, unknown>;

function toJson(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function usageTimestamp(row: Row): string {
  return String(
    row.completed_at ??
    row.failed_at ??
    row.cancelled_at ??
    row.started_at ??
    row.dispatched_at ??
    row.updated_at ??
    row.created_at,
  );
}

function usageDate(row: Row): string {
  const date = new Date(usageTimestamp(row));
  if (!Number.isFinite(date.getTime())) return String(row.created_at ?? "").slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function usageHour(row: Row): number {
  const date = new Date(usageTimestamp(row));
  if (!Number.isFinite(date.getTime())) return 0;
  return date.getUTCHours();
}

function usageSince(days: number | undefined): string | null {
  const value = Number(days ?? 30);
  if (!Number.isFinite(value) || value <= 0) return null;
  const capped = Math.min(365, Math.floor(value));
  return new Date(Date.now() - capped * 24 * 60 * 60 * 1000).toISOString();
}

function taskRunSeconds(row: Row): number {
  const start = Date.parse(String(row.started_at ?? row.dispatched_at ?? row.created_at));
  const end = Date.parse(String(row.completed_at ?? row.failed_at ?? row.cancelled_at ?? row.updated_at));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return Math.floor((end - start) / 1000);
}

type RuntimeUsageEntry = Required<Pick<TaskUsageEntry,
  "provider" |
  "model" |
  "inputTokens" |
  "outputTokens" |
  "cacheReadTokens" |
  "cacheWriteTokens"
>>;

function parseTaskUsageEntries(value: unknown): RuntimeUsageEntry[] {
  const raw = parseJson<unknown[]>(value, []);
  if (!Array.isArray(raw)) return [];
  const entries: RuntimeUsageEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    entries.push({
      provider: String(record.provider ?? "unknown"),
      model: String(record.model ?? "unknown"),
      inputTokens: normalizeUsageNumber(record.inputTokens ?? record.input_tokens),
      outputTokens: normalizeUsageNumber(record.outputTokens ?? record.output_tokens),
      cacheReadTokens: normalizeUsageNumber(record.cacheReadTokens ?? record.cache_read_tokens),
      cacheWriteTokens: normalizeUsageNumber(record.cacheWriteTokens ?? record.cache_write_tokens),
    });
  }
  return entries;
}

function addUsageTotals(
  target: Pick<RuntimeUsageEntry, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">,
  entry: RuntimeUsageEntry,
): void {
  target.inputTokens += entry.inputTokens;
  target.outputTokens += entry.outputTokens;
  target.cacheReadTokens += entry.cacheReadTokens;
  target.cacheWriteTokens += entry.cacheWriteTokens;
}

function normalizeUsageNumber(value: unknown): number {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.floor(number);
}

function formatIssueKey(number: number): string {
  return `MUL-${number}`;
}

function commentMentionPrompt(comment: MulticaIssueComment): string {
  return [
    "A teammate mentioned you in an issue comment.",
    "",
    "## Triggering Comment",
    comment.body,
  ].join("\n");
}

function hasPlainMention(body: string, name: string): boolean {
  const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return false;
  return new RegExp(`(^|\\s)@${escaped}(?=$|\\s|[.,:;!?])`, "i").test(body);
}

function validateIssueMetadataKey(key: string): void {
  if (!key) throw new Error("key is required");
  if (!ISSUE_METADATA_KEY_RE.test(key)) {
    throw new Error("key must match ^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$");
  }
}

function validateIssueMetadataValue(value: unknown): string | number | boolean {
  if (!isIssueMetadataPrimitive(value)) {
    if (value === null) throw new Error("value cannot be null");
    throw new Error("value must be a primitive: string, number, or bool");
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("value must be a finite number");
  }
  return value;
}

function isIssueMetadataPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "boolean" || typeof value === "number";
}

function validateIssueMetadataSize(metadata: Record<string, string | number | boolean>): void {
  if (Buffer.byteLength(toJson(metadata), "utf8") > 8 * 1024) {
    throw new Error("metadata exceeds the 8KB size limit");
  }
}

function normalizeIssuePriority(value: string | undefined): MulticaIssuePriority {
  const priority = String(value ?? "none").trim().toLowerCase();
  if (priority === "urgent" || priority === "high" || priority === "medium" || priority === "low" || priority === "none") {
    return priority;
  }
  throw new Error("priority must be one of urgent, high, medium, low, or none");
}

function normalizeIssueDependencyType(value: string | undefined): MulticaIssueDependencyType {
  const type = String(value ?? "related").trim().toLowerCase();
  if (type === "blocks" || type === "blocked_by" || type === "related") return type;
  throw new Error("dependency type must be one of blocks, blocked_by, or related");
}

function normalizeRuntimeVisibility(value: string | undefined): MulticaRuntimeVisibility {
  const visibility = String(value ?? "private").trim().toLowerCase();
  if (visibility === "private" || visibility === "public") return visibility;
  throw new Error("visibility must be private or public");
}

function normalizeRuntimeConcurrency(value: number | null | undefined): number {
  const concurrency = Number(value ?? 1);
  if (!Number.isFinite(concurrency) || concurrency < 1) throw new Error("maxConcurrency must be at least 1");
  return Math.floor(concurrency);
}

function normalizeIssuePosition(value: number | null | undefined): number {
  const position = Number(value ?? 0);
  if (!Number.isFinite(position)) throw new Error("position must be a finite number");
  return position;
}

function normalizeIssueDate(value: string | null | undefined, field: string): string | null {
  if (value == null || value === "") return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${field} must be a valid date`);
  return date.toISOString();
}

function normalizeJsonArray(value: unknown): unknown[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("value must be an array");
  return value;
}

function hasAnyField(target: object, ...keys: string[]): boolean {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(target, key));
}

function resolveOptionalStringField(
  target: object,
  camelKey: string,
  snakeKey: string,
  current: string | null,
): string | null {
  const values = target as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(values, camelKey)) return values[camelKey] == null ? null : String(values[camelKey]);
  if (Object.prototype.hasOwnProperty.call(values, snakeKey)) return values[snakeKey] == null ? null : String(values[snakeKey]);
  return current;
}

function normalizeLabelName(value: string | undefined): string {
  const name = value?.trim() ?? "";
  if (!name) throw new Error("Label name is required");
  if (name.length > 32) throw new Error("Label name cannot exceed 32 characters");
  return name;
}

function normalizeLabelColor(value: string | undefined): string {
  const color = value?.trim() ?? "";
  if (!/^#?[0-9a-fA-F]{6}$/.test(color)) throw new Error("Label color must be a 6-digit hex color");
  return (color.startsWith("#") ? color : `#${color}`).toLowerCase();
}

function normalizePinnedItemType(value: string | undefined): MulticaPinnedItemType {
  if (value === "issue" || value === "project") return value;
  throw new Error("item_type must be 'issue' or 'project'");
}

function normalizeSearchQuery(value: string | undefined): string {
  return String(value ?? "").trim();
}

function clampSearchLimit(value: number | undefined): number {
  const limit = Number(value ?? 20);
  if (!Number.isFinite(limit) || limit <= 0) return 20;
  return Math.min(50, Math.floor(limit));
}

function searchMatch(value: string, query: string): boolean {
  const haystack = value.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return terms.length > 0 && terms.every((term) => haystack.includes(term));
}

function searchRank(matchSource: string): number {
  if (matchSource === "key") return 0;
  if (matchSource === "title") return 1;
  return 2;
}

function extractSearchSnippet(value: string, query: string): string {
  const text = String(value);
  const term = query.toLowerCase().split(/\s+/).filter(Boolean).find((item) => text.toLowerCase().includes(item)) ?? "";
  if (!term) return text.slice(0, 160);
  const index = text.toLowerCase().indexOf(term);
  const start = Math.max(0, index - 50);
  const end = Math.min(text.length, index + term.length + 80);
  return `${start > 0 ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`;
}

function normalizeProjectResourceRef(resourceType: string, rawRef: Record<string, unknown>): Record<string, unknown> {
  if (!resourceType) throw new Error("resourceType is required");
  if (resourceType !== "github_repo") throw new Error(`Unknown project resource type: ${resourceType}`);
  const url = String(rawRef.url ?? "").trim();
  if (!url) throw new Error("github_repo url is required");
  if (!isValidGitRepoUrl(url)) throw new Error("github_repo url must be a valid http(s), ssh, git, or scp-like URL");
  const defaultBranchHint = String(rawRef.defaultBranchHint ?? rawRef.default_branch_hint ?? "").trim();
  return defaultBranchHint
    ? { url, defaultBranchHint, default_branch_hint: defaultBranchHint }
    : { url };
}

function isValidGitRepoUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return Boolean(url.host) && ["http", "https", "ssh", "git"].includes(url.protocol.replace(":", ""));
  } catch {
    if (value.includes(" ") || value.includes("://")) return false;
    const colon = value.indexOf(":");
    if (colon <= 0 || colon === value.length - 1) return false;
    const at = value.indexOf("@");
    if (at >= colon) return false;
    const host = value.slice(at >= 0 ? at + 1 : 0, colon);
    const path = value.slice(colon + 1);
    return Boolean(host && path);
  }
}

function projectSelect(suffix: string): string {
  return `
    SELECT p.*,
      COUNT(i.id) AS issue_count,
      COALESCE(SUM(CASE WHEN i.status IN ('done', 'completed', 'closed') THEN 1 ELSE 0 END), 0) AS done_count,
      (
        SELECT COUNT(*)
        FROM multica_project_resources pr
        WHERE pr.project_id = p.id
      ) AS resource_count
    FROM multica_projects p
    LEFT JOIN multica_issues i ON i.project_id = p.id
    ${suffix.includes("ORDER BY") ? suffix.replace("ORDER BY", "GROUP BY p.id ORDER BY") : `${suffix} GROUP BY p.id`}
  `;
}

function squadSelect(suffix: string): string {
  return `
    SELECT s.*, COUNT(m.id) AS member_count
    FROM multica_squads s
    LEFT JOIN multica_squad_members m ON m.squad_id = s.id
    ${suffix.includes("ORDER BY") ? suffix.replace("ORDER BY", "GROUP BY s.id ORDER BY") : `${suffix} GROUP BY s.id`}
  `;
}

function toAgent(row: Row): MulticaAgent {
  return {
    id: String(row.id),
    name: String(row.name),
    provider: String(row.provider),
    instructions: String(row.instructions ?? ""),
    skills: parseJson(row.skills, []),
    cwd: nullableString(row.cwd),
    executable: nullableString(row.executable),
    model: nullableString(row.model),
    allowedTools: parseJson(row.allowed_tools, []),
    customEnv: parseJson(row.custom_env, {}),
    customArgs: parseJson(row.custom_args, []),
    mcpConfig: row.mcp_config == null ? null : parseJson(row.mcp_config, null),
    thinkingLevel: nullableString(row.thinking_level),
    archivedAt: nullableString(row.archived_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toRuntime(row: Row): MulticaRuntime {
  return {
    id: String(row.id),
    name: String(row.name),
    provider: String(row.provider),
    workspaceId: nullableString(row.workspace_id),
    ownerId: nullableString(row.owner_id),
    visibility: normalizeRuntimeVisibility(String(row.visibility ?? "private")),
    status: String(row.status) as MulticaRuntime["status"],
    maxConcurrency: Number(row.max_concurrency ?? 1),
    taskCount: 0,
    activeTaskCount: 0,
    completedTaskCount: 0,
    failedTaskCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    lastHeartbeatAt: nullableString(row.last_heartbeat_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function withRuntimeLiveness(runtime: MulticaRuntime): MulticaRuntime {
  if (runtime.status === "offline") return runtime;
  if (!runtime.lastHeartbeatAt) return { ...runtime, status: "offline" };
  const heartbeat = Date.parse(runtime.lastHeartbeatAt);
  if (!Number.isFinite(heartbeat)) return { ...runtime, status: "offline" };
  return Date.now() - heartbeat > RUNTIME_HEARTBEAT_STALE_MS ? { ...runtime, status: "offline" } : runtime;
}

function toWorkspaceMember(row: Row): MulticaWorkspaceMember {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    name: String(row.name),
    email: nullableString(row.email),
    role: String(row.role ?? "member"),
    archivedAt: nullableString(row.archived_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toProject(row: Row): MulticaProject {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    title: String(row.title),
    description: nullableString(row.description),
    icon: nullableString(row.icon),
    status: String(row.status ?? "planned") as MulticaProject["status"],
    priority: String(row.priority ?? "none") as MulticaProject["priority"],
    leadType: nullableString(row.lead_type) as MulticaProject["leadType"],
    leadId: nullableString(row.lead_id),
    issueCount: Number(row.issue_count ?? 0),
    doneCount: Number(row.done_count ?? 0),
    resourceCount: Number(row.resource_count ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toProjectResource(row: Row): MulticaProjectResource {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    workspaceId: String(row.workspace_id ?? "local"),
    resourceType: String(row.resource_type),
    resourceRef: parseJson(row.resource_ref, {}),
    label: nullableString(row.label),
    position: Number(row.position ?? 0),
    createdAt: String(row.created_at),
    createdBy: nullableString(row.created_by),
  };
}

function toIssue(row: Row): MulticaIssue {
  const number = Number(row.issue_number ?? 0);
  return {
    id: String(row.id),
    key: String(row.issue_key || (number > 0 ? formatIssueKey(number) : row.id)),
    number,
    title: String(row.title),
    description: nullableString(row.description),
    status: String(row.status),
    priority: normalizeIssuePriority(String(row.priority ?? "none")),
    workspaceId: String(row.workspace_id ?? "local"),
    projectId: nullableString(row.project_id),
    parentIssueId: nullableString(row.parent_issue_id),
    assigneeType: nullableString(row.assignee_type) as MulticaIssue["assigneeType"],
    assigneeId: nullableString(row.assignee_id),
    position: Number(row.position ?? 0),
    startDate: nullableString(row.start_date),
    dueDate: nullableString(row.due_date),
    acceptanceCriteria: parseJson(row.acceptance_criteria, []),
    contextRefs: parseJson(row.context_refs, []),
    metadata: parseIssueMetadata(row.metadata),
    labels: [],
    createdBy: nullableString(row.created_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toChildIssueProgress(row: Row): MulticaIssueChildProgress {
  return {
    parentIssueId: String(row.parent_issue_id),
    total: Number(row.total ?? 0),
    done: Number(row.done ?? 0),
  };
}

function toIssueDependency(row: Row): MulticaIssueDependency {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    issueId: String(row.issue_id),
    dependsOnIssueId: String(row.depends_on_issue_id),
    type: normalizeIssueDependencyType(String(row.type ?? "related")),
    issue: null,
    dependsOnIssue: null,
    createdAt: String(row.created_at),
  };
}

function parseIssueMetadata(value: unknown): Record<string, string | number | boolean> {
  const raw = parseJson<Record<string, unknown>>(value, {});
  const metadata: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(raw)) {
    if (ISSUE_METADATA_KEY_RE.test(key) && isIssueMetadataPrimitive(item)) {
      metadata[key] = item;
    }
  }
  return metadata;
}

function toIssueComment(row: Row): MulticaIssueComment {
  return {
    id: String(row.id),
    issueId: String(row.issue_id),
    authorType: String(row.author_type ?? "member"),
    authorId: nullableString(row.author_id),
    parentId: nullableString(row.parent_id),
    body: String(row.body ?? ""),
    resolvedAt: nullableString(row.resolved_at),
    resolvedByType: nullableString(row.resolved_by_type),
    resolvedById: nullableString(row.resolved_by_id),
    reactions: [],
    attachments: [],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toIssueActivity(row: Row): MulticaIssueActivity {
  return {
    id: String(row.id),
    issueId: String(row.issue_id),
    actorType: String(row.actor_type ?? "system"),
    actorId: nullableString(row.actor_id),
    type: String(row.type),
    body: nullableString(row.body),
    data: row.data == null ? null : parseJson(row.data, null),
    createdAt: String(row.created_at),
  };
}

function toIssueSubscriber(row: Row): MulticaIssueSubscriber {
  return {
    id: String(row.id),
    issueId: String(row.issue_id),
    memberId: String(row.member_id),
    reason: String(row.reason ?? "manual") as MulticaSubscriptionReason,
    createdAt: String(row.created_at),
  };
}

function toInboxItem(row: Row, issue: MulticaIssue | null): MulticaInboxItem {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    issueId: String(row.issue_id),
    memberId: String(row.member_id),
    actorType: String(row.actor_type ?? "system"),
    actorId: nullableString(row.actor_id),
    type: String(row.type),
    title: String(row.title ?? ""),
    body: nullableString(row.body),
    read: Number(row.read ?? 0) === 1,
    archived: Number(row.archived ?? 0) === 1,
    createdAt: String(row.created_at),
    issue,
  };
}

function toIssueReaction(row: Row): MulticaIssueReaction {
  return {
    id: String(row.id),
    issueId: String(row.issue_id),
    workspaceId: String(row.workspace_id ?? "local"),
    actorType: String(row.actor_type ?? "member"),
    actorId: String(row.actor_id ?? "local"),
    emoji: String(row.emoji ?? ""),
    createdAt: String(row.created_at),
  };
}

function toCommentReaction(row: Row): MulticaCommentReaction {
  return {
    id: String(row.id),
    commentId: String(row.comment_id),
    workspaceId: String(row.workspace_id ?? "local"),
    actorType: String(row.actor_type ?? "member"),
    actorId: String(row.actor_id ?? "local"),
    emoji: String(row.emoji ?? ""),
    createdAt: String(row.created_at),
  };
}

function toAttachment(row: Row): MulticaAttachment {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    issueId: nullableString(row.issue_id),
    commentId: nullableString(row.comment_id),
    uploaderType: String(row.uploader_type ?? "member"),
    uploaderId: String(row.uploader_id ?? "local"),
    filename: String(row.filename ?? ""),
    url: String(row.url ?? ""),
    contentType: String(row.content_type ?? "application/octet-stream"),
    sizeBytes: Number(row.size_bytes ?? 0),
    createdAt: String(row.created_at),
  };
}

function toLabel(row: Row): MulticaLabel {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    name: String(row.name ?? ""),
    color: String(row.color ?? "#6b7280"),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toPinnedItem(row: Row): MulticaPinnedItem {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    userId: String(row.user_id ?? "local"),
    itemType: String(row.item_type ?? "issue") as MulticaPinnedItemType,
    itemId: String(row.item_id ?? ""),
    position: Number(row.position ?? 0),
    createdAt: String(row.created_at),
  };
}

function toSquad(row: Row): MulticaSquad {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    name: String(row.name),
    description: String(row.description ?? ""),
    instructions: String(row.instructions ?? ""),
    leaderId: nullableString(row.leader_id),
    creatorId: nullableString(row.creator_id),
    archivedAt: nullableString(row.archived_at),
    memberCount: Number(row.member_count ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toSquadMember(row: Row): MulticaSquadMember {
  return {
    id: String(row.id),
    squadId: String(row.squad_id),
    memberType: String(row.member_type) as MulticaSquadMember["memberType"],
    memberId: String(row.member_id),
    role: String(row.role ?? "member"),
    createdAt: String(row.created_at),
  };
}

function toAutopilot(row: Row): MulticaAutopilot {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    title: String(row.title),
    description: nullableString(row.description),
    projectId: nullableString(row.project_id),
    assigneeType: String(row.assignee_type ?? "agent") as MulticaAutopilot["assigneeType"],
    assigneeId: String(row.assignee_id),
    status: String(row.status ?? "active") as MulticaAutopilot["status"],
    executionMode: String(row.execution_mode ?? "create_issue") as MulticaAutopilot["executionMode"],
    issueTitleTemplate: nullableString(row.issue_title_template),
    triggerKind: String(row.trigger_kind ?? "manual"),
    triggerLabel: nullableString(row.trigger_label),
    cronExpression: nullableString(row.cron_expression),
    lastRunAt: nullableString(row.last_run_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toAutopilotRun(row: Row): MulticaAutopilotRun {
  return {
    id: String(row.id),
    autopilotId: String(row.autopilot_id),
    source: String(row.source ?? "manual") as MulticaAutopilotRun["source"],
    status: String(row.status ?? "running") as MulticaAutopilotRun["status"],
    issueId: nullableString(row.issue_id),
    taskId: nullableString(row.task_id),
    triggeredAt: String(row.triggered_at),
    completedAt: nullableString(row.completed_at),
    failureReason: nullableString(row.failure_reason),
    payload: row.payload == null ? null : parseJson(row.payload, null),
    result: row.result == null ? null : parseJson(row.result, null),
    createdAt: String(row.created_at),
  };
}

function toChatSession(row: Row): MulticaChatSession {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    agentId: String(row.agent_id),
    title: String(row.title ?? ""),
    status: String(row.status ?? "active") as MulticaChatSession["status"],
    sessionId: nullableString(row.session_id),
    workDir: nullableString(row.work_dir),
    latestTaskId: nullableString(row.latest_task_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toChatMessage(row: Row): MulticaChatMessage {
  return {
    id: String(row.id),
    chatSessionId: String(row.chat_session_id),
    taskId: nullableString(row.task_id),
    role: String(row.role ?? "system") as MulticaChatMessage["role"],
    body: String(row.body ?? ""),
    createdAt: String(row.created_at),
  };
}

function toTask(row: Row): MulticaTask {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    runtimeId: nullableString(row.runtime_id),
    issueId: nullableString(row.issue_id),
    chatSessionId: nullableString(row.chat_session_id),
    workspaceId: String(row.workspace_id ?? "local"),
    status: String(row.status) as MulticaTaskStatus,
    priority: Number(row.priority ?? 0),
    prompt: String(row.prompt ?? ""),
    result: nullableString(row.result),
    error: nullableString(row.error),
    branchName: nullableString(row.branch_name),
    sessionId: nullableString(row.session_id),
    workDir: nullableString(row.work_dir),
    progressSummary: nullableString(row.progress_summary),
    progressStep: row.progress_step == null ? null : Number(row.progress_step),
    progressTotal: row.progress_total == null ? null : Number(row.progress_total),
    usage: parseJson(row.usage, []),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    dispatchedAt: nullableString(row.dispatched_at),
    startedAt: nullableString(row.started_at),
    completedAt: nullableString(row.completed_at),
    failedAt: nullableString(row.failed_at),
    cancelledAt: nullableString(row.cancelled_at),
  };
}

function toTaskMessage(row: Row): MulticaTaskMessage {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    seq: Number(row.seq),
    type: String(row.type),
    tool: nullableString(row.tool),
    content: nullableString(row.content),
    input: row.input == null ? null : parseJson(row.input, null),
    output: nullableString(row.output),
    createdAt: String(row.created_at),
  };
}

export function isTerminalStatus(status: MulticaTaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
