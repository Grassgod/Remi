import { createHash } from "node:crypto";
import type {
  CanonicalMessage,
  MessageConnection,
  MessageErrorCode,
  MessageSource,
} from "@multiremi/contracts/messaging.js";
import { nowIso } from "@multiremi/ids.js";
import type { StoreContext } from "@multiremi/store/context.js";
import { nullableString, parseJson, toJson } from "@multiremi/store/helpers.js";

type Row = Record<string, unknown>;

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
}

export interface UpdateMessageProcessingStateInput {
  connectionId: string;
  externalMessageId: string;
  processedAt?: string | null;
  retryCount?: number;
  lastRetryAt?: string | null;
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

  getSource(id: string): MessageSource | null {
    const row = this.ctx.db.query(
      "SELECT * FROM multiremi_message_sources WHERE id = ?",
    ).get(id) as Row | null;
    return row ? toSource(row) : null;
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

    return this.ctx.db.transaction(() => {
      const result: IngestCanonicalMessagesResult = { inserted: 0, updated: 0, unchanged: 0 };
      const ingestedAt = input.ingestedAt ?? nowIso();
      for (const message of input.messages) {
        requireNonEmpty(message.externalMessageId, "externalMessageId");
        requireNonEmpty(message.externalConversationId, "externalConversationId");
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
    createdAt: String(row.created_at),
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
