/**
 * Multiremi CLI — argument parsing and option accessors.
 *
 * Extracted verbatim from the former single-file `cli/multiremi.ts`.
 */

export interface ParsedArgs {
  command: string;
  options: CliOptions;
  positional: string[];
}

export type CliOptionValue = string | boolean | string[];

export type CliOptions = Record<string, CliOptionValue>;

export type CliOutputMode = "json" | "table";

export function parseArgs(args: string[]): ParsedArgs {
  const command = args[0] ?? "help";
  const options: CliOptions = {};
  const positional: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    if (equals > 2) {
      setParsedOption(options, arg.slice(2, equals), arg.slice(equals + 1));
      continue;
    }
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      setParsedOption(options, key, next);
      i++;
    } else {
      setParsedOption(options, key, true);
    }
  }
  return { command, options, positional };
}

export function setParsedOption(options: CliOptions, key: string, value: string | boolean): void {
  const current = options[key];
  if (current === undefined) {
    options[key] = value;
    return;
  }
  const nextValue = typeof value === "string" ? value : String(value);
  if (Array.isArray(current)) {
    current.push(nextValue);
    return;
  }
  options[key] = [String(current), nextValue];
}

export function stringOpt(value: unknown, fallback?: string): string | null {
  const optionValue = Array.isArray(value) ? value.at(-1) : value;
  const raw = typeof optionValue === "string" ? optionValue : fallback;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

export function numberOpt(value: unknown, fallback: string | undefined, defaultValue: number): number {
  const raw = typeof value === "string" ? value : fallback;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

export function addQueryParam(params: URLSearchParams, key: string, value: string | null): void {
  if (value !== null) params.set(key, value);
}

export function integerOption(options: CliOptions, key: string): number | null {
  if (!hasOption(options, key)) return null;
  const value = rawStringOption(options, key);
  if (value == null) throw new Error(`--${key} must be an integer`);
  if (!/^-?\d+$/.test(value)) throw new Error(`--${key} must be an integer`);
  return Number.parseInt(value, 10);
}

export function hasOption(options: CliOptions, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(options, key);
}

export function rawStringOption(options: CliOptions, ...keys: string[]): string | null {
  for (const key of keys) {
    if (!hasOption(options, key)) continue;
    const value = options[key];
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      const last = value.at(-1);
      return typeof last === "string" ? last : null;
    }
    return null;
  }
  return null;
}

export function stringListOption(options: CliOptions, ...keys: string[]): string[] {
  const values: string[] = [];
  for (const key of keys) {
    if (!hasOption(options, key)) continue;
    const value = options[key];
    if (typeof value === "string") values.push(value);
    else if (Array.isArray(value)) values.push(...value.filter((entry): entry is string => typeof entry === "string"));
  }
  return values;
}

export function camelizeOptionKey(key: string): string {
  return key.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
}
