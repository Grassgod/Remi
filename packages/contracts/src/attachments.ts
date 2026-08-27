const ATTACHMENT_CONTENT_PATH_RE = /\/api\/attachments\/(att_[A-Za-z0-9_]+)\//g;

/** Extract stable attachment ids from product-generated attachment URLs in Markdown or plain text. */
export function attachmentIdsFromText(value: string | null | undefined): string[] {
  if (!value) return [];
  return [...new Set([...value.matchAll(ATTACHMENT_CONTENT_PATH_RE)].map((match) => match[1]!))];
}
