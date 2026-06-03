import type { Database } from "bun:sqlite";
import { getDb } from "../db/index.js";
import { createId, nowIso } from "./ids.js";
import type {
  AddSquadMemberInput,
  AssignIssueInput,
  AssignIssueResult,
  CreateAgentInput,
  CreateAutopilotInput,
  CreateIssueCommentInput,
  CreateIssueInput,
  CreateProjectInput,
  CreateSquadInput,
  CreateTaskInput,
  CreateWorkspaceMemberInput,
  MulticaAutopilot,
  MulticaAutopilotRun,
  MulticaAgent,
  MulticaAssigneeType,
  MulticaIssueActivity,
  MulticaIssueComment,
  MulticaIssue,
  MulticaIssueWithTasks,
  MulticaProject,
  MulticaRuntime,
  MulticaSquad,
  MulticaSquadMember,
  MulticaTask,
  MulticaTaskMessage,
  MulticaTaskStatus,
  MulticaTaskWithAgent,
  MulticaWorkspaceMember,
  RegisterRuntimeInput,
  RemoveSquadMemberInput,
  RunAutopilotInput,
  TaskMessageInput,
  TaskUsageEntry,
  UpdateAgentInput,
  UpdateAutopilotInput,
  UpdateIssueInput,
  UpdateProjectInput,
  UpdateSquadInput,
  UpdateWorkspaceMemberInput,
} from "./types.js";

const TERMINAL_STATUSES: MulticaTaskStatus[] = ["completed", "failed", "cancelled"];
const RUNTIME_HEARTBEAT_STALE_MS = 5 * 60 * 1000;

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
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        workspace_id TEXT NOT NULL DEFAULT 'local',
        project_id TEXT,
        assignee_type TEXT,
        assignee_id TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS multica_issue_comments (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        author_type TEXT NOT NULL DEFAULT 'member',
        author_id TEXT,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(issue_id) REFERENCES multica_issues(id) ON DELETE CASCADE
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

      CREATE TABLE IF NOT EXISTS multica_tasks (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        runtime_id TEXT,
        issue_id TEXT,
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
        FOREIGN KEY(issue_id) REFERENCES multica_issues(id)
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
    this.addColumnIfMissing("multica_issues", "assignee_type TEXT");
    this.addColumnIfMissing("multica_issues", "assignee_id TEXT");
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
    this.db.run(
      `INSERT INTO multica_runtimes (
        id, name, provider, workspace_id, status, max_concurrency,
        last_heartbeat_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'online', ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        provider = excluded.provider,
        workspace_id = excluded.workspace_id,
        status = 'online',
        max_concurrency = excluded.max_concurrency,
        last_heartbeat_at = excluded.last_heartbeat_at,
        updated_at = excluded.updated_at`,
      [
        id,
        input.name,
        input.provider,
        input.workspaceId ?? null,
        Math.max(1, input.maxConcurrency ?? 1),
        now,
        now,
        now,
      ],
    );
    return this.getRuntime(id)!;
  }

  getRuntime(id: string): MulticaRuntime | null {
    const row = this.db.query("SELECT * FROM multica_runtimes WHERE id = ?").get(id) as Row | null;
    return row ? toRuntime(row) : null;
  }

  listRuntimes(): MulticaRuntime[] {
    const rows = this.db.query("SELECT * FROM multica_runtimes ORDER BY updated_at DESC").all() as Row[];
    return rows.map((row) => withRuntimeLiveness(toRuntime(row)));
  }

  heartbeatRuntime(runtimeId: string): void {
    const now = nowIso();
    this.db.run(
      "UPDATE multica_runtimes SET status = 'online', last_heartbeat_at = ?, updated_at = ? WHERE id = ?",
      [now, now, runtimeId],
    );
  }

  createIssue(input: CreateIssueInput): MulticaIssue {
    if (input.projectId && !this.getProject(input.projectId)) {
      throw new Error(`Project not found: ${input.projectId}`);
    }
    if (input.assigneeType || input.assigneeId) {
      this.validateIssueAssignee(input.assigneeType ?? null, input.assigneeId ?? null);
    }
    const id = input.id ?? createId("iss");
    const now = nowIso();
    this.db.run(
      `INSERT INTO multica_issues (
        id, title, description, status, workspace_id, project_id, assignee_type, assignee_id,
        created_by, created_at, updated_at
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.title,
        input.description ?? null,
        input.workspaceId ?? "local",
        input.projectId ?? null,
        input.assigneeType ?? null,
        input.assigneeId ?? null,
        input.createdBy ?? null,
        now,
        now,
      ],
    );
    if (input.projectId) {
      this.db.run("UPDATE multica_projects SET updated_at = ? WHERE id = ?", [now, input.projectId]);
    }
    this.appendIssueActivity(id, {
      actorType: "system",
      actorId: input.createdBy ?? null,
      type: "issue_created",
      body: input.title,
      data: { projectId: input.projectId ?? null },
    });
    return this.getIssue(id)!;
  }

  getIssue(id: string): MulticaIssue | null {
    const row = this.db.query("SELECT * FROM multica_issues WHERE id = ?").get(id) as Row | null;
    return row ? toIssue(row) : null;
  }

  getIssueWithTasks(id: string): MulticaIssueWithTasks | null {
    const issue = this.getIssue(id);
    if (!issue) return null;
    return { ...issue, tasks: this.listTasksForIssue(id) };
  }

  listIssues(): MulticaIssue[] {
    const rows = this.db.query("SELECT * FROM multica_issues ORDER BY updated_at DESC").all() as Row[];
    return rows.map(toIssue);
  }

  listTasksForIssue(issueId: string): MulticaTask[] {
    const rows = this.db.query(
      "SELECT * FROM multica_tasks WHERE issue_id = ? ORDER BY created_at DESC",
    ).all(issueId) as Row[];
    return rows.map(toTask);
  }

  updateIssue(id: string, input: UpdateIssueInput): MulticaIssue {
    const current = this.getIssue(id);
    if (!current) throw new Error(`Issue not found: ${id}`);
    if (input.projectId && !this.getProject(input.projectId)) throw new Error(`Project not found: ${input.projectId}`);
    if (input.assigneeType !== undefined || input.assigneeId !== undefined) {
      this.validateIssueAssignee(
        input.assigneeType === undefined ? current.assigneeType : input.assigneeType,
        input.assigneeId === undefined ? current.assigneeId : input.assigneeId,
      );
    }
    const now = nowIso();
    this.db.run(
      `UPDATE multica_issues SET
        title = ?,
        description = ?,
        status = ?,
        workspace_id = ?,
        project_id = ?,
        assignee_type = ?,
        assignee_id = ?,
        updated_at = ?
       WHERE id = ?`,
      [
        input.title ?? current.title,
        input.description === undefined ? current.description : input.description,
        input.status ?? current.status,
        input.workspaceId ?? current.workspaceId,
        input.projectId === undefined ? current.projectId : input.projectId,
        input.assigneeType === undefined ? current.assigneeType : input.assigneeType,
        input.assigneeId === undefined ? current.assigneeId : input.assigneeId,
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
    if (input.projectId) this.db.run("UPDATE multica_projects SET updated_at = ? WHERE id = ?", [now, input.projectId]);
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
    if (!this.getIssue(issueId)) throw new Error(`Issue not found: ${issueId}`);
    const id = createId("cmt");
    const now = nowIso();
    this.db.run(
      `INSERT INTO multica_issue_comments (id, issue_id, author_type, author_id, body, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, issueId, input.authorType ?? "member", input.authorId ?? null, input.body.trim(), now, now],
    );
    this.db.run("UPDATE multica_issues SET updated_at = ? WHERE id = ?", [now, issueId]);
    this.appendIssueActivity(issueId, {
      actorType: input.authorType ?? "member",
      actorId: input.authorId ?? null,
      type: "comment_created",
      body: input.body.trim(),
      data: { commentId: id },
    });
    return this.getIssueComment(id)!;
  }

  getIssueComment(id: string): MulticaIssueComment | null {
    const row = this.db.query("SELECT * FROM multica_issue_comments WHERE id = ?").get(id) as Row | null;
    return row ? toIssueComment(row) : null;
  }

  listIssueComments(issueId: string): MulticaIssueComment[] {
    const rows = this.db.query(
      "SELECT * FROM multica_issue_comments WHERE issue_id = ? ORDER BY created_at ASC",
    ).all(issueId) as Row[];
    return rows.map(toIssueComment);
  }

  listIssueActivity(issueId: string): MulticaIssueActivity[] {
    const rows = this.db.query(
      "SELECT * FROM multica_issue_activity WHERE issue_id = ? ORDER BY created_at ASC",
    ).all(issueId) as Row[];
    return rows.map(toIssueActivity);
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
    return this.getProject(id)!;
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

  createTask(input: CreateTaskInput): MulticaTask {
    const agent = this.getAgent(input.agentId);
    if (!agent) throw new Error(`Agent not found: ${input.agentId}`);
    if (agent.archivedAt) throw new Error(`Agent is archived: ${input.agentId}`);
    const issue = input.issueId ? this.getIssue(input.issueId) : null;
    if (input.issueId && !issue) throw new Error(`Issue not found: ${input.issueId}`);

    const id = input.id ?? createId("tsk");
    const now = nowIso();
    this.db.run(
      `INSERT INTO multica_tasks (
        id, agent_id, issue_id, workspace_id, status, priority, prompt,
        session_id, work_dir, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.agentId,
        input.issueId ?? null,
        input.workspaceId ?? issue?.workspaceId ?? "local",
        input.priority ?? 0,
        input.prompt,
        input.sessionId ?? null,
        input.workDir ?? agent.cwd ?? null,
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
    return {
      ...task,
      agent: this.getAgent(task.agentId),
      issue: task.issueId ? this.getIssue(task.issueId) : null,
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

  private afterTaskTerminal(task: MulticaTask, status: "completed" | "failed" | "cancelled", body: string | null): void {
    const now = nowIso();
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

function projectSelect(suffix: string): string {
  return `
    SELECT p.*,
      COUNT(i.id) AS issue_count,
      COALESCE(SUM(CASE WHEN i.status IN ('done', 'completed', 'closed') THEN 1 ELSE 0 END), 0) AS done_count
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
    status: String(row.status) as MulticaRuntime["status"],
    maxConcurrency: Number(row.max_concurrency ?? 1),
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
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toIssue(row: Row): MulticaIssue {
  return {
    id: String(row.id),
    title: String(row.title),
    description: nullableString(row.description),
    status: String(row.status),
    workspaceId: String(row.workspace_id ?? "local"),
    projectId: nullableString(row.project_id),
    assigneeType: nullableString(row.assignee_type) as MulticaIssue["assigneeType"],
    assigneeId: nullableString(row.assignee_id),
    createdBy: nullableString(row.created_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toIssueComment(row: Row): MulticaIssueComment {
  return {
    id: String(row.id),
    issueId: String(row.issue_id),
    authorType: String(row.author_type ?? "member"),
    authorId: nullableString(row.author_id),
    body: String(row.body ?? ""),
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

function toTask(row: Row): MulticaTask {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    runtimeId: nullableString(row.runtime_id),
    issueId: nullableString(row.issue_id),
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
