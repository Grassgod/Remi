// Shared pure helpers used by the Multiremi store and its per-domain repos.
// Extracted verbatim from store.ts so store.ts and repos/*.ts import one copy.

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

export function cleanOptionalString(value: unknown): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
}
