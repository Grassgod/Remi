import { createHash } from "node:crypto";

export interface SessionArchiveRetryPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
}

export const DEFAULT_SESSION_ARCHIVE_RETRY_BASE_MS = 60_000;
export const DEFAULT_SESSION_ARCHIVE_RETRY_MAX_MS = 3_600_000;
export const DEFAULT_SESSION_ARCHIVE_RETRY_MAX_ATTEMPTS = 6;
export const DEFAULT_SESSION_ARCHIVE_UPLOAD_STALL_MS = 15 * 60_000;

const MIN_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 24 * 60 * 60_000;
const MAX_RETRY_ATTEMPTS = 100;
const MIN_UPLOAD_STALL_MS = 60_000;
const MAX_UPLOAD_STALL_MS = 24 * 60 * 60_000;

export function resolveSessionArchiveRetryPolicy(): SessionArchiveRetryPolicy {
  const baseDelayMs = boundedInteger(
    process.env.MULTIREMI_SESSION_ARCHIVE_RETRY_BASE_MS,
    MIN_RETRY_DELAY_MS,
    DEFAULT_SESSION_ARCHIVE_RETRY_MAX_MS,
    DEFAULT_SESSION_ARCHIVE_RETRY_BASE_MS,
  );
  const maxDelayMs = boundedInteger(
    process.env.MULTIREMI_SESSION_ARCHIVE_RETRY_MAX_MS,
    baseDelayMs,
    MAX_RETRY_DELAY_MS,
    DEFAULT_SESSION_ARCHIVE_RETRY_MAX_MS,
  );
  const maxAttempts = boundedInteger(
    process.env.MULTIREMI_SESSION_ARCHIVE_RETRY_MAX_ATTEMPTS,
    1,
    MAX_RETRY_ATTEMPTS,
    DEFAULT_SESSION_ARCHIVE_RETRY_MAX_ATTEMPTS,
  );
  return { baseDelayMs, maxDelayMs, maxAttempts };
}

export function resolveSessionArchiveUploadStallMs(): number {
  return boundedInteger(
    process.env.MULTIREMI_SESSION_ARCHIVE_UPLOAD_STALL_MS,
    MIN_UPLOAD_STALL_MS,
    MAX_UPLOAD_STALL_MS,
    DEFAULT_SESSION_ARCHIVE_UPLOAD_STALL_MS,
  );
}

export function nextSessionArchiveRetryAt(
  archiveId: string,
  attemptCount: number,
  policy: SessionArchiveRetryPolicy,
  now: Date | number,
): string {
  const attempt = Number.isSafeInteger(attemptCount) && attemptCount > 0 ? attemptCount : 1;
  const exponentialDelay = policy.baseDelayMs * (2 ** Math.max(0, attempt - 1));
  const cappedDelay = Math.min(exponentialDelay, policy.maxDelayMs);
  const jitteredDelay = Math.round(cappedDelay * deterministicJitterFactor(archiveId));
  const delayMs = Math.min(policy.maxDelayMs, Math.max(0, jitteredDelay));
  const timestamp = now instanceof Date ? now.getTime() : now;
  return new Date(timestamp + delayMs).toISOString();
}

export function isSessionArchiveRetryExhausted(
  attemptCount: number,
  policy: SessionArchiveRetryPolicy,
): boolean {
  return Number.isSafeInteger(attemptCount) && attemptCount >= policy.maxAttempts;
}

function deterministicJitterFactor(archiveId: string): number {
  const digest = createHash("sha256").update(archiveId).digest();
  const ratio = digest.readUInt32BE(0) / 0xffff_ffff;
  return 0.9 + ratio * 0.2;
}

function boundedInteger(
  value: string | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}
