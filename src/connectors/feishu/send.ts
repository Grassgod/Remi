/**
 * Feishu message sending utilities.
 * Adapted from OpenClaw feishu extension send.ts — removed runtime/account dependencies.
 */

import type * as Lark from "@larksuiteoapi/node-sdk";
import type { FeishuSendResult } from "./types.js";
import type { MentionTarget } from "./mention.js";
import { buildMentionedMessage, buildMentionedCardContent } from "./mention.js";
import { resolveReceiveIdType } from "./client.js";
import { parsePostContent } from "./receive.js";

/** Build Feishu post message payload (rich text with markdown support). */
function buildFeishuPostMessagePayload(params: { messageText: string }): {
  content: string;
  msgType: string;
} {
  const { messageText } = params;
  return {
    content: JSON.stringify({
      zh_cn: {
        content: [[{ tag: "md", text: messageText }]],
      },
    }),
    msgType: "post",
  };
}

/** Send a text message (rendered as rich text post). */
export async function sendMessageFeishu(
  client: Lark.Client,
  to: string,
  text: string,
  options?: {
    replyToMessageId?: string;
    mentions?: MentionTarget[];
  },
): Promise<FeishuSendResult> {
  const receiveId = to.trim();
  if (!receiveId) throw new Error(`Invalid Feishu target: ${to}`);

  const receiveIdType = resolveReceiveIdType(receiveId);

  let rawText = text ?? "";
  if (options?.mentions && options.mentions.length > 0) {
    rawText = buildMentionedMessage(options.mentions, rawText);
  }

  const { content, msgType } = buildFeishuPostMessagePayload({ messageText: rawText });

  if (options?.replyToMessageId) {
    const response = await client.im.message.reply({
      path: { message_id: options.replyToMessageId },
      data: { content, msg_type: msgType },
    });
    if (response.code !== 0) {
      throw new Error(`Feishu reply failed: ${response.msg || `code ${response.code}`}`);
    }
    return { messageId: response.data?.message_id ?? "unknown", chatId: receiveId };
  }

  const response = await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: { receive_id: receiveId, content, msg_type: msgType },
  });
  if (response.code !== 0) {
    throw new Error(`Feishu send failed: ${response.msg || `code ${response.code}`}`);
  }
  return { messageId: response.data?.message_id ?? "unknown", chatId: receiveId };
}

/** Build a Feishu interactive card with markdown content (schema 2.0). */
export function buildMarkdownCard(text: string): Record<string, unknown> {
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    body: {
      elements: [{ tag: "markdown", content: text }],
    },
  };
}

/** Build a rich Feishu card with optional thinking panel and stats footer. */
export function buildRichCard(options: {
  text: string;
  thinking?: string | null;
  stats?: string | null;
}): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [];

  // Collapsible thinking panel
  if (options.thinking) {
    elements.push({
      tag: "collapsible_panel",
      expanded: false,
      background_style: "default",
      header: { title: { tag: "plain_text", content: "💭 Thinking" } },
      vertical_spacing: "2px",
      elements: [
        { tag: "markdown", content: options.thinking },
      ],
    });
  }

  // Main content
  elements.push({ tag: "markdown", content: options.text });

  // Stats footer
  if (options.stats) {
    elements.push({ tag: "hr" });
    elements.push({ tag: "markdown", content: options.stats });
  }

  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    body: { elements },
  };
}

/** Send a card message. */
export async function sendCardFeishu(
  client: Lark.Client,
  to: string,
  card: Record<string, unknown>,
  options?: { replyToMessageId?: string },
): Promise<FeishuSendResult> {
  const receiveId = to.trim();
  if (!receiveId) throw new Error(`Invalid Feishu target: ${to}`);

  const receiveIdType = resolveReceiveIdType(receiveId);
  const content = JSON.stringify(card);

  if (options?.replyToMessageId) {
    const response = await client.im.message.reply({
      path: { message_id: options.replyToMessageId },
      data: { content, msg_type: "interactive" },
    });
    if (response.code !== 0) {
      throw new Error(`Feishu card reply failed: ${response.msg || `code ${response.code}`}`);
    }
    return { messageId: response.data?.message_id ?? "unknown", chatId: receiveId };
  }

  const response = await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: { receive_id: receiveId, content, msg_type: "interactive" },
  });
  if (response.code !== 0) {
    throw new Error(`Feishu card send failed: ${response.msg || `code ${response.code}`}`);
  }
  return { messageId: response.data?.message_id ?? "unknown", chatId: receiveId };
}

/** Update an existing card message. */
export async function updateCardFeishu(
  client: Lark.Client,
  messageId: string,
  card: Record<string, unknown>,
): Promise<void> {
  const content = JSON.stringify(card);
  const response = await client.im.message.patch({
    path: { message_id: messageId },
    data: { content },
  });
  if (response.code !== 0) {
    throw new Error(`Feishu card update failed: ${response.msg || `code ${response.code}`}`);
  }
}

/** Send text as a markdown card. */
export async function sendMarkdownCardFeishu(
  client: Lark.Client,
  to: string,
  text: string,
  options?: {
    replyToMessageId?: string;
    mentions?: MentionTarget[];
  },
): Promise<FeishuSendResult> {
  let cardText = text;
  if (options?.mentions && options.mentions.length > 0) {
    cardText = buildMentionedCardContent(options.mentions, text);
  }
  const card = buildMarkdownCard(cardText);
  return sendCardFeishu(client, to, card, { replyToMessageId: options?.replyToMessageId });
}

/** Edit an existing text message (within 24h limit). */
export async function editMessageFeishu(
  client: Lark.Client,
  messageId: string,
  text: string,
): Promise<void> {
  const { content, msgType } = buildFeishuPostMessagePayload({ messageText: text });
  const response = await client.im.message.update({
    path: { message_id: messageId },
    data: { msg_type: msgType, content },
  });
  if (response.code !== 0) {
    throw new Error(`Feishu message edit failed: ${response.msg || `code ${response.code}`}`);
  }
}

/** Get a message by its ID (for quoted/replied message content). */
export async function getMessageFeishu(
  client: Lark.Client,
  messageId: string,
): Promise<{ content: string; contentType: string } | null> {
  try {
    const response = (await client.im.message.get({
      path: { message_id: messageId },
    })) as {
      code?: number;
      data?: {
        items?: Array<{
          msg_type?: string;
          body?: { content?: string };
        }>;
      };
    };

    if (response.code !== 0) return null;
    const item = response.data?.items?.[0];
    if (!item) return null;

    let content = item.body?.content ?? "";
    try {
      if (item.msg_type === "text") {
        const parsed = JSON.parse(content);
        if (parsed.text) content = parsed.text;
      } else if (item.msg_type === "post") {
        content = parsePostContent(content).textContent;
      }
    } catch {
      // Keep raw content
    }

    return { content, contentType: item.msg_type ?? "text" };
  } catch {
    return null;
  }
}
