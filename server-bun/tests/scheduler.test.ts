/**
 * The cron SchedulerManager claims each plan_time at most once via the
 * sys_cron_executions unique key, so re-ticking inside the same cadence window
 * does not double-run a job. Driven here against the live DB.
 */

import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { SchedulerManager } from "../src/scheduler/manager.js";
import { sysCronExecutions } from "../src/db/schema.js";

const DB_URL = process.env.DATABASE_URL ?? "postgres://multimira:multimira@localhost:5432/multimira";

let reachable = false;
try {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 3 });
  await probe`select 1`;
  await probe.end();
  reachable = true;
} catch {
  /* skip */
}

test.skipIf(!reachable)("scheduler runs a claimed plan once and dedups re-ticks in the same window", async () => {
  const { db, close } = createDb(DB_URL);
  const jobName = `test_job_${Date.now()}`;
  let runs = 0;
  const mgr = new SchedulerManager(db, { tickIntervalMs: 60_000 });
  // 1-hour cadence so both ticks fall in the same plan bucket.
  mgr.register({ name: jobName, cadenceMs: 3_600_000, handler: async () => { runs++; } });

  try {
    await mgr.tickOnce();
    expect(runs).toBe(1);
    const rows1 = await db.select().from(sysCronExecutions).where(eq(sysCronExecutions.jobName, jobName));
    expect(rows1.length).toBe(1);
    expect(rows1[0]!.status).toBe("SUCCESS");

    // Same cadence window → same plan_time → the claim INSERT conflicts → no run.
    await mgr.tickOnce();
    expect(runs).toBe(1);
    const rows2 = await db.select().from(sysCronExecutions).where(eq(sysCronExecutions.jobName, jobName));
    expect(rows2.length).toBe(1);
  } finally {
    await db.delete(sysCronExecutions).where(eq(sysCronExecutions.jobName, jobName));
    await close();
  }
});

test.skipIf(!reachable)("a failing handler records a failed execution row", async () => {
  const { db, close } = createDb(DB_URL);
  const jobName = `test_fail_${Date.now()}`;
  const mgr = new SchedulerManager(db, { tickIntervalMs: 60_000 });
  mgr.register({ name: jobName, cadenceMs: 3_600_000, handler: async () => { throw new Error("boom"); } });

  try {
    await mgr.tickOnce(); // tickOnce swallows handler errors; the row is marked failed
    const rows = await db.select().from(sysCronExecutions).where(eq(sysCronExecutions.jobName, jobName));
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe("FAILED");
  } finally {
    await db.delete(sysCronExecutions).where(eq(sysCronExecutions.jobName, jobName));
    await close();
  }
});
