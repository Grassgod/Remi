/**
 * Feishu/Lark chat (group) management.
 */

import { createFeishuClient } from "./client.js";
import { createLogger } from "./logger.js";
import type { FeishuChannelConfig } from "./config.js";

const log = createLogger("feishu-chat");

type Creds = Pick<FeishuChannelConfig, "appId" | "appSecret" | "domain">;

function getBaseUrl(domain?: string): string {
  if (domain === "bytedance") return "https://fsopen.bytedance.net/open-apis";
  if (domain === "lark") return "https://open.larksuite.com/open-apis";
  return "https://open.feishu.cn/open-apis";
}

async function getTenantToken(creds: Creds): Promise<string> {
  const baseUrl = getBaseUrl(creds.domain);
  const res = await fetch(`${baseUrl}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
  });
  const data = await res.json() as any;
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`Failed to get tenant token: ${data.msg}`);
  }
  return data.tenant_access_token;
}

export async function createProjectChat(creds: Creds, name: string, ownerOpenId: string): Promise<string> {
  const client = createFeishuClient(creds);
  const res: any = await client.im.chat.create({
    data: {
      name: `${name} · Remi`,
      chat_mode: "group",
      chat_type: "private",
      group_message_type: "thread",
      owner_id: ownerOpenId,
      user_id_list: [ownerOpenId],
    },
    params: { user_id_type: "open_id" },
  });
  const chatId = res?.data?.chat_id;
  if (!chatId) throw new Error(`Failed to create Feishu chat: ${JSON.stringify(res?.msg ?? res)}`);
  return chatId;
}

export async function getChatName(creds: Creds, chatId: string): Promise<string | null> {
  try {
    const client = createFeishuClient(creds);
    const res: any = await client.im.chat.get({ path: { chat_id: chatId } });
    return res?.data?.name ?? null;
  } catch {
    return null;
  }
}

export async function transferChatOwner(creds: Creds, chatId: string, newOwnerOpenId: string): Promise<boolean> {
  try {
    const client = createFeishuClient(creds);
    await (client.im.chat as any).update({
      path: { chat_id: chatId },
      data: { owner_id: newOwnerOpenId },
      params: { user_id_type: "open_id" },
    });
    log.info(`transferred ownership of ${chatId} to ${newOwnerOpenId}`);
    return true;
  } catch (e) {
    log.warn(`failed to transfer ownership of ${chatId}: ${e}`);
    return false;
  }
}

export async function updateChat(creds: Creds, chatId: string, opts: { name?: string; avatar?: string; description?: string }): Promise<boolean> {
  try {
    const client = createFeishuClient(creds);
    const data: Record<string, string> = {};
    if (opts.name) data.name = opts.name;
    if (opts.avatar) data.avatar = opts.avatar;
    if (opts.description) data.description = opts.description;
    await (client.im.chat as any).update({ path: { chat_id: chatId }, data });
    log.info(`updated chat ${chatId}: ${JSON.stringify(opts)}`);
    return true;
  } catch (e) {
    log.warn(`failed to update chat ${chatId}: ${e}`);
    return false;
  }
}

export const REMI_AVATAR_KEY = "v3_00109_804c22d4-047c-4a29-b2cd-b4c5e9bbf13g";

export function getBoardBaseUrl(): string {
  return process.env.REMI_BOARD_URL ?? "http://localhost:8090";
}

export async function addChatTab(creds: Creds, chatId: string, projectId: string): Promise<boolean> {
  try {
    const baseUrl = getBaseUrl(creds.domain);
    const token = await getTenantToken(creds);
    const tabUrl = `${getBoardBaseUrl()}/mission/${projectId}`;
    const res = await fetch(`${baseUrl}/im/v1/chats/${chatId}/chat_tabs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ chat_tabs: [{ tab_name: "Missions", tab_type: "url", tab_content: { url: tabUrl } }] }),
    });
    const data = await res.json() as any;
    if (data.code !== 0) { log.warn(`failed to add chat tab to ${chatId}: ${data.msg}`); return false; }
    log.info(`added Mission tab to ${chatId} → ${tabUrl}`);
    return true;
  } catch (e) {
    log.warn(`failed to add chat tab to ${chatId}: ${e}`);
    return false;
  }
}

export async function setupProjectChat(creds: Creds, chatId: string, projectId: string): Promise<void> {
  await updateChat(creds, chatId, { avatar: REMI_AVATAR_KEY });
  await addChatTab(creds, chatId, projectId);
}
