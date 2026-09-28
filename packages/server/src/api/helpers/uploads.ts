// Attachment upload storage: the on-disk layout under the upload root, filename sanitising and
// the local file response used when an attachment is served back.
import { existsSync } from "node:fs";
import { mkdir, open, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import type { CreateAttachmentInput, MultiremiAttachment } from "@multiremi/contracts/types.js";

export const MAX_UPLOAD_SIZE = 100 * 1024 * 1024;

export function uploadRoot(): string {
  return process.env.MULTIREMI_UPLOAD_DIR ?? join(homedir(), ".remi", "multiremi", "uploads");
}

export function createUploadAttachmentId(): string {
  return `att_${crypto.randomUUID().replace(/-/g, "")}`;
}

/** Persist bytes before an atomic row insert; only this attempt's files may be removed. */
export async function persistUploadedAttachments<T>(
  workspaceId: string,
  files: Array<{ filename: string; bytes: Uint8Array | (() => Promise<Uint8Array>); contentType: string }>,
  insert: (inputs: CreateAttachmentInput[]) => T,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const createdPaths: string[] = [];
    try {
      const inputs: CreateAttachmentInput[] = [];
      for (const file of files) {
        const id = createUploadAttachmentId();
        const path = uploadAbsolutePath(uploadRelativePath(workspaceId, id, file.filename));
        await mkdir(dirname(path), { recursive: true });
        const handle = await open(path, "wx");
        createdPaths.push(path);
        let sizeBytes: number;
        try {
          const bytes = typeof file.bytes === "function" ? await file.bytes() : file.bytes;
          sizeBytes = bytes.byteLength;
          await handle.writeFile(bytes);
        }
        finally { await handle.close(); }
        inputs.push({ id, workspaceId, filename: file.filename, url: `/api/attachments/${id}/content`,
          contentType: file.contentType, sizeBytes });
      }
      return insert(inputs);
    } catch (error) {
      await Promise.all(createdPaths.map(async path => {
        try { await unlink(path); }
        catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
        }
      }));
      if (!isAttachmentIdCollision(error)) throw error;
    }
  }
  throw new Error("attachment id collision after 3 upload attempts");
}

function isAttachmentIdCollision(error: unknown): boolean {
  if ((error as NodeJS.ErrnoException | null)?.code === "EEXIST") return true;
  // The PostgreSQL sync bridge currently forwards only the server message.
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UNIQUE constraint failed: multiremi_attachments.id")
    || /duplicate key value violates unique constraint "multiremi_attachments_pkey"/.test(message);
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

// All upload writers use exclusive creation through persistUploadedAttachments.
export async function localAttachmentFileResponse(
  attachment: MultiremiAttachment,
  requestHeaders?: { get(name: string): string | null },
): Promise<Response> {
  const filePath = uploadedAttachmentPath(attachment);
  if (!filePath || !existsSync(filePath)) return Response.json({ error: "attachment file not found" }, { status: 404 });
  const info = await stat(filePath);
  const headers: Record<string, string> = {
    "Content-Type": attachment.contentType || detectContentTypeFromFilename(attachment.filename),
    "Content-Length": String(info.size),
    "Content-Disposition": `attachment; filename="${attachment.filename.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(attachment.filename).replace(/[!'()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    "Cache-Control": requestHeaders ? "private, max-age=31536000, immutable" : "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (requestHeaders) {
    headers["ETag"] = `"${attachment.id}"`;
    // Private caches must also separate login credentials.
    headers["Vary"] = "Authorization, Cookie";
  }
  // The caller completes authorization and visibility checks before this helper.
  if (requestHeaders && ifNoneMatchMatches(requestHeaders.get("if-none-match"), headers["ETag"]!)) {
    delete headers["Content-Length"];
    return new Response(null, { status: 304, headers });
  }
  return new Response(Bun.file(filePath), { headers });
}

// GET revalidation uses weak comparison, including wildcard and validator lists.
function ifNoneMatchMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  const candidates = header.split(",").map((value) => value.trim());
  if (candidates.includes("*")) return true;
  return candidates.some((candidate) => {
    const value = candidate.startsWith("W/") ? candidate.slice(2).trim() : candidate;
    return value === etag;
  });
}

export function safePathSegment(value: string): string {
  return String(value || "local").replace(/[^A-Za-z0-9_-]/g, "_") || "local";
}

export function detectContentTypeFromFilename(filename: string): string {
  const ext = extname(filename).toLowerCase();
  if (ext === ".html" || ext === ".htm") return "text/html";
  if (ext === ".csv") return "text/csv";
  if (ext === ".tsv") return "text/tab-separated-values";
  if (ext === ".bmp") return "image/bmp";
  if (ext === ".doc") return "application/msword";
  if (ext === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === ".xls") return "application/vnd.ms-excel";
  if (ext === ".xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (ext === ".ppt") return "application/vnd.ms-powerpoint";
  if (ext === ".pptx") return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".ogg" || ext === ".opus") return "audio/ogg";
  if (ext === ".m4a") return "audio/mp4";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".webm") return "video/webm";
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
