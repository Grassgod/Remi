import type { Database } from "bun:sqlite";
import { getDb } from "../db/index.js";
import { createId, nowIso } from "./ids.js";
import type {
  CreateAgentInput,
  CreateIssueInput,
  CreateTaskInput,
  MulticaAgent,
  MulticaIssue,
  MulticaRuntime,
  MulticaTask,
  MulticaTaskMessage,
  MulticaTaskStatus,
  MulticaTaskWithAgent,
  RegisterRuntimeInput,
  TaskMessageInput,
  TaskUsageEntry,
} from "./types.js";

const TERMINAL_STATUSES: MulticaTaskStatus[] = ["completed", "failed", "cancelled"];

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

      CREATE TABLE IF NOT EXISTS multica_issues (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        workspace_id TEXT NOT NULL DEFAULT 'local',
        project_id TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

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

  ensureDefaultAgent(provider = "claude"): MulticaAgent {
    const id = `agt_default_${provider}`;
    const existing = this.getAgent(id);
    if (existing) return existing;
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
    const rows = this.db.query("SELECT * FROM multica_agents ORDER BY created_at ASC").all() as Row[];
    return rows.map(toAgent);
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
    return rows.map(toRuntime);
  }

  heartbeatRuntime(runtimeId: string): void {
    const now = nowIso();
    this.db.run(
      "UPDATE multica_runtimes SET status = 'online', last_heartbeat_at = ?, updated_at = ? WHERE id = ?",
      [now, now, runtimeId],
    );
  }

  createIssue(input: CreateIssueInput): MulticaIssue {
    const id = input.id ?? createId("iss");
    const now = nowIso();
    this.db.run(
      `INSERT INTO multica_issues (
        id, title, description, status, workspace_id, project_id, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
      [
        id,
        input.title,
        input.description ?? null,
        input.workspaceId ?? "local",
        input.projectId ?? null,
        input.createdBy ?? null,
        now,
        now,
      ],
    );
    return this.getIssue(id)!;
  }

  getIssue(id: string): MulticaIssue | null {
    const row = this.db.query("SELECT * FROM multica_issues WHERE id = ?").get(id) as Row | null;
    return row ? toIssue(row) : null;
  }

  listIssues(): MulticaIssue[] {
    const rows = this.db.query("SELECT * FROM multica_issues ORDER BY updated_at DESC").all() as Row[];
    return rows.map(toIssue);
  }

  createTask(input: CreateTaskInput): MulticaTask {
    const agent = this.getAgent(input.agentId);
    if (!agent) throw new Error(`Agent not found: ${input.agentId}`);
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

      const workspaceFilter = runtime.workspaceId ? "AND t.workspace_id = ?" : "";
      const params = runtime.workspaceId
        ? [runtime.workspaceId, runtime.provider, runtime.provider]
        : [runtime.provider, runtime.provider];
      const row = this.db.query(
        `SELECT t.*
         FROM multica_tasks t
         JOIN multica_agents a ON a.id = t.agent_id
         WHERE t.status = 'queued'
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
    return this.getTask(taskId)!;
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
    return this.getTask(taskId)!;
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
    return this.getTask(taskId)!;
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

function toIssue(row: Row): MulticaIssue {
  return {
    id: String(row.id),
    title: String(row.title),
    description: nullableString(row.description),
    status: String(row.status),
    workspaceId: String(row.workspace_id ?? "local"),
    projectId: nullableString(row.project_id),
    createdBy: nullableString(row.created_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
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
