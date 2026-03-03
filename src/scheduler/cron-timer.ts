/**
 * CronTimer — Trigger layer for the cron scheduler.
 *
 * Ticks every `tickIntervalMs` (default 30s), checks which jobs are due,
 * dispatches them to JobRunner, and handles hot-reload from disk.
 */

import type { Remi } from "../core.js";
import type { RemiConfig } from "../config.js";
import { loadConfig, migrateToCronJobs, type CronJobConfig } from "../config.js";
import { JobStore, type CronJob, type CronSchedule } from "./job-store.js";
import { JobRunner } from "./job-runner.js";
import { createLogger } from "../logger.js";
import { join } from "node:path";
import { homedir } from "node:os";

const log = createLogger("cron:timer");

const DEFAULT_TICK_MS = 30_000; // 30 seconds

export class CronTimer {
  private _store: JobStore;
  private _runner: JobRunner;
  private _remi: Remi;
  private _config: RemiConfig;
  private _tickMs: number;

  constructor(remi: Remi, config: RemiConfig, tickMs = DEFAULT_TICK_MS) {
    this._remi = remi;
    this._config = config;
    this._tickMs = tickMs;
    this._store = new JobStore(join(homedir(), ".remi"));
    this._runner = new JobRunner(remi, this._store);

    // Sync config → store
    const cronJobs = this._buildJobsFromConfig(config);
    this._store.syncFromConfig(cronJobs);
    log.info(`CronTimer initialized with ${cronJobs.length} jobs from config`);
  }

  get store(): JobStore {
    return this._store;
  }

  get runner(): JobRunner {
    return this._runner;
  }

  /**
   * Main loop — runs until shutdownSignal is aborted.
   */
  async start(shutdownSignal: AbortSignal): Promise<void> {
    const jobNames = this._store.getEnabledJobs().map((j) => j.id);
    log.info(
      `CronTimer started (tick=${this._tickMs}ms, jobs=[${jobNames.join(", ")}])`,
    );

    while (!shutdownSignal.aborted) {
      // Wait for tick interval or shutdown
      await new Promise<void>((resolve) => {
        const onAbort = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => {
          shutdownSignal.removeEventListener("abort", onAbort);
          resolve();
        }, this._tickMs);
        shutdownSignal.addEventListener("abort", onAbort, { once: true });
      });

      if (shutdownSignal.aborted) break;

      try {
        await this._tick();
      } catch (e) {
        log.error("Tick error:", e);
      }
    }

    log.info("CronTimer stopped.");
  }

  /**
   * Single tick: hot-reload, find due jobs, execute them.
   */
  private async _tick(): Promise<void> {
    // 1. Hot-reload job store from disk (external edits)
    this._store.hotReload();

    // 2. Hot-reload config from remi.toml
    this._reloadConfig();

    // 3. Find and execute due jobs
    const now = Date.now();
    const dueJobs = this._store
      .getEnabledJobs()
      .filter((j) => j.state.nextRunAtMs && j.state.nextRunAtMs <= now);

    for (const job of dueJobs) {
      // Execute sequentially to avoid resource contention
      await this._runner.execute(job);
    }
  }

  /**
   * Hot-reload config from remi.toml — detect changes to cron jobs.
   */
  private _reloadConfig(): void {
    try {
      const newConfig = loadConfig();
      const newJobs = this._buildJobsFromConfig(newConfig);

      // Compare full job definitions (not just IDs) to detect schedule/config changes
      const oldHash = JSON.stringify(
        this._store.getAllJobs().map(({ state, ...def }) => def).sort((a, b) => a.id.localeCompare(b.id)),
      );
      const newHash = JSON.stringify(
        newJobs.sort((a, b) => a.id.localeCompare(b.id)),
      );

      if (oldHash !== newHash) {
        this._store.syncFromConfig(newJobs);
        this._config = newConfig;
        log.info(`Config hot-reloaded: jobs=[${newJobs.map((j) => j.id).join(", ")}]`);
      }
    } catch (e) {
      log.warn("Config hot-reload failed:", e);
    }
  }

  /**
   * Convert config into CronJob definitions for the store.
   * Handles both new `[[cron.jobs]]` format and legacy migration.
   */
  private _buildJobsFromConfig(config: RemiConfig): CronJob[] {
    // Use migrated cron jobs (handles both old and new formats)
    const cronConfigs = migrateToCronJobs(config);
    return cronConfigs.map((c) => this._configToJob(c));
  }

  private _configToJob(c: CronJobConfig): CronJob {
    let schedule: CronSchedule;

    if (c.cron) {
      schedule = { kind: "cron", expr: c.cron, tz: c.tz };
    } else if (c.every) {
      schedule = { kind: "every", intervalMs: parseIntervalToMs(c.every) };
    } else if (c.at) {
      schedule = { kind: "at", at: c.at };
    } else {
      // Fallback: default to daily at 3am
      schedule = { kind: "cron", expr: "0 3 * * *" };
    }

    return {
      id: c.id,
      name: c.name ?? c.id,
      enabled: c.enabled ?? true,
      schedule,
      handler: c.handler,
      handlerConfig: c.handlerConfig,
      timeoutMs: c.timeoutMs,
      deleteAfterRun: c.deleteAfterRun,
      state: {},
    };
  }
}

/**
 * Parse a human-readable interval string to milliseconds.
 * Supports: "30s", "5m", "2h", "1d", "300" (raw seconds)
 */
function parseIntervalToMs(val: string | number): number {
  if (typeof val === "number") return val * 1000;
  const match = val.match(/^(\d+)\s*(s|m|h|d)?$/i);
  if (!match) return 300_000; // default 5m
  const num = parseInt(match[1], 10);
  const unit = (match[2] ?? "s").toLowerCase();
  switch (unit) {
    case "s": return num * 1000;
    case "m": return num * 60_000;
    case "h": return num * 3_600_000;
    case "d": return num * 86_400_000;
    default: return num * 1000;
  }
}
