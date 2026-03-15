/**
 * Stop hook entry point — dual-write transcript for async memory extraction.
 *
 * Usage (Claude Code stop hook):
 *   bun run src/memory/enqueue.ts
 *
 * Dual-write pattern:
 *   1. JSONL file → ~/.remi/queue/{timestamp}.jsonl (source of truth, audit/trace)
 *   2. BunQueue → remi:memory queue (triggers async memory extraction)
 *
 * Must complete within 5 seconds.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { Queue } from "bunqueue/client";
import { QUEUES, type MemoryJobData } from "../queue/queues.js";

async function main(): Promise<void> {
  const queueDir = join(homedir(), ".remi", "queue");
  if (!existsSync(queueDir)) {
    mkdirSync(queueDir, { recursive: true });
  }

  // Read transcript from stdin
  const chunks: string[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(new TextDecoder().decode(chunk));
  }
  const transcript = chunks.join("");

  if (!transcript.trim()) return;

  // Content hash for idempotent dedup
  const contentHash = createHash("sha256")
    .update(transcript)
    .digest("hex")
    .slice(0, 16);

  // Dedup check
  const processedFile = join(queueDir, ".processed");
  if (existsSync(processedFile)) {
    const processed = readFileSync(processedFile, "utf-8").split("\n");
    if (processed.includes(contentHash)) return;
  }

  const now = new Date();
  const ts = now.toISOString().replace(/[-:]/g, "").replace(/T/, "T").replace(/\.\d{3}Z$/, "").slice(0, 15);

  // ═══════════════════════════════════════════════════
  //  1. JSONL — source of truth (fast append, durable)
  // ═══════════════════════════════════════════════════
  const entry = { timestamp: ts, hash: contentHash, transcript };
  const outputPath = join(queueDir, `${ts}.jsonl`);
  writeFileSync(outputPath, JSON.stringify(entry) + "\n", "utf-8");

  // Mark as processed
  appendFileSync(processedFile, contentHash + "\n", "utf-8");

  // ═══════════════════════════════════════════════════
  //  2. BunQueue — trigger async memory extraction
  // ═══════════════════════════════════════════════════
  const data: MemoryJobData = {
    sessionKey: "stop-hook",
    aggregatedText: transcript,
    contentHash,
    roundCount: 0,
    timestamp: now.toISOString(),
  };

  const queue = new Queue<MemoryJobData>(QUEUES.MEMORY, { embedded: true });
  try {
    await queue.add("memory_extract", data, {
      jobId: contentHash,
      attempts: 3,
      backoff: { type: "exponential", delay: 10_000 },
    });
  } finally {
    await queue.close();
  }
}

main().catch((e) => console.error("enqueue failed:", e));
