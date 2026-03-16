/**
 * Feishu message receiving — WebSocket listener + message parsing.
 * Extracted from OpenClaw bot.ts + monitor.ts, stripped of OpenClaw dependencies.
 */

import * as Lark from "@larksuiteoapi/node-sdk";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { FeishuConfig } from "../../config.js";
import { createLogger } from "../../logger.js";

const log = createLogger("feishu");
import type { FeishuMessageEvent, FeishuMessageContext, FeishuMediaInfo } from "./types.js";
import { createFeishuClient, createFeishuWSClient, createEventDispatcher, probeFeishu } from "./client.js";
import { downloadImageFeishu, downloadMessageResourceFeishu } from "./media.js";
import { extractMentionTargets, extractMessageBody } from "./mention.js";
import { getMessageFeishu } from "./send.js";
import { handleFormSubmission, handleButtonClick } from "./card-actions.js";

// ── Dedup (persisted across restarts) ────────────────────────
const DEDUP_TTL_MS = 30 * 60 * 1000;
const DEDUP_MAX_SIZE = 1_000;
const DEDUP_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const DEDUP_CACHE_PATH = join(homedir(), ".remi", "dedup-cache.json");
const processedMessageIds = new Map<string, number>();
let lastCleanupTime = Date.now();
let dedupDirty = false;
let dedupFlushTimer: ReturnType<typeof setTimeout> | null = null;

/** Load persisted dedup cache from disk (best-effort). */
function loadDedupCache(): void {
  try {
    if (!existsSync(DEDUP_CACHE_PATH)) return;
    const raw = readFileSync(DEDUP_CACHE_PATH, "utf-8");
    const entries: [string, number][] = JSON.parse(raw);
    const now = Date.now();
    for (const [id, ts] of entries) {
      if (now - ts < DEDUP_TTL_MS) {
        processedMessageIds.set(id, ts);
      }
    }
    log.info(`loaded ${processedMessageIds.size} dedup entries from cache`);
  } catch {
    // Corrupt or missing — start fresh
  }
}

/** Flush dedup cache to disk (debounced, best-effort). */
function scheduleDedupFlush(): void {
  if (dedupFlushTimer) return; // already scheduled
  dedupFlushTimer = setTimeout(() => {
    dedupFlushTimer = null;
    if (!dedupDirty) return;
    flushDedupCacheSync();
  }, 2000);
}

/** Synchronously flush dedup cache to disk. Called on connector stop to prevent
 *  message re-delivery after restart (the 2s debounce may not fire before exit). */
export function flushDedupCacheSync(): void {
  if (!dedupDirty) return;
  try {
    const dir = join(homedir(), ".remi");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(DEDUP_CACHE_PATH, JSON.stringify([...processedMessageIds]));
    dedupDirty = false;
  } catch {
    // Non-critical
  }
}

// Load on module init
loadDedupCache();

function tryRecordMessage(messageId: string): boolean {
  const now = Date.now();
  if (now - lastCleanupTime > DEDUP_CLEANUP_INTERVAL_MS) {
    for (const [id, ts] of processedMessageIds) {
      if (now - ts > DEDUP_TTL_MS) processedMessageIds.delete(id);
    }
    lastCleanupTime = now;
  }
  if (processedMessageIds.has(messageId)) return false;
  if (processedMessageIds.size >= DEDUP_MAX_SIZE) {
    const first = processedMessageIds.keys().next().value!;
    processedMessageIds.delete(first);
  }
  processedMessageIds.set(messageId, now);
  dedupDirty = true;
  scheduleDedupFlush();
  return true;
}

// ── Sender name resolution ───────────────────────────────────
const SENDER_NAME_TTL_MS = 10 * 60 * 1000;
const senderNameCache = new Map<string, { name: string; expireAt: number }>();

async function resolveSenderName(
  client: Lark.Client,
  senderOpenId: string,
): Promise<string | undefined> {
  if (!senderOpenId) return undefined;

  const cached = senderNameCache.get(senderOpenId);
  const now = Date.now();
  if (cached && cached.expireAt > now) return cached.name || undefined;

  try {
    const res: any = await client.contact.user.get({
      path: { user_id: senderOpenId },
      params: { user_id_type: "open_id" },
    });
    const name: string | undefined =
      res?.data?.user?.name ||
      res?.data?.user?.display_name ||
      res?.data?.user?.nickname ||
      res?.data?.user?.en_name;
    if (name && typeof name === "string") {
      senderNameCache.set(senderOpenId, { name, expireAt: now + SENDER_NAME_TTL_MS });
      return name;
    }
  } catch (err) {
    log.info(`resolveSenderName failed for ${senderOpenId}: ${String(err)}`);
    // Negative cache: avoid repeated failed API calls for the same open_id
    senderNameCache.set(senderOpenId, { name: "", expireAt: now + SENDER_NAME_TTL_MS });
  }
  return undefined;
}

// ── Message content parsing ──────────────────────────────────

function parseTextContent(content: string, messageType: string): string {
  try {
    const parsed = JSON.parse(content);
    if (messageType === "text") return parsed.text || "";
    if (messageType === "post") return parsePostContent(content).textContent;
    return content;
  } catch {
    return content;
  }
}

/** Strip simple HTML tags (e.g. <p>, <br>, <b>) from text, preserving inner content. */
function stripHtmlTags(text: string): string {
  return text.replace(/<[^>]+>/g, "").trim();
}

export function parsePostContent(content: string): { textContent: string; imageKeys: string[] } {
  try {
    const parsed = JSON.parse(content);
    // Post messages may be wrapped in a locale key (zh_cn, en_us, ja_jp, etc.)
    const localeKey = Object.keys(parsed).find((k) => typeof parsed[k] === "object" && parsed[k]?.content);
    const body = localeKey ? parsed[localeKey] : parsed;
    const title = body.title || "";
    const contentBlocks = body.content || [];
    let textContent = title ? `${title}\n\n` : "";
    const imageKeys: string[] = [];

    for (const paragraph of contentBlocks) {
      if (Array.isArray(paragraph)) {
        for (const element of paragraph) {
          if (element.tag === "text") textContent += element.text || "";
          else if (element.tag === "a") textContent += `[${element.text || ""}](${element.href || ""})`;
          else if (element.tag === "at") textContent += `@${element.user_name || element.user_id || ""}`;
          else if (element.tag === "img" && element.image_key) imageKeys.push(element.image_key);
          else if (element.tag === "code_block") textContent += `\`\`\`${element.language || ""}\n${element.text || ""}\`\`\`\n`;
          else if (element.tag === "emotion") textContent += element.emoji_type ? `[${element.emoji_type}]` : "";
          else if (element.text) textContent += element.text; // fallback for unknown tags with text
        }
        textContent += "\n";
      }
    }

    return { textContent: stripHtmlTags(textContent.trim()) || "[富文本消息]", imageKeys };
  } catch {
    return { textContent: "[富文本消息]", imageKeys: [] };
  }
}

function parseMediaKeys(
  content: string,
  messageType: string,
): { imageKey?: string; fileKey?: string; fileName?: string } {
  try {
    const parsed = JSON.parse(content);
    switch (messageType) {
      case "image":
        return { imageKey: parsed.image_key };
      case "file":
        return { fileKey: parsed.file_key, fileName: parsed.file_name };
      case "audio":
        return { fileKey: parsed.file_key };
      case "video":
        return { fileKey: parsed.file_key, imageKey: parsed.image_key };
      case "sticker":
        return { fileKey: parsed.file_key };
      default:
        return {};
    }
  } catch {
    return {};
  }
}

/** Resolve merge_forward message: fetch sub-messages and concatenate their text. */
async function resolveMergeForward(client: Lark.Client, messageId: string): Promise<string | null> {
  const response = (await client.im.message.get({
    path: { message_id: messageId },
  })) as {
    code?: number;
    data?: {
      items?: Array<{
        message_id?: string;
        msg_type?: string;
        body?: { content?: string };
        upper_message_id?: string;
        sender?: { id?: string; sender_type?: string };
      }>;
    };
  };

  if (response.code !== 0) return null;
  const items = response.data?.items;
  if (!items || items.length <= 1) return null;

  // Skip the first item (the merge_forward wrapper itself), process sub-messages
  const parts: string[] = [];
  const anonymousMap = new Map<string, number>(); // open_id → user number
  for (const item of items) {
    if (item.message_id === messageId) continue; // skip parent
    const content = item.body?.content ?? "";
    let text = "";
    try {
      if (item.msg_type === "text") {
        const parsed = JSON.parse(content);
        text = stripHtmlTags(parsed.text || content);
      } else if (item.msg_type === "post") {
        text = parsePostContent(content).textContent;
      } else if (item.msg_type === "image") {
        // Note: cannot download images from merge_forward sub-messages (bot lacks access to cross-context message_ids)
        text = "[图片]";
      } else if (item.msg_type === "file") {
        text = "[文件]";
      } else if (item.msg_type === "sticker") {
        text = "[表情包]";
      } else if (item.msg_type === "merge_forward") {
        text = "[嵌套合并转发]";
      } else {
        text = content || `[${item.msg_type}]`;
      }
    } catch {
      text = content || `[${item.msg_type}]`;
    }

    // Prefix sender identity (name or numbered fallback)
    const senderOpenId = item.sender?.id;
    if (senderOpenId && text) {
      const name = await resolveSenderName(client, senderOpenId);
      if (name) {
        text = `${name}: ${text}`;
      } else {
        if (!anonymousMap.has(senderOpenId)) {
          anonymousMap.set(senderOpenId, anonymousMap.size + 1);
        }
        text = `用户${anonymousMap.get(senderOpenId)}: ${text}`;
      }
    }

    if (text) parts.push(text);
  }

  // Log anonymous open_id mapping for traceability
  if (anonymousMap.size > 0) {
    const mapping = [...anonymousMap.entries()].map(([id, n]) => `用户${n}=${id}`).join(", ");
    log.info(`merge_forward sender mapping: ${mapping}`);
  }

  if (parts.length === 0) return null;
  return `[合并转发消息，共${parts.length}条]\n\n${parts.join("\n\n---\n\n")}`;
}

function inferPlaceholder(messageType: string): string {
  switch (messageType) {
    case "image": return "<media:image>";
    case "file": return "<media:document>";
    case "audio": return "<media:audio>";
    case "video": return "<media:video>";
    case "sticker": return "<media:sticker>";
    default: return "<media:document>";
  }
}

function checkBotMentioned(event: FeishuMessageEvent, botOpenId?: string): boolean {
  const mentions = event.message.mentions ?? [];
  if (mentions.length === 0 || !botOpenId) return false;
  return mentions.some((m) => m.id.open_id === botOpenId);
}

function stripBotMention(text: string, mentions?: FeishuMessageEvent["message"]["mentions"]): string {
  if (!mentions || mentions.length === 0) return text;
  let result = text;
  for (const mention of mentions) {
    result = result.replace(new RegExp(`@${mention.name}\\s*`, "g"), "").trim();
    result = result.replace(new RegExp(mention.key, "g"), "").trim();
  }
  return result;
}

// ── Public API ───────────────────────────────────────────────

/** Parse a raw Feishu message event into a FeishuMessageContext. */
export function parseFeishuMessageEvent(
  event: FeishuMessageEvent,
  botOpenId?: string,
): FeishuMessageContext {
  const rawContent = parseTextContent(event.message.content, event.message.message_type);
  const mentionedBot = checkBotMentioned(event, botOpenId);
  const content = stripBotMention(rawContent, event.message.mentions);

  return {
    chatId: event.message.chat_id,
    messageId: event.message.message_id,
    senderId: event.sender.sender_id.user_id || event.sender.sender_id.open_id || "",
    senderOpenId: event.sender.sender_id.open_id || "",
    chatType: event.message.chat_type,
    mentionedBot,
    rootId: event.message.root_id || undefined,
    parentId: event.message.parent_id || undefined,
    content,
    contentType: event.message.message_type,
  };
}

/** Resolve media from a message, downloading into buffers. */
export async function resolveFeishuMedia(
  client: Lark.Client,
  messageId: string,
  messageType: string,
  content: string,
): Promise<FeishuMediaInfo[]> {
  const mediaTypes = ["image", "file", "audio", "video", "sticker", "post"];
  if (!mediaTypes.includes(messageType)) return [];

  const out: FeishuMediaInfo[] = [];

  // Handle embedded images in rich text posts
  if (messageType === "post") {
    const { imageKeys } = parsePostContent(content);
    for (const imageKey of imageKeys) {
      try {
        const result = await downloadMessageResourceFeishu(client, messageId, imageKey, "image");
        out.push({
          buffer: result.buffer,
          contentType: result.contentType,
          placeholder: "<media:image>",
          imageKey,
        });
      } catch {
        // Skip failed downloads
      }
    }
    return out;
  }

  // Handle other media types
  const mediaKeys = parseMediaKeys(content, messageType);
  const fileKey = mediaKeys.imageKey || mediaKeys.fileKey;
  if (!fileKey) return [];

  try {
    const resourceType = messageType === "image" ? "image" : "file";
    const result = await downloadMessageResourceFeishu(client, messageId, fileKey, resourceType);
    out.push({
      buffer: result.buffer,
      contentType: result.contentType,
      fileName: result.fileName || mediaKeys.fileName,
      placeholder: inferPlaceholder(messageType),
      imageKey: mediaKeys.imageKey,
    });
  } catch {
    // Skip failed downloads
  }

  return out;
}

// ── Parsed message for connector ─────────────────────────────

export type ParsedFeishuMessage = {
  text: string;
  chatId: string;
  senderOpenId: string;
  senderName?: string;
  messageId: string;
  chatType: "p2p" | "group";
  mentionedBot: boolean;
  /** True if this message was admitted via monitor mode (not @mention). */
  monitored: boolean;
  media: FeishuMediaInfo[];
  quotedContent?: string;
  rootId?: string;
};

/** Full message processing pipeline: dedup → parse → resolve sender → resolve media → resolve quote. */
export async function processFeishuMessageEvent(
  client: Lark.Client,
  event: FeishuMessageEvent,
  botOpenId?: string,
  opts?: { allowedGroups?: string[]; monitorGroups?: string[]; triggerUserIds?: string[] },
): Promise<ParsedFeishuMessage | null> {
  const messageId = event.message.message_id;

  // Dedup
  if (!tryRecordMessage(messageId)) return null;

  // Parse
  const ctx = parseFeishuMessageEvent(event, botOpenId);

  // Two-layer group message filtering:
  // 1) allowedGroups (whitelist) — empty means no restriction
  // 2) monitorGroups — these groups don't require @mention
  let monitored = false;
  if (ctx.chatType === "group") {
    const allowed = !opts?.allowedGroups?.length || opts.allowedGroups.includes(ctx.chatId);
    if (!allowed) {
      log.info(`blocked group message ${messageId} (chatId=${ctx.chatId}, not in allowedGroups)`);
      return null;
    }
    const isMonitor = opts?.monitorGroups?.includes(ctx.chatId) ?? false;
    const mentionedTriggerUser = opts?.triggerUserIds?.length
      ? (event.message.mentions ?? []).some((m) => opts.triggerUserIds!.includes(m.id.open_id ?? ""))
      : false;
    if (!ctx.mentionedBot && !isMonitor && !mentionedTriggerUser) {
      log.info(`skipped group message ${messageId} (chatId=${ctx.chatId}, not mentioned, not monitored)`);
      return null;
    }
    monitored = (isMonitor || mentionedTriggerUser) && !ctx.mentionedBot;
  }

  // Resolve sender name (best-effort)
  const senderName = await resolveSenderName(client, ctx.senderOpenId);

  // Resolve media
  const media = await resolveFeishuMedia(
    client,
    ctx.messageId,
    event.message.message_type,
    event.message.content,
  );

  // Resolve quoted message
  let quotedContent: string | undefined;
  if (ctx.parentId) {
    try {
      const quoted = await getMessageFeishu(client, ctx.parentId);
      if (quoted) quotedContent = quoted.content;
    } catch {
      // Skip
    }
  }

  // Resolve merge_forward sub-messages
  if (event.message.message_type === "merge_forward") {
    try {
      const mergedText = await resolveMergeForward(client, ctx.messageId);
      if (mergedText) ctx.content = mergedText;
    } catch {
      // Keep original content on failure
    }
  }

  // Build text
  let text = ctx.content;
  if (quotedContent) {
    text = `[Replying to: "${quotedContent}"]\n\n${text}`;
  }

  // Add speaker label for group context
  const speaker = senderName ?? ctx.senderOpenId;
  if (ctx.chatType === "group") {
    text = `${speaker}: ${text}`;
  }

  // Append media placeholders
  for (const m of media) {
    text += `\n${m.placeholder}`;
  }

  return {
    text,
    chatId: ctx.chatId,
    senderOpenId: ctx.senderOpenId,
    senderName,
    messageId: ctx.messageId,
    chatType: ctx.chatType,
    mentionedBot: ctx.mentionedBot,
    monitored,
    media,
    quotedContent,
    rootId: ctx.rootId,
  };
}

// ── WebSocket listener ───────────────────────────────────────

export type FeishuMessageCallback = (msg: ParsedFeishuMessage) => Promise<void>;

export type FeishuWSHandle = {
  stop(): void;
};

/** Start WebSocket listener. Returns a handle to stop it. */
export function startWebSocketListener(
  config: FeishuConfig & { domain?: string; connectionMode?: string },
  onMessage: FeishuMessageCallback,
): FeishuWSHandle {
  const creds = {
    appId: config.appId,
    appSecret: config.appSecret,
    domain: (config as any).domain as string | undefined,
  };

  const client = createFeishuClient(creds);
  let botOpenId: string | undefined;
  let stopped = false;

  const allowedGroups = config.allowedGroups ?? [];
  const monitorGroups = config.monitorGroups ?? [];
  const triggerUserIds = config.triggerUserIds ?? [];

  // Probe bot open_id in background
  probeFeishu(creds).then((result) => {
    if (result.ok && result.botOpenId) {
      botOpenId = result.botOpenId;
      log.info(`bot open_id resolved: ${botOpenId} (${result.botName ?? ""})`);
    } else {
      log.warn(`failed to resolve bot open_id: ${result.error ?? "unknown"}`);
    }
  });

  // Create event dispatcher + WS client
  const eventDispatcher = createEventDispatcher({
    encryptKey: config.encryptKey,
    verificationToken: config.verificationToken,
  });



  eventDispatcher.register({
    "im.message.receive_v1": async (data) => {
      if (stopped) return;
      try {
        const event = data as unknown as FeishuMessageEvent;
        const msg = await processFeishuMessageEvent(client, event, botOpenId, { allowedGroups, monitorGroups, triggerUserIds });
        if (msg) {
          await onMessage(msg);
        }
      } catch (err) {
        log.error(`error handling message: ${String(err)}`);
      }
    },
    "im.message.message_read_v1": async () => {
      // Ignore read receipts
    },
    "im.chat.member.bot.added_v1": async (data) => {
      const event = data as unknown as { chat_id: string };
      log.info(`bot added to chat ${event.chat_id}`);
    },
    "im.chat.member.bot.deleted_v1": async (data) => {
      const event = data as unknown as { chat_id: string };
      log.info(`bot removed from chat ${event.chat_id}`);
    },
    // Card action callback — handles form submissions and button clicks
    // Must return a toast response within 3s for Feishu to acknowledge the interaction
    "card.action.trigger": async (data: any) => {
      if (stopped) return { toast: { type: "info", content: "Remi is stopped" } };
      try {
        const event = data as unknown as {
          operator?: { open_id?: string };
          action?: {
            value?: Record<string, unknown>;
            tag?: string;
            form_value?: Record<string, unknown>;
            name?: string;
          };
          card?: { card_id?: string };
        };
        const action = event.action;
        if (!action) return { toast: { type: "info", content: "No action" } };

        log.info(`card action: tag=${action.tag} name=${action.name ?? ""}`);

        if (action.tag === "form" && action.form_value && action.name) {
          // Form submission — route to pending action handler
          handleFormSubmission(action.name, action.form_value);
        } else if (action.tag === "button" && action.value) {
          // Button click — route to pending action handler
          const valueStr = typeof action.value === "string"
            ? action.value
            : JSON.stringify(action.value);
          handleButtonClick(valueStr);
        }

        return { toast: { type: "success", content: "已提交，处理中..." } };
      } catch (err) {
        log.error(`error handling card action: ${String(err)}`);
        return { toast: { type: "error", content: "处理失败" } };
      }
    },
  });

  const wsClient = createFeishuWSClient(creds);
  wsClient.start({ eventDispatcher });
  log.info("WebSocket client started");

  return {
    stop() {
      stopped = true;
      // WSClient doesn't expose a close method; setting flag prevents further processing
    },
  };
}
