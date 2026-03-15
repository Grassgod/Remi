/**
 * RemiQueueManager — unified BunQueue-based task dispatcher.
 *
 * Phase 1: conversation + memory queues (message hot path stays with AsyncLock).
 * Phase 2: message queue + cron migration (future).
 */

import { Queue, Worker } from "bunqueue/client";
import { QUEUES, type ConversationJobData, type MemoryJobData } from "./queues.js";
import { handleConversationJob } from "./handlers/conversation.js";
import { handleMemoryJob } from "./handlers/memory.js";
import type { MemoryStore } from "../memory/store.js";
import { createLogger } from "../logger.js";

const log = createLogger("queue");

/** Sliding window config for memory extraction triggers. */
const EXTRACT_ROUND_THRESHOLD = 10;
const EXTRACT_TIME_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

export class RemiQueueManager {
  // ── Queues ──
  private conversationQueue: Queue<ConversationJobData>;
  private memoryQueue: Queue<MemoryJobData>;

  // ── Workers ──
  private workers: Worker[] = [];

  // ── Sliding window state ──
  private sessionRoundCount = new Map<string, number>();
  private sessionLastExtract = new Map<string, number>();

  // ── Push rate limiter ──
  private pushCount = 0;
  private pushCountResetAt = Date.now();

  constructor(private memory: MemoryStore) {
    this.conversationQueue = new Queue<ConversationJobData>(QUEUES.CONVERSATION, {
      embedded: true,
    });
    this.memoryQueue = new Queue<MemoryJobData>(QUEUES.MEMORY, {
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
  //  Lifecycle
  // ══════════════════════════════════════════════════════════

  async start(): Promise<void> {
    const memory = this.memory;
    const self = this;

    // Conversation Worker — writes to SQLite, triggers memory extraction
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

    this.workers = [convWorker, memWorker];

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
    log.info("RemiQueueManager stopped");
  }

  // ── Internal ──

  private async cleanStaleJobs(): Promise<void> {
    const STALE_THRESHOLD = 10 * 60 * 1000; // 10 minutes
    for (const q of [this.conversationQueue, this.memoryQueue]) {
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
