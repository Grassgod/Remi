/**
 * RemiQueueManager — unified BunQueue-based task dispatcher.
 *
 * Phase 1: conversation + memory queues (message hot path stays with AsyncLock).
 * Phase 2: message queue + cron migration (future).
 */

import { Queue, Worker } from "bunqueue/client";
import { QUEUES, type ConversationJobData, type MemoryJobData, type CronJobData } from "./queues.js";
import { handleConversationJob } from "./handlers/conversation.js";
import { handleMemoryJob } from "./handlers/memory.js";
import { handleCronJob } from "./handlers/cron-bridge.js";
import type { MemoryStore } from "../memory/store.js";
import type { Remi } from "../core.js";
import type { CronJobConfig } from "../config.js";
import { createLogger } from "../logger.js";

const log = createLogger("queue");

/** Sliding window config for memory extraction triggers. */
const EXTRACT_ROUND_THRESHOLD = 10;
const EXTRACT_TIME_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

export class RemiQueueManager {
  // ── Queues ──
  private conversationQueue: Queue<ConversationJobData>;
  private memoryQueue: Queue<MemoryJobData>;
  private cronQueue: Queue<CronJobData>;

  // ── Workers ──
  private workers: Worker[] = [];

  // ── Sliding window state ──
  private sessionRoundCount = new Map<string, number>();
  private sessionLastExtract = new Map<string, number>();

  // ── Push rate limiter ──
  private pushCount = 0;
  private pushCountResetAt = Date.now();

  // ── Remi ref for cron handlers ──
  private remi: Remi | null = null;

  constructor(private memory: MemoryStore) {
    this.conversationQueue = new Queue<ConversationJobData>(QUEUES.CONVERSATION, {
      embedded: true,
    });
    this.memoryQueue = new Queue<MemoryJobData>(QUEUES.MEMORY, {
      embedded: true,
    });
    this.cronQueue = new Queue<CronJobData>(QUEUES.CRON, {
      embedded: true,
    });
  }

  // ══════════════════════════════════════════════════════════
  //  Enqueue methods (called from hot path, must be fast)
  // ══════════════════════════════════════════════════════════

  /** Enqueue a conversation record after each response completes. */
  async enqueueConversation(data: ConversationJobData): Promise<void> {
    await this.conversationQueue.add("conversation", data, {
      attempts: 2,
      backoff: { type: "fixed", delay: 2000 },
      removeOnComplete: { age: 3600 },
    });
  }

  /** Enqueue a memory extraction job (triggered by window or stop hook). */
  async enqueueMemory(data: MemoryJobData): Promise<void> {
    await this.memoryQueue.add("memory_extract", data, {
      jobId: data.contentHash, // idempotent dedup
      attempts: 3,
      backoff: { type: "exponential", delay: 10_000 },
      removeOnComplete: { age: 86400 },
    });
  }

  // ══════════════════════════════════════════════════════════
  //  Sliding window check
  // ══════════════════════════════════════════════════════════

  /** Returns true if memory extraction should be triggered for this session. */
  shouldExtractMemory(sessionKey: string): boolean {
    const count = (this.sessionRoundCount.get(sessionKey) ?? 0) + 1;
    this.sessionRoundCount.set(sessionKey, count);

    const lastExtract = this.sessionLastExtract.get(sessionKey) ?? Date.now();
    if (!this.sessionLastExtract.has(sessionKey)) {
      this.sessionLastExtract.set(sessionKey, Date.now());
    }

    const elapsed = Date.now() - lastExtract;

    if (count >= EXTRACT_ROUND_THRESHOLD || elapsed >= EXTRACT_TIME_THRESHOLD_MS) {
      this.sessionRoundCount.set(sessionKey, 0);
      this.sessionLastExtract.set(sessionKey, Date.now());
      return true;
    }
    return false;
  }

  // ══════════════════════════════════════════════════════════
  //  Push rate limiter (for future cron push handlers)
  // ══════════════════════════════════════════════════════════

  /** Returns false if push rate exceeded (max 20/min). */
  checkPushRate(): boolean {
    if (Date.now() - this.pushCountResetAt > 60_000) {
      this.pushCount = 0;
      this.pushCountResetAt = Date.now();
    }
    this.pushCount++;
    return this.pushCount <= 20;
  }

  // ══════════════════════════════════════════════════════════
  //  Cron scheduler setup
  // ══════════════════════════════════════════════════════════

  /**
   * Register cron jobs from config using BunQueue's upsertJobScheduler.
   * Replaces CronTimer + JobStore + JobRunner.
   */
  async setupSchedulers(cronJobs: CronJobConfig[], remi: Remi): Promise<void> {
    this.remi = remi;

    for (const job of cronJobs) {
      if (job.enabled === false) continue;

      let repeatOpts: { pattern?: string; every?: number; timezone?: string } | undefined;

      if (job.cron) {
        repeatOpts = { pattern: job.cron, timezone: job.tz ?? "Asia/Shanghai" };
      } else if (job.every) {
        const ms = RemiQueueManager.parseIntervalToMs(job.every);
        repeatOpts = { every: ms };
      }
      // "at" jobs (one-shot) are added as delayed jobs, not schedulers

      if (repeatOpts) {
        try {
          await this.cronQueue.upsertJobScheduler(
            `remi:${job.id}`,
            repeatOpts,
            {
              name: "cron",
              data: { handler: job.handler, handlerConfig: job.handlerConfig },
              opts: {
                attempts: 2,
                backoff: { type: "exponential", delay: 30_000 },
                removeOnComplete: { age: 86400 },
              },
            },
          );
          log.info(`Scheduler registered: ${job.id} (${job.cron ?? job.every})`);
        } catch (e) {
          log.error(`Failed to register scheduler ${job.id}:`, e);
        }
      } else if (job.at) {
        // One-shot delayed job
        const delayMs = new Date(job.at).getTime() - Date.now();
        if (delayMs > 0) {
          await this.cronQueue.add("cron", { handler: job.handler, handlerConfig: job.handlerConfig }, {
            delay: delayMs,
            jobId: `remi:${job.id}`,
            attempts: 2,
          });
          log.info(`One-shot job registered: ${job.id} (at ${job.at})`);
        }
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  //  Lifecycle
  // ══════════════════════════════════════════════════════════

  async start(): Promise<void> {
    const memory = this.memory;
    const self = this;

    // Conversation Worker — triggers memory extraction
    const convWorker = new Worker<ConversationJobData>(
      QUEUES.CONVERSATION,
      async (job) => handleConversationJob(job, self),
      { embedded: true, concurrency: 2 },
    );

    // Memory Worker — calls LLM to extract entities/decisions
    const memWorker = new Worker<MemoryJobData>(
      QUEUES.MEMORY,
      async (job) => handleMemoryJob(job, memory),
      { embedded: true, concurrency: 1 },
    );

    // Cron Worker — dispatches to handler functions
    const cronWorker = new Worker<CronJobData>(
      QUEUES.CRON,
      async (job) => {
        if (!self.remi) throw new Error("Remi not initialized for cron");
        await handleCronJob(job, self.remi);
      },
      { embedded: true, concurrency: 1 },
    );

    this.workers = [convWorker, memWorker, cronWorker];

    // Attach error handlers — log only, never push
    for (const w of this.workers) {
      w.on("failed", (job: unknown, err: unknown) => {
        const j = job as { id?: string; attemptsMade?: number } | null;
        const e = err as Error | null;
        log.error(`Job ${j?.id ?? "?"} failed (attempt ${j?.attemptsMade ?? "?"}): ${e?.message ?? e}`);
      });
      w.on("error", (err: unknown) => {
        log.error("Worker error:", err);
      });
    }

    // Clean stale active jobs from prior crash
    await this.cleanStaleJobs();

    log.info("RemiQueueManager started (conversation + memory queues)");
  }

  async stop(): Promise<void> {
    for (const w of this.workers) {
      try {
        await w.close();
      } catch {
        // ignore close errors during shutdown
      }
    }
    try { await this.conversationQueue.close(); } catch { /* */ }
    try { await this.memoryQueue.close(); } catch { /* */ }
    try { await this.cronQueue.close(); } catch { /* */ }
    log.info("RemiQueueManager stopped");
  }

  // ── Internal ──

  /** Parse interval string to milliseconds: "30s", "5m", "2h", "1d", "300" (raw seconds). */
  private static parseIntervalToMs(val: string | number): number {
    if (typeof val === "number") return val * 1000;
    const match = val.match(/^(\d+)\s*(s|m|h|d)?$/i);
    if (!match) {
      log.warn(`Invalid interval "${val}", falling back to 300s`);
      return 300_000;
    }
    const num = parseInt(match[1], 10);
    const unit = (match[2] ?? "s").toLowerCase();
    switch (unit) {
      case "s": return num * 1000;
      case "m": return num * 60_000;
      case "h": return num * 3_600_000;
      case "d": return num * 86_400_000;
      default: return num * 1000;
    }
  }

  private async cleanStaleJobs(): Promise<void> {
    const STALE_THRESHOLD = 30 * 60 * 1000; // 30 minutes (cron jobs like compaction/skill:gen can take 5-10min)
    for (const q of [this.conversationQueue, this.memoryQueue, this.cronQueue]) {
      try {
        const active = q.getActive();
        for (const job of active) {
          if (job.timestamp && Date.now() - job.timestamp > STALE_THRESHOLD) {
            log.warn(`Cleaned stale job: ${job.id} (queue=${q.name})`);
            // Move to failed so it doesn't block
            try {
              await q.retryJob(String(job.id));
            } catch {
              // If retry fails, just log — BunQueue will handle it
            }
          }
        }
      } catch {
        // getActive may fail if queue is empty or not yet ready
      }
    }
  }
}
