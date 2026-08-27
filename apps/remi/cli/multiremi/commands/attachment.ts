/**
 * Multiremi CLI — `attachment` command handler.
 *
 * Extracted verbatim from the former single-file `cli/multiremi.ts`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { hasOption, type CliOptions, rawStringOption } from "../options.js";
import {
  attachmentStringField,
  multiremiApiDownloadFile,
  multiremiApiRequest,
  normalizedAttachmentRecord,
  safeOutputFilename,
} from "../http.js";
import { printJson } from "../output.js";

export async function attachment(positional: string[], options: CliOptions): Promise<void> {
  const usage = "usage: remi attachment download <attachment-id> [--output <file> | --output-dir <dir>]";
  const action = positional[0] ?? "";
  if (action !== "download" || positional.length > 2) throw new Error(usage);
  const attachmentId = positional[1]?.trim();
  if (!attachmentId) throw new Error(usage);
  if (hasOption(options, "output") && hasOption(options, "output-dir")) {
    throw new Error("--output conflicts with --output-dir");
  }

  const metadata = await multiremiApiRequest<Record<string, unknown>>("GET", `/api/attachments/${encodeURIComponent(attachmentId)}`, undefined, options);
  const attachmentRow = normalizedAttachmentRecord(metadata);
  const downloadUrl = attachmentStringField(attachmentRow, "download_url", "downloadUrl", "url");
  if (!downloadUrl) throw new Error("attachment has no download URL");

  const filename = safeOutputFilename(attachmentStringField(attachmentRow, "filename") ?? attachmentId, attachmentId);
  const requestedOutput = rawStringOption(options, "output");
  const outputDir = rawStringOption(options, "output-dir", "outputDir") ?? ".";
  const data = await multiremiApiDownloadFile(downloadUrl, options);
  const outputPath = requestedOutput ? resolve(requestedOutput) : resolve(join(outputDir, filename));
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, data, { mode: 0o644 });

  console.error(`Downloaded: ${outputPath}`);
  printJson({
    id: attachmentStringField(attachmentRow, "id") ?? attachmentId,
    filename: basename(outputPath),
    path: outputPath,
    size: attachmentStringField(attachmentRow, "size_bytes", "sizeBytes") ?? String(data.byteLength),
  });
}
