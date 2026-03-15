/**
 * Stop hook entry point — enqueue transcript for async memory extraction.
 *
 * Usage (Claude Code stop hook):
 *   bun run src/memory/enqueue.ts
 *
 * Reads transcript from stdin, pushes to BunQueue (SQLite INSERT).
 * Must complete within 5 seconds.
 */

import { createHash } from "node:crypto";
import { Queue } from "bunqueue/client";
import { QUEUES, type MemoryJobData } from "../queue/queues.js";

async function main(): Promise<void> {
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

  const data: MemoryJobData = {
    sessionKey: "stop-hook",
    aggregatedText: transcript,
    contentHash,
    roundCount: 0,
    timestamp: new Date().toISOString(),
  };

  // Push to BunQueue — SQLite INSERT, same DB as main process (WAL mode)
  const queue = new Queue<MemoryJobData>(QUEUES.MEMORY, { embedded: true });
  try {
    await queue.add("memory_extract", data, {
      jobId: contentHash, // idempotent: same content won't be enqueued twice
      attempts: 3,
      backoff: { type: "exponential", delay: 10_000 },
    });
  } finally {
    await queue.close();
  }
}

main().catch((e) => console.error("enqueue failed:", e));
