/**
 * Storage retention policy of a daemon (ADR 0018, section 9).
 *
 * The workspace setting `settings.storage` is the source of truth, managed from
 * the server. A same-named environment variable overrides one key on this
 * machine only. Machine parameters (interval, enable switch, dry run, legacy
 * retention) come from the environment alone.
 */

import {
  STORAGE_SETTINGS_KEYS,
  resolveStorageSettings,
  type StorageSettings,
} from "@multiremi/contracts/storage.js";

const ENV_OVERRIDES: Partial<Record<keyof StorageSettings, string>> = {
  ttl_ms: "MULTIREMI_GC_TTL_MS",
  automation_ttl_ms: "MULTIREMI_GC_AUTOMATION_TTL_MS",
  max_retained: "MULTIREMI_GC_MAX_RETAINED",
  orphan_ttl_ms: "MULTIREMI_GC_ORPHAN_TTL_MS",
  snapshot_max_bytes: "MULTIREMI_GC_SNAPSHOT_MAX_BYTES",
};

export interface StorageMachineOptions {
  /** `MULTIREMI_GC_ENABLED`: run periodic rounds at all. */
  enabled: boolean;
  /** `MULTIREMI_GC_INTERVAL_MS`: time between periodic rounds. */
  intervalMs: number;
  /** `MULTIREMI_GC_DRY_RUN`: plan only, never mutate. */
  dryRun: boolean;
  /** `MULTIREMI_LEGACY_KEEP_DAYS`: how long a swept `legacy-<date>` directory stays. */
  legacyKeepDays: number;
}

export const DEFAULT_GC_INTERVAL_MS = 15 * 60 * 1000;
export const DEFAULT_LEGACY_KEEP_DAYS = 7;

export function resolveStorageMachineOptions(env: NodeJS.ProcessEnv = process.env): StorageMachineOptions {
  return {
    enabled: booleanValue(env.MULTIREMI_GC_ENABLED, true),
    intervalMs: integerValue(env.MULTIREMI_GC_INTERVAL_MS, DEFAULT_GC_INTERVAL_MS),
    dryRun: booleanValue(env.MULTIREMI_GC_DRY_RUN, false),
    legacyKeepDays: integerValue(env.MULTIREMI_LEGACY_KEEP_DAYS, DEFAULT_LEGACY_KEEP_DAYS),
  };
}

/**
 * Effective policy for one workspace: defaults, then `settings.storage`, then
 * the machine's environment overrides. A value outside its bounds is ignored at
 * every layer, so a bad override can never relax retention below the minimum.
 */
export function resolveStoragePolicy(
  workspaceSettings: Record<string, unknown> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): StorageSettings {
  const merged: Record<string, unknown> = {
    ...(isRecord(workspaceSettings?.storage) ? workspaceSettings.storage : {}),
  };
  for (const key of STORAGE_SETTINGS_KEYS) {
    const name = ENV_OVERRIDES[key];
    const raw = name ? env[name] : undefined;
    if (raw === undefined || raw.trim() === "") continue;
    const parsed = Number(raw);
    // Validate the override alone: out of range falls back to the workspace value.
    if (resolveStorageSettings({ [key]: parsed })[key] === parsed) merged[key] = parsed;
  }
  return resolveStorageSettings(merged);
}

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function integerValue(value: string | undefined, fallback: number): number {
  const parsed = value === undefined || value.trim() === "" ? Number.NaN : Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
