import { createFeishuClient } from "@connectors/feishu/client.js";
import { sendCardFeishu } from "@connectors/feishu/send.js";
import { validateFeishuGroupTarget } from "@multiremi/store/repos/notification-channels-repo.js";
import {
  PermanentNotificationDeliveryError,
  type OutboundNotificationSender,
} from "./types.js";
import { redactNotificationError } from "./error-redaction.js";

export interface FeishuGroupSenderDependencies {
  createClient?: typeof createFeishuClient;
  sendCard?: typeof sendCardFeishu;
}

export function createFeishuGroupSender(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: FeishuGroupSenderDependencies = {},
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
      try {
        const client = (dependencies.createClient ?? createFeishuClient)({
          appId,
          appSecret,
          domain: env.MULTIREMI_FEISHU_DOMAIN?.trim() || undefined,
        });
        await (dependencies.sendCard ?? sendCardFeishu)(client, chatId, notification.card);
      } catch (error) {
        throw new Error(redactNotificationError(error, env, [appSecret, appId]));
      }
    },
  };
}
