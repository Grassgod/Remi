import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { releaseRuntimeVersions, validRuntimeVersions, versionsAtLeast, type RuntimeProvider, type RuntimeSelection, type RuntimeVersions } from "./runtime-versions.js";

function statePath(name: string): string {
  return join(process.env.REMI_HOME ?? join(homedir(), ".remi"), "acp", `${name}.json`);
}

function readState(name: string): unknown {
  try { return JSON.parse(readFileSync(statePath(name), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Cannot read runtime ${name}: ${error instanceof Error ? error.message : error}`);
  }
}

function writeState(name: string, value: unknown): void {
  const path = statePath(name), temporary = `${path}.${process.pid}-${randomUUID()}`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

export function activeRuntimeSelection(): RuntimeSelection {
  const value = readState("active-runtimes");
  if (!value || typeof value !== "object") return {};
  const result: RuntimeSelection = {};
  for (const provider of ["claude", "codex"] as const) {
    const versions = (value as RuntimeSelection)[provider];
    if (validRuntimeVersions(versions)) result[provider] = versions;
  }
  return result;
}

export function selectedRuntimeVersions(provider: RuntimeProvider): RuntimeVersions {
  const floor = releaseRuntimeVersions(provider), active = activeRuntimeSelection()[provider];
  return active && versionsAtLeast(active, floor) ? active : floor;
}

/** Commit only after every requested provider has passed preflight and all lanes are idle. */
export function activateRuntimeSelection(selection: RuntimeSelection): void {
  for (const provider of Object.keys(selection) as RuntimeProvider[]) {
    if (!(provider === "claude" || provider === "codex") || !validRuntimeVersions(selection[provider])
      || !versionsAtLeast(selection[provider]!, selectedRuntimeVersions(provider))) {
      throw new Error(`Invalid or downgraded ${provider} runtime selection`);
    }
  }
  writeState("active-runtimes", { ...activeRuntimeSelection(), ...selection });
}

export interface RuntimeUpdateSettings { enabled: boolean; intervalHours: number }
export function runtimeUpdateSettings(): RuntimeUpdateSettings {
  const saved = readState("update-settings") as Partial<RuntimeUpdateSettings> | null;
  const settings = { enabled: saved?.enabled ?? true, intervalHours: saved?.intervalHours ?? 24 };
  validateSettings(settings);
  return settings;
}
function validateSettings(settings: RuntimeUpdateSettings): void {
  if (typeof settings.enabled !== "boolean" || !Number.isInteger(settings.intervalHours)
    || settings.intervalHours < 1 || settings.intervalHours > 720) {
    throw new Error("Runtime updates require enabled=true|false and interval-hours between 1 and 720");
  }
}
export function configureRuntimeUpdates(change: Partial<RuntimeUpdateSettings>): RuntimeUpdateSettings {
  const settings = { ...runtimeUpdateSettings(), ...change };
  validateSettings(settings);
  writeState("update-settings", settings);
  return settings;
}

export interface RuntimeUpdateStatus {
  checkedAt: number;
  status: "checking" | "current" | "waiting_for_tasks" | "updated" | "failed" | "disabled";
  versions?: RuntimeSelection;
  error?: string;
}
export function runtimeUpdateStatus(): RuntimeUpdateStatus | null {
  const saved = readState("update-status") as RuntimeUpdateStatus | null;
  if (saved && (!Number.isFinite(saved.checkedAt) || saved.checkedAt < 0)) throw new Error("Invalid runtime update status");
  return saved;
}
export function saveRuntimeUpdateStatus(status: RuntimeUpdateStatus): void { writeState("update-status", status); }
