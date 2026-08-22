import {
  MULTIREMI_ISSUE_ARCHIVE_DEFAULT_SWEEP_INTERVAL_MS,
  MULTIREMI_ISSUE_ARCHIVE_DEFAULT_TTL_MS,
  MULTIREMI_ISSUE_ARCHIVE_MAX_TTL_MS,
  MULTIREMI_ISSUE_ARCHIVE_MIN_SWEEP_INTERVAL_MS,
  MULTIREMI_ISSUE_ARCHIVE_MIN_TTL_MS,
} from "@multiremi/contracts/types.js";

export interface IssueArchiveSettings {
  ttlMs: number;
  sweepIntervalMs: number;
}

export function resolveIssueArchiveSettings(
  settings: Record<string, unknown> | null | undefined,
): IssueArchiveSettings {
  const raw = settings?.issue_archive;
  const archive = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const ttlMs = Number(archive.ttl_ms);
  const sweepIntervalMs = Number(archive.sweep_interval_ms);
  const resolvedTtlMs = Number.isSafeInteger(ttlMs)
    && ttlMs >= MULTIREMI_ISSUE_ARCHIVE_MIN_TTL_MS
    && ttlMs <= MULTIREMI_ISSUE_ARCHIVE_MAX_TTL_MS
    ? ttlMs
    : MULTIREMI_ISSUE_ARCHIVE_DEFAULT_TTL_MS;
  return {
    ttlMs: resolvedTtlMs,
    sweepIntervalMs: Number.isSafeInteger(sweepIntervalMs)
      && sweepIntervalMs >= MULTIREMI_ISSUE_ARCHIVE_MIN_SWEEP_INTERVAL_MS
      && sweepIntervalMs <= resolvedTtlMs
      ? sweepIntervalMs
      : MULTIREMI_ISSUE_ARCHIVE_DEFAULT_SWEEP_INTERVAL_MS,
  };
}
