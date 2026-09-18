// Issue sessions domain (sessions, participants, session events, agent lanes and published
// results), extracted verbatim from MultiremiStore (the facade delegates every public method here).
import { createId, nowIso } from "@multiremi/ids.js";
import { taskExecutionScope } from "@multiremi/contracts/task-execution.js";
import { cleanOptionalString, nullableString, parseJson, toJson } from "@multiremi/store/helpers.js";
import { type StoreContext } from "@multiremi/store/context.js";
import { buildSessionProjection } from "@multiremi/store/session-projection.js";
import { resolveFollowDeltaRatio, resolveFollowTokenLimit, resolveProjectionTokenBudget } from "@multiremi/store/session-projection-budget.js";
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
  MultiremiSessionInheritedContext,
  MultiremiSessionResult,
  MultiremiTask,
  PublishSessionResultInput,
  UpdateIssueSessionInput,
} from "@multiremi/contracts/types.js";

type Row = Record<string, unknown>;
const log = createLogger("multiremi-store");
const SESSION_SELECT = `SELECT s.*, (
  SELECT COUNT(*) FROM multiremi_session_events e
  WHERE e.session_id = s.parent_session_id
    AND ((s.inherit_mode = 'follow' AND (s.follow_frozen_seq IS NULL OR e.seq <= s.follow_frozen_seq))
      OR (s.inherit_mode <> 'follow' AND e.seq <= s.inherit_cutoff_seq))
) AS inherited_event_count FROM multiremi_issue_sessions s`;
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
      `${SESSION_SELECT} WHERE issue_id = ? AND is_default = 1 LIMIT 1`,
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
      `${SESSION_SELECT} WHERE issue_id = ? AND is_default = 1 LIMIT 1`,
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
    const requestedHoldsWorkspace = input.holdsWorkspace ?? input.holds_workspace ?? true;
    if (typeof requestedHoldsWorkspace !== "boolean") throw new Error("holds_workspace must be a boolean");
    const parentInput = input.parentSessionId ?? input.parent_session_id;
    if (parentInput != null && (typeof parentInput !== "string" || !parentInput.trim())) {
      throw new Error("parent_session_id must be a non-empty string");
    }
    const parentSessionId = parentInput?.trim() ?? null;
    const withCode = input.withCode ?? input.with_code ?? false;
    for (const requested of [input.withCode, input.with_code]) {
      if (requested !== undefined && (typeof requested !== "boolean" || requested !== withCode)) {
        throw new Error("with_code must be a boolean; withCode and with_code must agree");
      }
    }
    if (withCode && !parentSessionId) throw new Error("with_code requires parent_session_id");
    let codeRuntimeId: string | null = null;
    const requestedInheritMode = input.inheritMode ?? input.inherit_mode;
    const inheritMode = requestedInheritMode ?? (parentSessionId ? "snapshot" : "none");
    if (parentSessionId ? inheritMode !== "snapshot" && inheritMode !== "follow" : inheritMode !== "none") {
      throw new Error(parentSessionId
        ? "inherit_mode must be snapshot or follow with parent_session_id"
        : "inherit_mode must be none without parent_session_id");
    }
    let inheritCutoffSeq: number | null = null;
    if (parentSessionId) {
      // Use the same row lock as event appends: the cutoff and child creation
      // form one snapshot, including across PostgreSQL server processes.
      this.ctx.db.run("UPDATE multiremi_issue_sessions SET updated_at = updated_at WHERE id = ?", [parentSessionId]);
      const parent = this.getIssueSession(parentSessionId);
      if (!parent) throw new Error(`Parent session not found: ${parentSessionId}`);
      if (parent.issueId !== issueId) throw new Error("Parent session must belong to the same issue");
      if (parent.inheritMode !== "none") throw new Error("Cannot inherit from a side session (chained forks are not supported)");
      const max = this.ctx.db.query(
        "SELECT COALESCE(MAX(seq), 0) AS seq FROM multiremi_session_events WHERE session_id = ?",
      ).get(parentSessionId) as { seq: number } | null;
      inheritCutoffSeq = Number(max?.seq ?? 0);
      if (withCode) {
        const lane = this.ctx.db.query(
          `SELECT lane.runtime_id FROM multiremi_session_agent_lanes lane
           JOIN multiremi_runtimes runtime ON runtime.id = lane.runtime_id
           WHERE lane.session_id = ? AND COALESCE(runtime.workspace_id, 'local') = ?
           ORDER BY lane.updated_at DESC, lane.agent_id, lane.execution_scope LIMIT 1`,
        ).get(parentSessionId, issue.workspaceId) as Row | null;
        codeRuntimeId = nullableString(lane?.runtime_id);
        if (!codeRuntimeId) throw new Error("with_code requires a parent session lane with a runtime");
      }
    }
    const holdsWorkspace = parentSessionId ? false : requestedHoldsWorkspace;
    this.ctx.db.run(
      `INSERT INTO multiremi_issue_sessions (
         id, issue_id, workspace_id, title, status, is_default, holds_workspace,
         parent_session_id, inherit_mode, inherit_cutoff_seq, with_code, code_runtime_id,
         created_by_type, created_by_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'active', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, issueId, issue.workspaceId, title, holdsWorkspace ? 1 : 0,
        parentSessionId, inheritMode, inheritCutoffSeq, withCode ? 1 : 0, codeRuntimeId, createdByType, createdById, now, now],
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
      `${SESSION_SELECT}
       WHERE issue_id = ? AND status = 'active'
       ORDER BY updated_at DESC, created_at DESC, id DESC
       LIMIT 1`,
    ).get(issueId) as Row | null;
    return row ? toIssueSession(row) : null;
  }

  getIssueSession(id: string): MultiremiIssueSession | null {
    const row = this.ctx.db.query(`${SESSION_SELECT} WHERE id = ?`).get(id) as Row | null;
    return row ? toIssueSession(row) : null;
  }

  getSessionInheritedContext(sessionId: string): MultiremiSessionInheritedContext | null {
    const session = this.getIssueSession(sessionId);
    if (!session) return null;
    const inherits = session.inheritMode !== "none" && session.parentSessionId !== null;
    const row = inherits ? this.ctx.db.query(
      `SELECT id, agent_id, inherited_projection_truncated, inherited_projection_omitted_events,
              inherited_projection_estimated_tokens, inherited_projection_to_seq,
              inherited_projection_token_budget, inherited_projection_recorded_at
       FROM multiremi_tasks
       WHERE issue_session_id = ? AND inherited_projection_truncated IS NOT NULL
       ORDER BY inherited_projection_recorded_at DESC, id DESC LIMIT 1`,
    ).get(sessionId) as Row | null : null;
    const cost = this.ctx.db.query(
      "SELECT inherited_tokens_total, follow_frozen_seq FROM multiremi_issue_sessions WHERE id = ?",
    ).get(sessionId) as Row;
    const parentMax = inherits ? this.parentMaxSeq(session.parentSessionId!) : null;
    const lanes = inherits ? this.ctx.db.query(
      `SELECT agent_id, execution_scope, parent_cursor_seq FROM multiremi_session_agent_lanes
       WHERE session_id = ? ORDER BY agent_id, execution_scope`,
    ).all(sessionId) as Row[] : [];
    return {
      session_id: session.id,
      parent_session_id: inherits ? session.parentSessionId : null,
      parent_session_title: inherits ? this.getIssueSession(session.parentSessionId!)?.title ?? null : null,
      inherit_mode: session.inheritMode,
      inherit_cutoff_seq: inherits ? session.inheritCutoffSeq : null,
      ...(session.inheritMode === "follow" ? {
        parent_max_seq: parentMax,
        lanes: lanes.map((lane) => ({
          agent_id: String(lane.agent_id),
          execution_scope: String(lane.execution_scope),
          parent_cursor_seq: Number(lane.parent_cursor_seq),
        })),
        inherited_tokens_total: Number(cost.inherited_tokens_total),
        follow_token_limit: resolveFollowTokenLimit(),
        follow_frozen: cost.follow_frozen_seq != null,
        follow_frozen_seq: cost.follow_frozen_seq == null ? null : Number(cost.follow_frozen_seq),
      } : {}),
      // Raw parent size before truncation; follow includes new parent events.
      inherited_event_count: inherits ? session.inheritedEventCount : null,
      diagnostics: row ? {
        task_id: String(row.id),
        agent_id: String(row.agent_id),
        to_seq: Number(row.inherited_projection_to_seq),
        truncated: Boolean(Number(row.inherited_projection_truncated)),
        omitted_events: Number(row.inherited_projection_omitted_events),
        estimated_tokens: Number(row.inherited_projection_estimated_tokens),
        token_budget: Number(row.inherited_projection_token_budget),
        recorded_at: String(row.inherited_projection_recorded_at),
      } : null,
    };
  }

  listIssueSessions(issueId: string, includeArchived = false): MultiremiIssueSession[] {
    if (!this.ctx.issues().getIssue(issueId)) throw new Error(`Issue not found: ${issueId}`);
    const rows = includeArchived
      ? this.ctx.db.query(
        `${SESSION_SELECT} WHERE issue_id = ? ORDER BY is_default DESC, updated_at DESC`,
      ).all(issueId) as Row[]
      : this.ctx.db.query(
        `${SESSION_SELECT} WHERE issue_id = ? AND status = 'active' ORDER BY is_default DESC, updated_at DESC`,
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

  getOrCreateSessionAgentLane(sessionId: string, agentId: string, executionScope = ""): MultiremiSessionAgentLane {
    const session = this.getIssueSession(sessionId);
    if (!session) throw new Error(`Issue session not found: ${sessionId}`);
    const agent = this.ctx.agents().getAgent(agentId);
    if (!agent || agent.archivedAt) throw new Error(`Agent not found: ${agentId}`);
    if (agent.workspaceId !== session.workspaceId) throw new Error("Agent belongs to another workspace");
    const now = nowIso();
    this.ctx.db.run(
      `INSERT INTO multiremi_session_agent_lanes (
         session_id, agent_id, execution_scope, cursor_seq, generation, status, created_at, updated_at
       ) VALUES (?, ?, ?, 0, 1, 'active', ?, ?)
       ON CONFLICT(session_id, agent_id, execution_scope) DO NOTHING`,
      [sessionId, agentId, executionScope, now, now],
    );
    const row = this.ctx.db.query(
      "SELECT * FROM multiremi_session_agent_lanes WHERE session_id = ? AND agent_id = ? AND execution_scope = ?",
    ).get(sessionId, agentId, executionScope) as Row | null;
    return toSessionAgentLane(row!);
  }

  getSessionAgentLane(sessionId: string, agentId: string, executionScope = ""): MultiremiSessionAgentLane | null {
    const row = this.ctx.db.query(
      "SELECT * FROM multiremi_session_agent_lanes WHERE session_id = ? AND agent_id = ? AND execution_scope = ?",
    ).get(sessionId, agentId, executionScope) as Row | null;
    return row ? toSessionAgentLane(row) : null;
  }

  buildTaskSessionProjection(taskId: string): MultiremiSessionProjection | null {
    return this.ctx.db.transaction(() => {
      const task = this.ctx.tasks().getTask(taskId);
      if (!task?.issueSessionId) return null;
      // Match bulk lifecycle lock ordering, including the parent row used by
      // event appends. Holding both locks covers MAX(seq), the event read and
      // recording the follow window without a side/parent lock inversion.
      const initialSession = this.getIssueSession(task.issueSessionId)!;
      const sessionIds = [task.issueSessionId, initialSession.parentSessionId]
        .filter((id): id is string => id !== null).sort();
      for (const sessionId of sessionIds) {
        this.ctx.db.run(
          "UPDATE multiremi_issue_sessions SET updated_at = updated_at WHERE id = ?",
          [sessionId],
        );
      }
      const lane = this.getOrCreateSessionAgentLane(task.issueSessionId, task.agentId, taskExecutionScope(task));
      const agent = this.ctx.agents().getAgent(task.agentId);
      const session = this.getIssueSession(task.issueSessionId)!;
      const events = this.listSessionEvents(task.issueSessionId);
      const tokenBudget = resolveProjectionTokenBudget({
        provider: agent?.provider,
        model: agent?.model,
        degradeLevel: task.projectionDegradeLevel,
      });
      const inherits = session.inheritMode !== "none" && session.parentSessionId !== null;
      // Once claimed, a follow task owns an immutable parent window. In
      // particular a retry must not absorb events appended after its first build.
      const recorded = this.ctx.db.query(
        `SELECT inherited_projection_from_seq, inherited_projection_to_seq,
                inherited_projection_token_budget FROM multiremi_tasks WHERE id = ?`,
      ).get(task.id) as Row;
      const recordedFollow = recorded.inherited_projection_from_seq != null;
      const follows = session.inheritMode === "follow" || recordedFollow;
      let parentFromSeq = 0;
      let parentToSeq = session.inheritCutoffSeq ?? 0;
      if (follows) {
        parentFromSeq = recordedFollow ? Number(recorded.inherited_projection_from_seq) : lane.parentCursorSeq;
        const state = this.ctx.db.query(
          "SELECT follow_frozen_seq FROM multiremi_issue_sessions WHERE id = ?",
        ).get(session.id) as Row;
        parentToSeq = recordedFollow ? Number(recorded.inherited_projection_to_seq)
          : Math.min(this.parentMaxSeq(session.parentSessionId!),
            state.follow_frozen_seq == null ? Infinity : Number(state.follow_frozen_seq));
      }
      const hasInheritedWindow = inherits && (!follows || parentToSeq > parentFromSeq);
      const inheritedTokenBudget = !hasInheritedWindow ? 0 : recordedFollow
        ? Number(recorded.inherited_projection_token_budget)
        : Math.floor(tokenBudget * (follows && parentFromSeq > 0 ? resolveFollowDeltaRatio() : 0.4));
      const projection = buildSessionProjection({
        sessionId: task.issueSessionId,
        targetAgentId: task.agentId,
        events,
        cursorSeq: lane.cursorSeq,
        providerSessionId: task.sessionId && task.sessionId === lane.providerSessionId ? task.sessionId : null,
        tokenBudget: tokenBudget - inheritedTokenBudget,
        currentTaskId: task.id,
        resolveAuthorName: (type, id) => this.sessionAuthorName(type, id),
      });
      if (hasInheritedWindow) {
        const parent = this.getIssueSession(session.parentSessionId!);
        if (!parent) throw new Error(`Parent session not found: ${session.parentSessionId}`);
        const inheritedProjection = buildSessionProjection({
          sessionId: parent.id,
          targetAgentId: task.agentId,
          events: this.listSessionEvents(parent.id, { sinceSeq: parentFromSeq, toSeq: parentToSeq }),
          cursorSeq: 0,
          fromSeq: parentFromSeq,
          toSeq: parentToSeq,
          providerSessionId: null,
          perspectiveMode: "inherited",
          tokenBudget: inheritedTokenBudget,
          resolveAuthorName: (type, id) => this.sessionAuthorName(type, id),
        });
        // The legacy projector always retains its JSONL header. If operators
        // configure a budget smaller than both envelopes, fail rather than
        // silently exceed the total budget when combining two projections.
        if (projection.estimatedTokens > tokenBudget - inheritedTokenBudget
          || inheritedProjection.estimatedTokens > inheritedTokenBudget) {
          throw new Error("Side session projection token budget is too small for the snapshot headers");
        }
        inheritedProjection.sessionTitle = parent.title;
        inheritedProjection.session_title = parent.title;
        projection.inheritedSessionProjection = inheritedProjection;
        projection.inherited_session_projection = inheritedProjection;
      } else if (follows) {
        projection.inheritedSessionProjection = null;
        projection.inherited_session_projection = null;
      }
      const inheritedProjection = projection.inheritedSessionProjection;
      const now = nowIso();
      this.ctx.db.run(
        `UPDATE multiremi_tasks
         SET projection_from_seq = ?, projection_to_seq = ?, projection_mode = ?,
             projection_truncated = ?, projection_omitted_events = ?, projection_estimated_tokens = ?,
             inherited_projection_truncated = ?, inherited_projection_omitted_events = ?,
             inherited_projection_estimated_tokens = ?, inherited_projection_to_seq = ?,
             inherited_projection_from_seq = ?, inherited_projection_token_budget = ?, inherited_projection_recorded_at = ?, updated_at = ?
         WHERE id = ?`,
        [
          projection.fromSeq,
          projection.toSeq,
          projection.mode,
          projection.truncated ? 1 : 0,
          projection.omittedEvents,
          projection.estimatedTokens,
          // Explicit NULLs also clear any diagnostics left by an earlier claim.
          inheritedProjection ? (inheritedProjection.truncated ? 1 : 0) : null,
          inheritedProjection?.omittedEvents ?? null,
          inheritedProjection?.estimatedTokens ?? null,
          follows ? parentToSeq : inheritedProjection?.toSeq ?? null,
          follows ? parentFromSeq : null,
          inheritedProjection ? inheritedTokenBudget : null,
          inherits ? (follows ? task.inheritedProjectionRecordedAt ?? now : now) : null,
          now,
          taskId,
        ],
      );
      if (follows && !recordedFollow && inheritedProjection) {
        // The session locks above serialize this with other builds. The
        // post-lock task window is our once-per-task receipt, so failures are
        // charged too and rebuilding the same task cannot double-charge.
        this.ctx.db.run(
          `UPDATE multiremi_issue_sessions
           SET inherited_tokens_total = inherited_tokens_total + ? WHERE id = ?`,
          [inheritedProjection.estimatedTokens, session.id],
        );
        const cost = this.ctx.db.query(
          "SELECT inherited_tokens_total, follow_frozen_seq FROM multiremi_issue_sessions WHERE id = ?",
        ).get(session.id) as Row;
        if (cost.follow_frozen_seq == null && Number(cost.inherited_tokens_total) >= resolveFollowTokenLimit()) {
          this.ctx.db.run(
            "UPDATE multiremi_issue_sessions SET follow_frozen_seq = ? WHERE id = ? AND follow_frozen_seq IS NULL",
            [lane.parentCursorSeq, session.id],
          );
          this.appendSessionEventWithinTransaction(session.id, {
            authorType: "system",
            kind: "follow_frozen",
            body: "跟随已达成本上限，已冻结。",
            metadata: { follow_frozen_seq: lane.parentCursorSeq },
          });
        }
      }
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

  private parentMaxSeq(sessionId: string): number {
    const row = this.ctx.db.query(
      "SELECT COALESCE(MAX(seq), 0) AS seq FROM multiremi_session_events WHERE session_id = ?",
    ).get(sessionId) as { seq: number };
    return Number(row.seq);
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
  const parentSessionId = nullableString(row.parent_session_id);
  const inheritMode = String(row.inherit_mode ?? "none") as MultiremiIssueSession["inheritMode"];
  const inheritCutoffSeq = row.inherit_cutoff_seq == null ? null : Number(row.inherit_cutoff_seq);
  const inheritedEventCount = Number(row.inherited_event_count ?? 0);
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
    withCode: Boolean(Number(row.with_code ?? 0)),
    with_code: Boolean(Number(row.with_code ?? 0)),
    codeRuntimeId: nullableString(row.code_runtime_id),
    code_runtime_id: nullableString(row.code_runtime_id),
    parentSessionId,
    parent_session_id: parentSessionId,
    inheritMode,
    inherit_mode: inheritMode,
    inheritCutoffSeq,
    inherit_cutoff_seq: inheritCutoffSeq,
    inheritedEventCount,
    inherited_event_count: inheritedEventCount,
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
    parentCursorSeq: Number(row.parent_cursor_seq ?? 0),
    parent_cursor_seq: Number(row.parent_cursor_seq ?? 0),
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
