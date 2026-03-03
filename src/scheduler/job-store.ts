/**
 * JobStore — Registry layer for cron jobs.
 *
 * Persistence:
 *   ~/.remi/cron/jobs.json   — Job definitions + state
 *   ~/.remi/cron/runs/{jobId}.jsonl — Per-job execution history
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { Cron } from "croner";
import { createLogger } from "../logger.js";

const log = createLogger("cron:store");

// ── Types ─────────────────────────────────────────

export type CronSchedule =
  | { kind: "cron"; expr: string; tz?: string }
  | { kind: "every"; intervalMs: number }
  | { kind: "at"; at: string };

export interface CronJobState {
  nextRunAtMs?: number;
  lastRunAtMs?: number;
  lastRunStatus?: "ok" | "error" | "skipped";
  lastError?: string;
  lastDurationMs?: number;
  consecutiveErrors?: number;
}

export interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: CronSchedule;
  handler: string;
  handlerConfig?: Record<string, any>;
  timeoutMs?: number;
  deleteAfterRun?: boolean;
  state: CronJobState;
}

export interface CronRunEntry {
  ts: string;
  status: "ok" | "error" | "skipped";
  durationMs: number;
  error?: string;
}

interface StoreData {
  version: 1;
  jobs: CronJob[];
}

// ── JobStore ──────────────────────────────────────

export class JobStore {
  private _jobs: Map<string, CronJob> = new Map();
  private readonly _filePath: string;
  private readonly _runsDir: string;
  private _fileMtimeMs = 0;

  constructor(remiDir: string) {
    const cronDir = join(remiDir, "cron");
    if (!existsSync(cronDir)) mkdirSync(cronDir, { recursive: true });

    this._filePath = join(cronDir, "jobs.json");
    this._runsDir = join(cronDir, "runs");
    if (!existsSync(this._runsDir)) mkdirSync(this._runsDir, { recursive: true });

    this._loadFromDisk();
  }

  // ── Accessors ─────────────────────────────────

  getJob(id: string): CronJob | undefined {
    return this._jobs.get(id);
  }

  getAllJobs(): CronJob[] {
    return Array.from(this._jobs.values());
  }

  getEnabledJobs(): CronJob[] {
    return this.getAllJobs().filter((j) => j.enabled);
  }

  // ── Mutations ─────────────────────────────────

  /**
   * Upsert a job definition. Preserves existing state if job already exists.
   */
  upsert(job: CronJob): void {
    const existing = this._jobs.get(job.id);
    if (existing) {
      // Preserve runtime state, update definition
      job.state = { ...existing.state, ...job.state };
    }
    this._jobs.set(job.id, job);
  }

  /**
   * Sync jobs from config. Adds/updates configured jobs,
   * disables jobs that are no longer in config (but keeps their history).
   */
  syncFromConfig(jobs: CronJob[]): void {
    const configIds = new Set(jobs.map((j) => j.id));

    // Upsert all config jobs
    for (const job of jobs) {
      this.upsert(job);
    }

    // Disable jobs removed from config (keep history)
    for (const [id, job] of this._jobs) {
      if (!configIds.has(id)) {
        job.enabled = false;
      }
    }

    // Compute initial nextRunAtMs for jobs that don't have one
    for (const job of this.getEnabledJobs()) {
      if (!job.state.nextRunAtMs) {
        this.advanceSchedule(job);
      }
    }

    this._saveToDisk();
  }

  /**
   * Compute next run time for a job based on its schedule.
   */
  advanceSchedule(job: CronJob): void {
    const now = Date.now();

    if (job.schedule.kind === "cron") {
      try {
        const cron = new Cron(job.schedule.expr, { timezone: job.schedule.tz });
        const next = cron.nextRun();
        job.state.nextRunAtMs = next ? next.getTime() : undefined;
      } catch (e: any) {
        log.error(`Invalid cron expression for job ${job.id}: ${job.schedule.expr}`, e);
        job.state.nextRunAtMs = undefined;
      }
    } else if (job.schedule.kind === "every") {
      job.state.nextRunAtMs = now + job.schedule.intervalMs;
    } else if (job.schedule.kind === "at") {
      const atMs = new Date(job.schedule.at).getTime();
      if (atMs > now) {
        job.state.nextRunAtMs = atMs;
      } else {
        // Already past — mark as done
        job.enabled = false;
        job.state.nextRunAtMs = undefined;
      }
    }
  }

  /**
   * Apply exponential backoff after failure.
   * Backoff steps: 30s → 1m → 5m → 15m → 60m
   */
  applyBackoff(job: CronJob): void {
    const steps = [30_000, 60_000, 300_000, 900_000, 3_600_000];
    const idx = Math.min((job.state.consecutiveErrors ?? 1) - 1, steps.length - 1);
    job.state.nextRunAtMs = Date.now() + steps[idx];
  }

  /**
   * Record a run completion and update job state.
   */
  recordRun(jobId: string, status: "ok" | "error" | "skipped", durationMs: number, error?: string): void {
    const job = this._jobs.get(jobId);
    if (!job) return;

    // Update state
    job.state.lastRunAtMs = Date.now() - durationMs;
    job.state.lastRunStatus = status;
    job.state.lastDurationMs = durationMs;

    if (status === "ok") {
      job.state.consecutiveErrors = 0;
      job.state.lastError = undefined;
      this.advanceSchedule(job);
    } else if (status === "error") {
      job.state.consecutiveErrors = (job.state.consecutiveErrors ?? 0) + 1;
      job.state.lastError = error?.slice(0, 500);
      this.applyBackoff(job);
    } else {
      // skipped — just advance
      this.advanceSchedule(job);
    }

    // Handle one-shot jobs
    if (job.schedule.kind === "at" && status !== "error") {
      if (job.deleteAfterRun) {
        this._jobs.delete(jobId);
      } else {
        job.enabled = false;
        job.state.nextRunAtMs = undefined;
      }
    }

    // Append to per-job JSONL
    const entry: CronRunEntry = {
      ts: new Date().toISOString(),
      status,
      durationMs,
      error: error?.slice(0, 500),
    };
    const runFile = join(this._runsDir, `${jobId}.jsonl`);
    appendFileSync(runFile, JSON.stringify(entry) + "\n", "utf-8");

    this._saveToDisk();
  }

  /**
   * Get run history for a specific job.
   */
  getRunHistory(jobId: string, limit = 50): CronRunEntry[] {
    const runFile = join(this._runsDir, `${jobId}.jsonl`);
    if (!existsSync(runFile)) return [];

    const lines = readFileSync(runFile, "utf-8").split("\n").filter(Boolean);
    return lines
      .slice(-limit)
      .map((line) => {
        try { return JSON.parse(line) as CronRunEntry; }
        catch { return null; }
      })
      .filter((e): e is CronRunEntry => e !== null)
      .reverse();
  }

  /**
   * Hot-reload from disk if file was modified externally.
   */
  hotReload(): void {
    if (!existsSync(this._filePath)) return;
    try {
      const mtime = statSync(this._filePath).mtimeMs;
      if (mtime > this._fileMtimeMs) {
        this._loadFromDisk();
        log.info("Job store hot-reloaded from disk");
      }
    } catch { /* ignore */ }
  }

  /**
   * Persist to disk.
   */
  save(): void {
    this._saveToDisk();
  }

  // ── Disk I/O ──────────────────────────────────

  private _loadFromDisk(): void {
    if (!existsSync(this._filePath)) return;

    try {
      const raw = readFileSync(this._filePath, "utf-8");
      const data = JSON.parse(raw) as StoreData;
      this._jobs.clear();
      for (const job of data.jobs ?? []) {
        this._jobs.set(job.id, job);
      }
      this._fileMtimeMs = statSync(this._filePath).mtimeMs;
    } catch (e) {
      log.warn("Failed to load job store:", e);
    }
  }

  private _saveToDisk(): void {
    const data: StoreData = {
      version: 1,
      jobs: Array.from(this._jobs.values()),
    };
    try {
      writeFileSync(this._filePath, JSON.stringify(data, null, 2), "utf-8");
      this._fileMtimeMs = statSync(this._filePath).mtimeMs;
    } catch (e) {
      log.warn("Failed to save job store:", e);
    }
  }
}
