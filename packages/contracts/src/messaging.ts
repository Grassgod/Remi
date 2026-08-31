/**
 * Channel-agnostic messaging contract.
 *
 * Multiremi's Messaging Core owns source configuration, scheduling, leases,
 * cursors, deduplication, retries, storage, outcomes, and every downstream
 * behaviour (Inbox, Issue, knowledge extraction). A Provider owns exactly one
 * thing: turning a concrete channel's wire format into the canonical model
 * declared here, and back.
 *
 * Nothing in this file may name a concrete channel. `feishu`, `wechat`, and
 * `lark_cli` appear only as runtime string values supplied by a Provider's
 * manifest — never as a type, field, or branch in the contract.
 */

// ─── Identity ───────────────────────────────────────────────────────────────────────────────────

/** A Provider implementation id, e.g. the string `lark_cli`. */
export type MessageProviderId = string;

/** A messaging platform id, e.g. the string `feishu`. */
export type MessageChannelId = string;

/**
 * One authenticated account on one channel.
 *
 * A Connection is the deduplication and authorization boundary: message
 * identity is `(connectionId, externalMessageId)`, because two channels — or
 * two accounts on one channel — may legitimately mint the same external id.
 */
export interface MessageConnection {
  id: string;
  workspaceId: string;
  provider: MessageProviderId;
  channel: MessageChannelId;
  /** Operator-facing label. Never a secret or a fetchable endpoint. */
  name: string;
  /** Channel-native account id, when the Provider can report one. */
  externalAccountId: string | null;
  /** Channel-native account display name, when the Provider can report one. */
  externalAccountName: string | null;
  status: MessageConnectionStatus;
  /** Provider-owned, non-secret settings needed to reach this account. */
  config: Record<string, unknown>;
  lastCheckedAt: string | null;
  lastErrorCode: MessageErrorCode | null;
  lastErrorAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type MessageConnectionStatus =
  /** Authenticated and usable. */
  | "ready"
  /** Reachable, but the credential is missing, expired, or revoked. */
  | "unauthenticated"
  /** The Provider's runtime dependency is absent (e.g. a CLI is not installed). */
  | "unavailable"
  /** The runtime dependency exists but is older than the Provider's floor. */
  | "incompatible"
  /** Health has never been established. */
  | "unknown";

// ─── Sources ────────────────────────────────────────────────────────────────────────────────────

/**
 * A set of conversations to sync on one Connection, plus its filtering policy.
 *
 * `allowlist` is consent, not a filter of convenience: each entry carries the
 * activation watermark at which the operator opted that conversation in, and
 * the Core refuses to ingest anything at or before that instant.
 */
export interface MessageSource {
  id: string;
  workspaceId: string;
  connectionId: string;
  name: string;
  allowlist: MessageAllowlistEntry[];
  enabled: boolean;
  retentionDays: number;
  pollIntervalSeconds: number;
  unprocessedRetrySeconds: number;
  unprocessedRetryLimit: number;
  /**
   * Sync health, maintained by the Core.
   *
   * Kept on the Source rather than only in the cursor because this is what
   * operator surfaces read: a Source can be behind for a reason that has
   * nothing to do with where its cursor currently points.
   */
  lastSuccessfulIngestAt: string | null;
  lastErrorCode: MessageErrorCode | null;
  lastErrorAt: string | null;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
}

export interface MessageAllowlistEntry {
  /** Channel-native conversation id, stored verbatim. */
  externalConversationId: string;
  /** Activation watermark: nothing at or before this instant is ingested. */
  addedAt: string;
}

// ─── Sync state ─────────────────────────────────────────────────────────────────────────────────

/**
 * Per-stream sync progress for one Source, and the lease that guards it.
 *
 * The lease exists so that several Core instances can share one database
 * without polling the same Source twice: a writer must hold `leaseToken` for
 * every cursor write, and a lease that expires is reclaimed by whoever is next.
 * `cursor` is opaque Core state (which window is in flight, plus the Provider's
 * own page token); `watermark` is the point the Source is caught up to.
 */
export interface MessageSyncCursor {
  sourceId: string;
  stream: string;
  cursor: Record<string, unknown> | null;
  watermark: string | null;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastError: string | null;
  leaseOwner: string | null;
  leaseUntil: string | null;
  leaseToken: string | null;
  updatedAt: string;
}

// ─── Conversations ──────────────────────────────────────────────────────────────────────────────

export type MessageConversationKind = "direct" | "group" | "thread" | "unknown";

export interface MessageConversation {
  externalConversationId: string;
  name: string | null;
  kind: MessageConversationKind;
  /** Channel-native deep link, when the channel exposes one. */
  url: string | null;
  memberCount: number | null;
  /** Provider-owned extras that the Core stores but never interprets. */
  metadata: Record<string, unknown>;
}

// ─── Canonical message ──────────────────────────────────────────────────────────────────────────

export interface MessageSender {
  /** Channel-native sender id, stored verbatim. */
  externalSenderId: string | null;
  displayName: string | null;
  kind: "user" | "bot" | "system" | "unknown";
  /** True when the Provider can prove this is the connected account itself. */
  isSelf: boolean;
}

export interface MessageAttachmentRef {
  /** Channel-native resource key, stored verbatim. */
  externalAttachmentId: string;
  kind: "image" | "file" | "audio" | "video" | "unknown";
  name: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
}

export interface MessageMention {
  externalUserId: string | null;
  displayName: string | null;
  /** True for @all / @channel style mentions that name no single user. */
  isEveryone: boolean;
}

export interface MessageReaction {
  key: string;
  count: number;
  /** True when the connected account itself reacted. */
  reactedBySelf: boolean;
}

/**
 * A channel-independent message.
 *
 * Providers must preserve channel-native ids verbatim in the `external*`
 * fields so a migration or an audit can always trace a row back to its origin.
 * `raw` carries the Provider's original payload for forensics; the Core stores
 * it opaquely and never branches on its shape.
 */
export interface CanonicalMessage {
  /** Channel-native message id. Unique only within a Connection. */
  externalMessageId: string;
  externalConversationId: string;
  conversationName: string | null;
  conversationKind: MessageConversationKind;
  /** Channel-native thread id, when the channel models threads. */
  externalThreadId: string | null;
  /** Channel-native id of the thread root, when distinct from the thread id. */
  externalRootId: string | null;
  /** Channel-native id of the message this one replies to. */
  externalParentId: string | null;
  sender: MessageSender;
  /** Plain-text rendering used for search and for prompting. */
  text: string;
  attachments: MessageAttachmentRef[];
  mentions: MessageMention[];
  reactions: MessageReaction[];
  /** Channel-native deep link to this message, when one exists. */
  url: string | null;
  sentAt: string;
  editedAt: string | null;
  /** True when the channel reports the message as withdrawn. */
  recalled: boolean;
  /** Provider's original payload, stored opaquely for audit. */
  raw: Record<string, unknown>;
}

// ─── Outcomes ───────────────────────────────────────────────────────────────────────────────────

export type MessageOutcomeKind =
  | "issue_proposed"
  | "issue_created"
  | "notified"
  | "reply_drafted"
  | "ignored"
  | "dismissed";

export interface MessageOutcome {
  id: string;
  workspaceId: string;
  connectionId: string;
  externalMessageId: string;
  outcomeKind: MessageOutcomeKind;
  ref: string | null;
  reason: string | null;
  taskId: string | null;
  createdAt: string;
}

// ─── Errors ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The closed set of failure modes the Core understands.
 *
 * Providers must map every channel-specific and transport-specific failure
 * onto one of these. The Core decides retry and surfacing policy from the code
 * alone, so a Provider that invents codes silently disables recovery.
 */
export type MessageErrorCode =
  /** The Provider's runtime dependency is not installed. */
  | "provider_unavailable"
  /** The dependency is installed but below the Provider's minimum version. */
  | "provider_incompatible"
  /** The dependency lacks a capability this Provider requires. */
  | "capability_unsupported"
  /** No credential, or the credential expired or was revoked. */
  | "unauthenticated"
  /** Authenticated, but not permitted to read or write this resource. */
  | "forbidden"
  /** The channel throttled the request. */
  | "rate_limited"
  /** The request exceeded its deadline. */
  | "timeout"
  /** The channel or the transport was unreachable. */
  | "unreachable"
  /** The channel answered, but not in the shape the Provider requires. */
  | "malformed_response"
  /** The referenced conversation, message, or attachment does not exist. */
  | "not_found"
  /** A send completed with an indeterminate result — never silently retried. */
  | "send_result_unknown"
  /** Anything the Provider could not classify. */
  | "unknown";

/** Codes the Core may retry. A send that failed with an unknown result is never retried. */
export const RETRYABLE_MESSAGE_ERROR_CODES: readonly MessageErrorCode[] = [
  "rate_limited",
  "timeout",
  "unreachable",
];

export function isRetryableMessageErrorCode(code: MessageErrorCode): boolean {
  return RETRYABLE_MESSAGE_ERROR_CODES.includes(code);
}

/**
 * The error every Provider throws.
 *
 * `retryAfterMs` lets a channel that reports a throttle window propagate it
 * instead of forcing the Core to guess a backoff.
 */
export class MessageProviderError extends Error {
  constructor(
    readonly code: MessageErrorCode,
    message?: string,
    readonly options: { retryAfterMs?: number | null; cause?: unknown } = {},
  ) {
    super(message ?? `Message provider failed (${code})`);
    this.name = "MessageProviderError";
  }

  get retryable(): boolean {
    return isRetryableMessageErrorCode(this.code);
  }

  get retryAfterMs(): number | null {
    return this.options.retryAfterMs ?? null;
  }
}

// ─── Manifest ───────────────────────────────────────────────────────────────────────────────────

export type MessageAuthMethod =
  /** The Provider delegates auth to an external tool it shells out to. */
  | "external_tool"
  | "oauth"
  | "app_credential"
  | "webhook_secret";

export interface MessageProviderCapabilities {
  /** Cursor-based incremental pull. */
  pull: boolean;
  /** Inbound push/event normalization. */
  push: boolean;
  searchConversations: boolean;
  readConversations: boolean;
  send: boolean;
  reply: boolean;
  attachmentDownload: boolean;
  attachmentUpload: boolean;
  mention: boolean;
  reaction: boolean;
  /** The channel reports edits, so the Core can reconcile them. */
  edit: boolean;
  /** The channel reports recalls, so the Core can tombstone them. */
  recall: boolean;
}

export interface MessageProviderManifest {
  provider: MessageProviderId;
  /** Channels this Provider can serve. */
  channels: readonly MessageChannelId[];
  authMethods: readonly MessageAuthMethod[];
  capabilities: MessageProviderCapabilities;
  /** Human-readable name for operator-facing surfaces. */
  displayName: string;
}

export interface MessageProviderHealth {
  status: MessageConnectionStatus;
  /** Version of the Provider's underlying dependency, when detectable. */
  version: string | null;
  /** Channel-native account the credential resolves to, when detectable. */
  externalAccountId: string | null;
  externalAccountName: string | null;
  errorCode: MessageErrorCode | null;
  /** Operator-facing detail. Must never contain a credential. */
  detail: string | null;
  checkedAt: string;
}

// ─── Provider interfaces ────────────────────────────────────────────────────────────────────────

/** Context threaded through every Provider call. */
export interface MessageProviderContext {
  connection: MessageConnection;
  signal?: AbortSignal;
  /** Called during long operations so the Core can renew a lease. */
  heartbeat?: () => void;
}

/**
 * The one interface every Provider implements.
 *
 * Every other interface here is optional and gated by `manifest.capabilities`,
 * so a Provider that can only pull is not forced to stub sending.
 */
export interface MessageProvider {
  readonly manifest: MessageProviderManifest;
  /** Probe the dependency and credential. Must not throw for expected failures. */
  checkHealth(context: MessageProviderContext): Promise<MessageProviderHealth>;
}

export interface ConversationSearchQuery {
  query?: string;
  kinds?: readonly MessageConversationKind[];
  limit?: number;
  cursor?: string | null;
}

export interface ConversationSearchResult {
  conversations: MessageConversation[];
  cursor: string | null;
  done: boolean;
}

export interface ConversationProvider extends MessageProvider {
  searchConversations(
    context: MessageProviderContext,
    query: ConversationSearchQuery,
  ): Promise<ConversationSearchResult>;
  getConversation(
    context: MessageProviderContext,
    externalConversationId: string,
  ): Promise<MessageConversation | null>;
}

/**
 * One page of an incremental pull.
 *
 * `cursor` is Provider-owned and opaque to the Core, which persists it
 * verbatim and hands it back on the next page. The Core supplies the time
 * window — including its overlap — so windowing policy stays in one place.
 */
export interface MessageSyncRequest {
  source: MessageSource;
  /** Provider cursor from the previous page, or null to start the window. */
  cursor: Record<string, unknown> | null;
  /** Inclusive window start, already widened by the Core's overlap. */
  start: Date;
  /** Exclusive window end. */
  end: Date;
}

export interface MessageSyncPage {
  messages: CanonicalMessage[];
  cursor: Record<string, unknown> | null;
  /** True when the window is fully drained; the Core then advances the watermark. */
  done: boolean;
}

export interface MessageSyncProvider extends MessageProvider {
  syncMessages(context: MessageProviderContext, request: MessageSyncRequest): Promise<MessageSyncPage>;
}

export interface MessagePushEvent {
  /** Raw inbound payload as received from the channel. */
  payload: unknown;
  headers: Readonly<Record<string, string>>;
}

export interface MessagePushResult {
  messages: CanonicalMessage[];
  /** Messages the channel reports as deleted, by channel-native id. */
  recalledExternalMessageIds: string[];
}

export interface MessagePushProvider extends MessageProvider {
  /** Verify authenticity and normalize. Must reject unverified payloads. */
  normalizePush(context: MessageProviderContext, event: MessagePushEvent): Promise<MessagePushResult>;
}

export interface MessageSendDraft {
  externalConversationId: string;
  text: string;
  /** Channel-native id of the message being replied to. */
  replyToExternalMessageId?: string | null;
  /** Reply inside the target's thread rather than the conversation. */
  inThread?: boolean;
  mentions?: readonly MessageMention[];
  attachments?: readonly MessageOutboundAttachment[];
}

export interface MessageOutboundAttachment {
  name: string;
  mimeType: string | null;
  /** Provider-resolved handle produced by `uploadAttachment`. */
  externalAttachmentId: string;
}

/**
 * A validated draft plus the idempotency key the Core will replay with.
 *
 * Preparing separately from sending is what makes `send_result_unknown`
 * recoverable: the key is minted and persisted before the write leaves the
 * process, so a retry can be deduplicated by the channel instead of
 * double-posting.
 */
export interface PreparedMessageSend {
  draft: MessageSendDraft;
  idempotencyKey: string;
  /** Provider-computed warnings, e.g. truncation. Never blocks the send. */
  warnings: readonly string[];
}

export interface MessageSendReceipt {
  externalMessageId: string;
  externalConversationId: string;
  sentAt: string;
  url: string | null;
}

export interface MessageSendProvider extends MessageProvider {
  /** Validate and normalize a draft without contacting the channel. */
  prepareSend(context: MessageProviderContext, draft: MessageSendDraft): Promise<PreparedMessageSend>;
  send(context: MessageProviderContext, prepared: PreparedMessageSend): Promise<MessageSendReceipt>;
  reply(context: MessageProviderContext, prepared: PreparedMessageSend): Promise<MessageSendReceipt>;
}

export interface MessageAttachmentDownload {
  externalAttachmentId: string;
  name: string | null;
  mimeType: string | null;
  bytes: Uint8Array;
}

export interface AttachmentProvider extends MessageProvider {
  downloadAttachment(
    context: MessageProviderContext,
    request: { externalMessageId: string; externalAttachmentId: string },
  ): Promise<MessageAttachmentDownload>;
  uploadAttachment(
    context: MessageProviderContext,
    request: { name: string; mimeType: string | null; bytes: Uint8Array },
  ): Promise<{ externalAttachmentId: string }>;
}

// ─── Capability narrowing ───────────────────────────────────────────────────────────────────────

/**
 * Capability probes.
 *
 * These read the manifest rather than sniffing for methods, so a Provider that
 * ships a method it cannot actually honour on the current connection stays
 * correctly disabled.
 */
export function supportsConversations(provider: MessageProvider): provider is ConversationProvider {
  const { searchConversations, readConversations } = provider.manifest.capabilities;
  return (searchConversations || readConversations) && typeof (provider as ConversationProvider).searchConversations === "function";
}

export function supportsSync(provider: MessageProvider): provider is MessageSyncProvider {
  return provider.manifest.capabilities.pull
    && typeof (provider as MessageSyncProvider).syncMessages === "function";
}

export function supportsPush(provider: MessageProvider): provider is MessagePushProvider {
  return provider.manifest.capabilities.push
    && typeof (provider as MessagePushProvider).normalizePush === "function";
}

export function supportsSend(provider: MessageProvider): provider is MessageSendProvider {
  return provider.manifest.capabilities.send
    && typeof (provider as MessageSendProvider).send === "function";
}

export function supportsAttachments(provider: MessageProvider): provider is AttachmentProvider {
  const { attachmentDownload, attachmentUpload } = provider.manifest.capabilities;
  return (attachmentDownload || attachmentUpload)
    && typeof (provider as AttachmentProvider).downloadAttachment === "function";
}
