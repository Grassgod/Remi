const ATTACHMENT_CONTENT_PATH_RE = /\/api\/attachments\/(att_[A-Za-z0-9_]+)\//g;

/** Extract stable attachment ids from product-generated attachment URLs in Markdown or plain text. */
export function attachmentIdsFromText(value: string | null | undefined): string[] {
  if (!value) return [];
  return [...new Set([...value.matchAll(ATTACHMENT_CONTENT_PATH_RE)].map((match) => match[1]!))];
}

/** Limits shared by Chat ingestion, delivery, and daemon materialization. */
export const CHAT_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

export function sanitizeChatAttachmentFilename(value: string): string {
  const name = value.replace(/\\/g, "/").split("/").pop()!
    .replace(/[\x00-\x1f\x7f]/g, "").trim().replace(/^\.+/, "").trim() || "attachment.bin";
  const suffix = name.match(/\.[A-Za-z0-9]{1,20}$/)?.[0] ?? "";
  const encoder = new TextEncoder();
  let stem = "";
  let size = encoder.encode(suffix).length;
  for (const character of suffix ? name.slice(0, -suffix.length) : name) {
    size += encoder.encode(character).length;
    if (size > 180) break;
    stem += character;
  }
  return (stem || "attachment") + suffix;
}

const CHAT_ATTACHMENT_EXTENSIONS = new Set([
  "html", "htm", "pdf", "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg",
  "txt", "md", "csv", "tsv", "xls", "xlsx", "doc", "docx", "ppt", "pptx",
  "mp3", "mp4", "m4a", "wav", "ogg", "opus", "mov", "webm",
]);

/** Artifact types only; source, executable, archive, raw log and config extensions are excluded. */
export function chatAttachmentValidationError(filename: string, sizeBytes: number): string | null {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > CHAT_ATTACHMENT_MAX_BYTES) {
    return `Attachment ${filename} exceeds the 20MB limit`;
  }
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  if (!CHAT_ATTACHMENT_EXTENSIONS.has(extension)) return `Attachment type is not allowed: ${filename}`;
  return null;
}
