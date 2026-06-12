/**
 * Autopilot schedule sweep — fires schedule-kind autopilot triggers whose
 * next_run_at has passed, then advances next_run_at via the cron expression.
 * Runs as a scheduler job (see main.ts), so the SchedulerManager lease ensures
 * only one replica sweeps per tick; within the sweep each trigger is advanced
 * before dispatch so a dispatch error never wedges future firings.
 */

import { and, eq, lte, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { autopilotTrigger } from "../db/schema.js";
import { dispatchAutopilot } from "./autopilot.js";
import { computeNextRun } from "./cron.js";

/** Fire all due schedule triggers as of `now`. Returns the number dispatched. */
export async function sweepDueAutopilotTriggers(db: Db, now: Date = new Date()): Promise<number> {
  const due = await db
    .select()
    .from(autopilotTrigger)
    .where(
      and(
        eq(autopilotTrigger.kind, "schedule"),
        eq(autopilotTrigger.enabled, true),
        isNotNull(autopilotTrigger.nextRunAt),
        lte(autopilotTrigger.nextRunAt, now.toISOString()),
      ),
    );

  let fired = 0;
  for (const t of due) {
    // Advance next_run_at FIRST so a dispatch failure doesn't re-fire forever.
    let nextRunAt: string | null = null;
    if (t.cronExpression) {
      try {
        nextRunAt = computeNextRun(t.cronExpression, t.timezone ?? "UTC", now).toISOString();
      } catch (err) {
        console.warn(`autopilot scheduler: bad cron for trigger ${t.id}:`, err);
      }
    }
    await db
      .update(autopilotTrigger)
      .set({ nextRunAt, lastFiredAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(autopilotTrigger.id, t.id));

    try {
      await dispatchAutopilot(db, { autopilotId: t.autopilotId, source: "schedule", triggerId: t.id });
      fired++;
    } catch (err) {
      console.warn(`autopilot scheduler: dispatch failed for trigger ${t.id}:`, err);
    }
  }
  return fired;
}
