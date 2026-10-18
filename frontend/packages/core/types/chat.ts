import type { MultiremiBackgroundTask } from "@multiremi/contracts/unified-model";

/** Which chats a list shows: the user's own, those opened by automation runs, or both. */
export type ChatOriginFilter = "user" | "automation" | "all";

/** The automation run that opened a chat. */
export interface ChatOrigin {
  autopilot_id: string;
  run_id: string;
}

export interface ChatSession {
  runtime_workspace_id?: string | null;
  id: string;
  workspace_id: string;
  agent_id: string;
  project_id?: string | null;
  creator_id: string;
  title: string;
  status: "active" | "archived";
  /** True when the session has any unread assistant replies. List-only. */
  has_unread: boolean;
  pinned: boolean;
  /** Set for chats opened by an automation run; null for the user's own. */
  origin: ChatOrigin | null;
  unread_count: number;
  last_message: { content: string; role: "user" | "assistant"; created_at: string } | null;
  /**
   * Background tasks still running in this chat (PR 6), from the session
   * registry, whether or not a turn runs. List-only; absent when the server
   * does not report it (older servers), which hides every background-task
   * surface that would need it.
   */
  running_background_tasks?: number;
  created_at: string;
  updated_at: string;
}

export interface CreateChatSessionInput {
  runtime_workspace_id?: string | null;
  agent_id: string;
  title?: string;
  project_id?: string | null;
}

export interface UpdateChatSessionInput {
  title?: string;
  status?: "active" | "archived";
  pinned?: boolean;
}

export interface PendingChatTaskItem {
  task_id: string;
  /** The turn the attempt belongs to; cancel addresses the turn. */
  turn_id?: string;
  status: string;
  chat_session_id: string;
  /**
   * Subagents the turn's current attempt has running (PR 5), from the
   * daemon's best-effort `task.activity` report through `/api/turns`. Absent
   * when the server does not report it (older servers, never reported).
   */
  running_subagents?: number;
  /**
   * Background tasks the turn's current attempt has running (PR 6), from the
   * same report. The session's own count (`ChatSession.running_background_tasks`)
   * also covers tasks parked after their attempt.
   */
  running_background_tasks?: number;
}

export interface PendingChatTasksResponse {
  tasks: PendingChatTaskItem[];
}

export interface ChatMessage {
  turn_id?: string;
  id: string;
  chat_session_id: string;
  role: "user" | "assistant";
  content: string;
  task_id: string | null;
  created_at: string;
  /**
   * Attachments linked to this message via the attachment table's
   * chat_message_id FK. Populated by ListChatMessages. UI renders these
   * as file/image cards inside the bubble; the markdown URL inline in
   * `content` may have an expiring signature, while attachment metadata
   * here is stable and the source of truth for click-time download.
   */
  attachments?: import("./attachment").Attachment[];
  /**
   * When set, this is an assistant message synthesized by the server's
   * FailTask fallback (mirrors the issue path's failure system comment).
   * `content` carries the raw daemon-reported errMsg; the front-end maps
   * `failure_reason` (an enum like "agent_error" / "connection_error" /
   * "timeout") to a user-facing label and renders a destructive bubble.
   * Null on success messages and on user messages.
   */
  failure_reason?: string | null;
  /**
   * Wall-clock duration from `task.created_at` (user hit send) to terminal
   * state (completed/failed). Set by the server on assistant messages
   * synthesized by CompleteTask/FailTask. UI renders it as "Replied in
   * 38s" / "Failed after 12s" beneath the bubble. Null on user messages
   * and on legacy assistant messages predating migration 063.
   */
  elapsed_ms?: number | null;
}

export interface ChatMessagesCursor {
  created_at: string;
  id: string;
}

export interface ChatMessagesPage {
  messages: ChatMessage[];
  limit: number;
  has_more: boolean;
  next_cursor?: ChatMessagesCursor | null;
}

/**
 * The server accepted the message. The turn it started or joined is read
 * afterwards (`getChatTurnPendingTask`), never as part of the send.
 */
export interface SendChatMessageResponse {
  message_id: string;
  turn_id?: string;
  /** Server time of the message. */
  created_at: string;
}

/**
 * View model derived from active turns.
 * Head fields are absent when the session has no in-flight task.
 *
 * `created_at` is the server-authoritative anchor for the chat StatusPill's
 * elapsed-seconds timer — the optimistic seed in chat-window.tsx fills in
 * task_id/status only, then this query catches up with the real created_at
 * so the timer survives refresh / reopen without "resetting to 0s".
 */
export interface ChatPendingTask {
  turn_id?: string;
  task_id?: string;
  status?: string;
  created_at?: string;
  /** Server-provided explanation for the task's current waiting state. */
  wait_reason?: string | null;
  /** Optional Project preparation status, shown until provider output starts. */
  progress_summary?: string | null;
  /** Absent only in the short-lived optimistic cache seed. */
  supports_queue?: true;
}

/**
 * One background task of a chat (PR 6 §5.1), as the session registry reports
 * it: `GET /api/chat/sessions/:id/background-tasks` and the
 * `chat:background_tasks` realtime event carry the same rows.
 *
 * Fields the contract row does not have yet are optional here, and each one
 * only adds to the UI when the server sends it:
 * - `origin_turn_seq`: the number of the turn that started it (「来自第 n 轮」);
 * - `output_unreadable`: the daemon could not read its output (「无法读取输出」).
 */
export type ChatBackgroundTask = MultiremiBackgroundTask & {
  origin_turn_seq?: number | null;
  output_unreadable?: boolean;
};

/**
 * A chat's background tasks: the running rows plus the last ended ones. The
 * read endpoint and the realtime event share this shape; `running` is the
 * count the session list reports as `running_background_tasks`.
 */
export interface ChatBackgroundTasksSnapshot {
  session_id: string;
  running: number;
  rows: ChatBackgroundTask[];
}

/**
 * What a stop asks for (`POST /api/chat/sessions/:id/background-tasks/stop`):
 * one task, by the row's `task_id` (the bridge's task id), or every running
 * task of the chat.
 */
export type ChatBackgroundStopTarget = { task_id: string } | { all: true };
