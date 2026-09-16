/**
 * Feishu image/file upload & download.
 * Adapted from OpenClaw feishu extension media.ts — removed runtime/account dependencies.
 */

import type * as Lark from "@larksuiteoapi/node-sdk";
import { Readable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { resolveReceiveIdType } from "./client.js";
import { createLogger } from "@shared/logger.js";
import { FEISHU_ATTACHMENT_MAX_BYTES } from "./incoming-media.js";

const log = createLogger("feishu-media");

// ── Image compression ─────────────────────────────────────────

/**
 * Max long edge before resize (Claude's native resolution for non-Opus 4.7).
 * Claude internally resizes to this anyway; doing it client-side avoids the
 * 8000px hard error and reduces request payload size.
 */
const MAX_LONG_EDGE = 1568;
const MAX_FILE_BYTES = 4 * 1024 * 1024; // 4 MB

export interface CompressResult {
  buffer: Buffer;
  contentType: string;
  /** true if the image was modified (resize or re-encode) */
  compressed: boolean;
  originalSize: number;
  finalSize: number;
}

/**
 * Compress an image buffer so it fits within model input limits.
 *
 * Strategy:
 *   1. If within limits → return unchanged (truly lossless)
 *   2. Resize needed → resize to MAX_LONG_EDGE with aspect-ratio preserved
 *      - PNG input → stay PNG (lossless at new resolution)
 *      - JPEG/WebP/other → JPEG quality 92
 *   3. Still too large after resize → JPEG quality 88 (rare: e.g. huge PNG screenshots)
 */
export async function compressImageForModel(
  buffer: Buffer,
  contentType?: string,
): Promise<CompressResult> {
  let sharp: typeof import("sharp");
  try {
    const sharpModule = await import("sharp");
    sharp = sharpModule.default ?? sharpModule;
  } catch {
    // sharp not available — pass through unchanged
    log.warn("sharp not available, skipping image compression");
    return { buffer, contentType: contentType ?? "image/jpeg", compressed: false, originalSize: buffer.length, finalSize: buffer.length };
  }

  const meta = await sharp(buffer).metadata();
  const { width = 0, height = 0, format } = meta;
  const originalContentType = ({ jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
    tiff: "image/tiff", avif: "image/avif", svg: "image/svg+xml" } as Record<string, string>)[format ?? ""]
    ?? contentType ?? "image/jpeg";
  const longEdge = Math.max(width, height);
  const needsResize = longEdge > MAX_LONG_EDGE;
  const needsSizeReduce = buffer.length > MAX_FILE_BYTES;

  if (!needsResize && !needsSizeReduce) {
    return { buffer, contentType: originalContentType, compressed: false, originalSize: buffer.length, finalSize: buffer.length };
  }

  const isPng = format === "png" || contentType?.includes("png");
  const originalSize = buffer.length;

  log.info(`compressing image: ${width}x${height} ${(originalSize / 1024).toFixed(0)}KB format=${format} needsResize=${needsResize}`);

  let pipeline = sharp(buffer);
  if (needsResize) {
    pipeline = pipeline.resize(MAX_LONG_EDGE, MAX_LONG_EDGE, { fit: "inside", withoutEnlargement: true });
  }

  if (isPng) {
    // PNG: lossless compression after resize
    const result = await pipeline.png({ compressionLevel: 9 }).toBuffer();
    if (result.length <= MAX_FILE_BYTES) {
      log.info(`compressed: ${(originalSize / 1024).toFixed(0)}KB → ${(result.length / 1024).toFixed(0)}KB (PNG)`);
      return { buffer: result, contentType: "image/png", compressed: true, originalSize, finalSize: result.length };
    }
    // PNG still too large (very dense screenshot) → fall through to JPEG
    log.info(`PNG still ${(result.length / 1024).toFixed(0)}KB after resize, re-encoding as JPEG`);
    pipeline = sharp(buffer);
    if (needsResize) pipeline = pipeline.resize(MAX_LONG_EDGE, MAX_LONG_EDGE, { fit: "inside", withoutEnlargement: true });
  }

  // JPEG output
  const quality = needsSizeReduce && !needsResize ? 88 : 92;
  const result = await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
  log.info(`compressed: ${(originalSize / 1024).toFixed(0)}KB → ${(result.length / 1024).toFixed(0)}KB (JPEG q${quality})`);
  return { buffer: result, contentType: "image/jpeg", compressed: true, originalSize, finalSize: result.length };
}

export type DownloadResult = {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
};

export type UploadImageResult = { imageKey: string };
export type UploadFileResult = { fileKey: string };
export type SendMediaResult = { messageId: string; chatId: string };

/**
 * Convert various Feishu SDK response formats to a Buffer.
 * The SDK returns different types depending on version/runtime.
 */
export class FeishuAttachmentTooLargeError extends Error {
  constructor() { super("Feishu attachment exceeds 20MB"); this.name = "FeishuAttachmentTooLargeError"; }
}

async function responseToBuffer(response: unknown): Promise<Buffer> {
  const r = response as any;
  const checked = (buffer: Buffer): Buffer => {
    if (buffer.length > FEISHU_ATTACHMENT_MAX_BYTES) throw new FeishuAttachmentTooLargeError();
    return buffer;
  };
  if (Buffer.isBuffer(response)) return checked(response);
  if (response instanceof ArrayBuffer) return checked(Buffer.from(response));
  if (r?.data && Buffer.isBuffer(r.data)) return checked(r.data);
  if (r?.data instanceof ArrayBuffer) return checked(Buffer.from(r.data));
  const stream = typeof r?.getReadableStream === "function" ? r.getReadableStream() : r;
  if (stream && typeof stream[Symbol.asyncIterator] === "function") {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += buffer.length;
      if (length > FEISHU_ATTACHMENT_MAX_BYTES) throw new FeishuAttachmentTooLargeError();
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, length);
  }
  // SDK getReadableStream is supported; a writeFile-only response cannot be
  // bounded during download and must not write unchecked bytes to local disk.
  throw new Error("Feishu download: unexpected response format");
}

/** Download an image from Feishu using image_key, with automatic compression. */
export async function downloadImageFeishu(
  client: Lark.Client,
  imageKey: string,
): Promise<DownloadResult> {
  const response = await client.im.image.get({ path: { image_key: imageKey } });
  const r = response as any;
  if (r.code !== undefined && r.code !== 0) {
    throw new Error(`Feishu image download failed: ${r.msg || `code ${r.code}`}`);
  }
  const raw = await responseToBuffer(response);
  const { buffer, contentType } = await compressImageForModel(raw, responseContentType(r));
  return { buffer, contentType };
}

/** Download a message resource (file/image) from Feishu. Images are auto-compressed. */
export async function downloadMessageResourceFeishu(
  client: Lark.Client,
  messageId: string,
  fileKey: string,
  type: "image" | "file",
): Promise<DownloadResult> {
  const response = await client.im.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type },
  });
  const r = response as any;
  if (r.code !== undefined && r.code !== 0) {
    throw new Error(`Feishu resource download failed: ${r.msg || `code ${r.code}`}`);
  }
  const raw = await responseToBuffer(response);
  if (type === "image") {
    const { buffer, contentType } = await compressImageForModel(raw, responseContentType(r));
    return { buffer, contentType };
  }
  return { buffer: raw, contentType: responseContentType(r) };
}

function responseContentType(response: { headers?: Record<string, unknown> }): string | undefined {
  const header = response.headers?.["content-type"];
  return typeof header === "string" ? header.split(";")[0]?.trim() : undefined;
}

/** Upload an image to Feishu and get an image_key. */
export async function uploadImageFeishu(
  client: Lark.Client,
  image: Buffer | string,
  imageType: "message" | "avatar" = "message",
): Promise<UploadImageResult> {
  const imageStream =
    typeof image === "string" ? fs.createReadStream(image) : Readable.from(image);

  const response = await client.im.image.create({
    data: { image_type: imageType, image: imageStream as any },
  });
  const r = response as any;
  if (r.code !== undefined && r.code !== 0) {
    throw new Error(`Feishu image upload failed: ${r.msg || `code ${r.code}`}`);
  }
  const imageKey = r.image_key ?? r.data?.image_key;
  if (!imageKey) {
    throw new Error("Feishu image upload failed: no image_key returned");
  }
  return { imageKey };
}

/** Upload a file to Feishu and get a file_key. */
export async function uploadFileFeishu(
  client: Lark.Client,
  file: Buffer | string,
  fileName: string,
  fileType: "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream",
): Promise<UploadFileResult> {
  const fileStream =
    typeof file === "string" ? fs.createReadStream(file) : Readable.from(file);

  const response = await client.im.file.create({
    data: { file_type: fileType, file_name: fileName, file: fileStream as any },
  });
  const r = response as any;
  if (r.code !== undefined && r.code !== 0) {
    throw new Error(`Feishu file upload failed: ${r.msg || `code ${r.code}`}`);
  }
  const fileKey = r.file_key ?? r.data?.file_key;
  if (!fileKey) {
    throw new Error("Feishu file upload failed: no file_key returned");
  }
  return { fileKey };
}

/** Send an image message using an image_key. */
export async function sendImageFeishu(
  client: Lark.Client,
  to: string,
  imageKey: string,
  replyToMessageId?: string,
  idempotencyKey?: string,
): Promise<SendMediaResult> {
  const receiveId = to.trim();
  if (!receiveId) throw new Error(`Invalid Feishu target: ${to}`);
  const receiveIdType = resolveReceiveIdType(receiveId);
  const content = JSON.stringify({ image_key: imageKey });

  if (replyToMessageId) {
    const response = await client.im.message.reply({
      path: { message_id: replyToMessageId },
      data: { content, msg_type: "image", reply_in_thread: true, ...(idempotencyKey ? { uuid: idempotencyKey } : {}) },
    });
    if (response.code !== 0) {
      throw new Error(`Feishu image reply failed: ${response.msg || `code ${response.code}`}`);
    }
    return { messageId: response.data?.message_id ?? "unknown", chatId: receiveId };
  }

  const response = await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: { receive_id: receiveId, content, msg_type: "image", ...(idempotencyKey ? { uuid: idempotencyKey } : {}) },
  });
  if (response.code !== 0) {
    throw new Error(`Feishu image send failed: ${response.msg || `code ${response.code}`}`);
  }
  return { messageId: response.data?.message_id ?? "unknown", chatId: receiveId };
}

/** Send a file message using a file_key. */
export async function sendFileFeishu(
  client: Lark.Client,
  to: string,
  fileKey: string,
  msgType: "file" | "media" = "file",
  replyToMessageId?: string,
  idempotencyKey?: string,
): Promise<SendMediaResult> {
  const receiveId = to.trim();
  if (!receiveId) throw new Error(`Invalid Feishu target: ${to}`);
  const receiveIdType = resolveReceiveIdType(receiveId);
  const content = JSON.stringify({ file_key: fileKey });

  if (replyToMessageId) {
    const response = await client.im.message.reply({
      path: { message_id: replyToMessageId },
      data: { content, msg_type: msgType, reply_in_thread: true, ...(idempotencyKey ? { uuid: idempotencyKey } : {}) },
    });
    if (response.code !== 0) {
      throw new Error(`Feishu file reply failed: ${response.msg || `code ${response.code}`}`);
    }
    return { messageId: response.data?.message_id ?? "unknown", chatId: receiveId };
  }

  const response = await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: { receive_id: receiveId, content, msg_type: msgType, ...(idempotencyKey ? { uuid: idempotencyKey } : {}) },
  });
  if (response.code !== 0) {
    throw new Error(`Feishu file send failed: ${response.msg || `code ${response.code}`}`);
  }
  return { messageId: response.data?.message_id ?? "unknown", chatId: receiveId };
}

export interface FeishuAttachmentSendInput {
  chatId: string;
  replyToMessageId?: string;
  buffer: Buffer;
  filename: string;
  contentType: string;
  idempotencyKey: string;
  signal?: AbortSignal;
}

/** Upload first, then recheck the delivery lease before creating the message. */
export async function sendAttachmentFeishu(client: Lark.Client, input: FeishuAttachmentSendInput): Promise<SendMediaResult> {
  input.signal?.throwIfAborted();
  if (input.contentType.startsWith("image/") && input.contentType !== "image/svg+xml") {
    const { imageKey } = await uploadImageFeishu(client, input.buffer);
    input.signal?.throwIfAborted();
    return sendImageFeishu(client, input.chatId, imageKey, input.replyToMessageId, input.idempotencyKey);
  }
  const { fileKey } = await uploadFileFeishu(client, input.buffer, input.filename, detectFileType(input.filename));
  input.signal?.throwIfAborted();
  return sendFileFeishu(client, input.chatId, fileKey, "file", input.replyToMessageId, input.idempotencyKey);
}

/** Detect Feishu file_type from file extension. */
export function detectFileType(
  fileName: string,
): "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream" {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case ".opus":
    case ".ogg":
      return "opus";
    case ".mp4":
    case ".mov":
    case ".avi":
      return "mp4";
    case ".pdf":
      return "pdf";
    case ".doc":
    case ".docx":
      return "doc";
    case ".xls":
    case ".xlsx":
      return "xls";
    case ".ppt":
    case ".pptx":
      return "ppt";
    default:
      return "stream";
  }
}

/** Check if a file extension represents an image. */
export function isImageExtension(fileName: string): boolean {
  const ext = path.extname(fileName).toLowerCase();
  return [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".ico", ".tiff"].includes(ext);
}
