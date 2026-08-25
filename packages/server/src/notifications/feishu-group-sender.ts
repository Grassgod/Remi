import { createFeishuClient } from "@connectors/feishu/client.js";
import { sendCardFeishu } from "@connectors/feishu/send.js";
import { validateFeishuGroupTarget } from "@multiremi/store/repos/notification-channels-repo.js";
import {
  PermanentNotificationDeliveryError,
  type OutboundNotificationSender,
} from "./types.js";

export interface FeishuGroupSenderDependencies {
  createClient?: typeof createFeishuClient;
  sendCard?: typeof sendCardFeishu;
}

type FeishuDeliveryFailureCategory =
  | "auth_failed"
  | "chat_not_found"
  | "forbidden"
  | "rate_limited"
  | "network_error"
  | "timeout"
  | "unknown";

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
        const failure = controlledFeishuFailure(error);
        if (failure.permanent) {
          throw new PermanentNotificationDeliveryError(failure.message);
        }
        throw new Error(failure.message);
      }
    },
  };
}

function controlledFeishuFailure(error: unknown): { message: string; permanent: boolean } {
  const providerCode = numericField(error, ["code"])
    ?? numericField(error, ["response", "data", "code"])
    ?? numericCodeFromMessage(error);
  const httpStatus = numericField(error, ["status"])
    ?? numericField(error, ["statusCode"])
    ?? numericField(error, ["response", "status"]);
  const category = classifyFeishuFailure(error, providerCode, httpStatus);
  const diagnostics = [
    `feishu_send_failed category=${category}`,
    providerCode === null ? null : `provider_code=${providerCode}`,
    httpStatus === null ? null : `http_status=${httpStatus}`,
  ].filter((value): value is string => Boolean(value));
  return {
    message: diagnostics.join(" "),
    permanent: category === "auth_failed" || category === "chat_not_found" || category === "forbidden",
  };
}

function classifyFeishuFailure(
  error: unknown,
  providerCode: number | null,
  httpStatus: number | null,
): FeishuDeliveryFailureCategory {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  const code = stringField(error, ["code"])?.toUpperCase() ?? "";
  if (
    httpStatus === 401
    || providerCode === 401
    || /unauthoriz|authentication|invalid (?:app|credential|token)/u.test(message)
  ) {
    return "auth_failed";
  }
  if (httpStatus === 404 || providerCode === 404 || /chat[^\n]*not found|not found[^\n]*chat/u.test(message)) {
    return "chat_not_found";
  }
  if (httpStatus === 403 || providerCode === 403 || /forbidden|permission denied|no permission/u.test(message)) {
    return "forbidden";
  }
  if (httpStatus === 429 || providerCode === 429 || /rate.?limit|too many requests/u.test(message)) {
    return "rate_limited";
  }
  if (/timeout|timed out|aborted/u.test(message) || /ETIMEDOUT|ESOCKETTIMEDOUT/u.test(code)) {
    return "timeout";
  }
  if (/network|socket|fetch failed|dns/u.test(message) || /ECONN|ENOTFOUND|EAI_AGAIN/u.test(code)) {
    return "network_error";
  }
  return "unknown";
}

function numericCodeFromMessage(error: unknown): number | null {
  if (!(error instanceof Error)) return null;
  const match = error.message.match(/\bcode\s+(-?\d{1,12})\b/iu);
  return match ? Number(match[1]) : null;
}

function numericField(value: unknown, path: readonly string[]): number | null {
  const field = nestedField(value, path);
  if (typeof field === "number" && Number.isSafeInteger(field)) return field;
  if (typeof field === "string" && /^-?\d{1,12}$/u.test(field)) return Number(field);
  return null;
}

function stringField(value: unknown, path: readonly string[]): string | null {
  const field = nestedField(value, path);
  return typeof field === "string" ? field : null;
}

function nestedField(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const part of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
