/**
 * Queue name constants and typed data interfaces for BunQueue.
 */

export const QUEUES = {
  CONVERSATION: "remi:conversation",
  MEMORY: "remi:memory",
  CRON: "remi:cron",
} as const;

/** remi:conversation — trigger for memory extraction window check */
export interface ConversationJobData {
  sessionKey: string;
  chatId: string;
}

/** remi:memory — 记忆提取任务 */
export interface MemoryJobData {
  sessionKey: string;
  aggregatedText: string;
  contentHash: string;
  roundCount: number;
  timestamp: string;
}

/** remi:cron — 定时任务（Phase 2） */
export interface CronJobData {
  handler: string;
  handlerConfig?: Record<string, unknown>;
}
