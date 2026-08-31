import {
  MessageProviderError,
  type AttachmentProvider,
  type CanonicalMessage,
  type ConversationProvider,
  type ConversationSearchQuery,
  type ConversationSearchResult,
  type MessageAttachmentDownload,
  type MessageAttachmentRef,
  type MessageConversation,
  type MessageConversationKind,
  type MessageMention,
  type MessageProviderContext,
  type MessageProviderHealth,
  type MessageProviderManifest,
  type MessageReaction,
  type MessageSendDraft,
  type MessageSendProvider,
  type MessageSendReceipt,
  type MessageSyncPage,
  type MessageSyncProvider,
  type MessageSyncRequest,
  type PreparedMessageSend,
} from "@multiremi/contracts/messaging.js";
import {
  BunLarkCliRunner,
  type LarkCliRunOptions,
  type LarkCliRunner,
} from "./runner.js";

export const LARK_CLI_MINIMUM_VERSION = "1.0.90";

/**
 * Page-size ceilings lark-cli enforces itself, per subcommand.
 *
 * These are not tuning knobs. `im +messages-search` rejects anything above 50
 * outright (`invalid_argument`), so a larger value does not merely read fewer
 * rows — it fails the poll. They differ between the two commands, so they are
 * kept apart rather than collapsed into one conservative number.
 */
const MAX_MESSAGE_PAGE_SIZE = 50;
const MAX_CONVERSATION_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = MAX_MESSAGE_PAGE_SIZE;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_READ_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 100;
/**
 * The lark-cli commands this Provider drives.
 *
 * lark-cli exposes no capability manifest, so this list is not probed: the
 * version floor above is the guarantee that all of them exist, and a release
 * that dropped one still fails loudly, because an unknown subcommand is
 * reported as `capability_unsupported` on the call that needs it.
 */
export const REQUIRED_LARK_CLI_COMMANDS = [
  "im +chat-search",
  "im +chat-messages-list",
  "im +messages-search",
  "im +messages-send",
  "im +messages-reply",
  "im +messages-resources-download",
] as const;

export const LARK_CLI_MESSAGE_PROVIDER_MANIFEST: MessageProviderManifest = {
  provider: "lark_cli",
  channels: ["feishu"],
  authMethods: ["external_tool"],
  capabilities: {
    pull: true,
    push: false,
    searchConversations: true,
    readConversations: true,
    send: true,
    reply: true,
    attachmentDownload: true,
    attachmentUpload: false,
    mention: false,
    reaction: false,
    edit: true,
    recall: true,
  },
  displayName: "Lark CLI",
};

export interface LarkCliMessageProviderOptions {
  runner?: LarkCliRunner;
  timeoutMs?: number;
  maxReadAttempts?: number;
  retryBaseDelayMs?: number;
  now?: () => Date;
  createIdempotencyKey?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class LarkCliMessageProvider implements
  ConversationProvider,
  MessageSyncProvider,
  MessageSendProvider,
  AttachmentProvider {
  readonly manifest = LARK_CLI_MESSAGE_PROVIDER_MANIFEST;

  private readonly runner: LarkCliRunner;
  private readonly timeoutMs: number;
  private readonly maxReadAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly now: () => Date;
  private readonly createIdempotencyKey: () => string;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(options: LarkCliMessageProviderOptions = {}) {
    this.runner = options.runner ?? new BunLarkCliRunner({ timeoutMs: options.timeoutMs });
    this.timeoutMs = positiveInteger(options.timeoutMs) ?? DEFAULT_TIMEOUT_MS;
    this.maxReadAttempts = positiveInteger(options.maxReadAttempts) ?? DEFAULT_READ_ATTEMPTS;
    this.retryBaseDelayMs = nonNegativeInteger(options.retryBaseDelayMs) ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.now = options.now ?? (() => new Date());
    this.createIdempotencyKey = options.createIdempotencyKey ?? (() => crypto.randomUUID());
    this.sleep = options.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));
  }

  async checkHealth(context: MessageProviderContext): Promise<MessageProviderHealth> {
    const now = this.now();
    const checkedAt = now.toISOString();
    let version: string | null = null;
    try {
      // `--version` predates `--format` and rejects it, so it is read as text.
      // It is the only human-formatted output this Provider parses, and its
      // shape (`lark-cli version X.Y.Z`) is matched strictly rather than scanned.
      version = versionValue(await this.runVersion(context));
      if (!version) throw new MessageProviderError("malformed_response", "lark-cli version response is malformed");
      if (compareVersions(version, LARK_CLI_MINIMUM_VERSION) < 0) {
        return health("incompatible", version, "provider_incompatible", "lark-cli must be upgraded", checkedAt);
      }

      // `auth status` takes no `--format` either, but already emits JSON.
      const user = authUser(await this.runRead(["auth", "status"], context));
      if (!user) throw new MessageProviderError("malformed_response", "lark-cli auth status is malformed");
      const unauthenticated = authFailure(user, now);
      if (unauthenticated) {
        return health("unauthenticated", version, "unauthenticated", unauthenticated, checkedAt);
      }
      return {
        status: "ready",
        version,
        externalAccountId: firstString(user, ["open_id", "openId", "user_id", "userId", "id"]) || null,
        externalAccountName: firstString(user, ["user_name", "userName", "name", "display_name", "displayName"]) || null,
        errorCode: null,
        detail: null,
        checkedAt,
      };
    } catch (error) {
      const providerError = asProviderError(error);
      if (providerError.code === "provider_unavailable") {
        return health("unavailable", version, providerError.code, "lark-cli is not installed", checkedAt);
      }
      if (providerError.code === "provider_incompatible" || providerError.code === "capability_unsupported") {
        return health("incompatible", version, providerError.code, "lark-cli is incompatible", checkedAt);
      }
      if (providerError.code === "unauthenticated") {
        return health("unauthenticated", version, providerError.code, "lark-cli user identity needs authentication", checkedAt);
      }
      return health("unknown", version, providerError.code, "lark-cli health check failed", checkedAt);
    }
  }

  async searchConversations(
    context: MessageProviderContext,
    query: ConversationSearchQuery,
  ): Promise<ConversationSearchResult> {
    const search = query.query?.trim() ?? "";
    const argv = ["im", "+chat-search"];
    if (search) {
      argv.push("--query", search);
    } else {
      // lark-cli rejects a search that names neither a keyword nor a member, and
      // an absent query is how the Core says "browse", not "match everything" —
      // which for this account means the chats it is a member of. Passing an
      // empty `--query` instead, as this once did, failed every browse.
      const account = context.connection.externalAccountId?.trim();
      if (!account) {
        throw new MessageProviderError(
          "unauthenticated",
          "browsing conversations needs the connected account id; run a health check first",
        );
      }
      argv.push("--member-ids", account);
    }
    const limit = clampedPageSize(query.limit, MAX_CONVERSATION_PAGE_SIZE);
    if (limit !== null) argv.push("--page-size", String(limit));
    if (query.cursor) argv.push("--page-token", query.cursor);
    argv.push("--format", "json");

    const payload = await this.runRead(argv, context);
    const conversations = items(payload, ["chats", "items", "results"])
      .map(normalizeConversation)
      .filter((entry): entry is MessageConversation => entry !== null)
      .filter((entry) => !query.kinds?.length || query.kinds.includes(entry.kind));
    const cursor = pageToken(payload);
    const more = hasMore(payload);
    assertPageToken(more, cursor);
    return { conversations, cursor, done: !more && cursor === null };
  }

  async getConversation(
    context: MessageProviderContext,
    externalConversationId: string,
  ): Promise<MessageConversation | null> {
    const conversationId = requiredString(externalConversationId, "external conversation id");
    const payload = await this.runRead([
      "im",
      "+chat-messages-list",
      "--chat-id",
      conversationId,
      "--format",
      "json",
    ], context);
    const root = payloadRecord(payload);
    const explicit = normalizeConversation(root?.chat ?? root?.conversation);
    if (explicit) return explicit;
    const firstMessage = items(payload, ["messages", "items", "results"])[0];
    return conversationFromMessage(firstMessage, conversationId);
  }

  async syncMessages(context: MessageProviderContext, request: MessageSyncRequest): Promise<MessageSyncPage> {
    assertValidWindow(request.start, request.end);
    const activationByConversation = new Map<string, string>();
    for (const entry of request.source.allowlist) {
      const id = entry.externalConversationId.trim();
      if (id && timestampValue(entry.addedAt)) activationByConversation.set(id, entry.addedAt);
    }
    if (activationByConversation.size === 0) return { messages: [], cursor: null, done: true };

    const previousPageToken = cursorPageToken(request.cursor);
    const pageSize = clampedPageSize(context.connection.config.pageSize, MAX_MESSAGE_PAGE_SIZE) ?? DEFAULT_PAGE_SIZE;
    const argv = [
      "im",
      "+messages-search",
      "--chat-id",
      [...activationByConversation.keys()].join(","),
      "--start",
      cliTimestamp(request.start),
      "--end",
      cliTimestamp(request.end),
    ];
    if (previousPageToken) argv.push("--page-token", previousPageToken);
    argv.push("--page-size", String(pageSize), "--format", "json");

    const payload = await this.runRead(argv, context);
    const messages = items(payload, ["messages", "items", "results"])
      .map((entry) => normalizeMessage(entry, context.connection.externalAccountId))
      .filter((entry): entry is CanonicalMessage => entry !== null)
      .filter((entry) => {
        const addedAt = activationByConversation.get(entry.externalConversationId);
        return addedAt !== undefined && isAfterActivationMinute(entry.sentAt, addedAt);
      });
    const nextPageToken = pageToken(payload);
    const more = hasMore(payload);
    assertPageToken(more, nextPageToken);
    const done = !more && nextPageToken === null;
    return {
      messages,
      cursor: done || !nextPageToken ? null : { pageToken: nextPageToken },
      done,
    };
  }

  async prepareSend(
    _context: MessageProviderContext,
    draft: MessageSendDraft,
  ): Promise<PreparedMessageSend> {
    requiredString(draft.externalConversationId, "external conversation id");
    if (!draft.text.trim()) throw new MessageProviderError("unknown", "message text must not be empty");
    if (draft.mentions?.length) {
      throw new MessageProviderError("capability_unsupported", "lark-cli text sending does not support mentions");
    }
    if (draft.attachments?.length) {
      throw new MessageProviderError("capability_unsupported", "lark-cli attachment sending is not supported");
    }
    return { draft: { ...draft }, idempotencyKey: this.createIdempotencyKey(), warnings: [] };
  }

  async send(context: MessageProviderContext, prepared: PreparedMessageSend): Promise<MessageSendReceipt> {
    const draft = prepared.draft;
    const payload = await this.runSend([
      "im",
      "+messages-send",
      "--receive-id",
      requiredString(draft.externalConversationId, "external conversation id"),
      "--receive-id-type",
      "chat_id",
      "--msg-type",
      "text",
      "--content",
      JSON.stringify({ text: draft.text }),
      "--uuid",
      requiredString(prepared.idempotencyKey, "idempotency key"),
      "--format",
      "json",
    ], context);
    return sendReceipt(payload, draft.externalConversationId, this.now);
  }

  async reply(context: MessageProviderContext, prepared: PreparedMessageSend): Promise<MessageSendReceipt> {
    const draft = prepared.draft;
    const target = requiredString(draft.replyToExternalMessageId, "reply target message id");
    const argv = [
      "im",
      "+messages-reply",
      "--message-id",
      target,
      "--msg-type",
      "text",
      "--content",
      JSON.stringify({ text: draft.text }),
      "--uuid",
      requiredString(prepared.idempotencyKey, "idempotency key"),
    ];
    if (draft.inThread !== undefined) argv.push("--reply-in-thread", String(draft.inThread));
    argv.push("--format", "json");
    const payload = await this.runSend(argv, context);
    return sendReceipt(payload, draft.externalConversationId, this.now);
  }

  async downloadAttachment(
    context: MessageProviderContext,
    request: { externalMessageId: string; externalAttachmentId: string },
  ): Promise<MessageAttachmentDownload> {
    const payload = await this.runRead([
      "im",
      "+messages-resources-download",
      "--message-id",
      requiredString(request.externalMessageId, "external message id"),
      "--file-key",
      requiredString(request.externalAttachmentId, "external attachment id"),
      "--format",
      "json",
    ], context);
    const data = payloadRecord(payload);
    if (!data) throw new MessageProviderError("malformed_response", "attachment response is malformed");
    let bytes: Uint8Array;
    const encoded = firstString(data, ["content_base64", "contentBase64", "base64", "content"]);
    if (encoded && isBase64(encoded)) {
      bytes = Uint8Array.from(Buffer.from(encoded, "base64"));
    } else {
      const filePath = firstString(data, ["file_path", "filePath", "path"]);
      if (!filePath) {
        throw new MessageProviderError("malformed_response", "attachment response has no valid structured content");
      }
      try {
        bytes = new Uint8Array(await Bun.file(filePath).arrayBuffer());
      } catch (cause) {
        throw new MessageProviderError("malformed_response", "attachment path cannot be read", { cause });
      }
    }
    return {
      externalAttachmentId: request.externalAttachmentId,
      name: firstString(data, ["name", "file_name", "fileName"]) || null,
      mimeType: firstString(data, ["mime_type", "mimeType", "content_type", "contentType"]) || null,
      bytes,
    };
  }

  async uploadAttachment(
    _context: MessageProviderContext,
    _request: { name: string; mimeType: string | null; bytes: Uint8Array },
  ): Promise<{ externalAttachmentId: string }> {
    throw new MessageProviderError("capability_unsupported", "lark-cli attachment upload is not supported");
  }

  private async runRead(argv: readonly string[], context: MessageProviderContext): Promise<unknown> {
    let lastError: MessageProviderError | null = null;
    for (let attempt = 0; attempt < this.maxReadAttempts; attempt += 1) {
      if (context.signal?.aborted) throw new MessageProviderError("timeout", "lark-cli command was aborted");
      try {
        return await this.runner.run(argv, this.runOptions(context, "read"));
      } catch (error) {
        lastError = asProviderError(error);
        if (!lastError.retryable || attempt + 1 >= this.maxReadAttempts || context.signal?.aborted) throw lastError;
        const delay = lastError.retryAfterMs ?? this.retryBaseDelayMs * (2 ** attempt);
        await abortableSleep(this.sleep(delay), context.signal);
      }
    }
    throw lastError ?? new MessageProviderError("unknown", "lark-cli read failed");
  }

  private async runVersion(context: MessageProviderContext): Promise<unknown> {
    return await this.runner.run(["--version"], { ...this.runOptions(context, "read"), text: true });
  }

  private async runSend(argv: readonly string[], context: MessageProviderContext): Promise<unknown> {
    try {
      return await this.runner.run(argv, this.runOptions(context, "send"));
    } catch (error) {
      const providerError = asProviderError(error, "send_result_unknown");
      if (providerError.code === "timeout" || providerError.code === "unreachable") {
        throw new MessageProviderError("send_result_unknown", "lark-cli send result is indeterminate", {
          cause: providerError,
        });
      }
      throw providerError;
    }
  }

  private runOptions(context: MessageProviderContext, kind: "read" | "send"): LarkCliRunOptions {
    return { signal: context.signal, timeoutMs: this.timeoutMs, kind };
  }
}

function normalizeConversation(value: unknown): MessageConversation | null {
  const entry = record(value);
  if (!entry) return null;
  const externalConversationId = firstString(entry, ["chat_id", "chatId", "external_conversation_id", "id"]);
  if (!externalConversationId) return null;
  const memberCountValue = entry.member_count ?? entry.memberCount;
  return {
    externalConversationId,
    name: firstString(entry, ["name", "chat_name", "chatName", "title"]) || null,
    kind: conversationKind(entry.chat_type ?? entry.chatType ?? entry.chat_mode ?? entry.chatMode ?? entry.kind),
    url: firstString(entry, ["url", "chat_url", "chatUrl", "app_link", "appLink"]) || null,
    memberCount: nonNegativeInteger(memberCountValue),
    metadata: entry,
  };
}

function conversationFromMessage(value: unknown, fallbackId: string): MessageConversation | null {
  const message = record(value);
  if (!message) return null;
  const id = firstString(message, ["chat_id", "chatId"]) || fallbackId;
  return {
    externalConversationId: id,
    name: firstString(message, ["chat_name", "chatName"]) || null,
    kind: conversationKind(message.chat_type ?? message.chatType),
    url: firstString(message, ["chat_url", "chatUrl"]) || null,
    memberCount: null,
    metadata: {},
  };
}

function normalizeMessage(value: unknown, externalAccountId: string | null): CanonicalMessage | null {
  const message = record(value);
  if (!message) return null;
  const externalMessageId = firstString(message, ["message_id", "messageId", "external_message_id"]);
  const externalConversationId = firstString(message, ["chat_id", "chatId", "external_conversation_id"]);
  const sentAt = timestampValue(message.create_time ?? message.created_at ?? message.sent_at ?? message.sentAt);
  if (!externalMessageId || !externalConversationId || !sentAt) return null;

  const sender = record(message.sender) ?? {};
  const senderType = firstString(sender, ["sender_type", "senderType", "type", "kind"]).toLowerCase();
  const editedAt = timestampValue(message.update_time ?? message.updated_at ?? message.edited_at ?? message.editedAt);
  const externalSenderId = firstString(sender, ["sender_id", "senderId", "open_id", "openId", "id"]) || null;
  return {
    externalMessageId,
    externalConversationId,
    conversationName: firstString(message, ["chat_name", "chatName", "conversation_name"]) || null,
    conversationKind: conversationKind(message.chat_type ?? message.chatType ?? message.conversation_kind),
    externalThreadId: firstString(message, ["thread_id", "threadId"]) || null,
    externalRootId: firstString(message, ["root_id", "rootId"]) || null,
    externalParentId: firstString(message, ["parent_id", "parentId", "reply_to", "replyTo"]) || null,
    sender: {
      externalSenderId,
      displayName: firstString(sender, ["name", "display_name", "displayName"]) || null,
      kind: senderKind(senderType),
      isSelf: sender.is_self === true
        || sender.isSelf === true
        || (externalAccountId !== null && externalSenderId === externalAccountId),
    },
    text: messageText(message),
    attachments: normalizeAttachments(message),
    mentions: normalizeMentions(message.mentions),
    reactions: normalizeReactions(message.reactions),
    url: firstString(message, ["message_app_link", "messageAppLink", "url", "app_link"]) || null,
    sentAt,
    editedAt: editedAt && editedAt !== sentAt ? editedAt : null,
    recalled: message.deleted === true || message.recalled === true || message.withdrawn === true,
    raw: message,
  };
}

function normalizeAttachments(message: Record<string, unknown>): MessageAttachmentRef[] {
  const explicit = Array.isArray(message.attachments) ? message.attachments : [];
  const attachments = explicit
    .map((value) => {
      const attachment = record(value);
      if (!attachment) return null;
      const id = firstString(attachment, ["file_key", "fileKey", "image_key", "imageKey", "id", "external_attachment_id"]);
      if (!id) return null;
      return {
        externalAttachmentId: id,
        kind: attachmentKind(attachment.type ?? attachment.kind ?? message.msg_type),
        name: firstString(attachment, ["name", "file_name", "fileName"]) || null,
        mimeType: firstString(attachment, ["mime_type", "mimeType", "content_type", "contentType"]) || null,
        sizeBytes: nonNegativeInteger(attachment.size ?? attachment.size_bytes ?? attachment.sizeBytes),
      } satisfies MessageAttachmentRef;
    })
    .filter((entry): entry is MessageAttachmentRef => entry !== null);
  if (attachments.length > 0) return attachments;

  const content = structuredContent(message);
  const id = content && firstString(content, ["file_key", "fileKey", "image_key", "imageKey"]);
  if (!id) return [];
  return [{
    externalAttachmentId: id,
    kind: attachmentKind(message.msg_type ?? message.msgType),
    name: firstString(content, ["file_name", "fileName", "name"]) || null,
    mimeType: null,
    sizeBytes: null,
  }];
}

function normalizeMentions(value: unknown): MessageMention[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const mention = record(entry);
    if (!mention) return null;
    const key = firstString(mention, ["key", "id", "open_id", "openId"]);
    const everyone = mention.is_everyone === true || mention.isEveryone === true || key === "all";
    return {
      externalUserId: everyone ? null : firstString(mention, ["id", "open_id", "openId", "user_id", "userId"]) || null,
      displayName: firstString(mention, ["name", "display_name", "displayName"]) || null,
      isEveryone: everyone,
    } satisfies MessageMention;
  }).filter((entry): entry is MessageMention => entry !== null);
}

function normalizeReactions(value: unknown): MessageReaction[] {
  // lark-cli returns `{counts: [...], details: [...]}` — the tally plus one row
  // per reactor. The raw Feishu shape is a bare array. Only the tally is read;
  // `details` identifies individual colleagues and nothing here needs it.
  const entries = Array.isArray(value) ? value : record(value)?.counts;
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => {
    const reaction = record(entry);
    if (!reaction) return null;
    const key = firstString(reaction, ["emoji_type", "emojiType", "reaction_type", "reactionType", "key"]);
    if (!key) return null;
    return {
      key,
      count: nonNegativeInteger(reaction.count) ?? 0,
      reactedBySelf: reaction.reacted_by_self === true || reaction.reactedBySelf === true,
    } satisfies MessageReaction;
  }).filter((entry): entry is MessageReaction => entry !== null);
}

function messageText(message: Record<string, unknown>): string {
  const direct = firstString(message, ["text", "searchable_text", "searchableText"]);
  if (direct) return direct;
  const content = structuredContent(message);
  if (content) {
    const text = firstString(content, ["text", "title"]);
    if (text) return text;
    const collected = collectText(content).join("\n").trim();
    if (collected) return collected;
  }
  // Everything above handles the raw Feishu shape, where `content` is a
  // JSON-encoded object. lark-cli has already rendered it to a string by the
  // time we see it, so the string is taken whole. It is deliberately not picked
  // apart — recovering a file key from `[Image: img_v3_...]`, say, would mean
  // parsing human-facing text, which this Provider must not do.
  return stringValue(message.content);
}

function structuredContent(message: Record<string, unknown>): Record<string, unknown> | null {
  const direct = record(message.content);
  if (direct) return direct;
  const body = record(message.body);
  const encoded = typeof body?.content === "string" ? body.content : typeof message.content === "string" ? message.content : null;
  if (!encoded) return null;
  try {
    return record(JSON.parse(encoded));
  } catch {
    return null;
  }
}

function collectText(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectText);
  const entry = record(value);
  if (!entry) return [];
  const own = typeof entry.text === "string" ? [entry.text.trim()].filter(Boolean) : [];
  return own.concat(Object.entries(entry)
    .filter(([key]) => key !== "text")
    .flatMap(([, child]) => collectText(child)));
}

function sendReceipt(payload: unknown, fallbackConversationId: string, now: () => Date): MessageSendReceipt {
  const data = payloadRecord(payload);
  const externalMessageId = data && firstString(data, ["message_id", "messageId", "external_message_id"]);
  if (!externalMessageId) {
    throw new MessageProviderError("send_result_unknown", "lark-cli did not return a message id");
  }
  return {
    externalMessageId,
    externalConversationId: firstString(data, ["chat_id", "chatId", "external_conversation_id"]) || fallbackConversationId,
    sentAt: timestampValue(data.create_time ?? data.created_at ?? data.sent_at) ?? now().toISOString(),
    url: firstString(data, ["message_app_link", "messageAppLink", "url", "app_link"]) || null,
  };
}

function authUser(payload: unknown): Record<string, unknown> | null {
  const root = record(payload);
  const data = record(root?.data) ?? root;
  return record(record(data?.identities)?.user) ?? record(data?.user);
}

function versionValue(payload: unknown): string | null {
  if (typeof payload === "string") return normalizedVersion(payload);
  const data = payloadRecord(payload);
  return normalizedVersion(data && firstString(data, ["version", "cli_version", "cliVersion"]));
}

function normalizedVersion(value: unknown): string | null {
  // Accepts the bare version a JSON field would carry and the exact line
  // `lark-cli --version` prints. The prefix is anchored so that an unrelated
  // line containing digits can never be mistaken for a version.
  const match = stringValue(value).match(/^(?:lark-cli\s+version\s+)?v?(\d+\.\d+\.\d+)(?:[-+][0-9A-Za-z.-]+)?$/u);
  return match?.[1] ?? null;
}

/**
 * Human-readable reason the CLI identity cannot be used, or null when it can.
 *
 * The two states an operator has to tell apart are "never logged in" and "the
 * token ran out", because only the second is routine, so they get distinct text.
 */
function authFailure(user: Record<string, unknown>, now: Date): string | null {
  const status = stringValue(user.status).toLowerCase();
  const tokenStatus = stringValue(user.token_status ?? user.tokenStatus).toLowerCase();
  if (user.available === false) return "lark-cli user identity needs authentication";

  // The refresh token is the only part an operator can act on. While it is still
  // valid, `needs_refresh` is routine bookkeeping rather than a fault: lark-cli
  // mints a fresh access token on the next user API call and the call succeeds.
  // Treating it as expired — as this once did — reported a working connection as
  // unauthenticated every time an access token aged out, which is hourly.
  const refreshable = ["needs_refresh", "refreshable"].includes(status)
    || ["needs_refresh", "refreshable"].includes(tokenStatus);
  const refreshExpired = isPast(user.refresh_expires_at ?? user.refreshExpiresAt, now);
  if (refreshable && !refreshExpired) return null;

  const expired = refreshExpired
    || tokenStatus === "expired"
    || status === "expired"
    || isPast(user.expires_at ?? user.expiresAt, now);
  if (expired) return "lark-cli authorization has expired; sign in again";
  if (status !== "ready" || (tokenStatus && tokenStatus !== "valid")) {
    return "lark-cli user identity needs authentication";
  }
  return null;
}

function isPast(value: unknown, now: Date): boolean {
  const timestamp = Date.parse(stringValue(value));
  return Number.isFinite(timestamp) && timestamp <= now.getTime();
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}



function payloadRecord(payload: unknown): Record<string, unknown> | null {
  const root = record(payload);
  return record(root?.data) ?? root;
}

function items(payload: unknown, keys: readonly string[]): unknown[] {
  if (Array.isArray(payload)) return payload;
  const root = record(payload);
  const data = root?.data;
  if (Array.isArray(data)) return data;
  const candidates = [record(data), root].filter((entry): entry is Record<string, unknown> => entry !== null);
  for (const candidate of candidates) {
    for (const key of keys) if (Array.isArray(candidate[key])) return candidate[key] as unknown[];
  }
  throw new MessageProviderError("malformed_response", "lark-cli response has no structured result list");
}

function pageToken(payload: unknown): string | null {
  const data = payloadRecord(payload);
  return data && firstString(data, ["next_page_token", "nextPageToken", "page_token", "pageToken", "cursor"]) || null;
}

function hasMore(payload: unknown): boolean {
  const data = payloadRecord(payload);
  return data?.has_more === true || data?.hasMore === true;
}

function assertPageToken(hasMorePages: boolean, nextPageToken: string | null): void {
  if (hasMorePages && nextPageToken === null) {
    throw new MessageProviderError("malformed_response", "lark-cli paginated response has no next page token");
  }
}

function cursorPageToken(cursor: Record<string, unknown> | null): string | null {
  if (!cursor) return null;
  const token = firstString(cursor, ["pageToken", "page_token"]);
  if (!token) throw new MessageProviderError("malformed_response", "message cursor is malformed");
  return token;
}

function timestampValue(value: unknown): string | null {
  let timestamp: number;
  if (typeof value === "number" && Number.isFinite(value)) timestamp = value;
  else if (typeof value === "string" && /^\d+(?:\.\d+)?$/u.test(value.trim())) timestamp = Number(value);
  else if (typeof value === "string") timestamp = Date.parse(zonedTimestamp(value.trim()));
  else return null;
  if (timestamp > 0 && timestamp < 100_000_000_000) timestamp *= 1_000;
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

/**
 * Attach an explicit zone to the zoneless stamp lark-cli prints.
 *
 * `im +messages-search` reports `2026-09-01 00:44` — no offset, no seconds. Left
 * to `Date.parse`, that is read in the *server's* zone, so the same message
 * lands 8 hours apart on a +08:00 host and a UTC one, which quietly breaks the
 * allowlist activation cutoff and the incremental window. `BunLarkCliRunner`
 * pins the CLI's own TZ to UTC so this can be read as UTC and mean one instant.
 * Anything already carrying a zone is passed through untouched.
 */
function zonedTimestamp(value: string): string {
  const match = value.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/u);
  if (!match) return value;
  const time = match[2] as string;
  return `${match[1]}T${time}${time.length === 5 ? ":00" : ""}Z`;
}

function isAfterActivationMinute(sentAt: string, addedAt: string): boolean {
  return Math.floor(Date.parse(sentAt) / 60_000) > Math.floor(Date.parse(addedAt) / 60_000);
}

function conversationKind(value: unknown): MessageConversationKind {
  const kind = stringValue(value).toLowerCase();
  if (["p2p", "direct", "private", "single"].includes(kind)) return "direct";
  // `default` is what `im +chat-search` calls an ordinary group: that command
  // only ever returns group chats, and distinguishes plain ones from topic ones
  // as DEFAULT vs THREAD rather than with the `chat_type` messages carry.
  if (["group", "group_chat", "default"].includes(kind)) return "group";
  if (["thread", "topic"].includes(kind)) return "thread";
  return "unknown";
}

function senderKind(value: string): "user" | "bot" | "system" | "unknown" {
  if (["user", "human"].includes(value)) return "user";
  if (["bot", "app"].includes(value)) return "bot";
  if (value === "system") return "system";
  return "unknown";
}

function attachmentKind(value: unknown): MessageAttachmentRef["kind"] {
  const kind = stringValue(value).toLowerCase();
  if (["image", "img"].includes(kind)) return "image";
  if (["file", "folder"].includes(kind)) return "file";
  if (["audio", "voice"].includes(kind)) return "audio";
  if (["video", "media"].includes(kind)) return "video";
  return "unknown";
}

/**
 * Format a window boundary the way lark-cli's time filters accept it.
 *
 * `toISOString()` includes milliseconds, and Feishu rejects the whole request
 * with `invalid_parameters` when it sees them. Since the Core derives windows
 * from the clock, that fractional part is present essentially always, so this is
 * not an edge case — without truncating it, no poll ever returns a message.
 */
function cliTimestamp(value: Date): string {
  return `${value.toISOString().slice(0, 19)}Z`;
}

function assertValidWindow(start: Date, end: Date): void {
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) {
    throw new MessageProviderError("unknown", "message sync window is invalid");
  }
}

function health(
  status: MessageProviderHealth["status"],
  version: string | null,
  errorCode: MessageProviderHealth["errorCode"],
  detail: string,
  checkedAt: string,
): MessageProviderHealth {
  return {
    status,
    version,
    externalAccountId: null,
    externalAccountName: null,
    errorCode,
    detail,
    checkedAt,
  };
}

function asProviderError(error: unknown, fallback: "unknown" | "send_result_unknown" = "unknown"): MessageProviderError {
  return error instanceof MessageProviderError
    ? error
    : new MessageProviderError(fallback, `lark-cli command failed (${fallback})`, { cause: error });
}

function requiredString(value: unknown, label: string): string {
  const result = stringValue(value);
  if (!result) throw new MessageProviderError("unknown", `${label} is required`);
  return result;
}

function firstString(value: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const result = stringValue(value[key]);
    if (result) return result;
  }
  return "";
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const parsed = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * A page size lark-cli will accept, or null to let it pick its own default.
 *
 * Asking for more than the subcommand allows is answered with the most it can
 * give rather than by dropping the flag: silently falling back to lark-cli's
 * default of 20 would make a Source configured for large pages poll far more
 * often than its operator asked for, with nothing to show why.
 */
function clampedPageSize(value: unknown, maximum: number): number | null {
  const parsed = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 1) return null;
  return Math.min(parsed, maximum);
}

function isBase64(value: string): boolean {
  return value.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value);
}

function abortableSleep(sleep: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return sleep;
  if (signal.aborted) return Promise.reject(new MessageProviderError("timeout", "lark-cli command was aborted"));
  return new Promise<void>((resolve, reject) => {
    const finish = (callback: () => void): void => {
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void => finish(() => reject(
      new MessageProviderError("timeout", "lark-cli command was aborted"),
    ));
    signal.addEventListener("abort", abort, { once: true });
    sleep.then(
      () => finish(resolve),
      (error) => finish(() => reject(error)),
    );
  });
}
