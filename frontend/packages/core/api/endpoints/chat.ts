import type { z } from "zod";
import { MessagesEndpoints } from "./messages";
import { InboxEndpoints } from "./inbox";
import { TurnDetailSchema, type TurnSchema } from "../schemas/messages";
import type {
  ChatBackgroundStopTarget,
  ChatBackgroundTask,
  ChatBackgroundTasksSnapshot,
  CreateChatSessionInput,
  ChatOriginFilter,
  ChatPendingTask,
  ChatSession,
  PendingChatTasksResponse,
  SendChatMessageResponse,
  UpdateChatSessionInput,
} from "../../types";
import type { HttpClient } from "../http";
import { ApiContractError, parseStrictResponse } from "../schema";
import {
  ChatSessionSchema, ChatSessionListSchema, ChatSessionUpdateResponseSchema, ChatNoContentSchema,
  ChatBackgroundTasksSnapshotSchema, parseChatBackgroundTasks, ChatSlashCommandsSchema,
} from "../schemas/chat";
import type { ChatSlashCommandsResponse } from "@multiremi/contracts/slash-commands";

/** Turn statuses a chat shows as in flight. */
const ACTIVE_TURN_STATUSES: readonly string[] = ["pending", "running", "awaiting_human"];

function pendingTaskOf(turn: z.infer<typeof TurnSchema>): ChatPendingTask {
  // A running turn whose attempt waits for its local folder says so, and why (PR 6 §2.8).
  const folderWait = turn.status === "running" && typeof turn.local_directory_wait_reason === "string"
    ? { status: "waiting_local_directory", wait_reason: turn.local_directory_wait_reason || null } : null;
  return { task_id: turn.current_attempt_id ?? turn.id, turn_id: turn.id,
    status: turn.status === "pending" ? "queued" : turn.status, created_at: turn.created_at, supports_queue: true, ...folderWait };
}

export class ChatEndpoints {
  constructor(readonly http: HttpClient) {}

  // Chat Sessions
  async listChatSessions(params?: { status?: string; origin?: ChatOriginFilter }): Promise<ChatSession[]> {
    const search = new URLSearchParams();
    if (params?.status) search.set("status", params.status);
    if (params?.origin) search.set("origin", params.origin);
    const query = search.toString() ? `?${search}` : "";
    const raw = await this.http.fetch<unknown>(`/api/chat/sessions${query}`);
    return parseStrictResponse<ChatSession[]>(raw, ChatSessionListSchema, { endpoint: "GET /api/chat/sessions" });
  }

  async getChatSession(id: string, options: { signal?: AbortSignal } = {}): Promise<ChatSession> {
    const raw = await this.http.fetch<unknown>(`/api/chat/sessions/${id}`, options.signal ? { signal: options.signal } : undefined);
    return parseStrictResponse<ChatSession>(raw, ChatSessionSchema, { endpoint: "GET /api/chat/sessions/:id" });
  }

  async createChatSession(data: CreateChatSessionInput): Promise<ChatSession> {
    const raw = await this.http.fetch<unknown>("/api/chat/sessions", {
      method: "POST",
      body: JSON.stringify(data),
    });
    const session = parseStrictResponse<ChatSession>(raw, ChatSessionSchema, { endpoint: "POST /api/chat/sessions" });
    if (data.runtime_workspace_id && session.runtime_workspace_id !== data.runtime_workspace_id) {
      throw new ApiContractError("POST /api/chat/sessions", "Server did not retain the selected runtime workspace");
    }
    if (data.project_id && session.project_id !== data.project_id) {
      throw new ApiContractError("POST /api/chat/sessions", "Server did not retain the selected project");
    }
    return session;
  }

  async deleteChatSession(id: string): Promise<void> {
    const raw = await this.http.fetch<unknown>(`/api/chat/sessions/${id}`, { method: "DELETE" });
    parseStrictResponse<z.infer<typeof ChatNoContentSchema>>(raw, ChatNoContentSchema, { endpoint: "DELETE /api/chat/sessions/:id" });
  }

  async updateChatSession(id: string, data: UpdateChatSessionInput): Promise<ChatSession> {
    const raw = await this.http.fetch<unknown>(`/api/chat/sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
    const session = parseStrictResponse<ChatSession>(raw, ChatSessionUpdateResponseSchema, { endpoint: "PATCH /api/chat/sessions/:id" });
    if (session.id !== id || Object.entries(data).some(([field, value]) =>
      value !== undefined && session[field as keyof UpdateChatSessionInput] !== value)) {
      throw new ApiContractError("PATCH /api/chat/sessions/:id", "Server did not retain the requested session changes");
    }
    return session;
  }

  /**
   * Sends now: a running turn takes the message as a steer (ADR 0020). The
   * wake is explicit so a different server default cannot turn a steer into
   * a deferred message; queueing goes through the follow-up queue instead.
   * It settles when the server has accepted the message; the turn it started
   * or joined is read separately (`getChatTurnPendingTask`), so a slow turn
   * read never holds the send. `signal` aborts both requests.
   */
  async sendChatMessage(sessionId: string, content: string, attachmentIds?: string[], clientId?: string,
    options: { signal?: AbortSignal } = {}): Promise<SendChatMessageResponse> {
    const session = await this.getChatSession(sessionId, options);
    const result = await new MessagesEndpoints(this.http).sendMessage(sessionId, {
      body_md: content, message_kind: "request", to: { type: "agent", ref: session.agent_id }, wake_requested: "now",
      attachment_ids: attachmentIds?.length ? attachmentIds : undefined, dedupe_key: clientId,
    }, options);
    return { message_id: result.message.id, turn_id: result.turn_id, created_at: result.message.created_at };
  }

  /** One turn as its chat's pending task; an ended turn reads as none. */
  async getChatTurnPendingTask(turnId: string): Promise<ChatPendingTask> {
    const { turn } = await new MessagesEndpoints(this.http).getTurn(turnId);
    return ACTIVE_TURN_STATUSES.includes(turn.status) ? pendingTaskOf(turn) : { supports_queue: true };
  }

  private async activeTurns(sessionId?: string) {
    const messages = new MessagesEndpoints(this.http);
    const pages = await Promise.all(ACTIVE_TURN_STATUSES.map(async status => {
      const turns = [];
      let cursor: string | undefined;
      do { const page = await messages.listTurns({ session_id: sessionId, status, cursor, limit: 100 }); turns.push(...page.turns); cursor = page.next_cursor ?? undefined; } while (cursor);
      return turns;
    }));
    return pages.flat().sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  async getPendingChatTask(sessionId: string): Promise<ChatPendingTask> {
    const turn = (await this.activeTurns(sessionId))[0];
    return turn ? pendingTaskOf(turn) : { supports_queue: true };
  }
  async listPendingChatTasks(): Promise<PendingChatTasksResponse> {
    return { tasks: (await this.activeTurns()).filter(turn => turn.session_id.startsWith("chat_"))
      .map(turn => ({ task_id: turn.current_attempt_id ?? turn.id, turn_id: turn.id, status: turn.status === "pending" ? "queued" : turn.status, chat_session_id: turn.session_id,
        ...(typeof turn.running_subagents === "number" ? { running_subagents: turn.running_subagents } : {}),
        ...(typeof turn.running_background_tasks === "number" ? { running_background_tasks: turn.running_background_tasks } : {}) })) };
  }

  /**
   * A chat's background tasks (PR 6): the running rows plus the last ended
   * ones, from the session registry. Never a trace (MUL-472).
   */
  async listChatBackgroundTasks(sessionId: string): Promise<ChatBackgroundTasksSnapshot> {
    const path = `/api/chat/sessions/${encodeURIComponent(sessionId)}/background-tasks`;
    const snapshot = parseStrictResponse<ChatBackgroundTasksSnapshot>(await this.http.fetch<unknown>(path),
      ChatBackgroundTasksSnapshotSchema, { endpoint: "GET /api/chat/sessions/:id/background-tasks" });
    if (snapshot.session_id !== sessionId) throw new ApiContractError("GET /api/chat/sessions/:id/background-tasks", "Server returned another session");
    return snapshot;
  }

  /**
   * The agent's command catalogue for the composer menu (ADR 0025): the
   * chat's own (`session_id`), or for a chat not created yet the agent's
   * preview. Blocked and hidden commands are already gone.
   */
  async getChatSlashCommands(params: { agentId: string; sessionId?: string | null }): Promise<ChatSlashCommandsResponse> {
    const search = new URLSearchParams({ agent_id: params.agentId });
    if (params.sessionId) search.set("session_id", params.sessionId);
    return parseStrictResponse<ChatSlashCommandsResponse>(await this.http.fetch<unknown>(`/api/chat/slash-commands?${search}`),
      ChatSlashCommandsSchema, { endpoint: "GET /api/chat/slash-commands" });
  }

  /**
   * Asks the chat's computer to stop one background task or all of them
   * (PR 6 §6.1). Accepted with 202 `{requested_at, rows}`: the rows it marked
   * as stopping (well-formed ones; none when the answer has no body). They
   * end when the daemon answers. A 409 says why not: `task_not_running` or
   * `runtime_offline`.
   */
  async stopChatBackgroundTasks(sessionId: string, target: ChatBackgroundStopTarget): Promise<ChatBackgroundTask[]> {
    const path = `/api/chat/sessions/${encodeURIComponent(sessionId)}/background-tasks/stop`;
    const res = await this.http.fetchRaw(path, { method: "POST", body: JSON.stringify(target), extraHeaders: { "Content-Type": "application/json" } });
    // Any 2xx accepts the stop; the marked rows are a bonus, not a contract.
    const body = await res.json().catch(() => null) as { rows?: unknown } | null;
    return parseChatBackgroundTasks(body?.rows).filter((row) => row.session_id === sessionId);
  }

  async markChatSessionRead(sessionId: string): Promise<void> {
    await new InboxEndpoints(this.http).markInboxRead({ session_id: sessionId });
  }

  async cancelTaskById(turnId: string): Promise<void> {
    const path = `/api/turns/${encodeURIComponent(turnId)}/cancel`;
    const response = parseStrictResponse<z.infer<typeof TurnDetailSchema>>(await this.http.fetch<unknown>(path, { method: "POST", body: "{}" }), TurnDetailSchema, { endpoint: path });
    if (response.turn.id !== turnId) throw new ApiContractError(path, "Server returned a different turn");
  }
}
