import type { CliOutputMode } from "./command-registry.js";
import { CliError } from "./errors.js";

export interface CliTableColumn<T> {
  header: string;
  value: (row: T) => unknown;
  maxWidth?: number;
}

export interface CliRenderContract<T> {
  mode: CliOutputMode;
  columns?: readonly CliTableColumn<T>[];
  rows?: (value: unknown) => readonly T[];
  emptyMessage?: string;
}

export interface CliRendererOptions {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export class CliRenderer {
  private readonly stdout: (text: string) => void;
  private readonly stderr: (text: string) => void;

  constructor(options: CliRendererOptions = {}) {
    this.stdout = options.stdout ?? ((text) => console.log(text));
    this.stderr = options.stderr ?? ((text) => console.error(text));
  }

  render<T>(value: unknown, contract: CliRenderContract<T>): void {
    if (contract.mode === "json") {
      this.stdout(JSON.stringify(value ?? null, null, 2));
      return;
    }
    const rows = rowsFor(value, contract.rows);
    if (contract.mode === "jsonl") {
      for (const row of rows) this.stdout(JSON.stringify(row ?? null));
      return;
    }
    if (!contract.columns?.length) throw new CliError("usage", "table output requires registered columns");
    this.stdout(renderTable(rows, contract.columns, contract.emptyMessage ?? "No results found."));
  }

  diagnostic(message: string): void {
    this.stderr(message);
  }
}

function rowsFor<T>(value: unknown, extract?: (value: unknown) => readonly T[]): readonly T[] {
  if (extract) return extract(value);
  if (Array.isArray(value)) return value as T[];
  return [value as T];
}

export function renderTable<T>(
  rows: readonly T[],
  columns: readonly CliTableColumn<T>[],
  emptyMessage: string,
): string {
  if (!rows.length) return emptyMessage;
  const rendered = rows.map((row) => columns.map((column) => tableCell(column.value(row), column.maxWidth)));
  const widths = columns.map((column, index) => {
    const width = rendered.reduce((max, row) => Math.max(max, (row[index] ?? "").length), column.header.length);
    return column.maxWidth ? Math.min(column.maxWidth, width) : width;
  });
  return [
    columns.map((column, index) => column.header.padEnd(widths[index]!)).join("  ").trimEnd(),
    ...rendered.map((row) => row.map((value, index) => value.padEnd(widths[index]!)).join("  ").trimEnd()),
  ].join("\n");
}

function tableCell(value: unknown, maxWidth = 0): string {
  let text = value === null || value === undefined || value === ""
    ? "-"
    : typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : JSON.stringify(value);
  text = text.replace(/\s+/g, " ").trim();
  if (maxWidth > 1 && text.length > maxWidth) return `${text.slice(0, maxWidth - 1)}…`;
  return text;
}
