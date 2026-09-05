import { createFeishuClient } from "@connectors/feishu/client.js";
import { sendCardFeishu } from "@connectors/feishu/send.js";
import { uploadImageFeishu } from "@connectors/feishu/media.js";
import {
  createFeishuImageResolver,
  FEISHU_IMAGE_MAX_BYTES,
} from "@connectors/feishu/outbound-images.js";
import { buildInboxNotificationCardWithImages } from "./inbox-card.js";
import type { MultiremiAttachment } from "@multiremi/contracts/types.js";
import { uploadedAttachmentPath } from "@multiremi/api/helpers/uploads.js";
import { readFile } from "node:fs/promises";
import { validateFeishuGroupTarget } from "@multiremi/store/repos/notification-channels-repo.js";
import {
  PermanentNotificationDeliveryError,
  type OutboundNotificationSender,
} from "./types.js";

export interface FeishuGroupSenderDependencies {
  createClient?: typeof createFeishuClient;
  sendCard?: typeof sendCardFeishu;
  uploadImage?: typeof uploadImageFeishu;
  getAttachment?: (attachmentId: string) => MultiremiAttachment | null;
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
        const resolveImage = createFeishuImageResolver({
          loadAttachment: async (source) => {
            const attachment = dependencies.getAttachment?.(source.attachmentId);
            if (!attachment || attachment.workspaceId !== notification.item.workspaceId) return null;
            if (!attachment.url.startsWith("/api/attachments/")) return null;
            if (!attachment.contentType.trim().toLowerCase().startsWith("image/")) return null;
            if (attachment.sizeBytes > FEISHU_IMAGE_MAX_BYTES) return null;
            return {
              buffer: await readFile(uploadedAttachmentPath(attachment)),
              contentType: attachment.contentType,
              fileName: attachment.filename,
            };
          },
          uploadImage: async (image) => (
            await (dependencies.uploadImage ?? uploadImageFeishu)(client, image.buffer)
          ).imageKey,
        });
        const card = await buildInboxNotificationCardWithImages({
          item: notification.item,
          workspace: notification.workspace,
          publicUrl: notification.publicUrl,
        }, resolveImage);
        await (dependencies.sendCard ?? sendCardFeishu)(client, chatId, card);
      } catch (error) {
        const failure = controlledFeishuFailure(error, [appId, appSecret]);
        if (failure.permanent) {
          throw new PermanentNotificationDeliveryError(failure.message);
        }
        throw new Error(failure.message);
      }
    },
  };
}

function controlledFeishuFailure(
  error: unknown,
  credentialValues: readonly string[],
): { message: string; permanent: boolean } {
  try {
    const providerCode = excludeCredentialNumber(
      numericField(error, ["code"]) ?? numericField(error, ["response", "data", "code"]),
      credentialValues,
    );
    const httpStatus = excludeCredentialNumber(
      numericField(error, ["status"])
        ?? numericField(error, ["statusCode"])
        ?? numericField(error, ["response", "status"]),
      credentialValues,
    );
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
  } catch {
    return { message: "feishu_send_failed category=unknown", permanent: false };
  }
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

function numericField(value: unknown, path: readonly string[]): number | null {
  try {
    const field = nestedField(value, path);
    if (typeof field === "number" && Number.isSafeInteger(field)) return field;
    if (typeof field === "string" && /^-?\d{1,12}$/u.test(field)) return Number(field);
    return null;
  } catch {
    return null;
  }
}

function stringField(value: unknown, path: readonly string[]): string | null {
  try {
    const field = nestedField(value, path);
    return typeof field === "string" ? field : null;
  } catch {
    return null;
  }
}

function nestedField(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const part of path) {
    if (!current || typeof current !== "object") return undefined;
    try {
      current = Reflect.get(current, part);
    } catch {
      return undefined;
    }
  }
  return current;
}

function excludeCredentialNumber(value: number | null, credentialValues: readonly string[]): number | null {
  if (value === null) return null;
  const serialized = String(value);
  return credentialValues.some((credential) => credential.trim() === serialized) ? null : value;
}
