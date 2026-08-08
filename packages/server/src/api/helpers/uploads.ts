// Attachment upload storage: the on-disk layout under the upload root, filename sanitising and
// the local file response used when an attachment is served back.
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import type { MultiremiAttachment } from "@multiremi/contracts/types.js";

export const MAX_UPLOAD_SIZE = 100 * 1024 * 1024;

export function uploadRoot(): string {
  return process.env.MULTIREMI_UPLOAD_DIR ?? join(homedir(), ".remi", "multiremi", "uploads");
}

export function createUploadAttachmentId(): string {
  return `att_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function stringFormValue(value: FormDataEntryValue | null): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function safeFilename(value: string): string {
  const filename = basename(value).replace(/[^A-Za-z0-9._ -]/g, "_").trim();
  return filename || "upload.bin";
}

export function uploadRelativePath(workspaceId: string, attachmentId: string, filename: string): string {
  return join(safePathSegment(workspaceId || "local"), `${attachmentId}${extname(filename) || ".bin"}`);
}

export function uploadAbsolutePath(relativePath: string): string {
  return join(uploadRoot(), relativePath);
}

export function uploadedAttachmentPath(attachment: { workspaceId: string; id: string; filename: string }): string {
  return uploadAbsolutePath(uploadRelativePath(attachment.workspaceId, attachment.id, attachment.filename));
}

export async function localAttachmentFileResponse(attachment: MultiremiAttachment): Promise<Response> {
  const filePath = uploadedAttachmentPath(attachment);
  if (!filePath || !existsSync(filePath)) return Response.json({ error: "attachment file not found" }, { status: 404 });
  const info = await stat(filePath);
  const bytes = await readFile(filePath);
  return new Response(bytes, {
    headers: {
      "Content-Type": attachment.contentType || detectContentTypeFromFilename(attachment.filename),
      "Content-Length": String(info.size),
      "Content-Disposition": `attachment; filename="${attachment.filename.replace(/"/g, "")}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function safePathSegment(value: string): string {
  return String(value || "local").replace(/[^A-Za-z0-9_-]/g, "_") || "local";
}

export function detectContentTypeFromFilename(filename: string): string {
  const ext = extname(filename).toLowerCase();
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".json") return "application/json";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".md" || ext === ".txt" || ext === ".log") return "text/plain";
  return "application/octet-stream";
}
