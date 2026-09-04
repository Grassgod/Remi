import type {
  MultiremiAgentIssueUpdateSubscription,
  MultiremiChatMessage,
  MultiremiChatSession,
} from "@multiremi/contracts/types.js";
import type { StoreContext } from "@multiremi/store/context.js";
import { nullableString, parseJson, toJson } from "@multiremi/store/helpers.js";
import { createLogger } from "@shared/logger.js";

type Row = Record<string, unknown>;

export const DEFAULT_AGENT_ISSUE_UPDATE_DEBOUNCE_MS = 30_000;

const DELIVERABLE_EVENT_TYPES = new Set([
  "comment_created",
  "comment_updated",
  "comment_deleted",
  "comment_resolved",
  "comment_unresolved",
  "issue_updated",
  "issue_assigned",
  "issue_unassigned",
  "issue_dependency_added",
  "issue_dependency_removed",
  "label_attached",
  "label_detached",
  "issue_metadata_set",
  "issue_metadata_deleted",
  "title_renamed",
  "organizer_action",
  "result_published",
  "leader_round_completed",
]);

const SOURCE_TASK_KEYS = [
  "sourceTaskId",
  "source_task_id",
  "parentTaskId",
  "parent_task_id",
] as const;

const log = createLogger("agent-issue-updates");

export interface QueueAgentIssueUpdateInput {
  activityId: string;
  issueId: string;
  actorType: string;
  actorId?: string | null;
  type: string;
  body?: string | null;
  data?: unknown | null;
  createdAt: string;
}

export interface AgentIssueUpdateFlushResult {
  delivered: number;
  dropped: number;
}

export class AgentIssueUpdateValidationError extends Error {}

export class AgentIssueUpdatesRepo {
  private readonly debounceMs: number;

  constructor(
    private readonly ctx: StoreContext,
    options: {
      debounceMs?: number;
    } = {},
  ) {
    this.debounceMs = positiveInteger(options.debounceMs, DEFAULT_AGENT_ISSUE_UPDATE_DEBOUNCE_MS);
  }

  getSubscription(chatSessionId: string): MultiremiAgentIssueUpdateSubscription {
    const chat = this.ctx.chat().getChatSession(chatSessionId);
    if (!chat) throw new AgentIssueUpdateValidationError(`Chat session not found: ${chatSessionId}`);
    const channel = this.ctx.notificationChannels().getAgentChatNotificationChannel(chat.id);
    return {
      chatSessionId: chat.id,
      issueId: chat.issueId,
      channelId: channel?.id ?? null,
      enabled: Boolean(chat.issueId && channel?.enabled),
      debounceWindowSeconds: this.debounceMs / 1_000,
    };
  }

  setSubscription(input: {
    chatSessionId: string;
    enabled: boolean;
    memberId?: string | null;
    createdBy?: string | null;
  }): MultiremiAgentIssueUpdateSubscription {
    const chat = this.ctx.chat().getChatSession(input.chatSessionId);
    if (!chat) throw new AgentIssueUpdateValidationError(`Chat session not found: ${input.chatSessionId}`);
    if (input.enabled && !chat.issueId) {
      throw new AgentIssueUpdateValidationError("Bind the Chat to an Issue before enabling Issue updates");
    }
    this.ctx.notificationChannels().upsertAgentChatNotificationChannel({
      workspaceId: chat.workspaceId,
      chatSessionId: chat.id,
      name: `${chat.title} Issue updates`,
      enabled: input.enabled,
      memberId: input.memberId,
      createdBy: input.createdBy,
    });
    if (!input.enabled) {
      this.clearPending(chat.id);
      this.ctx.chat().discardPendingAgentIssueUpdatesWithinTransaction(chat.id);
    }
    return this.getSubscription(chat.id);
  }

  queue(input: QueueAgentIssueUpdateInput): void {
    if (!DELIVERABLE_EVENT_TYPES.has(input.type)) return;
    const issue = this.ctx.issues().getIssue(input.issueId);
    if (!issue) return;
    const chats = this.ctx.db.query(
      `SELECT * FROM multiremi_chat_sessions
       WHERE issue_id = ? AND status = 'active'
       ORDER BY created_at ASC, id ASC`,
    ).all(issue.id) as Row[];
    for (const row of chats) {
      const chat = toBoundChat(row);
      const channel = this.ctx.notificationChannels().getAgentChatNotificationChannel(chat.id);
      if (!channel?.enabled) continue;
      if (!channel.eventTypes.includes("*") && !channel.eventTypes.includes(input.type)) continue;
      if (this.isTargetChatEvent(chat.id, input)) continue;
      this.upsertPending(chat, channel.id, input);
    }
  }

  flushDue(nowInput: string | Date = new Date()): AgentIssueUpdateFlushResult {
    const now = nowInput instanceof Date ? nowInput : new Date(nowInput);
    if (!Number.isFinite(now.getTime())) throw new Error("now must be a valid date");
    const nowIso = now.toISOString();
    const rows = this.ctx.db.query(
      `SELECT chat_session_id FROM multiremi_agent_issue_update_state
       WHERE pending_count > 0 AND deliver_after IS NOT NULL AND deliver_after <= ?
       ORDER BY deliver_after ASC, chat_session_id ASC`,
    ).all(nowIso) as Row[];
    let delivered = 0;
    let dropped = 0;
    for (const row of rows) {
      const chatSessionId = String(row.chat_session_id);
      try {
        const outcome = this.flushOne(chatSessionId, now);
        if (outcome === "delivered") delivered += 1;
        else if (outcome === "dropped") dropped += 1;
      } catch (error) {
        log.warn(
          `agent issue update delivery failed chat=${chatSessionId}: `
          + `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { delivered, dropped };
  }

  /** Caller owns the transaction; used immediately before a leader-round wake. */
  flushIssueNowWithinTransaction(issueId: string, nowInput: string | Date = new Date()): AgentIssueUpdateFlushResult {
    const now = nowInput instanceof Date ? nowInput : new Date(nowInput);
    if (!Number.isFinite(now.getTime())) throw new Error("now must be a valid date");
    const rows = this.ctx.db.query(
      `SELECT chat_session_id FROM multiremi_agent_issue_update_state
       WHERE issue_id = ? AND pending_count > 0
       ORDER BY pending_since ASC, chat_session_id ASC`,
    ).all(issueId) as Row[];
    let delivered = 0;
    let dropped = 0;
    for (const row of rows) {
      const outcome = this.flushOneWithinTransaction(String(row.chat_session_id), now, true);
      if (outcome.kind === "delivered") delivered += 1;
      else if (outcome.kind === "dropped") dropped += 1;
      if (outcome.kind === "delivered" && outcome.result) this.publish(outcome.result);
    }
    return { delivered, dropped };
  }

  private flushOne(chatSessionId: string, now: Date): "delivered" | "dropped" | "skipped" {
    const outcome = this.ctx.db.transaction(() => this.flushOneWithinTransaction(chatSessionId, now, false))();

    if (outcome.kind === "delivered" && outcome.result) this.publish(outcome.result);
    return outcome.kind;
  }

  private flushOneWithinTransaction(
    chatSessionId: string,
    now: Date,
    force: boolean,
  ): {
    kind: "delivered" | "dropped" | "skipped";
    result: { session: MultiremiChatSession; message: MultiremiChatMessage } | null;
  } {
    this.ctx.db.run(
      "UPDATE multiremi_agent_issue_update_state SET updated_at = updated_at WHERE chat_session_id = ?",
      [chatSessionId],
    );
    const state = this.getState(chatSessionId);
    if (
      !state
      || state.pendingCount <= 0
      || (!force && (!state.deliverAfter || state.deliverAfter > now.getTime()))
    ) {
      return { kind: "skipped", result: null };
    }
    const chat = this.ctx.chat().getChatSession(chatSessionId);
    const channel = this.ctx.notificationChannels().getAgentChatNotificationChannel(chatSessionId);
    if (
      !chat
      || chat.status !== "active"
      || chat.issueId !== state.issueId
      || !channel?.enabled
      || channel.id !== state.channelId
    ) {
      this.clearPending(chatSessionId);
      return { kind: "dropped", result: null };
    }
    const issue = this.ctx.issues().getIssue(state.issueId);
    if (!issue) {
      this.clearPending(chatSessionId);
      return { kind: "dropped", result: null };
    }
    const result = this.ctx.chat().createPendingAgentIssueUpdateWithinTransaction(
      chat.id,
      buildUpdateMessage(issue.key, issue.title, state),
    );
    this.clearPending(chatSessionId, { lastDeliveredAt: now.toISOString() });
    return { kind: "delivered", result };
  }

  private isTargetChatEvent(chatSessionId: string, input: QueueAgentIssueUpdateInput): boolean {
    const data = recordValue(input.data);
    for (const key of SOURCE_TASK_KEYS) {
      const taskId = nullableString(data[key]);
      if (!taskId) continue;
      if (this.ctx.tasks().getTask(taskId)?.chatSessionId === chatSessionId) return true;
      // The leader-round marker already carries this task's final output. The
      // automatic Issue comment is posted just after the terminal transaction;
      // suppress only that covered copy so it cannot become a second pending
      // update for the next Chat turn.
      if (input.type === "comment_created") {
        const covered = this.ctx.db.query(
          `SELECT 1 AS present FROM multiremi_feishu_bot_round_pushes r
           JOIN multiremi_feishu_bot_chat_bindings b ON b.id = r.binding_id
           WHERE b.chat_session_id = ? AND r.leader_task_id = ? LIMIT 1`,
        ).get(chatSessionId, taskId) as Row | null;
        if (covered) return true;
      }
    }
    return false;
  }

  private upsertPending(
    chat: Pick<MultiremiChatSession, "id" | "workspaceId" | "issueId">,
    channelId: string,
    input: QueueAgentIssueUpdateInput,
  ): void {
    if (!chat.issueId) return;
    const deliverAfter = new Date(Date.parse(input.createdAt) + this.debounceMs).toISOString();
    this.ctx.db.run(
      `INSERT INTO multiremi_agent_issue_update_state (
        chat_session_id, workspace_id, issue_id, channel_id, pending_count,
        pending_since, deliver_after, latest_activity_id, latest_event_type,
        latest_actor_type, latest_actor_id, latest_body, latest_data, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_session_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        issue_id = excluded.issue_id,
        channel_id = excluded.channel_id,
        pending_count = CASE
          WHEN multiremi_agent_issue_update_state.issue_id = excluded.issue_id
            THEN multiremi_agent_issue_update_state.pending_count + 1
          ELSE 1
        END,
        pending_since = CASE
          WHEN multiremi_agent_issue_update_state.issue_id = excluded.issue_id
               AND multiremi_agent_issue_update_state.pending_count > 0
            THEN multiremi_agent_issue_update_state.pending_since
          ELSE excluded.pending_since
        END,
        deliver_after = CASE
          WHEN multiremi_agent_issue_update_state.issue_id = excluded.issue_id
               AND multiremi_agent_issue_update_state.pending_count > 0
            THEN multiremi_agent_issue_update_state.deliver_after
          ELSE excluded.deliver_after
        END,
        latest_activity_id = excluded.latest_activity_id,
        latest_event_type = excluded.latest_event_type,
        latest_actor_type = excluded.latest_actor_type,
        latest_actor_id = excluded.latest_actor_id,
        latest_body = excluded.latest_body,
        latest_data = excluded.latest_data,
        updated_at = excluded.updated_at`,
      [
        chat.id,
        chat.workspaceId,
        chat.issueId,
        channelId,
        input.createdAt,
        deliverAfter,
        input.activityId,
        input.type,
        input.actorType,
        input.actorId ?? null,
        truncate(input.body, 8_000),
        input.data == null ? null : truncate(toJson(input.data), 8_000),
        input.createdAt,
        input.createdAt,
      ],
    );
  }

  private getState(chatSessionId: string): AgentIssueUpdateState | null {
    const row = this.ctx.db.query(
      "SELECT * FROM multiremi_agent_issue_update_state WHERE chat_session_id = ?",
    ).get(chatSessionId) as Row | null;
    if (!row) return null;
    return {
      chatSessionId: String(row.chat_session_id),
      issueId: String(row.issue_id),
      channelId: String(row.channel_id),
      pendingCount: Number(row.pending_count ?? 0),
      pendingSince: timestamp(row.pending_since),
      deliverAfter: timestamp(row.deliver_after),
      latestEventType: String(row.latest_event_type ?? "issue_updated"),
      latestActorType: String(row.latest_actor_type ?? "system"),
      latestActorId: nullableString(row.latest_actor_id),
      latestBody: nullableString(row.latest_body),
      latestData: parseJson<Record<string, unknown>>(row.latest_data, {}),
    };
  }

  private clearPending(chatSessionId: string, input: {
    lastDeliveredAt?: string | null;
  } = {}): void {
    this.ctx.db.run(
      `UPDATE multiremi_agent_issue_update_state
       SET pending_count = 0, pending_since = NULL, deliver_after = NULL,
           latest_activity_id = NULL, latest_event_type = NULL,
           latest_actor_type = NULL, latest_actor_id = NULL,
           latest_body = NULL, latest_data = NULL,
           last_delivered_at = COALESCE(?, last_delivered_at),
           updated_at = ?
       WHERE chat_session_id = ?`,
      [
        input.lastDeliveredAt ?? null,
        new Date().toISOString(),
        chatSessionId,
      ],
    );
  }

  private publish(result: { session: MultiremiChatSession; message: MultiremiChatMessage }): void {
    this.ctx.emitChatEvent(result.session, "chat:message", {
      message_id: result.message.id,
      role: "system",
      content: result.message.body,
      task_id: null,
      created_at: result.message.createdAt,
    }, { actorType: "system", actorId: null });
  }
}

interface AgentIssueUpdateState {
  chatSessionId: string;
  issueId: string;
  channelId: string;
  pendingCount: number;
  pendingSince: number | null;
  deliverAfter: number | null;
  latestEventType: string;
  latestActorType: string;
  latestActorId: string | null;
  latestBody: string | null;
  latestData: Record<string, unknown>;
}

function buildUpdateMessage(issueKey: string, issueTitle: string, state: AgentIssueUpdateState): string {
  const details = state.latestBody?.trim()
    || summarizeData(state.latestData)
    || "No textual details were provided.";
  const actor = state.latestActorId
    ? `${state.latestActorType}:${state.latestActorId}`
    : state.latestActorType;
  return [
    `Bound Issue update: ${issueKey} - ${issueTitle}`,
    `Updates aggregated: ${state.pendingCount}`,
    `Latest event: ${state.latestEventType}`,
    `Latest actor: ${actor}`,
    "",
    "Latest details:",
    details,
  ].join("\n");
}

function summarizeData(data: Record<string, unknown>): string {
  const entries = Object.entries(data)
    .filter(([, value]) => value == null || ["string", "number", "boolean"].includes(typeof value))
    .slice(0, 8);
  return entries.map(([key, value]) => `${key}: ${String(value)}`).join("\n");
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function toBoundChat(row: Row): Pick<MultiremiChatSession, "id" | "workspaceId" | "issueId" | "agentId"> {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    issueId: nullableString(row.issue_id),
    agentId: String(row.agent_id),
  };
}

function timestamp(value: unknown): number | null {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function truncate(value: string | null | undefined, max: number): string | null {
  if (value == null) return null;
  return value.length <= max ? value : value.slice(0, max);
}
