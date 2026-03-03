/**
 * SchedulerHistory — Persists task execution records to JSONL files.
 *
 * Storage: ~/.remi/scheduler-history/{YYYY-MM-DD}.jsonl
 * One line per execution, append-only.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  appendFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type TaskStatus = "success" | "failed" | "skipped";

export interface TaskExecution {
  id: string;
  jobName: string;
  startedAt: string;   // ISO timestamp
  finishedAt: string;   // ISO timestamp
  duration: number;     // ms
  status: TaskStatus;
  error?: string;
}

export interface SchedulerJobStatus {
  jobName: string;
  lastRun: TaskExecution | null;
  nextRun: string | null;  // ISO timestamp or null
}

export interface DailySchedulerSummary {
  date: string;
  total: number;
  success: number;
  failed: number;
  skipped: number;
}

/** Format a Date as YYYY-MM-DD in local timezone. */
function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export class SchedulerHistory {
  private readonly _dir: string;

  constructor(remiDir: string) {
    this._dir = join(remiDir, "scheduler-history");
    if (!existsSync(this._dir)) {
      mkdirSync(this._dir, { recursive: true });
    }
  }

  /**
   * Record a task execution. Returns the execution record.
   */
  record(
    jobName: string,
    startedAt: Date,
    status: TaskStatus,
    error?: string,
  ): TaskExecution {
    const now = new Date();
    const entry: TaskExecution = {
      id: randomUUID(),
      jobName,
      startedAt: startedAt.toISOString(),
      finishedAt: now.toISOString(),
      duration: now.getTime() - startedAt.getTime(),
      status,
      error: error?.slice(0, 500),
    };

    const dateStr = localDateStr(startedAt);
    const filePath = join(this._dir, `${dateStr}.jsonl`);
    appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");

    return entry;
  }

  /**
   * Convenience wrapper: run a job and record its execution.
   */
  async run(jobName: string, fn: () => Promise<void>): Promise<TaskExecution> {
    const start = new Date();
    try {
      await fn();
      return this.record(jobName, start, "success");
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      return this.record(jobName, start, "failed", msg);
    }
  }

  /**
   * Get all executions for a specific date.
   */
  getHistory(date: string): TaskExecution[] {
    const filePath = join(this._dir, `${date}.jsonl`);
    if (!existsSync(filePath)) return [];

    return readFileSync(filePath, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line) as TaskExecution; }
        catch { return null; }
      })
      .filter((e): e is TaskExecution => e !== null);
  }

  /**
   * Get the most recent execution for each job name (across today + yesterday).
   */
  getLatestByJob(): Map<string, TaskExecution> {
    const today = localDateStr(new Date());
    const yesterday = localDateStr(new Date(Date.now() - 86400000));
    const entries = [...this.getHistory(yesterday), ...this.getHistory(today)];

    const latest = new Map<string, TaskExecution>();
    for (const entry of entries) {
      const existing = latest.get(entry.jobName);
      if (!existing || entry.startedAt > existing.startedAt) {
        latest.set(entry.jobName, entry);
      }
    }
    return latest;
  }

  /**
   * Get daily summaries for the last N days.
   */
  getSummary(days: number): DailySchedulerSummary[] {
    const summaries: DailySchedulerSummary[] = [];

    for (let i = 0; i < days; i++) {
      const date = localDateStr(new Date(Date.now() - i * 86400000));
      const entries = this.getHistory(date);

      summaries.push({
        date,
        total: entries.length,
        success: entries.filter((e) => e.status === "success").length,
        failed: entries.filter((e) => e.status === "failed").length,
        skipped: entries.filter((e) => e.status === "skipped").length,
      });
    }

    return summaries;
  }

  /**
   * List available date files.
   */
  listDates(): string[] {
    if (!existsSync(this._dir)) return [];
    return readdirSync(this._dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .map((f) => f.replace(".jsonl", ""))
      .sort()
      .reverse();
  }
}
