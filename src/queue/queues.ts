/**
 * Queue name constants and typed data interfaces for BunQueue.
 */

export const QUEUES = {
  CONVERSATION: "remi:conversation",
  MEMORY: "remi:memory",
  CRON: "remi:cron",
} as const;

/** remi:conversation — 每轮对话记录 */
export interface ConversationJobData {
  sessionKey: string;
  chatId: string;
  sender?: string;
  connector?: string;
  userText: string;
  assistantText: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs?: number;
  timestamp: string;
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
