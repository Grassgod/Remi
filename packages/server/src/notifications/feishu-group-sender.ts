import { createFeishuClient } from "@connectors/feishu/client.js";
import { sendCardFeishu } from "@connectors/feishu/send.js";
import { validateFeishuGroupTarget } from "@multiremi/store/repos/notification-channels-repo.js";
import {
  PermanentNotificationDeliveryError,
  type OutboundNotificationSender,
} from "./types.js";

export function createFeishuGroupSender(
  env: NodeJS.ProcessEnv = process.env,
): OutboundNotificationSender {
  return {
    async send(notification): Promise<void> {
      const appId = env.MULTIREMI_FEISHU_APP_ID?.trim() ?? "";
      const appSecret = env.MULTIREMI_FEISHU_APP_SECRET?.trim() ?? "";
      if (!appId || !appSecret) {
        throw new PermanentNotificationDeliveryError("feishu credentials not configured");
      }
      let chatId: string;
      try {
        chatId = validateFeishuGroupTarget({ chatId: notification.chatId }).chatId;
      } catch {
        throw new PermanentNotificationDeliveryError("invalid Feishu group chat target");
      }
      const client = createFeishuClient({
        appId,
        appSecret,
        domain: env.MULTIREMI_FEISHU_DOMAIN?.trim() || undefined,
      });
      await sendCardFeishu(client, chatId, notification.card);
    },
  };
}
