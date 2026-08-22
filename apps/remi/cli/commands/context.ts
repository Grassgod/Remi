import { loadMultiremiConfig } from "@multiremi/config.js";
import {
  CliApiClient,
  CliError,
  CliRenderer,
  type CliOutputMode,
  type CommandInvocation,
  type CommandSpec,
} from "../core/index.js";

export function contextCommandSpec(): CommandSpec {
  return {
    id: "context.get",
    path: ["context"],
    description: "Show the current CLI identity and safe workspace context",
    capability: "context.read",
    auth: ["human", "task", "daemon", "share"],
    mutation: "read",
    outputs: ["table", "json", "jsonl"],
    options: [
      { name: "output", type: "string", valueName: "table|json|jsonl", description: "Output format" },
      { name: "json", type: "boolean", description: "Alias for --output json" },
      { name: "workspace", type: "string", valueName: "id", description: "Workspace ID" },
      { name: "server", aliases: ["server-url"], type: "string", valueName: "url", description: "Remi server URL" },
      { name: "token", type: "string", valueName: "value", description: "Human, task, or daemon credential", conflictsWith: ["share"] },
      { name: "share", type: "string", valueName: "value", description: "Signed share credential", conflictsWith: ["token"] },
      { name: "limit", type: "integer", valueName: "n", description: "Maximum catalog entries" },
      { name: "cursor", type: "string", valueName: "cursor", description: "Catalog page cursor" },
      { name: "query", type: "string", valueName: "text", description: "Filter the safe catalog" },
      { name: "timeout", type: "integer", valueName: "ms", description: "Request timeout in milliseconds" },
    ],
    run: runContextCommand,
  };
}

export async function runContextCommand(invocation: CommandInvocation): Promise<void> {
  const config = loadMultiremiConfig();
  const serverUrl = stringOption(invocation, "server")
    ?? process.env.MULTIREMI_SERVER_URL?.trim()
    ?? config.server_url
    ?? "http://127.0.0.1:6120";
  const workspaceId = stringOption(invocation, "workspace")
    ?? process.env.MULTIREMI_WORKSPACE_ID?.trim()
    ?? config.workspace_id
    ?? null;
  const explicitCredential = stringOption(invocation, "token");
  const shareCredential = stringOption(invocation, "share");
  const client = new CliApiClient({
    serverUrl,
    token: shareCredential
      ? null
      : explicitCredential ?? process.env.MULTIREMI_TOKEN?.trim() ?? config.token ?? null,
    shareToken: shareCredential,
    workspaceId,
    timeoutMs: integerOption(invocation, "timeout") ?? 30_000,
  });
  const capabilities = await client.capabilities();
  const response = await client.request<Record<string, unknown>>({
    method: "GET",
    path: "/api/cli/context",
    query: {
      limit: integerOption(invocation, "limit"),
      cursor: stringOption(invocation, "cursor"),
      query: stringOption(invocation, "query"),
    },
  });
  const value = {
    ...response.data,
    capabilities,
    local: { cwd: process.cwd() },
  };
  const renderer = new CliRenderer();
  const mode = outputMode(invocation);
  renderer.render(value, {
    mode,
    rows: mode === "table" ? contextRows : undefined,
    columns: mode === "table" ? [
      { header: "TYPE", value: (row: ContextRow) => row.type },
      { header: "ID", value: (row: ContextRow) => row.id, maxWidth: 24 },
      { header: "NAME", value: (row: ContextRow) => row.name, maxWidth: 96 },
      { header: "STATUS", value: (row: ContextRow) => row.status },
    ] : undefined,
  });
}

interface ContextRow {
  type: string;
  id: string;
  name: string;
  status: string;
}

function contextRows(value: unknown): ContextRow[] {
  if (!isRecord(value)) return [];
  const rows: ContextRow[] = [];
  const workspace = recordValue(value.workspace);
  if (workspace) rows.push(row("workspace", workspace));
  const current = recordValue(value.current);
  for (const type of ["agent", "task", "chat", "issue", "session", "project", "runtime"] as const) {
    const item = recordValue(current?.[type]);
    if (item) rows.push(row(type, item));
  }
  for (const runtime of arrayRecords(current?.runtimes)) rows.push(row("runtime", runtime));
  const catalog = recordValue(value.catalog);
  for (const project of arrayRecords(catalog?.projects)) rows.push(row("project", project));
  for (const repository of arrayRecords(catalog?.repositories)) rows.push(row("repository", repository));
  const local = recordValue(value.local);
  if (local) rows.push({ type: "local", id: "-", name: stringValue(local.cwd) ?? "-", status: "-" });
  return rows;
}

function row(type: string, value: Record<string, unknown>): ContextRow {
  return {
    type,
    id: stringValue(value.id) ?? "-",
    name: stringValue(value.name) ?? stringValue(value.title) ?? "-",
    status: stringValue(value.status) ?? "-",
  };
}

function outputMode(invocation: CommandInvocation): CliOutputMode {
  if (invocation.options.json === true) return "json";
  const mode = stringOption(invocation, "output") ?? "table";
  if (mode === "table" || mode === "json" || mode === "jsonl") return mode;
  throw new CliError("usage", `unsupported --output ${JSON.stringify(mode)} (expected table, json, or jsonl)`);
}

function stringOption(invocation: CommandInvocation, name: string): string | null {
  const value = invocation.options[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integerOption(invocation: CommandInvocation, name: string): number | null {
  const value = invocation.options[name];
  return typeof value === "number" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
