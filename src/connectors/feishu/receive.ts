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
    try {
      const dir = join(homedir(), ".remi");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(DEDUP_CACHE_PATH, JSON.stringify([...processedMessageIds]));
      dedupDirty = false;
    } catch {
      // Non-critical
    }
  }, 2000);
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
  if (cached && cached.expireAt > now) return cached.name;

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
  } catch {
    // Best-effort: don't fail message handling if name lookup fails
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

function parsePostContent(content: string): { textContent: string; imageKeys: string[] } {
  try {
    const parsed = JSON.parse(content);
    const title = parsed.title || "";
    const contentBlocks = parsed.content || [];
    let textContent = title ? `${title}\n\n` : "";
    const imageKeys: string[] = [];

    for (const paragraph of contentBlocks) {
      if (Array.isArray(paragraph)) {
        for (const element of paragraph) {
          if (element.tag === "text") textContent += element.text || "";
          else if (element.tag === "a") textContent += element.text || element.href || "";
          else if (element.tag === "at") textContent += `@${element.user_name || element.user_id || ""}`;
          else if (element.tag === "img" && element.image_key) imageKeys.push(element.image_key);
        }
        textContent += "\n";
      }
    }

    return { textContent: textContent.trim() || "[富文本消息]", imageKeys };
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
  media: FeishuMediaInfo[];
  quotedContent?: string;
  rootId?: string;
};

/** Full message processing pipeline: dedup → parse → resolve sender → resolve media → resolve quote. */
export async function processFeishuMessageEvent(
  client: Lark.Client,
  event: FeishuMessageEvent,
  botOpenId?: string,
  opts?: { autoReplyGroups?: string[] },
): Promise<ParsedFeishuMessage | null> {
  const messageId = event.message.message_id;

  // Dedup
  if (!tryRecordMessage(messageId)) return null;

  // Parse
  const ctx = parseFeishuMessageEvent(event, botOpenId);

  // In groups, only respond if bot is mentioned (unless chat is in autoReplyGroups)
  const autoReply = opts?.autoReplyGroups?.includes(ctx.chatId) ?? false;
  if (ctx.chatType === "group" && !ctx.mentionedBot && !autoReply) {
    log.info(`skipped group message ${messageId} (chatId=${ctx.chatId}, mentionedBot=false, autoReply=false)`);
    return null;
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

  const autoReplyGroups = config.autoReplyGroups ?? [];

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
        const msg = await processFeishuMessageEvent(client, event, botOpenId, { autoReplyGroups });
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
