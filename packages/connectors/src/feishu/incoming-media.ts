import type { MediaAttachment } from "@shared/contracts/acp-protocol.js";
import type { FeishuMediaInfo } from "./types.js";
import { CHAT_ATTACHMENT_MAX_BYTES, sanitizeChatAttachmentFilename } from "@multiremi/contracts/attachments.js";

export const FEISHU_ATTACHMENT_MAX_BYTES = CHAT_ATTACHMENT_MAX_BYTES;
// Matches the submit API's bounded attachment_ids list.
export const FEISHU_MESSAGE_ATTACHMENT_LIMIT = 10;

/** Never treat a sender-provided filename as a filesystem path. */
export function sanitizeFeishuAttachmentName(name: string | undefined, fallback = "attachment.bin"): string {
  return sanitizeChatAttachmentFilename(name || fallback);
}

function inferMediaType(placeholder: string): MediaAttachment["mediaType"] {
  if (placeholder.includes("image")) return "image";
  if (placeholder.includes("audio")) return "audio";
  if (placeholder.includes("video")) return "video";
  if (placeholder.includes("sticker")) return "sticker";
  return "file";
}

function fallbackName(type: MediaAttachment["mediaType"], contentType?: string): string {
  const extension = ({ "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" } as Record<string, string>)[contentType ?? ""];
  if (extension) return `image.${extension}`;
  return type === "audio" ? "audio.ogg" : type === "video" ? "video.mp4" : "attachment.bin";
}

/** Keep attachment bytes in memory until the host uploads them to shared storage. */
export function prepareIncomingFeishuMedia(input: { text: string; messageId: string; media: FeishuMediaInfo[] }): {
  text: string; media: MediaAttachment[];
} {
  let text = input.text;
  const media: MediaAttachment[] = [];
  const used = new Set<string>();
  for (const item of input.media) {
    const mediaType = inferMediaType(item.placeholder);
    let replacement: string;
    if (mediaType === "sticker") {
      replacement = "[表情]";
    } else {
      const base = sanitizeFeishuAttachmentName(item.fileName, fallbackName(mediaType, item.contentType));
      let fileName = base;
      const dot = base.lastIndexOf(".");
      const stem = dot > 0 ? base.slice(0, dot) : base;
      const extension = dot > 0 ? base.slice(dot) : "";
      let suffix = 2;
      while (used.has(fileName)) fileName = `${stem}-${suffix++}${extension}`;
      used.add(fileName);
      if (item.rejectedReason === "too_large" || item.buffer.length > FEISHU_ATTACHMENT_MAX_BYTES) {
        replacement = `[附件 ${fileName} 超过 20MB 未接收]`;
      } else if (item.rejectedReason === "download_failed") {
        replacement = `[附件 ${fileName} 下载失败，未接收；请重新发送]`;
      } else if (media.length >= FEISHU_MESSAGE_ATTACHMENT_LIMIT) {
        replacement = `[附件 ${fileName} 超过每条消息 ${FEISHU_MESSAGE_ATTACHMENT_LIMIT} 个附件上限，未接收；请分开发送]`;
      } else {
        media.push({ buffer: item.buffer, contentType: item.contentType ?? "application/octet-stream", fileName, mediaType });
        replacement = `[附件: ${fileName}]`;
      }
      if (mediaType === "image" && item.imageKey) {
        text += `\n${JSON.stringify({ image_key: item.imageKey, message_id: input.messageId })}`;
      }
    }
    text = text.includes(item.placeholder) ? text.replace(item.placeholder, replacement) : `${text}\n${replacement}`;
  }
  return { text, media };
}
