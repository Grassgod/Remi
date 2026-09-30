// Chat domain (chat sessions and chat messages), extracted verbatim from MultiremiStore
// (the facade delegates every public method here).
import { createId, nowIso } from "@multiremi/ids.js";
import { cleanOptionalString, nullableString, resolveCamelOrSnakeString } from "@multiremi/store/helpers.js";
import { createCommitEventQueue, type StoreContext } from "@multiremi/store/context.js";
import {
  chatMessageToConversationLog,
  type MirrorChatMessageRow,
} from "@multiremi/store/conversation-log-mirror.js";
import { RuntimeWorkspaceError, RuntimeWorkspacesRepo } from "./runtime-workspaces-repo.js";
import type { CancelTaskResult } from "./tasks-repo.js";
import { buildSessionProjection } from "@multiremi/store/session-projection.js";
import { conversationLogChatMessage } from "@multiremi/store/conversation-log-projection.js";
import { resolveProjectionTokenBudget } from "@multiremi/store/session-projection-budget.js";
import { createLogger } from "@shared/logger.js";
import type {
  CreateChatSessionInput,
  MultiremiChatMessage,
  MultiremiChatSession,
  MultiremiSessionEvent,
  MultiremiSessionProjection,
  MultiremiTask,
  SendChatMessageInput,
  SendChatMessageResult,
  UpdateChatSessionInput,
} from "@multiremi/contracts/types.js";

type Row = Record<string, unknown>;

export class ChatConflictError extends Error {}
export class ChatValidationError extends Error {}

export interface QueuedChatTask {
  task_id: string;
  content: string;
  attachment_ids: string[];
  created_at: string;
}

/** The in-flight statuses a Chat's queue counts as pending, in `pendingTasks()` terms. */
const PENDING_CHAT_TASK_STATUSES: MultiremiTask["status"][] = [
  "queued",
  "dispatched",
  "running",
  "waiting_local_directory",
  "awaiting_human",
];

/**
 * One row of the batched pending-task read: the winning task plus the Session
 * fields a caller needs to authorize it without re-reading the Chat.
 */
export interface PendingChatTaskCandidate {
  taskId: string;
  status: MultiremiTask["status"];
  chatSessionId: string;
  sessionAgentId: string;
  sessionWorkspaceId: string;
}

const CHAT_SESSION_SELECT = `SELECT chat.*,
  (SELECT COUNT(*) FROM multiremi_chat_messages m WHERE m.chat_session_id = chat.id
    AND m.role != 'user' AND m.created_at >= chat.unread_since) AS unread_count,
  (SELECT SUBSTR(m.body, 1, 240) FROM multiremi_chat_messages m WHERE m.chat_session_id = chat.id
    ORDER BY m.sequence DESC, m.id DESC LIMIT 1) AS last_message_content,
  (SELECT m.role FROM multiremi_chat_messages m WHERE m.chat_session_id = chat.id
    ORDER BY m.sequence DESC, m.id DESC LIMIT 1) AS last_message_role,
  (SELECT m.created_at FROM multiremi_chat_messages m WHERE m.chat_session_id = chat.id
    ORDER BY m.sequence DESC, m.id DESC LIMIT 1) AS last_message_created_at
  FROM multiremi_chat_sessions chat`;


const log = createLogger("multiremi-store");

export const AGENT_ISSUE_UPDATE_PROMPT_LIMIT = 12;

export interface PendingAgentIssueUpdateWriteResult {
  session: MultiremiChatSession;
  message: MultiremiChatMessage;
}

export interface PendingAgentIssueUpdateBatch {
  messages: MultiremiChatMessage[];
  omittedCount: number;
}
export class ChatRepo {
  constructor(private ctx: StoreContext) {}

  createChatSession(input: CreateChatSessionInput): MultiremiChatSession {
    return this.ctx.db.transaction(() => this.createChatSessionWithinTransaction(input))();
  }

  /** Caller owns the transaction, including any accompanying Chat binding. */
  createChatSessionWithinTransaction(input: CreateChatSessionInput): MultiremiChatSession {
    if (Object.hasOwn(input, "issueId") || Object.hasOwn(input, "issue_id")) {
      throw new ChatValidationError("Chat sessions cannot be bound to an Issue");
    }
    const workspaceId = input.workspaceId ?? input.workspace_id ?? "local";
    this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
    const agentId = input.agentId ?? input.agent_id;
    if (!agentId) throw new Error("agent_id is required");
    const agent = this.ctx.agents().getAgent(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    if (agent.archivedAt) throw new Error(`Agent is archived: ${agentId}`);
    if (agent.workspaceId !== workspaceId) throw new Error("Agent belongs to another workspace");
    const runtimeWorkspaceId = input.runtimeWorkspaceId ?? input.runtime_workspace_id ?? null;
    if (runtimeWorkspaceId) new RuntimeWorkspacesRepo(this.ctx).require(runtimeWorkspaceId, workspaceId);
    const projectId = this.validateProjectBinding(workspaceId,
      Object.hasOwn(input, "projectId") ? input.projectId : input.project_id);
    if (projectId && runtimeWorkspaceId) throw new RuntimeWorkspaceError("Choose either a project or a runtime workspace");
    const id = input.id ?? createId("chat");
    if (this.getChatSession(id) || this.ctx.db.query("SELECT id FROM multiremi_tasks WHERE chat_session_id = ? LIMIT 1").get(id)) {
      throw new ChatConflictError("Chat session id has already been used");
    }
    const now = nowIso();
    const title = input.title?.trim() || `Chat with ${agent.name}`;
    this.ctx.db.run(
      `INSERT INTO multiremi_chat_sessions (
        project_id, runtime_workspace_id, id, workspace_id, creator_id, agent_id, title, status, session_id, work_dir, latest_task_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL, NULL, ?, ?)`,
      [projectId, runtimeWorkspaceId, id, workspaceId, input.creatorId ?? input.creator_id ?? "local", agentId, title, now, now],
    );
    // The chat head is the session title at seq 0.
    this.ctx.conversationLog().syncChatHeadWithinTransaction(id, title, now);
    const session = this.getChatSession(id)!;
    return session;
  }

  private validateProjectBinding(workspaceId: string, value: unknown): string | null {
    if (value == null) return null;
    if (typeof value !== "string" || !value.trim()) {
      throw new ChatValidationError("project_id must be a Project ID or null");
    }
    const project = this.ctx.projects().getProject(value.trim());
    if (!project || project.workspaceId !== workspaceId || project.archivedAt) {
      throw new ChatValidationError("Project must exist, belong to this workspace, and not be archived");
    }
    return project.id;
  }

  listChatSessions(workspaceId?: string | null, options: { creatorId?: string | null; includeArchived?: boolean } = {}): MultiremiChatSession[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (workspaceId) {
      clauses.push("workspace_id = ?");
      params.push(workspaceId);
    }
    if (options.creatorId) {
      clauses.push("creator_id = ?");
      params.push(options.creatorId);
    }
    if (!options.includeArchived) {
      clauses.push("status != 'archived'");
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.ctx.db.query(`${CHAT_SESSION_SELECT} ${where} ORDER BY pinned DESC, updated_at DESC`).all(...params) as Row[];
    return rows.map(toChatSession);
  }

  getChatSession(id: string): MultiremiChatSession | null {
    const row = this.ctx.db.query(`${CHAT_SESSION_SELECT} WHERE chat.id = ?`).get(id) as Row | null;
    return row ? toChatSession(row) : null;
  }

  updateChatSession(id: string, input: UpdateChatSessionInput): MultiremiChatSession {
    if (Object.hasOwn(input, "projectId") || Object.hasOwn(input, "project_id")) {
      throw new ChatValidationError("A Chat Project can only be selected when creating the session");
    }
    if (Object.hasOwn(input, "issueId") || Object.hasOwn(input, "issue_id")) {
      throw new ChatValidationError("Chat sessions cannot be bound to an Issue");
    }
    const cancelled: CancelTaskResult[] = [];
    const childStatusChanges: import("./tasks-repo.js").ChildStatusChangeCollector = [];
    const deferredEvents = createCommitEventQueue();
    const updated = this.ctx.db.transaction(() => {
      const initial = this.getChatSession(id);
      if (!initial) throw new Error(`Chat session not found: ${id}`);
      this.ctx.lockWorkspaceRuntimeLifecycle(initial.workspaceId);
      const current = this.getChatSession(id);
      if (!current) throw new Error(`Chat session not found: ${id}`);
      const location = input as UpdateChatSessionInput & CreateChatSessionInput;
      for (const [field, saved] of [
        ["runtimeWorkspaceId", current.runtimeWorkspaceId], ["runtime_workspace_id", current.runtimeWorkspaceId],
      ] as const) {
        if (Object.hasOwn(location, field) && (location[field] ?? null) !== (saved ?? null)) {
          throw new RuntimeWorkspaceError("Chat work location is fixed; create a new Chat to change it", 409);
        }
      }
      const now = nowIso();
      this.ctx.db.run(
        `UPDATE multiremi_chat_sessions
         SET title = ?, status = ?, pinned = ?, updated_at = ?
         WHERE id = ?`,
        [input.title?.trim() || current.title, input.status ?? current.status, (input.pinned ?? current.pinned) ? 1 : 0, now, id],
      );
      if (input.status === "archived") {
        for (const task of this.pendingTasks(id)) {
          cancelled.push(this.ctx.tasks().cancelTaskWithinTransaction(task.id, childStatusChanges, deferredEvents));
        }
        this.discardPendingAgentIssueUpdatesWithinTransaction(id);
      }
      const updated = this.getChatSession(id)!;
      // A renamed Chat keeps one head row at seq 0 and bumps its `revision`.
      this.ctx.conversationLog().syncChatHeadWithinTransaction(id, updated.title, now);
      return updated;
    })();
    for (const result of cancelled) this.ctx.tasks().notifyCancelledTask(result);
    this.ctx.tasks().runCollectedChildStatusChanges(childStatusChanges);
    this.ctx.emitCommitEvents(deferredEvents);
    this.ctx.emitChatEvent(updated, "chat:session_updated", {
      title: updated.title,
      status: updated.status,
      pinned: updated.pinned,
      project_id: updated.projectId,
      updated_at: updated.updatedAt,
    });
    return updated;
  }

  deleteChatSession(id: string): boolean {
    const childStatusChangesDel: import("./tasks-repo.js").ChildStatusChangeCollector = [];
    const deferredEventsDel = createCommitEventQueue();
    const result = this.ctx.db.transaction(() => {
      const initial = this.getChatSession(id);
      if (!initial) return null;
      this.ctx.lockWorkspaceRuntimeLifecycle(initial.workspaceId);
      const current = this.getChatSession(id);
      if (!current) return null;
      const cancelled = this.pendingTasks(id).map((task) =>
        this.ctx.tasks().cancelTaskWithinTransaction(task.id, childStatusChangesDel, deferredEventsDel));
      // Keep the original private scope on retained task audits. Clearing it
      // would make their transcripts inherit the workspace Agent visibility.
      this.ctx.db.run("DELETE FROM multiremi_attachments WHERE chat_session_id = ?", [id]);
      this.ctx.db.run("DELETE FROM multiremi_chat_messages WHERE chat_session_id = ?", [id]);
      this.ctx.notificationChannels().deleteAgentChatNotificationChannel(id);
      const deleted = this.ctx.db.run("DELETE FROM multiremi_chat_sessions WHERE id = ?", [id]).changes > 0;
      return { current, cancelled, deleted };
    })();
    if (!result) return false;
    for (const terminal of result.cancelled) this.ctx.tasks().notifyCancelledTask(terminal);
    this.ctx.tasks().runCollectedChildStatusChanges(childStatusChangesDel);
    this.ctx.emitCommitEvents(deferredEventsDel);
    if (result.deleted) this.ctx.emitChatEvent(result.current, "chat:session_deleted", {});
    return result.deleted;
  }

  markChatSessionRead(id: string): void {
    const session = this.getChatSession(id);
    if (!session) throw new Error(`Chat session not found: ${id}`);
    this.ctx.db.run("UPDATE multiremi_chat_sessions SET unread_since = NULL WHERE id = ?", [id]);
    this.ctx.emitChatEvent(session, "chat:session_read", {});
  }

  private pendingTasks(chatSessionId: string): MultiremiTask[] {
    const rows = this.ctx.db.query(
      `SELECT id FROM multiremi_tasks WHERE chat_session_id = ?
       AND status IN ('queued', 'dispatched', 'running', 'waiting_local_directory', 'awaiting_human')
       ORDER BY CASE WHEN status = 'queued' THEN 1 ELSE 0 END, priority DESC, chat_queue_order ASC, created_at ASC, id ASC`,
    ).all(chatSessionId) as Row[];
    return rows.map((row) => this.ctx.tasks().getTask(String(row.id))!);
  }

  getPendingChatTask(chatSessionId: string): MultiremiTask | null {
    if (!this.getChatSession(chatSessionId)) throw new Error(`Chat session not found: ${chatSessionId}`);
    return this.pendingTasks(chatSessionId)[0] ?? null;
  }

  listQueuedChatTasks(chatSessionId: string): QueuedChatTask[] {
    if (!this.getChatSession(chatSessionId)) throw new Error(`Chat session not found: ${chatSessionId}`);
    return this.pendingTasks(chatSessionId).slice(1).filter((task) => task.status === "queued" && !task.wakeSource)
      .map((task) => this.queuedTaskResponse(task));
  }

  private queuedTaskResponse(task: MultiremiTask): QueuedChatTask {
    const attachments = this.ctx.db.query(
      `SELECT a.id FROM multiremi_attachments a JOIN multiremi_chat_messages m ON m.id = a.chat_message_id
       WHERE m.chat_session_id = ? AND m.task_id = ? AND m.role = 'user'`,
    ).all(task.chatSessionId, task.id) as Row[];
    return { task_id: task.id, content: task.prompt, attachment_ids: attachments.map((row) => String(row.id)), created_at: task.createdAt };
  }

  private requireQueuedTask(chatSessionId: string, taskId: string): MultiremiTask {
    const task = this.pendingTasks(chatSessionId).slice(1).find((entry) => entry.id === taskId && entry.status === "queued" && !entry.wakeSource);
    if (!task) throw new ChatConflictError("Task is no longer queued in this chat");
    return task;
  }

  updateQueuedChatTask(chatSessionId: string, taskId: string, content: string): QueuedChatTask {
    const result = this.ctx.db.transaction(() => {
      this.lockActiveSession(chatSessionId);
      this.requireQueuedTask(chatSessionId, taskId);
      const body = content.trim();
      if (!body) throw new Error("content is required");
      const changed = this.ctx.db.run(
        `UPDATE multiremi_tasks SET prompt = ?, updated_at = ? WHERE id = ? AND status = 'queued'`,
        [body, nowIso(), taskId],
      );
      if (!changed.changes) throw new ChatConflictError("Task is no longer queued");
      const messages = this.ctx.db.run("UPDATE multiremi_chat_messages SET body = ? WHERE chat_session_id = ? AND task_id = ? AND role = 'user'", [body, chatSessionId, taskId]);
      if (messages.changes !== 1) throw new ChatConflictError("Queued input can no longer be edited");
      return this.queuedTaskResponse(this.ctx.tasks().getTask(taskId)!);
    })();
    this.ctx.emitChatEvent(this.getChatSession(chatSessionId)!, "chat:queue_updated", {});
    return result;
  }

  removeQueuedChatTasks(chatSessionId: string, taskId?: string): void {
    const childStatusChangesQ: import("./tasks-repo.js").ChildStatusChangeCollector = [];
    const deferredEventsQ = createCommitEventQueue();
    const cancelled = this.ctx.db.transaction(() => {
      this.lockActiveSession(chatSessionId);
      const tasks = taskId ? [this.requireQueuedTask(chatSessionId, taskId)]
        : this.pendingTasks(chatSessionId).slice(1).filter((task) => task.status === "queued" && !task.wakeSource);
      return tasks.map((task) => {
        const result = this.ctx.tasks().cancelTaskWithinTransaction(task.id, childStatusChangesQ, deferredEventsQ);
        this.ctx.db.run(`UPDATE multiremi_attachments SET chat_message_id = NULL WHERE chat_message_id IN
          (SELECT id FROM multiremi_chat_messages WHERE chat_session_id = ? AND task_id = ? AND role = 'user')`, [chatSessionId, task.id]);
        this.ctx.db.run("DELETE FROM multiremi_chat_messages WHERE chat_session_id = ? AND task_id = ? AND role = 'user'", [chatSessionId, task.id]);
        return result;
      });
    })();
    for (const result of cancelled) this.ctx.tasks().notifyCancelledTask(result);
    this.ctx.tasks().runCollectedChildStatusChanges(childStatusChangesQ);
    this.ctx.emitCommitEvents(deferredEventsQ);
    this.ctx.emitChatEvent(this.getChatSession(chatSessionId)!, "chat:queue_updated", {});
  }

  prioritizeQueuedChatTask(chatSessionId: string, taskId: string): { task_id: string; active_task_id: string | null } {
    const childStatusChangesP: import("./tasks-repo.js").ChildStatusChangeCollector = [];
    const deferredEventsP = createCommitEventQueue();
    const result = this.ctx.db.transaction(() => {
      this.lockActiveSession(chatSessionId);
      this.requireQueuedTask(chatSessionId, taskId);
      const pending = this.pendingTasks(chatSessionId);
      // A retry is still the current logical turn even while waiting to claim.
      // Interrupt it instead of moving its already-executed input into the queue.
      const active = pending.find((task) => task.status !== "queued")
        ?? (pending[0]?.attempt > 1 ? pending[0] : undefined);
      const priority = Math.max(0, ...pending.map((task) => task.priority)) + 1;
      this.ctx.db.run("UPDATE multiremi_tasks SET priority = ?, updated_at = ? WHERE id = ? AND status = 'queued'", [priority, nowIso(), taskId]);
      const cancelled = active ? this.ctx.tasks().cancelTaskWithinTransaction(active.id, childStatusChangesP, deferredEventsP) : null;
      return { cancelled, activeTaskId: active?.id ?? null };
    })();
    if (result.cancelled) this.ctx.tasks().notifyCancelledTask(result.cancelled);
    this.ctx.tasks().runCollectedChildStatusChanges(childStatusChangesP);
    this.ctx.emitCommitEvents(deferredEventsP);
    this.ctx.notifyTaskEnqueued(this.ctx.tasks().getTask(taskId)!);
    this.ctx.emitChatEvent(this.getChatSession(chatSessionId)!, "chat:queue_updated", {});
    return { task_id: taskId, active_task_id: result.activeTaskId };
  }

  /**
   * The first in-flight task of every Chat the caller can list, in one statement.
   *
   * The list surface used to walk the caller's Sessions and run
   * {@link pendingTasks} per Session: on a workspace with ~200 unarchived Chats
   * that is ~400 statements per poll, plus one Agent load each. The ranking
   * below is the same expression {@link pendingTasks} orders by, applied per
   * partition, so "first pending task of a Session" keeps its exact meaning;
   * only the row that wins the partition comes back.
   *
   * The join reads `multiremi_chat_sessions` for ownership, workspace, archived
   * state and the response's tie-break order. No Chat message column is touched
   * (MUL-402 B1), and the projection carries only what a caller needs to
   * authorize and answer — the prompts and results stay in the table.
   */
  listPendingChatTaskCandidates(
    workspaceId?: string | null,
    options: { creatorId?: string | null; excludeTransportSessions?: boolean } = {},
  ): PendingChatTaskCandidate[] {
    const clauses = ["chat.status != 'archived'"];
    const params: unknown[] = [];
    if (workspaceId) {
      clauses.push("chat.workspace_id = ?");
      params.push(workspaceId);
    }
    if (options.creatorId) {
      clauses.push("chat.creator_id = ?");
      params.push(options.creatorId);
    }
    if (options.excludeTransportSessions) {
      clauses.push(
        "NOT EXISTS (SELECT 1 FROM multiremi_feishu_bot_chat_bindings binding"
        + " WHERE binding.chat_session_id = chat.id)",
      );
    }
    const statuses = PENDING_CHAT_TASK_STATUSES.map(() => "?").join(", ");
    const rows = this.ctx.db.query(
      `WITH ranked_pending AS (
         SELECT task.id AS task_id,
                task.status AS status,
                task.chat_session_id AS chat_session_id,
                task.created_at AS task_created_at,
                chat.agent_id AS session_agent_id,
                chat.workspace_id AS session_workspace_id,
                chat.pinned AS session_pinned,
                chat.updated_at AS session_updated_at,
                ROW_NUMBER() OVER (
                  PARTITION BY task.chat_session_id
                  ORDER BY CASE WHEN task.status = 'queued' THEN 1 ELSE 0 END,
                           task.priority DESC,
                           task.chat_queue_order ASC,
                           task.created_at ASC,
                           task.id ASC
                ) AS pending_rank
         FROM multiremi_tasks task
         JOIN multiremi_chat_sessions chat ON chat.id = task.chat_session_id
         WHERE ${clauses.join(" AND ")}
           AND task.status IN (${statuses})
       )
       SELECT task_id, status, chat_session_id, session_agent_id, session_workspace_id
       FROM ranked_pending
       WHERE pending_rank = 1
       ORDER BY task_created_at DESC, session_pinned DESC, session_updated_at DESC, chat_session_id ASC`,
    ).all(...params, ...PENDING_CHAT_TASK_STATUSES) as Row[];
    return rows.map((row) => ({
      taskId: String(row.task_id),
      status: String(row.status) as MultiremiTask["status"],
      chatSessionId: String(row.chat_session_id),
      sessionAgentId: String(row.session_agent_id),
      sessionWorkspaceId: String(row.session_workspace_id ?? "local"),
    }));
  }

  /**
   * Full task rows for the first in-flight task of each of the caller's Chats.
   *
   * Same set and order as the old per-Session walk; the rows come back in one
   * `IN (…)` hydration instead of one statement per Session.
   */
  listPendingChatTasks(workspaceId?: string | null, options: { creatorId?: string | null } = {}): MultiremiTask[] {
    const candidates = this.listPendingChatTaskCandidates(workspaceId, options);
    if (!candidates.length) return [];
    return this.ctx.tasks().hydrateTasksByIds(candidates.map((candidate) => candidate.taskId));
  }

  listChatMessages(chatSessionId: string): MultiremiChatMessage[] {
    if (!this.getChatSession(chatSessionId)) throw new Error(`Chat session not found: ${chatSessionId}`);
    const rows = this.ctx.db.query(
      "SELECT * FROM multiremi_chat_messages WHERE chat_session_id = ? ORDER BY sequence ASC, id ASC",
    ).all(chatSessionId) as Row[];
    return rows.map(toChatMessage);
  }

  listChatMessagesFromLog(chatSessionId: string): MultiremiChatMessage[] {
    if (!this.getChatSession(chatSessionId)) throw new Error(`Chat session not found: ${chatSessionId}`);
    const rows = this.ctx.db.query(
      `SELECT message.*, log.seq AS cursor_seq FROM multiremi_conversation_log log
       JOIN multiremi_chat_messages message ON message.chat_session_id = log.session_id AND message.sequence = log.seq
       WHERE log.session_id = ? AND log.seq >= 1 AND log.visibility = 'shown' AND log.deleted_at IS NULL
       UNION ALL
       SELECT message.*, message.sequence AS cursor_seq FROM multiremi_chat_messages message
       WHERE message.chat_session_id = ? AND NOT EXISTS (
         SELECT 1 FROM multiremi_conversation_log log WHERE log.session_id = message.chat_session_id AND log.seq = message.sequence
       )
       ORDER BY cursor_seq ASC`,
    ).all(chatSessionId, chatSessionId) as Row[];
    return rows.map(toChatMessage);
  }

  listChatMessagesPageFromLog(chatSessionId: string, limit: number, beforeId?: string | null, beforeCreatedAt?: string | null): {
    messages: MultiremiChatMessage[];
    hasMore: boolean;
  } | null {
    if (!this.getChatSession(chatSessionId)) throw new Error(`Chat session not found: ${chatSessionId}`);
    const sequence = this.ctx.db.query(
      "SELECT message_sequence FROM multiremi_chat_sessions WHERE id = ?",
    ).get(chatSessionId) as { message_sequence: number };
    let anchor = Math.max(this.ctx.conversationLog().getConversationLogHead(chatSessionId)?.headSeq ?? 0, Number(sequence.message_sequence));
    if (beforeId && beforeCreatedAt) {
      const cursor = this.ctx.db.query(
        "SELECT sequence, created_at FROM multiremi_chat_messages WHERE id = ? AND chat_session_id = ?",
      ).get(beforeId, chatSessionId) as { sequence: number; created_at: string } | null;
      if (!cursor || cursor.created_at !== beforeCreatedAt) return null;
      anchor = Number(cursor.sequence) - 1;
    }
    const rows = this.ctx.db.query(
      `SELECT message.*, log.seq AS cursor_seq FROM multiremi_conversation_log log
       JOIN multiremi_chat_messages message ON message.chat_session_id = log.session_id AND message.sequence = log.seq
       WHERE log.session_id = ? AND log.seq >= 1 AND log.seq <= ?
         AND log.visibility = 'shown' AND log.deleted_at IS NULL
       UNION ALL
       SELECT message.*, message.sequence AS cursor_seq FROM multiremi_chat_messages message
       WHERE message.chat_session_id = ? AND message.sequence <= ? AND NOT EXISTS (
         SELECT 1 FROM multiremi_conversation_log log WHERE log.session_id = message.chat_session_id AND log.seq = message.sequence
       )
       ORDER BY cursor_seq DESC LIMIT ?`,
    ).all(chatSessionId, anchor, chatSessionId, anchor, limit + 1) as Row[];
    const hasMore = rows.length > limit;
    return { messages: rows.slice(0, limit).reverse().map(toChatMessage), hasMore };
  }

  appendChatMessageWithinTransaction(input: {
    id?: string;
    chatSessionId: string;
    taskId?: string | null;
    role: MultiremiChatMessage["role"];
    body: string;
    failureReason?: string | null;
    elapsedMs?: number | null;
    pendingAgentDelivery?: boolean;
    agentDeliveryTaskId?: string | null;
    createdAt?: string;
    /** Sender-supplied key for the optimistic message, kept in log metadata. */
    clientId?: string | null;
    metadata?: import("@multiremi/contracts/conversation-log").ConversationLogEntryMetadata;
  }): MultiremiChatMessage {
    const sequenceRow = this.ctx.db.query(
      `UPDATE multiremi_chat_sessions
       SET message_sequence = message_sequence + 1
       WHERE id = ?
       RETURNING message_sequence`,
    ).get(input.chatSessionId) as { message_sequence?: number } | null;
    if (!sequenceRow) throw new Error(`Chat session not found: ${input.chatSessionId}`);
    const id = input.id ?? createId("msg");
    this.ctx.db.run(
      `INSERT INTO multiremi_chat_messages (
        id, chat_session_id, task_id, role, body, failure_reason, elapsed_ms,
        pending_agent_delivery, agent_delivery_task_id, sequence, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.chatSessionId,
        input.taskId ?? null,
        input.role,
        input.body,
        input.failureReason ?? null,
        input.elapsedMs ?? null,
        input.pendingAgentDelivery ? 1 : 0,
        input.agentDeliveryTaskId ?? null,
        Number(sequenceRow.message_sequence),
        input.createdAt ?? nowIso(),
      ],
    );
    this.mirrorChatMessageWithinTransaction(id, input.clientId ?? null, input.metadata);
    return this.getChatMessage(id)!;
  }

  /**
   * Copy one freshly written `chat_messages` row into the conversation log at the
   * same `sequence` (MUL-426 B1). Chat seq is the message sequence, so the two
   * axes stay identical; the user-facing reads move to the log now, while the
   * agent-issue-update delivery remains on the legacy columns until B2.
   */
  private mirrorChatMessageWithinTransaction(
    messageId: string,
    clientId: string | null,
    metadata?: import("@multiremi/contracts/conversation-log").ConversationLogEntryMetadata,
  ): void {
    const row = this.ctx.db.query(
      "SELECT * FROM multiremi_chat_messages WHERE id = ?",
    ).get(messageId) as Row | null;
    if (!row) return;
    const session = this.getChatSession(String(row.chat_session_id));
    if (!session) return;
    const raw = { ...row, client_id: clientId } as unknown as MirrorChatMessageRow;
    const mapped = chatMessageToConversationLog(raw, session);
    this.ctx.conversationLog().appendWithinTransaction({
      sessionId: mapped.sessionId,
      seq: mapped.seq,
      id: mapped.id,
      kind: mapped.kind,
      authorType: mapped.authorType,
      authorId: mapped.authorId,
      taskId: mapped.taskId,
      bodyMd: mapped.bodyMd,
      metadata: { ...mapped.metadata, ...metadata },
      createdAt: mapped.createdAt,
    });
  }

  buildTaskSessionProjection(taskId: string): MultiremiSessionProjection | null {
    return this.ctx.db.transaction(() => {
      const task = this.ctx.tasks().getTask(taskId);
      if (!task?.chatSessionId) return null;
      const topicIssueId = this.ctx.feishuBot().getFeishuIssueIdForChatSession(task.chatSessionId);
      if (task.issueSessionId && topicIssueId) return null;
      const session = this.getChatSession(task.chatSessionId);
      if (!session) return null;
      const agent = this.ctx.agents().getAgent(task.agentId);
      const currentLineageTaskIds = chatTaskLineageIds(this.ctx, task);
      const entries = this.ctx.conversationLog().listConversationLogEntries(session.id);
      const messages = entries
        .filter((entry) => entry.kind !== "head" && entry.deleted_at === null)
        .map((entry) => ({ ...conversationLogChatMessage(entry), seq: entry.seq, metadata: entry.metadata })).filter((message) => {
        if (message.role !== "user" || !message.taskId || currentLineageTaskIds.has(message.taskId)) return true;
        const source = this.ctx.tasks().getTask(message.taskId);
        return source?.status !== "queued";
      });
      const events = chatMessagesAsSessionEvents(messages, session, task.id, currentLineageTaskIds);
      const entriesBySeq = new Map(entries.map((entry) => [entry.seq, entry]));
      const expandableSeqs = new Set(events.filter((event) => {
        const entry = entriesBySeq.get(event.seq);
        return entry?.visibility === "shown" && entry.deleted_at === null && event.body === entry.body_md;
      }).map((event) => event.seq));
      const detachedChatIssue = (task.issueId && topicIssueId !== task.issueId)
        || (task.issueSessionId && !topicIssueId);
      // Workspace validation may reject an active lease's old directory without
      // mutating its immutable execution snapshot. Projection must use that
      // same live decision, otherwise a cold provider receives only a delta.
      const warmProviderSessionId = detachedChatIssue ? null : this.ctx.tasks().getTaskWithAgent(task.id)?.sessionId ?? null;
      const tokenBudget = resolveProjectionTokenBudget({
        provider: agent?.provider,
        model: agent?.model,
        degradeLevel: task.projectionDegradeLevel,
      });
      const projection = buildSessionProjection({
        sessionId: session.id,
        targetAgentId: task.agentId,
        events,
        expandableSeqs,
        // createTask persists session_id only when resolveTaskAffinity concluded
        // that this exact provider lineage is resumable. Stored Chat messages are
        // already in that lineage; the current request is rendered separately.
        cursorSeq: warmProviderSessionId ? events.at(-1)?.seq ?? 0 : 0,
        providerSessionId: warmProviderSessionId,
        tokenBudget,
        currentTaskId: task.id,
        resolveAuthorName: (type, id) => type === "agent" && id === agent?.id ? agent.name : null,
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
          `chat session projection truncated for task ${taskId}: omitted=${projection.omittedEvents} `
          + `estimated_tokens=${projection.estimatedTokens} budget=${tokenBudget} `
          + `degrade_level=${task.projectionDegradeLevel}`,
        );
      }
      return projection;
    })();
  }

  sendChatMessage(chatSessionId: string, input: SendChatMessageInput): SendChatMessageResult {
    const childStatusChanges: import("./tasks-repo.js").ChildStatusChangeCollector = [];
    const deferredEvents = createCommitEventQueue();
    const result = this.ctx.db.transaction(() => {
      const session = this.lockActiveSession(chatSessionId);
      const body = (input.body ?? input.content)?.trim();
      if (!body) throw new Error("Chat message body is required");
      const queued = this.getPendingChatTask(session.id) != null;
      const now = nowIso();
      const messageId = createId("msg");
      const task = this.ctx.tasks().createTaskWithinTransaction({
        agentId: session.agentId,
        chatSessionId: session.id,
        // Issue ownership belongs to the Feishu transport binding, never Chat.
        issueId: this.ctx.feishuBot().getFeishuIssueIdForChatSession(session.id),
        workspaceId: session.workspaceId,
        holdsWorkspace: false,
        prompt: body,
        // Same authoritative-camelCase read as the other task-creation paths.
        parentTaskId: resolveCamelOrSnakeString(input, "parentTaskId", "parent_task_id"),
      }, childStatusChanges, deferredEvents);
      this.appendChatMessageWithinTransaction({
        id: messageId,
        chatSessionId: session.id,
        taskId: task.id,
        role: "user",
        body,
        clientId: input.client_id,
        createdAt: now,
      });
      const attachmentIds = input.attachmentIds ?? input.attachment_ids ?? [];
      if (attachmentIds.length) {
        this.ctx.issues().linkAttachmentsToChatMessage(session.id, messageId, attachmentIds);
        const linked = this.ctx.db.query("SELECT COUNT(*) AS count FROM multiremi_attachments WHERE chat_message_id = ?").get(messageId) as Row;
        if (Number(linked.count) !== new Set(attachmentIds).size) throw new ChatValidationError("Attachments must be unlinked uploads belonging to this chat");
      }
      this.ctx.db.run(
        "UPDATE multiremi_chat_sessions SET latest_task_id = ?, updated_at = ? WHERE id = ?",
        [task.id, now, session.id],
      );
      return { session: this.getChatSession(session.id)!, message: this.getChatMessage(messageId)!, task, queued };
    })();
    this.ctx.notifyTaskEnqueued(result.task);
    this.ctx.tasks().runCollectedChildStatusChanges(childStatusChanges);
    this.ctx.emitCommitEvents(deferredEvents);
    this.ctx.emitChatEvent(result.session, "chat:message", {
      message_id: result.message.id,
      role: "user",
      content: result.message.body,
      task_id: result.task.id,
      created_at: result.message.createdAt,
    });
    return result;
  }

  private lockActiveSession(chatSessionId: string): MultiremiChatSession {
    const initial = this.getChatSession(chatSessionId);
    if (!initial) throw new Error(`Chat session not found: ${chatSessionId}`);
    this.ctx.lockWorkspaceRuntimeLifecycle(initial.workspaceId);
    const session = this.getChatSession(chatSessionId);
    if (!session || session.status === "archived") throw new ChatConflictError("Chat session is archived");
    return session;
  }

  /** Caller owns the transaction and publishes the chat event after commit. */
  createPendingAgentIssueUpdateWithinTransaction(
    chatSessionId: string,
    bodyInput: string,
    options: { id?: string; metadata?: import("@multiremi/contracts/conversation-log").ConversationLogEntryMetadata } = {},
  ): PendingAgentIssueUpdateWriteResult {
    const session = this.getChatSession(chatSessionId);
    if (!session) throw new Error(`Chat session not found: ${chatSessionId}`);
    if (session.status === "archived") throw new Error(`Chat session is archived: ${chatSessionId}`);
    const body = options.metadata?.envelope ? bodyInput : bodyInput.trim();
    if (!body.trim()) throw new Error("Chat message body is required");
    const now = nowIso();
    const message = this.appendChatMessageWithinTransaction({
      id: options.id,
      chatSessionId: session.id,
      role: "system",
      body,
      pendingAgentDelivery: true,
      createdAt: now,
      metadata: options.metadata,
    });
    this.ctx.db.run(
      `UPDATE multiremi_chat_sessions
       SET unread_since = COALESCE(unread_since, ?), updated_at = ?
       WHERE id = ?`,
      [now, now, session.id],
    );
    return {
      session: this.getChatSession(session.id)!,
      message,
    };
  }

  preparePendingAgentIssueUpdatesForTask(
    chatSessionId: string,
    taskId: string,
    limit = AGENT_ISSUE_UPDATE_PROMPT_LIMIT,
  ): PendingAgentIssueUpdateBatch {
    return this.ctx.db.transaction(() =>
      this.preparePendingAgentIssueUpdatesForTaskWithinTransaction(chatSessionId, taskId, limit)
    )();
  }

  preparePendingAgentIssueUpdatesForTaskWithinTransaction(
    chatSessionId: string,
    taskId: string,
    limit = AGENT_ISSUE_UPDATE_PROMPT_LIMIT,
  ): PendingAgentIssueUpdateBatch {
    const safeLimit = Math.max(1, Math.floor(limit));
    const rows = this.ctx.conversationLog().listConversationLogEntries(chatSessionId).filter((entry) =>
      entry.kind === "message" && entry.author_type === "system" && entry.deleted_at === null
      && entry.metadata.pending_agent_delivery === true);
    if (!rows.length) return { messages: [], omittedCount: 0 };
    this.ctx.db.run(
      `UPDATE multiremi_chat_messages
       SET agent_delivery_task_id = ?
       WHERE chat_session_id = ? AND pending_agent_delivery = 1`,
      [taskId, chatSessionId],
    );
    this.patchPendingDeliveryLog(rows, true, taskId);
    const selected = rows.slice(-safeLimit);
    return {
      messages: selected.map(conversationLogChatMessage),
      omittedCount: rows.length - selected.length,
    };
  }

  completePendingAgentIssueUpdatesForTaskWithinTransaction(chatSessionId: string, taskId: string): number {
    const rows = this.ctx.conversationLog().listConversationLogEntries(chatSessionId).filter((entry) =>
      entry.kind === "message" && entry.author_type === "system" && entry.deleted_at === null
      && entry.metadata.pending_agent_delivery === true && entry.metadata.agent_delivery_task_id === taskId);
    const changes = this.ctx.db.run(
      `UPDATE multiremi_chat_messages
       SET pending_agent_delivery = 0, agent_delivery_task_id = NULL
       WHERE chat_session_id = ? AND pending_agent_delivery = 1 AND agent_delivery_task_id = ?`,
      [chatSessionId, taskId],
    ).changes;
    this.patchPendingDeliveryLog(rows, false, null);
    return changes;
  }

  discardPendingAgentIssueUpdatesWithinTransaction(chatSessionId: string): number {
    const rows = this.ctx.conversationLog().listConversationLogEntries(chatSessionId).filter((entry) =>
      entry.kind === "message" && entry.author_type === "system" && entry.deleted_at === null
      && entry.metadata.pending_agent_delivery === true);
    const changes = this.ctx.db.run(
      `UPDATE multiremi_chat_messages
       SET pending_agent_delivery = 0, agent_delivery_task_id = NULL
       WHERE chat_session_id = ? AND pending_agent_delivery = 1`,
      [chatSessionId],
    ).changes;
    this.patchPendingDeliveryLog(rows, false, null);
    return changes;
  }

  private patchPendingDeliveryLog(rows: Array<{ id: string }>, pending: boolean, taskId: string | null): void {
    for (const row of rows) {
      const entry = this.ctx.conversationLog().getConversationLogEntryById(String(row.id));
      if (!entry) continue; // Legacy messages are backfilled by MUL-427.
      this.ctx.conversationLog().updateWithinTransaction(entry.session_id, entry.seq, {
        fields: { metadata: {
          ...entry.metadata,
          pending_agent_delivery: pending,
          agent_delivery_task_id: taskId,
        } },
      });
    }
  }

  getChatMessage(id: string): MultiremiChatMessage | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_chat_messages WHERE id = ?").get(id) as Row | null;
    return row ? toChatMessage(row) : null;
  }


}

function chatTaskLineageIds(ctx: StoreContext, task: MultiremiTask): Set<string> {
  const ids = new Set<string>();
  let current: MultiremiTask | null = task;
  while (
    current?.chatSessionId === task.chatSessionId
    && current.prompt.trim() === task.prompt.trim()
    && !ids.has(current.id)
  ) {
    ids.add(current.id);
    current = current.parentTaskId ? ctx.tasks().getTask(current.parentTaskId) : null;
  }
  return ids;
}

function chatMessagesAsSessionEvents(
  messages: Array<MultiremiChatMessage & { seq: number; metadata: Record<string, unknown> }>,
  session: MultiremiChatSession,
  currentTaskId: string,
  currentLineageTaskIds: Set<string>,
): MultiremiSessionEvent[] {
  return messages.map((message) => {
    const currentRequest = message.role === "user"
      && !!message.taskId
      && currentLineageTaskIds.has(message.taskId);
    const authorType = message.role === "assistant"
      ? "agent"
      : message.role === "user"
        ? "member"
        : "system";
    return {
      id: message.id,
      sessionId: session.id,
      seq: message.seq,
      authorType,
      authorId: message.role === "assistant"
        ? session.agentId
        : message.role === "user"
          ? session.creatorId
          : null,
      kind: message.role === "user" ? "turn" : `chat_${message.role}`,
      body: message.body,
      taskId: currentRequest ? currentTaskId : message.taskId,
      sourceCommentId: null,
      metadata: { role: message.role, ...(message.metadata.envelope ? { envelope: message.metadata.envelope } : {}) },
      createdAt: message.createdAt,
    };
  });
}

function toChatSession(row: Row): MultiremiChatSession {
  return {
    runtimeWorkspaceId: nullableString(row.runtime_workspace_id),
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    creatorId: nullableString(row.creator_id) ?? "local",
    agentId: String(row.agent_id),
    projectId: nullableString(row.project_id),
    title: String(row.title ?? ""),
    status: String(row.status ?? "active") as MultiremiChatSession["status"],
    sessionId: nullableString(row.session_id),
    workDir: nullableString(row.work_dir),
    sessionRuntimeId: nullableString(row.session_runtime_id),
    sessionProvider: nullableString(row.session_provider),
    sessionExecutionFingerprint: nullableString(row.session_execution_fingerprint),
    latestTaskId: nullableString(row.latest_task_id),
    unreadSince: nullableString(row.unread_since),
    hasUnread: Boolean(row.unread_since),
    pinned: Number(row.pinned ?? 0) === 1,
    unreadCount: Number(row.unread_count ?? 0),
    lastMessage: row.last_message_created_at == null ? null : {
      content: String(row.last_message_content ?? ""),
      role: String(row.last_message_role) as MultiremiChatMessage["role"],
      createdAt: String(row.last_message_created_at),
    },
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toChatMessage(row: Row): MultiremiChatMessage {
  return {
    id: String(row.id),
    chatSessionId: String(row.chat_session_id),
    taskId: nullableString(row.task_id),
    role: String(row.role ?? "system") as MultiremiChatMessage["role"],
    body: String(row.body ?? ""),
    failureReason: nullableString(row.failure_reason),
    elapsedMs: row.elapsed_ms == null ? null : Number(row.elapsed_ms),
    createdAt: String(row.created_at),
  };
}
