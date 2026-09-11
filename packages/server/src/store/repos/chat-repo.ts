// Chat domain (chat sessions and chat messages), extracted verbatim from MultiremiStore
// (the facade delegates every public method here).
import { createId, nowIso } from "@multiremi/ids.js";
import { cleanOptionalString, nullableString } from "@multiremi/store/helpers.js";
import { type StoreContext } from "@multiremi/store/context.js";
import type { CancelTaskResult } from "./tasks-repo.js";
import { buildSessionProjection } from "@multiremi/store/session-projection.js";
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

export const CHAT_BOOTSTRAP_MAX_MESSAGES = 64;
export const AGENT_ISSUE_UPDATE_PROMPT_LIMIT = 12;

export interface PendingAgentIssueUpdateWriteResult {
  session: MultiremiChatSession;
  message: MultiremiChatMessage;
}

export interface PendingAgentIssueUpdateBatch {
  messages: MultiremiChatMessage[];
  omittedCount: number;
}
export const CHAT_BOOTSTRAP_MAX_BYTES = 64 * 1024;
export const CHAT_BOOTSTRAP_OMITTED_NOTICE = "[Earlier product chat history omitted.]";
const CHAT_BOOTSTRAP_TRUNCATED_NOTICE = "[Message truncated.]";

export interface ChatBootstrapTranscript {
  transcript: string;
  includedMessages: number;
  totalMessages: number;
  omitted: boolean;
}

export function buildChatBootstrapTranscript(
  messages: readonly MultiremiChatMessage[],
): ChatBootstrapTranscript {
  const entries = messages.flatMap((message) => {
    const body = message.body.trim();
    return body ? [`[${message.role}]\n${body}`] : [];
  });
  const noticeBytes = utf8Bytes(`${CHAT_BOOTSTRAP_OMITTED_NOTICE}\n\n`);
  const separatorBytes = utf8Bytes("\n\n");
  const selected: string[] = [];
  let selectedBytes = 0;
  let omitted = false;

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (selected.length >= CHAT_BOOTSTRAP_MAX_MESSAGES) {
      omitted = true;
      break;
    }
    const separator = selected.length ? separatorBytes : 0;
    const available = CHAT_BOOTSTRAP_MAX_BYTES - noticeBytes - selectedBytes - separator;
    const entry = entries[index]!;
    const entryBytes = utf8Bytes(entry);
    if (entryBytes <= available) {
      selected.unshift(entry);
      selectedBytes += separator + entryBytes;
      continue;
    }
    omitted = true;
    if (!selected.length) {
      const suffix = `\n${CHAT_BOOTSTRAP_TRUNCATED_NOTICE}`;
      const body = truncateUtf8(entry, Math.max(0, available - utf8Bytes(suffix)));
      selected.unshift(`${body}${suffix}`);
    }
    break;
  }

  if (selected.length < entries.length) omitted = true;
  const body = selected.join("\n\n");
  const transcript = omitted && body
    ? `${CHAT_BOOTSTRAP_OMITTED_NOTICE}\n\n${body}`
    : omitted
      ? CHAT_BOOTSTRAP_OMITTED_NOTICE
      : body;
  return {
    transcript,
    includedMessages: selected.length,
    totalMessages: entries.length,
    omitted,
  };
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  let end = Math.min(maxBytes, bytes.byteLength);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(bytes.slice(0, end)).trimEnd();
}

export class ChatRepo {
  constructor(private ctx: StoreContext) {}

  createChatSession(input: CreateChatSessionInput): MultiremiChatSession {
    return this.ctx.db.transaction(() => this.createChatSessionWithinTransaction(input))();
  }

  /** Caller owns the transaction, including any accompanying Chat binding. */
  createChatSessionWithinTransaction(input: CreateChatSessionInput): MultiremiChatSession {
    const workspaceId = input.workspaceId ?? input.workspace_id ?? "local";
    this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
    const agentId = input.agentId ?? input.agent_id;
    if (!agentId) throw new Error("agent_id is required");
    const agent = this.ctx.agents().getAgent(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    if (agent.archivedAt) throw new Error(`Agent is archived: ${agentId}`);
    if (agent.workspaceId !== workspaceId) throw new Error("Agent belongs to another workspace");
    const issueId = cleanOptionalString(input.issueId ?? input.issue_id);
    const issue = issueId ? this.ctx.issues().getIssue(issueId) : null;
    if (issueId && !issue) throw new Error(`Issue not found: ${issueId}`);
    if (issue && issue.workspaceId !== workspaceId) throw new Error("Issue belongs to another workspace");
    const id = input.id ?? createId("chat");
    if (this.getChatSession(id) || this.ctx.db.query("SELECT id FROM multiremi_tasks WHERE chat_session_id = ? LIMIT 1").get(id)) {
      throw new ChatConflictError("Chat session id has already been used");
    }
    const now = nowIso();
    const title = input.title?.trim() || `Chat with ${agent.name}`;
    this.ctx.db.run(
      `INSERT INTO multiremi_chat_sessions (
        id, workspace_id, creator_id, agent_id, issue_id, title, status, session_id, work_dir, latest_task_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', NULL, NULL, NULL, ?, ?)`,
      [id, workspaceId, input.creatorId ?? input.creator_id ?? "local", agentId, issue?.id ?? null, title, now, now],
    );
    const session = this.getChatSession(id)!;
    if (session.issueId) this.ensureDefaultAgentIssueUpdatesChannel(session);
    return session;
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

  bindChatSessionIssueIfUnbound(chatSessionId: string, issueId: string): {
    session: MultiremiChatSession;
    bound: boolean;
  } {
    const current = this.getChatSession(chatSessionId);
    if (!current) throw new Error(`Chat session not found: ${chatSessionId}`);
    const issue = this.ctx.issues().getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    if (issue.workspaceId !== current.workspaceId) throw new Error("Issue belongs to another workspace");
    if (current.issueId) return { session: current, bound: false };

    const now = nowIso();
    const updated = this.ctx.db.run(
      `UPDATE multiremi_chat_sessions
       SET issue_id = ?, updated_at = ?
       WHERE id = ? AND issue_id IS NULL`,
      [issue.id, now, current.id],
    );
    const session = this.getChatSession(current.id)!;
    if (updated.changes === 0) return { session, bound: false };
    this.ensureDefaultAgentIssueUpdatesChannel(session);
    this.ctx.emitChatEvent(session, "chat:session_updated", {
      title: session.title,
      issue_id: session.issueId,
      updated_at: session.updatedAt,
    });
    return { session, bound: true };
  }

  updateChatSession(id: string, input: UpdateChatSessionInput): MultiremiChatSession {
    const cancelled: CancelTaskResult[] = [];
    const updated = this.ctx.db.transaction(() => {
      const initial = this.getChatSession(id);
      if (!initial) throw new Error(`Chat session not found: ${id}`);
      this.ctx.lockWorkspaceRuntimeLifecycle(initial.workspaceId);
      const current = this.getChatSession(id);
      if (!current) throw new Error(`Chat session not found: ${id}`);
      const issueFieldProvided = Object.hasOwn(input, "issueId") || Object.hasOwn(input, "issue_id");
      const requestedIssueId = issueFieldProvided
        ? cleanOptionalString(input.issueId ?? input.issue_id)
        : current.issueId;
      const issue = requestedIssueId ? this.ctx.issues().getIssue(requestedIssueId) : null;
      if (requestedIssueId && !issue) throw new Error(`Issue not found: ${requestedIssueId}`);
      if (issue && issue.workspaceId !== current.workspaceId) throw new Error("Issue belongs to another workspace");
      const now = nowIso();
      if (issueFieldProvided && requestedIssueId !== current.issueId) {
        this.ctx.db.run("DELETE FROM multiremi_agent_issue_update_state WHERE chat_session_id = ?", [id]);
        this.discardPendingAgentIssueUpdatesWithinTransaction(id);
      }
      this.ctx.db.run(
        `UPDATE multiremi_chat_sessions
         SET title = ?, status = ?, issue_id = ?, pinned = ?, updated_at = ?
         WHERE id = ?`,
        [input.title?.trim() || current.title, input.status ?? current.status, issue?.id ?? null, (input.pinned ?? current.pinned) ? 1 : 0, now, id],
      );
      if (input.status === "archived") {
        for (const task of this.pendingTasks(id)) {
          cancelled.push(this.ctx.tasks().cancelTaskWithinTransaction(task.id));
        }
        this.discardPendingAgentIssueUpdatesWithinTransaction(id);
      }
      const updated = this.getChatSession(id)!;
      if (updated.issueId && !this.ctx.notificationChannels().getAgentChatNotificationChannel(updated.id)) {
        this.ensureDefaultAgentIssueUpdatesChannel(updated);
      }
      return updated;
    })();
    for (const result of cancelled) this.ctx.tasks().notifyCancelledTask(result);
    this.ctx.emitChatEvent(updated, "chat:session_updated", {
      title: updated.title,
      status: updated.status,
      pinned: updated.pinned,
      issue_id: updated.issueId,
      updated_at: updated.updatedAt,
    });
    return updated;
  }

  deleteChatSession(id: string): boolean {
    const result = this.ctx.db.transaction(() => {
      const initial = this.getChatSession(id);
      if (!initial) return null;
      this.ctx.lockWorkspaceRuntimeLifecycle(initial.workspaceId);
      const current = this.getChatSession(id);
      if (!current) return null;
      const cancelled = this.pendingTasks(id).map((task) => this.ctx.tasks().cancelTaskWithinTransaction(task.id));
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
    return this.pendingTasks(chatSessionId).slice(1).filter((task) => task.status === "queued")
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
    const task = this.pendingTasks(chatSessionId).slice(1).find((entry) => entry.id === taskId && entry.status === "queued");
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
    const cancelled = this.ctx.db.transaction(() => {
      this.lockActiveSession(chatSessionId);
      const tasks = taskId ? [this.requireQueuedTask(chatSessionId, taskId)]
        : this.pendingTasks(chatSessionId).slice(1).filter((task) => task.status === "queued");
      return tasks.map((task) => {
        const result = this.ctx.tasks().cancelTaskWithinTransaction(task.id);
        this.ctx.db.run(`UPDATE multiremi_attachments SET chat_message_id = NULL WHERE chat_message_id IN
          (SELECT id FROM multiremi_chat_messages WHERE chat_session_id = ? AND task_id = ? AND role = 'user')`, [chatSessionId, task.id]);
        this.ctx.db.run("DELETE FROM multiremi_chat_messages WHERE chat_session_id = ? AND task_id = ? AND role = 'user'", [chatSessionId, task.id]);
        return result;
      });
    })();
    for (const result of cancelled) this.ctx.tasks().notifyCancelledTask(result);
    this.ctx.emitChatEvent(this.getChatSession(chatSessionId)!, "chat:queue_updated", {});
  }

  prioritizeQueuedChatTask(chatSessionId: string, taskId: string): { task_id: string; active_task_id: string | null } {
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
      const cancelled = active ? this.ctx.tasks().cancelTaskWithinTransaction(active.id) : null;
      return { cancelled, activeTaskId: active?.id ?? null };
    })();
    if (result.cancelled) this.ctx.tasks().notifyCancelledTask(result.cancelled);
    this.ctx.notifyTaskEnqueued(this.ctx.tasks().getTask(taskId)!);
    this.ctx.emitChatEvent(this.getChatSession(chatSessionId)!, "chat:queue_updated", {});
    return { task_id: taskId, active_task_id: result.activeTaskId };
  }

  listPendingChatTasks(workspaceId?: string | null, options: { creatorId?: string | null } = {}): MultiremiTask[] {
    return this.listChatSessions(workspaceId, { creatorId: options.creatorId })
      .map((session) => this.getPendingChatTask(session.id))
      .filter((task): task is MultiremiTask => task != null)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  }

  listChatMessages(chatSessionId: string): MultiremiChatMessage[] {
    if (!this.getChatSession(chatSessionId)) throw new Error(`Chat session not found: ${chatSessionId}`);
    const rows = this.ctx.db.query(
      "SELECT * FROM multiremi_chat_messages WHERE chat_session_id = ? ORDER BY sequence ASC, id ASC",
    ).all(chatSessionId) as Row[];
    return rows.map(toChatMessage);
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
    return this.getChatMessage(id)!;
  }

  buildTaskSessionProjection(taskId: string): MultiremiSessionProjection | null {
    return this.ctx.db.transaction(() => {
      const task = this.ctx.tasks().getTask(taskId);
      if (!task?.chatSessionId || task.issueSessionId) return null;
      const session = this.getChatSession(task.chatSessionId);
      if (!session) return null;
      const agent = this.ctx.agents().getAgent(task.agentId);
      const currentLineageTaskIds = chatTaskLineageIds(this.ctx, task);
      const messages = this.listChatMessages(session.id).filter((message) => {
        if (message.role !== "user" || !message.taskId || currentLineageTaskIds.has(message.taskId)) return true;
        const source = this.ctx.tasks().getTask(message.taskId);
        return source?.status !== "queued";
      });
      const events = chatMessagesAsSessionEvents(messages, session, task.id, currentLineageTaskIds);
      const warmProviderSessionId = task.sessionId;
      const tokenBudget = resolveProjectionTokenBudget({
        provider: agent?.provider,
        model: agent?.model,
        degradeLevel: task.projectionDegradeLevel,
      });
      const projection = buildSessionProjection({
        sessionId: session.id,
        targetAgentId: task.agentId,
        events,
        // createTask persists session_id only when resolveTaskAffinity concluded
        // that this exact provider lineage is resumable. Stored Chat messages are
        // already in that lineage; the current request is rendered separately.
        cursorSeq: warmProviderSessionId ? events.length : 0,
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
        workspaceId: session.workspaceId,
        holdsWorkspace: false,
        prompt: body,
        parentTaskId: input.parentTaskId ?? input.parent_task_id ?? null,
      });
      this.appendChatMessageWithinTransaction({
        id: messageId,
        chatSessionId: session.id,
        taskId: task.id,
        role: "user",
        body,
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
  ): PendingAgentIssueUpdateWriteResult {
    const session = this.getChatSession(chatSessionId);
    if (!session) throw new Error(`Chat session not found: ${chatSessionId}`);
    if (session.status === "archived") throw new Error(`Chat session is archived: ${chatSessionId}`);
    const body = bodyInput.trim();
    if (!body) throw new Error("Chat message body is required");
    const now = nowIso();
    const message = this.appendChatMessageWithinTransaction({
      chatSessionId: session.id,
      role: "system",
      body,
      pendingAgentDelivery: true,
      createdAt: now,
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
    const rows = this.ctx.db.query(
      `SELECT * FROM multiremi_chat_messages
       WHERE chat_session_id = ? AND pending_agent_delivery = 1
       ORDER BY sequence ASC, id ASC`,
    ).all(chatSessionId) as Row[];
    if (!rows.length) return { messages: [], omittedCount: 0 };
    this.ctx.db.run(
      `UPDATE multiremi_chat_messages
       SET agent_delivery_task_id = ?
       WHERE chat_session_id = ? AND pending_agent_delivery = 1`,
      [taskId, chatSessionId],
    );
    const selected = rows.slice(-safeLimit);
    return {
      messages: selected.map(toChatMessage),
      omittedCount: rows.length - selected.length,
    };
  }

  completePendingAgentIssueUpdatesForTaskWithinTransaction(chatSessionId: string, taskId: string): number {
    return this.ctx.db.run(
      `UPDATE multiremi_chat_messages
       SET pending_agent_delivery = 0, agent_delivery_task_id = NULL
       WHERE chat_session_id = ? AND pending_agent_delivery = 1 AND agent_delivery_task_id = ?`,
      [chatSessionId, taskId],
    ).changes;
  }

  discardPendingAgentIssueUpdatesWithinTransaction(chatSessionId: string): number {
    return this.ctx.db.run(
      `UPDATE multiremi_chat_messages
       SET pending_agent_delivery = 0, agent_delivery_task_id = NULL
       WHERE chat_session_id = ? AND pending_agent_delivery = 1`,
      [chatSessionId],
    ).changes;
  }

  getChatMessage(id: string): MultiremiChatMessage | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_chat_messages WHERE id = ?").get(id) as Row | null;
    return row ? toChatMessage(row) : null;
  }

  private ensureDefaultAgentIssueUpdatesChannel(session: MultiremiChatSession): void {
    const member = this.ctx.workspaces().findWorkspaceMemberForUser(session.creatorId, session.workspaceId);
    this.ctx.notificationChannels().upsertAgentChatNotificationChannel({
      workspaceId: session.workspaceId,
      chatSessionId: session.id,
      name: `${session.title} Issue updates`,
      enabled: true,
      memberId: member?.id ?? null,
      createdBy: session.creatorId,
    });
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
  messages: MultiremiChatMessage[],
  session: MultiremiChatSession,
  currentTaskId: string,
  currentLineageTaskIds: Set<string>,
): MultiremiSessionEvent[] {
  return messages.map((message, index) => {
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
      seq: index + 1,
      authorType,
      authorId: message.role === "assistant"
        ? session.agentId
        : message.role === "user"
          ? session.creatorId
          : null,
      kind: message.role === "user" ? "task_assigned" : `chat_${message.role}`,
      body: message.body,
      taskId: currentRequest ? currentTaskId : message.taskId,
      sourceCommentId: null,
      metadata: { role: message.role },
      createdAt: message.createdAt,
    };
  });
}

function toChatSession(row: Row): MultiremiChatSession {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    creatorId: nullableString(row.creator_id) ?? "local",
    agentId: String(row.agent_id),
    issueId: nullableString(row.issue_id),
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
