import { describe, expect, it } from "bun:test";
import {
  STORAGE_SETTINGS_BOUNDS,
  STORAGE_SETTINGS_DEFAULTS,
  STORAGE_SETTINGS_KEYS,
  resolveStorageSettings,
  validateStorageSettingsPatch,
} from "@multiremi/contracts/storage.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe("storage settings defaults", () => {
  it("pins the ADR 0018 defaults and bounds", () => {
    expect(STORAGE_SETTINGS_DEFAULTS).toEqual({
      ttl_ms: 72 * HOUR_MS,
      automation_ttl_ms: 24 * HOUR_MS,
      max_retained: 50,
      orphan_ttl_ms: 72 * HOUR_MS,
      snapshot_max_bytes: 256 * 1024 * 1024,
      chat_idle_days: 14,
    });
    expect(STORAGE_SETTINGS_BOUNDS).toEqual({
      ttl_ms: { min: HOUR_MS, max: 365 * DAY_MS },
      automation_ttl_ms: { min: HOUR_MS, max: 365 * DAY_MS },
      max_retained: { min: 0, max: 10_000 },
      orphan_ttl_ms: { min: HOUR_MS, max: 365 * DAY_MS },
      snapshot_max_bytes: { min: 1024 * 1024, max: 10 * 1024 * 1024 * 1024 },
      chat_idle_days: { min: 0, max: 3650 },
    });
  });

  it("keeps every default inside its own bounds and the key list complete", () => {
    expect([...STORAGE_SETTINGS_KEYS].sort() as string[]).toEqual(Object.keys(STORAGE_SETTINGS_DEFAULTS).sort());
    for (const key of STORAGE_SETTINGS_KEYS) {
      const { min, max } = STORAGE_SETTINGS_BOUNDS[key];
      expect(STORAGE_SETTINGS_DEFAULTS[key]).toBeGreaterThanOrEqual(min);
      expect(STORAGE_SETTINGS_DEFAULTS[key]).toBeLessThanOrEqual(max);
    }
  });
});

describe("resolveStorageSettings", () => {
  it("returns the defaults for anything that is not an object", () => {
    for (const raw of [undefined, null, "x", 7, [], [1, 2]]) {
      expect(resolveStorageSettings(raw)).toEqual(STORAGE_SETTINGS_DEFAULTS);
    }
  });

  it("returns a copy so callers cannot mutate the defaults", () => {
    const resolved = resolveStorageSettings({});
    resolved.ttl_ms = 1;
    expect(STORAGE_SETTINGS_DEFAULTS.ttl_ms).toBe(72 * HOUR_MS);
  });

  it("merges valid keys over the defaults and ignores unknown keys", () => {
    expect(resolveStorageSettings({ ttl_ms: 2 * HOUR_MS, max_retained: 0, chat_idle_days: 0, extra: 1 })).toEqual({
      ...STORAGE_SETTINGS_DEFAULTS,
      ttl_ms: 2 * HOUR_MS,
      max_retained: 0,
      chat_idle_days: 0,
    });
  });

  it("accepts values exactly on a bound", () => {
    for (const key of STORAGE_SETTINGS_KEYS) {
      const { min, max } = STORAGE_SETTINGS_BOUNDS[key];
      expect(resolveStorageSettings({ [key]: min })[key]).toBe(min);
      expect(resolveStorageSettings({ [key]: max })[key]).toBe(max);
    }
  });

  it("falls back per key for invalid, out-of-range, fractional-count and non-finite values", () => {
    const resolved = resolveStorageSettings({
      ttl_ms: HOUR_MS - 1,
      automation_ttl_ms: "3600000",
      max_retained: 1.5,
      orphan_ttl_ms: Number.NaN,
      snapshot_max_bytes: Number.POSITIVE_INFINITY,
      chat_idle_days: -1,
    });
    expect(resolved).toEqual(STORAGE_SETTINGS_DEFAULTS);
    expect(resolveStorageSettings({ ttl_ms: 365 * DAY_MS + 1, chat_idle_days: 3651, max_retained: 10_001 }))
      .toEqual(STORAGE_SETTINGS_DEFAULTS);
    expect(resolveStorageSettings({ ttl_ms: null, max_retained: 5 }))
      .toEqual({ ...STORAGE_SETTINGS_DEFAULTS, max_retained: 5 });
  });
});

describe("validateStorageSettingsPatch", () => {
  it("accepts an empty body as a no-op", () => {
    expect(validateStorageSettingsPatch({})).toEqual({ patch: {}, errors: [] });
  });

  it("keeps valid numbers and treats null as reset to default", () => {
    expect(validateStorageSettingsPatch({ ttl_ms: 6 * HOUR_MS, max_retained: 0, orphan_ttl_ms: null })).toEqual({
      patch: { ttl_ms: 6 * HOUR_MS, max_retained: 0, orphan_ttl_ms: null },
      errors: [],
    });
  });

  it("rejects bodies that are not an object", () => {
    for (const raw of [undefined, null, "x", 1, [], [{ ttl_ms: HOUR_MS }]]) {
      const result = validateStorageSettingsPatch(raw);
      expect(result.patch).toEqual({});
      expect(result.errors).toEqual(["body must be an object"]);
    }
  });

  it("reports one error per bad field and still returns the valid ones", () => {
    const result = validateStorageSettingsPatch({
      ttl_ms: 1000,
      automation_ttl_ms: DAY_MS,
      max_retained: 2.5,
      orphan_ttl_ms: "soon",
      snapshot_max_bytes: 11 * 1024 * 1024 * 1024,
      chat_idle_days: 3651,
      bogus: 1,
    });
    expect(result.patch).toEqual({ automation_ttl_ms: DAY_MS });
    expect(result.errors).toEqual([
      "ttl_ms must be a number between 3600000 and 31536000000",
      "max_retained must be an integer between 0 and 10000",
      "orphan_ttl_ms must be a number between 3600000 and 31536000000",
      "snapshot_max_bytes must be a number between 1048576 and 10737418240",
      "chat_idle_days must be an integer between 0 and 3650",
      "bogus is not a storage setting",
    ]);
  });

  it("rejects non-finite numbers and booleans", () => {
    const result = validateStorageSettingsPatch({ ttl_ms: Number.NaN, max_retained: true, chat_idle_days: Number.POSITIVE_INFINITY });
    expect(result.patch).toEqual({});
    expect(result.errors).toHaveLength(3);
  });
});
