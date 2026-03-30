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
      name: `[Remi] ${name}`,
      chat_mode: "group",
      chat_type: "private",
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
