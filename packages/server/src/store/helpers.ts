// Shared pure helpers used by the Multiremi store and its per-domain repos.
// Extracted verbatim from store.ts so store.ts and repos/*.ts import one copy.
import type { MultiremiTaskStatus, TaskUsageEntry } from "@multiremi/contracts/types.js";

const TERMINAL_STATUSES: MultiremiTaskStatus[] = ["completed", "failed", "cancelled"];
const ACTIVE_TASK_STATUSES: MultiremiTaskStatus[] = ["queued", "dispatched", "running", "waiting_local_directory", "awaiting_human"];
const IN_FLIGHT_TASK_STATUSES: MultiremiTaskStatus[] = ["dispatched", "running", "waiting_local_directory", "awaiting_human"];

export function isTerminalStatus(status: MultiremiTaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function isActiveTaskStatus(status: MultiremiTaskStatus): boolean {
  return ACTIVE_TASK_STATUSES.includes(status);
}

export function isInFlightTaskStatus(status: MultiremiTaskStatus): boolean {
  return IN_FLIGHT_TASK_STATUSES.includes(status);
}

export function toJson(value: unknown): string {
  return JSON.stringify(value);
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cleanOptionalString(value: unknown): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
}

export function normalizeOptionalTimezone(value: unknown): string | null {
  const timezone = String(value ?? "").trim();
  if (!timezone) return null;
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    return timezone;
  } catch {
    throw new Error("invalid timezone");
  }
}

export function hasAnyField(target: object, ...keys: string[]): boolean {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(target, key));
}

export function resolveOptionalStringField(
  target: object,
  camelKey: string,
  snakeKey: string,
  current: string | null,
): string | null {
  const values = target as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(values, camelKey)) return values[camelKey] == null ? null : String(values[camelKey]);
  if (Object.prototype.hasOwnProperty.call(values, snakeKey)) return values[snakeKey] == null ? null : String(values[snakeKey]);
  return current;
}

export function normalizePositiveInt(value: number | null | undefined, fallback: number): number {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.floor(number);
}

export function normalizeRuntimeConcurrency(value: number | null | undefined): number {
  const concurrency = Number(value ?? 1);
  if (!Number.isFinite(concurrency) || concurrency < 1) throw new Error("maxConcurrency must be at least 1");
  return Math.floor(concurrency);
}

/**
 * Deterministic runtime id for a (daemon, provider) pair — FNV-1a over
 * "<daemonId>:<provider>". Daemon registration (registerDaemonRuntimes in
 * api.ts) derives runtime ids the same way, which is what makes a stamp on a
 * not-yet-registered daemon resolve once the machine comes online.
 */
export function daemonRuntimeId(daemonId: string, provider: string): string {
  const key = `${daemonId}:${provider}`.toLowerCase();
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `rt_${(hash >>> 0).toString(36)}`;
}

export function searchMatch(value: string, query: string): boolean {
  const haystack = value.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return terms.length > 0 && terms.every((term) => haystack.includes(term));
}

export function normalizeSearchQuery(value: string | undefined): string {
  return String(value ?? "").trim();
}

export function clampSearchLimit(value: number | undefined): number {
  const limit = Number(value ?? 20);
  if (!Number.isFinite(limit) || limit <= 0) return 20;
  return Math.min(50, Math.floor(limit));
}

export function searchRank(matchSource: string): number {
  if (matchSource === "key") return 0;
  if (matchSource === "title") return 1;
  if (matchSource === "description") return 2;
  return 3;
}

export function extractSearchSnippet(value: string, query: string): string {
  const text = String(value);
  const term = query.toLowerCase().split(/\s+/).filter(Boolean).find((item) => text.toLowerCase().includes(item)) ?? "";
  if (!term) return text.slice(0, 160);
  const index = text.toLowerCase().indexOf(term);
  const start = Math.max(0, index - 50);
  const end = Math.min(text.length, index + term.length + 80);
  return `${start > 0 ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`;
}

export function uniqueBy<T>(items: T[], keyFor: (item: T) => string): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const item of items) {
    const key = keyFor(item);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

export function compactRef(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function uniqueRefMatch<T>(
  items: T[],
  ref: string,
  getId: (item: T) => string,
  getAliases: (item: T) => Array<string | null | undefined>,
): T | null {
  const value = ref.trim();
  if (!value) return null;
  const lower = value.toLowerCase();
  const compact = compactRef(value);
  const aliasValues = (item: T) => getAliases(item).map((alias) => alias?.trim()).filter((alias): alias is string => Boolean(alias));
  const tiers: Array<(item: T) => boolean> = [
    (item) => getId(item) === value,
    (item) => getId(item).toLowerCase() === lower,
    (item) => aliasValues(item).some((alias) => alias.toLowerCase() === lower),
    (item) => getId(item).toLowerCase().startsWith(lower),
    (item) => aliasValues(item).some((alias) => compactRef(alias) === compact),
    (item) => aliasValues(item).some((alias) => alias.toLowerCase().startsWith(lower)),
    (item) => aliasValues(item).some((alias) => searchMatch(alias, value)),
  ];
  for (const tier of tiers) {
    const matches = uniqueBy(items.filter(tier), getId);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) return null;
  }
  return null;
}

export type RuntimeUsageEntry = Required<Pick<TaskUsageEntry,
  "provider" |
  "model" |
  "inputTokens" |
  "outputTokens" |
  "cacheReadTokens" |
  "cacheWriteTokens" |
  "totalTokens"
>>;

export function parseTaskUsageEntries(value: unknown): RuntimeUsageEntry[] {
  const raw = Array.isArray(value) ? value : parseJson<unknown[]>(value, []);
  return normalizeTaskUsageEntries(raw);
}

export function normalizeTaskUsageEntries(raw: unknown): RuntimeUsageEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: RuntimeUsageEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    entries.push({
      provider: String(record.provider ?? "unknown"),
      model: String(record.model ?? "unknown"),
      inputTokens: normalizeUsageNumber(record.inputTokens ?? record.input_tokens),
      outputTokens: normalizeUsageNumber(record.outputTokens ?? record.output_tokens),
      cacheReadTokens: normalizeUsageNumber(record.cacheReadTokens ?? record.cache_read_tokens),
      cacheWriteTokens: normalizeUsageNumber(record.cacheWriteTokens ?? record.cache_write_tokens),
      totalTokens: normalizeUsageNumber(record.totalTokens ?? record.total_tokens),
    });
  }
  return entries;
}

export function normalizeUsageNumber(value: unknown): number {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.floor(number);
}

