import { describe, expect, test } from "bun:test";
import { STORAGE_SETTINGS_DEFAULTS } from "@multiremi/contracts/storage.js";
import { resolveStorageMachineOptions, resolveStoragePolicy } from "@daemon/agent-runtime/workspace/storage-policy.js";

const HOUR = 60 * 60 * 1000;

describe("resolveStoragePolicy", () => {
  test("defaults when the workspace sets nothing", () => {
    expect(resolveStoragePolicy(undefined, {})).toEqual(STORAGE_SETTINGS_DEFAULTS);
    expect(resolveStoragePolicy({ co_authored_by_enabled: true }, {})).toEqual(STORAGE_SETTINGS_DEFAULTS);
  });

  test("takes the workspace's storage settings and ignores invalid keys", () => {
    expect(resolveStoragePolicy({ storage: { ttl_ms: 5 * HOUR, max_retained: 0, chat_idle_days: -1, orphan_ttl_ms: 10 } }, {})).toEqual({
      ...STORAGE_SETTINGS_DEFAULTS, ttl_ms: 5 * HOUR, max_retained: 0,
    });
  });

  test("an environment variable overrides one key on this machine", () => {
    const policy = resolveStoragePolicy({ storage: { ttl_ms: 5 * HOUR, automation_ttl_ms: 6 * HOUR } }, {
      MULTIREMI_GC_TTL_MS: String(2 * HOUR),
      MULTIREMI_GC_MAX_RETAINED: "7",
      MULTIREMI_GC_ORPHAN_TTL_MS: String(10 * HOUR),
      MULTIREMI_GC_SNAPSHOT_MAX_BYTES: String(8 * 1024 * 1024),
    });
    expect(policy).toEqual({
      ...STORAGE_SETTINGS_DEFAULTS,
      ttl_ms: 2 * HOUR,
      automation_ttl_ms: 6 * HOUR,
      max_retained: 7,
      orphan_ttl_ms: 10 * HOUR,
      snapshot_max_bytes: 8 * 1024 * 1024,
    });
  });

  test("an override outside its bounds falls back to the workspace value, never below the minimum", () => {
    const policy = resolveStoragePolicy({ storage: { ttl_ms: 5 * HOUR } }, {
      MULTIREMI_GC_TTL_MS: "1",
      MULTIREMI_GC_AUTOMATION_TTL_MS: "soon",
      MULTIREMI_GC_MAX_RETAINED: "2.5",
      MULTIREMI_GC_SNAPSHOT_MAX_BYTES: "",
    });
    expect(policy).toEqual({ ...STORAGE_SETTINGS_DEFAULTS, ttl_ms: 5 * HOUR });
  });

  test("chat_idle_days is managed by the server only", () => {
    expect(resolveStoragePolicy({ storage: { chat_idle_days: 3 } }, { MULTIREMI_GC_CHAT_IDLE_DAYS: "30" }).chat_idle_days).toBe(3);
  });
});

describe("resolveStorageMachineOptions", () => {
  test("defaults", () => {
    expect(resolveStorageMachineOptions({})).toEqual({ enabled: true, intervalMs: 15 * 60 * 1000, dryRun: false, legacyKeepDays: 7 });
  });

  test("reads the machine environment", () => {
    expect(resolveStorageMachineOptions({
      MULTIREMI_GC_ENABLED: "false",
      MULTIREMI_GC_INTERVAL_MS: "60000",
      MULTIREMI_GC_DRY_RUN: "1",
      MULTIREMI_LEGACY_KEEP_DAYS: "30",
    })).toEqual({ enabled: false, intervalMs: 60_000, dryRun: true, legacyKeepDays: 30 });
  });

  test("garbage falls back to the default, and 0 is a valid interval and keep period", () => {
    expect(resolveStorageMachineOptions({ MULTIREMI_GC_INTERVAL_MS: "often", MULTIREMI_LEGACY_KEEP_DAYS: "-3", MULTIREMI_GC_DRY_RUN: "off" }))
      .toEqual({ enabled: true, intervalMs: 15 * 60 * 1000, dryRun: false, legacyKeepDays: 7 });
    expect(resolveStorageMachineOptions({ MULTIREMI_GC_INTERVAL_MS: "0", MULTIREMI_LEGACY_KEEP_DAYS: "0" }))
      .toMatchObject({ intervalMs: 0, legacyKeepDays: 0 });
  });
});
