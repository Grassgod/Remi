import { createId, nowIso } from "@multiremi/ids.js";
import type { StoreContext } from "@multiremi/store/context.js";
import { cleanOptionalString, nullableString, parseJson, toJson } from "@multiremi/store/helpers.js";
import { normalizeFeishuSidecarEndpointName } from "@multiremi/feishu-ingest/endpoints.js";
import { createLogger } from "@shared/logger.js";
import type {
  CreateIssueFromMultiremiFeishuMessageInput,
  CreateMultiremiFeishuSourceInput,
  MultiremiFeishuAllowlistEntry,
  MultiremiFeishuChat,
  MultiremiFeishuMessage,
  MultiremiFeishuMessageOutcome,
  MultiremiFeishuMessageOutcomeKind,
  MultiremiFeishuIssueProposal,
  MultiremiFeishuIssueProposalListItem,
  MultiremiFeishuIssueProposalStatus,
  MultiremiFeishuSource,
  MultiremiFeishuSyncCursor,
  MultiremiInboxItem,
  MultiremiIssue,
  MultiremiFeishuSourceStatus,
  ResolveMultiremiFeishuMessageInput,
  UpdateMultiremiFeishuSourceInput,
} from "@multiremi/contracts/types.js";

type Row = Record<string, unknown>;

const log = createLogger("multiremi-feishu-ingest");

export interface ClaimFeishuSyncStreamInput {
  sourceId: string;
  stream: string;
  owner: string;
  now: string;
  leaseMs: number;
}

export interface UpdateClaimedFeishuSyncCursorInput {
  sourceId: string;
  stream: string;
  leaseToken: string;
  leaseUntil?: string | null;
  cursor?: Record<string, unknown> | null;
  watermark?: string | null;
  lastStartedAt?: string | null;
  lastCompletedAt?: string | null;
  lastError?: string | null;
}

export interface IngestedFeishuMessageInput {
  messageId: string;
  chatId: string;
  chatType?: string | null;
  chatName?: string | null;
  threadId?: string | null;
  rootId?: string | null;
  parentId?: string | null;
  sender: Record<string, unknown>;
  content: Record<string, unknown>;
  searchableText: string;
  contentFingerprint: string;
  messageAppLink?: string | null;
  createdAt: string;
  updatedAt?: string | null;
  recalled?: boolean;
}

export interface IngestFeishuBatchResult {
  inserted: number;
  updated: number;
  unchanged: number;
  eventId: string | null;
}

export interface CreateFeishuInboxOutcomeInput {
  workspaceId: string;
  recipientId: string;
  taskId?: string | null;
  actorType: "agent" | "member";
  actorId: string | null;
  text: string;
}

export interface CreateFeishuInboxOutcomeResult {
  message: MultiremiFeishuMessage;
  outcome: MultiremiFeishuMessageOutcome;
  inboxItem: MultiremiInboxItem | null;
  delivered: boolean;
}

export interface CreateFeishuIssueOutcomeInput extends CreateIssueFromMultiremiFeishuMessageInput {
  workspaceId: string;
  taskId?: string | null;
  createdBy?: string | null;
}

export interface CreateFeishuIssueOutcomeResult {
  message: MultiremiFeishuMessage;
  outcome: MultiremiFeishuMessageOutcome;
  issue: MultiremiIssue;
  created: boolean;
}

export interface CreateFeishuIssueProposalInput extends CreateIssueFromMultiremiFeishuMessageInput {
  workspaceId: string;
  recipientId: string;
  taskId?: string | null;
  actorType: "agent" | "member";
  actorId: string | null;
}

export interface CreateFeishuIssueProposalResult {
  message: MultiremiFeishuMessage;
  outcome: MultiremiFeishuMessageOutcome;
  proposal: MultiremiFeishuIssueProposal | null;
  inboxItem: MultiremiInboxItem | null;
  delivered: boolean;
  created: boolean;
}

export interface ResolveFeishuIssueProposalResult {
  message: MultiremiFeishuMessage;
  proposal: MultiremiFeishuIssueProposal;
  outcome: MultiremiFeishuMessageOutcome;
  issue: MultiremiIssue | null;
  created: boolean;
}

export interface ReconcileFeishuUnprocessedResult {
  retried: number;
  dismissed: number;
  eventId: string | null;
}

export interface ListFeishuMessagesInput {
  workspaceId: string;
  sourceId?: string | null;
  query?: string | null;
  processed?: boolean;
  since?: string | null;
  until?: string | null;
  chatId?: string | null;
  limit?: number;
  offset?: number;
}

export interface ListFeishuMessagesResult {
  messages: MultiremiFeishuMessage[];
  total: number;
}

export interface ListFeishuIssueProposalsInput {
  workspaceId: string;
  status?: MultiremiFeishuIssueProposalStatus;
  sourceId?: string | null;
  limit?: number;
  offset?: number;
}

export interface ListFeishuIssueProposalsResult {
  proposals: MultiremiFeishuIssueProposalListItem[];
  total: number;
}

const OUTCOME_KINDS = new Set<MultiremiFeishuMessageOutcomeKind>([
  "issue_proposed",
  "issue_created",
  "notified",
  "reply_drafted",
  "ignored",
  "dismissed",
]);

const CONNECTION_ALERT_THRESHOLD = 3;

export class FeishuIngestRepo {
  constructor(private readonly ctx: StoreContext) {}

  listSources(input: { workspaceId?: string | null; enabled?: boolean } = {}): MultiremiFeishuSource[] {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (input.workspaceId) {
      clauses.push("workspace_id = ?");
      args.push(input.workspaceId);
    }
    if (input.enabled !== undefined) {
      clauses.push("enabled = ?");
      args.push(input.enabled ? 1 : 0);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.ctx.db.query(
      `SELECT * FROM multiremi_feishu_sources ${where} ORDER BY created_at ASC, id ASC`,
    ).all(...args) as Row[];
    return rows.map(toSource);
  }

  getSource(id: string): MultiremiFeishuSource | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_feishu_sources WHERE id = ?").get(id) as Row | null;
    return row ? toSource(row) : null;
  }

  createSource(input: CreateMultiremiFeishuSourceInput): MultiremiFeishuSource {
    const workspaceId = cleanOptionalString(input.workspaceId ?? input.workspace_id) ?? "local";
    const type = input.type ?? "personal_automation";
    if (type !== "personal_automation") throw new Error("unsupported Feishu source type");
    const endpointName = normalizeFeishuSidecarEndpointName(input.endpointName ?? input.endpoint_name);
    const now = nowIso();
    const id = cleanOptionalString(input.id) ?? createId("fsrc");
    const name = cleanOptionalString(input.name) ?? "Personal Automation";
    const allowlist = normalizeAllowlist(input.allowlist ?? [], [], now);
    const retentionDays = normalizeRetentionDays(input.retentionDays ?? input.retention_days);
    const pollIntervalSeconds = normalizePollInterval(input.pollIntervalSeconds ?? input.poll_interval_seconds);
    const unprocessedRetrySeconds = normalizeUnprocessedRetrySeconds(
      input.unprocessedRetrySeconds ?? input.unprocessed_retry_seconds,
    );
    const unprocessedRetryLimit = normalizeUnprocessedRetryLimit(
      input.unprocessedRetryLimit ?? input.unprocessed_retry_limit,
    );
    this.ctx.db.run(
      `INSERT INTO multiremi_feishu_sources (
        id, workspace_id, name, type, endpoint_name, allowlist, enabled,
        retention_days, poll_interval_seconds, unprocessed_retry_seconds,
        unprocessed_retry_limit, access_token_encrypted, access_token_hint,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      [
        id,
        workspaceId,
        name,
        type,
        endpointName,
        toJson(allowlist),
        input.enabled === false ? 0 : 1,
        retentionDays,
        pollIntervalSeconds,
        unprocessedRetrySeconds,
        unprocessedRetryLimit,
        now,
        now,
      ],
    );
    return this.getSource(id)!;
  }

  updateSource(id: string, input: UpdateMultiremiFeishuSourceInput): MultiremiFeishuSource {
    const current = this.getSource(id);
    if (!current) throw new Error(`Feishu source not found: ${id}`);
    const now = nowIso();
    const allowlist = input.allowlist === undefined
      ? current.allowlist
      : normalizeAllowlist(input.allowlist, current.allowlist, now);
    this.ctx.db.run(
      `UPDATE multiremi_feishu_sources SET
        name = ?, endpoint_name = ?, allowlist = ?, enabled = ?, retention_days = ?,
        poll_interval_seconds = ?, unprocessed_retry_seconds = ?,
        unprocessed_retry_limit = ?, updated_at = ?
       WHERE id = ?`,
      [
        input.name === undefined ? current.name : cleanOptionalString(input.name) ?? "Personal Automation",
        input.endpointName === undefined && input.endpoint_name === undefined
          ? current.endpointName
          : normalizeFeishuSidecarEndpointName(input.endpointName ?? input.endpoint_name),
        toJson(allowlist),
        input.enabled === undefined ? (current.enabled ? 1 : 0) : (input.enabled ? 1 : 0),
        input.retentionDays === undefined && input.retention_days === undefined
          ? current.retentionDays
          : normalizeRetentionDays(input.retentionDays ?? input.retention_days),
        input.pollIntervalSeconds === undefined && input.poll_interval_seconds === undefined
          ? current.pollIntervalSeconds
          : normalizePollInterval(input.pollIntervalSeconds ?? input.poll_interval_seconds),
        input.unprocessedRetrySeconds === undefined && input.unprocessed_retry_seconds === undefined
          ? current.unprocessedRetrySeconds
          : normalizeUnprocessedRetrySeconds(input.unprocessedRetrySeconds ?? input.unprocessed_retry_seconds),
        input.unprocessedRetryLimit === undefined && input.unprocessed_retry_limit === undefined
          ? current.unprocessedRetryLimit
          : normalizeUnprocessedRetryLimit(input.unprocessedRetryLimit ?? input.unprocessed_retry_limit),
        now,
        id,
      ],
    );
    return this.getSource(id)!;
  }

  deleteSource(id: string): boolean {
    return this.ctx.db.transaction(() => {
      if (!this.getSource(id)) return false;
      // Keep cascade behavior deterministic even when a SQLite connection has
      // not enabled foreign-key enforcement.
      this.ctx.db.run(
        `DELETE FROM multiremi_feishu_message_outcomes
         WHERE message_id IN (SELECT message_id FROM multiremi_feishu_messages WHERE source_id = ?)`,
        [id],
      );
      this.ctx.db.run("DELETE FROM multiremi_feishu_messages WHERE source_id = ?", [id]);
      this.ctx.db.run("DELETE FROM multiremi_feishu_sync_cursors WHERE source_id = ?", [id]);
      return this.ctx.db.run("DELETE FROM multiremi_feishu_sources WHERE id = ?", [id]).changes === 1;
    })();
  }

  getSyncCursor(sourceId: string, stream: string): MultiremiFeishuSyncCursor | null {
    const row = this.ctx.db.query(
      "SELECT * FROM multiremi_feishu_sync_cursors WHERE source_id = ? AND stream = ?",
    ).get(sourceId, stream) as Row | null;
    return row ? toCursor(row) : null;
  }

  claimSyncStream(input: ClaimFeishuSyncStreamInput): MultiremiFeishuSyncCursor | null {
    return this.ctx.db.transaction(() => {
      this.ctx.db.run(
        `INSERT OR IGNORE INTO multiremi_feishu_sync_cursors (
          source_id, stream, cursor, watermark, last_started_at, last_completed_at,
          last_error, lease_owner, lease_until, lease_token, updated_at
        ) VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
        [input.sourceId, input.stream, input.now],
      );
      const leaseToken = createId("flease");
      const leaseUntil = new Date(Date.parse(input.now) + input.leaseMs).toISOString();
      const row = this.ctx.db.query(
        `UPDATE multiremi_feishu_sync_cursors
         SET lease_owner = ?, lease_until = ?, lease_token = ?, updated_at = ?
         WHERE source_id = ? AND stream = ?
           AND (lease_token IS NULL OR lease_until IS NULL OR lease_until <= ?)
         RETURNING *`,
      ).get(
        input.owner,
        leaseUntil,
        leaseToken,
        input.now,
        input.sourceId,
        input.stream,
        input.now,
      ) as Row | null;
      return row ? toCursor(row) : null;
    })();
  }

  updateClaimedSyncCursor(input: UpdateClaimedFeishuSyncCursorInput): MultiremiFeishuSyncCursor | null {
    const current = this.getSyncCursor(input.sourceId, input.stream);
    if (!current || current.leaseToken !== input.leaseToken) return null;
    const updatedAt = nowIso();
    const row = this.ctx.db.query(
      `UPDATE multiremi_feishu_sync_cursors SET
        cursor = ?, watermark = ?, last_started_at = ?, last_completed_at = ?,
        last_error = ?, lease_until = ?, updated_at = ?
       WHERE source_id = ? AND stream = ? AND lease_token = ?
       RETURNING *`,
    ).get(
      input.cursor === undefined ? encodeCursor(current.cursor) : encodeCursor(input.cursor),
      input.watermark === undefined ? current.watermark : input.watermark,
      input.lastStartedAt === undefined ? current.lastStartedAt : input.lastStartedAt,
      input.lastCompletedAt === undefined ? current.lastCompletedAt : input.lastCompletedAt,
      input.lastError === undefined ? current.lastError : input.lastError,
      input.leaseUntil === undefined ? current.leaseUntil : input.leaseUntil,
      updatedAt,
      input.sourceId,
      input.stream,
      input.leaseToken,
    ) as Row | null;
    return row ? toCursor(row) : null;
  }

  releaseSyncStream(sourceId: string, stream: string, leaseToken: string): boolean {
    return this.ctx.db.run(
      `UPDATE multiremi_feishu_sync_cursors
       SET lease_owner = NULL, lease_until = NULL, lease_token = NULL, updated_at = ?
       WHERE source_id = ? AND stream = ? AND lease_token = ?`,
      [nowIso(), sourceId, stream, leaseToken],
    ).changes > 0;
  }

  ingestBatch(sourceId: string, messages: readonly IngestedFeishuMessageInput[]): IngestFeishuBatchResult {
    const source = this.getSource(sourceId);
    if (!source) throw new Error(`Feishu source not found: ${sourceId}`);
    const allowedChats = new Map(source.allowlist.map((entry) => [entry.chatId, Date.parse(entry.addedAt)]));
    return this.ctx.db.transaction(() => {
      let inserted = 0;
      let updated = 0;
      let unchanged = 0;
      const ingestedAt = nowIso();
      for (const message of messages) {
        const allowedAfter = allowedChats.get(message.chatId);
        const createdAtTimestamp = Date.parse(message.createdAt);
        if (allowedAfter === undefined || !Number.isFinite(createdAtTimestamp) || createdAtTimestamp < allowedAfter) {
          unchanged += 1;
          continue;
        }
        const existing = this.getMessage(message.messageId);
        if (existing && (existing.workspaceId !== source.workspaceId || existing.sourceId !== source.id)) {
          throw new Error("Feishu message already belongs to another source");
        }
        if (!existing) {
          this.ctx.db.run(
            `INSERT INTO multiremi_feishu_messages (
              message_id, workspace_id, source_id, chat_id, chat_type, chat_name,
              thread_id, root_id, parent_id, sender, content, searchable_text,
              content_fingerprint, message_app_link, created_at, updated_at,
              recalled, edited, ingested_at, processed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL)`,
            [
              message.messageId,
              source.workspaceId,
              source.id,
              message.chatId,
              cleanOptionalString(message.chatType),
              cleanOptionalString(message.chatName),
              cleanOptionalString(message.threadId),
              cleanOptionalString(message.rootId),
              cleanOptionalString(message.parentId),
              toJson(message.sender),
              toJson(message.content),
              message.searchableText,
              message.contentFingerprint,
              cleanOptionalString(message.messageAppLink),
              message.createdAt,
              cleanOptionalString(message.updatedAt),
              message.recalled ? 1 : 0,
              ingestedAt,
            ],
          );
          inserted += 1;
          continue;
        }
        const recalled = Boolean(message.recalled);
        if (existing.contentFingerprint === message.contentFingerprint && existing.recalled === recalled) {
          unchanged += 1;
          continue;
        }
        const contentChanged = existing.contentFingerprint !== message.contentFingerprint;
        this.ctx.db.run(
          `UPDATE multiremi_feishu_messages SET
            chat_type = ?, chat_name = ?, thread_id = ?, root_id = ?, parent_id = ?,
            sender = ?, content = ?, searchable_text = ?, content_fingerprint = ?,
            message_app_link = ?, updated_at = ?, recalled = ?, edited = ?,
            ingested_at = ?
           WHERE message_id = ?`,
          [
            cleanOptionalString(message.chatType),
            cleanOptionalString(message.chatName),
            cleanOptionalString(message.threadId),
            cleanOptionalString(message.rootId),
            cleanOptionalString(message.parentId),
            toJson(message.sender),
            toJson(message.content),
            message.searchableText,
            message.contentFingerprint,
            cleanOptionalString(message.messageAppLink),
            cleanOptionalString(message.updatedAt),
            recalled ? 1 : 0,
            existing.edited || contentChanged ? 1 : 0,
            ingestedAt,
            message.messageId,
          ],
        );
        updated += 1;
      }
      const changed = inserted + updated;
      let eventId: string | null = null;
      if (changed > 0) {
        eventId = createId("sev");
        this.ctx.db.run(
          `INSERT INTO multiremi_system_events (
            id, workspace_id, resource, event, resource_id, project_id, payload,
            status, attempt_count, available_at, lease_until, last_error, created_at, processed_at
          ) VALUES (?, ?, 'feishu_source', 'messages_ingested', ?, NULL, ?, 'pending', 0, ?, NULL, NULL, ?, NULL)`,
          [
            eventId,
            source.workspaceId,
            source.id,
            toJson({ source_id: source.id, message_count: changed }),
            ingestedAt,
            ingestedAt,
          ],
        );
      }
      return { inserted, updated, unchanged, eventId };
    })();
  }

  getMessage(messageId: string): MultiremiFeishuMessage | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_feishu_messages WHERE message_id = ?").get(messageId) as Row | null;
    return row ? toMessage(row) : null;
  }

  listMessages(input: ListFeishuMessagesInput): ListFeishuMessagesResult {
    const clauses = ["workspace_id = ?"];
    const args: unknown[] = [input.workspaceId];
    if (input.sourceId) {
      clauses.push("source_id = ?");
      args.push(input.sourceId);
    }
    if (input.processed !== undefined) {
      clauses.push(input.processed ? "processed_at IS NOT NULL" : "processed_at IS NULL");
    }
    const query = input.query?.trim() ?? "";
    if (query.length > 200) throw new Error("q must be at most 200 characters");
    if (query) {
      clauses.push("LOWER(searchable_text) LIKE LOWER(?) ESCAPE '\\'");
      args.push(`%${escapeLikePattern(query)}%`);
    }
    if (input.since) {
      clauses.push("created_at >= ?");
      args.push(normalizeTimestamp(input.since, "since"));
    }
    if (input.until) {
      clauses.push("created_at <= ?");
      args.push(normalizeTimestamp(input.until, "until"));
    }
    if (input.chatId) {
      clauses.push("chat_id = ?");
      args.push(input.chatId);
    }
    const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 100)));
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const totalRow = this.ctx.db.query(
      `SELECT COUNT(*) AS count FROM multiremi_feishu_messages WHERE ${clauses.join(" AND ")}`,
    ).get(...args) as Row;
    const rows = this.ctx.db.query(
      `SELECT * FROM multiremi_feishu_messages
       WHERE ${clauses.join(" AND ")}
       ORDER BY created_at ASC, message_id ASC LIMIT ? OFFSET ?`,
    ).all(...args, limit, offset) as Row[];
    return { messages: rows.map(toMessage), total: Number(totalRow.count ?? 0) };
  }

  listMessageOutcomes(messageId: string): MultiremiFeishuMessageOutcome[] {
    const rows = this.ctx.db.query(
      "SELECT * FROM multiremi_feishu_message_outcomes WHERE message_id = ? ORDER BY created_at ASC, id ASC",
    ).all(messageId) as Row[];
    return rows.map(toOutcome);
  }

  listMessageOutcomesByMessageIds(messageIds: readonly string[]): MultiremiFeishuMessageOutcome[] {
    if (messageIds.length === 0) return [];
    const placeholders = messageIds.map(() => "?").join(", ");
    const rows = this.ctx.db.query(
      `SELECT * FROM multiremi_feishu_message_outcomes
       WHERE message_id IN (${placeholders}) ORDER BY created_at ASC, id ASC`,
    ).all(...messageIds) as Row[];
    return rows.map(toOutcome);
  }

  listChats(workspaceId: string): MultiremiFeishuChat[] {
    const sources = new Map(this.listSources({ workspaceId }).map((source) => [source.id, source]));
    const rows = this.ctx.db.query(
      `SELECT source_id, chat_id, MAX(chat_name) AS chat_name, MAX(chat_type) AS chat_type,
              COUNT(*) AS message_count, MAX(created_at) AS last_message_at
       FROM multiremi_feishu_messages
       WHERE workspace_id = ?
       GROUP BY source_id, chat_id
       ORDER BY last_message_at DESC, source_id ASC, chat_id ASC`,
    ).all(workspaceId) as Row[];
    return rows.map((row) => {
      const sourceId = String(row.source_id);
      const chatId = String(row.chat_id);
      return {
        sourceId,
        chatId,
        chatName: nullableString(row.chat_name),
        chatType: nullableString(row.chat_type),
        messageCount: Number(row.message_count ?? 0),
        lastMessageAt: String(row.last_message_at),
        inAllowlist: sources.get(sourceId)?.allowlist.some((entry) => entry.chatId === chatId) ?? false,
      };
    });
  }

  listIssueProposals(input: ListFeishuIssueProposalsInput): ListFeishuIssueProposalsResult {
    const clauses = ["o.workspace_id = ?", "o.outcome_kind = 'issue_proposed'"];
    const args: unknown[] = [input.workspaceId];
    if (input.status) {
      clauses.push("o.proposal_status = ?");
      args.push(input.status);
    }
    if (input.sourceId) {
      clauses.push("m.source_id = ?");
      args.push(input.sourceId);
    }
    const where = clauses.join(" AND ");
    const totalRow = this.ctx.db.query(
      `SELECT COUNT(*) AS count
       FROM multiremi_feishu_message_outcomes o
       JOIN multiremi_feishu_messages m ON m.message_id = o.message_id
       WHERE ${where}`,
    ).get(...args) as Row;
    const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 100)));
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const rows = this.ctx.db.query(
      `SELECT o.*, m.source_id AS summary_source_id, m.chat_id AS summary_chat_id,
              m.chat_name AS summary_chat_name, m.sender AS summary_sender,
              m.searchable_text AS summary_searchable_text,
              m.message_app_link AS summary_message_app_link,
              m.created_at AS summary_created_at
       FROM multiremi_feishu_message_outcomes o
       JOIN multiremi_feishu_messages m ON m.message_id = o.message_id
       WHERE ${where}
       ORDER BY o.created_at DESC, o.id DESC LIMIT ? OFFSET ?`,
    ).all(...args, limit, offset) as Row[];
    return {
      proposals: rows.map((row) => ({
        ...toIssueProposal(row),
        message: {
          messageId: String(row.message_id),
          sourceId: String(row.summary_source_id),
          chatId: String(row.summary_chat_id),
          chatName: nullableString(row.summary_chat_name),
          sender: parseJson<Record<string, unknown>>(row.summary_sender, {}),
          searchableText: String(row.summary_searchable_text ?? ""),
          messageAppLink: nullableString(row.summary_message_app_link),
          createdAt: String(row.summary_created_at),
        },
      })),
      total: Number(totalRow.count ?? 0),
    };
  }

  getSourceStatus(sourceId: string, now: Date = new Date()): MultiremiFeishuSourceStatus {
    const source = this.getSource(sourceId);
    if (!source) throw new Error(`Feishu source not found: ${sourceId}`);
    const connection = this.ctx.db.query(
      `SELECT last_successful_ingest_at, last_error_code, last_error_at,
              consecutive_failures, connection_alerted_at,
              connection_alert_delivery_failure_count,
              connection_alert_delivery_error_code,
              connection_alert_delivery_failed_at
       FROM multiremi_feishu_sources WHERE id = ?`,
    ).get(sourceId) as Row;
    const backlog = this.ctx.db.query(
      `SELECT COUNT(*) AS count, MIN(ingested_at) AS oldest, MAX(retry_count) AS maximum_retry_count
       FROM multiremi_feishu_messages
       WHERE source_id = ? AND processed_at IS NULL`,
    ).get(sourceId) as Row;
    const timedOut = this.ctx.db.query(
      `SELECT COUNT(*) AS count
       FROM multiremi_feishu_message_outcomes o
       JOIN multiremi_feishu_messages m ON m.message_id = o.message_id
       WHERE m.source_id = ? AND o.outcome_kind = 'dismissed' AND o.reason = 'unprocessed_timeout'`,
    ).get(sourceId) as Row;
    const mutedDeliveries = this.ctx.db.query(
      `SELECT COUNT(*) AS count
       FROM multiremi_feishu_message_outcomes o
       JOIN multiremi_feishu_messages m ON m.message_id = o.message_id
       WHERE m.source_id = ? AND o.outcome_kind = 'dismissed' AND o.reason = 'recipient_muted'`,
    ).get(sourceId) as Row;
    const pendingIssueProposals = this.ctx.db.query(
      `SELECT COUNT(*) AS count
       FROM multiremi_feishu_message_outcomes proposed
       JOIN multiremi_feishu_messages m ON m.message_id = proposed.message_id
       WHERE m.source_id = ? AND proposed.outcome_kind = 'issue_proposed'
         AND proposed.proposal_status = 'pending'
         AND NOT EXISTS (
           SELECT 1 FROM multiremi_feishu_message_outcomes terminal
           WHERE terminal.message_id = proposed.message_id
             AND terminal.outcome_kind IN ('issue_created', 'dismissed')
         )`,
    ).get(sourceId) as Row;
    const lastSuccessfulIngestAt = nullableString(connection.last_successful_ingest_at);
    const successfulAt = lastSuccessfulIngestAt ? Date.parse(lastSuccessfulIngestAt) : Number.NaN;
    return {
      sourceId,
      unprocessedCount: Number(backlog.count ?? 0),
      timedOutCount: Number(timedOut.count ?? 0),
      mutedDeliveryCount: Number(mutedDeliveries.count ?? 0),
      pendingIssueProposalCount: Number(pendingIssueProposals.count ?? 0),
      oldestUnprocessedAt: nullableString(backlog.oldest),
      maximumRetryCount: Number(backlog.maximum_retry_count ?? 0),
      lastSuccessfulIngestAt,
      lastErrorCode: nullableString(connection.last_error_code),
      lastErrorAt: nullableString(connection.last_error_at),
      lagSeconds: Number.isFinite(successfulAt)
        ? Math.max(0, Math.floor((now.getTime() - successfulAt) / 1_000))
        : null,
      consecutiveFailures: Number(connection.consecutive_failures ?? 0),
      connectionAlertedAt: nullableString(connection.connection_alerted_at),
      connectionAlertDeliveryFailureCount: Number(connection.connection_alert_delivery_failure_count ?? 0),
      connectionAlertDeliveryErrorCode: nullableString(connection.connection_alert_delivery_error_code),
      connectionAlertDeliveryFailedAt: nullableString(connection.connection_alert_delivery_failed_at),
    };
  }

  recordConnectionSuccess(sourceId: string, completedAt: string): void {
    this.ctx.db.run(
      `UPDATE multiremi_feishu_sources
       SET last_successful_ingest_at = ?, consecutive_failures = 0,
           connection_alerted_at = NULL,
           connection_alert_delivery_error_code = NULL,
           connection_alert_delivery_failed_at = NULL,
           updated_at = ?
       WHERE id = ?`,
      [completedAt, completedAt, sourceId],
    );
  }

  recordConnectionFailure(sourceId: string, errorCode: string, failedAt: string): MultiremiInboxItem | null {
    const normalizedCode = normalizeConnectionErrorCode(errorCode);
    return this.ctx.db.transaction(() => {
      this.ctx.db.run(
        `UPDATE multiremi_feishu_sources
         SET last_error_code = ?, last_error_at = ?,
             consecutive_failures = consecutive_failures + 1, updated_at = ?
         WHERE id = ?`,
        [normalizedCode, failedAt, failedAt, sourceId],
      );
      const source = this.ctx.db.query(
        `SELECT id, workspace_id, name, consecutive_failures, connection_alerted_at
         FROM multiremi_feishu_sources WHERE id = ?`,
      ).get(sourceId) as Row | null;
      if (!source
        || Number(source.consecutive_failures ?? 0) < CONNECTION_ALERT_THRESHOLD
        || nullableString(source.connection_alerted_at)) return null;
      const recipient = this.ctx.db.query(
        `SELECT id FROM multiremi_workspace_members
         WHERE workspace_id = ? AND archived_at IS NULL
         ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
                  created_at ASC, id ASC
         LIMIT 1`,
      ).get(String(source.workspace_id)) as Row | null;
      if (!recipient) {
        this.recordConnectionAlertDeliveryFailure(sourceId, failedAt, "alert_recipient_unavailable");
        return null;
      }
      const item = this.ctx.createInboxItem({
        workspaceId: String(source.workspace_id),
        memberId: String(recipient.id),
        severity: "attention",
        type: "feishu_ingest_connection_alert",
        title: "飞书消息源连接异常",
        body: `消息源 ${String(source.name)} 连续拉取失败，请检查 sidecar 连接。`,
        actorType: "system",
        actorId: null,
        details: {
          source_id: sourceId,
          error_code: normalizedCode,
          consecutive_failures: Number(source.consecutive_failures),
        },
        emitEvent: true,
        bypassMute: true,
      });
      if (!item) {
        this.recordConnectionAlertDeliveryFailure(sourceId, failedAt, "alert_inbox_create_failed");
        return null;
      }
      this.ctx.db.run(
        `UPDATE multiremi_feishu_sources
         SET connection_alerted_at = ?,
             connection_alert_delivery_error_code = NULL,
             connection_alert_delivery_failed_at = NULL,
             updated_at = ?
         WHERE id = ? AND connection_alerted_at IS NULL`,
        [failedAt, failedAt, sourceId],
      );
      return item;
    })();
  }

  private recordConnectionAlertDeliveryFailure(sourceId: string, failedAt: string, errorCode: string): void {
    const normalizedCode = normalizeConnectionErrorCode(errorCode);
    this.ctx.db.run(
      `UPDATE multiremi_feishu_sources
       SET connection_alert_delivery_failure_count = connection_alert_delivery_failure_count + 1,
           connection_alert_delivery_error_code = ?,
           connection_alert_delivery_failed_at = ?,
           updated_at = ?
       WHERE id = ?`,
      [normalizedCode, failedAt, failedAt, sourceId],
    );
    log.warn(`Feishu connection alert delivery failed for source ${sourceId}: ${normalizedCode}`);
  }

  hasDueUnprocessedMessages(sourceId: string, now: Date): boolean {
    const source = this.getSource(sourceId);
    if (!source) return false;
    const cutoff = new Date(now.getTime() - source.unprocessedRetrySeconds * 1_000).toISOString();
    const row = this.ctx.db.query(
      `SELECT 1 AS found FROM multiremi_feishu_messages
       WHERE source_id = ? AND processed_at IS NULL
         AND COALESCE(last_retry_at, ingested_at) <= ?
       LIMIT 1`,
    ).get(sourceId, cutoff) as Row | null;
    return Boolean(row);
  }

  reconcileUnprocessedMessages(
    sourceId: string,
    now: Date,
    limit = 500,
  ): ReconcileFeishuUnprocessedResult {
    const source = this.getSource(sourceId);
    if (!source) throw new Error(`Feishu source not found: ${sourceId}`);
    const reconciledAt = now.toISOString();
    const cutoff = new Date(now.getTime() - source.unprocessedRetrySeconds * 1_000).toISOString();
    return this.ctx.db.transaction(() => {
      const rows = this.ctx.db.query(
        `SELECT message_id, retry_count FROM multiremi_feishu_messages
         WHERE source_id = ? AND processed_at IS NULL
           AND COALESCE(last_retry_at, ingested_at) <= ?
         ORDER BY ingested_at ASC, message_id ASC
         LIMIT ?`,
      ).all(sourceId, cutoff, Math.max(1, Math.min(2_000, Math.floor(limit)))) as Row[];
      let retried = 0;
      let dismissed = 0;
      for (const row of rows) {
        const messageId = String(row.message_id);
        const retryCount = Number(row.retry_count ?? 0);
        if (retryCount >= source.unprocessedRetryLimit) {
          const changed = this.ctx.db.run(
            `UPDATE multiremi_feishu_messages SET processed_at = ?
             WHERE message_id = ? AND processed_at IS NULL AND retry_count = ?
               AND COALESCE(last_retry_at, ingested_at) <= ?`,
            [reconciledAt, messageId, retryCount, cutoff],
          ).changes;
          if (!changed) continue;
          this.insertOutcome({
            workspaceId: source.workspaceId,
            messageId,
            outcomeKind: "dismissed",
            ref: null,
            reason: "unprocessed_timeout",
            taskId: null,
            createdAt: reconciledAt,
          });
          dismissed += 1;
          continue;
        }
        retried += this.ctx.db.run(
          `UPDATE multiremi_feishu_messages
           SET retry_count = retry_count + 1, last_retry_at = ?
           WHERE message_id = ? AND processed_at IS NULL AND retry_count = ?
             AND COALESCE(last_retry_at, ingested_at) <= ?`,
          [reconciledAt, messageId, retryCount, cutoff],
        ).changes;
      }
      const eventId = retried > 0
        ? this.createMessagesIngestedEvent(source, retried, reconciledAt, { retry: true })
        : null;
      return { retried, dismissed, eventId };
    })();
  }

  resolveMessage(messageId: string, input: ResolveMultiremiFeishuMessageInput): {
    message: MultiremiFeishuMessage;
    outcome: MultiremiFeishuMessageOutcome;
  } {
    if (!OUTCOME_KINDS.has(input.outcome)) throw new Error("invalid Feishu message outcome");
    if (["issue_proposed", "issue_created", "notified", "reply_drafted"].includes(input.outcome)) {
      throw new Error(`${input.outcome} outcomes must use the dedicated Feishu command`);
    }
    const workspaceId = cleanOptionalString(input.workspaceId ?? input.workspace_id) ?? "local";
    const ref = cleanOptionalString(input.ref);
    const reason = cleanOptionalString(input.reason);
    const taskId = cleanOptionalString(input.taskId ?? input.task_id);
    if (ref) throw new Error("ref is assigned only by dedicated Feishu outcome commands");
    if (["ignored", "dismissed"].includes(input.outcome) && !reason) {
      throw new Error(`reason is required for ${input.outcome} outcomes`);
    }
    return this.ctx.db.transaction(() => {
      const message = this.getMessage(messageId);
      if (!message || message.workspaceId !== workspaceId) throw new Error(`Feishu message not found: ${messageId}`);
      this.assertTaskWorkspace(taskId, workspaceId);
      const createdAt = nowIso();
      const outcome = this.insertOutcome({
        workspaceId,
        messageId,
        outcomeKind: input.outcome,
        ref,
        reason,
        taskId,
        createdAt,
      });
      this.markMessageProcessed(messageId, createdAt);
      return { message: this.getMessage(messageId)!, outcome };
    })();
  }

  createInboxOutcome(
    messageId: string,
    outcomeKind: "notified" | "reply_drafted",
    input: CreateFeishuInboxOutcomeInput,
  ): CreateFeishuInboxOutcomeResult {
    const text = cleanRequiredText(input.text, outcomeKind === "notified" ? "summary" : "draft_text");
    return this.ctx.db.transaction(() => {
      const message = this.getMessage(messageId);
      if (!message || message.workspaceId !== input.workspaceId) {
        throw new Error(`Feishu message not found: ${messageId}`);
      }
      const taskId = cleanOptionalString(input.taskId);
      this.assertTaskWorkspace(taskId, input.workspaceId);
      const inboxType = outcomeKind === "reply_drafted" ? "feishu_reply_draft" : "feishu_message_notification";
      const recipient = this.ctx.resolveWorkspaceMemberForNotification(input.workspaceId, input.recipientId);
      if (!recipient || recipient.archivedAt) throw new Error("Inbox recipient is unavailable");
      const dismissMutedDelivery = (): CreateFeishuInboxOutcomeResult => {
        const createdAt = nowIso();
        const outcome = this.insertOutcome({
          workspaceId: input.workspaceId,
          messageId,
          outcomeKind: "dismissed",
          ref: null,
          reason: "recipient_muted",
          taskId,
          createdAt,
        });
        this.markMessageProcessed(messageId, createdAt);
        return { message: this.getMessage(messageId)!, outcome, inboxItem: null, delivered: false };
      };
      if (this.ctx.isNotificationMuted(input.workspaceId, recipient.id, inboxType)) {
        return dismissMutedDelivery();
      }
      const inboxItemInput = {
        workspaceId: input.workspaceId,
        memberId: recipient.id,
        body: text,
        actorType: input.actorType,
        actorId: input.actorId,
        details: {
          message_id: message.messageId,
          source_id: message.sourceId,
          chat_id: message.chatId,
          message_app_link: message.messageAppLink,
          outcome_kind: outcomeKind,
        },
        emitEvent: false,
      };
      let inboxItem: MultiremiInboxItem | null;
      if (outcomeKind === "reply_drafted") {
        inboxItem = this.ctx.createInboxItem({
          ...inboxItemInput,
          severity: "attention",
          type: "feishu_reply_draft",
          title: "飞书回复草稿",
        });
      } else {
        inboxItem = this.ctx.createInboxItem({
          ...inboxItemInput,
          severity: "info",
          type: "feishu_message_notification",
          title: "飞书消息提醒",
        });
      }
      if (!inboxItem) {
        if (this.ctx.isNotificationMuted(input.workspaceId, recipient.id, inboxType)) {
          return dismissMutedDelivery();
        }
        throw new Error("Inbox recipient is unavailable");
      }
      const createdAt = nowIso();
      const outcome = this.insertOutcome({
        workspaceId: input.workspaceId,
        messageId,
        outcomeKind,
        ref: `inbox:${inboxItem.id}`,
        reason: null,
        taskId,
        createdAt,
      });
      this.markMessageProcessed(messageId, createdAt);
      return { message: this.getMessage(messageId)!, outcome, inboxItem, delivered: true };
    })();
  }

  createIssueOutcome(
    messageId: string,
    input: CreateFeishuIssueOutcomeInput,
  ): CreateFeishuIssueOutcomeResult {
    const issueInput = normalizeIssueProposalInput(input);
    return this.ctx.db.transaction(() => this.createIssueOutcomeWithinTransaction(messageId, {
      ...issueInput,
      workspaceId: input.workspaceId,
      taskId: cleanOptionalString(input.taskId),
      createdBy: cleanOptionalString(input.createdBy),
    }))();
  }

  createIssueProposal(
    messageId: string,
    input: CreateFeishuIssueProposalInput,
  ): CreateFeishuIssueProposalResult {
    const issueInput = normalizeIssueProposalInput(input);
    return this.ctx.db.transaction(() => {
      const message = this.getMessage(messageId);
      if (!message || message.workspaceId !== input.workspaceId) {
        throw new Error(`Feishu message not found: ${messageId}`);
      }
      const taskId = cleanOptionalString(input.taskId);
      this.assertTaskWorkspace(taskId, input.workspaceId);
      this.lockMessage(messageId);
      const existingRow = this.ctx.db.query(
        `SELECT * FROM multiremi_feishu_message_outcomes
         WHERE message_id = ? AND outcome_kind = 'issue_proposed'
         ORDER BY created_at ASC, id ASC LIMIT 1`,
      ).get(messageId) as Row | null;
      if (existingRow) {
        const outcome = toOutcome(existingRow);
        return {
          message: this.getMessage(messageId)!,
          outcome,
          proposal: toIssueProposal(existingRow),
          inboxItem: null,
          delivered: true,
          created: false,
        };
      }
      const recipient = this.ctx.resolveWorkspaceMemberForNotification(input.workspaceId, input.recipientId);
      if (!recipient || recipient.archivedAt) throw new Error("Inbox recipient is unavailable");
      const dismissMutedProposal = (): CreateFeishuIssueProposalResult => {
        const createdAt = nowIso();
        const outcome = this.insertOutcome({
          workspaceId: input.workspaceId,
          messageId,
          outcomeKind: "dismissed",
          ref: null,
          reason: "recipient_muted",
          taskId,
          createdAt,
        });
        this.markMessageProcessed(messageId, createdAt);
        return {
          message: this.getMessage(messageId)!,
          outcome,
          proposal: null,
          inboxItem: null,
          delivered: false,
          created: true,
        };
      };
      const inboxType = "feishu_issue_proposal";
      if (this.ctx.isNotificationMuted(input.workspaceId, recipient.id, inboxType)) {
        return dismissMutedProposal();
      }
      const proposalId = createId("fout");
      const inboxItem = this.ctx.createInboxItem({
        workspaceId: input.workspaceId,
        memberId: recipient.id,
        severity: "attention",
        type: "feishu_issue_proposal",
        title: "建议创建 Issue",
        body: issueInput.title,
        actorType: input.actorType,
        actorId: input.actorId,
        details: {
          proposal_id: proposalId,
          proposed_issue: issueInput,
          message_id: message.messageId,
          source_id: message.sourceId,
          chat_id: message.chatId,
          message_app_link: message.messageAppLink,
          outcome_kind: "issue_proposed",
        },
        emitEvent: false,
      });
      if (!inboxItem) {
        if (this.ctx.isNotificationMuted(input.workspaceId, recipient.id, inboxType)) {
          return dismissMutedProposal();
        }
        throw new Error("Inbox recipient is unavailable");
      }
      const createdAt = nowIso();
      const outcome = this.insertOutcome({
        id: proposalId,
        workspaceId: input.workspaceId,
        messageId,
        outcomeKind: "issue_proposed",
        ref: `inbox:${inboxItem.id}`,
        reason: null,
        taskId,
        createdAt,
        proposalPayload: issueInput,
        proposalStatus: "pending",
      });
      this.markMessageProcessed(messageId, createdAt);
      const row = this.getIssueProposalRow(proposalId, input.workspaceId);
      return {
        message: this.getMessage(messageId)!,
        outcome,
        proposal: toIssueProposal(row),
        inboxItem,
        delivered: true,
        created: true,
      };
    })();
  }

  approveIssueProposal(
    proposalId: string,
    input: { workspaceId: string; approvedBy: string },
  ): ResolveFeishuIssueProposalResult {
    return this.ctx.db.transaction(() => {
      let proposal = toIssueProposal(this.getIssueProposalRow(proposalId, input.workspaceId));
      this.lockMessage(proposal.messageId);
      proposal = toIssueProposal(this.getIssueProposalRow(proposalId, input.workspaceId));
      if (proposal.status === "rejected") throw new Error("Feishu issue proposal is already rejected");
      const result = this.createIssueOutcomeWithinTransaction(proposal.messageId, {
        ...proposal.issue,
        workspaceId: input.workspaceId,
        taskId: null,
        createdBy: input.approvedBy,
      });
      const resolvedAt = nowIso();
      this.ctx.db.run(
        `UPDATE multiremi_feishu_message_outcomes
         SET proposal_status = 'approved', proposal_resolved_at = COALESCE(proposal_resolved_at, ?),
             proposal_resolved_by = COALESCE(proposal_resolved_by, ?)
         WHERE id = ? AND outcome_kind = 'issue_proposed'`,
        [resolvedAt, input.approvedBy, proposalId],
      );
      this.markProposalInboxHandled(proposal.inboxItemId);
      return {
        ...result,
        proposal: toIssueProposal(this.getIssueProposalRow(proposalId, input.workspaceId)),
      };
    })();
  }

  rejectIssueProposal(
    proposalId: string,
    input: { workspaceId: string; rejectedBy: string },
  ): ResolveFeishuIssueProposalResult {
    return this.ctx.db.transaction(() => {
      let proposal = toIssueProposal(this.getIssueProposalRow(proposalId, input.workspaceId));
      this.lockMessage(proposal.messageId);
      proposal = toIssueProposal(this.getIssueProposalRow(proposalId, input.workspaceId));
      if (proposal.status === "approved") throw new Error("Feishu issue proposal is already approved");
      const existingRow = this.ctx.db.query(
        `SELECT * FROM multiremi_feishu_message_outcomes
         WHERE message_id = ? AND outcome_kind = 'dismissed' AND reason = 'proposal_rejected'
         ORDER BY created_at ASC, id ASC LIMIT 1`,
      ).get(proposal.messageId) as Row | null;
      const createdAt = nowIso();
      const outcome = existingRow ? toOutcome(existingRow) : this.insertOutcome({
        workspaceId: input.workspaceId,
        messageId: proposal.messageId,
        outcomeKind: "dismissed",
        ref: null,
        reason: "proposal_rejected",
        taskId: null,
        createdAt,
      });
      this.ctx.db.run(
        `UPDATE multiremi_feishu_message_outcomes
         SET proposal_status = 'rejected', proposal_resolved_at = COALESCE(proposal_resolved_at, ?),
             proposal_resolved_by = COALESCE(proposal_resolved_by, ?)
         WHERE id = ? AND outcome_kind = 'issue_proposed'`,
        [createdAt, input.rejectedBy, proposalId],
      );
      this.markProposalInboxHandled(proposal.inboxItemId);
      this.markMessageProcessed(proposal.messageId, createdAt);
      return {
        message: this.getMessage(proposal.messageId)!,
        proposal: toIssueProposal(this.getIssueProposalRow(proposalId, input.workspaceId)),
        outcome,
        issue: null,
        created: !existingRow,
      };
    })();
  }

  private createIssueOutcomeWithinTransaction(
    messageId: string,
    input: CreateFeishuIssueOutcomeInput,
  ): CreateFeishuIssueOutcomeResult {
    const message = this.getMessage(messageId);
    if (!message || message.workspaceId !== input.workspaceId) {
      throw new Error(`Feishu message not found: ${messageId}`);
    }
    const taskId = cleanOptionalString(input.taskId);
    this.assertTaskWorkspace(taskId, input.workspaceId);
    this.lockMessage(messageId);
    const existingRow = this.ctx.db.query(
      `SELECT * FROM multiremi_feishu_message_outcomes
       WHERE message_id = ? AND outcome_kind = 'issue_created'
       ORDER BY created_at ASC, id ASC LIMIT 1`,
    ).get(messageId) as Row | null;
    if (existingRow) {
      const outcome = toOutcome(existingRow);
      const issueId = outcome.ref?.startsWith("issue:") ? outcome.ref.slice("issue:".length) : "";
      const issue = issueId ? this.ctx.issues().getIssue(issueId) : null;
      if (!issue || issue.workspaceId !== input.workspaceId) {
        throw new Error("existing Feishu issue outcome is invalid");
      }
      return { message: this.getMessage(messageId)!, outcome, issue, created: false };
    }
    const issue = this.ctx.issues().createIssue({
      title: input.title,
      description: input.description ?? null,
      priority: input.priority,
      workspaceId: input.workspaceId,
      projectId: input.projectId ?? input.project_id ?? null,
      assigneeType: input.assigneeType ?? input.assignee_type ?? null,
      assigneeId: input.assigneeId ?? input.assignee_id ?? null,
      contextRefs: [{
        type: "feishu_message",
        message_id: message.messageId,
        source_id: message.sourceId,
        chat_id: message.chatId,
        message_app_link: message.messageAppLink,
      }],
      createdBy: cleanOptionalString(input.createdBy),
    });
    const createdAt = nowIso();
    const outcome = this.insertOutcome({
      workspaceId: input.workspaceId,
      messageId,
      outcomeKind: "issue_created",
      ref: `issue:${issue.id}`,
      reason: null,
      taskId,
      createdAt,
    });
    this.markMessageProcessed(messageId, createdAt);
    return { message: this.getMessage(messageId)!, outcome, issue, created: true };
  }

  private lockMessage(messageId: string): void {
    // UPDATE is deliberately a no-op: it locks this message row on Postgres.
    this.ctx.db.run(
      "UPDATE multiremi_feishu_messages SET processed_at = processed_at WHERE message_id = ?",
      [messageId],
    );
  }

  private getIssueProposalRow(proposalId: string, workspaceId: string): Row {
    const row = this.ctx.db.query(
      `SELECT * FROM multiremi_feishu_message_outcomes
       WHERE id = ? AND workspace_id = ? AND outcome_kind = 'issue_proposed'`,
    ).get(proposalId, workspaceId) as Row | null;
    if (!row) throw new Error(`Feishu issue proposal not found: ${proposalId}`);
    return row;
  }

  private markProposalInboxHandled(inboxItemId: string | null): void {
    if (!inboxItemId) return;
    this.ctx.db.run(
      "UPDATE multiremi_inbox_items SET read = 1, archived = 1 WHERE id = ?",
      [inboxItemId],
    );
  }

  private assertTaskWorkspace(taskId: string | null, workspaceId: string): void {
    if (!taskId) return;
    const task = this.ctx.db.query("SELECT workspace_id FROM multiremi_tasks WHERE id = ?").get(taskId) as Row | null;
    if (!task || String(task.workspace_id) !== workspaceId) {
      throw new Error("task_id must reference a task in this workspace");
    }
  }

  private insertOutcome(input: {
    id?: string;
    workspaceId: string;
    messageId: string;
    outcomeKind: MultiremiFeishuMessageOutcomeKind;
    ref: string | null;
    reason: string | null;
    taskId: string | null;
    createdAt: string;
    proposalPayload?: CreateIssueFromMultiremiFeishuMessageInput;
    proposalStatus?: "pending" | "approved" | "rejected" | "not_applicable";
  }): MultiremiFeishuMessageOutcome {
    const id = input.id ?? createId("fout");
    this.ctx.db.run(
      `INSERT INTO multiremi_feishu_message_outcomes (
        id, workspace_id, message_id, outcome_kind, ref, reason, task_id,
        proposal_payload, proposal_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.workspaceId,
        input.messageId,
        input.outcomeKind,
        input.ref,
        input.reason,
        input.taskId,
        toJson(input.proposalPayload ?? {}),
        input.proposalStatus ?? "not_applicable",
        input.createdAt,
      ],
    );
    const row = this.ctx.db.query("SELECT * FROM multiremi_feishu_message_outcomes WHERE id = ?").get(id) as Row | null;
    if (!row) throw new Error("Feishu message outcome insert failed");
    return toOutcome(row);
  }

  private markMessageProcessed(messageId: string, processedAt: string): void {
    this.ctx.db.run(
      "UPDATE multiremi_feishu_messages SET processed_at = COALESCE(processed_at, ?) WHERE message_id = ?",
      [processedAt, messageId],
    );
  }

  private createMessagesIngestedEvent(
    source: MultiremiFeishuSource,
    messageCount: number,
    createdAt: string,
    extraPayload: Record<string, unknown> = {},
  ): string {
    const eventId = createId("sev");
    this.ctx.db.run(
      `INSERT INTO multiremi_system_events (
        id, workspace_id, resource, event, resource_id, project_id, payload,
        status, attempt_count, available_at, lease_until, last_error, created_at, processed_at
      ) VALUES (?, ?, 'feishu_source', 'messages_ingested', ?, NULL, ?, 'pending', 0, ?, NULL, NULL, ?, NULL)`,
      [
        eventId,
        source.workspaceId,
        source.id,
        toJson({ source_id: source.id, message_count: messageCount, ...extraPayload }),
        createdAt,
        createdAt,
      ],
    );
    return eventId;
  }

  deleteExpiredMessages(now: Date = new Date()): number {
    return this.ctx.db.transaction(() => {
      let deleted = 0;
      for (const source of this.listSources()) {
        const cutoff = new Date(now.getTime() - source.retentionDays * 24 * 60 * 60 * 1_000).toISOString();
        // Keep retention behavior deterministic even when a SQLite deployment
        // has not enabled foreign-key enforcement for this connection.
        this.ctx.db.run(
          `DELETE FROM multiremi_feishu_message_outcomes
           WHERE message_id IN (
             SELECT message_id FROM multiremi_feishu_messages
             WHERE source_id = ? AND ingested_at < ?
           )`,
          [source.id, cutoff],
        );
        deleted += this.ctx.db.run(
          "DELETE FROM multiremi_feishu_messages WHERE source_id = ? AND ingested_at < ?",
          [source.id, cutoff],
        ).changes;
      }
      return deleted;
    })();
  }
}

function normalizeAllowlist(
  values: Array<string | Partial<MultiremiFeishuAllowlistEntry>>,
  current: readonly MultiremiFeishuAllowlistEntry[],
  now: string,
): MultiremiFeishuAllowlistEntry[] {
  const existing = new Map(current.map((entry) => [entry.chatId, entry.addedAt]));
  const normalized = new Map<string, MultiremiFeishuAllowlistEntry>();
  for (const value of values) {
    const chatId = typeof value === "string" ? value.trim() : cleanOptionalString(value.chatId);
    if (!chatId || !/^oc_[A-Za-z0-9_-]{4,128}$/u.test(chatId)) {
      throw new Error("Feishu allowlist entries must use a valid chat_id");
    }
    const requestedAddedAt = typeof value === "object" && value ? cleanOptionalString(value.addedAt) : null;
    const addedAt = existing.get(chatId) ?? (requestedAddedAt ? normalizeTimestamp(requestedAddedAt, "addedAt") : now);
    normalized.set(chatId, { chatId, addedAt });
  }
  return [...normalized.values()].sort((left, right) => left.chatId.localeCompare(right.chatId));
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}

function normalizeRetentionDays(value: unknown): number {
  const parsed = value === undefined ? 90 : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 3650) {
    throw new Error("Feishu source retention_days must be between 1 and 3650");
  }
  return parsed;
}

function normalizePollInterval(value: unknown): number {
  const parsed = value === undefined ? 15 : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 3 || parsed > 3600) {
    throw new Error("Feishu source poll_interval_seconds must be between 3 and 3600");
  }
  return parsed;
}

function normalizeUnprocessedRetrySeconds(value: unknown): number {
  const parsed = value === undefined ? 900 : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 60 || parsed > 86_400) {
    throw new Error("Feishu source unprocessed_retry_seconds must be between 60 and 86400");
  }
  return parsed;
}

function normalizeUnprocessedRetryLimit(value: unknown): number {
  const parsed = value === undefined ? 3 : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 20) {
    throw new Error("Feishu source unprocessed_retry_limit must be between 1 and 20");
  }
  return parsed;
}

function normalizeTimestamp(value: string, field: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${field} must be an RFC3339 timestamp`);
  return new Date(timestamp).toISOString();
}

function cleanRequiredText(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${field} is required`);
  if (text.length > 20_000) throw new Error(`${field} must not exceed 20000 characters`);
  return text;
}

function normalizeIssueProposalInput(
  input: CreateIssueFromMultiremiFeishuMessageInput,
): CreateIssueFromMultiremiFeishuMessageInput {
  const title = cleanRequiredText(input.title, "title");
  const description = cleanOptionalString(input.description);
  if (description && description.length > 20_000) {
    throw new Error("description must not exceed 20000 characters");
  }
  return {
    title,
    description,
    priority: cleanOptionalString(input.priority) ?? undefined,
    projectId: cleanOptionalString(input.projectId ?? input.project_id),
    assigneeType: input.assigneeType ?? input.assignee_type ?? null,
    assigneeId: cleanOptionalString(input.assigneeId ?? input.assignee_id),
  };
}

function normalizeConnectionErrorCode(value: unknown): string {
  const code = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-z0-9][a-z0-9_.-]{0,127}$/u.test(code) ? code : "ingest_failed";
}

function encodeCursor(value: Record<string, unknown> | null): string | null {
  return value == null ? null : toJson(value);
}

function toSource(row: Row): MultiremiFeishuSource {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    name: String(row.name ?? ""),
    type: "personal_automation",
    endpointName: String(row.endpoint_name),
    allowlist: parseJson<MultiremiFeishuAllowlistEntry[]>(row.allowlist, []),
    enabled: Number(row.enabled ?? 0) === 1,
    retentionDays: Number(row.retention_days ?? 90),
    pollIntervalSeconds: Number(row.poll_interval_seconds ?? 15),
    unprocessedRetrySeconds: Number(row.unprocessed_retry_seconds ?? 900),
    unprocessedRetryLimit: Number(row.unprocessed_retry_limit ?? 3),
    accessTokenSet: Boolean(row.access_token_encrypted),
    accessTokenHint: nullableString(row.access_token_hint),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toCursor(row: Row): MultiremiFeishuSyncCursor {
  return {
    sourceId: String(row.source_id),
    stream: String(row.stream),
    cursor: parseJson<Record<string, unknown> | null>(row.cursor, null),
    watermark: nullableString(row.watermark),
    lastStartedAt: nullableString(row.last_started_at),
    lastCompletedAt: nullableString(row.last_completed_at),
    lastError: nullableString(row.last_error),
    leaseOwner: nullableString(row.lease_owner),
    leaseUntil: nullableString(row.lease_until),
    leaseToken: nullableString(row.lease_token),
    updatedAt: String(row.updated_at),
  };
}

function toMessage(row: Row): MultiremiFeishuMessage {
  return {
    messageId: String(row.message_id),
    workspaceId: String(row.workspace_id ?? "local"),
    sourceId: String(row.source_id),
    chatId: String(row.chat_id),
    chatType: nullableString(row.chat_type),
    chatName: nullableString(row.chat_name),
    threadId: nullableString(row.thread_id),
    rootId: nullableString(row.root_id),
    parentId: nullableString(row.parent_id),
    sender: parseJson<Record<string, unknown>>(row.sender, {}),
    content: parseJson<Record<string, unknown>>(row.content, {}),
    searchableText: String(row.searchable_text ?? ""),
    contentFingerprint: String(row.content_fingerprint),
    messageAppLink: nullableString(row.message_app_link),
    createdAt: String(row.created_at),
    updatedAt: nullableString(row.updated_at),
    recalled: Number(row.recalled ?? 0) === 1,
    edited: Number(row.edited ?? 0) === 1,
    ingestedAt: String(row.ingested_at),
    processedAt: nullableString(row.processed_at),
    retryCount: Number(row.retry_count ?? 0),
    lastRetryAt: nullableString(row.last_retry_at),
  };
}

function toOutcome(row: Row): MultiremiFeishuMessageOutcome {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    messageId: String(row.message_id),
    outcomeKind: String(row.outcome_kind) as MultiremiFeishuMessageOutcomeKind,
    ref: nullableString(row.ref),
    reason: nullableString(row.reason),
    taskId: nullableString(row.task_id),
    createdAt: String(row.created_at),
  };
}

function toIssueProposal(row: Row): MultiremiFeishuIssueProposal {
  const status = String(row.proposal_status ?? "pending");
  if (status !== "pending" && status !== "approved" && status !== "rejected") {
    throw new Error("Feishu issue proposal has invalid status");
  }
  const outcome = toOutcome(row);
  return {
    id: outcome.id,
    workspaceId: outcome.workspaceId,
    messageId: outcome.messageId,
    inboxItemId: outcome.ref?.startsWith("inbox:") ? outcome.ref.slice("inbox:".length) : null,
    issue: parseJson<CreateIssueFromMultiremiFeishuMessageInput>(row.proposal_payload, { title: "" }),
    status,
    resolvedAt: nullableString(row.proposal_resolved_at),
    resolvedBy: nullableString(row.proposal_resolved_by),
    createdAt: outcome.createdAt,
  };
}
