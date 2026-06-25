/**
 * Queue name constants and typed data interfaces for BunQueue.
 */

export const QUEUES = {
  CRON: "remi:cron",
} as const;

/** remi:cron — 定时任务 */
export interface CronJobData {
  jobId: string;
  handler: string;
  handlerConfig?: Record<string, unknown>;
}
