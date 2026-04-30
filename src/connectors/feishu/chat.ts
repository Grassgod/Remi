/**
 * Feishu/Lark chat (group) management.
 */

import { createFeishuClient } from "./client.js";
import { loadConfig } from "../../config.js";
import { createLogger } from "../../logger.js";

const log = createLogger("feishu-chat");

/** Helper: get a configured Feishu client. */
function getClient() {
  const config = loadConfig();
  return createFeishuClient({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    domain: config.feishu.domain,
  });
}

/**
 * Create a project group chat in Feishu.
 * The bot is automatically added as the app owner.
 */
export async function createProjectChat(
  name: string,
  ownerOpenId: string,
): Promise<string> {
  const client = getClient();

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
  if (!chatId) {
    throw new Error(
      `Failed to create Feishu chat: ${JSON.stringify(res?.msg ?? res)}`,
    );
  }
  return chatId;
}

/**
 * Fetch chat/group info from Feishu API.
 * Returns the chat name, or null if not found.
 */
export async function getChatName(chatId: string): Promise<string | null> {
  try {
    const client = getClient();
    const res: any = await client.im.chat.get({
      path: { chat_id: chatId },
    });
    return res?.data?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * Transfer group ownership to a user.
 * Bot must currently be the owner of the group.
 */
export async function transferChatOwner(chatId: string, newOwnerOpenId: string): Promise<boolean> {
  try {
    const client = getClient();
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

/**
 * Update chat settings (name, avatar, description).
 */
export async function updateChat(chatId: string, opts: {
  name?: string;
  avatar?: string;
  description?: string;
}): Promise<boolean> {
  try {
    const client = getClient();
    const data: Record<string, string> = {};
    if (opts.name) data.name = opts.name;
    if (opts.avatar) data.avatar = opts.avatar;
    if (opts.description) data.description = opts.description;

    await (client.im.chat as any).update({
      path: { chat_id: chatId },
      data,
    });
    log.info(`updated chat ${chatId}: ${JSON.stringify(opts)}`);
    return true;
  } catch (e) {
    log.warn(`failed to update chat ${chatId}: ${e}`);
    return false;
  }
}

/** Default Remi group avatar key (from the manually set remi · Remi group). */
export const REMI_AVATAR_KEY = "v3_00109_804c22d4-047c-4a29-b2cd-b4c5e9bbf13g";

/**
 * Resolve the Board app base URL.
 * Priority: REMI_BOARD_URL env var > localhost fallback.
 */
export function getBoardBaseUrl(): string {
  return process.env.REMI_BOARD_URL ?? "http://localhost:8090";
}

/** @deprecated Use getBoardBaseUrl() instead — kept for backwards compat. */
export const BOARD_BASE_URL = getBoardBaseUrl();

/**
 * Add a Chat Tab (群标签页) to a group, linking to the project's mission board.
 */
export async function addChatTab(chatId: string, projectId: string): Promise<boolean> {
  try {
    const client = getClient();
    const config = loadConfig();
    const baseUrl = getBaseUrl(config.feishu.domain);
    const token = await getTenantToken(config.feishu.appId, config.feishu.appSecret, baseUrl);

    const tabUrl = `${getBoardBaseUrl()}/mission/${projectId}`;
    const res = await fetch(`${baseUrl}/im/v1/chats/${chatId}/chat_tabs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_tabs: [{
          tab_name: "Missions",
          tab_type: "url",
          tab_content: { url: tabUrl },
        }],
      }),
    });
    const data = await res.json() as any;
    if (data.code !== 0) {
      log.warn(`failed to add chat tab to ${chatId}: ${data.msg}`);
      return false;
    }
    log.info(`added Mission tab to ${chatId} → ${tabUrl}`);
    return true;
  } catch (e) {
    log.warn(`failed to add chat tab to ${chatId}: ${e}`);
    return false;
  }
}

/**
 * Full group setup: avatar + chat tab. Called during project init after chat creation.
 */
export async function setupProjectChat(chatId: string, projectId: string): Promise<void> {
  // Set avatar
  await updateChat(chatId, { avatar: REMI_AVATAR_KEY });
  // Add mission board tab
  await addChatTab(chatId, projectId);
}

// ── Internal helpers ──

function getBaseUrl(domain: string): string {
  if (domain === "bytedance") return "https://fsopen.bytedance.net/open-apis";
  if (domain === "lark") return "https://open.larksuite.com/open-apis";
  return "https://open.feishu.cn/open-apis";
}

async function getTenantToken(appId: string, appSecret: string, baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data = await res.json() as any;
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`Failed to get tenant token: ${data.msg}`);
  }
  return data.tenant_access_token;
}
