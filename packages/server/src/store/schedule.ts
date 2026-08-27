import { Cron } from "croner";

export const DEFAULT_PLATFORM_UPDATE_TIME = "05:00";
export const DEFAULT_PLATFORM_UPDATE_TIMEZONE = "Asia/Shanghai";

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

export function isValidDailyScheduleTime(value: string): boolean {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return false;
  return Number(match[1]) <= 23 && Number(match[2]) <= 59;
}

export function isValidIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function computeDailyScheduleNextRun(
  time: string,
  timezone: string,
  from: Date = new Date(),
): string {
  if (!isValidDailyScheduleTime(time)) throw new Error("daily schedule time must use HH:mm");
  if (!isValidIanaTimezone(timezone)) throw new Error("daily schedule timezone must be an IANA timezone");
  const [hour, minute] = time.split(":").map(Number);
  return computeScheduleNextRun(`${minute} ${hour} * * *`, timezone, from);
}
