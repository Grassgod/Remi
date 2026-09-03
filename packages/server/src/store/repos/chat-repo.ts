// Chat domain (chat sessions and chat messages), extracted verbatim from MultiremiStore
// (the facade delegates every public method here).
import { createId, nowIso } from "@multiremi/ids.js";
import { cleanOptionalString, isActiveTaskStatus, nullableString } from "@multiremi/store/helpers.js";
import { type StoreContext } from "@multiremi/store/context.js";
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

const log = createLogger("multiremi-store");

export const CHAT_BOOTSTRAP_MAX_MESSAGES = 64;
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
    const agentId = input.agentId ?? input.agent_id;
    if (!agentId) throw new Error("agent_id is required");
    const agent = this.ctx.agents().getAgent(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    if (agent.archivedAt) throw new Error(`Agent is archived: ${agentId}`);
    const workspaceId = input.workspaceId ?? input.workspace_id ?? "local";
    if (agent.workspaceId !== workspaceId) throw new Error("Agent belongs to another workspace");
    const issueId = cleanOptionalString(input.issueId ?? input.issue_id);
    const issue = issueId ? this.ctx.issues().getIssue(issueId) : null;
    if (issueId && !issue) throw new Error(`Issue not found: ${issueId}`);
    if (issue && issue.workspaceId !== workspaceId) throw new Error("Issue belongs to another workspace");
    const id = input.id ?? createId("chat");
    const now = nowIso();
    const title = input.title?.trim() || `Chat with ${agent.name}`;
    this.ctx.db.run(
      `INSERT INTO multiremi_chat_sessions (
        id, workspace_id, creator_id, agent_id, issue_id, title, status, session_id, work_dir, latest_task_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', NULL, NULL, NULL, ?, ?)`,
      [id, workspaceId, input.creatorId ?? input.creator_id ?? "local", agentId, issue?.id ?? null, title, now, now],
    );
    return this.getChatSession(id)!;
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
    const rows = this.ctx.db.query(`SELECT * FROM multiremi_chat_sessions ${where} ORDER BY updated_at DESC`).all(...params) as Row[];
    return rows.map(toChatSession);
  }

  getChatSession(id: string): MultiremiChatSession | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_chat_sessions WHERE id = ?").get(id) as Row | null;
    return row ? toChatSession(row) : null;
  }

  updateChatSession(id: string, input: UpdateChatSessionInput): MultiremiChatSession {
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
    this.ctx.db.run(
      `UPDATE multiremi_chat_sessions
       SET title = ?, status = ?, issue_id = ?, updated_at = ?
       WHERE id = ?`,
      [input.title?.trim() || current.title, input.status ?? current.status, issue?.id ?? null, now, id],
    );
    const updated = this.getChatSession(id)!;
    this.ctx.emitChatEvent(updated, "chat:session_updated", {
      title: updated.title,
      issue_id: updated.issueId,
      updated_at: updated.updatedAt,
    });
    return updated;
  }

  deleteChatSession(id: string): boolean {
    const current = this.getChatSession(id);
    if (!current) return false;
    for (const task of this.ctx.tasks().listTasks().filter((task) => task.chatSessionId === id)) {
      if (isActiveTaskStatus(task.status)) {
        this.ctx.tasks().cancelTask(task.id);
      }
    }
    this.ctx.db.run("UPDATE multiremi_tasks SET chat_session_id = NULL WHERE chat_session_id = ?", [id]);
    this.ctx.db.run("DELETE FROM multiremi_attachments WHERE chat_session_id = ?", [id]);
    this.ctx.db.run("DELETE FROM multiremi_chat_messages WHERE chat_session_id = ?", [id]);
    const result = this.ctx.db.run("DELETE FROM multiremi_chat_sessions WHERE id = ?", [id]);
    if (result.changes > 0) {
      this.ctx.emitChatEvent(current, "chat:session_deleted", {});
    }
    return result.changes > 0;
  }

  markChatSessionRead(id: string): void {
    const session = this.getChatSession(id);
    if (!session) throw new Error(`Chat session not found: ${id}`);
    this.ctx.db.run("UPDATE multiremi_chat_sessions SET unread_since = NULL WHERE id = ?", [id]);
    this.ctx.emitChatEvent(session, "chat:session_read", {});
  }

  getPendingChatTask(chatSessionId: string): MultiremiTask | null {
    if (!this.getChatSession(chatSessionId)) throw new Error(`Chat session not found: ${chatSessionId}`);
    return this.ctx.tasks().listTasks()
      .filter((task) =>
        task.chatSessionId === chatSessionId &&
        isActiveTaskStatus(task.status)
      )
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] ?? null;
  }

  listPendingChatTasks(workspaceId?: string | null, options: { creatorId?: string | null } = {}): MultiremiTask[] {
    return this.ctx.tasks().listTasks()
      .filter((task) =>
        task.chatSessionId &&
        (workspaceId ? task.workspaceId === workspaceId : true) &&
        (options.creatorId ? this.getChatSession(task.chatSessionId)?.creatorId === options.creatorId : true) &&
        isActiveTaskStatus(task.status)
      )
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  }

  listChatMessages(chatSessionId: string): MultiremiChatMessage[] {
    if (!this.getChatSession(chatSessionId)) throw new Error(`Chat session not found: ${chatSessionId}`);
    const rows = this.ctx.db.query(
      "SELECT * FROM multiremi_chat_messages WHERE chat_session_id = ? ORDER BY created_at ASC, rowid ASC",
    ).all(chatSessionId) as Row[];
    return rows.map(toChatMessage);
  }

  buildTaskSessionProjection(taskId: string): MultiremiSessionProjection | null {
    return this.ctx.db.transaction(() => {
      const task = this.ctx.tasks().getTask(taskId);
      if (!task?.chatSessionId || task.issueSessionId) return null;
      const session = this.getChatSession(task.chatSessionId);
      if (!session) return null;
      const agent = this.ctx.agents().getAgent(task.agentId);
      const messages = this.listChatMessages(session.id);
      const currentLineageTaskIds = chatTaskLineageIds(this.ctx, task);
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
    const session = this.getChatSession(chatSessionId);
    if (!session) throw new Error(`Chat session not found: ${chatSessionId}`);
    if (session.status === "archived") throw new Error(`Chat session is archived: ${chatSessionId}`);
    const body = (input.body ?? input.content)?.trim();
    if (!body) throw new Error("Chat message body is required");
    const now = nowIso();
    const messageId = createId("msg");
    const task = this.ctx.tasks().createTask({
      agentId: session.agentId,
      chatSessionId: session.id,
      workspaceId: session.workspaceId,
      prompt: body,
      sessionId: session.sessionId,
      workDir: session.workDir,
      parentTaskId: input.parentTaskId ?? input.parent_task_id ?? null,
    });
    this.ctx.db.run(
      `INSERT INTO multiremi_chat_messages (id, chat_session_id, task_id, role, body, created_at)
       VALUES (?, ?, ?, 'user', ?, ?)`,
      [messageId, session.id, task.id, body, now],
    );
    const attachmentIds = input.attachmentIds ?? input.attachment_ids ?? [];
    if (attachmentIds.length) this.ctx.issues().linkAttachmentsToChatMessage(session.id, messageId, attachmentIds);
    this.ctx.db.run(
      "UPDATE multiremi_chat_sessions SET latest_task_id = ?, updated_at = ? WHERE id = ?",
      [task.id, now, session.id],
    );
    const result = {
      session: this.getChatSession(session.id)!,
      message: this.getChatMessage(messageId)!,
      task,
    };
    this.ctx.emitChatEvent(result.session, "chat:message", {
      message_id: result.message.id,
      role: "user",
      content: body,
      task_id: task.id,
      created_at: result.message.createdAt,
    });
    return result;
  }

  /** Caller owns the transaction and publishes the task/chat event after commit. */
  createSystemChatMessageWithinTransaction(chatSessionId: string, bodyInput: string): SendChatMessageResult {
    const session = this.getChatSession(chatSessionId);
    if (!session) throw new Error(`Chat session not found: ${chatSessionId}`);
    if (session.status === "archived") throw new Error(`Chat session is archived: ${chatSessionId}`);
    const body = bodyInput.trim();
    if (!body) throw new Error("Chat message body is required");
    const now = nowIso();
    const messageId = createId("msg");
    const task = this.ctx.tasks().createTaskWithinTransaction({
      agentId: session.agentId,
      chatSessionId: session.id,
      workspaceId: session.workspaceId,
      prompt: body,
      sessionId: session.sessionId,
      workDir: session.workDir,
    });
    this.ctx.db.run(
      `INSERT INTO multiremi_chat_messages (id, chat_session_id, task_id, role, body, created_at)
       VALUES (?, ?, ?, 'system', ?, ?)`,
      [messageId, session.id, task.id, body, now],
    );
    this.ctx.db.run(
      "UPDATE multiremi_chat_sessions SET latest_task_id = ?, updated_at = ? WHERE id = ?",
      [task.id, now, session.id],
    );
    return {
      session: this.getChatSession(session.id)!,
      message: this.getChatMessage(messageId)!,
      task,
    };
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
