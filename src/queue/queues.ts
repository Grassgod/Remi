/**
 * Queue name constants and typed data interfaces for BunQueue.
 */

export const QUEUES = {
  CONVERSATION: "remi:conversation",
  MEMORY: "remi:memory",
  CRON: "remi:cron",
  MISSION: "remi:mission",
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
  jobId: string;
  handler: string;
  handlerConfig?: Record<string, unknown>;
}

/** remi:mission — Mission pipeline step execution */
export interface MissionJobData {
  missionId: string;
  step: string;   // PipelineStep
  attempt?: number;
  evalFailureInfo?: string;  // eval 失败时传给 execute 的失败详情
  userMessage?: string;      // 用户在话题中的回复内容（intake 多轮）
}
