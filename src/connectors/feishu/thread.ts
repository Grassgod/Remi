/**
 * Feishu/Lark thread (话题) operations for topic-mode groups.
 */

import { createFeishuClient } from "./client.js";
import { loadConfig } from "../../config.js";
import { createLogger } from "../../logger.js";

const log = createLogger("feishu-thread");

/** A message retrieved from a thread. */
export type ThreadMessage = {
  messageId: string;
  senderId: string;
  senderType: string;
  content: string;
  msgType: string;
  createTime: string;
};

// ── Helpers ──

function getClient() {
  const config = loadConfig();
  return createFeishuClient({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    domain: config.feishu.domain,
  });
}

export function getBaseUrl(domain: string): string {
  if (domain === "bytedance") return "https://fsopen.bytedance.net/open-apis";
  if (domain === "lark") return "https://open.larksuite.com/open-apis";
  return "https://open.feishu.cn/open-apis";
}

export async function getTenantToken(appId: string, appSecret: string, baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data = (await res.json()) as any;
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`Failed to get tenant token: ${data.msg}`);
  }
  return data.tenant_access_token;
}

// ── Public API ──

/**
 * Create a thread (话题) in a topic-mode group.
 * Sends the title as the initial post; returns both thread_id (omt_xxx) and root message_id (om_xxx).
 */
export async function createThread(chatId: string, title: string): Promise<{ threadId: string; messageId: string }> {
  const client = getClient();

  const content = JSON.stringify({
    zh_cn: { content: [[{ tag: "text", text: title }]] },
  });

  const res: any = await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: { receive_id: chatId, content, msg_type: "post" },
  });

  if (res.code !== 0) {
    throw new Error(`Failed to create thread: ${res.msg || `code ${res.code}`}`);
  }

  const threadId = res.data?.thread_id;
  const messageId = res.data?.message_id;
  if (!threadId) {
    throw new Error("No thread_id returned — is the group in topic mode?");
  }

  log.info(`created thread ${threadId} (root=${messageId}) in ${chatId}: ${title}`);
  return { threadId, messageId: messageId ?? threadId };
}

/**
 * Send a message to a specific thread (话题).
 * Accepts either omt_xxx (thread container ID) or om_xxx (root message ID).
 * For omt_xxx: lists thread messages to get root, then replies.
 * For om_xxx: replies directly to the message in-thread.
 */
export async function sendToThread(
  chatId: string,
  threadId: string,
  content: string,
): Promise<string> {
  const config = loadConfig();
  const baseUrl = getBaseUrl(config.feishu.domain);
  const token = await getTenantToken(config.feishu.appId, config.feishu.appSecret, baseUrl);

  let rootMsgId: string;

  if (threadId.startsWith("om_")) {
    // threadId is already a message ID — use directly as reply target
    rootMsgId = threadId;
  } else {
    // threadId is omt_xxx — list thread messages to get root message
    const listParams = new URLSearchParams({
      container_id_type: "thread",
      container_id: threadId,
      sort_type: "ByCreateTimeAsc",
      page_size: "1",
    });
    const listRes = await fetch(`${baseUrl}/im/v1/messages?${listParams}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const listData = (await listRes.json()) as any;
    if (listData.code !== 0) {
      throw new Error(
        `Failed to list thread messages: ${listData.msg ?? JSON.stringify(listData)}`,
      );
    }

    rootMsgId = listData.data?.items?.[0]?.message_id;
    if (!rootMsgId) {
      throw new Error(`Thread ${threadId} has no messages`);
    }
  }

  // Reply to root message in-thread
  const msgContent = JSON.stringify({
    zh_cn: { content: [[{ tag: "md", text: content }]] },
  });
  const replyRes = await fetch(`${baseUrl}/im/v1/messages/${rootMsgId}/reply`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content: msgContent,
      msg_type: "post",
      reply_in_thread: true,
    }),
  });
  const replyData = (await replyRes.json()) as any;
  if (replyData.code !== 0) {
    throw new Error(
      `Failed to send to thread: ${replyData.msg ?? JSON.stringify(replyData)}`,
    );
  }

  log.info(`sent message to thread ${threadId} in ${chatId}`);
  return replyData.data?.message_id ?? "unknown";
}

/**
 * Retrieve messages from a thread (话题), paginated.
 */
export async function getThreadMessages(
  chatId: string,
  threadId: string,
  options?: { pageSize?: number; pageToken?: string },
): Promise<{ messages: ThreadMessage[]; hasMore: boolean; pageToken?: string }> {
  const config = loadConfig();
  const baseUrl = getBaseUrl(config.feishu.domain);
  const token = await getTenantToken(config.feishu.appId, config.feishu.appSecret, baseUrl);

  const params = new URLSearchParams({
    container_id_type: "thread",
    container_id: threadId,
    sort_type: "ByCreateTimeAsc",
    page_size: String(options?.pageSize ?? 50),
  });
  if (options?.pageToken) {
    params.set("page_token", options.pageToken);
  }

  const res = await fetch(`${baseUrl}/im/v1/messages?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = (await res.json()) as any;

  if (data.code !== 0) {
    throw new Error(
      `Failed to get thread messages: ${data.msg ?? JSON.stringify(data)}`,
    );
  }

  const items: any[] = data.data?.items ?? [];
  const messages: ThreadMessage[] = items.map((item) => ({
    messageId: item.message_id ?? "",
    senderId: item.sender?.id ?? "",
    senderType: item.sender?.sender_type ?? "",
    content: item.body?.content ?? "",
    msgType: item.msg_type ?? "text",
    createTime: item.create_time ?? "",
  }));

  return {
    messages,
    hasMore: data.data?.has_more ?? false,
    pageToken: data.data?.page_token,
  };
}
