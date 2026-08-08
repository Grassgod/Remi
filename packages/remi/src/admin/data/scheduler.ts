/**
 * RemiData — Scheduler (reads cron config from DB).
 *
 * Moved verbatim out of `admin/remi-data.ts`; `RemiData` delegates here.
 */

import { readFileSync, readdirSync, existsSync, appendFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { Cron } from "croner";
import { RemiDataContext } from "./context.js";

export class SchedulerData {
  constructor(private readonly ctx: RemiDataContext) {}

  /**
   * One-time migration: split mixed skill_run.jsonl into per-job files
   * by inferring jobId from UTC timestamp ranges.
   */
  private _migrateSkillRunJsonl(): void {
    const runsDir = join(this.ctx.root, "cron", "runs");
    const mixedFile = join(runsDir, "skill_run.jsonl");
    if (!existsSync(mixedFile)) return;

    const lines = readFileSync(mixedFile, "utf-8").trim().split("\n").filter(Boolean);
    const buckets = new Map<string, string[]>();

    for (const line of lines) {
      try {
        const raw = JSON.parse(line);
        const ts = raw.ts as string;
        const d = new Date(ts);
        const hh = d.getUTCHours();
        const mm = d.getUTCMinutes();

        let jobId: string | null = null;
        if (hh === 2 && mm >= 10 && mm < 25) jobId = "skill:ai-daily-briefing";
        else if (hh === 2 && mm >= 25 && mm < 40) jobId = "skill:feishu-insight";
        else if (hh === 2 && mm >= 40 && mm < 55) jobId = "skill:memory-research";
        else if (hh === 20 && mm >= 0 && mm < 15) jobId = "skill:repo-update";
        else if (hh === 20 && mm >= 15 && mm < 35) jobId = "skill:larkparser-answer-maintain";

        if (!jobId) continue; // discard unmatched entries

        const enriched = JSON.stringify({ ...raw, jobId, handler: "skill:run" });
        const arr = buckets.get(jobId) ?? [];
        arr.push(enriched);
        buckets.set(jobId, arr);
      } catch { /* skip malformed lines */ }
    }

    // Write per-job files (append, in case some already exist from new writes)
    for (const [jobId, entries] of buckets) {
      const safeId = jobId.replace(/[:/]/g, "_");
      appendFileSync(join(runsDir, `${safeId}.jsonl`), entries.join("\n") + "\n", "utf-8");
    }

    // Mark as migrated
    renameSync(mixedFile, mixedFile + ".migrated");
  }

  private _loadAllRuns(): Array<{
    ts: string; jobId: string; handler: string;
    status: "ok" | "error" | "skipped"; durationMs: number; error?: string;
    runId?: string; phase?: string;
  }> {
    const runsDir = join(this.ctx.root, "cron", "runs");
    if (!existsSync(runsDir)) return [];

    // Run migration on first access
    this._migrateSkillRunJsonl();

    const entries: Array<{
      ts: string; jobId: string; handler: string;
      status: "ok" | "error" | "skipped"; durationMs: number; error?: string;
      runId?: string; phase?: string;
    }> = [];

    for (const file of readdirSync(runsDir).filter(f => f.endsWith(".jsonl"))) {
      const content = readFileSync(join(runsDir, file), "utf-8").trim();
      if (!content) continue;
      const fallbackId = file.replace(".jsonl", "").replace(/_/g, ":");
      for (const line of content.split("\n")) {
        if (!line) continue;
        try {
          const raw = JSON.parse(line);
          const jobId = raw.jobId ?? fallbackId;
          entries.push({
            ts: raw.ts,
            jobId,
            handler: raw.handler ?? fallbackId,
            status: raw.status,
            durationMs: raw.durationMs,
            error: raw.error,
            runId: raw.runId,
            phase: raw.phase,
          });
        } catch { /* skip malformed lines */ }
      }
    }

    return entries.sort((a, b) => b.ts.localeCompare(a.ts));
  }

  private _calcNextRun(job: { cron?: string; every?: string | number; tz?: string }): string | null {
    if (job.cron) {
      try {
        const c = new Cron(job.cron, { timezone: job.tz ?? "Asia/Shanghai" });
        const next = c.nextRun();
        return next?.toISOString() ?? null;
      } catch { return null; }
    }
    return null;
  }

  private _formatSchedule(job: { cron?: string; every?: string | number; at?: string }): { kind: string; expr?: string; intervalMs?: number; at?: string } {
    if (job.cron) return { kind: "cron", expr: job.cron };
    if (job.every) {
      const val = job.every;
      if (typeof val === "number") return { kind: "every", intervalMs: val * 1000 };
      const match = String(val).match(/^(\d+)\s*(s|m|h|d)?$/i);
      if (!match) return { kind: "every", intervalMs: 300_000 };
      const num = parseInt(match[1], 10);
      const unit = (match[2] ?? "s").toLowerCase();
      const ms = unit === "m" ? num * 60_000 : unit === "h" ? num * 3_600_000 : unit === "d" ? num * 86_400_000 : num * 1000;
      return { kind: "every", intervalMs: ms };
    }
    if (job.at) return { kind: "at", at: job.at };
    return { kind: "unknown" };
  }

  getSchedulerStatus() {
    const allRuns = this._loadAllRuns();
    const jobs = this.ctx._loadCronJobs().map((job) => {
      const jobRuns = allRuns.filter(r => r.jobId === job.id);

      // lastRun: most recent entry for this job
      const last = jobRuns[0] ?? null;

      // consecutiveErrors: count from most recent backwards until non-error
      let consecutiveErrors = 0;
      for (const r of jobRuns) {
        if (r.status === "error") consecutiveErrors++;
        else break;
      }

      // nextRunAt: compute from cron expression
      const nextRunAt = this._calcNextRun(job);

      return {
        jobId: job.id,
        jobName: job.name ?? job.id,
        enabled: job.enabled !== false,
        handler: job.handler,
        schedule: this._formatSchedule(job),
        lastRun: last ? {
          status: last.status,
          finishedAt: last.ts,
          durationMs: last.durationMs,
          error: last.error,
        } : null,
        nextRunAt,
        consecutiveErrors,
        config: job.handlerConfig ?? null,
      };
    });
    return { jobs };
  }

  getSchedulerHistory(jobId?: string, limit = 50): Array<{ ts: string; status: string; durationMs: number; error?: string; jobId: string; runId?: string; phase?: string }> {
    let runs = this._loadAllRuns();
    // Filter out heartbeat noise unless explicitly requested
    if (!jobId) runs = runs.filter(r => r.jobId !== "builtin:heartbeat");
    else runs = runs.filter(r => r.jobId === jobId);
    return runs.slice(0, Math.min(limit, 200)).map(r => ({
      ts: r.ts,
      jobId: r.jobId,
      status: r.status,
      durationMs: r.durationMs,
      error: r.error,
      runId: r.runId,
      phase: r.phase,
    }));
  }

  getSchedulerSummary(days: number) {
    const allRuns = this._loadAllRuns();
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    // Exclude heartbeat from trend data (288/day noise)
    const recentRuns = allRuns.filter(r => r.ts >= cutoff && r.jobId !== "builtin:heartbeat");

    // Aggregate by date
    const byDate = new Map<string, { total: number; ok: number; error: number; skipped: number }>();
    for (const r of recentRuns) {
      const date = r.ts.slice(0, 10); // YYYY-MM-DD
      const bucket = byDate.get(date) ?? { total: 0, ok: 0, error: 0, skipped: 0 };
      bucket.total++;
      if (r.status === "ok") bucket.ok++;
      else if (r.status === "error") bucket.error++;
      else if (r.status === "skipped") bucket.skipped++;
      byDate.set(date, bucket);
    }

    // Fill zero-days to ensure every day has an entry
    const result: Array<{ date: string; total: number; ok: number; error: number; skipped: number }> = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(Date.now() - i * 86400000);
      const dateStr = d.toISOString().slice(0, 10);
      const bucket = byDate.get(dateStr) ?? { total: 0, ok: 0, error: 0, skipped: 0 };
      result.push({ date: dateStr, ...bucket });
    }
    return result;
  }
}
