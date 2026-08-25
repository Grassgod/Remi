import { createId, nowIso } from "@multiremi/ids.js";
import type { StoreContext } from "@multiremi/store/context.js";
import { cleanOptionalString, nullableString, parseJson, toJson } from "@multiremi/store/helpers.js";
import { normalizeFeishuSidecarEndpointName } from "@multiremi/feishu-ingest/endpoints.js";
import type {
  CreateIssueFromMultiremiFeishuMessageInput,
  CreateMultiremiFeishuSourceInput,
  MultiremiFeishuAllowlistEntry,
  MultiremiFeishuMessage,
  MultiremiFeishuMessageOutcome,
  MultiremiFeishuMessageOutcomeKind,
  MultiremiFeishuSource,
  MultiremiFeishuSyncCursor,
  MultiremiInboxItem,
  MultiremiIssue,
  MultiremiFeishuSourceStatus,
  ResolveMultiremiFeishuMessageInput,
  UpdateMultiremiFeishuSourceInput,
} from "@multiremi/contracts/types.js";

type Row = Record<string, unknown>;

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
  inboxItem: MultiremiInboxItem;
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

export interface ReconcileFeishuUnprocessedResult {
  retried: number;
  dismissed: number;
  eventId: string | null;
}

const OUTCOME_KINDS = new Set<MultiremiFeishuMessageOutcomeKind>([
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

  listMessages(input: {
    workspaceId: string;
    unprocessed?: boolean;
    since?: string | null;
    until?: string | null;
    chatId?: string | null;
    limit?: number;
  }): MultiremiFeishuMessage[] {
    const clauses = ["workspace_id = ?"];
    const args: unknown[] = [input.workspaceId];
    if (input.unprocessed) clauses.push("processed_at IS NULL");
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
    const rows = this.ctx.db.query(
      `SELECT * FROM multiremi_feishu_messages
       WHERE ${clauses.join(" AND ")}
       ORDER BY created_at ASC, message_id ASC LIMIT ?`,
    ).all(...args, limit) as Row[];
    return rows.map(toMessage);
  }

  listMessageOutcomes(messageId: string): MultiremiFeishuMessageOutcome[] {
    const rows = this.ctx.db.query(
      "SELECT * FROM multiremi_feishu_message_outcomes WHERE message_id = ? ORDER BY created_at ASC, id ASC",
    ).all(messageId) as Row[];
    return rows.map(toOutcome);
  }

  getSourceStatus(sourceId: string, now: Date = new Date()): MultiremiFeishuSourceStatus {
    const source = this.getSource(sourceId);
    if (!source) throw new Error(`Feishu source not found: ${sourceId}`);
    const connection = this.ctx.db.query(
      `SELECT last_successful_ingest_at, last_error_code, last_error_at,
              consecutive_failures, connection_alerted_at
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
    const lastSuccessfulIngestAt = nullableString(connection.last_successful_ingest_at);
    const successfulAt = lastSuccessfulIngestAt ? Date.parse(lastSuccessfulIngestAt) : Number.NaN;
    return {
      sourceId,
      unprocessedCount: Number(backlog.count ?? 0),
      timedOutCount: Number(timedOut.count ?? 0),
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
    };
  }

  recordConnectionSuccess(sourceId: string, completedAt: string): void {
    this.ctx.db.run(
      `UPDATE multiremi_feishu_sources
       SET last_successful_ingest_at = ?, consecutive_failures = 0,
           connection_alerted_at = NULL, updated_at = ?
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
      if (!recipient) return null;
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
      });
      if (!item) return null;
      this.ctx.db.run(
        `UPDATE multiremi_feishu_sources SET connection_alerted_at = ?, updated_at = ?
         WHERE id = ? AND connection_alerted_at IS NULL`,
        [failedAt, failedAt, sourceId],
      );
      return item;
    })();
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
    if (["issue_created", "notified", "reply_drafted"].includes(input.outcome)) {
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
      const inboxItem = this.ctx.createInboxItem({
        workspaceId: input.workspaceId,
        memberId: input.recipientId,
        severity: outcomeKind === "reply_drafted" ? "attention" : "info",
        type: outcomeKind === "reply_drafted" ? "feishu_reply_draft" : "feishu_message_notification",
        title: outcomeKind === "reply_drafted" ? "飞书回复草稿" : "飞书消息提醒",
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
      });
      if (!inboxItem) throw new Error("Inbox recipient is unavailable or notifications are muted");
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
      return { message: this.getMessage(messageId)!, outcome, inboxItem };
    })();
  }

  createIssueOutcome(
    messageId: string,
    input: CreateFeishuIssueOutcomeInput,
  ): CreateFeishuIssueOutcomeResult {
    const title = cleanRequiredText(input.title, "title");
    return this.ctx.db.transaction(() => {
      const message = this.getMessage(messageId);
      if (!message || message.workspaceId !== input.workspaceId) {
        throw new Error(`Feishu message not found: ${messageId}`);
      }
      const taskId = cleanOptionalString(input.taskId);
      this.assertTaskWorkspace(taskId, input.workspaceId);
      // UPDATE is deliberately a no-op: it locks this message row on Postgres,
      // making retries and concurrent workers observe an already-created outcome.
      this.ctx.db.run(
        "UPDATE multiremi_feishu_messages SET processed_at = processed_at WHERE message_id = ?",
        [messageId],
      );
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
        title,
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
    })();
  }

  private assertTaskWorkspace(taskId: string | null, workspaceId: string): void {
    if (!taskId) return;
    const task = this.ctx.db.query("SELECT workspace_id FROM multiremi_tasks WHERE id = ?").get(taskId) as Row | null;
    if (!task || String(task.workspace_id) !== workspaceId) {
      throw new Error("task_id must reference a task in this workspace");
    }
  }

  private insertOutcome(input: {
    workspaceId: string;
    messageId: string;
    outcomeKind: MultiremiFeishuMessageOutcomeKind;
    ref: string | null;
    reason: string | null;
    taskId: string | null;
    createdAt: string;
  }): MultiremiFeishuMessageOutcome {
    const id = createId("fout");
    this.ctx.db.run(
      `INSERT INTO multiremi_feishu_message_outcomes (
        id, workspace_id, message_id, outcome_kind, ref, reason, task_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.workspaceId, input.messageId, input.outcomeKind, input.ref, input.reason, input.taskId, input.createdAt],
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
