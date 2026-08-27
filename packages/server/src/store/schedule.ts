import { Cron } from "croner";

export function computeScheduleNextRun(
  expression: string,
  timezone: string | null | undefined,
  from: Date = new Date(),
): string {
  const job = new Cron(expression, {
    paused: true,
    ...(timezone ? { timezone } : {}),
  });
  try {
    const next = job.nextRun(from);
    if (!next) throw new Error("schedule has no future run");
    return next.toISOString();
  } finally {
    job.stop();
  }
}
