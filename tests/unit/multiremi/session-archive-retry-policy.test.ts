import { afterEach, describe, expect, it } from "bun:test";
import {
  DEFAULT_SESSION_ARCHIVE_RETRY_BASE_MS,
  DEFAULT_SESSION_ARCHIVE_RETRY_MAX_ATTEMPTS,
  DEFAULT_SESSION_ARCHIVE_RETRY_MAX_MS,
  DEFAULT_SESSION_ARCHIVE_UPLOAD_STALL_MS,
  isSessionArchiveRetryExhausted,
  nextSessionArchiveRetryAt,
  resolveSessionArchiveRetryPolicy,
  resolveSessionArchiveUploadStallMs,
} from "@multiremi/session-archive/retry-policy.js";

const ENV_NAMES = [
  "MULTIREMI_SESSION_ARCHIVE_RETRY_BASE_MS",
  "MULTIREMI_SESSION_ARCHIVE_RETRY_MAX_MS",
  "MULTIREMI_SESSION_ARCHIVE_RETRY_MAX_ATTEMPTS",
  "MULTIREMI_SESSION_ARCHIVE_UPLOAD_STALL_MS",
] as const;

const originalEnv = Object.fromEntries(
  ENV_NAMES.map((name) => [name, process.env[name]]),
) as Record<(typeof ENV_NAMES)[number], string | undefined>;

afterEach(() => {
  for (const name of ENV_NAMES) {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("Session archive retry policy", () => {
  const now = new Date("2026-08-26T00:00:00.000Z");
  const policy = { baseDelayMs: 60_000, maxDelayMs: 3_600_000, maxAttempts: 6 };

  it("grows exponentially and caps the jittered delay", () => {
    const retryTimes = [1, 2, 3, 4, 5, 6, 7, 20].map((attempt) =>
      Date.parse(nextSessionArchiveRetryAt("sar_sequence", attempt, policy, now)) - now.getTime()
    );

    for (let index = 1; index < 6; index++) {
      expect(retryTimes[index]! / retryTimes[index - 1]!).toBeCloseTo(2, 4);
    }
    expect(retryTimes[6]).toBeLessThanOrEqual(policy.maxDelayMs);
    expect(retryTimes[7]).toBe(retryTimes[6]);
  });

  it("uses deterministic archive-specific jitter within ten percent", () => {
    const first = Date.parse(nextSessionArchiveRetryAt("sar_alpha", 1, policy, now)) - now.getTime();
    const repeated = Date.parse(nextSessionArchiveRetryAt("sar_alpha", 1, policy, now)) - now.getTime();
    const second = Date.parse(nextSessionArchiveRetryAt("sar_beta", 1, policy, now)) - now.getTime();

    expect(repeated).toBe(first);
    expect(second).not.toBe(first);
    expect(first).toBeGreaterThanOrEqual(policy.baseDelayMs * 0.9);
    expect(first).toBeLessThanOrEqual(policy.baseDelayMs * 1.1);
    expect(second).toBeGreaterThanOrEqual(policy.baseDelayMs * 0.9);
    expect(second).toBeLessThanOrEqual(policy.baseDelayMs * 1.1);
  });

  it("marks the configured attempt budget as exhausted", () => {
    expect(isSessionArchiveRetryExhausted(5, policy)).toBe(false);
    expect(isSessionArchiveRetryExhausted(6, policy)).toBe(true);
    expect(isSessionArchiveRetryExhausted(7, policy)).toBe(true);
  });

  it("reads safe environment overrides", () => {
    process.env.MULTIREMI_SESSION_ARCHIVE_RETRY_BASE_MS = "2000";
    process.env.MULTIREMI_SESSION_ARCHIVE_RETRY_MAX_MS = "120000";
    process.env.MULTIREMI_SESSION_ARCHIVE_RETRY_MAX_ATTEMPTS = "8";
    process.env.MULTIREMI_SESSION_ARCHIVE_UPLOAD_STALL_MS = "120000";

    expect(resolveSessionArchiveRetryPolicy()).toEqual({
      baseDelayMs: 2_000,
      maxDelayMs: 120_000,
      maxAttempts: 8,
    });
    expect(resolveSessionArchiveUploadStallMs()).toBe(120_000);
  });

  it("falls back to defaults for malformed or unsafe environment values", () => {
    process.env.MULTIREMI_SESSION_ARCHIVE_RETRY_BASE_MS = "999";
    process.env.MULTIREMI_SESSION_ARCHIVE_RETRY_MAX_MS = "not-a-number";
    process.env.MULTIREMI_SESSION_ARCHIVE_RETRY_MAX_ATTEMPTS = "0";
    process.env.MULTIREMI_SESSION_ARCHIVE_UPLOAD_STALL_MS = "1";

    expect(resolveSessionArchiveRetryPolicy()).toEqual({
      baseDelayMs: DEFAULT_SESSION_ARCHIVE_RETRY_BASE_MS,
      maxDelayMs: DEFAULT_SESSION_ARCHIVE_RETRY_MAX_MS,
      maxAttempts: DEFAULT_SESSION_ARCHIVE_RETRY_MAX_ATTEMPTS,
    });
    expect(resolveSessionArchiveUploadStallMs()).toBe(DEFAULT_SESSION_ARCHIVE_UPLOAD_STALL_MS);
  });
});
