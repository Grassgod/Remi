/**
 * Feishu/Lark thread (话题) operations for topic-mode groups.
 */

import { createFeishuClient } from "./client.js";
import { createLogger } from "./logger.js";
import type { FeishuChannelConfig } from "./config.js";

const log = createLogger("feishu-thread");

type Creds = Pick<FeishuChannelConfig, "appId" | "appSecret" | "domain">;

export type ThreadMessage = {
  messageId: string;
  senderId: string;
  senderType: string;
  content: string;
  msgType: string;
  createTime: string;
};

export function getBaseUrl(domain?: string): string {
  if (domain === "bytedance") return "https://fsopen.bytedance.net/open-apis";
  if (domain === "lark") return "https://open.larksuite.com/open-apis";
  return "https://open.feishu.cn/open-apis";
}

export async function getTenantToken(creds: Creds): Promise<string> {
  const baseUrl = getBaseUrl(creds.domain);
  const res = await fetch(`${baseUrl}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
  });
  const data = (await res.json()) as any;
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`Failed to get tenant token: ${data.msg}`);
  }
  return data.tenant_access_token;
}

export async function createThread(creds: Creds, chatId: string, title: string): Promise<{ threadId: string; messageId: string }> {
  const client = createFeishuClient(creds);
  const content = JSON.stringify({ zh_cn: { content: [[{ tag: "text", text: title }]] } });
  const res: any = await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: { receive_id: chatId, content, msg_type: "post" },
  });
  if (res.code !== 0) throw new Error(`Failed to create thread: ${res.msg || `code ${res.code}`}`);
  const threadId = res.data?.thread_id;
  const messageId = res.data?.message_id;
  if (!threadId && !messageId) throw new Error("No thread_id or message_id returned");
  if (!threadId) log.info(`created message ${messageId} in ${chatId} (non-topic group): ${title}`);
  else log.info(`created thread ${threadId} (root=${messageId}) in ${chatId}: ${title}`);
  return { threadId: threadId ?? messageId, messageId: messageId ?? threadId };
}

export async function sendToThread(creds: Creds, chatId: string, threadId: string, content: string): Promise<string> {
  const baseUrl = getBaseUrl(creds.domain);
  const token = await getTenantToken(creds);

  let rootMsgId: string;
  if (threadId.startsWith("om_")) {
    rootMsgId = threadId;
  } else {
    const listParams = new URLSearchParams({ container_id_type: "thread", container_id: threadId, sort_type: "ByCreateTimeAsc", page_size: "1" });
    const listRes = await fetch(`${baseUrl}/im/v1/messages?${listParams}`, { headers: { Authorization: `Bearer ${token}` } });
    const listData = (await listRes.json()) as any;
    if (listData.code !== 0) throw new Error(`Failed to list thread messages: ${listData.msg ?? JSON.stringify(listData)}`);
    rootMsgId = listData.data?.items?.[0]?.message_id;
    if (!rootMsgId) throw new Error(`Thread ${threadId} has no messages`);
  }

  const msgContent = JSON.stringify({ zh_cn: { content: [[{ tag: "md", text: content }]] } });
  const replyRes = await fetch(`${baseUrl}/im/v1/messages/${rootMsgId}/reply`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content: msgContent, msg_type: "post", reply_in_thread: true }),
  });
  const replyData = (await replyRes.json()) as any;
  if (replyData.code !== 0) throw new Error(`Failed to send to thread: ${replyData.msg ?? JSON.stringify(replyData)}`);
  log.info(`sent message to thread ${threadId} in ${chatId}`);
  return replyData.data?.message_id ?? "unknown";
}

export async function getThreadMessages(
  creds: Creds,
  chatId: string,
  threadId: string,
  options?: { pageSize?: number; pageToken?: string },
): Promise<{ messages: ThreadMessage[]; hasMore: boolean; pageToken?: string }> {
  const baseUrl = getBaseUrl(creds.domain);
  const token = await getTenantToken(creds);
  const params = new URLSearchParams({ container_id_type: "thread", container_id: threadId, sort_type: "ByCreateTimeAsc", page_size: String(options?.pageSize ?? 50) });
  if (options?.pageToken) params.set("page_token", options.pageToken);
  const res = await fetch(`${baseUrl}/im/v1/messages?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = (await res.json()) as any;
  if (data.code !== 0) throw new Error(`Failed to get thread messages: ${data.msg ?? JSON.stringify(data)}`);
  const items: any[] = data.data?.items ?? [];
  return {
    messages: items.map((item) => ({
      messageId: item.message_id ?? "",
      senderId: item.sender?.id ?? "",
      senderType: item.sender?.sender_type ?? "",
      content: item.body?.content ?? "",
      msgType: item.msg_type ?? "text",
      createTime: item.create_time ?? "",
    })),
    hasMore: data.data?.has_more ?? false,
    pageToken: data.data?.page_token,
  };
}
