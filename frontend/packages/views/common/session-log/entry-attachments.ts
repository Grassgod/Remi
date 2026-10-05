import type { SessionLogEntry } from "@multiremi/core/replica";
import type { Attachment } from "@multiremi/core/types";
import { parseWithFallback } from "@multiremi/core/api/schema";
import { AttachmentSchema } from "@multiremi/core/api/schemas";

/** The minimal replica port has no metadata; full log rows may carry records. */
export function entryAttachments(entry: SessionLogEntry): Attachment[] | undefined {
  const metadata = "metadata" in entry ? entry.metadata : undefined;
  if (!metadata || typeof metadata !== "object" || !("attachments" in metadata)) return undefined;
  return parseWithFallback<Attachment[]>(metadata.attachments, AttachmentSchema.array(), [],
    { endpoint: "log.metadata.attachments" });
}
