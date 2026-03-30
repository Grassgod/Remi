/**
 * Feishu/Lark chat (group) management.
 */

import { createFeishuClient } from "./client.js";
import { loadConfig } from "../../config.js";

/**
 * Create a project group chat in Feishu.
 * The bot is automatically added as the app owner.
 */
export async function createProjectChat(
  name: string,
  ownerOpenId: string,
): Promise<string> {
  const config = loadConfig();
  const client = createFeishuClient({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    domain: config.feishu.domain,
  });

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
    const config = loadConfig();
    const client = createFeishuClient({
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
      domain: config.feishu.domain,
    });

    const res: any = await client.im.chat.get({
      path: { chat_id: chatId },
    });

    return res?.data?.name ?? null;
  } catch {
    return null;
  }
}
