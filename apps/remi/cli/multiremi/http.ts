/**
 * Multiremi CLI — HTTP client layer against the Multiremi REST API.
 *
 * Extracted verbatim from the former single-file `cli/multiremi.ts`.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { loadMultiremiConfig } from "@multiremi/config.js";
import { type CliOptions, stringOpt, stringListOption } from "./options.js";

export interface CliAttachmentFile {
  path: string;
  filename: string;
  contentType: string;
  // Backed by a plain ArrayBuffer (not SharedArrayBuffer) so it is a valid BlobPart.
  data: Uint8Array<ArrayBuffer>;
}

export interface MultiremiApiConnection {
  serverUrl: string;
  token: string | null;
  workspaceId: string | null;
}

export function readAttachmentFiles(options: CliOptions): CliAttachmentFile[] {
  const files: CliAttachmentFile[] = [];
  for (const value of stringListOption(options, "attachment")) {
    const filePath = value.trim();
    if (!filePath) continue;
    if (isHttpUrl(filePath)) {
      console.error(`Skipping --attachment ${JSON.stringify(filePath)}: URLs are not supported here, only local file paths.`);
      continue;
    }
    let data: Buffer;
    try {
      data = readFileSync(filePath);
    } catch (err) {
      throw new Error(`read attachment ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const filename = basename(filePath) || "upload.bin";
    files.push({
      path: filePath,
      filename,
      contentType: detectCliContentTypeFromFilename(filename),
      data: new Uint8Array(data),
    });
  }
  return files;
}

export async function multiremiApiUploadFile(attachmentFile: CliAttachmentFile, issueId: string, options: CliOptions): Promise<Record<string, unknown>> {
  const connection = multiremiApiConnection(options);
  const form = new FormData();
  form.append("file", new File([attachmentFile.data], attachmentFile.filename, { type: attachmentFile.contentType }));
  if (issueId) form.append("issue_id", issueId);
  if (connection.workspaceId) form.append("workspace_id", connection.workspaceId);
  const headers: Record<string, string> = {};
  if (connection.token) headers.Authorization = `Bearer ${connection.token}`;
  const response = await fetch(`${connection.serverUrl}/api/upload-file`, {
    method: "POST",
    headers,
    body: form,
  });
  const text = await response.text();
  if (!response.ok) throw new MultiremiCliHttpError("POST", "/api/upload-file", response.status, text);
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

export async function multiremiApiDownloadFile(downloadUrl: string, options: CliOptions): Promise<Buffer> {
  const connection = multiremiApiConnection(options);
  const isRelative = !/^https?:\/\//i.test(downloadUrl);
  const url = isRelative ? `${connection.serverUrl}${downloadUrl.startsWith("/") ? "" : "/"}${downloadUrl}` : downloadUrl;
  const headers: Record<string, string> = {};
  if (isRelative && connection.token) headers.Authorization = `Bearer ${connection.token}`;
  const response = await fetch(url, { method: "GET", headers });
  if (!response.ok) {
    const text = await response.text();
    throw new MultiremiCliHttpError("GET", downloadUrl, response.status, text);
  }
  return Buffer.from(await response.arrayBuffer());
}

export function multiremiApiConnection(options: CliOptions): MultiremiApiConnection {
  const config = loadMultiremiConfig();
  return {
    serverUrl: (
      stringOpt(options.server ?? options["server-url"], process.env.MULTIREMI_SERVER_URL)
      ?? config.server_url
      ?? `http://127.0.0.1:6120`
    ).replace(/\/+$/, ""),
    token: stringOpt(options.token, process.env.MULTIREMI_TOKEN) ?? config.token ?? null,
    workspaceId: stringOpt(options.workspace ?? options["workspace-id"], process.env.MULTIREMI_WORKSPACE_ID) ?? config.workspace_id ?? null,
  };
}

export function isHttpUrl(value: string): boolean {
  const text = value.trim().toLowerCase();
  return text.startsWith("http://") || text.startsWith("https://");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function responseIssueId(value: unknown): string {
  const row = isRecord(value) && isRecord(value.issue) ? value.issue : value;
  const id = isRecord(row) ? attachmentStringField(row, "id", "issue_id", "issueId") : null;
  if (!id) throw new Error("create issue response missing issue id; cannot upload attachments");
  return id;
}

export function normalizedAttachmentRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return isRecord(value.attachment) ? { ...value.attachment, ...value } : value;
}

export function attachmentStringField(row: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

export function safeOutputFilename(value: string, fallback: string): string {
  const filename = basename(value).trim();
  return filename && filename !== "." ? filename : fallback;
}

export function detectCliContentTypeFromFilename(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".md") || lower.endsWith(".txt") || lower.endsWith(".log")) return "text/plain";
  return "application/octet-stream";
}

export type MultiremiCliHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export class MultiremiCliHttpError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${method} ${path} returned ${status}: ${body}`);
  }
}

export async function multiremiApiRequest<T = unknown>(
  method: MultiremiCliHttpMethod,
  path: string,
  body: unknown,
  options: CliOptions,
): Promise<T> {
  return (await multiremiApiFetch<T>(method, path, body, options)).data;
}

export async function multiremiApiFetch<T = unknown>(
  method: MultiremiCliHttpMethod,
  path: string,
  body: unknown,
  options: CliOptions,
): Promise<{ data: T; headers: Headers }> {
  const connection = multiremiApiConnection(options);
  const headers: Record<string, string> = {};
  if (connection.token) headers.Authorization = `Bearer ${connection.token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(connection.serverUrl + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new MultiremiCliHttpError(method, path, response.status, text);
  return {
    data: text ? JSON.parse(text) as T : undefined as T,
    headers: response.headers,
  };
}
