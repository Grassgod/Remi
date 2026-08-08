// Cross-cutting primitives used by three or more helper modules: the API logger, the API error
// type, and small string/URL/JSON utilities that belong to no single domain.
import { createLogger } from "@shared/logger.js";

export const log = createLogger("multiremi-api");

export class MultiremiApiError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 413 | 429) {
    super(message);
  }
}

export function requestOrigin(requestUrl: string): string {
  try {
    return new URL(requestUrl).origin;
  } catch {
    return "http://127.0.0.1:6120";
  }
}

export function shellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function stripUtf8Bom(value: string): string {
  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value;
}

export function splitQueryList(value: string | undefined): string[] {
  return String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

export function uniqueStrings(values: unknown[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

export function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

export function parseJsonBody<T>(rawBody: string): T {
  if (!rawBody.trim()) return {} as T;
  try {
    return JSON.parse(rawBody) as T;
  } catch {
    throw new Error("Invalid JSON body");
  }
}

export function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}
