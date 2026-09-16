import { mkdtemp, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { CHAT_ATTACHMENT_MAX_BYTES, sanitizeChatAttachmentFilename } from "@multiremi/contracts/attachments.js";
export { CHAT_ATTACHMENT_MAX_BYTES } from "@multiremi/contracts/attachments.js";

/** Consume bytes with a hard limit even when Content-Length is absent or incorrect. */
export async function readChatAttachmentBytes(response: Response): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > CHAT_ATTACHMENT_MAX_BYTES) {
    await response.body?.cancel();
    throw new Error("Attachment exceeds the 20MB limit");
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > CHAT_ATTACHMENT_MAX_BYTES) throw new Error("Attachment exceeds the 20MB limit");
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** The claim list is the only source of attachment IDs; never fetch user-provided URLs. */
export async function materializeChatAttachments(
  workDir: string,
  taskId: string,
  attachments: unknown[],
  download: (id: string) => Promise<Buffer>,
  signal?: AbortSignal,
): Promise<unknown[]> {
  let directory: string | undefined;
  const materialized = new Map<string, string>();
  const output: unknown[] = [];
  for (const value of attachments) {
    signal?.throwIfAborted();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      output.push(value);
      continue;
    }
    // Paths from an old claim or remote payload are not trusted local paths.
    const { localPath: _localPath, local_path: _localPathWire, localDownloadError: _error, ...attachment } = value as Record<string, unknown>;
    const id = typeof attachment.id === "string" ? attachment.id : "";
    if (!/^att_[A-Za-z0-9_]+$/.test(id)) {
      output.push({ ...attachment, localDownloadError: "Invalid attachment ID" });
      continue;
    }
    try {
      if (Number(attachment.sizeBytes ?? attachment.size_bytes) > CHAT_ATTACHMENT_MAX_BYTES) {
        throw new Error("Attachment exceeds the 20MB limit");
      }
      let localPath = materialized.get(id);
      if (!localPath) {
        const bytes = await download(id);
        signal?.throwIfAborted();
        if (bytes.byteLength > CHAT_ATTACHMENT_MAX_BYTES) throw new Error("Attachment exceeds the 20MB limit");
        // mkdtemp never reuses an attacker-created directory or a symlink. All
        // files stay below the current task's working directory and its GC.
        directory ??= await mkdtemp(join(resolve(workDir), `.remi-attachments-${createHash("sha256").update(taskId).digest("hex").slice(0, 12)}-`));
        const originalName = typeof attachment.filename === "string" ? attachment.filename : "attachment";
        const filename = sanitizeChatAttachmentFilename(originalName);
        const prefix = id.length <= 50 ? id : `${id.slice(0, 24)}-${createHash("sha256").update(id).digest("hex").slice(0, 16)}`;
        localPath = join(directory, `${prefix}-${filename}`);
        await writeFile(localPath, bytes, { flag: "wx", mode: 0o600 });
        materialized.set(id, localPath);
      }
      output.push({ ...attachment, localPath });
    } catch (error) {
      signal?.throwIfAborted();
      // Do not expose server response bodies (or credentials) in model prompts.
      const reason = error instanceof Error && error.message.includes("20MB")
        ? "Attachment exceeds the 20MB limit"
        : "Automatic download failed; use the attachment download command";
      output.push({ ...attachment, localDownloadError: reason });
    }
  }
  return output;
}
