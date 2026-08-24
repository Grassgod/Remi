import { readFileSync } from "node:fs";
import { loadMultiremiConfig } from "@multiremi/config.js";
import {
  CliApiClient,
  CliError,
  CliRenderer,
  type CliOptionSpec,
  type CliOutputMode,
  type CommandInvocation,
} from "../core/index.js";

export const CONNECTION_OPTIONS: readonly CliOptionSpec[] = [
  { name: "output", type: "string", valueName: "table|json|jsonl", description: "Output format" },
  { name: "json", type: "boolean", description: "Alias for --output json" },
  { name: "workspace", type: "string", valueName: "id", description: "Workspace ID" },
  { name: "server", aliases: ["server-url"], type: "string", valueName: "url", description: "Remi server URL" },
  { name: "token", type: "string", valueName: "value", description: "Human or task credential", conflictsWith: ["share"] },
  { name: "share", type: "string", valueName: "value", description: "Signed share credential", conflictsWith: ["token"] },
  { name: "timeout", type: "integer", valueName: "ms", description: "Request timeout in milliseconds" },
];

export const PAGE_OPTIONS: readonly CliOptionSpec[] = [
  { name: "limit", type: "integer", valueName: "n", description: "Maximum results" },
  { name: "cursor", type: "string", valueName: "cursor", description: "Page cursor" },
  { name: "query", type: "string", valueName: "text", description: "Search query" },
];

export const INPUT_OPTIONS: readonly CliOptionSpec[] = [
  { name: "data", type: "string", valueName: "json", description: "JSON object merged into the request body", conflictsWith: ["file"] },
  { name: "file", type: "string", valueName: "path|-", description: "Read request JSON from a file or stdin", conflictsWith: ["data"] },
];

export const YES_OPTION: CliOptionSpec = {
  name: "yes",
  type: "boolean",
  description: "Confirm the destructive operation",
};

export function commandOptions(
  ...groups: readonly (readonly CliOptionSpec[])[]
): CliOptionSpec[] {
  const options: CliOptionSpec[] = [];
  const seen = new Set<string>();
  for (const option of [...CONNECTION_OPTIONS, ...groups.flat()]) {
    if (seen.has(option.name)) continue;
    seen.add(option.name);
    options.push({ ...option });
  }
  return options;
}

export async function clientFor(
  invocation: CommandInvocation,
  options: { skipCapability?: boolean } = {},
): Promise<CliApiClient> {
  const config = loadMultiremiConfig();
  const shareCredential = stringOption(invocation, "share");
  const client = new CliApiClient({
    serverUrl: stringOption(invocation, "server")
      ?? process.env.MULTIREMI_SERVER_URL?.trim()
      ?? config.server_url
      ?? "http://127.0.0.1:6120",
    token: shareCredential
      ? null
      : stringOption(invocation, "token")
        ?? process.env.MULTIREMI_TOKEN?.trim()
        ?? config.token
        ?? null,
    shareToken: shareCredential,
    workspaceId: workspaceOption(invocation),
    timeoutMs: integerOption(invocation, "timeout") ?? 30_000,
  });
  if (!options.skipCapability) await client.requireCapability(invocation.spec.id);
  return client;
}

export function workspaceOption(invocation: CommandInvocation): string | null {
  const config = loadMultiremiConfig();
  return stringOption(invocation, "workspace")
    ?? process.env.MULTIREMI_WORKSPACE_ID?.trim()
    ?? config.workspace_id
    ?? null;
}

export function requiredWorkspace(invocation: CommandInvocation): string {
  return workspaceOption(invocation) ?? "local";
}

export function outputMode(invocation: CommandInvocation): CliOutputMode {
  if (invocation.options.json === true) return "json";
  const mode = stringOption(invocation, "output") ?? "table";
  if (mode === "table" || mode === "json" || mode === "jsonl") return mode;
  throw new CliError("usage", `unsupported --output ${JSON.stringify(mode)} (expected table, json, or jsonl)`);
}

export function renderResource(invocation: CommandInvocation, value: unknown, collectionKeys: readonly string[] = []): void {
  new CliRenderer().render(value ?? { ok: true }, {
    mode: outputMode(invocation),
    rows: (input) => resourceRows(input, collectionKeys),
    columns: [
      { header: "ID", value: (row) => scalar(row.id) ?? "-", maxWidth: 28 },
      { header: "NAME", value: (row) => scalar(row.name) ?? scalar(row.title) ?? scalar(row.slug) ?? "-", maxWidth: 48 },
      { header: "STATUS", value: (row) => scalar(row.status) ?? scalar(row.role) ?? scalar(row.kind) ?? "-", maxWidth: 24 },
      { header: "DETAIL", value: (row) => scalar(row.email) ?? scalar(row.url) ?? scalar(row.description) ?? "-", maxWidth: 72 },
    ],
  });
}

export async function requestBody(
  invocation: CommandInvocation,
  explicit: Readonly<Record<string, unknown>> = {},
): Promise<Record<string, unknown>> {
  const rawData = stringOption(invocation, "data");
  const file = stringOption(invocation, "file");
  let source: unknown = {};
  if (rawData) source = parseJsonObject(rawData, "--data");
  if (file) {
    const text = readFileSync(file === "-" ? 0 : file, "utf8");
    source = parseJsonObject(text, file === "-" ? "stdin" : file);
  }
  return { ...(source as Record<string, unknown>), ...definedEntries(explicit) };
}

export function requireConfirmation(invocation: CommandInvocation): void {
  if (invocation.options.yes !== true) {
    throw new CliError("usage", `${invocation.spec.path.join(" ")} requires --yes`);
  }
}

export function positional(invocation: CommandInvocation, index: number, label: string): string {
  const value = invocation.positionals[index]?.trim();
  if (!value) throw new CliError("usage", `<${label}> is required for ${invocation.spec.path.join(" ")}`);
  return value;
}

export function stringOption(invocation: CommandInvocation, name: string): string | null {
  const value = invocation.options[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function stringOptions(invocation: CommandInvocation, name: string): string[] {
  const value = invocation.options[name];
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function integerOption(invocation: CommandInvocation, name: string): number | null {
  const value = invocation.options[name];
  return typeof value === "number" ? value : null;
}

export function booleanOption(invocation: CommandInvocation, name: string): boolean | null {
  const value = invocation.options[name];
  return typeof value === "boolean" ? value : null;
}

export function csvOption(invocation: CommandInvocation, name: string): string[] | undefined {
  const raw = stringOption(invocation, name);
  if (raw === null) return undefined;
  return raw.split(",").map((value) => value.trim()).filter(Boolean);
}

export function queryOptions(invocation: CommandInvocation, extra: Record<string, unknown> = {}): Record<string, string | number | boolean | null | undefined> {
  return {
    limit: integerOption(invocation, "limit"),
    cursor: stringOption(invocation, "cursor"),
    q: stringOption(invocation, "query"),
    ...extra,
  } as Record<string, string | number | boolean | null | undefined>;
}

export function encodePath(value: string): string {
  return encodeURIComponent(value);
}

export function extractRecords(value: unknown, keys: readonly string[]): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  for (const key of keys) {
    const nested = value[key];
    if (Array.isArray(nested)) return nested.filter(isRecord);
  }
  return [value];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resourceRows(value: unknown, collectionKeys: readonly string[]): Record<string, unknown>[] {
  const rows = extractRecords(value, collectionKeys);
  if (rows.length !== 1 || !isRecord(value)) return rows;
  for (const key of [
    "workspace", "member", "invitation", "token", "project", "repository", "doc", "metadata",
    "agent", "squad", "skill", "plugin", "binding", "version", "inspection",
  ]) {
    if (isRecord(value[key])) return [value[key] as Record<string, unknown>];
  }
  return rows;
}

function parseJsonObject(raw: string, source: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value)) throw new Error("expected an object");
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError("usage", `invalid JSON from ${source}: ${message}`);
  }
}

function definedEntries(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function scalar(value: unknown): string | number | boolean | null {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : null;
}
