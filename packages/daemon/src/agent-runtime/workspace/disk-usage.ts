/**
 * Disk usage of the workspaces root (ADR 0018, section 4 and amendment A3).
 *
 * `du` walks every file, and over a production root (hundreds of GB, millions
 * of files) it takes minutes. Measuring therefore never happens inside a
 * reclaim round: `DiskUsage.refresh` starts a background measurement, at most
 * hourly or when an operator asks, run at low priority with a deadline per
 * category, and leaves the result in `.daemon/disk-usage.json`. A report reads
 * the latest completed measurement; a measurement that is still running, that
 * timed out or that failed never delays or fails a round.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createLogger } from "@shared/logger.js";
import { LEGACY_DIRECTORY_PREFIX, diskUsageFile, envRoot, legacyEntryPath, sharedRoot, tracesRoot, workRoot } from "./layout.js";

const log = createLogger("multiremi-disk-usage");

/** A `du` nobody bounded (no signal given) still ends. Callers that bound it pass their own deadline. */
const DEFAULT_DU_TIMEOUT_MS = 10 * 60_000;
/** Disk measuring yields the CPU to everything else on the machine. */
const NICENESS = "19";

export const DISK_REFRESH_MS = 60 * 60_000;
export const DISK_CATEGORY_TIMEOUT_MS = 30 * 60_000;

export const DISK_CATEGORIES = ["work", "env", "traces", "shared", "legacy"] as const;
export type DiskCategory = (typeof DISK_CATEGORIES)[number];
export type DiskUsageBytes = Record<DiskCategory, number>;

export interface DiskUsageMeasurement {
  /** When the last category finished. */
  measured_at: string;
  bytes: DiskUsageBytes;
}

/**
 * Bytes used below `paths`, measured by an asynchronous `du -sk` under `nice`
 * so a deep `node_modules` neither blocks the daemon's event loop nor competes
 * with running agents. A path that does not exist counts as zero; any other
 * failure rejects, and so does `signal` aborting.
 */
export async function measureBytes(paths: readonly string[], signal?: AbortSignal): Promise<number> {
  const bound = signal ?? AbortSignal.timeout(DEFAULT_DU_TIMEOUT_MS);
  let total = 0;
  for (const path of paths) total += await duKilobytes(path, bound) * 1024;
  return total;
}

/**
 * Free space of the filesystem that holds `path`, or null when it cannot be read.
 * A reclaim round compares it before and after to tell what it freed; unlike a
 * measurement it walks nothing, so it belongs inside the round.
 */
export async function freeDiskBytes(path: string): Promise<number | null> {
  try {
    const info = await statfs(path);
    return info.bavail * info.bsize;
  } catch {
    return null;
  }
}

/** Space gained between two readings of `freeDiskBytes`; 0 when either is unknown or space shrank meanwhile. */
export function freedBetween(before: number | null, after: number | null): number {
  return before === null || after === null ? 0 : Math.max(0, after - before);
}

function duKilobytes(path: string, signal: AbortSignal): Promise<number> {
  return new Promise((resolveDu, reject) => {
    signal.throwIfAborted();
    const child = spawn("nice", ["-n", NICENESS, "du", "-sk", path], { stdio: ["ignore", "pipe", "pipe"], signal });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => {
      const kilobytes = Number.parseInt(stdout, 10);
      // `du` exits non-zero when one entry vanishes mid-walk but still prints the total.
      if (Number.isFinite(kilobytes)) return resolveDu(kilobytes);
      if (/No such file or directory/.test(stderr)) return resolveDu(0);
      reject(new Error(`du -sk ${path} failed (${code}): ${stderr.trim()}`));
    });
  });
}

export interface DiskUsageOptions {
  root: string;
  /** Sizes `paths` in bytes; defaults to `measureBytes`. */
  measure?: (paths: readonly string[], signal: AbortSignal) => Promise<number>;
  now?: () => number;
  /** How often a measurement is taken unless an operator asks; defaults to an hour. */
  refreshMs?: number;
  /** Deadline of each category; a measurement that exceeds it is dropped. Defaults to 30 minutes. */
  categoryTimeoutMs?: number;
  /** Ends a running measurement, e.g. when the daemon stops. */
  stopSignal?: () => AbortSignal | undefined;
  /** Ownership fence, called before the cache is written. */
  assertRootOwner?: () => void;
}

/** What every `DiskUsage` on one root shares: engines of co-resident provider daemons must not measure twice. */
interface RootState {
  running: Promise<void> | null;
  /** Last start of a measurement, so a failing one is not retried every round. */
  attemptedAt: number;
}

const states = new Map<string, RootState>();

function stateFor(root: string): RootState {
  let state = states.get(root);
  if (!state) {
    state = { running: null, attemptedAt: 0 };
    states.set(root, state);
  }
  return state;
}

export class DiskUsage {
  private readonly root: string;
  private readonly state: RootState;

  constructor(private readonly options: DiskUsageOptions) {
    this.root = resolve(options.root);
    this.state = stateFor(this.root);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** The latest completed measurement, or null before the first one finished. */
  latest(): DiskUsageMeasurement | null {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(diskUsageFile(this.root), "utf8"));
    } catch {
      return null;
    }
    return parseMeasurement(value);
  }

  /**
   * Start a measurement in the background and return at once. Nothing starts
   * while one is running, nor, unless `force` (an operator asked), when the last
   * attempt is younger than the refresh interval.
   */
  refresh(force: boolean): void {
    if (this.state.running) return;
    const now = this.now();
    const last = Math.max(Date.parse(this.latest()?.measured_at ?? "") || 0, this.state.attemptedAt);
    if (!force && now - last < (this.options.refreshMs ?? DISK_REFRESH_MS)) return;
    this.state.attemptedAt = now;
    const running = this.measureAll().catch((error) => {
      log.warn(`Disk usage measurement failed: ${errorMessage(error)}`);
    }).finally(() => {
      if (this.state.running === running) this.state.running = null;
    });
    this.state.running = running;
  }

  /** Resolves once no measurement is running. */
  async settled(): Promise<void> {
    while (this.state.running) await this.state.running;
  }

  private async measureAll(): Promise<void> {
    const measure = this.options.measure ?? measureBytes;
    const timeoutMs = this.options.categoryTimeoutMs ?? DISK_CATEGORY_TIMEOUT_MS;
    const bytes = {} as DiskUsageBytes;
    for (const category of DISK_CATEGORIES) {
      const deadline = AbortSignal.timeout(timeoutMs);
      const stop = this.options.stopSignal?.();
      const signal = stop ? AbortSignal.any([stop, deadline]) : deadline;
      try {
        bytes[category] = await measure(this.paths(category), signal);
      } catch (error) {
        // The previous measurement stays the latest one; a partial set would mix two moments.
        const why = deadline.aborted
          ? `did not finish within ${timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} min` : `${timeoutMs} ms`}`
          : stop?.aborted ? "was interrupted" : errorMessage(error);
        log.warn(`Disk usage of ${category} ${why}; keeping the previous measurement`);
        return;
      }
    }
    this.store({ measured_at: new Date(this.now()).toISOString(), bytes });
  }

  private paths(category: DiskCategory): string[] {
    switch (category) {
      case "work": return [workRoot(this.root)];
      case "env": return [envRoot(this.root)];
      case "traces": return [tracesRoot(this.root)];
      case "shared": return [sharedRoot(this.root)];
      case "legacy":
        return readdirSync(this.root).filter((name) => name.startsWith(LEGACY_DIRECTORY_PREFIX))
          .map((name) => legacyEntryPath(this.root, name));
    }
  }

  private store(measurement: DiskUsageMeasurement): void {
    const path = diskUsageFile(this.root);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      this.options.assertRootOwner?.();
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(temporary, `${JSON.stringify({ version: 1, ...measurement })}\n`, { mode: 0o600 });
      renameSync(temporary, path);
    } catch (error) {
      rmSync(temporary, { force: true });
      log.warn(`Could not save the disk usage measurement: ${errorMessage(error)}`);
    }
  }
}

function parseMeasurement(value: unknown): DiskUsageMeasurement | null {
  if (typeof value !== "object" || value === null) return null;
  const { version, measured_at: measuredAt, bytes } = value as Record<string, unknown>;
  if (version !== 1 || typeof measuredAt !== "string" || !Number.isFinite(Date.parse(measuredAt))) return null;
  if (typeof bytes !== "object" || bytes === null) return null;
  const parsed = {} as DiskUsageBytes;
  for (const category of DISK_CATEGORIES) {
    const size = (bytes as Record<string, unknown>)[category];
    if (typeof size !== "number" || !Number.isFinite(size) || size < 0) return null;
    parsed[category] = size;
  }
  return { measured_at: measuredAt, bytes: parsed };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
