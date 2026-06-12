/**
 * Cron next-run computation — the Bun port of Go's service.ComputeNextRun
 * (robfig/cron). Standard 5-field cron, evaluated in the trigger's timezone.
 * Used by the autopilot scheduler to advance a schedule trigger's next_run_at.
 */

import { Cron } from "croner";

/**
 * Next fire time strictly after `from` (default: now) for a 5-field cron
 * expression, evaluated in `timezone` (IANA name, default UTC). Throws on an
 * invalid expression or timezone — same fail-fast contract as the Go helper.
 */
export function computeNextRun(cronExpr: string, timezone = "UTC", from?: Date): Date {
  let job: Cron;
  try {
    job = new Cron(cronExpr, { timezone: timezone || "UTC" });
  } catch (err) {
    throw new Error(`cron: invalid expression ${JSON.stringify(cronExpr)} / tz ${JSON.stringify(timezone)}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const next = job.nextRun(from ?? new Date());
  if (!next) throw new Error(`cron: no upcoming run for ${JSON.stringify(cronExpr)}`);
  return next;
}
