/**
 * Multiremi CLI — JSON and table rendering for command output.
 *
 * Extracted verbatim from the former single-file `cli/multiremi.ts`.
 */

import { type CliOptions, type CliOutputMode, stringOpt } from "./options.js";
import { isRecord } from "./http.js";

export function outputMode(options: CliOptions, defaultMode: CliOutputMode = "json"): CliOutputMode {
  if (Boolean(options.json)) return "json";
  const output = stringOpt(options.output, undefined);
  if (!output) return defaultMode;
  if (output === "json") return "json";
  if (output === "table") return "table";
  throw new Error(`unsupported --output ${JSON.stringify(output)} (expected json or table)`);
}

export function printIssueCollection(value: unknown, options: CliOptions): void {
  if (outputMode(options, "table") !== "table") {
    printJson(value);
    return;
  }
  printIssueTable(extractList(value, "issues"), { match: false, fullId: Boolean(options["full-id"] ?? options.fullId) });
}

export function printAgentCollection(value: unknown, options: CliOptions): void {
  if (outputMode(options, "table") !== "table") {
    printJson(value);
    return;
  }
  printTable(extractList(value, "agents"), [
    { header: "ID", value: (row) => field(row, "id"), maxWidth: Boolean(options["full-id"] ?? options.fullId) ? 0 : 18 },
    { header: "NAME", value: (row) => field(row, "name"), maxWidth: 32 },
    { header: "ENGINE", value: (row) => field(row, "provider") },
    { header: "MODEL", value: (row) => field(row, "model"), maxWidth: 28 },
    { header: "VISIBILITY", value: (row) => field(row, "visibility") },
    { header: "CONCURRENCY", value: (row) => field(row, "max_concurrent_tasks", "maxConcurrentTasks") },
    { header: "UPDATED", value: (row) => shortDate(field(row, "updated_at", "updatedAt")) },
  ], "No agents found.");
}

export function printProjectDocCollection(value: unknown, options: CliOptions): void {
  if (outputMode(options, "table") !== "table") {
    printJson(value);
    return;
  }
  printTable(extractList(value, "docs"), [
    { header: "SLUG", value: (row) => field(row, "slug"), maxWidth: 28 },
    { header: "KIND", value: (row) => field(row, "kind") },
    { header: "TITLE", value: (row) => field(row, "title"), maxWidth: 48 },
    { header: "PINNED", value: (row) => field(row, "pinned") ? "yes" : "" },
    { header: "VERSION", value: (row) => field(row, "version") },
    { header: "UPDATED", value: (row) => shortDate(field(row, "updated_at", "updatedAt")) },
  ], "No project docs found.");
}

export function printIssueSessionCollection(value: unknown, options: CliOptions): void {
  if (outputMode(options, "table") !== "table") {
    printJson(value);
    return;
  }
  printTable(extractList(value, "sessions"), [
    { header: "ID", value: (row) => field(row, "id"), maxWidth: Boolean(options["full-id"] ?? options.fullId) ? 0 : 18 },
    { header: "TITLE", value: (row) => field(row, "title"), maxWidth: 36 },
    { header: "STATUS", value: (row) => field(row, "status") },
    { header: "DEFAULT", value: (row) => field(row, "is_default", "isDefault") ? "yes" : "" },
    { header: "PARTICIPANTS", value: (row) => Array.isArray(row.participants) ? row.participants.length : 0 },
    { header: "UPDATED", value: (row) => shortDate(field(row, "updated_at", "updatedAt")) },
  ], "No sessions found.");
}

export function printIssueSessionResultCollection(value: unknown, options: CliOptions): void {
  if (outputMode(options, "table") !== "table") {
    printJson(value);
    return;
  }
  printTable(extractList(value, "results"), [
    { header: "ID", value: (row) => field(row, "id"), maxWidth: Boolean(options["full-id"] ?? options.fullId) ? 0 : 18 },
    { header: "SOURCE SESSION", value: (row) => field(row, "source_session_id", "sourceSessionId"), maxWidth: 18 },
    { header: "TITLE", value: (row) => field(row, "title"), maxWidth: 36 },
    { header: "RESULT", value: (row) => field(row, "body"), maxWidth: 80 },
    { header: "PUBLISHED", value: (row) => shortDate(field(row, "created_at", "createdAt")) },
  ], "No published session results found.");
}

export function printIssueSearch(value: unknown, options: CliOptions): void {
  if (outputMode(options, "table") !== "table") {
    printJson(value);
    return;
  }
  printIssueTable(extractList(value, "issues"), { match: true, fullId: false });
}

export function printTaskRuns(value: unknown, options: CliOptions): void {
  if (outputMode(options, "table") !== "table") {
    printJson(value);
    return;
  }
  printTable(extractList(value), [
    { header: "ID", value: (row) => displayTaskId(field(row, "id"), Boolean(options["full-id"] ?? options.fullId)), maxWidth: Boolean(options["full-id"] ?? options.fullId) ? 0 : 12 },
    { header: "AGENT", value: (row) => field(row, "agent_id", "agentId"), maxWidth: 18 },
    { header: "STATUS", value: (row) => field(row, "status") },
    { header: "STARTED", value: (row) => shortDate(field(row, "started_at", "startedAt", "created_at", "createdAt")) },
    { header: "COMPLETED", value: (row) => shortDate(field(row, "completed_at", "completedAt", "updated_at", "updatedAt")) },
    { header: "ERROR", value: (row) => field(row, "error", "error_message", "errorMessage"), maxWidth: 50 },
  ], "No task runs found.");
}

export function printTaskMessages(value: unknown, options: CliOptions): void {
  if (outputMode(options) !== "table") {
    printJson(value);
    return;
  }
  printTable(extractList(value), [
    { header: "SEQ", value: (row) => field(row, "seq") },
    { header: "TYPE", value: (row) => field(row, "type", "role") },
    { header: "TOOL", value: (row) => field(row, "tool", "tool_name", "toolName") },
    { header: "CONTENT", value: (row) => field(row, "content", "output", "body", "text"), maxWidth: 80 },
  ], "No task messages found.");
}

export function printIssueComments(value: unknown, options: CliOptions): void {
  if (outputMode(options, "table") !== "table") {
    printJson(value);
    return;
  }
  printTable(extractList(value, "comments"), [
    { header: "ID", value: (row) => field(row, "id"), maxWidth: 18 },
    { header: "PARENT", value: (row) => field(row, "parent_id", "parentId") ?? "—", maxWidth: 18 },
    { header: "AUTHOR", value: (row) => assigneeLabel(field(row, "author_type", "authorType"), field(row, "author_id", "authorId")), maxWidth: 22 },
    { header: "TYPE", value: (row) => field(row, "type") },
    { header: "CONTENT", value: (row) => field(row, "content", "body"), maxWidth: 80 },
    { header: "CREATED", value: (row) => shortDate(field(row, "created_at", "createdAt")) },
  ], "No comments found.");
}

export function printIssueSubscribers(value: unknown, options: CliOptions): void {
  if (outputMode(options, "table") !== "table") {
    printJson(value);
    return;
  }
  printTable(extractList(value, "subscribers"), [
    { header: "USER", value: (row) => assigneeLabel(field(row, "user_type", "userType"), field(row, "user_id", "userId", "member_id", "memberId")), maxWidth: 22 },
    { header: "REASON", value: (row) => field(row, "reason") },
    { header: "CREATED", value: (row) => shortDate(field(row, "created_at", "createdAt")) },
  ], "No subscribers found.");
}

export function printIssueTable(rows: Record<string, unknown>[], options: { match: boolean; fullId: boolean }): void {
  if (options.match) {
    printTable(rows, [
      { header: "KEY", value: issueKey, maxWidth: 14 },
      { header: "TITLE", value: (row) => field(row, "title"), maxWidth: 72 },
      { header: "STATUS", value: (row) => field(row, "status") },
      { header: "MATCH", value: searchMatchInfo, maxWidth: 60 },
    ], "No issues found.");
    return;
  }
  printTable(rows, [
    { header: "KEY", value: issueKey, maxWidth: 14 },
    ...(options.fullId ? [{ header: "ID", value: (row: Record<string, unknown>) => field(row, "id"), maxWidth: 18 }] : []),
    { header: "TITLE", value: (row) => field(row, "title"), maxWidth: 72 },
    { header: "STATUS", value: (row) => field(row, "status") },
    { header: "PRIORITY", value: (row) => field(row, "priority") },
    { header: "ASSIGNEE", value: (row) => assigneeLabel(field(row, "assignee_type", "assigneeType"), field(row, "assignee_id", "assigneeId")), maxWidth: 24 },
    { header: "START DATE", value: (row) => dateOnly(field(row, "start_date", "startDate")) },
    { header: "DUE DATE", value: (row) => dateOnly(field(row, "due_date", "dueDate")) },
  ], "No issues found.");
}

export interface TableColumn {
  header: string;
  value: (row: Record<string, unknown>) => unknown;
  maxWidth?: number;
}

export function printTable(rows: Record<string, unknown>[], columns: TableColumn[], emptyMessage: string): void {
  if (rows.length === 0) {
    console.log(emptyMessage);
    return;
  }
  const rendered = rows.map((row) => columns.map((column) => tableCell(column.value(row), column.maxWidth)));
  const widths = columns.map((column, index) => {
    const maxCell = rendered.reduce((max, row) => Math.max(max, displayWidth(row[index] ?? "")), displayWidth(column.header));
    return column.maxWidth ? Math.min(column.maxWidth, maxCell) : maxCell;
  });
  const lines = [
    columns.map((column, index) => column.header.padEnd(widths[index]!)).join("  ").trimEnd(),
    ...rendered.map((row) => row.map((value, index) => value.padEnd(widths[index]!)).join("  ").trimEnd()),
  ];
  console.log(lines.join("\n"));
}

export function extractList(value: unknown, key?: string): Record<string, unknown>[] {
  const source = key && isRecord(value) ? value[key] : value;
  if (!Array.isArray(source)) return [];
  return source.filter(isRecord);
}

export function field(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

export function issueKey(row: Record<string, unknown>): unknown {
  return field(row, "identifier", "key", "issue_key", "issueKey", "id");
}

export function searchMatchInfo(row: Record<string, unknown>): string {
  const source = tableCell(field(row, "match_source", "matchSource"));
  const snippet = tableCell(field(row, "matched_snippet", "matchedSnippet"), 50);
  if (snippet === "-") return source;
  if (source === "-") return snippet;
  return `${source}: ${snippet}`;
}

export function assigneeLabel(type: unknown, id: unknown): string {
  const typeText = tableCell(type);
  const idText = tableCell(id);
  if (typeText === "-" && idText === "-") return "-";
  if (typeText === "-") return idText;
  if (idText === "-") return typeText;
  return `${typeText}:${idText}`;
}

export function displayTaskId(value: unknown, fullId: boolean): string {
  const text = tableCell(value);
  if (fullId || text === "-") return text;
  if (text.length <= 12) return text;
  return text.slice(0, 12);
}

export function dateOnly(value: unknown): string {
  const text = tableCell(value);
  if (text === "-") return text;
  return text.length >= 10 ? text.slice(0, 10) : text;
}

export function shortDate(value: unknown): string {
  const text = tableCell(value);
  if (text === "-") return text;
  const match = text.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/);
  if (!match) return text;
  return match[2] ? `${match[1]} ${match[2]}` : match[1]!;
}

export function tableCell(value: unknown, maxWidth = 0): string {
  let text: string;
  if (value === null || value === undefined || value === "") text = "-";
  else if (typeof value === "string") text = value;
  else if (typeof value === "number" || typeof value === "boolean") text = String(value);
  else text = JSON.stringify(value);
  text = text.replace(/\s+/g, " ").trim();
  if (maxWidth > 1 && displayWidth(text) > maxWidth) return `${text.slice(0, Math.max(0, maxWidth - 1))}…`;
  return text;
}

export function displayWidth(value: string): number {
  return value.length;
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
