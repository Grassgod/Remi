import {
  MULTIREMI_SESSION_ARCHIVE_MAX_TTL_MS,
  MULTIREMI_SESSION_ARCHIVE_MIN_GC_INTERVAL_MS,
  MULTIREMI_SESSION_ARCHIVE_MIN_TTL_MS,
} from "@multiremi/contracts/types.js";

export interface WorkspaceGcPolicy {
  ttlMs: number;
  intervalMs: number;
}

/** Resolve the admin-managed workspace policy without accepting unsafe values. */
export function resolveWorkspaceGcPolicy(
  settings: Record<string, unknown> | null | undefined,
  fallback: WorkspaceGcPolicy,
): WorkspaceGcPolicy {
  const archive = objectField(settings, "session_archive") ?? objectField(settings, "sessionArchive");
  const ttlMs = boundedInteger(
    archive?.workspace_ttl_ms ?? archive?.workspaceTtlMs,
    MULTIREMI_SESSION_ARCHIVE_MIN_TTL_MS,
    MULTIREMI_SESSION_ARCHIVE_MAX_TTL_MS,
  ) ?? fallback.ttlMs;
  const intervalMs = boundedInteger(
    archive?.gc_interval_ms ?? archive?.gcIntervalMs,
    MULTIREMI_SESSION_ARCHIVE_MIN_GC_INTERVAL_MS,
    ttlMs,
  ) ?? Math.min(fallback.intervalMs, ttlMs);
  return { ttlMs, intervalMs };
}

function objectField(value: Record<string, unknown> | null | undefined, key: string): Record<string, unknown> | null {
  const field = value?.[key];
  return field && typeof field === "object" && !Array.isArray(field)
    ? field as Record<string, unknown>
    : null;
}

function boundedInteger(value: unknown, min: number, max: number): number | null {
  const number = typeof value === "number" ? value : Number.NaN;
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
}
