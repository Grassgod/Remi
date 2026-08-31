import { createHash } from "node:crypto";
import type {
  CanonicalMessage,
  MessageConnection,
  MessageConversationSummary,
  MessageErrorCode,
  MessageOutcome,
  MessageOutcomeKind,
  MessageProposalStatus,
  MessageSource,
} from "@multiremi/contracts/messaging.js";
import type { MessageSyncCursor } from "@multiremi/contracts/messaging.js";
import { createId, nowIso } from "@multiremi/ids.js";
import type { StoreContext } from "@multiremi/store/context.js";
import { nullableString, parseJson, toJson } from "@multiremi/store/helpers.js";

type Row = Record<string, unknown>;

export interface ClaimMessageSyncStreamInput {
  sourceId: string;
  stream: string;
  owner: string;
  now: string;
  leaseMs: number;
}

export interface UpdateClaimedMessageSyncCursorInput {
  sourceId: string;
  stream: string;
  leaseToken: string;
  cursor?: Record<string, unknown> | null;
  watermark?: string | null;
  lastStartedAt?: string | null;
  lastCompletedAt?: string | null;
  lastError?: string | null;
  leaseUntil?: string | null;
}

export interface ReconcileMessageUnprocessedResult {
  retried: number;
  dismissed: number;
}

export interface UpsertMessageConnectionInput {
  id: string;
  workspaceId: string;
  provider: string;
  channel: string;
  name: string;
  externalAccountId?: string | null;
  externalAccountName?: string | null;
  status?: MessageConnection["status"];
  config?: Record<string, unknown>;
  lastCheckedAt?: string | null;
  lastErrorCode?: MessageErrorCode | null;
  lastErrorAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface UpsertMessageSourceInput {
  id: string;
  workspaceId: string;
  connectionId: string;
  name: string;
  allowlist?: MessageSource["allowlist"];
  enabled?: boolean;
  retentionDays?: number;
  pollIntervalSeconds?: number;
  unprocessedRetrySeconds?: number;
  unprocessedRetryLimit?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface StoredCanonicalMessage extends CanonicalMessage {
  connectionId: string;
  workspaceId: string;
  sourceId: string;
  contentFingerprint: string;
  ingestedAt: string;
  processedAt: string | null;
  retryCount: number;
  lastRetryAt: string | null;
}

export interface IngestCanonicalMessagesInput {
  connectionId: string;
  sourceId: string;
  messages: readonly CanonicalMessage[];
  ingestedAt?: string;
}

export interface IngestCanonicalMessagesResult {
  inserted: number;
  updated: number;
  unchanged: number;
  /** Rejected for want of consent: off the allowlist, or at/before activation. */
  skipped: number;
}

export interface UpdateMessageProcessingStateInput {
  connectionId: string;
  externalMessageId: string;
  processedAt?: string | null;
  retryCount?: number;
  lastRetryAt?: string | null;
}

export interface ListCanonicalMessagesInput {
  workspaceId?: string | null;
  connectionId?: string | null;
  sourceId?: string | null;
  externalConversationId?: string | null;
  /** Substring match over the canonical text. */
  query?: string | null;
  processed?: boolean;
  since?: string | null;
  until?: string | null;
  limit?: number;
  offset?: number;
}

export interface ListCanonicalMessagesResult {
  messages: StoredCanonicalMessage[];
  total: number;
}

export interface RecordMessageOutcomeInput {
  workspaceId: string;
  connectionId: string;
  externalMessageId: string;
  outcomeKind: MessageOutcomeKind;
  ref?: string | null;
  reason?: string | null;
  taskId?: string | null;
  proposalPayload?: Record<string, unknown>;
  proposalStatus?: MessageProposalStatus;
  createdAt?: string;
}

export interface ListMessageProposalsInput {
  workspaceId: string;
  status?: MessageProposalStatus;
  sourceId?: string | null;
  limit?: number;
  offset?: number;
}

export interface ListMessageProposalsResult {
  proposals: MessageOutcome[];
  total: number;
}

/** Message identity everywhere outside the message table itself. */
export interface MessageRef {
  connectionId: string;
  externalMessageId: string;
}

/** Persistence boundary for the channel-independent Messaging Core. */
export class MessagingRepo {
  constructor(private readonly ctx: Pick<StoreContext, "db">) {}

  getConnection(id: string): MessageConnection | null {
    const row = this.ctx.db.query(
      "SELECT * FROM multiremi_message_connections WHERE id = ?",
    ).get(id) as Row | null;
    return row ? toConnection(row) : null;
  }

  upsertConnection(input: UpsertMessageConnectionInput): MessageConnection {
    const current = this.getConnection(input.id);
    const timestamp = nowIso();
    const createdAt = input.createdAt ?? current?.createdAt ?? timestamp;
    const updatedAt = input.updatedAt ?? timestamp;
    this.ctx.db.run(
      `INSERT INTO multiremi_message_connections (
        id, workspace_id, provider, channel, name, external_account_id,
        external_account_name, status, config, last_checked_at, last_error_code,
        last_error_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        provider = excluded.provider,
        channel = excluded.channel,
        name = excluded.name,
        external_account_id = excluded.external_account_id,
        external_account_name = excluded.external_account_name,
        status = excluded.status,
        config = excluded.config,
        last_checked_at = excluded.last_checked_at,
        last_error_code = excluded.last_error_code,
        last_error_at = excluded.last_error_at,
        updated_at = excluded.updated_at`,
      [
        input.id,
        input.workspaceId,
        input.provider,
        input.channel,
        input.name,
        input.externalAccountId === undefined ? current?.externalAccountId ?? null : input.externalAccountId,
        input.externalAccountName === undefined ? current?.externalAccountName ?? null : input.externalAccountName,
        input.status ?? current?.status ?? "unknown",
        toJson(input.config ?? current?.config ?? {}),
        input.lastCheckedAt === undefined ? current?.lastCheckedAt ?? null : input.lastCheckedAt,
        input.lastErrorCode === undefined ? current?.lastErrorCode ?? null : input.lastErrorCode,
        input.lastErrorAt === undefined ? current?.lastErrorAt ?? null : input.lastErrorAt,
        createdAt,
        updatedAt,
      ],
    );
    return this.getConnection(input.id)!;
  }

  listConnections(input: { workspaceId?: string | null } = {}): MessageConnection[] {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (input.workspaceId) {
      conditions.push("workspace_id = ?");
      values.push(input.workspaceId);
    }
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.ctx.db.query(
      `SELECT * FROM multiremi_message_connections${where} ORDER BY created_at ASC, id ASC`,
    ).all(...values) as Row[];
    return rows.map(toConnection);
  }

  getSource(id: string): MessageSource | null {
    const row = this.ctx.db.query(
      "SELECT * FROM multiremi_message_sources WHERE id = ?",
    ).get(id) as Row | null;
    return row ? toSource(row) : null;
  }

  listSources(input: { workspaceId?: string | null; enabled?: boolean; connectionId?: string } = {}): MessageSource[] {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (input.workspaceId) {
      conditions.push("workspace_id = ?");
      values.push(input.workspaceId);
    }
    if (input.connectionId) {
      conditions.push("connection_id = ?");
      values.push(input.connectionId);
    }
    if (input.enabled !== undefined) {
      conditions.push("enabled = ?");
      values.push(input.enabled ? 1 : 0);
    }
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.ctx.db.query(
      `SELECT * FROM multiremi_message_sources${where} ORDER BY created_at ASC, id ASC`,
    ).all(...values) as Row[];
    return rows.map(toSource);
  }

  upsertSource(input: UpsertMessageSourceInput): MessageSource {
    const connection = this.getConnection(input.connectionId);
    if (!connection) throw new Error(`Message connection not found: ${input.connectionId}`);
    if (connection.workspaceId !== input.workspaceId) {
      throw new Error("Message source and connection must belong to the same workspace");
    }

    const current = this.getSource(input.id);
    if (current && current.connectionId !== input.connectionId) {
      throw new Error("Message source cannot be rebound to another connection");
    }
    const timestamp = nowIso();
    const createdAt = input.createdAt ?? current?.createdAt ?? timestamp;
    const updatedAt = input.updatedAt ?? timestamp;
    this.ctx.db.run(
      `INSERT INTO multiremi_message_sources (
        id, workspace_id, connection_id, name, allowlist, enabled,
        retention_days, poll_interval_seconds, unprocessed_retry_seconds,
        unprocessed_retry_limit, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        connection_id = excluded.connection_id,
        name = excluded.name,
        allowlist = excluded.allowlist,
        enabled = excluded.enabled,
        retention_days = excluded.retention_days,
        poll_interval_seconds = excluded.poll_interval_seconds,
        unprocessed_retry_seconds = excluded.unprocessed_retry_seconds,
        unprocessed_retry_limit = excluded.unprocessed_retry_limit,
        updated_at = excluded.updated_at`,
      [
        input.id,
        input.workspaceId,
        input.connectionId,
        input.name,
        toJson(input.allowlist ?? current?.allowlist ?? []),
        input.enabled === undefined ? (current?.enabled === false ? 0 : 1) : (input.enabled ? 1 : 0),
        normalizeNonNegativeInteger(input.retentionDays ?? current?.retentionDays ?? 90, "retentionDays"),
        normalizePositiveInteger(input.pollIntervalSeconds ?? current?.pollIntervalSeconds ?? 15, "pollIntervalSeconds"),
        normalizePositiveInteger(
          input.unprocessedRetrySeconds ?? current?.unprocessedRetrySeconds ?? 900,
          "unprocessedRetrySeconds",
        ),
        normalizeNonNegativeInteger(
          input.unprocessedRetryLimit ?? current?.unprocessedRetryLimit ?? 3,
          "unprocessedRetryLimit",
        ),
        createdAt,
        updatedAt,
      ],
    );
    return this.getSource(input.id)!;
  }

  getMessage(connectionId: string, externalMessageId: string): StoredCanonicalMessage | null {
    const row = this.ctx.db.query(
      `SELECT * FROM multiremi_message_messages
       WHERE connection_id = ? AND external_message_id = ?`,
    ).get(connectionId, externalMessageId) as Row | null;
    return row ? toMessage(row) : null;
  }

  ingestMessages(input: IngestCanonicalMessagesInput): IngestCanonicalMessagesResult {
    const source = this.getSource(input.sourceId);
    if (!source) throw new Error(`Message source not found: ${input.sourceId}`);
    if (source.connectionId !== input.connectionId) {
      throw new Error("Message source does not belong to the requested connection");
    }

    // Consent is enforced here rather than in the Provider: the Core is the
    // authorization boundary, so a Provider that returns more than it was asked
    // for — or is simply wrong — still cannot widen what gets stored.
    const activationByConversation = new Map(
      source.allowlist.map((entry) => [entry.externalConversationId, truncateMinute(entry.addedAt)]),
    );

    return this.ctx.db.transaction(() => {
      const result: IngestCanonicalMessagesResult = { inserted: 0, updated: 0, unchanged: 0, skipped: 0 };
      const ingestedAt = input.ingestedAt ?? nowIso();
      for (const message of input.messages) {
        requireNonEmpty(message.externalMessageId, "externalMessageId");
        requireNonEmpty(message.externalConversationId, "externalConversationId");
        if (!isConsented(activationByConversation, message)) {
          result.skipped += 1;
          continue;
        }
        const fingerprint = fingerprintMessage(message);
        const existing = this.getMessage(input.connectionId, message.externalMessageId);
        if (!existing) {
          this.insertMessage(source, message, fingerprint, ingestedAt);
          result.inserted += 1;
          continue;
        }
        if (existing.contentFingerprint === fingerprint) {
          result.unchanged += 1;
          continue;
        }

        // Processing state is intentionally absent: an edit or recall must not
        // make a historical message eligible for downstream processing again.
        this.ctx.db.run(
          `UPDATE multiremi_message_messages SET
            external_conversation_id = ?, conversation_kind = ?, conversation_name = ?,
            external_thread_id = ?, external_root_id = ?, external_parent_id = ?,
            sender = ?, searchable_text = ?, attachments = ?, mentions = ?,
            reactions = ?, raw = ?, content_fingerprint = ?, message_url = ?,
            sent_at = ?, edited_at = ?, recalled = ?, ingested_at = ?
           WHERE connection_id = ? AND external_message_id = ?`,
          messageValues(
            message,
            fingerprint,
            ingestedAt,
            input.connectionId,
            message.externalMessageId,
          ),
        );
        result.updated += 1;
      }
      return result;
    })();
  }

  updateMessageProcessingState(input: UpdateMessageProcessingStateInput): StoredCanonicalMessage | null {
    const current = this.getMessage(input.connectionId, input.externalMessageId);
    if (!current) return null;
    const retryCount = input.retryCount === undefined
      ? current.retryCount
      : normalizeNonNegativeInteger(input.retryCount, "retryCount");
    this.ctx.db.run(
      `UPDATE multiremi_message_messages
       SET processed_at = ?, retry_count = ?, last_retry_at = ?
       WHERE connection_id = ? AND external_message_id = ?`,
      [
        input.processedAt === undefined ? current.processedAt : input.processedAt,
        retryCount,
        input.lastRetryAt === undefined ? current.lastRetryAt : input.lastRetryAt,
        input.connectionId,
        input.externalMessageId,
      ],
    );
    return this.getMessage(input.connectionId, input.externalMessageId);
  }

  getSyncCursor(sourceId: string, stream: string): MessageSyncCursor | null {
    const row = this.ctx.db.query(
      "SELECT * FROM multiremi_message_sync_cursors WHERE source_id = ? AND stream = ?",
    ).get(sourceId, stream) as Row | null;
    return row ? toCursor(row) : null;
  }

  /**
   * Take the lease on a stream, or return null when another owner holds it.
   *
   * The claim is conditional in SQL rather than read-then-write, so two Core
   * instances racing for the same Source cannot both win and double-ingest.
   */
  claimSyncStream(input: ClaimMessageSyncStreamInput): MessageSyncCursor | null {
    return this.ctx.db.transaction(() => {
      this.ctx.db.run(
        `INSERT OR IGNORE INTO multiremi_message_sync_cursors (
          source_id, stream, cursor, watermark, last_started_at, last_completed_at,
          last_error, lease_owner, lease_until, lease_token, updated_at
        ) VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
        [input.sourceId, input.stream, input.now],
      );
      const row = this.ctx.db.query(
        `UPDATE multiremi_message_sync_cursors
         SET lease_owner = ?, lease_until = ?, lease_token = ?, updated_at = ?
         WHERE source_id = ? AND stream = ?
           AND (lease_token IS NULL OR lease_until IS NULL OR lease_until <= ?)
         RETURNING *`,
      ).get(
        input.owner,
        new Date(Date.parse(input.now) + input.leaseMs).toISOString(),
        createId("mlease"),
        input.now,
        input.sourceId,
        input.stream,
        input.now,
      ) as Row | null;
      return row ? toCursor(row) : null;
    })();
  }

  /** Writes cursor progress, but only for the caller that still holds the lease. */
  updateClaimedSyncCursor(input: UpdateClaimedMessageSyncCursorInput): MessageSyncCursor | null {
    const current = this.getSyncCursor(input.sourceId, input.stream);
    if (!current || current.leaseToken !== input.leaseToken) return null;
    const row = this.ctx.db.query(
      `UPDATE multiremi_message_sync_cursors SET
        cursor = ?, watermark = ?, last_started_at = ?, last_completed_at = ?,
        last_error = ?, lease_until = ?, updated_at = ?
       WHERE source_id = ? AND stream = ? AND lease_token = ?
       RETURNING *`,
    ).get(
      input.cursor === undefined ? toJson(current.cursor) : (input.cursor === null ? null : toJson(input.cursor)),
      input.watermark === undefined ? current.watermark : input.watermark,
      input.lastStartedAt === undefined ? current.lastStartedAt : input.lastStartedAt,
      input.lastCompletedAt === undefined ? current.lastCompletedAt : input.lastCompletedAt,
      input.lastError === undefined ? current.lastError : input.lastError,
      input.leaseUntil === undefined ? current.leaseUntil : input.leaseUntil,
      nowIso(),
      input.sourceId,
      input.stream,
      input.leaseToken,
    ) as Row | null;
    return row ? toCursor(row) : null;
  }

  releaseSyncStream(sourceId: string, stream: string, leaseToken: string): boolean {
    return this.ctx.db.run(
      `UPDATE multiremi_message_sync_cursors
       SET lease_owner = NULL, lease_until = NULL, lease_token = NULL, updated_at = ?
       WHERE source_id = ? AND stream = ? AND lease_token = ?`,
      [nowIso(), sourceId, stream, leaseToken],
    ).changes > 0;
  }

  recordSourceSuccess(sourceId: string, completedAt: string): void {
    this.ctx.db.run(
      `UPDATE multiremi_message_sources
       SET last_successful_ingest_at = ?, last_error_code = NULL, last_error_at = NULL,
           consecutive_failures = 0, connection_alerted_at = NULL, updated_at = ?
       WHERE id = ?`,
      [completedAt, nowIso(), sourceId],
    );
  }

  recordSourceFailure(sourceId: string, errorCode: MessageErrorCode, failedAt: string): void {
    this.ctx.db.run(
      `UPDATE multiremi_message_sources
       SET last_error_code = ?, last_error_at = ?,
           consecutive_failures = consecutive_failures + 1, updated_at = ?
       WHERE id = ?`,
      [errorCode, failedAt, nowIso(), sourceId],
    );
  }

  /** True when the Source has messages whose retry backoff has elapsed. */
  hasDueUnprocessedMessages(sourceId: string, now: Date): boolean {
    const source = this.getSource(sourceId);
    if (!source) return false;
    const due = new Date(now.getTime() - source.unprocessedRetrySeconds * 1_000).toISOString();
    const row = this.ctx.db.query(
      `SELECT 1 FROM multiremi_message_messages
       WHERE source_id = ? AND processed_at IS NULL AND retry_count < ?
         AND COALESCE(last_retry_at, ingested_at) <= ?
       LIMIT 1`,
    ).get(sourceId, source.unprocessedRetryLimit, due) as Row | null;
    return row !== null;
  }

  /**
   * Advances retry bookkeeping for messages that were never processed.
   *
   * Messages past `unprocessedRetryLimit` are dismissed by stamping
   * `processed_at`, which stops the retry without deleting evidence that the
   * message arrived — retention is the only thing that removes rows.
   */
  reconcileUnprocessedMessages(sourceId: string, now: Date, limit = 500): ReconcileMessageUnprocessedResult {
    const source = this.getSource(sourceId);
    if (!source) return { retried: 0, dismissed: 0 };
    const timestamp = now.toISOString();
    const due = new Date(now.getTime() - source.unprocessedRetrySeconds * 1_000).toISOString();
    return this.ctx.db.transaction(() => {
      const rows = this.ctx.db.query(
        `SELECT external_message_id, retry_count FROM multiremi_message_messages
         WHERE source_id = ? AND processed_at IS NULL
           AND COALESCE(last_retry_at, ingested_at) <= ?
         ORDER BY sent_at ASC, external_message_id ASC
         LIMIT ?`,
      ).all(sourceId, due, limit) as Row[];

      let retried = 0;
      let dismissed = 0;
      for (const row of rows) {
        const externalMessageId = String(row.external_message_id);
        const nextRetry = Number(row.retry_count ?? 0) + 1;
        if (nextRetry >= source.unprocessedRetryLimit) {
          this.ctx.db.run(
            `UPDATE multiremi_message_messages
             SET retry_count = ?, last_retry_at = ?, processed_at = ?
             WHERE connection_id = ? AND external_message_id = ?`,
            [nextRetry, timestamp, timestamp, source.connectionId, externalMessageId],
          );
          dismissed += 1;
          continue;
        }
        this.ctx.db.run(
          `UPDATE multiremi_message_messages
           SET retry_count = ?, last_retry_at = ?
           WHERE connection_id = ? AND external_message_id = ?`,
          [nextRetry, timestamp, source.connectionId, externalMessageId],
        );
        retried += 1;
      }
      return { retried, dismissed };
    })();
  }

  /** Drops messages past their Source's retention window. `0` days keeps forever. */
  deleteExpiredMessages(now: Date = new Date()): number {
    let deleted = 0;
    for (const source of this.listSources()) {
      if (source.retentionDays <= 0) continue;
      const cutoff = new Date(now.getTime() - source.retentionDays * 86_400_000).toISOString();
      deleted += this.ctx.db.run(
        "DELETE FROM multiremi_message_messages WHERE source_id = ? AND sent_at < ?",
        [source.id, cutoff],
      ).changes;
    }
    return deleted;
  }

  listMessages(input: ListCanonicalMessagesInput = {}): ListCanonicalMessagesResult {
    const limit = normalizeLimit(input.limit ?? 100);
    const offset = normalizeNonNegativeInteger(input.offset ?? 0, "offset");
    const conditions: string[] = [];
    const values: unknown[] = [];
    const equals = (column: string, value: string | null | undefined): void => {
      if (!value) return;
      conditions.push(`${column} = ?`);
      values.push(value);
    };
    equals("workspace_id", input.workspaceId);
    equals("connection_id", input.connectionId);
    equals("source_id", input.sourceId);
    equals("external_conversation_id", input.externalConversationId);
    if (input.processed !== undefined) {
      conditions.push(input.processed ? "processed_at IS NOT NULL" : "processed_at IS NULL");
    }
    if (input.since) {
      conditions.push("sent_at >= ?");
      values.push(input.since);
    }
    if (input.until) {
      conditions.push("sent_at <= ?");
      values.push(input.until);
    }
    const query = input.query?.trim();
    if (query) {
      conditions.push("LOWER(searchable_text) LIKE ? ESCAPE '\\'");
      values.push(`%${escapeLike(query.toLowerCase())}%`);
    }
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    const total = Number((this.ctx.db.query(
      `SELECT COUNT(*) AS count FROM multiremi_message_messages${where}`,
    ).get(...values) as Row | undefined)?.count ?? 0);
    const rows = this.ctx.db.query(
      `SELECT * FROM multiremi_message_messages${where}
       ORDER BY sent_at DESC, connection_id ASC, external_message_id ASC
       LIMIT ? OFFSET ?`,
    ).all(...values, limit, offset) as Row[];
    return { messages: rows.map(toMessage), total };
  }

  /**
   * Conversations reconstructed from stored messages.
   *
   * Deliberately not a Provider call: this stays truthful when the channel is
   * unreachable, and it can only ever show what was already consented to.
   */
  listConversations(workspaceId: string): MessageConversationSummary[] {
    const allowed = new Map(this.listSources({ workspaceId }).map((source) => [
      source.id,
      new Set(source.allowlist.map((entry) => entry.externalConversationId)),
    ]));
    const rows = this.ctx.db.query(
      `SELECT source_id, connection_id, external_conversation_id,
              MAX(conversation_name) AS conversation_name,
              MAX(conversation_kind) AS conversation_kind,
              COUNT(*) AS message_count, MAX(sent_at) AS last_message_at
       FROM multiremi_message_messages
       WHERE workspace_id = ?
       GROUP BY source_id, connection_id, external_conversation_id
       ORDER BY last_message_at DESC, source_id ASC, external_conversation_id ASC`,
    ).all(workspaceId) as Row[];
    return rows.map((row) => {
      const sourceId = String(row.source_id);
      const externalConversationId = String(row.external_conversation_id);
      return {
        sourceId,
        connectionId: String(row.connection_id),
        externalConversationId,
        name: nullableString(row.conversation_name),
        kind: String(row.conversation_kind ?? "unknown") as MessageConversationSummary["kind"],
        messageCount: Number(row.message_count ?? 0),
        lastMessageAt: String(row.last_message_at),
        inAllowlist: allowed.get(sourceId)?.has(externalConversationId) ?? false,
      };
    });
  }

  /**
   * Deletes a Connection and everything reached through it.
   *
   * The dependent rows are removed explicitly: the schema's `ON DELETE CASCADE`
   * is decorative here, because SQLite runs with foreign keys off and the
   * Postgres translation strips the clauses. Relying on it would leave orphaned
   * messages holding a credential's history after the credential was removed.
   */
  deleteConnection(id: string): boolean {
    return this.ctx.db.transaction(() => {
      if (!this.getConnection(id)) return false;
      for (const source of this.listSources({ connectionId: id })) this.deleteSourceRows(source.id);
      this.ctx.db.run("DELETE FROM multiremi_message_sources WHERE connection_id = ?", [id]);
      this.ctx.db.run("DELETE FROM multiremi_message_outcomes WHERE connection_id = ?", [id]);
      this.ctx.db.run("DELETE FROM multiremi_message_messages WHERE connection_id = ?", [id]);
      return this.ctx.db.run("DELETE FROM multiremi_message_connections WHERE id = ?", [id]).changes === 1;
    })();
  }

  deleteSource(id: string): boolean {
    return this.ctx.db.transaction(() => {
      if (!this.getSource(id)) return false;
      this.deleteSourceRows(id);
      return this.ctx.db.run("DELETE FROM multiremi_message_sources WHERE id = ?", [id]).changes === 1;
    })();
  }

  private deleteSourceRows(sourceId: string): void {
    this.ctx.db.run(
      `DELETE FROM multiremi_message_outcomes
       WHERE (connection_id, external_message_id) IN (
         SELECT connection_id, external_message_id FROM multiremi_message_messages WHERE source_id = ?
       )`,
      [sourceId],
    );
    this.ctx.db.run("DELETE FROM multiremi_message_messages WHERE source_id = ?", [sourceId]);
    this.ctx.db.run("DELETE FROM multiremi_message_sync_cursors WHERE source_id = ?", [sourceId]);
  }

  recordOutcome(input: RecordMessageOutcomeInput): MessageOutcome {
    return this.ctx.db.transaction(() => {
      const message = this.getMessage(input.connectionId, input.externalMessageId);
      if (!message || message.workspaceId !== input.workspaceId) throw new Error("Message not found");
      const id = createId("mout");
      this.ctx.db.run(
        `INSERT INTO multiremi_message_outcomes (
          id, workspace_id, connection_id, external_message_id, outcome_kind, ref, reason,
          task_id, proposal_payload, proposal_status, sequence, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          (SELECT COALESCE(MAX(sequence), 0) + 1 FROM multiremi_message_outcomes
           WHERE connection_id = ? AND external_message_id = ?),
          ?
        )`,
        [
          id,
          input.workspaceId,
          input.connectionId,
          input.externalMessageId,
          input.outcomeKind,
          input.ref ?? null,
          input.reason ?? null,
          input.taskId ?? null,
          toJson(input.proposalPayload ?? {}),
          input.proposalStatus ?? "not_applicable",
          input.connectionId,
          input.externalMessageId,
          input.createdAt ?? nowIso(),
        ],
      );
      return this.getOutcome(id)!;
    })();
  }

  getOutcome(id: string): MessageOutcome | null {
    const row = this.ctx.db.query(
      "SELECT * FROM multiremi_message_outcomes WHERE id = ?",
    ).get(id) as Row | undefined;
    return row ? toOutcome(row) : null;
  }

  listOutcomes(connectionId: string, externalMessageId: string): MessageOutcome[] {
    const rows = this.ctx.db.query(
      `SELECT * FROM multiremi_message_outcomes
       WHERE connection_id = ? AND external_message_id = ?
       ORDER BY sequence ASC, id ASC`,
    ).all(connectionId, externalMessageId) as Row[];
    return rows.map(toOutcome);
  }

  /** Outcomes for a page of messages, so a list view needs one query, not N. */
  listOutcomesForMessages(refs: readonly MessageRef[]): MessageOutcome[] {
    if (refs.length === 0) return [];
    const clause = refs.map(() => "(connection_id = ? AND external_message_id = ?)").join(" OR ");
    const values = refs.flatMap((ref) => [ref.connectionId, ref.externalMessageId]);
    const rows = this.ctx.db.query(
      `SELECT * FROM multiremi_message_outcomes WHERE ${clause} ORDER BY created_at ASC, sequence ASC, id ASC`,
    ).all(...values) as Row[];
    return rows.map(toOutcome);
  }

  listProposals(input: ListMessageProposalsInput): ListMessageProposalsResult {
    const limit = normalizeLimit(input.limit ?? 100);
    const offset = normalizeNonNegativeInteger(input.offset ?? 0, "offset");
    const conditions = ["o.workspace_id = ?", "o.proposal_status != 'not_applicable'"];
    const values: unknown[] = [input.workspaceId];
    if (input.status && input.status !== "not_applicable") {
      conditions.push("o.proposal_status = ?");
      values.push(input.status);
    }
    if (input.sourceId) {
      conditions.push("m.source_id = ?");
      values.push(input.sourceId);
    }
    const from = `FROM multiremi_message_outcomes o
       JOIN multiremi_message_messages m
         ON m.connection_id = o.connection_id AND m.external_message_id = o.external_message_id
       WHERE ${conditions.join(" AND ")}`;
    const total = Number((this.ctx.db.query(
      `SELECT COUNT(*) AS count ${from}`,
    ).get(...values) as Row | undefined)?.count ?? 0);
    const rows = this.ctx.db.query(
      `SELECT o.* ${from} ORDER BY o.created_at DESC, o.id DESC LIMIT ? OFFSET ?`,
    ).all(...values, limit, offset) as Row[];
    return { proposals: rows.map(toOutcome), total };
  }

  /**
   * Approves or rejects a pending proposal.
   *
   * Conditional on the row still being `pending`, so two reviewers racing on
   * the same proposal cannot both act on it.
   */
  resolveProposal(input: {
    id: string;
    workspaceId: string;
    status: "approved" | "rejected";
    resolvedBy: string | null;
    resolvedAt?: string;
  }): MessageOutcome | null {
    const changes = this.ctx.db.run(
      `UPDATE multiremi_message_outcomes
       SET proposal_status = ?, proposal_resolved_at = ?, proposal_resolved_by = ?
       WHERE id = ? AND workspace_id = ? AND proposal_status = 'pending'`,
      [input.status, input.resolvedAt ?? nowIso(), input.resolvedBy ?? null, input.id, input.workspaceId],
    ).changes;
    return changes > 0 ? this.getOutcome(input.id) : null;
  }

  private insertMessage(
    source: MessageSource,
    message: CanonicalMessage,
    fingerprint: string,
    ingestedAt: string,
  ): void {
    this.ctx.db.run(
      `INSERT INTO multiremi_message_messages (
        connection_id, external_message_id, workspace_id, source_id,
        external_conversation_id, conversation_kind, conversation_name,
        external_thread_id, external_root_id, external_parent_id, sender,
        searchable_text, attachments, mentions, reactions, raw,
        content_fingerprint, message_url, sent_at, edited_at, recalled,
        ingested_at, processed_at, retry_count, last_retry_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL)`,
      [
        source.connectionId,
        message.externalMessageId,
        source.workspaceId,
        source.id,
        ...messageValues(message, fingerprint, ingestedAt),
      ],
    );
  }
}

function messageValues(
  message: CanonicalMessage,
  fingerprint: string,
  ingestedAt: string,
  ...tail: unknown[]
): unknown[] {
  return [
    message.externalConversationId,
    message.conversationKind,
    message.conversationName,
    message.externalThreadId,
    message.externalRootId,
    message.externalParentId,
    toJson(message.sender),
    message.text,
    toJson(message.attachments),
    toJson(message.mentions),
    toJson(message.reactions),
    toJson(message.raw),
    fingerprint,
    message.url,
    message.sentAt,
    message.editedAt,
    message.recalled ? 1 : 0,
    ingestedAt,
    ...tail,
  ];
}

/**
 * Whether the operator opted this conversation in before the message was sent.
 *
 * Comparison is at minute precision because some channels only expose
 * minute-accurate timestamps on search results; the whole activation minute is
 * therefore excluded, so a coarse timestamp can never be read as post-consent.
 */
function isConsented(activationByConversation: ReadonlyMap<string, number>, message: CanonicalMessage): boolean {
  const activation = activationByConversation.get(message.externalConversationId);
  if (activation === undefined || !Number.isFinite(activation)) return false;
  const sentAt = truncateMinute(message.sentAt);
  return Number.isFinite(sentAt) && sentAt > activation;
}

function truncateMinute(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 60_000) * 60_000 : Number.NaN;
}

function fingerprintMessage(message: CanonicalMessage): string {
  return createHash("sha256").update(stableJson(message)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function toConnection(row: Row): MessageConnection {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    provider: String(row.provider),
    channel: String(row.channel),
    name: String(row.name),
    externalAccountId: nullableString(row.external_account_id),
    externalAccountName: nullableString(row.external_account_name),
    status: String(row.status) as MessageConnection["status"],
    config: parseJson<Record<string, unknown>>(row.config, {}),
    lastCheckedAt: nullableString(row.last_checked_at),
    lastErrorCode: nullableString(row.last_error_code) as MessageErrorCode | null,
    lastErrorAt: nullableString(row.last_error_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toSource(row: Row): MessageSource {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    connectionId: String(row.connection_id),
    name: String(row.name ?? ""),
    allowlist: parseJson<MessageSource["allowlist"]>(row.allowlist, []),
    enabled: Number(row.enabled) === 1,
    retentionDays: Number(row.retention_days),
    pollIntervalSeconds: Number(row.poll_interval_seconds),
    unprocessedRetrySeconds: Number(row.unprocessed_retry_seconds),
    unprocessedRetryLimit: Number(row.unprocessed_retry_limit),
    lastSuccessfulIngestAt: nullableString(row.last_successful_ingest_at),
    lastErrorCode: nullableString(row.last_error_code) as MessageErrorCode | null,
    lastErrorAt: nullableString(row.last_error_at),
    consecutiveFailures: Number(row.consecutive_failures ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toCursor(row: Row): MessageSyncCursor {
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

function toMessage(row: Row): StoredCanonicalMessage {
  return {
    connectionId: String(row.connection_id),
    externalMessageId: String(row.external_message_id),
    workspaceId: String(row.workspace_id ?? "local"),
    sourceId: String(row.source_id),
    externalConversationId: String(row.external_conversation_id),
    conversationKind: String(row.conversation_kind) as CanonicalMessage["conversationKind"],
    conversationName: nullableString(row.conversation_name),
    externalThreadId: nullableString(row.external_thread_id),
    externalRootId: nullableString(row.external_root_id),
    externalParentId: nullableString(row.external_parent_id),
    sender: parseJson<CanonicalMessage["sender"]>(row.sender, {
      externalSenderId: null,
      displayName: null,
      kind: "unknown",
      isSelf: false,
    }),
    text: String(row.searchable_text ?? ""),
    attachments: parseJson<CanonicalMessage["attachments"]>(row.attachments, []),
    mentions: parseJson<CanonicalMessage["mentions"]>(row.mentions, []),
    reactions: parseJson<CanonicalMessage["reactions"]>(row.reactions, []),
    raw: parseJson<Record<string, unknown>>(row.raw, {}),
    contentFingerprint: String(row.content_fingerprint),
    url: nullableString(row.message_url),
    sentAt: String(row.sent_at),
    editedAt: nullableString(row.edited_at),
    recalled: Number(row.recalled) === 1,
    ingestedAt: String(row.ingested_at),
    processedAt: nullableString(row.processed_at),
    retryCount: Number(row.retry_count ?? 0),
    lastRetryAt: nullableString(row.last_retry_at),
  };
}

function toOutcome(row: Row): MessageOutcome {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    connectionId: String(row.connection_id),
    externalMessageId: String(row.external_message_id),
    outcomeKind: String(row.outcome_kind) as MessageOutcomeKind,
    ref: nullableString(row.ref),
    reason: nullableString(row.reason),
    taskId: nullableString(row.task_id),
    proposalPayload: parseJson<Record<string, unknown>>(row.proposal_payload, {}),
    proposalStatus: String(row.proposal_status ?? "not_applicable") as MessageProposalStatus,
    proposalResolvedAt: nullableString(row.proposal_resolved_at),
    proposalResolvedBy: nullableString(row.proposal_resolved_by),
    createdAt: String(row.created_at),
  };
}

function normalizeLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 500) throw new Error("limit must be between 1 and 500");
  return value;
}

/** `LIKE` treats these as wildcards, so a literal search must escape them. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}

function normalizePositiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}

function normalizeNonNegativeInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`);
  return value;
}

function requireNonEmpty(value: string, field: string): void {
  if (!value) throw new Error(`${field} must not be empty`);
}
