/**
 * Multiremi CLI — `attachment` command handler.
 *
 * Extracted verbatim from the former single-file `cli/multiremi.ts`.
 */

import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type CliOptions, rawStringOption } from "../options.js";
import {
  attachmentStringField,
  multiremiApiDownloadFile,
  multiremiApiRequest,
  normalizedAttachmentRecord,
  safeOutputFilename,
} from "../http.js";
import { printJson } from "../output.js";

export async function attachment(positional: string[], options: CliOptions): Promise<void> {
  const action = positional[0] ?? "";
  if (action !== "download") throw new Error("usage: multiremi attachment download <attachment-id> [--output-dir <dir>]");
  const attachmentId = positional[1]?.trim();
  if (!attachmentId) throw new Error("usage: multiremi attachment download <attachment-id> [--output-dir <dir>]");

  const metadata = await multiremiApiRequest<Record<string, unknown>>("GET", `/api/attachments/${encodeURIComponent(attachmentId)}`, undefined, options);
  const attachmentRow = normalizedAttachmentRecord(metadata);
  const downloadUrl = attachmentStringField(attachmentRow, "download_url", "downloadUrl", "url");
  if (!downloadUrl) throw new Error("attachment has no download URL");

  const filename = safeOutputFilename(attachmentStringField(attachmentRow, "filename") ?? attachmentId, attachmentId);
  const outputDir = rawStringOption(options, "output-dir", "outputDir", "o") ?? ".";
  const data = await multiremiApiDownloadFile(downloadUrl, options);
  const outputPath = join(outputDir, filename);
  writeFileSync(outputPath, data, { mode: 0o644 });
  const absolutePath = resolve(outputPath);

  console.error(`Downloaded: ${absolutePath}`);
  printJson({
    id: attachmentStringField(attachmentRow, "id") ?? attachmentId,
    filename,
    path: absolutePath,
    size: attachmentStringField(attachmentRow, "size_bytes", "sizeBytes") ?? String(data.byteLength),
  });
}
