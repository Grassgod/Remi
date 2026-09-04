// Issue sessions domain (sessions, participants, session events, agent lanes and published
// results), extracted verbatim from MultiremiStore (the facade delegates every public method here).
import { createId, nowIso } from "@multiremi/ids.js";
import { cleanOptionalString, nullableString, parseJson, toJson } from "@multiremi/store/helpers.js";
import { type StoreContext } from "@multiremi/store/context.js";
import { buildSessionProjection } from "@multiremi/store/session-projection.js";
import { resolveProjectionTokenBudget } from "@multiremi/store/session-projection-budget.js";
import { createLogger } from "@shared/logger.js";
import type {
  AddSessionParticipantInput,
  CreateIssueSessionInput,
  CreateSessionTaskInput,
  MultiremiIssueSession,
  MultiremiSessionAgentLane,
  MultiremiSessionEvent,
  MultiremiSessionParticipant,
  MultiremiSessionProjection,
  MultiremiSessionResult,
  MultiremiTask,
  PublishSessionResultInput,
  UpdateIssueSessionInput,
} from "@multiremi/contracts/types.js";

type Row = Record<string, unknown>;
const log = createLogger("multiremi-store");
type AppendSessionEventInput = {
  authorType: string;
  authorId?: string | null;
  kind?: string;
  body?: string;
  taskId?: string | null;
  sourceCommentId?: string | null;
  metadata?: Record<string, unknown>;
  createdAt?: string;
};

export class IssueSessionsRepo {
  constructor(private ctx: StoreContext) {}

  getOrCreateDefaultIssueSession(issueId: string, createdById: string | null = null): MultiremiIssueSession {
    const issue = this.ctx.issues().getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const existing = this.ctx.db.query(
      "SELECT * FROM multiremi_issue_sessions WHERE issue_id = ? AND is_default = 1 LIMIT 1",
    ).get(issueId) as Row | null;
    if (existing) return toIssueSession(existing);

    const id = createId("ises");
    const now = nowIso();
    this.ctx.db.run(
      `INSERT INTO multiremi_issue_sessions (
         id, issue_id, workspace_id, title, status, is_default,
         created_by_type, created_by_id, created_at, updated_at
       ) VALUES (?, ?, ?, 'Main', 'active', 1, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
      [id, issueId, issue.workspaceId, createdById ? "member" : "system", createdById, now, now],
    );
    const row = this.ctx.db.query(
      "SELECT * FROM multiremi_issue_sessions WHERE issue_id = ? AND is_default = 1 LIMIT 1",
    ).get(issueId) as Row | null;
    if (!row) throw new Error(`Failed to create default session for issue: ${issueId}`);
    return toIssueSession(row);
  }

  createIssueSession(issueId: string, input: CreateIssueSessionInput = {}): MultiremiIssueSession {
    return this.ctx.db.transaction(() => this.createIssueSessionWithinTransaction(issueId, input))();
  }

  /** Caller already owns the transaction for the session + first event. */
  createIssueSessionWithinTransaction(issueId: string, input: CreateIssueSessionInput = {}): MultiremiIssueSession {
    const issue = this.ctx.issues().getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const title = input.title?.trim() || `Session ${this.listIssueSessions(issueId, true).length + 1}`;
    const id = input.id ?? createId("ises");
    const now = nowIso();
    const createdByType = input.createdByType ?? input.created_by_type ?? "member";
    const createdById = input.createdById ?? input.created_by_id ?? null;
    const holdsWorkspace = input.holdsWorkspace ?? input.holds_workspace ?? true;
    if (typeof holdsWorkspace !== "boolean") throw new Error("holds_workspace must be a boolean");
    this.ctx.db.run(
      `INSERT INTO multiremi_issue_sessions (
         id, issue_id, workspace_id, title, status, is_default, holds_workspace,
         created_by_type, created_by_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'active', 0, ?, ?, ?, ?, ?)`,
      [id, issueId, issue.workspaceId, title, holdsWorkspace ? 1 : 0, createdByType, createdById, now, now],
    );
    if (createdById && (createdByType === "member" || createdByType === "agent")) {
      this.addSessionParticipant(id, {
        participantType: createdByType,
        participantId: createdById,
        role: "owner",
      });
    }
    const participantAgentIds = input.participantAgentIds ?? input.participant_agent_ids ?? [];
    for (const agentId of participantAgentIds) {
      this.addSessionParticipant(id, { participantType: "agent", participantId: agentId });
    }
    this.appendSessionEventWithinTransaction(id, {
      authorType: "system",
      authorId: null,
      kind: "session_created",
      body: title,
      metadata: { created_by_type: createdByType, created_by_id: createdById },
    });
    return this.getIssueSession(id)!;
  }

  getLatestActiveIssueSession(issueId: string): MultiremiIssueSession | null {
    if (!this.ctx.issues().getIssue(issueId)) throw new Error(`Issue not found: ${issueId}`);
    const row = this.ctx.db.query(
      `SELECT * FROM multiremi_issue_sessions
       WHERE issue_id = ? AND status = 'active'
       ORDER BY updated_at DESC, created_at DESC, id DESC
       LIMIT 1`,
    ).get(issueId) as Row | null;
    return row ? toIssueSession(row) : null;
  }

  getIssueSession(id: string): MultiremiIssueSession | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_issue_sessions WHERE id = ?").get(id) as Row | null;
    return row ? toIssueSession(row) : null;
  }

  listIssueSessions(issueId: string, includeArchived = false): MultiremiIssueSession[] {
    if (!this.ctx.issues().getIssue(issueId)) throw new Error(`Issue not found: ${issueId}`);
    const rows = includeArchived
      ? this.ctx.db.query(
        "SELECT * FROM multiremi_issue_sessions WHERE issue_id = ? ORDER BY is_default DESC, updated_at DESC",
      ).all(issueId) as Row[]
      : this.ctx.db.query(
        "SELECT * FROM multiremi_issue_sessions WHERE issue_id = ? AND status = 'active' ORDER BY is_default DESC, updated_at DESC",
      ).all(issueId) as Row[];
    return rows.map(toIssueSession);
  }

  updateIssueSession(id: string, input: UpdateIssueSessionInput): MultiremiIssueSession {
    const session = this.getIssueSession(id);
    if (!session) throw new Error(`Issue session not found: ${id}`);
    const title = input.title === undefined ? session.title : input.title.trim();
    if (!title) throw new Error("Session title is required");
    const status = input.status ?? session.status;
    if (status !== "active" && status !== "archived") throw new Error(`Invalid session status: ${status}`);
    const summary = input.summary === undefined ? session.summary : cleanOptionalString(input.summary);
    const now = nowIso();
    this.ctx.db.run(
      "UPDATE multiremi_issue_sessions SET title = ?, status = ?, summary = ?, updated_at = ? WHERE id = ?",
      [title, status, summary, now, id],
    );
    return this.getIssueSession(id)!;
  }

  addSessionParticipant(sessionId: string, input: AddSessionParticipantInput): MultiremiSessionParticipant {
    const session = this.getIssueSession(sessionId);
    if (!session) throw new Error(`Issue session not found: ${sessionId}`);
    const participantType = input.participantType ?? input.participant_type;
    const participantId = input.participantId ?? input.participant_id;
    if (participantType !== "agent" && participantType !== "member") {
      throw new Error("participant_type must be agent or member");
    }
    if (!participantId) throw new Error("participant_id is required");
    let normalizedParticipantId = participantId;
    if (participantType === "agent") {
      const agent = this.ctx.agents().getAgent(participantId);
      if (!agent || agent.archivedAt) throw new Error(`Agent not found: ${participantId}`);
      if (agent.workspaceId !== session.workspaceId) throw new Error("Participant belongs to another workspace");
    } else {
      const member = this.ctx.workspaces().getWorkspaceMember(participantId) ?? this.ctx.workspaces().findWorkspaceMemberForUser(participantId, session.workspaceId);
      if (!member || member.workspaceId !== session.workspaceId) throw new Error(`Member not found: ${participantId}`);
      // New API actors use stable user ids, while local/legacy member fixtures
      // may not have a user link yet. Preserve their member id rather than
      // inserting NULL into the participant key.
      normalizedParticipantId = member.userId ?? member.id;
    }
    const now = nowIso();
    const id = createId("spart");
    this.ctx.db.run(
      `INSERT INTO multiremi_session_participants (
         id, session_id, participant_type, participant_id, role, status, joined_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
       ON CONFLICT(session_id, participant_type, participant_id)
       DO UPDATE SET role = excluded.role, status = 'active', updated_at = excluded.updated_at`,
      [id, sessionId, participantType, normalizedParticipantId, input.role?.trim() || "participant", now, now],
    );
    if (participantType === "agent") this.getOrCreateSessionAgentLane(sessionId, normalizedParticipantId);
    const row = this.ctx.db.query(
      `SELECT * FROM multiremi_session_participants
       WHERE session_id = ? AND participant_type = ? AND participant_id = ?`,
    ).get(sessionId, participantType, normalizedParticipantId) as Row | null;
    return toSessionParticipant(row!);
  }

  removeSessionParticipant(sessionId: string, participantType: string, participantId: string): void {
    if (!this.getIssueSession(sessionId)) throw new Error(`Issue session not found: ${sessionId}`);
    this.ctx.db.run(
      `UPDATE multiremi_session_participants
       SET status = 'left', updated_at = ?
       WHERE session_id = ? AND participant_type = ? AND participant_id = ?`,
      [nowIso(), sessionId, participantType, participantId],
    );
  }

  listSessionParticipants(sessionId: string, includeLeft = false): MultiremiSessionParticipant[] {
    if (!this.getIssueSession(sessionId)) throw new Error(`Issue session not found: ${sessionId}`);
    const rows = includeLeft
      ? this.ctx.db.query(
        "SELECT * FROM multiremi_session_participants WHERE session_id = ? ORDER BY joined_at ASC",
      ).all(sessionId) as Row[]
      : this.ctx.db.query(
        "SELECT * FROM multiremi_session_participants WHERE session_id = ? AND status = 'active' ORDER BY joined_at ASC",
      ).all(sessionId) as Row[];
    return rows.map(toSessionParticipant);
  }

  appendSessionEvent(sessionId: string, input: AppendSessionEventInput): MultiremiSessionEvent {
    return this.ctx.db.transaction(() => this.appendSessionEventWithinTransaction(sessionId, input))();
  }

  /** Caller already owns the transaction that serializes this session write. */
  appendSessionEventWithinTransaction(sessionId: string, input: AppendSessionEventInput): MultiremiSessionEvent {
    const session = this.getIssueSession(sessionId);
    if (!session) throw new Error(`Issue session not found: ${sessionId}`);
    // Row self-write serializes sequence allocation across server processes.
    this.ctx.db.run("UPDATE multiremi_issue_sessions SET updated_at = updated_at WHERE id = ?", [sessionId]);
    const max = this.ctx.db.query(
      "SELECT COALESCE(MAX(seq), 0) AS seq FROM multiremi_session_events WHERE session_id = ?",
    ).get(sessionId) as { seq: number } | null;
    const seq = Number(max?.seq ?? 0) + 1;
    const id = createId("sevt");
    const now = input.createdAt ?? nowIso();
    this.ctx.db.run(
      `INSERT INTO multiremi_session_events (
         id, session_id, seq, author_type, author_id, kind, body,
         task_id, source_comment_id, metadata, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        sessionId,
        seq,
        input.authorType,
        input.authorId ?? null,
        input.kind ?? "message",
        input.body ?? "",
        input.taskId ?? null,
        input.sourceCommentId ?? null,
        toJson(input.metadata ?? {}),
        now,
      ],
    );
    this.ctx.db.run("UPDATE multiremi_issue_sessions SET updated_at = ? WHERE id = ?", [now, sessionId]);
    return toSessionEvent(this.ctx.db.query("SELECT * FROM multiremi_session_events WHERE id = ?").get(id) as Row);
  }

  listSessionEvents(sessionId: string, input: { sinceSeq?: number | null; toSeq?: number | null } = {}): MultiremiSessionEvent[] {
    if (!this.getIssueSession(sessionId)) throw new Error(`Issue session not found: ${sessionId}`);
    const sinceSeq = Math.max(0, Math.floor(Number(input.sinceSeq ?? 0)));
    const toSeq = input.toSeq == null ? null : Math.max(0, Math.floor(Number(input.toSeq)));
    const rows = toSeq == null
      ? this.ctx.db.query(
        "SELECT * FROM multiremi_session_events WHERE session_id = ? AND seq > ? ORDER BY seq ASC",
      ).all(sessionId, sinceSeq) as Row[]
      : this.ctx.db.query(
        "SELECT * FROM multiremi_session_events WHERE session_id = ? AND seq > ? AND seq <= ? ORDER BY seq ASC",
      ).all(sessionId, sinceSeq, toSeq) as Row[];
    return rows.map(toSessionEvent);
  }

  getOrCreateSessionAgentLane(sessionId: string, agentId: string): MultiremiSessionAgentLane {
    const session = this.getIssueSession(sessionId);
    if (!session) throw new Error(`Issue session not found: ${sessionId}`);
    const agent = this.ctx.agents().getAgent(agentId);
    if (!agent || agent.archivedAt) throw new Error(`Agent not found: ${agentId}`);
    if (agent.workspaceId !== session.workspaceId) throw new Error("Agent belongs to another workspace");
    const now = nowIso();
    this.ctx.db.run(
      `INSERT INTO multiremi_session_agent_lanes (
         session_id, agent_id, cursor_seq, generation, status, created_at, updated_at
       ) VALUES (?, ?, 0, 1, 'active', ?, ?)
       ON CONFLICT(session_id, agent_id) DO NOTHING`,
      [sessionId, agentId, now, now],
    );
    const row = this.ctx.db.query(
      "SELECT * FROM multiremi_session_agent_lanes WHERE session_id = ? AND agent_id = ?",
    ).get(sessionId, agentId) as Row | null;
    return toSessionAgentLane(row!);
  }

  getSessionAgentLane(sessionId: string, agentId: string): MultiremiSessionAgentLane | null {
    const row = this.ctx.db.query(
      "SELECT * FROM multiremi_session_agent_lanes WHERE session_id = ? AND agent_id = ?",
    ).get(sessionId, agentId) as Row | null;
    return row ? toSessionAgentLane(row) : null;
  }

  buildTaskSessionProjection(taskId: string): MultiremiSessionProjection | null {
    return this.ctx.db.transaction(() => {
      const task = this.ctx.tasks().getTask(taskId);
      if (!task?.issueSessionId) return null;
      // Delegation wakeup coalescing uses the same Session row lock. Whichever
      // side wins decides deterministically whether this prompt includes a new
      // teammate event or a follow-up Delta task is required.
      this.ctx.db.run(
        "UPDATE multiremi_issue_sessions SET updated_at = updated_at WHERE id = ?",
        [task.issueSessionId],
      );
      const lane = this.getOrCreateSessionAgentLane(task.issueSessionId, task.agentId);
      const agent = this.ctx.agents().getAgent(task.agentId);
      const events = this.listSessionEvents(task.issueSessionId);
      const tokenBudget = resolveProjectionTokenBudget({
        provider: agent?.provider,
        model: agent?.model,
        degradeLevel: task.projectionDegradeLevel,
      });
      const projection = buildSessionProjection({
        sessionId: task.issueSessionId,
        targetAgentId: task.agentId,
        events,
        cursorSeq: lane.cursorSeq,
        providerSessionId: task.sessionId && task.sessionId === lane.providerSessionId ? task.sessionId : null,
        tokenBudget,
        currentTaskId: task.id,
        resolveAuthorName: (type, id) => this.sessionAuthorName(type, id),
      });
      this.ctx.db.run(
        `UPDATE multiremi_tasks
         SET projection_from_seq = ?, projection_to_seq = ?, projection_mode = ?,
             projection_truncated = ?, projection_omitted_events = ?, projection_estimated_tokens = ?,
             updated_at = ?
         WHERE id = ?`,
        [
          projection.fromSeq,
          projection.toSeq,
          projection.mode,
          projection.truncated ? 1 : 0,
          projection.omittedEvents,
          projection.estimatedTokens,
          nowIso(),
          taskId,
        ],
      );
      if (projection.truncated) {
        log.warn(
          `session projection truncated for task ${taskId}: omitted=${projection.omittedEvents} `
          + `estimated_tokens=${projection.estimatedTokens} budget=${tokenBudget} `
          + `degrade_level=${task.projectionDegradeLevel}`,
        );
      }
      return projection;
    })();
  }

  createSessionTask(sessionId: string, input: CreateSessionTaskInput): MultiremiTask {
    const session = this.getIssueSession(sessionId);
    if (!session) throw new Error(`Issue session not found: ${sessionId}`);
    const agentId = input.agentId ?? input.agent_id;
    if (!agentId) throw new Error("agent_id is required");
    this.addSessionParticipant(sessionId, { participantType: "agent", participantId: agentId });
    return this.ctx.tasks().createTask({
      agentId,
      issueId: session.issueId,
      issueSessionId: sessionId,
      workspaceId: session.workspaceId,
      priority: input.priority,
      prompt: input.prompt,
      assignmentAuthorType: input.createdByType ?? input.created_by_type ?? "system",
      assignmentAuthorId: input.createdById ?? input.created_by_id ?? null,
      assignmentSourceEventId: input.sourceEventId ?? input.source_event_id ?? null,
      parentTaskId: input.parentTaskId ?? input.parent_task_id ?? null,
    });
  }

  publishSessionResult(sessionId: string, input: PublishSessionResultInput): MultiremiSessionResult {
    const session = this.getIssueSession(sessionId);
    if (!session) throw new Error(`Issue session not found: ${sessionId}`);
    const body = input.body.trim();
    if (!body) throw new Error("Result body is required");
    const id = createId("sres");
    const now = nowIso();
    const publishedByType = input.publishedByType ?? input.published_by_type ?? "agent";
    const publishedById = input.publishedById ?? input.published_by_id ?? null;
    this.ctx.db.run(
      `INSERT INTO multiremi_session_results (
         id, issue_id, source_session_id, title, body, metadata,
         published_by_type, published_by_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        session.issueId,
        sessionId,
        input.title?.trim() ?? "",
        body,
        toJson(input.metadata ?? {}),
        publishedByType,
        publishedById,
        now,
      ],
    );
    this.appendSessionEvent(sessionId, {
      authorType: "system",
      authorId: null,
      kind: "result_published",
      body,
      metadata: { result_id: id, title: input.title?.trim() ?? "" },
    });
    const result = this.getSessionResult(id)!;
    try {
      this.ctx.notificationChannels().queueAgentIssueUpdate({
        activityId: result.id,
        issueId: session.issueId,
        actorType: publishedByType,
        actorId: publishedById,
        type: "result_published",
        body: [result.title ? `Published result: ${result.title}` : "Published result", result.body].join("\n\n"),
        data: {
          resultId: result.id,
          sourceSessionId: sessionId,
          ...(input.sourceTaskId ? { sourceTaskId: input.sourceTaskId } : {}),
        },
        createdAt: now,
      });
    } catch (error) {
      log.warn(`agent issue result update queue skipped for ${session.issueId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return result;
  }

  getSessionResult(id: string): MultiremiSessionResult | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_session_results WHERE id = ?").get(id) as Row | null;
    return row ? toSessionResult(row) : null;
  }

  listIssueSessionResults(issueId: string): MultiremiSessionResult[] {
    if (!this.ctx.issues().getIssue(issueId)) throw new Error(`Issue not found: ${issueId}`);
    const rows = this.ctx.db.query(
      "SELECT * FROM multiremi_session_results WHERE issue_id = ? ORDER BY created_at ASC",
    ).all(issueId) as Row[];
    return rows.map(toSessionResult);
  }

  private sessionAuthorName(authorType: string, authorId: string | null): string | null {
    if (!authorId) return null;
    if (authorType === "agent") return this.ctx.agents().getAgent(authorId)?.name ?? null;
    if (authorType === "member") {
      return this.ctx.workspaces().getWorkspaceMember(authorId)?.name ?? this.ctx.workspaces().getUser(authorId)?.name ?? null;
    }
    return null;
  }
}

function toIssueSession(row: Row): MultiremiIssueSession {
  const issueId = String(row.issue_id);
  const workspaceId = String(row.workspace_id ?? "local");
  const isDefault = Boolean(Number(row.is_default ?? 0));
  const holdsWorkspace = Boolean(Number(row.holds_workspace ?? 1));
  const createdByType = String(row.created_by_type ?? "member");
  const createdById = nullableString(row.created_by_id);
  const createdAt = String(row.created_at);
  const updatedAt = String(row.updated_at);
  return {
    id: String(row.id),
    issueId,
    issue_id: issueId,
    workspaceId,
    workspace_id: workspaceId,
    title: String(row.title ?? "Main"),
    status: String(row.status ?? "active") as MultiremiIssueSession["status"],
    isDefault,
    is_default: isDefault,
    holdsWorkspace,
    holds_workspace: holdsWorkspace,
    summary: nullableString(row.summary),
    createdByType,
    created_by_type: createdByType,
    createdById,
    created_by_id: createdById,
    createdAt,
    created_at: createdAt,
    updatedAt,
    updated_at: updatedAt,
  };
}

function toSessionParticipant(row: Row): MultiremiSessionParticipant {
  const sessionId = String(row.session_id);
  const participantType = String(row.participant_type) as MultiremiSessionParticipant["participantType"];
  const participantId = String(row.participant_id);
  const joinedAt = String(row.joined_at);
  const updatedAt = String(row.updated_at);
  return {
    id: String(row.id),
    sessionId,
    session_id: sessionId,
    participantType,
    participant_type: participantType,
    participantId,
    participant_id: participantId,
    role: String(row.role ?? "participant"),
    status: String(row.status ?? "active"),
    joinedAt,
    joined_at: joinedAt,
    updatedAt,
    updated_at: updatedAt,
  };
}

function toSessionEvent(row: Row): MultiremiSessionEvent {
  const sessionId = String(row.session_id);
  const authorType = String(row.author_type ?? "system");
  const authorId = nullableString(row.author_id);
  const taskId = nullableString(row.task_id);
  const sourceCommentId = nullableString(row.source_comment_id);
  const createdAt = String(row.created_at);
  return {
    id: String(row.id),
    sessionId,
    session_id: sessionId,
    seq: Number(row.seq ?? 0),
    authorType,
    author_type: authorType,
    authorId,
    author_id: authorId,
    kind: String(row.kind ?? "message"),
    body: String(row.body ?? ""),
    taskId,
    task_id: taskId,
    sourceCommentId,
    source_comment_id: sourceCommentId,
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    createdAt,
    created_at: createdAt,
  };
}

function toSessionAgentLane(row: Row): MultiremiSessionAgentLane {
  const sessionId = String(row.session_id);
  const agentId = String(row.agent_id);
  const providerSessionId = nullableString(row.provider_session_id);
  const executionFingerprint = nullableString(row.execution_fingerprint);
  const runtimeId = nullableString(row.runtime_id);
  const workDir = nullableString(row.work_dir);
  const lastTaskId = nullableString(row.last_task_id);
  const createdAt = String(row.created_at);
  const updatedAt = String(row.updated_at);
  const cursorSeq = Number(row.cursor_seq ?? 0);
  return {
    sessionId,
    session_id: sessionId,
    agentId,
    agent_id: agentId,
    providerSessionId,
    provider_session_id: providerSessionId,
    runtimeId,
    runtime_id: runtimeId,
    provider: nullableString(row.provider),
    executionFingerprint,
    execution_fingerprint: executionFingerprint,
    workDir,
    work_dir: workDir,
    cursorSeq,
    cursor_seq: cursorSeq,
    generation: Number(row.generation ?? 1),
    status: String(row.status ?? "active"),
    lastTaskId,
    last_task_id: lastTaskId,
    createdAt,
    created_at: createdAt,
    updatedAt,
    updated_at: updatedAt,
  };
}

function toSessionResult(row: Row): MultiremiSessionResult {
  const issueId = String(row.issue_id);
  const sourceSessionId = String(row.source_session_id);
  const publishedByType = String(row.published_by_type ?? "agent");
  const publishedById = nullableString(row.published_by_id);
  const createdAt = String(row.created_at);
  return {
    id: String(row.id),
    issueId,
    issue_id: issueId,
    sourceSessionId,
    source_session_id: sourceSessionId,
    title: String(row.title ?? ""),
    body: String(row.body ?? ""),
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    publishedByType,
    published_by_type: publishedByType,
    publishedById,
    published_by_id: publishedById,
    createdAt,
    created_at: createdAt,
  };
}
