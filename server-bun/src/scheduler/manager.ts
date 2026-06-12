/**
 * Lease-based cron scheduler — a simplified Bun/TS port of the Go
 * `server/internal/scheduler` package (manager.go, db_ops.go, spec.go).
 *
 * The `sys_cron_executions` table doubles as the distributed lock + audit
 * log for internal periodic jobs. Every process ticks the same registered
 * jobs, but the unique key on (job_name, scope_kind, scope_id, plan_time)
 * guarantees only one runner wins the lease for a given plan_time; losers
 * no-op silently. This keeps the at-least-once claim contract so two
 * managers never double-run the same plan_time.
 *
 * This port keeps the latest-plan-only catch-up strategy (the Go
 * CatchUpLatestOnly mode): each tick claims only the most recently due
 * plan bucket. The richer every-plan replay, stale-lease theft, heartbeat
 * renewal, and retry backoff modes from the Go version are intentionally
 * omitted — they are not needed for the current job set.
 */

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { sysCronExecutions } from "../db/schema.js";

/** Canonical singleton scope used by jobs that lock the whole database. */
const SCOPE_KIND = "global";
const SCOPE_ID = "global";

/** Lease window: how long after start a RUNNING row is considered stale. */
const LEASE_SECONDS = 300;

/** A registered periodic job. */
export interface JobSpec {
  /** Stable identifier; also the audit/index key. Use snake_case ASCII. */
  name: string;
  /** Plan bucket size in milliseconds. plan_time = floor(now / cadence). */
  cadenceMs: number;
  /** Per-execution business logic for one claimed plan_time. */
  handler: (ctx: { now: Date }) => Promise<void>;
}

export interface SchedulerOptions {
  /** Identifies this process in audit rows. Defaults to a fresh UUID. */
  runnerId?: string;
  /** How often the loop wakes to evaluate due plans. Defaults to 30s. */
  tickIntervalMs?: number;
}

/**
 * Floor a timestamp to the canonical plan bucket for a given cadence.
 * Mirrors Go's FloorPlan: the plan_time is the start of the cadence window
 * containing `now`, so every runner agrees on the same bucket.
 */
function floorPlan(nowMs: number, cadenceMs: number): Date {
  if (cadenceMs <= 0) return new Date(nowMs);
  return new Date(Math.floor(nowMs / cadenceMs) * cadenceMs);
}

/**
 * Per-process scheduler. Register one or more jobs, then call run() with an
 * AbortSignal, or drive it manually via tickOnce() (used by tests).
 */
export class SchedulerManager {
  private readonly db: Db;
  private readonly runnerId: string;
  private readonly tickIntervalMs: number;
  private readonly jobs = new Map<string, JobSpec>();

  constructor(db: Db, opts: SchedulerOptions = {}) {
    this.db = db;
    this.runnerId = opts.runnerId ?? crypto.randomUUID();
    this.tickIntervalMs = opts.tickIntervalMs ?? 30000;
  }

  /** Register a job. Duplicate names throw. */
  register(job: JobSpec): void {
    if (!job.name.trim()) throw new Error("scheduler: job name is required");
    if (job.cadenceMs <= 0) {
      throw new Error(`scheduler: job ${job.name}: cadenceMs must be > 0`);
    }
    if (this.jobs.has(job.name)) {
      throw new Error(`scheduler: duplicate job name ${job.name}`);
    }
    this.jobs.set(job.name, job);
  }

  /** Execute a single tick across every registered job. */
  async tickOnce(): Promise<void> {
    const now = await this.dbNow();
    for (const job of this.jobs.values()) {
      try {
        await this.runJob(job, now);
      } catch (err) {
        console.warn(`scheduler: job ${job.name} tick error:`, err);
      }
    }
  }

  /**
   * Block until `signal` is aborted, ticking immediately and then every
   * tickIntervalMs. Resolves once aborted.
   */
  async run(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;

    // First tick immediately so a fresh start does not wait a full interval.
    await this.tickOnce().catch((err) => {
      console.warn("scheduler: tick error:", err);
    });

    return new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        void this.tickOnce().catch((err) => {
          console.warn("scheduler: tick error:", err);
        });
      }, this.tickIntervalMs);

      const onAbort = () => {
        clearInterval(timer);
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      signal.addEventListener("abort", onAbort);
    });
  }

  /** Postgres's notion of "now" — the canonical clock for plan buckets. */
  private async dbNow(): Promise<Date> {
    const [row] = await this.db.execute<{ now: Date }>(sql`SELECT now() AS now`);
    return row?.now ? new Date(row.now as unknown as string) : new Date();
  }

  /**
   * Compute the latest due plan_time for a job, try to claim it, and run
   * the handler if we win the lease.
   */
  private async runJob(job: JobSpec, now: Date): Promise<void> {
    const planTime = floorPlan(now.getTime(), job.cadenceMs);
    const claimed = await this.tryClaim(job, planTime, now);
    if (!claimed) {
      // Another runner already owns this plan_time, or it is terminal.
      // Silent no-op is the expected case.
      return;
    }
    await this.runClaimed(job, planTime);
  }

  /**
   * Atomically claim a plan_time by INSERTing a RUNNING row with ON
   * CONFLICT DO NOTHING on the unique (job_name, scope_kind, scope_id,
   * plan_time) constraint. Returns true only if the insert created the row
   * (i.e. we own the lease). A zero-row insert means another runner owns
   * this plan_time — skip.
   */
  private async tryClaim(job: JobSpec, planTime: Date, now: Date): Promise<boolean> {
    const staleAfter = new Date(now.getTime() + LEASE_SECONDS * 1000);
    const inserted = await this.db
      .insert(sysCronExecutions)
      .values({
        jobName: job.name,
        scopeKind: SCOPE_KIND,
        scopeId: SCOPE_ID,
        planTime: planTime.toISOString(),
        status: "RUNNING",
        attempt: 1,
        runnerId: this.runnerId,
        startedAt: now.toISOString(),
        heartbeatAt: now.toISOString(),
        staleAfter: staleAfter.toISOString(),
      })
      .onConflictDoNothing({
        target: [
          sysCronExecutions.jobName,
          sysCronExecutions.scopeKind,
          sysCronExecutions.scopeId,
          sysCronExecutions.planTime,
        ],
      })
      .returning({ id: sysCronExecutions.id });
    return inserted.length > 0;
  }

  /**
   * Run the handler for an already-claimed lease and write the terminal
   * status. The lease guard (status = 'running') prevents a stale writer
   * from clobbering a newer attempt's state.
   */
  private async runClaimed(job: JobSpec, planTime: Date): Promise<void> {
    try {
      await job.handler({ now: planTime });
      await this.finish(job.name, planTime, "SUCCESS");
    } catch (err) {
      console.warn(`scheduler: job ${job.name} handler failed:`, err);
      await this.finish(job.name, planTime, "FAILED");
    }
  }

  /** Write the terminal status (SUCCESS/FAILED) for our RUNNING lease. */
  private async finish(
    jobName: string,
    planTime: Date,
    status: "SUCCESS" | "FAILED",
  ): Promise<void> {
    await this.db
      .update(sysCronExecutions)
      .set({
        status,
        finishedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(sysCronExecutions.jobName, jobName),
          eq(sysCronExecutions.scopeKind, SCOPE_KIND),
          eq(sysCronExecutions.scopeId, SCOPE_ID),
          eq(sysCronExecutions.planTime, planTime.toISOString()),
          eq(sysCronExecutions.runnerId, this.runnerId),
          eq(sysCronExecutions.status, "RUNNING"),
        ),
      );
  }
}
