import type {
  MultiremiInboxItem,
  MultiremiNotificationChannel,
  MultiremiNotificationChannelKind,
  MultiremiNotificationDelivery,
  MultiremiNotificationDeliveryStatus,
} from "@multiremi/contracts/types.js";
import { createId, nowIso } from "@multiremi/ids.js";
import type { StoreContext } from "@multiremi/store/context.js";
import { toInboxItem } from "@multiremi/store/context.js";
import { nullableString, parseJson, toJson } from "@multiremi/store/helpers.js";

type Row = Record<string, unknown>;

const FEISHU_GROUP_CHAT_ID = /^oc_[A-Za-z0-9_-]+$/;
const SEVERITY_RANK: Record<string, number> = {
  info: 0,
  attention: 1,
  warning: 2,
  error: 3,
  critical: 4,
};

export interface CreateNotificationChannelInput {
  workspaceId: string;
  kind: MultiremiNotificationChannelKind;
  name: string;
  enabled?: boolean;
  target: unknown;
  eventTypes: unknown;
  minSeverity?: string;
  createdBy?: string | null;
}

export interface UpdateNotificationChannelInput {
  name?: string;
  enabled?: boolean;
  target?: unknown;
  eventTypes?: unknown;
  minSeverity?: string;
}

export interface NotificationDeliveryContext {
  delivery: MultiremiNotificationDelivery;
  channel: MultiremiNotificationChannel | null;
  item: MultiremiInboxItem | null;
}

export class NotificationChannelValidationError extends Error {}

export function validateFeishuGroupTarget(value: unknown): { chatId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NotificationChannelValidationError("target must be an object containing chatId");
  }
  const chatId = (value as Record<string, unknown>).chatId;
  if (typeof chatId !== "string" || !FEISHU_GROUP_CHAT_ID.test(chatId)) {
    throw new NotificationChannelValidationError("target.chatId must be a Feishu group chat id beginning with oc_");
  }
  return { chatId };
}

export class NotificationChannelsRepo {
  constructor(private readonly ctx: StoreContext) {}

  getChannel(id: string): MultiremiNotificationChannel | null {
    const row = this.ctx.db.query(
      "SELECT * FROM multiremi_notification_channels WHERE id = ?",
    ).get(id) as Row | null;
    return row ? toNotificationChannel(row) : null;
  }

  listChannels(workspaceId: string): MultiremiNotificationChannel[] {
    const rows = this.ctx.db.query(
      `SELECT * FROM multiremi_notification_channels
       WHERE workspace_id = ? ORDER BY created_at ASC, id ASC`,
    ).all(workspaceId) as Row[];
    return rows.map(toNotificationChannel);
  }

  createChannel(input: CreateNotificationChannelInput): MultiremiNotificationChannel {
    const workspaceId = requiredString(input.workspaceId, "workspaceId");
    if (input.kind !== "feishu_group") {
      throw new NotificationChannelValidationError("kind must be feishu_group");
    }
    const name = requiredString(input.name, "name");
    const target = validateFeishuGroupTarget(input.target);
    const eventTypes = normalizeEventTypes(input.eventTypes);
    const minSeverity = normalizeSeverity(input.minSeverity ?? "info");
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
      throw new NotificationChannelValidationError("enabled must be a boolean");
    }
    const id = createId("nch");
    const now = nowIso();
    this.ctx.db.run(
      `INSERT INTO multiremi_notification_channels (
        id, workspace_id, kind, name, enabled, target, event_types, min_severity,
        created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        workspaceId,
        input.kind,
        name,
        input.enabled === false ? 0 : 1,
        toJson(target),
        toJson(eventTypes),
        minSeverity,
        nullableString(input.createdBy),
        now,
        now,
      ],
    );
    return this.getChannel(id)!;
  }

  updateChannel(id: string, input: UpdateNotificationChannelInput): MultiremiNotificationChannel | null {
    const current = this.getChannel(id);
    if (!current) return null;
    const fields: string[] = [];
    const values: unknown[] = [];
    if (input.name !== undefined) {
      fields.push("name = ?");
      values.push(requiredString(input.name, "name"));
    }
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== "boolean") {
        throw new NotificationChannelValidationError("enabled must be a boolean");
      }
      fields.push("enabled = ?");
      values.push(input.enabled ? 1 : 0);
    }
    if (input.target !== undefined) {
      fields.push("target = ?");
      values.push(toJson(validateFeishuGroupTarget(input.target)));
    }
    if (input.eventTypes !== undefined) {
      fields.push("event_types = ?");
      values.push(toJson(normalizeEventTypes(input.eventTypes)));
    }
    if (input.minSeverity !== undefined) {
      fields.push("min_severity = ?");
      values.push(normalizeSeverity(input.minSeverity));
    }
    if (!fields.length) return current;
    fields.push("updated_at = ?");
    values.push(nowIso(), id);
    this.ctx.db.run(
      `UPDATE multiremi_notification_channels SET ${fields.join(", ")} WHERE id = ?`,
      values,
    );
    return this.getChannel(id);
  }

  deleteChannel(id: string): boolean {
    return this.ctx.db.run(
      "DELETE FROM multiremi_notification_channels WHERE id = ?",
      [id],
    ).changes > 0;
  }

  matchRoutes(workspaceId: string, inboxType: string, severity: string): MultiremiNotificationChannel[] {
    const incomingRank = severityRank(severity);
    return this.listChannels(workspaceId).filter((channel) =>
      channel.enabled
      && channel.kind === "feishu_group"
      && (channel.eventTypes.includes("*") || channel.eventTypes.includes(inboxType))
      && incomingRank >= severityRank(channel.minSeverity)
    );
  }

  recordPending(item: MultiremiInboxItem, channel: MultiremiNotificationChannel): MultiremiNotificationDelivery {
    const id = createId("ndl");
    this.ctx.db.run(
      `INSERT INTO multiremi_notification_deliveries (
        id, workspace_id, inbox_item_id, channel_id, channel_kind, target_label,
        status, attempts, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
      [id, item.workspaceId, item.id, channel.id, channel.kind, channel.name, nowIso()],
    );
    return this.getDelivery(id)!;
  }

  getDelivery(id: string): MultiremiNotificationDelivery | null {
    const row = this.ctx.db.query(
      "SELECT * FROM multiremi_notification_deliveries WHERE id = ?",
    ).get(id) as Row | null;
    return row ? toNotificationDelivery(row) : null;
  }

  getDeliveryContext(id: string): NotificationDeliveryContext | null {
    const delivery = this.getDelivery(id);
    if (!delivery) return null;
    const channel = this.getChannel(delivery.channelId);
    const row = this.ctx.db.query(
      "SELECT * FROM multiremi_inbox_items WHERE id = ?",
    ).get(delivery.inboxItemId) as Row | null;
    const issueId = nullableString(row?.issue_id);
    const issue = issueId ? this.ctx.issues().getIssue(issueId) : null;
    return {
      delivery,
      channel,
      item: row ? toInboxItem(row, issue) : null,
    };
  }

  listDeliveries(input: {
    workspaceId: string;
    status?: MultiremiNotificationDeliveryStatus | null;
    limit?: number;
  }): MultiremiNotificationDelivery[] {
    const limit = normalizeLimit(input.limit);
    const rows = input.status
      ? this.ctx.db.query(
        `SELECT * FROM multiremi_notification_deliveries
         WHERE workspace_id = ? AND status = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      ).all(input.workspaceId, input.status, limit) as Row[]
      : this.ctx.db.query(
        `SELECT * FROM multiremi_notification_deliveries
         WHERE workspace_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      ).all(input.workspaceId, limit) as Row[];
    return rows.map(toNotificationDelivery);
  }

  listPendingDeliveries(now: string, limit = 100): MultiremiNotificationDelivery[] {
    const rows = this.ctx.db.query(
      `SELECT * FROM multiremi_notification_deliveries
       WHERE status = 'pending'
         AND (leased_until IS NULL OR leased_until <= ?)
       ORDER BY created_at ASC, id ASC LIMIT ?`,
    ).all(now, normalizeLimit(limit)) as Row[];
    return rows.map(toNotificationDelivery);
  }

  claimAttempt(
    id: string,
    expectedAttempts: number,
    maxAttempts: number,
    claimedAt: string,
    leasedUntil: string,
  ): MultiremiNotificationDelivery | null {
    const result = this.ctx.db.run(
      `UPDATE multiremi_notification_deliveries
       SET attempts = attempts + 1, last_attempt_at = ?, leased_until = ?, last_error = NULL
       WHERE id = ? AND status = 'pending' AND attempts = ? AND attempts < ?
         AND (leased_until IS NULL OR leased_until <= ?)`,
      [claimedAt, leasedUntil, id, expectedAttempts, maxAttempts, claimedAt],
    );
    return result.changes === 1 ? this.getDelivery(id) : null;
  }

  markSent(id: string, expectedAttempts: number): MultiremiNotificationDelivery | null {
    const now = nowIso();
    const result = this.ctx.db.run(
      `UPDATE multiremi_notification_deliveries
       SET status = 'sent', leased_until = NULL, last_error = NULL, delivered_at = ?
       WHERE id = ? AND status = 'pending' AND attempts = ?`,
      [now, id, expectedAttempts],
    );
    return result.changes === 1 ? this.getDelivery(id) : null;
  }

  markFailed(id: string, error: string, expectedAttempts: number): MultiremiNotificationDelivery | null {
    const result = this.ctx.db.run(
      `UPDATE multiremi_notification_deliveries
       SET status = 'failed', leased_until = NULL, last_error = ?
       WHERE id = ? AND status = 'pending' AND attempts = ?`,
      [truncateError(error), id, expectedAttempts],
    );
    return result.changes === 1 ? this.getDelivery(id) : null;
  }

  recordRetryableError(id: string, error: string, expectedAttempts: number): MultiremiNotificationDelivery | null {
    const result = this.ctx.db.run(
      `UPDATE multiremi_notification_deliveries
       SET leased_until = NULL, last_error = ?
       WHERE id = ? AND status = 'pending' AND attempts = ?`,
      [truncateError(error), id, expectedAttempts],
    );
    return result.changes === 1 ? this.getDelivery(id) : null;
  }

  resetForRetry(id: string): MultiremiNotificationDelivery | null {
    const current = this.getDelivery(id);
    if (!current || current.status === "sent") return null;
    const result = this.ctx.db.run(
      `UPDATE multiremi_notification_deliveries
       SET status = 'pending', attempts = 0, last_error = NULL,
           last_attempt_at = NULL, leased_until = NULL, delivered_at = NULL
       WHERE id = ? AND status IN ('pending', 'failed')`,
      [id],
    );
    return result.changes === 1 ? this.getDelivery(id) : null;
  }
}

function requiredString(value: unknown, name: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new NotificationChannelValidationError(`${name} is required`);
  return normalized;
}

function normalizeEventTypes(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new NotificationChannelValidationError("eventTypes must be a non-empty string array");
  }
  const normalized = [...new Set(value.map((entry) => entry.trim()).filter(Boolean))];
  if (!normalized.length) {
    throw new NotificationChannelValidationError("eventTypes must be a non-empty string array");
  }
  return normalized;
}

function normalizeSeverity(value: unknown): string {
  const severity = String(value ?? "").trim().toLowerCase();
  if (!(severity in SEVERITY_RANK)) {
    throw new NotificationChannelValidationError(
      "minSeverity must be one of info, attention, warning, error, critical",
    );
  }
  return severity;
}

function severityRank(value: string): number {
  return SEVERITY_RANK[String(value).trim().toLowerCase()] ?? SEVERITY_RANK.info!;
}

function normalizeLimit(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) return 100;
  return Math.min(Number(value), 500);
}

function truncateError(value: string): string {
  return String(value).slice(0, 2_000);
}

function toNotificationChannel(row: Row): MultiremiNotificationChannel {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    kind: String(row.kind) as MultiremiNotificationChannelKind,
    name: String(row.name ?? ""),
    enabled: Number(row.enabled ?? 0) === 1,
    target: parseJson<{ chatId: string }>(row.target, { chatId: "" }),
    eventTypes: parseJson<string[]>(row.event_types, []),
    minSeverity: String(row.min_severity ?? "info"),
    createdBy: nullableString(row.created_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toNotificationDelivery(row: Row): MultiremiNotificationDelivery {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    inboxItemId: String(row.inbox_item_id),
    channelId: String(row.channel_id),
    channelKind: String(row.channel_kind) as MultiremiNotificationChannelKind,
    targetLabel: String(row.target_label ?? ""),
    status: String(row.status) as MultiremiNotificationDeliveryStatus,
    attempts: Number(row.attempts ?? 0),
    leasedUntil: nullableString(row.leased_until),
    lastError: nullableString(row.last_error),
    lastAttemptAt: nullableString(row.last_attempt_at),
    deliveredAt: nullableString(row.delivered_at),
    createdAt: String(row.created_at),
  };
}
