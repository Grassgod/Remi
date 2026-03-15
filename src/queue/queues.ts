/**
 * Queue name constants and typed data interfaces for BunQueue.
 */

export const QUEUES = {
  CONVERSATION: "remi:conversation",
  MEMORY: "remi:memory",
  CRON: "remi:cron",
} as const;

/** A single StreamEvent captured during processing (for JSONL trace). */
export interface CapturedEvent {
  kind: string;
  ts: number; // Date.now() at capture time
  name?: string;
  toolUseId?: string;
  input?: Record<string, unknown>;
  resultPreview?: string;
  text?: string;
  error?: string;
  durationMs?: number;
}

/** remi:conversation — 每轮对话记录 */
export interface ConversationJobData {
  sessionKey: string;
  chatId: string;
  sender?: string;
  connector?: string;
  userText: string;
  assistantText: string;
  thinking?: string;
  toolCalls?: Array<{ name: string; toolUseId: string; input?: Record<string, unknown>; resultPreview?: string; durationMs?: number }>;
  events?: CapturedEvent[]; // 完整事件流，写入 JSONL
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
